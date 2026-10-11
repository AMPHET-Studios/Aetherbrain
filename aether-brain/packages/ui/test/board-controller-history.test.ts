import { describe, expect, it } from 'vitest'
import {
  BOARD_LIMITS,
  addMark,
  emptyBoard,
  estimateTextMetrics,
  itemBounds,
  itemQuad,
  type BoardDoc,
  type NoteItem,
  type PictureItem,
} from '@aether/core'
import { BoardController } from '../src/board/controller'
import { Rig, VIEWPORT, assertSane, at, build, threeThings, withoutView } from './board-controller-harness'

const M = estimateTextMetrics
const pic = (r: Rig, id: number) => r.item<PictureItem>(id)

/* ------------------------------------------------------------ undo and redo --- */

describe('undo and redo', () => {
  /** A long script of edits of every kind, with the board after each. */
  function script() {
    const b = build((x) => x.pic('a', -300, -100, 200, 100).pic('b', 100, -100, 200, 100).note('n', 0, 250, 240, 'hello').stroke('s', [0, 400, 100, 400], 6))
    const r = new Rig(b.doc)
    const steps: { name: string; doc: BoardDoc }[] = []
    const mark = (name: string): void => {
      // Every mark is a step of its own: the board really changed.
      const last = steps.length > 0 ? steps[steps.length - 1]!.doc : b.doc
      expect(withoutView(r.doc), `${name} changed nothing`).not.toEqual(withoutView(last))
      steps.push({ name, doc: r.doc })
      r.clock += 5000
    }
    r.drag(at(-300, -100), at(-250, -60))
    mark('move')
    r.drag(at(-150, 0 - 10), at(-100, 20)) // the se handle of a (box right/bottom at x -150, y -10)
    mark('scale')
    r.c.exec('edit.selectNone')
    r.click(at(100, -100))
    const top = r.s.box!.rotateHandle!
    r.drag(at(top.x, top.y), at(300, -100), {}, 5)
    mark('rotate')
    r.c.exec('transform.flipH')
    mark('flip')
    r.c.exec('tool.crop')
    const q = r.s.cropping
    expect(q).not.toBeNull()
    // The picture is turned, so the handle on its own right side is found from its corners.
    const quad = itemQuad(pic(r, b.id.b!), M)
    const e = { x: (quad[1].x + quad[2].x) / 2, y: (quad[1].y + quad[2].y) / 2 }
    const inward = { x: (quad[0].x - quad[1].x) / 200, y: (quad[0].y - quad[1].y) / 200 }
    r.drag(at(e.x, e.y), at(e.x + inward.x * 30, e.y + inward.y * 30))
    mark('crop')
    r.c.exec('tool.select')
    r.c.exec('tool.pen')
    r.drag(at(-400, 300), at(-300, 340))
    mark('draw')
    r.c.exec('tool.rect')
    r.drag(at(-400, 360), at(-300, 420))
    mark('rect')
    r.c.exec('tool.eraser')
    r.click(at(50, 400))
    mark('erase')
    r.c.exec('tool.select')
    r.c.exec('edit.selectAll')
    r.c.exec('edit.duplicate')
    mark('duplicate')
    r.c.exec('edit.copy')
    r.c.exec('edit.paste')
    mark('paste')
    r.c.exec('edit.group')
    mark('group')
    r.c.exec('edit.lock')
    mark('lock')
    r.c.exec('edit.unlock')
    mark('unlock')
    r.c.exec('edit.ungroup')
    mark('ungroup')
    r.c.exec('order.back')
    mark('order')
    r.c.exec('transform.rotateCw')
    mark('rotate90')
    r.c.exec('arrange.grid')
    mark('arrange')
    r.c.exec('align.top')
    mark('align')
    r.c.exec('view.background')
    mark('background')
    r.c.exec('view.gridSnap')
    mark('grid')
    r.c.exec('item.opacityDown')
    mark('opacity')
    r.c.exec('view.gray')
    mark('gray')
    r.c.exec('edit.delete')
    mark('delete')
    r.c.addPictures([{ path: 'new.png', w: 800, h: 600 }])
    mark('addPictures')
    r.c.addSwatches(['ff0000', '00ff00'], { x: 0, y: 0 })
    mark('swatches')
    const noteId = r.c.addNoteAt({ x: 0, y: 0 })
    r.c.commitNoteText(noteId, 'fresh note')
    mark('note')
    r.c.commitNoteText(noteId, 'edited note')
    mark('edit note')
    r.c.exec('edit.selectAll')
    r.c.setStyle({ noteColor: 'ffcc00' })
    mark('style')
    r.key('ArrowRight')
    mark('nudge')
    return { r, steps, initial: b.doc }
  }

  it('undoes every kind of edit one step at a time, back to the very first board', () => {
    const { r, steps, initial } = script()
    for (const s of steps) assertSane(s.doc)
    expect(steps.length).toBeGreaterThan(25)
    // The step the history holds for each is the board after it; go back through them.
    for (let i = steps.length - 2; i >= 0; i--) {
      r.c.exec('edit.undo')
      expect(withoutView(r.doc), `undo to after ${steps[i]!.name}`).toEqual(withoutView(steps[i]!.doc))
    }
    r.c.exec('edit.undo')
    expect(withoutView(r.doc)).toEqual(withoutView(initial))
    expect(r.s.canUndo).toBe(false)
    expect(r.s.dirty).toBe(false)
  })

  it('redoes them all again, to the last board', () => {
    const { r, steps } = script()
    for (let i = 0; i < steps.length; i++) r.c.exec('edit.undo')
    for (let i = 0; i < steps.length; i++) {
      r.c.exec('edit.redo')
      expect(withoutView(r.doc), steps[i]!.name).toEqual(withoutView(steps[i]!.doc))
    }
    expect(r.s.canRedo).toBe(false)
    // All the way forward is changed since the start.
    expect(r.s.dirty).toBe(true)
  })

  it('knows what each step was', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.drag(at(-300, -100), at(-250, -100))
    expect(r.s.undoLabel).toBe('Move')
    expect(r.s.redoLabel).toBeNull()
    r.c.exec('edit.undo')
    expect(r.s.undoLabel).toBeNull()
    expect(r.s.redoLabel).toBe('Move')
  })

  it('keeps the camera where the user left it', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.drag(at(-300, -100), at(-250, -100))
    r.c.setView({ x: 300, y: 200, zoom: 3 })
    r.c.exec('edit.undo')
    expect(r.doc.view).toEqual({ x: 300, y: 200, zoom: 3 })
    expect(pic(r, id.a).x).toBe(-300)
    r.c.setView({ x: -50, y: 0, zoom: 0.5 })
    r.c.exec('edit.redo')
    expect(r.doc.view).toEqual({ x: -50, y: 0, zoom: 0.5 })
    expect(pic(r, id.a).x).toBe(-250)
  })

  it('a pan alone is no step and does not clear the redo steps', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.drag(at(-300, -100), at(-250, -100))
    r.c.exec('edit.undo')
    r.drag(at(0, 500), at(40, 500), { button: 1 })
    r.wheel(500, 400, -100)
    expect(r.s.canRedo).toBe(true)
    expect(r.s.canUndo).toBe(false)
  })

  it('a new edit drops the redo steps', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.drag(at(-300, -100), at(-250, -100))
    r.c.exec('edit.undo')
    r.c.exec('view.gray')
    expect(r.s.canRedo).toBe(false)
  })

  it('keeps the selection by id: ids still on the board stay selected, ids that are gone drop out', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('view.gray')
    r.c.exec('edit.undo')
    expect(r.s.selection).toEqual([id.a, id.b, id.n])
    r.c.exec('edit.selectNone')
    r.click(at(-300, -100))
    r.c.exec('edit.duplicate')
    const copy = r.s.selection[0]!
    expect(copy).not.toBe(id.a)
    r.c.exec('edit.undo')
    expect(r.s.selection).toEqual([])
    r.c.exec('edit.selectAll')
    r.c.exec('edit.redo')
    // The copy is back, and the selection of the moment is still the three it was.
    expect(r.has(copy)).toBe(true)
    expect(r.s.selection).toEqual([id.a, id.b, id.n])
  })

  it('undo and redo with nothing to do are quiet', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.forget()
    r.c.exec('edit.undo')
    r.c.exec('edit.redo')
    expect(r.changes).toHaveLength(0)
    expect(r.states).toHaveLength(0)
    expect(r.s.doc).toBe(doc)
  })

  it('stops at the history limit', () => {
    const { doc } = threeThings()
    const r = new Rig(doc, { history: { limit: 3 } })
    for (let i = 0; i < 10; i++) r.c.exec('view.gray')
    let undone = 0
    while (r.s.canUndo) {
      r.c.exec('edit.undo')
      undone++
    }
    expect(undone).toBe(3)
  })

  it('an undo in the middle of a drag cancels the drag first', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('view.gray')
    r.down(at(-300, -100))
    r.move(at(-250, -100))
    r.c.exec('edit.undo')
    expect(pic(r, id.a).x).toBe(-300)
    expect(r.doc.gray).toBe(false)
    r.up(at(-250, -100))
    expect(r.s.canRedo).toBe(true)
    expect(pic(r, id.a).x).toBe(-300)
  })
})

