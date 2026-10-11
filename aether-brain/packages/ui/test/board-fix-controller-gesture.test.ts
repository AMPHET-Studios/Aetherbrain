/**
 * Review fixes in the controller's pointer handling: a key or a style change in the middle of a drag (controller-pointer-1,
 * controller-commands-m7), a picture's real size arriving in the middle of a drag and the silent correction (controller-pointer-2,
 * live-docked-m1, controller-commands-m3, controller-pointer-m4), the mark committed being the mark drawn (controller-pointer-3), and
 * the small ones (controller-pointer-m1, m2, m3, m5, m7, m8, m9).
 */
import { describe, expect, it } from 'vitest'
import { emptyBoard, parseBoard, serializeBoard, type EllipseItem, type LineItem, type NoteItem, type PictureItem, type RectItem } from '@aether/core'
import { Rig, at, build, threeThings } from './board-controller-harness'

const pic = (r: Rig, id: number): PictureItem => r.item<PictureItem>(id)

/** The final changes the savers heard of (what would be written), in order. */
const finals = (r: Rig) => r.changes.filter((c) => c.why.final && !c.why.viewOnly)

/* ------------------------------------------------- a key in the middle of a drag --- */

describe('an arrow key or a style change in the middle of a drag', () => {
  it('ends the drag first: the nudge is ONE step on the board as it was, with no step for the half-made drag', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.down(at(-300, -100))
    r.move(at(-250, -50))
    r.move(at(-100, 0))
    expect(pic(r, id.a).x).toBe(-100)
    r.forget()
    expect(r.key('ArrowRight')).toBe(true)
    expect(r.s.gesturing).toBe(false)
    expect(pic(r, id.a).x).toBe(-299)
    // The drag goes on arriving: it is over and ignored.
    r.move(at(-90, 0))
    r.up(at(-90, 0))
    expect(pic(r, id.a).x).toBe(-299)
    expect(r.s.undoLabel).toBe('Nudge')
    // What the savers heard: the board put back, then the nudge. The half-made drag position (-100, -99) was never a final state.
    expect(finals(r).map((c) => (c.doc.items.find((i) => i.id === id.a) as PictureItem).x)).toEqual([-300, -299])
    r.c.exec('edit.undo')
    expect(pic(r, id.a).x).toBe(-300)
    expect(r.s.canUndo).toBe(false)
  })

  it('a scale drag, an arrow and Esc leave one Nudge to undo, a clean board after it, and no scaled board in the history', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    // The south-east handle of picture a: it grows 200x100 about the opposite corner.
    r.down(at(-200, -50))
    r.move(at(-170, -35))
    r.move(at(-140, -20))
    expect(pic(r, id.a).w).toBeGreaterThan(200)
    r.forget()
    r.key('ArrowRight')
    r.key('Escape')
    expect(pic(r, id.a)).toMatchObject({ w: 200, h: 100, x: -299, y: -100 })
    expect(r.s.undoLabel).toBe('Nudge')
    expect(finals(r).every((c) => (c.doc.items.find((i) => i.id === id.a) as PictureItem).w === 200)).toBe(true)
    r.c.exec('edit.undo')
    expect(pic(r, id.a)).toMatchObject({ w: 200, h: 100, x: -300, y: -100 })
    expect(r.s.canUndo).toBe(false)
    r.c.markSaved()
    expect(r.s.dirty).toBe(false)
  })

  it('a style change ends the drag, then restyles the board as it was: the colour stays, the shape is not the half-made one', () => {
    const { doc, id } = build((b) => b.rect('r', -100, -100, 100, 100, '', 4))
    const r = new Rig(doc)
    r.click(at(-100, -100))
    r.down(at(100, 100))
    r.move(at(160, 130))
    r.move(at(220, 160))
    expect((r.item(id.r) as RectItem).x2).toBeGreaterThan(100)
    r.c.setStyle({ color: '00ff00' })
    expect(r.s.gesturing).toBe(false)
    expect(r.item(id.r)).toMatchObject({ color: '00ff00', x1: -100, y1: -100, x2: 100, y2: 100 })
    r.key('Escape')
    // The change the user asked for is still there, and it is a step of its own on the original shape.
    expect(r.item(id.r)).toMatchObject({ color: '00ff00', x2: 100 })
    expect(r.s.undoLabel).toBe('Style')
    r.c.exec('edit.undo')
    expect(r.item(id.r)).toMatchObject({ color: 'ff0000', x2: 100 })
    expect(r.s.canUndo).toBe(false)
  })

  it('a style change that touches nothing selected does not end the drag', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.down(at(-300, -100))
    r.move(at(-250, -50))
    r.move(at(-200, 0))
    r.c.setStyle({ color: '00ff00' })
    expect(r.s.gesturing).toBe(true)
    r.up(at(-200, 0))
    expect(r.s.undoLabel).toBe('Move')
  })

  it('a pan carries on through a key (it only moves the camera)', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.down(at(0, 500), { button: 1 })
    r.move(at(30, 500), { button: 1 })
    r.key('ArrowRight')
    expect(r.s.gesturing).toBe(true)
    r.move(at(60, 500), { button: 1 })
    expect(r.doc.view.x).toBeCloseTo(-60, 9)
    r.up(at(60, 500), { button: 1 })
  })
})

