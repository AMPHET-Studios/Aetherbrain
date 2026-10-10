import { describe, expect, it } from 'vitest'
import { itemBounds, itemQuad, estimateTextMetrics, emptyBoard, type NoteItem, type PictureItem, type StrokeItem } from '@aether/core'
import { ROTATE_HANDLE_PX } from '../src/board/controller'
import { Rig, at, build, threeThings, withoutView } from './board-controller-harness'

const M = estimateTextMetrics

/* ------------------------------------------------------------------ select --- */

describe('selecting', () => {
  it('a click on an item selects it and a click on the empty canvas clears the selection', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    expect(r.s.selection).toEqual([id.a])
    r.click(at(100, -100))
    expect(r.s.selection).toEqual([id.b])
    r.click(at(0, 500))
    expect(r.s.selection).toEqual([])
    expect(r.s.canUndo).toBe(false)
  })

  it('hits within 6 CSS pixels of an item and misses at 8, whatever the zoom', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100))
    const r = new Rig(doc)
    // Away from the handle of a selected item, which is a target of its own.
    r.click(at(70, 20))
    r.click(at(100 + 5, 20))
    expect(r.s.selection).toEqual([id.a])
    r.click(at(300, 300))
    r.click(at(100 + 8, 20))
    expect(r.s.selection).toEqual([])
    r.c.setView({ x: 0, y: 0, zoom: 4 })
    // At zoom 4 the item is 800 px wide, its right edge at screen +400: 5 px beyond it is a hit, 8 px is not.
    r.click({ x: 500 + 400 + 5, y: 400 + 40 })
    expect(r.s.selection).toEqual([id.a])
    r.click({ x: 500, y: 790 })
    r.click({ x: 500 + 400 + 8, y: 400 + 40 })
    expect(r.s.selection).toEqual([])
  })

  it('shift and ctrl and meta toggle an item in the selection', () => {
    const { doc, id } = threeThings()
    for (const mod of ['shift', 'ctrl', 'meta'] as const) {
      const r = new Rig(doc)
      r.click(at(-300, -100))
      r.click(at(100, -100), { [mod]: true })
      expect(r.s.selection).toEqual([id.a, id.b])
      r.click(at(100, -100), { [mod]: true })
      expect(r.s.selection).toEqual([id.a])
    }
  })

  it('a click on a selected item keeps the selection until the button is up, then narrows to that item', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    expect(r.s.selection).toEqual([id.a, id.b, id.n])
    r.down(at(-300, -100))
    expect(r.s.selection).toEqual([id.a, id.b, id.n])
    r.up(at(-300, -100))
    expect(r.s.selection).toEqual([id.a])
  })

  it('dragging a selected item drags the whole selection and keeps it', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.drag(at(-300, -100), at(-300, -60))
    expect(r.s.selection).toEqual([id.a, id.b, id.n])
    expect(r.item<PictureItem>(id.a).y).toBeCloseTo(-60, 9)
    expect(r.item<PictureItem>(id.b).y).toBeCloseTo(-60, 9)
    expect(r.item<NoteItem>(id.n).y).toBeCloseTo(290, 9)
  })

  it('pressing an item that is not selected replaces the selection with it, and a drag moves just it', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.down(at(100, -100))
    expect(r.s.selection).toEqual([id.b])
    r.up(at(100, -100))
    expect(r.item<PictureItem>(id.a).x).toBe(-300)
  })

  it('the topmost of overlapping items is the one hit', () => {
    const { doc, id } = build((b) => b.pic('under', 0, 0, 200, 200).pic('over', 20, 20, 200, 200))
    const r = new Rig(doc)
    r.click(at(50, 50))
    expect(r.s.selection).toEqual([id.over])
  })

  it('shift-click on a selected item takes it out only when it was a click, not a drag', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.click(at(100, -100), { shift: true })
    expect(r.s.selection).toEqual([id.a, id.b])
    r.drag(at(100, -100), at(100, -70), { shift: true })
    expect(r.s.selection).toEqual([id.a, id.b])
    expect(r.item<PictureItem>(id.b).y).toBeCloseTo(-70, 9)
  })
})

