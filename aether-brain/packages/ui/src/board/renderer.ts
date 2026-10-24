/**
 * The reference board's canvas renderer: one pure function that paints a board (`drawBoard`), the real-font text measure that the
 * notes wrap by (`canvasTextMetrics`) and the export of the board or a selection as one canvas (`exportBoard`, which reuses
 * `drawBoard` with the editing aids off). No DOM, no React: it takes a 2D context (a structural subset, so a recording fake runs it in
 * node), the document and what the view shows, and draws. Design: docs/design/reference-board.md ("Decisions" 3).
 *
 * Coordinates. The canvas is `viewport` CSS pixels wide and `dpr` times that in device pixels; `drawBoard` sets its own transforms
 * (it ignores whatever the context had). A picture, note or mark is drawn in the board's frame with the view's centre as origin, so a
 * far-off item loses no precision to a huge translation; everything the shell adds (outlines, handles, guides, the loupe) is drawn in
 * CSS pixels so it keeps one size at every zoom.
 */
import {
  NOTE_LINE_HEIGHT_EM,
  itemBounds,
  itemQuad,
  isModelPath,
  itemsBounds,
  luminance,
  noteBox,
  textColourOn,
  type BoardDoc,
  type BoardItem,
  type BoardView,
  type MarkItem,
  type NoteItem,
  type PictureItem,
  type Rect,
  type TextLayout,
  type TextMetrics,
  type Vec2,
} from '@aether/core'
import type { BoardUiState, ImageFailure, ImageSlot, ImageSource } from './api'
import type { BitmapLike } from './imageCache'
import type { ModelViewSource } from './modelViews'

/* ------------------------------------------------------------------ context -- */

/**
 * The part of the 2D canvas API the renderer uses. `CanvasRenderingContext2D` and `OffscreenCanvasRenderingContext2D` both fit (checked
 * below at compile time), and so does the recording fake of the tests.
 */
export interface Ctx2D {
  fillStyle: string | object
  strokeStyle: string | object
  lineWidth: number
  lineCap: 'butt' | 'round' | 'square'
  lineJoin: 'round' | 'bevel' | 'miter'
  globalAlpha: number
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: 'low' | 'medium' | 'high'
  /** Absent where the browser has no canvas filters: a grey picture is then drawn in colour. */
  filter?: string
  font: string
  textAlign: 'left' | 'right' | 'center' | 'start' | 'end'
  textBaseline: 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom'
  save(): void
  restore(): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void
  rect(x: number, y: number, w: number, h: number): void
  fill(fillRule?: 'nonzero' | 'evenodd'): void
  stroke(): void
  clip(fillRule?: 'nonzero' | 'evenodd'): void
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  setLineDash(segments: number[]): void
  drawImage(image: ImageBitmap, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void
  fillText(text: string, x: number, y: number, maxWidth?: number): void
  measureText(text: string): { width: number }
}

// A context that stops fitting the subset must fail here, not in the shell.
type Fits<T extends Ctx2D> = T
export type RealContexts = Fits<CanvasRenderingContext2D> | Fits<OffscreenCanvasRenderingContext2D>

/* ----------------------------------------------------------------- constants -- */

/** The size of a selection handle on the screen, in CSS pixels (the controller hit-tests with the same number). */
export const HANDLE_PX = 8
/** How far the rotate handle stands off the box's top edge, in CSS pixels (`handlesFor(items, metrics, ROTATE_STALK_PX / zoom)`). */
export const ROTATE_STALK_PX = 24

const KNOB_RADIUS = 5
const CULL_MARGIN = 16
/** A caption hangs this far below the picture's bounds (CSS px) and is at most this tall: the cull of a picture reaches that far down. */
const CAPTION_GAP = 4
const CAPTION_REACH = 48
/** A picture shorter than this on the screen shows no caption (it would be bigger than the picture). */
const CAPTION_MIN_SIDE = 48
/** Text smaller than this on the screen is drawn as bars: glyphs that small are not legible and cost the most to rasterise. */
const BARS_BELOW_PX = 3
const GRID_FADE_FROM = 2
const GRID_FADE_TO = 6
const DEFAULT_BG = '14161d'

const ACCENT = '#4da3ff'
const GUIDE_COLOUR = '#ff2bd6'
const FONT_FAMILY = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

/** The font of a note or caption at `size` pixels. */
export function noteFont(size: number): string {
  const s = Number.isFinite(size) && size > 0 ? Math.min(size, 100_000) : 0
  return `${+s.toFixed(3)}px ${FONT_FAMILY}`
}

/* -------------------------------------------------------------- draw arguments -- */

export interface DrawArgs {
  doc: BoardDoc
  view: BoardView
  /** The canvas size in CSS pixels. */
  viewport: { w: number; h: number }
  /** Device pixels per CSS pixel. */
  dpr: number
  state: Pick<BoardUiState, 'selection' | 'box' | 'marquee' | 'guides' | 'draft' | 'cropping' | 'editingNote' | 'sample' | 'moving'>
  images: ImageSource
  /** The 3D models on the board, drawn as they are turned (from their proxies): a model with no live view is drawn from `images`, as its still. */
  models?: ModelViewSource
  metrics: TextMetrics
  /** Handles, outlines, guides, marquee, loupe, grid: false for an export. Default true. */
  showUi?: boolean
  /** Whether the vault has lost this picture (it is then drawn as a missing picture and never asked of the cache). */
  missing?: (path: string) => boolean
  /** The clock for time-based effects. None is drawn yet: the renderer is a pure function of its arguments. */
  now?: number
  /**
   * What goes under the items: the board's colour ('fill', the default), a transparent canvas ('clear') or nothing ('keep': the export
   * draws a long board in several passes on one canvas).
   */
  backdrop?: 'fill' | 'clear' | 'keep'
}

/** A state with nothing selected, drawn or dragged (an export, a thumbnail). */
export const EMPTY_DRAW_STATE: DrawArgs['state'] = Object.freeze({
  selection: Object.freeze([]) as unknown as number[],
  box: null,
  marquee: null,
  guides: Object.freeze({ v: Object.freeze([]) as unknown as number[], h: Object.freeze([]) as unknown as number[] }),
  draft: null,
  cropping: null,
  editingNote: null,
  sample: null,
  moving: false,
})

/* ------------------------------------------------------------------- helpers -- */

const HEX6 = /^[0-9a-fA-F]{6}$/
const colours = new Map<string, string>()

/** A board colour (6 hex digits, no #) as CSS; anything else is `fallback`. Memoised: a board has a handful of colours. */
function colour(hex: string, fallback: string): string {
  let c = colours.get(hex)
  if (c === undefined) {
    c = '#' + (HEX6.test(hex) ? hex : fallback)
    if (colours.size > 256) colours.clear()
    colours.set(hex, c)
  }
  return c
}

function fin(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Sine and cosine of an angle in degrees, exact at quarter turns (as geometry.ts has them), so a turned picture's edges stay crisp. */
function sinCos(degrees: number): { sin: number; cos: number } {
  const a = ((fin(degrees, 0) % 360) + 360) % 360
  if (a === 0) return { sin: 0, cos: 1 }
  if (a === 90) return { sin: 1, cos: 0 }
  if (a === 180) return { sin: 0, cos: -1 }
  if (a === 270) return { sin: -1, cos: 0 }
  const r = (a * Math.PI) / 180
  return { sin: Math.sin(r), cos: Math.cos(r) }
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** A number gone bad makes setTransform a no-op (the item then lands wherever the last one was) and an endless box cull nothing: such items are not drawn. */
function isFiniteRect(b: Rect): boolean {
  return Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h)
}

/** Whether the board rectangle `b`, grown by `margin` CSS pixels (and `below` more at the bottom), meets the canvas. NaN is off screen. */
function onScreen(vx: number, vy: number, zoom: number, vw: number, vh: number, b: Rect, margin: number, below: number): boolean {
  const x0 = (b.x - vx) * zoom + vw / 2
  const y0 = (b.y - vy) * zoom + vh / 2
  return x0 + b.w * zoom >= -margin && x0 <= vw + margin && y0 + b.h * zoom + below >= -margin && y0 <= vh + margin
}

/** `text` cut to the longest start that fits `maxWidth` with an ellipsis, in the font the context has now. */
function fitText(ctx: Pick<Ctx2D, 'measureText'>, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  // Never end on half a surrogate pair.
  if (lo > 0) {
    const c = text.charCodeAt(lo - 1)
    if (c >= 0xd800 && c <= 0xdbff) lo--
  }
  return lo > 0 ? text.slice(0, lo) + '…' : '…'
}

function roundRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.min(Math.max(radius, 0), w / 2, h / 2)
  ctx.beginPath()
  if (!(r > 0)) {
    ctx.rect(x, y, w, h)
    return
  }
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

/* --------------------------------------------------------------------- frame -- */

/** Everything one `drawBoard` call shares between its parts (one object per frame). */
interface Frame {
  ctx: Ctx2D
  doc: BoardDoc
  /** The board point at the canvas centre. */
  vx: number
  vy: number
  zoom: number
  dpr: number
  vw: number
  vh: number
  /** Device pixels per board unit. */
  k: number
  /** The canvas centre in device pixels. */
  cx: number
  cy: number
  metrics: TextMetrics
  images: ImageSource
  models: ModelViewSource | undefined
  missing: ((path: string) => boolean) | undefined
  editing: number | null
  moving: boolean
  filterOk: boolean
}

function sxOf(f: Frame, x: number): number {
  return (x - f.vx) * f.zoom + f.vw / 2
}

function syOf(f: Frame, y: number): number {
  return (y - f.vy) * f.zoom + f.vh / 2
}

/**
 * Sets the transform, and says whether it took: a context ignores a matrix with a number that is not finite, and whatever is drawn
 * next would land where the last thing did. Callers that get false draw nothing.
 */
function setMatrix(ctx: Ctx2D, a: number, b: number, c: number, d: number, e: number, g: number): boolean {
  if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d) && Number.isFinite(e) && Number.isFinite(g))) return false
  ctx.setTransform(a, b, c, d, e, g)
  return true
}

