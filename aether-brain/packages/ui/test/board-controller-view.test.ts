import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_LIMITS, emptyBoard, screenToBoard, type PictureItem } from '@aether/core'
import { Rig, VIEWPORT, at, build, threeThings } from './board-controller-harness'

afterEach(() => {
  vi.useRealTimers()
})

const centre = { x: VIEWPORT.w / 2, y: VIEWPORT.h / 2 }

/* ------------------------------------------------------------------- panning --- */

describe('panning', () => {
  it('the middle button drags the canvas: the content follows the pointer', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.drag(at(0, 0), at(50, 30), { button: 1 })
    expect(r.doc.view).toEqual({ x: -50, y: -30, zoom: 1 })
    expect(r.s.selection).toEqual([])
    expect(r.s.canUndo).toBe(false)
    expect(r.s.dirty).toBe(false)
  })

  it('divides the drag by the zoom', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.setView({ x: 10, y: 20, zoom: 2 })
    r.drag(at(0, 0), at(50, 30), { button: 1 })
    expect(r.doc.view).toEqual({ x: 10 - 25, y: 20 - 15, zoom: 2 })
  })

  it('is a view-only change: final at the end of the drag and not before', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.forget()
    r.down(at(0, 0), { button: 1 })
    r.move(at(10, 0), { button: 1 })
    r.move(at(20, 0), { button: 1 })
    expect(r.changes.map((c) => c.why)).toEqual([
      { reason: 'pan', final: false, viewOnly: true },
      { reason: 'pan', final: false, viewOnly: true },
    ])
    expect(r.s.moving).toBe(true)
    expect(r.s.cursor).toBe('grabbing')
    r.up(at(20, 0), { button: 1 })
    expect(r.changes[r.changes.length - 1]!.why).toEqual({ reason: 'pan', final: true, viewOnly: true })
    expect(r.s.moving).toBe(false)
    expect(r.changes.every((c) => c.why.viewOnly)).toBe(true)
  })

  it('Space held turns a drag anywhere into a pan, over an item too, and shows the hand', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    expect(r.key(' ')).toBe(true)
    expect(r.s.cursor).toBe('grab')
    r.drag(at(-300, -100), at(-250, -100))
    expect(r.item<PictureItem>(id.a).x).toBe(-300)
    expect(r.doc.view.x).toBe(-50)
    expect(r.s.selection).toEqual([])
    r.down(at(0, 0))
    expect(r.s.cursor).toBe('grabbing')
    r.up(at(0, 0))
    expect(r.release(' ')).toBe(true)
    expect(r.s.cursor).toBe('default')
    r.click(at(-300 + 50, -100))
    expect(r.s.selection).toEqual([id.a])
  })

  it('losing the focus lets go of Space, whose release would never come', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.key(' ')
    expect(r.s.cursor).toBe('grab')
    r.c.blur()
    expect(r.s.cursor).toBe('default')
    r.drag(at(-300, -100), at(-250, -100))
    expect(r.item<PictureItem>(id.a).x).toBe(-250)
    expect(r.doc.view.x).toBe(0)
  })

  it('Space works with every tool', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('tool.pen')
    r.key(' ')
    r.drag(at(0, 0), at(30, 30))
    r.release(' ')
    expect(r.doc.items).toHaveLength(doc.items.length)
    expect(r.doc.view.x).toBe(-30)
  })

  it('the hand tool pans with the primary button and selects nothing', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('tool.hand')
    expect(r.s.cursor).toBe('grab')
    r.drag(at(-300, -100), at(-200, -60))
    expect(r.doc.view).toEqual({ x: -100, y: -40, zoom: 1 })
    expect(r.s.selection).toEqual([])
    r.click(at(-300, -100))
    expect(r.s.selection).toEqual([])
  })

  it("a pen's barrel button pans and its tip does not", () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.drag(at(0, 0), at(40, 20), { pointerType: 'pen', button: 2 })
    expect(r.doc.view).toEqual({ x: -40, y: -20, zoom: 1 })
    r.drag(at(-300, -100), at(-260, -100), { pointerType: 'pen' })
    expect(r.item<PictureItem>(id.a).x).toBe(-260)
    expect(r.doc.view.x).toBe(-40)
  })

  it('one touch on the empty canvas pans, and on an item moves it', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.drag(at(0, 500), at(30, 470), { pointerType: 'touch' })
    expect(r.doc.view).toEqual({ x: -30, y: 30, zoom: 1 })
    expect(r.s.selection).toEqual([])
    // The view moved by (-30, 30), so the picture is at (-270, -130) on the canvas now... drag it where it is.
    r.drag(at(-300 + 30, -100 - 30), at(-300 + 30 + 40, -100 - 30), { pointerType: 'touch' })
    expect(r.item<PictureItem>(id.a).x).toBe(-260)
  })

  it('a tap of a finger on the empty canvas clears the selection, a drag of it does not', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.drag(at(0, 500), at(40, 500), { pointerType: 'touch' })
    expect(r.s.selection).toEqual([id.a])
    r.forget()
    r.click(at(0, 500), { pointerType: 'touch' })
    expect(r.s.selection).toEqual([])
    expect(r.s.canUndo).toBe(false)
  })

  it('a tap that wobbles a pixel or two is still a tap', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    expect(r.s.selection).toEqual([id.a])
    r.down(at(0, 500), { pointerType: 'touch' })
    r.move(at(1, 501), { pointerType: 'touch' })
    r.move(at(2, 500), { pointerType: 'touch' })
    r.up(at(2, 500), { pointerType: 'touch' })
    expect(r.s.selection).toEqual([])
  })

  it('a double tap on the empty canvas makes a note', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.dblclick(at(300, 500), { pointerType: 'touch' })
    expect(r.s.editingNote).not.toBeNull()
  })

  it('touch draws with the drawing tools and does not pan', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('tool.line')
    r.drag(at(0, 400), at(100, 400), { pointerType: 'touch' })
    expect(r.doc.view.x).toBe(0)
    expect(r.doc.items).toHaveLength(doc.items.length + 1)
  })

  it('does not go past the coordinate limit', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.setView({ x: 999_999, y: 0, zoom: 1 })
    r.drag(at(0, 0), at(-900, 0), { button: 1 })
    expect(r.doc.view.x).toBe(1_000_000)
  })
})

