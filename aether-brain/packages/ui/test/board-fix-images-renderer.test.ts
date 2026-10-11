import { describe, expect, it } from 'vitest'
import {
  FULL_CROP,
  emptyBoard,
  estimateTextMetrics,
  itemBounds,
  type BoardDoc,
  type BoardItem,
  type BoardView,
  type LineItem,
  type PictureItem,
} from '@aether/core'
import type { ImageFailure, ImageSlot, ImageSource } from '../src/board/api'
import { EMPTY_DRAW_STATE, drawBoard, exportBoard, type DrawArgs, type ExportCanvas } from '../src/board/renderer'
import { RecordingContext, makeBitmap, type PathRec } from './helpers/recordingContext'

/**
 * Review fixes renderer-cache-1 / -3 (the renderer's half), desktop-4, renderer-cache-4 and renderer-cache-m1:
 * - the cache is told how big the part of a picture that is SHOWN is, so that a crowd of pictures is served biggest-first;
 * - a picture that cannot be shown is drawn as what it is: file missing, too large to show, can't be read, each with its own icon and
 *   words (the dashed box with a cross stays the missing file's);
 * - grey pictures clip the filter to their own rectangle, outset by a device pixel, and only when they are grey (drawBoard and the export);
 * - an arrow's head counts in what is culled and in what an export is sized to.
 */

let ids = 7000
const common = () => ({ id: ids++, group: 0, locked: false })
function pic(o: Partial<PictureItem> = {}): PictureItem {
  return { ...common(), kind: 'picture', path: 'a.png', x: 0, y: 0, w: 200, h: 100, rotation: 0, crop: { ...FULL_CROP }, flipH: false, flipV: false, gray: false, opacity: 1, caption: '', ...o }
}
function line(o: Partial<LineItem> = {}): LineItem {
  return { ...common(), kind: 'line', x1: 0, y1: 0, x2: 100, y2: 0, color: 'ff3300', width: 4, arrow: false, ...o }
}
const docOf = (items: BoardItem[], o: Partial<BoardDoc> = {}): BoardDoc => ({ ...emptyBoard('t'), items, nextId: 9000, ...o })

/** An image source with a fixed answer per path (reason included) that writes down each question, shown size and all. */
class Source implements ImageSource {
  calls: { path: string; want: number; shown: number | undefined }[] = []
  constructor(private readonly slots: Record<string, Partial<ImageSlot>> = {}) {}
  get(path: string, want: number, shown?: number): ImageSlot {
    this.calls.push({ path, want, shown })
    const s = this.slots[path]
    return { bitmap: s?.bitmap ?? null, natural: s?.natural ?? null, failed: s?.failed ?? false, ...(s?.reason ? { reason: s.reason } : {}) }
  }
}

const VP = { w: 800, h: 600 }

function run(doc: BoardDoc, images: ImageSource, o: Partial<DrawArgs> & { ctx?: RecordingContext } = {}): RecordingContext {
  const ctx = o.ctx ?? new RecordingContext()
  drawBoard(ctx, { doc, view: { x: 0, y: 0, zoom: 1 }, viewport: VP, dpr: 1, state: EMPTY_DRAW_STATE, images, metrics: estimateTextMetrics, ...o })
  return ctx
}

describe('the cache is told how big the shown part of a picture is (renderer-cache-1)', () => {
  it('asks for the whole picture at its longer side times the density, with the size of the cropped part on the screen as the second number', () => {
    const item = pic({ w: 300, h: 120, crop: { l: 0.2, t: 0, r: 0.4, b: 1 } })
    const images = new Source({ 'a.png': { bitmap: makeBitmap(64, 64) } })
    run(docOf([item]), images, { view: { x: 0, y: 0, zoom: 3 }, dpr: 2 })
    // The crop is 60 x 120 board units: 720 device pixels on its longer side; the whole picture is 300 wide: 1800.
    expect(images.calls).toEqual([{ path: 'a.png', want: 300 * 3 * 2, shown: 120 * 3 * 2 }])
  })

  it('says the same size of a detail crop whatever its share, so the cache can tell a detail from a whole picture', () => {
    const whole = pic({ path: 'whole.png', w: 400, h: 300 })
    const detail = pic({ path: 'detail.png', x: 500, w: 4000, h: 3000, crop: { l: 0.45, t: 0.45, r: 0.5, b: 0.5 } })
    const images = new Source({ 'whole.png': { bitmap: makeBitmap(8, 8) }, 'detail.png': { bitmap: makeBitmap(8, 8) } })
    run(docOf([whole, detail]), images, { view: { x: 250, y: 0, zoom: 1 } })
    const [a, b] = images.calls
    expect(a).toEqual({ path: 'whole.png', want: 400, shown: 400 })
    // 5% of 4000 = 200 board units shown, but the picture is 4000 wide: sharp only from a 4000 px bitmap.
    expect(b).toMatchObject({ path: 'detail.png', want: 4000 })
    expect(b!.shown).toBeCloseTo(200, 9)
  })
})