/** Item space (origin at the item's centre, turned by the angle, mirrored by the signs) onto device pixels. */
function setItemTransform(f: Frame, x: number, y: number, sin: number, cos: number, fx: number, fy: number): boolean {
  const k = f.k
  return setMatrix(f.ctx, k * cos * fx, k * sin * fx, -k * sin * fy, k * cos * fy, k * (x - f.vx) + f.cx, k * (y - f.vy) + f.cy)
}

/** Board space relative to the view's centre onto device pixels: callers subtract `vx`, `vy` themselves (in doubles). */
function setViewTransform(f: Frame): void {
  f.ctx.setTransform(f.k, 0, 0, f.k, f.cx, f.cy)
}

/** CSS pixels onto device pixels. */
function setScreenTransform(f: Frame): void {
  f.ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0)
}

/* ---------------------------------------------------------------------- main -- */

export function drawBoard(ctx: Ctx2D, args: DrawArgs): void {
  const { doc, state } = args
  const vw = args.viewport.w
  const vh = args.viewport.h
  if (!(vw > 0 && vh > 0)) return
  const dpr = args.dpr > 0 && Number.isFinite(args.dpr) ? args.dpr : 1
  const zoom = args.view.zoom > 0 && Number.isFinite(args.view.zoom) ? args.view.zoom : 1
  const f: Frame = {
    ctx,
    doc,
    vx: fin(args.view.x, 0),
    vy: fin(args.view.y, 0),
    zoom,
    dpr,
    vw,
    vh,
    k: zoom * dpr,
    cx: (vw * dpr) / 2,
    cy: (vh * dpr) / 2,
    metrics: args.metrics,
    images: args.images,
    models: args.models,
    missing: args.missing,
    editing: state.editingNote,
    moving: state.moving,
    filterOk: 'filter' in ctx,
  }
  const showUi = args.showUi !== false
  // A view so far out that the device numbers overflow has nothing to show.
  if (!(Number.isFinite(f.k) && Number.isFinite(f.cx) && Number.isFinite(f.cy))) return

  ctx.save()
  try {
    // The context may have been left in any state by an earlier frame or user: start from the defaults this file relies on.
    setScreenTransform(f)
    ctx.globalAlpha = 1
    if (f.filterOk) ctx.filter = 'none'
    ctx.setLineDash([])
    ctx.lineCap = 'butt'
    ctx.lineJoin = 'miter'
    const backdrop = args.backdrop ?? 'fill'
    if (backdrop === 'fill') {
      ctx.fillStyle = colour(doc.bg, DEFAULT_BG)
      ctx.fillRect(0, 0, vw, vh)
    } else if (backdrop === 'clear') {
      ctx.clearRect(0, 0, vw, vh)
    }
    if (showUi) drawGrid(f)

    const items = doc.items
    for (let i = 0; i < items.length; i++) drawItem(f, items[i]!, true)

    if (showUi) drawOverlay(f, state)
  } finally {
    ctx.restore()
  }
}

/**
 * The pictures `drawBoard` would ask the cache for (distinct paths, in drawing order): the same cull, so the shell can tell the cache
 * which pictures are in view (`ImageCache.setVisible`) without a second opinion on what is visible.
 */
export function visiblePictures(doc: BoardDoc, view: BoardView, viewport: { w: number; h: number }, metrics: TextMetrics): string[] {
  const zoom = view.zoom > 0 && Number.isFinite(view.zoom) ? view.zoom : 1
  const vx = fin(view.x, 0)
  const vy = fin(view.y, 0)
  const seen = new Set<string>()
  const out: string[] = []
  for (const it of doc.items) {
    if (it.kind !== 'picture' || seen.has(it.path)) continue
    if (!onScreen(vx, vy, zoom, viewport.w, viewport.h, itemBounds(it, metrics), CULL_MARGIN, doc.captions ? CAPTION_REACH : 0)) continue
    seen.add(it.path)
    out.push(it.path)
  }
  return out
}

function drawItem(f: Frame, it: BoardItem, cull: boolean): void {
  const b = itemBounds(it, f.metrics)
  if (!isFiniteRect(b)) return
  if (cull && !onScreen(f.vx, f.vy, f.zoom, f.vw, f.vh, b, CULL_MARGIN, it.kind === 'picture' && f.doc.captions ? CAPTION_REACH : 0)) return
  switch (it.kind) {
    case 'picture':
      drawPicture(f, it, b)
      return
    case 'note':
      drawNote(f, it)
      return
    default:
      drawMark(f, it)
  }
}

