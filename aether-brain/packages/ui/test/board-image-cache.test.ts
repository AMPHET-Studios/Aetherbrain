import { describe, expect, it } from 'vitest'
import { IMAGE_TIERS, type ImageTier } from '../src/board/api'
import { ImageCache, pickTier, type BitmapLike, type ImageCacheOptions, type LoadedImage } from '../src/board/imageCache'

/**
 * The reference board's picture cache against fake bitmaps and a loader the test settles by hand: tiers, the budget and what is evicted
 * first, loads (at most N at once, biggest need first, never twice, only for what is on screen), failures and their retries on an
 * injected clock, late results, and a seeded random walk that checks the books after every step.
 */

class Fake implements BitmapLike {
  closed = 0
  delivered = false
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  close(): void {
    this.closed++
  }
}

interface Job {
  path: string
  tier: ImageTier
  settled: boolean
  /** Settle with a bitmap made (and tracked) here. */
  give(w: number, h: number, natural?: { w: number; h: number }): Fake
  /** Settle with null: the picture could not be read. */
  none(): void
  /** Settle with a rejection. */
  reject(): void
}

/** A picture far bigger than any tier: given as `natural`, it keeps the cache from concluding that a small bitmap is the whole picture. */
const BIG = { w: 3000, h: 2000 }

function rig(options: Partial<ImageCacheOptions> = {}) {
  const jobs: Job[] = []
  const made: Fake[] = []
  let loaded = 0
  let running = 0
  let peak = 0
  const load = (path: string, tier: ImageTier) =>
    new Promise<LoadedImage | null>((resolve, reject) => {
      running++
      peak = Math.max(peak, running)
      const done = () => {
        job.settled = true
        running--
      }
      const job: Job = {
        path,
        tier,
        settled: false,
        give(w, h, natural) {
          const b = new Fake(w, h)
          b.delivered = true
          made.push(b)
          done()
          resolve(natural ? { bitmap: b, natural } : { bitmap: b })
          return b
        },
        none() {
          done()
          resolve(null)
        },
        reject() {
          done()
          reject(new Error('boom'))
        },
      }
      jobs.push(job)
    })
  const cache = new ImageCache({ load, onLoaded: () => void loaded++, ...options })
  return {
    cache,
    jobs,
    made,
    get loaded() {
      return loaded
    },
    get peak() {
      return peak
    },
    pending: () => jobs.filter((j) => !j.settled),
    /** The bitmap `get` hands out. */
    drawn: (path: string, want: number) => cache.get(path, want).bitmap as unknown as Fake | null,
    /** The only pending job, or a failure. */
    only(): Job {
      const p = jobs.filter((j) => !j.settled)
      if (p.length !== 1) throw new Error(`expected one pending load, got ${p.length}`)
      return p[0]!
    },
  }
}

/** Lets every promise and microtask the cache queued run. */
const settle = () => new Promise<void>((r) => setImmediate(r))

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('pickTier', () => {
  it.each([
    [0, 256],
    [-5, 256],
    [Number.NaN, 256],
    [Number.NEGATIVE_INFINITY, 256],
    [1, 256],
    [255.9, 256],
    [256, 256],
    // A quarter beyond a tier is still served by it: the next tier is 4 to 8 times as long.
    [320, 256],
    [320.5, 1024],
    [1000, 1024],
    [1024, 1024],
    [1280, 1024],
    [1280.5, 8192],
    [4000, 8192],
    [8192, 8192],
    [100000, 8192],
    [Number.POSITIVE_INFINITY, 8192],
  ])('wants %s px: tier %s', (want, tier) => {
    expect(pickTier(want, null)).toBe(tier)
  })

  it('never goes past what the picture has, and the picture itself is the biggest tier a big picture reaches', () => {
    // 200 px: whole at 256. 600 px: whole at 1024 (the preview is never enlarged), so no 8192.
    expect(pickTier(5000, { w: 200, h: 100 })).toBe(256)
    expect(pickTier(5000, { w: 256, h: 256 })).toBe(256)
    expect(pickTier(5000, { w: 600, h: 400 })).toBe(1024)
    expect(pickTier(5000, { w: 1024, h: 10 })).toBe(1024)
    // Over 1024 px the preview is a scaled-down copy: zoomed in, the picture itself is the only sharper version (the slack is for
    // what is asked, not for what the picture has: a 300 px picture is not made into a 256 px preview).
    expect(pickTier(5000, { w: 1025, h: 10 })).toBe(8192)
    expect(pickTier(5000, { w: 300, h: 10 })).toBe(1024)
    expect(pickTier(5000, { w: 3000, h: 2000 })).toBe(8192)
    expect(pickTier(5000, { w: 20000, h: 100 })).toBe(8192)
    // The longer side counts, whichever it is.
    expect(pickTier(5000, { w: 100, h: 20000 })).toBe(8192)
    expect(pickTier(5000, { w: 100, h: 600 })).toBe(1024)
    // A small ask stays small whatever the picture has.
    expect(pickTier(100, { w: 3000, h: 2000 })).toBe(256)
    expect(pickTier(900, { w: 3000, h: 2000 })).toBe(1024)
    // Sizes that are not sizes are not believed.
    expect(pickTier(5000, { w: 0, h: 0 })).toBe(8192)
    expect(pickTier(5000, { w: Number.NaN, h: 10 })).toBe(8192)
    expect(pickTier(5000, { w: Number.POSITIVE_INFINITY, h: 10 })).toBe(8192)
  })

  it('is monotone in the size asked, is never bigger than needed, and is always a tier big enough (seeded)', () => {
    const rnd = mulberry32(7)
    for (let i = 0; i < 3000; i++) {
      const natural = rnd() < 0.5 ? null : { w: 1 + Math.floor(rnd() * 12000), h: 1 + Math.floor(rnd() * 12000) }
      const a = rnd() < 0.05 ? 0 : Math.floor(rnd() * 12000)
      const b = a + Math.floor(rnd() * 5000)
      const ta = pickTier(a, natural)
      const tb = pickTier(b, natural)
      expect(IMAGE_TIERS).toContain(ta)
      expect(ta).toBeLessThanOrEqual(tb)
      // Big enough for what is asked (a quarter short is enough), or for the whole picture, or the biggest there is.
      const need = Math.min((a || 1) / 1.25, natural ? Math.max(natural.w, natural.h) : Infinity, 8192)
      expect(ta).toBeGreaterThanOrEqual(need)
      // Never a bigger one than that need allows: the next tier down would not do.
      const below = IMAGE_TIERS[IMAGE_TIERS.indexOf(ta) - 1]
      if (below !== undefined) expect(below).toBeLessThan(need)
    }
  })
})

