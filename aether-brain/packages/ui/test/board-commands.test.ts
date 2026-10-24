import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { build, Rig } from './board-controller-harness'
import type { BoardCommandId, BoardTool, KeyIn } from '../src/board/api'
import { BOARD_COMMANDS, boardHelpRows, commandInfo, isRepeatable, keyToCommand } from '../src/board/commands'

/* ------------------------------------------------------------ the id list --- */

/** Every id, as a record so that the compiler refuses a list that misses one or has one more than api.ts declares. */
const ALL_IDS: Record<BoardCommandId, true> = {
  'tool.select': true,
  'tool.hand': true,
  'tool.note': true,
  'tool.pen': true,
  'tool.line': true,
  'tool.rect': true,
  'tool.ellipse': true,
  'tool.eraser': true,
  'tool.sampler': true,
  'tool.crop': true,
  'tool.turn': true,
  'edit.undo': true,
  'edit.redo': true,
  'edit.selectAll': true,
  'edit.selectNone': true,
  'edit.invertSelection': true,
  'edit.duplicate': true,
  'edit.delete': true,
  'edit.copy': true,
  'edit.cut': true,
  'edit.paste': true,
  'edit.group': true,
  'edit.ungroup': true,
  'edit.lock': true,
  'edit.unlock': true,
  'note.edit': true,
  'order.front': true,
  'order.forward': true,
  'order.backward': true,
  'order.back': true,
  'transform.flipH': true,
  'transform.flipV': true,
  'transform.rotateCw': true,
  'transform.rotateCcw': true,
  'transform.resetRotation': true,
  'transform.resetScale': true,
  'transform.resetCrop': true,
  'transform.resetAll': true,
  'transform.resetView': true,
  'arrange.menu': true,
  'arrange.optimal': true,
  'arrange.row': true,
  'arrange.column': true,
  'arrange.grid': true,
  'arrange.stack': true,
  'sort.name': true,
  'sort.added': true,
  'sort.size': true,
  'sort.shuffle': true,
  'align.left': true,
  'align.right': true,
  'align.top': true,
  'align.bottom': true,
  'align.centerH': true,
  'align.centerV': true,
  'distribute.h': true,
  'distribute.v': true,
  'normalize.width': true,
  'normalize.height': true,
  'normalize.size': true,
  'normalize.scale': true,
  'view.gray': true,
  'view.grayItem': true,
  'view.smooth': true,
  'view.captions': true,
  'view.background': true,
  'view.gridSnap': true,
  'item.opacityUp': true,
  'item.opacityDown': true,
  'view.fitAll': true,
  'view.fitSelection': true,
  'view.zoom100': true,
  'view.zoomIn': true,
  'view.zoomOut': true,
  'view.hideUi': true,
  'picture.add': true,
  'picture.open': true,
  'picture.reveal': true,
  'picture.showInBrain': true,
  'picture.info': true,
  'picture.palette': true,
  'export.selection': true,
  'export.board': true,
  'window.popOut': true,
  'window.dock': true,
  'window.onTop': true,
}

/** The ids as api.ts spells them (read from its source, so a new id there cannot be forgotten here). */
function declaredIds(): string[] {
  const src = readFileSync(new URL('../src/board/api.ts', import.meta.url), 'utf8')
  const from = src.indexOf('export type BoardCommandId')
  const to = src.indexOf('export interface BoardCommandInfo')
  expect(from).toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  return [...src.slice(from, to).matchAll(/'([a-z]+\.[A-Za-z0-9]+)'/g)].map((m) => m[1]!)
}

