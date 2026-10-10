import { describe, expect, it } from 'vitest'
import { BOARD_COMMANDS } from '../src/board/commands'
import {
  COMMAND_HOME,
  EMPTY_MENU_CONTEXT,
  arrangeMenu,
  commandDisabled,
  commandHidden,
  contextMenu,
  editMenu,
  exportMenu,
  reachableCommands,
  toolEntries,
  viewMenu,
  windowEntries,
  type MenuContext,
  type MenuEntry,
} from '../src/board/view/menus'

const full = (over: Partial<MenuContext> = {}, can: Partial<MenuContext['can']> = {}): MenuContext => ({
  ...EMPTY_MENU_CONTEXT,
  selected: 3,
  pictures: 2,
  grouped: false,
  locked: 0,
  canPaste: true,
  canUndo: true,
  canRedo: true,
  can: { open: true, reveal: true, showInBrain: true, window: true, floating: false, alwaysOnTop: false, ...can },
  ...over,
})

const commands = (entries: MenuEntry[]) => entries.flatMap((e) => (e.kind === 'command' ? [e] : []))

describe('the board menus', () => {
  it('every command has exactly one place, and the table of places has nothing else', () => {
    expect(Object.keys(COMMAND_HOME).sort()).toEqual(BOARD_COMMANDS.map((c) => c.id).sort())
  })

  it('every command that is not desktop-only is reachable by mouse exactly once', () => {
    const count = reachableCommands(full({}, { window: true, floating: true }))
    for (const c of BOARD_COMMANDS) {
      if (c.desktopOnly) continue
      expect(count.get(c.id), c.id).toBe(1)
    }
    // And nothing that is not a command of the table.
    for (const id of count.keys()) expect(BOARD_COMMANDS.some((c) => c.id === id), id).toBe(true)
  })

  it('desktop-only commands appear once the host can do them, and not before', () => {
    const none = reachableCommands(full({}, { open: true, reveal: false, showInBrain: true, window: false }))
    expect(none.get('picture.reveal')).toBeUndefined()
    for (const id of ['window.popOut', 'window.dock', 'window.onTop'] as const) expect(none.get(id)).toBeUndefined()
    const docked = reachableCommands(full({}, { reveal: true, window: true, floating: false }))
    expect(docked.get('picture.reveal')).toBe(1)
    expect(docked.get('window.popOut')).toBe(1)
    expect(docked.get('window.dock')).toBeUndefined()
    const floating = reachableCommands(full({}, { reveal: true, window: true, floating: true }))
    expect(floating.get('window.dock')).toBe(1)
    expect(floating.get('window.onTop')).toBe(1)
    expect(floating.get('window.popOut')).toBeUndefined()
  })

  it('an entry carries its command’s own title and keys', () => {
    const ctx = full()
    const undo = commands(editMenu(ctx)).find((e) => e.id === 'edit.undo')!
    expect(undo).toMatchObject({ label: 'Undo', keys: '⌘ Z', disabled: false })
    const optimal = commands(arrangeMenu(ctx)).find((e) => e.id === 'arrange.optimal')!
    expect(optimal.label).toBe('Optimal')
    expect(commands(arrangeMenu(ctx)).find((e) => e.id === 'arrange.row')!.label).toBe('In a row')
    expect(commands(viewMenu(ctx)).find((e) => e.id === 'view.fitAll')).toMatchObject({ keys: 'Home / F' })
  })

  it('what needs a selection is disabled without one, and undo, redo and paste follow what can be done', () => {
    const empty = full({ selected: 0, pictures: 0, canPaste: false, canUndo: false, canRedo: false })
    const e = commands(editMenu(empty))
    const get = (id: string) => e.find((x) => x.id === id)!
    expect(get('edit.undo').disabled).toBe(true)
    expect(get('edit.redo').disabled).toBe(true)
    // Paste is always offered: with nothing copied on the board it says how to paste from the system clipboard.
    expect(get('edit.paste').disabled).toBe(false)
    expect(get('edit.delete').disabled).toBe(true)
    expect(get('edit.selectAll').disabled).toBe(false)
    expect(get('picture.info').disabled).toBe(true)
    expect(commands(arrangeMenu(empty)).find((x) => x.id === 'align.left')!.disabled).toBe(true)
    // Arranging everything needs no selection.
    expect(commands(arrangeMenu(empty)).find((x) => x.id === 'arrange.grid')!.disabled).toBe(false)
    // Two selected: align and group yes, distribute (three) no.
    const two = full({ selected: 2 })
    expect(commandDisabled('edit.group', two)).toBe(false)
    expect(commandDisabled('align.left', two)).toBe(false)
    expect(commandDisabled('distribute.h', two)).toBe(true)
    // Pictures only for the picture commands.
    const notes = full({ selected: 2, pictures: 0 })
    expect(commandDisabled('picture.open', notes)).toBe(true)
    expect(commandDisabled('view.grayItem', notes)).toBe(true)
    expect(commandDisabled('edit.delete', notes)).toBe(false)
  })

  it('the toggles show whether they are on', () => {
    const on = commands(viewMenu(full({ gray: true, smooth: false, captions: true, gridSnap: true })))
    const checked = (id: string) => on.find((x) => x.id === id)!.checked
    expect(checked('view.gray')).toBe(true)
    expect(checked('view.smooth')).toBe(false)
    expect(checked('view.captions')).toBe(true)
    expect(checked('view.gridSnap')).toBe(true)
    expect(on.find((x) => x.id === 'view.fitAll')!.checked).toBeUndefined()
  })

  it('undo and redo name the step they take back', () => {
    const e = commands(editMenu(full({ undoLabel: 'Move', redoLabel: 'Delete' })))
    expect(e.find((x) => x.id === 'edit.undo')!.note).toBe('Move')
    expect(e.find((x) => x.id === 'edit.redo')!.note).toBe('Delete')
  })

  it('menus have headings and separators between their parts, none at the ends', () => {
    for (const menu of [editMenu(full()), arrangeMenu(full()), viewMenu(full())]) {
      expect(menu[0]!.kind).toBe('heading')
      expect(menu.at(-1)!.kind).toBe('command')
      for (let i = 1; i < menu.length; i++) if (menu[i]!.kind === 'separator') expect(menu[i + 1]!.kind).toBe('heading')
    }
    expect(exportMenu(full()).map((e) => (e.kind === 'command' ? e.id : e.kind))).toEqual(['export.selection', 'export.board'])
    expect(toolEntries(full())).toHaveLength(10)
    expect(windowEntries(full({}, { window: false }))).toEqual([])
  })

  it('unsupported picture commands are left out, not greyed', () => {
    const ctx = full({}, { open: false, reveal: false, showInBrain: false })
    expect(commandHidden('picture.open', ctx)).toBe(true)
    const ids = commands(editMenu(ctx)).map((e) => e.id)
    expect(ids).not.toContain('picture.open')
    expect(ids).not.toContain('picture.reveal')
    expect(ids).not.toContain('picture.showInBrain')
    expect(ids).toContain('picture.info')
    expect(ids).toContain('picture.palette')
  })
})

