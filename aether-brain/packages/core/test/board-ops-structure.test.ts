import { describe, expect, it } from 'vitest'
import { itemBounds } from '../src/board/geometry'
import {
  BOARD_ITEM_LIMITS,
  clampDoc,
  duplicateItems,
  expandGroups,
  group,
  insertItems,
  lockItems,
  removeItems,
  reorder,
  ungroup,
} from '../src/board/ops'
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
const idsOf = (d: BoardDoc): number[] => d.items.map((i) => i.id)
const groupsOf = (d: BoardDoc): number[] => d.items.map((i) => i.group)

/** A strip of 100-wide pictures at the given x centres (so which overlap which is plain to see). */
function strip(...xs: number[]): BoardDoc {
  return docOf(...xs.map((x, i) => pic(i + 1, { x, y: 0, w: 100, h: 100 })))
}

function randItem(r: () => number, id: number): BoardItem {
  const c = (): number => (r() - 0.5) * 2000
  const k = r()
  if (k < 0.4) return pic(id, { x: c(), y: c(), w: 20 + r() * 300, h: 20 + r() * 300, rotation: (r() - 0.5) * 358 })
  if (k < 0.55) return note(id, { x: c(), y: c(), w: 80 + r() * 200, size: 10 + r() * 20, rotation: (r() - 0.5) * 358 })
  if (k < 0.7) return stroke(id, [c(), c(), c(), c(), c(), c()])
  if (k < 0.8) return line(id, c(), c(), c(), c())
  return k < 0.9 ? rect(id, c(), c(), c(), c(), { fill: r() < 0.5 ? '' : '112233' }) : ellipse(id, c(), c(), c(), c())
}

/* -------------------------------------------------------------- groups ---- */

describe('expandGroups', () => {
  const doc = docOf(pic(1, { group: 1 }), pic(2), pic(3, { group: 1 }), pic(4, { group: 2 }), pic(5, { group: 2, locked: true }), pic(6))

  it('adds every member of every group touched, once each, in board order', () => {
    expect(expandGroups(doc, [3])).toEqual([1, 3])
    expect(expandGroups(doc, [4, 3])).toEqual([1, 3, 4, 5])
    expect(expandGroups(doc, [6, 1, 3, 1])).toEqual([1, 3, 6])
    expect(expandGroups(doc, [2, 6])).toEqual([2, 6])
  })
  it('drops ids that are not on the board and returns [] for none', () => {
    expect(expandGroups(doc, [99, 2, -1])).toEqual([2])
    expect(expandGroups(doc, [])).toEqual([])
    expect(expandGroups(doc, [99])).toEqual([])
  })
  it('includes a locked member (a click selects it) and does not change the doc', () => {
    expect(expandGroups(deepFreeze(docOf(pic(1, { group: 1 }), pic(2, { group: 1, locked: true }))), [1])).toEqual([1, 2])
  })
})

