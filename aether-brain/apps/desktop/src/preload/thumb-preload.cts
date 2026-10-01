/// <reference lib="dom" />
/**
 * Preload of the hidden thumbnail helper (sandboxed, context-isolated, an
 * empty page; see src/main/thumbnailer.ts). Main sends a picture's bytes
 * with the size to make; this decodes them with Chromium's own decoders,
 * scaled while decoding (createImageBitmap resizes before it hands the
 * bitmap over, so a big picture is not kept at full size), draws the result
 * into an OffscreenCanvas and sends back PNG bytes, or null when the bytes
 * do not decode. A video comes as an address its session serves for this one
 * job: it is loaded, sought to one frame and that frame drawn, never played.
 * Nothing is exposed to the page, and nothing else is read here: the
 * helper's session refuses every other request.
 * (CommonJS on purpose — Electron preloads run in a sandbox that loads CJS.)
 */
import { ipcRenderer } from 'electron'

/** Same channels as THUMB_IPC in src/main/thumbnailer.ts (a sandboxed preload cannot import it at runtime). */
const IPC = {
  ready: 'thumbs:ready',
  job: 'thumbs:job',
  done: 'thumbs:done',
  video: 'thumbs:video',
} as const

/** Addresses main hands out for videos (VIDEO_URL_PREFIX in src/main/thumbnailer.ts). */
const VIDEO_URL = 'aether-video://clip/'
/** A video's still is a tenth of the way in, at most 5 s: past a title card or a fade-in, still near the start. */
const STILL_AT = 0.1
const STILL_MAX_S = 5
/** A video that has not given its still by then gets none (before main's own timeout ends the helper). */
const VIDEO_TIMEOUT_MS = 15_000
/**
 * `seeked` can come a moment before the frame can be drawn: a still that comes
 * out see-through is drawn again, this often at most, this far apart; then it
 * is kept as drawn when the video has its frame (a transparent background).
 */
const DRAW_TRIES = 25
const DRAW_WAIT_MS = 40

/** True when a few points of the canvas are painted (a video frame has no see-through pixels; a frame not ready yet is all see-through). */
function painted(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number): boolean {
  for (const fx of [0.25, 0.5, 0.75]) {
    for (const fy of [0.25, 0.5, 0.75]) {
      if ((ctx.getImageData(Math.floor(w * fx), Math.floor(h * fy), 1, 1).data[3] ?? 0) > 0) return true
    }
  }
  return false
}

/** Largest side main ever asks for (THUMB_MAX in src/main/assets.ts). */
const MAX_SIDE = 1024

const side = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_SIDE

/** PNG bytes of `bytes` (a picture of media type `type`) at `width` × `height`. */
async function thumbnail(bytes: Uint8Array, type: string, width: number, height: number): Promise<Uint8Array | null> {
  // Bytes that crossed IPC sit in a plain ArrayBuffer, never a shared one.
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type })
  const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    const png = await canvas.convertToBlob({ type: 'image/png' })
    return new Uint8Array(await png.arrayBuffer())
  } finally {
    bitmap.close()
  }
}

/** Resolves on `event` of `video`, rejects on its `error`. */
function until(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = (ok: boolean) => {
      video.removeEventListener(event, onEvent)
      video.removeEventListener('error', onError)
      if (ok) resolve()
      else reject(new Error(video.error?.message || 'The video could not be read'))
    }
    const onEvent = () => done(true)
    const onError = () => done(false)
    video.addEventListener(event, onEvent)
    video.addEventListener('error', onError)
  })
}

/** PNG bytes of one still frame of the video at `url`, at most `px` px on its longer side: sought to, never played. */
async function videoStill(url: string, px: number): Promise<Uint8Array | null> {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  // Served with CORS, so the frame can be drawn and read back.
  video.crossOrigin = 'anonymous'
  try {
    const meta = until(video, 'loadedmetadata')
    video.src = url
    await meta
    const d = video.duration
    const at = Number.isFinite(d) && d > 0 ? Math.min(d * STILL_AT, STILL_MAX_S) : 0
    if (at > 0) {
      const seeked = until(video, 'seeked')
      video.currentTime = at
      await seeked
    } else if (video.readyState < 2) {
      await until(video, 'loadeddata')
    }
    const w = video.videoWidth
    const h = video.videoHeight
    if (!(w > 0 && h > 0)) return null
    const scale = Math.min(1, px / Math.max(w, h))
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    for (let tries = 1; ; tries++) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      if (painted(ctx, canvas.width, canvas.height)) break
      if (tries >= DRAW_TRIES) {
        if (video.readyState >= 2) break
        return null
      }
      await new Promise((r) => setTimeout(r, DRAW_WAIT_MS))
    }
    const png = await canvas.convertToBlob({ type: 'image/png' })
    return new Uint8Array(await png.arrayBuffer())
  } finally {
    // Let go of the stream (and the file main serves) at once.
    video.removeAttribute('src')
    video.load()
  }
}

/** `job`, or null once `ms` have passed. */
function inTime<T>(job: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms)
    job.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (err: unknown) => (clearTimeout(timer), reject(err)),
    )
  })
}

ipcRenderer.on(IPC.video, (_e, id: unknown, url: unknown, px: unknown) => {
  const job = typeof url === 'string' && url.startsWith(VIDEO_URL) && side(px) ? inTime(videoStill(url, px), VIDEO_TIMEOUT_MS) : Promise.resolve(null)
  void job.then(
    (png) => ipcRenderer.send(IPC.done, id, png),
    () => ipcRenderer.send(IPC.done, id, null),
  )
})

ipcRenderer.on(IPC.job, (_e, id: unknown, bytes: unknown, type: unknown, width: unknown, height: unknown) => {
  const job =
    bytes instanceof Uint8Array && typeof type === 'string' && side(width) && side(height)
      ? thumbnail(bytes, type, width, height)
      : Promise.resolve(null)
  void job.then(
    (png) => ipcRenderer.send(IPC.done, id, png),
    () => ipcRenderer.send(IPC.done, id, null),
  )
})

ipcRenderer.send(IPC.ready)