/* -------------------------------------------------------------- onChange --- */

describe('onChange', () => {
  it('a drag reports its moves as not final and its end as final, with the live board', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100))
    const r = new Rig(doc)
    r.forget()
    r.down(at(0, 0))
    r.move(at(10, 0))
    r.move(at(20, 0))
    expect(r.changes.map((c) => [c.why.reason, c.why.final, c.why.viewOnly])).toEqual([
      ['move', false, false],
      ['move', false, false],
    ])
    expect((r.changes[1]!.doc.items[0] as PictureItem).x).toBe(20)
    r.up(at(20, 0))
    expect(r.changes).toHaveLength(3)
    expect(r.changes[2]!.why).toEqual({ reason: 'move', final: true, viewOnly: false })
    expect(r.changes[2]!.doc).toBe(r.doc)
    expect(id.a).toBe(1)
  })

  it('a one-shot command is final', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.forget()
    r.c.exec('edit.duplicate')
    r.c.exec('transform.flipH')
    r.c.exec('edit.undo')
    expect(r.changes.map((c) => c.why.final)).toEqual([true, true, true])
    expect(r.changes.map((c) => c.why.viewOnly)).toEqual([false, false, false])
    expect(r.changes[2]!.why.reason).toBe('undo')
  })

  it('says nothing about a selection, a tool or a hover', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.forget()
    r.click(at(-300, -100))
    r.c.exec('tool.pen')
    r.c.exec('tool.select')
    r.hover(at(5, 5))
    r.c.exec('edit.selectAll')
    r.drag(at(0, 600), at(30, 630))
    expect(r.changes).toHaveLength(0)
  })

  it('the typing of a new note is silent until its text is committed', () => {
    const r = new Rig(emptyBoard('t'))
    r.forget()
    const id = r.c.addNoteAt({ x: 0, y: 0 })
    expect(r.changes).toHaveLength(0)
    r.c.commitNoteText(id, 'x')
    expect(r.changes).toHaveLength(1)
    expect(r.changes[0]!.why).toMatchObject({ reason: 'note', final: true, viewOnly: false })
  })

  it('cancelling a drag reports the board as it is again', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.down(at(-300, -100))
    r.move(at(-200, -100))
    r.forget()
    r.key('Escape')
    expect(r.changes).toHaveLength(1)
    expect(r.changes[0]!.why).toEqual({ reason: 'cancel', final: true, viewOnly: false })
    expect(r.changes[0]!.doc.items).toBe(doc.items)
  })

  it('unsubscribing works', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    let n = 0
    const off = r.c.onChange(() => n++)
    r.c.exec('view.gray')
    off()
    r.c.exec('view.gray')
    expect(n).toBe(1)
  })

  it('a listener may call straight back in', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    let once = true
    r.c.onChange(() => {
      if (once) {
        once = false
        r.c.exec('edit.selectAll')
      }
    })
    r.c.exec('view.gray')
    expect(r.s.selection).toHaveLength(3)
  })
})