describe('group', () => {
  it('joins the items into one new group, with a label no other group has', () => {
    const doc = docOf(pic(1), pic(2), pic(3, { group: 4 }), pic(4, { group: 4 }), pic(5))
    const g = group(doc, [1, 2])
    expect(groupsOf(g)).toEqual([5, 5, 4, 4, 0])
    expect(byId(g, 3)).toBe(byId(doc, 3))
    expect(byId(g, 5)).toBe(byId(doc, 5))
    expect(byId(g, 1)).not.toBe(byId(doc, 1))
  })
  it('takes every member of every group an item touches, merging groups', () => {
    const doc = docOf(pic(1, { group: 1 }), pic(2, { group: 1 }), pic(3, { group: 2 }), pic(4, { group: 2 }), pic(5), pic(6, { group: 3 }), pic(7, { group: 3 }))
    const g = group(doc, [1, 3, 5])
    expect(groupsOf(g)).toEqual([4, 4, 4, 4, 4, 3, 3])
    expect(byId(g, 6)).toBe(byId(doc, 6))
    // one item of a group plus one outside: the whole group joins
    expect(groupsOf(group(doc, [2, 5]))).toEqual([4, 4, 2, 2, 4, 3, 3])
  })
  it('needs two items: one item, or none, changes nothing', () => {
    const doc = docOf(pic(1), pic(2))
    expect(group(doc, [1])).toBe(doc)
    expect(group(doc, [])).toBe(doc)
    expect(group(doc, [1, 1, 1])).toBe(doc)
    expect(group(doc, [1, 99])).toBe(doc)
  })
  it('is a no-op when the items are already exactly one group', () => {
    const doc = docOf(pic(1, { group: 1 }), pic(2, { group: 1 }), pic(3))
    expect(group(doc, [1, 2])).toBe(doc)
    expect(group(doc, [1])).toBe(doc)
  })
  it('a lone item of a group is not enough, but a group plus another item is', () => {
    const doc = docOf(pic(1, { group: 1 }), pic(2, { group: 1 }), pic(3))
    expect(groupsOf(group(doc, [1, 3]))).toEqual([2, 2, 2])
  })
  it('leaves a locked item where it is, in its old group, and does not count it', () => {
    const doc = docOf(pic(1, { group: 1 }), pic(2, { group: 1, locked: true }), pic(3), pic(4))
    const g = group(doc, [1, 3])
    expect(groupsOf(g)).toEqual([2, 1, 2, 0])
    expect(byId(g, 2)).toBe(byId(doc, 2))
    expect(group(docOf(pic(1, { locked: true }), pic(2)), [1, 2])).toEqual(docOf(pic(1, { locked: true }), pic(2)))
    const lone = docOf(pic(1, { locked: true }), pic(2))
    expect(group(lone, [1, 2])).toBe(lone)
    // a locked item named by the caller does not pull the free members of its group in
    const pulled = docOf(pic(1, { group: 1, locked: true }), pic(2, { group: 1 }), pic(3))
    expect(group(pulled, [1, 3])).toBe(pulled)
  })
})

describe('ungroup', () => {
  it('dissolves every group the ids touch, all its members, and no other group', () => {
    const doc = docOf(pic(1, { group: 1 }), pic(2, { group: 1 }), pic(3, { group: 2 }), pic(4, { group: 2 }), pic(5))
    const u = ungroup(doc, [2])
    expect(groupsOf(u)).toEqual([0, 0, 2, 2, 0])
    expect(byId(u, 3)).toBe(byId(doc, 3))
    expect(groupsOf(ungroup(doc, [1, 3]))).toEqual([0, 0, 0, 0, 0])
  })
  it('does nothing for items in no group, unknown ids or none', () => {
    const doc = docOf(pic(1, { group: 1 }), pic(2, { group: 1 }), pic(3))
    expect(ungroup(doc, [3])).toBe(doc)
    expect(ungroup(doc, [99])).toBe(doc)
    expect(ungroup(doc, [])).toBe(doc)
  })
  it('keeps locked members in the group', () => {
    const doc = docOf(pic(1, { group: 1 }), pic(2, { group: 1, locked: true }))
    const u = ungroup(doc, [1])
    expect(groupsOf(u)).toEqual([0, 1])
    expect(byId(u, 2)).toBe(byId(doc, 2))
    const only = docOf(pic(1, { group: 1, locked: true }), pic(2, { group: 1 }))
    expect(ungroup(only, [1])).toBe(only)
  })
  it('grouping then ungrouping the same items leaves no groups', () => {
    const doc = docOf(pic(1), pic(2), pic(3))
    expect(groupsOf(ungroup(group(doc, [1, 2, 3]), [2]))).toEqual([0, 0, 0])
  })
})

/* ------------------------------------------------------------- stacking --- */

