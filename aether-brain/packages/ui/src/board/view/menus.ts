/**
 * The board's menus, built from BOARD_COMMANDS: the Edit, Arrange, View and Export drop-downs of the toolbar and the context menu.
 * Every command lives in exactly one home (`COMMAND_HOME`, a Record over the command ids, so a new command that is not given a place
 * does not compile), a menu is a list of entries with the command's own title and keys, and whether an entry is enabled follows the
 * selection (`needs`) and what the host can do. No React, no DOM. Design: docs/design/reference-board.md.
 */
import type { BoardCommandId, BoardUiState } from '../api'
import { BOARD_COMMANDS, commandInfo } from '../commands'

/** Where a command is reached by mouse. */
export type MenuHome = 'tool' | 'edit' | 'arrange' | 'view' | 'export' | 'add' | 'arrangeButton' | 'window'

export const COMMAND_HOME: Record<BoardCommandId, MenuHome> = {
  'tool.select': 'tool',
  'tool.hand': 'tool',
  'tool.note': 'tool',
  'tool.pen': 'tool',
  'tool.line': 'tool',
  'tool.rect': 'tool',
  'tool.ellipse': 'tool',
  'tool.eraser': 'tool',
  'tool.sampler': 'tool',
  'tool.crop': 'tool',
  'edit.undo': 'edit',
  'edit.redo': 'edit',
  'edit.selectAll': 'edit',
  'edit.selectNone': 'edit',
  'edit.invertSelection': 'edit',
  'edit.duplicate': 'edit',
  'edit.delete': 'edit',
  'edit.copy': 'edit',
  'edit.cut': 'edit',
  'edit.paste': 'edit',
  'edit.group': 'edit',
  'edit.ungroup': 'edit',
  'edit.lock': 'edit',
  'edit.unlock': 'edit',
  'note.edit': 'edit',
  'order.front': 'edit',
  'order.forward': 'edit',
  'order.backward': 'edit',
  'order.back': 'edit',
  'transform.flipH': 'edit',
  'transform.flipV': 'edit',
  'transform.rotateCw': 'edit',
  'transform.rotateCcw': 'edit',
  'transform.resetRotation': 'edit',
  'transform.resetScale': 'edit',
  'transform.resetCrop': 'edit',
  'transform.resetAll': 'edit',
  'arrange.menu': 'arrangeButton',
  'arrange.optimal': 'arrange',
  'arrange.row': 'arrange',
  'arrange.column': 'arrange',
  'arrange.grid': 'arrange',
  'arrange.stack': 'arrange',
  'sort.name': 'arrange',
  'sort.added': 'arrange',
  'sort.size': 'arrange',
  'sort.shuffle': 'arrange',
  'align.left': 'arrange',
  'align.right': 'arrange',
  'align.top': 'arrange',
  'align.bottom': 'arrange',
  'align.centerH': 'arrange',
  'align.centerV': 'arrange',
  'distribute.h': 'arrange',
  'distribute.v': 'arrange',
  'normalize.width': 'arrange',
  'normalize.height': 'arrange',
  'normalize.size': 'arrange',
  'normalize.scale': 'arrange',
  'view.gray': 'view',
  'view.grayItem': 'view',
  'view.smooth': 'view',
  'view.captions': 'view',
  'view.background': 'view',
  'view.gridSnap': 'view',
  'item.opacityUp': 'view',
  'item.opacityDown': 'view',
  'view.fitAll': 'view',
  'view.fitSelection': 'view',
  'view.zoom100': 'view',
  'view.zoomIn': 'view',
  'view.zoomOut': 'view',
  'view.hideUi': 'view',
  'picture.add': 'add',
  'picture.open': 'edit',
  'picture.reveal': 'edit',
  'picture.showInBrain': 'edit',
  'picture.info': 'edit',
  'picture.palette': 'edit',
  'export.selection': 'export',
  'export.board': 'export',
  'window.popOut': 'window',
  'window.dock': 'window',
  'window.onTop': 'window',
}