/* ----------------------------------------------------------------------- grid -- */

function drawGrid(f: Frame): void {
  const g = f.doc.grid
  if (!(g > 0) || !Number.isFinite(g)) return
  const pitch = g * f.zoom
  // Finer than 6 px the lines turn into a haze, so they fade out and are gone at 2 px (which also bounds how many are drawn).
  const fade = clamp((pitch - GRID_FADE_FROM) / (GRID_FADE_TO - GRID_FADE_FROM), 0, 1)
  if (fade <= 0) return
  const ctx = f.ctx
  // Dark lines on a light board, light lines on a dark one.
  const lightBoard = luminance(f.doc.bg) > 0.5
  ctx.strokeStyle = lightBoard ? '#000000' : '#ffffff'
  ctx.globalAlpha = (lightBoard ? 0.12 : 0.09) * fade
  ctx.lineWidth = 1 / f.dpr
  ctx.beginPath()
  const half = 0.5 / f.dpr
  // At 2 px or more a line a pitch the canvas holds at most half its width in lines, which bounds both loops. The lines are counted by
  // their own small index: a view far out at a fine grid has no next number to count up to, and a loop that counts the lines' own
  // numbers would stand still on the first of them.
  const x0 = Math.ceil((f.vx - f.vw / 2 / f.zoom) / g)
  const nx = Math.floor((f.vx + f.vw / 2 / f.zoom) / g) - x0
  if (nx >= 0) {
    for (let j = 0; j <= nx; j++) {
      const x = Math.floor(sxOf(f, (x0 + j) * g) * f.dpr) / f.dpr + half
      ctx.moveTo(x, 0)
      ctx.lineTo(x, f.vh)
    }
  }
  const y0 = Math.ceil((f.vy - f.vh / 2 / f.zoom) / g)
  const ny = Math.floor((f.vy + f.vh / 2 / f.zoom) / g) - y0
  if (ny >= 0) {
    for (let j = 0; j <= ny; j++) {
      const y = Math.floor(syOf(f, (y0 + j) * g) * f.dpr) / f.dpr + half
      ctx.moveTo(0, y)
      ctx.lineTo(f.vw, y)
    }
  }
  ctx.stroke()
  ctx.globalAlpha = 1
}

/* ------------------------------------------------------------------- pictures -- */

function drawPicture(f: Frame, it: PictureItem, bounds: Rect): void {
  const c = it.crop
  const w = (c.r - c.l) * it.w
  const h = (c.b - c.t) * it.h
  if (!(w > 0 && h > 0)) return
  const ctx = f.ctx

  let slot: ImageSlot | null = null
  const gone = !!f.missing && f.missing(it.path)
  if (!gone) {
    // The cache holds the WHOLE picture whatever the crop shows, so the size it must be sharp at is the whole picture's. How big the
    // part that is SHOWN is goes with it: when the budget cannot give every picture what it wants, the biggest on the screen come first.
    slot = f.images.get(it.path, Math.max(it.w, it.h) * f.k, Math.max(w, h) * f.k)
  }
  // A 3D model that has its live view is drawn from that, turned as the item says; until it has one, its still (the cache's bitmap).
  const live = !gone && f.models && isModelPath(it.path) ? f.models.get(it, Math.max(it.w, it.h) * f.k) : null
  const bmp = live ? (live as unknown as ImageBitmap) : slot ? slot.bitmap : null
  if (!bmp || !(bmp.width > 0 && bmp.height > 0)) {
    // The vault says the file is gone; else the cache says why it could not be read; a picture with no slot at all is unreadable.
    drawPlaceholder(f, it, w, h, gone ? 'missing' : !slot || slot.failed ? (slot?.reason ?? 'unreadable') : null)
  } else {
    const { sin, cos } = sinCos(it.rotation)
    const gray = (it.gray || f.doc.gray) && f.filterOk
    ctx.save()
    try {
      if (setItemTransform(f, it.x, it.y, sin, cos, it.flipH ? -1 : 1, it.flipV ? -1 : 1)) {
        ctx.globalAlpha = clamp(fin(it.opacity, 1), 0, 1)
        if (gray) {
          // A canvas filter is applied over a layer as big as the clip, which is the whole canvas unless something smaller is set: 300
          // grey pictures took seconds a frame. The clip is the picture's own rectangle, outset by a device pixel so that the edge's
          // anti-aliasing is the picture's (an exact clip multiplies its own into it and leaves seams between pictures side by side).
          const u = 1 / f.k
          ctx.beginPath()
          ctx.rect(-w / 2 - u, -h / 2 - u, w + 2 * u, h + 2 * u)
          ctx.clip()
          ctx.filter = 'grayscale(1)'
        }
        ctx.imageSmoothingEnabled = f.doc.smooth
        // A pan or zoom in progress is redrawn every frame: the cheap filter will do until it stops.
        if (f.doc.smooth) ctx.imageSmoothingQuality = f.moving ? 'low' : 'high'
        // The crop is a share of the bitmap, whatever size the cache gave us (a smaller tier has the same shape).
        ctx.drawImage(bmp, c.l * bmp.width, c.t * bmp.height, (c.r - c.l) * bmp.width, (c.b - c.t) * bmp.height, -w / 2, -h / 2, w, h)
      }
    } catch {
      // A bitmap closed or broken under us: the cache is asked again on the next frame.
    } finally {
      ctx.restore()
    }
  }
  if (f.doc.captions) drawCaption(f, it, w, h, bounds)
}

/** What a placeholder says of a picture that cannot be shown. */
const FAILURE_LABEL: Record<ImageFailure, string> = { missing: 'file missing', 'too-large': 'too large to show', unreadable: "can't be read" }
/** A placeholder shorter than this on the screen (CSS px) draws no icon; no words below the next, no file name below the last. */
const PLACEHOLDER_ICON_PX = 28
const PLACEHOLDER_LABEL_PX = 60
const PLACEHOLDER_NAME_PX = 110

/**
 * The fill of a picture that is loading (`reason` null), or the dashed box of one that cannot be shown, which says why: a cross and
 * "file missing" for a file the vault has lost, the corners of a frame pushed outwards and "too large to show" for a picture with more
 * pixels than a board decodes, a warning sign and "can't be read" for anything else. Big enough, the file name sits at the bottom.
 */
