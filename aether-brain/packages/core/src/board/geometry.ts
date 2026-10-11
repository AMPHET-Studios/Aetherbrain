/**
 * Board geometry: sizes, outlines and hit tests of items, the view (pan, zoom, fit), snapping while dragging and the handles of the
 * selection box. Pure functions of plain data (types.ts), no DOM; text is measured through the TextMetrics the caller supplies, so the
 * renderer, the hit tests and the tests all agree on how tall a note is. Design: docs/design/reference-board.md.
 *
 * Conventions. x grows right, y grows DOWN, angles are degrees clockwise on screen: rotating a point by `a` is the usual
 * (x cos a - y sin a, x sin a + y cos a). A picture or note has a box (its shown size) turned about its centre; the marks (stroke, line,
 * rect, ellipse) are made of points and are never turned: their box is their bounding box, grown by half the line width.
 */
import {
  BOARD_LIMITS,
  NOTE_PADDING_EM,
  type BoardDoc,
  type BoardItem,
  type BoardView,
  type LineItem,
  type MarkItem,
  type NoteItem,
  type Rect,
  type TextLayout,
  type TextMetrics,
  type Vec2,
} from './types'

type Quad = [Vec2, Vec2, Vec2, Vec2]

/** Board units two lines may differ by and still count as one guide (floating-point noise, not a tolerance for the user). */
const GUIDE_EPS = 1e-6

function fin(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback
}

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/* -------------------------------------------------------------- angles --- */

/** An angle in degrees as the equivalent in (-180, 180]. Not a number gives 0. */
export function normalizeAngle(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  if (degrees > -180 && degrees <= 180) return degrees === 0 ? 0 : degrees
  let r = degrees % 360
  if (r > 180) r -= 360
  else if (r <= -180) r += 360
  return r === 0 ? 0 : r
}

/** Sine and cosine of an angle in degrees, exact at quarter turns so four 90 degree turns give back the very same numbers. */
function sinCos(degrees: number): { sin: number; cos: number } {
  const a = ((fin(degrees) % 360) + 360) % 360
  if (a === 0) return { sin: 0, cos: 1 }
  if (a === 90) return { sin: 1, cos: 0 }
  if (a === 180) return { sin: 0, cos: -1 }
  if (a === 270) return { sin: -1, cos: 0 }
  const r = (a * Math.PI) / 180
  return { sin: Math.sin(r), cos: Math.cos(r) }
}

/** `p` turned by `degrees` (clockwise on screen) about `about`. */
export function rotatePoint(p: Vec2, about: Vec2, degrees: number): Vec2 {
  const { sin, cos } = sinCos(degrees)
  const dx = p.x - about.x
  const dy = p.y - about.y
  return { x: about.x + dx * cos - dy * sin, y: about.y + dx * sin + dy * cos }
}

/* --------------------------------------------------------------- boxes ---- */

/** The box of an item: its centre, its shown size and the angle it is turned by (marks: bounding box, angle 0). */
interface Box {
  cx: number
  cy: number
  w: number
  h: number
  rot: number
}

/** The part of a note's width its text may use: the note is `w` wide in all, with a margin on both sides. */
export function noteTextWidth(note: Pick<NoteItem, 'w' | 'size'>): number {
  const pad = NOTE_PADDING_EM * note.size
  return Math.max(note.w - 2 * pad, 1)
}

export interface NoteBox {
  /** The margin round the text, in board units. */
  pad: number
  /** The wrapped text. */
  layout: TextLayout
  /** The box the note shows: `w` by the text's height plus the margin twice. */
  w: number
  h: number
}

/** How a note lays out: the one place that knows the margin, so the renderer and the hit tests draw and test the same box. */
export function noteBox(note: NoteItem, metrics: TextMetrics): NoteBox {
  const pad = NOTE_PADDING_EM * note.size
  const layout = metrics.layout(note.text, note.size, noteTextWidth(note))
  return { pad, layout, w: Math.max(0, note.w), h: layout.height + 2 * pad }
}

/**
 * The three corners of an arrow line's head, as the renderer draws it (renderer.ts, drawMark): the tip at (x2, y2), a head 4 line
 * widths long (at most 0.8 of the line) and half as wide as long. Null for a line with no head or no length. (The renderer never draws a
 * line thinner than one device pixel; the width here is the item's own.)
 */