describe('pinching', () => {
  const pinchRig = () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    return { r, id }
  }

  it('two touches zoom by the ratio of their distance and keep the board under their middle', () => {
    const { r } = pinchRig()
    r.down({ x: 400, y: 300 }, { id: 1, pointerType: 'touch' })
    r.down({ x: 600, y: 300 }, { id: 2, pointerType: 'touch' })
    const board = screenToBoard(r.doc.view, VIEWPORT, { x: 500, y: 300 })
    r.move({ x: 700, y: 300 }, { id: 2, pointerType: 'touch' })
    // 200 apart became 300: 1.5 times, about the old middle, and the middle itself moved to (550, 300).
    expect(r.doc.view.zoom).toBeCloseTo(1.5, 9)
    const under = screenToBoard(r.doc.view, VIEWPORT, { x: 550, y: 300 })
    expect(under.x).toBeCloseTo(board.x, 9)
    expect(under.y).toBeCloseTo(board.y, 9)
    expect(r.s.moving).toBe(true)
    r.up({ x: 700, y: 300 }, { id: 2, pointerType: 'touch' })
    r.up({ x: 400, y: 300 }, { id: 1, pointerType: 'touch' })
    expect(r.s.moving).toBe(false)
  })

  it('moving both fingers together pans', () => {
    const { r } = pinchRig()
    r.down({ x: 400, y: 300 }, { id: 1, pointerType: 'touch' })
    r.down({ x: 600, y: 300 }, { id: 2, pointerType: 'touch' })
    r.move({ x: 430, y: 340 }, { id: 1, pointerType: 'touch' })
    r.move({ x: 630, y: 340 }, { id: 2, pointerType: 'touch' })
    expect(r.doc.view.zoom).toBeCloseTo(1, 9)
    expect(r.doc.view.x).toBeCloseTo(-30, 6)
    expect(r.doc.view.y).toBeCloseTo(-40, 6)
  })

  it('pinching in zooms out', () => {
    const { r } = pinchRig()
    r.down({ x: 300, y: 300 }, { id: 1, pointerType: 'touch' })
    r.down({ x: 700, y: 300 }, { id: 2, pointerType: 'touch' })
    r.move({ x: 500, y: 300 }, { id: 2, pointerType: 'touch' })
    expect(r.doc.view.zoom).toBeCloseTo(0.5, 9)
  })

  it('a touch drag that was under way is undone when the second finger lands', () => {
    const { r, id } = pinchRig()
    r.down(at(-300, -100), { id: 1, pointerType: 'touch' })
    r.move(at(-250, -100), { id: 1, pointerType: 'touch' })
    expect(r.item<PictureItem>(id.a).x).toBe(-250)
    r.down({ x: 700, y: 600 }, { id: 2, pointerType: 'touch' })
    expect(r.item<PictureItem>(id.a).x).toBe(-300)
    r.up({ x: 700, y: 600 }, { id: 2, pointerType: 'touch' })
    r.up(at(-250, -100), { id: 1, pointerType: 'touch' })
    expect(r.s.canUndo).toBe(false)
  })

  it('the finger left on the glass after one lifts does not pan or drag', () => {
    const { r, id } = pinchRig()
    r.down(at(-300, -100), { id: 1, pointerType: 'touch' })
    r.down(at(100, -100), { id: 2, pointerType: 'touch' })
    r.up(at(100, -100), { id: 2, pointerType: 'touch' })
    const view = r.doc.view
    r.move(at(-200, 0), { id: 1, pointerType: 'touch' })
    r.up(at(-200, 0), { id: 1, pointerType: 'touch' })
    expect(r.doc.view).toEqual(view)
    expect(r.item<PictureItem>(id.a).x).toBe(-300)
  })

  it('a third finger is ignored; a new pair after both lifted pinches again', () => {
    const { r } = pinchRig()
    r.down({ x: 400, y: 300 }, { id: 1, pointerType: 'touch' })
    r.down({ x: 600, y: 300 }, { id: 2, pointerType: 'touch' })
    r.down({ x: 100, y: 100 }, { id: 3, pointerType: 'touch' })
    r.move({ x: 50, y: 50 }, { id: 3, pointerType: 'touch' })
    expect(r.doc.view).toEqual({ x: 0, y: 0, zoom: 1 })
    r.up({ x: 50, y: 50 }, { id: 3, pointerType: 'touch' })
    r.up({ x: 600, y: 300 }, { id: 2, pointerType: 'touch' })
    r.up({ x: 400, y: 300 }, { id: 1, pointerType: 'touch' })
    r.down({ x: 400, y: 300 }, { id: 1, pointerType: 'touch' })
    r.down({ x: 600, y: 300 }, { id: 2, pointerType: 'touch' })
    r.move({ x: 800, y: 300 }, { id: 2, pointerType: 'touch' })
    expect(r.doc.view.zoom).toBeCloseTo(2, 9)
  })

  it('zoom stays inside the limits and the view is a view-only change', () => {
    const { r } = pinchRig()
    r.forget()
    r.down({ x: 499, y: 300 }, { id: 1, pointerType: 'touch' })
    r.down({ x: 501, y: 300 }, { id: 2, pointerType: 'touch' })
    r.move({ x: 1000, y: 300 }, { id: 2, pointerType: 'touch' })
    expect(r.doc.view.zoom).toBe(BOARD_LIMITS.zoomMax)
    expect(r.changes.every((c) => c.why.viewOnly)).toBe(true)
    expect(r.s.canUndo).toBe(false)
  })

  it('a second finger does not start a pinch while the first is still pressed on the canvas as a mouse would be', () => {
    const { r } = pinchRig()
    r.down(at(0, 500), { id: 1 })
    r.down({ x: 700, y: 600 }, { id: 2, pointerType: 'touch' })
    r.move({ x: 750, y: 600 }, { id: 2, pointerType: 'touch' })
    // One touch only: it pans, it does not pinch.
    expect(r.doc.view.zoom).toBe(1)
  })
})

