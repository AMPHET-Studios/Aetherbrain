/**
 * Arranging a board: lay the selected pictures and notes out as a row, a column, a grid, a packed layout or a pile; order them (by
 * name, age, size, a shuffle); align and distribute them; make their sizes equal. Pure functions `BoardDoc → BoardDoc` in the style of
 * ops.ts: nothing is mutated, a no-op returns the very same doc, locked items are skipped. Design: docs/design/reference-board.md.
 *
 * What moves. Pictures and notes. A mark (stroke, line, rectangle, ellipse) never moves by itself, because it annotates something
 * and would be left behind; it moves only as a member of a group, and a group is one rigid unit (members keep their places relative
 * to each other, marks included, and the unit's footprint is the rectangle round all of them). A group with a locked member cannot move
 * rigidly, so it stays whole where it is, as do groups and loose marks that hold no picture or note. A unit's footprint is the
 * axis-aligned rectangle round its rotated members (geometry.ts), so units that do not overlap there do not overlap at all.
 *
 * Where it goes. The layout is centred on the centre of the rectangle round the units that were arranged, so arranging does not fling
 * the selection across the board. Positions closer than rounding noise to where they already are are left alone: arranging an arranged
 * selection again returns the same doc.
 */
import { estimateTextMetrics } from './text'
import { itemSize, itemsBounds } from './geometry'
import { expandGroups, moveItems, resizePicture } from './ops'
import type { BoardDoc, BoardItem, PictureItem, Rect, TextMetrics, Vec2 } from './types'

export type ArrangeMode = 'optimal' | 'row' | 'column' | 'grid' | 'stack'
export type ArrangeOrder = 'current' | 'name' | 'added' | 'size' | 'shuffle'

export interface ArrangeOptions {
  /** The order the units are laid out in (the pile's order from back to front): 'current' is the board's own back-to-front order. */
  order?: ArrangeOrder
  /** Board units between neighbouring units (rows included), 16 by default; below 0 counts as 0. */
  gap?: number
  /** Width over height the whole layout aims for in 'optimal' and 'grid', 1.6 by default. */
  aspect?: number
  /** Decides 'shuffle': the same seed gives the same shuffle. */
  seed?: number
  /** How tall notes are; the estimate in text.ts when left out. */
  metrics?: TextMetrics
  /** 'grid' only: the number of columns. Left out, it is chosen to bring the grid's shape closest to `aspect`. */
  columns?: number
}

const DEFAULT_GAP = 16
const DEFAULT_ASPECT = 1.6
/** Distances this small, relative to the coordinates involved, are floating-point noise, not a move. */
const NOISE = 1e-9
/** The tiniest size the packer divides by. */
const TINY = 1e-9
/** How many row widths 'optimal' tries at most (each is one pass over the units). */
const MAX_PACKS = 4000
/** How much of a note's or a name's start the name order looks at. */
const SORT_KEY_CHARS = 200

function isLaidOut(item: BoardItem): boolean {
  return item.kind === 'picture' || item.kind === 'note'
}

/* ------------------------------------------------------------- ordering --- */

/** A small deterministic generator (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A seeded Fisher-Yates shuffle: a new array, the same one for the same seed and the same input. */
function shuffled<T>(items: readonly T[], seed: number | undefined): T[] {
  const a = items.slice()
  const rnd = seeded(seed !== undefined && Number.isFinite(seed) ? Math.floor(seed) : 1)
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

/** Compares two (lower-case) strings with the digit runs in them taken by value: "img2" before "img10", "a 1" before "a1". */
function naturalCompare(a: string, b: string): number {
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const ca = a.charCodeAt(i)
    const cb = b.charCodeAt(j)
    if (isDigit(ca) && isDigit(cb)) {
      let ie = i
      while (ie < a.length && isDigit(a.charCodeAt(ie))) ie++
      let je = j
      while (je < b.length && isDigit(b.charCodeAt(je))) je++
      // Leading zeros do not count, so "007" and "7" are the same number (the caller's stable sort keeps them in order).
      let is = i
      while (is < ie - 1 && a.charCodeAt(is) === 48) is++
      let js = j
      while (js < je - 1 && b.charCodeAt(js) === 48) js++
      if (ie - is !== je - js) return ie - is < je - js ? -1 : 1
      for (let k = 0; k < ie - is; k++) {
        const da = a.charCodeAt(is + k)
        const db = b.charCodeAt(js + k)
        if (da !== db) return da < db ? -1 : 1
      }
      i = ie
      j = je
    } else {
      if (ca !== cb) return ca < cb ? -1 : 1
      i++
      j++
    }
  }
  return a.length - i === b.length - j ? 0 : a.length - i < b.length - j ? -1 : 1
}

