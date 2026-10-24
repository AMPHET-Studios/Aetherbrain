/**
 * Pure operations on a board document. Every function takes a BoardDoc and returns a new one; nothing is mutated, and whatever did not
 * change keeps its identity (a no-op returns the very same doc, so a caller can tell "nothing happened" with `===`). Locked items are
 * skipped by everything except `lockItems`; ids that are not on the board are ignored. These functions never expand groups: the
 * controller passes `expandGroups(doc, ids)` where a gesture should take a whole group. A number gone bad (NaN, Infinity) in an
 * argument means "no change", and results are kept inside BOARD_LIMITS. Design: docs/design/reference-board.md.
 *
 * Where a picture's or note's size is needed (a flip about the selection's centre, which item overlaps which) the functions take the
 * text metrics last, defaulting to the estimate.
 */
import { isModelPath } from '../vault/assets'
import { isDefaultView, normaliseView, type ModelView } from '../models/proxyRaster'
import { cleanText, cutText, estimateTextMetrics } from './text'
import { clampView, itemBounds, itemsBounds, noteBox, normalizeAngle, rotatePoint } from './geometry'
import {
  BOARD_LIMITS,
  type BoardDoc,
  type BoardItem,
  type Crop,
  type EllipseItem,
  type LineItem,
  type MarkItem,
  type NoteItem,
  type PictureItem,
  type Rect,
  type RectItem,
  type StrokeItem,
  type TextMetrics,
  type Vec2,
} from './types'

/**
 * What the operations keep item properties within (the inspector and the drag handles use the same numbers), and what the markdown
 * format (format.ts) clamps to when it reads and writes: ONE table, so a value that is valid in memory is never changed by a save.
 */
export const BOARD_ITEM_LIMITS = {
  /** A note's font size, board units. */
  noteSize: { min: 2, max: 2000 },
  /** A note's width, board units. */
  noteWidth: { min: 16, max: BOARD_LIMITS.pictureMax },
  /**
   * A mark's line width, board units. A line is as thick on the screen as its style says whatever the zoom, so the range is what a pen of
   * about half a pixel to 200 pixels needs between the zoom limits (0.5 / 64 up to 200 / 0.005).
   */
  markWidth: { min: 0.005, max: 40_000 },
  opacity: { min: 0.05, max: 1 },
  /** The least a crop may leave of a picture's width or height (a fraction). */
  cropMin: 0.02,
  /** The snap grid, board units (0: none). */
  grid: { min: 0, max: 10_000 },
} as const

const NOTE_DEFAULTS = { w: 240, size: 18 }
/** The size of a picture whose size came as nonsense. */
const FALLBACK_PICTURE_EDGE = 256
const FALLBACK_COLOUR = 'ffffff'

const L = BOARD_LIMITS.coordinate

function fin(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback
}

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function clampCoord(v: number): number {
  return clampTo(fin(v), -L, L)
}

/** A colour as 6 lowercase hex digits (a leading # is dropped), or null. */
function hex6(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.startsWith('#') ? v.slice(1) : v
  return /^[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null
}

/* ------------------------------------------------------------ sanitising -- */

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i])
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
  }
  return false
}

/** `next` when it differs from `prev` in any field (one `prev` has and `next` has not, an optional one taken away, too), else `prev` itself. */
function keepIfSame<T extends object>(prev: T, next: T): T {
  const a = prev as Record<string, unknown>
  const b = next as Record<string, unknown>
  for (const k of Object.keys(b)) if (!sameValue(a[k], b[k])) return next
  for (const k of Object.keys(a)) if (!(k in b) && a[k] !== undefined) return next
  return prev
}

/** A picture's size with its sides inside the allowed range, keeping the proportions where both limits can be met. */
function fitPictureSize(w: number, h: number): { w: number; h: number } {
  let W = fin(w)
  let H = fin(h)
  if (!(W > 0) && !(H > 0)) W = H = FALLBACK_PICTURE_EDGE
  else if (!(W > 0)) W = H
  else if (!(H > 0)) H = W
  const { pictureMin: lo, pictureMax: hi } = BOARD_LIMITS
  let s = 1
  const big = Math.max(W, H)
  if (big > hi) s = hi / big
  const small = Math.min(W, H)
  if (small * s < lo) s = lo / small
  return { w: clampTo(W * s, lo, hi), h: clampTo(H * s, lo, hi) }
}

/** The crop with each fraction inside 0..1, or null when it leaves less than the minimum of an edge (or is not a number). */
function validCrop(c: Crop): Crop | null {
  if (!c || !Number.isFinite(c.l) || !Number.isFinite(c.t) || !Number.isFinite(c.r) || !Number.isFinite(c.b)) return null
  const next = { l: clampTo(c.l, 0, 1), t: clampTo(c.t, 0, 1), r: clampTo(c.r, 0, 1), b: clampTo(c.b, 0, 1) }
  const min = BOARD_ITEM_LIMITS.cropMin - 1e-9
  return next.r - next.l >= min && next.b - next.t >= min ? next : null
}

