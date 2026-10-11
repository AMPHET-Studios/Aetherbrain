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
 *   A picture drawn several times in a frame is wanted at the biggest of those sizes.
 * - Only pictures marked visible (`setVisible`, once per frame) load. A request that is still queued when its picture leaves the view
 *   is dropped.
 * - The budget counts width × height of every held bitmap, and it is a real limit, drawn pictures included. The tier asked for follows
 *   the size on the screen (a picture a quarter beyond a tier's size still takes that tier: the cliff to the next one is 4× and 16× the
 *   pixels). When the pictures on screen want more than the budget holds, a PLAN (`plan`) gives the tiers out: every picture keeps at
 *   least the 256 tier, and the rest goes to the pictures shown biggest on the screen (`get`'s `shownPx`, a crop's size), among equals to
 *   the ones drawn last (on top). A picture the plan leaves short is held at a smaller tier: its bigger bitmap stays and is drawn until
 *   the smaller one has arrived (nothing flickers), and is closed then. Over budget, bitmaps of pictures that are not on screen go
 *   first (least recently used first), then the bitmaps a picture on screen does not draw with. Only the 256 tiers of a crowd of
 *   pictures can stand above the budget (at most 1,500 pictures on a board, 98 megapixels), and loads in flight and bitmaps waiting for
 *   their replacement for a moment.
 * - Nothing is closed inside `get` or `setVisible`, which a frame calls synchronously before it draws: a bitmap the renderer got a
 *   moment ago is still open when it draws it. Bitmaps close in a microtask (a load arrived, or a frame changed what is on screen),
 *   and on `forget` / `clear` / `dispose`, which the owner calls between frames.
 * - Why a picture cannot be shown: `ImageSlot.reason` / `failureOf(path)`, one of 'missing' (the host says the file is gone), 'too-large'
 *   (more pixels than a board decodes: a verdict about the file, kept until `forget`) and 'unreadable' (anything else). The loader says
 *   which with `{ failure }`; a null, a rejection or a bitmap with no size is 'unreadable'.
 * - A load that takes longer than `loadTimeoutMs` (30 s) stops holding its slot and counts as a failure (what it brings later is
 *   closed); a picture that failed before waits behind the ones that did not.
 */
import { IMAGE_TIERS, type ImageFailure, type ImageSlot, type ImageSource, type ImageTier } from './api'

/** What the cache needs of a decoded picture; an ImageBitmap is one. */
export type BitmapLike = { readonly width: number; readonly height: number; close(): void }

export interface LoadedImage {
  bitmap: BitmapLike
  /** The size of the picture itself, when this load knows it (before any scaling). */
  natural?: { w: number; h: number }
  failure?: undefined
}

/** A load that knows why it failed (and, maybe, how big the picture is). */
export interface LoadFailure {
  bitmap?: undefined
  failure: ImageFailure
  natural?: { w: number; h: number }
}

