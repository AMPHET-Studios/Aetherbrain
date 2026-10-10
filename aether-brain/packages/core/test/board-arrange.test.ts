import { describe, expect, it } from 'vitest'
import {
  type AlignEdge,
  type ArrangeMode,
  type ArrangeOrder,
  align,
  arrange,
  distribute,
  normalize,
  sortOrder,
} from '../src/board/arrange'
import { itemBounds, itemCentre, itemSize } from '../src/board/geometry'
import { expandGroups } from '../src/board/ops'
import {
  emptyBoard,
  type BoardDoc,
  type BoardItem,
  type EllipseItem,
  type LineItem,
  type NoteItem,
  type PictureItem,
  type Rect,
  type RectItem,
  type StrokeItem,
  type TextMetrics,
} from '../src/board/types'

/* ------------------------------------------------------------- helpers --- */

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

/** Fixed-width text (half the size a glyph, greedy wrap at spaces, 1.25 lines): the tests do not depend on the real estimate. */
const GLYPH = 0.5
const M: TextMetrics = {
  layout(text, size, maxWidth) {
    const perLine = Math.max(1, Math.floor(maxWidth / (GLYPH * size)))
    const lines: string[] = []
    for (const para of text.split('\n')) {
      let cur = ''
      for (const word of para.split(' ')) {
        const cand = cur ? `${cur} ${word}` : word
        if (cand.length > perLine && cur) {
          lines.push(cur)
          cur = word
        } else cur = cand
      }
      lines.push(cur)
    }
    return { lines, width: Math.max(...lines.map((l) => l.length)) * GLYPH * size, height: lines.length * size * 1.25 }
  },
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o as object)) deepFreeze(v)
  }
  return o
}

function pic(id: number, o: Partial<PictureItem> = {}): PictureItem {
  return {
    kind: 'picture', id, group: 0, locked: false, path: `p${id}.png`, x: 0, y: 0, w: 100, h: 50, rotation: 0,
    crop: { l: 0, t: 0, r: 1, b: 1 }, flipH: false, flipV: false, gray: false, opacity: 1, caption: '', ...o,
  }
}
function note(id: number, o: Partial<NoteItem> = {}): NoteItem {
  return { kind: 'note', id, group: 0, locked: false, text: 'hello', x: 0, y: 0, w: 200, size: 20, rotation: 0, color: 'ffffff', fill: '', ...o }
}
function stroke(id: number, points: number[], o: Partial<StrokeItem> = {}): StrokeItem {
  return { kind: 'stroke', id, group: 0, locked: false, points, color: 'ff0000', width: 4, ...o }
}
function line(id: number, x1: number, y1: number, x2: number, y2: number, o: Partial<LineItem> = {}): LineItem {
  return { kind: 'line', id, group: 0, locked: false, x1, y1, x2, y2, color: 'ff0000', width: 4, arrow: false, ...o }
}
function rect(id: number, x1: number, y1: number, x2: number, y2: number, o: Partial<RectItem> = {}): RectItem {
  return { kind: 'rect', id, group: 0, locked: false, x1, y1, x2, y2, color: 'ff0000', width: 4, fill: '', ...o }
}
function ellipse(id: number, x1: number, y1: number, x2: number, y2: number, o: Partial<EllipseItem> = {}): EllipseItem {
  return { kind: 'ellipse', id, group: 0, locked: false, x1, y1, x2, y2, color: 'ff0000', width: 4, fill: '', ...o }
}
function docOf(...items: BoardItem[]): BoardDoc {
  return { ...emptyBoard('t'), items, nextId: items.reduce((m, i) => Math.max(m, i.id), 0) + 1 }
}
const byId = (d: BoardDoc, id: number): BoardItem => d.items.find((i) => i.id === id)!
const ordered = (d: BoardDoc): number[] => d.items.map((i) => i.id)
const boundsOf = (d: BoardDoc, id: number): Rect => itemBounds(byId(d, id), M)

function unionRect(rects: Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w))
  const y1 = Math.max(...rects.map((r) => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
const midOf = (r: Rect): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/** The units a selection makes, worked out from the contract (groups whole; a locked member or no picture / note: not a unit). */
function unitsOf(doc: BoardDoc, ids: number[]): { ids: number[]; rect: Rect }[] {
  const wanted = new Set(expandGroups(doc, ids))
  const parts = new Map<string, BoardItem[]>()
  for (const it of doc.items) {
    if (!wanted.has(it.id)) continue
    const key = it.group > 0 ? `g${it.group}` : `i${it.id}`
    parts.set(key, [...(parts.get(key) ?? []), it])
  }
  return [...parts.values()]
    .filter((p) => !p.some((i) => i.locked) && p.some((i) => i.kind === 'picture' || i.kind === 'note'))
    .map((p) => ({ ids: p.map((i) => i.id), rect: unionRect(p.map((i) => itemBounds(i, M))) }))
}

/** How far apart two rectangles are along the axis where they are furthest apart (negative: they overlap on both). */
function separation(a: Rect, b: Rect): number {
  return Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), a.y - (b.y + b.h), b.y - (a.y + a.h))
}

function close(a: number, b: number, eps = 1e-9): void {
  expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(eps * Math.max(1, Math.abs(a), Math.abs(b)))
}

function allFinite(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every(allFinite)
  if (v && typeof v === 'object') return Object.values(v).every(allFinite)
  return true
}

/** Three pictures in a known place: bounds A [-50,50]x[-25,25], B [270,330]x[180,220], C [-90,-10]x[460,540]; their union is centred on (120, 257.5). */
function abc(): BoardDoc {
  return docOf(
    pic(1, { x: 0, y: 0, w: 100, h: 50 }),
    pic(2, { x: 300, y: 200, w: 60, h: 40 }),
    pic(3, { x: -50, y: 500, w: 80, h: 80 }),
  )
}
const centresOf = (d: BoardDoc, ...ids: number[]): [number, number][] => ids.map((id) => [itemCentre(byId(d, id)).x, itemCentre(byId(d, id)).y])

function expectCentres(d: BoardDoc, expected: Record<number, [number, number]>): void {
  for (const [id, [x, y]] of Object.entries(expected)) {
    const c = itemCentre(byId(d, Number(id)))
    close(c.x, x, 1e-9)
    close(c.y, y, 1e-9)
  }
}

function randPic(r: () => number, id: number): PictureItem {
  return pic(id, {
    x: (r() - 0.5) * 2000, y: (r() - 0.5) * 2000, w: 20 + r() * 400, h: 20 + r() * 400, rotation: r() < 0.3 ? 0 : (r() - 0.5) * 358,
    crop: r() < 0.5 ? { l: 0, t: 0, r: 1, b: 1 } : { l: r() * 0.4, t: r() * 0.4, r: 0.6 + r() * 0.4, b: 0.6 + r() * 0.4 },
    flipH: r() < 0.5, opacity: 0.1 + r() * 0.9,
  })
}
function randNote(r: () => number, id: number): NoteItem {
  const words = ['alpha', 'be', 'gamma ray', 'x', 'delta force', 'omega']
  return note(id, {
    text: Array.from({ length: 1 + Math.floor(r() * 12) }, () => words[Math.floor(r() * words.length)]!).join(' '),
    x: (r() - 0.5) * 2000, y: (r() - 0.5) * 2000, w: 60 + r() * 300, size: 8 + r() * 40, rotation: r() < 0.5 ? 0 : (r() - 0.5) * 358,
  })
}
function randMark(r: () => number, id: number): BoardItem {
  const c = (): number => (r() - 0.5) * 2000
  const k = Math.floor(r() * 4)
  const width = 1 + r() * 20
  if (k === 0) return stroke(id, Array.from({ length: 2 * (2 + Math.floor(r() * 8)) }, c), { width })
  if (k === 1) return line(id, c(), c(), c(), c(), { width, arrow: r() < 0.5 })
  if (k === 2) return rect(id, c(), c(), c(), c(), { width, fill: r() < 0.5 ? '' : '00ff00' })
  return ellipse(id, c(), c(), c(), c(), { width, fill: r() < 0.5 ? '' : '00ff00' })
}

/** A board of mixed items with groups (some partly marks, some with a locked member) and locks, and a selection. */
function scenario(seed: number): { doc: BoardDoc; ids: number[] } {
  const r = rng(seed)
  const n = 1 + Math.floor(r() * 16)
  const items: BoardItem[] = []
  for (let i = 1; i <= n; i++) {
    const k = r()
    let it = k < 0.5 ? randPic(r, i) : k < 0.7 ? randNote(r, i) : randMark(r, i)
    if (r() < 0.45) it = { ...it, group: 1 + Math.floor(r() * 3) }
    if (r() < 0.1) it = { ...it, locked: true }
    items.push(it)
  }
  const doc = docOf(...items)
  const ids = r() < 0.4 ? items.map((i) => i.id) : items.filter(() => r() < 0.6).map((i) => i.id)
  return { doc, ids }
}

const MODES: ArrangeMode[] = ['optimal', 'row', 'column', 'grid', 'stack']
const NO_OVERLAP: ArrangeMode[] = ['optimal', 'row', 'column', 'grid']
const ORDERS: ArrangeOrder[] = ['current', 'name', 'added', 'size', 'shuffle']

/* ------------------------------------------------------------ sortOrder --- */