describe('the context menu', () => {
  it('on empty canvas: paste, a note here, add picture, select all, fit all', () => {
    const entries = contextMenu(full({ selected: 0, pictures: 0 }), 'canvas')
    expect(entries.map((e) => (e.kind === 'command' ? e.id : e.kind === 'action' ? e.action : e.kind))).toEqual([
      'edit.paste',
      'add-note-here',
      'picture.add',
      'edit.selectAll',
      'view.fitAll',
    ])
    expect((entries[0] as { disabled: boolean }).disabled).toBe(false)
    expect((contextMenu(full({ selected: 0, canPaste: false }), 'canvas')[0] as { disabled: boolean }).disabled).toBe(false)
  })

  it('on a picture: copy, duplicate, delete, group, lock, order, flip, rotate, grey, crop, and what the host can do with the file', () => {
    const ids = commands(contextMenu(full({ selected: 2, pictures: 1, grouped: true, locked: 1 }), 'item')).map((e) => e.id)
    for (const want of [
      'edit.copy', 'edit.cut', 'edit.duplicate', 'edit.delete', 'edit.group', 'edit.ungroup', 'edit.lock', 'edit.unlock',
      'order.front', 'order.forward', 'order.backward', 'order.back', 'transform.flipH', 'transform.flipV', 'transform.rotateCw', 'transform.rotateCcw',
      'view.grayItem', 'tool.crop', 'picture.open', 'picture.reveal', 'picture.showInBrain', 'picture.info', 'picture.palette', 'export.selection',
    ] as const) {
      expect(ids, want).toContain(want)
    }
    // Every entry is a command of the table once, no more.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('group, ungroup, lock and unlock are offered only where they make sense', () => {
    const ids = (over: Partial<MenuContext>) => commands(contextMenu(full({ pictures: 1, ...over }), 'item')).map((e) => e.id)
    const one = ids({ selected: 1, grouped: false, locked: 0 })
    expect(one).not.toContain('edit.group')
    expect(one).not.toContain('edit.ungroup')
    expect(one).toContain('edit.lock')
    expect(one).not.toContain('edit.unlock')
    const locked = ids({ selected: 1, locked: 1 })
    expect(locked).toContain('edit.unlock')
    expect(locked).not.toContain('edit.lock')
    const mixed = ids({ selected: 3, grouped: true, locked: 1 })
    expect(mixed).toEqual(expect.arrayContaining(['edit.group', 'edit.ungroup', 'edit.lock', 'edit.unlock']))
  })

  it('on a note: no picture commands, but Edit text when it is the only thing selected', () => {
    const note = contextMenu(full({ selected: 1, pictures: 0 }), 'item', true)
    const ids = commands(note).map((e) => e.id)
    expect(ids).not.toContain('picture.open')
    expect(ids).not.toContain('tool.crop')
    // Editing the text is a command of the table now (F2, Enter), so the menu shows its key.
    expect(note.find((e) => e.kind === 'command' && e.id === 'note.edit')).toMatchObject({ label: 'Edit text', keys: 'F2' })
    expect(ids).toContain('note.edit')
    expect(contextMenu(full({ selected: 2, pictures: 0 }), 'item', false).some((e) => e.kind === 'command' && e.id === 'note.edit')).toBe(false)
  })
})
