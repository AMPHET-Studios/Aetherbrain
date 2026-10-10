import { describe, expect, it } from 'vitest'
import {
  BOARD_LIMITS,
  addMark,
  arrange,
  emptyBoard,
  estimateTextMetrics,
  itemBounds,
  textColourOn,
  type BoardItem,
  type LineItem,
  type NoteItem,
  type PictureItem,
} from '@aether/core'
import { BOARD_BACKGROUNDS } from '../src/board/controller'
import type { BoardCommandId, BoardTool } from '../src/board/api'
import { BOARD_COMMANDS } from '../src/board/commands'
import { Rig, at, build, threeThings } from './board-controller-harness'

const M = estimateTextMetrics

const pic = (r: Rig, id: number) => r.item<PictureItem>(id)

function fourPictures() {
  return build((b) =>
    b
      .pic('a', -300, -100, 200, 100)
      .pic('b', 0, -80, 100, 160)
      .pic('c', 250, -100, 120, 90)
      .pic('d', 0, 250, 300, 100),
  )
}

/* --------------------------------------------------------------------- tools --- */

describe('tool commands', () => {
  it('each one picks its tool', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    const names: BoardTool[] = ['hand', 'note', 'pen', 'line', 'rect', 'ellipse', 'eraser', 'sampler', 'select']
    for (const t of names) {
      r.c.exec(`tool.${t}` as BoardCommandId)
      expect(r.s.tool).toBe(t)
    }
  })

  it('crop needs one picture selected', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.c.exec('tool.crop')
    expect(r.s).toMatchObject({ tool: 'crop', cropping: id.a })
    r.c.exec('tool.select')
    expect(r.s.cropping).toBeNull()
  })

  it('a tool command does not touch the board or the history', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('tool.pen')
    r.c.exec('tool.select')
    expect(r.doc).toBe(doc)
    expect(r.s.canUndo).toBe(false)
    expect(r.changes).toHaveLength(0)
  })
})

/* ---------------------------------------------------------------------- edit --- */

describe('selection commands', () => {
  it('select all, none, and invert', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    expect(r.s.selection).toEqual([id.a, id.b, id.n])
    r.c.exec('edit.selectNone')
    expect(r.s.selection).toEqual([])
    r.click(at(-300, -100))
    r.c.exec('edit.invertSelection')
    expect(r.s.selection).toEqual([id.b, id.n])
    r.c.exec('edit.invertSelection')
    expect(r.s.selection).toEqual([id.a])
    expect(r.s.canUndo).toBe(false)
  })

  it('invert on nothing selected selects everything; on everything, nothing', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.invertSelection')
    expect(r.s.selection).toEqual([id.a, id.b, id.n])
    r.c.exec('edit.invertSelection')
    expect(r.s.selection).toEqual([])
  })

  it('invert keeps groups whole', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 50, 50).pic('b', 100, 0, 50, 50).pic('c', 200, 0, 50, 50).group('a', 'b'))
    const r = new Rig(doc)
    r.click(at(200, 0))
    r.c.exec('edit.invertSelection')
    expect(r.s.selection).toEqual([id.a, id.b])
  })
})

describe('duplicate', () => {
  it('copies the selection 24 pixels down and right, selects the copies, in one step', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.c.exec('edit.duplicate')
    expect(r.doc.items).toHaveLength(4)
    const copy = r.doc.items[3] as PictureItem
    expect(copy).toMatchObject({ kind: 'picture', path: 'a.png', x: -276, y: -76 })
    expect(copy.id).not.toBe(id.a)
    expect(r.s.selection).toEqual([copy.id])
    expect(r.s.undoLabel).toBe('Duplicate')
    r.c.exec('edit.undo')
    expect(r.doc.items).toHaveLength(3)
    expect(r.s.selection).toEqual([])
  })

  it('the offset is 24 screen pixels at any zoom', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.setView({ x: 0, y: 0, zoom: 2 })
    r.c.exec('edit.selectAll')
    r.c.exec('edit.duplicate')
    expect(r.doc.items[3]).toMatchObject({ x: -288, y: -88 })
  })

  it('repeated, it cascades', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 50, 50))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.duplicate')
    r.c.exec('edit.duplicate')
    expect(r.doc.items.map((i) => (i as PictureItem).x)).toEqual([0, 24, 48])
  })

  it('skips locked items; a locked selection says so', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 50, 50).pic('b', 100, 0, 50, 50).lock('a'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.duplicate')
    expect(r.doc.items).toHaveLength(3)
    const lone = build((b) => b.pic('a', 0, 0, 50, 50).lock('a'))
    const r2 = new Rig(lone.doc)
    r2.c.exec('edit.selectAll')
    r2.c.exec('edit.duplicate')
    expect(r2.doc.items).toHaveLength(1)
    expect(r2.toasts('locked')).toHaveLength(1)
  })

  it('a copied group is a group of its own', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 50, 50).pic('b', 100, 0, 50, 50).group('a', 'b'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.duplicate')
    const groups = r.doc.items.map((i) => i.group)
    expect(new Set(groups).size).toBe(2)
    expect(groups[2]).toBe(groups[3])
    expect(groups[2]).not.toBe(groups[0])
  })

  it('on a full board says so and changes nothing', () => {
    let doc = emptyBoard('full')
    for (let i = 0; i < BOARD_LIMITS.items; i++) doc = addMark(doc, { kind: 'line', x1: i, y1: 0, x2: i + 1, y2: 5, color: 'ffffff', width: 2, arrow: false }).doc
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.duplicate')
    expect(r.doc.items).toHaveLength(BOARD_LIMITS.items)
    expect(r.toasts('limit')).toHaveLength(1)
  })
})

