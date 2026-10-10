import { describe, expect, it, vi } from 'vitest'
import { IMAGE_TIERS, type ImageFailure, type ImageSlot, type ImageTier } from '../src/board/api'
import { ImageCache, type BitmapLike, type ImageCacheOptions, type LoadFailure, type LoadedImage } from '../src/board/imageCache'

/**
 * Review fixes renderer-cache-1 (the 128 megapixel budget is a real limit, drawn pictures included), renderer-cache-3 / desktop-4
 * (the cache says WHY a picture cannot be shown) and renderer-cache-m5 (a load that hangs frees its slot; failing pictures wait behind
 * healthy ones). The cache against a world of pictures whose bitmaps have the sizes the real loader makes (256 / 1024 long side, the
 * picture itself held to 8192 and 32 megapixels), counted by the pixels of the bitmaps still open, not by the cache's own books.
 */

class Fake implements BitmapLike {
  closed = 0
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  close(): void {
    this.closed++
  }
}

const settle = () => new Promise<void>((r) => setImmediate(r))

interface Item {
  path: string
  /** Device pixels the whole picture must be sharp at, and how big the part that is shown is. */
  want: number
  shown?: number
}

/** The bitmap a real load makes of a picture of `nat` at `tier`, and whether it reports the picture's size. */
function bitmapFor(nat: { w: number; h: number }, tier: ImageTier): { w: number; h: number; natural: boolean } {
  const long = Math.max(nat.w, nat.h)
  if (tier === 8192) {
    const s = Math.min(1, 8192 / long, Math.sqrt(32e6 / (nat.w * nat.h)))
    return { w: Math.max(1, Math.round(nat.w * s)), h: Math.max(1, Math.round(nat.h * s)), natural: true }
  }
  if (long <= tier) return { w: nat.w, h: nat.h, natural: true }
  const s = tier / long
  return { w: Math.max(1, Math.round(nat.w * s)), h: Math.max(1, Math.round(nat.h * s)), natural: false }
}

function world(natOf: (path: string) => { w: number; h: number }, options: Partial<ImageCacheOptions> = {}) {
  const made: Fake[] = []
  const loads: { path: string; tier: ImageTier }[] = []
  let live = 0
  let peakLive = 0
  const load = async (path: string, tier: ImageTier): Promise<LoadedImage> => {
    loads.push({ path, tier })
    await null
    const nat = natOf(path)
    const b = bitmapFor(nat, tier)
    const f = new Fake(b.w, b.h)
    made.push(f)
    live += b.w * b.h
    peakLive = Math.max(peakLive, live)
    const close = f.close.bind(f)
    f.close = () => {
      if (f.closed === 0) live -= f.width * f.height
      close()
    }
    return b.natural ? { bitmap: f, natural: nat } : { bitmap: f }
  }
  const cache = new ImageCache({ load, onLoaded: () => {}, ...options })
  /** One frame as the board draws it: the visible set first, then a get per item in drawing order. */
  const frame = (items: Item[]): ImageSlot[] => {
    cache.setVisible(items.map((i) => i.path))
    return items.map((i) => cache.get(i.path, i.want, i.shown ?? i.want))
  }
  return {
    cache,
    made,
    loads,
    frame,
    get live() {
      return live
    },
    get peakLive() {
      return peakLive
    },
    /** Frames until the cache has nothing left to load (at most `max`); every frame's slots go to `each`. */
    async run(items: Item[], max = 60, each?: (slots: ImageSlot[]) => void): Promise<ImageSlot[]> {
      let slots: ImageSlot[] = []
      for (let i = 0; i < max; i++) {
        slots = frame(items)
        each?.(slots)
        await settle()
        const s = cache.stats()
        if (i > 1 && s.loading === 0 && s.queued === 0) {
          // One more frame: what arrived may change what is wanted.
          slots = frame(items)
          each?.(slots)
          await settle()
          if (cache.stats().loading === 0 && cache.stats().queued === 0) break
        }
      }
      return slots
    },
  }
}

const PHOTO = { w: 4000, h: 3000 }
const BUDGET = 128e6
const longOf = (s: ImageSlot): number => (s.bitmap ? Math.max(s.bitmap.width, s.bitmap.height) : 0)

