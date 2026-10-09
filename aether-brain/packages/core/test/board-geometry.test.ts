import { describe, expect, it } from 'vitest'
import {
  boardToScreen,
  canRotateItems,
  clampView,
  fitView,
  handlesFor,
  hitHandle,
  hitTest,
  itemBounds,
  itemCentre,
  itemQuad,
  itemSize,
  itemsBounds,
  itemsInRect,
  noteBox,
  normalizeAngle,
  panView,
  pointInItem,
  rotatePoint,
  screenToBoard,
  selectionBounds,
  snapMove,
  zoomAt,
  type HandleBox,
} from '../src/board/geometry'
import {
  BOARD_LIMITS,
  emptyBoard,
  type BoardDoc,
  type BoardItem,
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

/** mulberry32: a small seeded generator, so a failing property reproduces. */
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

/** Fixed-width text: half the size a glyph, greedy wrap at spaces, 1.25 lines. No dependency on the real estimate. */
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

function close(a: number, b: number, eps = 1e-9): void {
  expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(eps)
}
function closeV(a: Vec2, b: Vec2, eps = 1e-9): void {
  close(a.x, b.x, eps)
  close(a.y, b.y, eps)
}

function randPic(r: () => number, id: number): PictureItem {
  return pic(id, {
    x: (r() - 0.5) * 2000,
    y: (r() - 0.5) * 2000,
    w: 20 + r() * 400,
    h: 20 + r() * 400,
    rotation: (r() - 0.5) * 360,
    crop: { l: r() * 0.4, t: r() * 0.4, r: 0.6 + r() * 0.4, b: 0.6 + r() * 0.4 },
    flipH: r() < 0.5,
    flipV: r() < 0.5,
  })
}
function randNote(r: () => number, id: number): NoteItem {
  const words = ['alpha', 'be', 'gamma ray', 'x', 'delta force', 'omega']
  return note(id, {
    text: Array.from({ length: 1 + Math.floor(r() * 12) }, () => words[Math.floor(r() * words.length)]!).join(' '),
    x: (r() - 0.5) * 2000,
    y: (r() - 0.5) * 2000,
    w: 60 + r() * 300,
    size: 8 + r() * 40,
    rotation: (r() - 0.5) * 360,
  })
}
function randMark(r: () => number, id: number): BoardItem {
  const c = (): number => (r() - 0.5) * 2000
  const k = Math.floor(r() * 4)
  const width = 1 + r() * 20
  if (k === 0) return stroke(id, Array.from({ length: 2 * (2 + Math.floor(r() * 8)) }, c), { width })
  if (k === 1) return line(id, c(), c(), c(), c(), { width })
  if (k === 2) return rect(id, c(), c(), c(), c(), { width, fill: r() < 0.5 ? '' : '00ff00' })
  return ellipse(id, c(), c(), c(), c(), { width, fill: r() < 0.5 ? '' : '00ff00' })
}
function randItem(r: () => number, id: number): BoardItem {
  const k = r()
  return k < 0.35 ? randPic(r, id) : k < 0.55 ? randNote(r, id) : randMark(r, id)
}

/** Independent test of a point in a convex quad (TL, TR, BR, BL), plus its distance to the outline. */
function quadInfo(q: Vec2[], p: Vec2): { inside: boolean; edge: number } {
  let inside = true
  let edge = Infinity
  for (let i = 0; i < 4; i++) {
    const a = q[i]!
    const b = q[(i + 1) % 4]!
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (cross < 0) inside = false
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2))
    edge = Math.min(edge, Math.hypot(a.x + t * (b.x - a.x) - p.x, a.y + t * (b.y - a.y) - p.y))
  }
  return { inside, edge }
}

/* -------------------------------------------------------------- angles ---- */

describe('normalizeAngle', () => {
  it('maps to (-180, 180]', () => {
    expect(normalizeAngle(0)).toBe(0)
    expect(normalizeAngle(180)).toBe(180)
    expect(normalizeAngle(-180)).toBe(180)
    expect(normalizeAngle(181)).toBe(-179)
    expect(normalizeAngle(-181)).toBe(179)
    expect(normalizeAngle(360)).toBe(0)
    expect(normalizeAngle(540)).toBe(180)
    expect(normalizeAngle(-540)).toBe(180)
    expect(normalizeAngle(725)).toBe(5)
    expect(normalizeAngle(-725)).toBe(-5)
  })
  it('never returns -0 and turns a number gone bad into 0', () => {
    expect(Object.is(normalizeAngle(-0), 0)).toBe(true)
    expect(Object.is(normalizeAngle(-360), 0)).toBe(true)
    expect(normalizeAngle(NaN)).toBe(0)
    expect(normalizeAngle(Infinity)).toBe(0)
  })
  it('keeps an angle already in range exactly, and is idempotent and congruent for any angle', () => {
    const r = rng(1)
    for (let i = 0; i < 500; i++) {
      const a = (r() - 0.5) * 20000
      const n = normalizeAngle(a)
      expect(n).toBeGreaterThan(-180)
      expect(n).toBeLessThanOrEqual(180)
      expect(normalizeAngle(n)).toBe(n)
      const turns = (a - n) / 360
      close(turns, Math.round(turns), 1e-9)
    }
    expect(normalizeAngle(33.3333)).toBe(33.3333)
  })
})

describe('rotatePoint', () => {
  it('turns clockwise on screen (y grows down)', () => {
    expect(rotatePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, 90)).toEqual({ x: 0, y: 1 })
    expect(rotatePoint({ x: 0, y: 1 }, { x: 0, y: 0 }, 90)).toEqual({ x: -1, y: 0 })
    expect(rotatePoint({ x: 11, y: 5 }, { x: 10, y: 5 }, 180)).toEqual({ x: 9, y: 5 })
    closeV(rotatePoint({ x: 2, y: 0 }, { x: 0, y: 0 }, 30), { x: 2 * Math.cos(Math.PI / 6), y: 1 })
  })
  it('four quarter turns give back exactly the same numbers', () => {
    let p: Vec2 = { x: 123.456, y: -78.9 }
    const c = { x: 17.25, y: 3.5 }
    for (let i = 0; i < 4; i++) p = rotatePoint(p, c, 90)
    expect(p.x).toBeCloseTo(123.456, 12)
    expect(p.y).toBeCloseTo(-78.9, 12)
    expect(rotatePoint(rotatePoint({ x: 5, y: 9 }, { x: 1, y: 2 }, 180), { x: 1, y: 2 }, 180)).toEqual({ x: 5, y: 9 })
  })
  it('turning by a then -a returns the point, and keeps the distance to the centre', () => {
    const r = rng(2)
    for (let i = 0; i < 300; i++) {
      const p = { x: (r() - 0.5) * 1e4, y: (r() - 0.5) * 1e4 }
      const c = { x: (r() - 0.5) * 1e4, y: (r() - 0.5) * 1e4 }
      const a = (r() - 0.5) * 1000
      const q = rotatePoint(p, c, a)
      close(Math.hypot(q.x - c.x, q.y - c.y), Math.hypot(p.x - c.x, p.y - c.y), 1e-8)
      closeV(rotatePoint(q, c, -a), p, 1e-8)
    }
  })
})

/* --------------------------------------------------------------- sizes ---- */