/** The points with every coordinate finite and in range, at most `cap` of them (a file may hold more than a user can draw). */
function cleanPoints(points: readonly number[], cap: number = BOARD_LIMITS.strokePointsFile): number[] {
  const n = Math.min(points.length >> 1, cap)
  const out: number[] = new Array(n * 2)
  for (let i = 0; i < n; i++) {
    // A coordinate gone bad takes the previous point's, so the stroke keeps its shape and its length.
    out[2 * i] = clampCoord(Number.isFinite(points[2 * i]!) ? points[2 * i]! : i > 0 ? out[2 * i - 2]! : 0)
    out[2 * i + 1] = clampCoord(Number.isFinite(points[2 * i + 1]!) ? points[2 * i + 1]! : i > 0 ? out[2 * i - 1]! : 0)
  }
  return out
}

function markWidth(v: number): number {
  return clampTo(fin(v, 2), BOARD_ITEM_LIMITS.markWidth.min, BOARD_ITEM_LIMITS.markWidth.max)
}

/** A note's or caption's text as it is kept: no control characters, cut to what a file may hold. */
function keptText(s: unknown): string {
  return typeof s === 'string' ? cutText(cleanText(s), BOARD_LIMITS.noteCharsFile) : ''
}

/** The item with every number inside its range, colours as 6 hex digits, text cut to its limit. The same object when it already is. */
function sanitizeItem(item: BoardItem): BoardItem {
  const group = Number.isInteger(item.group) && item.group > 0 ? item.group : 0
  const locked = item.locked === true
  switch (item.kind) {
    case 'picture': {
      const size = fitPictureSize(item.w, item.h)
      // A view is kept as the file keeps it, and only on a model, and only when it is not the first view.
      const { turn, ...bare } = item
      const view = turn && isModelPath(item.path) ? normaliseView(turn) : null
      const turned = view && !isDefaultView(view) ? view : null
      const next: PictureItem = {
        ...bare,
        ...(turned ? { turn: turned } : {}),
        group,
        locked,
        x: clampCoord(item.x),
        y: clampCoord(item.y),
        w: size.w,
        h: size.h,
        rotation: normalizeAngle(item.rotation),
        crop: validCrop(item.crop) ?? { l: 0, t: 0, r: 1, b: 1 },
        flipH: item.flipH === true,
        flipV: item.flipV === true,
        gray: item.gray === true,
        opacity: clampTo(fin(item.opacity, 1), BOARD_ITEM_LIMITS.opacity.min, BOARD_ITEM_LIMITS.opacity.max),
        caption: keptText(item.caption),
      }
      return keepIfSame(item, next)
    }
    case 'note':
      return keepIfSame(item, {
        ...item,
        group,
        locked,
        x: clampCoord(item.x),
        y: clampCoord(item.y),
        w: clampTo(fin(item.w, NOTE_DEFAULTS.w), BOARD_ITEM_LIMITS.noteWidth.min, BOARD_ITEM_LIMITS.noteWidth.max),
        size: clampTo(fin(item.size, NOTE_DEFAULTS.size), BOARD_ITEM_LIMITS.noteSize.min, BOARD_ITEM_LIMITS.noteSize.max),
        rotation: normalizeAngle(item.rotation),
        text: keptText(item.text),
        color: hex6(item.color) ?? FALLBACK_COLOUR,
        fill: item.fill === '' ? '' : (hex6(item.fill) ?? ''),
      })
    case 'stroke':
      return keepIfSame(item, {
        ...item,
        group,
        locked,
        points: cleanPoints(item.points),
        color: hex6(item.color) ?? FALLBACK_COLOUR,
        width: markWidth(item.width),
      })
    case 'line':
      return keepIfSame(item, {
        ...item,
        group,
        locked,
        x1: clampCoord(item.x1),
        y1: clampCoord(item.y1),
        x2: clampCoord(item.x2),
        y2: clampCoord(item.y2),
        color: hex6(item.color) ?? FALLBACK_COLOUR,
        width: markWidth(item.width),
        arrow: item.arrow === true,
      })
    case 'rect':
    case 'ellipse':
      return keepIfSame<RectItem | EllipseItem>(item, {
        ...item,
        group,
        locked,
        x1: clampCoord(item.x1),
        y1: clampCoord(item.y1),
        x2: clampCoord(item.x2),
        y2: clampCoord(item.y2),
        color: hex6(item.color) ?? FALLBACK_COLOUR,
        width: markWidth(item.width),
        fill: item.fill === '' ? '' : (hex6(item.fill) ?? ''),
      })
  }
}

/* --------------------------------------------------------------- helpers -- */

/** The first id above every id on the board (and `nextId`, which may be further on). */
function freshId(doc: BoardDoc): number {
  let max = 0
  for (const it of doc.items) if (it.id > max) max = it.id
  const next = Number.isInteger(doc.nextId) && doc.nextId >= 1 ? doc.nextId : 1
  return Math.max(next, max + 1)
}

function maxGroup(doc: BoardDoc): number {
  let max = 0
  for (const it of doc.items) if (it.group > max) max = it.group
  return max
}

/** The items of `ids` that are on the board and free, in board order. */
function pick(doc: BoardDoc, ids: readonly number[]): BoardItem[] {
  const set = new Set(ids)
  return doc.items.filter((it) => set.has(it.id) && !it.locked)
}

/** The doc with `fn` applied to each free item of `ids`; the same doc when `fn` returns every item as it came. */
function edit(doc: BoardDoc, ids: readonly number[], fn: (item: BoardItem) => BoardItem): BoardDoc {
  const set = new Set(ids)
  let items: BoardItem[] | null = null
  for (let i = 0; i < doc.items.length; i++) {
    const it = doc.items[i]!
    if (!set.has(it.id) || it.locked) continue
    // An item that comes back equal in every field (a rectangle turned about its own centre) counts as untouched.
    const next = keepIfSame(it, fn(it))
    if (next !== it) {
      items ??= doc.items.slice()
      items[i] = next
    }
  }
  return items ? { ...doc, items } : doc
}