/** What the menus need to know to enable, check and hide entries. */
export interface MenuContext {
  /** Items selected, and of those the pictures and the notes. */
  selected: number
  pictures: number
  notes: number
  /** Some selected item belongs to a group; how many of the selected items are locked. */
  grouped: boolean
  locked: number
  canPaste: boolean
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  gray: boolean
  smooth: boolean
  captions: boolean
  gridSnap: boolean
  /** What the host can do with a picture, and whether it has window controls. */
  can: { open: boolean; reveal: boolean; showInBrain: boolean; window: boolean; floating: boolean; alwaysOnTop: boolean }
}

export const EMPTY_MENU_CONTEXT: MenuContext = Object.freeze({
  selected: 0,
  pictures: 0,
  notes: 0,
  grouped: false,
  locked: 0,
  canPaste: false,
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  gray: false,
  smooth: true,
  captions: false,
  gridSnap: false,
  can: Object.freeze({ open: false, reveal: false, showInBrain: false, window: false, floating: false, alwaysOnTop: false }),
}) as MenuContext

/** The menu context for the board as the controller shows it now. */
export function menuContextOf(state: BoardUiState, can: MenuContext['can']): MenuContext {
  const chosen = new Set(state.selection)
  let pictures = 0
  let notes = 0
  let locked = 0
  let grouped = false
  for (const it of state.doc.items) {
    if (!chosen.has(it.id)) continue
    if (it.kind === 'picture') pictures++
    if (it.kind === 'note') notes++
    if (it.locked) locked++
    if (it.group > 0) grouped = true
  }
  return {
    selected: state.selection.length,
    pictures,
    notes,
    grouped,
    locked,
    canPaste: state.canPaste,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    undoLabel: state.undoLabel,
    redoLabel: state.redoLabel,
    gray: state.doc.gray,
    smooth: state.doc.smooth,
    captions: state.doc.captions,
    gridSnap: state.doc.grid > 0,
    can,
  }
}

export type MenuEntry =
  | { kind: 'heading'; label: string }
  | { kind: 'separator' }
  | { kind: 'command'; id: BoardCommandId; label: string; keys?: string; disabled: boolean; checked?: boolean; note?: string }
  /** Something the controller has an API for but no command: a note at the click. */
  | { kind: 'action'; action: 'add-note-here'; label: string; disabled: boolean }

/** "Arrange: in a row" → "In a row": inside the Arrange menu the prefix says nothing. */
function shortTitle(title: string): string {
  const m = /^Arrange: (.)(.*)$/.exec(title)
  return m ? m[1]!.toUpperCase() + m[2]! : title
}

const PICTURE_COMMANDS: ReadonlySet<BoardCommandId> = new Set<BoardCommandId>([
  'picture.open',
  'picture.reveal',
  'picture.showInBrain',
  'picture.info',
  'picture.palette',
  'view.grayItem',
  'item.opacityUp',
  'item.opacityDown',
  'transform.resetCrop',
  'transform.resetScale',
  'normalize.scale',
])

/** Whether the host leaves the command out altogether (a picture program it does not have, a window it is not). */
export function commandHidden(id: BoardCommandId, ctx: MenuContext): boolean {
  switch (id) {
    case 'picture.open':
      return !ctx.can.open
    case 'picture.reveal':
      return !ctx.can.reveal
    case 'picture.showInBrain':
      return !ctx.can.showInBrain
    case 'window.popOut':
      return !ctx.can.window || ctx.can.floating
    case 'window.dock':
      return !ctx.can.window || !ctx.can.floating
    case 'window.onTop':
      return !ctx.can.window || !ctx.can.floating
    default:
      return false
  }
}