/* ------------------------------------------------------- dirty and saving --- */

describe('dirty and markSaved', () => {
  it('is clean at the start, dirty after an edit, clean again when saved', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    expect(r.s.dirty).toBe(false)
    r.c.exec('view.gray')
    expect(r.s.dirty).toBe(true)
    r.c.markSaved()
    expect(r.s.dirty).toBe(false)
  })

  it('follows the undo and redo past the saved step', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('view.gray')
    r.c.markSaved()
    r.c.exec('view.captions')
    expect(r.s.dirty).toBe(true)
    r.c.exec('edit.undo')
    expect(r.s.dirty).toBe(false)
    r.c.exec('edit.undo')
    expect(r.s.dirty).toBe(true)
    r.c.exec('edit.redo')
    expect(r.s.dirty).toBe(false)
  })

  it('a pan or zoom never makes it dirty', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.drag(at(0, 500), at(50, 520), { button: 1 })
    r.wheel(500, 400, -100)
    r.c.exec('view.fitAll')
    r.c.setView({ x: 3, y: 4, zoom: 2 })
    expect(r.s.dirty).toBe(false)
  })

  it('a drag in progress is dirty, and clean again if cancelled', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.down(at(-300, -100))
    r.move(at(-200, -100))
    expect(r.s.dirty).toBe(true)
    r.key('Escape')
    expect(r.s.dirty).toBe(false)
    r.up(at(-200, -100))
  })

  it('saving in the middle of a drag leaves it dirty', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.down(at(-300, -100))
    r.move(at(-200, -100))
    r.c.markSaved()
    expect(r.s.dirty).toBe(true)
    r.up(at(-200, -100))
    expect(r.s.dirty).toBe(true)
  })
})