describe('the marquee', () => {
  it('selects what it touches, even by a corner, in any drag direction', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    // a spans x -400..-200, y -150..-50; the rectangle overlaps only its lower right corner.
    r.drag(at(-220, -70), at(-150, 0))
    expect(r.s.selection).toEqual([id.a])
    r.drag(at(-150, 0), at(-220, -70))
    expect(r.s.selection).toEqual([id.a])
    r.drag(at(-150, -70), at(-220, 0))
    expect(r.s.selection).toEqual([id.a])
    r.drag(at(-220, 0), at(-150, -70))
    expect(r.s.selection).toEqual([id.a])
  })

  it('shows the rectangle in board units while dragging and clears it at the end', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.down(at(-450, -200))
    r.move(at(-250, -75))
    expect(r.s.marquee).toEqual({ x: -450, y: -200, w: 200, h: 125 })
    r.move(at(-500, -300))
    expect(r.s.marquee).toEqual({ x: -500, y: -300, w: 50, h: 100 })
    r.up(at(-500, -300))
    expect(r.s.marquee).toBeNull()
  })

  it('updates the selection while it is dragged', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.down(at(-450, -200))
    r.move(at(-250, -75))
    expect(r.s.selection).toEqual([id.a])
    r.move(at(250, 100))
    expect(r.s.selection).toEqual([id.a, id.b])
    r.move(at(-250, -75))
    expect(r.s.selection).toEqual([id.a])
    r.up(at(-250, -75))
    expect(r.s.selection).toEqual([id.a])
  })

  it('replaces the selection, and shift adds to it', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(0, 250))
    expect(r.s.selection).toEqual([id.n])
    r.drag(at(-450, -200), at(-250, -75))
    expect(r.s.selection).toEqual([id.a])
    r.drag(at(50, -200), at(250, -75), { shift: true })
    expect(r.s.selection).toEqual([id.a, id.b])
  })

  it('a click on the empty canvas clears the selection, a shift-click keeps it', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.click(at(0, 500), { shift: true })
    expect(r.s.selection).toEqual([id.a])
    r.click(at(0, 500))
    expect(r.s.selection).toEqual([])
  })

  it('a drag of under 3 pixels is a click', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.drag(at(0, 500), at(2, 501))
    expect(r.s.selection).toEqual([])
    expect(r.s.marquee).toBeNull()
    r.click(at(-300, -100))
    r.down(at(-300, -100))
    r.move(at(-298, -99))
    r.up(at(-298, -99))
    expect(r.item<PictureItem>(id.a).x).toBe(-300)
    expect(r.s.canUndo).toBe(false)
  })

  it('takes a whole group when it touches one member', () => {
    const { doc, id } = build((b) => b.pic('a', -300, 0, 100, 100).pic('b', 300, 0, 100, 100).pic('c', 0, 300, 100, 100).group('a', 'b'))
    const r = new Rig(doc)
    r.drag(at(-400, -100), at(-200, 100))
    expect(r.s.selection).toEqual([id.a, id.b])
  })

  it('takes locked items too (they can be selected)', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100).lock('a'))
    const r = new Rig(doc)
    r.drag(at(-100, -100), at(100, 100))
    expect(r.s.selection).toEqual([id.a])
  })

  it('takes strokes and shapes by their thickness and an empty rectangle by its outline only', () => {
    const { doc, id } = build((b) => b.rect('hollow', -100, -100, 100, 100).stroke('s', [300, 0, 400, 0], 6))
    const r = new Rig(doc)
    r.drag(at(-20, -20), at(20, 20))
    expect(r.s.selection).toEqual([])
    r.drag(at(-120, -20), at(-80, 20))
    expect(r.s.selection).toEqual([id.hollow])
    r.drag(at(340, -2), at(360, 2))
    expect(r.s.selection).toEqual([id.s])
  })
})

/* -------------------------------------------------------------------- move --- */