describe('delete', () => {
  it('removes the selection, as one step, and clears it', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.click(at(100, -100), { shift: true })
    r.c.exec('edit.delete')
    expect(r.doc.items.map((i) => i.id)).toEqual([id.n])
    expect(r.s.selection).toEqual([])
    r.c.exec('edit.undo')
    expect(r.doc.items).toHaveLength(3)
  })

  it('leaves locked items, which stay selected, and says nothing when something was deleted', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 50, 50).pic('b', 100, 0, 50, 50).lock('a'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.delete')
    expect(r.doc.items.map((i) => i.id)).toEqual([id.a])
    expect(r.s.selection).toEqual([id.a])
    expect(r.toasts('locked')).toHaveLength(0)
  })

  it('a locked item alone is refused with a message and no step', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 50, 50).lock('a'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.delete')
    r.key('Delete')
    r.key('Backspace')
    expect(r.doc.items).toHaveLength(1)
    expect(r.toasts('locked')).toHaveLength(3)
    expect(r.s.canUndo).toBe(false)
  })

  it('with nothing selected does nothing', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.delete')
    expect(r.doc).toBe(doc)
    expect(r.events).toHaveLength(0)
  })
})

describe('copy, cut and paste', () => {
  it('paste puts a copy 24 pixels away, then further for each paste, and selects it', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.c.exec('edit.copy')
    expect(r.s.canPaste).toBe(true)
    expect(r.doc.items).toHaveLength(3)
    r.c.exec('edit.paste')
    r.c.exec('edit.paste')
    expect(r.doc.items).toHaveLength(5)
    expect(r.doc.items[3]).toMatchObject({ x: -276, y: -76 })
    expect(r.doc.items[4]).toMatchObject({ x: -252, y: -52 })
    expect(r.s.selection).toEqual([r.doc.items[4]!.id])
    expect(id.a).toBeGreaterThan(0)
    expect(r.s.undoLabel).toBe('Paste')
  })

  it('works across the original being deleted, and lands where the view is when the original was out of sight', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.c.exec('edit.copy')
    r.c.setView({ x: 5000, y: 3000, zoom: 1 })
    r.c.exec('edit.paste')
    expect(r.doc.items[3]).toMatchObject({ x: 5000, y: 3000 })
  })

  it('cut removes the free items and keeps them for paste', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.cut')
    expect(r.doc.items).toHaveLength(0)
    r.c.exec('edit.paste')
    expect(r.doc.items).toHaveLength(3)
    expect(r.doc.items.map((i) => i.kind)).toEqual(['picture', 'picture', 'note'])
  })

  it('cut leaves a locked item where it is and does not put it on the clipboard', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 50, 50).pic('b', 100, 0, 50, 50).lock('a'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.cut')
    expect(r.doc.items).toHaveLength(1)
    r.c.exec('edit.paste')
    expect(r.doc.items).toHaveLength(2)
  })

  it('copy takes a locked item, and the pasted copy is free', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 50, 50).lock('a'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.copy')
    r.c.exec('edit.paste')
    expect(r.doc.items[0]!.locked).toBe(true)
    expect(r.doc.items[1]!.locked).toBe(false)
  })

  it('keeps a group a group, as a new one', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 50, 50).pic('b', 100, 0, 50, 50).group('a', 'b'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.copy')
    r.c.exec('edit.paste')
    const g = r.doc.items.map((i) => i.group)
    expect(g[2]).toBe(g[3])
    expect(g[2]).not.toBe(g[0])
    expect(g[2]).toBeGreaterThan(0)
  })

  it('is not changed by edits to the originals afterwards', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 50, 50))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.copy')
    r.drag(at(0, 0), at(300, 0))
    r.c.setView({ x: 0, y: 0, zoom: 1 })
    r.c.exec('edit.paste')
    expect((r.doc.items[1] as PictureItem).x).toBe(24)
  })

  it('paste with an empty clipboard does nothing; copy of nothing keeps what was there', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.paste')
    expect(r.doc).toBe(doc)
    expect(r.s.canPaste).toBe(false)
    r.click(at(-300, -100))
    r.c.exec('edit.copy')
    r.c.exec('edit.selectNone')
    r.c.exec('edit.copy')
    expect(r.s.canPaste).toBe(true)
  })

  it('paste on a full board is refused', () => {
    let doc = emptyBoard('full')
    for (let i = 0; i < BOARD_LIMITS.items; i++) doc = addMark(doc, { kind: 'line', x1: i, y1: 0, x2: i + 1, y2: 5, color: 'ffffff', width: 2, arrow: false }).doc
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.copy')
    r.c.exec('edit.paste')
    expect(r.doc.items).toHaveLength(BOARD_LIMITS.items)
    expect(r.toasts('limit')).toHaveLength(1)
  })
})