function arrowHead(item: LineItem): [Vec2, Vec2, Vec2] | null {
  if (!item.arrow) return null
  const dx = item.x2 - item.x1
  const dy = item.y2 - item.y1
  const len = Math.hypot(dx, dy)
  if (!(len > 1e-9)) return null
  const head = Math.min(4 * Math.max(0, fin(item.width)), len * 0.8)
  if (!(head > 0)) return null
  const ux = dx / len
  const uy = dy / len
  const bx = item.x2 - ux * head
  const by = item.y2 - uy * head
  return [
    { x: item.x2, y: item.y2 },
    { x: bx - uy * head * 0.5, y: by + ux * head * 0.5 },
    { x: bx + uy * head * 0.5, y: by - ux * head * 0.5 },
  ]
}

/** Whether `p` is within `reach` of the triangle `t` (inside it, or near one of its sides). */
function nearTriangle(t: readonly [Vec2, Vec2, Vec2], p: Vec2, reach: number): boolean {
  const side = (a: Vec2, b: Vec2): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
  const d1 = side(t[0], t[1])
  const d2 = side(t[1], t[2])
  const d3 = side(t[2], t[0])
  if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true
  const r2 = reach * reach
  for (let i = 0; i < 3; i++) {
    const a = t[i]!
    const b = t[(i + 1) % 3]!
    if (segmentDistSq(p.x, p.y, a.x, a.y, b.x, b.y) <= r2) return true
  }
  return false
}

/** The bounding box of a mark including half its line width, and an arrow's head. An empty stroke is a speck at the origin. */
function markExtent(item: MarkItem): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  if (item.kind === 'stroke') {
    const p = item.points
    for (let i = 0; i + 1 < p.length; i += 2) {
      const x = p[i]!
      const y = p[i + 1]!
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  } else {
    x0 = Math.min(item.x1, item.x2)
    x1 = Math.max(item.x1, item.x2)
    y0 = Math.min(item.y1, item.y2)
    y1 = Math.max(item.y1, item.y2)
  }
  if (x0 > x1) {
    x0 = x1 = 0
    y0 = y1 = 0
  }
  const hw = Math.max(0, fin(item.width)) / 2
  const box = { x: x0 - hw, y: y0 - hw, w: x1 - x0 + 2 * hw, h: y1 - y0 + 2 * hw }
  // The head of an arrow reaches further to the sides than the line is thick.
  const head = item.kind === 'line' ? arrowHead(item) : null
  if (!head) return box
  let hx0 = box.x
  let hy0 = box.y
  let hx1 = box.x + box.w
  let hy1 = box.y + box.h
  for (const c of head) {
    if (c.x < hx0) hx0 = c.x
    if (c.x > hx1) hx1 = c.x
    if (c.y < hy0) hy0 = c.y
    if (c.y > hy1) hy1 = c.y
  }
  return { x: hx0, y: hy0, w: hx1 - hx0, h: hy1 - hy0 }
}

function boxOf(item: BoardItem, metrics: TextMetrics): Box {
  switch (item.kind) {
    case 'picture': {
      const c = item.crop
      return { cx: item.x, cy: item.y, w: (c.r - c.l) * item.w, h: (c.b - c.t) * item.h, rot: item.rotation }
    }
    case 'note': {
      const n = noteBox(item, metrics)
      return { cx: item.x, cy: item.y, w: n.w, h: n.h, rot: item.rotation }
    }
    default: {
      const e = markExtent(item)
      return { cx: e.x + e.w / 2, cy: e.y + e.h / 2, w: e.w, h: e.h, rot: 0 }
    }
  }
}

function quadOf(b: Box): Quad {
  const { sin, cos } = sinCos(b.rot)
  const hw = b.w / 2
  const hh = b.h / 2
  const at = (lx: number, ly: number): Vec2 => ({ x: b.cx + lx * cos - ly * sin, y: b.cy + lx * sin + ly * cos })
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)]
}

function rectOfQuad(q: Quad): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of q) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.y < y0) y0 = p.y
    if (p.y > y1) y1 = p.y
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function isFiniteRect(r: Rect): boolean {
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h)
}

/** The size an item is shown at, unrotated: a picture's cropped part, a note's box, a mark's bounding box. */
export function itemSize(item: BoardItem, metrics: TextMetrics): { w: number; h: number } {
  const b = boxOf(item, metrics)
  return { w: b.w, h: b.h }
}

/** The centre of an item's box: a picture's or note's `x`, `y`, a mark's bounding box centre. */
export function itemCentre(item: BoardItem): Vec2 {
  switch (item.kind) {
    case 'picture':
    case 'note':
      return { x: item.x, y: item.y }
    default: {
      const e = markExtent(item)
      return { x: e.x + e.w / 2, y: e.y + e.h / 2 }
    }
  }
}