export interface ImageCacheOptions {
  /** Resolves with the picture at `tier`, or null when it cannot be read. May reject: that counts as a failure. */
  load(path: string, tier: ImageTier): Promise<LoadedImage | LoadFailure | null>
  /** A load changed what `get` would answer (a bitmap arrived, or a picture turned out unreadable). Once per microtask at most. */
  onLoaded(): void
  /** Pixels (width × height) of decoded bitmaps to hold. Default 128 megapixels (about 512 MB). */
  budgetPixels?: number
  /** Loads running at once. Default 2. */
  concurrency?: number
  /** A failed picture is tried again this long after the failure, when it is on screen; it doubles for each failure in a row, up to 8×. Default 15 s. */
  retryAfterMs?: number
  /** A load running this long (ms) is given up: its slot is free and it counts as a failure. Default 30 s. */
  loadTimeoutMs?: number
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
export const DEFAULT_LOAD_TIMEOUT_MS = 30_000
/** The most pixels the full tier holds of one picture (the loader scales a bigger one down to it): a quarter of the default budget. */
export const FULL_MAX_PIXELS = 32e6

/** Failures in a row double the wait before the next try this many times (2³ = 8×): a 64 MB picture that never decodes is not read every 15 s. */
const MAX_BACKOFF_DOUBLINGS = 3
/** Pictures remembered when nothing of them is held (their size and failures): beyond this the oldest are forgotten. */
const MAX_ENTRIES = 4096
/**
 * A picture this much bigger on the screen than a tier is still given that tier: the next tier is 4× (256 → 1024) and 8× (1024 → 8192)
 * as long, so a few pixels over the line must not cost 16× and 15× the pixels.
 */
const TIER_SLACK = 1.25
/** What a bitmap of each tier is guessed to hold of a picture whose size is not known yet: a 4:3 photo, the full tier a 16 megapixel one. */
const GUESS_PIXELS: readonly number[] = [256 * 192, 1024 * 768, 16e6]
const GUESS_TOP = 16e6

/** The reasons a picture can have nothing to draw (a loader that says anything else is taken to mean 'unreadable'). */
const FAILURES: readonly ImageFailure[] = ['missing', 'too-large', 'unreadable']

/** Index into IMAGE_TIERS. */
type Idx = number
/** The biggest tier: no cap. */
const TOP: Idx = IMAGE_TIERS.length - 1

/** The index of the smallest tier that serves `px` (a quarter bigger than the tier is served by it; the last one for anything bigger). */
function fitIdx(px: number): Idx {
  return px <= IMAGE_TIERS[0] * TIER_SLACK ? 0 : px <= IMAGE_TIERS[1] * TIER_SLACK ? 1 : 2
}

/** The index of the smallest tier that holds a picture of `px` on its longer side whole. */
function wholeIdx(px: number): Idx {
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
    if (longer > 0 && longer < Infinity) return Math.min(want, wholeIdx(longer))
  }
  return want
}

/**
 * The tier to hold a picture at when it is `wantPx` device pixels on its longer side: the smallest tier that is big enough (a quarter
 * short is enough), never more than the picture has (`natural`, when known: a 600 px picture is whole at 1024, so there is no point in
 * its 8192 tier; and no less than whole is enough for a picture to need), 256 for nonsense. The tier 8192 is the picture itself, scaled down to 8192 on its longer side when bigger.
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
  kind: ImageFailure
  /** A verdict about the file (too large): never tried again until the picture is forgotten. */
  permanent: boolean
}

/** Everything known about one picture. Indexed by tier index where it says so. */
interface Entry {
  path: string
  held: (Held | null)[]
  loading: boolean[]
  fail: (Fail | null)[]
  natural: { w: number; h: number } | null
  /** The size asked for in the latest frame (the biggest of that frame's asks), how much of the picture is shown at that size, and when (a counter, for least-recently-used). */
  want: number
  shown: number
  used: number
  /** The frame (see `ImageCache.frame`) `want` and `shown` were set in. */
  frame: number
  /** The biggest tier the budget gives this picture now (TOP: no limit). */
  cap: Idx
  /** The tier wanted when the budget was last divided: a change asks for a new division. */
  planned: Idx
}

interface Request {
  entry: Entry
  tier: Idx
  need: number
  seq: number
}

