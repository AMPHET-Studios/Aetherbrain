/**
 * The reference board's picture cache: decoded pictures held at the three sizes of IMAGE_TIERS under a pixel budget, loaded lazily for
 * what is on screen, two decodes at a time. No DOM: it asks `options.load` for a picture (imageLoader.ts makes the real one) and only
 * ever calls `close()` on what it was given, so it is tested in node with fake bitmaps. Design: docs/design/reference-board.md
 * ("Decisions" 4).
 *
 * How it behaves, in short:
 * - `get` is called for every visible picture on every frame, so it only looks things up. What it hands back is the held bitmap that
 *   fits the wanted size best (the smallest that is big enough, else the biggest smaller one); the wanted tier is queued when it is not
 *   held (or the best one that did not fail lately). Loads start in a microtask, after the frame's calls have queued their needs, so the biggest need goes first.
 * - Only pictures marked visible (`setVisible`, once per frame) load. A request that is still queued when its picture leaves the view
 *   is dropped.
 * - The budget counts width × height of every held bitmap. Over budget, bitmaps of pictures that are not on screen go first (least
 *   recently used first), then the spare bitmaps of pictures that are. The bitmap a visible picture is drawn with is never evicted: the
 *   cache may stand above its budget by those, and nothing else.
 * - Nothing is closed inside `get` or `setVisible`, which a frame calls synchronously before it draws: a bitmap the renderer got a
 *   moment ago is still open when it draws it. Bitmaps close in a microtask (a load arrived, or a frame changed what is on screen),
 *   and on `forget` / `clear` / `dispose`, which the owner calls between frames.
 */
import { IMAGE_TIERS, type ImageSlot, type ImageSource, type ImageTier } from './api'

/** What the cache needs of a decoded picture; an ImageBitmap is one. */
export type BitmapLike = { readonly width: number; readonly height: number; close(): void }

export interface LoadedImage {
  bitmap: BitmapLike
  /** The size of the picture itself, when this load knows it (before any scaling). */
  natural?: { w: number; h: number }
}

export interface ImageCacheOptions {
  /** Resolves with the picture at `tier`, or null when it cannot be read. May reject: that counts as a failure. */
  load(path: string, tier: ImageTier): Promise<LoadedImage | null>
  /** A load changed what `get` would answer (a bitmap arrived, or a picture turned out unreadable). Once per microtask at most. */
  onLoaded(): void
  /** Pixels (width × height) of decoded bitmaps to hold. Default 128 megapixels (about 512 MB). */
  budgetPixels?: number
  /** Loads running at once. Default 2. */
  concurrency?: number
  /** A failed picture is tried again this long after the failure, when it is on screen; it doubles for each failure in a row, up to 8×. Default 15 s. */
  retryAfterMs?: number
  /** The clock for retries (ms). Default Date.now. */
  now?(): number
}

export interface ImageCacheStats {
  /** Pixels held. */
  pixels: number
  /** Bitmaps held. */
  bitmaps: number
  /** Loads running. */
  loading: number
  /** Pictures waiting for a load slot. */
  queued: number
  /** Pictures with nothing to draw because every try failed so far. */
  failed: number
}

export const DEFAULT_BUDGET_PIXELS = 128e6
export const DEFAULT_CONCURRENCY = 2
export const DEFAULT_RETRY_MS = 15_000

/** Failures in a row double the wait before the next try this many times (2³ = 8×): a 64 MB picture that never decodes is not read every 15 s. */
const MAX_BACKOFF_DOUBLINGS = 3
/** Pictures remembered when nothing of them is held (their size and failures): beyond this the oldest are forgotten. */
const MAX_ENTRIES = 4096

/** Index into IMAGE_TIERS. */
type Idx = number

/** The index of the smallest tier of at least `px` (the last one for anything bigger). */
function fitIdx(px: number): Idx {
  return px <= IMAGE_TIERS[0] ? 0 : px <= IMAGE_TIERS[1] ? 1 : 2
}

function tierAt(i: Idx): ImageTier {
  return IMAGE_TIERS[i] ?? IMAGE_TIERS[2]
}

function wantedIdx(wantPx: number, natural: { w: number; h: number } | null): Idx {
  if (!(wantPx > 0)) return 0
  const want = fitIdx(wantPx)
  if (natural) {
    const longer = Math.max(natural.w, natural.h)
    // A picture is complete at the smallest tier that holds it: the 1024 preview of a 600 px picture is the picture, and the picture
    // itself (tier 8192) of a 3000 px one is its only sharper version.
    if (longer > 0 && longer < Infinity) return Math.min(want, fitIdx(longer))
  }
  return want
}

