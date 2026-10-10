import { describe, expect, it } from 'vitest'
import {
  BOARD_LIMITS,
  addMark,
  emptyBoard,
  itemBounds,
  itemQuad,
  estimateTextMetrics,
  type EllipseItem,
  type LineItem,
  type NoteItem,
  type PictureItem,
  type RectItem,
  type StrokeItem,
} from '@aether/core'
import { simplifyStroke } from '../src/board/controller'
import { Rig, at, build } from './board-controller-harness'

const M = estimateTextMetrics

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1)
  return items[0]!
}

/* --------------------------------------------------------------------- pen --- */

describe('the pen', () => {
  const penRig = (doc = emptyBoard('t'), opts = {}) => {
    const r = new Rig(doc, opts)
    r.c.exec('tool.pen')
    return r
  }

  it('draws a stroke through the points the pointer visited, as one history step', () => {
    const r = penRig()
    r.down(at(0, 0))
    r.move(at(40, 30))
    r.move(at(80, -20))
    r.move(at(120, 40))
    r.up(at(120, 40))
    const s = only(r.doc.items) as StrokeItem
    expect(s.kind).toBe('stroke')
    expect(s.points).toEqual([0, 0, 40, 30, 80, -20, 120, 40])
    expect(s.color).toBe('ff5a36')
    expect(s.width).toBe(3)
    expect(r.s.undoLabel).toBe('Draw')
    r.c.exec('edit.undo')
    expect(r.doc.items).toHaveLength(0)
    expect(r.s.canUndo).toBe(false)
  })

  it('shows the stroke as the draft while drawing and nothing is on the board until the pointer lifts', () => {
    const r = penRig()
    r.down(at(0, 0))
    r.move(at(20, 10))
    r.move(at(40, 0))
    expect(r.doc.items).toHaveLength(0)
    expect(r.s.draft).toMatchObject({ kind: 'stroke', points: [0, 0, 20, 10, 40, 0] })
    expect(r.s.canUndo).toBe(false)
    r.up(at(40, 0))
    expect(r.s.draft).toBeNull()
    expect(r.doc.items).toHaveLength(1)
  })

  it('takes a point only when the pointer is at least 1.5 pixels from the last one it took', () => {
    const r = penRig()
    r.down(at(0, 0))
    r.move(at(1, 0))
    r.move(at(1.4, 0))
    expect((r.s.draft as StrokeItem).points).toEqual([0, 0])
    r.move(at(1.6, 0))
    expect((r.s.draft as StrokeItem).points).toHaveLength(4)
    expect((r.s.draft as StrokeItem).points[2]).toBeCloseTo(1.6, 9)
    // Measured from the last point taken, not the last event: a slow creep still draws.
    r.move(at(2.5, 0))
    r.move(at(3.2, 0))
    expect((r.s.draft as StrokeItem).points).toHaveLength(6)
    expect((r.s.draft as StrokeItem).points[4]).toBeCloseTo(3.2, 9)
    r.up(at(3.2, 0))
  })

  it('drops a click and a stroke of one point', () => {
    const r = penRig()
    r.click(at(10, 10))
    r.down(at(10, 10))
    r.move(at(11, 10))
    r.up(at(11, 10))
    expect(r.doc.items).toHaveLength(0)
    expect(r.s.canUndo).toBe(false)
    expect(r.s.draft).toBeNull()
  })

  it('thins a straight run of points to its ends and keeps a corner', () => {
    const r = penRig()
    r.down(at(0, 0))
    for (let x = 10; x <= 200; x += 10) r.move(at(x, 0))
    for (let y = 10; y <= 100; y += 10) r.move(at(200, y))
    r.up(at(200, 100))
    expect((only(r.doc.items) as StrokeItem).points).toEqual([0, 0, 200, 0, 200, 100])
  })

  it('works in board units at any zoom: points and width divide by it', () => {
    const r = penRig()
    r.c.setView({ x: 0, y: 0, zoom: 4 })
    r.down({ x: 500, y: 400 })
    r.move({ x: 540, y: 440 })
    r.move({ x: 580, y: 400 })
    r.up({ x: 580, y: 400 })
    const s = only(r.doc.items) as StrokeItem
    expect(s.points).toEqual([0, 0, 10, 10, 20, 0])
    expect(s.width).toBe(0.75)
  })

  it('a pen tip thickens the line with its average pressure: width times 0.5 plus the average', () => {
    const r = penRig()
    r.down(at(0, 0), { pointerType: 'pen', pressure: 0.2 })
    r.move(at(20, 20), { pointerType: 'pen', pressure: 0.4 })
    r.move(at(40, 0), { pointerType: 'pen', pressure: 0.6 })
    r.up(at(40, 0), { pointerType: 'pen' })
    // (0.2 + 0.4 + 0.6) / 3 = 0.4, so 3 * 0.9.
    expect((only(r.doc.items) as StrokeItem).width).toBeCloseTo(2.7, 9)
  })

  it('full pressure is half as thick again, and a mouse (half pressure) changes nothing', () => {
    const r = penRig()
    r.down(at(0, 0), { pointerType: 'pen', pressure: 1 })
    r.move(at(20, 20), { pointerType: 'pen', pressure: 1 })
    r.up(at(20, 20), { pointerType: 'pen' })
    r.down(at(0, 100), { pressure: 0.5 })
    r.move(at(20, 120), { pressure: 0.5 })
    r.up(at(20, 120))
    const [a, b] = r.doc.items as StrokeItem[]
    expect(a!.width).toBeCloseTo(4.5, 9)
    expect(b!.width).toBe(3)
  })

  it('a touch draws as a mouse does', () => {
    const r = penRig()
    r.down(at(0, 0), { pointerType: 'touch', pressure: 1 })
    r.move(at(20, 20), { pointerType: 'touch', pressure: 1 })
    r.up(at(20, 20), { pointerType: 'touch' })
    expect((only(r.doc.items) as StrokeItem).width).toBe(3)
  })

  it('never holds more points than a stroke may, while drawing or when done', () => {
    const r = penRig()
    r.keepStates = false
    r.down(at(0, 0))
    let worst = 0
    let last = { x: 0, y: 0 }
    // A zigzag 30 000 pixels long: 15 000 moves, each past the 1.5 px spacing, and nothing a simplifier can drop for free.
    for (let i = 1; i <= 15_000; i++) {
      last = { x: 500 + i * 2, y: 400 + (i % 2 === 0 ? 30 : -30) }
      r.move(last)
      worst = Math.max(worst, ((r.s.draft as StrokeItem).points.length / 2) | 0)
    }
    expect(worst).toBeLessThanOrEqual(BOARD_LIMITS.strokePoints)
    expect(worst).toBeGreaterThan(1000)
    r.up(last)
    const s = only(r.doc.items) as StrokeItem
    expect(s.points.length / 2).toBeLessThanOrEqual(BOARD_LIMITS.strokePoints)
    expect(s.points.slice(0, 2)).toEqual([0, 0])
    // The end of the stroke is where the pointer was.
    expect(s.points[s.points.length - 2]).toBeCloseTo(last.x - 500, 9)
    expect(s.points[s.points.length - 1]).toBeCloseTo(last.y - 400, 9)
  }, 30_000)

  it('keeps the shape of a long smooth curve when it has to thin it', () => {
    const r = penRig()
    r.keepStates = false
    const at_ = (i: number) => ({ x: 500 + i * 1.6, y: 400 + 200 * Math.sin(i / 400) })
    r.down(at_(0))
    for (let i = 1; i <= 12_000; i++) r.move(at_(i))
    r.up(at_(12_000))
    const s = only(r.doc.items) as StrokeItem
    // Every ninth point of the true curve is within a few units of the polyline that was kept.
    const poly = s.points
    let worst = 0
    for (let i = 0; i <= 12_000; i += 9) {
      const p = { x: i * 1.6, y: 200 * Math.sin(i / 400) }
      let best = Infinity
      for (let k = 0; k + 3 < poly.length; k += 2) {
        const ax = poly[k]!
        const ay = poly[k + 1]!
        const bx = poly[k + 2]!
        const by = poly[k + 3]!
        const dx = bx - ax
        const dy = by - ay
        const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / (dx * dx + dy * dy || 1)))
        best = Math.min(best, Math.hypot(ax + t * dx - p.x, ay + t * dy - p.y))
      }
      worst = Math.max(worst, best)
    }
    expect(worst).toBeLessThan(5)
  }, 30_000)

  it('refuses to start on a full board and says so', () => {
    let doc = emptyBoard('full')
    for (let i = 0; i < BOARD_LIMITS.items; i++) doc = addMark(doc, { kind: 'line', x1: i, y1: 0, x2: i + 1, y2: 5, color: 'ffffff', width: 2, arrow: false }).doc
    const r = penRig(doc)
    r.down(at(0, 0))
    r.move(at(30, 30))
    r.up(at(30, 30))
    expect(r.doc.items).toHaveLength(BOARD_LIMITS.items)
    expect(r.toasts('limit')).toHaveLength(1)
    expect(r.s.draft).toBeNull()
  })

  it('Esc drops the draft', () => {
    const r = penRig()
    r.down(at(0, 0))
    r.move(at(30, 30))
    expect(r.s.draft).not.toBeNull()
    expect(r.key('Escape')).toBe(true)
    expect(r.s.draft).toBeNull()
    r.up(at(30, 30))
    expect(r.doc.items).toHaveLength(0)
    expect(r.s.tool).toBe('pen')
  })

  it('simplifyStroke keeps the ends, drops what is within the tolerance and never mutates its input', () => {
    const pts = [0, 0, 5, 0.3, 10, -0.2, 15, 0, 15, 10]
    const copy = pts.slice()
    expect(simplifyStroke(pts, 0.5)).toEqual([0, 0, 15, 0, 15, 10])
    expect(simplifyStroke(pts, 0.1).length).toBeGreaterThan(6)
    expect(pts).toEqual(copy)
    expect(simplifyStroke([1, 2], 5)).toEqual([1, 2])
    expect(simplifyStroke([], 5)).toEqual([])
  })
})

