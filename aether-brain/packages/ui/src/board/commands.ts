/**
 * The reference board's commands: one row for every `BoardCommandId` (what the palette lists as "Board: ...", the cheatsheet shows
 * and the controller's `exec` carries out), the keys that run them and the keys the shell hands the board. The rows are the one source
 * of truth for keys: `keyToCommand` is built by reading each row's `keys` text, so the cheatsheet cannot say one thing and the board
 * do another. Pure data and functions, no DOM. Design: docs/design/reference-board.md.
 *
 * Writing a key. `⌘` is Ctrl or Meta (whichever the platform's shortcut key is), `⇧` Shift, `⌥` Alt; the key comes last ("⌘ ⇧ Z",
 * "]", "Delete", "Esc"). Two keys for one command are joined by " / " ("Delete / ⌫"). Letters ignore case. Brackets are the
 * character the key types ('[' and ']'; AltGr is Ctrl+Alt on Windows and is dropped), and only where an Option key on a Mac turns the
 * bracket key into another character does the key code stand in for it. A letter or digit typed in another script (Cyrillic, Greek,
 * Hebrew ...) counts as the Latin letter on the same physical key, so Ctrl+Z is Ctrl+Z on every layout. `+`, `=`, `-` and the digits
 * ignore Shift (Shift makes the plus; a French keyboard makes its 1 with Shift), everything else must match its modifiers exactly, so
 * "H" (hand tool) and "⇧ H" (flip) never fire together.
 */
import type { BoardCommandId, BoardCommandInfo, BoardTool, KeyIn } from './api'

type Group = BoardCommandInfo['group']

interface RowExtra {
  needs?: number
  desktopOnly?: boolean
}

function row(id: BoardCommandId, title: string, group: Group, keys?: string, extra: RowExtra = {}): BoardCommandInfo {
  const info: BoardCommandInfo = { id, title, group }
  if (keys !== undefined) info.keys = keys
  if (extra.needs !== undefined) info.needs = extra.needs
  if (extra.desktopOnly) info.desktopOnly = true
  return info
}