/** A picture file's name without its folder and extension ("Boards/Gate/rust 2.png" gives "rust 2"). */
function baseName(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** What the name order compares: a picture's file name, a note's text; null for a mark, which has no name. */
function nameKey(item: BoardItem): string | null {
  if (item.kind === 'picture') return baseName(item.path).slice(0, SORT_KEY_CHARS).toLowerCase()
  if (item.kind === 'note') return item.text.trim().slice(0, SORT_KEY_CHARS).toLowerCase()
  return null
}

/**
 * The ids of `ids` that are on the board, in the order asked for, each once. 'current' is the board's back-to-front order; 'added' is
 * by id (the order they were made in); 'size' is by shown area, largest first; 'name' is natural order on a picture's file name
 * (no folder, no extension, case ignored, numbers by value) and on a note's text, with marks (no name) after those; 'shuffle' is a
 * seeded shuffle of the current order. Items that compare equal keep their board order. `metrics` measures notes for 'size'.
 */
export function sortOrder(
  doc: BoardDoc,
  ids: readonly number[],
  order: ArrangeOrder,
  seed?: number,
  metrics: TextMetrics = estimateTextMetrics,
): number[] {
  const set = new Set(ids)
  const items = doc.items.filter((it) => set.has(it.id))
  switch (order) {
    case 'added':
      return items
        .map((it, i) => ({ id: it.id, i }))
        .sort((p, q) => p.id - q.id || p.i - q.i)
        .map((e) => e.id)
    case 'size':
      return items
        .map((it, i) => {
          const s = itemSize(it, metrics)
          return { id: it.id, i, area: s.w * s.h }
        })
        .sort((p, q) => q.area - p.area || p.i - q.i)
        .map((e) => e.id)
    case 'name':
      return items
        .map((it, i) => ({ id: it.id, i, key: nameKey(it) }))
        .sort((p, q) => {
          if (p.key === null || q.key === null) return p.key === q.key ? p.i - q.i : p.key === null ? 1 : -1
          return naturalCompare(p.key, q.key) || p.i - q.i
        })
        .map((e) => e.id)
    case 'shuffle':
      return shuffled(items, seed).map((it) => it.id)
    default:
      return items.map((it) => it.id)
  }
}

/* ---------------------------------------------------------------- units --- */

/** Something that moves as one: a loose picture or note, or a whole group. */
interface Unit {
  /** Every member, marks of a group included, in board order. */
  ids: number[]
  /** The rectangle round all the members (their rotated bounds). */
  rect: Rect
}

const centreOf = (r: Rect): Vec2 => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/** The units the ids make, in board order of their first member. See the file header for what is left out. */
function buildUnits(doc: BoardDoc, ids: readonly number[], metrics: TextMetrics): Unit[] {
  const wanted = new Set(expandGroups(doc, ids))
  if (wanted.size === 0) return []
  const byGroup = new Map<number, BoardItem[]>()
  const parts: BoardItem[][] = []
  for (const it of doc.items) {
    if (!wanted.has(it.id)) continue
    if (it.group > 0) {
      let members = byGroup.get(it.group)
      if (!members) {
        members = []
        byGroup.set(it.group, members)
        parts.push(members)
      }
      members.push(it)
    } else parts.push([it])
  }
  const units: Unit[] = []
  for (const part of parts) {
    if (part.some((it) => it.locked) || !part.some(isLaidOut)) continue
    const rect = itemsBounds(part, metrics)
    if (rect) units.push({ ids: part.map((it) => it.id), rect })
  }
  return units
}

function unionRect(units: readonly Unit[]): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const u of units) {
    x0 = Math.min(x0, u.rect.x)
    y0 = Math.min(y0, u.rect.y)
    x1 = Math.max(x1, u.rect.x + u.rect.w)
    y1 = Math.max(y1, u.rect.y + u.rect.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The units in the order asked for. A unit stands where its first member would in the item order; a shuffle shuffles the units. */
function orderUnits(doc: BoardDoc, units: Unit[], order: ArrangeOrder, seed: number | undefined, metrics: TextMetrics): Unit[] {
  if (order === 'current' || units.length < 2) return units
  if (order === 'shuffle') return shuffled(units, seed)
  const kind = new Map(doc.items.map((it) => [it.id, isLaidOut(it)]))
  const named = units.flatMap((u) => u.ids.filter((id) => kind.get(id)))
  const rank = new Map(sortOrder(doc, named, order, seed, metrics).map((id, i) => [id, i]))
  const first = (u: Unit): number => Math.min(...u.ids.map((id) => rank.get(id) ?? Infinity))
  return units
    .map((u) => ({ u, r: first(u) }))
    .sort((p, q) => p.r - q.r)
    .map((e) => e.u)
}

/** Moves `unit` by (dx, dy), dropping moves that are only rounding noise. */
function shift(doc: BoardDoc, unit: Unit, dx: number, dy: number, scale: number): BoardDoc {
  const eps = NOISE * Math.max(1, scale)
  return moveItems(doc, unit.ids, Math.abs(dx) < eps ? 0 : dx, Math.abs(dy) < eps ? 0 : dy)
}

/* -------------------------------------------------------------- layouts --- */

interface Size {
  w: number
  h: number
}

/** Centres of the units side by side, left to right, on one horizontal line. */
function rowLayout(sizes: readonly Size[], gap: number): Vec2[] {
  let x = 0
  return sizes.map((s) => {
    const c = { x: x + s.w / 2, y: 0 }
    x += s.w + gap
    return c
  })
}

/** Centres of the units one under the other, top to bottom, on one vertical line. */
function columnLayout(sizes: readonly Size[], gap: number): Vec2[] {
  let y = 0
  return sizes.map((s) => {
    const c = { x: 0, y: y + s.h / 2 }
    y += s.h + gap
    return c
  })
}

/** The width of each column and the height of each row of a table that fills rows of `cols` units left to right. */
function tableOf(sizes: readonly Size[], cols: number): { colW: number[]; rowH: number[] } {
  const colW: number[] = new Array(Math.min(cols, sizes.length)).fill(0)
  const rowH: number[] = new Array(Math.ceil(sizes.length / cols)).fill(0)
  sizes.forEach((s, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    if (s.w > colW[c]!) colW[c] = s.w
    if (s.h > rowH[r]!) rowH[r] = s.h
  })
  return { colW, rowH }
}

const sum = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0)

/** The column count whose table comes closest to the wanted shape (on a log scale), the least area on a tie. */
function chooseColumns(sizes: readonly Size[], gap: number, aspect: number): number {
  let best = 1
  let bestErr = Infinity
  let bestArea = Infinity
  for (let cols = 1; cols <= sizes.length; cols++) {
    const { colW, rowH } = tableOf(sizes, cols)
    const w = sum(colW) + gap * (colW.length - 1)
    const h = sum(rowH) + gap * (rowH.length - 1)
    const err = Math.abs(Math.log(Math.max(w, TINY) / Math.max(h, TINY) / aspect))
    const area = w * h
    if (err < bestErr - 1e-12 || (Math.abs(err - bestErr) <= 1e-12 && area < bestArea)) {
      best = cols
      bestErr = err
      bestArea = area
    }
  }
  return best
}

/** Centres of the units in a table of `cols` columns, each unit in the middle of its cell. */
function gridLayout(sizes: readonly Size[], gap: number, cols: number): Vec2[] {
  const { colW, rowH } = tableOf(sizes, cols)
  const xs: number[] = []
  let x = 0
  for (const w of colW) {
    xs.push(x)
    x += w + gap
  }
  const ys: number[] = []
  let y = 0
  for (const h of rowH) {
    ys.push(y)
    y += h + gap
  }
  return sizes.map((_, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    return { x: xs[c]! + colW[c]! / 2, y: ys[r]! + rowH[r]! / 2 }
  })
}

/** The rows a greedy fill makes when no row may be wider than `limit`, and how the whole comes out. */
interface Pack {
  /** Index of the first unit of each row. */
  starts: number[]
  width: number
  height: number
  /** The smallest limit at which the fill would be different (some row could take one more unit); Infinity when none. */
  next: number
}

function packRows(sizes: readonly Size[], gap: number, limit: number): Pack {
  const starts = [0]
  let rowW = 0
  let rowH = 0
  let width = 0
  let height = 0
  let next = Infinity
  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i]!
    if (i === 0) {
      rowW = s.w
      rowH = s.h
      continue
    }
    // The same expression is the limit that would let this unit in, so stepping to `next` really changes the fill.
    const grown = rowW + gap + s.w
    if (grown <= limit) {
      rowW = grown
      if (s.h > rowH) rowH = s.h
      continue
    }
    if (grown < next) next = grown
    if (rowW > width) width = rowW
    height += rowH + gap
    starts.push(i)
    rowW = s.w
    rowH = s.h
  }
  if (rowW > width) width = rowW
  height += rowH
  return { starts, width, height, next }
}