/** A load in flight, with the timer that gives it up. */
interface Run {
  settled: boolean
  timer: ReturnType<typeof setTimeout> | undefined
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

/** The reason of the failure that happened last. */
function failureKind(e: Entry): ImageFailure {
  let kind: ImageFailure = 'unreadable'
  let at = -Infinity
  for (const f of e.fail) {
    if (f && f.at >= at) {
      at = f.at
      kind = f.kind
    }
  }
  return kind
}

function validSize(n: { w: number; h: number } | null | undefined): n is { w: number; h: number } {
  return !!n && n.w > 0 && n.h > 0 && n.w < Infinity && n.h < Infinity
}

/**
 * The pixels a bitmap of tier `idx` takes: what is held, else what the loader would make of this picture (never enlarged, the full tier
 * held to FULL_MAX_PIXELS), else a guess (the shape of a bitmap held at another tier, the size of a typical photo).
 */
function costAt(e: Entry, idx: Idx): number {
  const h = heldOf(e, idx)
  if (h) return h.px
  const t = tierAt(idx)
  let shape: { w: number; h: number } | null = e.natural
  if (!shape && idx < TOP) {
    for (let i = 0; i < e.held.length && !shape; i++) {
      const o = e.held[i]
      if (o) shape = { w: o.bitmap.width, h: o.bitmap.height }
    }
  }
  if (!shape) return GUESS_PIXELS[idx] ?? GUESS_TOP
  const long = Math.max(shape.w, shape.h)
  // The size of the picture itself is known only when `natural` is: a held bitmap's shape says nothing about how big the picture is.
  let s = e.natural ? Math.min(1, t / long) : t / long
  if (idx === TOP) {
    if (!e.natural) return GUESS_TOP
    s = Math.min(s, Math.sqrt(FULL_MAX_PIXELS / (shape.w * shape.h)))
  }
  return Math.max(1, Math.round(shape.w * s)) * Math.max(1, Math.round(shape.h * s))
}

/** Pictures shown within about a quarter of each other in size count as equals (a size in log steps), so that a pixel does not reorder them. */
function sizeClass(px: number): number {
  return Math.round(Math.log2(Math.max(1, Math.min(px, 1e9))) * 3)
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
  private readonly loadTimeoutMs: number

  private readonly entries = new Map<string, Entry>()
  private visible: Set<string> = new Set()
  /** The next load wanted of each picture: one per picture, retargeted as the wanted size changes. */
  private readonly queue = new Map<string, Request>()
  private readonly runs = new Set<Run>()
  private running = 0
  private pixels = 0
  private tick = 0
  private seq = 0
  /** Counts the frames: `get` calls made without a microtask in between belong to one (a frame draws synchronously). */
  private frame = 0
  private frameOpen = false
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
    const timeout = options.loadTimeoutMs
    this.loadTimeoutMs = timeout !== undefined && timeout > 0 && timeout < Infinity ? timeout : DEFAULT_LOAD_TIMEOUT_MS
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  get(path: string, wantPx: number, shownPx?: number): ImageSlot {
    let e = this.entries.get(path)
    const onScreen = !this.disposed && this.visible.has(path)
    if (this.disposed || (!e && !onScreen)) return { bitmap: null, natural: null, failed: false }
    if (!e) {
      e = { path, held: [null, null, null], loading: [false, false, false], fail: [null, null, null], natural: null, want: 0, shown: 0, used: 0, frame: -1, cap: TOP, planned: -1 }
      this.entries.set(path, e)
    }
    e.used = ++this.tick
    this.note(e, wantPx, shownPx)
    if (onScreen) {
      // The picture is wanted at the biggest size any of its items shows it at.
      const all = wantedIdx(e.want, e.natural)
      // A new tier wanted changes who gets what: the budget is divided again.
      if (all !== e.planned) {
        e.planned = all
        this.schedule()
      }
      this.request(e, all, e.want)
    }
    const h = bestHeld(e, Math.min(wantedIdx(wantPx, e.natural), e.cap))
    // The bitmaps are whatever `load` gave: ImageBitmaps in the app, fakes in tests.
    if (!h && hasFailure(e)) return { bitmap: null, natural: e.natural, failed: true, reason: failureKind(e) }
    return { bitmap: h ? (h.bitmap as ImageBitmap) : null, natural: e.natural, failed: false }
  }

  /** Why the picture has nothing to draw (every try failed), else null. */
  failureOf(path: string): ImageFailure | null {
    const e = this.entries.get(path)
    if (!e || e.held.some(Boolean) || !hasFailure(e)) return null
    return failureKind(e)
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
    for (const run of this.runs) clearTimeout(run.timer)
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

  /* ----------------------------------------------------------- the wants --- */

  /** Records what a `get` asked: the biggest ask of the frame stands. */
  private note(e: Entry, wantPx: number, shownPx: number | undefined): void {
    if (!this.frameOpen) {
      this.frameOpen = true
      queueMicrotask(() => {
        this.frameOpen = false
        this.frame++
      })
    }
    const want = wantPx > 0 ? wantPx : 0
    const shown = shownPx === undefined ? want : shownPx > 0 ? shownPx : 0
    if (e.frame !== this.frame) {
      e.frame = this.frame
      e.want = want
      e.shown = shown
    } else {
      if (want > e.want) e.want = want
      if (shown > e.shown) e.shown = shown
    }
  }

  /* ----------------------------------------------------------- loading --- */

  /**
   * Queues the load of the wanted tier for a visible picture, unless it is held, running, or failed lately. The budget's cap on the
   * picture comes first: a tier above it is not asked for. When the wanted tier failed lately the best one that did not stands in for
   * it (a preview of a picture too big to read whole, sharper than the smaller one held): better than a placeholder or a blur, and the
   * wanted tier is tried again when its time comes.
   */
  private request(e: Entry, wanted: Idx, wantPx: number, wake = true): void {
    let idx = Math.min(wanted, e.cap)
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
    if (wake) this.schedule()
  }

  private blocked(e: Entry, idx: Idx): boolean {
    const f = e.fail[idx]
    return !!f && (f.permanent || this.now() < f.at + this.retryAfterMs * 2 ** Math.min(f.n - 1, MAX_BACKOFF_DOUBLINGS))
  }

  /**
   * Once the synchronous work of this frame is over: divide the budget, evict what the frame left evictable, then start the loads it
   * queued (the biggest need first, however the frame ordered its calls).
   */
  private schedule(): void {
    if (this.settleQueued || this.disposed) return
    this.settleQueued = true
    queueMicrotask(() => {
      this.settleQueued = false
      if (this.disposed) return
      this.plan()
      this.evict()
      this.trim()
      this.pump()
    })
  }

  private pump(): void {
    while (!this.disposed && this.running < this.concurrency) {
      // A picture that has not failed first, then the biggest need, the longest waiting among equals. (Everything queued is on
      // screen: setVisible drops the rest.)
      let next: Request | null = null
      let nextBad = 0
      for (const r of this.queue.values()) {
        const bad = r.entry.fail[r.tier] ? 1 : 0
        if (next === null || bad < nextBad || (bad === nextBad && (r.need > next.need || (r.need === next.need && r.seq < next.seq)))) {
          next = r
          nextBad = bad
        }
      }
      if (!next) return
      this.queue.delete(next.entry.path)
      this.start(next.entry, next.tier)
    }
  }

  private start(e: Entry, idx: Idx): void {
    e.loading[idx] = true
    this.running++
    const run: Run = { settled: false, timer: undefined }
    this.runs.add(run)
    // Whichever comes first, the answer or the timer, settles the load; what comes after is closed.
    const settle = (img: LoadedImage | LoadFailure | null): void => {
      if (run.settled) {
        closeQuietly(img?.bitmap)
        return
      }
      run.settled = true
      clearTimeout(run.timer)
      this.runs.delete(run)
      this.arrived(e, idx, img)
    }
    run.timer = setTimeout(() => settle(null), this.loadTimeoutMs)
    ;(run.timer as { unref?: () => void }).unref?.()
    let job: Promise<LoadedImage | LoadFailure | null>
    try {
      job = Promise.resolve(this.options.load(e.path, tierAt(idx)))
    } catch (err) {
      job = Promise.reject(err)
    }
    job.then(settle, () => settle(null))
  }

  private arrived(e: Entry, idx: Idx, img: LoadedImage | LoadFailure | null): void {
    this.running--
    e.loading[idx] = false
    if (this.disposed || this.entries.get(e.path) !== e) {
      // Forgotten, cleared or disposed while it ran: nobody wants it.
      closeQuietly(img?.bitmap)
      this.pump()
      return
    }
    const bitmap = img?.bitmap
    if (img && usable(bitmap)) {
      this.adopt(e, idx, bitmap, img.natural)
      // What this picture now wants may be something else (its size was learned): so may what waits for it.
      const waiting = this.queue.get(e.path)
      if (waiting) this.request(e, wantedIdx(e.want, e.natural), waiting.need)
      this.changed()
    } else {
      closeQuietly(img?.bitmap)
      const first = !hasFailure(e) && bestHeld(e, 0) === null
      const kind: ImageFailure = img?.failure && FAILURES.includes(img.failure) ? img.failure : 'unreadable'
      const prev = e.fail[idx]
      const fail: Fail = { at: this.now(), n: (prev?.n ?? 0) + 1, kind, permanent: kind === 'too-large' }
      // A verdict on the file holds for every tier of it.
      if (fail.permanent) for (let i = 0; i < e.fail.length; i++) e.fail[i] = { ...fail }
      else e.fail[idx] = fail
      const learned = !e.natural && validSize(img?.natural)
      if (img && validSize(img.natural)) e.natural = Object.freeze({ w: img.natural.w, h: img.natural.h })
      if (first || learned) this.changed()
    }
    // What was learned (a size, a failure) changes the division of the budget: once for the loads that land together.
    this.schedule()
  }

  private adopt(e: Entry, idx: Idx, bitmap: BitmapLike, natural: { w: number; h: number } | undefined): void {
    this.drop(e, idx)
    const px = bitmap.width * bitmap.height
    e.held[idx] = { bitmap, px, long: Math.max(bitmap.width, bitmap.height) }
    this.pixels += px
    e.fail[idx] = null
    const n = natural
    if (validSize(n)) {
      e.natural = Object.freeze({ w: n.w, h: n.h })
    } else if (Math.max(bitmap.width, bitmap.height) < tierAt(idx)) {
      // Smaller than the size it was asked at: the picture itself.
      e.natural = Object.freeze({ w: bitmap.width, h: bitmap.height })
    }
    // A bigger version has everything a smaller one had. (One that came above what the budget gives the picture is only a spare: the
    // smaller bitmap it is to be replaced by stays.)
    if (idx <= e.cap) for (let i = 0; i < idx; i++) this.drop(e, i)
  }

  private changed(): void {
    if (this.notifyQueued || this.disposed) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      if (!this.disposed) this.options.onLoaded()
    })
  }

