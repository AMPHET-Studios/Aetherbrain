/**
 * The review round of the board's geometry, operations and arranging (geometry-1, geometry-m1, geometry-m2, geometry-m10,
 * controller-pointer-m6, live-docked-m7 part 3).
 */
import { describe, expect, it } from 'vitest'
import { hitTest, itemBounds, itemsInRect, pointInItem, selectionBounds } from '../src/board/geometry'
import { BOARD_ITEM_LIMITS, addMark, addPicture, clampDoc, duplicateItems, insertItems, moveItems, rotateItems, scaleItems } from '../src/board/ops'
import { align, arrange } from '../src/board/arrange'
import { estimateTextMetrics } from '../src/board/text'
import { BOARD_LIMITS, FULL_CROP, emptyBoard } from '../src/board/types'
import type { BoardDoc, BoardItem, LineItem, PictureItem, RectItem, StrokeItem, Vec2 } from '../src/board/types'

const M = estimateTextMetrics
const L = BOARD_LIMITS.coordinate

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pic(id: number, x: number, y: number, w: number, h: number, over: Partial<PictureItem> = {}): PictureItem {
  return { id, group: 0, locked: false, kind: 'picture', path: `p${id}.png`, x, y, w, h, rotation: 0, crop: { ...FULL_CROP }, flipH: false, flipV: false, gray: false, opacity: 1, caption: '', ...over }
}
function rect(id: number, x1: number, y1: number, x2: number, y2: number, over: Partial<RectItem> = {}): RectItem {
  return { id, group: 0, locked: false, kind: 'rect', x1, y1, x2, y2, color: 'ffffff', width: 4, fill: '', ...over }
}
function line(id: number, x1: number, y1: number, x2: number, y2: number, over: Partial<LineItem> = {}): LineItem {
  return { id, group: 0, locked: false, kind: 'line', x1, y1, x2, y2, color: 'ffffff', width: 4, arrow: false, ...over }
}
function stroke(id: number, points: number[], over: Partial<StrokeItem> = {}): StrokeItem {
  return { id, group: 0, locked: false, kind: 'stroke', points, color: 'ffffff', width: 2, ...over }
}
function docOf(...items: BoardItem[]): BoardDoc {
  return { ...emptyBoard('T'), items, nextId: items.reduce((m, it) => Math.max(m, it.id), 0) + 1 }
}
const byId = (doc: BoardDoc, id: number): BoardItem => doc.items.find((it) => it.id === id)!

/* ================================================================ geometry-1 === */