describe('group, ungroup, lock, unlock', () => {
  it('group joins two or more and keeps the selection; ungroup splits them', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.group')
    const g = r.doc.items.map((i) => i.group)
    expect(g[0]).toBeGreaterThan(0)
    expect(new Set(g).size).toBe(1)
    expect(r.s.selection).toEqual([id.a, id.b, id.n])
    r.c.exec('edit.ungroup')
    expect(r.doc.items.map((i) => i.group)).toEqual([0, 0, 0])
    r.c.exec('edit.undo')
    expect(new Set(r.doc.items.map((i) => i.group)).size).toBe(1)
  })

  it('a single item cannot be grouped', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.c.exec('edit.group')
    expect(r.doc).toBe(doc)
    expect(r.s.canUndo).toBe(false)
  })

  it('a click on a grouped item then selects the group', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.group')
    r.c.exec('edit.selectNone')
    r.click(at(-300, -100))
    expect(r.s.selection).toEqual([id.a, id.b, id.n])
  })

  it('lock refuses changes until unlock, and unlock works on a locked selection', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.c.exec('edit.lock')
    expect(r.item(id.a).locked).toBe(true)
    r.c.exec('transform.flipH')
    r.c.exec('edit.delete')
    r.key('ArrowRight')
    expect((pic(r, id.a)).flipH).toBe(false)
    expect(r.doc.items).toHaveLength(3)
    expect(r.toasts('locked')).toHaveLength(3)
    r.c.exec('edit.unlock')
    expect(r.item(id.a).locked).toBe(false)
    r.c.exec('transform.flipH')
    expect(pic(r, id.a).flipH).toBe(true)
  })

  it('lock and unlock are history steps', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.c.exec('edit.lock')
    r.c.exec('edit.undo')
    expect(r.item(id.a).locked).toBe(false)
    r.c.exec('edit.redo')
    expect(r.item(id.a).locked).toBe(true)
  })
})

/* -------------------------------------------------------------------- order --- */

describe('order commands', () => {
  const ids = (r: Rig) => r.doc.items.map((i) => i.id)

  it('front, back, forward and backward', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100).pic('b', 20, 20, 100, 100).pic('c', 40, 40, 100, 100))
    const r = new Rig(doc)
    r.click(at(-40, -40))
    expect(r.s.selection).toEqual([id.a])
    r.c.exec('order.front')
    expect(ids(r)).toEqual([id.b, id.c, id.a])
    r.c.exec('order.back')
    expect(ids(r)).toEqual([id.a, id.b, id.c])
    r.c.exec('order.forward')
    expect(ids(r)).toEqual([id.b, id.a, id.c])
    r.c.exec('order.backward')
    expect(ids(r)).toEqual([id.a, id.b, id.c])
    expect(r.s.selection).toEqual([id.a])
    expect(r.s.undoLabel).toBe('Move backward')
  })

  it('with the keys', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100).pic('b', 20, 20, 100, 100).pic('c', 40, 40, 100, 100))
    const r = new Rig(doc)
    r.click(at(-40, -40))
    r.key(']', { ctrl: true })
    expect(ids(r)).toEqual([id.b, id.c, id.a])
    r.key('[', { ctrl: true })
    expect(ids(r)).toEqual([id.a, id.b, id.c])
    r.key(']')
    expect(ids(r)).toEqual([id.b, id.a, id.c])
    r.key('[')
    expect(ids(r)).toEqual([id.a, id.b, id.c])
  })

  it('does nothing at the end of the stack and records nothing', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 100, 100).pic('b', 20, 20, 100, 100))
    const r = new Rig(doc)
    r.click(at(40, 40))
    r.c.exec('order.front')
    expect(r.doc).toBe(doc)
    expect(r.s.canUndo).toBe(false)
  })
})

/* ---------------------------------------------------------------- transform --- */