describe('sortOrder', () => {
  it("'current' is the board's back-to-front order, whatever order the ids come in; strangers and repeats are dropped", () => {
    const doc = docOf(pic(7), pic(3), pic(9), pic(1))
    expect(sortOrder(doc, [1, 9, 7], 'current')).toEqual([7, 9, 1])
    expect(sortOrder(doc, [3, 3, 99, 7, 7], 'current')).toEqual([7, 3])
    expect(sortOrder(doc, [], 'current')).toEqual([])
  })

  it("'added' is by id", () => {
    const doc = docOf(pic(7), pic(3), pic(9), pic(1), note(5))
    expect(sortOrder(doc, [7, 3, 9, 1, 5], 'added')).toEqual([1, 3, 5, 7, 9])
    expect(sortOrder(doc, [9, 5], 'added')).toEqual([5, 9])
  })

  it("'size' is by shown area, largest first, ties in board order", () => {
    const doc = docOf(
      pic(1, { w: 100, h: 50 }), // 5000
      pic(2, { w: 40, h: 40 }), // 1600
      pic(3, { w: 200, h: 100, crop: { l: 0.5, t: 0, r: 1, b: 1 } }), // shown 100 x 100 = 10000
      pic(4, { w: 80, h: 62.5 }), // 5000, after 1
      pic(5, { w: 40, h: 40, rotation: 45 }), // 1600, after 2: a turn does not change the area
      note(6, { w: 200, size: 20, text: 'hello' }), // 200 x 45 = 9000 under M
      rect(7, 0, 0, 10, 10), // 14 x 14
    )
    expect(sortOrder(doc, [1, 2, 3, 4, 5, 6, 7], 'size', undefined, M)).toEqual([3, 6, 1, 4, 2, 5, 7])
    expect(sortOrder(doc, [5, 4, 2], 'size', undefined, M)).toEqual([4, 2, 5])
  })

  it("'name' is natural order on the file name: numbers by value, case ignored, folder and extension left out", () => {
    const doc = docOf(
      pic(1, { path: 'Boards/Gate/photo 10.jpg' }),
      pic(2, { path: 'photo 2.jpg' }),
      pic(3, { path: 'a/b/Photo 1.JPG' }),
      pic(4, { path: 'zebra.png' }),
      pic(5, { path: 'apple.png' }),
    )
    expect(sortOrder(doc, [1, 2, 3, 4, 5], 'name')).toEqual([5, 3, 2, 1, 4])
    // the folder does not count: z/a.png comes before a/b.png
    const dirs = docOf(pic(1, { path: 'a/b.png' }), pic(2, { path: 'z/a.png' }))
    expect(sortOrder(dirs, [1, 2], 'name')).toEqual([2, 1])
    const win = docOf(pic(1, { path: 'C:\\x\\b.png' }), pic(2, { path: 'C:\\y\\a.png' }))
    expect(sortOrder(win, [1, 2], 'name')).toEqual([2, 1])
  })

  it("'name' compares digit runs by value however long, and ignores leading zeros", () => {
    const doc = docOf(
      pic(1, { path: 'img007.png' }),
      pic(2, { path: 'img7.png' }),
      pic(3, { path: 'img08.png' }),
      pic(4, { path: 'img1.png' }),
      pic(5, { path: 'img100.png' }),
      pic(6, { path: 'img9.png' }),
    )
    // 007 and 7 are the same number: board order
    expect(sortOrder(doc, [1, 2, 3, 4, 5, 6], 'name')).toEqual([4, 1, 2, 3, 6, 5])
    const big = docOf(pic(1, { path: 'x100000000000000000000.png' }), pic(2, { path: 'x99999999999999999999.png' }))
    expect(sortOrder(big, [1, 2], 'name')).toEqual([2, 1])
    const mixed = docOf(pic(1, { path: 'a1.png' }), pic(2, { path: 'a 1.png' }), pic(3, { path: 'a.png' }), pic(4, { path: 'A-1.png' }))
    // "a", then "a 1" (space before digit), "a-1" (hyphen 45 is under digit 49), "a1"
    expect(sortOrder(mixed, [1, 2, 3, 4], 'name')).toEqual([3, 2, 4, 1])
  })

  it("'name' puts numbers in order of value however the board lists them: a pair compares the same both ways, and zeros in front are no number", () => {
    const digits = ['007', '7', '08', '1', '9', '100', '0', '00', '12', '012', '112', '10', '010']
    const r = rng(8)
    for (let t = 0; t < 120; t++) {
      const order = digits.map((d) => ({ d, k: r() })).sort((a, b) => a.k - b.k).map((e) => e.d)
      const doc = docOf(...order.map((d, i) => pic(i + 1, { path: `img${d}.png` })))
      const got = sortOrder(doc, doc.items.map((i) => i.id), 'name').map((id) => order[id - 1]!)
      // the sort is stable, so equal values (007 and 7) stay in the board's order
      const want = order.slice().sort((p, q) => parseInt(p, 10) - parseInt(q, 10))
      expect(got, order.join(' ')).toEqual(want)
    }
  })

  it("'name' sorts notes by their text with the pictures, ties and marks last in board order", () => {
    const doc = docOf(
      note(1, { text: 'Zed' }),
      pic(2, { path: 'apple.png' }),
      stroke(3, [0, 0, 5, 5]),
      pic(4, { path: 'a/apple.png' }),
      note(5, { text: '  banana split' }),
      rect(6, 0, 0, 5, 5),
    )
    expect(sortOrder(doc, [1, 2, 3, 4, 5, 6], 'name')).toEqual([2, 4, 5, 1, 3, 6])
  })

  it("'name' is stable for the same name and does not move with the ids' order", () => {
    const doc = docOf(pic(1, { path: 'x/a.png' }), pic(2, { path: 'y/a.png' }), pic(3, { path: 'z/a.png' }))
    expect(sortOrder(doc, [3, 1, 2], 'name')).toEqual([1, 2, 3])
  })

  it("'shuffle' is a permutation, the same for the same seed and not for another", () => {
    const doc = docOf(...Array.from({ length: 20 }, (_, i) => pic(i + 1)))
    const ids = doc.items.map((i) => i.id)
    const a = sortOrder(doc, ids, 'shuffle', 5)
    expect([...a].sort((p, q) => p - q)).toEqual(ids)
    expect(sortOrder(doc, ids, 'shuffle', 5)).toEqual(a)
    expect(sortOrder(doc, [...ids].reverse(), 'shuffle', 5)).toEqual(a)
    expect(sortOrder(doc, ids, 'shuffle', 6)).not.toEqual(a)
    expect(a).not.toEqual(ids)
    expect(sortOrder(doc, ids, 'shuffle')).toEqual(sortOrder(doc, ids, 'shuffle'))
    expect(sortOrder(doc, ids, 'shuffle', NaN)).toEqual(sortOrder(doc, ids, 'shuffle'))
  })

  it("'shuffle' is fair: an item stays in its place once in n shuffles on average, and every item leads about 1 in n", () => {
    const n = 10
    const doc = docOf(...Array.from({ length: n }, (_, i) => pic(i + 1)))
    const ids = doc.items.map((i) => i.id)
    let fixed = 0
    const first = new Array(n).fill(0) as number[]
    const runs = 3000
    for (let seed = 0; seed < runs; seed++) {
      const s = sortOrder(doc, ids, 'shuffle', seed)
      s.forEach((id, i) => {
        if (id === ids[i]) fixed++
      })
      first[s[0]! - 1]!++
    }
    expect(fixed / runs).toBeGreaterThan(0.85)
    expect(fixed / runs).toBeLessThan(1.15)
    for (const c of first) {
      expect(c / runs).toBeGreaterThan(0.07)
      expect(c / runs).toBeLessThan(0.13)
    }
  })

  it('does not touch the doc', () => {
    const doc = deepFreeze(docOf(pic(2, { path: 'b.png' }), pic(1, { path: 'a.png' })))
    for (const o of ORDERS) expect(() => sortOrder(doc, [1, 2], o, 3, M)).not.toThrow()
  })
})

/* ---------------------------------------------------------- arrange: rules --- */

describe('arrange: what moves', () => {
  it('returns the same doc when there is nothing to move', () => {
    const doc = deepFreeze(abc())
    for (const mode of MODES) {
      expect(arrange(doc, [], mode, { metrics: M })).toBe(doc)
      expect(arrange(doc, [99, 100], mode, { metrics: M })).toBe(doc)
      expect(arrange(doc, [2], mode, { metrics: M })).toBe(doc)
    }
    expect(arrange(docOf(), [1], 'row')).toEqual(docOf())
  })

  it('never moves a mark, alone or among pictures', () => {
    const marks = deepFreeze(docOf(rect(1, 0, 0, 50, 50), line(2, 200, 0, 300, 90), stroke(3, [5, 5, 80, 90]), ellipse(4, 0, 300, 90, 340)))
    for (const mode of MODES) expect(arrange(marks, [1, 2, 3, 4], mode, { metrics: M })).toBe(marks)
    const mixed = deepFreeze(docOf(pic(1, { x: 0 }), rect(2, 0, 0, 50, 50), pic(3, { x: 500 }), line(4, 200, 0, 300, 90)))
    for (const mode of MODES) {
      const out = arrange(mixed, [1, 2, 3, 4], mode, { metrics: M })
      expect(out.items[1]).toBe(mixed.items[1])
      expect(out.items[3]).toBe(mixed.items[3])
    }
  })

  it('leaves locked items where they are and arranges the others as if they were not there', () => {
    const doc = deepFreeze(docOf(pic(1, { x: 0, y: 0 }), pic(2, { x: 150, y: 90, locked: true }), pic(3, { x: 600, y: 0 })))
    const out = arrange(doc, [1, 2, 3], 'row', { metrics: M })
    expect(out.items[1]).toBe(doc.items[1])
    // 1 and 3 are 100 wide: bounds [-50,50] and [550,650], centre 300; row of two with gap 16 is 216 wide
    expectCentres(out, { 1: [300 - 58, 0], 3: [300 + 58, 0] })
    // a selection of only locked items does nothing
    expect(arrange(doc, [2], 'grid', { metrics: M })).toBe(doc)
  })

  it('leaves the items it was not given exactly as they were', () => {
    const doc = deepFreeze(abc())
    const out = arrange(doc, [1, 2], 'column', { metrics: M })
    expect(out.items[2]).toBe(doc.items[2])
    expect(out.items[0]).not.toBe(doc.items[0])
  })

  it('changes only positions: sizes, turns, crops and everything else stay', () => {
    const r = rng(4)
    const doc = deepFreeze(docOf(...Array.from({ length: 8 }, (_, i) => (i % 3 === 0 ? randNote(r, i + 1) : randPic(r, i + 1)))))
    for (const mode of MODES) {
      const out = arrange(doc, doc.items.map((i) => i.id), mode, { metrics: M })
      expect(out.items.length).toBe(doc.items.length)
      doc.items.forEach((before, i) => {
        const after = out.items.find((it) => it.id === before.id)!
        expect({ ...after, x: 0, y: 0 }, `${mode} item ${i}`).toEqual({ ...before, x: 0, y: 0 })
      })
      expect(out.view).toBe(doc.view)
      expect(out.nextId).toBe(doc.nextId)
    }
  })
})