describe('moving', () => {
  it('moves the selection by exactly the drag when nothing snaps, as one history step', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100))
    const r = new Rig(doc)
    r.drag(at(0, 0), at(40, 30))
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 40, y: 30 })
    expect(r.s.undoLabel).toBe('Move')
    r.c.exec('edit.undo')
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 0, y: 0 })
    expect(r.s.canUndo).toBe(false)
    r.c.exec('edit.redo')
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 40, y: 30 })
  })

  it('updates the live board during the drag without a history step until the pointer lifts', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100))
    const r = new Rig(doc)
    r.down(at(0, 0))
    r.move(at(10, 0))
    r.move(at(20, 0))
    expect(r.item<PictureItem>(id.a).x).toBe(20)
    expect(r.s.canUndo).toBe(false)
    expect(r.s.moving).toBe(true)
    expect(r.s.dirty).toBe(true)
    r.up(at(20, 0))
    expect(r.s.canUndo).toBe(true)
    expect(r.s.moving).toBe(false)
  })

  it('does not move until the pointer has gone 3 pixels, then moves from the press, not from where it started moving', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100))
    const r = new Rig(doc)
    r.down(at(0, 0))
    r.move(at(2, 0))
    expect(r.item<PictureItem>(id.a).x).toBe(0)
    r.move(at(4, 0))
    expect(r.item<PictureItem>(id.a).x).toBe(4)
    r.up(at(4, 0))
  })

  it('divides the drag by the zoom', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100))
    const r = new Rig(doc)
    r.c.setView({ x: 0, y: 0, zoom: 2 })
    r.drag({ x: 500, y: 400 }, { x: 560, y: 440 })
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 30, y: 20 })
  })

  it('holds a shift-drag to the dominant axis', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100))
    const r = new Rig(doc)
    r.drag(at(0, 0), at(80, 30), { shift: true })
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 80, y: 0 })
    r.drag(at(80, 0), at(90, 130), { shift: true })
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 80, y: 130 })
  })

  it('shift can be pressed and let go during the drag', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100))
    const r = new Rig(doc)
    r.down(at(0, 0))
    r.move(at(60, 20), { shift: true })
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 60, y: 0 })
    r.move(at(60, 20))
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 60, y: 20 })
    r.up(at(60, 20))
  })

  it('snaps to the edges and centres of other items and shows the guides, and not with Alt', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100).pic('b', 400, 300, 200, 100))
    const r = new Rig(doc)
    r.click(at(0, 0))
    // b's top edge is y = 250; a's bottom edge (y + 50) is 4 units away from the line a's top meets at y = 296... use b's top: move a so its bottom is near 250.
    r.down(at(0, 0))
    r.move(at(0, 203)) // bottom edge at 253: within 6 of 250
    expect(r.item<PictureItem>(id.a).y).toBeCloseTo(200, 9)
    expect(r.s.guides.h).toContain(250)
    r.up(at(0, 203))
    expect(r.s.guides).toEqual({ v: [], h: [] })
    r.c.exec('edit.undo')
    r.down(at(0, 0))
    r.move(at(0, 203), { alt: true })
    expect(r.item<PictureItem>(id.a).y).toBeCloseTo(203, 9)
    expect(r.s.guides).toEqual({ v: [], h: [] })
    r.up(at(0, 203), { alt: true })
    expect(id.b).toBeGreaterThan(0)
  })

  it('snaps the top left corner to the grid when there is one, and not with Alt', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100), { ...emptyBoard('g'), grid: 16 })
    const r = new Rig(doc)
    r.drag(at(0, 0), at(21, 9))
    // Moved by (21, 9): the top left corner (-100+21, -50+9) = (-79, -41) goes to the nearest multiples of 16: (-80, -48).
    const a = r.item<PictureItem>(id.a)
    expect(a.x - 100).toBeCloseTo(-80, 9)
    expect(a.y - 50).toBeCloseTo(-48, 9)
    r.c.exec('edit.undo')
    r.drag(at(0, 0), at(21, 9), { alt: true })
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 21, y: 9 })
  })

  it('moves a whole group when one member is dragged', () => {
    const { doc, id } = build((b) => b.pic('a', -300, 0, 100, 100).pic('b', 300, 0, 100, 100).group('a', 'b'))
    const r = new Rig(doc)
    r.drag(at(-300, 0), at(-250, 20))
    expect(r.s.selection).toEqual([id.a, id.b])
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: -250, y: 20 })
    expect(r.item<PictureItem>(id.b)).toMatchObject({ x: 350, y: 20 })
    expect(r.c.state.canUndo).toBe(true)
    r.c.exec('edit.undo')
    expect(r.item<PictureItem>(id.b)).toMatchObject({ x: 300, y: 0 })
  })

  it('moves marks and notes with the pictures', () => {
    const { doc, id } = build((b) => b.stroke('s', [0, 0, 100, 0, 100, 100], 6).note('n', 300, 0, 200, 'x').line('l', 0, 300, 100, 300))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.drag(at(50, 0), at(60, 25))
    expect((r.item(id.s) as StrokeItem).points).toEqual([10, 25, 110, 25, 110, 125])
    expect(r.item<NoteItem>(id.n)).toMatchObject({ x: 310, y: 25 })
    expect(r.item(id.l)).toMatchObject({ x1: 10, y1: 325, x2: 110, y2: 325 })
  })

  it('a cancelled drag (Esc) puts the board back and the pointer is ignored until it lifts', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100))
    const r = new Rig(doc)
    r.down(at(0, 0))
    r.move(at(50, 50))
    expect(r.item<PictureItem>(id.a).x).toBe(50)
    expect(r.key('Escape')).toBe(true)
    expect(r.doc.items).toBe(doc.items)
    expect(r.s.canUndo).toBe(false)
    r.move(at(80, 80))
    expect(r.item<PictureItem>(id.a).x).toBe(0)
    r.up(at(80, 80))
    expect(r.s.canUndo).toBe(false)
    // The next press works as usual.
    r.drag(at(0, 0), at(10, 0))
    expect(r.item<PictureItem>(id.a).x).toBe(10)
  })

  it('pointerCancel undoes the drag', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100))
    const r = new Rig(doc)
    r.down(at(0, 0))
    r.move(at(50, 50))
    r.cancel(at(50, 50))
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 0, y: 0 })
    expect(r.s.canUndo).toBe(false)
    expect(r.s.dirty).toBe(false)
    // The save that may have happened mid-drag is followed by one of the restored board.
    const last = r.changes[r.changes.length - 1]!
    expect(last.why).toMatchObject({ reason: 'cancel', final: true })
    expect(last.doc.items).toBe(doc.items)
  })

  it('a pan or zoom during a drag does not carry the camera back to where the drag began', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100))
    const r = new Rig(doc)
    r.down(at(0, 0))
    r.move(at(20, 0))
    r.wheel(500, 400, -100)
    const zoomed = r.doc.view.zoom
    expect(zoomed).toBeGreaterThan(1)
    r.move({ x: 540, y: 400 })
    expect(r.doc.view.zoom).toBe(zoomed)
    r.up({ x: 540, y: 400 })
    expect(r.doc.view.zoom).toBe(zoomed)
    // 40 pixels at the new zoom, from the press at board (0, 0).
    expect(r.item<PictureItem>(id.a).x).toBeCloseTo(40 / zoomed, 6)
  })

  it('keeps items inside the coordinate limit', () => {
    const { doc, id } = build((b) => b.pic('a', 999_900, 0, 100, 100))
    const r = new Rig(doc)
    r.c.setView({ x: 999_900, y: 0, zoom: 1 })
    r.drag({ x: 500, y: 400 }, { x: 900, y: 400 })
    expect(r.item<PictureItem>(id.a).x).toBe(1_000_000)
  })
})

/* --------------------------------------------------------------- locked --- */