/** The four corners of an item's box after its rotation: top-left, top-right, bottom-right, bottom-left (as seen unrotated). */
export function itemQuad(item: BoardItem, metrics: TextMetrics): [Vec2, Vec2, Vec2, Vec2] {
  return quadOf(boxOf(item, metrics))
}

/** The axis-aligned rectangle round an item (its rotated box). */
export function itemBounds(item: BoardItem, metrics: TextMetrics): Rect {
  const b = boxOf(item, metrics)
  if (b.rot === 0) return { x: b.cx - b.w / 2, y: b.cy - b.h / 2, w: b.w, h: b.h }
  return rectOfQuad(quadOf(b))
}

/** The rectangle round all of `items`, or null when there are none. An item with a number gone bad is left out. */
export function itemsBounds(items: readonly BoardItem[], metrics: TextMetrics): Rect | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const it of items) {
    const r = itemBounds(it, metrics)
    if (!isFiniteRect(r)) continue
    if (r.x < x0) x0 = r.x
    if (r.y < y0) y0 = r.y
    if (r.x + r.w > x1) x1 = r.x + r.w
    if (r.y + r.h > y1) y1 = r.y + r.h
  }
  return x0 > x1 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The rectangle round the items of `ids` that are on the board (locked ones too), or null. */
export function selectionBounds(doc: BoardDoc, ids: readonly number[], metrics: TextMetrics): Rect | null {
  const set = new Set(ids)
  return itemsBounds(
    doc.items.filter((it) => set.has(it.id)),
    metrics,
  )
}

/* ---------------------------------------------------------- hit testing --- */

function segmentDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? clampTo(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0
  const qx = ax + t * dx - px
  const qy = ay + t * dy - py
  return qx * qx + qy * qy
}

/** Whether `p` is within `reach` of a polyline given as x0, y0, x1, y1 ... (one point: a dot; none: nothing). */
function nearPolyline(pts: readonly number[], p: Vec2, reach: number): boolean {
  const n = pts.length >> 1
  if (n === 0) return false
  const r2 = reach * reach
  if (n === 1) return segmentDistSq(p.x, p.y, pts[0]!, pts[1]!, pts[0]!, pts[1]!) <= r2
  for (let i = 0; i + 3 < pts.length; i += 2) {
    if (segmentDistSq(p.x, p.y, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!) <= r2) return true
  }
  return false
}

/** Signed distance from an offset (dx, dy) to the outline of the axis-aligned rectangle with half sizes a, b about the origin: negative inside. */
function rectSignedDistance(dx: number, dy: number, a: number, b: number): number {
  const ox = Math.abs(dx) - a
  const oy = Math.abs(dy) - b
  if (ox > 0 || oy > 0) return Math.hypot(Math.max(ox, 0), Math.max(oy, 0))
  return Math.max(ox, oy)
}

/** The root of Eberly's bisection for the closest point on an ellipse (see ellipseOutlineDistance). */
function ellipseRoot(r0: number, z0: number, z1: number, g: number): number {
  const n0 = r0 * z0
  let s0 = z1 - 1
  let s1 = g < 0 ? 0 : Math.hypot(n0, z1) - 1
  let s = 0
  for (let i = 0; i < 160; i++) {
    s = (s0 + s1) / 2
    if (s === s0 || s === s1) break
    const ratio0 = n0 / (s + r0)
    const ratio1 = z1 / (s + 1)
    const gg = ratio0 * ratio0 + ratio1 * ratio1 - 1
    if (gg > 0) s0 = s
    else if (gg < 0) s1 = s
    else break
  }
  return s
}

/** Exact distance from an offset (px, py) to the outline of the ellipse with half axes a, b about the origin (inside or out). */
function ellipseOutlineDistance(px: number, py: number, a: number, b: number): number {
  let e0 = a
  let e1 = b
  let y0 = Math.abs(px)
  let y1 = Math.abs(py)
  if (e0 < e1) {
    ;[e0, e1] = [e1, e0]
    ;[y0, y1] = [y1, y0]
  }
  // A flat ellipse is a segment along its long axis (a point when both are 0).
  if (e1 <= 1e-12) return Math.hypot(Math.max(y0 - e0, 0), y1)
  if (y1 > 0) {
    if (y0 > 0) {
      const z0 = y0 / e0
      const z1 = y1 / e1
      const g = z0 * z0 + z1 * z1 - 1
      if (g === 0) return 0
      const r0 = (e0 / e1) * (e0 / e1)
      const sbar = ellipseRoot(r0, z0, z1, g)
      return Math.hypot((r0 * y0) / (sbar + r0) - y0, y1 / (sbar + 1) - y1)
    }
    return Math.abs(y1 - e1)
  }
  const numer = e0 * y0
  const denom = e0 * e0 - e1 * e1
  if (numer < denom) {
    const t = numer / denom
    return Math.hypot(e0 * t - y0, e1 * Math.sqrt(1 - t * t))
  }
  return Math.abs(y0 - e0)
}

