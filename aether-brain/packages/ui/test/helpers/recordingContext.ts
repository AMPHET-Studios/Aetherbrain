/**
 * A 2D context that draws nothing and writes down everything: the board renderer's tests run `drawBoard` against it in node and read
 * back where each picture landed, which state it was drawn in and which text and paths came out. It implements the Canvas 2D matrix
 * rules (save/restore, translate, rotate, scale, transform, setTransform; a new transform is multiplied on the right, as in the
 * spec), and a path point is mapped through the matrix at the moment it is added, as a browser does. The matrix model is checked
 * against real Chromium's by board-renderer-chromium.test.ts.
 */
import type { Ctx2D } from '../../src/board/renderer'
import type { ImageSlot, ImageSource } from '../../src/board/api'

/** [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (the canvas's DOMMatrix order). */
export type Matrix = [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** `m` followed by `n` (n applied first to a point, as `ctx.transform(n)` does). */
export function multiply(m: Matrix, n: Matrix): Matrix {
  const [a, b, c, d, e, f] = m
  return [a * n[0] + c * n[1], b * n[0] + d * n[1], a * n[2] + c * n[3], b * n[2] + d * n[3], a * n[4] + c * n[5] + e, b * n[4] + d * n[5] + f]
}

export function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

export function determinant(m: Matrix): number {
  return m[0] * m[3] - m[1] * m[2]
}

/** The state a drawing call is made in. */
export interface Snapshot {
  matrix: Matrix
  globalAlpha: number
  /** undefined: the context has no filters. */
  filter: string | undefined
  smoothing: boolean
  quality: string
  fillStyle: string | object
  strokeStyle: string | object
  lineWidth: number
  lineCap: string
  lineJoin: string
  lineDash: number[]
  font: string
  textAlign: string
  textBaseline: string
  /** How many clips are active (nested saves count). */
  clips: number
}

/** One segment of a path; points are already in device space. */
export type PathSeg =
  | { t: 'M' | 'L'; x: number; y: number }
  | { t: 'Q'; cx: number; cy: number; x: number; y: number }
  | { t: 'Z' }
  | { t: 'rect'; x: number; y: number; w: number; h: number; m: Matrix }
  | { t: 'arc'; x: number; y: number; r: number; a0: number; a1: number; ccw: boolean; m: Matrix }
  | { t: 'ellipse'; x: number; y: number; rx: number; ry: number; rot: number; a0: number; a1: number; ccw: boolean; m: Matrix }
  | { t: 'arcTo'; x1: number; y1: number; x2: number; y2: number; r: number; m: Matrix }

export interface DrawImageRec {
  op: 'drawImage'
  image: ImageBitmap
  sx: number
  sy: number
  sw: number
  sh: number
  dx: number
  dy: number
  dw: number
  dh: number
  s: Snapshot
}

export interface RectRec {
  op: 'fillRect' | 'strokeRect' | 'clearRect'
  x: number
  y: number
  w: number
  h: number
  s: Snapshot
}

export interface TextRec {
  op: 'fillText'
  text: string
  x: number
  y: number
  s: Snapshot
}

export interface PathRec {
  op: 'fill' | 'stroke' | 'clip'
  path: PathSeg[]
  rule: string
  s: Snapshot
}

export interface MarkRec {
  op: 'save' | 'restore' | 'setLineDash'
  s: Snapshot
}

export type Rec = DrawImageRec | RectRec | TextRec | PathRec | MarkRec

export interface RecordingOptions {
  /** false: the context has no `filter` property (an old Safari). */
  filter?: boolean
  /** The width of a string in the current font; default 0.6 × the font's pixel size per UTF-16 unit. */
  measure?: (text: string, fontPx: number) => number
}

const FONT_PX = /(\d+(?:\.\d+)?(?:e[+-]?\d+)?)px/

export class RecordingContext implements Ctx2D {
  fillStyle: string | object = '#000000'
  strokeStyle: string | object = '#000000'
  lineWidth = 1
  lineCap: 'butt' | 'round' | 'square' = 'butt'
  lineJoin: 'round' | 'bevel' | 'miter' = 'miter'
  globalAlpha = 1
  imageSmoothingEnabled = true
  imageSmoothingQuality: 'low' | 'medium' | 'high' = 'low'
  // `declare`: no property at all on a context without filters, as on a browser that lacks them (`'filter' in ctx` is false).
  declare filter?: string
  font = '10px sans-serif'
  textAlign: 'left' | 'right' | 'center' | 'start' | 'end' = 'start'
  textBaseline: 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom' = 'alphabetic'

  matrix: Matrix = [...IDENTITY]
  lineDash: number[] = []
  clips = 0
  /** Every drawing call, in order. */
  log: Rec[] = []
  /** The path being built. */
  path: PathSeg[] = []
  /** Calls to restore() with nothing saved (a bug in the caller). */
  underflows = 0
  /** Calls to setTransform with a number that is not finite (ignored, as a browser does). */
  badTransforms = 0
  /** The numbers and the call stack of the first of them. */
  badTransformAt: string | undefined
  /** Calls to measureText. */
  measures = 0
  private stack: Snapshot[] = []
  private readonly measureFn: (text: string, fontPx: number) => number

  constructor(opts: RecordingOptions = {}) {
    if (opts.filter !== false) this.filter = 'none'
    this.measureFn = opts.measure ?? ((text, px) => text.length * px * 0.6)
  }

  /* ---- state ---- */

  /** The state as a call would see it now. */
  snapshot(): Snapshot {
    return {
      matrix: [...this.matrix] as Matrix,
      globalAlpha: this.globalAlpha,
      filter: this.filter,
      smoothing: this.imageSmoothingEnabled,
      quality: this.imageSmoothingQuality,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      lineDash: [...this.lineDash],
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      clips: this.clips,
    }
  }

  private restoreFrom(s: Snapshot): void {
    this.matrix = [...s.matrix] as Matrix
    this.globalAlpha = s.globalAlpha
    if (s.filter === undefined) delete this.filter
    else this.filter = s.filter
    this.imageSmoothingEnabled = s.smoothing
    this.imageSmoothingQuality = s.quality as 'low' | 'medium' | 'high'
    this.fillStyle = s.fillStyle
    this.strokeStyle = s.strokeStyle
    this.lineWidth = s.lineWidth
    this.lineCap = s.lineCap as 'butt' | 'round' | 'square'
    this.lineJoin = s.lineJoin as 'round' | 'bevel' | 'miter'
    this.lineDash = [...s.lineDash]
    this.font = s.font
    this.textAlign = s.textAlign as this['textAlign']
    this.textBaseline = s.textBaseline as this['textBaseline']
    this.clips = s.clips
  }

  /** Saves not yet restored. */
  get depth(): number {
    return this.stack.length
  }

  save(): void {
    this.stack.push(this.snapshot())
    this.log.push({ op: 'save', s: this.snapshot() })
  }

  restore(): void {
    const s = this.stack.pop()
    if (!s) {
      this.underflows++
      return
    }
    this.restoreFrom(s)
    this.log.push({ op: 'restore', s: this.snapshot() })
  }

  /* ---- matrix ---- */

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    // As in a browser: a matrix with a number that is not finite is ignored (and the caller then draws in the wrong place).
    if (![a, b, c, d, e, f].every(Number.isFinite)) {
      this.badTransforms++
      this.badTransformAt ??= `${[a, b, c, d, e, f].join(', ')}\n${new Error().stack ?? ''}`
      return
    }
    this.matrix = [a, b, c, d, e, f]
  }

  resetTransform(): void {
    this.matrix = [...IDENTITY]
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.matrix = multiply(this.matrix, [a, b, c, d, e, f])
  }

  translate(x: number, y: number): void {
    this.transform(1, 0, 0, 1, x, y)
  }

  rotate(radians: number): void {
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    this.transform(cos, sin, -sin, cos, 0, 0)
  }

  scale(x: number, y: number): void {
    this.transform(x, 0, 0, y, 0, 0)
  }

  /* ---- paths ---- */

  beginPath(): void {
    this.path = []
  }

  closePath(): void {
    this.path.push({ t: 'Z' })
  }

  moveTo(x: number, y: number): void {
    const p = apply(this.matrix, x, y)
    this.path.push({ t: 'M', x: p.x, y: p.y })
  }

  lineTo(x: number, y: number): void {
    const p = apply(this.matrix, x, y)
    this.path.push({ t: 'L', x: p.x, y: p.y })
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    const c = apply(this.matrix, cpx, cpy)
    const p = apply(this.matrix, x, y)
    this.path.push({ t: 'Q', cx: c.x, cy: c.y, x: p.x, y: p.y })
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    this.path.push({ t: 'arcTo', x1, y1, x2, y2, r: radius, m: [...this.matrix] as Matrix })
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise = false): void {
    if (radius < 0) throw new Error('IndexSizeError: negative radius')
    this.path.push({ t: 'arc', x, y, r: radius, a0: startAngle, a1: endAngle, ccw: counterclockwise, m: [...this.matrix] as Matrix })
  }

  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, startAngle: number, endAngle: number, counterclockwise = false): void {
    if (rx < 0 || ry < 0) throw new Error('IndexSizeError: negative radius')
    this.path.push({ t: 'ellipse', x, y, rx, ry, rot: rotation, a0: startAngle, a1: endAngle, ccw: counterclockwise, m: [...this.matrix] as Matrix })
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.path.push({ t: 'rect', x, y, w, h, m: [...this.matrix] as Matrix })
  }

  fill(fillRule: 'nonzero' | 'evenodd' = 'nonzero'): void {
    this.log.push({ op: 'fill', path: [...this.path], rule: fillRule, s: this.snapshot() })
  }

  stroke(): void {
    this.log.push({ op: 'stroke', path: [...this.path], rule: 'nonzero', s: this.snapshot() })
  }

  clip(fillRule: 'nonzero' | 'evenodd' = 'nonzero'): void {
    this.log.push({ op: 'clip', path: [...this.path], rule: fillRule, s: this.snapshot() })
    this.clips++
  }

  /* ---- drawing ---- */

  fillRect(x: number, y: number, w: number, h: number): void {
    this.log.push({ op: 'fillRect', x, y, w, h, s: this.snapshot() })
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.log.push({ op: 'strokeRect', x, y, w, h, s: this.snapshot() })
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.log.push({ op: 'clearRect', x, y, w, h, s: this.snapshot() })
  }

  setLineDash(segments: number[]): void {
    this.lineDash = [...segments]
    this.log.push({ op: 'setLineDash', s: this.snapshot() })
  }

  drawImage(image: ImageBitmap, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void {
    this.log.push({ op: 'drawImage', image, sx, sy, sw, sh, dx, dy, dw, dh, s: this.snapshot() })
  }

  fillText(text: string, x: number, y: number): void {
    this.log.push({ op: 'fillText', text, x, y, s: this.snapshot() })
  }

  measureText(text: string): { width: number } {
    this.measures++
    const m = FONT_PX.exec(this.font)
    const px = m ? Number(m[1]) : 10
    return { width: this.measureFn(text, px) }
  }

  /* ---- reading the log ---- */

  drawImages(): DrawImageRec[] {
    return this.log.filter((r): r is DrawImageRec => r.op === 'drawImage')
  }

  texts(): TextRec[] {
    return this.log.filter((r): r is TextRec => r.op === 'fillText')
  }

  rects(op: RectRec['op']): RectRec[] {
    return this.log.filter((r): r is RectRec => r.op === op)
  }

  paths(op: PathRec['op']): PathRec[] {
    return this.log.filter((r): r is PathRec => r.op === op)
  }

  /** Forgets what was recorded (not the state). */
  clearLog(): void {
    this.log = []
    this.measures = 0
  }
}