function append(doc: BoardDoc, made: BoardItem[], nextId: number): BoardDoc {
  return { ...doc, items: [...doc.items, ...made], nextId }
}

/** The corner and the point coordinates an item is made of (what has to stay inside the coordinate range). */
function eachCoordinate(item: BoardItem, fn: (x: number, y: number) => void): void {
  switch (item.kind) {
    case 'picture':
    case 'note':
      fn(item.x, item.y)
      return
    case 'stroke':
      for (let i = 0; i + 1 < item.points.length; i += 2) fn(item.points[i]!, item.points[i + 1]!)
      return
    default:
      fn(item.x1, item.y1)
      fn(item.x2, item.y2)
  }
}

function mapPoints(item: BoardItem, fn: (p: Vec2) => Vec2): BoardItem {
  switch (item.kind) {
    case 'picture':
    case 'note': {
      const p = fn({ x: item.x, y: item.y })
      return { ...item, x: p.x, y: p.y }
    }
    case 'stroke': {
      const points = item.points.slice()
      for (let i = 0; i + 1 < points.length; i += 2) {
        const p = fn({ x: points[i]!, y: points[i + 1]! })
        points[i] = p.x
        points[i + 1] = p.y
      }
      return { ...item, points }
    }
    default: {
      const a = fn({ x: item.x1, y: item.y1 })
      const b = fn({ x: item.x2, y: item.y2 })
      return { ...item, x1: a.x, y1: a.y, x2: b.x, y2: b.y }
    }
  }
}

/** `o` moved by `d`, never past the coordinate range when it started inside it (a sum can overshoot the limit by one ulp). */
function nudge(o: number, d: number): number {
  const n = o + d
  return n > L && o <= L ? L : n < -L && o >= -L ? -L : n
}

function translate(item: BoardItem, dx: number, dy: number): BoardItem {
  return mapPoints(item, (p) => ({ x: nudge(p.x, dx), y: nudge(p.y, dy) }))
}

/**
 * The move (dx, dy) held back so that no coordinate of `sel` goes past the coordinate range in the direction it travels (one offset for
 * the whole selection, so its shape is kept). Items already outside are not pulled in.
 */
function limitedMove(sel: readonly BoardItem[], dx: number, dy: number): Vec2 {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const it of sel) {
    eachCoordinate(it, (x, y) => {
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    })
  }
  if (x0 > x1) return { x: dx, y: dy }
  return {
    x: dx > 0 ? Math.min(dx, Math.max(0, L - x1)) : Math.max(dx, Math.min(0, -L - x0)),
    y: dy > 0 ? Math.min(dy, Math.max(0, L - y1)) : Math.max(dy, Math.min(0, -L - y0)),
  }
}

function markCentre(item: LineItem | RectItem | EllipseItem): Vec2 {
  return { x: (item.x1 + item.x2) / 2, y: (item.y1 + item.y2) / 2 }
}

/** Whether two rectangles share area. */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** A colour that reads on the board's background: near-black on a light one, white on a dark one. */
function inkFor(bg: string): string {
  const c = hex6(bg)
  if (!c) return FALLBACK_COLOUR
  const luma = (0.2126 * parseInt(c.slice(0, 2), 16) + 0.7152 * parseInt(c.slice(2, 4), 16) + 0.0722 * parseInt(c.slice(4, 6), 16)) / 255
  return luma > 0.5 ? '111111' : FALLBACK_COLOUR
}

/* ---------------------------------------------------------------- adding -- */

export interface NewPicture {
  path: string
  /** Size of the WHOLE picture in board units (cropped, the shown part is smaller). Out-of-range sizes are brought in, keeping the proportions. */
  w: number
  h: number
  /** Where the centre of the shown part goes; the view's centre when left out. */
  x?: number
  y?: number
  rotation?: number
  crop?: Crop
  flipH?: boolean
  flipV?: boolean
  gray?: boolean
  opacity?: number
  caption?: string
}

export interface NewNote {
  text?: string
  /** The note's centre; the view's centre when left out. */
  x?: number
  y?: number
  w?: number
  size?: number
  rotation?: number
  /** Text colour; defaults to one that reads on the board's background. */
  color?: string
  fill?: string
}

type Spec<T> = Omit<T, 'id' | 'group' | 'locked'>
export type NewMark = Spec<StrokeItem> | Spec<LineItem> | Spec<RectItem> | Spec<EllipseItem>

/** What adding returns: the new doc and the id of what was added; the same doc and null when the board is full. */
export interface AddResult {
  doc: BoardDoc
  id: number | null
}

function addOne(doc: BoardDoc, make: (id: number) => BoardItem): AddResult {
  if (doc.items.length >= BOARD_LIMITS.items) return { doc, id: null }
  const id = freshId(doc)
  return { doc: append(doc, [sanitizeItem(make(id))], id + 1), id }
}