function drawPlaceholder(f: Frame, it: PictureItem, w: number, h: number, shown: ImageFailure | null): void {
  const ctx = f.ctx
  // A reason this file does not know (a host from another build) is one the user can do nothing about either.
  const reason = shown === null ? null : Object.prototype.hasOwnProperty.call(FAILURE_LABEL, shown) ? shown : 'unreadable'
  const u = 1 / f.zoom
  const minSide = Math.min(w, h) * f.zoom
  const { sin, cos } = sinCos(it.rotation)
  const hw = w / 2
  const hh = h / 2
  ctx.save()
  if (!setItemTransform(f, it.x, it.y, sin, cos, 1, 1)) {
    ctx.restore()
    return
  }
  ctx.fillStyle = reason ? '#241a1f' : '#1b1e29'
  ctx.fillRect(-hw, -hh, w, h)
  if (!reason) {
    if (minSide >= 28) {
      // A frame with a sun and two hills, no bigger than 40 px.
      const g = Math.min(minSide * 0.4, 40) * u
      ctx.strokeStyle = 'rgba(255,255,255,0.2)'
      ctx.fillStyle = 'rgba(255,255,255,0.2)'
      ctx.lineWidth = Math.max(1.5 * u, 1 / f.k)
      ctx.lineJoin = 'round'
      ctx.strokeRect(-g * 0.6, -g * 0.5, g * 1.2, g)
      ctx.beginPath()
      ctx.moveTo(-g * 0.6, g * 0.5)
      ctx.lineTo(-g * 0.15, -g * 0.05)
      ctx.lineTo(g * 0.1, g * 0.25)
      ctx.lineTo(g * 0.25, g * 0.1)
      ctx.lineTo(g * 0.6, g * 0.5)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(-g * 0.3, -g * 0.22, g * 0.09, 0, Math.PI * 2)
      ctx.fill()
    }
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'
    ctx.lineWidth = Math.max(1.5 * u, 1 / f.k)
    ctx.setLineDash([6 * u, 4 * u])
    ctx.strokeRect(-hw, -hh, w, h)
    const named = minSide >= PLACEHOLDER_NAME_PX
    const labelled = minSide >= PLACEHOLDER_LABEL_PX
    // The icon and the words are one stack at the middle (a little above it when the file name takes the bottom).
    const g = Math.min(minSide * 0.14, 16) * u
    const middle = named ? -12 * u : 0
    const top = middle - (reason === 'missing' ? 18 * u : 2 * g + 24 * u) / 2
    const iconY = labelled ? top + g : 0
    if (reason === 'missing') {
      // The cross corner to corner is the icon.
      ctx.beginPath()
      ctx.moveTo(-hw, -hh)
      ctx.lineTo(hw, hh)
      ctx.moveTo(hw, -hh)
      ctx.lineTo(-hw, hh)
      ctx.stroke()
    } else if (minSide >= PLACEHOLDER_ICON_PX) {
      ctx.setLineDash([])
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      if (reason === 'too-large') {
        // The four corners of a frame, each an elbow: a picture bigger than the frame.
        const arm = g * 0.8
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            ctx.moveTo(sx * g - sx * arm, iconY + sy * g)
            ctx.lineTo(sx * g, iconY + sy * g)
            ctx.lineTo(sx * g, iconY + sy * g - sy * arm)
          }
        }
      } else {
        // A warning sign: a triangle with an exclamation mark.
        ctx.moveTo(0, iconY - g)
        ctx.lineTo(g * 1.1, iconY + g * 0.85)
        ctx.lineTo(-g * 1.1, iconY + g * 0.85)
        ctx.closePath()
        ctx.moveTo(0, iconY - g * 0.3)
        ctx.lineTo(0, iconY + g * 0.25)
        ctx.moveTo(0, iconY + g * 0.55)
        ctx.lineTo(0, iconY + g * 0.56)
      }
      ctx.stroke()
      ctx.lineCap = 'butt'
    }
    if (labelled) {
      ctx.setLineDash([])
      ctx.font = noteFont(12 * u)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const words = fitText(ctx, FAILURE_LABEL[reason], w - 16 * u)
      const tw = ctx.measureText(words).width
      // The words sit on a plate too, so that the cross does not run through them.
      const y = reason === 'missing' ? middle : top + 2 * g + 15 * u
      ctx.fillStyle = 'rgba(20,16,20,0.85)'
      ctx.fillRect(-tw / 2 - 4 * u, y - 9 * u, tw + 8 * u, 18 * u)
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.fillText(words, 0, y)
    }
    if (named) {
      ctx.setLineDash([])
      ctx.font = noteFont(12 * u)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const name = fitText(ctx, baseName(it.path), w - 16 * u)
      const tw = ctx.measureText(name).width
      // The name sits on a plate so the cross does not run through it.
      ctx.fillStyle = 'rgba(20,16,20,0.85)'
      ctx.fillRect(-tw / 2 - 4 * u, hh - 24 * u, tw + 8 * u, 18 * u)
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.fillText(name, 0, hh - 15 * u)
    }
  }
  ctx.restore()
}

/** A caption's font size and label height in CSS pixels, from how big the picture's shorter side is on the screen. */
function captionSize(minSidePx: number): { font: number; height: number } {
  const font = clamp(minSidePx * 0.06, 10, 22)
  return { font, height: font * 1.4 + 4 }
}

/** The caption (or, without one, the file name) in a small plate under the picture, upright whatever the picture's turn. */
function drawCaption(f: Frame, it: PictureItem, w: number, h: number, bounds: Rect): void {
  const minSide = Math.min(w, h) * f.zoom
  if (minSide < CAPTION_MIN_SIDE) return
  const text = it.caption !== '' ? it.caption : baseName(it.path)
  if (text === '') return
  const ctx = f.ctx
  const { font, height } = captionSize(minSide)
  const padX = font * 0.5
  const left = sxOf(f, bounds.x)
  const width = bounds.w * f.zoom
  const bottom = syOf(f, bounds.y + bounds.h)
  ctx.save()
  setScreenTransform(f)
  ctx.font = noteFont(font)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const label = fitText(ctx, text, Math.max(width - 2 * padX, 8))
  const lw = ctx.measureText(label).width + 2 * padX
  const x = left + width / 2 - lw / 2
  const y = bottom + CAPTION_GAP
  roundRectPath(ctx, x, y, lw, height, height / 2)
  ctx.fillStyle = 'rgba(10,12,20,0.72)'
  ctx.fill()
  ctx.fillStyle = '#e8eaf2'
  ctx.fillText(label, x + padX, y + height / 2)
  ctx.restore()
}

/* ---------------------------------------------------------------------- notes -- */

function drawNote(f: Frame, it: NoteItem): void {
  const nb = noteBox(it, f.metrics)
  const w = nb.w
  const h = nb.h
  if (!(w > 0 && h > 0)) return
  const ctx = f.ctx
  const { sin, cos } = sinCos(it.rotation)
  ctx.save()
  if (!setItemTransform(f, it.x, it.y, sin, cos, 1, 1)) {
    ctx.restore()
    return
  }
  if (it.fill !== '') {
    roundRectPath(ctx, -w / 2, -h / 2, w, h, nb.pad * 0.6)
    ctx.fillStyle = colour(it.fill, '202530')
    ctx.fill()
  }
  // The shell shows a text box over the note being edited: its text is not drawn twice.
  if (it.id !== f.editing && it.text !== '') drawNoteText(f, it, nb.layout, nb.pad, w, h, sin, cos)
  ctx.restore()
}