/**
 * The tier to hold a picture at when it is `wantPx` device pixels on its longer side: the smallest tier that is at least that big,
 * never more than the picture has (`natural`, when known: a 600 px picture is whole at 1024, so there is no point in its 8192 tier), 256
 * for nonsense. The tier 8192 is the picture itself, scaled down to 8192 on its longer side when bigger.
 */
export function pickTier(wantPx: number, natural: { w: number; h: number } | null): ImageTier {
  return tierAt(wantedIdx(wantPx, natural))
}

interface Held {
  bitmap: BitmapLike
  px: number
  /** Its longer side. */
  long: number
}

interface Fail {
  at: number
  /** Failures in a row at this tier. */
  n: number
}

/** Everything known about one picture. Indexed by tier index where it says so. */
interface Entry {
  path: string
  held: (Held | null)[]
  loading: boolean[]
  fail: (Fail | null)[]
  natural: { w: number; h: number } | null
  /** The size asked for last, and when (a counter, for least-recently-used). */
  want: number
  used: number
}

interface Request {
  entry: Entry
  tier: Idx
  need: number
  seq: number
}

function heldOf(e: Entry, i: Idx): Held | null {
  return e.held[i] ?? null
}

/** The bitmap to draw with when tier `idx` is wanted: the smallest held tier that is big enough, else the biggest smaller one. */
function bestHeld(e: Entry, idx: Idx): Held | null {
  for (let i = idx; i < IMAGE_TIERS.length; i++) {
    const h = heldOf(e, i)
    if (h) return h
  }
  for (let i = idx - 1; i >= 0; i--) {
    const h = heldOf(e, i)
    if (h) return h
  }
  return null
}

/**
 * Whether tier `idx` needs no load: it is held, or a bigger tier is held that is no bigger than this one would be (the picture itself,
 * which is smaller than the tier: a preview of it would be the same pixels).
 */
function holdsEnough(e: Entry, idx: Idx): boolean {
  const limit = tierAt(idx)
  for (let i = idx; i < IMAGE_TIERS.length; i++) {
    const h = heldOf(e, i)
    if (h && (i === idx || h.long <= limit)) return true
  }
  return false
}

function hasFailure(e: Entry): boolean {
  return e.fail.some((f) => f !== null)
}

function closeQuietly(b: BitmapLike | null | undefined): void {
  try {
    b?.close()
  } catch {
    /* a bitmap that will not close has nothing left to give back */
  }
}