/* ------------------------------------------------- a size arriving mid-gesture --- */

describe('a picture\'s real size arriving while a gesture runs', () => {
  const squares = () => build((b) => b.pic('a', -300, -100, 200, 200).pic('b', 100, -100, 200, 200))

  it('a drag of that picture: every step and the committed board carry the real shape', () => {
    const { doc, id } = squares()
    const r = new Rig(doc)
    r.down(at(-300, -100))
    r.move(at(-290, -100))
    r.move(at(-280, -100))
    r.c.setNaturalSize('a.png', 400, 100)
    expect(pic(r, id.a).h).toBe(50)
    r.move(at(-270, -100))
    expect(pic(r, id.a).h).toBe(50)
    r.up(at(-270, -100))
    expect(pic(r, id.a)).toMatchObject({ w: 200, h: 50, x: -270 })
    expect(r.s.undoLabel).toBe('Move')
    const last = finals(r).at(-1)!
    expect((last.doc.items.find((i) => i.id === id.a) as PictureItem).h).toBe(50)
    r.c.exec('edit.undo')
    expect(pic(r, id.a)).toMatchObject({ h: 50, x: -300 })
  })

  it('a drag of another picture: the size still reaches the board', () => {
    const { doc, id } = squares()
    const r = new Rig(doc)
    r.down(at(100, -100))
    r.move(at(110, -100))
    r.c.setNaturalSize('a.png', 400, 100)
    r.move(at(120, -100))
    r.up(at(120, -100))
    expect(pic(r, id.a).h).toBe(50)
    expect(pic(r, id.b)).toMatchObject({ x: 120, h: 200 })
  })

  it('Esc puts back the board with the real shape, not the one the drag began with', () => {
    const { doc, id } = squares()
    const r = new Rig(doc)
    r.down(at(-300, -100))
    r.move(at(-290, -100))
    r.move(at(-280, -100))
    r.c.setNaturalSize('a.png', 400, 100)
    r.key('Escape')
    expect(pic(r, id.a)).toMatchObject({ x: -300, h: 50 })
    expect(r.s.canUndo).toBe(false)
  })

  it('a scale drag and a rotate drag too', () => {
    const { doc, id } = squares()
    const scaled = new Rig(doc)
    scaled.click(at(-300, -100))
    scaled.down(at(-200, 0))
    scaled.move(at(-170, 30))
    scaled.c.setNaturalSize('a.png', 400, 100)
    scaled.move(at(-140, 60))
    scaled.up(at(-140, 60))
    const p = pic(scaled, id.a)
    expect(p.w / p.h).toBeCloseTo(4, 6)

    const turned = new Rig(doc)
    turned.click(at(-300, -100))
    // The rotate handle is 28 px above the top edge.
    turned.down(at(-300, -200 - 28))
    turned.move(at(-250, -230))
    turned.c.setNaturalSize('a.png', 400, 100)
    turned.move(at(-200, -240))
    turned.up(at(-200, -240))
    expect(pic(turned, id.a).w / pic(turned, id.a).h).toBeCloseTo(4, 6)
  })

  it('a gesture that has changed nothing yet does not look changed afterwards: Esc after a click on it says nothing to the savers', () => {
    const { doc } = squares()
    const r = new Rig(doc)
    r.down(at(-300, -100))
    r.c.setNaturalSize('a.png', 400, 100)
    r.forget()
    r.key('Escape')
    expect(r.changes).toHaveLength(0)
  })
})

