/**
 * The live pictures of the 3D models on a board: a model is turned with the pointer, so it is drawn from its proxy (core's
 * `decodeProxy` / `renderProxy`: up to 24,000 triangles and a colour for every vertex, which the thumbnail helper baked) at the view
 * the item holds, onto a canvas the renderer draws like any picture. No DOM, no React: the canvases are made by whoever builds it
 * (`makeCanvas`), the proxies are fetched through `load` (the host's), so this runs, and is tested, in node.
 *
 * The renderer asks for every visible model on every frame (`get`), so a call only looks things up and draws only when the view or the
 * size on the screen changed since the last one. Until a proxy has arrived (or when a model has none) `get` says null and the renderer
 * draws what the picture cache holds, the model's still from the helper: a model on a board is never blank and never blocks a frame.
 * Bounded: at most `maxHeld` proxies are kept (the least recently drawn go first), each a few hundred KB; a canvas is at most
 * `MAX_SIDE` px a side. A model drawn too small to show a turn (under `MIN_PX` device pixels) is left to its still.
 */
import { MODEL_VIEW_DEFAULT, decodeProxy, isModelPath, normaliseView, renderProxy, type ModelProxy, type PictureItem } from '@aether/core'

/** Whatever `drawImage` takes and has a size: the live canvas. */
export interface LiveImage {
  readonly width: number
  readonly height: number
}

/** One canvas to draw a model's pixels onto. */
export interface LiveCanvas {
  /** What the renderer draws. */
  readonly image: LiveImage
  /** Replaces the canvas's pixels with `side` × `side` RGBA. */
  paint(pixels: Uint8ClampedArray): void
}

/** What the renderer asks of the board's models. */
export interface ModelViewSource {
  /** The picture of the model item as it is turned, drawn for about `wantPx` device pixels on its longer side; null when there is none yet. Cheap. */
  get(item: PictureItem, wantPx: number): LiveImage | null
}

export interface ModelViewsOptions {
  /** The model's proxy bytes, from the host (null: there is none). May reject: that is the same as null. */
  load(path: string): Promise<Uint8Array | null>
  /** A canvas of this side, or null where there is none to make (then no model is drawn live). */
  makeCanvas(side: number): LiveCanvas | null
  /** A model became drawable, or stopped being: the board should be drawn again. */
  onChange(): void
  /** Proxies kept at once. Default 24. */
  maxHeld?: number
  /** A proxy that could not be had is asked for again after this long (ms), when it is wanted again. Default 60 s. */
  retryMs?: number
  /** The clock (ms) for retries. Default `Date.now`. */
  now?: () => number
}

/** The sides a model is drawn at: the smallest of these that is not smaller than what the screen shows. */
export const MODEL_MAX_SIDE = 512
const SIDES = [64, 128, 256, MODEL_MAX_SIDE] as const
export const MODEL_MIN_PX = 48
const DEFAULT_HELD = 24
const DEFAULT_RETRY_MS = 60_000

interface Entry {
  state: 'loading' | 'ready' | 'failed'
  proxy: ModelProxy | null
  /** The exposure gain of the first picture drawn, kept for every other view of the model (so it does not flicker as it turns). */
  gain: number | undefined
  canvas: LiveCanvas | null
  side: number
  /** What the canvas shows now: `side|yaw|pitch`. */
  shown: string
  /** When it was last asked for (a counter): the least recently asked goes first. */
  used: number
  failedAt: number
}

/** The side a model drawn for `px` device pixels is rendered at. */
export function liveSide(px: number): number {
  for (const s of SIDES) if (px <= s) return s
  return MODEL_MAX_SIDE
}

export class ModelViews implements ModelViewSource {
  private readonly held = new Map<string, Entry>()
  private tick = 0
  private disposed = false

  constructor(private readonly opts: ModelViewsOptions) {}

  /** Models whose proxy is held (loading ones too). */
  get size(): number {
    return this.held.size
  }

  /** Whether the model's proxy is here and it can be drawn. */
  ready(path: string): boolean {
    return this.held.get(path)?.state === 'ready'
  }

  get(item: PictureItem, wantPx: number): LiveImage | null {
    if (this.disposed || !isModelPath(item.path) || !(wantPx >= MODEL_MIN_PX)) return null
    const e = this.entryFor(item.path)
    e.used = ++this.tick
    if (e.state !== 'ready' || !e.proxy) return null
    const side = liveSide(wantPx)
    const view = normaliseView(item.turn ?? MODEL_VIEW_DEFAULT)
    const shown = `${side}|${view.yaw}|${view.pitch}`
    if (e.canvas && e.shown === shown) return e.canvas.image
    const drawn = renderProxy(e.proxy, { side, yaw: view.yaw, pitch: view.pitch, supersample: side <= 256 ? 2 : 1, ...(e.gain !== undefined ? { gain: e.gain } : {}) })
    if (!drawn) {
      // Nothing of the model lands on the picture (every triangle edge-on at this view): the still stands in for it.
      return null
    }
    e.gain ??= drawn.gain
    if (!e.canvas || e.side !== side) {
      e.canvas = this.opts.makeCanvas(side)
      e.side = side
    }
    if (!e.canvas) return null
    e.canvas.paint(drawn.pixels)
    e.shown = shown
    return e.canvas.image
  }

  /** The vault's copy of this model changed: its proxy is fetched again the next time it is drawn. */
  forget(path: string): void {
    this.held.delete(path)
  }

  /** Everything is let go (the board closed). */
  dispose(): void {
    this.disposed = true
    this.held.clear()
  }

  private entryFor(path: string): Entry {
    const have = this.held.get(path)
    const now = (this.opts.now ?? Date.now)()
    if (have && !(have.state === 'failed' && now - have.failedAt >= (this.opts.retryMs ?? DEFAULT_RETRY_MS))) return have
    const entry: Entry = { state: 'loading', proxy: null, gain: undefined, canvas: null, side: 0, shown: '', used: ++this.tick, failedAt: 0 }
    this.held.set(path, entry)
    this.evict(path)
    void this.fetch(path, entry)
    return entry
  }

  private async fetch(path: string, entry: Entry): Promise<void> {
    let proxy: ModelProxy | null = null
    try {
      const bytes = await this.opts.load(path)
      proxy = bytes ? decodeProxy(bytes) : null
    } catch {
      proxy = null
    }
    // A model forgotten (or the board closed) while its proxy was on the way: the answer is for a file that is no longer this one.
    if (this.disposed || this.held.get(path) !== entry) return
    if (proxy) {
      entry.proxy = proxy
      entry.state = 'ready'
    } else {
      entry.state = 'failed'
      entry.failedAt = (this.opts.now ?? Date.now)()
    }
    this.opts.onChange()
  }

  /** Lets the least recently asked for go while more are held than allowed (the one being asked for now stays). */
  private evict(keep: string): void {
    const max = Math.max(1, this.opts.maxHeld ?? DEFAULT_HELD)
    while (this.held.size > max) {
      let oldest: string | null = null
      let at = Infinity
      for (const [p, e] of this.held) {
        if (p === keep) continue
        if (e.used < at) {
          at = e.used
          oldest = p
        }
      }
      if (oldest === null) return
      this.held.delete(oldest)
    }
  }
}