/**
 * Justified rows in the given order: units keep their sizes, a row is filled until the next unit would not fit under a limit, rows are
 * centred on one vertical line and the units of a row on one horizontal line. The limit is the knob: every different fill from a
 * row width a quarter to four times the width a square-ish layout of that much area would have is tried (each is the fill at the
 * widest row it makes, found by stepping from one change of fill to the next), and the layout is kept whose shape is closest to
 * `aspect` (log scale) with the least empty space inside its rectangle (the two errors are added, so a perfectly full layout a little
 * off the shape beats a ragged one right on it).
 */
function optimalLayout(sizes: readonly Size[], gap: number, aspect: number): Vec2[] {
  let area = 0
  let used = 0
  let narrowest = 0
  let widest = 0
  sizes.forEach((s, i) => {
    area += (s.w + gap) * (s.h + gap)
    used += s.w * s.h
    if (s.w > narrowest) narrowest = s.w
    // Summed the way packRows sums a row, so a limit of `widest` really holds everything in one row.
    widest = i === 0 ? s.w : widest + gap + s.w
  })
  const ideal = Math.sqrt(area * aspect)
  const clampW = (w: number): number => Math.min(Math.max(w, narrowest), widest)
  const lo = clampW(ideal / 4)
  const hi = clampW(ideal * 4)

  const kept: { pack: Pack | null; score: number } = { pack: null, score: Infinity }
  const consider = (p: Pack): void => {
    const shape = Math.abs(Math.log(Math.max(p.width, TINY) / Math.max(p.height, TINY) / aspect))
    const empty = Math.max(0, 1 - used / Math.max(p.width * p.height, TINY))
    const score = shape + empty
    if (kept.pack === null || score < kept.score) {
      kept.pack = p
      kept.score = score
    }
  }
  consider(packRows(sizes, gap, narrowest))
  let limit = lo
  for (let k = 0; k < MAX_PACKS; k++) {
    const p = packRows(sizes, gap, limit)
    consider(p)
    if (!(p.next <= hi)) break
    limit = p.next
  }
  consider(packRows(sizes, gap, widest))

  const starts = kept.pack!.starts
  const out: Vec2[] = new Array(sizes.length)
  let y = 0
  for (let r = 0; r < starts.length; r++) {
    const from = starts[r]!
    const to = starts[r + 1] ?? sizes.length
    let rowW = gap * (to - from - 1)
    let rowH = 0
    for (let i = from; i < to; i++) {
      rowW += sizes[i]!.w
      if (sizes[i]!.h > rowH) rowH = sizes[i]!.h
    }
    let x = -rowW / 2
    for (let i = from; i < to; i++) {
      out[i] = { x: x + sizes[i]!.w / 2, y: y + rowH / 2 }
      x += sizes[i]!.w + gap
    }
    y += rowH + gap
  }
  return out
}