/* ------------------------------------------------------------ replaceDoc --- */

describe('replaceDoc', () => {
  const change = (doc: BoardDoc): BoardDoc => ({ ...doc, items: doc.items.map((i) => (i.kind === 'picture' && i.id === 1 ? { ...i, x: i.x + 500 } : i)) })

  it('takes the new board, keeps the camera and the selection of items that are exactly what they were, restarts the history, and counts as saved', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('view.gray')
    r.c.exec('edit.selectAll')
    r.c.setView({ x: 9, y: 8, zoom: 2 })
    const outside = change(r.doc)
    r.c.replaceDoc({ ...outside, view: { x: 0, y: 0, zoom: 1 } })
    expect(pic(r, id.a).x).toBe(200)
    expect(r.doc.view).toEqual({ x: 9, y: 8, zoom: 2 })
    // Picture a is not what it was: it leaves the selection. The other two are the same at the same place.
    expect(r.s.selection).toEqual([id.b, id.n])
    expect(r.s.dirty).toBe(false)
    // An outside change is a barrier: there is nothing to undo, so an undo cannot take back what another program wrote.
    expect(r.s.canUndo).toBe(false)
    expect(r.s.undoLabel).toBeNull()
    r.c.exec('edit.undo')
    expect(pic(r, id.a).x).toBe(200)
    expect(r.doc.gray).toBe(true)
  })

  it('drops from the selection what the new board no longer has', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.replaceDoc({ ...doc, items: doc.items.filter((i) => i.id !== id.b) })
    expect(r.s.selection).toEqual([id.a, id.n])
  })

  it('a board equal to the present one is an echo: nothing changes, not even a history step', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('view.gray')
    r.forget()
    const same = JSON.parse(JSON.stringify(r.doc)) as BoardDoc
    r.c.replaceDoc(same)
    expect(r.s.doc).toBe(r.doc)
    expect(r.states).toHaveLength(0)
    expect(r.changes).toHaveLength(0)
    r.c.exec('edit.undo')
    expect(r.s.canUndo).toBe(false)
  })

  it('does not call onChange: the shell made the change itself', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.forget()
    r.c.replaceDoc(change(doc))
    expect(r.changes).toHaveLength(0)
    expect(r.states).toHaveLength(1)
  })

  it('takes the new board\'s view when asked to (the first load)', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.replaceDoc({ ...doc, view: { x: 11, y: 22, zoom: 3 } }, { view: true })
    expect(r.doc.view).toEqual({ x: 11, y: 22, zoom: 3 })
  })

  it('stops a drag in progress, and the pointer is ignored until it lifts', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.down(at(-300, -100))
    r.move(at(-250, -100))
    r.c.replaceDoc(change(doc))
    r.move(at(-200, -100))
    r.up(at(-200, -100))
    expect(pic(r, id.a).x).toBe(200)
  })

  it('ends editing a note the new board no longer has', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.editNote(id.n)
    r.c.replaceDoc({ ...doc, items: doc.items.filter((i) => i.id !== id.n) })
    expect(r.s.editingNote).toBeNull()
  })

  it('brings numbers gone bad back inside the limits', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.replaceDoc({ ...doc, items: doc.items.map((i) => (i.kind === 'picture' ? { ...i, x: NaN, w: 1e9 } : i)) })
    assertSane(r.doc)
    expect(pic(r, id.a).w).toBe(BOARD_LIMITS.pictureMax)
  })

  it('and the constructor does the same', () => {
    const { doc } = threeThings()
    const bad = { ...doc, items: doc.items.map((i) => (i.kind === 'picture' ? { ...i, x: Infinity, rotation: 900 } : i)) }
    const c = new BoardController({ doc: bad })
    assertSane(c.state.doc)
  })

  it('shows a picture whose shape the controller knows the way it knows it', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100))
    const r = new Rig(doc)
    r.c.setNaturalSize('a.png', 200, 100)
    r.c.replaceDoc(doc)
    expect(pic(r, id.a)).toMatchObject({ w: 100, h: 50 })
  })
})

/* ----------------------------------------------------------- addPictures --- */

