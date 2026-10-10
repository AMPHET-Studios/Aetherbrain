import { describe, expect, it } from 'vitest'
import { itemBounds, itemCentre, itemQuad, itemSize, noteBox, normalizeAngle, rotatePoint } from '../src/board/geometry'
import {
  BOARD_ITEM_LIMITS,
  type NewMark,
  addMark,
  addNote,
  addPicture,
  duplicateItems,
  flipItems,
  group,
  lockItems,
  moveItems,
  removeItems,
  reorder,
  resetCrop,
  resizeNote,
  resizePicture,
  rotateItems,
  scaleItems,
  setCrop,
  setProps,
  ungroup,
} from '../src/board/ops'
import {
  BOARD_LIMITS,
  emptyBoard,
  type BoardDoc,
  type BoardItem,
  type Crop,
  type EllipseItem,
  type LineItem,
  type NoteItem,
  type PictureItem,
  type RectItem,
  type StrokeItem,
  type TextMetrics,
  type Vec2,
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

function randPic(r: () => number, id: number): PictureItem {
  return pic(id, {
    x: (r() - 0.5) * 2000, y: (r() - 0.5) * 2000, w: 20 + r() * 400, h: 20 + r() * 400, rotation: (r() - 0.5) * 358,
    crop: { l: r() * 0.4, t: r() * 0.4, r: 0.6 + r() * 0.4, b: 0.6 + r() * 0.4 }, flipH: r() < 0.5, flipV: r() < 0.5,
    opacity: 0.1 + r() * 0.9, caption: r() < 0.5 ? 'c' : '',
  })
}
function randNote(r: () => number, id: number): NoteItem {
  const words = ['alpha', 'be', 'gamma ray', 'x', 'delta force', 'omega']
  return note(id, {
    text: Array.from({ length: 1 + Math.floor(r() * 12) }, () => words[Math.floor(r() * words.length)]!).join(' '),
    x: (r() - 0.5) * 2000, y: (r() - 0.5) * 2000, w: 60 + r() * 300, size: 8 + r() * 40, rotation: (r() - 0.5) * 358,
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
function randItem(r: () => number, id: number): BoardItem {
  const k = r()
  return k < 0.35 ? randPic(r, id) : k < 0.55 ? randNote(r, id) : randMark(r, id)
}
function randDoc(r: () => number, n: number, lockedShare = 0): BoardDoc {
  const items: BoardItem[] = []
  for (let i = 1; i <= n; i++) {
    const it = randItem(r, i)
    items.push(r() < lockedShare ? { ...it, locked: true } : it)
  }
  return docOf(...items)
}

/** The whole structure equal, numbers within a relative eps. */
function expectClose(a: unknown, b: unknown, eps = 1e-9, path = 'doc'): void {
  if (typeof a === 'number' && typeof b === 'number') {
    expect(Math.abs(a - b), `${path}: ${a} vs ${b}`).toBeLessThanOrEqual(eps * Math.max(1, Math.abs(a), Math.abs(b)))
  } else if (Array.isArray(a) && Array.isArray(b)) {
    expect(a.length, `${path}.length`).toBe(b.length)
    a.forEach((v, i) => expectClose(v, b[i], eps, `${path}[${i}]`))
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    expect(Object.keys(a).sort(), `${path} keys`).toEqual(Object.keys(b).sort())
    for (const k of Object.keys(a)) expectClose((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], eps, `${path}.${k}`)
  } else expect(a, path).toEqual(b)
}

function allFinite(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every(allFinite)
  if (v && typeof v === 'object') return Object.values(v).every(allFinite)
  return true
}

/** The board position of the picture's pixel at fraction (u, v) of the whole picture: the draw model of types.ts, written out independently. */
function pixelAt(it: PictureItem, u: number, v: number): Vec2 {
  const c = it.crop
  const lx = (u - (c.l + c.r) / 2) * it.w * (it.flipH ? -1 : 1)
  const ly = (v - (c.t + c.b) / 2) * it.h * (it.flipV ? -1 : 1)
  return rotatePoint({ x: it.x + lx, y: it.y + ly }, { x: it.x, y: it.y }, it.rotation)
}

function closeV(a: Vec2, b: Vec2, eps = 1e-8): void {
  expect(Math.abs(a.x - b.x), `x ${a.x} vs ${b.x}`).toBeLessThanOrEqual(eps * Math.max(1, Math.abs(a.x)))
  expect(Math.abs(a.y - b.y), `y ${a.y} vs ${b.y}`).toBeLessThanOrEqual(eps * Math.max(1, Math.abs(a.y)))
}

/* --------------------------------------------------------------- adding --- */

describe('addPicture', () => {
  it('adds on top with the next id and leaves the old doc alone', () => {
    const doc = deepFreeze(docOf(pic(1), pic(2)))
    const r = addPicture(doc, { path: 'a/b.png', w: 300, h: 200, x: 10, y: 20 })
    expect(r.id).toBe(3)
    expect(r.doc.nextId).toBe(4)
    expect(r.doc.items.map((i) => i.id)).toEqual([1, 2, 3])
    expect(r.doc.items[0]).toBe(doc.items[0])
    expect(r.doc.items[1]).toBe(doc.items[1])
    expect(r.doc.items[2]).toEqual(
      pic(3, { path: 'a/b.png', w: 300, h: 200, x: 10, y: 20 }),
    )
    expect(doc.items.length).toBe(2)
  })
  it('goes to the centre of the view when no place is given', () => {
    const doc = { ...docOf(), view: { x: 40, y: -20, zoom: 2 } }
    const p = addPicture(doc, { path: 'a.png', w: 100, h: 100 }).doc.items[0] as PictureItem
    expect([p.x, p.y]).toEqual([40, -20])
  })
  it('brings sizes inside the limits, keeping the proportions where it can', () => {
    const size = (w: number, h: number): [number, number] => {
      const p = addPicture(docOf(), { path: 'a.png', w, h }).doc.items[0] as PictureItem
      return [p.w, p.h]
    }
    expect(size(1, 1)).toEqual([BOARD_LIMITS.pictureMin, BOARD_LIMITS.pictureMin])
    expect(size(1e6, 5e5)).toEqual([BOARD_LIMITS.pictureMax, BOARD_LIMITS.pictureMax / 2])
    expect(size(4, 2)).toEqual([16, 8])
    expect(size(5, 1000)).toEqual([8, 1600])
    expect(size(300, 200)).toEqual([300, 200])
    // a sliver that cannot satisfy both limits keeps its long side inside the maximum
    const [w, h] = size(40000, 5)
    expect(w).toBe(BOARD_LIMITS.pictureMax)
    expect(h).toBeGreaterThanOrEqual(BOARD_LIMITS.pictureMin)
  })
  it('replaces sizes that are not numbers', () => {
    const p = (w: number, h: number): PictureItem => addPicture(docOf(), { path: 'a.png', w, h }).doc.items[0] as PictureItem
    expect([p(NaN, NaN).w, p(NaN, NaN).h]).toEqual([256, 256])
    expect([p(NaN, 100).w, p(NaN, 100).h]).toEqual([100, 100])
    expect([p(-5, 100).w, p(-5, 100).h]).toEqual([100, 100])
    expect([p(Infinity, 100).w, p(Infinity, 100).h]).toEqual([100, 100])
  })
  it('keeps rotation, opacity and the crop valid, and does not share the crop it was given', () => {
    const crop = { l: 0.1, t: 0.1, r: 0.9, b: 0.9 }
    const p = addPicture(docOf(), { path: 'a.png', w: 10, h: 10, rotation: 270, opacity: 5, crop }).doc.items[0] as PictureItem
    expect(p.rotation).toBe(-90)
    expect(p.opacity).toBe(1)
    expect(p.crop).toEqual(crop)
    expect(p.crop).not.toBe(crop)
    expect((addPicture(docOf(), { path: 'a.png', w: 10, h: 10, opacity: 0 }).doc.items[0] as PictureItem).opacity).toBe(0.05)
    expect((addPicture(docOf(), { path: 'a.png', w: 10, h: 10, crop: { l: 0.5, t: 0, r: 0.5, b: 1 } }).doc.items[0] as PictureItem).crop).toEqual({ l: 0, t: 0, r: 1, b: 1 })
  })
  it('refuses past BOARD_LIMITS.items: the same doc and no id', () => {
    const full = docOf(...Array.from({ length: BOARD_LIMITS.items }, (_, i) => pic(i + 1)))
    const r = addPicture(full, { path: 'a.png', w: 10, h: 10 })
    expect(r.doc).toBe(full)
    expect(r.id).toBeNull()
    const almost = docOf(...Array.from({ length: BOARD_LIMITS.items - 1 }, (_, i) => pic(i + 1)))
    const ok = addPicture(almost, { path: 'a.png', w: 10, h: 10 })
    expect(ok.id).toBe(BOARD_LIMITS.items)
    expect(ok.doc.items.length).toBe(BOARD_LIMITS.items)
  })
  it('never hands out an id that is taken, even when nextId is stale', () => {
    const doc = { ...docOf(pic(5), pic(9)), nextId: 3 }
    expect(addPicture(doc, { path: 'a.png', w: 10, h: 10 }).id).toBe(10)
    expect(addPicture({ ...docOf(), nextId: NaN }, { path: 'a.png', w: 10, h: 10 }).id).toBe(1)
  })
  it('keeps a place that is not a number out of the board', () => {
    const p = addPicture(docOf(), { path: 'a.png', w: 10, h: 10, x: NaN, y: 1e12 }).doc.items[0] as PictureItem
    expect(p.x).toBe(0)
    expect(p.y).toBe(BOARD_LIMITS.coordinate)
  })
})

describe('addNote', () => {
  it('has defaults that read on the board background', () => {
    const dark = addNote(docOf()).doc.items[0] as NoteItem
    expect([dark.text, dark.w, dark.size, dark.color, dark.fill, dark.rotation]).toEqual(['', 240, 18, 'ffffff', '', 0])
    const light = addNote({ ...docOf(), bg: 'f0f0f0' }).doc.items[0] as NoteItem
    expect(light.color).toBe('111111')
  })
  it('cuts the text, and keeps size, width and colours valid', () => {
    const n = addNote(docOf(), { text: 'x'.repeat(BOARD_LIMITS.noteChars + 50), size: 1, w: 1, color: '#FF8800', fill: 'nope' }).doc.items[0] as NoteItem
    expect(n.text.length).toBe(BOARD_LIMITS.noteChars)
    expect(n.size).toBe(BOARD_ITEM_LIMITS.noteSize.min)
    expect(n.w).toBe(BOARD_ITEM_LIMITS.noteWidth.min)
    expect(n.color).toBe('ff8800')
    expect(n.fill).toBe('')
    expect((addNote(docOf(), { size: 1e9, w: 1e12 }).doc.items[0] as NoteItem).size).toBe(BOARD_ITEM_LIMITS.noteSize.max)
    expect((addNote(docOf(), { size: 1e9, w: 1e12 }).doc.items[0] as NoteItem).w).toBe(BOARD_ITEM_LIMITS.noteWidth.max)
    expect((addNote(docOf(), { color: 'zzz' }).doc.items[0] as NoteItem).color).toBe('ffffff')
  })
  it('refuses on a full board', () => {
    const full = docOf(...Array.from({ length: BOARD_LIMITS.items }, (_, i) => pic(i + 1)))
    expect(addNote(full)).toEqual({ doc: full, id: null })
    expect(addNote(full).doc).toBe(full)
  })
})

describe('addMark', () => {
  it('adds each kind on top', () => {
    let doc = docOf(pic(1))
    const marks: NewMark[] = [
      { kind: 'stroke', points: [0, 0, 10, 10], color: 'ff0000', width: 3 },
      { kind: 'line', x1: 0, y1: 0, x2: 5, y2: 5, color: 'ff0000', width: 3, arrow: true },
      { kind: 'rect', x1: 0, y1: 0, x2: 5, y2: 5, color: 'ff0000', width: 3, fill: '' },
      { kind: 'ellipse', x1: 0, y1: 0, x2: 5, y2: 5, color: 'ff0000', width: 3, fill: '00ff00' },
    ]
    for (const mark of marks) {
      const r = addMark(doc, mark)
      expect(r.id).toBe(doc.nextId)
      expect(r.doc.items[r.doc.items.length - 1]).toMatchObject({ ...mark, id: r.id, group: 0, locked: false })
      doc = r.doc
    }
    expect(doc.items.map((i) => i.id)).toEqual([1, 2, 3, 4, 5])
  })
  it('refuses a stroke with no point, copies its points, and cleans numbers that are not numbers', () => {
    const none = docOf()
    expect(addMark(none, { kind: 'stroke', points: [], color: 'ff0000', width: 3 })).toEqual({ doc: none, id: null })
    const pts = [1, 2, 3, 4]
    const r = addMark(none, { kind: 'stroke', points: pts, color: 'ff0000', width: 3 })
    pts[0] = 999
    expect((r.doc.items[0] as StrokeItem).points).toEqual([1, 2, 3, 4])
    const bad = addMark(none, { kind: 'stroke', points: [5, 6, NaN, Infinity, 9, 10], color: 'ff0000', width: NaN })
    const s = bad.doc.items[0] as StrokeItem
    expect(s.points).toEqual([5, 6, 5, 6, 9, 10])
    expect(s.width).toBe(2)
  })
  it('keeps a line width inside its range and colours as 6 hex digits', () => {
    const l = (w: number): LineItem => addMark(docOf(), { kind: 'line', x1: 0, y1: 0, x2: 5, y2: 5, color: '#AABBCC', width: w, arrow: false }).doc.items[0] as LineItem
    expect(l(0).width).toBe(BOARD_ITEM_LIMITS.markWidth.min)
    expect(l(1e9).width).toBe(BOARD_ITEM_LIMITS.markWidth.max)
    expect(l(5).color).toBe('aabbcc')
  })
})

/* ------------------------------------------------------------ move/scale -- */

describe('moveItems', () => {
  it('shifts the bounds of every kind of item by (dx, dy) and leaves the rest as it was', () => {
    const r = rng(20)
    const doc = deepFreeze(randDoc(r, 40))
    const ids = doc.items.filter((i) => i.id % 2 === 0).map((i) => i.id)
    const moved = moveItems(doc, ids, 13.5, -7.25)
    for (const it of doc.items) {
      const after = byId(moved, it.id)
      if (!ids.includes(it.id)) {
        expect(after).toBe(it)
        continue
      }
      const b0 = itemBounds(it, M)
      const b1 = itemBounds(after, M)
      expectClose(b1, { x: b0.x + 13.5, y: b0.y - 7.25, w: b0.w, h: b0.h })
    }
  })
  it('moves one member of a group without the others (groups are the controller\'s business)', () => {
    const doc = docOf(pic(1, { group: 1 }), pic(2, { group: 1 }))
    const moved = moveItems(doc, [1], 10, 0)
    expect((byId(moved, 1) as PictureItem).x).toBe(10)
    expect(byId(moved, 2)).toBe(byId(doc, 2))
  })
  it('moving there and back is the identity (random boards, all kinds)', () => {
    const r = rng(21)
    for (let i = 0; i < 30; i++) {
      const doc = randDoc(r, 20)
      const ids = doc.items.map((it) => it.id)
      const dx = (r() - 0.5) * 3000
      const dy = (r() - 0.5) * 3000
      expectClose(moveItems(moveItems(doc, ids, dx, dy), ids, -dx, -dy), doc)
    }
  })
  it('does nothing for a zero move, no ids, unknown ids or a move that is not a number', () => {
    const doc = docOf(pic(1), pic(2))
    expect(moveItems(doc, [1], 0, 0)).toBe(doc)
    expect(moveItems(doc, [], 5, 5)).toBe(doc)
    expect(moveItems(doc, [7], 5, 5)).toBe(doc)
    expect(moveItems(doc, [1], NaN, NaN)).toBe(doc)
    const half = moveItems(doc, [1], NaN, 5)
    expect(allFinite(half)).toBe(true)
    expect((byId(half, 1) as PictureItem).y).toBe(5)
  })
  it('stops at the coordinate limit as a whole, whatever the kind', () => {
    const L = BOARD_LIMITS.coordinate
    const doc = docOf(pic(1, { x: L - 10, y: 0 }), stroke(2, [L - 100, 0, L - 20, 5]), line(3, 0, 0, 1, 1))
    const moved = moveItems(doc, [1, 2], 500, 0)
    expect((byId(moved, 1) as PictureItem).x).toBe(L)
    // the stroke is held back by the same amount, so it keeps its shape
    expect((byId(moved, 2) as StrokeItem).points).toEqual([L - 90, 0, L - 10, 5])
    expect(moveItems(doc, [1], 5, 0)).not.toBe(doc)
    expect((byId(moveItems(doc, [1], -(2 * L), 0), 1) as PictureItem).x).toBe(-L)
    // already at the limit: asking for more is a no-op
    expect(moveItems(moved, [1, 2], 500, 0)).toBe(moved)
  })
})

describe('scaleItems', () => {
  it('scales the shown part of a picture about the anchor: every corner of its quad follows', () => {
    const r = rng(22)
    for (let i = 0; i < 100; i++) {
      const p = randPic(r, 1)
      const anchor = { x: (r() - 0.5) * 1000, y: (r() - 0.5) * 1000 }
      const f = 0.5 + r() * 1.5
      const q0 = itemQuad(p, M)
      const q1 = itemQuad(byId(scaleItems(docOf(p), [1], f, anchor), 1), M)
      for (let k = 0; k < 4; k++) closeV(q1[k]!, { x: anchor.x + (q0[k]!.x - anchor.x) * f, y: anchor.y + (q0[k]!.y - anchor.y) * f })
    }
  })
  it('scales a note\'s position, width and size; a mark\'s points and line width', () => {
    const doc = docOf(
      note(1, { x: 10, y: 20, w: 100, size: 10 }),
      stroke(2, [10, 10, 20, 30], { width: 4 }),
      line(3, 0, 0, 10, 10, { width: 2 }),
      rect(4, 0, 0, 10, 20, { width: 3 }),
      ellipse(5, 10, 10, 20, 20, { width: 3 }),
    )
    const s = scaleItems(doc, [1, 2, 3, 4, 5], 2, { x: 10, y: 10 })
    expect(byId(s, 1)).toMatchObject({ x: 10, y: 30, w: 200, size: 20 })
    expect(byId(s, 2)).toMatchObject({ points: [10, 10, 30, 50], width: 8 })
    expect(byId(s, 3)).toMatchObject({ x1: -10, y1: -10, x2: 10, y2: 10, width: 4 })
    expect(byId(s, 4)).toMatchObject({ x1: -10, y1: -10, x2: 10, y2: 30, width: 6 })
    expect(byId(s, 5)).toMatchObject({ x1: 10, y1: 10, x2: 30, y2: 30, width: 6 })
  })
  it('scaling by f and then by 1/f is the identity', () => {
    const r = rng(23)
    for (let i = 0; i < 30; i++) {
      const doc = randDoc(r, 20)
      const ids = doc.items.map((it) => it.id)
      const f = 0.5 + r() * 1.5
      const anchor = { x: (r() - 0.5) * 1000, y: (r() - 0.5) * 1000 }
      expectClose(scaleItems(scaleItems(doc, ids, f, anchor), ids, 1 / f, anchor), doc, 1e-8)
    }
  })
  it('holds the factor so pictures stay within the size limits, and the whole selection scales by the same factor', () => {
    const doc = docOf(pic(1, { w: 100, h: 50, x: 100, y: 0 }), pic(2, { w: 1000, h: 1000, x: 0, y: 0 }))
    const big = scaleItems(doc, [1, 2], 1e6, { x: 0, y: 0 })
    // picture 2 reaches 40000 at x40; picture 1 would reach 4000 only
    expect((byId(big, 2) as PictureItem).w).toBe(BOARD_LIMITS.pictureMax)
    expect((byId(big, 1) as PictureItem).w).toBe(4000)
    expect((byId(big, 1) as PictureItem).x).toBe(4000)
    const small = scaleItems(doc, [1, 2], 1e-9, { x: 0, y: 0 })
    // picture 1 is 50 high: the factor stops at 8/50
    expect((byId(small, 1) as PictureItem).h).toBeCloseTo(BOARD_LIMITS.pictureMin, 9)
    expect((byId(small, 1) as PictureItem).w).toBeCloseTo(16, 9)
    expect((byId(small, 2) as PictureItem).w).toBeCloseTo(160, 9)
    // a picture already at the cap cannot grow, so nothing in the selection does
    const capped = docOf(pic(1, { w: BOARD_LIMITS.pictureMax, h: 100 }), pic(2, { x: 200 }))
    expect(scaleItems(capped, [1, 2], 2, { x: 0, y: 0 })).toBe(capped)
  })
  it('keeps coordinates inside the board by holding the factor back', () => {
    const L = BOARD_LIMITS.coordinate
    const doc = docOf(pic(1, { x: 900_000, y: 0 }), stroke(2, [-500_000, 0, 500_000, 0]))
    const s = scaleItems(doc, [1, 2], 10, { x: 0, y: 0 })
    expect((byId(s, 1) as PictureItem).x).toBeCloseTo(L, 3)
    for (const v of (byId(s, 2) as StrokeItem).points) expect(Math.abs(v)).toBeLessThanOrEqual(L + 1e-6)
    expect((byId(s, 2) as StrokeItem).points[2]).toBeCloseTo(L / 900_000 * 500_000, 3)
  })
  it('does nothing for a factor of 1, a factor or anchor that is not usable, or no items', () => {
    const doc = docOf(pic(1))
    expect(scaleItems(doc, [1], 1, { x: 0, y: 0 })).toBe(doc)
    expect(scaleItems(doc, [1], NaN, { x: 0, y: 0 })).toBe(doc)
    expect(scaleItems(doc, [1], 0, { x: 0, y: 0 })).toBe(doc)
    expect(scaleItems(doc, [1], -2, { x: 0, y: 0 })).toBe(doc)
    expect(scaleItems(doc, [1], Infinity, { x: 0, y: 0 })).toBe(doc)
    expect(scaleItems(doc, [1], 2, { x: NaN, y: 0 })).toBe(doc)
    expect(scaleItems(doc, [], 2, { x: 0, y: 0 })).toBe(doc)
  })
  it('keeps a mark\'s line width above its minimum without touching its shape', () => {
    const doc = docOf(stroke(1, [0, 0, 100, 100], { width: 0.006 }))
    const s = byId(scaleItems(doc, [1], 0.5, { x: 0, y: 0 }), 1) as StrokeItem
    expect(s.points).toEqual([0, 0, 50, 50])
    expect(s.width).toBe(BOARD_ITEM_LIMITS.markWidth.min)
  })
})

describe('resizePicture', () => {
  it('sets the width, keeps the proportions, and keeps the chosen point of the box where it was', () => {
    const r = rng(24)
    for (let i = 0; i < 150; i++) {
      const p = randPic(r, 1)
      const a = { x: r() - 0.5, y: r() - 0.5 }
      const newW = p.w * (0.5 + r() * 1.5)
      const size = itemSize(p, M)
      const world = (it: PictureItem, s: { w: number; h: number }): Vec2 =>
        rotatePoint({ x: it.x + a.x * s.w, y: it.y + a.y * s.h }, { x: it.x, y: it.y }, it.rotation)
      const before = world(p, size)
      const out = byId(resizePicture(docOf(p), 1, newW, a), 1) as PictureItem
      expect(out.w).toBeCloseTo(newW, 9)
      expect(out.h / out.w).toBeCloseTo(p.h / p.w, 9)
      expect(out.crop).toEqual(p.crop)
      expect(out.rotation).toBe(p.rotation)
      closeV(world(out, itemSize(out, M)), before)
    }
  })
  it('drags a corner: the opposite corner stays, on a turned picture too', () => {
    const p = pic(1, { x: 100, y: 100, w: 200, h: 100, rotation: 30 })
    const q = itemQuad(p, M)
    const out = byId(resizePicture(docOf(p), 1, 400, { x: -0.5, y: -0.5 }), 1) as PictureItem
    const q2 = itemQuad(out, M)
    closeV(q2[0]!, q[0]!)
    expect(Math.hypot(q2[1]!.x - q2[0]!.x, q2[1]!.y - q2[0]!.y)).toBeCloseTo(400, 9)
  })
  it('holds the size inside the limits, ignores other kinds, locked pictures and bad widths', () => {
    const doc = docOf(pic(1, { w: 100, h: 50 }), pic(2, { locked: true }), note(3))
    expect((byId(resizePicture(doc, 1, 1e9), 1) as PictureItem).w).toBe(BOARD_LIMITS.pictureMax)
    expect((byId(resizePicture(doc, 1, 1), 1) as PictureItem).h).toBe(BOARD_LIMITS.pictureMin)
    expect(resizePicture(doc, 2, 500)).toBe(doc)
    expect(resizePicture(doc, 3, 500)).toBe(doc)
    expect(resizePicture(doc, 9, 500)).toBe(doc)
    expect(resizePicture(doc, 1, NaN)).toBe(doc)
    expect(resizePicture(doc, 1, 0)).toBe(doc)
    expect(resizePicture(doc, 1, 100)).toBe(doc)
  })
})

describe('resizeNote', () => {
  it('keeps the dragged-from edge and the top of the note where they are, however the text reflows', () => {
    const r = rng(25)
    for (let i = 0; i < 100; i++) {
      const n = randNote(r, 1)
      const newW = 40 + r() * 400
      const left = byId(resizeNote(docOf(n), 1, newW, -0.5, M), 1) as NoteItem
      expect(left.w).toBeCloseTo(newW, 9)
      closeV(itemQuad(left, M)[0]!, itemQuad(n, M)[0]!)
      const right = byId(resizeNote(docOf(n), 1, newW, 0.5, M), 1) as NoteItem
      closeV(itemQuad(right, M)[1]!, itemQuad(n, M)[1]!)
      const mid = byId(resizeNote(docOf(n), 1, newW, 0, M), 1) as NoteItem
      const top = (it: NoteItem): Vec2 => {
        const q = itemQuad(it, M)
        return { x: (q[0].x + q[1].x) / 2, y: (q[0].y + q[1].y) / 2 }
      }
      closeV(top(mid), top(n))
    }
  })
  it('holds the width inside its limits and ignores other things', () => {
    const doc = docOf(note(1, { w: 100 }), pic(2), note(3, { locked: true }))
    expect((byId(resizeNote(doc, 1, 1, 0, M), 1) as NoteItem).w).toBe(BOARD_ITEM_LIMITS.noteWidth.min)
    expect(resizeNote(doc, 1, 100, 0, M)).toBe(doc)
    expect(resizeNote(doc, 2, 300, 0, M)).toBe(doc)
    expect(resizeNote(doc, 3, 300, 0, M)).toBe(doc)
    expect(resizeNote(doc, 1, NaN, 0, M)).toBe(doc)
  })
})

/* ---------------------------------------------------------- rotate, flip -- */

describe('rotateItems', () => {
  it('turns a picture or note rigidly about the pivot: every corner of its quad turns with it', () => {
    const r = rng(26)
    for (let i = 0; i < 150; i++) {
      const it = i % 2 ? randPic(r, 1) : randNote(r, 1)
      const pivot = { x: (r() - 0.5) * 1000, y: (r() - 0.5) * 1000 }
      const deg = (r() - 0.5) * 700
      const out = byId(rotateItems(docOf(it), [1], deg, pivot), 1) as PictureItem | NoteItem
      const q0 = itemQuad(it, M)
      const q1 = itemQuad(out, M)
      for (let k = 0; k < 4; k++) closeV(q1[k]!, rotatePoint(q0[k]!, pivot, deg))
      expect(out.rotation).toBeGreaterThan(-180)
      expect(out.rotation).toBeLessThanOrEqual(180)
      expect(normalizeAngle(out.rotation - it.rotation - deg)).toBeCloseTo(0, 8)
    }
  })
  it('swings the points of strokes and lines about the pivot, and only the centre of rectangles and ellipses', () => {
    const doc = docOf(
      stroke(1, [10, 0, 20, 0]),
      line(2, 10, 0, 10, 10, { arrow: true }),
      rect(3, 0, 0, 20, 10),
      ellipse(4, 0, 0, 20, 10),
    )
    const out = rotateItems(doc, [1, 2, 3, 4], 90, { x: 0, y: 0 })
    expect((byId(out, 1) as StrokeItem).points).toEqual([0, 10, 0, 20])
    expect(byId(out, 2)).toMatchObject({ x1: 0, y1: 10, x2: -10, y2: 10, arrow: true })
    // the rectangle's centre (10, 5) goes to (-5, 10); it stays upright, 20 by 10
    expect(byId(out, 3)).toMatchObject({ x1: -15, y1: 5, x2: 5, y2: 15 })
    expect(byId(out, 4)).toMatchObject({ x1: -15, y1: 5, x2: 5, y2: 15 })
  })
  it('rotating by a and then -a is the identity (random boards, all kinds)', () => {
    const r = rng(27)
    for (let i = 0; i < 30; i++) {
      const doc = randDoc(r, 20)
      const ids = doc.items.map((it) => it.id)
      const deg = (r() - 0.5) * 900
      const pivot = { x: (r() - 0.5) * 1000, y: (r() - 0.5) * 1000 }
      expectClose(rotateItems(rotateItems(doc, ids, deg, pivot), ids, -deg, pivot), doc, 1e-9)
    }
  })
  it('four quarter turns give back the board', () => {
    const r = rng(28)
    const doc = randDoc(r, 20)
    const ids = doc.items.map((it) => it.id)
    let d = doc
    for (let i = 0; i < 4; i++) d = rotateItems(d, ids, 90, { x: 12, y: -30 })
    expectClose(d, doc, 1e-9)
  })
  it('does nothing for a whole number of turns, a bad angle, a bad pivot or no items', () => {
    const doc = docOf(pic(1, { rotation: 20 }))
    expect(rotateItems(doc, [1], 360, { x: 0, y: 0 })).toBe(doc)
    expect(rotateItems(doc, [1], -720, { x: 0, y: 0 })).toBe(doc)
    expect(rotateItems(doc, [1], NaN, { x: 0, y: 0 })).toBe(doc)
    expect(rotateItems(doc, [1], 10, { x: NaN, y: 0 })).toBe(doc)
    expect(rotateItems(doc, [3], 10, { x: 0, y: 0 })).toBe(doc)
  })
})

describe('flipItems', () => {
  it('mirrors every pixel of a picture about the axis (rotation, crop and earlier flips included)', () => {
    const r = rng(29)
    for (let i = 0; i < 200; i++) {
      const p = randPic(r, 1)
      const axis = i % 2 ? 'h' : 'v'
      const about = (r() - 0.5) * 800
      const f = byId(flipItems(docOf(p), [1], axis, about, M), 1) as PictureItem
      for (let k = 0; k < 6; k++) {
        const u = p.crop.l + r() * (p.crop.r - p.crop.l)
        const v = p.crop.t + r() * (p.crop.b - p.crop.t)
        const was = pixelAt(p, u, v)
        const now = pixelAt(f, u, v)
        closeV(now, axis === 'h' ? { x: 2 * about - was.x, y: was.y } : { x: was.x, y: 2 * about - was.y })
      }
      expect(f.flipH).toBe(axis === 'h' ? !p.flipH : p.flipH)
      expect(f.flipV).toBe(axis === 'v' ? !p.flipV : p.flipV)
    }
  })
  it('on a picture alone, with no axis given, flips in place', () => {
    const p = pic(1, { x: 70, y: -20, w: 120, h: 60, rotation: 25, crop: { l: 0.1, t: 0, r: 0.7, b: 1 } })
    for (const axis of ['h', 'v'] as const) {
      const f = byId(flipItems(docOf(p), [1], axis, undefined, M), 1) as PictureItem
      closeV({ x: f.x, y: f.y }, { x: p.x, y: p.y })
    }
    expect((byId(flipItems(docOf(p), [1], 'h', undefined, M), 1) as PictureItem).rotation).toBeCloseTo(-25, 9)
    expect((byId(flipItems(docOf(p), [1], 'v', undefined, M), 1) as PictureItem).rotation).toBeCloseTo(-25, 9)
  })
  it('mirrors a note as a box but not its text: the quad is mirrored and the text stays the right way up', () => {
    const r = rng(30)
    for (let i = 0; i < 100; i++) {
      const n = randNote(r, 1)
      const axis = i % 2 ? 'h' : 'v'
      const about = (r() - 0.5) * 800
      const f = byId(flipItems(docOf(n), [1], axis, about, M), 1) as NoteItem
      expect(f.text).toBe(n.text)
      expect(f.w).toBe(n.w)
      expect(f.size).toBe(n.size)
      const mirror = (p: Vec2): Vec2 => (axis === 'h' ? { x: 2 * about - p.x, y: p.y } : { x: p.x, y: 2 * about - p.y })
      const want = itemQuad(n, M).map(mirror)
      const got = itemQuad(f, M)
      // the same four corners, though not in the same order (the note is not mirrored, only its box)
      for (const w of want) expect(got.some((g) => Math.hypot(g.x - w.x, g.y - w.y) < 1e-7), `${w.x},${w.y}`).toBe(true)
      expect(f.rotation).toBeCloseTo(normalizeAngle(-n.rotation), 9)
    }
  })
  it('mirrors the points of marks', () => {
    const doc = docOf(stroke(1, [0, 0, 10, 5]), line(2, 0, 0, 10, 5, { arrow: true }), rect(3, 0, 0, 10, 5), ellipse(4, 0, 0, 10, 5))
    const h = flipItems(doc, [1, 2, 3, 4], 'h', 20, M)
    expect((byId(h, 1) as StrokeItem).points).toEqual([40, 0, 30, 5])
    expect(byId(h, 2)).toMatchObject({ x1: 40, y1: 0, x2: 30, y2: 5, arrow: true })
    expect(byId(h, 3)).toMatchObject({ x1: 40, x2: 30, y1: 0, y2: 5 })
    const v = flipItems(doc, [1, 2, 3, 4], 'v', 2, M)
    expect((byId(v, 1) as StrokeItem).points).toEqual([0, 4, 10, -1])
    expect(byId(v, 4)).toMatchObject({ x1: 0, x2: 10, y1: 4, y2: -1 })
  })
  it('uses the centre of the selection\'s bounds when no axis is given', () => {
    const doc = docOf(pic(1, { x: 0, y: 0, w: 100, h: 100 }), pic(2, { x: 300, y: 50, w: 100, h: 100 }))
    // bounds span x -50..350, centre 150
    const f = flipItems(doc, [1, 2], 'h', undefined, M)
    expect((byId(f, 1) as PictureItem).x).toBe(300)
    expect((byId(f, 2) as PictureItem).x).toBe(0)
    const v = flipItems(doc, [1, 2], 'v', undefined, M)
    // y bounds -50..100, centre 25
    expect((byId(v, 1) as PictureItem).y).toBe(50)
    expect((byId(v, 2) as PictureItem).y).toBe(0)
  })
  it('takes the centre from the free items only: a locked one does not move the axis', () => {
    const doc = docOf(pic(1, { x: 0, y: 0, w: 100, h: 100 }), pic(2, { x: 1000, y: 0, locked: true }))
    const f = flipItems(doc, [1, 2], 'h', undefined, M)
    expect((byId(f, 1) as PictureItem).x).toBe(0)
    expect(byId(f, 2)).toBe(byId(doc, 2))
  })
  it('flipping twice is the identity, about a given axis or about the selection', () => {
    const r = rng(31)
    for (let i = 0; i < 30; i++) {
      const doc = randDoc(r, 20)
      const ids = doc.items.map((it) => it.id)
      const axis = i % 2 ? 'h' : 'v'
      const about = i % 3 ? (r() - 0.5) * 800 : undefined
      expectClose(flipItems(flipItems(doc, ids, axis, about, M), ids, axis, about, M), doc, 1e-9)
    }
  })
  it('does nothing for no items, and ignores an axis that is not a number', () => {
    const doc = docOf(pic(1, { x: 10 }))
    expect(flipItems(doc, [], 'h', 0, M)).toBe(doc)
    expect(flipItems(doc, [5], 'h', 0, M)).toBe(doc)
    const centred = flipItems(doc, [1], 'h', NaN, M)
    expect((byId(centred, 1) as PictureItem).x).toBe(10)
    expect((byId(centred, 1) as PictureItem).flipH).toBe(true)
  })
})

/* ------------------------------------------------------------------ crop -- */

describe('setCrop', () => {
  it('keeps the pixels that stay visible where they were (turned, flipped and already cropped pictures too)', () => {
    const r = rng(32)
    let checked = 0
    for (let i = 0; i < 300; i++) {
      const p = randPic(r, 1)
      const next: Crop = { l: r() * 0.45, t: r() * 0.45, r: 0.55 + r() * 0.45, b: 0.55 + r() * 0.45 }
      const out = byId(setCrop(docOf(p), 1, next), 1) as PictureItem
      expect(out.crop).toEqual(next)
      // the part both crops show
      const l = Math.max(p.crop.l, next.l)
      const rr = Math.min(p.crop.r, next.r)
      const t = Math.max(p.crop.t, next.t)
      const b = Math.min(p.crop.b, next.b)
      if (rr <= l || b <= t) continue
      for (let k = 0; k < 6; k++) {
        const u = l + r() * (rr - l)
        const v = t + r() * (b - t)
        closeV(pixelAt(out, u, v), pixelAt(p, u, v))
        checked++
      }
      // the item's size is now the cropped part of the picture
      expect(itemSize(out, M).w).toBeCloseTo((next.r - next.l) * p.w, 8)
      expect(itemSize(out, M).h).toBeCloseTo((next.b - next.t) * p.h, 8)
    }
    expect(checked).toBeGreaterThan(500)
  })
  it('moves the centre by the shift of the shown part: cropping the left quarter of a plain picture moves its centre right', () => {
    const p = pic(1, { x: 0, y: 0, w: 100, h: 40 })
    const out = byId(setCrop(docOf(p), 1, { l: 0.25, t: 0, r: 1, b: 1 }), 1) as PictureItem
    expect([out.x, out.y]).toEqual([12.5, 0])
    const flipped = byId(setCrop(docOf({ ...p, flipH: true }), 1, { l: 0.25, t: 0, r: 1, b: 1 }), 1) as PictureItem
    expect([flipped.x, flipped.y]).toEqual([-12.5, 0])
    const turned = byId(setCrop(docOf({ ...p, rotation: 90 }), 1, { l: 0.25, t: 0, r: 1, b: 1 }), 1) as PictureItem
    expect(turned.x).toBeCloseTo(0, 9)
    expect(turned.y).toBeCloseTo(12.5, 9)
  })
  it('refuses a crop under 2% of an edge, one that is not a number, or one turned inside out', () => {
    const doc = docOf(pic(1))
    expect(setCrop(doc, 1, { l: 0, t: 0, r: 0.019, b: 1 })).toBe(doc)
    expect(setCrop(doc, 1, { l: 0, t: 0.5, r: 1, b: 0.51 })).toBe(doc)
    expect(setCrop(doc, 1, { l: 0.6, t: 0, r: 0.4, b: 1 })).toBe(doc)
    expect(setCrop(doc, 1, { l: NaN, t: 0, r: 1, b: 1 })).toBe(doc)
    expect(setCrop(doc, 1, { l: 0, t: 0, r: 0.02, b: 1 })).not.toBe(doc)
    expect(setCrop(doc, 1, { l: 0.1, t: 0.1, r: 0.12, b: 0.9 })).not.toBe(doc) // exactly 2%, in floating point 0.01999...
  })
  it('brings fractions outside 0..1 in before judging them', () => {
    const out = byId(setCrop(docOf(pic(1)), 1, { l: -0.5, t: -1, r: 3, b: 0.5 }), 1) as PictureItem
    expect(out.crop).toEqual({ l: 0, t: 0, r: 1, b: 0.5 })
  })
  it('is a no-op for the same crop, other kinds, locked pictures and unknown ids', () => {
    const doc = docOf(pic(1, { crop: { l: 0.1, t: 0, r: 1, b: 1 } }), pic(2, { locked: true }), note(3))
    expect(setCrop(doc, 1, { l: 0.1, t: 0, r: 1, b: 1 })).toBe(doc)
    expect(setCrop(doc, 2, { l: 0.2, t: 0, r: 1, b: 1 })).toBe(doc)
    expect(setCrop(doc, 3, { l: 0.2, t: 0, r: 1, b: 1 })).toBe(doc)
    expect(setCrop(doc, 8, { l: 0.2, t: 0, r: 1, b: 1 })).toBe(doc)
  })
  it('cropping twice equals cropping once to the end result', () => {
    const r = rng(33)
    for (let i = 0; i < 50; i++) {
      const p = randPic(r, 1)
      const a: Crop = { l: r() * 0.4, t: r() * 0.4, r: 0.6 + r() * 0.4, b: 0.6 + r() * 0.4 }
      const b: Crop = { l: r() * 0.4, t: r() * 0.4, r: 0.6 + r() * 0.4, b: 0.6 + r() * 0.4 }
      const twice = setCrop(setCrop(docOf(p), 1, a), 1, b)
      expectClose(twice, setCrop(docOf(p), 1, b), 1e-9)
    }
  })
})

describe('resetCrop', () => {
  it('shows the whole picture again without moving what was shown', () => {
    const r = rng(34)
    for (let i = 0; i < 100; i++) {
      const p = randPic(r, 1)
      const out = byId(resetCrop(docOf(p), [1]), 1) as PictureItem
      expect(out.crop).toEqual({ l: 0, t: 0, r: 1, b: 1 })
      const u = p.crop.l + r() * (p.crop.r - p.crop.l)
      const v = p.crop.t + r() * (p.crop.b - p.crop.t)
      closeV(pixelAt(out, u, v), pixelAt(p, u, v))
    }
  })
  it('does nothing for an uncropped picture, other kinds or locked pictures', () => {
    const doc = docOf(pic(1), note(2), pic(3, { locked: true, crop: { l: 0.2, t: 0, r: 1, b: 1 } }))
    expect(resetCrop(doc, [1, 2, 3])).toBe(doc)
  })
  it('resets each picture of several, and leaves the others as they were', () => {
    const doc = docOf(pic(1, { crop: { l: 0.2, t: 0, r: 1, b: 1 } }), pic(2, { crop: { l: 0.2, t: 0, r: 1, b: 1 } }))
    const out = resetCrop(doc, [1])
    expect((byId(out, 1) as PictureItem).crop.l).toBe(0)
    expect(byId(out, 2)).toBe(byId(doc, 2))
  })
})

/* ---------------------------------------------------------------- props --- */

describe('setProps', () => {
  it('sets the properties each kind has', () => {
    const doc = docOf(pic(1), note(2), stroke(3, [0, 0, 1, 1]), line(4, 0, 0, 5, 5), rect(5, 0, 0, 5, 5), ellipse(6, 0, 0, 5, 5))
    const p = setProps(doc, [1], { gray: true, opacity: 0.5, caption: 'gate', flipH: true, flipV: true, rotation: 190 }, M)
    expect(byId(p, 1)).toMatchObject({ gray: true, opacity: 0.5, caption: 'gate', flipH: true, flipV: true, rotation: -170 })
    const n = setProps(doc, [2], { text: 'new', size: 30, color: '#00FF00', fill: '112233', w: 300, rotation: 10 }, M)
    expect(byId(n, 2)).toMatchObject({ text: 'new', size: 30, color: '00ff00', fill: '112233', w: 300, rotation: 10 })
    expect(setProps(n, [2], { fill: '' }, M).items[1]).toMatchObject({ fill: '' })
    const m = setProps(doc, [3, 4, 5, 6], { color: 'abcdef', width: 9, arrow: true, fill: '010203' }, M)
    expect(byId(m, 3)).toMatchObject({ color: 'abcdef', width: 9 })
    expect(byId(m, 4)).toMatchObject({ color: 'abcdef', width: 9, arrow: true })
    expect(byId(m, 5)).toMatchObject({ color: 'abcdef', width: 9, fill: '010203' })
    expect(byId(m, 6)).toMatchObject({ color: 'abcdef', width: 9, fill: '010203' })
    expect(byId(m, 3)).not.toHaveProperty('arrow')
    expect(byId(m, 3)).not.toHaveProperty('fill')
  })
  it('sets a picture\'s size and a note\'s width through w and h', () => {
    const doc = docOf(pic(1, { w: 100, h: 50 }), note(2))
    const s = setProps(doc, [1, 2], { w: 300, h: 150 }, M)
    expect(byId(s, 1)).toMatchObject({ w: 300, h: 150 })
    expect(byId(s, 2)).toMatchObject({ w: 300 })
  })
  it('keeps values in range and ignores values that are not usable', () => {
    const doc = docOf(pic(1), note(2), line(3, 0, 0, 5, 5))
    const hi = setProps(doc, [1, 2, 3], { opacity: 9, size: 1e9, width: 1e9, w: 1e9 }, M)
    expect((byId(hi, 1) as PictureItem).opacity).toBe(1)
    expect((byId(hi, 2) as NoteItem).size).toBe(BOARD_ITEM_LIMITS.noteSize.max)
    expect((byId(hi, 3) as LineItem).width).toBe(BOARD_ITEM_LIMITS.markWidth.max)
    const lo = setProps(doc, [1, 2, 3], { opacity: 0, size: 0.01, width: 0 }, M)
    expect((byId(lo, 1) as PictureItem).opacity).toBe(BOARD_ITEM_LIMITS.opacity.min)
    expect((byId(lo, 2) as NoteItem).size).toBe(BOARD_ITEM_LIMITS.noteSize.min)
    expect((byId(lo, 3) as LineItem).width).toBe(BOARD_ITEM_LIMITS.markWidth.min)
    const bad = setProps(doc, [1, 2, 3], { opacity: NaN, size: NaN, width: NaN, w: NaN, rotation: NaN, color: 'blue', fill: 'xyz' }, M)
    expect(bad).toBe(doc)
    const cut = setProps(doc, [2], { text: 'y'.repeat(BOARD_LIMITS.noteChars + 10) }, M)
    expect((byId(cut, 2) as NoteItem).text.length).toBe(BOARD_LIMITS.noteChars)
    const cap = setProps(doc, [1], { caption: 'z'.repeat(BOARD_LIMITS.noteChars + 10) }, M)
    expect((byId(cap, 1) as PictureItem).caption.length).toBe(BOARD_LIMITS.noteChars)
  })
  it('does nothing when the value is the one already there, or the property is not the item\'s', () => {
    const doc = docOf(pic(1, { gray: true }), note(2), line(3, 0, 0, 5, 5))
    expect(setProps(doc, [1], { gray: true }, M)).toBe(doc)
    expect(setProps(doc, [1], { text: 'x', arrow: true, width: 5, size: 7 }, M)).toBe(doc)
    expect(setProps(doc, [2], { gray: true, opacity: 0.2, arrow: true, width: 7 }, M)).toBe(doc)
    expect(setProps(doc, [3], { text: 'x', opacity: 0.1, gray: true }, M)).toBe(doc)
    expect(setProps(doc, [1, 2, 3], {}, M)).toBe(doc)
  })
  it('keeps a note\'s top-left corner where it is when its text, size or width change', () => {
    const r = rng(35)
    for (let i = 0; i < 150; i++) {
      const n = randNote(r, 1)
      const patch = i % 3 === 0 ? { text: n.text + ' and some more words to make it wrap' } : i % 3 === 1 ? { size: 8 + r() * 60 } : { w: 80 + r() * 300 }
      const out = byId(setProps(docOf(n), [1], patch, M), 1) as NoteItem
      closeV(itemQuad(out, M)[0]!, itemQuad(n, M)[0]!)
      expect(noteBox(out, M).h).toBeGreaterThan(0)
    }
    // colour and rotation do not move it
    const n = note(1, { x: 5, y: 6 })
    const c = byId(setProps(docOf(n), [1], { color: '000000', rotation: 40 }, M), 1) as NoteItem
    expect([c.x, c.y]).toEqual([5, 6])
  })
  it('works without text metrics given (the estimate is the default)', () => {
    const doc = docOf(note(1, { text: 'one two three four five six seven eight nine ten' }))
    const out = byId(setProps(doc, [1], { size: 40 }), 1) as NoteItem
    expect(allFinite(out)).toBe(true)
    expect(out.size).toBe(40)
    expect(Number.isFinite(itemCentre(out).x)).toBe(true)
  })
})

/* ------------------------------------------------- invariants of all ops --- */

interface Case {
  name: string
  run(d: BoardDoc, ids: number[]): BoardDoc
  /** The same op with arguments that are not numbers. */
  bad?(d: BoardDoc, ids: number[]): BoardDoc
}
const PIVOT = { x: 30, y: -40 }
const CASES: Case[] = [
  { name: 'moveItems', run: (d, ids) => moveItems(d, ids, 13.5, -7.25), bad: (d, ids) => moveItems(d, ids, NaN, Infinity) },
  {
    name: 'scaleItems',
    run: (d, ids) => scaleItems(d, ids, 1.5, PIVOT),
    bad: (d, ids) => scaleItems(scaleItems(d, ids, NaN, PIVOT), ids, 2, { x: NaN, y: Infinity }),
  },
  { name: 'rotateItems', run: (d, ids) => rotateItems(d, ids, 33, PIVOT), bad: (d, ids) => rotateItems(rotateItems(d, ids, NaN, PIVOT), ids, 10, { x: NaN, y: 0 }) },
  { name: 'flipItems h', run: (d, ids) => flipItems(d, ids, 'h', undefined, M), bad: (d, ids) => flipItems(d, ids, 'h', NaN, M) },
  { name: 'flipItems v about', run: (d, ids) => flipItems(d, ids, 'v', 12.5, M), bad: (d, ids) => flipItems(d, ids, 'v', Infinity, M) },
  {
    name: 'setProps',
    run: (d, ids) =>
      setProps(d, ids, { gray: true, opacity: 0.5, caption: 'cap', text: 'new text', size: 30, color: '00ff00', fill: '112233', width: 9, arrow: true, rotation: 20 }, M),
    bad: (d, ids) => setProps(d, ids, { opacity: NaN, size: NaN, w: NaN, h: NaN, width: NaN, rotation: NaN }, M),
  },
  { name: 'resetCrop', run: (d, ids) => resetCrop(d, ids) },
  { name: 'reorder front', run: (d, ids) => reorder(d, ids, 'front', M) },
  { name: 'reorder back', run: (d, ids) => reorder(d, ids, 'back', M) },
  { name: 'reorder forward', run: (d, ids) => reorder(d, ids, 'forward', M) },
  { name: 'reorder backward', run: (d, ids) => reorder(d, ids, 'backward', M) },
  { name: 'removeItems', run: (d, ids) => removeItems(d, ids) },
  { name: 'duplicateItems', run: (d, ids) => duplicateItems(d, ids, { x: 10, y: 10 }).doc, bad: (d, ids) => duplicateItems(d, ids, { x: NaN, y: Infinity }).doc },
  { name: 'group', run: (d, ids) => group(d, ids) },
  { name: 'ungroup', run: (d, ids) => ungroup(d, ids) },
  { name: 'setCrop', run: (d, ids) => ids.reduce((acc, id) => setCrop(acc, id, { l: 0.2, t: 0.1, r: 0.9, b: 0.8 }), d), bad: (d, ids) => ids.reduce((acc, id) => setCrop(acc, id, { l: NaN, t: 0, r: 1, b: 1 }), d) },
  { name: 'resizePicture', run: (d, ids) => ids.reduce((acc, id) => resizePicture(acc, id, 321, { x: -0.5, y: 0.5 }), d), bad: (d, ids) => ids.reduce((acc, id) => resizePicture(acc, id, NaN, { x: NaN, y: 0 }), d) },
  { name: 'resizeNote', run: (d, ids) => ids.reduce((acc, id) => resizeNote(acc, id, 150, 0.5, M), d), bad: (d, ids) => ids.reduce((acc, id) => resizeNote(acc, id, NaN, NaN, M), d) },
]

describe('every operation', () => {
  it('never changes the document it is given (deep-frozen input, random boards)', () => {
    const r = rng(40)
    for (const c of CASES) {
      for (let round = 0; round < 4; round++) {
        const doc = deepFreeze(randDoc(r, 25, 0.2))
        const all = doc.items.map((i) => i.id)
        expect(() => c.run(doc, all), c.name).not.toThrow()
        expect(() => c.run(doc, all.filter((i) => i % 3 === 0)), c.name).not.toThrow()
        if (c.bad) expect(() => c.bad!(doc, all), `${c.name} bad`).not.toThrow()
      }
    }
  })
  it('never changes a locked item: it comes back as the very same object', () => {
    const r = rng(41)
    for (const c of CASES) {
      for (let round = 0; round < 6; round++) {
        const doc = randDoc(r, 25, 0.4)
        const out = c.run(doc, doc.items.map((i) => i.id))
        for (const it of doc.items) if (it.locked) expect(out.items, c.name).toContain(it)
      }
    }
  })
  it('on a board of locked items alone does nothing at all', () => {
    const r = rng(42)
    for (const c of CASES) {
      const doc = randDoc(r, 12, 1)
      expect(c.run(doc, doc.items.map((i) => i.id)), c.name).toBe(doc)
    }
  })
  it('ignores ids that are not on the board and returns the same doc', () => {
    const r = rng(43)
    for (const c of CASES) {
      const doc = randDoc(r, 12)
      expect(c.run(doc, [9999, -1, 0.5, 100]), c.name).toBe(doc)
      expect(c.run(doc, []), c.name).toBe(doc)
    }
  })
  it('keeps the identity of every item it did not touch', () => {
    const r = rng(44)
    for (const c of CASES) {
      if (c.name.startsWith('reorder') || c.name === 'duplicateItems') continue
      const doc = randDoc(r, 25)
      const out = c.run(doc, [3, 4])
      for (const it of doc.items) if (it.id !== 3 && it.id !== 4) expect(out.items, c.name).toContain(it)
    }
  })
  it('lets nothing that is not a number into the document', () => {
    const r = rng(45)
    for (const c of CASES) {
      if (!c.bad) continue
      for (let round = 0; round < 4; round++) {
        const doc = randDoc(r, 20)
        const out = c.bad(doc, doc.items.map((i) => i.id))
        expect(allFinite(out.items), c.name).toBe(true)
        expect(allFinite(out.nextId), c.name).toBe(true)
      }
    }
  })
  it('acts on the free items of a mixed selection and leaves the locked ones', () => {
    const doc = docOf(pic(1, { x: 0 }), pic(2, { x: 100, locked: true }), pic(3, { x: 200 }))
    const out = moveItems(doc, [1, 2, 3], 5, 0)
    expect((byId(out, 1) as PictureItem).x).toBe(5)
    expect(byId(out, 2)).toBe(byId(doc, 2))
    expect((byId(out, 3) as PictureItem).x).toBe(205)
    const unlocked = moveItems(lockItems(doc, [2], false), [1, 2, 3], 5, 0)
    expect((byId(unlocked, 2) as PictureItem).x).toBe(105)
  })
})