/** Adds a picture on top of everything. At most BOARD_LIMITS.items items on a board: past that nothing is added and `id` is null. */
export function addPicture(doc: BoardDoc, spec: NewPicture): AddResult {
  return addOne(doc, (id) => ({
    kind: 'picture',
    id,
    group: 0,
    locked: false,
    path: spec.path,
    x: fin(spec.x ?? doc.view.x, doc.view.x),
    y: fin(spec.y ?? doc.view.y, doc.view.y),
    w: spec.w,
    h: spec.h,
    rotation: fin(spec.rotation ?? 0),
    crop: spec.crop ? { ...spec.crop } : { l: 0, t: 0, r: 1, b: 1 },
    flipH: spec.flipH ?? false,
    flipV: spec.flipV ?? false,
    gray: spec.gray ?? false,
    opacity: spec.opacity ?? 1,
    caption: cutText(cleanText(spec.caption ?? ''), BOARD_LIMITS.noteChars),
  }))
}

/** Adds a text note on top of everything. */
export function addNote(doc: BoardDoc, spec: NewNote = {}): AddResult {
  return addOne(doc, (id) => ({
    kind: 'note',
    id,
    group: 0,
    locked: false,
    text: cutText(cleanText(spec.text ?? ''), BOARD_LIMITS.noteChars),
    x: fin(spec.x ?? doc.view.x, doc.view.x),
    y: fin(spec.y ?? doc.view.y, doc.view.y),
    w: spec.w ?? NOTE_DEFAULTS.w,
    size: spec.size ?? NOTE_DEFAULTS.size,
    rotation: fin(spec.rotation ?? 0),
    color: hex6(spec.color) ?? inkFor(doc.bg),
    fill: spec.fill ?? '',
  }))
}

/** Adds a drawn mark (stroke, line, rectangle, ellipse) on top of everything. A stroke with no point is refused like a full board. */
export function addMark(doc: BoardDoc, mark: NewMark): AddResult {
  if (mark.kind === 'stroke' && mark.points.length < 2) return { doc, id: null }
  // A new stroke is held to what a user can draw; a longer one that came from a file keeps its points (cleanPoints' file ceiling).
  const own = mark.kind === 'stroke' ? { ...mark, points: mark.points.slice(0, 2 * BOARD_LIMITS.strokePoints) } : mark
  return addOne(doc, (id) => ({ ...own, id, group: 0, locked: false }) as BoardItem)
}

/**
 * Adds copies of `items` on top, each with a fresh id, shifted by `offset` (held back, for all of them together, where it would take a
 * coordinate past the range). Groups stay groups but become new ones (a copy is never welded to the original); a group of which only
 * one member is copied is not a group any more. All or nothing: when the copies would not fit under BOARD_LIMITS.items, the same doc
 * and no ids come back. Used by duplicate and paste.
 */
export function insertItems(doc: BoardDoc, items: readonly BoardItem[], offset: Vec2): { doc: BoardDoc; ids: number[] } {
  const src = items.filter((it) => !(it.kind === 'stroke' && it.points.length < 2))
  if (src.length === 0 || doc.items.length + src.length > BOARD_LIMITS.items) return { doc, ids: [] }
  // ONE offset for all the copies: clamped coordinate by coordinate, a copy near the edge would be squashed against it.
  const { x: dx, y: dy } = limitedMove(src, fin(offset.x), fin(offset.y))
  const members = new Map<number, number>()
  for (const it of src) if (it.group > 0) members.set(it.group, (members.get(it.group) ?? 0) + 1)
  const relabel = new Map<number, number>()
  let label = maxGroup(doc)
  let id = freshId(doc)
  const made: BoardItem[] = src.map((it) => {
    let group = 0
    if (it.group > 0 && (members.get(it.group) ?? 0) > 1) {
      if (!relabel.has(it.group)) relabel.set(it.group, ++label)
      group = relabel.get(it.group)!
    }
    const base: BoardItem = it.kind === 'picture' ? { ...it, crop: { ...it.crop } } : it
    return sanitizeItem(translate({ ...base, id: id++, group }, dx, dy))
  })
  return { doc: append(doc, made, id), ids: made.map((m) => m.id) }
}

/** Copies the free items of `ids` (locked ones are not copied) on top, shifted by `offset`; returns the new ids in board order. */
export function duplicateItems(doc: BoardDoc, ids: readonly number[], offset: Vec2): { doc: BoardDoc; ids: number[] } {
  return insertItems(doc, pick(doc, ids), offset)
}

/* ----------------------------------------------------------- transforming -- */

/** Moves the free items of `ids` by (dx, dy), no further than the coordinate limit allows. */
export function moveItems(doc: BoardDoc, ids: readonly number[], dx: number, dy: number): BoardDoc {
  if (fin(dx) === 0 && fin(dy) === 0) return doc
  const sel = pick(doc, ids)
  if (sel.length === 0) return doc
  // Only the direction of travel is held back: an item already outside is not pulled in.
  const { x: mx, y: my } = limitedMove(sel, fin(dx), fin(dy))
  if (mx === 0 && my === 0) return doc
  return edit(doc, ids, (it) => translate(it, mx, my))
}