describe('transform commands', () => {
  it('flips a lone picture in place and a pair about the middle of both', () => {
    const { doc, id } = build((b) => b.pic('a', -100, 0, 100, 100).pic('b', 200, 0, 100, 100))
    const r = new Rig(doc)
    r.click(at(-100, 0))
    r.c.exec('transform.flipH')
    expect(pic(r, id.a)).toMatchObject({ x: -100, flipH: true, flipV: false })
    r.c.exec('transform.flipV')
    expect(pic(r, id.a)).toMatchObject({ flipH: true, flipV: true })
    r.c.exec('edit.undo')
    r.c.exec('edit.undo')
    r.c.exec('edit.selectAll')
    r.c.exec('transform.flipH')
    // About the middle of both, x = 50: -100 goes to 200 and 200 to -100.
    expect(pic(r, id.a).x).toBe(200)
    expect(pic(r, id.b).x).toBe(-100)
  })

  it('rotates by 90 degrees about the middle of the selection, with the keys', () => {
    const { doc, id } = build((b) => b.pic('a', -100, 0, 100, 50).pic('b', 100, 0, 100, 50))
    const r = new Rig(doc)
    r.click(at(-100, 0))
    r.key('r', { ctrl: true })
    expect(pic(r, id.a)).toMatchObject({ rotation: 90, x: -100, y: 0 })
    r.key('r', { ctrl: true, shift: true })
    r.key('r', { ctrl: true, shift: true })
    expect(pic(r, id.a).rotation).toBe(-90)
  })

  it('a pair swings round the middle of both', () => {
    const { doc, id } = build((b) => b.pic('a', -100, 0, 100, 50).pic('b', 100, 0, 100, 50))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('transform.rotateCw')
    expect(pic(r, id.a).rotation).toBe(90)
    expect(pic(r, id.a).x).toBeCloseTo(0, 9)
    expect(pic(r, id.a).y).toBeCloseTo(-100, 9)
    expect(pic(r, id.b).x).toBeCloseTo(0, 9)
    expect(pic(r, id.b).y).toBeCloseTo(100, 9)
    r.c.exec('transform.rotateCcw')
    expect(pic(r, id.a)).toMatchObject({ rotation: 0, x: -100, y: 0 })
  })

  it('four quarter turns bring a picture back exactly', () => {
    const { doc, id } = build((b) => b.pic('a', 30, 40, 120, 70).pic('b', 300, 10, 80, 50))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    for (let i = 0; i < 4; i++) r.c.exec('transform.rotateCw')
    expect(pic(r, id.a)).toMatchObject({ x: 30, y: 40, rotation: 0 })
    expect(pic(r, id.b)).toMatchObject({ x: 300, y: 10, rotation: 0 })
  })

  it('reset rotation turns pictures and notes back upright', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 50, { rotation: 33 }).note('n', 300, 0, 200, 'x', { rotation: -70 }))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('transform.resetRotation')
    expect(pic(r, id.a).rotation).toBe(0)
    expect(r.item<NoteItem>(id.n).rotation).toBe(0)
  })

  it('reset size shows a picture at its own pixel size, about its centre, when that is known', () => {
    const { doc, id } = build((b) => b.pic('a', 10, 20, 100, 50).pic('b', 300, 0, 100, 50))
    const r = new Rig(doc)
    r.c.setNaturalSize('a.png', 640, 320)
    r.c.exec('edit.selectAll')
    r.c.exec('transform.resetScale')
    expect(pic(r, id.a)).toMatchObject({ x: 10, y: 20, w: 640, h: 320 })
    // b's size is not known: it stays.
    expect(pic(r, id.b)).toMatchObject({ w: 100, h: 50 })
  })

  it('reset crop shows the whole picture again without moving what was shown', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100, { crop: { l: 0.25, t: 0, r: 0.75, b: 1 } }))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    const before = itemBounds(pic(r, id.a), M)
    r.c.exec('transform.resetCrop')
    expect(pic(r, id.a).crop).toEqual({ l: 0, t: 0, r: 1, b: 1 })
    const after = itemBounds(pic(r, id.a), M)
    expect(after.w).toBeCloseTo(200, 9)
    // The part that was shown is in the middle of the whole picture, where it was.
    expect(after.x + after.w / 2).toBeCloseTo(before.x + before.w / 2, 9)
  })

  it('reset all does rotation, size, crop, flips and opacity together, as one step', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 50, { rotation: 20, flipH: true, flipV: true, opacity: 0.4, crop: { l: 0, t: 0, r: 0.5, b: 1 } }))
    const r = new Rig(doc)
    r.c.setNaturalSize('a.png', 200, 100)
    r.c.exec('edit.selectAll')
    r.c.exec('transform.resetAll')
    expect(pic(r, id.a)).toMatchObject({ rotation: 0, flipH: false, flipV: false, opacity: 1, w: 200, h: 100, crop: { l: 0, t: 0, r: 1, b: 1 } })
    r.c.exec('edit.undo')
    expect(pic(r, id.a)).toMatchObject({ rotation: 20, flipH: true, opacity: 0.4 })
    expect(r.s.canUndo).toBe(false)
  })

  it('nothing is done to nothing', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    for (const id of ['transform.flipH', 'transform.rotateCw', 'transform.resetAll', 'order.front', 'edit.group'] as const) r.c.exec(id)
    expect(r.doc).toBe(doc)
  })
})