describe('the silent correction of a shape', () => {
  it('is no change of the board for the savers: a board that is only looked at is never written', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 300))
    const r = new Rig(doc)
    r.forget()
    r.c.setNaturalSize('a.png', 640, 480)
    expect(pic(r, id.a).h).toBeCloseTo(150, 9)
    expect(r.changes.map((c) => c.why)).toEqual([{ reason: 'natural-size', final: false, viewOnly: true }])
    expect(finals(r)).toHaveLength(0)
    expect(r.s.canUndo).toBe(false)
  })

  it('is no unsaved work either: a visit that learned a shape leaves the board clean, like a pan does', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 200, 300))
    const r = new Rig(doc)
    r.c.setNaturalSize('a.png', 640, 480)
    expect(r.s.dirty).toBe(false)
    r.c.setNaturalSize('a.png', 400, 500)
    expect(r.s.dirty).toBe(false)
    r.down(at(0, 0))
    r.c.setNaturalSize('a.png', 640, 480)
    r.up(at(0, 0))
    expect(r.s.gesturing).toBe(false)
    expect(r.s.dirty).toBe(false)
  })

  it('does not hide a real edit, and the corrected board counts as saved once it is saved', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 200, 300).pic('b', 400, 0, 100, 100))
    const r = new Rig(doc)
    r.c.setNaturalSize('a.png', 640, 480)
    r.click(at(400, 0))
    r.key('ArrowRight')
    expect(r.s.dirty).toBe(true)
    r.c.markSaved()
    expect(r.s.dirty).toBe(false)
    r.c.setNaturalSize('a.png', 100, 400)
    expect(r.s.dirty).toBe(false)
    // Undo to the board as it was read, still with the shapes learned meanwhile: the step is the saved one, so it is clean.
    r.c.exec('edit.undo')
    expect(r.s.dirty).toBe(true)
    r.c.exec('edit.redo')
    expect(r.s.dirty).toBe(false)
  })

  it('a drag in progress is dirty as ever, and a cancelled one leaves the corrected board clean', () => {
    const { doc, id } = build((b) => b.pic('a', -300, -100, 200, 300).pic('b', 100, -100, 200, 200))
    const r = new Rig(doc)
    r.down(at(100, -100))
    r.move(at(130, -100))
    r.move(at(160, -100))
    r.c.setNaturalSize('a.png', 400, 100)
    expect(pic(r, id.a).h).toBe(50)
    expect(r.s.dirty).toBe(true)
    r.key('Escape')
    expect(r.s.dirty).toBe(false)
    expect(pic(r, id.a).h).toBe(50)
  })

  it('a note typed and abandoned in a corrected board leaves it clean', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 200, 300))
    const r = new Rig(doc)
    const id = r.c.addNoteAt({ x: 300, y: 300 })
    r.c.setNaturalSize('a.png', 640, 480)
    expect(r.s.dirty).toBe(true)
    r.c.cancelNoteEdit()
    expect(r.doc.items.some((i) => i.id === id)).toBe(false)
    expect(r.s.dirty).toBe(false)
  })

  it('rides the next real edit', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 300).pic('b', 400, 0, 100, 100))
    const r = new Rig(doc)
    r.c.setNaturalSize('a.png', 640, 480)
    r.forget()
    r.click(at(400, 0))
    r.key('ArrowRight')
    const last = finals(r).at(-1)!
    expect((last.doc.items.find((i) => i.id === id.a) as PictureItem).h).toBeCloseTo(150, 9)
  })

  it('never puts the note being typed into anything the savers hear of, and cancelling it needs nothing said', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 200, 300).note('n', 0, 400, 200, 'hello'))
    const r = new Rig(doc)
    r.c.exec('tool.note')
    r.click(at(300, 300))
    const id = r.s.editingNote!
    expect(id).not.toBeNull()
    r.forget()
    r.c.setNaturalSize('a.png', 640, 480)
    r.c.setStyle({ noteColor: 'ffcc00' })
    r.c.cancelNoteEdit()
    expect(r.doc.items.some((i) => i.id === id)).toBe(false)
    for (const c of r.changes) expect(c.doc.items.some((i) => i.kind === 'note' && i.text === ''), JSON.stringify(c.why)).toBe(false)
    expect(finals(r)).toHaveLength(0)
  })

  it('a note typed in a board whose shapes were corrected is written with them and without its empty twin', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 200, 300))
    const r = new Rig(doc)
    r.c.setNaturalSize('a.png', 640, 480)
    const id = r.c.addNoteAt({ x: 300, y: 300 })
    r.c.commitNoteText(id, 'kept')
    const text = serializeBoard(finals(r).at(-1)!.doc, undefined, new Date('2026-01-01T00:00:00Z'))
    const items = parseBoard(text).doc.items
    expect(items.map((i) => i.kind)).toEqual(['picture', 'note'])
    expect((items[1] as NoteItem).text).toBe('kept')
  })
})