function drawNoteText(f: Frame, it: NoteItem, layout: TextLayout, pad: number, w: number, h: number, sin: number, cos: number): void {
  const ctx = f.ctx
  const lines = layout.lines
  const lineH = it.size * NOTE_LINE_HEIGHT_EM
  if (!(lineH > 0) || lines.length === 0) return
  const top = -h / 2 + pad
  const left = -w / 2 + pad

  // Only the lines that meet the canvas: where the canvas corners fall in the note's own frame says which rows those are.
  let first = 0
  let last = lines.length - 1
  if (lines.length > 24) {
    const e = f.k * (it.x - f.vx) + f.cx
    const g = f.k * (it.y - f.vy) + f.cy
    let lo = Infinity
    let hi = -Infinity
    for (let corner = 0; corner < 4; corner++) {
      const X = corner & 1 ? f.vw * f.dpr : 0
      const Y = corner & 2 ? f.vh * f.dpr : 0
      const ly = (-sin * (X - e) + cos * (Y - g)) / f.k
      if (ly < lo) lo = ly
      if (ly > hi) hi = ly
    }
    first = Math.max(0, Math.floor((lo - top) / lineH) - 1)
    last = Math.min(lines.length - 1, Math.ceil((hi - top) / lineH) + 1)
  }

  ctx.fillStyle = colour(it.color, 'ffffff')
  if (it.size * f.zoom < BARS_BELOW_PX) {
    // Too small to read: a bar per line, as long as the line is.
    let widest = 1
    for (let i = first; i <= last; i++) widest = Math.max(widest, lines[i]!.length)
    ctx.globalAlpha = 0.55
    for (let i = first; i <= last; i++) {
      const n = lines[i]!.length
      if (n === 0) continue
      ctx.fillRect(left, top + (i + 0.5) * lineH - it.size * 0.18, (layout.width * n) / widest, it.size * 0.36)
    }
    return
  }
  ctx.font = noteFont(it.size)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (let i = first; i <= last; i++) {
    const line = lines[i]!
    if (line !== '') ctx.fillText(line, left, top + (i + 0.5) * lineH)
  }
}

/* ---------------------------------------------------------------------- marks -- */

/** Scratch for a stroke's thinned points: reused so a frame allocates nothing per stroke. */
const scratch: number[] = []

function drawMark(f: Frame, it: MarkItem): void {
  const ctx = f.ctx
  const vx = f.vx
  const vy = f.vy
  // Widths follow the zoom, but a line never gets thinner than one device pixel.
  const lw = Math.max(Number.isFinite(it.width) && it.width > 0 ? it.width : 0, 1 / f.k)
  ctx.save()
  setViewTransform(f)
  ctx.lineWidth = lw
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = colour(it.color, 'ffffff')
  switch (it.kind) {
    case 'stroke': {
      const p = it.points
      // Points closer than half a device pixel to the last kept one change nothing on the screen; the first and last always stay.
      const minD2 = (0.5 / f.k) ** 2
      scratch.length = 0
      for (let i = 0; i + 1 < p.length; i += 2) {
        const x = p[i]! - vx
        const y = p[i + 1]! - vy
        const n = scratch.length
        const last = i + 3 >= p.length
        if (n === 0 || last || (x - scratch[n - 2]!) ** 2 + (y - scratch[n - 1]!) ** 2 >= minD2) scratch.push(x, y)
      }
      const n = scratch.length >> 1
      if (n === 0) break
      if (n === 1) {
        // A tap with the pen: a dot as wide as the line.
        ctx.fillStyle = colour(it.color, 'ffffff')
        ctx.beginPath()
        ctx.arc(scratch[0]!, scratch[1]!, lw / 2, 0, Math.PI * 2)
        ctx.fill()
        break
      }
      // Smoothed through the midpoints of the segments, so a hand-drawn line has no corners.
      ctx.beginPath()
      ctx.moveTo(scratch[0]!, scratch[1]!)
      for (let i = 1; i < n - 1; i++) {
        const cxp = scratch[2 * i]!
        const cyp = scratch[2 * i + 1]!
        ctx.quadraticCurveTo(cxp, cyp, (cxp + scratch[2 * i + 2]!) / 2, (cyp + scratch[2 * i + 3]!) / 2)
      }
      ctx.lineTo(scratch[2 * n - 2]!, scratch[2 * n - 1]!)
      ctx.stroke()
      break
    }
    case 'line': {
      const x1 = it.x1 - vx
      const y1 = it.y1 - vy
      const x2 = it.x2 - vx
      const y2 = it.y2 - vy
      const dx = x2 - x1
      const dy = y2 - y1
      const len = Math.hypot(dx, dy)
      if (!(len > 1e-9)) {
        ctx.fillStyle = colour(it.color, 'ffffff')
        ctx.beginPath()
        ctx.arc(x1, y1, lw / 2, 0, Math.PI * 2)
        ctx.fill()
        break
      }
      if (!it.arrow) {
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
        break
      }
      // The head grows with the line's width; on a short line it is held to most of its length so the shaft still shows.
      const head = Math.min(4 * lw, len * 0.8)
      const ux = dx / len
      const uy = dy / len
      const bx = x2 - ux * head
      const by = y2 - uy * head
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2 - ux * head * 0.7, y2 - uy * head * 0.7)
      ctx.stroke()
      ctx.fillStyle = colour(it.color, 'ffffff')
      ctx.beginPath()
      ctx.moveTo(x2, y2)
      ctx.lineTo(bx - uy * head * 0.5, by + ux * head * 0.5)
      ctx.lineTo(bx + uy * head * 0.5, by - ux * head * 0.5)
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'rect': {
      const x = Math.min(it.x1, it.x2) - vx
      const y = Math.min(it.y1, it.y2) - vy
      const w = Math.abs(it.x2 - it.x1)
      const h = Math.abs(it.y2 - it.y1)
      if (it.fill !== '') {
        ctx.fillStyle = colour(it.fill, '202530')
        ctx.fillRect(x, y, w, h)
      }
      ctx.lineJoin = 'miter'
      ctx.strokeRect(x, y, w, h)
      break
    }
    case 'ellipse': {
      const rx = Math.abs(it.x2 - it.x1) / 2
      const ry = Math.abs(it.y2 - it.y1) / 2
      ctx.beginPath()
      ctx.ellipse((it.x1 + it.x2) / 2 - vx, (it.y1 + it.y2) / 2 - vy, rx, ry, 0, 0, Math.PI * 2)
      if (it.fill !== '') {
        ctx.fillStyle = colour(it.fill, '202530')
        ctx.fill()
      }
      ctx.stroke()
      break
    }
  }
  ctx.restore()
}

/* -------------------------------------------------------------------- overlay -- */

/** A board point as a CSS pixel point. */
function toScreen(f: Frame, x: number, y: number): Vec2 {
  return { x: sxOf(f, x), y: syOf(f, y) }
}

