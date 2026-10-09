/**
 * How much of a note the preview draws. Laying text out costs memory in proportion to its length, not just its
 * element count: an imported AI chat of 1 MB took about 1 GB to draw, one of 4 MB about 3 GB, one of 16 MB about
 * 10 GB (measured in the real app), and the window died with "ran out of memory". So the preview draws the first
 * part of a note and offers the next part on request, up to a ceiling; the rest of the note stays in its file.
 * Pure, so it is tested without a browser.
 */

/** Characters drawn when a note opens, and added by each *Show more*. */
export const PREVIEW_FIRST = 60_000
export const PREVIEW_STEP = 60_000
/** The most the preview ever draws of one note (about 200 MB of memory), however often *Show more* is pressed. */
export const PREVIEW_MAX = 300_000
/** A note embedded in another (`![[Title]]`) is drawn this much at most, with no *Show more*. */
export const EMBED_MAX = 20_000

/**
 * A note longer than this opens in the editor read-only, as its preview, without the text box. A text box holds the
 * whole text, and Chromium builds about two page elements per line of it and lays every line out: 1 MB of an imported
 * chat took about half a gigabyte, 16 MB about 9 GB (measured in the real app), and the window died with "ran out of
 * memory". 400,000 characters is a novel; the file itself is not touched, and any text editor opens it.
 */
export const EDIT_MAX = 400_000

/** True when a note of this many characters is too long for the editor's text box (see `EDIT_MAX`). */
export const tooBigToEdit = (chars: number): boolean => chars > EDIT_MAX

export interface PreviewCut {
  /** The part to draw: a prefix of the text, so line numbers (task ticks) still match the file. */
  text: string
  /** Characters in the whole text. */
  total: number
  /** True when `text` is not all of it. */
  cut: boolean
}

/** The first `limit` characters of `body`, cut where a reader would not notice: at a blank line, else a line end, else a word. */
export function previewCut(body: string, limit: number): PreviewCut {
  const total = body.length
  const max = Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 0))
  if (total <= max) return { text: body, total, cut: false }
  let end = max
  // Never between the two halves of an emoji and the like.
  const last = body.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  const head = body.slice(0, end)
  // The nearest break in the last tenth of the part (or a fifth, for the line end), so nothing much is lost.
  const floor = Math.floor(end * 0.9)
  let at = head.lastIndexOf('\n\n')
  if (at < floor) at = head.lastIndexOf('\n')
  if (at < floor) at = head.lastIndexOf(' ')
  const text = at >= floor && at > 0 ? head.slice(0, at) : head
  return { text: text + closeFence(text), total, cut: true }
}

const FENCE = /^((?:[ \t]*>)*[ \t]{0,3})(`{3,}|~{3,})/

/** What closes a code block that the cut left open (nothing when none is open): a cut inside one would swallow the notice. */
function closeFence(text: string): string {
  let open: { prefix: string; marker: string } | null = null
  let from = 0
  while (from <= text.length) {
    let to = text.indexOf('\n', from)
    if (to < 0) to = text.length
    const m = FENCE.exec(text.slice(from, Math.min(to, from + 200)))
    if (m) {
      const prefix = m[1] ?? ''
      const marker = m[2] ?? '```'
      if (!open) open = { prefix, marker }
      else if (marker[0] === open.marker[0] && marker.length >= open.marker.length) open = null
    }
    from = to + 1
  }
  return open ? `\n${open.prefix}${open.marker}` : ''
}

/** "16,000,000" for the notice. */
export const groups = (n: number): string => Math.round(n).toLocaleString('en-US')
