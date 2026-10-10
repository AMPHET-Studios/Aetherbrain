/**
 * Keys on other keyboards (review findings controller-commands-2, controller-commands-3, controller-commands-m10) and the command that
 * edits a note (controller-commands-m5): brackets are the character typed, a letter of another script is the Latin letter on the same
 * key, and a French keyboard makes its 1 with Shift.
 */
import { describe, expect, it } from 'vitest'
import { BOARD_COMMANDS, commandInfo, keyToCommand } from '../src/board/commands'
import type { BoardCommandId, KeyIn } from '../src/board/api'
import { Rig, at, build, threeThings } from './board-controller-harness'

const rest = { tool: 'select', editing: false, cropping: false } as const

function key(k: string, code: string, m: Partial<KeyIn> = {}): KeyIn {
  return { key: k, code, down: true, shift: false, ctrl: false, alt: false, meta: false, repeat: false, ...m }
}

describe('brackets are the character the key types', () => {
  it('the + key of a German, Spanish or Italian keyboard (where ] sits on a US one) zooms in and no longer brings forward', () => {
    expect(keyToCommand(key('+', 'BracketRight'), rest)).toBe('view.zoomIn')
    expect(keyToCommand(key('*', 'BracketRight', { shift: true }), rest)).toBeNull()
    // Ctrl + the + key is not Ctrl + ] (bring to front).
    expect(keyToCommand(key('+', 'BracketRight', { ctrl: true }), rest)).toBeNull()
    expect(keyToCommand(key('+', 'BracketRight', { meta: true }), rest)).toBeNull()
  })

  it('the u-umlaut key (where [ sits on a US keyboard) and the dollar key of a French one are not brackets', () => {
    expect(keyToCommand(key('ü', 'BracketLeft'), rest)).toBeNull()
    expect(keyToCommand(key('ü', 'BracketLeft', { alt: true }), rest)).toBeNull()
    expect(keyToCommand(key('$', 'BracketRight'), rest)).toBeNull()
  })

  it('a Dvorak keyboard has = where ] sits and still zooms with it', () => {
    expect(keyToCommand(key('=', 'BracketRight'), rest)).toBe('view.zoomIn')
    expect(keyToCommand(key('[', 'Minus'), rest)).toBe('order.backward')
  })

  it('a bracket typed with AltGr (Ctrl+Alt on Windows) is the bare bracket', () => {
    expect(keyToCommand(key('[', 'Digit8', { ctrl: true, alt: true }), rest)).toBe('order.backward')
    expect(keyToCommand(key(']', 'Digit9', { ctrl: true, alt: true }), rest)).toBe('order.forward')
    // AltGr arrives as Alt only on some systems: that is the opacity key, as on a US keyboard with Alt.
    expect(keyToCommand(key('[', 'Digit5', { alt: true }), rest)).toBe('item.opacityDown')
    // Linux reports no modifier at all.
    expect(keyToCommand(key(']', 'Digit9'), rest)).toBe('order.forward')
  })

  it('an Option bracket on a Mac (another character, on the bracket key) is still the bracket', () => {
    expect(keyToCommand(key('“', 'BracketLeft', { alt: true }), rest)).toBe('item.opacityDown')
    expect(keyToCommand(key('‘', 'BracketRight', { alt: true }), rest)).toBe('item.opacityUp')
    expect(keyToCommand(key('Dead', 'BracketLeft', { alt: true }), rest)).toBe('item.opacityDown')
    // ... and only with Option: the same character without it is just a character.
    expect(keyToCommand(key('“', 'BracketLeft'), rest)).toBeNull()
  })

  it('US brackets are unchanged', () => {
    expect(keyToCommand(key('[', 'BracketLeft'), rest)).toBe('order.backward')
    expect(keyToCommand(key(']', 'BracketRight'), rest)).toBe('order.forward')
    expect(keyToCommand(key('[', 'BracketLeft', { ctrl: true }), rest)).toBe('order.back')
    expect(keyToCommand(key(']', 'BracketRight', { meta: true }), rest)).toBe('order.front')
    expect(keyToCommand(key('{', 'BracketLeft', { shift: true }), rest)).toBeNull()
  })

  it('on a German keyboard the + key zooms the board in the controller and leaves the order alone', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    const order = r.doc.items.map((i) => i.id)
    r.key('+', { code: 'BracketRight' })
    expect(r.doc.items.map((i) => i.id)).toEqual(order)
    expect(r.doc.view.zoom).toBeGreaterThan(1)
    expect(r.s.selection).toEqual([id.a])
  })
})