/** The factor nearest to `want` that keeps pictures and notes within their size limits and every coordinate inside the range. */
function limitScale(sel: readonly BoardItem[], want: number, anchor: Vec2): number {
  let lo = 0
  let hi = Infinity
  const span = (value: number, min: number, max: number): void => {
    if (value > 0) {
      lo = Math.max(lo, min / value)
      hi = Math.min(hi, max / value)
    }
  }
  for (const it of sel) {
    if (it.kind === 'picture') {
      span(it.w, BOARD_LIMITS.pictureMin, BOARD_LIMITS.pictureMax)
      span(it.h, BOARD_LIMITS.pictureMin, BOARD_LIMITS.pictureMax)
    } else if (it.kind === 'note') {
      span(it.size, BOARD_ITEM_LIMITS.noteSize.min, BOARD_ITEM_LIMITS.noteSize.max)
      span(it.w, BOARD_ITEM_LIMITS.noteWidth.min, BOARD_ITEM_LIMITS.noteWidth.max)
    }
    eachCoordinate(it, (x, y) => {
      const dx = x - anchor.x
      const dy = y - anchor.y
      if (dx > 0) hi = Math.min(hi, (L - anchor.x) / dx)
      else if (dx < 0) hi = Math.min(hi, (L + anchor.x) / -dx)
      if (dy > 0) hi = Math.min(hi, (L - anchor.y) / dy)
      else if (dy < 0) hi = Math.min(hi, (L + anchor.y) / -dy)
    })
  }
  // Where the limits cannot all be met the upper one wins: nothing grows past its maximum.
  return Math.min(Math.max(want, lo), hi)
}

function scaledAbout(item: BoardItem, f: number, a: Vec2): BoardItem {
  const moved = mapPoints(item, (p) => ({ x: a.x + (p.x - a.x) * f, y: a.y + (p.y - a.y) * f }))
  switch (moved.kind) {
    case 'picture':
      return { ...moved, w: moved.w * f, h: moved.h * f }
    case 'note':
      return { ...moved, w: moved.w * f, size: moved.size * f }
    default:
      return { ...moved, width: moved.width * f }
  }
}

/**
 * Scales the free items of `ids` by `factor` about `anchor`: positions move toward or away from it; a picture's and a note's size and
 * a mark's points and line width scale with them. The factor is held to what keeps every picture between BOARD_LIMITS.pictureMin and
 * pictureMax (and notes within their limits), so the selection keeps its shape rather than part of it.
 */
