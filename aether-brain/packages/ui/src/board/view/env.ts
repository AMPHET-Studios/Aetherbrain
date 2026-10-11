/**
 * The browser's side of the board session (SessionEnv): the text measuring, the picture decoding, the offscreen canvases and the
 * storage the session asks for. The only file of the view that touches `document`, `createImageBitmap` and `localStorage`, so the
 * rest runs in node. Every function is safe where the browser is missing (a server render, a test): it answers "nothing".
 */
import { IMAGE_BLIND_DECODE_MAX_BYTES, estimateTextMetrics, readBlobHeader, type TextMetrics } from '@aether/core'
import type { BitmapLike } from '../imageCache'
import { canvasTextMetrics, type ExportCanvas } from '../renderer'
import { realTimers } from './session'
import type { SessionEnv } from './boardSession'

/** Text measured with a real canvas font (a dedicated 1 by 1 canvas: the measuring must not disturb the drawing's own context). */
export function createTextMetrics(): TextMetrics {
  try {
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const ctx = canvas.getContext('2d')
      if (ctx) return canvasTextMetrics(ctx)
    }
  } catch {
    /* no canvas here: the estimate of @aether/core */
  }
  return estimateTextMetrics
}

function makeCanvas(w: number, h: number): ExportCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h) as unknown as ExportCanvas
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas as unknown as ExportCanvas
}

/** A picture whose header cannot be read is decoded to learn its size only when its file is this small. */
/** Decodes that may run at once (a decode takes width x height x 4 bytes; the header read takes none). */
const FALLBACK_DECODES = 2

let decoding = 0
const decodeQueue: (() => void)[] = []
async function withDecodeSlot<T>(job: () => Promise<T>): Promise<T> {
  if (decoding >= FALLBACK_DECODES) await new Promise<void>((resolve) => decodeQueue.push(resolve))
  decoding++
  try {
    return await job()
  } finally {
    decoding--
    decodeQueue.shift()?.()
  }
}

/**
 * A picture's size as it is shown (upright), read from its first bytes: the PNG, JPEG, GIF, WebP, BMP or AVIF header says it, and nothing
 * is decoded. Decoding to learn a size cost a gigabyte for a 16000 x 16000 PNG of 775 KB, eight of them at once for a drop. A file
 * whose header cannot be read is decoded only when it is small and two at a time; a larger one is no picture the board can use.
 */
export async function pictureSize(blob: Blob): Promise<{ w: number; h: number } | null> {
  // The first 256 KB, and for a JPEG or AVIF with long metadata in front the first 2 MiB; nothing is decoded.
  const header = await readBlobHeader(blob)
  if (header) return { w: header.shownWidth, h: header.shownHeight }
  // No header could be read: a file bigger than a few KB is no picture the board can use (a flat 12,504 x 12,504 JPEG is 0.6 MB and
  // decodes to 625 MB), only a tiny one is decoded to see what it is.
  if (blob.size > IMAGE_BLIND_DECODE_MAX_BYTES || typeof createImageBitmap !== 'function') return null
  return withDecodeSlot(async () => {
    try {
      // Upright, as the picture cache decodes it, so that a phone photo's shape is the one it is drawn with.
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
      const size = { w: bitmap.width, h: bitmap.height }
      bitmap.close()
      return size.w > 0 && size.h > 0 ? size : null
    } catch {
      return null
    }
  })
}

interface Readable2D {
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray }
}

/**
 * Reads one pixel of a canvas that is on screen (the sampler), through a 1 by 1 canvas of its own made for reading
 * (`willReadFrequently`): `getImageData` on the drawing canvas itself, again and again, makes Chromium warn and, with the canvas on
 * the GPU, stall on every read. Null where there is no canvas to make.
 */
export function createPixelReader(): (source: HTMLCanvasElement, x: number, y: number) => Uint8ClampedArray | null {
  let probe: CanvasRenderingContext2D | null | undefined
  return (source, x, y) => {
    if (probe === undefined) {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = 1
        probe = canvas.getContext('2d', { willReadFrequently: true })
      } catch {
        probe = null
      }
    }
    if (!probe) return null
    probe.imageSmoothingEnabled = false
    probe.clearRect(0, 0, 1, 1)
    probe.drawImage(source, x, y, 1, 1, 0, 0, 1, 1)
    return probe.getImageData(0, 0, 1, 1).data
  }
}

export function browserEnv(): SessionEnv {
  return {
    timers: realTimers,
    metrics: createTextMetrics(),
    storage: () => {
      try {
        return typeof localStorage !== 'undefined' ? localStorage : null
      } catch {
        return null
      }
    },
    decodeSize: pictureSize,
    pixelsOf(bitmap: BitmapLike, maxSide: number) {
      try {
        const w = bitmap.width
        const h = bitmap.height
        if (!(w > 0 && h > 0)) return null
        const s = Math.min(1, maxSide / Math.max(w, h))
        const cw = Math.max(1, Math.round(w * s))
        const ch = Math.max(1, Math.round(h * s))
        const ctx = makeCanvas(cw, ch).getContext('2d') as unknown as Readable2D | null
        if (!ctx) return null
        ctx.drawImage(bitmap, 0, 0, cw, ch)
        return ctx.getImageData(0, 0, cw, ch).data
      } catch {
        return null
      }
    },
    makeCanvas,
    async canvasToPng(canvas) {
      const c = canvas as unknown as {
        convertToBlob?: (options?: { type?: string }) => Promise<Blob>
        toBlob?: (cb: (b: Blob | null) => void, type?: string) => void
      }
      let blob: Blob | null = null
      if (typeof c.convertToBlob === 'function') blob = await c.convertToBlob({ type: 'image/png' })
      else if (typeof c.toBlob === 'function') blob = await new Promise<Blob | null>((resolve) => c.toBlob!(resolve, 'image/png'))
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null
    },
    now: () => new Date(),
  }
}