describe('itemSize, itemCentre, itemQuad, itemBounds', () => {
  it('a picture is shown at its cropped size', () => {
    const p = pic(1, { w: 200, h: 100, crop: { l: 0.125, t: 0.25, r: 0.625, b: 0.75 }, x: 30, y: 40 })
    expect(itemSize(p, M)).toEqual({ w: 100, h: 50 })
    expect(itemCentre(p)).toEqual({ x: 30, y: 40 })
  })
  it('a note is its width by the text height plus the margin twice', () => {
    const one = note(1, { text: 'hello', size: 20, w: 200 })
    // margin 0.5 em = 10; one line is 25 high
    expect(itemSize(one, M)).toEqual({ w: 200, h: 25 + 20 })
    // 180 board units of text space = 18 glyphs of 10: "aaaa bbbb cccc dddd" wraps after the third word
    const wrapped = note(2, { text: 'aaaa bbbb cccc dddd', size: 20, w: 200 })
    expect(noteBox(wrapped, M).layout.lines).toEqual(['aaaa bbbb cccc', 'dddd'])
    expect(itemSize(wrapped, M)).toEqual({ w: 200, h: 2 * 25 + 20 })
    expect(itemSize(note(3, { text: 'a\nb\nc', size: 10, w: 100 }), M)).toEqual({ w: 100, h: 3 * 12.5 + 10 })
  })
  it('a mark is its bounding box grown by half the line width', () => {
    expect(itemSize(line(1, 0, 0, 100, 40, { width: 10 }), M)).toEqual({ w: 110, h: 50 })
    expect(itemCentre(line(1, 0, 0, 100, 40, { width: 10 }))).toEqual({ x: 50, y: 20 })
    expect(itemSize(stroke(1, [10, 10, 30, -20, 5, 0], { width: 2 }), M)).toEqual({ w: 27, h: 32 })
    expect(itemSize(rect(1, 50, 60, 10, 20, { width: 6 }), M)).toEqual({ w: 46, h: 46 })
    expect(itemCentre(ellipse(1, 50, 60, 10, 20))).toEqual({ x: 30, y: 40 })
    expect(itemBounds(ellipse(1, 0, 0, 20, 10, { width: 4 }), M)).toEqual({ x: -2, y: -2, w: 24, h: 14 })
  })
  it('an empty stroke is a speck, not NaN', () => {
    expect(itemSize(stroke(1, [], { width: 4 }), M)).toEqual({ w: 4, h: 4 })
    expect(itemBounds(stroke(1, [], { width: 4 }), M).x).toBe(-2)
  })
  it('the quad of an unrotated picture is its box, corners top-left first, clockwise', () => {
    const q = itemQuad(pic(1, { x: 10, y: 20, w: 100, h: 50 }), M)
    expect(q).toEqual([{ x: -40, y: -5 }, { x: 60, y: -5 }, { x: 60, y: 45 }, { x: -40, y: 45 }])
  })
  it('turns the quad about the centre by the rotation (a quarter turn sends the top-left corner to the top-right)', () => {
    const q = itemQuad(pic(1, { x: 10, y: 20, w: 100, h: 50, rotation: 90 }), M)
    expect(q).toEqual([{ x: 35, y: -30 }, { x: 35, y: 70 }, { x: -15, y: 70 }, { x: -15, y: -30 }])
  })
  it('flips and a crop do not turn or move the quad; a crop shrinks it about the item centre', () => {
    const base = itemQuad(pic(1, { w: 100, h: 50 }), M)
    expect(itemQuad(pic(1, { w: 100, h: 50, flipH: true, flipV: true }), M)).toEqual(base)
    const cropped = itemQuad(pic(1, { w: 100, h: 50, crop: { l: 0, t: 0, r: 0.5, b: 1 } }), M)
    expect(cropped[1]).toEqual({ x: 25, y: -25 })
  })
  it('a quad has the item size, the item centre as its middle and the rotation as its direction (random items)', () => {
    const r = rng(3)
    for (let i = 0; i < 300; i++) {
      const it = i % 2 ? randPic(r, 1) : randNote(r, 1)
      const q = itemQuad(it, M)
      const s = itemSize(it, M)
      close(Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), s.w, 1e-8)
      close(Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y), s.h, 1e-8)
      closeV({ x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2 }, itemCentre(it), 1e-8)
      closeV({ x: (q[1].x + q[3].x) / 2, y: (q[1].y + q[3].y) / 2 }, itemCentre(it), 1e-8)
      const dir = (Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x) * 180) / Math.PI
      close(normalizeAngle(dir - (it as PictureItem).rotation), 0, 1e-7)
    }
  })
  it('itemBounds is the box round the quad, for rotated items too', () => {
    const r = rng(4)
    for (let i = 0; i < 300; i++) {
      const it = randItem(r, 1)
      const q = itemQuad(it, M)
      const b = itemBounds(it, M)
      close(b.x, Math.min(...q.map((p) => p.x)), 1e-8)
      close(b.y, Math.min(...q.map((p) => p.y)), 1e-8)
      close(b.x + b.w, Math.max(...q.map((p) => p.x)), 1e-8)
      close(b.y + b.h, Math.max(...q.map((p) => p.y)), 1e-8)
    }
    const sq = itemBounds(pic(1, { w: 100, h: 100, rotation: 45 }), M)
    close(sq.w, 100 * Math.SQRT2, 1e-9)
  })
  it('itemsBounds unions, is null for none and skips an item gone to NaN', () => {
    expect(itemsBounds([], M)).toBeNull()
    expect(itemsBounds([pic(1, { x: 0, y: 0 }), pic(2, { x: 200, y: 100 })], M)).toEqual({ x: -50, y: -25, w: 300, h: 150 })
    const bad = pic(3, { x: NaN })
    expect(itemsBounds([bad, pic(2, { x: 200, y: 100 })], M)).toEqual({ x: 150, y: 75, w: 100, h: 50 })
    expect(itemsBounds([bad], M)).toBeNull()
  })
  it('selectionBounds takes the ids that are on the board, locked ones too', () => {
    const doc = docOf(pic(1, { x: 0 }), pic(2, { x: 200, locked: true }), pic(3, { x: 1000 }))
    expect(selectionBounds(doc, [1, 2, 99], M)).toEqual({ x: -50, y: -25, w: 300, h: 50 })
    expect(selectionBounds(doc, [99], M)).toBeNull()
  })
})

/* ------------------------------------------------------------ hit tests --- */