describe('placeholders say why (renderer-cache-3, desktop-4)', () => {
  const big = pic({ path: 'Boards/Gate/rust.png', w: 400, h: 300 })
  const draw = (reason: ImageFailure | undefined, item: PictureItem = big, o: Partial<DrawArgs> = {}): RecordingContext =>
    run(docOf([item]), new Source({ [item.path]: { failed: true, ...(reason ? { reason } : {}) } }), o)
  const strokes = (ctx: RecordingContext): PathRec[] => ctx.paths('stroke')
  const shape = (ctx: RecordingContext): string => strokes(ctx).map((p) => p.path.map((s) => s.t).join('')).join('|')

  it('draws a picture that is loading as a plain dark frame: no dashes, no icon, no words', () => {
    const ctx = run(docOf([big]), new Source({ [big.path]: {} }))
    expect(ctx.log.some((r) => r.op === 'setLineDash' && r.s.lineDash.length > 0)).toBe(false)
    expect(ctx.texts()).toHaveLength(0)
  })

  it('draws "file missing" with the cross for a file the vault lost, "too large to show" with the corners of a frame for a picture with too many pixels, "can\'t be read" with a warning sign for the rest', () => {
    const missing = draw('missing')
    const large = draw('too-large')
    const unreadable = draw('unreadable')
    const unknown = draw(undefined)
    expect(missing.texts().map((t) => t.text)).toEqual(['file missing', 'rust.png'])
    expect(large.texts().map((t) => t.text)).toEqual(['too large to show', 'rust.png'])
    expect(unreadable.texts().map((t) => t.text)).toEqual(["can't be read", 'rust.png'])
    // A reason nobody gave is "can't be read".
    expect(unknown.texts().map((t) => t.text)).toEqual(["can't be read", 'rust.png'])
    expect(shape(unknown)).toBe(shape(unreadable))
    // Nor does a reason this build does not know (a host from another one) or a name from Object.prototype make "undefined" words.
    for (const odd of ['whatever', 'constructor', '__proto__', 'toString']) {
      const ctx = draw(odd as ImageFailure)
      expect(ctx.texts().map((t) => t.text), odd).toEqual(["can't be read", 'rust.png'])
      expect(shape(ctx), odd).toBe(shape(unreadable))
    }
    // Every one of them has the dashed outline of the picture\'s box.
    for (const ctx of [missing, large, unreadable]) {
      const outline = ctx.rects('strokeRect').filter((r) => r.w === 400 && r.h === 300)
      expect(outline).toHaveLength(1)
      expect(outline[0]!.s.lineDash.length).toBeGreaterThan(0)
    }
    // The icons differ: a cross (two diagonals), four elbows, a triangle with a stroke and a dot.
    expect(shape(missing)).toBe('MLML')
    expect(shape(large)).toBe('MLLMLLMLLMLL')
    expect(shape(unreadable)).toBe('MLLZMLML')
    expect(new Set([shape(missing), shape(large), shape(unreadable)]).size).toBe(3)
  })

  it('draws a picture the vault has lost as missing whatever the cache says, without asking it', () => {
    const images = new Source({ [big.path]: { bitmap: makeBitmap(4, 4) } })
    const ctx = run(docOf([big]), images, { missing: () => true })
    expect(images.calls).toEqual([])
    expect(ctx.drawImages()).toHaveLength(0)
    expect(ctx.texts().map((t) => t.text)).toEqual(['file missing', 'rust.png'])
    expect(shape(ctx)).toBe('MLML')
  })

  it('shows less of the message as the box gets smaller: icon from 28 px, words from 60, the file name from 110', () => {
    const at = (side: number, reason: ImageFailure) => draw(reason, pic({ path: 'x/p.png', w: side, h: side }))
    for (const reason of ['too-large', 'unreadable'] as const) {
      expect(at(20, reason).paths('stroke')).toHaveLength(0)
      expect(at(40, reason).paths('stroke')).toHaveLength(1)
      expect(at(40, reason).texts()).toHaveLength(0)
      // (80 px is narrower than the words: they are cut with an ellipsis.)
      const mid = at(80, reason).texts().map((t) => t.text)
      expect(mid).toHaveLength(1)
      expect(mid[0]!.startsWith(reason === 'too-large' ? 'too' : 'can')).toBe(true)
      expect(at(200, reason).texts().map((t) => t.text)).toEqual([reason === 'too-large' ? 'too large to show' : "can't be read", 'p.png'])
    }
    // The cross of a missing file is the box\'s own diagonals, whatever its size.
    expect(at(20, 'missing').paths('stroke')).toHaveLength(1)
    expect(at(40, 'missing').texts()).toHaveLength(0)
    expect(at(105, 'missing').texts().map((t) => t.text)).toEqual(['file missing'])
  })

  it('cuts the words to the box when it is narrow, and keeps the plate behind them inside it', () => {
    const narrow = pic({ path: 'x/p.png', w: 62, h: 200 })
    const ctx = draw('too-large', narrow)
    const words = ctx.texts()[0]!
    expect(words.text.endsWith('…')).toBe(true)
    expect(words.text.length).toBeLessThan('too large to show'.length)
  })

  it('draws every placeholder inside save and restore and leaves the context as it was', () => {
    for (const reason of ['missing', 'too-large', 'unreadable'] as const) {
      const ctx = new RecordingContext()
      ctx.globalAlpha = 0.3
      ctx.lineCap = 'round'
      draw(reason, big, { ctx })
      expect(ctx.depth).toBe(0)
      expect(ctx.underflows).toBe(0)
      expect([ctx.globalAlpha, ctx.lineCap]).toEqual([0.3, 'round'])
      // Square caps for the dashes, round only for the icon\'s own strokes.
      expect(ctx.rects('strokeRect')[0]!.s.lineCap).toBe('butt')
    }
  })
})

