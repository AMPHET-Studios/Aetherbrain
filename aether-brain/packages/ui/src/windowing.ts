/**
 * Windowing for long lists of fixed-height rows: only the rows in (or just
 * outside) the view exist in the page, the rest are two spacers. A list of
 * 20,000 projects is then ~20 cards, not ~440,000 elements.
 */

/** Which rows to draw, and the empty space standing in for the rows above and below them. */
export interface RowWindow {
  /** First row drawn. */
  start: number
  /** One past the last row drawn. */
  end: number
  /** Height of the rows above `start`, px. */
  padTop: number
  /** Height of the rows from `end` on, px. */
  padBottom: number
}

/** Rows drawn beyond each edge of the view, so a fast scroll does not show a gap. */
export const OVERSCAN_ROWS = 6

/** The height assumed before the real one is known (and when drawing without a browser). */
export const DEFAULT_VIEWPORT_PX = 800

/**
 * The rows to draw for a list of `count` rows, each `rowHeight` px, scrolled
 * to `scrollTop` in a view `viewportHeight` px tall. Always sane: any input
 * (negative, NaN, past the end) gives a window inside 0..count.
 */
export function rowWindow(count: number, rowHeight: number, scrollTop: number, viewportHeight: number, overscan = OVERSCAN_ROWS): RowWindow {
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0))
  const h = rowHeight > 0 && Number.isFinite(rowHeight) ? rowHeight : 1
  const view = viewportHeight > 0 && Number.isFinite(viewportHeight) ? viewportHeight : DEFAULT_VIEWPORT_PX
  const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0)
  const first = Math.min(n, Math.floor(top / h))
  const last = Math.min(n, Math.ceil((top + view) / h))
  const start = Math.max(0, Math.min(first, n) - overscan)
  const end = Math.min(n, Math.max(last, first) + overscan)
  return { start, end, padTop: start * h, padBottom: (n - end) * h }
}

/**
 * The scroll position that shows row `index` in full, or `scrollTop` itself
 * when it already is: the least movement, like moving a selection with the keys.
 */
export function scrollToReveal(index: number, rowHeight: number, scrollTop: number, viewportHeight: number): number {
  const view = viewportHeight > 0 && Number.isFinite(viewportHeight) ? viewportHeight : DEFAULT_VIEWPORT_PX
  const top = Math.max(0, index) * rowHeight
  const bottom = top + rowHeight
  if (top < scrollTop) return top
  // A row taller than the view is shown from its top.
  if (bottom > scrollTop + view) return Math.min(top, Math.max(0, bottom - view))
  return scrollTop
}

/** A list shown a page at a time: how many rows to draw now. */
export function pageLimit(total: number, shown: number): number {
  return Math.max(0, Math.min(total, shown))
}