/** Moves the units so that the layout `centres` (of units of `sizes`) is centred on `middle`. */
function place(doc: BoardDoc, units: readonly Unit[], sizes: readonly Size[], centres: readonly Vec2[], middle: Vec2): BoardDoc {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  centres.forEach((c, i) => {
    const s = sizes[i]!
    x0 = Math.min(x0, c.x - s.w / 2)
    y0 = Math.min(y0, c.y - s.h / 2)
    x1 = Math.max(x1, c.x + s.w / 2)
    y1 = Math.max(y1, c.y + s.h / 2)
  })
  const lx = (x0 + x1) / 2
  const ly = (y0 + y1) / 2
  let out = doc
  units.forEach((u, i) => {
    const now = centreOf(u.rect)
    const to = { x: middle.x + centres[i]!.x - lx, y: middle.y + centres[i]!.y - ly }
    out = shift(out, u, to.x - now.x, to.y - now.y, Math.max(Math.abs(to.x), Math.abs(to.y)))
  })
  return out
}

/** The doc with the arranged items' places in the drawing order handed out again so that the units run back to front in `units` order. */
function restack(doc: BoardDoc, units: readonly Unit[]): BoardDoc {
  const want = units.flatMap((u) => u.ids)
  const members = new Set(want)
  const slots: number[] = []
  doc.items.forEach((it, i) => {
    if (members.has(it.id)) slots.push(i)
  })
  const byId = new Map(doc.items.map((it) => [it.id, it]))
  const items = doc.items.slice()
  let changed = false
  slots.forEach((slot, k) => {
    const item = byId.get(want[k]!)!
    if (items[slot] !== item) {
      items[slot] = item
      changed = true
    }
  })
  return changed ? { ...doc, items } : doc
}