/* -------------------------------------------------------------------- wheel --- */

describe('the wheel', () => {
  it('zooms by 1.0015 to the power of minus the delta, about the pointer', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    const p = { x: 300, y: 200 }
    const before = screenToBoard(r.doc.view, VIEWPORT, p)
    r.wheel(p.x, p.y, -100)
    expect(r.doc.view.zoom).toBeCloseTo(Math.pow(1.0015, 100), 12)
    const after = screenToBoard(r.doc.view, VIEWPORT, p)
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
    r.wheel(p.x, p.y, 100)
    expect(r.doc.view.zoom).toBeCloseTo(1, 12)
    const back = screenToBoard(r.doc.view, VIEWPORT, p)
    expect(back.x).toBeCloseTo(before.x, 9)
  })

  it('keeps the point under the cursor fixed at any zoom and position', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.setView({ x: 123, y: -456, zoom: 0.37 })
    for (const [x, y, d] of [
      [10, 790, -240],
      [990, 5, 90],
      [500, 400, -33],
      [0, 0, 400],
    ] as const) {
      const p = { x, y }
      const before = screenToBoard(r.doc.view, VIEWPORT, p)
      r.wheel(x, y, d)
      const after = screenToBoard(r.doc.view, VIEWPORT, p)
      expect(after.x).toBeCloseTo(before.x, 7)
      expect(after.y).toBeCloseTo(before.y, 7)
    }
  })

  it('reads lines and pages as pixels: 32 for a line and a viewport height for a page', () => {
    const { doc } = threeThings()
    const a = new Rig(doc)
    a.wheel(500, 400, -3, { deltaMode: 1 })
    expect(a.doc.view.zoom).toBeCloseTo(Math.pow(1.0015, 96), 12)
    const b = new Rig(doc)
    b.wheel(500, 400, -0.1, { deltaMode: 2 })
    expect(b.doc.view.zoom).toBeCloseTo(Math.pow(1.0015, 80), 12)
  })

  it('ctrl + wheel (a trackpad pinch) is three times as sensitive', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.wheel(500, 400, -10, { ctrl: true })
    expect(r.doc.view.zoom).toBeCloseTo(Math.pow(1.0015, 30), 12)
  })

  it('limits one event to a factor of 2', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.wheel(500, 400, -50_000)
    expect(r.doc.view.zoom).toBe(2)
    r.wheel(500, 400, 50_000)
    expect(r.doc.view.zoom).toBe(1)
    r.wheel(500, 400, 50_000)
    expect(r.doc.view.zoom).toBe(0.5)
  })

  it('stays inside the zoom limits', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    for (let i = 0; i < 100; i++) r.wheel(500, 400, -2000)
    expect(r.doc.view.zoom).toBe(BOARD_LIMITS.zoomMax)
    for (let i = 0; i < 100; i++) r.wheel(500, 400, 2000)
    expect(r.doc.view.zoom).toBe(BOARD_LIMITS.zoomMin)
  })

  it('shift + wheel pans sideways, from the delta in either axis', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.wheel(500, 400, 100, { shift: true })
    expect(r.doc.view).toEqual({ x: 100, y: 0, zoom: 1 })
    r.wheel(500, 400, 0, { shift: true, deltaX: -40 })
    expect(r.doc.view).toEqual({ x: 60, y: 0, zoom: 1 })
    r.c.setView({ x: 0, y: 0, zoom: 4 })
    r.wheel(500, 400, 100, { shift: true })
    expect(r.doc.view.x).toBe(25)
  })

  it('alt + wheel pans up and down', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.wheel(500, 400, 80, { alt: true })
    expect(r.doc.view).toEqual({ x: 0, y: 80, zoom: 1 })
    r.wheel(500, 400, -30, { alt: true })
    expect(r.doc.view).toEqual({ x: 0, y: 50, zoom: 1 })
  })

  it('a trackpad scroll on both axes is not a pan: the wheel zooms by its vertical part and ignores the horizontal', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.wheel(500, 400, 0, { deltaX: 300 })
    expect(r.doc.view).toEqual({ x: 0, y: 0, zoom: 1 })
    r.wheel(500, 400, -20, { deltaX: 300 })
    expect(r.doc.view.x).toBeCloseTo(0, 6)
    expect(r.doc.view.zoom).toBeCloseTo(Math.pow(1.0015, 20), 12)
  })

  it('is a view-only change: no history, not dirty, and a final change per event', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.forget()
    r.wheel(500, 400, -100)
    r.wheel(500, 400, 100, { shift: true })
    expect(r.changes.map((c) => c.why)).toEqual([
      { reason: 'zoom', final: true, viewOnly: true },
      { reason: 'pan', final: true, viewOnly: true },
    ])
    expect(r.s.canUndo).toBe(false)
    expect(r.s.dirty).toBe(false)
  })

  it('says it is moving, then settles', () => {
    vi.useFakeTimers()
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.wheel(500, 400, -100)
    expect(r.s.moving).toBe(true)
    vi.advanceTimersByTime(100)
    expect(r.s.moving).toBe(true)
    r.wheel(500, 400, -100)
    vi.advanceTimersByTime(100)
    expect(r.s.moving).toBe(true)
    vi.advanceTimersByTime(100)
    expect(r.s.moving).toBe(false)
  })

  it('an event that changes nothing (zoom at its limit) is no change', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.setView({ x: 0, y: 0, zoom: BOARD_LIMITS.zoomMax })
    r.forget()
    r.wheel(500, 400, -100)
    expect(r.changes).toHaveLength(0)
    expect(r.s.moving).toBe(false)
  })

  it('does not choke on nonsense', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.wheel(NaN, NaN, NaN)
    r.wheel(500, 400, Infinity, { shift: true })
    expect(Number.isFinite(r.doc.view.x + r.doc.view.y + r.doc.view.zoom)).toBe(true)
  })
})

