/**
 * The browser's side of the board session (SessionEnv): the text measuring, the picture decoding, the offscreen canvases and the
 * storage the session asks for. The only file of the view that touches `document`, `createImageBitmap` and `localStorage`, so the
 * rest runs in node. Every function is safe where the browser is missing (a server render, a test): it answers "nothing".
 */
import { estimateTextMetrics, type TextMetrics } from '@aether/core'
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

interface Readable2D {
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray }
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
    async decodeSize(blob) {
      try {
        // Upright, as the picture cache decodes it, so that a phone photo's shape is the one it is drawn with.
        const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
        const size = { w: bitmap.width, h: bitmap.height }
        bitmap.close()
        return size.w > 0 && size.h > 0 ? size : null
      } catch {
        return null
      }
    },
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