describe('ImageCache: what get answers, and which tier it loads', () => {
  it('loads the wanted tier of a visible picture, in a microtask, and nothing for a picture that is not visible', async () => {
    const t = rig()
    expect(t.cache.get('a.png', 400)).toEqual({ bitmap: null, natural: null, failed: false })
    await settle()
    expect(t.jobs).toHaveLength(0)
    expect(t.cache.stats()).toEqual({ pixels: 0, bitmaps: 0, loading: 0, queued: 0, failed: 0 })

    t.cache.setVisible(['a.png'])
    expect(t.cache.get('a.png', 400)).toEqual({ bitmap: null, natural: null, failed: false })
    // get never waits for anything, nor calls the loader itself.
    expect(t.jobs).toHaveLength(0)
    expect(t.cache.stats().queued).toBe(1)
    await settle()
    expect(t.jobs.map((j) => [j.path, j.tier])).toEqual([['a.png', 1024]])
    expect(t.cache.stats()).toMatchObject({ loading: 1, queued: 0 })

    const b = t.only().give(300, 200)
    await settle()
    expect(t.cache.get('a.png', 400).bitmap).toBe(b)
    expect(t.loaded).toBe(1)
    expect(t.cache.stats()).toEqual({ pixels: 60000, bitmaps: 1, loading: 0, queued: 0, failed: 0 })
  })

  it('asks for the tier the size needs, from the smallest to the picture itself', async () => {
    const t = rig({ concurrency: 3 })
    t.cache.setVisible(['s', 'm', 'l'])
    t.cache.get('s', 200)
    t.cache.get('m', 700)
    t.cache.get('l', 3000)
    await settle()
    expect(t.jobs.map((j) => [j.path, j.tier]).sort()).toEqual([
      ['l', 8192],
      ['m', 1024],
      ['s', 256],
    ])
  })

  it('draws with the held bitmap that fits best: the smallest big enough, else the biggest smaller one', async () => {
    const t = rig()
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    await settle()
    const small = t.only().give(256, 192, BIG)
    await settle()
    expect(t.drawn('a', 100)).toBe(small)
    await settle() // the next frame

    // Zoomed in: the 256 still draws (the biggest smaller one) while the 1024 comes.
    expect(t.drawn('a', 900)).toBe(small)
    await settle()
    expect(t.only().tier).toBe(1024)
    const mid = t.only().give(1024, 768, BIG)
    await settle()
    // The bigger one has everything the smaller had: the smaller is closed, not kept to be drawn from.
    expect(small.closed).toBe(1)
    expect(mid.closed).toBe(0)
    expect(t.drawn('a', 900)).toBe(mid)
    expect(t.cache.stats()).toMatchObject({ bitmaps: 1, pixels: 1024 * 768 })
    await settle() // the next frame

    // Zoomed out again: the 1024 is big enough, so it draws at once; the 256 is asked for and, once there, draws instead.
    expect(t.drawn('a', 100)).toBe(mid)
    await settle()
    expect(t.only().tier).toBe(256)
    const small2 = t.only().give(256, 192, BIG)
    await settle()
    expect(t.drawn('a', 100)).toBe(small2)
    expect(t.drawn('a', 900)).toBe(mid)
    expect(mid.closed).toBe(0)
    expect(t.cache.stats().bitmaps).toBe(2)
  })

  it('does not ask for a tier it already holds, however often it is asked', async () => {
    const t = rig()
    t.cache.setVisible(['a'])
    for (let frame = 0; frame < 3; frame++) {
      t.cache.get('a', 600)
      t.cache.get('a', 600)
      await settle()
    }
    expect(t.jobs).toHaveLength(1)
    t.only().give(600, 600, BIG)
    await settle()
    for (let frame = 0; frame < 3; frame++) {
      t.cache.get('a', 600)
      t.cache.get('a', 1000)
      await settle()
    }
    // 1000 px is the same tier as 600 px.
    expect(t.jobs).toHaveLength(1)
  })
})

describe('ImageCache: options', () => {
  it('calls load, onLoaded and now as methods of the options object', async () => {
    const o = {
      calls: [] as string[],
      loaded: 0,
      clock: 100,
      load(this: { calls: string[] }, path: string, tier: ImageTier) {
        this.calls.push(`${path}@${tier}`)
        return Promise.resolve(null)
      },
      onLoaded(this: { loaded: number }) {
        this.loaded++
      },
      now(this: { clock: number }) {
        return this.clock
      },
      retryAfterMs: 50,
    }
    const cache = new ImageCache(o)
    cache.setVisible(['a'])
    cache.get('a', 100)
    await settle()
    expect(o.calls).toEqual(['a@256'])
    expect(o.loaded).toBe(1)
    o.clock = 149
    cache.get('a', 100)
    await settle()
    expect(o.calls).toHaveLength(1)
    o.clock = 150
    cache.get('a', 100)
    await settle()
    expect(o.calls).toHaveLength(2)
  })
})