/* ------------------------------------------------------------------- arrange --- */

describe('arrange commands', () => {
  it('lay the selection out with the arrange functions, aiming at the shape of the canvas', () => {
    for (const mode of ['optimal', 'row', 'column', 'grid', 'stack'] as const) {
      const { doc } = fourPictures()
      const r = new Rig(doc)
      r.c.exec('edit.selectAll')
      r.c.exec(`arrange.${mode}` as BoardCommandId)
      const want = arrange(doc, doc.items.map((i) => i.id), mode, { metrics: M, aspect: 1000 / 800 })
      expect(r.doc.items, mode).toEqual(want.items)
      expect(r.s.undoLabel, mode).toBe('Arrange')
      r.c.exec('edit.undo')
      expect(r.doc.items, mode).toEqual(doc.items)
    }
  })

  it('a row is one line with a gap of 16 between neighbours', () => {
    const { doc, id } = fourPictures()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('arrange.row')
    const ps = [id.a, id.b, id.c, id.d].map((i) => itemBounds(pic(r, i!), M))
    for (const b of ps) expect(b.y + b.h / 2).toBeCloseTo(ps[0]!.y + ps[0]!.h / 2, 9)
    const sorted = [...ps].sort((p, q) => p.x - q.x)
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.x - (sorted[i - 1]!.x + sorted[i - 1]!.w)).toBeCloseTo(16, 9)
  })

  it('with fewer than two items selected they take every picture and note, and no mark', () => {
    const { doc, id } = build((b) => b.pic('a', -300, 0, 100, 100).pic('b', 300, 200, 100, 100).note('n', 0, 400, 100, 'x').line('l', 0, 0, 50, 50))
    const r = new Rig(doc)
    r.click(at(-300, 0))
    r.c.exec('arrange.row')
    const a = itemBounds(pic(r, id.a), M)
    const b = itemBounds(pic(r, id.b), M)
    expect(a.y + a.h / 2).toBeCloseTo(b.y + b.h / 2, 9)
    expect(r.item<LineItem>(id.l)).toMatchObject({ x1: 0, y1: 0, x2: 50, y2: 50 })
  })

  it('says what it did', () => {
    const { doc } = fourPictures()
    const r = new Rig(doc)
    r.c.exec('arrange.grid')
    expect(r.toasts()).toHaveLength(1)
    expect((r.toasts()[0] as { text: string }).text).toBe('Arranged 4 items in a grid.')
    r.c.exec('sort.size')
    expect((r.toasts()[1] as { text: string }).text).toBe('Sorted 4 items by size.')
  })

  it('sort commands lay the items out in that order', () => {
    const { doc } = build((b) => b.pic('c', 0, 0, 100, 100).pic('a', 300, 0, 100, 100).pic('b', 600, 0, 100, 100))
    for (const [cmd, order] of [
      ['sort.name', 'name'],
      ['sort.added', 'added'],
      ['sort.size', 'size'],
    ] as const) {
      const r = new Rig(doc)
      r.c.exec(cmd)
      const want = arrange(doc, doc.items.map((i) => i.id), 'optimal', { metrics: M, aspect: 1.25, order })
      expect(r.doc.items, cmd).toEqual(want.items)
    }
    const r = new Rig(doc)
    r.c.exec('sort.name')
    const at_ = (n: string) => r.doc.items.find((i) => (i as PictureItem).path === `${n}.png`) as PictureItem
    // In reading order (rows from the top, left to right) a comes before b before c.
    const before = (p: PictureItem, q: PictureItem) => p.y < q.y - 1e-9 || (Math.abs(p.y - q.y) < 1e-9 && p.x < q.x)
    expect(before(at_('a'), at_('b'))).toBe(true)
    expect(before(at_('b'), at_('c'))).toBe(true)
  })

  it('shuffle differs from call to call and is the same for the same clock', () => {
    const items = Array.from({ length: 12 }, (_, i) => i)
    const { doc } = build((b) => {
      for (const i of items) b.pic(`p${i}`, i * 150, 0, 100, 100)
    })
    const a = new Rig(doc)
    const b = new Rig(doc)
    a.c.exec('sort.shuffle')
    b.c.exec('sort.shuffle')
    expect(a.doc.items).toEqual(b.doc.items)
    const first = a.doc.items
    a.c.exec('sort.shuffle')
    expect(a.doc.items).not.toEqual(first)
  })

  it('aligns and distributes the selection; a selection that is too small is told so', () => {
    const { doc, id } = fourPictures()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.c.exec('align.left')
    expect(r.toasts('select')).toHaveLength(1)
    expect(r.doc).toBe(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('align.left')
    const lefts = [id.a, id.b, id.c, id.d].map((i) => itemBounds(pic(r, i!), M).x)
    for (const x of lefts) expect(x).toBeCloseTo(lefts[0]!, 9)
    expect(r.s.undoLabel).toBe('Align')
    r.c.exec('edit.undo')
    r.c.exec('align.centerV')
    const mids = [id.a, id.b, id.c, id.d].map((i) => itemBounds(pic(r, i!), M)).map((b) => b.y + b.h / 2)
    for (const y of mids) expect(y).toBeCloseTo(mids[0]!, 9)
  })

  it('distribute needs three, align needs two, and each says how many', () => {
    const { doc } = fourPictures()
    const r = new Rig(doc)
    r.click(at(-300, -100))
    r.click(at(250, -100), { shift: true })
    expect(r.s.selection).toHaveLength(2)
    r.forget()
    r.c.exec('distribute.h')
    r.c.exec('distribute.v')
    expect(r.toasts('select').map((e) => (e as { text: string }).text)).toEqual(['Select at least 3 items first.', 'Select at least 3 items first.'])
    expect(r.doc).toBe(doc)
    r.c.exec('align.top')
    expect(r.s.undoLabel).toBe('Align')
    r.c.exec('edit.selectNone')
    r.click(at(-300, -100))
    r.c.exec('normalize.width')
    expect((r.toasts('select')[2] as { text: string }).text).toBe('Select at least 2 items first.')
  })

  it('distribute spreads three items evenly', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100).pic('b', 150, 0, 100, 100).pic('c', 600, 0, 100, 100))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('distribute.h')
    expect(pic(r, id.b).x).toBe(300)
    expect(pic(r, id.a).x).toBe(0)
    expect(pic(r, id.c).x).toBe(600)
  })

  it('normalize makes pictures the same width, height or size, or their own size', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100).pic('b', 300, 0, 300, 150))
    const r = new Rig(doc)
    r.c.setNaturalSize('a.png', 50, 50)
    r.c.setNaturalSize('b.png', 600, 300)
    r.c.exec('edit.selectAll')
    r.c.exec('normalize.width')
    expect(pic(r, id.a).w).toBeCloseTo(200, 9)
    expect(pic(r, id.b).w).toBeCloseTo(200, 9)
    r.c.exec('normalize.height')
    expect(pic(r, id.a).h).toBeCloseTo(pic(r, id.b).h, 9)
    r.c.exec('normalize.size')
    expect(pic(r, id.a).w * pic(r, id.a).h).toBeCloseTo(pic(r, id.b).w * pic(r, id.b).h, 6)
    r.c.exec('normalize.scale')
    expect(pic(r, id.a).w).toBeCloseTo(50, 9)
    expect(pic(r, id.a).h).toBeCloseTo(50, 9)
    expect(pic(r, id.b).w).toBeCloseTo(600, 9)
    expect(pic(r, id.b).h).toBeCloseTo(300, 9)
  })

  it('locked items stay where they are, and a locked selection is told so', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 100, 100).pic('b', 300, 0, 100, 100).pic('c', 600, 0, 100, 100).lock('a'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('arrange.column')
    expect(pic(r, id.a)).toMatchObject({ x: 0, y: 0 })
    const locked = build((b) => b.pic('a', 0, 0, 100, 100).pic('b', 300, 0, 100, 100).lock('a', 'b'))
    const r2 = new Rig(locked.doc)
    r2.c.exec('edit.selectAll')
    r2.c.exec('arrange.column')
    expect(r2.doc).toBe(locked.doc)
    expect(r2.toasts('locked')).toHaveLength(1)
  })

  it('arrange takes options as an argument', () => {
    const { doc } = fourPictures()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('arrange.grid', { columns: 2, gap: 40 })
    const want = arrange(doc, doc.items.map((i) => i.id), 'grid', { metrics: M, aspect: 1.25, columns: 2, gap: 40 })
    expect(r.doc.items).toEqual(want.items)
    r.c.exec('arrange.row', 'nonsense')
    r.c.exec('arrange.row', { gap: NaN, columns: 'x' })
  })
})