export function scaleItems(doc: BoardDoc, ids: readonly number[], factor: number, anchor: Vec2): BoardDoc {
  if (!(factor > 0) || !Number.isFinite(factor) || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return doc
  const sel = pick(doc, ids)
  if (sel.length === 0) return doc
  const a = { x: clampCoord(anchor.x), y: clampCoord(anchor.y) }
  const f = limitScale(sel, factor, a)
  if (!(f > 0) || f === 1) return doc
  return edit(doc, ids, (it) => sanitizeItem(scaledAbout(it, f, a)))
}

/**
 * Resizes a picture to a whole-picture width of `newW` (the height follows, proportions kept) while the point `anchorLocal` of its
 * shown box stays where it is on the board. `anchorLocal` is in fractions of the shown box from its centre, in the box's own turned
 * frame: (-0.5, -0.5) the top-left corner, (0.5, 0.5) the bottom-right, (0, 0) the centre. The size is held within the picture limits.
 */
export function resizePicture(doc: BoardDoc, id: number, newW: number, anchorLocal: Vec2 = { x: 0, y: 0 }): BoardDoc {
  if (!(newW > 0) || !Number.isFinite(newW)) return doc
  const ax = fin(anchorLocal.x)
  const ay = fin(anchorLocal.y)
  return edit(doc, [id], (it) => {
    if (it.kind !== 'picture') return it
    const c = it.crop
    const at = rotatePoint({ x: it.x + ax * (c.r - c.l) * it.w, y: it.y + ay * (c.b - c.t) * it.h }, { x: it.x, y: it.y }, it.rotation)
    const fit = limitScale([it], newW / it.w, at)
    if (!(fit > 0) || fit === 1) return it
    return sanitizeItem({
      ...it,
      x: at.x + (it.x - at.x) * fit,
      y: at.y + (it.y - at.y) * fit,
      w: it.w * fit,
      h: it.h * fit,
    })
  })
}

/**
 * Changes a note's width while the edge `anchorLocalX` (-0.5 the left, 0.5 the right, 0 the middle, in fractions of the width) and the
 * top of the note stay where they are, whatever the text reflows to. For dragging a note's side handles.
 */
export function resizeNote(
  doc: BoardDoc,
  id: number,
  newW: number,
  anchorLocalX = 0,
  metrics: TextMetrics = estimateTextMetrics,
): BoardDoc {
  if (!(newW > 0) || !Number.isFinite(newW)) return doc
  const a = fin(anchorLocalX)
  return edit(doc, [id], (it) => {
    if (it.kind !== 'note') return it
    const w = clampTo(newW, BOARD_ITEM_LIMITS.noteWidth.min, BOARD_ITEM_LIMITS.noteWidth.max)
    if (w === it.w) return it
    const next = { ...it, w }
    const shift = rotatePoint({ x: a * (it.w - w), y: (noteBox(next, metrics).h - noteBox(it, metrics).h) / 2 }, { x: 0, y: 0 }, it.rotation)
    return sanitizeItem({ ...next, x: it.x + shift.x, y: it.y + shift.y })
  })
}

/**
 * Turns the free items of `ids` by `degrees` (clockwise) about `pivot`. A picture or note turns about its own centre by that angle
 * as its centre swings round the pivot; a stroke's or a line's points swing round it; a rectangle or ellipse stays upright and only its
 * centre swings. With `exactQuarter` and `degrees` an exact multiple of 90 (the Rotate 90 commands) a rectangle or ellipse is turned
 * too: its half-extents swap about its rotated centre, which is exact and still upright, so a frame drawn round a picture still
 * encloses it. A drag rotation does not pass it: with it a shape would jump between its two sizes at every quarter turn.
 */
export function rotateItems(doc: BoardDoc, ids: readonly number[], degrees: number, pivot: Vec2, opts: { exactQuarter?: boolean } = {}): BoardDoc {
  const deg = fin(degrees)
  const turn = normalizeAngle(deg)
  if (turn === 0 || !Number.isFinite(pivot.x) || !Number.isFinite(pivot.y)) return doc
  const quarter = opts.exactQuarter === true && turn % 90 === 0
  return edit(doc, ids, (it) => {
    if (it.kind === 'rect' || it.kind === 'ellipse') {
      const c = markCentre(it)
      const to = rotatePoint(c, pivot, deg)
      if (quarter && Math.abs(turn) === 90) {
        const hw = Math.abs(it.x2 - it.x1) / 2
        const hh = Math.abs(it.y2 - it.y1) / 2
        return sanitizeItem({ ...it, x1: to.x - hh, x2: to.x + hh, y1: to.y - hw, y2: to.y + hw })
      }
      return sanitizeItem(translate(it, to.x - c.x, to.y - c.y))
    }
    const turned = mapPoints(it, (p) => rotatePoint(p, pivot, deg))
    return sanitizeItem(turned.kind === 'picture' || turned.kind === 'note' ? { ...turned, rotation: normalizeAngle(turned.rotation + deg) } : turned)
  })
}

/**
 * Mirrors the free items of `ids`: 'h' left to right about the vertical line x = `about`, 'v' top to bottom about the horizontal line
 * y = `about`; with no `about`, the centre of the free selection's bounds. A picture's own pixels are mirrored too (flipH / flipV
 * toggle) and a turned picture's rotation becomes -r. A note is mirrored as a box but its text is not: its rotation becomes -r and it
 * still reads the right way up. Marks mirror their points.
 */
export function flipItems(
  doc: BoardDoc,
  ids: readonly number[],
  axis: 'h' | 'v',
  about?: number,
  metrics: TextMetrics = estimateTextMetrics,
): BoardDoc {
  const sel = pick(doc, ids)
  if (sel.length === 0) return doc
  let at = about !== undefined && Number.isFinite(about) ? about : undefined
  if (at === undefined) {
    const b = itemsBounds(sel, metrics)
    if (!b) return doc
    at = axis === 'h' ? b.x + b.w / 2 : b.y + b.h / 2
  }
  const mirror = at
  return edit(doc, ids, (it) => {
    const moved = mapPoints(it, (p) => (axis === 'h' ? { x: 2 * mirror - p.x, y: p.y } : { x: p.x, y: 2 * mirror - p.y }))
    switch (moved.kind) {
      case 'picture':
        return sanitizeItem({
          ...moved,
          flipH: axis === 'h' ? !moved.flipH : moved.flipH,
          flipV: axis === 'v' ? !moved.flipV : moved.flipV,
          rotation: normalizeAngle(-moved.rotation),
        })
      case 'note':
        return sanitizeItem({ ...moved, rotation: normalizeAngle(-moved.rotation) })
      default:
        return sanitizeItem(moved)
    }
  })
}

/* ------------------------------------------------------------------ crop -- */

/** The picture with another crop, moved so that the pixels still shown do not move on the board. */
function recropped(it: PictureItem, crop: Crop): PictureItem {
  const old = it.crop
  const dx = ((crop.l + crop.r) / 2 - (old.l + old.r) / 2) * it.w * (it.flipH ? -1 : 1)
  const dy = ((crop.t + crop.b) / 2 - (old.t + old.b) / 2) * it.h * (it.flipV ? -1 : 1)
  const shift = rotatePoint({ x: dx, y: dy }, { x: 0, y: 0 }, it.rotation)
  return { ...it, crop, x: it.x + shift.x, y: it.y + shift.y }
}

/**
 * Crops a picture to `crop` (fractions of the whole picture). What stays visible does not move on the board: the item's centre, which
 * is the centre of the shown part, moves by the difference. A crop that is not a number or leaves under 2% of an edge is refused (the
 * same doc); fractions outside 0..1 are brought in first.
 */
export function setCrop(doc: BoardDoc, id: number, crop: Crop): BoardDoc {
  const next = validCrop(crop)
  if (!next) return doc
  return edit(doc, [id], (it) => {
    if (it.kind !== 'picture') return it
    const o = it.crop
    if (o.l === next.l && o.t === next.t && o.r === next.r && o.b === next.b) return it
    return sanitizeItem(recropped(it, next))
  })
}

/** Shows the whole of each picture of `ids` again, without moving what was shown. */
export function resetCrop(doc: BoardDoc, ids: readonly number[]): BoardDoc {
  return edit(doc, ids, (it) => {
    const c = it.kind === 'picture' ? it.crop : null
    if (!c || (c.l === 0 && c.t === 0 && c.r === 1 && c.b === 1)) return it
    return sanitizeItem(recropped(it as PictureItem, { l: 0, t: 0, r: 1, b: 1 }))
  })
}

/* ------------------------------------------------------------ properties -- */

/** A change to properties. Each field applies to the kinds that have it and is ignored, with a bad value, by the others. */
export interface BoardPatch {
  // pictures
  gray?: boolean
  opacity?: number
  caption?: string
  flipH?: boolean
  flipV?: boolean
  /** A 3D model's view (`normaliseView` brings it in range); null puts it back to the first view. Ignored by a picture that is not a model. */
  turn?: ModelView | null
  /** A picture's whole-picture height. */
  h?: number
  // pictures and notes
  rotation?: number
  /** A picture's whole-picture width, a note's width. */
  w?: number
  // notes
  text?: string
  size?: number
  // notes and marks
  color?: string
  // notes, rectangles and ellipses: '' for none
  fill?: string
  // marks
  width?: number
  // lines
  arrow?: boolean
}

function patched(it: BoardItem, p: BoardPatch, metrics: TextMetrics): BoardItem {
  const num = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v)
  switch (it.kind) {
    case 'picture': {
      const next = { ...it }
      if (typeof p.gray === 'boolean') next.gray = p.gray
      if (num(p.opacity)) next.opacity = p.opacity
      if (typeof p.caption === 'string') next.caption = cutText(cleanText(p.caption), Math.max(BOARD_LIMITS.noteChars, it.caption.length))
      if (typeof p.flipH === 'boolean') next.flipH = p.flipH
      if (typeof p.flipV === 'boolean') next.flipV = p.flipV
      if (num(p.rotation)) next.rotation = p.rotation
      if (num(p.w) && p.w > 0) next.w = p.w
      if (num(p.h) && p.h > 0) next.h = p.h
      if (isModelPath(it.path)) {
        if (p.turn === null) delete next.turn
        else if (p.turn && num(p.turn.yaw) && num(p.turn.pitch)) next.turn = p.turn
      }
      return sanitizeItem(next)
    }
    case 'note': {
      const next = { ...it }
      // A text may not grow past what a user can make, but one a file held longer is not cut by an edit of something else.
      if (typeof p.text === 'string') next.text = cutText(cleanText(p.text), Math.max(BOARD_LIMITS.noteChars, it.text.length))
      if (num(p.size) && p.size > 0) next.size = p.size
      if (num(p.w) && p.w > 0) next.w = p.w
      if (num(p.rotation)) next.rotation = p.rotation
      const color = hex6(p.color)
      if (color) next.color = color
      if (p.fill === '') next.fill = ''
      else if (hex6(p.fill)) next.fill = hex6(p.fill)!
      const clean = sanitizeItem(next) as NoteItem
      if (clean === it) return it
      // The note keeps its top-left corner when its text, size or width change, as a text box does.
      const before = noteBox(it, metrics)
      const after = noteBox(clean, metrics)
      const shift = rotatePoint({ x: (after.w - before.w) / 2, y: (after.h - before.h) / 2 }, { x: 0, y: 0 }, it.rotation)
      return sanitizeItem({ ...clean, x: it.x + shift.x, y: it.y + shift.y })
    }
    default: {
      const next = { ...it } as MarkItem
      const color = hex6(p.color)
      if (color) next.color = color
      if (num(p.width)) next.width = p.width
      if ((next.kind === 'rect' || next.kind === 'ellipse') && (p.fill === '' || hex6(p.fill))) next.fill = p.fill === '' ? '' : hex6(p.fill)!
      if (next.kind === 'line' && typeof p.arrow === 'boolean') next.arrow = p.arrow
      return sanitizeItem(next)
    }
  }
}