/* ------------------------------------------------- the mark committed is the mark drawn --- */

describe('a drawn mark is committed as it was shown', () => {
  const corners = (it: RectItem | EllipseItem | LineItem): number[] => [it.x1, it.y1, it.x2, it.y2]

  const cases: { tool: 'tool.rect' | 'tool.ellipse' | 'tool.line'; down: { shift?: boolean; alt?: boolean }; up: { shift?: boolean; alt?: boolean }; what: string }[] = [
    { tool: 'tool.rect', down: { alt: true }, up: {}, what: 'a rectangle from its middle, Alt let go before the button' },
    { tool: 'tool.ellipse', down: { alt: true }, up: {}, what: 'an ellipse from its middle, Alt let go before the button' },
    { tool: 'tool.rect', down: { shift: true }, up: {}, what: 'a square, Shift let go before the button' },
    { tool: 'tool.line', down: { shift: true }, up: {}, what: 'a line at 45 degrees, Shift let go before the button' },
    { tool: 'tool.rect', down: { alt: true, shift: true }, up: { shift: true }, what: 'a square from its middle, Alt let go first' },
    { tool: 'tool.rect', down: {}, up: { shift: true }, what: 'a rectangle, Shift pressed only at the release' },
    { tool: 'tool.ellipse', down: {}, up: { alt: true }, what: 'an ellipse, Alt pressed only at the release' },
  ]

  for (const c of cases) {
    it(`${c.what}: what is committed is the draft`, () => {
      const r = new Rig(emptyBoard('t'))
      r.c.exec(c.tool)
      r.down(at(0, 0), c.down)
      r.dragMoves(at(0, 0), at(140, 80), c.down, 4)
      const shown = r.s.draft as RectItem | EllipseItem | LineItem
      expect(shown).not.toBeNull()
      r.up(at(140, 80), c.up)
      expect(r.doc.items).toHaveLength(1)
      const made = r.doc.items[0] as RectItem | EllipseItem | LineItem
      expect(corners(made)).toEqual(corners(shown))
    })
  }

  it('the release still gives the end point: a release away from the last move ends the mark there', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.exec('tool.rect')
    r.down(at(0, 0))
    r.move(at(50, 50))
    r.up(at(100, 60))
    expect(corners(r.doc.items[0] as RectItem)).toEqual([0, 0, 100, 60])
  })

  it('a click and a tiny drag still make nothing', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.exec('tool.rect')
    r.click(at(10, 10))
    r.drag(at(10, 10), at(11, 11))
    expect(r.doc.items).toHaveLength(0)
  })
})

/* ------------------------------------------------- pointers that never lift --- */