describe('geometry-1: Rotate 90 turns a frame round a picture with it', () => {
  const frame = (): BoardDoc => ({ ...docOf(pic(1, 0, 0, 400, 200), rect(2, -212, -112, 212, 112)), items: [pic(1, 0, 0, 400, 200, { group: 1 }), rect(2, -212, -112, 212, 112, { group: 1 })] })
  const encloses = (doc: BoardDoc, outer: number, inner: number): boolean => {
    const a = itemBounds(byId(doc, outer), M)
    const b = itemBounds(byId(doc, inner), M)
    return a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h
  }

  it('with exactQuarter a rectangle swaps its half-extents about its rotated centre, so the frame still encloses the picture', () => {
    const d = frame()
    expect(encloses(d, 2, 1)).toBe(true)
    for (const deg of [90, -90, 270, 450]) {
      const turned = rotateItems(d, [1, 2], deg, { x: 0, y: 0 }, { exactQuarter: true })
      expect(byId(turned, 1)).toMatchObject({ w: 400, h: 200 })
      expect(byId(turned, 2)).toMatchObject({ x1: -112, x2: 112, y1: -212, y2: 212 })
      expect(encloses(turned, 2, 1), String(deg)).toBe(true)
    }
    // Half a turn needs no swap, but the centre swings.
    const half = rotateItems(d, [1, 2], 180, { x: 50, y: 0 }, { exactQuarter: true })
    expect(byId(half, 2)).toMatchObject({ x1: -112, x2: 312, y1: -112, y2: 112 })
    expect(encloses(half, 2, 1)).toBe(true)
  })

  it('an ellipse does the same, and a shape off the pivot goes to its rigidly rotated place at its turned size', () => {
    const e: BoardItem = { id: 2, group: 0, locked: false, kind: 'ellipse', x1: -300, y1: -150, x2: 300, y2: 150, color: 'ffffff', width: 2, fill: '' }
    const turned = rotateItems(docOf(e), [2], 90, { x: 0, y: 0 }, { exactQuarter: true })
    expect(byId(turned, 2)).toMatchObject({ x1: -150, x2: 150, y1: -300, y2: 300 })
    // (120,-40)-(300,40) about (100,0) clockwise: centre (210,0) goes to (100,110); it was 180 by 80, it is 80 by 180.
    const off = rotateItems(docOf(rect(3, 120, -40, 300, 40)), [3], 90, { x: 100, y: 0 }, { exactQuarter: true })
    expect(byId(off, 3)).toMatchObject({ x1: 60, y1: 20, x2: 140, y2: 200 })
  })

  it('four quarter turns bring everything back exactly', () => {
    const r = rng(11)
    for (let n = 0; n < 50; n++) {
      const d = docOf(pic(1, r() * 500 - 250, r() * 500 - 250, 100 + r() * 300, 80 + r() * 200), rect(2, r() * 400 - 200, r() * 400 - 200, r() * 400 - 200, r() * 400 - 200), line(3, 1, 2, 30, 40), stroke(4, [1, 2, 3, 4, 5, 9]))
      const pivot: Vec2 = { x: Math.round(r() * 100), y: Math.round(r() * 100) }
      let t = d
      for (let k = 0; k < 4; k++) t = rotateItems(t, [1, 2, 3, 4], 90, pivot, { exactQuarter: true })
      const rb = byId(d, 2) as RectItem
      const back = byId(t, 2) as RectItem
      expect([Math.min(back.x1, back.x2), Math.max(back.x1, back.x2), Math.min(back.y1, back.y2), Math.max(back.y1, back.y2)]).toEqual([Math.min(rb.x1, rb.x2), Math.max(rb.x1, rb.x2), Math.min(rb.y1, rb.y2), Math.max(rb.y1, rb.y2)])
      expect(byId(t, 1)).toMatchObject({ x: (byId(d, 1) as PictureItem).x, y: (byId(d, 1) as PictureItem).y, rotation: 0 })
      expect(byId(t, 4)).toEqual(byId(d, 4))
    }
  })

  it('a drag rotation (no option) and any angle that is not a quarter turn keep shapes upright, so nothing jumps at 90', () => {
    const d = frame()
    for (const deg of [90, 75, 105, 30]) {
      const turned = rotateItems(d, [1, 2], deg, { x: 0, y: 0 })
      const r = byId(turned, 2) as RectItem
      expect([r.x2 - r.x1, r.y2 - r.y1]).toEqual([424, 224])
    }
    const free = rotateItems(d, [1, 2], 30, { x: 0, y: 0 }, { exactQuarter: true })
    const f = byId(free, 2) as RectItem
    expect([f.x2 - f.x1, f.y2 - f.y1]).toEqual([424, 224])
  })
})

/* ================================================================ geometry-m1 === */