describe('addPictures', () => {
  it('shows a large picture with its longest side 35% of the canvas width, centred, selected, as one step', () => {
    const r = new Rig(emptyBoard('t'))
    const ids = r.c.addPictures([{ path: 'big.png', w: 4000, h: 3000 }])
    expect(ids).toHaveLength(1)
    const p = pic(r, ids[0]!)
    expect(p.w).toBeCloseTo(350, 9)
    expect(p.h).toBeCloseTo(262.5, 9)
    expect(p).toMatchObject({ x: 0, y: 0, rotation: 0, path: 'big.png' })
    expect(r.s.selection).toEqual(ids)
    expect(r.s.undoLabel).toBe('Add pictures')
    r.c.exec('edit.undo')
    expect(r.doc.items).toHaveLength(0)
    expect(r.s.canUndo).toBe(false)
  })

  it('never shows a picture at more than twice its own pixels on the screen', () => {
    const r = new Rig(emptyBoard('t'))
    const [id] = r.c.addPictures([{ path: 'small.png', w: 100, h: 50 }])
    expect(pic(r, id!)).toMatchObject({ w: 200, h: 100 })
    r.c.setView({ x: 0, y: 0, zoom: 4 })
    const [id2] = r.c.addPictures([{ path: 'small2.png', w: 100, h: 50 }])
    // At zoom 4 the 100 pixels are 400 on the screen when 1:1... twice that is 800 screen pixels, i.e. 50 board units.
    expect(pic(r, id2!)).toMatchObject({ w: 50, h: 25 })
  })

  it('follows the zoom: a third of the canvas whatever the zoom', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.setView({ x: 0, y: 0, zoom: 0.1 })
    const [id] = r.c.addPictures([{ path: 'big.png', w: 4000, h: 2000 }])
    expect(pic(r, id!).w).toBeCloseTo(3500, 6)
    expect(pic(r, id!).h).toBeCloseTo(1750, 6)
    r.c.setView({ x: 0, y: 0, zoom: 2 })
    const [id2] = r.c.addPictures([{ path: 'big2.png', w: 4000, h: 2000 }])
    expect(pic(r, id2!).w).toBeCloseTo(175, 9)
  })

  it('goes where the view is looking when not told', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.setView({ x: 1200, y: -700, zoom: 1 })
    const [id] = r.c.addPictures([{ path: 'a.png', w: 400, h: 400 }])
    expect(pic(r, id!)).toMatchObject({ x: 1200, y: -700 })
    const [id2] = r.c.addPictures([{ path: 'b.png', w: 400, h: 400 }], { x: 40, y: 50 })
    expect(pic(r, id2!)).toMatchObject({ x: 40, y: 50 })
  })

  it('lays a batch out as an arrangement round the place: no overlap, centred on it', () => {
    const r = new Rig(emptyBoard('t'))
    const files = [
      { path: 'a.png', w: 1200, h: 800 },
      { path: 'b.png', w: 800, h: 1200 },
      { path: 'c.png', w: 1000, h: 1000 },
      { path: 'd.png', w: 2000, h: 500 },
      { path: 'e.png', w: 640, h: 480 },
      { path: 'f.png', w: 300, h: 300 },
    ]
    const ids = r.c.addPictures(files, { x: 200, y: -100 })
    expect(ids).toHaveLength(6)
    expect(r.s.selection).toEqual(ids)
    const boxes = ids.map((i) => itemBounds(pic(r, i), M))
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!
        const b = boxes[j]!
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
        expect(apart, `${i} and ${j}`).toBe(true)
      }
    }
    const x0 = Math.min(...boxes.map((b) => b.x))
    const x1 = Math.max(...boxes.map((b) => b.x + b.w))
    const y0 = Math.min(...boxes.map((b) => b.y))
    const y1 = Math.max(...boxes.map((b) => b.y + b.h))
    expect((x0 + x1) / 2).toBeCloseTo(200, 6)
    expect((y0 + y1) / 2).toBeCloseTo(-100, 6)
    // Aimed at the shape of the canvas (1.25 wide for each high), not a tall strip or a single row.
    expect((x1 - x0) / (y1 - y0)).toBeGreaterThan(0.6)
    expect((x1 - x0) / (y1 - y0)).toBeLessThan(2.6)
    expect(r.s.undoLabel).toBe('Add pictures')
    r.c.exec('edit.undo')
    expect(r.doc.items).toHaveLength(0)
  })

  it('goes on top of what is there', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    const [n] = r.c.addPictures([{ path: 'z.png', w: 500, h: 500 }])
    expect(r.doc.items.map((i) => i.id)).toEqual([id.a, id.b, id.n, n])
  })

  it('stops at the limit of the board, adds what fits and says so', () => {
    let doc = emptyBoard('almost')
    for (let i = 0; i < BOARD_LIMITS.items - 2; i++) doc = addMark(doc, { kind: 'line', x1: i, y1: 0, x2: i + 1, y2: 5, color: 'ffffff', width: 2, arrow: false }).doc
    const r = new Rig(doc)
    const ids = r.c.addPictures(Array.from({ length: 5 }, (_, i) => ({ path: `p${i}.png`, w: 100, h: 100 })))
    expect(ids).toHaveLength(2)
    expect(r.doc.items).toHaveLength(BOARD_LIMITS.items)
    expect(r.toasts('limit')).toHaveLength(1)
    expect((r.toasts('limit')[0] as { text: string }).text).toContain('2 of 5')
    expect(r.c.addPictures([{ path: 'more.png', w: 10, h: 10 }])).toEqual([])
    expect(r.toasts('limit')).toHaveLength(2)
    expect(r.doc.items).toHaveLength(BOARD_LIMITS.items)
  })

  it('a full board gets no step', () => {
    let doc = emptyBoard('full')
    for (let i = 0; i < BOARD_LIMITS.items; i++) doc = addMark(doc, { kind: 'line', x1: i, y1: 0, x2: i + 1, y2: 5, color: 'ffffff', width: 2, arrow: false }).doc
    const r = new Rig(doc)
    r.c.addPictures([{ path: 'x.png', w: 10, h: 10 }])
    expect(r.s.canUndo).toBe(false)
    expect(r.doc).toBe(r.s.doc)
  })

  it('copes with sizes that are nonsense and paths that are empty', () => {
    const r = new Rig(emptyBoard('t'))
    const ids = r.c.addPictures([
      { path: 'zero.png', w: 0, h: 0 },
      { path: 'nan.png', w: NaN, h: 10 },
      { path: 'neg.png', w: -5, h: 20 },
      { path: '', w: 100, h: 100 },
      { path: 'huge.png', w: 1e12, h: 1e12 },
    ])
    expect(ids).toHaveLength(4)
    assertSane(r.doc)
    expect(r.c.addPictures([])).toEqual([])
    expect(r.c.addPictures([{ path: '', w: 1, h: 1 }])).toEqual([])
  })

  it('remembers the pictures\' own size', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.addPictures([{ path: 'a.png', w: 640, h: 480 }])
    expect(r.c.naturalSize('a.png')).toEqual({ w: 640, h: 480 })
    expect(r.c.naturalSize('b.png')).toBeNull()
  })

  it('a new note being typed is dropped by a drop of pictures', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.addNoteAt({ x: 0, y: 0 })
    r.c.addPictures([{ path: 'a.png', w: 100, h: 100 }])
    expect(r.doc.items.map((i) => i.kind)).toEqual(['picture'])
    expect(r.s.editingNote).toBeNull()
  })

  it('the picture is hit-testable where it was put', () => {
    const r = new Rig(emptyBoard('t'))
    const [id] = r.c.addPictures([{ path: 'a.png', w: 1000, h: 1000 }])
    r.click(at(10, 10))
    expect(r.s.selection).toEqual([id])
  })
})