describe('cancelPointers', () => {
  it('ends a stroke half drawn: nothing is committed and the next pointer can draw', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.exec('tool.pen')
    r.down(at(0, 0), { id: 1 })
    r.move(at(30, 20), { id: 1 })
    r.move(at(60, 0), { id: 1 })
    expect(r.s.draft).not.toBeNull()
    r.c.cancelPointers()
    expect(r.s.draft).toBeNull()
    expect(r.s.gesturing).toBe(false)
    expect(r.doc.items).toHaveLength(0)
    // The first button-less move of any kind no longer commits the half stroke, and a pen pointer draws.
    r.hover(at(80, 0), { id: 1 })
    expect(r.doc.items).toHaveLength(0)
    r.down(at(0, 100), { id: 11, pointerType: 'pen' })
    r.move(at(30, 120), { id: 11, pointerType: 'pen' })
    r.move(at(60, 100), { id: 11, pointerType: 'pen' })
    r.up(at(60, 100), { id: 11, pointerType: 'pen' })
    expect(r.doc.items).toHaveLength(1)
  })

  it('puts a drag back as it was', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.down(at(-300, -100))
    r.move(at(-200, -50))
    r.move(at(-100, 0))
    r.c.cancelPointers()
    expect(pic(r, id.a).x).toBe(-300)
    expect(r.s.canUndo).toBe(false)
    expect(r.s.gesturing).toBe(false)
  })

  it('forgets a finger whose lift never came: a new finger is not paired with it', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.exec('tool.pen')
    r.down(at(0, 0), { id: 5, pointerType: 'touch' })
    r.move(at(10, 10), { id: 5, pointerType: 'touch' })
    r.c.cancelPointers()
    const zoom = r.doc.view.zoom
    r.down(at(100, 0), { id: 6, pointerType: 'touch' })
    r.move(at(160, 0), { id: 6, pointerType: 'touch' })
    r.move(at(260, 0), { id: 6, pointerType: 'touch' })
    expect(r.doc.view.zoom).toBe(zoom)
    expect(r.s.moving).toBe(false)
    r.up(at(260, 0), { id: 6, pointerType: 'touch' })
    expect(r.doc.items).toHaveLength(1)
  })

  it('a pinch counts as a gesture held (the session defers an outside reload while it lasts)', () => {
    const r = new Rig(emptyBoard('t'))
    expect(r.s.gesturing).toBe(false)
    r.down(at(0, 0), { id: 1, pointerType: 'touch' })
    r.down(at(100, 0), { id: 2, pointerType: 'touch' })
    expect(r.s.gesturing).toBe(true)
    r.up(at(100, 0), { id: 2, pointerType: 'touch' })
    r.up(at(0, 0), { id: 1, pointerType: 'touch' })
    expect(r.s.gesturing).toBe(false)
  })

  it('forgets a pinch', () => {
    const r = new Rig(emptyBoard('t'))
    r.down(at(0, 0), { id: 1, pointerType: 'touch' })
    r.down(at(100, 0), { id: 2, pointerType: 'touch' })
    expect(r.s.moving).toBe(true)
    r.c.cancelPointers()
    expect(r.s.moving).toBe(false)
    r.move(at(300, 0), { id: 2, pointerType: 'touch' })
    expect(r.doc.view.zoom).toBe(1)
  })

  it('does nothing when nothing is held', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.forget()
    r.c.cancelPointers()
    expect(r.changes).toHaveLength(0)
    expect(r.doc).toBe(doc)
  })

  it('a second press of a pointer whose note press was cut short does not drag the note being typed', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('tool.note')
    r.down(at(300, 500), { id: 1 })
    r.down(at(310, 500), { id: 1 })
    const id = r.s.editingNote
    expect(id).not.toBeNull()
    r.move(at(360, 500), { id: 1 })
    r.up(at(360, 500), { id: 1 })
    expect(r.s.gesturing).toBe(false)
    expect(r.s.canUndo).toBe(false)
    expect(r.s.editingNote).toBe(id)
    expect(finals(r)).toHaveLength(0)
  })
})

describe('fingers, pens and mice', () => {
  const stroke = (r: Rig, o: { id: number; pointerType: 'pen' | 'mouse' | 'touch' }, y: number): void => {
    r.down(at(0, y), o)
    for (let i = 1; i <= 10; i++) r.move(at(i * 20, y + (i % 2) * 15), o)
    r.up(at(200, y), o)
  }

  it('a palm resting on the glass does not stop the pen: the pen draws', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.exec('tool.pen')
    r.down(at(-300, 0), { id: 21, pointerType: 'touch' })
    stroke(r, { id: 22, pointerType: 'pen' }, 0)
    expect(r.doc.items).toHaveLength(1)
    r.up(at(-300, 0), { id: 21, pointerType: 'touch' })
    expect(r.doc.items).toHaveLength(1)
  })

  it('palm contacts while the pen draws are not a pinch and do not cancel the stroke', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.exec('tool.pen')
    const pen = { id: 22, pointerType: 'pen' as const }
    r.down(at(0, 0), pen)
    for (let i = 1; i <= 4; i++) r.move(at(i * 20, (i % 2) * 15), pen)
    r.down(at(-300, 200), { id: 31, pointerType: 'touch' })
    r.down(at(-250, 200), { id: 32, pointerType: 'touch' })
    expect(r.s.gesturing).toBe(true)
    for (let i = 5; i <= 10; i++) r.move(at(i * 20, (i % 2) * 15), pen)
    r.up(at(200, 0), pen)
    expect(r.doc.items).toHaveLength(1)
    expect(r.doc.view.zoom).toBe(1)
  })

  it('a pen coming down on a pinch ends the pinch and draws', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.exec('tool.pen')
    r.down(at(-300, 200), { id: 31, pointerType: 'touch' })
    r.down(at(-250, 200), { id: 32, pointerType: 'touch' })
    expect(r.s.moving).toBe(true)
    stroke(r, { id: 22, pointerType: 'pen' }, 0)
    expect(r.doc.items).toHaveLength(1)
  })

  it('two fingers still pinch', () => {
    const r = new Rig(emptyBoard('t'))
    r.down(at(-50, 0), { id: 1, pointerType: 'touch' })
    r.down(at(50, 0), { id: 2, pointerType: 'touch' })
    r.move(at(-100, 0), { id: 1, pointerType: 'touch' })
    r.move(at(100, 0), { id: 2, pointerType: 'touch' })
    expect(r.doc.view.zoom).toBeGreaterThan(1)
  })

  it('a mouse stroke is not taken by a finger either', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.exec('tool.pen')
    r.down(at(0, 0), { id: 1 })
    for (let i = 1; i <= 4; i++) r.move(at(i * 20, (i % 2) * 15), { id: 1 })
    r.down(at(-300, 200), { id: 31, pointerType: 'touch' })
    r.down(at(-250, 200), { id: 32, pointerType: 'touch' })
    for (let i = 5; i <= 10; i++) r.move(at(i * 20, (i % 2) * 15), { id: 1 })
    r.up(at(200, 0), { id: 1 })
    expect(r.doc.items).toHaveLength(1)
  })
})