describe('the budget is a real limit, pictures that are drawn included (renderer-cache-1)', () => {
  it('holds 300 distinct visible pictures wanted at 600 px (the 1024 tier, 236 megapixels) within the budget, none of them blank', async () => {
    const w = world(() => PHOTO)
    const items: Item[] = Array.from({ length: 300 }, (_, i) => ({ path: `p${i}.jpg`, want: 600 }))
    const slots = await w.run(items)
    expect(w.cache.stats().pixels).toBeLessThanOrEqual(BUDGET)
    expect(w.live).toBeLessThanOrEqual(BUDGET)
    expect(w.peakLive).toBeLessThanOrEqual(BUDGET * 1.25)
    expect(slots.every((s) => s.bitmap !== null && !s.failed)).toBe(true)
    // The room goes to the pictures drawn last (on top); the rest keep the 256 tier.
    const sharp = slots.filter((s) => longOf(s) === 1024).length
    expect(sharp).toBeGreaterThan(100)
    expect(sharp).toBeLessThan(300)
    expect(longOf(slots[299]!)).toBe(1024)
    expect(longOf(slots[0]!)).toBe(256)
  })

  it('holds 40 piled pictures shown at 1792 px (the picture itself, 480 megapixels) within the budget; the top one stays sharp', async () => {
    const w = world(() => PHOTO)
    const items: Item[] = Array.from({ length: 40 }, (_, i) => ({ path: `p${i}.jpg`, want: 1792 }))
    const slots = await w.run(items)
    expect(w.cache.stats().pixels).toBeLessThanOrEqual(BUDGET)
    expect(w.peakLive).toBeLessThanOrEqual(BUDGET * 1.25)
    expect(slots.every((s) => s.bitmap !== null)).toBe(true)
    expect(longOf(slots[39]!)).toBe(4000)
    expect(longOf(slots[0]!)).toBe(256)
    // The original is read for no more pictures than the budget holds (10 of 12 megapixels).
    expect(slots.filter((s) => longOf(s) === 4000)).toHaveLength(10)
  })

  it('keeps even a thousand and a half piled pictures within the budget (the board\'s item limit): every one holds its 256 tier at least', async () => {
    const w = world(() => PHOTO)
    const items: Item[] = Array.from({ length: 1500 }, (_, i) => ({ path: `p${i}.jpg`, want: 2000 }))
    const slots = await w.run(items, 80)
    expect(w.cache.stats().pixels).toBeLessThanOrEqual(BUDGET)
    expect(w.peakLive).toBeLessThanOrEqual(BUDGET * 1.25)
    expect(slots.every((s) => s.bitmap !== null)).toBe(true)
  })

  it('serves a detail crop at the 1024 tier when that is as sharp as it is shown (a 10% crop shown 110 px wide wants 1100 px of the whole)', async () => {
    const w = world(() => PHOTO)
    const items: Item[] = Array.from({ length: 20 }, (_, i) => ({ path: `c${i}.jpg`, want: 1100, shown: 110 }))
    const slots = await w.run(items)
    // 20 x 0.79 megapixels, not 20 x 12.
    expect(w.cache.stats().pixels).toBeLessThan(20e6)
    expect(slots.every((s) => longOf(s) === 1024)).toBe(true)
    expect(w.loads.some((l) => l.tier === 8192)).toBe(false)
  })

  it('keeps a crop sharp where the sharpness is needed, and serves the pictures shown biggest first when the budget is short', async () => {
    const w = world(() => PHOTO)
    // 20 crops of 5% that need the whole picture at 2200 px (the original) to be sharp: only 10 of them fit the budget at that size.
    const items: Item[] = Array.from({ length: 20 }, (_, i) => ({ path: `c${i}.jpg`, want: 2200, shown: 110 }))
    // One of them is shown big (the user zoomed to it): it comes first, whatever its place in the drawing order.
    items[0] = { path: 'c0.jpg', want: 2200, shown: 900 }
    const slots = await w.run(items)
    expect(w.cache.stats().pixels).toBeLessThanOrEqual(BUDGET)
    expect(longOf(slots[0]!)).toBe(4000)
    expect(slots.filter((s) => longOf(s) === 4000).length).toBeLessThanOrEqual(11)
    expect(slots.every((s) => s.bitmap !== null)).toBe(true)
  })

  it('gives every picture what it wants while that fits: nothing is held back below the budget', async () => {
    const w = world(() => PHOTO)
    const items: Item[] = Array.from({ length: 8 }, (_, i) => ({ path: `p${i}.jpg`, want: 3000 }))
    const slots = await w.run(items)
    expect(slots.every((s) => longOf(s) === 4000)).toBe(true)
    expect(w.cache.stats().pixels).toBe(8 * 12e6)
  })

  it('wants a picture drawn several times at the biggest size any of them shows, and ranks it by the biggest part shown', async () => {
    const w = world(() => PHOTO)
    w.cache.setVisible(['a.jpg'])
    w.cache.get('a.jpg', 100, 100)
    w.cache.get('a.jpg', 3000, 1500)
    w.cache.get('a.jpg', 200, 200)
    await settle()
    expect(w.loads).toEqual([{ path: 'a.jpg', tier: 8192 }])
  })

  it('shows no blank at any step while the view zooms out and in: a picture keeps its bitmap until the replacement has arrived', async () => {
    const w = world(() => PHOTO)
    const paths = Array.from({ length: 40 }, (_, i) => `p${i}.jpg`)
    const at = (want: number): Item[] => paths.map((path) => ({ path, want, shown: want }))
    let blank = 0
    let frames = 0
    const watch = (slots: ImageSlot[]): void => {
      frames++
      blank += slots.filter((s) => s.bitmap === null).length
    }
    await w.run(at(1792), 60, watch)
    // Once every picture has been shown (first run), none may go blank again.
    blank = 0
    for (const want of [900, 300, 100, 300, 900, 1792, 3000, 600, 1792]) {
      await w.run(at(want), 60, watch)
      expect(w.cache.stats().pixels).toBeLessThanOrEqual(BUDGET * 1.25)
    }
    expect(frames).toBeGreaterThan(20)
    expect(blank).toBe(0)
    expect(w.peakLive).toBeLessThanOrEqual(BUDGET * 1.3)
  })

  it('gives the biggest-shown pictures the room first, and among equals the ones drawn last', async () => {
    // Room for three originals (36 megapixels) and the 1024 tier of the others. (A picture whose size is not known yet counts as 16
    // megapixels until it has been loaded once, so the third original is granted when the first two have arrived.)
    const w = world(() => PHOTO, { budgetPixels: 42e6 })
    const items: Item[] = [
      { path: 'small-first.jpg', want: 3000, shown: 300 },
      { path: 'big.jpg', want: 3000, shown: 3000 },
      { path: 'mid-1.jpg', want: 3000, shown: 1000 },
      { path: 'mid-2.jpg', want: 3000, shown: 1000 },
      { path: 'mid-3.jpg', want: 3000, shown: 1000 },
    ]
    const slots = await w.run(items)
    expect(slots.map(longOf)).toEqual([1024, 4000, 1024, 4000, 4000])
    expect(w.cache.stats().pixels).toBeLessThanOrEqual(42e6)
  })

  it('closes what the budget took back only after the smaller replacement has arrived: no frame without a bitmap for a picture that had one, none closed twice', async () => {
    const w = world(() => PHOTO, { budgetPixels: 20e6 })
    await w.run([{ path: 'a.jpg', want: 3000 }])
    expect(longOf(w.cache.get('a.jpg', 3000))).toBe(4000)
    // A second picture on top wants the room: 'a' is brought down to the 1024 tier.
    const both: Item[] = [{ path: 'a.jpg', want: 3000 }, { path: 'b.jpg', want: 3000 }]
    const aSeen: number[] = []
    const slots = await w.run(both, 40, (s) => aSeen.push(longOf(s[0]!)))
    expect(aSeen.every((n) => n > 0)).toBe(true)
    // It went 4000 -> 1024 and stayed there; the original was not dropped before the 1024 one had arrived.
    expect(aSeen[0]).toBe(4000)
    expect(aSeen[aSeen.length - 1]).toBe(1024)
    expect(slots.map(longOf)).toEqual([1024, 4000])
    expect(w.cache.stats().pixels).toBeLessThanOrEqual(20e6)
    expect(w.live).toBe(w.cache.stats().pixels)
    for (const f of w.made) expect(f.closed).toBeLessThanOrEqual(1)
  })
})

