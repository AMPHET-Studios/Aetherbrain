import { describe, expect, it, vi } from 'vitest'
import {
  FULL_CROP,
  MODEL_VIEW_DEFAULT,
  emptyBoard,
  encodeProxy,
  decodeProxy,
  estimateTextMetrics,
  renderProxy,
  type BoardDoc,
  type PictureItem,
  type ProxyParts,
} from '@aether/core'
import { EMPTY_DRAW_STATE, drawBoard } from '../src/board/renderer'
import { MODEL_MAX_SIDE, MODEL_MIN_PX, ModelViews, liveSide, type LiveCanvas, type ModelViewSource } from '../src/board/modelViews'
import { createImageLoader, MODEL_PREVIEW_PX } from '../src/board/imageLoader'
import { FakeImages, RecordingContext, makeBitmap } from './helpers/recordingContext'

/**
 * The live pictures of the 3D models on a board: each model's proxy is fetched once, drawn at the view its item holds onto a canvas the
 * renderer draws like a picture, drawn again only when the view or the size changes, held in a bounded set, and left to its still
 * (the picture cache's) until it is there or when it cannot be.
 */

const Q = 32767

function sphereParts(lat = 12, lon = 16, color: [number, number, number] = [200, 60, 60]): ProxyParts {
  const positions: number[] = []
  for (let i = 0; i <= lat; i++) {
    const t = (i / lat) * Math.PI
    for (let j = 0; j < lon; j++) {
      const a = (j / lon) * Math.PI * 2
      positions.push(Math.round(Math.sin(t) * Math.cos(a) * Q), Math.round(Math.cos(t) * Q), Math.round(Math.sin(t) * Math.sin(a) * Q))
    }
  }
  const indices: number[] = []
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const a = i * lon + j
      const b = i * lon + ((j + 1) % lon)
      const c = (i + 1) * lon + j
      const d = (i + 1) * lon + ((j + 1) % lon)
      indices.push(a, c, b, b, c, d)
    }
  }
  return { centre: [0, 0, 0], half: 1, positions, colors: Array.from({ length: positions.length / 3 }, () => color).flat(), indices }
}

/** A long dark box: lit very differently from its two ends, so the exposure of one view is not the exposure of another. */
function boxParts(): ProxyParts {
  const s = Q
  const long = Math.round(Q * 0.25)
  const positions: number[] = []
  for (const z of [-long, long]) for (const y of [-long, long]) for (const x of [-s, s]) positions.push(x, y, z)
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
  const indices: number[] = []
  for (const [a, b, c, d] of quads) indices.push(a!, b!, c!, a!, c!, d!)
  return { centre: [0, 0, 0], half: 1, positions, colors: Array.from({ length: 8 }, () => [90, 75, 60]).flat(), indices }
}

const bytesOf = (parts: ProxyParts): Uint8Array => encodeProxy(parts)

const item = (o: Partial<PictureItem> = {}): PictureItem => ({
  id: 1,
  group: 0,
  locked: false,
  kind: 'picture',
  path: 'Art/robot.glb',
  x: 0,
  y: 0,
  w: 300,
  h: 300,
  rotation: 0,
  crop: { ...FULL_CROP },
  flipH: false,
  flipV: false,
  gray: false,
  opacity: 1,
  caption: '',
  ...o,
})

/** A canvas that keeps what is painted on it. */
function fakeCanvases() {
  const made: { side: number; painted: Uint8ClampedArray[]; canvas: LiveCanvas }[] = []
  return {
    made,
    makeCanvas: (side: number): LiveCanvas => {
      const rec = { side, painted: [] as Uint8ClampedArray[], canvas: null as unknown as LiveCanvas }
      rec.canvas = { image: { width: side, height: side }, paint: (pixels) => void rec.painted.push(pixels) }
      made.push(rec)
      return rec.canvas
    },
  }
}