describe('the eraser end of a pen', () => {
  const lined = () => build((b) => b.line('l', -100, 0, 100, 0, 6).stroke('s', [-100, 100, 0, 130, 100, 100], 6))

  it('rubs out what it touches whatever the tool, and leaves the tool alone', () => {
    for (const how of [
      { button: 5, buttons: 32 },
      { button: 0, buttons: 32 },
    ]) {
      const { doc } = lined()
      const r = new Rig(doc)
      expect(r.s.tool).toBe('select')
      // The rig derives `buttons` from `button`; the eraser bit is set by hand.
      r.c.pointerDown({ id: 3, x: at(0, 0).x, y: at(0, 0).y, button: how.button, buttons: how.buttons, shift: false, ctrl: false, alt: false, meta: false, pointerType: 'pen', pressure: 0.5, time: 1000 })
      r.c.pointerMove({ id: 3, x: at(20, 0).x, y: at(20, 0).y, button: how.button, buttons: how.buttons, shift: false, ctrl: false, alt: false, meta: false, pointerType: 'pen', pressure: 0.5, time: 1010 })
      r.c.pointerUp({ id: 3, x: at(20, 0).x, y: at(20, 0).y, button: how.button, buttons: 0, shift: false, ctrl: false, alt: false, meta: false, pointerType: 'pen', pressure: 0.5, time: 1020 })
      expect(r.doc.items.map((i) => i.kind), JSON.stringify(how)).toEqual(['stroke'])
      expect(r.s.undoLabel).toBe('Erase')
      expect(r.s.tool).toBe('select')
    }
  })

  it('a mouse with the same bits does nothing special', () => {
    const { doc } = lined()
    const r = new Rig(doc)
    r.c.pointerDown({ id: 3, x: at(0, 0).x, y: at(0, 0).y, button: 5, buttons: 32, shift: false, ctrl: false, alt: false, meta: false, pointerType: 'mouse', pressure: 0.5, time: 1000 })
    r.c.pointerUp({ id: 3, x: at(0, 0).x, y: at(0, 0).y, button: 5, buttons: 0, shift: false, ctrl: false, alt: false, meta: false, pointerType: 'mouse', pressure: 0.5, time: 1020 })
    expect(r.doc.items).toHaveLength(2)
  })
})

/* ------------------------------------------------- an outside change that is the same board --- */

describe('replaceDoc with a board that holds the same work', () => {
  it('keeps the stroke being drawn, and the stroke is committed', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('tool.pen')
    r.down(at(-100, 300))
    for (let i = 1; i <= 8; i++) r.move(at(-100 + i * 20, 300 + (i % 2) * 20))
    expect(r.s.draft).not.toBeNull()
    // The note was rewritten outside with the same board in it (other prose, other line endings): a board numbered 1, 2, 3 ...
    r.c.replaceDoc({ ...doc, nextId: 4 })
    expect(r.s.draft).not.toBeNull()
    for (let i = 9; i <= 16; i++) r.move(at(-100 + i * 20, 300 + (i % 2) * 20))
    r.up(at(220, 300))
    expect(r.doc.items).toHaveLength(4)
    expect(r.s.undoLabel).toBe('Draw')
  })

  it('judges a board by its work, not by the numbers of its items', () => {
    // A board that was edited has gaps in its ids; the same board read from a note is numbered from 1.
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100).pic('b', 300, 0, 100, 100).pic('c', 600, 0, 100, 100))
    const r = new Rig(doc)
    r.click(at(300, 0))
    r.c.exec('edit.delete')
    r.c.exec('tool.pen')
    r.down(at(0, 300))
    r.move(at(30, 330))
    r.move(at(60, 300))
    const renumbered = { ...r.doc, items: r.doc.items.map((it, i) => ({ ...it, id: i + 1 })), nextId: r.doc.items.length + 1 }
    expect(r.doc.items.map((i) => i.id)).toEqual([id.a, id.c])
    r.c.replaceDoc(renumbered)
    expect(r.s.draft).not.toBeNull()
    r.up(at(60, 300))
    expect(r.doc.items).toHaveLength(3)
  })

  it('keeps a note being edited', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.editNote(id.n)
    r.c.replaceDoc({ ...doc })
    expect(r.s.editingNote).toBe(id.n)
  })

  it('a board that differs still ends the gesture and takes the outside board', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('tool.pen')
    r.down(at(-100, 300))
    r.move(at(-80, 320))
    r.move(at(-60, 300))
    r.c.replaceDoc({ ...doc, items: doc.items.map((i) => (i.id === id.a && i.kind === 'picture' ? { ...i, x: i.x + 50 } : i)) })
    expect(r.s.draft).toBeNull()
    expect(r.s.gesturing).toBe(false)
    expect(pic(r, id.a).x).toBe(-250)
  })

  it('a drag in progress whose board is only the echo of the board it began with goes on', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.down(at(-300, -100))
    r.move(at(-250, -50))
    r.move(at(-200, 0))
    r.c.replaceDoc({ ...doc })
    expect(r.s.gesturing).toBe(true)
    r.up(at(-200, 0))
    expect(pic(r, id.a).x).toBe(-200)
  })
})