describe('grey pictures clip the filter to their own rectangle, outset a device pixel (renderer-cache-4)', () => {
  const slots = { 'a.png': { bitmap: makeBitmap(100, 50) } }

  it('clips to the picture\'s rectangle in its own frame, 1 / (zoom x density) larger on every side, before the filtered draw', () => {
    const item = pic({ w: 200, h: 100, gray: true, rotation: 33, flipH: true, crop: { l: 0.1, t: 0, r: 0.9, b: 1 } })
    const ctx = run(docOf([item]), new Source(slots), { view: { x: 0, y: 0, zoom: 2 }, dpr: 1.5 })
    const clips = ctx.paths('clip')
    expect(clips).toHaveLength(1)
    const rect = clips[0]!.path.filter((s) => s.t === 'rect')
    expect(rect).toHaveLength(1)
    const r = rect[0] as { x: number; y: number; w: number; h: number; m: number[] }
    // Shown part: 160 x 100 board units; one device pixel is 1 / 3 unit.
    const u = 1 / 3
    expect([r.x, r.y, r.w, r.h].map((v) => +v.toFixed(9))).toEqual([-80 - u, -50 - u, 160 + 2 * u, 100 + 2 * u].map((v) => +v.toFixed(9)))
    // Under the picture's own transform (turned, mirrored): the same matrix the image is drawn with.
    const image = ctx.drawImages()[0]!
    expect(r.m).toEqual(image.s.matrix)
    // The clip comes before the draw, which is made with the filter and inside it.
    expect(ctx.log.indexOf(clips[0]!)).toBeLessThan(ctx.log.indexOf(image))
    expect(image.s.filter).toBe('grayscale(1)')
    expect(image.s.clips).toBe(1)
  })

  it('clips only the grey ones: a picture in colour is drawn with no clip at all, and the clip never outlives its picture', () => {
    const items = [pic({ path: 'a.png', x: -300, gray: true }), pic({ path: 'a.png', x: 0 }), pic({ path: 'a.png', x: 300, gray: true })]
    const ctx = run(docOf(items), new Source(slots))
    expect(ctx.paths('clip')).toHaveLength(2)
    expect(ctx.drawImages().map((d) => [d.s.filter, d.s.clips])).toEqual([['grayscale(1)', 1], ['none', 0], ['grayscale(1)', 1]])
    expect(ctx.clips).toBe(0)
    expect(ctx.depth).toBe(0)
  })

  it('clips every picture of a grey board, and none of a board in colour', () => {
    const items = [pic({ x: -300 }), pic({ x: 0 }), pic({ x: 300 })]
    expect(run(docOf(items, { gray: true }), new Source(slots)).paths('clip')).toHaveLength(3)
    expect(run(docOf(items, { gray: false }), new Source(slots)).paths('clip')).toHaveLength(0)
  })

  it('draws in colour, with no clip, on a context that has no filters', () => {
    const ctx = new RecordingContext({ filter: false })
    run(docOf([pic({ gray: true })]), new Source(slots), { ctx })
    expect(ctx.paths('clip')).toHaveLength(0)
    expect(ctx.drawImages()).toHaveLength(1)
  })

  it('keeps the hairline seam away: the clip is wider than the picture by at least one device pixel at any zoom or density', () => {
    for (const [zoom, dpr] of [[0.05, 1], [1, 1], [1, 2], [8, 2], [40, 3]] as const) {
      const ctx = run(docOf([pic({ w: 100, h: 100, gray: true })]), new Source(slots), { view: { x: 0, y: 0, zoom }, dpr })
      const rect = ctx.paths('clip')[0]!.path.find((s) => s.t === 'rect') as { x: number; w: number }
      const outsetUnits = (rect.w - 100) / 2
      expect(outsetUnits * zoom * dpr).toBeCloseTo(1, 9)
    }
  })

  it('clips the pictures of an export too (it draws with drawBoard): one clip per grey picture', async () => {
    const items = [pic({ path: 'a.png', x: 0, y: 0, w: 100, h: 60 }), pic({ path: 'a.png', x: 120, y: 0, w: 100, h: 60 })]
    const ctx = new RecordingContext()
    const canvas: ExportCanvas = { width: 0, height: 0, getContext: () => ctx }
    await exportBoard(docOf(items, { gray: true }), null, 1, { get: async () => makeBitmap(100, 60) }, (w, h) => Object.assign(canvas, { width: w, height: h }), estimateTextMetrics)
    expect(ctx.paths('clip')).toHaveLength(2)
    expect(ctx.drawImages().every((d) => d.s.filter === 'grayscale(1)' && d.s.clips === 1)).toBe(true)
  })
})