describe('ImageCache: natural size', () => {
  it('learns it from the load, and a picture smaller than the tier it was asked at is its own size', async () => {
    const t = rig()
    t.cache.setVisible(['a', 'b'])
    t.cache.get('a', 100)
    t.cache.get('b', 100)
    await settle()
    const [ja, jb] = t.pending()
    expect(ja!.path).toBe('a')
    // A bitmap shorter than the tier on its longer side can only be the picture itself.
    ja!.give(200, 120)
    // One as long as the tier may be a scaled-down copy of a bigger picture: nothing is known.
    jb!.give(256, 120)
    await settle()
    expect(t.cache.get('a', 100).natural).toEqual({ w: 200, h: 120 })
    expect(t.cache.get('b', 100).natural).toBeNull()
  })

  it('takes the size a load reports over the size of its bitmap (a scaled picture)', async () => {
    const t = rig()
    t.cache.setVisible(['a'])
    t.cache.get('a', 20000)
    await settle()
    t.only().give(8192, 4096, { w: 20000, h: 10000 })
    await settle()
    expect(t.cache.get('a', 20000).natural).toEqual({ w: 20000, h: 10000 })
  })

  it('ignores sizes that are not sizes', async () => {
    const t = rig()
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    await settle()
    t.only().give(256, 100, { w: 0, h: Number.NaN })
    await settle()
    expect(t.cache.get('a', 100).natural).toBeNull()
  })

  it('does not load the picture itself for one a smaller tier showed to be small', async () => {
    const t = rig()
    t.cache.setVisible(['a'])
    t.cache.get('a', 900)
    await settle()
    // The 1024 preview of a 600 px picture is the picture.
    t.only().give(600, 400, { w: 600, h: 400 })
    await settle()
    for (let i = 0; i < 3; i++) {
      t.cache.get('a', 5000)
      await settle()
    }
    expect(t.jobs).toHaveLength(1)
    expect(t.cache.get('a', 5000).bitmap).not.toBeNull()
  })

  it('does ask for it once the size is learned to be bigger than the preview', async () => {
    const t = rig()
    t.cache.setVisible(['a'])
    t.cache.get('a', 900)
    await settle()
    t.only().give(1024, 700) // a preview of something bigger: nothing is known of its size
    await settle()
    t.cache.get('a', 5000)
    await settle()
    expect(t.only().tier).toBe(8192)
  })

  it('drops the request for the picture itself that was waiting, the moment a smaller tier shows the picture to be small', async () => {
    const t = rig({ concurrency: 1 })
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    await settle()
    // The 256 preview is running; the zoomed-in view wants the picture itself, which has to wait for the one slot.
    t.cache.get('a', 5000)
    expect(t.cache.stats().queued).toBe(1)
    t.only().give(200, 120)
    await settle()
    // 200 px wide: nothing more to fetch. Without this the original would be read and decoded for a picture the preview already is.
    expect(t.cache.stats()).toMatchObject({ queued: 0, loading: 0 })
    expect(t.jobs).toHaveLength(1)
    expect(t.cache.get('a', 5000).natural).toEqual({ w: 200, h: 120 })
  })

  it('moves a waiting request to the tier the size allows, once the size is learned to be in between', async () => {
    const t = rig({ concurrency: 1 })
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    await settle()
    t.cache.get('a', 5000)
    // The load that is running reports the picture's size: 600 px, whole at the 1024 tier, so the 8192 that waits is too much.
    t.only().give(256, 171, { w: 600, h: 400 })
    await settle()
    expect(t.only()).toMatchObject({ path: 'a', tier: 1024 })
    t.only().give(600, 400, { w: 600, h: 400 })
    await settle()
    expect(t.jobs.map((j) => j.tier)).toEqual([256, 1024])
    expect(t.cache.get('a', 5000).bitmap).not.toBeNull()
  })
})

describe('ImageCache: loading', () => {
  it('only loads pictures that are on screen, and keeps drawing a held one that left', async () => {
    const t = rig()
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    t.cache.get('b', 100)
    await settle()
    expect(t.jobs.map((j) => j.path)).toEqual(['a'])
    const a = t.only().give(100, 100)
    await settle()
    t.cache.setVisible([])
    // Off screen, nothing new loads (not even another tier), but what is held still answers.
    expect(t.drawn('a', 100)).toBe(a)
    t.cache.get('a', 5000)
    await settle()
    expect(t.jobs).toHaveLength(1)
    expect(a.closed).toBe(0)
  })

  it('runs at most `concurrency` loads at once (default 2), starting the next as soon as one ends', async () => {
    for (const [concurrency, expected] of [
      [undefined, 2],
      [1, 1],
      [3, 3],
      [0, 2],
      [Number.NaN, 2],
    ] as const) {
      const t = rig(concurrency === undefined ? {} : { concurrency })
      const paths = Array.from({ length: 7 }, (_, i) => `p${i}`)
      t.cache.setVisible(paths)
      for (const p of paths) t.cache.get(p, 100)
      await settle()
      expect(t.pending()).toHaveLength(expected)
      expect(t.cache.stats()).toMatchObject({ loading: expected, queued: 7 - expected })
      let done = 0
      while (t.pending().length) {
        t.pending()[0]!.give(10, 10)
        done++
        await settle()
        expect(t.pending().length).toBe(Math.min(expected, 7 - done))
      }
      expect(done).toBe(7)
      expect(t.peak).toBe(expected)
    }
  })

  it('starts the biggest need first, the longest waiting among equals, whatever order the frame asked in', async () => {
    const t = rig({ concurrency: 1 })
    t.cache.setVisible(['a', 'b', 'c', 'd'])
    t.cache.get('a', 300)
    t.cache.get('b', 3000)
    t.cache.get('c', 3000)
    t.cache.get('d', 1500)
    await settle()
    const order: string[] = []
    while (t.pending().length) {
      const j = t.only()
      order.push(j.path)
      j.give(10, 10)
      await settle()
    }
    expect(order).toEqual(['b', 'c', 'd', 'a'])
  })

  it('ranks by the size asked in the latest frame, and a waiting request follows the wanted tier', async () => {
    const t = rig({ concurrency: 1 })
    t.cache.setVisible(['x', 'a', 'b'])
    t.cache.get('x', 100)
    await settle()
    t.cache.get('a', 400)
    t.cache.get('b', 2000)
    await settle() // the next frame
    // Later frames: b shrinks, a grows past it and now wants the picture itself.
    t.cache.get('a', 5000)
    t.cache.get('b', 400)
    expect(t.cache.stats().queued).toBe(2)
    t.only().give(10, 10)
    await settle()
    expect(t.only()).toMatchObject({ path: 'a', tier: 8192 })
    t.only().give(10, 10)
    await settle()
    expect(t.only()).toMatchObject({ path: 'b', tier: 1024 })
    t.only().give(10, 10)
    await settle()
    // One request per picture: the 256 and 1024 that a asked for first were never made.
    expect(t.jobs.map((j) => [j.path, j.tier])).toEqual([
      ['x', 256],
      ['a', 8192],
      ['b', 1024],
    ])
  })

  it('treats a size that is not a number as the smallest need', async () => {
    const t = rig({ concurrency: 1 })
    t.cache.setVisible(['a', 'b'])
    t.cache.get('a', Number.NaN)
    t.cache.get('b', 100)
    await settle()
    expect(t.only().path).toBe('b')
  })

  it('never loads the same picture at the same tier twice at once, but a bigger tier may run beside it', async () => {
    const t = rig({ concurrency: 3 })
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    await settle()
    for (let i = 0; i < 4; i++) {
      t.cache.get('a', 100)
      await settle()
    }
    expect(t.jobs).toHaveLength(1)
    t.cache.get('a', 900)
    await settle()
    t.cache.get('a', 100)
    t.cache.get('a', 900)
    await settle()
    expect(t.jobs.map((j) => j.tier)).toEqual([256, 1024])
  })

  it('does not queue a picture twice while it waits', async () => {
    const t = rig({ concurrency: 1 })
    t.cache.setVisible(['x', 'a'])
    t.cache.get('x', 100)
    await settle()
    for (let i = 0; i < 5; i++) t.cache.get('a', 100)
    expect(t.cache.stats().queued).toBe(1)
    t.only().give(10, 10)
    await settle()
    t.only().give(10, 10)
    await settle()
    expect(t.jobs.map((j) => j.path)).toEqual(['x', 'a'])
  })

  it('skips a load whose picture left the screen before its turn, and keeps one that was already running', async () => {
    const t = rig({ concurrency: 1 })
    t.cache.setVisible(['a', 'b'])
    t.cache.get('a', 100)
    t.cache.get('b', 100)
    await settle()
    expect(t.only().path).toBe('a')
    expect(t.cache.stats().queued).toBe(1)

    t.cache.setVisible([])
    expect(t.cache.stats().queued).toBe(0)
    const a = t.only().give(100, 100)
    await settle()
    // b never started. a had, so it lands and is held (off screen, ready to be evicted first).
    expect(t.jobs.map((j) => j.path)).toEqual(['a'])
    expect(t.cache.stats()).toMatchObject({ bitmaps: 1, loading: 0, queued: 0 })
    expect(a.closed).toBe(0)

    // Back on screen it is asked for again.
    t.cache.setVisible(['b'])
    t.cache.get('b', 100)
    await settle()
    expect(t.only().path).toBe('b')
  })

  it('drops a waiting request when the picture comes to want a tier it already holds', async () => {
    const t = rig({ concurrency: 1 })
    t.cache.setVisible(['a', 'x'])
    t.cache.get('a', 900)
    await settle()
    t.only().give(300, 10, BIG) // a holds its 1024 tier
    await settle()
    t.cache.get('x', 100)
    await settle()
    // Zoomed out: a asks for the 256 tier and waits for x's slot ...
    t.cache.get('a', 100)
    expect(t.cache.stats().queued).toBe(1)
    // ... zoomed back in before its turn: the 1024 it holds is what it wants again.
    t.cache.get('a', 900)
    expect(t.cache.stats().queued).toBe(0)
    t.only().give(10, 10, BIG)
    await settle()
    expect(t.jobs.map((j) => [j.path, j.tier])).toEqual([
      ['a', 1024],
      ['x', 256],
    ])
  })
})