describe('arrange: groups', () => {
  /** Group 1: two pictures with an arrow mark across them, and a loose picture and a loose note. */
  function withGroup(): BoardDoc {
    return docOf(
      pic(1, { x: 0, y: 0, w: 100, h: 50, group: 1 }),
      pic(2, { x: 200, y: 20, w: 100, h: 50, group: 1 }),
      line(3, 0, 60, 200, 60, { group: 1, width: 4, arrow: true }),
      pic(4, { x: 700, y: 400, w: 120, h: 80 }),
      note(5, { x: -300, y: 400, w: 200, size: 20 }),
    )
  }

  it('moves a group as one rigid body, marks included, and keeps its members where they are relative to each other', () => {
    const doc = deepFreeze(withGroup())
    for (const mode of MODES) {
      const out = arrange(doc, [1, 2, 3, 4, 5], mode, { metrics: M })
      const d1 = { x: itemCentre(byId(out, 1)).x - 0, y: itemCentre(byId(out, 1)).y - 0 }
      for (const id of [2, 3]) {
        const before = itemCentre(byId(doc, id))
        const after = itemCentre(byId(out, id))
        close(after.x - before.x, d1.x, 1e-9)
        close(after.y - before.y, d1.y, 1e-9)
      }
      expect({ ...byId(out, 3), x1: 0, x2: 0, y1: 0, y2: 0 }).toEqual({ ...byId(doc, 3), x1: 0, x2: 0, y1: 0, y2: 0 })
    }
  })

  it('lays out the whole footprint of the group, mark included, so a row has the gap between it and its neighbours', () => {
    const doc = deepFreeze(withGroup())
    const out = arrange(doc, [1, 2, 3, 4, 5], 'row', { metrics: M })
    const g = unionRect([1, 2, 3].map((id) => boundsOf(out, id)))
    const loose4 = boundsOf(out, 4)
    const loose5 = boundsOf(out, 5)
    // board order: the group first (its first member is 1), then 4, then 5
    close(loose4.x - (g.x + g.w), 16)
    close(loose5.x - (loose4.x + loose4.w), 16)
    // the mark is part of the footprint: the group is taller than its pictures alone
    const pics = unionRect([1, 2].map((id) => boundsOf(out, id)))
    expect(g.h).toBeGreaterThan(pics.h)
  })

  it('takes the whole group when only some of its members are listed', () => {
    const doc = deepFreeze(withGroup())
    const out = arrange(doc, [2, 4], 'row', { metrics: M })
    expect(out.items[0]).not.toBe(doc.items[0])
    expect(out.items[2]).not.toBe(doc.items[2])
    expect(out.items[4]).toBe(doc.items[4])
    const g = unionRect([1, 2, 3].map((id) => boundsOf(out, id)))
    close(boundsOf(out, 4).x - (g.x + g.w), 16)
  })

  it('leaves a group with a locked member exactly where it is, and does not count it', () => {
    const doc = deepFreeze(
      docOf(
        pic(1, { x: 0, y: 0, group: 1, locked: true }),
        pic(2, { x: 200, y: 0, group: 1 }),
        pic(3, { x: 600, y: 0 }),
        pic(4, { x: 1000, y: 0 }),
      ),
    )
    const out = arrange(doc, [1, 2, 3, 4], 'row', { metrics: M })
    expect(out.items[0]).toBe(doc.items[0])
    expect(out.items[1]).toBe(doc.items[1])
    // 3 and 4 alone: bounds [550,650] and [950,1050], centre 800
    expectCentres(out, { 3: [800 - 58, 0], 4: [800 + 58, 0] })
  })

  it('leaves a group of marks alone, even listed', () => {
    const doc = deepFreeze(docOf(rect(1, 0, 0, 50, 50, { group: 1 }), line(2, 100, 0, 200, 50, { group: 1 }), pic(3), pic(4, { x: 500 })))
    const out = arrange(doc, [1, 2, 3, 4], 'column', { metrics: M })
    expect(out.items[0]).toBe(doc.items[0])
    expect(out.items[1]).toBe(doc.items[1])
    expect(out.items[2]).not.toBe(doc.items[2])
  })

  it('orders a group by its first member in the ordering', () => {
    const doc = docOf(
      pic(1, { path: 'm.png', x: 0 }),
      pic(2, { path: 'z.png', x: 300, group: 1 }),
      pic(3, { path: 'a.png', x: 600, group: 1 }),
    )
    const out = arrange(doc, [1, 2, 3], 'row', { order: 'name', metrics: M })
    // the group holds "a", the loose picture "m": the group goes first
    expect(itemCentre(byId(out, 3)).x).toBeLessThan(itemCentre(byId(out, 1)).x)
    expect(itemCentre(byId(out, 2)).x).toBeLessThan(itemCentre(byId(out, 1)).x)
    // inside the group nothing changed
    close(itemCentre(byId(out, 3)).x - itemCentre(byId(out, 2)).x, 300)
  })
})

describe('arrange: shapes', () => {
  it("'row' puts the units left to right on one line, a gap apart, centred on the middle of where they were", () => {
    const out = arrange(deepFreeze(abc()), [1, 2, 3], 'row', { metrics: M })
    expectCentres(out, { 1: [34, 257.5], 2: [130, 257.5], 3: [216, 257.5] })
  })

  it("'column' puts the units top to bottom on one line", () => {
    const out = arrange(deepFreeze(abc()), [1, 2, 3], 'column', { metrics: M })
    expectCentres(out, { 1: [120, 181.5], 2: [120, 242.5], 3: [120, 318.5] })
  })

  it("'grid' fills rows of the given number of columns; each column as wide as its widest unit, each row as tall as its tallest; units in the middle of their cell", () => {
    const out = arrange(deepFreeze(abc()), [1, 2, 3], 'grid', { metrics: M, columns: 2 })
    expectCentres(out, { 1: [82, 209.5], 2: [178, 209.5], 3: [82, 290.5] })
  })

  it("'stack' puts every unit on the one centre", () => {
    const out = arrange(deepFreeze(abc()), [1, 2, 3], 'stack', { metrics: M })
    expectCentres(out, { 1: [120, 257.5], 2: [120, 257.5], 3: [120, 257.5] })
  })

  it('uses the rotated bounds of a turned picture', () => {
    // 100 x 50 turned a quarter: 50 wide, 100 tall
    const doc = docOf(pic(1, { x: 0, y: 0, rotation: 90 }), pic(2, { x: 400, y: 0 }))
    const out = arrange(doc, [1, 2], 'row', { metrics: M, gap: 10 })
    // union [-25, 450] x [-50, 50]: centre (212.5, 0); row 50 + 10 + 100 = 160 -> left 132.5
    expectCentres(out, { 1: [132.5 + 25, 0], 2: [132.5 + 60 + 50, 0] })
    close(boundsOf(out, 2).x - (boundsOf(out, 1).x + boundsOf(out, 1).w), 10)
  })

  it('measures notes with the metrics it is given', () => {
    const tall: TextMetrics = { layout: (text) => ({ lines: [text], width: 10, height: 300 }) }
    const doc = docOf(note(1, { x: 0, y: 0 }), note(2, { x: 500, y: 0 }))
    const a = arrange(doc, [1, 2], 'column', { metrics: tall })
    // each note is 300 + 2 x 10 = 320 tall; centres 320 + 16 apart
    close(itemCentre(byId(a, 2)).y - itemCentre(byId(a, 1)).y, 336)
    const b = arrange(doc, [1, 2], 'column', { metrics: M })
    close(itemCentre(byId(b, 2)).y - itemCentre(byId(b, 1)).y, 45 + 16)
  })

  it('takes the gap option: 0 touches, a large one spreads, a bad one is the default 16 and a negative one is 0', () => {
    const doc = abc()
    const gapOf = (opts: { gap?: number }): number => {
      const out = arrange(doc, [1, 2, 3], 'row', { metrics: M, ...opts })
      return boundsOf(out, 2).x - (boundsOf(out, 1).x + boundsOf(out, 1).w)
    }
    close(gapOf({}), 16)
    close(gapOf({ gap: 0 }), 0)
    close(gapOf({ gap: 40 }), 40)
    close(gapOf({ gap: NaN }), 16)
    close(gapOf({ gap: Infinity }), 16)
    close(gapOf({ gap: -30 }), 0)
    const col = arrange(doc, [1, 2, 3], 'column', { metrics: M, gap: 7 })
    close(boundsOf(col, 2).y - (boundsOf(col, 1).y + boundsOf(col, 1).h), 7)
    // Grid of 2 columns: row 0 holds 1 (100 x 50) and 2 (60 x 40), row 1 holds 3 (80 x 80). Columns are 100 and 60 wide, row 0 is 50 tall.
    const grid = arrange(doc, [1, 2, 3], 'grid', { metrics: M, gap: 7, columns: 2 })
    // 1 and 2 fill their cells across, 1 and 3 their row's height, so the cell gap is the gap
    close(boundsOf(grid, 2).x - (boundsOf(grid, 1).x + boundsOf(grid, 1).w), 7)
    close(boundsOf(grid, 3).y - (boundsOf(grid, 1).y + boundsOf(grid, 1).h), 7)
    // 2 is 10 shorter than its row and sits in the middle of its cell: 5 of air under it besides the gap
    close(boundsOf(grid, 3).y - (boundsOf(grid, 2).y + boundsOf(grid, 2).h), 7 + 5)
  })

  it('uses the board order for "current" however the ids are listed', () => {
    const doc = abc()
    const a = arrange(doc, [1, 2, 3], 'row', { metrics: M })
    const b = arrange(doc, [3, 1, 2], 'row', { metrics: M })
    expect(b).toEqual(a)
    const xs = [1, 2, 3].map((id) => itemCentre(byId(a, id)).x)
    expect(xs).toEqual([...xs].sort((p, q) => p - q))
  })
})