/* ------------------------------------------------- small boxes and locked selections --- */

describe('handles', () => {
  it('a selected picture smaller than its handles can still be dragged by its middle', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 150))
    const r = new Rig(doc)
    r.c.setView({ x: 0, y: 0, zoom: 0.05 })
    r.click({ x: 500, y: 400 })
    expect(r.s.selection).toEqual([id.a])
    r.drag({ x: 500, y: 400 }, { x: 540, y: 400 })
    expect(r.s.undoLabel).toBe('Move')
    expect(pic(r, id.a).x).toBeCloseTo(40 / 0.05, 6)
  })

  it('its corners can still be dragged to scale it', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 150))
    const r = new Rig(doc)
    r.c.setView({ x: 0, y: 0, zoom: 0.05 })
    r.click({ x: 500, y: 400 })
    // The south-east corner is at (505, 403.75).
    r.drag({ x: 505, y: 403.75 }, { x: 515, y: 411.25 })
    expect(r.s.undoLabel).toBe('Scale')
    expect(pic(r, id.a).w).toBeGreaterThan(200)
  })

  it('the rotate handle of a small box is as easy to hit as ever', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 200, 150))
    const r = new Rig(doc)
    r.c.setView({ x: 0, y: 0, zoom: 0.05 })
    r.click({ x: 500, y: 400 })
    // 3.75 px up to the top edge and 28 px above it; 6 px beside the handle is still on it.
    const top = 400 - 3.75
    r.down({ x: 506, y: top - 28 })
    expect(r.s.gesturing).toBe(true)
    r.move({ x: 520, y: top - 20 })
    r.move({ x: 530, y: top - 5 })
    r.up({ x: 530, y: top - 5 })
    expect(r.s.undoLabel).toBe('Rotate')
  })

  it('a box of ordinary size keeps its edge handles', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 150))
    const r = new Rig(doc)
    r.click({ x: 500, y: 400 })
    r.drag(at(100, 0), at(160, 0))
    expect(r.s.undoLabel).toBe('Scale')
    expect(pic(r, id.a).w).toBeGreaterThan(200)
  })

  it('a selection that is all locked has no handles: a press near its corner is a marquee, with no complaint', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100).pic('b', 260, 130, 100, 100).lock('a'))
    const r = new Rig(doc)
    r.click(at(0, 0))
    expect(r.s.selection).toEqual([id.a])
    r.forget()
    // 6.5 pixels beside the south-east corner: past the picture's own reach (6), inside the corner handle's (7). Dragged over picture b.
    r.drag(at(106.5, 50), at(300, 170))
    expect(r.s.selection).toEqual([id.b])
    expect(r.toasts('locked')).toHaveLength(0)
  })

  it('the cursor over a locked selection\'s corner is not a resize cursor', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 200, 100).lock('a'))
    const r = new Rig(doc)
    r.click(at(0, 0))
    r.hover(at(100, 50))
    expect(r.s.cursor).not.toMatch(/resize/)
  })
})

/* ------------------------------------------------- the small inconsistencies --- */