/** A ModelViews whose proxies come from `files` (a path → bytes, or null for none, or an Error for a failing load). */
function rig(files: Record<string, Uint8Array | null | Error>, opts: { maxHeld?: number; retryMs?: number; makeCanvas?: (side: number) => LiveCanvas | null } = {}) {
  const canvases = fakeCanvases()
  const loads: string[] = []
  const changes = { n: 0 }
  let clock = 0
  const views = new ModelViews({
    load: async (path) => {
      loads.push(path)
      const f = files[path]
      if (f instanceof Error) throw f
      return f ?? null
    },
    makeCanvas: opts.makeCanvas ?? canvases.makeCanvas,
    onChange: () => void changes.n++,
    ...(opts.maxHeld !== undefined ? { maxHeld: opts.maxHeld } : {}),
    ...(opts.retryMs !== undefined ? { retryMs: opts.retryMs } : {}),
    now: () => clock,
  })
  /** Lets the loads that are under way finish. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  return { views, canvases, loads, changes, settle, tick: (ms: number) => void (clock += ms) }
}

describe('liveSide', () => {
  it('is the smallest of 64, 128, 256 and 512 that holds what the screen shows, and never more than 512', () => {
    expect(MODEL_MAX_SIDE).toBe(512)
    expect([1, 64, 65, 128, 129, 256, 257, 512, 513, 4000, Infinity].map(liveSide)).toEqual([64, 64, 128, 128, 256, 256, 512, 512, 512, 512, 512])
  })
})

describe('ModelViews', () => {
  it('asks for a model’s proxy once, says nothing (the still stays) until it is here, and says so when it arrives', async () => {
    const t = rig({ 'Art/robot.glb': bytesOf(sphereParts()) })
    expect(t.views.get(item(), 300)).toBeNull()
    expect(t.views.get(item(), 300)).toBeNull()
    expect(t.loads).toEqual(['Art/robot.glb'])
    expect(t.views.ready('Art/robot.glb')).toBe(false)
    await t.settle()
    expect(t.changes.n).toBe(1)
    expect(t.views.ready('Art/robot.glb')).toBe(true)
    const live = t.views.get(item(), 300)
    expect(live).toEqual({ width: 512, height: 512 })
    expect(t.loads).toHaveLength(1)
  })

  it('draws the proxy at the view the item holds, on a canvas of the side the screen needs', async () => {
    const proxy = bytesOf(sphereParts())
    const t = rig({ 'Art/robot.glb': proxy })
    t.views.get(item(), 200)
    await t.settle()
    const turned = item({ turn: { yaw: 120, pitch: -10 } })
    const live = t.views.get(turned, 200)!
    expect(live).toEqual({ width: 256, height: 256 })
    const painted = t.canvases.made[0]!.painted.at(-1)!
    const direct = renderProxy(decodeProxy(proxy)!, { side: 256, yaw: 120, pitch: -10, supersample: 2 })!
    expect(Buffer.compare(Buffer.from(painted), Buffer.from(direct.pixels))).toBe(0)
  })

  it('draws the first view for a model nobody turned: the one its still has', async () => {
    const proxy = bytesOf(sphereParts())
    const t = rig({ 'Art/robot.glb': proxy })
    t.views.get(item(), 100)
    await t.settle()
    t.views.get(item(), 100)
    const direct = renderProxy(decodeProxy(proxy)!, { side: 128, yaw: MODEL_VIEW_DEFAULT.yaw, pitch: MODEL_VIEW_DEFAULT.pitch, supersample: 2 })!
    expect(Buffer.compare(Buffer.from(t.canvases.made[0]!.painted[0]!), Buffer.from(direct.pixels))).toBe(0)
  })

  it('draws again only when the view or the size changed: a frame that asks for the same thing costs a look-up', async () => {
    const t = rig({ 'Art/robot.glb': bytesOf(sphereParts()) })
    t.views.get(item(), 200)
    await t.settle()
    for (let i = 0; i < 20; i++) t.views.get(item(), 200)
    expect(t.canvases.made).toHaveLength(1)
    expect(t.canvases.made[0]!.painted).toHaveLength(1)
    t.views.get(item({ turn: { yaw: 10, pitch: 10 } }), 200)
    expect(t.canvases.made[0]!.painted).toHaveLength(2)
    t.views.get(item({ turn: { yaw: 10, pitch: 10 } }), 200)
    expect(t.canvases.made[0]!.painted).toHaveLength(2)
    // The size on the screen crosses into the next side: a canvas of that side.
    t.views.get(item({ turn: { yaw: 10, pitch: 10 } }), 400)
    expect(t.canvases.made.map((m) => m.side)).toEqual([256, 512])
    // The same view and size under another item id (a copy) is the same picture.
    t.views.get(item({ id: 9, turn: { yaw: 10, pitch: 10 } }), 400)
    expect(t.canvases.made[1]!.painted).toHaveLength(1)
  })

  it('keeps one exposure for every view of a model, so it does not flicker as it is turned', async () => {
    const proxy = bytesOf(boxParts())
    const t = rig({ 'Art/box.glb': proxy })
    const box = (turn?: { yaw: number; pitch: number }) => item({ path: 'Art/box.glb', ...(turn ? { turn } : {}) })
    t.views.get(box(), 128)
    await t.settle()
    t.views.get(box(), 128)
    const first = renderProxy(decodeProxy(proxy)!, { side: 128, yaw: 35, pitch: 24, supersample: 2 })!
    t.views.get(box({ yaw: 215, pitch: 60 }), 128)
    const second = t.canvases.made[0]!.painted.at(-1)!
    const withFirstGain = renderProxy(decodeProxy(proxy)!, { side: 128, yaw: 215, pitch: 60, supersample: 2, gain: first.gain })!
    const withOwnGain = renderProxy(decodeProxy(proxy)!, { side: 128, yaw: 215, pitch: 60, supersample: 2 })!
    // The scenario is a real one: another view of this model would have been given another exposure.
    expect(withOwnGain.gain).not.toBe(first.gain)
    expect(Buffer.compare(Buffer.from(second), Buffer.from(withFirstGain.pixels))).toBe(0)
  })

  it('does nothing for what is not a model, and for a model drawn too small to turn', async () => {
    const t = rig({ 'Art/robot.glb': bytesOf(sphereParts()), 'Art/gate.png': bytesOf(sphereParts()) })
    expect(t.views.get(item({ path: 'Art/gate.png' }), 300)).toBeNull()
    expect(t.views.get(item(), MODEL_MIN_PX - 1)).toBeNull()
    expect(t.views.get(item(), NaN)).toBeNull()
    await t.settle()
    expect(t.loads).toEqual([])
    expect(t.views.size).toBe(0)
  })

  it('leaves a model with no proxy to its still, and asks again only after a while, when it is wanted again', async () => {
    const t = rig({ 'Art/robot.glb': null }, { retryMs: 60_000 })
    expect(t.views.get(item(), 300)).toBeNull()
    await t.settle()
    expect(t.changes.n).toBe(1)
    expect(t.views.get(item(), 300)).toBeNull()
    expect(t.loads).toHaveLength(1)
    t.tick(59_000)
    t.views.get(item(), 300)
    expect(t.loads).toHaveLength(1)
    t.tick(2_000)
    t.views.get(item(), 300)
    expect(t.loads).toHaveLength(2)
  })

  it('treats a load that throws, and bytes that are no proxy, as no proxy, never as an error', async () => {
    const t = rig({ 'Art/a.glb': new Error('the helper stopped'), 'Art/b.glb': new Uint8Array(100).fill(7), 'Art/c.glb': bytesOf(sphereParts()).subarray(0, 40) })
    for (const p of ['Art/a.glb', 'Art/b.glb', 'Art/c.glb']) expect(t.views.get(item({ path: p }), 300)).toBeNull()
    await t.settle()
    for (const p of ['Art/a.glb', 'Art/b.glb', 'Art/c.glb']) {
      expect(t.views.get(item({ path: p }), 300), p).toBeNull()
      expect(t.views.ready(p), p).toBe(false)
    }
  })

  it('holds a bounded number of proxies: the least recently asked for goes first, and comes back when it is asked for', async () => {
    const files = { 'Art/a.glb': bytesOf(sphereParts()), 'Art/b.glb': bytesOf(sphereParts()), 'Art/c.glb': bytesOf(sphereParts()) }
    const t = rig(files, { maxHeld: 2 })
    for (const p of ['Art/a.glb', 'Art/b.glb']) t.views.get(item({ path: p }), 200)
    await t.settle()
    t.views.get(item({ path: 'Art/a.glb' }), 200)
    t.views.get(item({ path: 'Art/c.glb' }), 200)
    expect(t.views.size).toBe(2)
    expect(t.views.ready('Art/a.glb')).toBe(true)
    expect(t.views.ready('Art/b.glb')).toBe(false)
    await t.settle()
    t.views.get(item({ path: 'Art/b.glb' }), 200)
    expect(t.loads.filter((p) => p === 'Art/b.glb')).toHaveLength(2)
    expect(t.views.size).toBeLessThanOrEqual(2)
  })

  it('forgets a model whose file changed: its proxy is fetched again, and a proxy that was on its way is dropped', async () => {
    const t = rig({ 'Art/robot.glb': bytesOf(sphereParts()) })
    t.views.get(item(), 200)
    t.views.forget('Art/robot.glb')
    await t.settle()
    // The answer to the first ask belongs to a copy that is gone: nothing is announced, nothing is held.
    expect(t.changes.n).toBe(0)
    expect(t.views.ready('Art/robot.glb')).toBe(false)
    t.views.get(item(), 200)
    await t.settle()
    expect(t.loads).toHaveLength(2)
    expect(t.views.ready('Art/robot.glb')).toBe(true)
    t.views.forget('Art/robot.glb')
    expect(t.views.size).toBe(0)
    expect(t.views.get(item(), 200)).toBeNull()
  })

  it('is let go when the board closes: nothing is drawn or announced after it', async () => {
    const t = rig({ 'Art/robot.glb': bytesOf(sphereParts()) })
    t.views.get(item(), 200)
    t.views.dispose()
    await t.settle()
    expect(t.changes.n).toBe(0)
    expect(t.views.get(item(), 200)).toBeNull()
    expect(t.views.size).toBe(0)
  })

  it('leaves a model to its still where there is no canvas to draw on, and where nothing of it lands on the picture', async () => {
    const none = rig({ 'Art/robot.glb': bytesOf(sphereParts()) }, { makeCanvas: () => null })
    none.views.get(item(), 200)
    await none.settle()
    expect(none.views.get(item(), 200)).toBeNull()
    // A flat sheet seen exactly edge-on.
    const sheet: ProxyParts = { centre: [0, 0, 0], half: 1, positions: [-Q, 0, 0, Q, 0, 0, 0, 0, Q], colors: [9, 9, 9, 9, 9, 9, 9, 9, 9], indices: [0, 1, 2] }
    const flat = rig({ 'Art/robot.glb': bytesOf(sheet) })
    flat.views.get(item(), 200)
    await flat.settle()
    expect(flat.views.get(item({ turn: { yaw: 0, pitch: 0 } }), 200)).toBeNull()
  })
})

describe('the renderer and a model', () => {
  const doc = (items: PictureItem[]): BoardDoc => ({ ...emptyBoard('t'), items, nextId: 100 })
  const draw = (d: BoardDoc, models?: ModelViewSource, images = new FakeImages()) => {
    const ctx = new RecordingContext()
    drawBoard(ctx, { doc: d, view: { x: 0, y: 0, zoom: 1 }, viewport: { w: 800, h: 600 }, dpr: 1, state: EMPTY_DRAW_STATE, images, metrics: estimateTextMetrics, ...(models ? { models } : {}) })
    return { ctx, images }
  }

  it('draws the live view of a model in place of its still, with its crop taken from it like any picture’s', () => {
    const live = { width: 256, height: 256 }
    const asked: { path: string; want: number }[] = []
    const models: ModelViewSource = { get: (it, want) => (asked.push({ path: it.path, want }), live) }
    const still = makeBitmap(512, 512)
    const { ctx } = draw(doc([item({ crop: { l: 0.25, t: 0, r: 1, b: 0.5 } })]), models, new FakeImages({ 'Art/robot.glb': { bitmap: still } }))
    const drawn = ctx.drawImages()
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.image).toBe(live)
    expect([drawn[0]!.sx, drawn[0]!.sy, drawn[0]!.sw, drawn[0]!.sh]).toEqual([64, 0, 192, 128])
    // It was asked for the size the item is on the screen.
    expect(asked).toEqual([{ path: 'Art/robot.glb', want: 300 }])
  })

  it('draws the still when the model has no live view yet, and a placeholder when there is neither', () => {
    const none: ModelViewSource = { get: () => null }
    const still = makeBitmap(512, 512)
    expect(draw(doc([item()]), none, new FakeImages({ 'Art/robot.glb': { bitmap: still } })).ctx.drawImages()[0]!.image).toBe(still)
    expect(draw(doc([item()]), none).ctx.drawImages()).toHaveLength(0)
  })

  it('asks only for 3D models, never for a picture, and never for a model the vault has lost', () => {
    const asked: string[] = []
    const models: ModelViewSource = { get: (it) => (asked.push(it.path), { width: 64, height: 64 }) }
    const ctx = new RecordingContext()
    drawBoard(ctx, {
      doc: doc([item({ path: 'Art/gate.png' }), item({ id: 2, path: 'Art/robot.glb' }), item({ id: 3, path: 'Art/gone.glb' })]),
      view: { x: 0, y: 0, zoom: 1 },
      viewport: { w: 800, h: 600 },
      dpr: 1,
      state: EMPTY_DRAW_STATE,
      images: new FakeImages(),
      metrics: estimateTextMetrics,
      models,
      missing: (p) => p === 'Art/gone.glb',
    })
    expect(asked).toEqual(['Art/robot.glb'])
  })

  it('is the same board as before for a board with no models source: the stills are drawn', () => {
    const still = makeBitmap(100, 100)
    const { ctx } = draw(doc([item()]), undefined, new FakeImages({ 'Art/robot.glb': { bitmap: still } }))
    expect(ctx.drawImages()[0]!.image).toBe(still)
  })
})

describe('the picture cache and a model', () => {
  const host = (calls: { preview: [string, number][]; original: string[] }) => ({
    preview: async (p: string, px: number) => (calls.preview.push([p, px]), new Blob([new Uint8Array(8)], { type: 'image/png' })),
    original: async (p: string) => (calls.original.push(p), null),
  })
  const create = vi.fn(async (_blob: Blob) => makeBitmap(512, 512) as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof createImageLoader>[1]>>>)

  it('is its picture at most 512 px at every tier, never "the file itself": a board never reads a model whole', async () => {
    const calls = { preview: [] as [string, number][], original: [] as string[] }
    const load = createImageLoader(host(calls), create)
    for (const tier of [256, 1024, 8192] as const) await load('Art/robot.glb', tier)
    expect(calls.original).toEqual([])
    expect(calls.preview).toEqual([['Art/robot.glb', 256], ['Art/robot.glb', 512], ['Art/robot.glb', 512]])
    expect(MODEL_PREVIEW_PX).toBe(512)
  })

  it('knows the size of a model’s picture when it is smaller than the tier asked for, so it has a size of its own', async () => {
    const calls = { preview: [] as [string, number][], original: [] as string[] }
    const load = createImageLoader(host(calls), create)
    for (const tier of [256, 1024, 8192] as const) expect(await load('Art/robot.glb', tier), String(tier)).toMatchObject({ natural: { w: 512, h: 512 } })
  })

  it('leaves a picture as it was: its tiers and its original are asked for as before', async () => {
    const calls = { preview: [] as [string, number][], original: [] as string[] }
    const load = createImageLoader(host(calls), create)
    await load('Art/gate.png', 1024)
    await load('Art/gate.png', 8192)
    expect(calls.preview).toEqual([['Art/gate.png', 1024]])
    expect(calls.original).toEqual(['Art/gate.png'])
  })
})
