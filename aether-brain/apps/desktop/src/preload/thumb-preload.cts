/// <reference lib="dom" />
/**
 * Preload of the hidden thumbnail helper (sandboxed, context-isolated, an
 * empty page; see src/main/thumbnailer.ts). Main sends a picture's bytes
 * with the size to make; this decodes them with Chromium's own decoders,
 * scaled while decoding (createImageBitmap resizes before it hands the
 * bitmap over, so a big picture is not kept at full size), draws the result
 * into an OffscreenCanvas and sends back PNG bytes, or null when the bytes
 * do not decode. Nothing is exposed to the page, and nothing is read here:
 * the helper's session refuses every request.
 * (CommonJS on purpose — Electron preloads run in a sandbox that loads CJS.)
 */
import { ipcRenderer } from 'electron'

/** Same channels as THUMB_IPC in src/main/thumbnailer.ts (a sandboxed preload cannot import it at runtime). */
const IPC = {
  ready: 'thumbs:ready',
  job: 'thumbs:job',
  done: 'thumbs:done',
} as const

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