/** Every command of the board, in the order the palette and the cheatsheet list them. */
export const BOARD_COMMANDS: BoardCommandInfo[] = [
  // tools
  row('tool.select', 'Select tool', 'Tools', 'V'),
  row('tool.hand', 'Hand tool (pan)', 'Tools', 'H'),
  row('tool.note', 'Note tool', 'Tools', 'T'),
  row('tool.pen', 'Pen', 'Tools', 'P'),
  row('tool.line', 'Line and arrow', 'Tools', 'L'),
  row('tool.rect', 'Rectangle', 'Tools', 'R'),
  row('tool.ellipse', 'Ellipse', 'Tools', 'O'),
  row('tool.eraser', 'Eraser', 'Tools', 'E'),
  row('tool.sampler', 'Colour sampler', 'Tools', 'I'),
  row('tool.crop', 'Crop the selected picture', 'Tools', 'C', { needs: 1 }),
  // edit
  row('edit.undo', 'Undo', 'Edit', '⌘ Z'),
  row('edit.redo', 'Redo', 'Edit', '⌘ ⇧ Z / ⌘ Y'),
  row('edit.selectAll', 'Select all', 'Edit', '⌘ A'),
  row('edit.selectNone', 'Select none', 'Edit', 'Esc'),
  row('edit.invertSelection', 'Invert selection', 'Edit', '⌘ I'),
  row('edit.duplicate', 'Duplicate', 'Edit', '⌘ D', { needs: 1 }),
  row('edit.delete', 'Delete', 'Edit', 'Delete / ⌫', { needs: 1 }),
  row('edit.copy', 'Copy', 'Edit', '⌘ C', { needs: 1 }),
  row('edit.cut', 'Cut', 'Edit', '⌘ X', { needs: 1 }),
  row('edit.paste', 'Paste', 'Edit', '⌘ V'),
  row('edit.group', 'Group', 'Edit', '⌘ G', { needs: 2 }),
  row('edit.ungroup', 'Ungroup', 'Edit', '⌘ ⇧ G', { needs: 1 }),
  row('edit.lock', 'Lock', 'Edit', '⌘ L', { needs: 1 }),
  row('edit.unlock', 'Unlock', 'Edit', '⌘ ⇧ L', { needs: 1 }),
  // notes (Enter does the same as F2 when exactly one note is selected: the controller reads it, `picture.open` owns the key)
  row('note.edit', 'Edit the selected note (Enter too)', 'Edit', 'F2', { needs: 1 }),
  // stacking
  row('order.front', 'Bring to front', 'Order', '⌘ ]', { needs: 1 }),
  row('order.forward', 'Bring forward', 'Order', ']', { needs: 1 }),
  row('order.backward', 'Send backward', 'Order', '[', { needs: 1 }),
  row('order.back', 'Send to back', 'Order', '⌘ [', { needs: 1 }),
  // transform
  row('transform.flipH', 'Flip horizontally', 'Transform', '⇧ H', { needs: 1 }),
  row('transform.flipV', 'Flip vertically', 'Transform', '⇧ V', { needs: 1 }),
  row('transform.rotateCw', 'Rotate 90° clockwise', 'Transform', '⌘ R', { needs: 1 }),
  row('transform.rotateCcw', 'Rotate 90° counter-clockwise', 'Transform', '⌘ ⇧ R', { needs: 1 }),
  row('transform.resetRotation', 'Reset rotation', 'Transform', undefined, { needs: 1 }),
  row('transform.resetScale', 'Reset size to the picture’s own', 'Transform', undefined, { needs: 1 }),
  row('transform.resetCrop', 'Reset crop', 'Transform', undefined, { needs: 1 }),
  row('transform.resetAll', 'Reset rotation, size, crop, flips and opacity', 'Transform', undefined, { needs: 1 }),
  // arrange
  row('arrange.menu', 'Arrange menu', 'Arrange', 'A'),
  row('arrange.optimal', 'Arrange: optimal', 'Arrange'),
  row('arrange.row', 'Arrange: in a row', 'Arrange'),
  row('arrange.column', 'Arrange: in a column', 'Arrange'),
  row('arrange.grid', 'Arrange: in a grid', 'Arrange'),
  row('arrange.stack', 'Arrange: in a pile', 'Arrange'),
  row('sort.name', 'Sort by name', 'Arrange'),
  row('sort.added', 'Sort by the order they were added', 'Arrange'),
  row('sort.size', 'Sort by size', 'Arrange'),
  row('sort.shuffle', 'Shuffle', 'Arrange'),
  row('align.left', 'Align left', 'Arrange', undefined, { needs: 2 }),
  row('align.right', 'Align right', 'Arrange', undefined, { needs: 2 }),
  row('align.top', 'Align top', 'Arrange', undefined, { needs: 2 }),
  row('align.bottom', 'Align bottom', 'Arrange', undefined, { needs: 2 }),
  row('align.centerH', 'Align centres horizontally', 'Arrange', undefined, { needs: 2 }),
  row('align.centerV', 'Align centres vertically', 'Arrange', undefined, { needs: 2 }),
  row('distribute.h', 'Distribute horizontally', 'Arrange', undefined, { needs: 3 }),
  row('distribute.v', 'Distribute vertically', 'Arrange', undefined, { needs: 3 }),
  row('normalize.width', 'Make the same width', 'Arrange', undefined, { needs: 2 }),
  row('normalize.height', 'Make the same height', 'Arrange', undefined, { needs: 2 }),
  row('normalize.size', 'Make the same size', 'Arrange', undefined, { needs: 2 }),
  row('normalize.scale', 'Show at the pictures’ own size', 'Arrange', undefined, { needs: 1 }),
  // appearance
  row('view.gray', 'Grey the whole board', 'Appearance', 'G'),
  row('view.grayItem', 'Grey the selected pictures', 'Appearance', '⇧ G', { needs: 1 }),
  row('view.smooth', 'Smooth or crisp pixels', 'Appearance', 'S'),
  row('view.captions', 'Captions', 'Appearance', 'N'),
  row('view.background', 'Next background colour', 'Appearance', 'B'),
  row('view.gridSnap', 'Snap to grid', 'Appearance', '⇧ S'),
  row('item.opacityUp', 'More opaque', 'Appearance', '⌥ ]', { needs: 1 }),
  row('item.opacityDown', 'More transparent', 'Appearance', '⌥ [', { needs: 1 }),
  // view
  row('view.fitAll', 'Fit all', 'View', 'Home / F'),
  row('view.fitSelection', 'Fit the selection', 'View', '⇧ F / Z'),
  row('view.zoom100', 'Zoom to 100%', 'View', '1'),
  row('view.zoomIn', 'Zoom in', 'View', '+ / ='),
  row('view.zoomOut', 'Zoom out', 'View', '-'),
  row('view.hideUi', 'Hide or show the toolbar', 'View', 'Tab'),
  // pictures
  row('picture.add', 'Add pictures…', 'Pictures', '⌘ O'),
  row('picture.open', 'Open in the image program', 'Pictures', 'Enter', { needs: 1 }),
  row('picture.reveal', 'Show in the file manager', 'Pictures', undefined, { needs: 1, desktopOnly: true }),
  row('picture.showInBrain', 'Show in the brain', 'Pictures', undefined, { needs: 1 }),
  row('picture.info', 'Picture info', 'Pictures', undefined, { needs: 1 }),
  row('picture.palette', 'Extract a colour palette', 'Pictures', undefined, { needs: 1 }),
  row('export.selection', 'Export the selection as a picture', 'Pictures', '⌘ E', { needs: 1 }),
  row('export.board', 'Export the whole board as a picture', 'Pictures', '⌘ ⇧ E'),
  // window (desktop)
  row('window.popOut', 'Pop out into its own window', 'Window', undefined, { desktopOnly: true }),
  row('window.dock', 'Dock back into the app', 'Window', undefined, { desktopOnly: true }),
  row('window.onTop', 'Window always on top', 'Window', undefined, { desktopOnly: true }),
]