describe('locked items', () => {
  it('can be selected and are not moved, with one message', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100).lock('a'))
    const r = new Rig(doc)
    r.click(at(0, 0))
    expect(r.s.selection).toEqual([id.a])
    r.drag(at(0, 0), at(50, 50))
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 0, y: 0 })
    expect(r.s.canUndo).toBe(false)
    expect(r.toasts('locked')).toHaveLength(1)
  })

  it('a drag that moves nothing tells the savers nothing', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 200, 100).lock('a'))
    const r = new Rig(doc)
    r.click(at(0, 0))
    r.forget()
    r.drag(at(0, 0), at(50, 50), {}, 6)
    expect(r.changes).toHaveLength(0)
  })

  it('stay while the free items of a mixed selection move', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100).pic('b', 300, 0, 100, 100).lock('a'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.drag(at(300, 0), at(320, 10))
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 0, y: 0 })
    expect(r.item<PictureItem>(id.b)).toMatchObject({ x: 320, y: 10 })
    expect(r.toasts('locked')).toHaveLength(0)
  })

  it('refuse the scale and rotate handles', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100).lock('a'))
    const r = new Rig(doc)
    r.click(at(0, 0))
    r.drag(at(100, 50), at(200, 100))
    r.drag(at(0, -50 - ROTATE_HANDLE_PX), at(100, -50 - ROTATE_HANDLE_PX))
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 0, y: 0, w: 200, h: 100, rotation: 0 })
    expect(r.toasts('locked').length).toBeGreaterThan(0)
    expect(r.s.canUndo).toBe(false)
  })
})

/* ----------------------------------------------------------- right click --- */

describe('right click', () => {
  it('selects the item under it when it is not selected, and starts nothing', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(100, -100), { button: 2 })
    expect(r.s.selection).toEqual([id.b])
    r.down(at(-300, -100), { button: 2 })
    r.move(at(-250, -50), { button: 2 })
    r.up(at(-250, -50), { button: 2 })
    expect(r.s.selection).toEqual([id.a])
    expect(r.item<PictureItem>(id.a).x).toBe(-300)
    expect(r.s.marquee).toBeNull()
    expect(r.s.canUndo).toBe(false)
  })

  it('leaves the selection alone when the item is already in it, and on the empty canvas', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.click(at(100, -100), { button: 2 })
    expect(r.s.selection).toEqual([id.a, id.b, id.n])
    r.click(at(0, 600), { button: 2 })
    expect(r.s.selection).toEqual([id.a, id.b, id.n])
  })
})

/* ------------------------------------------------------------ double click --- */

describe('double click', () => {
  it('on a note edits it', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.dblclick(at(0, 250))
    expect(r.s.editingNote).toBe(id.n)
    expect(r.s.selection).toEqual([id.n])
  })

  it('on a picture fits it in the view', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.dblclick(at(100, -100))
    expect(r.s.selection).toEqual([id.b])
    const v = r.doc.view
    expect(v.x).toBeCloseTo(100, 9)
    expect(v.y).toBeCloseTo(-100, 9)
    // 200 by 100 in a 1000 by 800 canvas with a 48 px margin: the width decides.
    expect(v.zoom).toBeCloseTo((1000 - 96) / 200, 9)
    expect(r.s.canUndo).toBe(false)
  })

  it('on the empty canvas makes a note there and edits it', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.dblclick(at(300, 500))
    const id = r.s.editingNote
    expect(id).not.toBeNull()
    const n = r.item<NoteItem>(id!)
    expect(n.kind).toBe('note')
    expect(n.text).toBe('')
    // The note's top left corner is at the double click.
    expect(n.x - n.w / 2).toBeCloseTo(300, 9)
    expect(itemBounds(n, M).y).toBeCloseTo(500, 9)
    expect(r.s.selection).toEqual([id])
    expect(r.s.canUndo).toBe(false)
  })

  it('needs the second press within 350 ms and 6 pixels of the first', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.down(at(300, 500), { time: 1000 })
    r.up(at(300, 500), { time: 1020 })
    r.down(at(300, 500), { time: 1351 })
    r.up(at(300, 500), { time: 1360 })
    expect(r.s.editingNote).toBeNull()
    r.down(at(300, 500), { time: 5000 })
    r.up(at(300, 500), { time: 5010 })
    r.down(at(307, 500), { time: 5100 })
    r.up(at(307, 500), { time: 5110 })
    expect(r.s.editingNote).toBeNull()
    r.down(at(300, 500), { time: 9000 })
    r.up(at(300, 500), { time: 9010 })
    r.down(at(305, 500), { time: 9349 })
    expect(r.s.editingNote).not.toBeNull()
  })

  it('a drag in between is not a click, and a third press starts over', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.down(at(300, 500), { time: 1000 })
    r.move(at(340, 500), { time: 1010 })
    r.up(at(340, 500), { time: 1020 })
    r.down(at(340, 500), { time: 1100 })
    r.up(at(340, 500), { time: 1110 })
    expect(r.s.editingNote).toBeNull()
    r.down(at(340, 500), { time: 1200 })
    r.up(at(340, 500), { time: 1210 })
    expect(r.s.editingNote).not.toBeNull()
    r.c.cancelNoteEdit()
    r.down(at(340, 500), { time: 1300 })
    r.up(at(340, 500), { time: 1310 })
    expect(r.s.editingNote).toBeNull()
  })

  it('a locked note is refused', () => {
    const { doc } = build((b) => b.note('n', 0, 0, 200, 'x').lock('n'))
    const r = new Rig(doc)
    r.dblclick(at(0, 0))
    expect(r.s.editingNote).toBeNull()
    expect(r.toasts('locked')).toHaveLength(1)
  })

  it('does nothing special in other tools', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('tool.hand')
    r.dblclick(at(300, 500))
    expect(r.s.editingNote).toBeNull()
  })
})