/**
 * Lays out the pictures and notes of `ids` (a group counts as one rigid unit, whole whichever of its members are listed).
 * 'row': left to right on one horizontal line; 'column': top to bottom on one vertical line; 'grid': rows of `opts.columns` units
 * (or the count that brings the shape closest to `opts.aspect`), columns as wide as their widest unit and rows as tall as their tallest;
 * 'optimal': packed justified rows aiming at `opts.aspect` with little empty space, sizes untouched; 'stack': every unit on one
 * centre, the first of `opts.order` at the back (the drawing order of the arranged items changes to match unless the order is
 * 'current'). Units are set `opts.gap` apart in the other modes. Everything is centred on the middle of where the units were.
 */
export function arrange(doc: BoardDoc, ids: readonly number[], mode: ArrangeMode, opts: ArrangeOptions = {}): BoardDoc {
  const metrics = opts.metrics ?? estimateTextMetrics
  const gap = opts.gap !== undefined && Number.isFinite(opts.gap) ? Math.max(0, opts.gap) : DEFAULT_GAP
  const aspect = opts.aspect !== undefined && Number.isFinite(opts.aspect) && opts.aspect > 0 ? opts.aspect : DEFAULT_ASPECT
  const order = opts.order ?? 'current'
  const found = buildUnits(doc, ids, metrics)
  if (found.length === 0) return doc
  const middle = centreOf(unionRect(found))
  const units = orderUnits(doc, found, order, opts.seed, metrics)
  const sizes = units.map((u) => ({ w: u.rect.w, h: u.rect.h }))

  let centres: Vec2[]
  switch (mode) {
    case 'row':
      centres = rowLayout(sizes, gap)
      break
    case 'column':
      centres = columnLayout(sizes, gap)
      break
    case 'grid': {
      const wanted = opts.columns !== undefined && Number.isFinite(opts.columns) ? Math.floor(opts.columns) : 0
      const cols = wanted >= 1 ? Math.min(wanted, units.length) : chooseColumns(sizes, gap, aspect)
      centres = gridLayout(sizes, gap, cols)
      break
    }
    case 'optimal':
      centres = optimalLayout(sizes, gap, aspect)
      break
    case 'stack':
      centres = sizes.map(() => ({ x: 0, y: 0 }))
      break
    default:
      return doc
  }
  const moved = place(doc, units, sizes, centres, middle)
  return mode === 'stack' && order !== 'current' ? restack(moved, units) : moved
}

/* ----------------------------------------------------- align, distribute --- */

export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'centerH' | 'centerV'

/**
 * Brings the units of `ids` (pictures, notes and groups, as in `arrange`) to one edge or centre line of the rectangle round all of
 * them: 'left', 'right', 'top', 'bottom', or 'centerH' (the centres share one x: a vertical line) and 'centerV' (the centres share
 * one y: a horizontal line). Locked items and the marks that are not in a group stay. Fewer than two units change nothing.
 */
export function align(doc: BoardDoc, ids: readonly number[], edge: AlignEdge, metrics: TextMetrics = estimateTextMetrics): BoardDoc {
  const units = buildUnits(doc, ids, metrics)
  if (units.length < 2) return doc
  const r = unionRect(units)
  let out = doc
  for (const u of units) {
    const b = u.rect
    let dx = 0
    let dy = 0
    switch (edge) {
      case 'left':
        dx = r.x - b.x
        break
      case 'right':
        dx = r.x + r.w - (b.x + b.w)
        break
      case 'top':
        dy = r.y - b.y
        break
      case 'bottom':
        dy = r.y + r.h - (b.y + b.h)
        break
      case 'centerH':
        dx = r.x + r.w / 2 - (b.x + b.w / 2)
        break
      case 'centerV':
        dy = r.y + r.h / 2 - (b.y + b.h / 2)
        break
      default:
        return doc
    }
    out = shift(out, u, dx, dy, Math.max(Math.abs(r.x), Math.abs(r.y), Math.abs(r.x + r.w), Math.abs(r.y + r.h)))
  }
  return out
}