function drawOverlay(f: Frame, state: DrawArgs['state']): void {
  const ctx = f.ctx
  const items = f.doc.items
  setScreenTransform(f)
  ctx.lineJoin = 'miter'
  ctx.lineCap = 'butt'

  if (state.draft) drawItem(f, state.draft, false)

  // Outlines of the selection: one path, one stroke.
  if (state.selection.length > 0) {
    const selected = new Set(state.selection)
    setScreenTransform(f)
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1
    ctx.beginPath()
    let outlined = false
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!
      if (!selected.has(it.id) || it.id === state.cropping) continue
      const b = itemBounds(it, f.metrics)
      if (!onScreen(f.vx, f.vy, f.zoom, f.vw, f.vh, b, CULL_MARGIN, 0)) continue
      outlined = true
      if (it.kind === 'picture' || it.kind === 'note') {
        const q = itemQuad(it, f.metrics)
        for (let j = 0; j < 4; j++) {
          const p = q[j]!
          const x = sxOf(f, p.x)
          const y = syOf(f, p.y)
          if (j === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.closePath()
      } else {
        ctx.rect(sxOf(f, b.x), syOf(f, b.y), b.w * f.zoom, b.h * f.zoom)
      }
    }
    if (outlined) ctx.stroke()
  }

  if (state.cropping !== null) drawCropOverlay(f, state.cropping)
  if (state.box) drawBox(f, state.box)
  drawGuides(f, state.guides)
  if (state.marquee) drawMarquee(f, state.marquee)
  if (state.sample) drawLoupe(f, state.sample)
}

function drawBox(f: Frame, box: NonNullable<DrawArgs['state']['box']>): void {
  const ctx = f.ctx
  const c = box.corners.map((p) => toScreen(f, p.x, p.y))
  const [a, b, d, e] = c as [Vec2, Vec2, Vec2, Vec2]
  if (![a, b, d, e].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return
  setScreenTransform(f)
  ctx.strokeStyle = ACCENT
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.lineTo(d.x, d.y)
  ctx.lineTo(e.x, e.y)
  ctx.closePath()
  ctx.stroke()

  const { sin, cos } = sinCos(box.rotation)
  const mid = (p: Vec2, q: Vec2): Vec2 => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })
  const topMid = mid(a, b)
  if (box.rotateHandle) {
    const r = toScreen(f, box.rotateHandle.x, box.rotateHandle.y)
    ctx.beginPath()
    ctx.moveTo(topMid.x, topMid.y)
    ctx.lineTo(r.x, r.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(r.x, r.y, KNOB_RADIUS, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.stroke()
  }
  // Squares as big as HANDLE_PX on the screen at every zoom, turned with the box.
  const spots = [a, b, d, e, topMid, mid(b, d), mid(e, d), mid(a, e)]
  ctx.fillStyle = '#ffffff'
  const dpr = f.dpr
  const half = HANDLE_PX / 2
  for (let i = 0; i < spots.length; i++) {
    const p = spots[i]!
    if (!setMatrix(ctx, dpr * cos, dpr * sin, -dpr * sin, dpr * cos, dpr * p.x, dpr * p.y)) continue
    ctx.fillRect(-half, -half, HANDLE_PX, HANDLE_PX)
    ctx.strokeRect(-half + 0.5, -half + 0.5, HANDLE_PX - 1, HANDLE_PX - 1)
  }
  setScreenTransform(f)
}

/**
 * The picture being cropped shows all of itself: the part outside the crop is drawn dimmed, so an edge can be dragged back out over
 * it. The crop rectangle is the picture's own box, with thirds guides and crop marks at its corners and edges.
 */
function drawCropOverlay(f: Frame, id: number): void {
  let it: PictureItem | null = null
  for (let i = 0; i < f.doc.items.length; i++) {
    const cand = f.doc.items[i]!
    if (cand.id === id) {
      it = cand.kind === 'picture' ? cand : null
      break
    }
  }
  if (!it || !isFiniteRect(itemBounds(it, f.metrics))) return
  const ctx = f.ctx
  const c = it.crop
  const cw = (c.r - c.l) * it.w
  const ch = (c.b - c.t) * it.h
  if (!(cw > 0 && ch > 0)) return

  // The whole picture in the item's frame: the shown part is centred on the origin, the rest hangs off it.
  const slot = f.missing && f.missing(it.path) ? null : f.images.get(it.path, Math.max(it.w, it.h) * f.k)
  const bmp = slot ? slot.bitmap : null
  const left = -((c.l + c.r) / 2) * it.w
  const top = -((c.t + c.b) / 2) * it.h
  const { sin, cos } = sinCos(it.rotation)
  let placed = false
  ctx.save()
  try {
    placed = setItemTransform(f, it.x, it.y, sin, cos, it.flipH ? -1 : 1, it.flipV ? -1 : 1)
    if (placed) {
      ctx.beginPath()
      ctx.rect(left, top, it.w, it.h)
      ctx.rect(-cw / 2, -ch / 2, cw, ch)
      ctx.clip('evenodd')
      if (bmp && bmp.width > 0 && bmp.height > 0) {
        ctx.imageSmoothingEnabled = f.doc.smooth
        ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, left, top, it.w, it.h)
      }
      ctx.fillStyle = 'rgba(8,10,18,0.62)'
      ctx.fillRect(left, top, it.w, it.h)
    }
  } catch {
    // A bitmap closed under us: the dimming stays, the next frame asks again.
  } finally {
    ctx.restore()
  }
  if (!placed) return

  const q = itemQuad(it, f.metrics).map((p) => toScreen(f, p.x, p.y)) as [Vec2, Vec2, Vec2, Vec2]
  setScreenTransform(f)
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'miter'
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(q[0].x, q[0].y)
  ctx.lineTo(q[1].x, q[1].y)
  ctx.lineTo(q[2].x, q[2].y)
  ctx.lineTo(q[3].x, q[3].y)
  ctx.closePath()
  ctx.stroke()
  // Thirds.
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'
  ctx.beginPath()
  for (const t of [1 / 3, 2 / 3]) {
    ctx.moveTo(q[0].x + (q[1].x - q[0].x) * t, q[0].y + (q[1].y - q[0].y) * t)
    ctx.lineTo(q[3].x + (q[2].x - q[3].x) * t, q[3].y + (q[2].y - q[3].y) * t)
    ctx.moveTo(q[0].x + (q[3].x - q[0].x) * t, q[0].y + (q[3].y - q[0].y) * t)
    ctx.lineTo(q[1].x + (q[2].x - q[1].x) * t, q[1].y + (q[2].y - q[1].y) * t)
  }
  ctx.stroke()
  // Crop marks: an L at each corner and a bar on each edge, as long as the edge lets them be.
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 3
  ctx.beginPath()
  for (let i = 0; i < 4; i++) {
    const p = q[i]!
    const next = q[(i + 1) % 4]!
    const prev = q[(i + 3) % 4]!
    const arm = (to: Vec2): void => {
      const len = Math.hypot(to.x - p.x, to.y - p.y)
      if (!(len > 0)) return
      const l = Math.min(14, len / 3) / len
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(p.x + (to.x - p.x) * l, p.y + (to.y - p.y) * l)
    }
    arm(next)
    arm(prev)
    const len = Math.hypot(next.x - p.x, next.y - p.y)
    if (len > 0) {
      const l = Math.min(9, len / 6) / len
      const mx = (p.x + next.x) / 2
      const my = (p.y + next.y) / 2
      ctx.moveTo(mx - (next.x - p.x) * l, my - (next.y - p.y) * l)
      ctx.lineTo(mx + (next.x - p.x) * l, my + (next.y - p.y) * l)
    }
  }
  ctx.stroke()
}

function drawGuides(f: Frame, guides: DrawArgs['state']['guides']): void {
  if (guides.v.length === 0 && guides.h.length === 0) return
  const ctx = f.ctx
  const dpr = f.dpr
  setScreenTransform(f)
  ctx.strokeStyle = GUIDE_COLOUR
  ctx.lineWidth = 1 / dpr
  ctx.beginPath()
  for (let i = 0; i < guides.v.length; i++) {
    const x = (Math.floor(sxOf(f, guides.v[i]!) * dpr) + 0.5) / dpr
    if (!Number.isFinite(x)) continue
    ctx.moveTo(x, 0)
    ctx.lineTo(x, f.vh)
  }
  for (let i = 0; i < guides.h.length; i++) {
    const y = (Math.floor(syOf(f, guides.h[i]!) * dpr) + 0.5) / dpr
    if (!Number.isFinite(y)) continue
    ctx.moveTo(0, y)
    ctx.lineTo(f.vw, y)
  }
  ctx.stroke()
}

function drawMarquee(f: Frame, m: Rect): void {
  const ctx = f.ctx
  const x0 = sxOf(f, Math.min(m.x, m.x + m.w))
  const y0 = syOf(f, Math.min(m.y, m.y + m.h))
  const w = Math.abs(m.w) * f.zoom
  const h = Math.abs(m.h) * f.zoom
  if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(w) && Number.isFinite(h))) return
  setScreenTransform(f)
  ctx.fillStyle = 'rgba(77,163,255,0.14)'
  ctx.fillRect(x0, y0, w, h)
  ctx.strokeStyle = ACCENT
  ctx.lineWidth = 1
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(w - 1, 0), Math.max(h - 1, 0))
}