/* ----------------------------------------------------------------- scale --- */

/** The four corners of a picture's shown box, as [x, y] pairs. */
function corners(r: Rig, id: number): [number, number][] {
  return itemQuad(r.item(id), M).map((p) => [p.x, p.y])
}

describe('scaling with the handles', () => {
  const rigFor = () => {
    const b = build((x) => x.pic('a', 0, 0, 200, 100))
    return { r: new Rig(b.doc), id: b.id.a! }
  }

  it('shows a box with the rotate handle 28 pixels above the top edge, at every zoom', () => {
    const { r, id } = rigFor()
    r.click(at(0, 0))
    expect(r.s.box).not.toBeNull()
    expect(r.s.box!.corners.map((p) => [p.x, p.y])).toEqual([
      [-100, -50],
      [100, -50],
      [100, 50],
      [-100, 50],
    ])
    expect(ROTATE_HANDLE_PX).toBe(28)
    expect(r.s.box!.rotateHandle).toEqual({ x: 0, y: -50 - 28 })
    r.c.setView({ x: 0, y: 0, zoom: 4 })
    expect(r.s.box!.rotateHandle!.y).toBeCloseTo(-50 - 28 / 4, 9)
    expect(id).toBeGreaterThan(0)
  })

  it('has no box when nothing is selected', () => {
    const { r } = rigFor()
    expect(r.s.box).toBeNull()
  })

  it('a corner scales uniformly about the opposite corner (from each of the four)', () => {
    // (handle at, anchor): the handle is dragged to 1.5 times its distance from the anchor.
    const cases: [string, [number, number], [number, number]][] = [
      ['se', [100, 50], [-100, -50]],
      ['nw', [-100, -50], [100, 50]],
      ['ne', [100, -50], [-100, 50]],
      ['sw', [-100, 50], [100, -50]],
    ]
    for (const [name, h, a] of cases) {
      const { r, id } = rigFor()
      r.click(at(0, 0))
      const to = { x: a[0] + (h[0] - a[0]) * 1.5, y: a[1] + (h[1] - a[1]) * 1.5 }
      r.drag(at(h[0], h[1]), at(to.x, to.y))
      const p = r.item<PictureItem>(id)
      expect(p.w, name).toBeCloseTo(300, 9)
      expect(p.h, name).toBeCloseTo(150, 9)
      // The anchor corner has not moved.
      const q = corners(r, id)
      const fixed = q.find((c) => Math.abs(c[0]! - a[0]) < 1e-9 && Math.abs(c[1]! - a[1]) < 1e-9)
      expect(fixed, name).toBeDefined()
      expect(r.s.undoLabel).toBe('Scale')
    }
  })

  it('keeps the aspect whatever the pointer does off the diagonal', () => {
    const { r, id } = rigFor()
    r.click(at(0, 0))
    r.drag(at(100, 50), at(400, 70))
    const p = r.item<PictureItem>(id)
    expect(p.w / p.h).toBeCloseTo(2, 9)
  })

  it('with Alt scales about the centre', () => {
    const { r, id } = rigFor()
    r.click(at(0, 0))
    r.drag(at(100, 50), at(150, 75), { alt: true })
    const p = r.item<PictureItem>(id)
    expect(p).toMatchObject({ x: 0, y: 0 })
    expect(p.w).toBeCloseTo(300, 9)
    expect(p.h).toBeCloseTo(150, 9)
  })

  it('shrinks, and stops at the smallest size instead of flipping when dragged past the anchor', () => {
    const { r, id } = rigFor()
    r.click(at(0, 0))
    r.drag(at(100, 50), at(-300, -200))
    const p = r.item<PictureItem>(id)
    expect(Math.min(p.w, p.h)).toBeGreaterThanOrEqual(8 - 1e-9)
    expect(p.w / p.h).toBeCloseTo(2, 6)
    expect(p.w).toBeGreaterThan(0)
  })

  it('an edge handle scales uniformly about the middle of the opposite edge', () => {
    const { r, id } = rigFor()
    r.click(at(0, 0))
    // Drag the right edge's handle from x = 100 to x = 300: the width doubles about the left edge.
    r.drag(at(100, 0), at(300, 0))
    const p = r.item<PictureItem>(id)
    expect(p.w).toBeCloseTo(400, 9)
    expect(p.h).toBeCloseTo(200, 9)
    const left = Math.min(...corners(r, id).map((c) => c[0]!))
    expect(left).toBeCloseTo(-100, 9)
    // Centred vertically on the old middle line, since the left edge's middle was the anchor.
    expect(p.y).toBeCloseTo(0, 9)
  })

  it('scales a rotated picture uniformly: aspect kept, the opposite corner fixed', () => {
    const b = build((x) => x.pic('a', 0, 0, 200, 100, { rotation: 30 }))
    const r = new Rig(b.doc)
    const id = b.id.a!
    r.click(at(0, 0))
    const q = r.s.box!.corners
    const se = q[2]!
    const nw = q[0]!
    const to = { x: nw.x + (se.x - nw.x) * 2, y: nw.y + (se.y - nw.y) * 2 }
    r.drag(at(se.x, se.y), at(to.x, to.y))
    const p = r.item<PictureItem>(id)
    expect(p.w).toBeCloseTo(400, 6)
    expect(p.h).toBeCloseTo(200, 6)
    expect(p.rotation).toBeCloseTo(30, 9)
    const nw2 = itemQuad(p, M)[0]!
    expect(nw2.x).toBeCloseTo(nw.x, 6)
    expect(nw2.y).toBeCloseTo(nw.y, 6)
  })

  it('a rotated picture keeps its aspect when the pointer strays sideways', () => {
    const b = build((x) => x.pic('a', 0, 0, 300, 100, { rotation: -50 }))
    const r = new Rig(b.doc)
    r.click(at(0, 0))
    const se = r.s.box!.corners[2]!
    r.drag(at(se.x, se.y), at(se.x + 240, se.y - 10))
    const p = r.item<PictureItem>(b.id.a!)
    expect(p.w / p.h).toBeCloseTo(3, 6)
  })

  it('scales a multi-selection about the box corner opposite the handle', () => {
    const b = build((x) => x.pic('a', -100, 0, 100, 100).pic('b', 100, 0, 100, 100))
    const r = new Rig(b.doc)
    r.c.exec('edit.selectAll')
    // The box spans x -150..150, y -50..50. Drag its bottom right corner (150, 50) to (450, 150): factor 2 about (-150, -50).
    r.drag(at(150, 50), at(450, 150))
    const a = r.item<PictureItem>(b.id.a!)
    const c = r.item<PictureItem>(b.id.b!)
    expect(a).toMatchObject({ w: 200, h: 200 })
    expect(a.x).toBeCloseTo(-50, 9)
    expect(a.y).toBeCloseTo(50, 9)
    expect(c.x).toBeCloseTo(350, 9)
    expect(c.y).toBeCloseTo(50, 9)
  })

  it('scales strokes and shapes with their line width', () => {
    const b = build((x) => x.rect('r', 0, 0, 100, 100, '', 4).stroke('s', [200, 0, 300, 100], 6))
    const r = new Rig(b.doc)
    r.c.exec('edit.selectAll')
    // The box (with half the line width round it) spans -2..303 by -2..102; take its far corner to twice the distance from the near one.
    const box = r.s.box!
    const br = box.corners[2]!
    const tl = box.corners[0]!
    r.drag(at(br.x, br.y), at(tl.x + (br.x - tl.x) * 2, tl.y + (br.y - tl.y) * 2))
    const rect = r.item(b.id.r!) as { x2: number; width: number }
    expect(rect.width).toBeCloseTo(8, 6)
    expect(rect.x2).toBeCloseTo(-2 + (100 + 2) * 2, 6)
  })

  it('on a lone note the side handles change its width and the text reflows; the corners scale it', () => {
    const b = build((x) => x.note('n', 0, 0, 200, 'one two three four five six seven eight nine ten', { size: 20 }))
    const r = new Rig(b.doc)
    r.click(at(0, 0))
    const before = r.item<NoteItem>(b.id.n!)
    const box = r.s.box!
    const e = { x: (box.corners[1]!.x + box.corners[2]!.x) / 2, y: (box.corners[1]!.y + box.corners[2]!.y) / 2 }
    r.drag(at(e.x, e.y), at(e.x + 100, e.y))
    const wide = r.item<NoteItem>(b.id.n!)
    expect(wide.w).toBeCloseTo(300, 9)
    expect(wide.size).toBe(before.size)
    // The left edge stays where it was.
    expect(wide.x - wide.w / 2).toBeCloseTo(before.x - before.w / 2, 9)
    expect(r.s.undoLabel).toBe('Resize note')
    // The left side handle: the right edge stays.
    const box2 = r.s.box!
    const w = { x: (box2.corners[0]!.x + box2.corners[3]!.x) / 2, y: (box2.corners[0]!.y + box2.corners[3]!.y) / 2 }
    r.drag(at(w.x, w.y), at(w.x + 100, w.y))
    const narrow = r.item<NoteItem>(b.id.n!)
    expect(narrow.w).toBeCloseTo(200, 9)
    expect(narrow.x + narrow.w / 2).toBeCloseTo(wide.x + wide.w / 2, 9)
    // A corner scales the size too.
    const box3 = r.s.box!
    const c = box3.corners[2]!
    const a = box3.corners[0]!
    r.drag(at(c.x, c.y), at(a.x + (c.x - a.x) * 2, a.y + (c.y - a.y) * 2))
    const big = r.item<NoteItem>(b.id.n!)
    expect(big.size).toBeCloseTo(40, 6)
    expect(big.w).toBeCloseTo(400, 6)
  })

  it('a finger can be a little further from a handle than a mouse', () => {
    const { r, id } = rigFor()
    r.click(at(0, 0))
    // 12 pixels beyond the right edge: out of reach for a mouse, in reach of a finger.
    r.drag(at(112, 0), at(212, 0))
    expect(r.item<PictureItem>(id).w).toBe(200)
    expect(r.s.selection).toEqual([])
    r.click(at(0, 0))
    r.drag(at(112, 0), at(312, 0), { pointerType: 'touch' })
    // The handle moved 200 with the finger, however far from it the finger first landed.
    expect(r.item<PictureItem>(id).w).toBeCloseTo(400, 9)
  })

  it('a press a little off a handle does not make the picture jump: it follows the pointer from where it was grabbed', () => {
    const { r, id } = rigFor()
    r.click(at(0, 0))
    r.down(at(105, 4))
    r.move(at(105, 4))
    expect(r.item<PictureItem>(id).w).toBeCloseTo(200, 9)
    r.move(at(125, 4))
    // The side handle moved 20 with the pointer, and the picture grew by the same 20 across.
    expect(r.item<PictureItem>(id).w).toBeCloseTo(220, 9)
    r.up(at(125, 4))
    // The same for a side handle of a note and for a rotated picture.
    const b = build((x) => x.pic('a', 0, 0, 200, 100, { rotation: 30 }))
    const q = new Rig(b.doc)
    q.click(at(0, 0))
    const se = q.s.box!.corners[2]!
    const nw = q.s.box!.corners[0]!
    const dir = { x: (se.x - nw.x) / Math.hypot(se.x - nw.x, se.y - nw.y), y: (se.y - nw.y) / Math.hypot(se.x - nw.x, se.y - nw.y) }
    q.down(at(se.x + 3, se.y - 4))
    q.move(at(se.x + 3 + dir.x * 50, se.y - 4 + dir.y * 50))
    // The diagonal of 223.6 grew by 50.
    expect(q.item<PictureItem>(b.id.a).w).toBeCloseTo(200 * (1 + 50 / Math.hypot(200, 100)), 6)
  })

  it('a note side handle follows the pointer from where it was grabbed', () => {
    const b = build((x) => x.note('n', 0, 0, 200, 'one two three four', { size: 20 }))
    const r = new Rig(b.doc)
    r.click(at(0, 0))
    const box = r.s.box!
    const e = { x: (box.corners[1]!.x + box.corners[2]!.x) / 2, y: (box.corners[1]!.y + box.corners[2]!.y) / 2 }
    r.down(at(e.x + 4, e.y + 2))
    r.move(at(e.x + 4, e.y + 2))
    expect(r.item<NoteItem>(b.id.n).w).toBeCloseTo(200, 9)
    r.move(at(e.x + 4 + 60, e.y + 2))
    expect(r.item<NoteItem>(b.id.n).w).toBeCloseTo(260, 9)
    r.up(at(e.x + 4 + 60, e.y + 2))
  })

  it('moving the pointer back to where it was grabbed puts the size back', () => {
    const { r, id } = rigFor()
    r.click(at(0, 0))
    r.down(at(103, 52))
    r.move(at(160, 90))
    expect(r.item<PictureItem>(id).w).toBeGreaterThan(250)
    r.move(at(103, 52))
    expect(r.item<PictureItem>(id).w).toBeCloseTo(200, 9)
    r.up(at(103, 52))
  })

  it('a click on a handle without a drag changes nothing', () => {
    const { r, id } = rigFor()
    r.click(at(0, 0))
    const before = r.doc.items
    r.click(at(100, 50))
    expect(r.doc.items).toBe(before)
    expect(r.s.canUndo).toBe(false)
    expect(r.s.selection).toEqual([id])
  })

  it('the handles of a tiny box are still reachable (nearest wins)', () => {
    const b = build((x) => x.pic('a', 0, 0, 10, 10))
    const r = new Rig(b.doc)
    r.click(at(0, 0))
    r.drag(at(5, 5), at(25, 25))
    expect(r.item<PictureItem>(b.id.a!).w).toBeGreaterThan(10)
  })
})