/** Whether a shown command can be run now. */
export function commandDisabled(id: BoardCommandId, ctx: MenuContext): boolean {
  const info = commandInfo(id)
  switch (id) {
    case 'edit.undo':
      return !ctx.canUndo
    case 'edit.redo':
      return !ctx.canRedo
    // Editing a note's text is for one note (the controller does nothing for anything else).
    case 'note.edit':
      return ctx.selected !== 1 || ctx.notes !== 1
    case 'tool.crop':
    // Paste is always offered: with nothing of the board's own to paste it says how to paste what is on the system clipboard (⌘ V).
    case 'edit.paste':
    case 'picture.add':
    case 'export.board':
      return false
    default:
      break
  }
  if ((info.needs ?? 0) > ctx.selected) return true
  if (PICTURE_COMMANDS.has(id) && ctx.pictures === 0) return true
  return false
}

/** One command as a menu entry, with the title and keys of its row. */
export function commandEntry(id: BoardCommandId, ctx: MenuContext, title?: string): MenuEntry {
  const info = commandInfo(id)
  const entry: MenuEntry = { kind: 'command', id, label: title ?? shortTitle(info.title), disabled: commandDisabled(id, ctx) }
  if (info.keys) entry.keys = info.keys
  if (id === 'edit.undo' && ctx.undoLabel) entry.note = ctx.undoLabel
  if (id === 'edit.redo' && ctx.redoLabel) entry.note = ctx.redoLabel
  if (id === 'view.gray') entry.checked = ctx.gray
  else if (id === 'view.smooth') entry.checked = ctx.smooth
  else if (id === 'view.captions') entry.checked = ctx.captions
  else if (id === 'view.gridSnap') entry.checked = ctx.gridSnap
  else if (id === 'window.onTop') entry.checked = ctx.can.alwaysOnTop
  return entry
}

/** The commands of a group of the table, in the table's order, minus the ones the host leaves out. */
function ofGroup(group: string, ctx: MenuContext, ids?: readonly BoardCommandId[]): MenuEntry[] {
  const list = ids ?? BOARD_COMMANDS.filter((c) => c.group === group).map((c) => c.id)
  return list.filter((id) => !commandHidden(id, ctx)).map((id) => commandEntry(id, ctx))
}

const idsWithPrefix = (...prefixes: string[]): BoardCommandId[] =>
  BOARD_COMMANDS.filter((c) => prefixes.some((p) => c.id.startsWith(p))).map((c) => c.id)

function sections(...parts: [string | null, MenuEntry[]][]): MenuEntry[] {
  const out: MenuEntry[] = []
  for (const [heading, entries] of parts) {
    if (entries.length === 0) continue
    if (out.length > 0) out.push({ kind: 'separator' })
    if (heading) out.push({ kind: 'heading', label: heading })
    out.push(...entries)
  }
  return out
}

/** The toolbar's tools, in the table's order. */
export function toolEntries(ctx: MenuContext): MenuEntry[] {
  return ofGroup('Tools', ctx)
}

/** Edit ▾: editing, stacking order, transforms, and what can be done with the selected pictures. */
export function editMenu(ctx: MenuContext): MenuEntry[] {
  return sections(
    ['Edit', ofGroup('Edit', ctx)],
    ['Order', ofGroup('Order', ctx)],
    ['Transform', ofGroup('Transform', ctx)],
    ['Picture', ofGroup('Pictures', ctx, ['picture.open', 'picture.reveal', 'picture.showInBrain', 'picture.info', 'picture.palette'])],
  )
}

/** Arrange ▾: layouts, sorting, aligning, spreading and sizing the selection (or the whole board). */
export function arrangeMenu(ctx: MenuContext): MenuEntry[] {
  return sections(
    ['Layout', ofGroup('Arrange', ctx, idsWithPrefix('arrange.').filter((id) => id !== 'arrange.menu'))],
    ['Sort', ofGroup('Arrange', ctx, idsWithPrefix('sort.'))],
    ['Align', ofGroup('Arrange', ctx, idsWithPrefix('align.'))],
    ['Distribute', ofGroup('Arrange', ctx, idsWithPrefix('distribute.'))],
    ['Size', ofGroup('Arrange', ctx, idsWithPrefix('normalize.'))],
  )
}