function usable(b: BitmapLike | null | undefined): b is BitmapLike {
  return !!b && b.width > 0 && b.height > 0 && b.width < Infinity && b.height < Infinity
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

export class ImageCache implements ImageSource {
  /** Kept whole, not taken apart: `load`, `onLoaded` and `now` are methods and may use their own `this`. */
  private readonly options: ImageCacheOptions
  private readonly budget: number
  private readonly concurrency: number
  private readonly retryAfterMs: number

  private readonly entries = new Map<string, Entry>()
  private visible: Set<string> = new Set()
  /** The next load wanted of each picture: one per picture, retargeted as the wanted size changes. */
  private readonly queue = new Map<string, Request>()
  private running = 0
  private pixels = 0
  private tick = 0
  private seq = 0
  private settleQueued = false
  private notifyQueued = false
  private disposed = false

  constructor(options: ImageCacheOptions) {
    this.options = options
    const budget = options.budgetPixels
    this.budget = budget !== undefined && budget >= 0 && budget < Infinity ? budget : DEFAULT_BUDGET_PIXELS
    const concurrency = options.concurrency
    this.concurrency = concurrency !== undefined && concurrency >= 1 && concurrency < Infinity ? Math.floor(concurrency) : DEFAULT_CONCURRENCY
    const retry = options.retryAfterMs
    this.retryAfterMs = retry !== undefined && retry >= 0 && retry < Infinity ? retry : DEFAULT_RETRY_MS
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  get(path: string, wantPx: number): ImageSlot {
    let e = this.entries.get(path)
    const onScreen = !this.disposed && this.visible.has(path)
    if (this.disposed || (!e && !onScreen)) return { bitmap: null, natural: null, failed: false }
    if (!e) {
      e = { path, held: [null, null, null], loading: [false, false, false], fail: [null, null, null], natural: null, want: 0, used: 0 }
      this.entries.set(path, e)
    }
    e.used = ++this.tick
    e.want = wantPx
    const idx = wantedIdx(wantPx, e.natural)
    if (onScreen) this.request(e, idx, wantPx)
    const h = bestHeld(e, idx)
    // The bitmaps are whatever `load` gave: ImageBitmaps in the app, fakes in tests.
    return { bitmap: h ? (h.bitmap as ImageBitmap) : null, natural: e.natural, failed: !h && hasFailure(e) }
  }

  /** The pictures on screen this frame. Loads only start for these, and the ones that are not are the first to be evicted. */
  setVisible(paths: Iterable<string>): void {
    if (this.disposed) return
    const next = new Set(paths)
    if (sameSet(next, this.visible)) return
    this.visible = next
    for (const path of this.queue.keys()) if (!next.has(path)) this.queue.delete(path)
    this.schedule()
  }

  /**
   * Lets go of everything about a picture (it was replaced on disk, say). A load already running for it is left to finish and its
   * result is closed; the picture may start loading again at once, so that (path, tier) can then run twice: the old one may be
   * reading the old file.
   */
  forget(path: string): void {
    const e = this.entries.get(path)
    if (!e) return
    this.queue.delete(path)
    for (let i = 0; i < e.held.length; i++) this.drop(e, i)
    this.entries.delete(path)
  }

  /** Closes every bitmap and forgets every picture; what is on screen is kept, so the next `get` loads again. */
  clear(): void {
    this.queue.clear()
    for (const e of this.entries.values()) for (let i = 0; i < e.held.length; i++) this.drop(e, i)
    this.entries.clear()
  }

  /** Closes every bitmap and stops for good: nothing loads, loads still running are closed when they land. */
  dispose(): void {
    this.clear()
    this.visible = new Set()
    this.disposed = true
  }

  stats(): ImageCacheStats {
    let bitmaps = 0
    let failed = 0
    for (const e of this.entries.values()) {
      let n = 0
      for (const h of e.held) if (h) n++
      bitmaps += n
      if (n === 0 && hasFailure(e)) failed++
    }
    return { pixels: this.pixels, bitmaps, loading: this.running, queued: this.queue.size, failed }
  }

  /* ----------------------------------------------------------- loading --- */

  /**
   * Queues the load of the wanted tier for a visible picture, unless it is held, running, or failed lately. When the wanted tier
   * failed lately the best one that did not stands in for it (a preview of a picture too big to read whole, sharper than the
   * smaller one held): better than a placeholder or a blur, and the wanted tier is tried again when its time comes.
   */
  private request(e: Entry, wanted: Idx, wantPx: number): void {
    let idx = wanted
    while (idx > 0 && this.blocked(e, idx)) idx--
    const queued = this.queue.get(e.path)
    if (holdsEnough(e, idx) || e.loading[idx] || this.blocked(e, idx)) {
      // Whatever was waiting for this picture is no longer what it needs.
      if (queued) this.queue.delete(e.path)
      return
    }
    const need = wantPx > 0 ? Math.min(wantPx, 1e9) : 0
    if (queued) {
      queued.tier = idx
      queued.need = need
    } else {
      this.queue.set(e.path, { entry: e, tier: idx, need, seq: ++this.seq })
    }
    this.schedule()
  }

  private blocked(e: Entry, idx: Idx): boolean {
    const f = e.fail[idx]
    return !!f && this.now() < f.at + this.retryAfterMs * 2 ** Math.min(f.n - 1, MAX_BACKOFF_DOUBLINGS)
  }

  /**
   * Once the synchronous work of this frame is over: evict what the frame left evictable, then start the loads it queued (the
   * biggest need first, however the frame ordered its calls).
   */
  private schedule(): void {
    if (this.settleQueued || this.disposed) return
    this.settleQueued = true
    queueMicrotask(() => {
      this.settleQueued = false
      if (this.disposed) return
      this.evict()
      this.trim()
      this.pump()
    })
  }

  private pump(): void {
    while (!this.disposed && this.running < this.concurrency) {
      // The biggest need first, the longest waiting among equals. (Everything queued is on screen: setVisible drops the rest.)
      let next: Request | null = null
      for (const r of this.queue.values()) {
        if (next === null || r.need > next.need || (r.need === next.need && r.seq < next.seq)) next = r
      }
      if (!next) return
      this.queue.delete(next.entry.path)
      this.start(next.entry, next.tier)
    }
  }

  private start(e: Entry, idx: Idx): void {
    e.loading[idx] = true
    this.running++
    let job: Promise<LoadedImage | null>
    try {
      job = Promise.resolve(this.options.load(e.path, tierAt(idx)))
    } catch (err) {
      job = Promise.reject(err)
    }
    job.then(
      (img) => this.arrived(e, idx, img),
      () => this.arrived(e, idx, null),
    )
  }

  private arrived(e: Entry, idx: Idx, img: LoadedImage | null): void {
    this.running--
    e.loading[idx] = false
    if (this.disposed || this.entries.get(e.path) !== e) {
      // Forgotten, cleared or disposed while it ran: nobody wants it.
      closeQuietly(img?.bitmap)
      this.pump()
      return
    }
    if (img && usable(img.bitmap)) {
      this.adopt(e, idx, img)
      // What this picture now wants may be something else (its size was learned): so may what waits for it.
      const waiting = this.queue.get(e.path)
      if (waiting) this.request(e, wantedIdx(e.want, e.natural), waiting.need)
      this.changed()
    } else {
      closeQuietly(img?.bitmap)
      const first = !hasFailure(e) && bestHeld(e, 0) === null
      const prev = e.fail[idx]
      e.fail[idx] = { at: this.now(), n: (prev?.n ?? 0) + 1 }
      if (first) this.changed()
    }
    this.evict()
    this.trim()
    this.pump()
  }

  private adopt(e: Entry, idx: Idx, img: LoadedImage): void {
    const bitmap = img.bitmap
    this.drop(e, idx)
    const px = bitmap.width * bitmap.height
    e.held[idx] = { bitmap, px, long: Math.max(bitmap.width, bitmap.height) }
    this.pixels += px
    e.fail[idx] = null
    const n = img.natural
    if (n && n.w > 0 && n.h > 0 && n.w < Infinity && n.h < Infinity) {
      e.natural = Object.freeze({ w: n.w, h: n.h })
    } else if (Math.max(bitmap.width, bitmap.height) < tierAt(idx)) {
      // Smaller than the size it was asked at: the picture itself.
      e.natural = Object.freeze({ w: bitmap.width, h: bitmap.height })
    }
    // A bigger version has everything a smaller one had.
    for (let i = 0; i < idx; i++) this.drop(e, i)
  }

  private changed(): void {
    if (this.notifyQueued || this.disposed) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      if (!this.disposed) this.options.onLoaded()
    })
  }

  /* ---------------------------------------------------------- eviction --- */

  private drop(e: Entry, idx: Idx): void {
    const h = e.held[idx]
    if (!h) return
    e.held[idx] = null
    this.pixels -= h.px
    closeQuietly(h.bitmap)
  }

  /** Closes bitmaps until the budget holds or only the ones being drawn are left. */
  private evict(): void {
    if (this.pixels <= this.budget) return
    const candidates: { e: Entry; idx: Idx; onScreen: boolean }[] = []
    for (const e of this.entries.values()) {
      const onScreen = this.visible.has(e.path)
      const drawn = onScreen ? bestHeld(e, wantedIdx(e.want, e.natural)) : null
      for (let i = 0; i < e.held.length; i++) {
        const h = e.held[i]
        if (h && h !== drawn) candidates.push({ e, idx: i, onScreen })
      }
    }
    // Pictures off screen first, the least recently used first, a picture's biggest bitmap first (it frees the most).
    candidates.sort((a, b) => Number(a.onScreen) - Number(b.onScreen) || a.e.used - b.e.used || b.idx - a.idx)
    for (const c of candidates) {
      if (this.pixels <= this.budget) break
      this.drop(c.e, c.idx)
    }
  }

  /** Bounds what is remembered about pictures that hold nothing: the oldest of them are forgotten. */
  private trim(): void {
    if (this.entries.size <= MAX_ENTRIES) return
    const idle: Entry[] = []
    for (const e of this.entries.values()) {
      if (!this.visible.has(e.path) && !e.loading.some(Boolean) && !e.held.some(Boolean)) idle.push(e)
    }
    idle.sort((a, b) => a.used - b.used)
    for (const e of idle) {
      if (this.entries.size <= MAX_ENTRIES) break
      this.entries.delete(e.path)
    }
  }
}