describe('geometry-m1 / renderer-cache-m1: an arrow\'s head is part of the item', () => {
  /** The head as the renderer draws it (renderer.ts drawMark): tip, base of 4 line widths (at most 0.8 of the line), flaps half as wide. */
  function head(it: LineItem): Vec2[] {
    const dx = it.x2 - it.x1
    const dy = it.y2 - it.y1
    const len = Math.hypot(dx, dy)
    const h = Math.min(4 * it.width, len * 0.8)
    const ux = dx / len
    const uy = dy / len
    const bx = it.x2 - ux * h
    const by = it.y2 - uy * h
    return [
      { x: it.x2, y: it.y2 },
      { x: bx - uy * h * 0.5, y: by + ux * h * 0.5 },
      { x: bx + uy * h * 0.5, y: by - ux * h * 0.5 },
    ]
  }

  it('the bounds, the selection box and the fit include the head', () => {
    const a = line(1, 0, 0, 200, 0, { width: 10, arrow: true })
    const b = itemBounds(a, M)
    // Head 40 long, flaps at x=160, y=+-20; the line itself is 10 thick.
    expect(b).toMatchObject({ x: -5, y: -20, w: 210, h: 40 })
    expect(selectionBounds(docOf(a), [1], M)).toMatchObject({ y: -20, h: 40 })
    // Without the head it is only the line.
    expect(itemBounds({ ...a, arrow: false }, M)).toMatchObject({ y: -5, h: 10 })
  })

  it('every corner of the head is inside the bounds, for any direction (300 random arrows)', () => {
    const r = rng(5)
    for (let i = 0; i < 300; i++) {
      const a = line(1, r() * 400 - 200, r() * 400 - 200, r() * 400 - 200, r() * 400 - 200, { width: 0.5 + r() * 30, arrow: true })
      if (Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 1e-6) continue
      const b = itemBounds(a, M)
      for (const p of head(a)) {
        expect(p.x).toBeGreaterThanOrEqual(b.x - 1e-9)
        expect(p.x).toBeLessThanOrEqual(b.x + b.w + 1e-9)
        expect(p.y).toBeGreaterThanOrEqual(b.y - 1e-9)
        expect(p.y).toBeLessThanOrEqual(b.y + b.h + 1e-9)
      }
      // ...and the bounds are tight to within the line's own thickness.
      const body = itemBounds({ ...a, arrow: false }, M)
      const grown = Math.max(0, b.w - body.w) + Math.max(0, b.h - body.h)
      expect(grown).toBeLessThanOrEqual(2 * 4 * a.width + 1e-6)
    }
  })

  it('a point on the head but beside the shaft hits the line; a point past the head does not', () => {
    const a = line(1, 0, 0, 200, 0, { width: 10, arrow: true })
    const d = docOf(a)
    expect(pointInItem(a, { x: 165, y: 12 }, 0, M)).toBe(true)
    expect(pointInItem(a, { x: 160, y: 20 }, 0, M)).toBe(true)
    expect(pointInItem(a, { x: 160, y: -20 }, 0, M)).toBe(true)
    expect(pointInItem(a, { x: 190, y: 12 }, 0, M)).toBe(false)
    expect(pointInItem(a, { x: 100, y: 12 }, 0, M)).toBe(false)
    expect(pointInItem(a, { x: 165, y: 20 }, 3, M)).toBe(true)
    expect(pointInItem(a, { x: 165, y: 24 }, 3, M)).toBe(false)
    expect(hitTest(d, { x: 165, y: 12 }, 0, M)?.id).toBe(1)
    // Without an arrow the flap is empty space.
    expect(pointInItem({ ...a, arrow: false }, { x: 165, y: 12 }, 0, M)).toBe(false)
  })

  it('a marquee that only touches the head takes the line', () => {
    const a = line(1, 0, 0, 200, 0, { width: 10, arrow: true })
    const d = docOf(a)
    const flap = { x: 158, y: 14, w: 4, h: 4 }
    expect(itemsInRect(d, flap, 'touch', M)).toEqual([1])
    expect(itemsInRect(docOf({ ...a, arrow: false }), flap, 'touch', M)).toEqual([])
    // A rectangle swallowed by the head's triangle.
    expect(itemsInRect(d, { x: 180, y: -1, w: 2, h: 2 }, 'touch', M)).toEqual([1])
    // 'contain' needs the whole head.
    expect(itemsInRect(d, { x: -6, y: -10, w: 212, h: 20 }, 'contain', M)).toEqual([])
    expect(itemsInRect(d, { x: -6, y: -21, w: 212, h: 42 }, 'contain', M)).toEqual([1])
  })

  it('a short arrow holds its head to 0.8 of its length, as drawn; a point-sized one has none', () => {
    const short = line(1, 0, 0, 10, 0, { width: 10, arrow: true })
    // Head is 8 long, flaps at x=2, y=+-4: inside the line's own thickness.
    expect(itemBounds(short, M)).toMatchObject({ x: -5, y: -5, w: 20, h: 10 })
    const dot = line(2, 5, 5, 5, 5, { width: 6, arrow: true })
    expect(itemBounds(dot, M)).toMatchObject({ w: 6, h: 6 })
    expect(pointInItem(dot, { x: 5, y: 5 }, 0, M)).toBe(true)
  })
})

/* ================================================================ geometry-m10 === */