/* ------------------------------------------------------------ view commands --- */

describe('fitting and zooming', () => {
  it('fit all shows every item with a margin of 48 pixels', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 400, 200).pic('b', 1000, 600, 400, 200))
    const r = new Rig(doc)
    r.c.exec('view.fitAll')
    // The items span x -200..1200 and y -100..700 : 1400 by 800 in a canvas 1000 by 800.
    expect(r.doc.view.zoom).toBeCloseTo(Math.min((1000 - 96) / 1400, (800 - 96) / 800), 9)
    expect(r.doc.view.x).toBeCloseTo(500, 9)
    expect(r.doc.view.y).toBeCloseTo(300, 9)
    expect(r.s.canUndo).toBe(false)
    expect(r.s.dirty).toBe(false)
  })

  it('fit all on an empty board goes home', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.setView({ x: 500, y: 500, zoom: 3 })
    r.c.exec('view.fitAll')
    expect(r.doc.view).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('fit selection shows the selection, and everything when nothing is selected', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100).pic('b', 2000, 0, 100, 100))
    const r = new Rig(doc)
    r.click(at(0, 0))
    r.c.exec('view.fitSelection')
    expect(r.doc.view.x).toBeCloseTo(0, 9)
    expect(r.doc.view.zoom).toBeCloseTo((800 - 96) / 100, 9)
    r.c.exec('edit.selectNone')
    r.c.exec('view.fitSelection')
    expect(r.doc.view.x).toBeCloseTo(1000, 9)
    expect(id.a).toBeGreaterThan(0)
  })

  it('zoom in and out step by 1.25 about the middle of the canvas', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.setView({ x: 40, y: 60, zoom: 1 })
    r.c.exec('view.zoomIn')
    expect(r.doc.view).toEqual({ x: 40, y: 60, zoom: 1.25 })
    r.c.exec('view.zoomOut')
    r.c.exec('view.zoomOut')
    expect(r.doc.view.zoom).toBeCloseTo(0.8, 12)
    expect(r.doc.view.x).toBeCloseTo(40, 9)
  })

  it('100% shows one picture pixel per screen pixel of the selected picture, centred on it', () => {
    const { doc, id } = build((b) => b.pic('a', 300, 200, 400, 200).pic('b', -300, 0, 400, 200))
    const r = new Rig(doc)
    r.c.setNaturalSize('a.png', 1600, 800)
    r.click(at(300, 200))
    r.c.exec('view.zoom100')
    // 1600 pixels across 400 board units: 4 screen pixels per board unit.
    expect(r.doc.view).toEqual({ x: 300, y: 200, zoom: 4 })
    expect(id.a).toBeGreaterThan(0)
  })

  it('100% without a picture or a known size is zoom 1 where the view is', () => {
    const { doc } = build((b) => b.pic('a', 300, 200, 400, 200))
    const r = new Rig(doc)
    r.c.setView({ x: 70, y: 80, zoom: 5 })
    r.c.exec('view.zoom100')
    expect(r.doc.view).toEqual({ x: 70, y: 80, zoom: 1 })
    r.click({ x: 500 + (300 - 70) * 1, y: 400 + (200 - 80) * 1 })
    r.c.exec('view.zoom100')
    expect(r.doc.view).toEqual({ x: 70, y: 80, zoom: 1 })
  })

  it('setView clamps and is not a history step', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.setView({ x: 5e9, y: -5e9, zoom: 1e9 })
    expect(r.doc.view).toEqual({ x: 1e6, y: -1e6, zoom: BOARD_LIMITS.zoomMax })
    r.c.setView({ x: NaN, y: 3, zoom: NaN })
    expect(Number.isFinite(r.doc.view.x + r.doc.view.zoom)).toBe(true)
    expect(r.s.canUndo).toBe(false)
  })
})