/**
 * Whether the point `p` is on `item`, grown by `tol` board units. Pictures and notes: inside the turned box. Strokes and lines: within
 * half the width of the path. Rectangles and ellipses: near the outline, or anywhere inside when they have a fill.
 */
export function pointInItem(item: BoardItem, p: Vec2, tol: number, metrics: TextMetrics): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false
  const t = Math.max(0, fin(tol))
  switch (item.kind) {
    case 'picture':
    case 'note': {
      const b = boxOf(item, metrics)
      const { sin, cos } = sinCos(-b.rot)
      const dx = p.x - b.cx
      const dy = p.y - b.cy
      const lx = dx * cos - dy * sin
      const ly = dx * sin + dy * cos
      return Math.abs(lx) <= b.w / 2 + t && Math.abs(ly) <= b.h / 2 + t
    }
    case 'stroke':
      return nearPolyline(item.points, p, Math.max(0, item.width) / 2 + t)
    case 'line': {
      if (nearPolyline([item.x1, item.y1, item.x2, item.y2], p, Math.max(0, item.width) / 2 + t)) return true
      const head = arrowHead(item)
      return head !== null && nearTriangle(head, p, t)
    }
    case 'rect': {
      const g = Math.max(0, item.width) / 2 + t
      const dx = p.x - (item.x1 + item.x2) / 2
      const dy = p.y - (item.y1 + item.y2) / 2
      const d = rectSignedDistance(dx, dy, Math.abs(item.x2 - item.x1) / 2, Math.abs(item.y2 - item.y1) / 2)
      return item.fill !== '' ? d <= g : Math.abs(d) <= g
    }
    case 'ellipse': {
      const g = Math.max(0, item.width) / 2 + t
      const a = Math.abs(item.x2 - item.x1) / 2
      const b = Math.abs(item.y2 - item.y1) / 2
      const dx = p.x - (item.x1 + item.x2) / 2
      const dy = p.y - (item.y1 + item.y2) / 2
      if (item.fill !== '' && a > 0 && b > 0 && (dx / a) * (dx / a) + (dy / b) * (dy / b) <= 1) return true
      return ellipseOutlineDistance(dx, dy, a, b) <= g
    }
  }
}

/** The topmost item at `p` (the last in the array), locked ones too, or null. `tol` is in board units: pass the pixels you allow over the zoom. */
export function hitTest(doc: BoardDoc, p: Vec2, tol: number, metrics: TextMetrics): BoardItem | null {
  for (let i = doc.items.length - 1; i >= 0; i--) {
    const it = doc.items[i]!
    if (pointInItem(it, p, tol, metrics)) return it
  }
  return null
}

/* ------------------------------------------------------ rectangle tests --- */

function normalizedRect(r: Rect): Rect {
  const w = fin(r.w)
  const h = fin(r.h)
  return { x: w < 0 ? r.x + w : r.x, y: h < 0 ? r.y + h : r.y, w: Math.abs(w), h: Math.abs(h) }
}

/** Whether a turned box and an upright rectangle share a point (separating axes: the two upright ones and the box's own two). */
function quadMeetsRect(q: Quad, r: Rect): boolean {
  const qb = rectOfQuad(q)
  if (qb.x > r.x + r.w || qb.x + qb.w < r.x || qb.y > r.y + r.h || qb.y + qb.h < r.y) return false
  const rc: Vec2[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ]
  for (let k = 0; k < 2; k++) {
    const a = q[k]!
    const b = q[k + 1]!
    const ax = b.x - a.x
    const ay = b.y - a.y
    let qmin = Infinity
    let qmax = -Infinity
    let rmin = Infinity
    let rmax = -Infinity
    for (const p of q) {
      const d = p.x * ax + p.y * ay
      if (d < qmin) qmin = d
      if (d > qmax) qmax = d
    }
    for (const p of rc) {
      const d = p.x * ax + p.y * ay
      if (d < rmin) rmin = d
      if (d > rmax) rmax = d
    }
    if (qmax < rmin || rmax < qmin) return false
  }
  return true
}