/* ---------------------------------------------------------------- rotate --- */

describe('rotating with the handle', () => {
  const rigFor = (extra = {}) => {
    const b = build((x) => x.pic('a', 0, 0, 200, 100, extra))
    return { r: new Rig(b.doc), id: b.id.a! }
  }
  const handle = { x: 0, y: -50 - ROTATE_HANDLE_PX }

  it('turns about the centre by the angle the pointer sweeps', () => {
    const { r, id } = rigFor()
    r.click(at(0, 0))
    // From straight above to straight right of the centre: a quarter turn clockwise.
    r.drag(at(handle.x, handle.y), at(200, 0), {}, 6)
    const p = r.item<PictureItem>(id)
    expect(p.rotation).toBeCloseTo(90, 9)
    expect(p).toMatchObject({ x: 0, y: 0 })
    expect(r.s.undoLabel).toBe('Rotate')
    r.c.exec('edit.undo')
    expect(r.item<PictureItem>(id).rotation).toBe(0)
  })

  it('turns anticlockwise and past a half turn without jumping', () => {
    const { r, id } = rigFor()
    r.click(at(0, 0))
    r.down(at(handle.x, handle.y))
    // Anticlockwise a quarter, then on round to three quarters.
    r.move(at(-200, 0))
    expect(r.item<PictureItem>(id).rotation).toBeCloseTo(-90, 9)
    r.move(at(0, 200))
    // Half a turn either way is 180 (angles are kept in (-180, 180]).
    expect(r.item<PictureItem>(id).rotation).toBeCloseTo(180, 9)
    r.move(at(200, 0))
    expect(r.item<PictureItem>(id).rotation).toBeCloseTo(90, 9)
    r.up(at(200, 0))
  })

  it('without shift lands on whatever angle the pointer has', () => {
    const { r, id } = rigFor()
    r.click(at(0, 0))
    const a = (37 * Math.PI) / 180
    r.drag(at(handle.x, handle.y), at(200 * Math.sin(a), -200 * Math.cos(a)))
    expect(r.item<PictureItem>(id).rotation).toBeCloseTo(37, 6)
  })

  it('with shift lands on a multiple of 15 degrees', () => {
    const { r, id } = rigFor()
    r.click(at(0, 0))
    const a = (37 * Math.PI) / 180
    r.drag(at(handle.x, handle.y), at(200 * Math.sin(a), -200 * Math.cos(a)), { shift: true })
    expect(r.item<PictureItem>(id).rotation).toBeCloseTo(30, 9)
    const b = (44 * Math.PI) / 180
    r.drag(at(handle.x, handle.y), at(200 * Math.sin(b), -200 * Math.cos(b)), { shift: true })
    expect(Math.abs(r.item<PictureItem>(id).rotation % 15)).toBeCloseTo(0, 9)
  })

  it('with shift a picture that is already tilted snaps its own angle, not the turn', () => {
    const { r, id } = rigFor({ rotation: 7 })
    r.click(at(0, 0))
    const h = r.s.box!.rotateHandle!
    const a = (7 + 20) * (Math.PI / 180)
    // A 20 degree turn would give 27; snapped, the picture lands on 30.
    r.drag(at(h.x, h.y), at(300 * Math.sin(a), -300 * Math.cos(a)), { shift: true })
    expect(r.item<PictureItem>(id).rotation).toBeCloseTo(30, 9)
  })

  it('turns a multi-selection about the middle of its box, each item by the same angle', () => {
    const b = build((x) => x.pic('a', -200, 0, 100, 100).pic('b', 200, 0, 100, 100))
    const r = new Rig(b.doc)
    r.c.exec('edit.selectAll')
    const h = r.s.box!.rotateHandle!
    expect(h.x).toBeCloseTo(0, 9)
    // Quarter turn clockwise about (0, 0): a goes from (-200, 0) to (0, -200), b from (200, 0) to (0, 200).
    r.drag(at(h.x, h.y), at(300, 0), {}, 5)
    const a = r.item<PictureItem>(b.id.a!)
    const c = r.item<PictureItem>(b.id.b!)
    expect(a.rotation).toBeCloseTo(90, 9)
    expect(c.rotation).toBeCloseTo(90, 9)
    expect(a.x).toBeCloseTo(0, 6)
    expect(a.y).toBeCloseTo(-200, 6)
    expect(c.x).toBeCloseTo(0, 6)
    expect(c.y).toBeCloseTo(200, 6)
  })

  it('has no rotate handle for a lone rectangle', () => {
    const b = build((x) => x.rect('r', 0, 0, 100, 100))
    const r = new Rig(b.doc)
    r.click(at(50, 0))
    expect(r.s.selection).toEqual([b.id.r])
    expect(r.s.box!.rotateHandle).toBeNull()
  })

  it('a tilted picture has a tilted box and its handle is out along its own up', () => {
    const { r } = rigFor({ rotation: 90 })
    r.click(at(0, 0))
    const box = r.s.box!
    expect(box.rotation).toBe(90)
    // Turned a quarter clockwise, the picture's top edge faces right: the handle is to the right of it.
    expect(box.rotateHandle!.x).toBeCloseTo(50 + ROTATE_HANDLE_PX, 9)
    expect(box.rotateHandle!.y).toBeCloseTo(0, 9)
  })
})