describe('the cache says why a picture cannot be shown (renderer-cache-3, desktop-4)', () => {
  const failing = (reasons: Record<string, ImageFailure | 'null' | 'reject'>) => {
    const loads: string[] = []
    const load = async (path: string, tier: ImageTier): Promise<LoadedImage | LoadFailure | null> => {
      loads.push(`${path}@${tier}`)
      const r = reasons[path]
      if (r === 'reject') throw new Error('boom')
      if (r === 'null' || r === undefined) return null
      return r === 'too-large' ? { failure: r, natural: { w: 30000, h: 30000 } } : { failure: r }
    }
    let now = 0
    const cache = new ImageCache({ load, onLoaded: () => {}, now: () => now })
    return {
      cache,
      loads,
      advance(ms: number) {
        now += ms
      },
    }
  }
  const frame = async (c: ImageCache, path: string, want = 300): Promise<ImageSlot> => {
    c.setVisible([path])
    const s = c.get(path, want)
    await settle()
    return s
  }

  it('reports missing, too-large and unreadable (a null, a rejection) apart, in the slot and in failureOf', async () => {
    const t = failing({ 'gone.png': 'missing', 'huge.png': 'too-large', 'null.png': 'null', 'boom.png': 'reject' })
    const expected: [string, ImageFailure][] = [['gone.png', 'missing'], ['huge.png', 'too-large'], ['null.png', 'unreadable'], ['boom.png', 'unreadable']]
    for (const [path, reason] of expected) {
      await frame(t.cache, path)
      await frame(t.cache, path)
      const slot = await frame(t.cache, path)
      expect(slot, path).toMatchObject({ bitmap: null, failed: true, reason })
      expect(t.cache.failureOf(path), path).toBe(reason)
    }
    expect(t.cache.failureOf('never-seen.png')).toBeNull()
    // The size a too-large verdict carries is kept for the info card.
    t.cache.setVisible(['huge.png'])
    expect(t.cache.get('huge.png', 300).natural).toEqual({ w: 30000, h: 30000 })
  })

  it('takes a reason it does not know for unreadable', async () => {
    const load = async (): Promise<LoadFailure | null> => ({ failure: 'on-fire' as ImageFailure })
    const cache = new ImageCache({ load, onLoaded: () => {} })
    await frame(cache, 'a.png')
    expect(await frame(cache, 'a.png')).toMatchObject({ failed: true, reason: 'unreadable' })
    expect(cache.failureOf('a.png')).toBe('unreadable')
  })

  it('retries a missing or unreadable picture after its wait, and a too-large one never (until it is forgotten)', async () => {
    const t = failing({ 'gone.png': 'missing', 'huge.png': 'too-large' })
    for (const p of ['gone.png', 'huge.png']) {
      await frame(t.cache, p)
      await frame(t.cache, p)
    }
    const firstTries = t.loads.length
    for (const hours of [1, 5, 24]) {
      t.advance(hours * 3_600_000)
      for (const p of ['gone.png', 'huge.png']) {
        await frame(t.cache, p)
        await frame(t.cache, p)
      }
    }
    const gone = t.loads.filter((l) => l.startsWith('gone.png')).length
    const huge = t.loads.filter((l) => l.startsWith('huge.png')).length
    expect(huge).toBe(1) // the verdict holds for every tier: one read
    expect(gone).toBeGreaterThan(3)
    expect(firstTries).toBeGreaterThan(0)
    t.cache.forget('huge.png')
    await frame(t.cache, 'huge.png')
    await frame(t.cache, 'huge.png')
    expect(t.loads.filter((l) => l.startsWith('huge.png'))).toHaveLength(2)
  })

  it('says nothing about failure once a bitmap is held, and forgets the reason with the failure', async () => {
    let fail = true
    const load = async (_p: string, tier: ImageTier): Promise<LoadedImage | LoadFailure | null> => (fail ? { failure: 'missing' } : { bitmap: new Fake(tier, tier) })
    let now = 0
    const cache = new ImageCache({ load, onLoaded: () => {}, now: () => now })
    expect((await frame(cache, 'a.png')).failed).toBe(false)
    expect(await frame(cache, 'a.png')).toMatchObject({ failed: true, reason: 'missing' })
    fail = false
    now += 10 * 60_000
    await frame(cache, 'a.png')
    await frame(cache, 'a.png')
    const slot = await frame(cache, 'a.png')
    expect(slot.failed).toBe(false)
    expect(slot.reason).toBeUndefined()
    expect(slot.bitmap).not.toBeNull()
    expect(cache.failureOf('a.png')).toBeNull()
  })
})