/** Whether the segment (ax, ay)-(bx, by) passes through the rectangle (Liang-Barsky). */
function segmentMeetsRect(ax: number, ay: number, bx: number, by: number, r: Rect): boolean {
  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dy = by - ay
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  return (
    clip(-dx, ax - r.x) && clip(dx, r.x + r.w - ax) && clip(-dy, ay - r.y) && clip(dy, r.y + r.h - ay)
  )
}

function pointRectDistance(px: number, py: number, r: Rect): number {
  return Math.hypot(Math.max(r.x - px, 0, px - (r.x + r.w)), Math.max(r.y - py, 0, py - (r.y + r.h)))
}

/** Distance from a segment to a rectangle (0 when they meet). */
function segmentRectDistance(ax: number, ay: number, bx: number, by: number, r: Rect): number {
  if (segmentMeetsRect(ax, ay, bx, by, r)) return 0
  let d = Math.min(pointRectDistance(ax, ay, r), pointRectDistance(bx, by, r))
  for (const [cx, cy] of [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ] as const) {
    d = Math.min(d, Math.sqrt(segmentDistSq(cx, cy, ax, ay, bx, by)))
  }
  return d
}

/** Whether a triangle and an upright rectangle share a point: a side crosses the rectangle, or the rectangle lies inside the triangle. */
function triangleMeetsRect(t: readonly [Vec2, Vec2, Vec2], r: Rect): boolean {
  for (let i = 0; i < 3; i++) {
    const a = t[i]!
    const b = t[(i + 1) % 3]!
    if (segmentMeetsRect(a.x, a.y, b.x, b.y, r)) return true
  }
  return nearTriangle(t, { x: r.x, y: r.y }, 0)
}

function polylineMeetsRect(pts: readonly number[], hw: number, r: Rect): boolean {
  const n = pts.length >> 1
  if (n === 0) return false
  if (n === 1) return pointRectDistance(pts[0]!, pts[1]!, r) <= hw
  for (let i = 0; i + 3 < pts.length; i += 2) {
    if (segmentRectDistance(pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!, r) <= hw) return true
  }
  return false
}

/** Whether an upright rectangle has a point inside (or on) the ellipse with half axes a, b about (cx, cy). */
function rectMeetsEllipse(r: Rect, cx: number, cy: number, a: number, b: number): boolean {
  const px = clampTo(cx, r.x, r.x + r.w) - cx
  const py = clampTo(cy, r.y, r.y + r.h) - cy
  const nx = a > 0 ? px / a : px === 0 ? 0 : Infinity
  const ny = b > 0 ? py / b : py === 0 ? 0 : Infinity
  return nx * nx + ny * ny <= 1
}

/** Distance from an upright rectangle to the ellipse with half axes a, b about (cx, cy); 0 when they meet. */
function rectEllipseGap(r: Rect, cx: number, cy: number, a: number, b: number): number {
  if (rectMeetsEllipse(r, cx, cy, a, b)) return 0
  // The rectangle is wholly outside, and the distance to a convex set is convex along each side: the nearest point is found by a ternary search.
  const c = rectCorners(r)
  let best = Infinity
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = c[i]!
    const [x1, y1] = c[(i + 1) % 4]!
    const f = (t: number): number => ellipseOutlineDistance(x0 + (x1 - x0) * t - cx, y0 + (y1 - y0) * t - cy, a, b)
    let lo = 0
    let hi = 1
    for (let k = 0; k < 60; k++) {
      const m1 = lo + (hi - lo) / 3
      const m2 = hi - (hi - lo) / 3
      if (f(m1) < f(m2)) hi = m2
      else lo = m1
    }
    best = Math.min(best, f((lo + hi) / 2))
  }
  return best
}

function rectCorners(r: Rect): [number, number][] {
  return [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ]
}