/**
 * Spreads the units of `ids` along an axis ('h': left to right, 'v': top to bottom) so the gaps between neighbouring rectangles are
 * all the same. The unit that is first by centre and the one that is last stay where they are; the ones between move. Needs three
 * units (fewer change nothing); units that cannot fit end to end in the span overlap by the same amount each (a negative gap).
 */
export function distribute(doc: BoardDoc, ids: readonly number[], axis: 'h' | 'v', metrics: TextMetrics = estimateTextMetrics): BoardDoc {
  const units = buildUnits(doc, ids, metrics)
  if (units.length < 3) return doc
  const h = axis === 'h'
  const start = (u: Unit): number => (h ? u.rect.x : u.rect.y)
  const extent = (u: Unit): number => (h ? u.rect.w : u.rect.h)
  const middle = (u: Unit): number => start(u) + extent(u) / 2
  const sorted = units.map((u, i) => ({ u, i })).sort((p, q) => middle(p.u) - middle(q.u) || p.i - q.i).map((e) => e.u)
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!
  const span = start(last) + extent(last) - start(first)
  const gap = (span - sum(sorted.map(extent))) / (sorted.length - 1)
  let at = start(first) + extent(first) + gap
  let out = doc
  for (let i = 1; i < sorted.length - 1; i++) {
    const u = sorted[i]!
    const d = at - start(u)
    out = shift(out, u, h ? d : 0, h ? 0 : d, Math.max(Math.abs(at), Math.abs(start(u))))
    at += extent(u) + gap
  }
  return out
}

/* ------------------------------------------------------------ normalize --- */

export type NormalizeMode = 'width' | 'height' | 'size' | 'scale'

/**
 * Makes pictures equal, each about its own centre, with crop and rotation untouched (marks, notes and locked pictures are skipped,
 * and the ids are used as given: groups are not expanded, the selection already holds whole groups). 'width' and 'height' make the
 * shown width or height (the cropped part, unrotated) equal to `opts.target`, 'size' makes the shown area equal to it, each keeping
 * the picture's proportions; the target is the mean of the pictures concerned when it is left out or not a positive number. 'scale'
 * sets a picture's whole width to `natural(path).w` times `opts.target` (1 by default), the proportions kept, and leaves alone the
 * pictures whose natural size is unknown (no `natural`, or it answers null). Sizes stay within the picture limits (ops.resizePicture).
 */
export function normalize(
  doc: BoardDoc,
  ids: readonly number[],
  mode: NormalizeMode,
  opts: { target?: number; natural?: (path: string) => { w: number; h: number } | null; metrics?: TextMetrics } = {},
): BoardDoc {
  const metrics = opts.metrics ?? estimateTextMetrics
  const set = new Set(ids)
  const pictures = doc.items.filter((it): it is PictureItem => it.kind === 'picture' && set.has(it.id) && !it.locked)
  const given = opts.target !== undefined && Number.isFinite(opts.target) && opts.target > 0 ? opts.target : undefined
  let out = doc

  if (mode === 'scale') {
    const factor = given ?? 1
    for (const p of pictures) {
      const nat = opts.natural?.(p.path)
      if (!nat || !Number.isFinite(nat.w) || !(nat.w > 0)) continue
      out = resizePicture(out, p.id, nat.w * factor)
    }
    return out
  }

  const shown = pictures
    .map((p) => ({ p, s: itemSize(p, metrics) }))
    .filter(({ s }) => Number.isFinite(s.w) && Number.isFinite(s.h) && s.w > 0 && s.h > 0)
  if (shown.length === 0) return doc
  const measure = (s: Size): number => (mode === 'width' ? s.w : mode === 'height' ? s.h : s.w * s.h)
  const target = given ?? sum(shown.map(({ s }) => measure(s))) / shown.length
  for (const { p, s } of shown) {
    // Area grows with the square of the side, so the side scales by the square root.
    const factor = mode === 'size' ? Math.sqrt(target / measure(s)) : target / measure(s)
    out = resizePicture(out, p.id, p.w * factor)
  }
  return out
}