describe('the command table', () => {
  it('has one row for every id api.ts declares, and no other', () => {
    const declared = declaredIds()
    expect(new Set(declared).size).toBe(declared.length)
    expect(declared.length).toBeGreaterThan(70)
    expect([...declared].sort()).toEqual(Object.keys(ALL_IDS).sort())
    expect(BOARD_COMMANDS.map((c) => c.id).sort()).toEqual([...declared].sort())
    expect(new Set(BOARD_COMMANDS.map((c) => c.id)).size).toBe(BOARD_COMMANDS.length)
  })

  it('looks a row up by id', () => {
    for (const c of BOARD_COMMANDS) expect(commandInfo(c.id)).toBe(c)
    expect(() => commandInfo('nope' as BoardCommandId)).toThrow()
  })

  it('has a title, a group and a sensible need on every row', () => {
    const groups = new Set(['Tools', 'Edit', 'Order', 'Transform', 'Arrange', 'Appearance', 'View', 'Pictures', 'Window'])
    for (const c of BOARD_COMMANDS) {
      expect(c.title.trim(), c.id).not.toBe('')
      expect(c.title, c.id).not.toMatch(/^Board/)
      expect(groups.has(c.group), c.id).toBe(true)
      if (c.needs !== undefined) expect([1, 2, 3], c.id).toContain(c.needs)
    }
    expect(new Set(BOARD_COMMANDS.map((c) => c.title)).size).toBe(BOARD_COMMANDS.length)
  })

  it('groups the rows the way the id prefix says', () => {
    const want: Record<string, string> = { tool: 'Tools', edit: 'Edit', note: 'Edit', order: 'Order', transform: 'Transform', arrange: 'Arrange', sort: 'Arrange', align: 'Arrange', distribute: 'Arrange', normalize: 'Arrange', export: 'Pictures', picture: 'Pictures', window: 'Window', item: 'Appearance' }
    for (const c of BOARD_COMMANDS) {
      const prefix = c.id.split('.')[0]!
      if (prefix === 'view') expect(['Appearance', 'View'], c.id).toContain(c.group)
      else expect(c.group, c.id).toBe(want[prefix])
    }
  })

  it('offers only the desktop what is only the desktop\'s', () => {
    const desktop = BOARD_COMMANDS.filter((c) => c.desktopOnly).map((c) => c.id)
    expect(desktop.sort()).toEqual(['picture.reveal', 'window.dock', 'window.onTop', 'window.popOut'])
  })

  it('needs enough items for what the command does', () => {
    expect(commandInfo('edit.group').needs).toBe(2)
    expect(commandInfo('align.left').needs).toBe(2)
    expect(commandInfo('distribute.h').needs).toBe(3)
    expect(commandInfo('edit.delete').needs).toBe(1)
    expect(commandInfo('edit.selectAll').needs).toBeUndefined()
    expect(commandInfo('arrange.row').needs).toBeUndefined()
  })
})

/* ------------------------------------------------------------------- keys --- */

/** The alternatives of a row's keys text. */
const alternatives = (keys: string): string[] => keys.split(' / ')

/** A key text in a fixed form: modifiers sorted, the key lower case. */
function canonical(text: string): string {
  const tokens = text.trim().split(/\s+/)
  const mods = tokens.filter((t) => t === '⌘' || t === '⇧' || t === '⌥').sort()
  const key = tokens.filter((t) => t !== '⌘' && t !== '⇧' && t !== '⌥').join(' ')
  return [...mods, key.toLowerCase()].join(' ')
}

/** The key event a keys text means (ctrl or meta for ⌘). */
function eventFor(text: string, mod: 'ctrl' | 'meta' = 'ctrl'): KeyIn {
  const tokens = text.trim().split(/\s+/)
  const name = tokens[tokens.length - 1]!
  const shift = tokens.includes('⇧')
  const e: KeyIn = { key: name, code: name, down: true, shift, ctrl: false, alt: tokens.includes('⌥'), meta: false, repeat: false }
  if (tokens.includes('⌘')) e[mod] = true
  const named: Record<string, string> = { Esc: 'Escape', '⌫': 'Backspace' }
  if (named[name]) {
    e.key = named[name]!
    e.code = named[name]!
  } else if (name === '[' || name === ']') {
    e.code = name === '[' ? 'BracketLeft' : 'BracketRight'
    // With Alt a Mac types another character; the code is what counts.
    e.key = e.alt ? '“' : name
  } else if (/^[a-z]$/i.test(name)) {
    e.key = shift ? name.toUpperCase() : name.toLowerCase()
    e.code = `Key${name.toUpperCase()}`
  } else if (/^\d$/.test(name)) {
    e.code = `Digit${name}`
  }
  return e
}

const rest = { tool: 'select', editing: false, cropping: false } as const