describe('arrange: grid columns', () => {
  const squares = (n: number): BoardDoc => docOf(...Array.from({ length: n }, (_, i) => pic(i + 1, { x: i * 7, y: (i % 3) * 5, w: 100, h: 100 })))
  /** Number of distinct rows (y of the centres) and columns (x). */
  const shape = (d: BoardDoc): { rows: number; cols: number } => ({
    rows: new Set(d.items.map((i) => Math.round(itemCentre(i).y))).size,
    cols: new Set(d.items.map((i) => Math.round(itemCentre(i).x))).size,
  })

  it('takes the number of columns asked for', () => {
    const doc = squares(10)
    const ids = doc.items.map((i) => i.id)
    expect(shape(arrange(doc, ids, 'grid', { metrics: M, columns: 3 }))).toEqual({ rows: 4, cols: 3 })
    expect(shape(arrange(doc, ids, 'grid', { metrics: M, columns: 5 }))).toEqual({ rows: 2, cols: 5 })
    expect(shape(arrange(doc, ids, 'grid', { metrics: M, columns: 1 }))).toEqual({ rows: 10, cols: 1 })
    expect(shape(arrange(doc, ids, 'grid', { metrics: M, columns: 2.9 }))).toEqual({ rows: 5, cols: 2 })
    expect(shape(arrange(doc, ids, 'grid', { metrics: M, columns: 99 }))).toEqual({ rows: 1, cols: 10 })
  })

  it('fills rows left to right in the order of the units', () => {
    const doc = squares(7)
    const out = arrange(doc, doc.items.map((i) => i.id), 'grid', { metrics: M, columns: 3 })
    const pos = out.items.map((i) => itemCentre(i))
    pos.forEach((p, i) => {
      close(p.x, pos[i % 3]!.x)
      close(p.y, pos[Math.floor(i / 3) * 3]!.y)
    })
    expect(pos[1]!.x).toBeGreaterThan(pos[0]!.x)
    expect(pos[3]!.y).toBeGreaterThan(pos[0]!.y)
  })

  it('chooses the count whose shape is nearest the wanted one', () => {
    const doc16 = squares(16)
    const ids16 = doc16.items.map((i) => i.id)
    expect(shape(arrange(doc16, ids16, 'grid', { metrics: M, gap: 0, aspect: 1 }))).toEqual({ rows: 4, cols: 4 })
    expect(shape(arrange(doc16, ids16, 'grid', { metrics: M, gap: 0, aspect: 4 }))).toEqual({ rows: 2, cols: 8 })
    expect(shape(arrange(doc16, ids16, 'grid', { metrics: M, gap: 0, aspect: 0.25 }))).toEqual({ rows: 8, cols: 2 })
    // 12 squares at the default shape 1.6: 5 across (500 x 300) is nearer than 4 (400 x 300)
    const doc12 = squares(12)
    expect(shape(arrange(doc12, doc12.items.map((i) => i.id), 'grid', { metrics: M, gap: 0 }))).toEqual({ rows: 3, cols: 5 })
    // columns left out, 0, negative or not a number: chosen
    for (const columns of [undefined, 0, -3, NaN]) {
      expect(shape(arrange(doc16, ids16, 'grid', { metrics: M, gap: 0, aspect: 1, columns }))).toEqual({ rows: 4, cols: 4 })
    }
    // an aspect that makes no sense is the default
    const dflt = arrange(doc12, doc12.items.map((i) => i.id), 'grid', { metrics: M, gap: 0 })
    for (const aspect of [0, -2, NaN]) {
      expect(arrange(doc12, doc12.items.map((i) => i.id), 'grid', { metrics: M, gap: 0, aspect })).toEqual(dflt)
    }
  })

  it("considers the units' sizes, not just their number: wide pictures take fewer columns, tall ones more", () => {
    const ids = (d: BoardDoc): number[] => d.items.map((i) => i.id)
    // Twelve alike, so a rule that only counted them would give the same columns for both (3 or 4 for a square)
    const wide = docOf(...Array.from({ length: 12 }, (_, i) => pic(i + 1, { x: i * 5, w: 400, h: 100 })))
    // 400 x 100 cells: 2 across, 6 down is 800 x 600 (shape 1.33); 1 across is 400 x 1200 and 3 across 1200 x 400, both far off 1
    expect(shape(arrange(wide, ids(wide), 'grid', { metrics: M, gap: 0, aspect: 1 }))).toEqual({ rows: 6, cols: 2 })
    const tall = docOf(...Array.from({ length: 12 }, (_, i) => pic(i + 1, { x: i * 5, w: 100, h: 400 })))
    // 8 across, 2 down (the second row short) is 800 x 800, exactly square; 7 across is 700 x 800
    expect(shape(arrange(tall, ids(tall), 'grid', { metrics: M, gap: 0, aspect: 1 }))).toEqual({ rows: 2, cols: 8 })
  })

  it('takes the one that needs less room when two counts come out equally near the wanted shape', () => {
    // 400x200, 50x50, 50x200, 400x50 for a shape of 2. Two across: columns 400 + 400, rows 200 + 200 = 800 x 400. Three across: columns
    // 400 + 50 + 50, rows 200 + 50 = 500 x 250. Both are exactly 2 to 1, and the second takes 125,000 where the first takes 320,000.
    const mixed = docOf(pic(1, { w: 400, h: 200 }), pic(2, { x: 10, w: 50, h: 50 }), pic(3, { x: 20, w: 50, h: 200 }), pic(4, { x: 30, w: 400, h: 50 }))
    expect(shape(arrange(mixed, [1, 2, 3, 4], 'grid', { metrics: M, gap: 0, aspect: 2 }))).toEqual({ rows: 2, cols: 3 })
  })

  it('aims for a shape of 1.6 when it is not told one, and for what it is told otherwise', () => {
    // Three pictures 179 x 200: two across is 358 x 400 (0.895 to 1), three across 537 x 200 (2.685 to 1). 1.6 is nearer the second on a
    // log scale (0.52 against 0.58); 1.5 is nearer the first (0.52 against 0.58).
    const three = docOf(...Array.from({ length: 3 }, (_, i) => pic(i + 1, { x: i * 10, w: 179, h: 200 })))
    expect(shape(arrange(three, [1, 2, 3], 'grid', { metrics: M, gap: 0 }))).toEqual({ rows: 1, cols: 3 })
    expect(shape(arrange(three, [1, 2, 3], 'grid', { metrics: M, gap: 0, aspect: 1.6 }))).toEqual({ rows: 1, cols: 3 })
    expect(shape(arrange(three, [1, 2, 3], 'grid', { metrics: M, gap: 0, aspect: 1.5 }))).toEqual({ rows: 2, cols: 2 })
  })

  it('takes the fewer columns when two counts come out equally near the wanted shape', () => {
    // 400 x 100 pictures, eight of them: 1 across is 400 x 800 and 2 across is 800 x 400, both a factor 2 from a square
    const wide = docOf(...Array.from({ length: 8 }, (_, i) => pic(i + 1, { x: i * 5, w: 400, h: 100 })))
    expect(shape(arrange(wide, wide.items.map((i) => i.id), 'grid', { metrics: M, gap: 0, aspect: 1 }))).toEqual({ rows: 8, cols: 1 })
  })
})