describe('geometry-m10: a move never goes past the coordinate range, not even by one ulp', () => {
  it('moves that used to land a hair past the limit land on it', () => {
    // x + (L - x) rounds above L for these.
    for (const x of [-283716.40951024124, -450822.67975554976, -54613.81910403344]) {
      const moved = moveItems(docOf(line(1, x, 0, x + 1, 0)), [1], 2e6, 0)
      expect((byId(moved, 1) as LineItem).x2).toBeLessThanOrEqual(L)
      expect(Math.max((byId(moved, 1) as LineItem).x1, (byId(moved, 1) as LineItem).x2)).toBe(L)
    }
    for (const x of [907523.9005058383, 904255.830310908, 199784.21014056855]) {
      const moved = moveItems(docOf(line(1, x - 1, 0, x, 0)), [1], -2e6, 0)
      expect(Math.min((byId(moved, 1) as LineItem).x1, (byId(moved, 1) as LineItem).x2)).toBe(-L)
    }
    const up = moveItems(docOf(pic(1, -283716.40951024124, -283716.40951024124, 10, 10)), [1], 3e6, 3e6)
    expect(byId(up, 1)).toMatchObject({ x: L, y: L })
  })

  it('stays inside after any mix of moves, aligns and arranges near the edge, and clampDoc has nothing to change (300 boards)', () => {
    const r = rng(443)
    for (let n = 0; n < 300; n++) {
      let d = docOf(
        pic(1, (r() - 0.5) * 2e6, (r() - 0.5) * 2e6, 20 + r() * 300, 20 + r() * 300),
        pic(2, (r() - 0.5) * 2e6, (r() - 0.5) * 2e6, 20 + r() * 300, 20 + r() * 300),
        pic(3, (r() - 0.5) * 2e6, (r() - 0.5) * 2e6, 20 + r() * 300, 20 + r() * 300),
        line(4, (r() - 0.5) * 2e6, (r() - 0.5) * 2e6, (r() - 0.5) * 2e6, (r() - 0.5) * 2e6),
      )
      for (let k = 0; k < 6; k++) {
        const pick = Math.floor(r() * 5)
        const big = (): number => (r() - 0.5) * 6e6
        if (pick === 0) d = moveItems(d, [1, 2, 3, 4], big(), big())
        else if (pick === 1) d = align(d, [1, 2, 3], (['left', 'right', 'top', 'bottom', 'centerH', 'centerV'] as const)[Math.floor(r() * 6)]!)
        else if (pick === 2) d = arrange(d, [1, 2, 3], (['row', 'column', 'grid', 'optimal'] as const)[Math.floor(r() * 4)]!, { gap: r() * 5e5 })
        else if (pick === 3) d = scaleItems(d, [1, 2, 3, 4], 0.2 + r() * 4, { x: (r() - 0.5) * 2e6, y: 0 })
        else d = insertItems(d, d.items.slice(0, 2), { x: big(), y: big() }).doc
      }
      for (const it of d.items) {
        const xs = it.kind === 'picture' || it.kind === 'note' ? [it.x, it.y] : it.kind === 'stroke' ? it.points : [it.x1, it.y1, it.x2, it.y2]
        for (const v of xs) expect(Math.abs(v), `board ${n}`).toBeLessThanOrEqual(L)
      }
      expect(clampDoc(d).items.map((it) => JSON.stringify(it))).toEqual(d.items.map((it) => JSON.stringify(it)))
    }
  })
})

/* ================================================================ geometry-m2 === */