/* --------------------------------------------------------------- appearance --- */

describe('appearance commands', () => {
  it('grey, smooth and captions toggle, each as an undoable step', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.key('g')
    expect(r.doc.gray).toBe(true)
    r.key('s')
    expect(r.doc.smooth).toBe(false)
    r.key('n')
    expect(r.doc.captions).toBe(true)
    r.c.exec('edit.undo')
    r.c.exec('edit.undo')
    r.c.exec('edit.undo')
    expect(r.doc.gray).toBe(false)
    expect(r.doc.smooth).toBe(true)
    expect(r.doc.captions).toBe(false)
    expect(r.s.dirty).toBe(false)
  })

  it('grey for the selected pictures greys them all, then colours them all', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 50, 50, { gray: true }).pic('b', 100, 0, 50, 50).note('n', 200, 0, 100, 'x'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.key('g', { shift: true })
    expect(pic(r, id.a).gray && pic(r, id.b).gray).toBe(true)
    r.key('g', { shift: true })
    expect(pic(r, id.a).gray || pic(r, id.b).gray).toBe(false)
  })

  it('the background steps through dark, mid, light, black and white and round again', () => {
    const r = new Rig(emptyBoard('t'))
    const seen = [r.doc.bg]
    for (let i = 0; i < 5; i++) {
      r.key('b')
      seen.push(r.doc.bg)
    }
    expect(seen).toEqual(['14161d', '808080', 'd6d6d6', '000000', 'ffffff', '14161d'])
    expect(BOARD_BACKGROUNDS.map((b) => b.hex)).toEqual(seen.slice(0, 5))
  })

  it('an unknown background goes to the first; a colour as the argument is taken as it is', () => {
    const r = new Rig({ ...emptyBoard('t'), bg: '123456' })
    r.c.exec('view.background')
    expect(r.doc.bg).toBe('14161d')
    r.c.exec('view.background', '#AA55CC')
    expect(r.doc.bg).toBe('aa55cc')
    r.c.exec('view.background', 'not a colour')
    expect(r.doc.bg).toBe('14161d')
  })

  it('shift S turns snapping to a 16 unit grid on and off', () => {
    const r = new Rig(emptyBoard('t'))
    r.key('s', { shift: true })
    expect(r.doc.grid).toBe(16)
    r.key('s', { shift: true })
    expect(r.doc.grid).toBe(0)
  })

  it('the opacity keys step selected pictures by 0.1, each from its own value, within 0.05 and 1', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 50, 50, { opacity: 0.55 }).pic('b', 100, 0, 50, 50).note('n', 200, 0, 100, 'x'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.key('[', { alt: true })
    expect(pic(r, id.a).opacity).toBeCloseTo(0.45, 9)
    expect(pic(r, id.b).opacity).toBeCloseTo(0.9, 9)
    for (let i = 0; i < 20; i++) r.key('[', { alt: true })
    expect(pic(r, id.a).opacity).toBe(0.05)
    expect(pic(r, id.b).opacity).toBe(0.05)
    for (let i = 0; i < 20; i++) r.key(']', { alt: true })
    expect(pic(r, id.a).opacity).toBe(1)
  })

  it('a run of opacity presses is one step', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 50, 50))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    for (let i = 0; i < 4; i++) {
      r.clock += 100
      r.key('[', { alt: true })
    }
    expect(pic(r, id.a).opacity).toBeCloseTo(0.6, 9)
    r.c.exec('edit.undo')
    expect(pic(r, id.a).opacity).toBe(1)
  })

  it('opacity leaves locked pictures alone', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 50, 50).lock('a'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('item.opacityDown')
    expect(pic(r, id.a).opacity).toBe(1)
    expect(r.toasts('locked')).toHaveLength(1)
  })
})