/** Whether an item has a point inside the upright rectangle `r`: a picture's box, the thickness of a stroke, the outline of an empty shape. */
function itemTouchesRect(item: BoardItem, r: Rect, metrics: TextMetrics): boolean {
  switch (item.kind) {
    case 'picture':
    case 'note':
      return quadMeetsRect(quadOf(boxOf(item, metrics)), r)
    case 'stroke':
      return polylineMeetsRect(item.points, Math.max(0, item.width) / 2, r)
    case 'line': {
      if (polylineMeetsRect([item.x1, item.y1, item.x2, item.y2], Math.max(0, item.width) / 2, r)) return true
      const head = arrowHead(item)
      return head !== null && triangleMeetsRect(head, r)
    }
    case 'rect':
    case 'ellipse': {
      // The outline is a band of half width hw about the path; a filled shape adds everything inside. The rectangle touches an empty
      // shape unless it lies wholly in the hollow, deeper than the band.
      const hw = Math.max(0, item.width) / 2
      const cx = (item.x1 + item.x2) / 2
      const cy = (item.y1 + item.y2) / 2
      const a = Math.abs(item.x2 - item.x1) / 2
      const b = Math.abs(item.y2 - item.y1) / 2
      const round = item.kind === 'ellipse'
      const gap = round
        ? rectEllipseGap(r, cx, cy, a, b)
        : Math.hypot(Math.max(0, cx - a - (r.x + r.w), r.x - (cx + a)), Math.max(0, cy - b - (r.y + r.h), r.y - (cy + b)))
      if (gap > hw) return false
      if (item.fill !== '') return true
      return !rectCorners(r).every(([x, y]) => {
        const dx = x - cx
        const dy = y - cy
        if (round) return a > 0 && b > 0 && (dx / a) * (dx / a) + (dy / b) * (dy / b) < 1 && ellipseOutlineDistance(dx, dy, a, b) > hw
        const ox = Math.abs(dx) - a
        const oy = Math.abs(dy) - b
        return ox <= 0 && oy <= 0 && -Math.max(ox, oy) > hw
      })
    }
  }
}

/**
 * Ids of the items a marquee takes, back to front, locked ones included (the caller expands groups). 'touch': any part of the item is
 * inside the rectangle (an empty shape only by its outline); 'contain': the item's whole bounds are. A rectangle dragged backwards
 * (negative w or h) is the same as one dragged forwards.
 */
export function itemsInRect(doc: BoardDoc, rect: Rect, mode: 'touch' | 'contain', metrics: TextMetrics): number[] {
  const r = normalizedRect(rect)
  if (!isFiniteRect(r)) return []
  const out: number[] = []
  for (const it of doc.items) {
    if (it.kind === 'stroke' && it.points.length < 2) continue
    const b = itemBounds(it, metrics)
    if (!isFiniteRect(b)) continue
    if (mode === 'contain') {
      if (b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h) out.push(it.id)
    } else if (b.x <= r.x + r.w && b.x + b.w >= r.x && b.y <= r.y + r.h && b.y + b.h >= r.y && itemTouchesRect(it, r, metrics)) {
      out.push(it.id)
    }
  }
  return out
}

/* ---------------------------------------------------------------- view ---- */

type Viewport = { w: number; h: number }

function clampZoom(z: number): number {
  return clampTo(fin(z, 1), BOARD_LIMITS.zoomMin, BOARD_LIMITS.zoomMax)
}

/** The board point under the canvas pixel `p` (the view's x, y is the board point at the middle of the canvas). */
export function screenToBoard(view: BoardView, viewport: Viewport, p: Vec2): Vec2 {
  return { x: view.x + (p.x - viewport.w / 2) / view.zoom, y: view.y + (p.y - viewport.h / 2) / view.zoom }
}

/** The canvas pixel a board point is drawn at (inverse of screenToBoard). */
export function boardToScreen(view: BoardView, viewport: Viewport, p: Vec2): Vec2 {
  return { x: (p.x - view.x) * view.zoom + viewport.w / 2, y: (p.y - view.y) * view.zoom + viewport.h / 2 }
}

/** Zooms by `factor` keeping the board point under the canvas pixel `anchor` where it is. Zoom stays within BOARD_LIMITS. */
export function zoomAt(view: BoardView, factor: number, anchor: Vec2, viewport: Viewport): BoardView {
  if (!(factor > 0) || !Number.isFinite(factor)) return view
  const zoom = clampZoom(view.zoom * factor)
  if (zoom === view.zoom) return view
  const b = screenToBoard(view, viewport, anchor)
  return { x: b.x - (anchor.x - viewport.w / 2) / zoom, y: b.y - (anchor.y - viewport.h / 2) / zoom, zoom }
}

/** Moves the view so the content follows a drag of (dx, dy) canvas pixels. */
export function panView(view: BoardView, dx: number, dy: number): BoardView {
  return clampView({ x: view.x - fin(dx) / view.zoom, y: view.y - fin(dy) / view.zoom, zoom: view.zoom })
}

/**
 * The view that shows `bounds` whole with `margin` canvas pixels round it, centred. No bounds, or bounds with no extent at all, give
 * zoom 1 centred on them (a view of one point has nothing to fit); a bound with extent in one direction only fits that direction.
 */
