/**
 * The key `w` in the floating board window: as in the brain window, it brings the board back (docks it). The board's own keys are
 * taken by the board view first (it handles the keys it has and stops them); this is for the one it does not have. A text box keeps
 * its letters, and so does an open menu, picker or dialog. Pure, so it is tested without a page.
 */

/** What is read of a key event. */
export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  isComposing: boolean
  defaultPrevented: boolean
  /** An EventTarget in the page; any object with a tag name and an editable flag in a test. */
  target: object | null
}

/** Whether this key press should bring the board back; `overlayOpen`: a menu, the picker or a dialog is on screen. */
export function isBringBackKey(e: KeyLike, overlayOpen: boolean): boolean {
  if (e.defaultPrevented || e.isComposing || e.repeat || overlayOpen) return false
  if (e.key !== 'w' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/i.test(t.tagName ?? ''))) return false
  return true
}