describe('arrange: optimal', () => {
  const squares = (n: number): BoardDoc => docOf(...Array.from({ length: n }, (_, i) => pic(i + 1, { x: i * 10, y: 0, w: 100, h: 100 })))
  const rowsOf = (d: BoardDoc): number[][] => {
    const byY = new Map<number, number[]>()
    for (const it of d.items) {
      const y = Math.round(itemCentre(it).y * 1000) / 1000
      byY.set(y, [...(byY.get(y) ?? []), it.id])
    }
    return [...byY.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids.sort((p, q) => itemCentre(byId(d, p)).x - itemCentre(byId(d, q)).x))
  }

  it('packs equal squares into the rows that bring the whole closest to the wanted shape', () => {
    const doc = squares(24)
    const ids = doc.items.map((i) => i.id)
    const wide = arrange(doc, ids, 'optimal', { metrics: M, gap: 0, aspect: 1.5 })
    expect(rowsOf(wide).map((r) => r.length)).toEqual([6, 6, 6, 6])
    expect(unionRect(wide.items.map((i) => itemBounds(i, M)))).toEqual({ x: expect.any(Number), y: expect.any(Number), w: 600, h: 400 })
    const tall = arrange(doc, ids, 'optimal', { metrics: M, gap: 0, aspect: 2 / 3 })
    expect(rowsOf(tall).map((r) => r.length)).toEqual([4, 4, 4, 4, 4, 4])
    // a square: 5 x 5 with a short last row beats every other count
    const square = arrange(doc, ids, 'optimal', { metrics: M, gap: 0, aspect: 1 })
    expect(rowsOf(square).map((r) => r.length)).toEqual([5, 5, 5, 5, 4])
  })

  it('reads in the order of the units: row by row, left to right', () => {
    const doc = squares(24)
    const out = arrange(doc, doc.items.map((i) => i.id), 'optimal', { metrics: M, gap: 0, aspect: 1.5 })
    expect(rowsOf(out).flat()).toEqual(doc.items.map((i) => i.id))
  })

  it('centres every row, a short last one too, and puts the units of a row on one line', () => {
    const doc = squares(24)
    const out = arrange(doc, doc.items.map((i) => i.id), 'optimal', { metrics: M, gap: 0, aspect: 1 })
    const rows = rowsOf(out)
    const mid = (row: number[]): number => (itemCentre(byId(out, row[0]!)).x + itemCentre(byId(out, row[row.length - 1]!)).x) / 2
    for (const row of rows) close(mid(row), mid(rows[0]!))
    const full = rows[0]!.map((id) => itemCentre(byId(out, id)).x)
    const last = rows[4]!.map((id) => itemCentre(byId(out, id)).x)
    close(last[0]! - full[0]!, 50)
    const mixed = docOf(pic(1, { w: 100, h: 40 }), pic(2, { w: 100, h: 100 }), pic(3, { w: 100, h: 60 }), pic(4, { x: 500, w: 100, h: 30 }))
    const m = arrange(mixed, [1, 2, 3, 4], 'optimal', { metrics: M, gap: 10, aspect: 1000 })
    // one long row: centres on one line
    const ys = [1, 2, 3, 4].map((id) => itemCentre(byId(m, id)).y)
    for (const y of ys) close(y, ys[0]!)
  })

  it('keeps one picture where it is and keeps every size', () => {
    const solo = docOf(pic(1, { x: 33, y: -12 }))
    expect(arrange(solo, [1], 'optimal', { metrics: M })).toBe(solo)
    const two = docOf(pic(1, { x: 0 }), pic(2, { x: 500, w: 30, h: 90 }))
    const out = arrange(two, [1, 2], 'optimal', { metrics: M })
    expect(itemSize(byId(out, 2), M)).toEqual({ w: 30, h: 90 })
  })

  it('is as good as the best that any row width gives (brute force over every width, random sizes and turns)', () => {
    const score = (w: number, h: number, used: number, aspect: number): number => Math.abs(Math.log(w / h / aspect)) + Math.max(0, 1 - used / (w * h))
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed * 31)
      const n = 2 + Math.floor(r() * 12)
      const items = Array.from({ length: n }, (_, i) =>
        pic(i + 1, { x: (r() - 0.5) * 3000, y: (r() - 0.5) * 3000, w: 20 + r() * 400, h: 20 + r() * 400, rotation: r() < 0.4 ? 0 : (r() - 0.5) * 358 }),
      )
      const doc = docOf(...items)
      const ids = items.map((i) => i.id)
      const aspect = [1, 1.6, 0.6, 3][seed % 4]!
      const gap = [0, 16, 40][seed % 3]!
      const sizes = items.map((it) => {
        const b = itemBounds(it, M)
        return { w: b.w, h: b.h }
      })
      const used = sizes.reduce((a, s) => a + s.w * s.h, 0)
      // every width a greedy fill can be cut at: the sum of any run of neighbours
      const candidates = new Set<number>()
      for (let i = 0; i < n; i++) {
        let w = 0
        for (let j = i; j < n; j++) {
          w = j === i ? sizes[j]!.w : w + gap + sizes[j]!.w
          candidates.add(w)
        }
      }
      let best = Infinity
      for (const limit of candidates) {
        let rowW = 0
        let rowH = 0
        let width = 0
        let height = 0
        sizes.forEach((s, i) => {
          if (i > 0 && rowW + gap + s.w <= limit + 1e-9) {
            rowW += gap + s.w
            rowH = Math.max(rowH, s.h)
          } else {
            if (i > 0) {
              width = Math.max(width, rowW)
              height += rowH + gap
            }
            rowW = s.w
            rowH = s.h
          }
        })
        width = Math.max(width, rowW)
        height += rowH
        best = Math.min(best, score(width, height, used, aspect))
      }
      const out = arrange(doc, ids, 'optimal', { metrics: M, gap, aspect })
      const box = unionRect(out.items.map((i) => itemBounds(i, M)))
      const got = score(box.w, box.h, used, aspect)
      expect(got, `seed ${seed} n ${n}`).toBeLessThanOrEqual(best + 1e-7)
      expect(got, `seed ${seed} n ${n}`).toBeGreaterThanOrEqual(best - 1e-7)
    }
  })
})

describe('arrange: stack', () => {
  it("'current' keeps the drawing order; other orders hand the arranged items' places in it out again, back to front, leaving the rest in theirs", () => {
    const doc = deepFreeze(
      docOf(pic(1, { path: 'c.png', x: 0 }), pic(4, { path: 'q.png', x: 800 }), pic(2, { path: 'a.png', x: 300 }), pic(3, { path: 'b.png', x: 600 })),
    )
    expect(ordered(arrange(doc, [1, 2, 3], 'stack', { metrics: M }))).toEqual([1, 4, 2, 3])
    expect(ordered(arrange(doc, [1, 2, 3], 'stack', { metrics: M, order: 'name' }))).toEqual([2, 4, 3, 1])
    expect(ordered(arrange(doc, [1, 2, 3], 'stack', { metrics: M, order: 'added' }))).toEqual([1, 4, 2, 3])
    // sizes 100 x 50 all alike: ties keep the board order
    expect(ordered(arrange(doc, [1, 2, 3], 'stack', { metrics: M, order: 'size' }))).toEqual([1, 4, 2, 3])
    const sized = deepFreeze(docOf(pic(1, { w: 50, h: 50 }), pic(2, { w: 300, h: 300 }), pic(3, { w: 100, h: 100 })))
    // largest first, so the largest is at the back
    expect(ordered(arrange(sized, [1, 2, 3], 'stack', { metrics: M, order: 'size' }))).toEqual([2, 3, 1])
  })

  it('puts every unit on the centre, and a group in the pile keeps its shape', () => {
    const doc = docOf(
      pic(1, { x: 0, y: 0, w: 100, h: 50, group: 1 }),
      pic(2, { x: 200, y: 0, w: 100, h: 50, group: 1 }),
      pic(3, { x: 700, y: 300, w: 60, h: 60 }),
    )
    const out = arrange(doc, [1, 2, 3], 'stack', { metrics: M })
    // the group's footprint [-50,250] x [-25,25] and the loose picture [670,730] x [270,330]: centre (340, 152.5)
    const g = unionRect([1, 2].map((id) => boundsOf(out, id)))
    close(midOf(g).x, 340)
    close(midOf(g).y, 152.5)
    close(midOf(boundsOf(out, 3)).x, 340)
    close(midOf(boundsOf(out, 3)).y, 152.5)
    close(itemCentre(byId(out, 2)).x - itemCentre(byId(out, 1)).x, 200)
  })
})

describe('arrange: order', () => {
  const named = (): BoardDoc =>
    docOf(
      pic(1, { path: 'c.png', x: 0, w: 100, h: 100 }),
      pic(2, { path: 'a.png', x: 300, w: 300, h: 300 }),
      pic(3, { path: 'b.png', x: 600, w: 50, h: 50 }),
      pic(4, { path: 'd.png', x: 900, w: 200, h: 200 }),
    )
  const leftToRight = (d: BoardDoc): number[] => d.items.map((i) => i.id).sort((p, q) => itemCentre(byId(d, p)).x - itemCentre(byId(d, q)).x)

  it('lays the units out in the order asked for', () => {
    const doc = named()
    const ids = [1, 2, 3, 4]
    expect(leftToRight(arrange(doc, ids, 'row', { metrics: M }))).toEqual([1, 2, 3, 4])
    expect(leftToRight(arrange(doc, ids, 'row', { metrics: M, order: 'name' }))).toEqual([2, 3, 1, 4])
    expect(leftToRight(arrange(doc, ids, 'row', { metrics: M, order: 'added' }))).toEqual([1, 2, 3, 4])
    expect(leftToRight(arrange(doc, ids, 'row', { metrics: M, order: 'size' }))).toEqual([2, 4, 1, 3])
    expect(leftToRight(arrange(docOf(...doc.items.slice().reverse()), ids, 'row', { metrics: M, order: 'added' }))).toEqual([1, 2, 3, 4])
  })

  it("'shuffle' is the shuffle sortOrder gives, and the seed decides", () => {
    const doc = docOf(...Array.from({ length: 12 }, (_, i) => pic(i + 1, { x: i * 300, y: (i % 4) * 90, w: 50 + i * 7, h: 60 })))
    const ids = doc.items.map((i) => i.id)
    const a = arrange(doc, ids, 'row', { metrics: M, order: 'shuffle', seed: 9 })
    expect(leftToRight(a)).toEqual(sortOrder(doc, ids, 'shuffle', 9))
    expect(arrange(doc, ids, 'row', { metrics: M, order: 'shuffle', seed: 9 })).toEqual(a)
    expect(leftToRight(arrange(doc, ids, 'row', { metrics: M, order: 'shuffle', seed: 10 }))).not.toEqual(leftToRight(a))
  })
})

/* ----------------------------------------------------- arrange: properties --- */