export function fitView(bounds: Rect | null, viewport: Viewport, margin: number): BoardView {
  if (!bounds || !isFiniteRect(bounds)) return { x: 0, y: 0, zoom: 1 }
  const x = bounds.x + bounds.w / 2
  const y = bounds.y + bounds.h / 2
  const m = Math.max(0, fin(margin))
  const availW = Math.max(viewport.w - 2 * m, 1)
  const availH = Math.max(viewport.h - 2 * m, 1)
  const ratios: number[] = []
  if (bounds.w > 1e-6) ratios.push(availW / bounds.w)
  if (bounds.h > 1e-6) ratios.push(availH / bounds.h)
  if (ratios.length === 0 || !(viewport.w > 0) || !(viewport.h > 0)) return clampView({ x, y, zoom: 1 })
  return clampView({ x, y, zoom: Math.min(...ratios) })
}

/** The view with its zoom inside BOARD_LIMITS and its centre inside the coordinate range; a number gone bad becomes 0 (zoom: 1). The same object when nothing changes. */
export function clampView(view: BoardView): BoardView {
  const L = BOARD_LIMITS.coordinate
  const x = clampTo(fin(view.x), -L, L)
  const y = clampTo(fin(view.y), -L, L)
  const zoom = clampZoom(view.zoom)
  return x === view.x && y === view.y && zoom === view.zoom ? view : { x, y, zoom }
}

/* -------------------------------------------------------------- snapping -- */

export interface SnapOptions {
  /** How near a line must be to catch the selection, in canvas pixels. */
  threshold: number
  /** The view's zoom, to turn the threshold into board units. */
  zoom: number
  /** Grid size in board units; 0 for none. Used on an axis where no item caught the selection. */
  grid: number
  metrics: TextMetrics
  /** Snap to the edges and centres of the other items. */
  edges: boolean
}

export interface SnapResult {
  /** The move to make instead of the one asked for. */
  delta: Vec2
  /** Board coordinates of the lines the selection snapped to: x of vertical lines, y of horizontal ones. */
  guides: { v: number[]; h: number[] }
}

/** The nearest target to any of `lines` within `reach`, as the shift that lands on it, and every target the shifted lines now meet. */
function snapAxis(lines: readonly number[], targets: readonly number[], reach: number): { shift: number; hits: number[] } | null {
  let best = Infinity
  let shift = 0
  for (const m of lines) {
    for (const t of targets) {
      const d = t - m
      if (Math.abs(d) <= reach && Math.abs(d) < best) {
        best = Math.abs(d)
        shift = d
      }
    }
  }
  if (best === Infinity) return null
  const hits: number[] = []
  for (const m of lines) {
    for (const t of targets) {
      if (Math.abs(t - (m + shift)) <= GUIDE_EPS && !hits.some((h) => Math.abs(h - t) <= GUIDE_EPS)) hits.push(t)
    }
  }
  return { shift, hits: hits.sort((p, q) => p - q) }
}

/**
 * Where a drag of the selection `movingIds` by `delta` should land: the selection's edges and centre jump to the edges and centres of
 * the other items when they are within `threshold` pixels, otherwise its top-left corner to the nearest grid line (when a grid is on).
 * Each axis is decided on its own. Locked items do not move, so they are not part of the selection's bounds. A grid is not a magnet:
 * with a grid on, the selection always ends on a grid line unless an item caught it first. Only item lines are returned as guides.
 */
export function snapMove(doc: BoardDoc, movingIds: readonly number[], delta: Vec2, opts: SnapOptions): SnapResult {
  const dx = fin(delta.x)
  const dy = fin(delta.y)
  const moving = new Set(movingIds)
  const mine: Rect[] = []
  const others: Rect[] = []
  for (const it of doc.items) {
    const isMoving = moving.has(it.id)
    if (isMoving && it.locked) continue
    if (!isMoving && !opts.edges) continue
    const r = itemBounds(it, opts.metrics)
    if (!isFiniteRect(r)) continue
    if (isMoving) mine.push(r)
    else others.push(r)
  }
  const sel = rectUnion(mine)
  if (!sel) return { delta: { x: dx, y: dy }, guides: { v: [], h: [] } }

  const reach = opts.threshold / (opts.zoom > 0 ? opts.zoom : 1)
  const xs = [sel.x + dx, sel.x + sel.w / 2 + dx, sel.x + sel.w + dx]
  const ys = [sel.y + dy, sel.y + sel.h / 2 + dy, sel.y + sel.h + dy]
  const hitX = opts.edges ? snapAxis(xs, others.flatMap((r) => [r.x, r.x + r.w / 2, r.x + r.w]), reach) : null
  const hitY = opts.edges ? snapAxis(ys, others.flatMap((r) => [r.y, r.y + r.h / 2, r.y + r.h]), reach) : null
  const grid = opts.grid > 0 && Number.isFinite(opts.grid) ? opts.grid : 0
  const gx = grid ? Math.round(xs[0]! / grid) * grid - xs[0]! : 0
  const gy = grid ? Math.round(ys[0]! / grid) * grid - ys[0]! : 0
  return {
    delta: { x: dx + (hitX ? hitX.shift : gx), y: dy + (hitY ? hitY.shift : gy) },
    guides: { v: hitX ? hitX.hits : [], h: hitY ? hitY.hits : [] },
  }
}