/* --------------------------------------------------------------- the keys --- */

describe('the keyboard', () => {
  it('picks the tools', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    const tools: [string, string][] = [
      ['h', 'hand'],
      ['t', 'note'],
      ['p', 'pen'],
      ['l', 'line'],
      ['r', 'rect'],
      ['o', 'ellipse'],
      ['e', 'eraser'],
      ['i', 'sampler'],
      ['v', 'select'],
    ]
    for (const [k, tool] of tools) {
      expect(r.key(k), k).toBe(true)
      expect(r.s.tool, k).toBe(tool)
    }
    r.click(at(-300, -100))
    expect(r.key('c')).toBe(true)
    expect(r.s.tool).toBe('crop')
  })

  it('returns false for keys it has no use for and for releases', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    for (const k of ['q', 'w', 'x', 'F5', 'Shift', 'Control', 'ArrowLeft', 'ArrowUp']) expect(r.key(k), k).toBe(false)
    expect(r.release('v')).toBe(false)
    expect(r.key('a', { alt: true })).toBe(false)
    expect(r.key('z', { ctrl: true, alt: true })).toBe(false)
  })

  it('both ctrl and meta are the shortcut key', () => {
    const { doc } = threeThings()
    for (const mod of ['ctrl', 'meta'] as const) {
      const r = new Rig(doc)
      expect(r.key('a', { [mod]: true })).toBe(true)
      expect(r.s.selection).toHaveLength(3)
      expect(r.key('i', { [mod]: true })).toBe(true)
      expect(r.s.selection).toHaveLength(0)
    }
  })

  it('undo, redo (two ways)', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100))
    const r = new Rig(doc)
    r.drag(at(0, 0), at(50, 0))
    expect(r.key('z', { ctrl: true })).toBe(true)
    expect(r.item<PictureItem>(id.a).x).toBe(0)
    expect(r.key('z', { ctrl: true, shift: true })).toBe(true)
    expect(r.item<PictureItem>(id.a).x).toBe(50)
    r.key('z', { meta: true })
    expect(r.item<PictureItem>(id.a).x).toBe(0)
    expect(r.key('y', { meta: true })).toBe(true)
    expect(r.item<PictureItem>(id.a).x).toBe(50)
  })

  it('Esc is a ladder: the drag, then cropping, then the selection, then the tool', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.key('p')
    r.click(at(-300, -100))
    expect(r.s.selection).toEqual([])
    r.key('v')
    r.click(at(-300, -100))
    r.key('c')
    r.key('p')
    expect(r.s.tool).toBe('pen')
    // A drag under way is cancelled first, and nothing else changes.
    r.down(at(0, 500))
    r.move(at(50, 520))
    expect(r.key('Escape')).toBe(true)
    expect(r.s.draft).toBeNull()
    expect(r.s.tool).toBe('pen')
    expect(r.s.selection).toEqual([id.a])
    r.up(at(50, 520))
    // Next the selection, then the tool.
    expect(r.key('Escape')).toBe(true)
    expect(r.s.selection).toEqual([])
    expect(r.s.tool).toBe('pen')
    expect(r.key('Escape')).toBe(true)
    expect(r.s.tool).toBe('select')
    expect(r.key('Escape')).toBe(false)
  })

  it('Esc leaves cropping before it clears the selection', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.key('c')
    expect(r.s.cropping).toBe(id.a)
    expect(r.key('Escape')).toBe(true)
    expect(r.s.cropping).toBeNull()
    expect(r.s.selection).toEqual([id.a])
    expect(r.s.tool).toBe('select')
    expect(r.key('Escape')).toBe(true)
    expect(r.s.selection).toEqual([])
  })

  it('zoom keys, fit keys and the zoom to 100%', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 400, 200))
    const r = new Rig(doc)
    r.key('=')
    expect(r.doc.view.zoom).toBe(1.25)
    r.key('+', { shift: true })
    expect(r.doc.view.zoom).toBeCloseTo(1.5625, 12)
    r.key('-')
    expect(r.doc.view.zoom).toBeCloseTo(1.25, 12)
    r.key('Home')
    expect(r.doc.view.zoom).toBeCloseTo((1000 - 96) / 400, 9)
    r.key('1')
    expect(r.doc.view.zoom).toBe(1)
    r.key('f')
    expect(r.doc.view.zoom).toBeCloseTo((1000 - 96) / 400, 9)
    r.c.setView({ x: 0, y: 0, zoom: 1 })
    r.key('z')
    expect(r.doc.view.zoom).toBeCloseTo((1000 - 96) / 400, 9)
    r.c.setView({ x: 0, y: 0, zoom: 1 })
    r.key('f', { shift: true })
    expect(r.doc.view.zoom).toBeCloseTo((1000 - 96) / 400, 9)
  })

  it('holding a key does not repeat its command, except for the ones that should', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 400, 200))
    const r = new Rig(doc)
    r.key('g')
    r.key('g', { repeat: true })
    r.key('g', { repeat: true })
    expect(r.doc.gray).toBe(true)
    r.key('=')
    r.key('=', { repeat: true })
    r.key('=', { repeat: true })
    expect(r.doc.view.zoom).toBeCloseTo(1.25 ** 3, 12)
    expect(r.key('Delete', { repeat: true })).toBe(true)
  })

  it('Tab and A and Enter and the picture keys hand a command to the shell', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.key('Tab')
    r.key('a')
    expect(r.eventsOf('command').map((e) => e.id)).toEqual(['view.hideUi', 'arrange.menu'])
    r.click(at(-300, -100))
    r.forget()
    r.key('Enter')
    expect(r.eventsOf('command')).toEqual([{ type: 'command', id: 'picture.open', ids: [id.a], paths: ['a.png'] }])
    r.key('o', { ctrl: true })
    r.key('e', { ctrl: true })
    r.key('e', { ctrl: true, shift: true })
    expect(r.eventsOf('command').map((e) => e.id)).toEqual(['picture.open', 'picture.add', 'export.selection', 'export.board'])
  })
})