describe('ImageCache: failures', () => {
  it('marks the picture failed, calls onLoaded once, and tries again after retryAfterMs, with a longer wait after each failure in a row', async () => {
    let clock = 1000
    const t = rig({ retryAfterMs: 5000, now: () => clock })
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    await settle()
    t.only().none()
    await settle()
    expect(t.cache.get('a', 100)).toEqual({ bitmap: null, natural: null, failed: true, reason: 'unreadable' })
    expect(t.cache.stats()).toMatchObject({ failed: 1, loading: 0 })
    expect(t.loaded).toBe(1)

    clock += 4999
    t.cache.get('a', 100)
    await settle()
    expect(t.jobs).toHaveLength(1)
    clock += 1
    t.cache.get('a', 100)
    await settle()
    expect(t.jobs).toHaveLength(2)
    // While it is being tried again it is still failed (no flash of an empty picture).
    expect(t.cache.get('a', 100).failed).toBe(true)
    // A rejection is a failure like a null; nothing new to draw, so no new onLoaded.
    t.only().reject()
    await settle()
    expect(t.cache.get('a', 100).failed).toBe(true)
    expect(t.loaded).toBe(1)

    // The second failure in a row waits twice as long.
    clock += 5000
    t.cache.get('a', 100)
    await settle()
    expect(t.jobs).toHaveLength(2)
    clock += 5000
    t.cache.get('a', 100)
    await settle()
    expect(t.jobs).toHaveLength(3)
    t.only().none()
    await settle()
    // The third: four times as long.
    clock += 19_999
    t.cache.get('a', 100)
    await settle()
    expect(t.jobs).toHaveLength(3)
    clock += 1
    t.cache.get('a', 100)
    await settle()
    expect(t.jobs).toHaveLength(4)
    // It works this time.
    const b = t.only().give(200, 120)
    await settle()
    expect(t.cache.get('a', 100)).toEqual({ bitmap: b, natural: { w: 200, h: 120 }, failed: false })
    expect(t.cache.stats().failed).toBe(0)
    expect(t.loaded).toBe(2)
  })

  it('asks for a smaller tier when the wanted one failed and there is nothing to draw, and tries the wanted one again in its time', async () => {
    let clock = 0
    const t = rig({ retryAfterMs: 1000, now: () => clock })
    t.cache.setVisible(['a'])
    t.cache.get('a', 5000)
    await settle()
    expect(t.only().tier).toBe(8192)
    t.only().none() // the picture itself cannot be read
    await settle()
    expect(t.cache.get('a', 5000).failed).toBe(true)
    await settle()
    // The preview will do until then.
    expect(t.only().tier).toBe(1024)
    t.only().none() // that one cannot be made either
    await settle()
    t.cache.get('a', 5000)
    await settle()
    expect(t.only().tier).toBe(256)
    const small = t.only().give(256, 170)
    await settle()
    expect(t.cache.get('a', 5000)).toEqual({ bitmap: small, natural: null, failed: false })
    // Nothing else is asked for until the failures are old enough ...
    await settle()
    expect(t.pending()).toHaveLength(0)
    expect(t.jobs.map((j) => j.tier)).toEqual([8192, 1024, 256])
    // ... and then the better tiers are tried again, the wanted one first.
    clock += 1000
    t.cache.get('a', 5000)
    await settle()
    expect(t.only().tier).toBe(8192)
  })

  it('asks for the best tier that did not fail, also when a smaller one is held and blurry', async () => {
    const t = rig({ retryAfterMs: 1000 })
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    await settle()
    const small = t.only().give(256, 170)
    await settle()
    t.cache.get('a', 5000)
    await settle()
    expect(t.only().tier).toBe(8192)
    t.only().none()
    await settle()
    // The 256 is all there is to draw with, at 5000 px: the 1024 preview is better than waiting for the original to be readable.
    expect(t.cache.get('a', 5000)).toMatchObject({ bitmap: small, failed: false })
    await settle()
    expect(t.only().tier).toBe(1024)
    const mid = t.only().give(1024, 680)
    await settle()
    expect(t.cache.get('a', 5000).bitmap).toBe(mid)
    await settle()
    expect(t.pending()).toHaveLength(0)
  })

  it('forgets a failure once the tier loads, so a bitmap evicted later is not taken for a failed picture', async () => {
    let clock = 0
    const t = rig({ retryAfterMs: 60_000, budgetPixels: 150, now: () => clock })
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    await settle()
    t.only().none()
    await settle()
    clock += 60_000
    t.cache.get('a', 100)
    await settle()
    const b = t.only().give(10, 10)
    await settle()
    expect(t.cache.get('a', 100).bitmap).toBe(b)
    // Another picture takes its place in the budget.
    t.cache.setVisible(['c'])
    t.cache.get('c', 100)
    await settle()
    const c = t.only().give(10, 10)
    await settle()
    t.cache.setVisible(['c', 'd'])
    t.cache.get('d', 100)
    await settle()
    t.only().give(10, 10)
    await settle()
    expect(b.closed).toBe(1)
    expect(c.closed).toBe(0)
    expect(t.cache.stats().failed).toBe(0)
    // Back on screen it loads at once: the old failure is not held against it.
    t.cache.setVisible(['a'])
    expect(t.cache.get('a', 100)).toEqual({ bitmap: null, natural: { w: 10, h: 10 }, failed: false })
    await settle()
    expect(t.only().path).toBe('a')
  })

  it('waits at most eight times as long, however many times it fails', async () => {
    let clock = 0
    const t = rig({ retryAfterMs: 1000, now: () => clock })
    t.cache.setVisible(['a'])
    for (let n = 0; n < 8; n++) {
      clock += 1_000_000
      t.cache.get('a', 100)
      await settle()
      t.only().none()
      await settle()
    }
    expect(t.jobs).toHaveLength(8)
    clock += 7999
    t.cache.get('a', 100)
    await settle()
    expect(t.jobs).toHaveLength(8)
    clock += 1
    t.cache.get('a', 100)
    await settle()
    expect(t.jobs).toHaveLength(9)
  })

  it('treats a loader that throws, or hands over a bitmap with no size, as a failure, and closes the bitmap', async () => {
    const bad = new Fake(0, 0)
    const t = rig({
      load: (path) => {
        if (path === 'throws') throw new Error('sync')
        return Promise.resolve({ bitmap: bad })
      },
    })
    t.cache.setVisible(['throws', 'empty'])
    t.cache.get('throws', 100)
    t.cache.get('empty', 100)
    await settle()
    expect(t.cache.get('throws', 100).failed).toBe(true)
    expect(t.cache.get('empty', 100).failed).toBe(true)
    expect(bad.closed).toBe(1)
    expect(t.cache.stats()).toMatchObject({ failed: 2, bitmaps: 0, pixels: 0, loading: 0 })
  })

  it('retries only a picture that is on screen', async () => {
    let clock = 0
    const t = rig({ retryAfterMs: 1000, now: () => clock })
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    await settle()
    t.only().none()
    await settle()
    t.cache.setVisible([])
    clock += 100_000
    expect(t.cache.get('a', 100).failed).toBe(true)
    await settle()
    expect(t.jobs).toHaveLength(1)
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    await settle()
    expect(t.jobs).toHaveLength(2)
  })

  it('is not "failed" while there is something to draw: a picture whose full size cannot be read keeps its preview', async () => {
    let clock = 0
    const t = rig({ retryAfterMs: 1000, now: () => clock })
    t.cache.setVisible(['a'])
    t.cache.get('a', 900)
    await settle()
    const preview = t.only().give(1024, 700)
    await settle()
    t.cache.get('a', 5000)
    await settle()
    expect(t.only().tier).toBe(8192)
    t.only().none()
    await settle()
    expect(t.cache.get('a', 5000)).toMatchObject({ bitmap: preview, failed: false })
    expect(t.cache.stats().failed).toBe(0)
    await settle() // the next frame
    // A failure of one tier does not stop the others.
    t.cache.get('a', 100)
    await settle()
    expect(t.only().tier).toBe(256)
    // And the failed one is not asked for again until its time.
    t.only().give(256, 180)
    await settle()
    t.cache.get('a', 5000)
    await settle()
    expect(t.pending()).toHaveLength(0)
    clock += 1000
    t.cache.get('a', 5000)
    await settle()
    expect(t.only().tier).toBe(8192)
  })

  it('forgets a failure when the picture is forgotten', async () => {
    let clock = 0
    const t = rig({ retryAfterMs: 60_000, now: () => clock })
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    await settle()
    t.only().none()
    await settle()
    t.cache.forget('a')
    expect(t.cache.stats().failed).toBe(0)
    expect(t.cache.get('a', 100).failed).toBe(false)
    await settle()
    expect(t.jobs).toHaveLength(2)
  })

  it('bounds what it remembers of pictures that hold nothing', async () => {
    const t = rig({ load: () => Promise.resolve(null), concurrency: 8 })
    const paths = Array.from({ length: 5000 }, (_, i) => `p${i}`)
    t.cache.setVisible(paths)
    for (const p of paths) t.cache.get(p, 100)
    await settle()
    expect(t.cache.stats().failed).toBe(5000)
    t.cache.setVisible([])
    await settle()
    const left = t.cache.stats().failed
    expect(left).toBeLessThanOrEqual(4096)
    expect(left).toBeGreaterThan(4000)
    // The ones forgotten are the oldest; the latest are still known to be failures.
    expect(t.cache.get('p0', 100).failed).toBe(false)
    expect(t.cache.get('p4999', 100).failed).toBe(true)
    // (5000 visible pictures is far more than a board holds; each arrival divides the budget again, so a busy machine needs room.)
  }, 30_000)
})