describe('the state', () => {
  it('is a new object whenever something changed and the same one when nothing did', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    const s0 = r.s
    expect(r.s).toBe(s0)
    r.click(at(-300, -100))
    const s1 = r.s
    expect(s1).not.toBe(s0)
    expect(r.s).toBe(s1)
    expect(s0.selection).toEqual([])
    expect(s1.selection).not.toBe(s0.selection)
  })

  it('subscribers hear every change, once per call', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.forget()
    r.c.exec('edit.selectAll')
    expect(r.states).toHaveLength(1)
    expect(r.states[0]).toBe(r.s)
    r.c.exec('edit.selectAll')
    expect(r.states).toHaveLength(1)
  })

  it('unsubscribing stops the calls', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    let n = 0
    const off = r.c.subscribe(() => n++)
    r.c.exec('edit.selectAll')
    expect(n).toBe(1)
    off()
    r.c.exec('edit.selectNone')
    expect(n).toBe(1)
  })

  it('one listener that throws does not stop the others, and the error is rethrown after', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    let heard = 0
    r.c.subscribe(() => {
      throw new Error('boom')
    })
    r.c.subscribe(() => heard++)
    expect(() => r.c.exec('edit.selectAll')).toThrow('boom')
    expect(heard).toBe(1)
    // The controller still works.
    expect(() => r.c.exec('edit.selectNone')).toThrow('boom')
    expect(r.s.selection).toEqual([])
  })

  it('viewport changes are in the state', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.setViewport(640, 480)
    expect(r.s.viewport).toEqual({ w: 640, h: 480 })
    r.c.setViewport(0, 480)
    r.c.setViewport(NaN, 5)
    expect(r.s.viewport).toEqual({ w: 640, h: 480 })
  })

  it('withoutView of a doc leaves everything else', () => {
    const { doc } = threeThings()
    expect(withoutView(doc)).not.toHaveProperty('view')
  })
})