describe('arrange: properties over random boards', () => {
  it('moves only the units it should, rigidly, keeping their shapes, and leaves every other item the very same object', () => {
    for (let seed = 1; seed <= 90; seed++) {
      const { doc, ids } = scenario(seed)
      const frozen = deepFreeze(doc)
      const units = unitsOf(frozen, ids)
      const moving = new Set(units.flatMap((u) => u.ids))
      for (const mode of MODES) {
        const order = ORDERS[(seed + mode.length) % ORDERS.length]!
        const out = arrange(frozen, ids, mode, { metrics: M, order, seed })
        expect(out.items.length).toBe(frozen.items.length)
        expect(allFinite(out)).toBe(true)
        const label = `seed ${seed} ${mode} ${order}`
        for (const before of frozen.items) {
          const after = out.items.find((i) => i.id === before.id)!
          if (!moving.has(before.id)) expect(after, label).toBe(before)
        }
        if (moving.size === 0) {
          expect(out, label).toBe(frozen)
          continue
        }
        for (const u of units) {
          const first = u.ids[0]!
          const dx = itemCentre(byId(out, first)).x - itemCentre(byId(frozen, first)).x
          const dy = itemCentre(byId(out, first)).y - itemCentre(byId(frozen, first)).y
          for (const id of u.ids) {
            const c0 = itemCentre(byId(frozen, id))
            const c1 = itemCentre(byId(out, id))
            close(c1.x - c0.x, dx, 1e-8)
            close(c1.y - c0.y, dy, 1e-8)
            const a = itemSize(byId(out, id), M)
            const b = itemSize(byId(frozen, id), M)
            close(a.w, b.w)
            close(a.h, b.h)
          }
        }
        // centred on the middle of where the units were
        const was = midOf(unionRect(units.map((u) => u.rect)))
        const now = midOf(unionRect(unitsOf(out, ids).map((u) => u.rect)))
        close(now.x, was.x, 1e-8)
        close(now.y, was.y, 1e-8)
      }
    }
  })

  it('leaves no two units overlapping, a gap apart at least, in row, column, grid and optimal', () => {
    for (let seed = 100; seed < 190; seed++) {
      const { doc, ids } = scenario(seed)
      const gap = [0, 16, 5][seed % 3]!
      for (const mode of NO_OVERLAP) {
        const order = ORDERS[seed % ORDERS.length]!
        const out = arrange(doc, ids, mode, { metrics: M, gap, order, seed, aspect: [1.6, 1, 0.5, 3][seed % 4]! })
        const rects = unitsOf(out, ids).map((u) => u.rect)
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            expect(separation(rects[i]!, rects[j]!), `seed ${seed} ${mode} units ${i}/${j}`).toBeGreaterThanOrEqual(gap - 1e-6)
          }
        }
      }
    }
  })

  it('arranging an arranged selection again changes nothing (the very same doc)', () => {
    for (let seed = 200; seed < 260; seed++) {
      const { doc, ids } = scenario(seed)
      for (const mode of MODES) {
        for (const order of ORDERS.filter((o) => o !== 'shuffle')) {
          const once = arrange(doc, ids, mode, { metrics: M, order })
          const twice = arrange(once, ids, mode, { metrics: M, order })
          expect(twice, `seed ${seed} ${mode} ${order}`).toBe(once)
        }
      }
    }
  })

  it('only the stack mode changes the drawing order', () => {
    for (let seed = 300; seed < 340; seed++) {
      const { doc, ids } = scenario(seed)
      for (const mode of MODES) {
        const out = arrange(doc, ids, mode, { metrics: M, order: 'name' })
        if (mode !== 'stack') expect(ordered(out)).toEqual(ordered(doc))
        else expect([...ordered(out)].sort((a, b) => a - b)).toEqual([...ordered(doc)].sort((a, b) => a - b))
      }
    }
  })
})