describe('letters and digits of other scripts', () => {
  /** The Russian letter on the same key as each Latin one (the standard layout). */
  const RUSSIAN: Record<string, string> = {
    a: 'ф', b: 'и', c: 'с', d: 'в', e: 'у', f: 'а', g: 'п', h: 'р', i: 'ш', j: 'о', k: 'л', l: 'д', m: 'ь',
    n: 'т', o: 'щ', p: 'з', q: 'й', r: 'к', s: 'ы', t: 'е', u: 'г', v: 'м', w: 'ц', x: 'ч', y: 'н', z: 'я',
  }

  it('Ctrl+Z on a Russian keyboard is undo, and Ctrl+Shift+Z redo', () => {
    expect(keyToCommand(key('я', 'KeyZ', { ctrl: true }), rest)).toBe('edit.undo')
    expect(keyToCommand(key('Я', 'KeyZ', { ctrl: true, shift: true }), rest)).toBe('edit.redo')
    expect(keyToCommand(key('н', 'KeyY', { meta: true }), rest)).toBe('edit.redo')
    expect(keyToCommand(key('с', 'KeyC', { ctrl: true }), rest)).toBe('edit.copy')
    expect(keyToCommand(key('ф', 'KeyA', { ctrl: true }), rest)).toBe('edit.selectAll')
  })

  it('every single-letter key of the table works on a Russian keyboard, with the same modifiers', () => {
    let n = 0
    for (const c of BOARD_COMMANDS) {
      if (!c.keys) continue
      for (const alt of c.keys.split(' / ')) {
        const tokens = alt.split(' ')
        const name = tokens[tokens.length - 1]!
        if (!/^[A-Z]$/.test(name)) continue
        const letter = name.toLowerCase()
        const cyr = RUSSIAN[letter]!
        const shift = tokens.includes('⇧')
        const e = key(shift ? cyr.toUpperCase() : cyr, `Key${name}`, { shift, ctrl: tokens.includes('⌘'), alt: tokens.includes('⌥') })
        expect(keyToCommand(e, rest), `${alt} (${cyr}) for ${c.id}`).toBe(c.id)
        n++
      }
    }
    expect(n).toBeGreaterThan(30)
  })

  it('Greek and Hebrew work the same way', () => {
    expect(keyToCommand(key('ζ', 'KeyZ', { ctrl: true }), rest)).toBe('edit.undo')
    expect(keyToCommand(key('α', 'KeyA', { ctrl: true }), rest)).toBe('edit.selectAll')
    expect(keyToCommand(key('ז', 'KeyZ', { ctrl: true }), rest)).toBe('edit.undo')
    expect(keyToCommand(key('π', 'KeyP'), rest)).toBe('tool.pen')
  })

  it('an IME\'s Process key and a dead key are nothing, whatever key they sit on', () => {
    expect(keyToCommand(key('Process', 'KeyA'), rest)).toBeNull()
    expect(keyToCommand(key('Dead', 'KeyE'), rest)).toBeNull()
    expect(keyToCommand(key('Unidentified', 'KeyV'), rest)).toBeNull()
  })

  it('a layout that types ASCII letters is read as typed (Dvorak, AZERTY, Colemak)', () => {
    // Dvorak: the key at KeyC types j, which is no command.
    expect(keyToCommand(key('j', 'KeyC'), rest)).toBeNull()
    // AZERTY: A sits where Q is on a US keyboard and Z where W is.
    expect(keyToCommand(key('a', 'KeyQ'), rest)).toBe('arrange.menu')
    expect(keyToCommand(key('z', 'KeyW', { ctrl: true }), rest)).toBe('edit.undo')
  })

  it('a character with an accent that no key code names stays what it is', () => {
    expect(keyToCommand(key('ö', 'Semicolon'), rest)).toBeNull()
    expect(keyToCommand(key('å', 'BracketLeft'), rest)).toBeNull()
  })

  it('a digit of another script on the digit key is that digit (the 1 of an Arabic keyboard zooms to 100%)', () => {
    expect(keyToCommand(key('١', 'Digit1'), rest)).toBe('view.zoom100')
  })

  it('Ctrl+Z on a Russian keyboard undoes in the controller', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.key('ArrowRight')
    expect(r.doc.items.find((i) => i.id === id.a)).toMatchObject({ x: -299 })
    expect(r.c.key(key('я', 'KeyZ', { ctrl: true }))).toBe(true)
    expect(r.doc.items.find((i) => i.id === id.a)).toMatchObject({ x: -300 })
  })
})

