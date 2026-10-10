/**
 * The board's size budget in the controller (review findings controller-commands-5, geometry-2, shell-7, format-1): a board may hold at
 * most BOARD_LIMITS.noteTotal characters of items (core `boardChars`). Anything that GROWS the board past it is refused with the
 * board-is-full message; anything that keeps or shrinks it is always allowed, so a board that is too big can be thinned out of it.
 */
import { describe, expect, it } from 'vitest'
import { BOARD_LIMITS, addMark, addNote, boardChars, emptyBoard, parseBoard, serializeBoard, type BoardDoc, type StrokeItem } from '@aether/core'
import { Rig, at, build, fatBoard } from './board-controller-harness'

const LIMIT = BOARD_LIMITS.noteTotal

const full = (items: number): string => `The board is full: it holds at most about 500,000 characters of items (${items} item${items === 1 ? '' : 's'}).`

/** A zig-zag of `n` points: nothing for the simplifier to drop. */
function zigzag(r: Rig, n: number, pen = true): void {
  if (pen) r.c.exec('tool.pen')
  r.down(at(-500, 0))
  for (let i = 1; i < n; i++) r.move(at(-500 + i * 6, i % 2 === 0 ? 0 : 40))
  r.up(at(-500 + n * 6, 0))
}

function limitToasts(r: Rig): { text: string; tone: string }[] {
  return r.toasts('limit').map((t) => t as { text: string; tone: string })
}

