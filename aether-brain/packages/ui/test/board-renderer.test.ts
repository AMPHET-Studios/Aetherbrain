import { describe, expect, it } from 'vitest'
import {
  FULL_CROP,
  boardToScreen,
  emptyBoard,
  estimateTextMetrics,
  handlesFor,
  itemQuad,
  noteBox,
  rotatePoint,
  screenToBoard,
  setCrop,
  type BoardDoc,
  type BoardItem,
  type BoardView,
  type EllipseItem,
  type LineItem,
  type NoteItem,
  type PictureItem,
  type RectItem,
  type StrokeItem,
  type TextMetrics,
  type Vec2,
} from '@aether/core'
import {
  EMPTY_DRAW_STATE,
  EXPORT_PASS_PIXELS,
  HANDLE_PX,
  ROTATE_STALK_PX,
  TEXT_CACHE_ENTRIES,
  canvasTextMetrics,
  drawBoard,
  exportBoard,
  noteFont,
  visiblePictures,
  type DrawArgs,
  type ExportCanvas,
  type ExportImages,
} from '../src/board/renderer'
import {
  FakeImages,
  RecordingContext,
  apply,
  determinant,
  destCorners,
  makeBitmap,
  rectCorners,
  type DrawImageRec,
  type PathRec,
} from './helpers/recordingContext'

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

let ids = 1000
const common = () => ({ id: ids++, group: 0, locked: false })

function pic(o: Partial<PictureItem> = {}): PictureItem {
  return { ...common(), kind: 'picture', path: 'a.png', x: 0, y: 0, w: 200, h: 100, rotation: 0, crop: { ...FULL_CROP }, flipH: false, flipV: false, gray: false, opacity: 1, caption: '', ...o }
}

function note(o: Partial<NoteItem> = {}): NoteItem {
  return { ...common(), kind: 'note', text: 'hello', x: 0, y: 0, w: 200, size: 20, rotation: 0, color: 'ffffff', fill: '', ...o }
}

function stroke(o: Partial<StrokeItem> = {}): StrokeItem {
  return { ...common(), kind: 'stroke', points: [0, 0, 100, 0], color: 'ff5533', width: 4, ...o }
}

function line(o: Partial<LineItem> = {}): LineItem {
  return { ...common(), kind: 'line', x1: 0, y1: 0, x2: 100, y2: 0, color: 'ffffff', width: 4, arrow: false, ...o }
}

function rectItem(o: Partial<RectItem> = {}): RectItem {
  return { ...common(), kind: 'rect', x1: 0, y1: 0, x2: 100, y2: 60, color: 'ffffff', width: 4, fill: '', ...o }
}

function ellipseItem(o: Partial<EllipseItem> = {}): EllipseItem {
  return { ...common(), kind: 'ellipse', x1: 0, y1: 0, x2: 100, y2: 60, color: 'ffffff', width: 4, fill: '', ...o }
}

function docOf(items: BoardItem[], o: Partial<BoardDoc> = {}): BoardDoc {
  return { ...emptyBoard('t'), items, nextId: 5000, ...o }
}

const VIEW: BoardView = { x: 0, y: 0, zoom: 1 }
const VP = { w: 800, h: 600 }

interface Run {
  ctx: RecordingContext
  images: FakeImages
}

/** Draws `doc` onto a recording context (or `o.ctx`) and returns it with the image source it was given. */
function run(doc: BoardDoc, o: Partial<DrawArgs> & { ctx?: RecordingContext; slots?: ConstructorParameters<typeof FakeImages>[0] } = {}): Run {
  const ctx = o.ctx ?? new RecordingContext()
  const images = (o.images as FakeImages | undefined) ?? new FakeImages(o.slots)
  drawBoard(ctx, {
    doc,
    view: VIEW,
    viewport: VP,
    dpr: 1,
    state: EMPTY_DRAW_STATE,
    images,
    metrics: estimateTextMetrics,
    ...(o.view ? { view: o.view } : {}),
    ...(o.viewport ? { viewport: o.viewport } : {}),
    ...(o.dpr !== undefined ? { dpr: o.dpr } : {}),
    ...(o.state ? { state: o.state } : {}),
    ...(o.metrics ? { metrics: o.metrics } : {}),
    ...(o.showUi !== undefined ? { showUi: o.showUi } : {}),
    ...(o.missing ? { missing: o.missing } : {}),
    ...(o.backdrop ? { backdrop: o.backdrop } : {}),
  })
  return { ctx, images }
}

const close = (a: number, b: number, eps = 1e-6): void => {
  expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(eps)
}

const closePt = (a: Vec2, b: Vec2, eps = 1e-6): void => {
  close(a.x, b.x, eps)
  close(a.y, b.y, eps)
}

/** A board point on the canvas in device pixels. */
function dev(view: BoardView, vp: { w: number; h: number }, dpr: number, p: Vec2): Vec2 {
  const s = boardToScreen(view, vp, p)
  return { x: s.x * dpr, y: s.y * dpr }
}

/** The state of nothing selected plus the given fields. */
const state = (o: Partial<DrawArgs['state']>): DrawArgs['state'] => ({ ...EMPTY_DRAW_STATE, ...o })

const isMagenta = (s: string | object): boolean => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(s))
  return !!m && parseInt(m[1]!, 16) > 200 && parseInt(m[2]!, 16) < 100 && parseInt(m[3]!, 16) > 150
}

/* ------------------------------------------------------------ pictures --- */