/* ------------------------------------------------------------------ shapes --- */

describe('lines, rectangles and ellipses', () => {
  const shapeRig = (tool: string, doc = emptyBoard('t')) => {
    const r = new Rig(doc)
    r.c.exec(`tool.${tool}` as 'tool.line')
    return r
  }

  it('a line goes from the press to the release, with the style, as one step', () => {
    const r = shapeRig('line')
    r.drag(at(10, 20), at(110, 70))
    const l = only(r.doc.items) as LineItem
    expect(l).toMatchObject({ kind: 'line', x1: 10, y1: 20, x2: 110, y2: 70, color: 'ff5a36', width: 3, arrow: false })
    expect(r.s.undoLabel).toBe('Draw line')
  })

  it('an arrow when the style says so', () => {
    const r = shapeRig('line')
    r.c.setStyle({ arrow: true, color: '00ff00', width: 6 })
    r.drag(at(0, 0), at(100, 0))
    expect(only(r.doc.items)).toMatchObject({ arrow: true, color: '00ff00', width: 6 })
    expect(r.s.undoLabel).toBe('Draw arrow')
  })

  it('shows the shape as the draft while the pointer is down', () => {
    const r = shapeRig('rect')
    r.down(at(0, 0))
    r.move(at(50, 40))
    expect(r.s.draft).toMatchObject({ kind: 'rect', x1: 0, y1: 0, x2: 50, y2: 40 })
    expect(r.doc.items).toHaveLength(0)
    r.move(at(80, 10))
    expect(r.s.draft).toMatchObject({ x2: 80, y2: 10 })
    r.up(at(80, 10))
    expect(r.s.draft).toBeNull()
    expect(only(r.doc.items)).toMatchObject({ kind: 'rect', x1: 0, y1: 0, x2: 80, y2: 10 })
  })

  it('shift makes a line snap to steps of 45 degrees and keeps its length', () => {
    const r = shapeRig('line')
    r.drag(at(0, 0), at(100, 30), { shift: true })
    const a = r.doc.items[0] as LineItem
    expect(a.y2).toBeCloseTo(0, 9)
    expect(a.x2).toBeCloseTo(Math.hypot(100, 30), 9)
    r.drag(at(0, 200), at(100, 290), { shift: true })
    const b = r.doc.items[1] as LineItem
    const d = Math.hypot(100, 90) / Math.SQRT2
    expect(b.x2).toBeCloseTo(d, 9)
    expect(b.y2 - b.y1).toBeCloseTo(d, 9)
    r.drag(at(0, 400), at(-5, 300), { shift: true })
    const c = r.doc.items[2] as LineItem
    expect(c.x2).toBeCloseTo(0, 9)
    // Straight up from (0, 400) by the length of the drag.
    expect(c.y2).toBeCloseTo(400 - Math.hypot(5, 100), 9)
  })

  it('shift makes a rectangle a square and an ellipse a circle, towards the pointer', () => {
    const r = shapeRig('rect')
    r.drag(at(0, 0), at(100, 40), { shift: true })
    expect(r.doc.items[0]).toMatchObject({ x1: 0, y1: 0, x2: 100, y2: 100 })
    r.drag(at(0, 0), at(-100, 40), { shift: true })
    expect(r.doc.items[1]).toMatchObject({ x1: 0, y1: 0, x2: -100, y2: 100 })
    r.c.exec('tool.ellipse')
    r.drag(at(0, 0), at(30, -80), { shift: true })
    expect(r.doc.items[2]).toMatchObject({ kind: 'ellipse', x1: 0, y1: 0, x2: 80, y2: -80 })
  })

  it('alt draws from the middle: the press is the centre', () => {
    const r = shapeRig('rect')
    r.drag(at(10, 10), at(110, 50), { alt: true })
    expect(r.doc.items[0]).toMatchObject({ x1: -90, y1: -30, x2: 110, y2: 50 })
    r.drag(at(0, 200), at(100, 240), { alt: true, shift: true })
    expect(r.doc.items[1]).toMatchObject({ x1: -100, y1: 100, x2: 100, y2: 300 })
    r.c.exec('tool.line')
    r.drag(at(0, 400), at(60, 400), { alt: true })
    expect(r.doc.items[2]).toMatchObject({ x1: -60, y1: 400, x2: 60, y2: 400 })
  })

  it('a rectangle and an ellipse take the style fill', () => {
    const r = shapeRig('rect')
    r.c.setStyle({ fill: '112233' })
    r.drag(at(0, 0), at(50, 50))
    r.c.exec('tool.ellipse')
    r.drag(at(100, 0), at(150, 50))
    expect((r.doc.items[0] as RectItem).fill).toBe('112233')
    expect((r.doc.items[1] as EllipseItem).fill).toBe('112233')
  })

  it('drops a tiny drag, with no history step', () => {
    for (const tool of ['line', 'rect', 'ellipse']) {
      const r = shapeRig(tool)
      r.drag(at(0, 0), at(2, 1))
      r.click(at(5, 5))
      expect(r.doc.items).toHaveLength(0)
      expect(r.s.canUndo).toBe(false)
      expect(r.s.draft).toBeNull()
    }
  })

  it('width is in pixels as drawn, so board units at the zoom', () => {
    const r = shapeRig('line')
    r.c.setView({ x: 0, y: 0, zoom: 0.5 })
    r.drag({ x: 500, y: 400 }, { x: 600, y: 400 })
    expect(only(r.doc.items)).toMatchObject({ x1: 0, x2: 200, width: 6 })
  })

  it('stays in the tool for the next one', () => {
    const r = shapeRig('ellipse')
    r.drag(at(0, 0), at(50, 50))
    expect(r.s.tool).toBe('ellipse')
  })
})