describe('reorder', () => {
  const rect4 = () => strip(0, 500, 50, 700) // 1 overlaps 3; 2 and 4 stand alone

  it('front and back move the items to the end or the start, keeping their order among themselves', () => {
    const doc = docOf(...[1, 2, 3, 4, 5, 6].map((i) => pic(i, { x: i * 1000 })))
    expect(idsOf(reorder(doc, [2, 5], 'front', M))).toEqual([1, 3, 4, 6, 2, 5])
    expect(idsOf(reorder(doc, [5, 2], 'front', M))).toEqual([1, 3, 4, 6, 2, 5])
    expect(idsOf(reorder(doc, [2, 5], 'back', M))).toEqual([2, 5, 1, 3, 4, 6])
    expect(idsOf(reorder(doc, [6, 1], 'back', M))).toEqual([1, 6, 2, 3, 4, 5])
  })
  it('does nothing when the items are already where they are sent', () => {
    const doc = docOf(...[1, 2, 3].map((i) => pic(i, { x: i * 1000 })))
    expect(reorder(doc, [3], 'front', M)).toBe(doc)
    expect(reorder(doc, [2, 3], 'front', M)).toBe(doc)
    expect(reorder(doc, [1], 'back', M)).toBe(doc)
    expect(reorder(doc, [1, 2], 'back', M)).toBe(doc)
    expect(reorder(doc, [3], 'forward', M)).toBe(doc)
    expect(reorder(doc, [1], 'backward', M)).toBe(doc)
    expect(reorder(doc, [1, 2, 3], 'front', M)).toBe(doc)
  })
  it('forward goes just past the next item above that overlaps it, skipping those that do not', () => {
    // 1 (0) overlaps 3 (50) but not 2 (500): it jumps over 2 and 3 together
    expect(idsOf(reorder(rect4(), [1], 'forward', M))).toEqual([2, 3, 1, 4])
    // 3 (50) overlaps nothing above (4 is at 700): one step
    expect(idsOf(reorder(rect4(), [3], 'forward', M))).toEqual([1, 2, 4, 3])
    // 2 overlaps nothing above: one step
    expect(idsOf(reorder(rect4(), [2], 'forward', M))).toEqual([1, 3, 2, 4])
  })
  it('backward goes just below the next item beneath that overlaps it', () => {
    // 3 (50) overlaps 1 (0), skipping 2
    expect(idsOf(reorder(rect4(), [3], 'backward', M))).toEqual([3, 1, 2, 4])
    // 4 overlaps nothing beneath: one step
    expect(idsOf(reorder(rect4(), [4], 'backward', M))).toEqual([1, 2, 4, 3])
    expect(idsOf(reorder(rect4(), [2], 'backward', M))).toEqual([2, 1, 3, 4])
  })
  it('moves a selection as a block: its items keep their order and never pass one another', () => {
    const doc = docOf(...[0, 500, 50, 700].map((x, i) => pic(i + 1, { x, y: 0, w: 100, h: 100 })))
    // 1 and 2 forward: 2 steps over 3 (no overlap above it but 3 is the next), then 1 lands just past 3
    expect(idsOf(reorder(doc, [1, 2], 'forward', M))).toEqual([3, 1, 2, 4])
    // the top item cannot go forward, the one below it is wedged against it
    expect(idsOf(reorder(doc, [3, 4], 'forward', M))).toEqual([1, 2, 3, 4])
    expect(reorder(doc, [3, 4], 'forward', M)).toBe(doc)
    expect(idsOf(reorder(doc, [3, 4], 'backward', M))).toEqual([3, 1, 4, 2])
    expect(idsOf(reorder(doc, [1, 2, 3, 4], 'forward', M))).toEqual([1, 2, 3, 4])
  })
  it('compares the bounds of turned items, not their boxes', () => {
    // a 100x100 square turned 45 degrees at 0 reaches 70.7 to the right; one at 125 reaches left to 75: no overlap of bounds
    const doc = docOf(pic(1, { x: 0, y: 0, w: 100, h: 100, rotation: 45 }), pic(2, { x: 200, y: 0, w: 100, h: 100 }), pic(3, { x: 130, y: 0, w: 100, h: 100 }))
    // 1's bounds are -70.7..70.7; 3's are 80..180 (apart); 2's are 150..250 (apart): one step over 2
    expect(idsOf(reorder(doc, [1], 'forward', M))).toEqual([2, 1, 3])
    const near = docOf(pic(1, { x: 0, y: 0, w: 100, h: 100, rotation: 45 }), pic(2, { x: 200, y: 0, w: 100, h: 100 }), pic(3, { x: 115, y: 0, w: 100, h: 100 }))
    // 3 is now 65..165 and overlaps 1's bounds
    expect(idsOf(reorder(near, [1], 'forward', M))).toEqual([2, 3, 1])
  })
  it('skips locked items and reports nothing changed when only locked ones are named', () => {
    const doc = docOf(pic(1, { locked: true }), pic(2), pic(3, { x: 1000 }))
    expect(idsOf(reorder(doc, [1, 2], 'front', M))).toEqual([1, 3, 2])
    expect(reorder(doc, [1], 'front', M)).toBe(doc)
    expect(reorder(doc, [99], 'front', M)).toBe(doc)
    // a locked item in the way is passed like any other
    const way = docOf(pic(1, { x: 0 }), pic(2, { x: 10, locked: true }), pic(3, { x: 2000 }))
    expect(idsOf(reorder(way, [1], 'forward', M))).toEqual([2, 1, 3])
  })
  it('keeps every item and the relative order of the moved ones and of the rest (random boards, all moves)', () => {
    const r = rng(50)
    for (let round = 0; round < 60; round++) {
      const items: BoardItem[] = []
      for (let i = 1; i <= 15; i++) items.push(randItem(r, i))
      // a clustered board so that overlaps happen
      const doc = deepFreeze(docOf(...items.map((it) => (it.kind === 'picture' ? { ...it, x: it.x / 8, y: it.y / 8 } : it))))
      const moved = doc.items.filter((_, i) => r() < 0.3).map((i) => i.id)
      for (const where of ['front', 'forward', 'backward', 'back'] as const) {
        const out = reorder(doc, moved, where, M)
        expect([...idsOf(out)].sort((a, b) => a - b)).toEqual(idsOf(doc))
        const inOrder = (d: BoardDoc, keep: (id: number) => boolean): number[] => idsOf(d).filter(keep)
        expect(inOrder(out, (id) => moved.includes(id)), where).toEqual(inOrder(doc, (id) => moved.includes(id)))
        expect(inOrder(out, (id) => !moved.includes(id)), where).toEqual(inOrder(doc, (id) => !moved.includes(id)))
        for (const it of doc.items) expect(out.items).toContain(it)
      }
    }
  })
  it('forward never moves an item more than past one overlapping neighbour, and moving forward then backward comes back for a lone item', () => {
    const r = rng(51)
    for (let round = 0; round < 40; round++) {
      const doc = docOf(...Array.from({ length: 10 }, (_, i) => pic(i + 1, { x: r() * 150, y: r() * 150, w: 100, h: 100 })))
      const id = 1 + Math.floor(r() * 10)
      const i0 = idsOf(doc).indexOf(id)
      const fwd = reorder(doc, [id], 'forward', M)
      const i1 = idsOf(fwd).indexOf(id)
      expect(i1).toBeGreaterThanOrEqual(i0)
      if (i1 > i0) {
        // everything it passed except the last is clear of it; the last overlaps it
        const passed = idsOf(doc).slice(i0 + 1, i1 + 1)
        const me = itemBounds(byId(doc, id), M)
        const over = (o: BoardItem): boolean => {
          const b = itemBounds(o, M)
          return me.x < b.x + b.w && b.x < me.x + me.w && me.y < b.y + b.h && b.y < me.y + me.h
        }
        expect(over(byId(doc, passed[passed.length - 1]!))).toBe(passed.length === 1 || over(byId(doc, passed[passed.length - 1]!)))
        for (const p of passed.slice(0, -1)) expect(over(byId(doc, p))).toBe(false)
      }
    }
  })
})