/** Sets properties on the free items of `ids`. A note keeps its top-left corner when its text, size or width change. */
export function setProps(doc: BoardDoc, ids: readonly number[], patch: BoardPatch, metrics: TextMetrics = estimateTextMetrics): BoardDoc {
  return edit(doc, ids, (it) => patched(it, patch, metrics))
}

/* ---------------------------------------------------------------- groups -- */

/**
 * Every id of every group touched by `ids`, plus `ids` themselves, in board order, once each. Ids that are not on the board are
 * dropped. Locked members are included: this is what a click selects.
 */
export function expandGroups(doc: BoardDoc, ids: readonly number[]): number[] {
  const set = new Set(ids)
  const touched = new Set<number>()
  for (const it of doc.items) if (set.has(it.id) && it.group > 0) touched.add(it.group)
  const out: number[] = []
  for (const it of doc.items) if (set.has(it.id) || (it.group > 0 && touched.has(it.group))) out.push(it.id)
  return out
}

/**
 * Joins the free items of `ids`, and the free members of every group they touch, into one new group. Fewer than two items, or items
 * already exactly one group, change nothing. Locked members of a touched group stay in the old group.
 */
export function group(doc: BoardDoc, ids: readonly number[]): BoardDoc {
  const set = new Set(ids)
  const touched = new Set<number>()
  for (const it of doc.items) if (set.has(it.id) && !it.locked && it.group > 0) touched.add(it.group)
  const members = doc.items.filter((it) => !it.locked && (set.has(it.id) || (it.group > 0 && touched.has(it.group))))
  if (members.length < 2) return doc
  const first = members[0]!.group
  if (first > 0 && members.every((m) => m.group === first)) return doc
  const label = maxGroup(doc) + 1
  return edit(
    doc,
    members.map((m) => m.id),
    (it) => ({ ...it, group: label }),
  )
}