/* ------------------------------------------------------------------ eraser --- */

describe('the eraser', () => {
  const marks = () =>
    build((b) =>
      b
        .stroke('s', [-200, 0, -100, 0], 6)
        .line('l', 0, -100, 0, 100, 6)
        .rect('hollow', 100, -50, 200, 50, '', 6)
        .line('locked', 300, 0, 400, 0, 6)
        .lock('locked')
        .pic('p', 0, 300, 200, 100)
        .note('n', 300, 300, 200, 'x'),
    )

  it('removes the mark under the pointer at once', () => {
    const { doc, id } = marks()
    const r = new Rig(doc)
    r.c.exec('tool.eraser')
    r.down(at(-150, 0))
    expect(r.has(id.s!)).toBe(false)
    expect(r.has(id.l!)).toBe(true)
    r.up(at(-150, 0))
  })

  it('removes every mark the pointer passes over, in one history step, even over a long jump', () => {
    const { doc, id } = marks()
    const r = new Rig(doc)
    r.c.exec('tool.eraser')
    r.down(at(-250, 0))
    r.move(at(250, 0))
    r.up(at(250, 0))
    expect(r.has(id.s!)).toBe(false)
    expect(r.has(id.l!)).toBe(false)
    expect(r.has(id.hollow!)).toBe(false)
    expect(r.s.undoLabel).toBe('Erase')
    r.c.exec('edit.undo')
    expect(r.doc.items).toHaveLength(6)
    expect(r.s.canUndo).toBe(false)
  })

  it('leaves locked marks, pictures and notes alone', () => {
    const { doc, id } = marks()
    const r = new Rig(doc)
    r.c.exec('tool.eraser')
    r.drag(at(-500, 0), at(500, 0), {}, 20)
    r.drag(at(-300, 300), at(500, 300), {}, 20)
    expect(r.has(id.locked!)).toBe(true)
    expect(r.has(id.p!)).toBe(true)
    expect(r.has(id.n!)).toBe(true)
    expect(r.doc.items).toHaveLength(3)
  })

  it('passing over a locked mark alone changes nothing and tells nobody', () => {
    const { doc, id } = marks()
    const r = new Rig(doc)
    r.c.exec('tool.eraser')
    r.forget()
    r.drag(at(320, 0), at(380, 0))
    expect(r.has(id.locked!)).toBe(true)
    expect(r.doc.items).toBe(doc.items)
    expect(r.changes).toHaveLength(0)
    expect(r.s.canUndo).toBe(false)
  })

  it('erases the inside of a filled shape but only the outline of an empty one', () => {
    const { doc, id } = build((b) => b.rect('hollow', 0, 0, 100, 100, '', 4).rect('solid', 300, 0, 400, 100, 'ff0000', 4))
    const r = new Rig(doc)
    r.c.exec('tool.eraser')
    r.click(at(50, 50))
    expect(r.has(id.hollow!)).toBe(true)
    r.click(at(350, 50))
    expect(r.has(id.solid!)).toBe(false)
  })

  it('does nothing and records nothing when it hits nothing', () => {
    const { doc } = marks()
    const r = new Rig(doc)
    r.c.exec('tool.eraser')
    r.drag(at(-300, 200), at(300, 200))
    expect(r.doc.items).toBe(doc.items)
    expect(r.s.canUndo).toBe(false)
  })

  it('drops erased marks from the selection', () => {
    const { doc, id } = marks()
    const r = new Rig(doc)
    r.click(at(0, 0))
    expect(r.s.selection).toEqual([id.l])
    r.c.exec('tool.eraser')
    r.click(at(0, 50))
    expect(r.s.selection).toEqual([])
  })

  it('Esc puts the erased marks back', () => {
    const { doc } = marks()
    const r = new Rig(doc)
    r.c.exec('tool.eraser')
    r.down(at(-150, 0))
    r.move(at(150, 0))
    expect(r.doc.items.length).toBeLessThan(6)
    r.key('Escape')
    expect(r.doc.items).toHaveLength(6)
    r.up(at(150, 0))
    expect(r.s.canUndo).toBe(false)
  })
})