describe('ImageCache: onLoaded', () => {
  it('is called once for loads that land together, and again for ones that land later', async () => {
    const t = rig({ concurrency: 3 })
    t.cache.setVisible(['a', 'b', 'c', 'd'])
    for (const p of ['a', 'b', 'c', 'd']) t.cache.get(p, 100)
    await settle()
    const [ja, jb, jc] = t.pending()
    ja!.give(10, 10)
    jb!.give(10, 10)
    jc!.give(10, 10)
    expect(t.loaded).toBe(0) // never inside the call that settled it
    await settle()
    expect(t.loaded).toBe(1)
    t.only().give(10, 10)
    await settle()
    expect(t.loaded).toBe(2)
  })

  it('answers with the bitmap already in place', async () => {
    let seen: unknown = 'unset'
    const t = rig({
      onLoaded: () => {
        seen = t.drawn('a', 100)
      },
    })
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    await settle()
    const b = t.only().give(10, 10)
    await settle()
    expect(seen).toBe(b)
  })

  it('is not called for a result nobody wants any more', async () => {
    const t = rig()
    t.cache.setVisible(['a', 'b'])
    t.cache.get('a', 100)
    t.cache.get('b', 100)
    await settle()
    const [ja, jb] = t.pending()
    t.cache.forget('a')
    ja!.give(10, 10)
    await settle()
    expect(t.loaded).toBe(0)
    t.cache.dispose()
    jb!.give(10, 10)
    await settle()
    expect(t.loaded).toBe(0)
  })
})