/* --------------------------------------------------------- remove, lock --- */

describe('removeItems', () => {
  it('removes the free items of the ids and keeps the rest in order', () => {
    const doc = docOf(pic(1), pic(2, { locked: true }), pic(3), pic(4))
    const out = removeItems(doc, [1, 2, 4, 99])
    expect(idsOf(out)).toEqual([2, 3])
    expect(out.items[0]).toBe(doc.items[1])
    expect(out.items[1]).toBe(doc.items[2])
    expect(out.nextId).toBe(doc.nextId)
  })
  it('is the same doc when nothing goes', () => {
    const doc = docOf(pic(1, { locked: true }), pic(2))
    expect(removeItems(doc, [1])).toBe(doc)
    expect(removeItems(doc, [])).toBe(doc)
    expect(removeItems(doc, [7])).toBe(doc)
  })
  it('does not change the doc it is given', () => {
    const doc = deepFreeze(docOf(pic(1), pic(2)))
    expect(idsOf(removeItems(doc, [1]))).toEqual([2])
    expect(doc.items.length).toBe(2)
  })
})

describe('lockItems', () => {
  it('locks and unlocks, locked items included in the ids', () => {
    const doc = docOf(pic(1), pic(2, { locked: true }), pic(3))
    const l = lockItems(doc, [1, 2, 99], true)
    expect(l.items.map((i) => i.locked)).toEqual([true, true, false])
    expect(l.items[1]).toBe(doc.items[1])
    expect(l.items[2]).toBe(doc.items[2])
    const u = lockItems(l, [2, 1], false)
    expect(u.items.map((i) => i.locked)).toEqual([false, false, false])
  })
  it('is the same doc when nothing changes', () => {
    const doc = docOf(pic(1), pic(2, { locked: true }))
    expect(lockItems(doc, [1], false)).toBe(doc)
    expect(lockItems(doc, [2], true)).toBe(doc)
    expect(lockItems(doc, [], true)).toBe(doc)
    expect(lockItems(doc, [9], true)).toBe(doc)
  })
  it('unlocking lets the other operations act on an item again', () => {
    const doc = lockItems(docOf(pic(1)), [1], true)
    expect(removeItems(doc, [1])).toBe(doc)
    expect(idsOf(removeItems(lockItems(doc, [1], false), [1]))).toEqual([])
  })
})