/* -------------------------------------------------------------- note tool --- */

describe('the note tool', () => {
  const noteRig = () => {
    const r = new Rig(emptyBoard('t'))
    r.c.exec('tool.note')
    return r
  }

  it('a click makes a note with its top left corner there and starts editing it', () => {
    const r = noteRig()
    r.click(at(100, 50))
    const id = r.s.editingNote
    expect(id).not.toBeNull()
    const n = r.item<NoteItem>(id!)
    expect(n).toMatchObject({ kind: 'note', text: '', w: 240, size: 18 })
    expect(n.x - n.w / 2).toBeCloseTo(100, 9)
    expect(itemBounds(n, M).y).toBeCloseTo(50, 9)
    expect(r.s.selection).toEqual([id])
    expect(r.s.tool).toBe('select')
    expect(r.s.box).toBeNull()
  })

  it('a drag sets the width', () => {
    const r = noteRig()
    r.drag(at(300, 100), at(100, 160))
    const n = r.item<NoteItem>(r.s.editingNote!)
    expect(n.w).toBe(200)
    expect(n.x - n.w / 2).toBeCloseTo(100, 9)
    expect(itemBounds(n, M).y).toBeCloseTo(100, 9)
  })

  it('shows the dragged width as a draft outline', () => {
    const r = noteRig()
    r.down(at(0, 0))
    r.move(at(150, 40))
    expect(r.s.draft).toMatchObject({ kind: 'rect', x1: 0, y1: 0, x2: 150, y2: 40 })
    r.up(at(150, 40))
    expect(r.s.draft).toBeNull()
  })

  it('size and width are pixels as they look: board units at the zoom', () => {
    const r = noteRig()
    r.c.setView({ x: 0, y: 0, zoom: 2 })
    r.click({ x: 500, y: 400 })
    expect(r.item<NoteItem>(r.s.editingNote!)).toMatchObject({ w: 120, size: 9 })
  })

  it('takes the style size, colour and background', () => {
    const r = noteRig()
    r.c.setStyle({ noteSize: 30, noteColor: 'ffcc00', noteFill: '202530' })
    r.click(at(0, 0))
    expect(r.item<NoteItem>(r.s.editingNote!)).toMatchObject({ size: 30, color: 'ffcc00', fill: '202530' })
  })

  it('a note whose colour is left to the board reads on the background', () => {
    const r = new Rig({ ...emptyBoard('t'), bg: 'ffffff' })
    r.c.exec('tool.note')
    r.click(at(0, 0))
    expect(r.item<NoteItem>(r.s.editingNote!).color).toBe('111111')
  })

  it('is in no history step until it has text; then one step adds it', () => {
    const r = noteRig()
    r.click(at(0, 0))
    const id = r.s.editingNote!
    expect(r.s.canUndo).toBe(false)
    r.c.commitNoteText(id, 'Check the edge')
    expect(r.s.editingNote).toBeNull()
    expect(r.item<NoteItem>(id).text).toBe('Check the edge')
    expect(r.s.undoLabel).toBe('Add note')
    r.c.exec('edit.undo')
    expect(r.doc.items).toHaveLength(0)
    expect(r.s.canUndo).toBe(false)
    r.c.exec('edit.redo')
    expect(r.item<NoteItem>(id).text).toBe('Check the edge')
  })

  it('empty text deletes the note and leaves no step; so does white space', () => {
    for (const text of ['', '   \n  ']) {
      const r = noteRig()
      r.click(at(0, 0))
      const id = r.s.editingNote!
      r.c.commitNoteText(id, text)
      expect(r.doc.items).toHaveLength(0)
      expect(r.s.canUndo).toBe(false)
      expect(r.s.dirty).toBe(false)
      expect(r.s.selection).toEqual([])
      expect(r.s.editingNote).toBeNull()
    }
  })

  it('cancelling the edit of a new note removes it', () => {
    const r = noteRig()
    r.click(at(0, 0))
    expect(r.doc.items).toHaveLength(1)
    r.c.cancelNoteEdit()
    expect(r.doc.items).toHaveLength(0)
    expect(r.s.editingNote).toBeNull()
    expect(r.s.dirty).toBe(false)
  })

  it('Esc while editing cancels', () => {
    const r = noteRig()
    r.click(at(0, 0))
    expect(r.key('Escape')).toBe(true)
    expect(r.doc.items).toHaveLength(0)
  })

  it('the board does not take other keys or presses while a note is being edited', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100).note('n', 300, 0, 200, 'x'))
    const r = new Rig(doc)
    r.c.editNote(id.n!)
    expect(r.s.editingNote).toBe(id.n)
    expect(r.key('Delete')).toBe(false)
    expect(r.key('a', { ctrl: true })).toBe(false)
    r.click(at(0, 0))
    expect(r.s.selection).toEqual([id.n])
    expect(r.s.editingNote).toBe(id.n)
  })

  it('editing an existing note and committing new text is one step; the same text is none', () => {
    const { doc, id } = build((b) => b.note('n', 0, 0, 200, 'old'))
    const r = new Rig(doc)
    r.c.editNote(id.n!)
    r.c.commitNoteText(id.n!, 'old')
    expect(r.s.canUndo).toBe(false)
    expect(r.s.editingNote).toBeNull()
    r.c.editNote(id.n!)
    r.c.commitNoteText(id.n!, 'new text')
    expect(r.item<NoteItem>(id.n!).text).toBe('new text')
    expect(r.s.undoLabel).toBe('Edit note')
    r.c.exec('edit.undo')
    expect(r.item<NoteItem>(id.n!).text).toBe('old')
  })

  it('emptying an existing note deletes it, with an undo', () => {
    const { doc, id } = build((b) => b.note('n', 0, 0, 200, 'old'))
    const r = new Rig(doc)
    r.c.editNote(id.n!)
    r.c.commitNoteText(id.n!, '')
    expect(r.doc.items).toHaveLength(0)
    r.c.exec('edit.undo')
    expect(r.item<NoteItem>(id.n!).text).toBe('old')
  })

  it('cuts a text past the limit', () => {
    const { doc, id } = build((b) => b.note('n', 0, 0, 200, 'x'))
    const r = new Rig(doc)
    r.c.commitNoteText(id.n!, 'y'.repeat(BOARD_LIMITS.noteChars + 500))
    expect(r.item<NoteItem>(id.n!).text).toHaveLength(BOARD_LIMITS.noteChars)
  })

  it('a locked note does not take new text', () => {
    const { doc, id } = build((b) => b.note('n', 0, 0, 200, 'x').lock('n'))
    const r = new Rig(doc)
    r.c.commitNoteText(id.n!, 'changed')
    expect(r.item<NoteItem>(id.n!).text).toBe('x')
    expect(r.toasts('locked')).toHaveLength(1)
  })

  it('the note keeps its top left corner when its text grows', () => {
    const r = noteRig()
    r.click(at(40, 60))
    const id = r.s.editingNote!
    r.c.commitNoteText(id, 'a long text '.repeat(30))
    const n = r.item<NoteItem>(id)
    expect(n.x - n.w / 2).toBeCloseTo(40, 9)
    expect(itemBounds(n, M).y).toBeCloseTo(60, 9)
    expect(itemBounds(n, M).h).toBeGreaterThan(100)
  })

  it('refuses a new note on a full board', () => {
    let doc = emptyBoard('full')
    for (let i = 0; i < BOARD_LIMITS.items; i++) doc = addMark(doc, { kind: 'line', x1: i, y1: 0, x2: i + 1, y2: 5, color: 'ffffff', width: 2, arrow: false }).doc
    const r = new Rig(doc)
    expect(r.c.addNoteAt({ x: 0, y: 0 })).toBe(0)
    expect(r.toasts('limit')).toHaveLength(1)
    expect(r.s.editingNote).toBeNull()
  })

  it('another command while a new note is being typed drops it (the shell commits first)', () => {
    const r = noteRig()
    r.click(at(0, 0))
    r.c.exec('view.gray')
    expect(r.doc.items).toHaveLength(0)
    expect(r.s.editingNote).toBeNull()
  })

  it('zooming the camera does not end the edit', () => {
    const r = noteRig()
    r.click(at(0, 0))
    const id = r.s.editingNote
    r.c.exec('view.zoomIn')
    r.wheel(500, 400, -100)
    expect(r.s.editingNote).toBe(id)
    expect(r.doc.items).toHaveLength(1)
  })
})