/** View ▾: the camera, the look of the board, and the toolbar. */
export function viewMenu(ctx: MenuContext): MenuEntry[] {
  return sections(
    ['Camera', ofGroup('View', ctx)],
    ['Look', ofGroup('Appearance', ctx)],
  )
}

/** Export ▾. */
export function exportMenu(ctx: MenuContext): MenuEntry[] {
  return ofGroup('Pictures', ctx, ['export.selection', 'export.board'])
}

/** The window controls the toolbar shows as buttons (floating window: dock and on top; docked: pop out). */
export function windowEntries(ctx: MenuContext): MenuEntry[] {
  return ofGroup('Window', ctx)
}

/**
 * The context menu: on an item or the selection, what can be done to them; on the empty canvas, what can be put there. `target` is
 * what is under the pointer (the selection already includes it: the controller selects on a right press).
 */
export function contextMenu(ctx: MenuContext, target: 'item' | 'canvas', singleNote = false): MenuEntry[] {
  if (target === 'canvas') {
    return sections([
      null,
      [
        commandEntry('edit.paste', ctx),
        { kind: 'action', action: 'add-note-here', label: 'Add a note here', disabled: false },
        commandEntry('picture.add', ctx),
        commandEntry('edit.selectAll', ctx),
        commandEntry('view.fitAll', ctx),
      ],
    ])
  }
  const picture = ctx.pictures > 0
  const edit: MenuEntry[] = [
    commandEntry('edit.copy', ctx),
    commandEntry('edit.cut', ctx),
    commandEntry('edit.duplicate', ctx),
    commandEntry('edit.delete', ctx),
  ]
  if (singleNote) edit.push(commandEntry('note.edit', ctx, 'Edit text'))
  // Only what makes sense for this selection: group needs two, ungroup a group, and a lock is either put on or taken off.
  const group: MenuEntry[] = []
  if (ctx.selected >= 2) group.push(commandEntry('edit.group', ctx))
  if (ctx.grouped) group.push(commandEntry('edit.ungroup', ctx))
  if (ctx.locked < ctx.selected) group.push(commandEntry('edit.lock', ctx))
  if (ctx.locked > 0) group.push(commandEntry('edit.unlock', ctx))
  const order = ofGroup('Order', ctx)
  const transform: MenuEntry[] = [
    commandEntry('transform.flipH', ctx),
    commandEntry('transform.flipV', ctx),
    commandEntry('transform.rotateCw', ctx),
    commandEntry('transform.rotateCcw', ctx),
  ]
  const look: MenuEntry[] = picture ? [commandEntry('view.grayItem', ctx), commandEntry('tool.crop', ctx, 'Crop')] : []
  const pictures = picture
    ? ofGroup('Pictures', ctx, ['picture.open', 'picture.reveal', 'picture.showInBrain', 'picture.info', 'picture.palette', 'export.selection'])
    : []
  return sections([null, edit], [null, group], ['Order', order], ['Transform', [...transform, ...look]], ['Picture', pictures])
}

/** Every command a menu or a button of the toolbar reaches, with how many places it is in (for the test that none is lost or doubled). */
export function reachableCommands(ctx: MenuContext): Map<BoardCommandId, number> {
  const count = new Map<BoardCommandId, number>()
  const add = (entries: MenuEntry[]): void => {
    for (const e of entries) if (e.kind === 'command') count.set(e.id, (count.get(e.id) ?? 0) + 1)
  }
  add(toolEntries(ctx))
  add(editMenu(ctx))
  add(arrangeMenu(ctx))
  add(viewMenu(ctx))
  add(exportMenu(ctx))
  add(windowEntries(ctx))
  add([commandEntry('picture.add', ctx)])
  // The Arrange button is the command `arrange.menu`: pressing it opens the menu.
  add([commandEntry('arrange.menu', ctx)])
  return count
}