describe('ImageCache: the budget', () => {
  it('evicts pictures that are off screen first, the least recently used first, and closes each bitmap once', async () => {
    const t = rig({ budgetPixels: 250, concurrency: 3 })
    t.cache.setVisible(['a', 'b', 'c'])
    for (const p of ['a', 'b', 'c']) t.cache.get(p, 100)
    await settle()
    const [a, b, c] = t.pending().map((j) => j.give(10, 10, BIG))
    await settle()
    // All three are drawn: over the budget, but none of them may go.
    expect(t.cache.stats()).toMatchObject({ pixels: 300, bitmaps: 3 })
    for (const x of [a, b, c]) expect(x!.closed).toBe(0)

    t.cache.setVisible(['c'])
    await settle()
    expect([a!.closed, b!.closed, c!.closed]).toEqual([1, 0, 0])
    expect(t.cache.stats()).toMatchObject({ pixels: 200, bitmaps: 2 })
    // Nothing is closed twice by later events.
    t.cache.setVisible([])
    await settle()
    expect([a!.closed, b!.closed, c!.closed]).toEqual([1, 0, 0])
  })

  it('counts a get as a use, so the picture touched last is the last to go', async () => {
    const t = rig({ budgetPixels: 250, concurrency: 3 })
    t.cache.setVisible(['a', 'b', 'c'])
    for (const p of ['a', 'b', 'c']) t.cache.get(p, 100)
    await settle()
    const [a, b, c] = t.pending().map((j) => j.give(10, 10, BIG))
    await settle()
    t.cache.setVisible([])
    await settle()
    // The three are off screen now and over budget by 50: one goes, the oldest.
    expect([a!.closed, b!.closed, c!.closed]).toEqual([1, 0, 0])

    const t2 = rig({ budgetPixels: 250, concurrency: 3 })
    t2.cache.setVisible(['a', 'b', 'c'])
    for (const p of ['a', 'b', 'c']) t2.cache.get(p, 100)
    await settle()
    const [a2, b2, c2] = t2.pending().map((j) => j.give(10, 10, BIG))
    await settle()
    // a is asked for again after b and c: now b is the oldest.
    t2.cache.get('a', 100)
    t2.cache.setVisible([])
    await settle()
    expect([a2!.closed, b2!.closed, c2!.closed]).toEqual([0, 1, 0])
  })

  // Bitmaps of the sizes the tiers have (a 4:3 picture): the budgets below are made of them.
  const S = 256 * 192
  const M = 1024 * 768

  it('takes a picture that is off screen before the spare bitmap of one that is on, however recently it was used', async () => {
    const t = rig({ budgetPixels: M + 1.5 * S })
    t.cache.setVisible(['n'])
    t.cache.get('n', 100)
    await settle()
    const n = t.only().give(256, 192, BIG)
    await settle()
    t.cache.setVisible(['v'])
    t.cache.get('v', 900)
    await settle()
    const big = t.only().give(1024, 768, BIG) // v's 1024 tier
    await settle()
    // Zoomed out: v wants the 256 tier, the 1024 one is a spare.
    t.cache.get('v', 100)
    await settle()
    // n is touched after v's last get, so by recency alone v's spare would go first.
    t.cache.get('n', 100)
    const small = t.only().give(256, 192, BIG)
    await settle()
    expect(t.drawn('v', 100)).toBe(small)
    expect([n.closed, big.closed, small.closed]).toEqual([1, 0, 0])
    expect(t.cache.stats().pixels).toBe(M + S)
  })

  it('takes the spare bitmap of a picture on screen before the one it draws with, and never the one it draws with', async () => {
    const t = rig({ budgetPixels: M + S / 2 })
    t.cache.setVisible(['v'])
    t.cache.get('v', 900)
    await settle()
    const big = t.only().give(1024, 768, BIG)
    await settle()
    // Alone, it fits and is what is drawn.
    expect([big.closed, t.cache.stats().pixels]).toEqual([0, M])
    await settle()
    t.cache.get('v', 100)
    await settle()
    // The 256 tier is wanted now. Until it is there the big one is what is drawn, and it stays.
    expect(t.drawn('v', 100)).toBe(big)
    const small = t.only().give(256, 192, BIG)
    await settle()
    expect(t.cache.stats().pixels).toBe(S)
    expect([big.closed, small.closed]).toEqual([1, 0])
    expect(t.drawn('v', 100)).toBe(small)
  })

  it('keeps the bitmap that is best for the size wanted, and drops the spare one, whichever is bigger', async () => {
    const t = rig({ budgetPixels: M + 1.5 * S })
    t.cache.setVisible(['v'])
    t.cache.get('v', 900)
    await settle()
    const big = t.only().give(1024, 768, BIG) // the 1024 tier
    await settle()
    t.cache.get('v', 100)
    await settle()
    const small = t.only().give(256, 192, BIG) // the 256 tier: both fit
    await settle()
    expect([big.closed, small.closed]).toEqual([0, 0])
    // Zoomed in again: the big one is what v draws with, the small one is the spare.
    expect(t.drawn('v', 900)).toBe(big)
    await settle()
    t.cache.setVisible(['v', 'w'])
    t.cache.get('v', 900)
    t.cache.get('w', 100)
    await settle()
    const w = t.only().give(256, 192, BIG) // M + 2 S in all, half an S over
    await settle()
    expect([big.closed, small.closed, w.closed]).toEqual([0, 1, 0])
    expect(t.drawn('v', 900)).toBe(big)
  })

  it('evicts a picture\'s biggest bitmap first', async () => {
    const t = rig({ budgetPixels: M + 1.5 * S })
    t.cache.setVisible(['n'])
    t.cache.get('n', 900)
    await settle()
    const big = t.only().give(1024, 768, BIG) // the 1024 tier
    await settle()
    t.cache.get('n', 100)
    await settle()
    const small = t.only().give(256, 192, BIG) // the 256 tier
    await settle()
    expect([big.closed, small.closed]).toEqual([0, 0]) // M + S: within the budget, both kept
    // n leaves and m arrives: M + 2 S, half an S over. Dropping the big one fixes it; dropping the small one would not.
    t.cache.setVisible(['m'])
    t.cache.get('m', 100)
    await settle()
    const m = t.only().give(256, 192, BIG)
    await settle()
    expect([big.closed, small.closed, m.closed]).toEqual([1, 0, 0])
    expect(t.cache.stats().pixels).toBe(2 * S)
  })

  it('lets a visible picture\'s only bitmap stand over the budget, and closes it as soon as the picture leaves', async () => {
    const t = rig({ budgetPixels: 250 })
    t.cache.setVisible(['p', 'q'])
    t.cache.get('p', 100)
    t.cache.get('q', 100)
    await settle()
    const [p, q] = t.pending().map((j, i) => j.give(i === 0 ? 40 : 10, 10, BIG))
    await settle()
    expect(t.cache.stats().pixels).toBe(500)
    expect([p!.closed, q!.closed]).toEqual([0, 0])
    expect(t.drawn('p', 100)).toBe(p)
    t.cache.setVisible(['q'])
    await settle()
    expect([p!.closed, q!.closed]).toEqual([1, 0])
    expect(t.cache.stats().pixels).toBe(100)
  })

  it('closes a bitmap that lands for a picture that left the screen when it does not fit', async () => {
    const t = rig({ budgetPixels: 150 })
    t.cache.setVisible(['a', 'b'])
    t.cache.get('a', 100)
    t.cache.get('b', 100)
    await settle()
    const [ja, jb] = t.pending()
    const a = ja!.give(10, 10, BIG)
    await settle()
    t.cache.setVisible(['a'])
    const b = jb!.give(10, 10, BIG)
    await settle()
    // b is the newer arrival but not drawn: a is, and the budget holds one.
    expect([a.closed, b.closed]).toEqual([0, 1])
    expect(t.cache.stats().pixels).toBe(100)
  })

  it('holds 128 megapixels by default', async () => {
    const t = rig({ concurrency: 3 })
    t.cache.setVisible(['a', 'b', 'c'])
    for (const p of ['a', 'b', 'c']) t.cache.get(p, 20000)
    await settle()
    const [a, b, c] = t.pending().map((j) => j.give(8000, 8000, { w: 12000, h: 12000 }))
    await settle()
    // Three drawn pictures of 64 megapixels: all kept.
    expect(t.cache.stats().pixels).toBe(192e6)
    t.cache.setVisible([])
    await settle()
    expect([a!.closed, b!.closed, c!.closed]).toEqual([1, 0, 0])
    expect(t.cache.stats().pixels).toBe(128e6)
  })

  it('takes nonsense for a budget as the default', async () => {
    for (const budgetPixels of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const t = rig({ budgetPixels, concurrency: 3 })
      t.cache.setVisible(['a', 'b', 'c'])
      for (const p of ['a', 'b', 'c']) t.cache.get(p, 20000)
      await settle()
      const [a, b, c] = t.pending().map((j) => j.give(8000, 8000, { w: 12000, h: 12000 }))
      await settle()
      t.cache.setVisible([])
      await settle()
      expect([a!.closed, b!.closed, c!.closed]).toEqual([1, 0, 0])
    }
  })

  it('never closes inside get or setVisible, which a frame calls before it draws', async () => {
    const t = rig({ budgetPixels: 100 })
    t.cache.setVisible(['a', 'b'])
    t.cache.get('a', 100)
    t.cache.get('b', 100)
    await settle()
    const [a, b] = t.pending().map((j) => j.give(10, 10, BIG))
    await settle()
    expect(t.cache.stats().pixels).toBe(200)
    t.cache.setVisible(['b'])
    t.cache.get('b', 100)
    t.cache.get('a', 100)
    t.cache.get('a', 5000)
    expect([a!.closed, b!.closed]).toEqual([0, 0])
    await settle()
    expect([a!.closed, b!.closed]).toEqual([1, 0])
  })
})