/* ------------------------------------------------------------ duplicate --- */

describe('duplicateItems', () => {
  it('adds copies on top, shifted by the offset, with fresh ids, in the order of the originals', () => {
    const doc = deepFreeze(
      docOf(
        pic(1, { x: 5, y: 6, rotation: 30, caption: 'a' }),
        note(2, { x: 50, text: 'hi' }),
        stroke(3, [0, 0, 10, 10, 20, 0]),
        line(4, 0, 0, 5, 5, { arrow: true }),
        rect(5, 0, 0, 10, 10, { fill: '112233' }),
        ellipse(6, 0, 0, 10, 10),
      ),
    )
    const r = duplicateItems(doc, [6, 1, 3, 2, 4, 5], { x: 20, y: -10 })
    expect(r.ids).toEqual([7, 8, 9, 10, 11, 12])
    expect(r.doc.nextId).toBe(13)
    expect(r.doc.items.slice(0, 6)).toEqual(doc.items)
    r.doc.items.slice(0, 6).forEach((it, i) => expect(it).toBe(doc.items[i]))
    expect(r.doc.items[6]).toEqual(pic(7, { path: 'p1.png', x: 25, y: -4, rotation: 30, caption: 'a' }))
    expect(r.doc.items[7]).toEqual(note(8, { x: 70, y: -10, text: 'hi' }))
    expect(r.doc.items[8]).toEqual(stroke(9, [20, -10, 30, 0, 40, -10]))
    expect(r.doc.items[9]).toEqual(line(10, 20, -10, 25, -5, { arrow: true }))
    expect(r.doc.items[10]).toEqual(rect(11, 20, -10, 30, 0, { fill: '112233' }))
    expect(r.doc.items[11]).toEqual(ellipse(12, 20, -10, 30, 0))
  })
  it('keeps the layout of the copies relative to each other (random boards)', () => {
    const r = rng(52)
    for (let round = 0; round < 20; round++) {
      const items: BoardItem[] = []
      for (let i = 1; i <= 12; i++) items.push(randItem(r, i))
      const doc = docOf(...items)
      const ids = [2, 3, 5, 8, 11]
      const off = { x: (r() - 0.5) * 500, y: (r() - 0.5) * 500 }
      const out = duplicateItems(doc, ids, off)
      expect(out.ids.length).toBe(5)
      ids.forEach((id, k) => {
        const a = itemBounds(byId(doc, id), M)
        const b = itemBounds(byId(out.doc, out.ids[k]!), M)
        expect(b.x).toBeCloseTo(a.x + off.x, 7)
        expect(b.y).toBeCloseTo(a.y + off.y, 7)
        expect(b.w).toBeCloseTo(a.w, 7)
        expect(b.h).toBeCloseTo(a.h, 7)
      })
    }
  })
  it('makes new groups of copied groups, so a copy is not welded to its original', () => {
    const doc = docOf(pic(1, { group: 1 }), pic(2, { group: 1 }), pic(3, { group: 2 }), pic(4, { group: 2 }), pic(5))
    const out = duplicateItems(doc, [1, 2, 3, 5], { x: 10, y: 10 })
    // 1+2 copy as one new group; 3 alone from group 2 is not a group; 5 was in none
    expect(groupsOf(out.doc)).toEqual([1, 1, 2, 2, 0, 3, 3, 0, 0])
    const both = duplicateItems(doc, [1, 2, 3, 4], { x: 10, y: 10 })
    expect(groupsOf(both.doc)).toEqual([1, 1, 2, 2, 0, 3, 3, 4, 4])
    // the originals' groups are untouched
    expect(out.doc.items.slice(0, 5)).toEqual(doc.items)
  })
  it('does not share what it can mutate with the original', () => {
    const doc = docOf(stroke(1, [0, 0, 1, 1]), pic(2, { crop: { l: 0.1, t: 0, r: 1, b: 1 } }))
    const out = duplicateItems(doc, [1, 2], { x: 0, y: 0 })
    expect((out.doc.items[2] as StrokeItem).points).not.toBe((doc.items[0] as StrokeItem).points)
    expect((out.doc.items[3] as PictureItem).crop).not.toBe((doc.items[1] as PictureItem).crop)
    expect((out.doc.items[3] as PictureItem).crop).toEqual({ l: 0.1, t: 0, r: 1, b: 1 })
  })
  it('does not copy locked items, and gives the same doc when there is nothing to copy', () => {
    const doc = docOf(pic(1, { locked: true }), pic(2))
    const out = duplicateItems(doc, [1, 2], { x: 1, y: 1 })
    expect(out.ids).toEqual([3])
    expect(out.doc.items.length).toBe(3)
    expect(duplicateItems(doc, [1], { x: 1, y: 1 })).toEqual({ doc, ids: [] })
    expect(duplicateItems(doc, [1], { x: 1, y: 1 }).doc).toBe(doc)
    expect(duplicateItems(doc, [], { x: 1, y: 1 }).doc).toBe(doc)
  })
  it('is all or nothing at the item limit', () => {
    const near = docOf(...Array.from({ length: BOARD_LIMITS.items - 2 }, (_, i) => pic(i + 1)))
    const three = duplicateItems(near, [1, 2, 3], { x: 0, y: 0 })
    expect(three.doc).toBe(near)
    expect(three.ids).toEqual([])
    const two = duplicateItems(near, [1, 2], { x: 0, y: 0 })
    expect(two.doc.items.length).toBe(BOARD_LIMITS.items)
    expect(two.ids.length).toBe(2)
  })
  it('hands out fresh ids even when nextId is stale, and puts copies inside the board', () => {
    const doc = { ...docOf(pic(1), pic(2), pic(7, { x: BOARD_LIMITS.coordinate })), nextId: 2 }
    const out = duplicateItems(doc, [1, 7], { x: 100, y: NaN })
    expect(out.ids).toEqual([8, 9])
    expect((byId(out.doc, 9) as PictureItem).x).toBe(BOARD_LIMITS.coordinate)
    expect((byId(out.doc, 8) as PictureItem).y).toBe(0)
  })
})