describe('pointInItem', () => {
  it('agrees with the quad for random pictures, notes and points', () => {
    const r = rng(5)
    let checked = 0
    for (let i = 0; i < 400; i++) {
      const it = i % 2 ? randPic(r, 1) : randNote(r, 1)
      const q = itemQuad(it, M)
      const c = itemCentre(it)
      for (let k = 0; k < 20; k++) {
        const p = { x: c.x + (r() - 0.5) * 900, y: c.y + (r() - 0.5) * 900 }
        const info = quadInfo(q, p)
        if (info.edge < 1e-6) continue
        expect(pointInItem(it, p, 0, M), JSON.stringify({ it, p })).toBe(info.inside)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(5000)
  })
  it('grows a picture by the tolerance in its own turned frame', () => {
    const it = pic(1, { x: 100, y: 100, w: 100, h: 50, rotation: 30 })
    const out = (d: number): Vec2 => rotatePoint({ x: 100 + 50 + d, y: 100 }, { x: 100, y: 100 }, 30)
    expect(pointInItem(it, out(5.99), 6, M)).toBe(true)
    expect(pointInItem(it, out(6.01), 6, M)).toBe(false)
    expect(pointInItem(it, out(0.5), 0, M)).toBe(false)
    expect(pointInItem(it, out(-0.5), 0, M)).toBe(true)
    const up = rotatePoint({ x: 100, y: 100 - 25 - 5.99 }, { x: 100, y: 100 }, 30)
    expect(pointInItem(it, up, 6, M)).toBe(true)
  })
  it('a note hits by its box including the text height', () => {
    const n = note(1, { text: 'aaaa bbbb cccc dddd', size: 20, w: 200, x: 0, y: 0 }) // 200 by 70
    expect(pointInItem(n, { x: 99, y: 34 }, 0, M)).toBe(true)
    expect(pointInItem(n, { x: 99, y: 36 }, 0, M)).toBe(false)
    expect(pointInItem(n, { x: 101, y: 0 }, 0, M)).toBe(false)
  })
  it('a stroke is hit within half its width of the path, with round ends', () => {
    const s = stroke(1, [0, 0, 100, 0, 100, 100], { width: 10 })
    expect(pointInItem(s, { x: 50, y: 4.9 }, 0, M)).toBe(true)
    expect(pointInItem(s, { x: 50, y: 5.1 }, 0, M)).toBe(false)
    expect(pointInItem(s, { x: 50, y: 5.1 }, 1, M)).toBe(true)
    expect(pointInItem(s, { x: 104.9, y: 50 }, 0, M)).toBe(true)
    expect(pointInItem(s, { x: -4.9, y: 0 }, 0, M)).toBe(true)
    expect(pointInItem(s, { x: -5.1, y: 0 }, 0, M)).toBe(false)
    expect(pointInItem(s, { x: 50, y: 50 }, 0, M)).toBe(false)
    expect(pointInItem(stroke(2, [10, 10], { width: 6 }), { x: 12.9, y: 10 }, 0, M)).toBe(true)
    expect(pointInItem(stroke(2, [10, 10], { width: 6 }), { x: 13.1, y: 10 }, 0, M)).toBe(false)
    expect(pointInItem(stroke(3, [], { width: 6 }), { x: 0, y: 0 }, 100, M)).toBe(false)
  })
  it('a line is hit within half its width of the segment', () => {
    const l = line(1, 0, 0, 100, 100, { width: 10 })
    expect(pointInItem(l, { x: 50, y: 50 + 7 }, 0, M)).toBe(true) // 7 / sqrt2 = 4.95 from the line
    expect(pointInItem(l, { x: 50, y: 50 + 7.2 }, 0, M)).toBe(false)
    expect(pointInItem(l, { x: 120, y: 120 }, 0, M)).toBe(false)
    expect(pointInItem(l, { x: 120, y: 120 }, 30, M)).toBe(true)
  })
  it('an empty rectangle is hit near its outline only, a filled one anywhere inside', () => {
    const r1 = rect(1, 0, 0, 100, 60, { width: 4 })
    expect(pointInItem(r1, { x: 50, y: 30 }, 0, M)).toBe(false)
    expect(pointInItem(r1, { x: 50, y: 1.9 }, 0, M)).toBe(true)
    expect(pointInItem(r1, { x: 50, y: -1.9 }, 0, M)).toBe(true)
    expect(pointInItem(r1, { x: 50, y: 2.1 }, 0, M)).toBe(false)
    expect(pointInItem(r1, { x: 50, y: -2.1 }, 0, M)).toBe(false)
    expect(pointInItem(r1, { x: 101.9, y: 30 }, 0, M)).toBe(true)
    expect(pointInItem(r1, { x: 50, y: 5 }, 3, M)).toBe(true)
    const r2 = rect(2, 100, 60, 0, 0, { width: 4, fill: '112233' })
    expect(pointInItem(r2, { x: 50, y: 30 }, 0, M)).toBe(true)
    expect(pointInItem(r2, { x: 50, y: -1.9 }, 0, M)).toBe(true)
    expect(pointInItem(r2, { x: 50, y: -2.1 }, 0, M)).toBe(false)
    expect(pointInItem(r2, { x: 102.1, y: 30 }, 0, M)).toBe(false)
  })
  it('an ellipse is hit near its outline (exactly, not by a first-order estimate), or inside when filled', () => {
    const e = ellipse(1, -50, -30, 50, 30, { width: 2 })
    for (let k = 0; k < 360; k += 7) {
      const t = (k * Math.PI) / 180
      expect(pointInItem(e, { x: 50 * Math.cos(t), y: 30 * Math.sin(t) }, 0, M), `on outline ${k}`).toBe(true)
    }
    expect(pointInItem(e, { x: 0, y: 0 }, 0, M)).toBe(false)
    expect(pointInItem(e, { x: 0, y: 29.1 }, 0, M)).toBe(true)
    expect(pointInItem(e, { x: 0, y: 28.9 }, 0, M)).toBe(false)
    expect(pointInItem(e, { x: 0, y: 31.1 }, 0, M)).toBe(false)
    expect(pointInItem(e, { x: 50.9, y: 0 }, 0, M)).toBe(true)
    expect(pointInItem(e, { x: 51.1, y: 0 }, 0, M)).toBe(false)
    const f = ellipse(2, -50, -30, 50, 30, { width: 2, fill: 'ffffff' })
    expect(pointInItem(f, { x: 0, y: 0 }, 0, M)).toBe(true)
    expect(pointInItem(f, { x: 49, y: 0 }, 0, M)).toBe(true)
    expect(pointInItem(f, { x: 51.1, y: 0 }, 0, M)).toBe(false)
  })
  it('agrees with a brute-force distance to the outline, round, thin and flat ellipses alike', () => {
    const r = rng(6)
    const shapes: [number, number][] = [[50, 30], [100, 2], [3, 80], [40, 40], [60, 0], [0, 0]]
    for (const [a, b] of shapes) {
      const e = ellipse(1, -a, -b, a, b, { width: 3 })
      const outline: Vec2[] = []
      for (let i = 0; i < 20000; i++) outline.push({ x: a * Math.cos((i / 20000) * 2 * Math.PI), y: b * Math.sin((i / 20000) * 2 * Math.PI) })
      for (let k = 0; k < 150; k++) {
        const p = { x: (r() - 0.5) * 2.6 * (a + 4), y: (r() - 0.5) * 2.6 * (b + 4) }
        let d = Infinity
        for (const o of outline) d = Math.min(d, Math.hypot(o.x - p.x, o.y - p.y))
        if (Math.abs(d - 1.5) < 0.05) continue
        expect(pointInItem(e, p, 0, M), `a=${a} b=${b} p=${p.x},${p.y} d=${d}`).toBe(d <= 1.5)
      }
    }
  })
  it('is false for a point that is not a number', () => {
    expect(pointInItem(pic(1), { x: NaN, y: 0 }, 5, M)).toBe(false)
    expect(pointInItem(rect(1, 0, 0, 10, 10, { fill: 'ffffff' }), { x: 5, y: Infinity }, 5, M)).toBe(false)
  })
})

describe('hitTest', () => {
  it('returns the topmost item (the last in the array), locked ones too', () => {
    const doc = deepFreeze(docOf(pic(1, { w: 100, h: 100 }), pic(2, { w: 100, h: 100, locked: true }), pic(3, { x: 500 })))
    expect(hitTest(doc, { x: 10, y: 10 }, 0, M)?.id).toBe(2)
    expect(hitTest(doc, { x: 500, y: 0 }, 0, M)?.id).toBe(3)
    expect(hitTest(doc, { x: 10, y: 10 }, 0, M)).toBe(doc.items[1])
  })
  it('returns null on empty space and on an empty board; the tolerance reaches further', () => {
    const doc = docOf(pic(1, { w: 100, h: 100 }))
    expect(hitTest(doc, { x: 80, y: 0 }, 0, M)).toBeNull()
    expect(hitTest(doc, { x: 80, y: 0 }, 35, M)?.id).toBe(1)
    expect(hitTest(docOf(), { x: 0, y: 0 }, 5, M)).toBeNull()
  })
  it('skips an empty rectangle in its hollow, so what lies under it is hit', () => {
    const doc = docOf(pic(1, { w: 400, h: 400 }), rect(2, -100, -100, 100, 100, { width: 4 }))
    expect(hitTest(doc, { x: 0, y: 0 }, 0, M)?.id).toBe(1)
    expect(hitTest(doc, { x: 100, y: 0 }, 0, M)?.id).toBe(2)
  })
})

/* ----------------------------------------------------------- rectangles --- */

describe('itemsInRect', () => {
  const R = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

  it("'touch' takes whatever shares a point with the rectangle, 'contain' only what is wholly in it", () => {
    const doc = deepFreeze(docOf(pic(1, { x: 0, y: 0, w: 100, h: 100 }), pic(2, { x: 200, y: 0, w: 100, h: 100 }), pic(3, { x: 1000, y: 1000 })))
    expect(itemsInRect(doc, R(-10, -10, 100, 20), 'touch', M)).toEqual([1])
    expect(itemsInRect(doc, R(-10, -10, 100, 20), 'contain', M)).toEqual([])
    expect(itemsInRect(doc, R(-60, -60, 120 + 300, 120), 'contain', M)).toEqual([1, 2])
    expect(itemsInRect(doc, R(-60, -60, 120 + 300, 120), 'touch', M)).toEqual([1, 2])
    expect(itemsInRect(doc, R(-1000, -1000, 5000, 5000), 'touch', M)).toEqual([1, 2, 3])
  })
  it('a rectangle dragged backwards is the same as one dragged forwards', () => {
    const doc = docOf(pic(1, { x: 0, y: 0 }), pic(2, { x: 500, y: 0 }))
    expect(itemsInRect(doc, R(40, 40, -90, -90), 'touch', M)).toEqual([1])
    expect(itemsInRect(doc, R(40, 40, -90, -90), 'contain', M)).toEqual(itemsInRect(doc, R(-50, -50, 90, 90), 'contain', M))
    expect(itemsInRect(doc, R(-200, -200, 5000, 5000), 'contain', M)).toEqual([1, 2])
    expect(itemsInRect(doc, R(50, 50, -100, -100), 'contain', M)).toEqual([1])
  })
  it("'touch' uses the turned box, not the box round it", () => {
    // A square turned 45 degrees: its top-right corner region is empty although its bounds reach there.
    const doc = docOf(pic(1, { x: 0, y: 0, w: 100, h: 100, rotation: 45 }))
    const corner = R(55, -85, 20, 20) // inside the bounds (|x|,|y| < 70.7), outside the diamond
    expect(itemsInRect(doc, corner, 'touch', M)).toEqual([])
    expect(itemsInRect(doc, R(30, -50, 20, 20), 'touch', M)).toEqual([1])
    // a rectangle wholly inside the picture still touches it
    expect(itemsInRect(doc, R(-5, -5, 10, 10), 'touch', M)).toEqual([1])
  })
  it("'touch' sees a stroke or line that crosses the rectangle between its points", () => {
    const doc = docOf(stroke(1, [-100, 0, 100, 0], { width: 2 }), line(2, 0, -100, 0, 100, { width: 2 }), line(3, -100, 60, 100, 60, { width: 2 }))
    expect(itemsInRect(doc, R(-10, -10, 20, 20), 'touch', M)).toEqual([1, 2])
    expect(itemsInRect(doc, R(-10, -10, 20, 20), 'contain', M)).toEqual([])
    // line 3 lies at y = 60 and is 2 thick, so its edge is at 59; the rectangle below spans y from 40 up to 40 + h
    expect(itemsInRect(doc, R(30, 40, 20, 18), 'touch', M)).toEqual([])
    expect(itemsInRect(doc, R(30, 40, 20, 18.9), 'touch', M)).toEqual([])
    expect(itemsInRect(doc, R(30, 40, 20, 19.2), 'touch', M)).toEqual([3])
    expect(itemsInRect(doc, R(30, 40, 20, 40), 'touch', M)).toEqual([3])
  })
  it("'contain' counts the line width: a stroke whose points are inside but whose thickness pokes out is not contained", () => {
    const doc = docOf(stroke(1, [0, 0, 100, 0], { width: 20 }))
    expect(itemsInRect(doc, R(-5, -5, 110, 10), 'contain', M)).toEqual([])
    expect(itemsInRect(doc, R(-10, -10, 120, 20), 'contain', M)).toEqual([1])
    expect(itemsInRect(doc, R(-11, -11, 122, 22), 'contain', M)).toEqual([1])
  })
  it('an empty rectangle or ellipse is touched by its outline, a marquee in its hollow touches nothing; a filled one is touched anywhere', () => {
    const doc = docOf(
      rect(1, -100, -100, 100, 100, { width: 4 }),
      ellipse(2, 300, -100, 500, 100, { width: 4 }),
      rect(3, 600, -100, 800, 100, { width: 4, fill: '00ff00' }),
      ellipse(4, 900, -100, 1100, 100, { width: 4, fill: '00ff00' }),
    )
    expect(itemsInRect(doc, R(-10, -10, 20, 20), 'touch', M)).toEqual([])
    expect(itemsInRect(doc, R(390, -10, 20, 20), 'touch', M)).toEqual([])
    expect(itemsInRect(doc, R(690, -10, 20, 20), 'touch', M)).toEqual([3])
    expect(itemsInRect(doc, R(990, -10, 20, 20), 'touch', M)).toEqual([4])
    expect(itemsInRect(doc, R(90, -10, 20, 20), 'touch', M)).toEqual([1]) // over the right edge
    expect(itemsInRect(doc, R(-10, 90, 20, 20), 'touch', M)).toEqual([1]) // over the bottom edge
    expect(itemsInRect(doc, R(490, -10, 20, 20), 'touch', M)).toEqual([2])
    expect(itemsInRect(doc, R(-1000, -1000, 3000, 3000), 'touch', M)).toEqual([1, 2, 3, 4])
    expect(itemsInRect(doc, R(-1000, -1000, 3000, 3000), 'contain', M)).toEqual([1, 2, 3, 4])
    // the corner of an ellipse's bounds is not on the ellipse
    expect(itemsInRect(doc, R(495, -105, 20, 20), 'touch', M)).toEqual([])
    expect(itemsInRect(doc, R(1090, -110, 20, 20), 'touch', M)).toEqual([])
  })
  it("'touch' counts a rectangle that only meets an item's edge, and rounds the corner of a shape's outline", () => {
    const doc = docOf(pic(1, { x: 0, y: 0, w: 100, h: 100 }))
    expect(itemsInRect(doc, R(50, 0, 10, 10), 'touch', M)).toEqual([1])
    expect(itemsInRect(doc, R(50.001, 0, 10, 10), 'touch', M)).toEqual([])
    expect(itemsInRect(doc, R(-60, -10, 10, 10), 'touch', M)).toEqual([1])
    // the outer edge of a 4 thick outline round the corner (100, 0) is a circle of radius 2, not a square
    const filled = docOf(rect(1, 0, 0, 100, 60, { width: 4, fill: '112233' }))
    expect(itemsInRect(filled, R(101, -11, 10, 10), 'touch', M)).toEqual([1])
    expect(itemsInRect(filled, R(101.5, -11.5, 10, 10), 'touch', M)).toEqual([])
  })
  it('never fails on a stroke with no point or an item gone to NaN, and takes a NaN rectangle as nothing', () => {
    const doc = docOf(stroke(1, []), pic(2, { x: NaN }), pic(3))
    expect(itemsInRect(doc, R(-1000, -1000, 2000, 2000), 'touch', M)).toEqual([3])
    expect(itemsInRect(doc, R(-1000, -1000, 2000, 2000), 'contain', M)).toEqual([3])
    expect(itemsInRect(doc, R(NaN, 0, 10, 10), 'touch', M)).toEqual([])
  })
  it("'contain' is a subset of 'touch', and a point of the rectangle that is on an item makes the item touched (random boards)", () => {
    const r = rng(7)
    for (let round = 0; round < 40; round++) {
      const items: BoardItem[] = []
      for (let i = 1; i <= 12; i++) items.push(randItem(r, i))
      const doc = deepFreeze(docOf(...items))
      for (let k = 0; k < 6; k++) {
        const cx = (r() - 0.5) * 2000
        const cy = (r() - 0.5) * 2000
        const rc = R(cx, cy, r() * 900, r() * 900)
        const touch = itemsInRect(doc, rc, 'touch', M)
        const contain = itemsInRect(doc, rc, 'contain', M)
        for (const id of contain) expect(touch).toContain(id)
        for (let s = 0; s < 40; s++) {
          const p = { x: rc.x + r() * rc.w, y: rc.y + r() * rc.h }
          const on = hitTest(doc, p, 0, M)
          // hitTest names only the topmost; check every item at that point
          for (const it of items) if (pointInItem(it, p, 0, M)) expect(touch, `item ${it.id} at ${p.x},${p.y}`).toContain(it.id)
          void on
        }
        for (const id of contain) {
          const it = items.find((i) => i.id === id)!
          const b = itemBounds(it, M)
          expect(b.x).toBeGreaterThanOrEqual(rc.x)
          expect(b.x + b.w).toBeLessThanOrEqual(rc.x + rc.w)
          expect(b.y).toBeGreaterThanOrEqual(rc.y)
          expect(b.y + b.h).toBeLessThanOrEqual(rc.y + rc.h)
        }
      }
    }
  })
})

/* ---------------------------------------------------------------- view ---- */

describe('view mapping', () => {
  const VP = { w: 800, h: 600 }

  it('the middle of the canvas is the view centre; zoom scales around it', () => {
    const v = { x: 100, y: -50, zoom: 2 }
    expect(screenToBoard(v, VP, { x: 400, y: 300 })).toEqual({ x: 100, y: -50 })
    expect(screenToBoard(v, VP, { x: 500, y: 300 })).toEqual({ x: 150, y: -50 })
    expect(boardToScreen(v, VP, { x: 100, y: -50 })).toEqual({ x: 400, y: 300 })
    expect(boardToScreen(v, VP, { x: 150, y: -25 })).toEqual({ x: 500, y: 350 })
  })
  it('screenToBoard(boardToScreen(p)) is p, and the other way', () => {
    const r = rng(8)
    for (let i = 0; i < 300; i++) {
      const v = { x: (r() - 0.5) * 1e5, y: (r() - 0.5) * 1e5, zoom: 0.005 + r() * 60 }
      const vp = { w: 100 + r() * 3000, h: 100 + r() * 3000 }
      const p = { x: (r() - 0.5) * 1e5, y: (r() - 0.5) * 1e5 }
      closeV(screenToBoard(v, vp, boardToScreen(v, vp, p)), p, 1e-6)
      closeV(boardToScreen(v, vp, screenToBoard(v, vp, p)), p, 1e-6)
    }
  })
  it('zoomAt keeps the board point under the anchor under it', () => {
    const r = rng(9)
    for (let i = 0; i < 300; i++) {
      const v = { x: (r() - 0.5) * 1e4, y: (r() - 0.5) * 1e4, zoom: 0.05 + r() * 10 }
      const anchor = { x: r() * VP.w, y: r() * VP.h }
      const before = screenToBoard(v, VP, anchor)
      const z = zoomAt(v, 0.3 + r() * 3, anchor, VP)
      closeV(screenToBoard(z, VP, anchor), before, 1e-7)
      closeV(boardToScreen(z, VP, before), anchor, 1e-7)
    }
  })
  it('zoomAt multiplies the zoom, clamps it to the limits, and leaves the view alone for a bad factor', () => {
    const v = { x: 5, y: 6, zoom: 1 }
    expect(zoomAt(v, 2, { x: 400, y: 300 }, VP).zoom).toBe(2)
    expect(zoomAt(v, 1e9, { x: 10, y: 10 }, VP).zoom).toBe(BOARD_LIMITS.zoomMax)
    expect(zoomAt(v, 1e-9, { x: 10, y: 10 }, VP).zoom).toBe(BOARD_LIMITS.zoomMin)
    const atMax = { x: 5, y: 6, zoom: BOARD_LIMITS.zoomMax }
    expect(zoomAt(atMax, 2, { x: 10, y: 10 }, VP)).toBe(atMax)
    expect(zoomAt(v, NaN, { x: 10, y: 10 }, VP)).toBe(v)
    expect(zoomAt(v, 0, { x: 10, y: 10 }, VP)).toBe(v)
    expect(zoomAt(v, -2, { x: 10, y: 10 }, VP)).toBe(v)
    // the anchor still holds when the zoom was clamped
    const edge = zoomAt({ x: 0, y: 0, zoom: 40 }, 10, { x: 700, y: 100 }, VP)
    expect(edge.zoom).toBe(BOARD_LIMITS.zoomMax)
    closeV(screenToBoard(edge, VP, { x: 700, y: 100 }), screenToBoard({ x: 0, y: 0, zoom: 40 }, VP, { x: 700, y: 100 }), 1e-7)
  })
  it('panView makes the content follow a drag', () => {
    const v = { x: 10, y: 20, zoom: 4 }
    const p = { x: 123, y: 456 }
    const under = screenToBoard(v, VP, p)
    const moved = panView(v, 40, -80)
    closeV(screenToBoard(moved, VP, { x: p.x + 40, y: p.y - 80 }), under)
    expect(moved).toEqual({ x: 0, y: 40, zoom: 4 })
    expect(panView(v, NaN, 0)).toEqual(v)
  })
  it('panView stops at the edge of the coordinate range', () => {
    expect(panView({ x: 0, y: 0, zoom: 1 }, -5e6, 0).x).toBe(BOARD_LIMITS.coordinate)
    expect(panView({ x: 0, y: 0, zoom: 1 }, 5e6, 0).x).toBe(-BOARD_LIMITS.coordinate)
  })
})

describe('fitView', () => {
  const VP = { w: 800, h: 600 }

  it('shows the bounds whole, centred, with the margin on the tight side', () => {
    const b = { x: 100, y: 200, w: 400, h: 100 }
    const v = fitView(b, VP, 20)
    expect(v.zoom).toBeCloseTo(760 / 400, 12) // width is the tight direction
    closeV({ x: v.x, y: v.y }, { x: 300, y: 250 })
    const tl = boardToScreen(v, VP, { x: b.x, y: b.y })
    const br = boardToScreen(v, VP, { x: b.x + b.w, y: b.y + b.h })
    close(tl.x, 20, 1e-9)
    close(br.x, 780, 1e-9)
    expect(tl.y).toBeGreaterThanOrEqual(20)
    expect(br.y).toBeLessThanOrEqual(580)
    const tall = fitView({ x: 0, y: 0, w: 100, h: 1000 }, VP, 0)
    expect(tall.zoom).toBeCloseTo(0.6, 12)
  })
  it('random bounds always fit inside the margin', () => {
    const r = rng(10)
    for (let i = 0; i < 200; i++) {
      const b = { x: (r() - 0.5) * 1e4, y: (r() - 0.5) * 1e4, w: 1 + r() * 1e4, h: 1 + r() * 1e4 }
      const margin = r() * 100
      const vp = { w: 300 + r() * 2000, h: 300 + r() * 2000 }
      const v = fitView(b, vp, margin)
      for (const p of [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]) {
        const s = boardToScreen(v, vp, p)
        expect(s.x).toBeGreaterThanOrEqual(margin - 1e-6)
        expect(s.x).toBeLessThanOrEqual(vp.w - margin + 1e-6)
        expect(s.y).toBeGreaterThanOrEqual(margin - 1e-6)
        expect(s.y).toBeLessThanOrEqual(vp.h - margin + 1e-6)
      }
    }
  })
  it('an empty or tiny bounds gives zoom 1, centred on it', () => {
    expect(fitView(null, VP, 10)).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(fitView({ x: 40, y: 50, w: 0, h: 0 }, VP, 10)).toEqual({ x: 40, y: 50, zoom: 1 })
    const tiny = fitView({ x: 40, y: 50, w: 1e-9, h: 1e-9 }, VP, 10)
    expect(tiny.zoom).toBe(1)
    closeV(tiny, { x: 40, y: 50 }, 1e-8)
    expect(fitView({ x: NaN, y: 0, w: 5, h: 5 }, VP, 10)).toEqual({ x: 0, y: 0, zoom: 1 })
  })
  it('a bounds with extent in one direction only is fitted in that direction', () => {
    const v = fitView({ x: 0, y: 0, w: 400, h: 0 }, VP, 0)
    expect(v.zoom).toBe(2)
    expect(v.y).toBe(0)
  })
  it('keeps the zoom inside the limits and survives a viewport too small for the margin', () => {
    expect(fitView({ x: 0, y: 0, w: 0.01, h: 0.01 }, VP, 0).zoom).toBe(BOARD_LIMITS.zoomMax)
    expect(fitView({ x: 0, y: 0, w: 1e6, h: 1e6 }, VP, 0).zoom).toBe(BOARD_LIMITS.zoomMin)
    const z = fitView({ x: 0, y: 0, w: 100, h: 100 }, { w: 50, h: 50 }, 100).zoom
    expect(z).toBeGreaterThanOrEqual(BOARD_LIMITS.zoomMin)
    expect(Number.isFinite(z)).toBe(true)
    expect(fitView({ x: 0, y: 0, w: 100, h: 100 }, { w: 0, h: 0 }, 0).zoom).toBe(1)
  })
})

describe('clampView', () => {
  it('keeps a good view as the same object', () => {
    const v = { x: 5, y: 6, zoom: 2 }
    expect(clampView(v)).toBe(v)
  })
  it('brings the zoom and the centre inside the limits and replaces numbers gone bad', () => {
    expect(clampView({ x: 0, y: 0, zoom: 1e9 }).zoom).toBe(BOARD_LIMITS.zoomMax)
    expect(clampView({ x: 0, y: 0, zoom: 0 }).zoom).toBe(BOARD_LIMITS.zoomMin)
    expect(clampView({ x: 5e9, y: -5e9, zoom: 1 })).toEqual({ x: BOARD_LIMITS.coordinate, y: -BOARD_LIMITS.coordinate, zoom: 1 })
    expect(clampView({ x: NaN, y: Infinity, zoom: NaN })).toEqual({ x: 0, y: 0, zoom: 1 })
  })
})

/* ------------------------------------------------------------- snapping --- */

describe('snapMove', () => {
  const opts = (o: Partial<{ threshold: number; zoom: number; grid: number; edges: boolean }> = {}) => ({
    threshold: 8, zoom: 1, grid: 0, edges: true, metrics: M, ...o,
  })
  // item 1 is the one moved (edges -50, 0, 50 both ways); item 2 is a target at x = 300, 350, 400 and y = 150, 200, 250
  const base = () => deepFreeze(docOf(pic(1, { x: 0, y: 0, w: 100, h: 100 }), pic(2, { x: 350, y: 200, w: 100, h: 100 })))

  it('lands a moved edge exactly on another item edge within the threshold, and names the guide', () => {
    // item 1's right edge is at 50; asking for +245 puts it at 295, five short of 300
    const r = snapMove(base(), [1], { x: 245, y: 0 }, opts())
    close(r.delta.x, 250)
    expect(r.guides.v).toEqual([300])
    // y: nothing of item 2 is near -50, 0 or 50
    expect(r.delta.y).toBe(0)
    expect(r.guides.h).toEqual([])
  })
  it('takes the threshold in pixels: it shrinks as the zoom grows', () => {
    const near = snapMove(base(), [1], { x: 245, y: 0 }, opts({ zoom: 2 })) // reach 4 board units, 5 away
    expect(near.delta.x).toBe(245)
    expect(near.guides.v).toEqual([])
    const reach = snapMove(base(), [1], { x: 246.5, y: 0 }, opts({ zoom: 2 }))
    close(reach.delta.x, 250)
    const wide = snapMove(base(), [1], { x: 245, y: 0 }, opts({ zoom: 0.5 })) // reach 16
    close(wide.delta.x, 250)
  })
  it('never moves further than the threshold', () => {
    const r = snapMove(base(), [1], { x: 241.9, y: 0 }, opts()) // 8.1 short
    expect(r.delta.x).toBe(241.9)
    const edge = snapMove(base(), [1], { x: 242, y: 0 }, opts())
    close(edge.delta.x, 250)
  })
  it('snaps a centre to a centre, and edge to far edge', () => {
    // a wide, flat target: its centre y (50) is 3 from the moved item's centre, its edges (30, 70) are further
    const flat = docOf(pic(1, { x: 0, y: 0, w: 100, h: 100 }), pic(2, { x: 500, y: 50, w: 100, h: 40 }))
    const c = snapMove(flat, [1], { x: 0, y: 47 }, opts())
    close(c.delta.y, 50)
    expect(c.guides.h).toEqual([50])
    // item 1's left edge at -50 meets target's right edge 400 after moving 450
    const e = snapMove(base(), [1], { x: 446, y: 0 }, opts())
    close(e.delta.x, 450)
    expect(e.guides.v).toContain(400)
  })
  it('reports every guide that lines up at once', () => {
    // two targets with the same top edge, selection top lands on it: one guide; centre and edge both hit => two
    const doc = docOf(pic(1, { x: 0, y: 0, w: 100, h: 100 }), pic(2, { x: 300, y: 50, w: 100, h: 100 }))
    const r = snapMove(doc, [1], { x: 300, y: 50 }, opts())
    expect(r.delta).toEqual({ x: 300, y: 50 })
    expect(r.guides.v).toEqual([250, 300, 350])
    expect(r.guides.h).toEqual([0, 50, 100])
  })
  it('chooses the nearest of several candidates', () => {
    const doc = docOf(pic(1, { x: 0, y: 0, w: 10, h: 10 }), pic(2, { x: 100, y: 500, w: 10, h: 10 }), pic(3, { x: 108, y: 900, w: 10, h: 10 }))
    // selection edges at -5, 0, 5 (+dx); targets 95,100,105 and 103,108,113. dx=98 -> 93,98,103; nearest pair is 103-103 (0) -> shift 0
    const r = snapMove(doc, [1], { x: 98, y: 0 }, opts())
    close(r.delta.x, 98)
    expect(r.guides.v).toEqual([103])
  })
  it('decides each axis alone', () => {
    const r = snapMove(base(), [1], { x: 246, y: 400 }, opts())
    close(r.delta.x, 250)
    expect(r.delta.y).toBe(400)
    expect(r.guides.h).toEqual([])
  })
  it('does not snap the selection to itself, nor to a member of the same drag', () => {
    const doc = docOf(pic(1, { x: 0, y: 0, w: 100, h: 100 }), pic(2, { x: 120, y: 0, w: 100, h: 100 }))
    const r = snapMove(doc, [1, 2], { x: 3, y: 3 }, opts())
    expect(r.delta).toEqual({ x: 3, y: 3 })
    expect(r.guides).toEqual({ v: [], h: [] })
  })
  it('uses the bounds of the whole moving selection', () => {
    const doc = docOf(pic(1, { x: 0, y: 0, w: 100, h: 100 }), pic(2, { x: 200, y: 0, w: 100, h: 100 }), pic(3, { x: 800, y: 0, w: 100, h: 100 }))
    // selection 1+2 spans -50..250; its right edge to item 3's left edge (750) needs +500
    const r = snapMove(doc, [1, 2], { x: 497, y: 0 }, opts())
    close(r.delta.x, 500)
    expect(r.guides.v).toContain(750)
  })
  it('ignores locked items among the moving ones; a selection of locked items only is left alone', () => {
    const doc = docOf(pic(1, { x: 0, y: 0, w: 100, h: 100 }), pic(2, { x: 1000, y: 0, w: 100, h: 100, locked: true }), pic(3, { x: 350, y: 50, w: 100, h: 100 }))
    // if the locked item counted, the selection would span to 1050 and its edges would not meet 300 at +245
    const r = snapMove(doc, [1, 2], { x: 245, y: 0 }, opts())
    close(r.delta.x, 250)
    const only = snapMove(docOf(pic(1, { locked: true }), pic(2, { x: 350 })), [1], { x: 245, y: 0 }, opts())
    expect(only).toEqual({ delta: { x: 245, y: 0 }, guides: { v: [], h: [] } })
  })
  it('locked items are still things to snap to', () => {
    const doc = docOf(pic(1, { x: 0, y: 0, w: 100, h: 100 }), pic(2, { x: 350, y: 50, w: 100, h: 100, locked: true }))
    close(snapMove(doc, [1], { x: 245, y: 0 }, opts()).delta.x, 250)
  })
  it('edges: false turns item snapping off but not the grid', () => {
    const r = snapMove(base(), [1], { x: 245, y: 0 }, opts({ edges: false }))
    expect(r.delta).toEqual({ x: 245, y: 0 })
    expect(r.guides).toEqual({ v: [], h: [] })
    const g = snapMove(base(), [1], { x: 245, y: 0 }, opts({ edges: false, grid: 50 }))
    expect(g.delta).toEqual({ x: 250, y: 0 }) // left edge -50+245 = 195, the nearest grid line is 200
    expect(g.guides).toEqual({ v: [], h: [] })
  })
  it('snaps the top-left corner to the grid where no item caught it', () => {
    // 90 by 90, so the top-left corner is on the grid while the centre and the far corner are not
    const doc = docOf(pic(1, { x: 0, y: 0, w: 90, h: 90 }))
    // left edge -45+13 = -32, the nearest multiple of 20 is -40
    const r = snapMove(doc, [1], { x: 13, y: 21 }, opts({ grid: 20 }))
    close(r.delta.x, 5)
    close(r.delta.y, 25) // top edge -45+21 = -24, the nearest grid line is -20
    expect(r.guides).toEqual({ v: [], h: [] })
  })
  it('an item catches an axis before the grid does, and the grid takes the other axis', () => {
    // grid 30: the grid alone would send the left edge (-50+244 = 194) to 180, an item sends the right edge (294) to 300
    const r = snapMove(base(), [1], { x: 244, y: 13 }, opts({ grid: 30 }))
    close(r.delta.x, 250) // item snap, not the grid
    close(r.delta.y, 20) // top edge -50+13 = -37 goes to the grid line -30
    expect(r.guides.v).toEqual([300])
    expect(r.guides.h).toEqual([])
  })
  it('replaces a delta that is not a number with 0', () => {
    const r = snapMove(base(), [1], { x: NaN, y: Infinity }, opts())
    expect(Number.isFinite(r.delta.x) && Number.isFinite(r.delta.y)).toBe(true)
  })
  it('an unknown id moves nothing and snaps nothing', () => {
    expect(snapMove(base(), [99], { x: 245, y: 0 }, opts())).toEqual({ delta: { x: 245, y: 0 }, guides: { v: [], h: [] } })
  })
  it('does not change the document it reads', () => {
    expect(() => snapMove(base(), [1], { x: 245, y: 3 }, opts({ grid: 10 }))).not.toThrow()
  })
  it('lands exactly on a guide when one is in range and never moves further than the threshold (random boards)', () => {
    const r = rng(11)
    let snapped = 0
    for (let round = 0; round < 150; round++) {
      const items: BoardItem[] = []
      for (let i = 1; i <= 10; i++) items.push(i % 3 === 0 ? randNote(r, i) : randPic(r, i))
      const doc = deepFreeze(docOf(...items))
      const moving = [1, 2]
      const zoom = 0.2 + r() * 4
      const o = opts({ zoom, threshold: 6 + r() * 10 })
      const want = { x: (r() - 0.5) * 400, y: (r() - 0.5) * 400 }
      const res = snapMove(doc, moving, want, o)
      const reach = o.threshold / zoom
      expect(Math.abs(res.delta.x - want.x)).toBeLessThanOrEqual(reach + 1e-9)
      expect(Math.abs(res.delta.y - want.y)).toBeLessThanOrEqual(reach + 1e-9)
      // brute force the nearest pair on each axis
      const sel = itemsBounds(items.filter((i) => moving.includes(i.id)), M)!
      const others = items.filter((i) => !moving.includes(i.id)).map((i) => itemBounds(i, M))
      for (const axis of ['x', 'y'] as const) {
        const [s0, size] = axis === 'x' ? [sel.x, sel.w] : [sel.y, sel.h]
        const lines = [s0 + want[axis], s0 + size / 2 + want[axis], s0 + size + want[axis]]
        const targets = others.flatMap((b) => (axis === 'x' ? [b.x, b.x + b.w / 2, b.x + b.w] : [b.y, b.y + b.h / 2, b.y + b.h]))
        let best = Infinity
        for (const a of lines) for (const t of targets) if (Math.abs(t - a) <= reach && Math.abs(t - a) < Math.abs(best)) best = t - a
        const guides = axis === 'x' ? res.guides.v : res.guides.h
        if (best !== Infinity) {
          snapped++
          close(res.delta[axis] - want[axis], best, 1e-9)
          expect(guides.length).toBeGreaterThan(0)
          const landed = lines.map((l) => l + best)
          for (const g of guides) {
            expect(Math.min(...landed.map((l) => Math.abs(l - g)))).toBeLessThan(1e-9)
            expect(targets.some((t) => Math.abs(t - g) < 1e-9)).toBe(true)
          }
        } else {
          expect(res.delta[axis]).toBe(want[axis])
          expect(guides).toEqual([])
        }
      }
    }
    expect(snapped).toBeGreaterThan(5)
  })
})

/* -------------------------------------------------------------- handles --- */

describe('handlesFor', () => {
  it('is null for nothing', () => {
    expect(handlesFor([], M, 30)).toBeNull()
  })
  it('a lone unrotated picture: its box, the rotate handle a fixed offset above the middle of the top edge', () => {
    const h = handlesFor([pic(1, { x: 10, y: 20, w: 100, h: 50 })], M, 30)!
    expect(h.corners).toEqual([{ x: -40, y: -5 }, { x: 60, y: -5 }, { x: 60, y: 45 }, { x: -40, y: 45 }])
    expect(h.rotateHandle).toEqual({ x: 10, y: -35 })
    expect(h.rotation).toBe(0)
  })
  it('a lone turned picture or note: a turned box, with the handle out along the box\'s own up', () => {
    const r = rng(12)
    for (let i = 0; i < 100; i++) {
      const it = i % 2 ? randPic(r, 1) : randNote(r, 1)
      const off = 5 + r() * 100
      const h = handlesFor([it], M, off)!
      expect(h.corners).toEqual(itemQuad(it, M))
      expect(h.rotation).toBe((it as PictureItem).rotation)
      const top = { x: (h.corners[0].x + h.corners[1].x) / 2, y: (h.corners[0].y + h.corners[1].y) / 2 }
      const c = itemCentre(it)
      const hd = h.rotateHandle!
      close(Math.hypot(hd.x - top.x, hd.y - top.y), off, 1e-8)
      // perpendicular to the top edge ...
      const ex = h.corners[1].x - h.corners[0].x
      const ey = h.corners[1].y - h.corners[0].y
      close((hd.x - top.x) * ex + (hd.y - top.y) * ey, 0, 1e-6 * Math.hypot(ex, ey) * off + 1e-7)
      // ... and away from the middle
      expect((hd.x - top.x) * (top.x - c.x) + (hd.y - top.y) * (top.y - c.y)).toBeGreaterThan(0)
    }
  })
  it('several items, or a mark: an upright box round them, rotation 0', () => {
    const h = handlesFor([pic(1, { x: 0, y: 0, rotation: 30 }), pic(2, { x: 300, y: 100 })], M, 20)!
    const b = itemsBounds([pic(1, { x: 0, y: 0, rotation: 30 }), pic(2, { x: 300, y: 100 })], M)!
    expect(h.rotation).toBe(0)
    expect(h.corners[0]).toEqual({ x: b.x, y: b.y })
    expect(h.corners[2]).toEqual({ x: b.x + b.w, y: b.y + b.h })
    closeV(h.rotateHandle!, { x: b.x + b.w / 2, y: b.y - 20 })
    const s = handlesFor([stroke(1, [0, 0, 100, 50], { width: 2 })], M, 10)!
    expect(s.rotation).toBe(0)
    expect(s.corners[0]).toEqual({ x: -1, y: -1 })
    expect(s.rotateHandle).toEqual({ x: 50, y: -11 })
  })
  it('no rotate handle when nothing can be turned: all locked, or only rectangles and ellipses', () => {
    expect(handlesFor([pic(1, { locked: true })], M, 20)!.rotateHandle).toBeNull()
    expect(handlesFor([rect(1, 0, 0, 10, 10)], M, 20)!.rotateHandle).toBeNull()
    expect(handlesFor([rect(1, 0, 0, 10, 10), ellipse(2, 5, 5, 20, 20)], M, 20)!.rotateHandle).toBeNull()
    expect(handlesFor([rect(1, 0, 0, 10, 10), pic(2)], M, 20)!.rotateHandle).not.toBeNull()
    expect(handlesFor([pic(1, { locked: true }), pic(2)], M, 20)!.rotateHandle).not.toBeNull()
    expect(canRotateItems([line(1, 0, 0, 5, 5)])).toBe(true)
    expect(canRotateItems([])).toBe(false)
  })
})

describe('hitHandle', () => {
  const box: HandleBox = {
    corners: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }],
    rotateHandle: { x: 50, y: -30 },
    rotation: 0,
  }
  it('names every handle at its place', () => {
    const at: [string, Vec2][] = [
      ['nw', { x: 0, y: 0 }], ['ne', { x: 100, y: 0 }], ['se', { x: 100, y: 60 }], ['sw', { x: 0, y: 60 }],
      ['n', { x: 50, y: 0 }], ['e', { x: 100, y: 30 }], ['s', { x: 50, y: 60 }], ['w', { x: 0, y: 30 }],
      ['rotate', { x: 50, y: -30 }],
    ]
    for (const [name, p] of at) expect(hitHandle(box, p, 5), name).toBe(name)
    for (const [name, p] of at) expect(hitHandle(box, { x: p.x + 3, y: p.y - 3 }, 5), name).toBe(name)
  })
  it('is null away from the handles and exactly at the tolerance', () => {
    expect(hitHandle(box, { x: 50, y: 30 }, 5)).toBeNull()
    expect(hitHandle(box, { x: 30, y: 0 }, 5)).toBeNull()
    expect(hitHandle(box, { x: 6, y: 0 }, 5)).toBeNull()
    expect(hitHandle(box, { x: 5, y: 0 }, 5)).toBe('nw')
    expect(hitHandle({ ...box, rotateHandle: null }, { x: 50, y: -30 }, 5)).toBeNull()
  })
  it('the nearest wins when handles crowd, and a tie goes to rotate, corner, edge', () => {
    const tiny: HandleBox = { corners: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], rotateHandle: null, rotation: 0 }
    expect(hitHandle(tiny, { x: 0.5, y: 0.5 }, 10)).toBe('nw')
    expect(hitHandle(tiny, { x: 3.4, y: 3.6 }, 10)).toBe('se')
    expect(hitHandle(tiny, { x: 2, y: 0.4 }, 10)).toBe('n')
    // exactly midway between nw (0,0) and n (2,0)
    expect(hitHandle(tiny, { x: 1, y: 0 }, 10)).toBe('nw')
    // the rotate handle on top of a corner wins that tie
    expect(hitHandle({ ...tiny, rotateHandle: { x: 0, y: 0 } }, { x: 0, y: 0 }, 10)).toBe('rotate')
  })
  it('works on a turned box: the edge handles are the middles of the turned edges', () => {
    const it = pic(1, { x: 200, y: 100, w: 120, h: 40, rotation: 90 })
    const h = handlesFor([it], M, 25)!
    // turned a quarter: the top edge is on the right, its middle at (220, 100)
    expect(hitHandle(h, { x: 220, y: 100 }, 3)).toBe('n')
    expect(hitHandle(h, { x: 200, y: 160 }, 3)).toBe('e') // right edge of the box is now at the bottom
    expect(hitHandle(h, { x: 245, y: 100 }, 3)).toBe('rotate')
    expect(hitHandle(h, { x: 180, y: 100 }, 3)).toBe('s')
    expect(hitHandle(h, { x: 200, y: 40 }, 3)).toBe('w')
    expect(hitHandle(h, { x: 220, y: 160 }, 3)).toBe('ne') // box top-right = bottom-right on screen
  })
})
