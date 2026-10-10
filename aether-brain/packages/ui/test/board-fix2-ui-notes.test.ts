import { describe, expect, it } from 'vitest'
import { BOARD_LIMITS, addMark, emptyBoard, newBoardNote, parseBoard, serializeBoard, type BoardDoc, type NoteItem } from '@aether/core'
import type { KeyIn } from '../src/board/api'
import { keyToCommand } from '../src/board/commands'
import { noteCap } from '../src/board/controller'
import { SAVE_THROTTLE_MS } from '../src/board/view/session'
import { Rig, fatBoard } from './board-controller-harness'
import { NOW, boardRaw, rig, settle } from './helpers/board-view-fakes'

/**
 * Round 2 of the reference board's review, the controller and the session: a note longer than the creation limit that came from a file
 * (diff-core-1), pictures dropped on a board that has no room (diff-core-3), a bracket typed with Option on a Mac layout (diff-app-m3).
 */

/** A text of this many characters that is not the same character all the way (a cut anywhere shows). */
const textOf = (n: number): string => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')

/** A board note holding one note of `n` characters, as an AI helper or a hand edit writes it (the reader keeps it whole up to 100,000). */
function longRaw(n: number): string {
  const raw = boardRaw('Gate', [], [['hello', 0, 0]]).replace('» hello', `» ${textOf(n)}`)
  expect(raw).toContain(textOf(n))
  return raw
}

const noteTexts = (raw: string): string[] => parseBoard(raw).doc.items.flatMap((i) => (i.kind === 'note' ? [i.text] : []))
const noteOf = (doc: BoardDoc): NoteItem => doc.items.find((i): i is NoteItem => i.kind === 'note')!

/* ------------------------------------------------------------------------- diff-core-1 --- */