describe('the character budget', () => {
  it('reads the size of the board the way core counts it, in the state, with the budget beside it', () => {
    const r = new Rig(fatBoard(123_456))
    expect(r.s.chars).toBe(123_456)
    expect(r.s.chars).toBe(boardChars(r.doc))
    expect(r.s.charsLimit).toBe(LIMIT)
    const before = r.s.chars
    r.c.exec('tool.rect')
    r.drag(at(0, 0), at(80, 60))
    expect(r.s.chars).toBeGreaterThan(before)
    expect(r.s.chars).toBe(boardChars(r.doc))
  })

  it('shows a drag at the size the board had when it began (it adds nothing) and the new size when it ends', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 100, 100).line('l', -300, 0, -200, 40))
    const r = new Rig(doc)
    const n = r.s.chars
    r.down(at(0, 0))
    r.move(at(50, 33.3333333))
    r.move(at(97, 71.1111111))
    expect(r.s.chars).toBe(n)
    r.up(at(97, 71.1111111))
    expect(r.s.chars).toBe(boardChars(r.doc))
    expect(r.s.chars).not.toBe(n)
  })

  it('refuses a pen stroke that would pass it, says why, and leaves the board and its history alone', () => {
    const r = new Rig(fatBoard(LIMIT - 300))
    const items = r.doc.items.length
    r.forget()
    zigzag(r, 40)
    expect(r.doc.items).toHaveLength(items)
    expect(r.s.canUndo).toBe(false)
    expect(r.s.draft).toBeNull()
    expect(limitToasts(r)).toEqual([{ type: 'toast', text: full(items), tone: 'error', code: 'limit' }])
    expect(boardChars(r.doc)).toBe(LIMIT - 300)
    // A stroke that does fit is still drawn: the budget is a number, not a lock.
    r.forget()
    r.down(at(-500, 100))
    r.move(at(-400, 130))
    r.up(at(-300, 100))
    expect(r.doc.items).toHaveLength(items + 1)
    expect(boardChars(r.doc)).toBeLessThanOrEqual(LIMIT)
    expect(limitToasts(r)).toHaveLength(0)
  })

  it('refuses a line, a rectangle and an ellipse that do not fit, after the drag, with the same message', () => {
    for (const tool of ['tool.line', 'tool.rect', 'tool.ellipse'] as const) {
      const r = new Rig(fatBoard(LIMIT - 40))
      const items = r.doc.items.length
      r.c.exec(tool)
      r.forget()
      r.drag(at(0, 0), at(120, 80))
      expect(r.doc.items, tool).toHaveLength(items)
      expect(r.s.canUndo, tool).toBe(false)
      expect(limitToasts(r).map((t) => t.text), tool).toEqual([full(items)])
    }
  })

  it('refuses the press itself when the board is already at the budget (no drawing for nothing)', () => {
    for (const tool of ['tool.pen', 'tool.line', 'tool.rect', 'tool.ellipse', 'tool.note'] as const) {
      const r = new Rig(fatBoard(LIMIT))
      r.c.exec(tool)
      r.forget()
      r.down(at(0, 0))
      expect(r.s.gesturing, tool).toBe(false)
      expect(r.s.draft, tool).toBeNull()
      expect(limitToasts(r), tool).toHaveLength(1)
      r.up(at(0, 0))
    }
  })

  it('a note: refused when made with no room, and a text that does not fit is refused at the commit, with the note left open', () => {
    const none = new Rig(fatBoard(LIMIT - 20))
    none.forget()
    expect(none.c.addNoteAt({ x: 0, y: 0 })).toBe(0)
    expect(none.s.editingNote).toBeNull()
    expect(limitToasts(none)).toHaveLength(1)

    const r = new Rig(fatBoard(LIMIT - 2500))
    const items = r.doc.items.length
    const id = r.c.addNoteAt({ x: 0, y: 0 })
    expect(id).not.toBe(0)
    r.forget()
    r.c.commitNoteText(id, 'x'.repeat(4000))
    // Refused: the note is still being typed, on the board and in no history step, and the user was told.
    expect(r.s.editingNote).toBe(id)
    expect(r.s.canUndo).toBe(false)
    expect(r.doc.items).toHaveLength(items + 1)
    expect(limitToasts(r).map((t) => t.text)).toEqual([full(items + 1)])
    expect(r.changes).toHaveLength(0)
    // Shorter, it fits, and the note is made.
    r.c.commitNoteText(id, 'x'.repeat(200))
    expect(r.s.editingNote).toBeNull()
    expect(r.s.undoLabel).toBe('Add note')
    expect(boardChars(r.doc)).toBeLessThanOrEqual(LIMIT)
  })

  it('a note that is there already may be shortened or kept the same length whatever the board weighs, never lengthened past it', () => {
    const base = fatBoard(LIMIT - 10)
    const withNote = addNote(base, { text: 'short', x: 0, y: 0 })
    // `withNote` is over by a few characters: it stands for a board loaded over its budget.
    expect(boardChars(withNote.doc)).toBeGreaterThan(LIMIT)
    const r = new Rig(withNote.doc)
    const id = withNote.id!
    r.c.editNote(id)
    r.forget()
    r.c.commitNoteText(id, 'longer than before')
    expect(r.s.editingNote).toBe(id)
    expect(limitToasts(r)).toHaveLength(1)
    r.c.commitNoteText(id, 'tiny')
    expect(r.s.editingNote).toBeNull()
    expect(r.s.undoLabel).toBe('Edit note')
    r.c.editNote(id)
    r.c.commitNoteText(id, 'tiny')
    expect(r.s.editingNote).toBeNull()
  })

  it('a board loaded over its budget can be thinned and moved but not added to', () => {
    const over = fatBoard(LIMIT + 7000)
    const r = new Rig(over)
    expect(r.s.chars).toBeGreaterThan(LIMIT)
    const total = r.doc.items.length
    r.forget()
    // Adding: refused whatever the way it comes.
    r.c.exec('tool.rect')
    r.down(at(0, 0))
    expect(r.s.gesturing).toBe(false)
    r.up(at(0, 0))
    r.c.exec('tool.select')
    r.c.exec('edit.selectAll')
    r.c.exec('edit.duplicate')
    expect(r.doc.items).toHaveLength(total)
    r.c.exec('edit.copy')
    r.c.exec('edit.paste')
    expect(r.doc.items).toHaveLength(total)
    expect(limitToasts(r).length).toBeGreaterThanOrEqual(3)
    // Thinning: always. Delete one item, then a flip (the same size) and a nudge.
    r.c.exec('edit.selectNone')
    r.click(at(0, 0))
    r.c.exec('edit.selectAll')
    r.c.exec('transform.flipH')
    expect(r.s.undoLabel).toBe('Flip horizontally')
    r.c.exec('edit.selectNone')
    r.c.exec('edit.undo')
    const lastId = r.doc.items[r.doc.items.length - 1]!.id
    r.c.exec('edit.selectNone')
    r.key('Escape')
    r.c.exec('edit.selectAll')
    r.c.exec('edit.delete')
    expect(r.doc.items).toHaveLength(0)
    expect(lastId).toBeGreaterThan(0)
    // Undo brings the old, too big board back: it was allowed once, and a history step is not growth.
    r.c.exec('edit.undo')
    expect(r.doc.items).toHaveLength(total)
  })

  it('refuses a paste, a duplicate and a paste from the system clipboard that would pass it', () => {
    const source = new Rig(build((b) => b.stroke('s', Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? i * 9 : 40 + (i % 7))), 3)).doc)
    source.c.exec('edit.selectAll')
    source.c.exec('edit.copy')
    const copied = source.c.exportCopy()
    expect(copied).not.toBeNull()

    const r = new Rig(fatBoard(LIMIT - 200))
    const items = r.doc.items.length
    r.c.exec('edit.selectAll')
    r.c.exec('edit.copy')
    r.forget()
    // The copy of everything is far bigger than the room.
    r.c.exec('edit.paste')
    expect(r.doc.items).toHaveLength(items)
    expect(limitToasts(r)).toHaveLength(1)
    r.forget()
    r.c.exec('edit.duplicate')
    expect(r.doc.items).toHaveLength(items)
    expect(limitToasts(r).map((t) => t.text)).toEqual([full(items)])
    // A foreign stroke of 80 points (more than 200 characters) does not fit either.
    r.forget()
    expect(r.c.importCopy(copied!.text)).toBe(0)
    expect(r.doc.items).toHaveLength(items)
    expect(limitToasts(r)).toHaveLength(1)
    expect(r.s.canUndo).toBe(false)
  })

  it('adds as many pictures as fit and says how many were left out; none at all when there is no room', () => {
    const files = Array.from({ length: 30 }, (_, i) => ({ path: `Boards/Gate/picture-${i}.png`, w: 800, h: 600 }))
    const tight = new Rig(fatBoard(LIMIT - 1500))
    const items = tight.doc.items.length
    tight.forget()
    const ids = tight.c.addPictures(files)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.length).toBeLessThan(30)
    expect(tight.doc.items).toHaveLength(items + ids.length)
    expect(boardChars(tight.doc)).toBeLessThanOrEqual(LIMIT)
    expect(tight.s.selection).toEqual(ids)
    const said = limitToasts(tight)
    expect(said).toHaveLength(1)
    expect(said[0]!.text).toBe(`The board is full: added ${ids.length} of 30 pictures (it holds at most about 500,000 characters of items).`)

    const none = new Rig(fatBoard(LIMIT - 30))
    none.forget()
    expect(none.c.addPictures(files)).toEqual([])
    expect(limitToasts(none).map((t) => t.text)).toEqual([full(none.doc.items.length)])
    expect(none.s.canUndo).toBe(false)
  })

  it('refuses colour swatches with no room', () => {
    const r = new Rig(fatBoard(LIMIT - 100))
    const items = r.doc.items.length
    r.forget()
    expect(r.c.addSwatches(['ff0000', '00ff00', '0000ff'], { x: 0, y: 0 })).toEqual([])
    expect(r.doc.items).toHaveLength(items)
    expect(limitToasts(r)).toHaveLength(1)
  })

  it('stays under the budget however many strokes are drawn, and the board that comes out is one a note can hold', () => {
    const r = new Rig(emptyBoard('pen'), { history: { limit: 5000 } })
    r.c.exec('tool.pen')
    let refused = 0
    for (let k = 0; k < 400 && refused < 3; k++) {
      const before = r.doc.items.length
      r.down(at(-480, -300 + (k % 20) * 3))
      for (let i = 1; i <= 260; i++) r.move(at(-480 + i * 3.5, -300 + (k % 20) * 3 + (i % 2 === 0 ? 0 : 9) + Math.sin(i / 7) * 30))
      r.up(at(440, -300))
      if (r.doc.items.length === before) refused++
      expect(boardChars(r.doc)).toBeLessThanOrEqual(LIMIT)
    }
    expect(refused).toBeGreaterThan(0)
    expect(r.s.chars).toBeLessThanOrEqual(LIMIT)
    // What the budget lets in is what a note writes and reads back whole.
    const text = serializeBoard(r.doc, undefined, new Date('2026-01-01T00:00:00Z'))
    expect(text.length).toBeLessThan(2 * LIMIT)
    const back = parseBoard(text)
    expect(back.doc.items).toHaveLength(r.doc.items.length)
    expect(back.warnings.filter((w) => /characters long/.test(w))).toHaveLength(text.length > LIMIT ? 1 : 0)
    void (r.doc.items[0] as StrokeItem)
  })

  it('counts a note\'s text as the note writes it: the budget is not an estimate', () => {
    const doc: BoardDoc = addMark(emptyBoard('x'), { kind: 'stroke', points: [0, 0, 5, 5], color: '00ff00', width: 3 }).doc
    const r = new Rig(doc)
    expect(r.s.chars).toBe(boardChars(doc))
    const text = serializeBoard(doc, undefined, new Date('2026-01-01T00:00:00Z'))
    const section = text.slice(text.indexOf('## Board'))
    // The count is within a few characters of the section it stands for.
    expect(Math.abs(section.length - r.s.chars)).toBeLessThan(200)
  })
})