function rectUnion(rects: readonly Rect[]): Rect | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    if (r.x < x0) x0 = r.x
    if (r.y < y0) y0 = r.y
    if (r.x + r.w > x1) x1 = r.x + r.w
    if (r.y + r.h > y1) y1 = r.y + r.h
  }
  return x0 > x1 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/* --------------------------------------------------------------- handles -- */

/** Where on the selection box the pointer is (the names of HandleKind in the view's contract, without 'body' and the crop handles). */
export type BoxHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate'

/** The box drawn round a selection; the same shape as the view's SelectionBox. */
export interface HandleBox {
  /** Top-left, top-right, bottom-right, bottom-left of the box. */
  corners: [Vec2, Vec2, Vec2, Vec2]
  /** Where the rotate handle sits, or null when nothing selected can be turned. */
  rotateHandle: Vec2 | null
  /** Degrees: a single turned picture or note has a turned box, everything else an upright one. */
  rotation: number
}

/** Whether turning the selection does anything: some item is free and not a lone rectangle or ellipse (those stay upright). */
export function canRotateItems(items: readonly BoardItem[]): boolean {
  return items.some((it) => !it.locked && it.kind !== 'rect' && it.kind !== 'ellipse')
}

/**
 * The box round `items` with its rotate handle `rotateOffset` board units beyond the middle of the top edge (the view passes
 * its pixels over the zoom, so the handle keeps one distance on the screen). Null for no items.
 */
export function handlesFor(items: readonly BoardItem[], metrics: TextMetrics, rotateOffset: number): HandleBox | null {
  if (items.length === 0) return null
  let corners: [Vec2, Vec2, Vec2, Vec2]
  let rotation = 0
  const only = items.length === 1 ? items[0]! : null
  if (only && (only.kind === 'picture' || only.kind === 'note')) {
    corners = itemQuad(only, metrics)
    rotation = only.rotation
  } else {
    const b = itemsBounds(items, metrics)
    if (!b) return null
    corners = [
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
      { x: b.x, y: b.y + b.h },
    ]
  }
  let rotateHandle: Vec2 | null = null
  if (canRotateItems(items)) {
    const { sin, cos } = sinCos(rotation)
    const off = Math.max(0, fin(rotateOffset))
    // "Up" for a box turned by r is (sin r, -cos r).
    rotateHandle = {
      x: (corners[0].x + corners[1].x) / 2 + sin * off,
      y: (corners[0].y + corners[1].y) / 2 - cos * off,
    }
  }
  return { corners, rotateHandle, rotation }
}

/**
 * Which handle of the box `p` is on, within `tolBoard` board units of its centre, or null. When handles crowd (a tiny box) the nearest
 * wins; a tie goes to the rotate handle, then the corners, then the edges.
 */
export function hitHandle(
  box: Pick<HandleBox, 'corners' | 'rotateHandle'>,
  p: Vec2,
  tolBoard: number,
): BoxHandle | null {
  const [tl, tr, br, bl] = box.corners
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const spots: [BoxHandle, Vec2 | null][] = [
    ['rotate', box.rotateHandle],
    ['nw', tl],
    ['ne', tr],
    ['se', br],
    ['sw', bl],
    ['n', mid(tl, tr)],
    ['e', mid(tr, br)],
    ['s', mid(bl, br)],
    ['w', mid(tl, bl)],
  ]
  let best: BoxHandle | null = null
  let bestD = Infinity
  const tol = Math.max(0, fin(tolBoard))
  for (const [name, at] of spots) {
    if (!at) continue
    const d = Math.hypot(p.x - at.x, p.y - at.y)
    if (d <= tol && d < bestD) {
      best = name
      bestD = d
    }
  }
  return best
}