/** The sampler: a ring of the colour under the pointer (the pointer's own pixel shows through the hole) and its hex below. */
function drawLoupe(f: Frame, s: { x: number; y: number; hex: string }): void {
  if (!(Number.isFinite(s.x) && Number.isFinite(s.y))) return
  const ctx = f.ctx
  const hex = HEX6.test(s.hex) ? s.hex.toLowerCase() : '000000'
  const inner = 14
  const outer = 24
  setScreenTransform(f)
  ctx.beginPath()
  ctx.arc(s.x, s.y, outer, 0, Math.PI * 2)
  ctx.arc(s.x, s.y, inner, 0, Math.PI * 2, true)
  ctx.fillStyle = '#' + hex
  ctx.fill('evenodd')
  ctx.lineWidth = 2
  ctx.strokeStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(s.x, s.y, outer + 1, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(0,0,0,0.75)'
  ctx.beginPath()
  ctx.arc(s.x, s.y, inner - 0.5, 0, Math.PI * 2)
  ctx.stroke()

  ctx.font = noteFont(12)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const label = '#' + hex.toUpperCase()
  const tw = ctx.measureText(label).width
  const lw = tw + 14
  // Below the ring, or above it when it is too near the canvas's bottom edge.
  const below = s.y + outer + 6 + 20 <= f.vh
  const top = below ? s.y + outer + 6 : s.y - outer - 6 - 20
  const left = clamp(s.x - lw / 2, 2, Math.max(f.vw - lw - 2, 2))
  roundRectPath(ctx, left, top, lw, 20, 10)
  ctx.fillStyle = '#' + hex
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'
  ctx.stroke()
  ctx.fillStyle = '#' + textColourOn(hex)
  ctx.fillText(label, left + lw / 2, top + 10.5)
}

/* ------------------------------------------------------------- text measuring -- */

/** The most layouts `canvasTextMetrics` keeps (a board has at most 1,500 notes; this leaves room for one resize in flight). */
export const TEXT_CACHE_ENTRIES = 2048
/** Layouts kept per text (the sizes and widths one note has been given while it is dragged larger). */
const TEXT_VARIANTS = 8
/** The size words are measured at: large, so hinting and rounding of small sizes never decide where a line breaks. */
const REF_SIZE = 100

export interface CanvasTextMetrics extends TextMetrics {
  /** Layouts held now. */
  readonly size: number
}

interface Variant {
  size: number
  width: number
  layout: TextLayout
}

/**
 * Wrapped text measured with the context's real font. A line breaks at spaces when the next word would not fit, a word wider than the
 * line is cut where it fills it (at least one character a line), `\n` starts a line, and a line is `NOTE_LINE_HEIGHT_EM × size` high:
 * the same rules as `estimateTextMetrics`, with real widths. Words are measured at a fixed large size and scaled, so the layout of a
 * note does not wobble with its size. Answers are cached per (text, size, width) in a bounded table and shared, never mutated.
 */
export function canvasTextMetrics(ctx: Pick<Ctx2D, 'measureText' | 'font'>): CanvasTextMetrics {
  const cache = new Map<string, Variant[]>()
  let held = 0

  function measure(s: string): number {
    const w = ctx.measureText(s).width
    return Number.isFinite(w) && w > 0 ? w : 0
  }

  /**
   * How many of `chars` (code points) from `from` on fit `limit`, at least one. It gallops (8, 16, 32 ...) before it bisects, so a line
   * costs by its own length and not by what is left of the word: a 4,000 character word in a one-glyph column stays cheap.
   */
  function fitStart(chars: string[], from: number, limit: number): number {
    const left = chars.length - from
    const fits = (n: number): boolean => measure(chars.slice(from, from + n).join('')) <= limit
    let lo = 1
    let hi = Math.min(left, 8)
    while (hi < left && fits(hi)) {
      lo = hi
      hi = Math.min(left, hi * 2)
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (fits(mid)) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  function wrapParagraph(p: string, limit: number, lines: string[], widths: number[]): void {
    const whole = p === '' ? 0 : measure(p)
    if (whole <= limit) {
      lines.push(p)
      widths.push(whole)
      return
    }
    let line = ''
    let lineW = 0
    let started = false
    for (const word of p.split(' ')) {
      if (started) {
        const joined = line + ' ' + word
        const jw = measure(joined)
        if (jw <= limit) {
          line = joined
          lineW = jw
          continue
        }
        lines.push(line)
        widths.push(lineW)
      }
      started = true
      const ww = word === '' ? 0 : measure(word)
      if (ww <= limit) {
        line = word
        lineW = ww
        continue
      }
      // A word wider than the line: full lines of it, the rest starts the next line.
      const chars = Array.from(word)
      let from = 0
      for (;;) {
        const n = fitStart(chars, from, limit)
        if (from + n >= chars.length) break
        const piece = chars.slice(from, from + n).join('')
        lines.push(piece)
        widths.push(measure(piece))
        from += n
      }
      line = chars.slice(from).join('')
      lineW = measure(line)
    }
    lines.push(line)
    widths.push(lineW)
  }

  function compute(text: string, size: number, maxWidth: number): TextLayout {
    const px = Number.isFinite(size) && size > 0 ? size : 0
    const lines: string[] = []
    const widths: number[] = []
    if (px === 0) {
      for (const p of text.split('\n')) lines.push(p.replace(/\r$/, ''))
      return Object.freeze({ lines: Object.freeze(lines) as string[], width: 0, height: 0 })
    }
    const before = ctx.font
    ctx.font = noteFont(REF_SIZE)
    try {
      const limit = Number.isFinite(maxWidth) ? (Math.max(maxWidth, 0) * REF_SIZE) / px : Infinity
      for (const p of text.split('\n')) wrapParagraph(p.replace(/\r$/, ''), limit, lines, widths)
    } finally {
      // Measuring happens in the middle of drawing with the same context: its font is handed back as it was.
      ctx.font = before
    }
    let widest = 0
    for (const w of widths) if (w > widest) widest = w
    return Object.freeze({ lines: Object.freeze(lines) as string[], width: (widest * px) / REF_SIZE, height: lines.length * px * NOTE_LINE_HEIGHT_EM })
  }

  return {
    get size() {
      return held
    },
    layout(text: string, size: number, maxWidth: number): TextLayout {
      const variants = cache.get(text)
      if (variants) {
        for (const v of variants) if (v.size === size && v.width === maxWidth) return v.layout
      }
      const layout = compute(text, size, maxWidth)
      if (variants) {
        if (variants.length >= TEXT_VARIANTS) {
          variants.shift()
          held--
        }
        variants.push({ size, width: maxWidth, layout })
        held++
      } else {
        // The oldest texts go first (insertion order); a text that is asked for again is simply computed again.
        while (held >= TEXT_CACHE_ENTRIES) {
          const oldest = cache.keys().next()
          if (oldest.done) break
          held -= cache.get(oldest.value)!.length
          cache.delete(oldest.value)
        }
        cache.set(text, [{ size, width: maxWidth, layout }])
        held++
      }
      return layout
    },
  }
}

/* --------------------------------------------------------------------- export -- */

/** A canvas as the export needs it: a `<canvas>`, or whatever the host can make that can be turned into a PNG. */
export interface ExportCanvas {
  width: number
  height: number
  getContext(type: '2d'): Ctx2D | null
  toBlob?(callback: (blob: Blob | null) => void, type?: string): void
}

export interface ExportImages {
  /** The picture at its full size (the original, scaled down only past 8192 px), or null when it cannot be read. */
  get(path: string): Promise<BitmapLike | null>
  /** Gives a bitmap back once the export has drawn with it. Without it the export closes the bitmap itself. */
  release?(path: string, bitmap: BitmapLike): void
}

export interface ExportOptions {
  /** Empty space round the board, in pixels of the picture made. Default 0. */
  margin?: number
  /** The longer side of the picture at most; the scale is reduced to keep it. Default 8192. */
  maxSide?: number
  /** Paint the board's colour under the items (default) or leave the picture transparent. */
  background?: boolean
}

export interface ExportResult {
  canvas: ExportCanvas
  width: number
  height: number
  /** Pixels per board unit actually used (the asked scale, or less when the picture would be too large). */
  scale: number
}

export const DEFAULT_EXPORT_MAX_SIDE = 8192
/** Pixels of full-size bitmaps an export holds at once: a long board is drawn in several passes, closing what a pass loaded. */
export const EXPORT_PASS_PIXELS = 96e6

/** The rectangle in board units a picture's caption takes below its bounds at `scale` pixels per unit, or null when it shows none. */
function captionRect(it: PictureItem, bounds: Rect, scale: number): Rect | null {
  const c = it.crop
  const minSide = Math.min((c.r - c.l) * it.w, (c.b - c.t) * it.h) * scale
  if (!(minSide >= CAPTION_MIN_SIDE)) return null
  if (it.caption === '' && baseName(it.path) === '') return null
  const { height } = captionSize(minSide)
  return { x: bounds.x, y: bounds.y + bounds.h, w: bounds.w, h: (CAPTION_GAP + height) / scale }
}

function unionRect(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 }
}

/**
 * Draws the items `ids` (null: all of them) at `scale` pixels per board unit onto a canvas from `makeCanvas`, exactly as the board
 * shows them without its editing aids (`drawBoard` with `showUi` off, an image source that serves the full-size bitmaps). The scale is
 * brought down so that neither side passes `maxSide`. Null for no items. The pictures are loaded as needed, a pass of them at a time
 * (EXPORT_PASS_PIXELS), and each bitmap is handed back (`images.release`, else closed) once its pass is drawn: a board of hundreds of
 * large pictures never sits in memory at once. A picture that cannot be read is drawn as a missing one.
 */
export async function exportBoard(
  doc: BoardDoc,
  ids: readonly number[] | null,
  scale: number,
  images: ExportImages,
  makeCanvas: (w: number, h: number) => ExportCanvas,
  metrics: TextMetrics,
  opts: ExportOptions = {},
): Promise<ExportResult | null> {
  const wanted = ids ? new Set(ids) : null
  const items = wanted ? doc.items.filter((it) => wanted.has(it.id)) : doc.items
  const bounds0 = items.length > 0 ? itemsBounds(items, metrics) : null
  if (!bounds0) return null

  const maxSide = Math.max(16, Math.min(Number.isFinite(opts.maxSide) && opts.maxSide! > 0 ? opts.maxSide! : DEFAULT_EXPORT_MAX_SIDE, 32768))
  const margin = Math.max(0, Math.min(Number.isFinite(opts.margin) ? opts.margin! : 0, maxSide / 4))
  const asked = Number.isFinite(scale) && scale > 0 ? scale : 1

  // Captions hang below their pictures and have a fixed size in pixels, so what they add depends on the scale: settle it in a few rounds.
  const fit = (b: Rect): number => Math.min(asked, (maxSide - 2 * margin) / Math.max(b.w, b.h, 1e-9))
  let s = fit(bounds0)
  let bounds = bounds0
  if (doc.captions) {
    for (let round = 0; round < 3; round++) {
      let b = bounds0
      for (const it of items) {
        if (it.kind !== 'picture') continue
        const r = captionRect(it, itemBounds(it, metrics), s)
        if (r) b = unionRect(b, r)
      }
      bounds = b
      const next = fit(b)
      if (next >= s) break
      s = next
    }
  }
  const width = Math.max(1, Math.min(maxSide, Math.ceil(bounds.w * s + 2 * margin)))
  const height = Math.max(1, Math.min(maxSide, Math.ceil(bounds.h * s + 2 * margin)))
  const canvas = makeCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const view: BoardView = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2, zoom: s }
  const viewport = { w: width, h: height }
  let drawn = 0
  while (drawn < items.length) {
    const held = new Map<string, BitmapLike | null>()
    let pixels = 0
    let end = drawn
    try {
      for (; end < items.length; end++) {
        const it = items[end]!
        if (it.kind !== 'picture' || held.has(it.path)) continue
        if (pixels >= EXPORT_PASS_PIXELS) break
        let bmp: BitmapLike | null = null
        try {
          bmp = await images.get(it.path)
        } catch {
          bmp = null
        }
        if (bmp && !(bmp.width > 0 && bmp.height > 0)) bmp = null
        held.set(it.path, bmp)
        if (bmp) pixels += bmp.width * bmp.height
      }
      const source: ImageSource = {
        get(path: string): ImageSlot {
          const bmp = held.get(path) ?? null
          return {
            bitmap: bmp as unknown as ImageBitmap | null,
            natural: bmp ? { w: bmp.width, h: bmp.height } : null,
            failed: !bmp,
          }
        },
      }
      drawBoard(ctx, {
        doc: { ...doc, items: items.slice(drawn, end) },
        view,
        viewport,
        dpr: 1,
        state: EMPTY_DRAW_STATE,
        images: source,
        metrics,
        showUi: false,
        backdrop: drawn > 0 ? 'keep' : opts.background === false ? 'clear' : 'fill',
      })
    } finally {
      for (const [path, bmp] of held) {
        if (!bmp) continue
        try {
          if (images.release) images.release(path, bmp)
          else bmp.close()
        } catch {
          /* a bitmap that will not close has nothing left to give back */
        }
      }
    }
    drawn = end
  }
  return { canvas, width, height, scale: s }
}
