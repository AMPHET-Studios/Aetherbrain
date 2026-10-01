export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD = isMac ? '⌘' : 'Ctrl'

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(t)) return iso
  const diff = now - t
  const day = 86400000
  // Date-only values (the common frontmatter case) resolve to local midnight.
  if (iso.length === 10) {
    if (diff < 0) return iso
    if (diff < day) return 'today'
  }
  if (diff < 0) return iso.slice(0, 10)
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < day) return `${Math.floor(diff / 3600000)}h ago`
  if (diff < day * 2) return 'yesterday'
  if (diff < day * 30) return `${Math.floor(diff / day)}d ago`
  if (diff < day * 365) return `${Math.floor(diff / (day * 30))}mo ago`
  return `${Math.floor(diff / (day * 365))}y ago`
}

export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(t)) return null
  return Math.floor((now - t) / 86400000)
}

/** True when the keyboard event originates from a text field. */
export function isTyping(e: KeyboardEvent | { target: EventTarget | null }): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/**
 * True when the event's target is a control that `Enter` activates by itself
 * (a button, a link, a list option …): a global `Enter` shortcut must leave
 * it alone, or both would run.
 */
export function isControl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el?.tagName) return false
  if (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY' || (el.tagName === 'A' && !!el.hasAttribute?.('href'))) return true
  return ['button', 'link', 'option', 'menuitem', 'tab', 'checkbox', 'switch'].includes(el.getAttribute?.('role') ?? '')
}

export function plural(n: number, s: string, p = `${s}s`): string {
  return `${n} ${n === 1 ? s : p}`
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** A video's still is a tenth of the way in, at most 5 s (as the desktop thumbnail helper takes it). */
const STILL_AT = 0.1
const STILL_MAX_S = 5
/** A video that has not given its still by then gets none. */
const STILL_TIMEOUT_MS = 15_000
/** `seeked` can come a moment before the frame can be drawn: a see-through still is drawn again, this often at most, this far apart. */
const DRAW_TRIES = 25
const DRAW_WAIT_MS = 40

/**
 * One still frame of a video Blob (a file the browser adapters read, a
 * memory vault's bytes), at most `size` px (32–1024) on its longer side, as
 * a PNG Blob: the video is loaded and sought a tenth of the way in (at most
 * 5 s), never played. Null without a DOM (tests), or when the browser can't
 * decode it in time.
 */
export async function videoStill(source: Blob, size: number): Promise<Blob | null> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function' || source.size === 0) return null
  const side = Math.min(1024, Math.max(32, Math.round(Number.isFinite(size) ? size : 128)))
  const url = URL.createObjectURL(source)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  const until = (event: string) =>
    new Promise<void>((resolve, reject) => {
      const done = (ok: boolean) => {
        video.removeEventListener(event, onEvent)
        video.removeEventListener('error', onError)
        if (ok) resolve()
        else reject(new Error('The video could not be read'))
      }
      const onEvent = () => done(true)
      const onError = () => done(false)
      video.addEventListener(event, onEvent)
      video.addEventListener('error', onError)
    })
  const still = async (): Promise<Blob | null> => {
    const meta = until('loadedmetadata')
    video.src = url
    await meta
    const d = video.duration
    const at = Number.isFinite(d) && d > 0 ? Math.min(d * STILL_AT, STILL_MAX_S) : 0
    if (at > 0) {
      const seeked = until('seeked')
      video.currentTime = at
      await seeked
    } else if (video.readyState < 2) {
      await until('loadeddata')
    }
    const w = video.videoWidth
    const h = video.videoHeight
    if (!(w > 0 && h > 0)) return null
    const scale = Math.min(1, side / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    // A video frame has no see-through pixels; a frame not ready yet is all see-through.
    const painted = () =>
      [0.25, 0.5, 0.75].some((fx) => [0.25, 0.5, 0.75].some((fy) => (ctx.getImageData(Math.floor(canvas.width * fx), Math.floor(canvas.height * fy), 1, 1).data[3] ?? 0) > 0))
    for (let tries = 1; ; tries++) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      if (painted()) break
      if (tries >= DRAW_TRIES) return null
      await new Promise((r) => setTimeout(r, DRAW_WAIT_MS))
    }
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([still(), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), STILL_TIMEOUT_MS)))])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

/**
 * What a thumbnail loader hands the scene and the inspector: the picture it
 * got, or for a video (a `video/…` Blob, as the browser adapters give it) one
 * still frame of it. The desktop adapter sends stills already.
 */
export async function stillOf(blob: Blob | null, size: number): Promise<Blob | null> {
  if (!blob || blob.size === 0) return null
  return blob.type.startsWith('video/') ? videoStill(blob, size) : blob
}

/** Pictures bigger than this get no preview: decoding them would stall the app for a thumbnail. */
const MAX_PREVIEW_SOURCE = 64 * 1024 * 1024

/**
 * A preview of a picture at most `size` px (32–1024) on its longer side, as
 * a PNG Blob, for the browser adapters' `thumbnail`. Decoded with
 * `createImageBitmap` (off the main thread in Chromium) and drawn on an
 * OffscreenCanvas where there is one. A picture already that small, or one
 * this engine can't redraw (no canvas: tests), comes back as it is; null
 * when it is empty, huge, or not a picture the engine can decode.
 */
export async function resizeImage(source: Blob, size: number): Promise<Blob | null> {
  if (source.size === 0 || source.size > MAX_PREVIEW_SOURCE) return null
  if (typeof createImageBitmap !== 'function') return source
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(source)
  } catch {
    return null
  }
  try {
    const side = Math.min(1024, Math.max(32, Math.round(Number.isFinite(size) ? size : 128)))
    const scale = side / Math.max(bitmap.width, bitmap.height)
    if (!(scale < 1)) return source
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h)
      const ctx = canvas.getContext('2d')
      if (!ctx) return source
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bitmap, 0, 0, w, h)
      return await canvas.convertToBlob({ type: 'image/png' })
    }
    if (typeof document === 'undefined') return source
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return source
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, w, h)
    return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? source), 'image/png'))
  } catch {
    // Drawing failed (out of memory, a lost context): the picture itself still makes a preview.
    return source
  } finally {
    bitmap.close()
  }
}