/* ----------------------------------------------------------------- sampler --- */

describe('the sampler', () => {
  const rigFor = () => {
    const r = new Rig(build((b) => b.pic('a', 0, 0, 200, 100)).doc)
    r.c.exec('tool.sampler')
    return r
  }

  it('asks for the colour under the pointer wherever it goes, in canvas pixels', () => {
    const r = rigFor()
    r.hover({ x: 321, y: 123 })
    r.hover({ x: 330, y: 130 })
    expect(r.eventsOf('sample-request').map((e) => e.at)).toEqual([
      { x: 321, y: 123 },
      { x: 330, y: 130 },
    ])
  })

  it('shows the answer in the state until the next one', () => {
    const r = rigFor()
    r.hover({ x: 321, y: 123 })
    r.c.sampleAt({ x: 321, y: 123 }, 'A1B2C3')
    expect(r.s.sample).toEqual({ x: 321, y: 123, hex: 'a1b2c3' })
    r.c.sampleAt({ x: 330, y: 130 }, null)
    expect(r.s.sample).toBeNull()
  })

  it('answers from inside the event, as the shell does', () => {
    const r = rigFor()
    r.c.onEvent((e) => {
      if (e.type === 'sample-request') r.c.sampleAt(e.at, '336699')
    })
    r.hover({ x: 10, y: 10 })
    expect(r.s.sample).toEqual({ x: 10, y: 10, hex: '336699' })
  })

  it('a click commits the colour under the pointer', () => {
    const r = rigFor()
    r.c.onEvent((e) => {
      if (e.type === 'sample-request') r.c.sampleAt(e.at, '336699')
    })
    r.click({ x: 10, y: 10 })
    expect(r.eventsOf('sample-commit')).toEqual([{ type: 'sample-commit', hex: '336699' }])
  })

  it('a release away from the last answer asks again and commits what the answer is', () => {
    const r = rigFor()
    r.down({ x: 10, y: 10 })
    r.c.sampleAt({ x: 10, y: 10 }, '111111')
    r.move({ x: 60, y: 60 })
    r.up({ x: 60, y: 60 })
    expect(r.eventsOf('sample-commit')).toHaveLength(0)
    r.c.sampleAt({ x: 60, y: 60 }, '222222')
    expect(r.eventsOf('sample-commit')).toEqual([{ type: 'sample-commit', hex: '222222' }])
  })

  it('changes nothing on the board and records nothing', () => {
    const r = rigFor()
    r.c.onEvent((e) => {
      if (e.type === 'sample-request') r.c.sampleAt(e.at, '336699')
    })
    r.click({ x: 10, y: 10 })
    expect(r.s.canUndo).toBe(false)
    expect(r.s.dirty).toBe(false)
  })

  it('leaving the tool clears the loupe, and so does leaving the canvas', () => {
    const r = rigFor()
    r.c.sampleAt({ x: 1, y: 1 }, '000000')
    expect(r.s.sample).not.toBeNull()
    r.c.pointerLeave()
    expect(r.s.sample).toBeNull()
    r.c.sampleAt({ x: 1, y: 1 }, '000000')
    r.c.exec('tool.select')
    expect(r.s.sample).toBeNull()
    // An answer that arrives after the tool changed is ignored.
    r.c.sampleAt({ x: 1, y: 1 }, '000000')
    expect(r.s.sample).toBeNull()
  })
})