describe('insertItems', () => {
  it('adds items from elsewhere (a paste) with fresh ids whatever ids they come with, keeping their locked flag', () => {
    const doc = docOf(pic(1), pic(2))
    const clip = [pic(1, { x: 10, locked: true }), note(2, { text: 'pasted' })]
    const out = insertItems(doc, clip, { x: 5, y: 5 })
    expect(out.ids).toEqual([3, 4])
    expect(byId(out.doc, 3)).toMatchObject({ kind: 'picture', x: 15, y: 5, locked: true })
    expect(byId(out.doc, 4)).toMatchObject({ kind: 'note', text: 'pasted', x: 5, y: 5, locked: false })
    expect(clip[0]).toEqual(pic(1, { x: 10, locked: true }))
  })
  it('relabels groups of the clipboard so that they do not join groups already on the board', () => {
    const doc = docOf(pic(1, { group: 1 }), pic(2, { group: 1 }))
    const out = insertItems(doc, [pic(1, { group: 1 }), pic(2, { group: 1 }), pic(3, { group: 5 })], { x: 0, y: 0 })
    expect(groupsOf(out.doc)).toEqual([1, 1, 2, 2, 0])
  })
  it('drops a stroke with no points, and adds nothing for an empty clipboard', () => {
    const doc = docOf(pic(1))
    expect(insertItems(doc, [], { x: 0, y: 0 })).toEqual({ doc, ids: [] })
    expect(insertItems(doc, [stroke(1, [])], { x: 0, y: 0 }).doc).toBe(doc)
  })
  it('cleans what it takes in: numbers gone bad and sizes out of range', () => {
    const doc = docOf()
    const out = insertItems(doc, [pic(1, { w: NaN, h: 1e9, opacity: 7 })], { x: 0, y: 0 })
    const p = byId(out.doc, 1) as PictureItem
    expect(Number.isFinite(p.w)).toBe(true)
    expect(p.h).toBe(BOARD_LIMITS.pictureMax)
    expect(p.opacity).toBe(1)
  })
})