describe('the keys', () => {
  const rows = BOARD_COMMANDS.filter((c) => c.keys)

  it('are not used twice, in any order of the modifiers or case', () => {
    const seen = new Map<string, BoardCommandId>()
    for (const c of rows) {
      for (const alt of alternatives(c.keys!)) {
        const k = canonical(alt)
        expect(seen.get(k), `${alt} on ${c.id} and ${seen.get(k)}`).toBeUndefined()
        seen.set(k, c.id)
      }
    }
    expect(seen.size).toBeGreaterThan(50)
    // The rows themselves do not repeat a key text either.
    expect(new Set(rows.map((c) => c.keys)).size).toBe(rows.length)
  })

  it('write modifiers in the order ⌘ ⇧ ⌥ and use no other words for them', () => {
    for (const c of rows) {
      for (const alt of alternatives(c.keys!)) {
        const tokens = alt.split(' ')
        expect(tokens.length, alt).toBeGreaterThanOrEqual(1)
        const mods = tokens.slice(0, -1)
        expect(mods.every((m) => m === '⌘' || m === '⇧' || m === '⌥'), alt).toBe(true)
        expect([...mods].sort((p, q) => '⌘⇧⌥'.indexOf(p) - '⌘⇧⌥'.indexOf(q)), alt).toEqual(mods)
      }
    }
  })

  it('every key in the table runs its command (with ctrl or with meta)', () => {
    for (const c of rows) {
      for (const alt of alternatives(c.keys!)) {
        for (const mod of ['ctrl', 'meta'] as const) {
          expect(keyToCommand(eventFor(alt, mod), rest), `${alt} (${mod}) for ${c.id}`).toBe(c.id)
        }
      }
    }
  })

  it('every key that runs a command is in the table for that command', () => {
    const names = [
      ...'abcdefghijklmnopqrstuvwxyz0123456789',
      '[',
      ']',
      '+',
      '=',
      '-',
      'Escape',
      'Delete',
      'Backspace',
      'Enter',
      'Tab',
      'Home',
      'End',
      'ArrowLeft',
      'ArrowUp',
      ' ',
      '.',
      ',',
      '/',
      '\\',
      "'",
      ';',
      'F1',
      'Shift',
      'Control',
      'Alt',
      'Meta',
      'Dead',
    ]
    let found = 0
    for (const name of names) {
      for (let mods = 0; mods < 16; mods++) {
        const e: KeyIn = {
          key: name.length === 1 && (mods & 1) !== 0 ? name.toUpperCase() : name,
          code: name === '[' ? 'BracketLeft' : name === ']' ? 'BracketRight' : name.length === 1 && /[a-z]/.test(name) ? `Key${name.toUpperCase()}` : name,
          down: true,
          shift: (mods & 1) !== 0,
          ctrl: (mods & 2) !== 0,
          alt: (mods & 4) !== 0,
          meta: (mods & 8) !== 0,
          repeat: false,
        }
        const id = keyToCommand(e, rest)
        if (id === null) continue
        found++
        const key = name === 'Escape' ? 'esc' : name === 'Backspace' ? '⌫' : name.toLowerCase()
        // Ctrl and Alt together with a bracket is AltGr on Windows: the bracket typed, bare.
        const altGr = (key === '[' || key === ']') && e.ctrl && e.alt && !e.meta
        const mod = (e.ctrl || e.meta) && !altGr
        const shiftFree = key === '+' || key === '=' || key === '-' || /^\d$/.test(key)
        const row = commandInfo(id)
        expect(row.keys, `${JSON.stringify(e)} runs ${id}`).toBeDefined()
        const want = alternatives(row.keys!).map(canonical)
        const mine = canonical([mod ? '⌘' : '', e.shift && !shiftFree ? '⇧' : '', e.alt && !altGr ? '⌥' : '', key].filter(Boolean).join(' '))
        expect(want, `${JSON.stringify(e)} runs ${id}`).toContain(mine)
      }
    }
    // Every alternative of every row was found at least once (they cannot all be missed).
    expect(found).toBeGreaterThan(rows.length)
  })

  it('a plain letter and the same letter with shift are different keys; any other modifier makes it nothing', () => {
    expect(keyToCommand({ ...eventFor('V'), shift: false }, rest)).toBe('tool.select')
    expect(keyToCommand(eventFor('⇧ V'), rest)).toBe('transform.flipV')
    expect(keyToCommand(eventFor('⌘ V'), rest)).toBe('edit.paste')
    expect(keyToCommand({ ...eventFor('V'), alt: true }, rest)).toBeNull()
    expect(keyToCommand({ ...eventFor('⇧ V'), alt: true }, rest)).toBeNull()
    expect(keyToCommand({ ...eventFor('⌘ V'), alt: true }, rest)).toBeNull()
    expect(keyToCommand({ ...eventFor('⌘ ⇧ V'), shift: true }, rest)).toBeNull()
  })

  it('caps lock (an upper case letter without shift) is the same key', () => {
    expect(keyToCommand({ ...eventFor('P'), key: 'P' }, rest)).toBe('tool.pen')
    expect(keyToCommand({ ...eventFor('⌘ Z'), key: 'Z' }, rest)).toBe('edit.undo')
  })

  it('plus, equals and minus zoom whatever shift says', () => {
    for (const shift of [false, true]) {
      expect(keyToCommand({ ...eventFor('='), shift }, rest)).toBe('view.zoomIn')
      expect(keyToCommand({ ...eventFor('='), key: '+', shift }, rest)).toBe('view.zoomIn')
      expect(keyToCommand({ ...eventFor('-'), shift }, rest)).toBe('view.zoomOut')
    }
    expect(keyToCommand({ ...eventFor('='), ctrl: true }, rest)).toBeNull()
  })

  it('brackets are found by their key code, so Alt on a Mac still works', () => {
    expect(keyToCommand({ key: '“', code: 'BracketLeft', down: true, shift: false, ctrl: false, alt: true, meta: false, repeat: false }, rest)).toBe('item.opacityDown')
    expect(keyToCommand({ key: '‘', code: 'BracketRight', down: true, shift: false, ctrl: false, alt: true, meta: false, repeat: false }, rest)).toBe('item.opacityUp')
    expect(keyToCommand({ key: '[', code: 'BracketLeft', down: true, shift: false, ctrl: true, alt: false, meta: false, repeat: false }, rest)).toBe('order.back')
    expect(keyToCommand({ key: '{', code: 'BracketLeft', down: true, shift: true, ctrl: false, alt: false, meta: false, repeat: false }, rest)).toBeNull()
  })

  it('only presses count, and nothing while a note is edited', () => {
    expect(keyToCommand({ ...eventFor('V'), down: false }, rest)).toBeNull()
    for (const c of rows) {
      expect(keyToCommand(eventFor(alternatives(c.keys!)[0]!), { ...rest, editing: true }), c.id).toBeNull()
    }
  })

  it('in the crop tool Enter and Esc go back to the select tool', () => {
    expect(keyToCommand(eventFor('Enter'), rest)).toBe('picture.open')
    expect(keyToCommand(eventFor('Esc'), rest)).toBe('edit.selectNone')
    for (const ctx of [
      { tool: 'crop', editing: false, cropping: true },
      { tool: 'crop', editing: false, cropping: false },
      { tool: 'select', editing: false, cropping: true },
    ] as const) {
      expect(keyToCommand(eventFor('Enter'), ctx)).toBe('tool.select')
      expect(keyToCommand(eventFor('Esc'), ctx)).toBe('tool.select')
      expect(keyToCommand(eventFor('C'), ctx)).toBe('tool.crop')
    }
  })

  it('the tool does not change what a key means otherwise', () => {
    const tools: BoardTool[] = ['select', 'hand', 'note', 'pen', 'line', 'rect', 'ellipse', 'eraser', 'sampler']
    for (const tool of tools) {
      for (const c of rows) {
        const e = eventFor(alternatives(c.keys!)[0]!)
        if (c.keys === 'Enter' || c.keys === 'Esc') continue
        expect(keyToCommand(e, { tool, editing: false, cropping: false }), `${c.id} in ${tool}`).toBe(c.id)
      }
    }
  })

  it('arrow keys and the space bar are the controller\'s own, not commands', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ']) {
      expect(keyToCommand({ key, code: key === ' ' ? 'Space' : key, down: true, shift: false, ctrl: false, alt: false, meta: false, repeat: false }, rest)).toBeNull()
    }
  })

  it('which commands may repeat while a key is held', () => {
    const repeating = BOARD_COMMANDS.filter((c) => isRepeatable(c.id)).map((c) => c.id)
    expect(repeating.sort()).toEqual(['edit.redo', 'edit.undo', 'item.opacityDown', 'item.opacityUp', 'view.zoomIn', 'view.zoomOut'])
  })

  it('the cheatsheet rows are the commands that have keys, then the gestures', () => {
    const help = boardHelpRows()
    const fromTable = rows.map((c) => ({ keys: c.keys!, label: c.title }))
    expect(help.slice(0, fromTable.length)).toEqual(fromTable)
    const extra = help.slice(fromTable.length)
    expect(extra.length).toBeGreaterThanOrEqual(4)
    expect(extra.map((r) => r.keys)).toContain('← ↑ → ↓')
    expect(extra.map((r) => r.keys)).toContain('Space + drag')
    expect(new Set(help.map((r) => r.keys)).size).toBe(help.length)
    for (const r of help) {
      expect(r.keys.trim()).not.toBe('')
      expect(r.label.trim()).not.toBe('')
    }
  })
})