describe('the arrow keys', () => {
  it('nudge the selection by 1 unit, 10 with shift', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100))
    const r = new Rig(doc)
    r.click(at(0, 0))
    expect(r.key('ArrowRight')).toBe(true)
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 1, y: 0 })
    r.key('ArrowDown', { shift: true })
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 1, y: 10 })
    r.key('ArrowLeft')
    r.key('ArrowUp')
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 0, y: 9 })
  })

  it('a run of presses is one undo step; a pause makes another', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100))
    const r = new Rig(doc)
    r.click(at(0, 0))
    for (let i = 0; i < 6; i++) {
      r.clock += 200
      r.key('ArrowRight')
    }
    expect(r.item<PictureItem>(id.a).x).toBe(6)
    r.c.exec('edit.undo')
    expect(r.item<PictureItem>(id.a).x).toBe(0)
    expect(r.s.canUndo).toBe(false)
    r.c.exec('edit.redo')
    r.clock += 5000
    r.key('ArrowRight')
    expect(r.item<PictureItem>(id.a).x).toBe(7)
    r.c.exec('edit.undo')
    expect(r.item<PictureItem>(id.a).x).toBe(6)
    r.c.exec('edit.undo')
    expect(r.item<PictureItem>(id.a).x).toBe(0)
  })

  it('a run of presses on one selection is one step, on another selection a step of its own', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.key('ArrowRight')
    r.key('ArrowRight')
    r.click(at(100, -100))
    r.key('ArrowDown')
    r.key('ArrowDown')
    expect(r.item<PictureItem>(id.a).x).toBe(-298)
    expect(r.item<PictureItem>(id.b).y).toBe(-98)
    r.c.exec('edit.undo')
    expect(r.item<PictureItem>(id.b).y).toBe(-100)
    expect(r.item<PictureItem>(id.a).x).toBe(-298)
    r.c.exec('edit.undo')
    expect(r.item<PictureItem>(id.a).x).toBe(-300)
    expect(r.s.canUndo).toBe(false)
  })

  it('a nudge after an undo starts a step of its own', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100))
    const r = new Rig(doc)
    r.click(at(0, 0))
    r.key('ArrowRight')
    r.c.exec('edit.undo')
    r.key('ArrowDown')
    expect(r.item<PictureItem>(id.a)).toMatchObject({ x: 0, y: 1 })
    expect(r.s.canUndo).toBe(true)
  })

  it('are not used with nothing selected, or with ctrl, meta or alt', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100))
    const r = new Rig(doc)
    expect(r.key('ArrowRight')).toBe(false)
    r.click(at(0, 0))
    expect(r.key('ArrowRight', { ctrl: true })).toBe(false)
    expect(r.key('ArrowRight', { alt: true })).toBe(false)
    expect(r.key('ArrowRight', { meta: true })).toBe(false)
    expect(r.item<PictureItem>(id.a).x).toBe(0)
  })

  it('leave a locked selection alone and say so once', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100).lock('a'))
    const r = new Rig(doc)
    r.click(at(0, 0))
    expect(r.key('ArrowRight')).toBe(true)
    r.key('ArrowRight', { repeat: true })
    r.key('ArrowRight', { repeat: true })
    expect(r.item<PictureItem>(id.a).x).toBe(0)
    expect(r.toasts('locked')).toHaveLength(1)
  })
})