/* ------------------------------------------------------- setNaturalSize --- */

describe('setNaturalSize', () => {
  it('corrects a picture whose shape is off by more than 1%, keeping its width, with no history step', () => {
    const { doc, id } = build((b) => b.pic('a', 10, 20, 200, 200).pic('b', 300, 0, 200, 200))
    const r = new Rig(doc)
    r.forget()
    r.c.setNaturalSize('a.png', 400, 200)
    expect(pic(r, id.a)).toMatchObject({ x: 10, y: 20, w: 200, h: 100 })
    expect(pic(r, id.b)).toMatchObject({ w: 200, h: 200 })
    expect(r.s.canUndo).toBe(false)
    // Not a change of the board for the savers: a board that is only looked at is never written (the shape rides the next real edit).
    expect(r.changes.map((c) => c.why)).toEqual([{ reason: 'natural-size', final: false, viewOnly: true }])
  })

  it('leaves a picture within 1% alone, as the same object', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100))
    const r = new Rig(doc)
    r.forget()
    r.c.setNaturalSize('a.png', 2000, 1005)
    expect(r.doc).toBe(doc)
    expect(r.item(id.a)).toBe(doc.items[0])
    expect(r.changes).toHaveLength(0)
    r.c.setNaturalSize('a.png', 2000, 980)
    expect(pic(r, id.a).h).not.toBe(100)
  })

  it('fixes every picture of that path, locked ones too, and cropped ones without moving them', () => {
    const { doc, id } = build((b) =>
      b
        .pic('a', 0, 0, 200, 200)
        .pic('a2', 300, 0, 100, 100)
        .lock('a2'),
    )
    const crop = { l: 0.25, t: 0, r: 0.75, b: 1 }
    const withCrop: BoardDoc = {
      ...doc,
      items: [...doc.items, { ...(doc.items[0] as PictureItem), id: 99, path: 'a.png', x: 600, y: 10, crop }],
      nextId: 100,
    }
    const r = new Rig(withCrop)
    r.c.setNaturalSize('a.png', 100, 50)
    // a2 is another path name in the builder (a2.png); only a.png ones are fixed.
    expect(pic(r, id.a)).toMatchObject({ w: 200, h: 100 })
    expect(pic(r, id.a2)).toMatchObject({ w: 100, h: 100 })
    expect(pic(r, 99)).toMatchObject({ x: 600, y: 10, w: 200, h: 100, crop })
  })

  it('a locked picture is fixed too', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 200).lock('a'))
    const r = new Rig(doc)
    r.c.setNaturalSize('a.png', 100, 50)
    expect(pic(r, id.a)).toMatchObject({ h: 100, locked: true })
  })

  it('ignores a size that is not one', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 200, 200))
    const r = new Rig(doc)
    r.c.setNaturalSize('a.png', 0, 10)
    r.c.setNaturalSize('a.png', NaN, 10)
    r.c.setNaturalSize('a.png', 10, -1)
    r.c.setNaturalSize('a.png', Infinity, 10)
    expect(r.doc).toBe(doc)
    expect(r.c.naturalSize('a.png')).toBeNull()
  })

  it('the correction comes back when undo goes to a board from before it', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 200).pic('b', 400, 0, 100, 100))
    const r = new Rig(doc)
    r.drag(at(400, 0), at(450, 0))
    r.c.setNaturalSize('a.png', 100, 50)
    expect(pic(r, id.a).h).toBe(100)
    r.c.exec('edit.undo')
    expect(pic(r, id.b).x).toBe(400)
    expect(pic(r, id.a).h).toBe(100)
    r.c.exec('edit.redo')
    expect(pic(r, id.a).h).toBe(100)
  })

  it('goes into the next step and costs no step of its own', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 200).pic('b', 400, 0, 100, 100))
    const r = new Rig(doc)
    r.c.setNaturalSize('a.png', 100, 50)
    r.drag(at(400, 0), at(450, 0))
    r.c.exec('edit.undo')
    expect(r.s.canUndo).toBe(false)
    expect(pic(r, id.a).h).toBe(100)
  })
})