describe('the digit 1', () => {
  it('is the 100% zoom with or without Shift (a French keyboard makes its 1 with Shift)', () => {
    expect(keyToCommand(key('1', 'Digit1'), rest)).toBe('view.zoom100')
    expect(keyToCommand(key('1', 'Digit1', { shift: true }), rest)).toBe('view.zoom100')
    expect(keyToCommand(key('1', 'Numpad1'), rest)).toBe('view.zoom100')
  })

  it('is not the 100% zoom with Ctrl or Alt, and Shift+1 on a US keyboard (the exclamation mark) is nothing', () => {
    expect(keyToCommand(key('1', 'Digit1', { ctrl: true }), rest)).toBeNull()
    expect(keyToCommand(key('1', 'Digit1', { alt: true }), rest)).toBeNull()
    expect(keyToCommand(key('!', 'Digit1', { shift: true }), rest)).toBeNull()
  })

  it('does not take the minus of a French keyboard (it is on the 6 key) from the zoom out', () => {
    expect(keyToCommand(key('-', 'Digit6'), rest)).toBe('view.zoomOut')
  })
})

describe('editing a note from the keyboard', () => {
  it('has a row in the table with a key and a label', () => {
    const row = commandInfo('note.edit')
    expect(row.keys).toBe('F2')
    expect(row.group).toBe('Edit')
    expect(row.needs).toBe(1)
    expect(row.title).toMatch(/note/i)
    expect(keyToCommand(key('F2', 'F2'), rest)).toBe('note.edit')
    expect(keyToCommand(key('F2', 'F2', { ctrl: true }), rest)).toBeNull()
  })

  it('F2 on a lone selected note edits it', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(0, 250))
    expect(r.s.selection).toEqual([id.n])
    expect(r.key('F2')).toBe(true)
    expect(r.s.editingNote).toBe(id.n)
  })

  it('Enter does the same', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(0, 250))
    expect(r.key('Enter')).toBe(true)
    expect(r.s.editingNote).toBe(id.n)
    expect(r.eventsOf('command')).toHaveLength(0)
  })

  it('Enter with a picture selected still opens it in the image program', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.forget()
    expect(r.key('Enter')).toBe(true)
    expect(r.s.editingNote).toBeNull()
    expect(r.eventsOf('command')).toEqual([{ type: 'command', id: 'picture.open', ids: [id.a], paths: ['a.png'] }])
  })

  it('Enter with a note and a picture selected opens the picture', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.forget()
    r.key('Enter')
    expect(r.s.editingNote).toBeNull()
    expect(r.eventsOf('command').map((e) => e.id)).toEqual(['picture.open'])
  })

  it('Enter with nothing to open or edit does nothing, says nothing and is left for the page', () => {
    const { doc } = threeThings()
    const empty = new Rig(doc)
    empty.forget()
    expect(empty.key('Enter')).toBe(false)
    expect(empty.events).toHaveLength(0)
    const marks = new Rig(build((b) => b.line('l', 0, 0, 100, 0)).doc)
    marks.c.exec('edit.selectAll')
    marks.forget()
    expect(marks.key('Enter')).toBe(false)
    expect(marks.events).toHaveLength(0)
    const empty2 = new Rig(build(() => {}).doc)
    empty2.forget()
    expect(empty2.key('Enter')).toBe(false)
    expect(empty2.events).toHaveLength(0)
  })

  it('the command from a palette says what it needs when it has nothing to edit', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('note.edit')
    expect(r.toasts('select')).toHaveLength(1)
    r.forget()
    r.c.exec('edit.selectAll')
    r.c.exec('note.edit')
    expect(r.toasts('select')).toHaveLength(1)
    expect(r.s.editingNote).toBeNull()
  })

  it('a locked note is not edited, and the user is told', () => {
    const { doc } = build((b) => b.note('n', 0, 0, 200, 'x').lock('n'))
    const r = new Rig(doc)
    r.click(at(0, 0))
    r.forget()
    r.key('F2')
    expect(r.s.editingNote).toBeNull()
    expect(r.toasts('locked')).toHaveLength(1)
  })

  it('the text typed is committed as a step of its own', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(0, 250))
    r.key('F2')
    r.c.commitNoteText(id.n, 'new words')
    expect(r.s.editingNote).toBeNull()
    expect(r.s.undoLabel).toBe('Edit note')
  })

  it('every id of the table is something the controller carries out, note.edit included', () => {
    const ids = BOARD_COMMANDS.map((c) => c.id) as BoardCommandId[]
    expect(ids).toContain('note.edit')
  })
})