const BY_ID = new Map<BoardCommandId, BoardCommandInfo>(BOARD_COMMANDS.map((c) => [c.id, c]))

/** The row of a command. */
export function commandInfo(id: BoardCommandId): BoardCommandInfo {
  const info = BY_ID.get(id)
  if (!info) throw new Error(`unknown board command ${String(id)}`)
  return info
}

/* ------------------------------------------------------------------ keys --- */

/** The names a key can have in a `keys` text, besides a single character. */
const NAMED: Record<string, string> = { Esc: 'escape', Delete: 'delete', '⌫': 'backspace', Enter: 'enter', Tab: 'tab', Home: 'home', F2: 'f2' }

/** Keys whose Shift state does not matter: Shift is how a keyboard makes a plus, and a French keyboard makes its digits with Shift. */
const SHIFT_FREE = new Set(['+', '=', '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])

/** Commands that make sense to fire again and again while a key is held. */
const REPEATABLE = new Set<BoardCommandId>(['edit.undo', 'edit.redo', 'item.opacityUp', 'item.opacityDown', 'view.zoomIn', 'view.zoomOut'])

/** A key as the table compares it: modifiers in a fixed order, then the key's own name (lower case). */
function signature(mod: boolean, shift: boolean, alt: boolean, key: string): string {
  return `${mod ? '⌘' : ''}${shift && !SHIFT_FREE.has(key) ? '⇧' : ''}${alt ? '⌥' : ''}${key}`
}

/** Reads one key of a `keys` text ("⌘ ⇧ Z") into its signature. */
function signatureOfText(text: string): string {
  let mod = false
  let shift = false
  let alt = false
  let key = ''
  for (const token of text.trim().split(/\s+/)) {
    if (token === '⌘') mod = true
    else if (token === '⇧') shift = true
    else if (token === '⌥') alt = true
    else key = NAMED[token] ?? token.toLowerCase()
  }
  return signature(mod, shift, alt, key)
}

/**
 * What an Option key on a Mac types on the bracket keys ('“', '‘', a dead key): not a letter and not ASCII. Only then does the key
 * code stand in for the bracket; on every other layout the key's own character decides (a German `+` sits where `]` does on a US board).
 */
function isOptionGlyph(key: string): boolean {
  if (key === 'Dead') return true
  return key.length === 1 && key.charCodeAt(0) > 126 && !/\p{L}/u.test(key)
}

/**
 * The lower-case name of a one-character key as a US keyboard would type it: the character itself when it is ASCII (a Dvorak, AZERTY
 * or Colemak layout types what it types), else - a letter or digit of another script (Cyrillic, Greek, Hebrew, Arabic ...) - the Latin
 * letter or digit on the same physical key, read from the key code, so that Ctrl+Z is Ctrl+Z on every layout. A character that no
 * letter or digit code names stays as it is. For the shortcuts of the app too (`useKeyboard`).
 */
export function latinKey(key: string, code: string): string {
  const k = key.toLowerCase()
  if (k.length !== 1 || k.charCodeAt(0) <= 0x7f) return k
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code)
  return m ? (m[1] ?? m[2]!).toLowerCase() : k
}

/** The signature of a key event, or null for a key no row can name (a modifier on its own, a dead key, an IME's 'Process'). */
function signatureOfEvent(e: KeyIn): string | null {
  let key: string
  let ctrl = e.ctrl
  let alt = e.alt
  if (e.key === '[' || e.key === ']') {
    key = e.key
    // Windows reports AltGr, which types a bracket on many layouts, as Ctrl+Alt: the bracket typed is then a bare one.
    if (ctrl && alt && !e.meta) {
      ctrl = false
      alt = false
    } else if (alt && !ctrl && e.code !== '' && e.code !== 'BracketLeft' && e.code !== 'BracketRight') {
      // A Mac layout where Option types the bracket (German: Option+5 is `[`, Option+6 `]`) reports it with alt on a key that is not
      // the bracket key: the character came from Option, so it is the bare bracket. On the bracket key itself (Alt+] on Windows and
      // Linux) alt is the chord's.
      alt = false
    }
  } else if (e.alt && (e.code === 'BracketLeft' || e.code === 'BracketRight') && isOptionGlyph(e.key)) {
    key = e.code === 'BracketLeft' ? '[' : ']'
  } else if (e.key.length === 1) {
    key = latinKey(e.key, e.code)
  } else if (e.key === 'Escape') key = 'escape'
  else if (e.key === 'Delete') key = 'delete'
  else if (e.key === 'Backspace') key = 'backspace'
  else if (e.key === 'Enter') key = 'enter'
  else if (e.key === 'Tab') key = 'tab'
  else if (e.key === 'Home') key = 'home'
  else if (e.key === 'F2') key = 'f2'
  else return null
  return signature(ctrl || e.meta, e.shift, alt, key)
}

const BINDINGS = new Map<string, BoardCommandId>()
for (const c of BOARD_COMMANDS) {
  if (!c.keys) continue
  for (const alternative of c.keys.split(' / ')) BINDINGS.set(signatureOfText(alternative), c.id)
}

export interface KeyContext {
  tool: BoardTool
  /** A note is being edited: the board does not take keys then (the shell does not even ask). */
  editing: boolean
  /** A picture is being cropped. */
  cropping: boolean
}

/**
 * The command a key press runs, or null when the board has no use for it. Only presses count (`down`), and nothing while a note is
 * being edited. In the crop tool Enter and Esc finish cropping, which is leaving for the select tool; everywhere else Esc is "select
 * none" (the controller's Esc ladder goes further: it cancels a drag first and leaves the tool last). Arrow keys (nudge) and Space
 * (pan) are not commands: the controller takes them itself.
 */
export function keyToCommand(e: KeyIn, ctx: KeyContext): BoardCommandId | null {
  if (!e.down || ctx.editing) return null
  const sig = signatureOfEvent(e)
  if (sig === null) return null
  if ((ctx.cropping || ctx.tool === 'crop') && (sig === 'enter' || sig === 'escape')) return 'tool.select'
  return BINDINGS.get(sig) ?? null
}

/** Whether holding the key down should keep running the command; the controller swallows the repeats of every other one. */
export function isRepeatable(id: BoardCommandId): boolean {
  return REPEATABLE.has(id)
}

/**
 * The cheatsheet's rows for the board: every command that has a key, then the gestures and the keys that are not commands. The shell
 * registers these with `registerHelpRows` and a test keeps docs/KEYBOARD.md in step.
 */
export function boardHelpRows(): { keys: string; label: string }[] {
  const rows = BOARD_COMMANDS.filter((c) => c.keys).map((c) => ({ keys: c.keys!, label: c.title }))
  rows.push(
    { keys: '← ↑ → ↓', label: 'Nudge the selection 1 unit (⇧ 10 units)' },
    { keys: 'Space + drag', label: 'Pan' },
    { keys: 'Wheel', label: 'Zoom at the pointer' },
    { keys: '⇧ Wheel', label: 'Pan sideways' },
    { keys: '⌥ Wheel', label: 'Pan up and down' },
    { keys: 'Double-click', label: 'Edit a note, fit a picture, or add a note on empty canvas' },
  )
  return rows
}