describe('small things', () => {
  it('a tap with the pen shows no dot that would not be kept: draft and commit agree', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.exec('tool.pen')
    r.down(at(10, 10))
    expect(r.s.draft).toBeNull()
    r.up(at(10, 10))
    expect(r.doc.items).toHaveLength(0)
    r.down(at(10, 10))
    r.move(at(30, 20))
    expect(r.s.draft).not.toBeNull()
    r.up(at(30, 20))
    expect(r.doc.items).toHaveLength(1)
  })

  it('the eraser does not step over thin marks on a fast jump', () => {
    const { doc } = build((b) => {
      for (let i = 0; i < 40; i++) b.line(`l${i}`, -300 + i * 15, -50, -300 + i * 15, 50, 1)
    })
    const r = new Rig(doc)
    r.c.exec('tool.eraser')
    r.down(at(-320, 0))
    // One jump of 700 pixels across all of them.
    r.move(at(380, 0))
    r.up(at(380, 0))
    expect(r.doc.items).toHaveLength(0)
  })

  it('the eraser leaves what its path does not touch, however long the jump', () => {
    const { doc } = build((b) => b.line('far', -300, 120, 300, 120, 2).line('near', -300, 0, 300, 0, 2).line('cross', 0, -200, 0, 200, 2))
    const r = new Rig(doc)
    r.c.exec('tool.eraser')
    r.down(at(-400, 3))
    r.move(at(400, 3))
    r.up(at(400, 3))
    expect(r.doc.items).toHaveLength(1)
    expect(r.doc.items[0]).toMatchObject({ kind: 'line', y1: 120 })
  })

  it('the cursor follows the selection and the tool without a pointer move', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.hover(at(-320, -100))
    expect(r.s.selection).toEqual([id.a])
    expect(r.s.cursor).toBe('move')
    r.key('Escape')
    expect(r.s.selection).toEqual([])
    expect(r.s.cursor).toBe('default')
    // A click on an item with the pointer staying put: the cursor says it can be moved.
    r.c.exec('tool.hand')
    expect(r.s.cursor).toBe('grab')
    r.c.exec('tool.select')
    expect(r.s.cursor).toBe('default')
    r.c.exec('edit.selectAll')
    expect(r.s.cursor).toBe('move')
  })

  it('a click that selects an item shows the move cursor at once, with the pointer where it was pressed', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    expect(r.s.cursor).toBe('move')
    r.click(at(0, 500))
    expect(r.s.cursor).toBe('default')
  })

  it('an erase cancelled with Esc brings the marks back selected', () => {
    const { doc, id } = build((b) => b.line('l', -100, 0, 100, 0, 6).line('m', -100, 40, 100, 40, 6))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('tool.eraser')
    r.down(at(0, -20))
    r.move(at(0, 60))
    expect(r.doc.items).toHaveLength(0)
    r.key('Escape')
    expect(r.doc.items).toHaveLength(2)
    expect(r.s.selection).toEqual([id.l, id.m])
  })

  it('a quick grab after a drag is a grab, not a double click that fits the view', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.down(at(-300, -100), { time: 1000 })
    r.move(at(-280, -100), { time: 1010 })
    r.move(at(-260, -100), { time: 1020 })
    r.up(at(-260, -100), { time: 1030 })
    expect(pic(r, id.a).x).toBe(-260)
    const view = r.doc.view
    // 100 ms later, 4 px from where the first press was: used to be a "double click".
    r.down(at(-296, -100), { time: 1100 })
    expect(r.doc.view).toEqual(view)
    expect(r.s.gesturing).toBe(true)
    r.move(at(-250, -100), { time: 1110 })
    r.up(at(-250, -100), { time: 1120 })
    expect(pic(r, id.a).x).toBeGreaterThan(-260)
  })

  it('two real clicks are still a double click', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.dblclick(at(0, 250))
    expect(r.s.editingNote).toBe(id.n)
  })
})

describe('editing the note that is being edited', () => {
  it('asking again keeps the new note being typed (it is in no history step: dropping it left an editor on nothing)', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    const id = r.c.addNoteAt({ x: 300, y: 300 })
    expect(id).not.toBe(0)
    r.c.editNote(id)
    expect(r.s.editingNote).toBe(id)
    expect(r.doc.items.some((i) => i.id === id)).toBe(true)
    r.c.commitNoteText(id, 'kept')
    expect(r.item<NoteItem>(id).text).toBe('kept')
    expect(r.s.undoLabel).toBe('Add note')
  })

  it('an existing note asked for twice is still the one being edited', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.editNote(id.n)
    r.c.editNote(id.n)
    expect(r.s.editingNote).toBe(id.n)
    r.c.commitNoteText(id.n, 'changed')
    expect(r.item<NoteItem>(id.n).text).toBe('changed')
  })
})