/* ---------------------------------------------------------------- the style --- */

describe('the drawing style', () => {
  it('ignores values that are not valid and keeps the rest', () => {
    const r = new Rig(emptyBoard('t'))
    const before = r.s.style
    r.c.setStyle({ color: 'nonsense', width: NaN, noteSize: Infinity, fill: 'zz' })
    expect(r.s.style).toEqual(before)
    r.c.setStyle({ color: '#AbCdEf', width: 9999, noteSize: 1, fill: '123456', arrow: true })
    expect(r.s.style).toMatchObject({ color: 'abcdef', width: 200, noteSize: 6, fill: '123456', arrow: true })
    r.c.setStyle({ fill: '' })
    expect(r.s.style.fill).toBe('')
  })

  it('with the select tool, restyles the selected marks and notes as one step; with another tool it does not', () => {
    const { doc, id } = build((b) => b.line('l', 0, 0, 100, 0).rect('r', 0, 50, 100, 100, '').note('n', 300, 0, 200, 'x').pic('p', 0, 300, 100, 100))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.setStyle({ color: '00ff00', width: 8, fill: '445566', noteColor: 'ffff00', noteSize: 30, noteFill: '010203' })
    expect(r.item(id.l!)).toMatchObject({ color: '00ff00', width: 8 })
    expect(r.item(id.r!)).toMatchObject({ color: '00ff00', width: 8, fill: '445566' })
    expect(r.item(id.n!)).toMatchObject({ color: 'ffff00', size: 30, fill: '010203' })
    expect(r.item<PictureItem>(id.p!)).toMatchObject({ w: 100 })
    expect(r.s.undoLabel).toBe('Style')
    r.c.exec('edit.undo')
    expect(r.item(id.l!)).toMatchObject({ color: 'ff0000', width: 4 })
    expect(r.s.canUndo).toBe(false)

    r.c.exec('tool.pen')
    r.c.setStyle({ color: '0000ff' })
    expect(r.item(id.l!)).toMatchObject({ color: 'ff0000' })
    expect(r.s.style.color).toBe('0000ff')
  })

  it('changing a note\'s colour while it is being edited does not end the editing', () => {
    const { doc, id } = build((b) => b.note('n', 0, 0, 200, 'x'))
    const r = new Rig(doc)
    r.c.editNote(id.n!)
    r.c.setStyle({ noteColor: 'ffcc00' })
    expect(r.s.editingNote).toBe(id.n)
    expect(r.item<NoteItem>(id.n!).color).toBe('ffcc00')
    r.c.commitNoteText(id.n!, 'typed meanwhile')
    expect(r.item<NoteItem>(id.n!)).toMatchObject({ text: 'typed meanwhile', color: 'ffcc00' })
  })

  it('a new note being typed is not restyled by the style controls, but takes the new style when made', () => {
    const r = new Rig(emptyBoard('t'))
    const id = r.c.addNoteAt({ x: 0, y: 0 })
    const before = r.item<NoteItem>(id)
    r.c.setStyle({ noteColor: 'ffcc00', noteSize: 40 })
    expect(r.item<NoteItem>(id)).toBe(before)
    r.c.cancelNoteEdit()
    const id2 = r.c.addNoteAt({ x: 0, y: 0 })
    expect(r.item<NoteItem>(id2)).toMatchObject({ color: 'ffcc00', size: 40 })
  })

  it('a run of changes inside the coalescing window is one step', () => {
    const { doc, id } = build((b) => b.line('l', 0, 0, 100, 0))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.setStyle({ color: '111111' })
    r.clock += 100
    r.c.setStyle({ color: '222222' })
    r.clock += 100
    r.c.setStyle({ color: '333333' })
    expect(r.item(id.l!)).toMatchObject({ color: '333333' })
    r.c.exec('edit.undo')
    expect(r.item(id.l!)).toMatchObject({ color: 'ff0000' })
  })

  it('a value that is not valid restyles nothing, not even with the old value', () => {
    const { doc, id } = build((b) => b.line('l', 0, 0, 100, 0).note('n', 300, 0, 200, 'x', { color: 'abcdef' }))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.forget()
    r.c.setStyle({ color: 'nope', width: NaN, noteColor: 'bad', noteSize: Infinity, fill: 'zz', noteFill: 'qq' })
    expect(r.doc).toBe(doc)
    expect(r.changes).toHaveLength(0)
    expect(r.item(id.l!)).toMatchObject({ color: 'ff0000', width: 4 })
    expect(r.item<NoteItem>(id.n!).color).toBe('abcdef')
  })

  it('leaves locked items alone', () => {
    const { doc, id } = build((b) => b.line('l', 0, 0, 100, 0).lock('l'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.setStyle({ color: '00ff00' })
    expect(r.item(id.l!)).toMatchObject({ color: 'ff0000' })
  })

  it('a width on selected marks is in pixels at the zoom', () => {
    const { doc, id } = build((b) => b.line('l', 0, 0, 100, 0))
    const r = new Rig(doc)
    r.c.setView({ x: 0, y: 0, zoom: 4 })
    r.c.exec('edit.selectAll')
    r.c.setStyle({ width: 8 })
    expect(r.item(id.l!)).toMatchObject({ width: 2 })
  })
})

/* -------------------------------------------------------------------- crop --- */

describe('cropping', () => {
  const rigFor = (extra = {}) => {
    const b = build((x) => x.pic('a', 0, 0, 200, 100, extra).pic('b', 400, 0, 200, 100))
    const r = new Rig(b.doc)
    r.click(at(0, 0))
    r.c.exec('tool.crop')
    return { r, id: b.id.a!, other: b.id.b! }
  }

  it('starts on the selected picture, hides the ordinary box and shows no rotate handle', () => {
    const { r, id } = rigFor()
    expect(r.s.tool).toBe('crop')
    expect(r.s.cropping).toBe(id)
    expect(r.s.box).toBeNull()
  })

  it('dragging the right edge crops it and what is left does not move', () => {
    const { r, id } = rigFor()
    r.drag(at(100, 0), at(60, 0))
    const p = r.item<PictureItem>(id)
    expect(p.crop.r).toBeCloseTo(0.8, 9)
    expect(p.crop).toMatchObject({ l: 0, t: 0, b: 1 })
    const box = itemBounds(p, M)
    expect(box.x).toBeCloseTo(-100, 9)
    expect(box.x + box.w).toBeCloseTo(60, 9)
    expect(p.w).toBe(200)
    expect(r.s.undoLabel).toBe('Crop')
    expect(r.s.cropping).toBe(id)
  })

  it('every edge and corner crops the side it is on', () => {
    const cases: [string, [number, number], [number, number], Partial<Record<'l' | 't' | 'r' | 'b', number>>][] = [
      ['w', [-100, 0], [-60, 0], { l: 0.2 }],
      ['n', [0, -50], [0, -30], { t: 0.2 }],
      ['s', [0, 50], [0, 30], { b: 0.8 }],
      ['nw', [-100, -50], [-60, -30], { l: 0.2, t: 0.2 }],
      ['ne', [100, -50], [60, -30], { r: 0.8, t: 0.2 }],
      ['se', [100, 50], [60, 30], { r: 0.8, b: 0.8 }],
      ['sw', [-100, 50], [-60, 30], { l: 0.2, b: 0.8 }],
    ]
    for (const [name, from, to, want] of cases) {
      const { r, id } = rigFor()
      r.drag(at(from[0], from[1]), at(to[0], to[1]))
      const c = r.item<PictureItem>(id).crop
      const full = { l: 0, t: 0, r: 1, b: 1, ...want }
      for (const k of ['l', 't', 'r', 'b'] as const) expect(c[k], `${name}.${k}`).toBeCloseTo(full[k], 9)
    }
  })

  it('what stays visible does not move, also when the picture is flipped and turned', () => {
    for (const extra of [{ flipH: true }, { flipV: true }, { rotation: 90 }, { rotation: 33, flipH: true, flipV: true }]) {
      const { r, id } = rigFor(extra)
      const before = r.item<PictureItem>(id)
      const q0 = itemQuad(before, M)
      // Drag the handle on the picture's own right side, wherever that is on the screen, inwards by 40 board units.
      const right = { x: (q0[1].x + q0[2].x) / 2, y: (q0[1].y + q0[2].y) / 2 }
      const left = { x: (q0[0].x + q0[3].x) / 2, y: (q0[0].y + q0[3].y) / 2 }
      const towards = { x: (left.x - right.x) / 200, y: (left.y - right.y) / 200 }
      const to = { x: right.x + towards.x * 40, y: right.y + towards.y * 40 }
      r.drag(at(right.x, right.y), at(to.x, to.y))
      const after = r.item<PictureItem>(id)
      const q1 = itemQuad(after, M)
      // The left edge (corners 0 and 3) has not moved on the board; the right edge came in by 40.
      expect(q1[0].x).toBeCloseTo(q0[0].x, 6)
      expect(q1[0].y).toBeCloseTo(q0[0].y, 6)
      expect(q1[3].x).toBeCloseTo(q0[3].x, 6)
      expect(q1[3].y).toBeCloseTo(q0[3].y, 6)
      expect(Math.hypot(q1[1].x - q0[1].x, q1[1].y - q0[1].y)).toBeCloseTo(40, 6)
      expect(after.w).toBe(200)
      expect(after.rotation).toBeCloseTo(before.rotation, 9)
    }
  })

  it('a press a little off the edge does not make the crop jump', () => {
    const { r, id } = rigFor()
    r.down(at(104, 5))
    r.move(at(104, 5))
    expect(r.item<PictureItem>(id).crop.r).toBe(1)
    r.move(at(64, 5))
    // The edge moved in by the 40 the pointer did.
    expect(r.item<PictureItem>(id).crop.r).toBeCloseTo(0.8, 9)
    r.up(at(64, 5))
  })

  it('cannot go below 2% of an edge, whichever way it is dragged', () => {
    const { r, id } = rigFor()
    r.drag(at(100, 0), at(-500, 0))
    const c = r.item<PictureItem>(id).crop
    expect(c.r - c.l).toBeCloseTo(0.02, 9)
    expect(c.l).toBe(0)
    r.drag(at(-100 + 0.02 * 200, 0), at(900, 0))
    // Dragged back out it grows to the whole picture and no further.
    expect(r.item<PictureItem>(id).crop.r).toBe(1)
  })

  it('an edge can be dragged back out over the part that was cropped away', () => {
    const { r, id } = rigFor()
    r.drag(at(100, 0), at(0, 0))
    expect(r.item<PictureItem>(id).crop.r).toBeCloseTo(0.5, 9)
    const box = itemBounds(r.item<PictureItem>(id), M)
    r.drag(at(box.x + box.w, 0), at(100, 0))
    expect(r.item<PictureItem>(id).crop.r).toBeCloseTo(1, 9)
    expect(r.item<PictureItem>(id).x).toBeCloseTo(0, 9)
  })

  it('a drag is one history step; a drag that changes nothing is none', () => {
    const { r, id } = rigFor()
    r.down(at(100, 0))
    r.move(at(80, 0))
    r.move(at(60, 0))
    expect(r.s.canUndo).toBe(false)
    r.up(at(60, 0))
    r.c.exec('edit.undo')
    expect(r.item<PictureItem>(id).crop).toEqual({ l: 0, t: 0, r: 1, b: 1 })
    expect(r.s.canUndo).toBe(false)
    r.click(at(100, 0))
    expect(r.s.canUndo).toBe(false)
  })

  it('Enter, Esc and choosing another tool end cropping', () => {
    for (const end of ['Enter', 'Escape', 'tool']) {
      const { r, id } = rigFor()
      if (end === 'tool') r.c.exec('tool.pen')
      else expect(r.key(end)).toBe(true)
      expect(r.s.cropping, end).toBeNull()
      expect(r.s.selection, end).toEqual([id])
      expect(r.s.tool, end).toBe(end === 'tool' ? 'pen' : 'select')
    }
  })

  it('a picture that is not selected is chosen for cropping by clicking it', () => {
    const { r, id, other } = rigFor()
    r.click(at(400, 0))
    expect(r.s.cropping).toBe(other)
    expect(r.s.selection).toEqual([other])
    expect(id).not.toBe(other)
  })

  it('the crop tool with nothing to crop says so and waits for a click', () => {
    const b = build((x) => x.pic('a', 0, 0, 200, 100))
    const r = new Rig(b.doc)
    r.c.exec('tool.crop')
    expect(r.s.tool).toBe('crop')
    expect(r.s.cropping).toBeNull()
    expect(r.toasts('select')).toHaveLength(1)
    r.click(at(0, 0))
    expect(r.s.cropping).toBe(b.id.a)
  })

  it('refuses a locked picture', () => {
    const b = build((x) => x.pic('a', 0, 0, 200, 100).lock('a'))
    const r = new Rig(b.doc)
    r.click(at(0, 0))
    r.c.exec('tool.crop')
    expect(r.s.cropping).toBeNull()
    expect(r.s.tool).toBe('select')
    expect(r.toasts('locked')).toHaveLength(1)
  })

  it('deleting the picture ends cropping', () => {
    const { r } = rigFor()
    r.c.exec('edit.delete')
    expect(r.s.cropping).toBeNull()
    expect(r.s.tool).toBe('select')
  })

  it('an undo that removes the picture ends cropping', () => {
    const b = build((x) => x.pic('a', 0, 0, 200, 100))
    const r = new Rig(b.doc)
    r.click(at(0, 0))
    r.c.exec('edit.duplicate')
    r.c.exec('tool.crop')
    expect(r.s.cropping).not.toBeNull()
    r.c.exec('edit.undo')
    expect(r.s.cropping).toBeNull()
    expect(r.s.tool).toBe('select')
  })

  it('shows the resize cursor of the crop handle under the pointer', () => {
    const { r } = rigFor()
    r.hover(at(100, 0))
    expect(r.s.cursor).toBe('ew-resize')
    r.hover(at(100, 50))
    expect(r.s.cursor).toBe('nwse-resize')
    r.hover(at(0, 50))
    expect(r.s.cursor).toBe('ns-resize')
    r.hover(at(0, 0))
    expect(r.s.cursor).toBe('default')
  })

})