describe('arrange: size of the job', () => {
  /** The board with `items` behind a proxy that counts every item read by index: the cost of a pass over the board, whatever the clock says. */
  function counted(doc: BoardDoc): { doc: BoardDoc; reads: () => number } {
    let reads = 0
    const items = new Proxy(doc.items, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    return { doc: { ...doc, items }, reads: () => reads }
  }
  const full = (): { doc: BoardDoc; ids: number[] } => {
    const r = rng(77)
    const doc = docOf(...Array.from({ length: 1500 }, (_, i) => (i % 5 === 0 ? randNote(r, i + 1) : randPic(r, i + 1))))
    return { doc, ids: doc.items.map((i) => i.id) }
  }

  it('arranges a full board of 1,500 items in every mode, with no overlap and without a pause', () => {
    const { doc, ids } = full()
    for (const mode of MODES) {
      const t = Date.now()
      const out = arrange(doc, ids, mode, { metrics: M, order: 'size' })
      expect(Date.now() - t, mode).toBeLessThan(3000)
      expect(out.items.length).toBe(1500)
      expect(allFinite(out)).toBe(true)
      if (NO_OVERLAP.includes(mode)) {
        const rects = unitsOf(out, ids).map((u) => u.rect)
        const sorted = rects.slice().sort((a, b) => a.x - b.x)
        // Sweep by x: only neighbours that overlap in x can overlap. A column makes them all so, which is a million pairs: take the
        // worst separation and ask once.
        let worst = Infinity
        for (let i = 0; i < sorted.length; i++) {
          for (let j = i + 1; j < sorted.length && sorted[j]!.x < sorted[i]!.x + sorted[i]!.w; j++) {
            worst = Math.min(worst, separation(sorted[i]!, sorted[j]!))
          }
        }
        expect(worst, mode).toBeGreaterThanOrEqual(16 - 1e-6)
      }
    }
  })

  it('reads each item a few times, not once per unit: the cost grows with the board, not with its square', () => {
    const { doc, ids } = full()
    // Linear is a few dozen passes at most (1,500 each); a pass over the board per unit would be 1,500 passes.
    const budget = 40 * 1500
    for (const mode of MODES) {
      const c = counted(doc)
      arrange(c.doc, ids, mode, { metrics: M, order: 'name' })
      expect(c.reads(), mode).toBeLessThan(budget)
    }
    for (const edge of ['left', 'centerV'] as const) {
      const c = counted(doc)
      align(c.doc, ids, edge, M)
      expect(c.reads(), edge).toBeLessThan(budget)
    }
    const d = counted(doc)
    distribute(d.doc, ids, 'h', M)
    expect(d.reads(), 'distribute').toBeLessThan(budget)
    const pics = doc.items.filter((i) => i.kind === 'picture').map((i) => i.id)
    for (const mode of ['width', 'size'] as const) {
      const n = counted(doc)
      normalize(n.doc, pics, mode, { metrics: M })
      expect(n.reads(), mode).toBeLessThan(budget)
    }
  })

  it("'optimal' still finds the shape on a board of a few giants and a thousand specks, where the row fills are too many to try one by one", () => {
    const r = rng(5)
    const giants = Array.from({ length: 30 }, (_, i) => pic(i + 1, { w: 30000 + r() * 9000, h: 30000 + r() * 9000 }))
    const specks = Array.from({ length: 1470 }, (_, i) => pic(31 + i, { w: 8 + r() * 3, h: 8 + r() * 3 }))
    // interleaved, so the rows are mixed whichever way they fill
    const items: BoardItem[] = []
    for (let i = 0; i < 1500; i++) items.push(i % 50 === 0 ? giants[i / 50]! : specks[i - Math.floor(i / 50) - 1]!)
    const doc = docOf(...items.map((it, i) => ({ ...it, id: i + 1 })))
    const gap = 16
    const aspect = 1.6
    const sizes = doc.items.map((it) => itemSize(it, M))
    const used = sizes.reduce((a, s) => a + s.w * s.h, 0)
    const score = (w: number, h: number): number => Math.abs(Math.log(w / h / aspect)) + Math.max(0, 1 - used / (w * h))
    // Independent search: a greedy fill at 4,000 widths spread over everything from the widest picture to one single row.
    let best = Infinity
    const widest = Math.max(...sizes.map((s) => s.w))
    const total = sizes.reduce((a, s) => a + s.w + gap, 0)
    for (let k = 0; k <= 4000; k++) {
      const limit = widest + (total - widest) * (k / 4000) ** 2
      let rowW = 0
      let rowH = 0
      let width = 0
      let height = 0
      sizes.forEach((s, i) => {
        if (i > 0 && rowW + gap + s.w <= limit) {
          rowW += gap + s.w
          rowH = Math.max(rowH, s.h)
        } else {
          if (i > 0) {
            width = Math.max(width, rowW)
            height += rowH + gap
          }
          rowW = s.w
          rowH = s.h
        }
      })
      width = Math.max(width, rowW)
      height += rowH
      best = Math.min(best, score(width, height))
    }
    const out = arrange(doc, doc.items.map((i) => i.id), 'optimal', { metrics: M, gap, aspect })
    const box = unionRect(out.items.map((i) => itemBounds(i, M)))
    expect(score(box.w, box.h)).toBeLessThanOrEqual(best + 0.02)
    // and it is a layout, not a long strip: nearer the wanted shape than a row of 20 times it
    expect(box.w / box.h).toBeLessThan(aspect * 3)
    expect(box.w / box.h).toBeGreaterThan(aspect / 3)
  })

  it('keeps every item inside the board even when the layout is wider than the board can be', () => {
    // 80 pictures of the largest size in a row would be 3.2 million wide; the board's coordinates stop at a million either way
    const doc = docOf(...Array.from({ length: 80 }, (_, i) => pic(i + 1, { x: i * 10, w: 40000, h: 40000 })))
    const ids = doc.items.map((i) => i.id)
    for (const mode of ['row', 'column', 'grid', 'optimal'] as const) {
      const out = arrange(doc, ids, mode, { metrics: M, columns: 80 })
      for (const it of out.items) {
        const c = itemCentre(it)
        expect(Math.abs(c.x), mode).toBeLessThanOrEqual(1_000_000)
        expect(Math.abs(c.y), mode).toBeLessThanOrEqual(1_000_000)
      }
    }
  })

  it('leaves an item whose numbers have gone bad where it is and lays out the others', () => {
    const doc = deepFreeze(docOf(pic(1, { x: 0 }), pic(2, { x: NaN }), pic(3, { x: 500 }), pic(4, { y: Infinity, x: 900 })))
    for (const mode of MODES) {
      const out = arrange(doc, [1, 2, 3, 4], mode, { metrics: M })
      expect(out.items[1], mode).toBe(doc.items[1])
      expect(out.items[3], mode).toBe(doc.items[3])
      expect(allFinite([out.items[0], out.items[2]]), mode).toBe(true)
    }
  })
})

/* ---------------------------------------------------------------- align --- */

describe('align', () => {
  it('brings every unit to the chosen edge or centre line of the rectangle round them all', () => {
    const doc = deepFreeze(abc())
    const at = (edge: AlignEdge): BoardDoc => align(doc, [1, 2, 3], edge, M)
    expectCentres(at('left'), { 1: [-40, 0], 2: [-60, 200], 3: [-50, 500] })
    expectCentres(at('right'), { 1: [280, 0], 2: [300, 200], 3: [290, 500] })
    expectCentres(at('top'), { 1: [0, 0], 2: [300, -5], 3: [-50, 15] })
    expectCentres(at('bottom'), { 1: [0, 515], 2: [300, 520], 3: [-50, 500] })
    expectCentres(at('centerH'), { 1: [120, 0], 2: [120, 200], 3: [120, 500] })
    expectCentres(at('centerV'), { 1: [0, 257.5], 2: [300, 257.5], 3: [-50, 257.5] })
  })

  it('leaves a unit that is already there the very same object', () => {
    const doc = deepFreeze(abc())
    expect(align(doc, [1, 2, 3], 'left', M).items[2]).toBe(doc.items[2])
    expect(align(doc, [1, 2, 3], 'right', M).items[1]).toBe(doc.items[1])
    expect(align(doc, [1, 2, 3], 'top', M).items[0]).toBe(doc.items[0])
    expect(align(doc, [1, 2, 3], 'bottom', M).items[2]).toBe(doc.items[2])
  })

  it('works on the rotated bounds', () => {
    const doc = docOf(pic(1, { x: 0, y: 0, w: 100, h: 50, rotation: 90 }), pic(2, { x: 100, y: 0, w: 40, h: 40 }))
    const out = align(doc, [1, 2], 'left', M)
    // 1 spans [-25, 25]; 2 [80, 120] goes to -25
    expect(out.items[0]).toBe(doc.items[0])
    expectCentres(out, { 2: [-5, 0] })
    const right = align(doc, [1, 2], 'right', M)
    expectCentres(right, { 1: [95, 0] })
  })

  it('moves a group as one, marks and all; skips locked items, loose marks and groups that cannot move', () => {
    const doc = deepFreeze(
      docOf(
        pic(1, { x: 0, y: 0, group: 1 }),
        pic(2, { x: 200, y: 100, group: 1 }),
        rect(3, -60, -30, 260, 130, { group: 1, width: 2 }),
        pic(4, { x: 900, y: 0 }),
        pic(5, { x: -1000, y: 0, locked: true }),
        rect(6, 2000, 0, 2100, 50),
        pic(7, { x: 3000, y: 0, group: 2, locked: true }),
        pic(8, { x: 3100, y: 0, group: 2 }),
      ),
    )
    const out = align(doc, [1, 2, 3, 4, 5, 6, 7, 8], 'left', M)
    for (const i of [4, 5, 6, 7]) expect(out.items[i]).toBe(doc.items[i])
    // the group's footprint left edge was -61; the loose picture's is 850: it moves to -61
    close(boundsOf(out, 4).x, -61)
    expect(out.items[0]).toBe(doc.items[0])
    expect(out.items[1]).toBe(doc.items[1])
    expect(out.items[2]).toBe(doc.items[2])
  })

  it('does nothing for fewer than two units', () => {
    const doc = deepFreeze(abc())
    for (const edge of ['left', 'right', 'top', 'bottom', 'centerH', 'centerV'] as const) {
      expect(align(doc, [2], edge, M)).toBe(doc)
      expect(align(doc, [], edge, M)).toBe(doc)
      expect(align(doc, [99], edge, M)).toBe(doc)
    }
  })

  it('on a random board: every unit ends on the line, nothing else moves, and a second go changes nothing', () => {
    for (let seed = 400; seed < 460; seed++) {
      const { doc, ids } = scenario(seed)
      const units = unitsOf(doc, ids)
      const moving = new Set(units.flatMap((u) => u.ids))
      for (const edge of ['left', 'right', 'top', 'bottom', 'centerH', 'centerV'] as const) {
        const out = align(doc, ids, edge, M)
        if (units.length < 2) {
          expect(out).toBe(doc)
          continue
        }
        const ref = unionRect(units.map((u) => u.rect))
        for (const u of unitsOf(out, ids)) {
          const b = u.rect
          if (edge === 'left') close(b.x, ref.x, 1e-8)
          if (edge === 'right') close(b.x + b.w, ref.x + ref.w, 1e-8)
          if (edge === 'top') close(b.y, ref.y, 1e-8)
          if (edge === 'bottom') close(b.y + b.h, ref.y + ref.h, 1e-8)
          if (edge === 'centerH') close(midOf(b).x, midOf(ref).x, 1e-8)
          if (edge === 'centerV') close(midOf(b).y, midOf(ref).y, 1e-8)
        }
        for (const it of doc.items) if (!moving.has(it.id)) expect(byId(out, it.id)).toBe(it)
        expect(align(out, ids, edge, M)).toBe(out)
      }
    }
  })
})

/* ----------------------------------------------------------- distribute --- */

describe('distribute', () => {
  /** Four pictures at [0,100], [120,170], [180,200], [400,430] in x. */
  function four(): BoardDoc {
    return docOf(
      pic(1, { x: 50, y: 0, w: 100, h: 40 }),
      pic(2, { x: 145, y: 30, w: 50, h: 40 }),
      pic(3, { x: 190, y: 90, w: 20, h: 40 }),
      pic(4, { x: 415, y: 10, w: 30, h: 40 }),
    )
  }

  it('spreads the units so the gaps between neighbouring rectangles are equal, keeping the two at the ends', () => {
    const doc = deepFreeze(four())
    const out = distribute(doc, [1, 2, 3, 4], 'h', M)
    expect(out.items[0]).toBe(doc.items[0])
    expect(out.items[3]).toBe(doc.items[3])
    // gap = (430 - 200) / 3
    const gap = 230 / 3
    close(boundsOf(out, 2).x, 100 + gap)
    close(boundsOf(out, 3).x, 100 + gap + 50 + gap)
    for (const [a, b] of [[1, 2], [2, 3], [3, 4]] as const) close(boundsOf(out, b).x - (boundsOf(out, a).x + boundsOf(out, a).w), gap)
    // only along the axis
    expect(itemCentre(byId(out, 2)).y).toBe(30)
    expect(itemCentre(byId(out, 3)).y).toBe(90)
  })

  it('goes down the board for "v"', () => {
    const doc = docOf(
      pic(1, { x: 0, y: 20, w: 40, h: 40 }),
      pic(2, { x: 50, y: 70, w: 40, h: 40 }),
      pic(3, { x: 99, y: 500, w: 40, h: 100 }),
    )
    const out = distribute(doc, [1, 2, 3], 'v', M)
    // [0,40], [50,90], [450,550]: gap (550 - 0 - 180) / 2 = 185 -> the middle one at 40 + 185
    close(boundsOf(out, 2).y, 225)
    expect(itemCentre(byId(out, 2)).x).toBe(50)
    expect(out.items[0]).toBe(doc.items[0])
    expect(out.items[2]).toBe(doc.items[2])
  })

  it('goes by position, not by the order of the ids or of the board', () => {
    const shuffled = docOf(...four().items.slice().reverse())
    const out = distribute(shuffled, [3, 1, 4, 2], 'h', M)
    const gap = 230 / 3
    close(boundsOf(out, 2).x, 100 + gap)
    close(boundsOf(out, 3).x, 100 + gap + 50 + gap)
  })

  it('needs three units; fewer change nothing', () => {
    const doc = deepFreeze(four())
    expect(distribute(doc, [1, 2], 'h', M)).toBe(doc)
    expect(distribute(doc, [1], 'v', M)).toBe(doc)
    expect(distribute(doc, [], 'h', M)).toBe(doc)
    expect(distribute(doc, [1, 2, 99], 'h', M)).toBe(doc)
  })

  it('keeps a group whole and skips locked items', () => {
    const doc = deepFreeze(
      docOf(
        pic(1, { x: 0, y: 0, w: 100, h: 40 }),
        pic(2, { x: 200, y: 0, w: 100, h: 40, group: 1 }),
        pic(3, { x: 260, y: 60, w: 40, h: 40, group: 1 }),
        pic(4, { x: 300, y: 0, w: 40, h: 40, locked: true }),
        pic(5, { x: 1000, y: 0, w: 100, h: 40 }),
      ),
    )
    const out = distribute(doc, [1, 2, 3, 4, 5], 'h', M)
    expect(out.items[3]).toBe(doc.items[3])
    // units: 1 [-50,50], the group [150,280] (picture 2 spans 150..250, picture 3 240..280, so 130 wide), 5 [950,1050];
    // the locked 4 is not a unit. Gap (1100 - 100 - 130 - 100) / 2 = 385 -> the group's left edge at 50 + 385 = 435
    close(boundsOf(out, 2).x, 435)
    close(boundsOf(out, 3).x + boundsOf(out, 3).w, 435 + 130)
    close(boundsOf(out, 5).x - (boundsOf(out, 3).x + boundsOf(out, 3).w), 385)
    close(itemCentre(byId(out, 3)).x - itemCentre(byId(out, 2)).x, 60)
    close(itemCentre(byId(out, 3)).y - itemCentre(byId(out, 2)).y, 60)
  })

  it('on a random board: equal gaps between units in order, the ends stay, nothing else moves', () => {
    for (let seed = 500; seed < 560; seed++) {
      const r = rng(seed)
      const n = 3 + Math.floor(r() * 9)
      const doc = docOf(...Array.from({ length: n }, (_, i) => randPic(r, i + 1)))
      const ids = doc.items.map((i) => i.id)
      for (const axis of ['h', 'v'] as const) {
        const before = unitsOf(doc, ids).map((u) => ({ id: u.ids[0]!, rect: u.rect }))
        const key = (rr: Rect): number => (axis === 'h' ? rr.x + rr.w / 2 : rr.y + rr.h / 2)
        const order = before.slice().sort((a, b) => key(a.rect) - key(b.rect))
        const out = distribute(doc, ids, axis, M)
        const after = order.map((o) => boundsOf(out, o.id))
        expect(byId(out, order[0]!.id)).toBe(byId(doc, order[0]!.id))
        expect(byId(out, order[n - 1]!.id)).toBe(byId(doc, order[n - 1]!.id))
        const gaps = after.slice(1).map((b, i) => (axis === 'h' ? b.x - (after[i]!.x + after[i]!.w) : b.y - (after[i]!.y + after[i]!.h)))
        for (const g of gaps) close(g, gaps[0]!, 1e-7)
        // the other axis is untouched
        order.forEach((o, i) => close(axis === 'h' ? after[i]!.y : after[i]!.x, axis === 'h' ? o.rect.y : o.rect.x, 1e-8))
      }
    }
  })
})

/* ------------------------------------------------------------ normalize --- */

describe('normalize', () => {
  /** Shown 100x50, 200x100 and 200x200 (a picture cropped to its middle half). */
  function three(): BoardDoc {
    return docOf(
      pic(1, { x: 0, y: 0, w: 100, h: 50 }),
      pic(2, { x: 500, y: 40, w: 200, h: 100, rotation: 30, flipH: true }),
      pic(3, { x: -300, y: 200, w: 400, h: 200, crop: { l: 0.25, t: 0, r: 0.75, b: 1 }, opacity: 0.5, caption: 'c' }),
    )
  }
  const shown = (d: BoardDoc, id: number): { w: number; h: number } => itemSize(byId(d, id), M)

  it("'width' makes the shown widths equal (the mean by default), keeping proportions, centres, turns and crops", () => {
    const doc = deepFreeze(three())
    const out = normalize(doc, [1, 2, 3], 'width')
    const mean = (100 + 200 + 200) / 3
    for (const id of [1, 2, 3]) {
      close(shown(out, id).w, mean)
      const a = byId(out, id) as PictureItem
      const b = byId(doc, id) as PictureItem
      close(a.w / a.h, b.w / b.h)
      expect({ ...a, w: 0, h: 0 }).toEqual({ ...b, w: 0, h: 0 })
    }
  })

  it("'height' makes the shown heights equal", () => {
    const out = normalize(deepFreeze(three()), [1, 2, 3], 'height')
    const mean = (50 + 100 + 200) / 3
    for (const id of [1, 2, 3]) close(shown(out, id).h, mean)
  })

  it("'size' makes the shown areas equal (the mean area by default), keeping proportions", () => {
    const doc = deepFreeze(three())
    const out = normalize(doc, [1, 2, 3], 'size')
    const mean = (5000 + 20000 + 40000) / 3
    for (const id of [1, 2, 3]) {
      const s = shown(out, id)
      close(s.w * s.h, mean, 1e-9)
      const a = byId(out, id) as PictureItem
      const b = byId(doc, id) as PictureItem
      close(a.w / a.h, b.w / b.h)
    }
    // sides scale by the square root of the area: 100 x 50 to area 21666.67 is a factor 2.0817
    close(shown(out, 1).w, 100 * Math.sqrt(mean / 5000), 1e-9)
  })

  it('takes a target: a width, a height, an area', () => {
    const doc = deepFreeze(three())
    for (const id of [1, 2, 3]) {
      close(shown(normalize(doc, [1, 2, 3], 'width', { target: 120 }), id).w, 120)
      close(shown(normalize(doc, [1, 2, 3], 'height', { target: 80 }), id).h, 80)
      const s = shown(normalize(doc, [1, 2, 3], 'size', { target: 10000 }), id)
      close(s.w * s.h, 10000)
    }
  })

  it('a target that is not a positive number is the mean', () => {
    const doc = three()
    const mean = normalize(doc, [1, 2, 3], 'width')
    for (const target of [0, -5, NaN, Infinity]) expect(normalize(doc, [1, 2, 3], 'width', { target })).toEqual(mean)
  })

  it('leaves alone locked pictures, notes, marks and what is not listed; the mean is of the pictures that change', () => {
    const doc = deepFreeze(
      docOf(
        pic(1, { x: 0, y: 0, w: 100, h: 50 }),
        pic(2, { x: 500, y: 0, w: 300, h: 150, locked: true }),
        pic(3, { x: 0, y: 300, w: 200, h: 100 }),
        note(4, { x: 0, y: 600 }),
        rect(5, 0, 0, 10, 10),
        pic(6, { x: 900, y: 0, w: 1000, h: 500 }),
      ),
    )
    const out = normalize(doc, [1, 2, 3, 4, 5], 'width')
    expect(out.items[1]).toBe(doc.items[1])
    expect(out.items[3]).toBe(doc.items[3])
    expect(out.items[4]).toBe(doc.items[4])
    expect(out.items[5]).toBe(doc.items[5])
    close(shown(out, 1).w, 150)
    close(shown(out, 3).w, 150)
    // nothing to change
    expect(normalize(doc, [2, 4, 5], 'size')).toBe(doc)
    expect(normalize(doc, [], 'height')).toBe(doc)
    expect(normalize(doc, [99], 'width')).toBe(doc)
  })

  it('one picture is its own mean: nothing changes', () => {
    const doc = docOf(pic(1, { w: 123, h: 77, crop: { l: 0.1, t: 0.2, r: 0.9, b: 0.7 } }))
    expect(normalize(doc, [1], 'width', { metrics: M })).toEqual(doc)
  })

  it("'scale' sets the whole picture's width to the natural width times the target, 1 by default, and skips pictures with no known natural size", () => {
    const doc = deepFreeze(
      docOf(pic(1, { path: 'a.png', x: 0, y: 0, w: 100, h: 50 }), pic(2, { path: 'b.png', x: 400, y: 0, w: 60, h: 30 }), pic(3, { path: 'c.png', x: 0, y: 300, w: 80, h: 80, crop: { l: 0, t: 0, r: 0.5, b: 1 } })),
    )
    const natural = (path: string): { w: number; h: number } | null => (path === 'a.png' ? { w: 1000, h: 500 } : path === 'c.png' ? { w: 400, h: 400 } : null)
    const one = normalize(doc, [1, 2, 3], 'scale', { natural })
    expect((byId(one, 1) as PictureItem).w).toBeCloseTo(1000, 6)
    expect((byId(one, 1) as PictureItem).h).toBeCloseTo(500, 6)
    expect(one.items[1]).toBe(doc.items[1])
    // the whole picture's width, not the shown part's
    expect((byId(one, 3) as PictureItem).w).toBeCloseTo(400, 6)
    const half = normalize(doc, [1, 2, 3], 'scale', { natural, target: 0.5 })
    expect((byId(half, 1) as PictureItem).w).toBeCloseTo(500, 6)
    expect((byId(half, 3) as PictureItem).w).toBeCloseTo(200, 6)
    // centres stay
    expect(itemCentre(byId(half, 1))).toEqual({ x: 0, y: 0 })
    expect(normalize(doc, [1, 2, 3], 'scale')).toBe(doc)
    expect(normalize(doc, [1, 2, 3], 'scale', { natural: () => null })).toBe(doc)
    expect(normalize(doc, [1], 'scale', { natural: () => ({ w: 0, h: 10 }) })).toBe(doc)
    expect(normalize(doc, [1], 'scale', { natural: () => ({ w: NaN, h: 10 }) })).toBe(doc)
    // an unusable target is 1
    expect((byId(normalize(doc, [1], 'scale', { natural, target: -3 }), 1) as PictureItem).w).toBeCloseTo(1000, 6)
  })

  it('stays inside the picture limits, keeping proportions', () => {
    const doc = docOf(pic(1, { w: 100, h: 50 }), pic(2, { x: 300, w: 100, h: 50 }))
    const out = normalize(doc, [1, 2], 'width', { target: 1 })
    const p = byId(out, 1) as PictureItem
    // the short side may not go under 8: 50 -> 8 takes the width to 16
    expect(p.h).toBeCloseTo(8, 6)
    expect(p.w).toBeCloseTo(16, 6)
    const big = normalize(doc, [1, 2], 'width', { target: 1e9 })
    expect(Math.max((byId(big, 1) as PictureItem).w, (byId(big, 1) as PictureItem).h)).toBeLessThanOrEqual(40000 + 1e-6)
  })

  it('on random pictures: the measure is equal for all, centres do not move, and nothing else changes', () => {
    for (let seed = 600; seed < 650; seed++) {
      const r = rng(seed)
      const n = 2 + Math.floor(r() * 7)
      const doc = deepFreeze(docOf(...Array.from({ length: n }, (_, i) => randPic(r, i + 1))))
      const ids = doc.items.map((i) => i.id)
      for (const mode of ['width', 'height', 'size'] as const) {
        const out = normalize(doc, ids, mode, { metrics: M })
        const measure = (id: number): number => {
          const s = itemSize(byId(out, id), M)
          return mode === 'width' ? s.w : mode === 'height' ? s.h : s.w * s.h
        }
        for (const id of ids) {
          close(measure(id), measure(ids[0]!), 1e-7)
          const a = byId(out, id) as PictureItem
          const b = byId(doc, id) as PictureItem
          expect({ ...a, w: 0, h: 0 }).toEqual({ ...b, w: 0, h: 0 })
          close(a.w / a.h, b.w / b.h, 1e-9)
        }
      }
    }
  })
})