/** The four corners of a drawImage's destination rectangle in device space: dest top-left, top-right, bottom-right, bottom-left. */
export function destCorners(r: DrawImageRec): { x: number; y: number }[] {
  return [
    apply(r.s.matrix, r.dx, r.dy),
    apply(r.s.matrix, r.dx + r.dw, r.dy),
    apply(r.s.matrix, r.dx + r.dw, r.dy + r.dh),
    apply(r.s.matrix, r.dx, r.dy + r.dh),
  ]
}

/** A rectangle fill's four corners in device space. */
export function rectCorners(r: RectRec): { x: number; y: number }[] {
  return [apply(r.s.matrix, r.x, r.y), apply(r.s.matrix, r.x + r.w, r.y), apply(r.s.matrix, r.x + r.w, r.y + r.h), apply(r.s.matrix, r.x, r.y + r.h)]
}

/** A stand-in for an ImageBitmap: its size, a name to tell it by, and whether it was closed. */
export interface FakeBitmap {
  readonly width: number
  readonly height: number
  readonly name: string
  closed: boolean
  close(): void
}

export function makeBitmap(width: number, height: number, name = 'bmp'): FakeBitmap & ImageBitmap {
  const b: FakeBitmap = {
    width,
    height,
    name,
    closed: false,
    close() {
      b.closed = true
    },
  }
  return b as FakeBitmap & ImageBitmap
}

/** An image source with a fixed answer per path, writing down each question. */
export class FakeImages implements ImageSource {
  calls: { path: string; want: number }[] = []
  constructor(private readonly slots: Record<string, Partial<ImageSlot>> = {}) {}
  get(path: string, wantPx: number): ImageSlot {
    this.calls.push({ path, want: wantPx })
    const s = this.slots[path]
    return { bitmap: s?.bitmap ?? null, natural: s?.natural ?? null, failed: s?.failed ?? false }
  }
}