describe('a load that hangs, and pictures that keep failing (renderer-cache-m5)', () => {
  it('gives up on a load after loadTimeoutMs (30 s): the slot is free, the picture counts as failed, and what it brings later is closed', async () => {
    vi.useFakeTimers()
    try {
      const hung: { resolve: (v: LoadedImage) => void }[] = []
      const order: string[] = []
      const load = (path: string, tier: ImageTier): Promise<LoadedImage> => {
        order.push(`${path}@${tier}`)
        if (path.startsWith('hang')) return new Promise<LoadedImage>((resolve) => hung.push({ resolve }))
        return Promise.resolve({ bitmap: new Fake(tier, tier) })
      }
      const cache = new ImageCache({ load, onLoaded: () => {}, concurrency: 2 })
      const paths = ['hang1.png', 'hang2.png', 'ok.png']
      cache.setVisible(paths)
      for (const p of paths) cache.get(p, 100)
      await vi.advanceTimersByTimeAsync(10)
      // Two slots, both stuck: the healthy picture waits.
      expect(order).toEqual(['hang1.png@256', 'hang2.png@256'])
      expect(cache.stats()).toMatchObject({ loading: 2, queued: 1 })
      await vi.advanceTimersByTimeAsync(29_000)
      expect(order).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(order).toEqual(['hang1.png@256', 'hang2.png@256', 'ok.png@256'])
      for (const p of paths) cache.get(p, 100)
      expect(cache.get('ok.png', 100).bitmap).not.toBeNull()
      expect(cache.get('hang1.png', 100)).toMatchObject({ bitmap: null, failed: true, reason: 'unreadable' })
      expect(cache.stats()).toMatchObject({ loading: 0, failed: 2 })
      // The hung loads end at last: their bitmaps are closed at once, never held.
      const late = new Fake(256, 192)
      hung[0]!.resolve({ bitmap: late })
      await vi.advanceTimersByTimeAsync(10)
      expect(late.closed).toBe(1)
      expect(cache.stats().bitmaps).toBe(1)
      cache.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes the timeout as an option, and stops its timers on dispose', async () => {
    vi.useFakeTimers()
    try {
      const cache = new ImageCache({ load: () => new Promise<LoadedImage>(() => {}), onLoaded: () => {}, loadTimeoutMs: 1000 })
      cache.setVisible(['a.png'])
      cache.get('a.png', 100)
      await vi.advanceTimersByTimeAsync(5)
      expect(cache.stats().loading).toBe(1)
      await vi.advanceTimersByTimeAsync(1100)
      expect(cache.stats()).toMatchObject({ loading: 0, failed: 1 })
      const second = new ImageCache({ load: () => new Promise<LoadedImage>(() => {}), onLoaded: () => {}, loadTimeoutMs: 1000 })
      second.setVisible(['b.png'])
      second.get('b.png', 100)
      await vi.advanceTimersByTimeAsync(5)
      second.dispose()
      expect(vi.getTimerCount()).toBe(0)
      cache.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the pictures that did not fail before the ones that did, however big the failed one\'s need', async () => {
    let now = 0
    const order: string[] = []
    const failOnce = new Set(['bad.png'])
    const load = async (path: string, tier: ImageTier): Promise<LoadedImage | null> => {
      order.push(`${path}@${tier}`)
      if (failOnce.delete(path)) return null
      return { bitmap: new Fake(tier, tier) }
    }
    const cache = new ImageCache({ load, onLoaded: () => {}, concurrency: 1, now: () => now, retryAfterMs: 1000 })
    cache.setVisible(['bad.png'])
    cache.get('bad.png', 100)
    await settle()
    expect(order).toEqual(['bad.png@256'])
    // Its time is up; at the same moment two new pictures come into view, with a smaller need than the failed one has.
    now += 5000
    cache.setVisible(['bad.png', 'new1.png', 'new2.png'])
    cache.get('bad.png', 250)
    cache.get('new1.png', 100)
    cache.get('new2.png', 100)
    await settle()
    expect(order.slice(1)).toEqual(['new1.png@256', 'new2.png@256', 'bad.png@256'])
  })
})

describe('the tiers, for reference', () => {
  it('are the three the host makes', () => {
    expect([...IMAGE_TIERS]).toEqual([256, 1024, 8192])
  })
})