describe('geometry-m2: a layout wider than the board, and a paste at its edge', () => {
  const overlapping = (doc: BoardDoc): number => {
    const boxes = doc.items.map((it) => itemBounds(it, M)).sort((a, b) => a.x - b.x)
    let n = 0
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length && boxes[j]!.x < boxes[i]!.x + boxes[i]!.w; j++) {
        const a = boxes[i]!
        const b = boxes[j]!
        if (a.y < b.y + b.h && b.y < a.y + a.h) n++
      }
    }
    return n
  }
  const inside = (doc: BoardDoc): boolean => doc.items.every((it) => {
    const b = itemBounds(it, M)
    return b.x >= -L && b.y >= -L && b.x + b.w <= L && b.y + b.h <= L
  })

  it('1,500 natural-size pictures in a row or a column become the packed layout: no overlap, all inside the board', () => {
    const items = Array.from({ length: 1500 }, (_, i) => pic(i + 1, i, 0, 4000, 3000))
    const d = docOf(...items)
    const ids = items.map((it) => it.id)
    for (const mode of ['row', 'column'] as const) {
      const out = arrange(d, ids, mode)
      expect(out, mode).not.toBe(d)
      expect(overlapping(out), mode).toBe(0)
      expect(inside(out), mode).toBe(true)
    }
    // Grid and optimal were fine and still are.
    for (const mode of ['grid', 'optimal'] as const) {
      const out = arrange(d, ids, mode)
      expect(overlapping(out), mode).toBe(0)
      expect(inside(out), mode).toBe(true)
    }
  })

  it('200 pictures 40,000 wide in a row: the same', () => {
    const d = docOf(...Array.from({ length: 200 }, (_, i) => pic(i + 1, 0, 0, 40000, 400)))
    const out = arrange(d, d.items.map((it) => it.id), 'row')
    expect(overlapping(out)).toBe(0)
    expect(inside(out)).toBe(true)
  })

  it('a layout that fits is not changed into another, only moved to stay inside the board when its middle is at the edge', () => {
    const d = docOf(pic(1, 990000, 0, 5000, 100), pic(2, 995000, 0, 5000, 100), pic(3, 999000, 0, 5000, 100))
    const row = arrange(d, [1, 2, 3], 'row', { gap: 16 })
    expect(overlapping(row)).toBe(0)
    expect(inside(row)).toBe(true)
    // Still a row: one y.
    expect(new Set(row.items.map((it) => (it as PictureItem).y)).size).toBe(1)
    // Centred on the middle of where the pictures were when it fits there (250 is the middle of 0 and 500 with their sizes).
    const mid = docOf(pic(1, 0, 0, 100, 100), pic(2, 500, 0, 100, 100))
    const placed = arrange(mid, [1, 2], 'row', { gap: 16 })
    expect((byId(placed, 1) as PictureItem).x).toBeCloseTo(192, 9)
    expect((byId(placed, 2) as PictureItem).x).toBeCloseTo(308, 9)
  })

  it('a copy near the edge moves with ONE offset: the shape of a stroke or a pair of pictures is kept', () => {
    const s = stroke(1, [999900, 10, 999950, 20, 999999, 30])
    const dup = duplicateItems(docOf(s), [1], { x: 200, y: 0 })
    const copy = dup.doc.items[1] as StrokeItem
    expect(copy.points).toEqual([999901, 10, 999951, 20, 1000000, 30])
    // (Clamped one coordinate at a time, every point used to land on 1,000,000.)
    const two = docOf(pic(1, 999900, 0, 20, 20), pic(2, 999990, 0, 20, 20))
    const pasted = insertItems(two, two.items, { x: 500, y: -2e6 }).doc
    const [a, b] = [pasted.items[2] as PictureItem, pasted.items[3] as PictureItem]
    expect(b.x - a.x).toBe(90)
    expect(a.y).toBe(b.y)
    expect(Math.max(a.x, b.x)).toBe(L)
    expect(a.y).toBe(-L)
  })
})

/* ============================================================== marks ======== */

describe('controller-pointer-m6: a mark\'s width can follow the zoom range', () => {
  it('a pen of half a pixel at zoom 64 and of 200 pixels at zoom 0.005 keeps its width in board units', () => {
    const thin = 0.5 / BOARD_LIMITS.zoomMax
    const wide = 200 / BOARD_LIMITS.zoomMin
    const doc = emptyBoard('x')
    const made = (width: number): number => (addMark(doc, { kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: 'ffffff', width, arrow: false }).doc.items[0] as LineItem).width
    expect(made(thin)).toBe(thin)
    expect(made(wide)).toBe(wide)
    expect(made(3 / 64)).toBeCloseTo(3 / 64, 12)
    expect(made(1e-9)).toBe(BOARD_ITEM_LIMITS.markWidth.min)
    expect(made(1e9)).toBe(BOARD_ITEM_LIMITS.markWidth.max)
    expect(BOARD_ITEM_LIMITS.markWidth.min).toBeLessThanOrEqual(thin)
    expect(BOARD_ITEM_LIMITS.markWidth.max).toBeGreaterThanOrEqual(wide)
  })
})

/* ============================================================== captions ===== */

