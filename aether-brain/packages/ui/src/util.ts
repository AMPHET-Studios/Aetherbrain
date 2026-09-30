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