describe('a note longer than the creation limit is never shortened by editing it (diff-core-1)', () => {
  it('the cap is the creation limit, or the length the note has when it is opened, up to the file ceiling', () => {
    expect(noteCap('')).toBe(BOARD_LIMITS.noteChars)
    expect(noteCap('x'.repeat(100))).toBe(BOARD_LIMITS.noteChars)
    expect(noteCap('x'.repeat(BOARD_LIMITS.noteChars))).toBe(BOARD_LIMITS.noteChars)
    expect(noteCap('x'.repeat(9000))).toBe(9000)
    expect(noteCap('x'.repeat(BOARD_LIMITS.noteCharsFile + 5))).toBe(BOARD_LIMITS.noteCharsFile)
  })

  it('the reader keeps a 9,000 character note whole (the premise)', () => {
    const parsed = parseBoard(longRaw(9000))
    expect(parsed.warnings).toEqual([])
    expect(noteOf(parsed.doc).text).toHaveLength(9000)
  })

  it('controller: opening a long note and leaving it as it is changes nothing - no step, no save', () => {
    const r = new Rig(parseBoard(longRaw(9000)).doc)
    const note = noteOf(r.doc)
    r.c.editNote(note.id)
    r.c.commitNoteText(note.id, note.text)
    expect(r.item<NoteItem>(note.id).text).toBe(textOf(9000))
    expect(r.changes).toHaveLength(0)
    expect(r.s.canUndo).toBe(false)
    expect(r.s.editingNote).toBeNull()
  })

  it('controller: one letter typed in a 9,000 character note leaves all 9,000 characters, and is one undo step', () => {
    const r = new Rig(parseBoard(longRaw(9000)).doc)
    const note = noteOf(r.doc)
    r.c.editNote(note.id)
    r.c.commitNoteText(note.id, `X${note.text.slice(1)}`)
    const after = r.item<NoteItem>(note.id).text
    expect(after).toHaveLength(9000)
    expect(after.startsWith(`X${textOf(9000).slice(1, 40)}`)).toBe(true)
    expect(after.slice(-100)).toBe(textOf(9000).slice(-100))
    expect(r.changes).toHaveLength(1)
    r.c.exec('edit.undo')
    expect(r.item<NoteItem>(note.id).text).toBe(textOf(9000))
  })

  it('controller: the note can be made shorter, and cannot be made longer than it was', () => {
    const r = new Rig(parseBoard(longRaw(9000)).doc)
    const note = noteOf(r.doc)
    r.c.editNote(note.id)
    r.c.commitNoteText(note.id, `${note.text}ZZZZ`)
    expect(r.item<NoteItem>(note.id).text).toBe(textOf(9000))
    r.c.editNote(note.id)
    r.c.commitNoteText(note.id, note.text.slice(0, 5000))
    expect(r.item<NoteItem>(note.id).text).toBe(textOf(9000).slice(0, 5000))
    // Shorter than the creation limit, the creation limit is the cap again.
    r.c.editNote(note.id)
    r.c.commitNoteText(note.id, 'y'.repeat(9000))
    expect(r.item<NoteItem>(note.id).text).toHaveLength(5000)
  })

  it('controller: a new note is still cut to the creation limit', () => {
    const r = new Rig(emptyBoard('Gate'))
    const id = r.c.addNoteAt({ x: 0, y: 0 })
    r.c.commitNoteText(id, 'y'.repeat(9000))
    expect(r.item<NoteItem>(id).text).toHaveLength(BOARD_LIMITS.noteChars)
  })

  it('session: a draft saved while a long note is open keeps every character', async () => {
    const r = rig(longRaw(9000))
    const c = r.session.controller
    const note = noteOf(c.state.doc)
    c.editNote(note.id)
    let text = `X${note.text.slice(1)}`
    r.session.registerEditor(note.id, () => text)
    r.session.draftNote(note.id)
    await r.timers.advance(SAVE_THROTTLE_MS + 1)
    expect(r.host.saves).toHaveLength(1)
    expect(noteTexts(r.host.saves[0]!)[0]).toHaveLength(9000)
    expect(noteTexts(r.host.saves[0]!)[0]!.startsWith('Xbcdefghij')).toBe(true)
    // More typing in the box, and the commit that follows it.
    text = `XY${note.text.slice(2)}`
    r.session.draftNote(note.id)
    await r.timers.advance(SAVE_THROTTLE_MS + 1)
    expect(noteTexts(r.host.saves.at(-1)!)[0]).toHaveLength(9000)
    expect(await r.session.flush()).toBe(true)
    expect(noteTexts(r.host.raw)[0]).toBe(text)
    expect(noteOf(c.state.doc).text).toHaveLength(9000)
  })

  it('session: opening a long note and leaving it writes nothing, and a draft that grows past the length it had is cut back to it', async () => {
    const r = rig(longRaw(9000))
    const c = r.session.controller
    const note = noteOf(c.state.doc)
    c.editNote(note.id)
    r.session.registerEditor(note.id, () => note.text)
    r.session.draftNote(note.id)
    expect(await r.session.flush()).toBe(true)
    expect(r.host.saves).toEqual([])
    expect(noteOf(c.state.doc).text).toBe(note.text)
    // A draft longer than the note was: kept at the length it had.
    c.editNote(note.id)
    r.session.registerEditor(note.id, () => `${note.text}ZZZZ`)
    r.session.draftNote(note.id)
    await r.timers.advance(SAVE_THROTTLE_MS + 1)
    expect(r.host.saves.every((raw) => noteTexts(raw)[0] === note.text)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- diff-core-3 --- */

describe('pictures dropped on a board that has no room are refused before they are copied (diff-core-3)', () => {
  const file = (name: string): File => new File([name], name, { type: 'image/png' })
  const withSizes = (r: ReturnType<typeof rig>, names: string[]): void => {
    for (const n of names) r.env.sizes[n] = { w: 800, h: 600 }
  }
  const fullRaw = (chars: number): string => serializeBoard(fatBoard(chars), newBoardNote('Gate', NOW), NOW)

  it('the controller says how many pictures fit, by the items and by the character budget', () => {
    expect(new Rig(emptyBoard('x')).c.pictureRoom()).toEqual({ room: BOARD_LIMITS.items, why: `it holds at most ${BOARD_LIMITS.items} items` })
    const fat = new Rig(fatBoard(BOARD_LIMITS.noteTotal - 49)).c.pictureRoom()
    expect(fat.room).toBe(0)
    expect(fat.why).toMatch(/500,000 characters/)
    // Room for about two: the estimate is a picture's line and the room an arrangement may take.
    const two = new Rig(fatBoard(BOARD_LIMITS.noteTotal - 450)).c.pictureRoom()
    expect(two.room).toBe(2)
  })

  it('a board full by characters: nothing is copied, the user is told, and a second drop does the same', async () => {
    const r = rig(fullRaw(BOARD_LIMITS.noteTotal - 49))
    withSizes(r, ['a.png', 'b.png'])
    const before = r.session.controller.state.doc.items.length
    await r.session.handleTransfer({ files: [file('a.png'), file('b.png')], uriList: '', html: '', text: '' }, null)
    await r.session.handleTransfer({ files: [file('a.png'), file('b.png')], uriList: '', html: '', text: '' }, null)
    expect(r.host.added).toEqual([])
    expect(r.env.decodes).toEqual([])
    expect(r.session.controller.state.doc.items).toHaveLength(before)
    expect(r.host.toastTexts().at(-1)).toMatch(/board is full.*500,000 characters.*2 pictures not added, and nothing was copied/)
    expect(r.session.activity).toBeNull()
  })

  it('a board full by items: nothing is copied either', async () => {
    let doc = emptyBoard('Gate')
    for (let i = 0; i < BOARD_LIMITS.items; i++) doc = addMark(doc, { kind: 'line', x1: i, y1: 0, x2: i + 5, y2: 5, color: 'ff0000', width: 2, arrow: false }).doc
    const r = rig(serializeBoard(doc, newBoardNote('Gate', NOW), NOW))
    withSizes(r, ['c.png'])
    await r.session.handleTransfer({ files: [file('c.png')], uriList: '', html: '', text: '' }, null)
    await r.session.handleTransfer({ files: [file('c.png')], uriList: '', html: '', text: '' }, null)
    expect(r.host.added).toEqual([])
    expect(r.session.controller.state.doc.items).toHaveLength(BOARD_LIMITS.items)
    expect(r.host.toastTexts().at(-1)).toMatch(/at most 1500 items.*1 picture not added, and nothing was copied/)
  })

  it('room for some: only that many are copied and put on the board, and the message says how many were left out', async () => {
    const r = rig(fullRaw(BOARD_LIMITS.noteTotal - 450))
    const names = ['a.png', 'b.png', 'c.png', 'd.png']
    withSizes(r, names)
    const before = r.session.controller.state.doc.items.length
    await r.session.handleTransfer({ files: names.map(file), uriList: '', html: '', text: '' }, null)
    expect(r.host.added).toHaveLength(1)
    expect(r.host.added[0]!.map((f) => f.name)).toEqual(['a.png', 'b.png'])
    expect(r.session.controller.state.doc.items.filter((i) => i.kind === 'picture')).toHaveLength(2)
    expect(r.session.controller.state.doc.items).toHaveLength(before + 2)
    expect(r.host.toastTexts().some((t) => /adding 2 of 4 pictures; the other 2 were left out and not copied/.test(t))).toBe(true)
  })

  it('a roomy board takes every file, as before', async () => {
    const r = rig(boardRaw())
    withSizes(r, ['a.png', 'b.png', 'c.png'])
    await r.session.handleTransfer({ files: [file('a.png'), file('b.png'), file('c.png')], uriList: '', html: '', text: '' }, null)
    expect(r.host.added[0]!.map((f) => f.name)).toEqual(['a.png', 'b.png', 'c.png'])
    expect(r.session.controller.state.doc.items.filter((i) => i.kind === 'picture')).toHaveLength(3)
    expect(r.host.toastTexts().some((t) => /board is full/.test(t))).toBe(false)
  })

  it('pictures that were copied and then did not fit (the board changed meanwhile) are said to be in the folder', async () => {
    let doc = emptyBoard('Gate')
    for (let i = 0; i < BOARD_LIMITS.items; i++) doc = addMark(doc, { kind: 'line', x1: i, y1: 0, x2: i + 5, y2: 5, color: 'ff0000', width: 2, arrow: false }).doc
    const r = rig(serializeBoard(doc, newBoardNote('Gate', NOW), NOW))
    withSizes(r, ['c.png', 'd.png'])
    // The estimate said there was room (the board filled up while the files were read): the controller is the judge after all.
    ;(r.session.controller as unknown as { pictureRoom(): { room: number; why: string } }).pictureRoom = () => ({ room: 5, why: '' })
    await r.session.handleTransfer({ files: [file('c.png'), file('d.png')], uriList: '', html: '', text: '' }, null)
    expect(r.host.added.flat()).toHaveLength(2)
    expect(r.session.controller.state.doc.items).toHaveLength(BOARD_LIMITS.items)
    expect(r.host.toastTexts().at(-1)).toMatch(/2 pictures were copied into the board's folder but did not fit on the board/)
  })
})

/* ------------------------------------------------------------------------- diff-app-m3 --- */

describe('a bracket typed with Option on a Mac layout (diff-app-m3)', () => {
  const rest = { tool: 'select', editing: false, cropping: false } as const
  const key = (k: string, code: string, m: Partial<KeyIn> = {}): KeyIn => ({ key: k, code, down: true, shift: false, ctrl: false, alt: false, meta: false, repeat: false, ...m })

  it('German: Option+5 types [ and Option+6 types ] - the bare brackets, backward and forward', () => {
    expect(keyToCommand(key('[', 'Digit5', { alt: true }), rest)).toBe('order.backward')
    expect(keyToCommand(key(']', 'Digit6', { alt: true }), rest)).toBe('order.forward')
    // With Command as well: to the back / to the front.
    expect(keyToCommand(key('[', 'Digit5', { alt: true, meta: true }), rest)).toBe('order.back')
    expect(keyToCommand(key(']', 'Digit6', { alt: true, meta: true }), rest)).toBe('order.front')
  })

  it('the documented chords still work: Alt on the bracket key is opacity, on every platform', () => {
    // Windows and Linux: the bracket character with Alt, on the bracket key.
    expect(keyToCommand(key('[', 'BracketLeft', { alt: true }), rest)).toBe('item.opacityDown')
    expect(keyToCommand(key(']', 'BracketRight', { alt: true }), rest)).toBe('item.opacityUp')
    // A Mac US layout: Option types another character on that key.
    expect(keyToCommand(key('“', 'BracketLeft', { alt: true }), rest)).toBe('item.opacityDown')
    expect(keyToCommand(key('‘', 'BracketRight', { alt: true }), rest)).toBe('item.opacityUp')
    // An event with no key code keeps the chord it always had.
    expect(keyToCommand(key('[', '', { alt: true }), rest)).toBe('item.opacityDown')
    // AltGr as Ctrl+Alt is the bare bracket, as before.
    expect(keyToCommand(key('[', 'Digit8', { ctrl: true, alt: true }), rest)).toBe('order.backward')
    expect(keyToCommand(key(']', 'Digit9', { ctrl: true, alt: true }), rest)).toBe('order.forward')
  })

  it('the bracket keys without Alt are as they were', () => {
    expect(keyToCommand(key('[', 'BracketLeft'), rest)).toBe('order.backward')
    expect(keyToCommand(key(']', 'BracketRight'), rest)).toBe('order.forward')
    expect(keyToCommand(key('[', 'BracketLeft', { meta: true }), rest)).toBe('order.back')
    expect(keyToCommand(key(']', 'BracketRight', { ctrl: true }), rest)).toBe('order.front')
  })
})

void settle