  /* -------------------------------------------------------------- budget --- */

  /**
   * Divides the budget among the pictures on screen: sets each one's `cap`, the biggest tier it may hold, and asks for the loads that
   * follow (a smaller tier for a picture whose cap came down). When what they all want fits, nobody is capped. Otherwise every
   * picture gets the 256 tier first, then the pictures shown biggest on the screen (the ones drawn last among equals) get as much of
   * what they want as the room left allows. Sizes not known yet are guessed; they are corrected when a load brings the real ones.
   */
  private plan(): void {
    const live: { e: Entry; want: Idx; floor: number }[] = []
    let floors = 0
    let wanted = 0
    for (const e of this.entries.values()) {
      if (!this.visible.has(e.path)) {
        e.cap = TOP
        e.planned = -1
        continue
      }
      const want = wantedIdx(e.want, e.natural)
      const floor = costAt(e, 0)
      floors += floor
      wanted += costAt(e, want)
      e.planned = want
      live.push({ e, want, floor })
    }
    if (wanted <= this.budget) {
      for (const x of live) x.e.cap = TOP
    } else {
      live.sort((a, b) => sizeClass(b.e.shown) - sizeClass(a.e.shown) || b.e.used - a.e.used)
      let total = floors
      for (const x of live) {
        let t = x.want
        while (t > 0 && total - x.floor + costAt(x.e, t) > this.budget) t--
        if (t > 0) total += costAt(x.e, t) - x.floor
        // A picture that gets all it wants is not capped: it can ask for more when it wants more.
        x.e.cap = t >= x.want ? TOP : t
      }
    }
    for (const x of live) this.request(x.e, x.want, x.e.want, false)
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
      const drawn = onScreen ? bestHeld(e, Math.min(wantedIdx(e.want, e.natural), e.cap)) : null
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