describe('ImageCache: forget, clear and dispose', () => {
  it('forget closes the picture\'s bitmaps and lets it load again; a load running for it lands closed', async () => {
    const t = rig({ concurrency: 3 })
    t.cache.setVisible(['a', 'b'])
    t.cache.get('a', 100)
    t.cache.get('b', 100)
    await settle()
    const [ja, jb] = t.pending()
    const a = ja!.give(10, 10, BIG)
    await settle()
    t.cache.get('a', 900)
    await settle()
    const stale = t.pending().find((j) => j.path === 'a')! // a's 1024, running
    t.cache.forget('a')
    expect(a.closed).toBe(1)
    expect(t.cache.stats().bitmaps).toBe(0)
    expect(t.cache.get('a', 100)).toEqual({ bitmap: null, natural: null, failed: false })
    await settle()
    // The new generation loads at once; the old job is still running beside it.
    expect(t.pending().map((j) => [j.path, j.tier])).toEqual([
      ['b', 256],
      ['a', 1024],
      ['a', 256],
    ])
    const lateOld = stale.give(10, 10, BIG)
    await settle()
    expect(lateOld.closed).toBe(1)
    expect(t.cache.stats().bitmaps).toBe(0)
    const fresh = t.pending().find((j) => j.path === 'a')!.give(10, 10, BIG)
    jb!.give(10, 10, BIG)
    await settle()
    expect(fresh.closed).toBe(0)
    expect(t.drawn('a', 100)).toBe(fresh)
    // Forgetting a picture the cache never saw is nothing.
    t.cache.forget('nobody')
  })

  it('clear closes everything and drops what waits, but keeps what is on screen so the pictures load again', async () => {
    const t = rig({ concurrency: 1 })
    t.cache.setVisible(['a', 'b', 'c'])
    for (const p of ['a', 'b', 'c']) t.cache.get(p, 100)
    await settle()
    const a = t.only().give(10, 10, BIG)
    await settle()
    const running = t.only() // b
    t.cache.clear()
    expect(a.closed).toBe(1)
    expect(t.cache.stats()).toMatchObject({ pixels: 0, bitmaps: 0, queued: 0 })
    const late = running.give(10, 10, BIG)
    await settle()
    expect(late.closed).toBe(1)
    expect(t.cache.stats().bitmaps).toBe(0)
    t.cache.get('a', 100)
    await settle()
    expect(t.only().path).toBe('a')
  })

  it('dispose closes every bitmap, drops the queue, and closes the results of loads still running', async () => {
    const t = rig({ concurrency: 2 })
    const paths = ['a', 'b', 'c', 'd', 'e']
    t.cache.setVisible(paths)
    for (const p of paths) t.cache.get(p, 100)
    await settle()
    const [ja, jb] = t.pending()
    const a = ja!.give(10, 10, BIG)
    await settle()
    expect(t.pending()).toHaveLength(2) // b and c
    expect(t.cache.stats()).toMatchObject({ bitmaps: 1, queued: 2, loading: 2 })

    t.cache.dispose()
    expect(a.closed).toBe(1)
    expect(t.cache.stats()).toMatchObject({ pixels: 0, bitmaps: 0, queued: 0, failed: 0 })
    const loadedBefore = t.loaded
    const b = jb!.give(10, 10, BIG)
    const c = t.pending()[0]!.give(10, 10, BIG)
    await settle()
    expect([b.closed, c.closed]).toEqual([1, 1])
    // Nothing starts, nothing is announced, nothing is held, and calling it again is harmless.
    expect(t.jobs).toHaveLength(3)
    expect(t.loaded).toBe(loadedBefore)
    t.cache.setVisible(paths)
    expect(t.cache.get('d', 100)).toEqual({ bitmap: null, natural: null, failed: false })
    await settle()
    expect(t.jobs).toHaveLength(3)
    expect(t.cache.stats()).toEqual({ pixels: 0, bitmaps: 0, loading: 0, queued: 0, failed: 0 })
    t.cache.forget('a')
    t.cache.clear()
    t.cache.dispose()
    for (const x of t.made) expect(x.closed).toBe(1)
  })

  it('closes a result that arrives after dispose even when it fails to be usable', async () => {
    const t = rig()
    t.cache.setVisible(['a'])
    t.cache.get('a', 100)
    await settle()
    const j = t.only()
    t.cache.dispose()
    const dud = j.give(0, 0)
    await settle()
    expect(dud.closed).toBe(1)
  })
})