/* ------------------------------------------------------- the shell's commands --- */

describe('commands the shell carries out', () => {
  it('picture commands name the selected pictures and their distinct paths', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 50, 50).pic('b', 100, 0, 50, 50).note('n', 200, 0, 100, 'x'))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    for (const cmd of ['picture.open', 'picture.reveal', 'picture.showInBrain', 'picture.info'] as const) {
      r.forget()
      r.c.exec(cmd)
      expect(r.events).toEqual([{ type: 'command', id: cmd, ids: [id.a, id.b], paths: ['a.png', 'b.png'] }])
    }
  })

  it('two copies of one picture are one path', () => {
    const { doc } = build((b) => b.pic('a', 0, 0, 50, 50))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('edit.duplicate')
    r.c.exec('edit.selectAll')
    r.forget()
    r.c.exec('picture.open')
    expect(r.eventsOf('command')[0]!.paths).toEqual(['a.png'])
  })

  it('without a picture selected they say so', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('picture.open')
    r.click(at(0, 250))
    r.c.exec('picture.reveal')
    expect(r.eventsOf('command')).toHaveLength(0)
    expect(r.toasts('select')).toHaveLength(2)
  })

  it('add, export and window commands are handed over as they are', () => {
    const { doc, id } = threeThings()
    const r = new Rig(doc)
    r.c.exec('picture.add')
    r.c.exec('window.popOut')
    r.c.exec('window.dock')
    r.c.exec('window.onTop')
    r.c.exec('export.board')
    expect(r.eventsOf('command').map((e) => e.id)).toEqual(['picture.add', 'window.popOut', 'window.dock', 'window.onTop', 'export.board'])
    expect(r.eventsOf('command')[4]!.ids).toEqual([id.a, id.b, id.n])
    r.forget()
    r.c.exec('export.selection')
    expect(r.eventsOf('command')).toHaveLength(0)
    r.click(at(0, 250))
    r.c.exec('export.selection')
    expect(r.eventsOf('command')).toEqual([{ type: 'command', id: 'export.selection', ids: [id.n], paths: [] }])
  })

  it('none of them changes the board', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    for (const c of BOARD_COMMANDS.filter((c) => /^(picture|export|window)\./.test(c.id))) r.c.exec(c.id)
    expect(r.doc).toBe(doc)
    expect(r.s.canUndo).toBe(false)
  })
})