/* ------------------------------------------------------- pointer details --- */

describe('pointer edge cases', () => {
  it('a release for a pointer that never went down is ignored', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.forget()
    r.up(at(0, 0), { id: 9 })
    r.cancel(at(0, 0), { id: 9 })
    expect(r.changes).toHaveLength(0)
    expect(r.s.doc).toBe(doc)
  })

  it('a move that says no button is down ends the press (the release was lost outside the window)', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.down(at(-300, -100))
    r.move(at(-250, -100))
    r.hover(at(-200, -100))
    expect(pic(r, id.a).x).toBe(-250)
    expect(r.s.canUndo).toBe(true)
    r.move(at(0, 0))
    r.up(at(0, 0))
    expect(pic(r, id.a).x).toBe(-250)
  })

  it('a press for a pointer that is still down means its release was lost: the old press ends where it was', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.down(at(-300, -100))
    r.move(at(-250, -100))
    r.down(at(100, -100))
    // The drag of a ended at -250 and is one step; the new press is on b.
    expect(pic(r, id.a).x).toBe(-250)
    expect(r.s.canUndo).toBe(true)
    expect(r.s.selection).toEqual([id.b])
    r.up(at(100, -100))
    expect(r.s.selection).toEqual([id.b])
  })

  it('two mice (two pointer ids) at once: the second is not a gesture while the first is', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.down(at(-300, -100), { id: 1 })
    r.down(at(100, -100), { id: 2 })
    r.move(at(150, -100), { id: 2 })
    r.move(at(-250, -100), { id: 1 })
    r.up(at(150, -100), { id: 2 })
    r.up(at(-250, -100), { id: 1 })
    expect(pic(r, id.a).x).toBe(-250)
    expect(pic(r, id.b).x).toBe(100)
  })

  it('other buttons (back, forward) start nothing', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100), { button: 3 })
    r.click(at(-300, -100), { button: 4 })
    expect(r.s.selection).toEqual([])
  })

  it('a hover over a selected item shows the move cursor and over a handle the resize cursor', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.hover(at(-300, -100))
    expect(r.s.cursor).toBe('move')
    r.hover(at(-200, -50))
    expect(r.s.cursor).toBe('nwse-resize')
    r.hover(at(-200, -100))
    expect(r.s.cursor).toBe('ew-resize')
    r.hover(at(-300, -50))
    expect(r.s.cursor).toBe('ns-resize')
    r.hover(at(-400, -50))
    expect(r.s.cursor).toBe('nesw-resize')
    r.hover(at(-300, -150 - 28))
    expect(r.s.cursor).toBe('crosshair')
    r.hover(at(100, -100))
    expect(r.s.cursor).toBe('default')
    r.c.pointerLeave()
    expect(r.s.cursor).toBe('default')
  })

  it('resize cursors turn with a tilted box', () => {
    const b = build((x) => x.pic('a', 0, 0, 200, 100, { rotation: 90 }))
    const r = new Rig(b.doc)
    r.click(at(0, 0))
    // Turned a quarter, the east handle is at the bottom: it resizes up and down.
    r.hover(at(0, 100))
    expect(r.s.cursor).toBe('ns-resize')
  })

  it('the cursor follows the tool', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    const cursors: [string, string][] = [
      ['tool.hand', 'grab'],
      ['tool.note', 'text'],
      ['tool.pen', 'crosshair'],
      ['tool.line', 'crosshair'],
      ['tool.rect', 'crosshair'],
      ['tool.ellipse', 'crosshair'],
      ['tool.sampler', 'crosshair'],
      ['tool.eraser', 'cell'],
      ['tool.select', 'default'],
    ]
    for (const [cmd, cur] of cursors) {
      r.c.exec(cmd as 'tool.hand')
      expect(r.s.cursor, cmd).toBe(cur)
    }
  })
})