describe('an arrow\'s head counts (renderer-cache-m1)', () => {
  // A line from (0, 0) to (200, 0), width 10: a head 40 long reaching 20 above and below the shaft (the shaft is 5 each side).
  const arrow = line({ x1: 0, y1: 0, x2: 200, y2: 0, width: 10, arrow: true })

  it('sizes an export to the head, not only to the shaft: 420 x 80 at scale 2, the head not cut off', async () => {
    const b = itemBounds(arrow, estimateTextMetrics)
    expect(b.h).toBeGreaterThanOrEqual(40)
    const ctx = new RecordingContext()
    const canvas: ExportCanvas = { width: 0, height: 0, getContext: () => ctx }
    const out = await exportBoard(docOf([arrow]), null, 2, { get: async () => null }, (w, h) => Object.assign(canvas, { width: w, height: h }), estimateTextMetrics)
    expect([out!.width, out!.height]).toEqual([420, 80])
    // A line with no head keeps the thin box.
    const plain = await exportBoard(docOf([{ ...arrow, id: 7999, arrow: false }]), null, 2, { get: async () => null }, (w, h) => Object.assign(canvas, { width: w, height: h }), estimateTextMetrics)
    expect(plain!.height).toBe(20)
  })

  it('draws an arrow whose head reaches the canvas although its shaft does not', () => {
    // The view shows y from -300 to 300. The shaft (y = -325, 5 thick) ends at -320, 20 px above the canvas and past the 16 px margin;
    // the head\'s lower wing reaches -305: 5 px above the canvas, inside the margin.
    const high = line({ x1: -100, y1: -325, x2: 100, y2: -325, width: 10, arrow: true })
    const ctx = run(docOf([high]), new Source())
    expect(ctx.paths('stroke').length + ctx.paths('fill').length).toBeGreaterThan(0)
    // The same line without a head is off the screen and not drawn.
    const bare = run(docOf([{ ...high, arrow: false }]), new Source())
    expect(bare.paths('stroke')).toHaveLength(0)
  })
})