/** Dissolves every group touched by the free items of `ids` (its free members; locked ones keep their label). */
export function ungroup(doc: BoardDoc, ids: readonly number[]): BoardDoc {
  const set = new Set(ids)
  const touched = new Set<number>()
  for (const it of doc.items) if (set.has(it.id) && !it.locked && it.group > 0) touched.add(it.group)
  if (touched.size === 0) return doc
  return edit(
    doc,
    doc.items.filter((it) => it.group > 0 && touched.has(it.group)).map((it) => it.id),
    (it) => ({ ...it, group: 0 }),
  )
}

/* -------------------------------------------------------------- stacking -- */

/**
 * Moves the free items of `ids` in the drawing order (the array is back to front), keeping their order among themselves.
 * 'front' and 'back' go to the end and the start. 'forward' and 'backward' move each item past the next item it overlaps in bounds
 * (the neighbour that hides or is hidden by it), or one place when it overlaps nothing in that direction; a moved item never passes
 * another moved item.
 */
export function reorder(
  doc: BoardDoc,
  ids: readonly number[],
  where: 'front' | 'forward' | 'backward' | 'back',
  metrics: TextMetrics = estimateTextMetrics,
): BoardDoc {
  const set = new Set(ids)
  const moved = (it: BoardItem): boolean => set.has(it.id) && !it.locked
  const items = doc.items
  if (!items.some(moved)) return doc
  let out: BoardItem[]
  if (where === 'front') out = [...items.filter((it) => !moved(it)), ...items.filter(moved)]
  else if (where === 'back') out = [...items.filter(moved), ...items.filter((it) => !moved(it))]
  else {
    out = items.slice()
    const bounds = new Map<number, Rect>()
    const boundsOf = (it: BoardItem): Rect => {
      let b = bounds.get(it.id)
      if (!b) bounds.set(it.id, (b = itemBounds(it, metrics)))
      return b
    }
    const n = out.length
    if (where === 'forward') {
      for (let i = n - 2; i >= 0; i--) {
        if (!moved(out[i]!)) continue
        let limit = n
        for (let k = i + 1; k < n; k++) {
          if (moved(out[k]!)) {
            limit = k
            break
          }
        }
        if (i + 1 >= limit) continue
        let target = i + 1
        const me = boundsOf(out[i]!)
        for (let j = i + 1; j < limit; j++) {
          if (overlaps(me, boundsOf(out[j]!))) {
            target = j
            break
          }
        }
        out.splice(target, 0, out.splice(i, 1)[0]!)
      }
    } else {
      for (let i = 1; i < n; i++) {
        if (!moved(out[i]!)) continue
        let limit = -1
        for (let k = i - 1; k >= 0; k--) {
          if (moved(out[k]!)) {
            limit = k
            break
          }
        }
        if (i - 1 <= limit) continue
        let target = i - 1
        const me = boundsOf(out[i]!)
        for (let j = i - 1; j > limit; j--) {
          if (overlaps(me, boundsOf(out[j]!))) {
            target = j
            break
          }
        }
        out.splice(target, 0, out.splice(i, 1)[0]!)
      }
    }
  }
  return out.every((it, i) => it === items[i]) ? doc : { ...doc, items: out }
}

/* -------------------------------------------------------- removing, locking -- */

/** Removes the free items of `ids`. */
export function removeItems(doc: BoardDoc, ids: readonly number[]): BoardDoc {
  const set = new Set(ids)
  const items = doc.items.filter((it) => !(set.has(it.id) && !it.locked))
  return items.length === doc.items.length ? doc : { ...doc, items }
}

/** Locks or unlocks the items of `ids`, locked ones included: the one operation that does not skip them. */
export function lockItems(doc: BoardDoc, ids: readonly number[], locked: boolean): BoardDoc {
  const set = new Set(ids)
  let items: BoardItem[] | null = null
  for (let i = 0; i < doc.items.length; i++) {
    const it = doc.items[i]!
    if (!set.has(it.id) || it.locked === locked) continue
    items ??= doc.items.slice()
    items[i] = { ...it, locked }
  }
  return items ? { ...doc, items } : doc
}

/* ---------------------------------------------------------------- clamping - */

/**
 * The board with every number inside its range: coordinates within BOARD_LIMITS.coordinate, sizes, opacity, line widths, crops and the
 * view valid, colours as 6 hex digits, texts cut to their limits, a number gone bad (NaN, Infinity) replaced by a neutral one. A stroke
 * with no point is dropped. The same doc (and the same items) when it was already fine.
 */
export function clampDoc(doc: BoardDoc): BoardDoc {
  let changed = false
  const items: BoardItem[] = []
  for (const it of doc.items) {
    if (it.kind === 'stroke' && it.points.length < 2) {
      changed = true
      continue
    }
    const clean = sanitizeItem(it)
    if (clean !== it) changed = true
    items.push(clean)
  }
  let maxId = 0
  for (const it of items) if (it.id > maxId) maxId = it.id
  const nextId = Number.isInteger(doc.nextId) && doc.nextId > maxId ? doc.nextId : maxId + 1
  const next: BoardDoc = {
    ...doc,
    view: clampView(doc.view),
    bg: hex6(doc.bg) ?? '14161d',
    gray: doc.gray === true,
    smooth: doc.smooth === true,
    captions: doc.captions === true,
    grid: clampTo(fin(doc.grid), BOARD_ITEM_LIMITS.grid.min, BOARD_ITEM_LIMITS.grid.max),
    items: changed ? items : doc.items,
    nextId,
  }
  for (const k of Object.keys(next) as (keyof BoardDoc)[]) if (!sameValue(next[k], doc[k])) return next
  return doc
}