/* ---------------------------------------------------------------- clamp --- */

describe('clampDoc', () => {
  it('returns the same doc, and the same items, when everything is already in range', () => {
    const r = rng(53)
    const items: BoardItem[] = []
    for (let i = 1; i <= 30; i++) items.push(randItem(r, i))
    const doc = deepFreeze(docOf(...items))
    expect(clampDoc(doc)).toBe(doc)
    expect(clampDoc(emptyBoard('x'))).toEqual(emptyBoard('x'))
    const e = emptyBoard('x')
    expect(clampDoc(e)).toBe(e)
  })
  it('puts coordinates inside the board and replaces numbers gone bad', () => {
    const L = BOARD_LIMITS.coordinate
    const doc = docOf(
      pic(1, { x: 5e9, y: -5e9 }),
      note(2, { x: NaN, y: Infinity }),
      stroke(3, [1e12, -1e12, NaN, 5, 7, Infinity]),
      line(4, NaN, NaN, 1e9, -1e9),
      rect(5, -1e9, 0, 0, 1e9),
      ellipse(6, NaN, 0, 0, NaN),
    )
    const out = clampDoc(doc)
    expect(out.items[0]).toMatchObject({ x: L, y: -L })
    expect(out.items[1]).toMatchObject({ x: 0, y: 0 })
    expect((out.items[2] as StrokeItem).points).toEqual([L, -L, L, 5, 7, 5])
    expect(out.items[3]).toMatchObject({ x1: 0, y1: 0, x2: L, y2: -L })
    expect(out.items[4]).toMatchObject({ x1: -L, y1: 0, x2: 0, y2: L })
    expect(out.items[5]).toMatchObject({ x1: 0, y1: 0, x2: 0, y2: 0 })
  })
  it('brings sizes, opacity, line widths, crops and rotation into range', () => {
    const doc = docOf(
      pic(1, { w: 1, h: 1, opacity: 9, rotation: 400, crop: { l: 0.6, t: 0, r: 0.4, b: 1 } }),
      pic(2, { w: 1e9, h: 1e9, opacity: NaN, crop: { l: -1, t: -1, r: 2, b: 2 } }),
      pic(3, { w: NaN, h: NaN, opacity: 0, rotation: NaN, crop: { l: NaN, t: 0, r: 1, b: 1 } }),
      note(4, { w: 1, size: 0, rotation: -180 }),
      note(5, { w: 1e9, size: 1e9 }),
      line(6, 0, 0, 1, 1, { width: 0 }),
      rect(7, 0, 0, 1, 1, { width: 1e9 }),
      stroke(8, [0, 0, 1, 1], { width: NaN }),
    )
    const out = clampDoc(doc)
    expect(out.items[0]).toMatchObject({ w: 8, h: 8, opacity: 1, rotation: 40, crop: { l: 0, t: 0, r: 1, b: 1 } })
    expect(out.items[1]).toMatchObject({ w: BOARD_LIMITS.pictureMax, h: BOARD_LIMITS.pictureMax, opacity: 1, crop: { l: 0, t: 0, r: 1, b: 1 } })
    expect(out.items[2]).toMatchObject({ w: 256, h: 256, opacity: 0.05, rotation: 0, crop: { l: 0, t: 0, r: 1, b: 1 } })
    expect(out.items[3]).toMatchObject({ w: 16, size: 2, rotation: 180 })
    expect(out.items[4]).toMatchObject({ w: BOARD_LIMITS.pictureMax, size: 2000 })
    expect(out.items[5]).toMatchObject({ width: BOARD_ITEM_LIMITS.markWidth.min })
    expect(out.items[6]).toMatchObject({ width: BOARD_ITEM_LIMITS.markWidth.max })
    expect(out.items[7]).toMatchObject({ width: 2 })
  })
  it('keeps the proportions of a picture it has to shrink', () => {
    const out = clampDoc(docOf(pic(1, { w: 80000, h: 20000 })))
    expect(out.items[0]).toMatchObject({ w: 40000, h: 10000 })
  })
  it('cleans colours and cuts texts', () => {
    const out = clampDoc(docOf(note(1, { color: '#ABCDEF', fill: 'oops', text: 'z'.repeat(BOARD_LIMITS.noteCharsFile + 50) }), line(2, 0, 0, 1, 1, { color: 'red' }), pic(3, { caption: 'c'.repeat(BOARD_LIMITS.noteCharsFile + 50) })))
    expect(out.items[0]).toMatchObject({ color: 'abcdef', fill: '' })
    // Texts are cut at what a file may hold; the 4,000 are what a user can make (a longer one that came from a file is not cut by an edit).
    expect((out.items[0] as NoteItem).text.length).toBe(BOARD_LIMITS.noteCharsFile)
    expect(out.items[1]).toMatchObject({ color: 'ffffff' })
    expect((out.items[2] as PictureItem).caption.length).toBe(BOARD_LIMITS.noteCharsFile)
    expect((clampDoc(docOf(note(1, { text: 'z'.repeat(5000) }))).items[0] as NoteItem).text.length).toBe(5000)
  })
  it('drops a stroke with no point, cuts a stroke past the limit, and keeps the others', () => {
    const long = stroke(2, Array.from({ length: 2 * (BOARD_LIMITS.strokePointsFile + 50) }, (_, i) => i))
    const out = clampDoc(docOf(stroke(1, []), long, pic(3), stroke(4, [5])))
    expect(idsOf(out)).toEqual([2, 3])
    expect((out.items[0] as StrokeItem).points.length).toBe(2 * BOARD_LIMITS.strokePointsFile)
    // A stroke past what a user can draw but inside what a file holds keeps its points.
    const drawn = stroke(2, Array.from({ length: 2 * (BOARD_LIMITS.strokePoints + 50) }, (_, i) => i))
    expect((clampDoc(docOf(drawn)).items[0] as StrokeItem).points.length).toBe(2 * (BOARD_LIMITS.strokePoints + 50))
  })
  it('makes the view, background, flags, grid and next id valid', () => {
    const doc: BoardDoc = {
      ...docOf(pic(1), pic(9)),
      view: { x: NaN, y: 9e9, zoom: 0 },
      bg: 'nope',
      grid: -5,
      nextId: 3,
    }
    const out = clampDoc(doc)
    expect(out.view).toEqual({ x: 0, y: BOARD_LIMITS.coordinate, zoom: BOARD_LIMITS.zoomMin })
    expect(out.bg).toBe('14161d')
    expect(out.grid).toBe(0)
    expect(out.nextId).toBe(10)
    expect(clampDoc({ ...doc, grid: NaN }).grid).toBe(0)
    expect(clampDoc({ ...doc, grid: 1e9 }).grid).toBe(BOARD_ITEM_LIMITS.grid.max)
    expect(clampDoc({ ...docOf(), nextId: NaN }).nextId).toBe(1)
  })
  it('numbers a group that is not a whole number as no group, and a locked flag that is not a boolean as unlocked', () => {
    const out = clampDoc(docOf(pic(1, { group: -2 }), pic(2, { group: 1.5 }), pic(3, { group: NaN })))
    expect(groupsOf(out)).toEqual([0, 0, 0])
  })
  it('is idempotent and leaves untouched items as they were', () => {
    const doc = docOf(pic(1), pic(2, { x: 1e9 }), pic(3))
    const once = clampDoc(doc)
    expect(clampDoc(once)).toBe(once)
    expect(once.items[0]).toBe(doc.items[0])
    expect(once.items[2]).toBe(doc.items[2])
    expect(once.items[1]).not.toBe(doc.items[1])
  })
  it('does not change the doc it is given', () => {
    const doc = deepFreeze(docOf(pic(1, { x: NaN, w: 1e9 }), stroke(2, [NaN, 1, 2, 3]), stroke(3, [])))
    expect(() => clampDoc(doc)).not.toThrow()
    expect(doc.items.length).toBe(3)
  })
})