describe('drawBoard: where a picture lands', () => {
  // Dest corner i of the drawImage (top-left, top-right, bottom-right, bottom-left of the rectangle) is quad corner FLIP[i] after the mirror.
  const FLIP: Record<string, number[]> = { none: [0, 1, 2, 3], h: [1, 0, 3, 2], v: [3, 2, 1, 0], hv: [2, 3, 0, 1] }

  it('puts the four destination corners on itemQuad mapped to the screen and takes the crop from the bitmap, for random pictures, turns, flips, crops, views and densities', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed)
      const rot = [0, 90, 180, 270, -90, (r() - 0.5) * 360][Math.floor(r() * 6)]!
      const l = r() * 0.6
      const t = r() * 0.6
      const crop = { l, t, r: l + 0.1 + r() * (1 - l - 0.1), b: t + 0.1 + r() * (1 - t - 0.1) }
      const flipH = r() < 0.5
      const flipV = r() < 0.5
      const item = pic({ x: (r() - 0.5) * 4000, y: (r() - 0.5) * 4000, w: 20 + r() * 1500, h: 20 + r() * 1500, rotation: rot, crop, flipH, flipV })
      const zoom = Math.exp(Math.log(0.01) + r() * (Math.log(30) - Math.log(0.01)))
      const dpr = [1, 1.25, 2][Math.floor(r() * 3)]!
      const centre = { x: item.x + ((r() - 0.5) * 300) / zoom, y: item.y + ((r() - 0.5) * 300) / zoom }
      const view = { x: centre.x, y: centre.y, zoom }
      const bmp = makeBitmap(50 + Math.floor(r() * 4000), 50 + Math.floor(r() * 4000))
      const { ctx } = run(docOf([item]), { view, dpr, slots: { 'a.png': { bitmap: bmp } } })

      const drawn = ctx.drawImages()
      expect(drawn, `seed ${seed}`).toHaveLength(1)
      const rec = drawn[0]!
      expect(rec.image).toBe(bmp)
      const got = destCorners(rec)
      const quad = itemQuad(item, estimateTextMetrics)
      const map = FLIP[`${flipH ? 'h' : ''}${flipV ? 'v' : ''}` || 'none']!
      for (let i = 0; i < 4; i++) closePt(got[i]!, dev(view, VP, dpr, quad[map[i]!]!), 1e-6)
      // The source rectangle is the crop's share of this bitmap, whatever size it has.
      close(rec.sx, crop.l * bmp.width, 1e-9 * bmp.width)
      close(rec.sy, crop.t * bmp.height, 1e-9 * bmp.height)
      close(rec.sw, (crop.r - crop.l) * bmp.width, 1e-9 * bmp.width)
      close(rec.sh, (crop.b - crop.t) * bmp.height, 1e-9 * bmp.height)
      // The destination is the shown part's size in the item's own frame, and a mirror shows up as a negative determinant.
      close(rec.dw, (crop.r - crop.l) * item.w, 1e-9)
      close(rec.dh, (crop.b - crop.t) * item.h, 1e-9)
      close(rec.dx, -rec.dw / 2, 1e-9)
      close(rec.dy, -rec.dh / 2, 1e-9)
      const k = zoom * dpr
      close(determinant(rec.s.matrix) / (k * k), flipH !== flipV ? -1 : 1, 1e-9)
    }
  })

  it('draws a pixel where the picture says: the top-left source pixel is at the quad corner a flip sends it to', () => {
    const view = { x: 10, y: -20, zoom: 2 }
    for (const [flipH, flipV, corner] of [
      [false, false, 0],
      [true, false, 1],
      [false, true, 3],
      [true, true, 2],
    ] as const) {
      const item = pic({ x: 50, y: 30, w: 100, h: 60, rotation: 30, flipH, flipV })
      const { ctx } = run(docOf([item]), { view, slots: { 'a.png': { bitmap: makeBitmap(10, 6) } } })
      const rec = ctx.drawImages()[0]!
      // sx, sy = 0, 0 is drawn at (dx, dy): the dest top-left.
      closePt(apply(rec.s.matrix, rec.dx, rec.dy), dev(view, VP, 1, itemQuad(item, estimateTextMetrics)[corner]!))
    }
  })

  it('keeps the matrix exact at quarter turns, so a picture turned by 90 degrees has crisp edges and four turns come back to the start', () => {
    const k = 2 * 1.5
    const view = { x: 0, y: 0, zoom: 1.5 }
    const want: Record<number, number[]> = { 0: [k, 0, 0, k], 90: [0, k, -k, 0], 180: [-k, 0, 0, -k], 270: [0, -k, k, 0], [-90]: [0, -k, k, 0] }
    for (const rot of [0, 90, 180, 270, -90]) {
      const { ctx } = run(docOf([pic({ rotation: rot })]), { view, dpr: 2, slots: { 'a.png': { bitmap: makeBitmap(4, 4) } } })
      const m = ctx.drawImages()[0]!.s.matrix
      expect([m[0] + 0, m[1] + 0, m[2] + 0, m[3] + 0], `rotation ${rot}`).toEqual(want[rot]!.map((v) => v + 0))
    }
  })

  it('keeps every pixel still shown where it was when the crop changes through ops.setCrop, flips and turns included', () => {
    // Where the pixel at (u, v) of the whole picture (fractions) is drawn, from the recorded call alone.
    const landing = (doc: BoardDoc, view: BoardView, u: number, v: number): Vec2 => {
      const bmp = makeBitmap(400, 300)
      const { ctx } = run(doc, { view, slots: { 'a.png': { bitmap: bmp } } })
      const rec = ctx.drawImages()[0]!
      const sx = u * bmp.width
      const sy = v * bmp.height
      return apply(rec.s.matrix, rec.dx + ((sx - rec.sx) / rec.sw) * rec.dw, rec.dy + ((sy - rec.sy) / rec.sh) * rec.dh)
    }
    for (let seed = 1; seed <= 120; seed++) {
      const r = rng(seed * 7919)
      const l = r() * 0.4
      const t = r() * 0.4
      const before = { l, t, r: l + 0.3 + r() * 0.3, b: t + 0.3 + r() * 0.3 }
      const l2 = r() * 0.4
      const t2 = r() * 0.4
      const after = { l: l2, t: t2, r: l2 + 0.25 + r() * 0.35, b: t2 + 0.25 + r() * 0.35 }
      const item = pic({ x: (r() - 0.5) * 300, y: (r() - 0.5) * 300, w: 200 + r() * 300, h: 150 + r() * 200, rotation: (r() - 0.5) * 360, flipH: r() < 0.5, flipV: r() < 0.5, crop: before })
      const doc = docOf([item])
      const next = setCrop(doc, item.id, after)
      expect(next, `seed ${seed}`).not.toBe(doc)
      // A point of the picture inside both crops.
      const u = Math.max(before.l, after.l) + r() * (Math.min(before.r, after.r) - Math.max(before.l, after.l))
      const v = Math.max(before.t, after.t) + r() * (Math.min(before.b, after.b) - Math.max(before.t, after.t))
      if (!(Math.min(before.r, after.r) > Math.max(before.l, after.l)) || !(Math.min(before.b, after.b) > Math.max(before.t, after.t))) continue
      const view = { x: item.x, y: item.y, zoom: 1.3 }
      closePt(landing(doc, view, u, v), landing(next, view, u, v), 1e-6)
    }
  })

  it('asks the cache for the whole picture at its longer side on the screen times the density, whatever the crop shows', () => {
    const item = pic({ w: 300, h: 120, crop: { l: 0.2, t: 0, r: 0.4, b: 1 } })
    const images = new FakeImages({ 'a.png': { bitmap: makeBitmap(64, 64) } })
    run(docOf([item]), { images, view: { x: 0, y: 0, zoom: 3 }, dpr: 2 })
    expect(images.calls).toEqual([{ path: 'a.png', want: 300 * 3 * 2 }])
  })

  it('does not ask for pictures that are off screen, and does for those whose turned bounds reach the canvas', () => {
    // Screen x = board x + 400 at zoom 1 here; the cull keeps a margin of 16 px.
    const inside = pic({ path: 'in.png', x: 0, y: 0, w: 100, h: 100 })
    const farRight = pic({ path: 'far.png', x: 5000, y: 0, w: 100, h: 100 })
    const justOut = pic({ path: 'out.png', x: -467, y: 0, w: 100, h: 100 })
    const justIn = pic({ path: 'edge.png', x: -465, y: 0, w: 100, h: 100 })
    const tallFlat = pic({ path: 'flat.png', x: -600, y: 0, w: 1000, h: 10, rotation: 0 })
    const tallTurned = pic({ path: 'turned.png', x: -600, y: 0, w: 1000, h: 10, rotation: 90 })
    const diagonal = pic({ path: 'diag.png', x: -450, y: 0, w: 100, h: 100, rotation: 45 })
    const below = pic({ path: 'below.png', x: 0, y: 5000, w: 100, h: 100 })
    const bmp = makeBitmap(10, 10)
    const slots = Object.fromEntries(['in', 'far', 'out', 'edge', 'flat', 'turned', 'diag', 'below'].map((n) => [`${n}.png`, { bitmap: bmp }]))
    const { ctx, images } = run(docOf([inside, farRight, justOut, justIn, tallFlat, tallTurned, diagonal, below]), { slots })
    expect(images.calls.map((c) => c.path).sort()).toEqual(['diag.png', 'edge.png', 'flat.png', 'in.png'])
    expect(ctx.drawImages()).toHaveLength(4)
  })

  it('skips notes and marks that are off screen too, and draws those on screen', () => {
    const doc = docOf([
      note({ text: 'near', x: 0, y: 0 }),
      note({ text: 'far', x: 9000, y: 0 }),
      stroke({ points: [8000, 0, 8100, 50] }),
      line({ x1: 0, y1: 100, x2: 50, y2: 100 }),
      rectItem({ x1: 7000, y1: 0, x2: 7100, y2: 50 }),
      ellipseItem({ x1: -9000, y1: 0, x2: -8900, y2: 50 }),
    ])
    const { ctx } = run(doc)
    expect(ctx.texts().map((t) => t.text)).toEqual(['near'])
    expect(ctx.paths('stroke')).toHaveLength(1)
    expect(ctx.rects('strokeRect')).toHaveLength(0)
  })

  it('draws a caption that hangs into the canvas under a picture that is itself just above it, and not when captions are off', () => {
    // A picture 400 px tall on the screen, its bottom 30 px above the top edge: its caption plate reaches down to y = 8.
    const item = pic({ path: 'tall/cap.png', x: 0, y: -530, w: 400, h: 400, caption: 'above' })
    const slots = { 'tall/cap.png': { bitmap: makeBitmap(10, 10) } }
    const on = run(docOf([item], { captions: true }), { slots, view: { x: 0, y: 0, zoom: 1 } })
    expect(on.ctx.drawImages()).toHaveLength(1)
    expect(on.ctx.texts().map((t) => t.text)).toEqual(['above'])
    const off = run(docOf([item], { captions: false }), { slots })
    expect(off.ctx.drawImages()).toHaveLength(0)
  })

  it('lists the visible pictures with the very cull the drawing uses', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed)
      const items: BoardItem[] = []
      for (let i = 0; i < 25; i++) items.push(pic({ path: `p${i % 17}.png`, x: (r() - 0.5) * 3000, y: (r() - 0.5) * 2000, w: 50 + r() * 400, h: 50 + r() * 400, rotation: r() * 360 - 180 }))
      const view = { x: (r() - 0.5) * 500, y: (r() - 0.5) * 500, zoom: 0.3 + r() * 2 }
      const captions = r() < 0.5
      const doc = docOf(items, { captions })
      const slots = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}.png`, { bitmap: makeBitmap(8, 8) }]))
      const { images } = run(doc, { view, slots })
      const asked = [...new Set(images.calls.map((c) => c.path))]
      expect(visiblePictures(doc, view, VP, estimateTextMetrics), `seed ${seed}`).toEqual(asked)
    }
  })

  it('draws the items back to front: the first item of the board is drawn first', () => {
    const slots = { 'back.png': { bitmap: makeBitmap(4, 4, 'back') }, 'front.png': { bitmap: makeBitmap(4, 4, 'front') } }
    const { ctx } = run(docOf([pic({ path: 'back.png' }), pic({ path: 'front.png' })]), { slots })
    expect(ctx.drawImages().map((d) => (d.image as unknown as { name: string }).name)).toEqual(['back', 'front'])
  })
})

describe('drawBoard: the state a picture is drawn in', () => {
  const bmp = makeBitmap(100, 50)
  const slots = { 'a.png': { bitmap: bmp }, 'b.png': { bitmap: bmp }, 'c.png': { bitmap: bmp } }

  it('sets opacity, grey and smoothing for one picture and hands the defaults to the next', () => {
    const items = [
      pic({ path: 'a.png', opacity: 0.4, gray: true, x: -150 }),
      pic({ path: 'b.png', x: 0 }),
      pic({ path: 'c.png', opacity: 0.8, x: 150 }),
      pic({ path: 'b.png', x: 300, gray: true }),
      pic({ path: 'b.png', x: -300 }),
    ]
    const { ctx } = run(docOf(items), { slots })
    const states = ctx.drawImages().map((d) => ({ a: d.s.globalAlpha, f: d.s.filter, s: d.s.smoothing, q: d.s.quality }))
    expect(states).toEqual([
      { a: 0.4, f: 'grayscale(1)', s: true, q: 'high' },
      { a: 1, f: 'none', s: true, q: 'high' },
      { a: 0.8, f: 'none', s: true, q: 'high' },
      { a: 1, f: 'grayscale(1)', s: true, q: 'high' },
      { a: 1, f: 'none', s: true, q: 'high' },
    ])
  })

  it('greys everything when the board is grey, and smooths or not by the board', () => {
    const crisp = run(docOf([pic({ path: 'a.png' })], { gray: true, smooth: false }), { slots })
    const rec = crisp.ctx.drawImages()[0]!
    expect(rec.s.filter).toBe('grayscale(1)')
    expect(rec.s.smoothing).toBe(false)
    const smooth = run(docOf([pic({ path: 'a.png' })], { gray: false, smooth: true }), { slots })
    expect(smooth.ctx.drawImages()[0]!.s.smoothing).toBe(true)
  })

  it('uses the cheap resampling filter while a pan or zoom is in progress, and the good one at rest', () => {
    const moving = run(docOf([pic({ path: 'a.png' })]), { slots, state: state({ moving: true }) })
    expect(moving.ctx.drawImages()[0]!.s.quality).toBe('low')
    const rest = run(docOf([pic({ path: 'a.png' })]), { slots })
    expect(rest.ctx.drawImages()[0]!.s.quality).toBe('high')
  })

  it('draws a grey picture in colour, without failing, on a context that has no filters', () => {
    const ctx = new RecordingContext({ filter: false })
    expect('filter' in ctx).toBe(false)
    run(docOf([pic({ path: 'a.png', gray: true })]), { slots, ctx })
    const rec = ctx.drawImages()[0]!
    expect(rec.s.filter).toBeUndefined()
    expect('filter' in ctx).toBe(false)
  })

  it('leaves the context as it found it: balanced saves, its own alpha, filter, transform and dash, even after a bitmap that throws', () => {
    const ctx = new RecordingContext()
    ctx.globalAlpha = 0.3
    ctx.filter = 'blur(2px)'
    ctx.setTransform(2, 0, 0, 2, 5, 6)
    ctx.setLineDash([1, 2])
    const boom = makeBitmap(10, 10)
    const orig = ctx.drawImage.bind(ctx)
    ctx.drawImage = (image, ...rest) => {
      if (image === boom) throw new Error('InvalidStateError')
      orig(image, ...rest)
    }
    const items = [pic({ path: 'a.png', opacity: 0.5, gray: true }), pic({ path: 'boom.png' }), stroke(), note({ text: 'x', fill: '333333' }), pic({ path: 'a.png', x: 99 })]
    run(docOf(items), { ctx, slots: { 'a.png': { bitmap: bmp }, 'boom.png': { bitmap: boom } }, state: state({ selection: [items[0]!.id], box: { corners: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], rotateHandle: { x: 5, y: -20 }, rotation: 0 } }) })
    expect(ctx.depth).toBe(0)
    expect(ctx.underflows).toBe(0)
    expect(ctx.globalAlpha).toBe(0.3)
    expect(ctx.filter).toBe('blur(2px)')
    expect(ctx.matrix).toEqual([2, 0, 0, 2, 5, 6])
    expect(ctx.lineDash).toEqual([1, 2])
    // The picture after the one that threw was still drawn.
    expect(ctx.drawImages().map((d) => d.s.matrix[4])).toHaveLength(2)
  })

  it('does not draw a bitmap that was closed under the frame (its size is 0)', () => {
    const closed = makeBitmap(0, 0)
    const { ctx } = run(docOf([pic({ path: 'a.png' })]), { slots: { 'a.png': { bitmap: closed } } })
    expect(ctx.drawImages()).toHaveLength(0)
  })
})

describe('drawBoard: placeholders', () => {
  const big = pic({ path: 'Boards/Gate/rust.png', w: 400, h: 300 })

  it('draws a dark fill and no image while a picture is loading', () => {
    const { ctx } = run(docOf([big]), { slots: { 'Boards/Gate/rust.png': { bitmap: null } } })
    expect(ctx.drawImages()).toHaveLength(0)
    const fills = ctx.rects('fillRect').filter((r) => r.w === 400 && r.h === 300)
    expect(fills).toHaveLength(1)
    expect(fills[0]!.s.fillStyle).toBe('#1b1e29')
    // Dashes and the file name belong to the pictures that cannot be shown.
    expect(ctx.log.some((r) => r.op === 'setLineDash' && r.s.lineDash.length > 0)).toBe(false)
    expect(ctx.texts()).toHaveLength(0)
  })

  it('draws a dashed outline, a crossed box and the file name for a picture that failed', () => {
    const { ctx } = run(docOf([big]), { slots: { 'Boards/Gate/rust.png': { failed: true } } })
    expect(ctx.drawImages()).toHaveLength(0)
    const dashed = ctx.rects('strokeRect').filter((r) => r.w === 400 && r.h === 300)
    expect(dashed).toHaveLength(1)
    expect(dashed[0]!.s.lineDash.length).toBeGreaterThan(0)
    // The cross: two diagonals corner to corner.
    const cross = ctx.paths('stroke').find((p) => p.path.length === 4)!
    const [m1, l1, m2, l2] = cross.path as { x: number; y: number }[]
    const quad = itemQuad(big, estimateTextMetrics).map((p) => dev(VIEW, VP, 1, p))
    closePt(m1!, quad[0]!)
    closePt(l1!, quad[2]!)
    closePt(m2!, quad[1]!)
    closePt(l2!, quad[3]!)
    expect(ctx.texts().map((t) => t.text)).toEqual(['rust.png'])
  })

  it('draws its outlines with square caps and mitred joins whatever the context had before', () => {
    const ctx = new RecordingContext()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'bevel'
    run(docOf([big]), { ctx, slots: { 'Boards/Gate/rust.png': { failed: true } } })
    const outline = ctx.rects('strokeRect')[0]!
    expect([outline.s.lineCap, outline.s.lineJoin]).toEqual(['butt', 'miter'])
    expect([ctx.lineCap, ctx.lineJoin]).toEqual(['round', 'bevel'])
  })

  it('treats a picture the vault has lost as failed without asking the cache for it', () => {
    const { ctx, images } = run(docOf([big, pic({ path: 'ok.png', x: 400 })]), { slots: { 'ok.png': { bitmap: makeBitmap(4, 4) } }, missing: (p) => p === 'Boards/Gate/rust.png' })
    expect(images.calls.map((c) => c.path)).toEqual(['ok.png'])
    expect(ctx.rects('strokeRect').some((r) => r.s.lineDash.length > 0)).toBe(true)
    expect(ctx.texts().map((t) => t.text)).toEqual(['rust.png'])
  })

  it('leaves the file name out of a placeholder too small to hold it and draws the box turned with the picture', () => {
    const tiny = pic({ path: 'x/small.png', w: 40, h: 30, rotation: 90 })
    const { ctx } = run(docOf([tiny]), { slots: { 'x/small.png': { failed: true } } })
    expect(ctx.texts()).toHaveLength(0)
    const outline = ctx.rects('strokeRect')[0]!
    const corners = rectCorners(outline)
    const quad = itemQuad(tiny, estimateTextMetrics).map((p) => dev(VIEW, VP, 1, p))
    for (let i = 0; i < 4; i++) closePt(corners[i]!, quad[i]!)
  })

  it('draws captions: the caption, else the file name, under a big enough picture only', () => {
    const slots = { 'dir/one.png': { bitmap: makeBitmap(8, 8) }, 'dir/two.png': { bitmap: makeBitmap(8, 8) }, 'dir/tiny.png': { bitmap: makeBitmap(8, 8) } }
    const items = [pic({ path: 'dir/one.png', x: -250, caption: 'Rusted gate' }), pic({ path: 'dir/two.png', x: 250 }), pic({ path: 'dir/tiny.png', x: 0, y: 200, w: 30, h: 30 })]
    const { ctx } = run(docOf(items, { captions: true }), { slots })
    expect(ctx.texts().map((t) => t.text)).toEqual(['Rusted gate', 'two.png'])
    const off = run(docOf(items, { captions: false }), { slots })
    expect(off.ctx.texts()).toHaveLength(0)
    // Under the picture's bounds, centred on it, upright.
    const t = ctx.texts()[0]!
    expect(t.s.matrix).toEqual([1, 0, 0, 1, 0, 0])
    // The picture's bottom is at y = 350 on the canvas: the plate hangs from 4 px below it and is under 48 px tall.
    expect(t.y).toBeGreaterThan(350 + 4)
    expect(t.y).toBeLessThan(350 + 48)
  })
})

describe('drawBoard: captions in detail', () => {
  const slots = { 'dir/long.png': { bitmap: makeBitmap(8, 8) } }
  // Every UTF-16 unit is 0.6 of the font size wide.
  const width = (text: string, px: number): number => text.length * px * 0.6

  it('cuts a caption wider than its picture to fit, with an ellipsis, and leaves a short one whole', () => {
    const long = 'A very long caption that cannot possibly fit under a picture of one hundred pixels'
    const item = pic({ path: 'dir/long.png', x: 0, y: 0, w: 100, h: 100, caption: long })
    const { ctx } = run(docOf([item], { captions: true }), { slots })
    const t = ctx.texts()[0]!
    expect(t.text.endsWith('…')).toBe(true)
    expect(t.text.length).toBeLessThan(long.length)
    expect(long.startsWith(t.text.slice(0, -1))).toBe(true)
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(t.s.font)![1])
    // The plate (text and a margin of half the font each side) is no wider than the picture.
    expect(width(t.text, px) + px).toBeLessThanOrEqual(100 + 1e-9)
    // One more character would not have fit.
    const more = long.slice(0, t.text.length) + '…'
    expect(width(more, px) + px).toBeGreaterThan(100)
    const short = run(docOf([{ ...item, caption: 'short' }], { captions: true }), { slots })
    expect(short.ctx.texts()[0]!.text).toBe('short')
  })

  it('hangs the plate under the bounds of a turned picture, centred on it, upright', () => {
    for (const rotation of [0, 45, 90, -30]) {
      const item = pic({ path: 'dir/long.png', x: 30, y: -20, w: 220, h: 120, rotation, caption: 'under' })
      const view = { x: 10, y: 5, zoom: 1.5 }
      const { ctx } = run(docOf([item], { captions: true }), { slots, view })
      const t = ctx.texts()[0]!
      expect(t.s.matrix).toEqual([1, 0, 0, 1, 0, 0])
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(t.s.font)![1])
      const quad = itemQuad(item, estimateTextMetrics).map((p) => boardToScreen(view, VP, p))
      const bottom = Math.max(...quad.map((p) => p.y))
      const centreX = (Math.min(...quad.map((p) => p.x)) + Math.max(...quad.map((p) => p.x))) / 2
      // The text is left-aligned inside a plate half a font wider each side: the plate's middle is the text's middle.
      close(t.x + width('under', px) / 2, centreX, 1e-6)
      // 4 px under the lowest corner, the plate is 1.4 fonts and 4 px tall, and the text is on its middle line.
      close(t.y, bottom + 4 + (px * 1.4 + 4) / 2, 1e-6)
    }
  })

  it('grows the label with the picture between 10 and 22 px', () => {
    const sizeFor = (w: number): number => {
      const { ctx } = run(docOf([pic({ path: 'dir/long.png', w, h: w, caption: 'x' })], { captions: true }), { slots })
      return Number(/(\d+(?:\.\d+)?)px/.exec(ctx.texts()[0]!.s.font)![1])
    }
    expect(sizeFor(60)).toBe(10)
    close(sizeFor(250), 15, 1e-9)
    expect(sizeFor(500)).toBe(22)
  })
})

/* --------------------------------------------------------------- notes --- */

describe('drawBoard: notes', () => {
  /** Lays out as the test says, and remembers what it was asked. */
  function stubMetrics(lines: string[]): TextMetrics & { asked: [string, number, number][] } {
    const asked: [string, number, number][] = []
    return {
      asked,
      layout(text, size, maxWidth) {
        asked.push([text, size, maxWidth])
        return { lines, width: 123, height: lines.length * size * 1.25 }
      },
    }
  }

  it('writes the lines the metrics gave, one by one, at the margin and the line height, turned with the note', () => {
    const lines = ['alpha beta', 'gamma', '', 'delta']
    const metrics = stubMetrics(lines)
    const n = note({ text: 'ignored by the stub', x: 50, y: -70, w: 300, size: 20, rotation: 30, color: 'ffcc00', fill: '112233' })
    const view = { x: 15, y: 5, zoom: 1.5 }
    const { ctx } = run(docOf([n]), { metrics, view, dpr: 2 })
    // The renderer wraps to the width inside the margins and nothing else.
    expect(metrics.asked.every((a) => a[0] === n.text && a[1] === 20 && a[2] === 300 - 2 * 10)).toBe(true)
    const texts = ctx.texts()
    expect(texts.map((t) => t.text)).toEqual(['alpha beta', 'gamma', 'delta'])
    const box = noteBox(n, metrics)
    const lineH = 20 * 1.25
    for (const [i, t] of [[0, texts[0]!], [1, texts[1]!], [3, texts[2]!]] as const) {
      const local = { x: n.x - n.w / 2 + box.pad, y: n.y - box.h / 2 + box.pad + (i + 0.5) * lineH }
      const want = dev(view, VP, 2, rotatePoint(local, { x: n.x, y: n.y }, 30))
      closePt(apply(t.s.matrix, t.x, t.y), want, 1e-6)
      expect(t.s.font).toBe(noteFont(20))
      expect(t.s.fillStyle).toBe('#ffcc00')
      expect(t.s.textAlign).toBe('left')
      expect(t.s.textBaseline).toBe('middle')
    }
    // The text is turned with the note and scaled with the view.
    const m = texts[0]!.s.matrix
    close(Math.atan2(m[1], m[0]), (30 * Math.PI) / 180, 1e-12)
    close(Math.hypot(m[0], m[1]), 1.5 * 2, 1e-12)
  })

  it('fills the note box (rounded) in its colour, and none without a fill', () => {
    const n = note({ x: 50, y: -70, w: 300, size: 20, rotation: 30, fill: 'ff0000' })
    const metrics = stubMetrics(['a', 'b'])
    const { ctx } = run(docOf([n, note({ text: 'bare', fill: '', x: 1000 })]), { metrics })
    const fills = ctx.paths('fill')
    expect(fills).toHaveLength(1)
    expect(fills[0]!.s.fillStyle).toBe('#ff0000')
    // Every straight piece of the outline lies on the turned box: |x'| = w/2 or |y'| = h/2 in the note's own frame.
    const box = noteBox(n, metrics)
    for (const seg of fills[0]!.path) {
      if (seg.t !== 'M' && seg.t !== 'L') continue
      const p = screenToBoard(VIEW, VP, { x: seg.x, y: seg.y })
      const q = rotatePoint(p, { x: n.x, y: n.y }, -30)
      const onSide = Math.abs(Math.abs(q.x - n.x) - box.w / 2) < 1e-6 || Math.abs(Math.abs(q.y - n.y) - box.h / 2) < 1e-6
      expect(onSide, JSON.stringify(seg)).toBe(true)
    }
    expect(fills[0]!.path.some((s) => s.t === 'arcTo')).toBe(true)
  })

  it('draws the fill of the note being edited but not its text', () => {
    const n = note({ text: 'being typed', fill: '222222' })
    const other = note({ text: 'other', x: 400, y: 100 })
    const { ctx } = run(docOf([n, other]), { state: state({ editingNote: n.id }) })
    expect(ctx.texts().map((t) => t.text)).toEqual(['other'])
    expect(ctx.paths('fill')).toHaveLength(1)
  })

  it('wraps by the real metrics: the drawn lines are exactly canvasTextMetrics.layout', () => {
    const measureCtx = new RecordingContext({ measure: (t, px) => [...t].length * px * 0.5 })
    const metrics = canvasTextMetrics(measureCtx)
    const n = note({ text: 'the quick brown fox jumps over the lazy dog\nsecond paragraph supercalifragilistic', w: 160, size: 16 })
    const { ctx } = run(docOf([n]), { metrics })
    const want = metrics.layout(n.text, 16, 160 - 16).lines.filter((l) => l !== '')
    expect(want.length).toBeGreaterThan(3)
    expect(ctx.texts().map((t) => t.text)).toEqual(want)
    // The note's height is the layout's (what hit testing sees too): the fill covers exactly the lines and the margins.
    const withFill = run(docOf([{ ...n, fill: '101010' }]), { metrics })
    const h = metrics.layout(n.text, 16, 144).height + 16
    const ys = withFill.ctx.paths('fill')[0]!.path.filter((s) => s.t === 'L' || s.t === 'M').map((s) => (s as { y: number }).y)
    close(Math.max(...ys) - Math.min(...ys), h, 1e-6)
  })

  it('draws only the lines that meet the canvas of a note far taller than it', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
    for (const rot of [0, 90, -37]) {
      const n = note({ text, w: 400, size: 20, rotation: rot })
      const { ctx } = run(docOf([n]))
      const texts = ctx.texts()
      expect(texts.length, `rotation ${rot}`).toBeGreaterThan(8)
      expect(texts.length).toBeLessThan(80)
      const m = texts[0]!.s.matrix
      const box = noteBox(n, estimateTextMetrics)
      const shown = new Set(texts.map((t) => t.text))
      for (let i = 0; i < 300; i++) {
        // The line runs from the note's left margin to its right edge; its text starts at the left end.
        const ly = -box.h / 2 + box.pad + (i + 0.5) * 25
        const a = apply(m, -n.w / 2 + box.pad, ly)
        const b = apply(m, n.w / 2, ly)
        const startsInside = a.x >= 0 && a.x <= 800 && a.y >= 0 && a.y <= 600
        // Both ends past the same side of the canvas by more than a line: nothing of it can show.
        const away =
          (a.x < -100 && b.x < -100) || (a.x > 900 && b.x > 900) || (a.y < -100 && b.y < -100) || (a.y > 700 && b.y > 700)
        const why = `line ${i} from ${a.x},${a.y} to ${b.x},${b.y} (rotation ${rot})`
        if (startsInside) expect(shown.has(`line ${i}`), why).toBe(true)
        if (away) expect(shown.has(`line ${i}`), why).toBe(false)
      }
    }
  })

  it('draws a bar per line, no glyphs, when the text would be under 3 px', () => {
    const n = note({ text: 'one two three\nfour\n\nfive six', w: 400, size: 20 })
    const { ctx } = run(docOf([n]), { view: { x: 0, y: 0, zoom: 0.1 } })
    expect(ctx.texts()).toHaveLength(0)
    const bars = ctx.rects('fillRect').filter((r) => r.s.fillStyle === '#ffffff')
    expect(bars).toHaveLength(3)
    expect(bars.every((b) => b.s.globalAlpha < 1)).toBe(true)
    // The longest line gets the full text width, shorter ones less.
    expect(bars[0]!.w).toBeGreaterThan(bars[1]!.w)
  })

  it('does not fail on empty text, a note of no width, or a colour that is not a colour', () => {
    const { ctx } = run(docOf([note({ text: '' }), note({ w: 0, x: 100 }), note({ color: 'zzz', text: 'odd', y: 100 })]))
    expect(ctx.texts().map((t) => t.text)).toEqual(['odd'])
    expect(ctx.texts()[0]!.s.fillStyle).toBe('#ffffff')
  })
})

/* --------------------------------------------------------------- marks --- */

describe('drawBoard: marks', () => {
  /** Device pixels per board unit of the transform a mark was stroked with. */
  const scaleOf = (p: PathRec): number => Math.hypot(p.s.matrix[0], p.s.matrix[1])

  it('strokes a pen line as one round-capped, round-joined path through the segment midpoints', () => {
    const pts = [0, 0, 100, 40, 200, 0, 300, 80, 400, 10]
    const view = { x: 20, y: 10, zoom: 1.5 }
    const { ctx } = run(docOf([stroke({ points: pts, width: 6 })]), { view, dpr: 2 })
    const s = ctx.paths('stroke')
    expect(s).toHaveLength(1)
    const d = (i: number): Vec2 => dev(view, VP, 2, { x: pts[2 * i]!, y: pts[2 * i + 1]! })
    const mid = (i: number): Vec2 => ({ x: (d(i).x + d(i + 1).x) / 2, y: (d(i).y + d(i + 1).y) / 2 })
    const path = s[0]!.path as { t: string; x: number; y: number; cx: number; cy: number }[]
    expect(path.map((p) => p.t)).toEqual(['M', 'Q', 'Q', 'Q', 'L'])
    closePt(path[0]!, d(0))
    for (let i = 1; i <= 3; i++) {
      closePt({ x: path[i]!.cx, y: path[i]!.cy }, d(i))
      closePt(path[i]!, mid(i))
    }
    closePt(path[4]!, d(4))
    expect(s[0]!.s.lineCap).toBe('round')
    expect(s[0]!.s.lineJoin).toBe('round')
    expect(s[0]!.s.strokeStyle).toBe('#ff5533')
    close(s[0]!.s.lineWidth * scaleOf(s[0]!), 6 * 1.5 * 2, 1e-9)
  })

  it('never draws a line thinner than one device pixel, and scales a wide one with the zoom', () => {
    const thin = run(docOf([stroke({ width: 0.5 }), line({ width: 0, y1: 50, y2: 50 })]), { view: { x: 0, y: 0, zoom: 0.1 }, dpr: 2 })
    for (const p of thin.ctx.paths('stroke')) close(p.s.lineWidth * scaleOf(p), 1, 1e-9)
    const wide = run(docOf([stroke({ width: 10 })]), { view: { x: 0, y: 0, zoom: 3 }, dpr: 1 })
    close(wide.ctx.paths('stroke')[0]!.s.lineWidth * scaleOf(wide.ctx.paths('stroke')[0]!), 30, 1e-9)
  })

  it('draws a tap with the pen as a dot, and an empty stroke as nothing', () => {
    const { ctx } = run(docOf([stroke({ points: [10, 20], width: 8 }), stroke({ points: [], x: 0 } as Partial<StrokeItem>)]))
    const f = ctx.paths('fill')
    expect(f).toHaveLength(1)
    const arc = f[0]!.path[0]! as { t: string; r: number }
    expect(arc.t).toBe('arc')
    expect(arc.r).toBe(4)
    expect(ctx.paths('stroke')).toHaveLength(0)
  })

  it('drops points that are closer than half a device pixel to the last, keeping the ends', () => {
    const pts: number[] = []
    for (let i = 0; i < 2000; i++) pts.push(i * 0.01, Math.sin(i) * 0.01)
    const { ctx } = run(docOf([stroke({ points: pts, width: 2 })]))
    const path = ctx.paths('stroke')[0]!.path
    // 2000 points over 20 units at zoom 1: about 40 survive, not 2000.
    expect(path.length).toBeLessThan(80)
    const end = path[path.length - 1]! as { x: number }
    close(end.x, dev(VIEW, VP, 1, { x: 1999 * 0.01, y: 0 }).x, 1e-6)
  })

  it('draws a line, and an arrow head sized from the width at the second end', () => {
    const plain = run(docOf([line({ x1: -100, y1: 0, x2: 100, y2: 0, width: 4 })])).ctx
    const shaft = plain.paths('stroke')[0]!.path as { x: number; y: number }[]
    closePt(shaft[0]!, dev(VIEW, VP, 1, { x: -100, y: 0 }))
    closePt(shaft[1]!, dev(VIEW, VP, 1, { x: 100, y: 0 }))
    expect(plain.paths('fill')).toHaveLength(0)

    const headLength = (width: number): number => {
      const { ctx } = run(docOf([line({ x1: -300, y1: 0, x2: 300, y2: 0, width, arrow: true })]))
      const tri = ctx.paths('fill')[0]!.path as { t: string; x: number; y: number }[]
      expect(tri.map((p) => p.t)).toEqual(['M', 'L', 'L', 'Z'])
      // The tip is the end point; the barbs are behind it, one on each side.
      closePt(tri[0]!, dev(VIEW, VP, 1, { x: 300, y: 0 }))
      expect(tri[1]!.x).toBeLessThan(tri[0]!.x)
      expect(tri[1]!.x).toBeCloseTo(tri[2]!.x, 9)
      expect(tri[1]!.y + tri[2]!.y).toBeCloseTo(2 * tri[0]!.y, 9)
      expect(tri[1]!.y).not.toBeCloseTo(tri[2]!.y, 3)
      expect(ctx.paths('fill')[0]!.s.fillStyle).toBe('#ffffff')
      return tri[0]!.x - tri[1]!.x
    }
    close(headLength(10) / headLength(5), 2, 1e-9)
    close(headLength(20) / headLength(5), 4, 1e-9)
  })

  it('shortens the head of an arrow too short for it, and draws a zero-length line as a dot', () => {
    const { ctx } = run(docOf([line({ x1: 0, y1: 0, x2: 6, y2: 0, width: 10, arrow: true }), line({ x1: 5, y1: 50, x2: 5, y2: 50, width: 10 })]))
    const tri = ctx.paths('fill')[0]!.path as { x: number }[]
    expect(tri[0]!.x - tri[1]!.x).toBeLessThanOrEqual(6 * 0.8 + 1e-9)
    expect((ctx.paths('fill')[1]!.path[0] as { t: string }).t).toBe('arc')
  })

  it('draws a rectangle with its fill first and its outline over it, and an ellipse through its centre', () => {
    const { ctx } = run(
      docOf([
        rectItem({ x1: 100, y1: 80, x2: 20, y2: 10, width: 6, fill: '336699', color: 'ff0000' }),
        rectItem({ x1: 0, y1: 0, x2: 10, y2: 10, fill: '' }),
        ellipseItem({ x1: -40, y1: -20, x2: 40, y2: 20, fill: '00ff00', width: 3 }),
        ellipseItem({ x1: 100, y1: 100, x2: 160, y2: 140, fill: '' }),
      ]),
    )
    const fr = ctx.rects('fillRect').filter((r) => r.s.fillStyle === '#336699')
    expect(fr).toHaveLength(1)
    const [a, b] = [rectCorners(fr[0]!), rectCorners(ctx.rects('strokeRect')[0]!)]
    for (let i = 0; i < 4; i++) closePt(a[i]!, b[i]!)
    // A reversed corner pair is the same rectangle: (20,10) to (100,80).
    closePt(a[0]!, dev(VIEW, VP, 1, { x: 20, y: 10 }))
    closePt(a[2]!, dev(VIEW, VP, 1, { x: 100, y: 80 }))
    expect(ctx.log.findIndex((r) => r === fr[0]!)).toBeLessThan(ctx.log.findIndex((r) => r === ctx.rects('strokeRect')[0]!))
    expect(ctx.rects('strokeRect')).toHaveLength(2)
    expect(ctx.rects('strokeRect')[0]!.s.strokeStyle).toBe('#ff0000')

    const ellipses = ctx.log.filter((r): r is PathRec => (r.op === 'fill' || r.op === 'stroke') && r.path.some((s) => s.t === 'ellipse'))
    expect(ellipses.map((e) => e.op)).toEqual(['fill', 'stroke', 'stroke'])
    const first = ellipses[0]!.path.find((s) => s.t === 'ellipse') as { x: number; y: number; rx: number; ry: number }
    expect([first.x, first.y, first.rx, first.ry]).toEqual([0, 0, 40, 20])
  })

  it('far from the origin, loses nothing: a mark 900,000 units out lands where the maths puts it', () => {
    const view = { x: 900_000, y: -800_000, zoom: 20 }
    const rect = rectItem({ x1: 900_000.5, y1: -800_000.25, x2: 900_002.5, y2: -799_999.25, width: 0.1 })
    const { ctx } = run(docOf([rect]), { view })
    const r = rectCorners(ctx.rects('strokeRect')[0]!)
    closePt(r[0]!, dev(view, VP, 1, { x: 900_000.5, y: -800_000.25 }), 1e-6)
    closePt(r[2]!, dev(view, VP, 1, { x: 900_002.5, y: -799_999.25 }), 1e-6)
  })
})

/* ----------------------------------------------------------------- UI --- */

describe('drawBoard: selection, handles, guides and the other editing aids', () => {
  const big = pic({ path: 'big.png', x: 20, y: 10, w: 300, h: 200, rotation: 25 })
  const slots = { 'big.png': { bitmap: makeBitmap(30, 20) } }
  const boxFor = (items: BoardItem[], zoom: number) => handlesFor(items, estimateTextMetrics, ROTATE_STALK_PX / zoom)!

  it('draws nothing of the editing aids for an export, whatever the state says', () => {
    const rich = state({
      selection: [big.id],
      box: boxFor([big], 1),
      marquee: { x: 0, y: 0, w: 50, h: 50 },
      guides: { v: [10], h: [20] },
      draft: stroke(),
      cropping: big.id,
      sample: { x: 30, y: 40, hex: 'aabbcc' },
    })
    const doc = docOf([big], { grid: 25 })
    const bare = run(doc, { slots, showUi: false })
    const withState = run(doc, { slots, showUi: false, state: rich })
    expect(withState.ctx.log).toEqual(bare.ctx.log)
    const shown = run(doc, { slots, state: rich })
    expect(shown.ctx.log.length).toBeGreaterThan(bare.ctx.log.length + 10)
  })

  it('outlines each selected item, turned with it, in one path', () => {
    const second = rectItem({ x1: -200, y1: -100, x2: -120, y2: -40, width: 10 })
    const unselected = pic({ path: 'big.png', x: 400, y: 200 })
    const { ctx } = run(docOf([big, second, unselected]), { slots, state: state({ selection: [big.id, second.id] }) })
    const outlines = ctx.paths('stroke').filter((p) => p.s.strokeStyle === '#4da3ff')
    expect(outlines).toHaveLength(1)
    const path = outlines[0]!.path
    const quad = itemQuad(big, estimateTextMetrics).map((p) => dev(VIEW, VP, 1, p))
    for (let i = 0; i < 4; i++) closePt(path[i]! as { x: number; y: number }, quad[i]!)
    expect(path[4]!.t).toBe('Z')
    expect(outlines[0]!.s.lineWidth).toBe(1)
    // The rectangle's outline is its bounds including the line's width (5 either side).
    const r = path[5] as { t: string; x: number; y: number; w: number; h: number }
    expect(r.t).toBe('rect')
    closePt({ x: r.x, y: r.y }, dev(VIEW, VP, 1, { x: -205, y: -105 }))
    expect([r.w, r.h]).toEqual([90, 70])
  })

  it('outlines only what is on screen: a selected item far off the canvas has no outline', () => {
    const away = pic({ path: 'big.png', x: 9000, y: 0 })
    const awayRect = rectItem({ x1: -9000, y1: 0, x2: -8900, y2: 50 })
    const none = run(docOf([away, awayRect]), { slots, state: state({ selection: [away.id, awayRect.id] }) })
    expect(none.ctx.paths('stroke')).toHaveLength(0)
    const some = run(docOf([big, away, awayRect]), { slots, state: state({ selection: [big.id, away.id, awayRect.id] }) })
    const outline = some.ctx.paths('stroke').filter((p) => p.s.strokeStyle === '#4da3ff')
    expect(outline).toHaveLength(1)
    expect(outline[0]!.path.map((s) => s.t)).toEqual(['M', 'L', 'L', 'L', 'Z'])
  })

  it('draws the selection box and its eight handles at 8 px whatever the zoom, turned with the box, and the rotate knob at the end of its stalk', () => {
    for (const zoom of [0.1, 0.5, 1, 4, 20]) {
      for (const dpr of [1, 2]) {
        const view = { x: 20, y: 10, zoom }
        const box = boxFor([big], zoom)
        const { ctx } = run(docOf([big]), { slots, view, dpr, state: state({ box }) })
        const handles = ctx.rects('fillRect').filter((r) => r.w === HANDLE_PX && r.h === HANDLE_PX)
        expect(handles, `zoom ${zoom}`).toHaveLength(8)
        const [tl, tr, br, bl] = box.corners.map((p) => dev(view, VP, dpr, p)) as [Vec2, Vec2, Vec2, Vec2]
        const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
        const want = [tl, tr, br, bl, mid(tl, tr), mid(tr, br), mid(bl, br), mid(tl, bl)]
        for (let i = 0; i < 8; i++) {
          const h = handles[i]!
          // 8 CSS px on the screen: 8 × dpr device pixels along each axis of the handle's own frame.
          close(Math.hypot(h.s.matrix[0], h.s.matrix[1]) * h.w, HANDLE_PX * dpr, 1e-9)
          close(Math.hypot(h.s.matrix[2], h.s.matrix[3]) * h.h, HANDLE_PX * dpr, 1e-9)
          closePt(apply(h.s.matrix, h.x + h.w / 2, h.y + h.h / 2), want[i]!, 1e-6)
          close(Math.atan2(h.s.matrix[1], h.s.matrix[0]), (box.rotation * Math.PI) / 180, 1e-9)
        }
        // The stalk runs from the middle of the top edge to the knob, 24 CSS px beyond it.
        const stalk = ctx.paths('stroke').find((p) => p.path.length === 2 && p.path[0]!.t === 'M')!
        const top = stalk.path[0] as { x: number; y: number }
        const knob = stalk.path[1] as { x: number; y: number }
        closePt(top, mid(tl, tr))
        close(Math.hypot(knob.x - top.x, knob.y - top.y), ROTATE_STALK_PX * dpr, 1e-6)
        const arc = ctx.paths('fill').find((p) => p.path[0]!.t === 'arc')!
        expect((arc.path[0] as { r: number }).r).toBe(5)
        // The knob is drawn at the end of the stalk (an arc's centre is in CSS pixels, the stalk's points in device pixels).
        closePt({ x: (arc.path[0] as { x: number }).x * dpr, y: (arc.path[0] as { y: number }).y * dpr }, knob, 1e-6)
      }
    }
  })

  it('draws a box without a rotate handle for a selection that cannot turn', () => {
    const r = rectItem()
    const box = handlesFor([r], estimateTextMetrics, 24)!
    expect(box.rotateHandle).toBeNull()
    const { ctx } = run(docOf([r]), { state: state({ box }) })
    expect(ctx.paths('fill').some((p) => p.path[0]!.t === 'arc')).toBe(false)
    expect(ctx.rects('fillRect').filter((x) => x.w === HANDLE_PX)).toHaveLength(8)
  })

  it('draws alignment guides as 1 device pixel lines across the whole canvas, on a pixel centre', () => {
    const view = { x: 5.3, y: 7.7, zoom: 1.7 }
    for (const dpr of [1, 2]) {
      const { ctx } = run(docOf([]), { view, dpr, state: state({ guides: { v: [12.34, -50], h: [99.9] } }) })
      const g = ctx.paths('stroke').filter((p) => isMagenta(p.s.strokeStyle))
      expect(g).toHaveLength(1)
      const segs = g[0]!.path as { t: string; x: number; y: number }[]
      expect(segs.map((s) => s.t)).toEqual(['M', 'L', 'M', 'L', 'M', 'L'])
      close(g[0]!.s.lineWidth * dpr, 1, 1e-12)
      for (const [i, bx] of [[0, 12.34], [2, -50]] as const) {
        const sx = boardToScreen(view, VP, { x: bx, y: 0 }).x
        const want = (Math.floor(sx * dpr) + 0.5) / dpr
        expect(segs[i]!.x / dpr).toBeCloseTo(want, 9)
        expect(segs[i]!.y).toBe(0)
        expect(segs[i + 1]!.x).toBe(segs[i]!.x)
        expect(segs[i + 1]!.y / dpr).toBe(VP.h)
      }
      const sy = boardToScreen(view, VP, { x: 0, y: 99.9 }).y
      expect(segs[4]!.y / dpr).toBeCloseTo((Math.floor(sy * dpr) + 0.5) / dpr, 9)
      expect(segs[5]!.x / dpr).toBe(VP.w)
    }
  })

  it('draws the marquee as a translucent rectangle with a border, however it was dragged', () => {
    const view = { x: 10, y: 10, zoom: 2 }
    const { ctx } = run(docOf([]), { view, state: state({ marquee: { x: 60, y: 50, w: -40, h: -30 } }) })
    const fill = ctx.rects('fillRect').find((r) => String(r.s.fillStyle).startsWith('rgba('))!
    expect(String(fill.s.fillStyle)).toMatch(/^rgba\(\d+,\d+,\d+,0\.\d+\)$/)
    const c = rectCorners(fill)
    closePt(c[0]!, dev(view, VP, 1, { x: 20, y: 20 }))
    closePt(c[2]!, dev(view, VP, 1, { x: 60, y: 50 }))
    expect(ctx.rects('strokeRect')).toHaveLength(1)
  })

  it('draws the mark being drawn, over the board', () => {
    const draft = stroke({ points: [0, 0, 50, 50, 100, 20], color: '00ff88', width: 5 })
    const { ctx } = run(docOf([rectItem()]), { state: state({ draft }) })
    const s = ctx.paths('stroke').filter((p) => p.s.strokeStyle === '#00ff88')
    expect(s).toHaveLength(1)
    // After the board's own items.
    expect(ctx.log.indexOf(s[0]!)).toBeGreaterThan(ctx.log.indexOf(ctx.rects('strokeRect')[0]!))
    const without = run(docOf([rectItem()]), { state: state({ draft: null }) })
    expect(without.ctx.paths('stroke').some((p) => p.s.strokeStyle === '#00ff88')).toBe(false)
  })

  it('draws the sampler as a ring of the colour at the pointer with its hex beside it', () => {
    const { ctx } = run(docOf([]), { state: state({ sample: { x: 300, y: 200, hex: 'ff8040' } }) })
    const ring = ctx.paths('fill').find((p) => p.s.fillStyle === '#ff8040' && p.path.filter((s) => s.t === 'arc').length === 2)!
    expect(ring.rule).toBe('evenodd')
    const [outer, inner] = ring.path as { x: number; y: number; r: number; ccw: boolean }[]
    expect([outer!.x, outer!.y, inner!.x, inner!.y]).toEqual([300, 200, 300, 200])
    expect(outer!.r).toBeGreaterThan(inner!.r)
    const label = ctx.texts()
    expect(label.map((t) => t.text)).toEqual(['#FF8040'])
    // Dark colour: light text on it; light colour: dark text.
    expect(label[0]!.s.fillStyle).toBe('#000000')
    const dark = run(docOf([]), { state: state({ sample: { x: 300, y: 200, hex: '102030' } }) })
    expect(dark.ctx.texts()[0]!.s.fillStyle).toBe('#ffffff')
    // Near the bottom edge the label goes above the ring, never off the canvas.
    const edge = run(docOf([]), { state: state({ sample: { x: 790, y: 590, hex: 'ff8040' } }) })
    expect(edge.ctx.texts()[0]!.y).toBeLessThan(590)
    const lab = edge.ctx.paths('fill').find((p) => p.s.fillStyle === '#ff8040' && p.path[0]!.t === 'M')!
    expect(Math.max(...lab.path.filter((s) => s.t === 'L').map((s) => (s as { x: number }).x))).toBeLessThanOrEqual(800)
  })

  it('draws a grid at a view so far out that counting from one line to the next does not move (it must not loop for ever)', () => {
    // 1e300 / 25 has no neighbour in doubles: the loop used to stand still on its first line, forever.
    const { ctx } = run(docOf([], { grid: 25 }), { view: { x: 0, y: 1e300, zoom: 1.2 } })
    expect(ctx.paths('stroke').every((p) => p.path.length < 2 * (800 + 600))).toBe(true)
    const wild = run(docOf([], { grid: 1e-3 }), { view: { x: 1e15, y: -1e15, zoom: 2 } })
    expect(wild.ctx.paths('stroke').every((p) => p.path.length < 2 * (800 + 600))).toBe(true)
  })

  it('draws grid lines light on a dark board and dark on a light one', () => {
    const lines = (bg: string) => run(docOf([], { grid: 50, bg })).ctx.paths('stroke')[0]!.s.strokeStyle
    expect(lines('14161d')).toBe('#ffffff')
    expect(lines('f4f4f0')).toBe('#000000')
  })

  it('keeps the contract sizes: handles of 8 px, a rotate stalk of 24 px', () => {
    expect(HANDLE_PX).toBe(8)
    expect(ROTATE_STALK_PX).toBe(24)
  })

  it('draws a grid only when asked, on whole multiples, fading out finer than 6 px and gone at 2 px', () => {
    const view = { x: 3, y: 4, zoom: 1 }
    const strokes = (grid: number, zoom: number, showUi = true) => {
      const { ctx } = run(docOf([], { grid }), { view: { ...view, zoom }, showUi })
      return ctx.paths('stroke')
    }
    expect(strokes(0, 1)).toHaveLength(0)
    expect(strokes(50, 1, false)).toHaveLength(0)
    const full = strokes(50, 1)
    expect(full).toHaveLength(1)
    // Vertical lines first, at every multiple of 50 inside the canvas (board x -397 .. 403: -350 .. 400), on pixel centres.
    const verticals = (full[0]!.path as { t: string; x: number; y: number }[]).filter((s) => s.t === 'M' && s.y === 0)
    const multiples = Array.from({ length: 16 }, (_, i) => -350 + 50 * i)
    expect(verticals.map((s) => s.x)).toEqual(multiples.map((b) => Math.floor(boardToScreen(view, VP, { x: b, y: 0 }).x) + 0.5))
    const alpha = (grid: number, zoom: number) => strokes(grid, zoom)[0]?.s.globalAlpha ?? 0
    expect(alpha(50, 1)).toBeGreaterThan(0)
    expect(alpha(5, 1)).toBeLessThan(alpha(5, 2) + 1e-9)
    expect(alpha(5, 1)).toBeGreaterThan(0)
    expect(alpha(5, 1)).toBeLessThan(alpha(50, 1))
    expect(alpha(5, 6 / 5)).toBeCloseTo(alpha(50, 1), 9)
    expect(strokes(2, 1)).toHaveLength(0)
    expect(strokes(1, 1)).toHaveLength(0)
    // However fine the grid, the number of lines is bounded by the canvas.
    const dense = strokes(2.01, 1)
    expect((dense[0]?.path.length ?? 0)).toBeLessThan(2 * (800 + 600))
  })
})

describe('drawBoard: the crop overlay', () => {
  it('shows the whole picture dimmed round the crop, and the crop frame, thirds and marks on the shown part', () => {
    for (const [flipH, flipV, rotation] of [[false, false, 0], [true, false, 0], [false, true, 90], [true, true, 33]] as const) {
      const crop = { l: 0.1, t: 0.3, r: 0.5, b: 0.8 }
      const item = pic({ path: 'c.png', x: 40, y: -30, w: 400, h: 300, crop, flipH, flipV, rotation })
      const bmp = makeBitmap(80, 60)
      const view = { x: 40, y: -30, zoom: 1.25 }
      const { ctx } = run(docOf([item]), { view, dpr: 2, slots: { 'c.png': { bitmap: bmp } }, state: state({ cropping: item.id }) })

      const draws = ctx.drawImages()
      expect(draws).toHaveLength(2)
      // 1: the picture as shown; 2: the whole picture, behind a clip that leaves the crop rectangle out.
      const whole = draws[1]!
      expect([whole.sx, whole.sy, whole.sw, whole.sh]).toEqual([0, 0, 80, 60])
      const centre = { x: item.x, y: item.y }
      const offset = { x: (0.5 - (crop.l + crop.r) / 2) * item.w * (flipH ? -1 : 1), y: (0.5 - (crop.t + crop.b) / 2) * item.h * (flipV ? -1 : 1) }
      const fullCentre = rotatePoint({ x: centre.x + offset.x, y: centre.y + offset.y }, centre, rotation)
      const want = [
        { x: -item.w / 2, y: -item.h / 2 },
        { x: item.w / 2, y: -item.h / 2 },
        { x: item.w / 2, y: item.h / 2 },
        { x: -item.w / 2, y: item.h / 2 },
      ].map((c) => dev(view, VP, 2, rotatePoint({ x: fullCentre.x + c.x, y: fullCentre.y + c.y }, fullCentre, rotation)))
      const got = destCorners(whole)
      const map = { none: [0, 1, 2, 3], h: [1, 0, 3, 2], v: [3, 2, 1, 0], hv: [2, 3, 0, 1] }[`${flipH ? 'h' : ''}${flipV ? 'v' : ''}` || 'none']!
      for (let i = 0; i < 4; i++) closePt(got[i]!, want[map[i]!]!, 1e-6)

      const clip = ctx.paths('clip')
      expect(clip).toHaveLength(1)
      expect(clip[0]!.rule).toBe('evenodd')
      expect(clip[0]!.path.map((s) => s.t)).toEqual(['rect', 'rect'])
      expect(whole.s.clips).toBe(1)
      expect(draws[0]!.s.clips).toBe(0)
      // The veil covers the whole picture inside that clip.
      const veil = ctx.rects('fillRect').find((r) => r.s.clips === 1)!
      expect([veil.w, veil.h]).toEqual([item.w, item.h])

      // The frame is the shown part's quad; thirds are two lines each way.
      const quad = itemQuad(item, estimateTextMetrics).map((p) => dev(view, VP, 2, p))
      const strokes = ctx.paths('stroke')
      const frame = strokes.find((p) => p.path.length === 5 && p.path[4]!.t === 'Z')!
      for (let i = 0; i < 4; i++) closePt(frame.path[i] as { x: number; y: number }, quad[i]!)
      const thirds = strokes.find((p) => p.path.length === 8 && p.s.lineWidth === 1 && p !== frame)!
      expect(thirds.path.map((s) => s.t)).toEqual(['M', 'L', 'M', 'L', 'M', 'L', 'M', 'L'])
      // Crop marks: an L's two arms per corner and a bar per edge (3 strokes a corner), all in white, 3 px wide.
      const marks = strokes.find((p) => p.s.lineWidth === 3)!
      expect(marks.path).toHaveLength(4 * 6)
      expect(marks.s.strokeStyle).toBe('#ffffff')
      for (let i = 0; i < 4; i++) closePt(marks.path[i * 6] as { x: number; y: number }, quad[i]!)
    }
  })

  it('does not outline the picture being cropped as a selection, and does nothing for a missing or non-picture id', () => {
    const item = pic({ path: 'c.png' })
    const slots = { 'c.png': { bitmap: makeBitmap(8, 8) } }
    const a = run(docOf([item]), { slots, state: state({ selection: [item.id], cropping: item.id }) })
    expect(a.ctx.paths('stroke').filter((p) => p.s.strokeStyle === '#4da3ff')).toHaveLength(0)
    const n = note()
    const b = run(docOf([n]), { state: state({ cropping: n.id }) })
    const c = run(docOf([n]), { state: state({ cropping: 424242 }) })
    expect(b.ctx.paths('clip')).toHaveLength(0)
    expect(c.ctx.paths('clip')).toHaveLength(0)
  })
})

describe('drawBoard: purity', () => {
  it('draws the same twice, never touches its arguments, and survives numbers gone bad', () => {
    const freeze = <T>(v: T): T => {
      if (v && typeof v === 'object' && !Object.isFrozen(v)) {
        Object.freeze(v)
        for (const x of Object.values(v)) freeze(x)
      }
      return v
    }
    const items: BoardItem[] = [
      pic({ path: 'a.png', rotation: 12, flipH: true, gray: true, opacity: 0.6, caption: 'cap' }),
      note({ text: 'some words to wrap round the box', fill: '223344' }),
      stroke({ points: [0, 0, 10, 10, 30, 0] }),
      line({ arrow: true }),
      rectItem({ fill: '445566' }),
      ellipseItem({ fill: '665544' }),
      pic({ path: 'a.png', x: Number.NaN }),
      pic({ path: 'a.png', w: Number.POSITIVE_INFINITY }),
      rectItem({ x1: Number.NaN }),
      stroke({ points: [Number.NaN, 0, 5, 5], width: Number.NaN }),
      ellipseItem({ x2: Number.POSITIVE_INFINITY }),
    ]
    const doc = freeze(docOf(items, { captions: true, grid: 20 }))
    const st = freeze(state({ selection: [items[0]!.id, items[1]!.id], box: { corners: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }], rotateHandle: { x: 2, y: -9 }, rotation: 10 }, guides: { v: [1], h: [2] }, marquee: { x: 0, y: 0, w: 4, h: 4 }, sample: { x: 1, y: 1, hex: 'abcdef' } }))
    const slots = { 'a.png': { bitmap: makeBitmap(20, 10) } }
    const one = run(doc, { state: st, slots })
    const two = run(doc, { state: st, slots })
    expect(two.ctx.log).toEqual(one.ctx.log)
    expect(one.ctx.depth).toBe(0)
  })

  it('survives numbers gone bad everywhere (NaN, infinities, negatives, huge, tiny) without a throw, a stray matrix or an unbalanced save', () => {
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, 0, 1e300, -1e300, 1e-300, 7]
    const seeds = Number(process.env['BOARD_FUZZ_SEEDS'] ?? 300)
    for (let seed = 1; seed <= seeds; seed++) {
      const r = rng(seed * 31)
      const num = (normal: number): number => (r() < 0.25 ? bad[Math.floor(r() * bad.length)]! : normal)
      const items: BoardItem[] = []
      for (let i = 0; i < 8; i++) {
        const k = Math.floor(r() * 6)
        const common = { x: num((r() - 0.5) * 600), y: num((r() - 0.5) * 400) }
        if (k === 0) items.push(pic({ ...common, w: num(50 + r() * 200), h: num(50 + r() * 200), rotation: num(r() * 360), opacity: num(r()), crop: { l: num(0.1), t: num(0.1), r: num(0.9), b: num(0.9) } }))
        else if (k === 1) items.push(note({ ...common, w: num(150), size: num(16), rotation: num(20), text: r() < 0.5 ? '' : 'some words to wrap\nand more' }))
        else if (k === 2) items.push(stroke({ points: [num(0), num(0), num(30), num(40), num(90)], width: num(4) }))
        else if (k === 3) items.push(line({ x1: num(0), y1: num(0), x2: num(80), y2: num(30), width: num(5), arrow: r() < 0.5 }))
        else if (k === 4) items.push(rectItem({ x1: num(0), y1: num(0), x2: num(80), y2: num(50), width: num(3), fill: r() < 0.5 ? '' : '224466' }))
        else items.push(ellipseItem({ x1: num(0), y1: num(0), x2: num(80), y2: num(50), width: num(3), fill: r() < 0.5 ? '' : '224466' }))
      }
      const ctx = new RecordingContext()
      const view = { x: num(0), y: num(0), zoom: num(1.2) }
      const st = state({
        selection: items.map((i) => i.id),
        box: { corners: [{ x: num(0), y: num(0) }, { x: num(50), y: num(0) }, { x: num(50), y: num(50) }, { x: num(0), y: num(50) }], rotateHandle: { x: num(0), y: num(-20) }, rotation: num(10) },
        marquee: { x: num(0), y: num(0), w: num(30), h: num(30) },
        guides: { v: [num(5)], h: [num(9)] },
        sample: { x: num(10), y: num(10), hex: r() < 0.3 ? 'zz' : 'a1b2c3' },
        cropping: items[0]!.id,
        draft: stroke({ points: [num(0), num(0), num(50), num(50)], width: num(3) }),
      })
      const doc = docOf(items, { captions: r() < 0.5, grid: num(25), bg: r() < 0.3 ? 'nope' : '223344' })
      const dpr = num(1)
      expect(() => run(doc, { ctx, view, dpr, state: st, slots: { 'a.png': { bitmap: makeBitmap(20, 10) } } }), `seed ${seed}`).not.toThrow()
      expect(ctx.depth, `seed ${seed}`).toBe(0)
      expect(ctx.underflows).toBe(0)
      expect(ctx.badTransforms, `seed ${seed}: a matrix that is not finite: ${ctx.badTransformAt}`).toBe(0)
    }
  })

  it('draws nothing of an item whose size is not finite, and does not ask the cache for it', () => {
    const inf = Number.POSITIVE_INFINITY
    const items: BoardItem[] = [
      pic({ path: 'inf.png', w: inf }),
      pic({ path: 'ok.png', x: 300 }),
      note({ w: inf, text: 'wide', fill: '112233' }),
      rectItem({ x2: inf }),
      stroke({ width: inf }),
      ellipseItem({ y2: inf, fill: '445566' }),
    ]
    const slots = { 'inf.png': { bitmap: makeBitmap(4, 4) }, 'ok.png': { bitmap: makeBitmap(4, 4) } }
    const { ctx, images } = run(docOf(items), { slots, state: state({ cropping: items[0]!.id, selection: items.map((i) => i.id) }) })
    expect(images.calls.map((c) => c.path)).toEqual(['ok.png'])
    expect(ctx.drawImages()).toHaveLength(1)
    expect(ctx.texts()).toHaveLength(0)
    expect(ctx.paths('clip')).toHaveLength(0)
    expect(ctx.rects('strokeRect')).toHaveLength(0)
    expect(ctx.paths('fill')).toHaveLength(0)
    // The mark being drawn is not culled by position, so the size check is what keeps a broken one off the canvas.
    const draft = run(docOf([]), { state: state({ draft: rectItem({ x2: inf }) }) })
    expect(draft.ctx.rects('strokeRect')).toHaveLength(0)
  })

  it('draws nothing for an empty canvas and falls back to density 1 for a bad one', () => {
    const empty = run(docOf([pic()]), { viewport: { w: 0, h: 0 } })
    expect(empty.ctx.log).toHaveLength(0)
    const slots = { 'a.png': { bitmap: makeBitmap(4, 4) } }
    const bad = run(docOf([pic()]), { dpr: Number.NaN, slots })
    const good = run(docOf([pic()]), { dpr: 1, slots })
    expect(bad.ctx.drawImages()[0]!.s.matrix).toEqual(good.ctx.drawImages()[0]!.s.matrix)
  })

  it('paints the board colour first, or clears, or leaves the canvas alone', () => {
    const fill = run(docOf([], { bg: 'ffffff' }))
    expect(fill.ctx.rects('fillRect')[0]).toMatchObject({ x: 0, y: 0, w: 800, h: 600 })
    expect(fill.ctx.rects('fillRect')[0]!.s.fillStyle).toBe('#ffffff')
    const bad = run(docOf([], { bg: 'nope' }))
    expect(bad.ctx.rects('fillRect')[0]!.s.fillStyle).toBe('#14161d')
    const clear = run(docOf([]), { backdrop: 'clear' })
    expect(clear.ctx.rects('clearRect')).toHaveLength(1)
    expect(clear.ctx.rects('fillRect')).toHaveLength(0)
    const keep = run(docOf([]), { backdrop: 'keep' })
    expect(keep.ctx.log.filter((r) => r.op === 'fillRect' || r.op === 'clearRect')).toHaveLength(0)
  })

  it('scales the board by dpr as a whole: the canvas backing store is dpr times the viewport', () => {
    const { ctx } = run(docOf([]), { dpr: 2 })
    expect(ctx.rects('fillRect')[0]!.s.matrix).toEqual([2, 0, 0, 2, 0, 0])
  })
})

/* ---------------------------------------------------- text measuring --- */

describe('canvasTextMetrics', () => {
  /** A font where every code point is `em` wide. */
  const fixed = (em: number) => new RecordingContext({ measure: (t, px) => [...t].length * px * em })

  it('wraps at spaces like the estimate does when its glyphs are as wide as the estimate thinks', () => {
    const words = ['a', 'bc', 'def', 'ghij', 'klmno', 'pqrstu', 'supercalifragilisticexpialidocious', 'x', '']
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed)
      const paragraphs: string[] = []
      for (let p = 0; p < 1 + Math.floor(r() * 3); p++) {
        const n = Math.floor(r() * 14)
        paragraphs.push(Array.from({ length: n }, () => words[Math.floor(r() * words.length)]!).join(' '))
      }
      const text = paragraphs.join('\n')
      const size = 8 + r() * 40
      const maxWidth = size * 0.55 * (1.5 + r() * 25) + 0.013
      const m = canvasTextMetrics(fixed(0.55))
      const got = m.layout(text, size, maxWidth)
      const want = estimateTextMetrics.layout(text, size, maxWidth)
      expect(got.lines, `seed ${seed}: ${JSON.stringify(text)} at ${size}/${maxWidth}`).toEqual(want.lines)
      close(got.height, want.height, 1e-9)
      close(got.width, want.width, 1e-6)
    }
  })

  it('breaks a word wider than the line where it fills it, with at least one character a line, and keeps surrogate pairs whole', () => {
    const m = canvasTextMetrics(fixed(0.5))
    // 10 px glyphs are 5 wide; a line of 12 holds two.
    expect(m.layout('abcdefg', 10, 12).lines).toEqual(['ab', 'cd', 'ef', 'g'])
    // A line narrower than one glyph still takes one.
    expect(m.layout('abc', 10, 1).lines).toEqual(['a', 'b', 'c'])
    expect(m.layout('a😀b😀c', 10, 12).lines).toEqual(['a😀', 'b😀', 'c'])
    expect(m.layout('ab cdefg', 10, 12).lines).toEqual(['ab', 'cd', 'ef', 'g'])
  })

  it('keeps line breaks and empty lines, turns an empty text into one empty line, and measures a line by its real width', () => {
    const m = canvasTextMetrics(fixed(0.5))
    expect(m.layout('', 10, 100).lines).toEqual([''])
    expect(m.layout('a\n\nb\r\nc', 10, 100).lines).toEqual(['a', '', 'b', 'c'])
    const l = m.layout('aaaa\nbb', 10, 100)
    close(l.width, 20, 1e-9)
    close(l.height, 2 * 10 * 1.25, 1e-9)
    const proportional = new RecordingContext({ measure: (t, px) => [...t].reduce((w, ch) => w + (ch === 'i' ? 0.25 : 0.75) * px, 0) })
    const p = canvasTextMetrics(proportional)
    // "iiiiiiii" is 2 em wide, "wwww" 3 em: eight i's fit a 3.5 em line (with room to spare), but not next to the w's; in 2.5 em the w's break.
    expect(p.layout('iiiiiiii wwww', 10, 35).lines).toEqual(['iiiiiiii', 'wwww'])
    expect(p.layout('wwww', 10, 25).lines).toEqual(['www', 'w'])
    // A space is 0.75 em here: eight i's, a space and two i's are 3.25 em and share a 3.5 em line; four i's more do not.
    expect(p.layout('iiiiiiii ii', 10, 35).lines).toEqual(['iiiiiiii ii'])
    expect(p.layout('iiiiiiii iiii', 10, 35).lines).toEqual(['iiiiiiii', 'iiii'])
  })

  it('gives the same lines at every size when the width is scaled with it, and sizes its answer by the size', () => {
    const m = canvasTextMetrics(fixed(0.55))
    const base = m.layout('the quick brown fox jumps over', 10, 55).lines
    for (const k of [0.5, 2, 7.3, 40]) expect(m.layout('the quick brown fox jumps over', 10 * k, 55 * k).lines).toEqual(base)
    close(m.layout('abc', 20, 1000).height, 25, 1e-9)
  })

  it('does not wrap without a width and does not measure without a size', () => {
    const m = canvasTextMetrics(fixed(0.5))
    expect(m.layout('a b c d e f', 10, Infinity).lines).toEqual(['a b c d e f'])
    const z = m.layout('a b\nc', 0, 100)
    expect(z.lines).toEqual(['a b', 'c'])
    expect([z.width, z.height]).toEqual([0, 0])
    expect(m.layout('a', Number.NaN, 100).height).toBe(0)
  })

  it('breaks a very long word into one-glyph lines without measuring the rest of the word for every line', () => {
    let measured = 0
    const ctx = new RecordingContext({
      measure: (t, px) => {
        measured += t.length
        return t.length * px * 0.5
      },
    })
    const m = canvasTextMetrics(ctx)
    const word = 'x'.repeat(4000)
    const l = m.layout(word, 10, 5)
    expect(l.lines).toHaveLength(4000)
    expect(l.lines.every((x) => x === 'x')).toBe(true)
    // A line costs a few short measures; scanning what is left of the word each time would be 4000 × 4000 / 2.
    expect(measured).toBeLessThan(4000 * 40)
    // And at a width of 37 glyphs the lines are 37 long, the last one the rest.
    const wide = m.layout(word, 10, 37 * 5).lines
    expect(wide.slice(0, -1).every((x) => x.length === 37)).toBe(true)
    expect(wide.join('')).toBe(word)
  })

  it('keeps the context font as it found it, even when measuring in the middle of a draw', () => {
    const ctx = fixed(0.5)
    ctx.font = '13px serif'
    const m = canvasTextMetrics(ctx)
    m.layout('some text to wrap', 10, 20)
    expect(ctx.font).toBe('13px serif')
  })

  it('answers the same question from its cache, bounded to TEXT_CACHE_ENTRIES layouts', () => {
    const ctx = fixed(0.5)
    const m = canvasTextMetrics(ctx)
    const first = m.layout('first text', 10, 50)
    const calls = ctx.measures
    expect(m.layout('first text', 10, 50)).toBe(first)
    expect(ctx.measures).toBe(calls)
    // Another size or width is another answer, and both are kept.
    const other = m.layout('first text', 12, 50)
    expect(other).not.toBe(first)
    expect(m.layout('first text', 10, 50)).toBe(first)
    expect(m.layout('first text', 12, 50)).toBe(other)
    expect(m.size).toBe(2)

    for (let i = 0; i < 3 * TEXT_CACHE_ENTRIES; i++) m.layout(`text number ${i}`, 10, 50)
    expect(m.size).toBeLessThanOrEqual(TEXT_CACHE_ENTRIES)
    expect(m.size).toBeGreaterThan(TEXT_CACHE_ENTRIES / 2)
    // The oldest is gone (measured again), the newest is held (not measured again).
    ctx.clearLog()
    m.layout(`text number ${3 * TEXT_CACHE_ENTRIES - 1}`, 10, 50)
    expect(ctx.measures).toBe(0)
    m.layout('first text', 10, 50)
    expect(ctx.measures).toBeGreaterThan(0)
  })

  it('bounds the sizes it keeps for one text, so a note dragged wider does not fill the cache', () => {
    const m = canvasTextMetrics(fixed(0.5))
    for (let w = 20; w < 20 + 500; w++) m.layout('one note being resized', 10, w)
    expect(m.size).toBeLessThanOrEqual(8)
  })

  it('hands out layouts nobody can change', () => {
    const m = canvasTextMetrics(fixed(0.5))
    const l = m.layout('a b c', 10, 5)
    expect(Object.isFrozen(l)).toBe(true)
    expect(Object.isFrozen(l.lines)).toBe(true)
  })

  it('is consistent with how drawBoard draws: the note box is as tall as the lines drawn', () => {
    const m = canvasTextMetrics(fixed(0.5))
    const n = note({ text: 'one two three four five six seven', w: 100, size: 10 })
    const { ctx } = run(docOf([{ ...n, fill: '222222' }]), { metrics: m })
    const lines = m.layout(n.text, 10, 90).lines
    expect(ctx.texts().map((t) => t.text)).toEqual(lines)
    const ys = ctx.paths('fill')[0]!.path.filter((s) => s.t === 'M' || s.t === 'L').map((s) => (s as { y: number }).y)
    close(Math.max(...ys) - Math.min(...ys), lines.length * 12.5 + 10, 1e-9)
  })
})

/* -------------------------------------------------------------- export --- */

describe('exportBoard', () => {
  interface Made {
    canvas: ExportCanvas & { ctx: RecordingContext | null }
  }

  function makeCanvasFactory(opts: { noContext?: boolean } = {}): { make: (w: number, h: number) => ExportCanvas; made: Made['canvas'][] } {
    const made: Made['canvas'][] = []
    return {
      made,
      make: (w, h) => {
        const ctx = opts.noContext ? null : new RecordingContext()
        const c = { width: w, height: h, ctx, getContext: () => ctx }
        made.push(c)
        return c
      },
    }
  }

  /** Full-size bitmaps by path, remembering how many are open at once. */
  function bitmaps(sizes: Record<string, [number, number]>) {
    const state = { open: 0, peak: 0, closed: 0, asked: [] as string[], released: [] as string[] }
    const images: ExportImages = {
      async get(path) {
        state.asked.push(path)
        const s = sizes[path]
        if (!s) return null
        const b = makeBitmap(s[0], s[1], path)
        state.open++
        state.peak = Math.max(state.peak, state.open)
        const close = b.close.bind(b)
        b.close = () => {
          state.open--
          state.closed++
          close()
        }
        return b
      },
    }
    return { images, state }
  }

  it('is null for an empty board, an empty selection, ids that are not there, and a canvas without a context', async () => {
    const f = makeCanvasFactory()
    const { images } = bitmaps({})
    expect(await exportBoard(docOf([]), null, 1, images, f.make, estimateTextMetrics)).toBeNull()
    const doc = docOf([pic()])
    expect(await exportBoard(doc, [], 1, images, f.make, estimateTextMetrics)).toBeNull()
    expect(await exportBoard(doc, [31337], 1, images, f.make, estimateTextMetrics)).toBeNull()
    expect(f.made).toHaveLength(0)
    const none = makeCanvasFactory({ noContext: true })
    expect(await exportBoard(doc, null, 1, images, none.make, estimateTextMetrics)).toBeNull()
  })

  it('makes a canvas as large as the items at the scale asked for, with the picture exactly in place', async () => {
    const item = pic({ path: 'a.png', x: 500, y: -300, w: 200, h: 100 })
    const other = pic({ path: 'b.png', x: 5000, y: 5000, w: 50, h: 50 })
    const f = makeCanvasFactory()
    const { images, state } = bitmaps({ 'a.png': [400, 200], 'b.png': [10, 10] })
    const out = (await exportBoard(docOf([item, other]), [item.id], 2, images, f.make, estimateTextMetrics, { margin: 10 }))!
    expect([out.width, out.height, out.scale]).toEqual([2 * 200 + 20, 2 * 100 + 20, 2])
    expect([out.canvas.width, out.canvas.height]).toEqual([420, 220])
    const ctx = f.made[0]!.ctx!
    const rec = ctx.drawImages()
    expect(rec).toHaveLength(1)
    const c = destCorners(rec[0]!)
    closePt(c[0]!, { x: 10, y: 10 })
    closePt(c[2]!, { x: 410, y: 210 })
    // Only what was chosen is read: the other picture is never loaded.
    expect(state.asked).toEqual(['a.png'])
  })

  it('reduces the scale so the longer side never passes maxSide, margin included', async () => {
    const wide = pic({ path: 'w.png', w: 10000, h: 5000 })
    const { images } = bitmaps({ 'w.png': [100, 50] })
    for (const [scale, margin, maxSide, wantScale] of [
      [2, 0, 8192, 8192 / 10000],
      [1, 0, 8192, 0.8192],
      [0.5, 0, 8192, 0.5],
      [3, 40, 4096, (4096 - 80) / 10000],
      [10, 0, 100, 0.01],
    ] as const) {
      const f = makeCanvasFactory()
      const out = (await exportBoard(docOf([wide]), null, scale, images, f.make, estimateTextMetrics, { margin, maxSide }))!
      expect(out.scale).toBeCloseTo(wantScale, 12)
      expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(maxSide)
      expect(out.width).toBeGreaterThanOrEqual(Math.floor(10000 * out.scale + 2 * margin))
    }
    const f = makeCanvasFactory()
    const dflt = (await exportBoard(docOf([wide]), null, 4, images, f.make, estimateTextMetrics))!
    expect(dflt.width).toBe(8192)
    expect(dflt.height).toBe(Math.ceil(5000 * (8192 / 10000)))
    // A nonsense scale is 1.
    const small = pic({ path: 'w.png', w: 300, h: 200 })
    const odd = (await exportBoard(docOf([small]), null, Number.NaN, images, f.make, estimateTextMetrics))!
    expect(odd.scale).toBe(1)
    expect([odd.width, odd.height]).toEqual([300, 200])
  })

  it('leaves room for the captions under pictures, still inside maxSide', async () => {
    const item = pic({ path: 'a.png', w: 400, h: 300, caption: 'under' })
    const { images } = bitmaps({ 'a.png': [40, 30] })
    const f = makeCanvasFactory()
    const on = (await exportBoard(docOf([item], { captions: true }), null, 1, images, f.make, estimateTextMetrics))!
    const off = (await exportBoard(docOf([item], { captions: false }), null, 1, images, makeCanvasFactory().make, estimateTextMetrics))!
    expect([on.width, off.width]).toEqual([400, 400])
    expect(off.height).toBe(300)
    // 18 px label (a 300 px picture: 6%), 1.4 × + 4 tall, 4 px gap.
    expect(on.height).toBe(Math.ceil(300 + 4 + 18 * 1.4 + 4))
    expect(f.made[0]!.ctx!.texts().map((t) => t.text)).toEqual(['under'])
    const tight = (await exportBoard(docOf([pic({ path: 'a.png', w: 400, h: 400, caption: 'x' })], { captions: true }), null, 5, images, makeCanvasFactory().make, estimateTextMetrics, { maxSide: 500 }))!
    expect(Math.max(tight.width, tight.height)).toBeLessThanOrEqual(500)
  })

  it('draws as the board shows it, without editing aids, background first or none', async () => {
    const item = pic({ path: 'a.png', x: 0, y: 0, w: 100, h: 100, gray: true, rotation: 20, flipH: true })
    const { images } = bitmaps({ 'a.png': [100, 100] })
    const f1 = makeCanvasFactory()
    const out = (await exportBoard(docOf([item, note({ text: 'hi', x: 120 })], { bg: '224466', grid: 10 }), null, 1, images, f1.make, estimateTextMetrics))!
    expect(out).not.toBeNull()
    const ctx = f1.made[0]!.ctx!
    expect(ctx.rects('fillRect')[0]!.s.fillStyle).toBe('#224466')
    expect(ctx.drawImages()[0]!.s.filter).toBe('grayscale(1)')
    expect(ctx.paths('stroke')).toHaveLength(0)
    expect(ctx.texts().map((t) => t.text)).toEqual(['hi'])

    const f2 = makeCanvasFactory()
    await exportBoard(docOf([item], { bg: '224466' }), null, 1, images, f2.make, estimateTextMetrics, { background: false })
    const clear = f2.made[0]!.ctx!
    expect(clear.rects('clearRect')).toHaveLength(1)
    expect(clear.rects('fillRect').filter((r) => r.s.fillStyle === '#224466')).toHaveLength(0)
  })

  it('draws the chosen items in board order and nothing else', async () => {
    const a = pic({ path: 'a.png', x: 0 })
    const b = pic({ path: 'b.png', x: 300 })
    const c = pic({ path: 'c.png', x: 600 })
    const { images, state } = bitmaps({ 'a.png': [10, 10], 'b.png': [10, 10], 'c.png': [10, 10] })
    const f = makeCanvasFactory()
    await exportBoard(docOf([a, b, c]), [c.id, a.id], 1, images, f.make, estimateTextMetrics)
    expect(f.made[0]!.ctx!.drawImages().map((d) => (d.image as unknown as { name: string }).name)).toEqual(['a.png', 'c.png'])
    expect(state.asked).toEqual(['a.png', 'c.png'])
  })

  it('draws a picture it cannot read as a missing one, also when the loader throws', async () => {
    const a = pic({ path: 'gone.png', x: 0 })
    const b = pic({ path: 'boom.png', x: 300 })
    const images: ExportImages = {
      async get(path) {
        if (path === 'boom.png') throw new Error('decode failed')
        return null
      },
    }
    const f = makeCanvasFactory()
    const out = await exportBoard(docOf([a, b]), null, 1, images, f.make, estimateTextMetrics)
    expect(out).not.toBeNull()
    const ctx = f.made[0]!.ctx!
    expect(ctx.drawImages()).toHaveLength(0)
    expect(ctx.rects('strokeRect').filter((r) => r.s.lineDash.length > 0)).toHaveLength(2)
  })

  it('draws a board of huge pictures in passes, never holding more than one pass of bitmaps, and closes every one', async () => {
    const paths = ['p0.png', 'p1.png', 'p2.png', 'p3.png', 'p4.png']
    const items: BoardItem[] = []
    paths.forEach((p, i) => items.push(pic({ path: p, x: i * 150, w: 100, h: 100 })))
    items.push(note({ text: 'on top', x: 300, y: 200 }), pic({ path: 'p1.png', x: 800, w: 100, h: 100 }))
    const big = Math.ceil(Math.sqrt(EXPORT_PASS_PIXELS)) + 10
    const { images, state } = bitmaps(Object.fromEntries(paths.map((p) => [p, [big, big] as [number, number]])))
    const f = makeCanvasFactory()
    const out = await exportBoard(docOf(items), null, 1, images, f.make, estimateTextMetrics)
    expect(out).not.toBeNull()
    // One bitmap is already a whole pass; nothing was held beside it.
    expect(state.peak).toBe(1)
    expect(state.open).toBe(0)
    expect(state.closed).toBe(state.asked.length)
    expect(state.asked).toEqual(['p0.png', 'p1.png', 'p2.png', 'p3.png', 'p4.png', 'p1.png'])
    const ctx = f.made[0]!.ctx!
    // The same picture of the last item arrives drawn in the order of the board, and the background is painted once.
    expect(ctx.drawImages().map((d) => (d.image as unknown as { name: string }).name)).toEqual(['p0.png', 'p1.png', 'p2.png', 'p3.png', 'p4.png', 'p1.png'])
    expect(ctx.rects('fillRect').filter((r) => r.w === out!.width && r.h === out!.height && r.s.fillStyle === '#14161d')).toHaveLength(1)
    expect(ctx.texts().map((t) => t.text)).toEqual(['on top'])
    // The note (item 6) comes after the fifth picture and before the sixth.
    const order = ctx.log.filter((r) => r.op === 'drawImage' || r.op === 'fillText').map((r) => (r.op === 'fillText' ? 'text' : 'img'))
    expect(order).toEqual(['img', 'img', 'img', 'img', 'img', 'text', 'img'])
  })

  it('loads small pictures together in one pass and hands bitmaps back through release when it is given', async () => {
    const items = [pic({ path: 'a.png', x: 0 }), pic({ path: 'b.png', x: 200 }), pic({ path: 'a.png', x: 400 })]
    const { images, state } = bitmaps({ 'a.png': [50, 50], 'b.png': [50, 50] })
    const released: string[] = []
    const withRelease: ExportImages = { get: images.get, release: (p) => released.push(p) }
    const f = makeCanvasFactory()
    await exportBoard(docOf(items), null, 1, withRelease, f.make, estimateTextMetrics)
    // a.png is read once for both of its items.
    expect(state.asked).toEqual(['a.png', 'b.png'])
    expect(released.sort()).toEqual(['a.png', 'b.png'])
    expect(state.closed).toBe(0)
    expect(f.made[0]!.ctx!.drawImages()).toHaveLength(3)
  })
})