describe('bounds', () => {
  it('forgets the oldest picture sizes past a few thousand', () => {
    const r = new Rig(emptyBoard('t'))
    for (let i = 0; i < 5000; i++) r.c.setNaturalSize(`p${i}.png`, 10 + i, 20)
    expect(r.c.naturalSize('p0.png')).toBeNull()
    expect(r.c.naturalSize('p903.png')).toBeNull()
    expect(r.c.naturalSize('p4999.png')).toEqual({ w: 5009, h: 20 })
    expect(r.c.naturalSize('p1000.png')).toEqual({ w: 1010, h: 20 })
  })

  it('a size asked again counts as new', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.setNaturalSize('keep.png', 10, 10)
    for (let i = 0; i < 4090; i++) r.c.setNaturalSize(`p${i}.png`, 10, 10)
    r.c.setNaturalSize('keep.png', 10, 10)
    for (let i = 0; i < 100; i++) r.c.setNaturalSize(`q${i}.png`, 10, 10)
    expect(r.c.naturalSize('keep.png')).not.toBeNull()
  })

  it('pointers that never lifted are dropped after a few dozen, and the board works on', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    for (let i = 1; i <= 100; i++) r.down(at(0, 600), { id: 1000 + i })
    for (let i = 1; i <= 100; i++) r.up(at(0, 600), { id: 1000 + i })
    r.click(at(-300, -100), { id: 1 })
    expect(r.s.selection).toEqual([id.a])
    r.drag(at(-300, -100), at(-250, -100), { id: 2 })
    expect(pic(r, id.a).x).toBe(-250)
  })
})

describe('dispose', () => {
  it('stops telling anyone anything', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.dispose()
    r.forget()
    r.c.exec('view.gray')
    r.wheel(500, 400, -100)
    expect(r.events).toHaveLength(0)
    expect(r.changes).toHaveLength(0)
    expect(r.states).toHaveLength(0)
    expect(r.doc.gray).toBe(true)
  })
})

describe('the viewport', () => {
  it('is what the pointer maths and the fit commands work in', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 100, 100))
    const r = new Rig(doc)
    r.c.setViewport(400, 300)
    // The canvas middle is now (200, 150).
    r.click({ x: 200, y: 150 })
    expect(r.s.selection).toHaveLength(1)
    r.c.exec('view.fitAll')
    expect(r.doc.view.zoom).toBeCloseTo((300 - 96) / 100, 9)
    expect(VIEWPORT.w).toBe(1000)
  })
})