/* ------------------------------------------------- every id does something --- */

/** A board with a bit of everything, and a state of the controller in which `id` has something to do. */
function ready(id: BoardCommandId): Rig {
  const b = build((x) =>
    x
      .pic('a', 0, 0, 100, 100, { rotation: 20, opacity: 0.8 })
      .pic('b', 300, 200, 200, 100, { crop: { l: 0, t: 0, r: 0.5, b: 1 } })
      .pic('c', 700, -50, 150, 150)
      .note('n', 100, 400, 200, 'note')
      .line('l', -300, 0, -200, 40),
  )
  const r = new Rig(b.doc)
  r.c.setNaturalSize('a.png', 400, 400)
  r.c.setNaturalSize('b.png', 800, 400)
  r.c.setNaturalSize('c.png', 300, 300)
  r.c.setView({ x: 50, y: 50, zoom: 2 })
  const pics = [b.id.a!, b.id.b!, b.id.c!]
  const select = (ids: number[]): void => {
    r.c.exec('edit.selectNone')
    for (const i of ids) {
      const it = r.item(i)
      const x = it.kind === 'picture' || it.kind === 'note' ? it.x : -300
      const y = it.kind === 'picture' || it.kind === 'note' ? it.y : 0
      r.click({ x: 500 + (x - 50) * 2, y: 400 + (y - 50) * 2 }, { shift: true })
    }
  }
  select(pics)
  if (id.startsWith('order.')) select([b.id.b!])
  if (id === 'edit.copy' || id === 'edit.paste') r.c.exec('edit.copy')
  if (id === 'edit.paste') select([])
  if (id === 'edit.undo') r.c.exec('view.gray')
  if (id === 'edit.redo') {
    r.c.exec('view.gray')
    r.c.exec('edit.undo')
  }
  if (id === 'edit.ungroup') r.c.exec('edit.group')
  if (id === 'edit.unlock') r.c.exec('edit.lock')
  if (id === 'edit.selectAll') select([b.id.a!])
  if (id === 'edit.invertSelection') select([b.id.a!])
  if (id === 'tool.select') r.c.exec('tool.pen')
  if (id === 'edit.selectNone') select([b.id.a!])
  if (id === 'tool.crop') select([b.id.a!])
  if (id === 'picture.palette') select([b.id.a!])
  return r
}