describe('ImageCache: a random walk keeps the books straight', () => {
  /** Runs `steps` random operations on a small cache and checks the invariants after every one. */
  async function walk(seed: number, steps: number, forgetting: boolean): Promise<void> {
    const rnd = mulberry32(seed)
    const int = (n: number) => Math.floor(rnd() * n)
    const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!
    const paths = Array.from({ length: 10 }, (_, i) => `p${i}.png`)
    const budget = pick([300_000, 1_500_000, 6_000_000, 40_000_000])
    const concurrency = 1 + int(3)
    let clock = 0
    const t = rig({ budgetPixels: budget, concurrency, retryAfterMs: 500, now: () => clock })
    const WANTS = [Number.NaN, -1, 0, 50, 256, 300, 1000, 1024, 1500, 4000, 8192, 20000]
    const wants = new Map<string, number>()
    let visible = new Set<string>()
    let had = new Set<string>()
    let hadVisible = new Set<string>()

    const check = (resetsPictures: boolean) => {
      const drawn = new Set<Fake>()
      const have = new Set<string>()
      for (const p of visible) {
        const slot = t.cache.get(p, wants.get(p) ?? 0)
        if (slot.bitmap) {
          const b = slot.bitmap as unknown as Fake
          // A bitmap handed out is never one that was closed.
          expect(b.closed).toBe(0)
          drawn.add(b)
          have.add(p)
        }
        if (slot.failed) expect(slot.bitmap).toBeNull()
      }
      // A visible picture that was drawn and is still visible never loses all its bitmaps, whatever the budget says.
      if (!resetsPictures) for (const p of visible) if (had.has(p) && hadVisible.has(p)) expect(have.has(p)).toBe(true)
      had = have
      hadVisible = new Set(visible)

      const open = t.made.filter((b) => b.delivered && b.closed === 0)
      const st = t.cache.stats()
      // Every bitmap that was delivered is either held (counted) or closed: none leaks, none is counted twice.
      expect(st.bitmaps).toBe(open.length)
      expect(st.pixels).toBe(open.reduce((n, b) => n + b.width * b.height, 0))
      for (const b of t.made) expect(b.closed).toBeLessThanOrEqual(1)
      // Over the budget only by what is being drawn.
      if (st.pixels > budget) for (const b of open) expect(drawn.has(b)).toBe(true)
      // The loader's own count of running loads is the cache's, and within the limit.
      expect(st.loading).toBe(t.pending().length)
      expect(t.peak).toBeLessThanOrEqual(concurrency)
      if (!forgetting) {
        const keys = t.pending().map((j) => `${j.path}\u0000${j.tier}`)
        expect(new Set(keys).size).toBe(keys.length)
      }
      expect(st.queued).toBeLessThanOrEqual(visible.size)
    }

    for (let step = 0; step < steps; step++) {
      const r = rnd()
      let resetsPictures = false
      if (r < 0.3) {
        visible = new Set(paths.filter(() => rnd() < 0.45))
        t.cache.setVisible(rnd() < 0.5 ? visible : [...visible])
        for (const p of visible) if (!wants.has(p) || rnd() < 0.6) wants.set(p, pick(WANTS))
      } else if (r < 0.75) {
        const p = t.pending()
        if (p.length) {
          const job = pick(p)
          const o = rnd()
          if (o < 0.75) {
            const longer = rnd() < 0.2 ? 1 + int(job.tier - 1) : job.tier
            const shorter = 1 + int(longer)
            const [w, h] = rnd() < 0.5 ? [longer, shorter] : [shorter, longer]
            const natural = rnd() < 0.15 ? { w: longer * (1 + int(3)), h: shorter * (1 + int(3)) } : undefined
            job.give(w, h, natural)
          } else if (o < 0.85) job.none()
          else if (o < 0.95) job.reject()
          else job.give(0, 0)
        }
      } else if (r < 0.9) {
        clock += pick([100, 400, 600, 5000])
      } else if (forgetting && r < 0.97) {
        t.cache.forget(pick(paths))
        resetsPictures = true
      } else if (forgetting) {
        t.cache.clear()
        resetsPictures = true
      }
      await settle()
      // The frame after every operation, as the board view draws one.
      check(resetsPictures)
    }

    // End of the board: nothing is left open, whatever was still running.
    t.cache.dispose()
    for (const j of t.pending()) j.give(1 + int(50), 1 + int(50))
    await settle()
    for (const b of t.made) expect(b.closed).toBe(1)
    expect(t.cache.stats()).toEqual({ pixels: 0, bitmaps: 0, loading: 0, queued: 0, failed: 0 })
    const jobs = t.jobs.length
    t.cache.setVisible(paths)
    for (const p of paths) t.cache.get(p, 1000)
    await settle()
    expect(t.jobs.length).toBe(jobs)
  }

  it('keeps the books for 40 seeds of 250 operations: nothing leaks, nothing closes twice, the budget holds but for what is drawn', async () => {
    for (let seed = 1; seed <= 40; seed++) await walk(seed, 250, false)
  }, 60_000)

  it('keeps them when pictures are forgotten and the cache is cleared in between', async () => {
    for (let seed = 101; seed <= 130; seed++) await walk(seed, 250, true)
  }, 60_000)
})