describe('colour palette', () => {
  it('asks the shell for the pictures selected, with a place for the swatches under them', () => {
    const { doc, id } = build((b) => b.pic('a', 0, 0, 200, 100).pic('b', 300, 0, 200, 100))
    const r = new Rig(doc)
    r.c.exec('edit.selectAll')
    r.c.exec('picture.palette')
    expect(r.eventsOf('palette-request')).toEqual([{ type: 'palette-request', ids: [id.a, id.b], near: { x: 150, y: 50 + 16 } }])
  })

  it('without a picture it says so', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('picture.palette')
    expect(r.eventsOf('palette-request')).toHaveLength(0)
    expect(r.toasts('select')).toHaveLength(1)
  })

  it('addSwatches puts small notes in a row centred on the place, filled with the colours and labelled', () => {
    const r = new Rig(emptyBoard('t'))
    const ids = r.c.addSwatches(['FF0000', '#00ff00', '0000ff', 'ff0000', 'nonsense'], { x: 100, y: 300 })
    expect(ids).toHaveLength(3)
    const notes = ids.map((i) => r.item<NoteItem>(i))
    expect(notes.map((n) => n.text)).toEqual(['#ff0000', '#00ff00', '#0000ff'])
    expect(notes.map((n) => n.fill)).toEqual(['ff0000', '00ff00', '0000ff'])
    expect(notes.map((n) => n.color)).toEqual(['ff0000', '00ff00', '0000ff'].map(textColourOn))
    expect(new Set(notes.map((n) => n.y)).size).toBe(1)
    const bounds = notes.map((n) => itemBounds(n, M))
    expect(Math.min(...bounds.map((b) => b.y))).toBeCloseTo(300, 9)
    const left = Math.min(...bounds.map((b) => b.x))
    const right = Math.max(...bounds.map((b) => b.x + b.w))
    expect((left + right) / 2).toBeCloseTo(100, 9)
    for (let i = 1; i < bounds.length; i++) expect(bounds[i]!.x).toBeGreaterThan(bounds[i - 1]!.x + bounds[i - 1]!.w)
    expect(r.s.selection).toEqual(ids)
    expect(r.s.undoLabel).toBe('Add colours')
    r.c.exec('edit.undo')
    expect(r.doc.items).toHaveLength(0)
  })

  it('the swatches are sized for the zoom and capped at 16', () => {
    const r = new Rig(emptyBoard('t'))
    r.c.setView({ x: 0, y: 0, zoom: 2 })
    const colours = Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(2, '0').repeat(3))
    const ids = r.c.addSwatches(colours, { x: 0, y: 0 })
    expect(ids).toHaveLength(16)
    expect(r.item<NoteItem>(ids[0]!).size).toBe(7)
  })

  it('nothing for no colours or a bad place', () => {
    const r = new Rig(emptyBoard('t'))
    expect(r.c.addSwatches([], { x: 0, y: 0 })).toEqual([])
    expect(r.c.addSwatches(['ff0000'], { x: NaN, y: 0 })).toEqual([])
    expect(r.s.canUndo).toBe(false)
  })

  it('a swatch note is a note like any other: it can be edited', () => {
    const r = new Rig(emptyBoard('t'))
    const [id] = r.c.addSwatches(['ff0000'], { x: 0, y: 0 })
    r.c.commitNoteText(id!, 'rust')
    expect(r.item<NoteItem>(id!).text).toBe('rust')
    const kinds: BoardItem['kind'][] = r.doc.items.map((i) => i.kind)
    expect(kinds).toEqual(['note'])
  })
})