describe('every command is carried out', () => {
  for (const c of BOARD_COMMANDS) {
    it(`${c.id}: ${c.title}`, () => {
      const r = ready(c.id)
      r.forget()
      const before = r.s
      r.c.exec(c.id)
      const said = r.events.length > 0
      const changed = r.s !== before
      expect(said || changed, `${c.id} did nothing visible`).toBe(true)
    })
  }

  it('none of them throws, on an empty board, on a locked one and with nothing selected', () => {
    const lockedAll = build((x) => x.pic('a', 0, 0, 100, 100).pic('b', 300, 0, 100, 100).note('n', 0, 200, 100, 'x').line('l', 0, 400, 10, 410).lock('a', 'b', 'n', 'l'))
    for (const make of [
      () => new Rig(build(() => {}).doc),
      () => new Rig(lockedAll.doc),
      () => {
        const r = new Rig(lockedAll.doc)
        r.c.exec('edit.selectAll')
        return r
      },
      () => {
        const r = ready('edit.selectAll')
        r.c.exec('edit.selectNone')
        return r
      },
    ]) {
      for (const c of BOARD_COMMANDS) {
        const r = make()
        expect(() => r.c.exec(c.id), c.id).not.toThrow()
        expect(() => r.c.exec(c.id, 'junk'), c.id).not.toThrow()
        expect(() => r.c.exec(c.id, { gap: NaN, columns: -1 }), c.id).not.toThrow()
      }
    }
  })

  it('a locked selection refuses every command that would change it, and says so', () => {
    const lockedAll = build((x) => x.pic('a', 0, 0, 100, 100).pic('b', 300, 80, 100, 100).pic('c', 100, 300, 100, 100).lock('a', 'b', 'c'))
    const changing: BoardCommandId[] = [
      'edit.delete',
      'edit.cut',
      'edit.group',
      'order.front',
      'order.back',
      'transform.flipH',
      'transform.flipV',
      'transform.rotateCw',
      'transform.rotateCcw',
      'transform.resetRotation',
      'arrange.row',
      'arrange.column',
      'arrange.grid',
      'sort.name',
      'align.left',
      'align.top',
      'distribute.h',
      'normalize.width',
      'item.opacityDown',
      'view.grayItem',
    ]
    for (const id of changing) {
      const r = new Rig(lockedAll.doc)
      r.c.exec('edit.selectAll')
      r.forget()
      r.c.exec(id)
      expect(r.doc.items, id).toBe(lockedAll.doc.items)
      expect(r.toasts('locked').length, id).toBeGreaterThan(0)
      expect(r.s.canUndo, id).toBe(false)
    }
  })
})