describe('live-docked-m7: Arrange makes room for the captions the board shows', () => {
  /** Distinct rows: the gap between each row's bottom and the next row's top. */
  function rowGaps(doc: BoardDoc): number[] {
    const boxes = doc.items.map((it) => itemBounds(it, M)).sort((a, b) => a.y - b.y)
    const rows: { top: number; bottom: number }[] = []
    for (const b of boxes) {
      const last = rows[rows.length - 1]
      if (last && b.y < last.bottom - 1e-6 && b.y + b.h > last.top + 1e-6) {
        last.top = Math.min(last.top, b.y)
        last.bottom = Math.max(last.bottom, b.y + b.h)
      } else rows.push({ top: b.y, bottom: b.y + b.h })
    }
    return rows.slice(1).map((r, i) => r.top - rows[i]!.bottom)
  }
  const gallery = (captions: boolean, zoom = 1): BoardDoc => ({
    ...docOf(...Array.from({ length: 12 }, (_, i) => pic(i + 1, i * 10, 0, 200, 150, { caption: i % 2 ? 'a caption' : '' }))),
    captions,
    view: { x: 0, y: 0, zoom },
  })
  const ids = Array.from({ length: 12 }, (_, i) => i + 1)

  it('without captions the rows are `gap` apart, as before', () => {
    for (const gap of rowGaps(arrange(gallery(false), ids, 'optimal', { gap: 16 }))) expect(gap).toBeCloseTo(16, 6)
  })

  it('with captions on the rows are further apart by the caption\'s height (4 + 1.4 font + 4 pixels, over the zoom)', () => {
    const gaps = rowGaps(arrange(gallery(true), ids, 'optimal', { gap: 16 }))
    expect(gaps.length).toBeGreaterThan(0)
    // Pictures 150 high at zoom 1: font 10, label 18, plus the 4 px gap = 22.
    for (const gap of gaps) expect(gap).toBeCloseTo(16 + 22, 6)
    // At zoom 2 the same pictures are 300 px: font 18, label 29.2, plus 4, in board units: 16.6.
    for (const gap of rowGaps(arrange(gallery(true, 2), ids, 'optimal', { gap: 16 }))) expect(gap).toBeCloseTo(16 + 33.2 / 2, 6)
    // Pictures too small on the screen to show a caption need no room.
    for (const gap of rowGaps(arrange(gallery(true, 0.1), ids, 'optimal', { gap: 16 }))) expect(gap).toBeCloseTo(16, 6)
  })

  it('a column and a grid make the same room; a row, which has no row below it, does not change', () => {
    for (const mode of ['column', 'grid'] as const) {
      const on = rowGaps(arrange(gallery(true), ids, mode, { gap: 16, columns: 3 }))
      for (const gap of on) expect(gap, mode).toBeCloseTo(38, 6)
    }
    const row = arrange(gallery(true), ids, 'row', { gap: 16 })
    const off = arrange(gallery(false), ids, 'row', { gap: 16 })
    expect(row.items.map((it) => (it as PictureItem).x)).toEqual(off.items.map((it) => (it as PictureItem).x))
  })

  it('no caption of one row is covered by the next row\'s pictures', () => {
    const out = arrange(gallery(true), ids, 'optimal', { gap: 16 })
    const boxes = out.items.map((it) => itemBounds(it, M))
    for (const a of boxes) {
      // A caption hangs 4 + 18 px below its picture.
      const caption = { x: a.x, y: a.y + a.h, w: a.w, h: 22 }
      for (const b of boxes) {
        if (b === a) continue
        const overlap = caption.x < b.x + b.w && b.x < caption.x + caption.w && caption.y < b.y + b.h && b.y < caption.y + caption.h
        expect(overlap).toBe(false)
      }
    }
  })
})

/* ============================================================== addPicture ==== */

describe('pictures from the operations are held to the creation limits only where made', () => {
  it('addPicture keeps a caption of 4,000 characters and cuts a longer one', () => {
    const cap = (n: number): number => (addPicture(emptyBoard('x'), { path: 'a.png', w: 10, h: 10, caption: 'c'.repeat(n) }).doc.items[0] as PictureItem).caption.length
    expect(cap(BOARD_LIMITS.noteChars)).toBe(BOARD_LIMITS.noteChars)
    expect(cap(BOARD_LIMITS.noteChars + 1)).toBe(BOARD_LIMITS.noteChars)
  })
})
