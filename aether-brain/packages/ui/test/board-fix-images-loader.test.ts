import { describe, expect, it, vi } from 'vitest'
import { ImageCache } from '../src/board/imageCache'
import { createImageLoader, MAX_LOAD_PIXELS, type CreateBitmap } from '../src/board/imageLoader'

/**
 * Review fixes renderer-cache-2 and shell-5 (the loader half), renderer-cache-3 and desktop-4 (the loader half):
 * - a picture is never decoded to learn its size: the loader reads the header of the blob (a few KB of PNG can claim 30,000 x 30,000
 *   pixels and a decode of that is 3.6 GB), refuses above 150 megapixels without decoding anything ('too-large'), decodes once, straight
 *   to the size it is wanted at, and decodes the pictures from 64 megapixels up one at a time for the whole page;
 * - a picture the host has no preview of (over main's 64 megapixel thumbnail cap) is made into the preview from its original, so it
 *   shows at every zoom and not only past 1024 px;
 * - the reason a picture cannot be shown comes out of the loader ('missing', 'too-large', anything else 'unreadable').
 */

class Bmp {
  closed = 0
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  close(): void {
    this.closed++
  }
}

/** The first 33 bytes of a PNG that claims to be `w` x `h`. */
function pngHead(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const v = new DataView(b.buffer)
  v.setUint32(16, w)
  v.setUint32(20, h)
  b[24] = 8
  b[25] = 2
  return b
}

/** The start of a JPEG that claims `w` x `h` as stored and EXIF orientation `orientation`. */
function jpegHead(w: number, h: number, orientation: number): Uint8Array {
  // Big-endian TIFF: header, one entry (tag 0x0112, SHORT, one value), no next directory.
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif]
  const sof = [0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9])
}

const UPRIGHT = { imageOrientation: 'from-image' }

/** A fake engine: bitmaps of the size the blob claims (or the size asked), counting how many decodes run at once. */
function engine(sizeOf: Map<Blob, { w: number; h: number }>, opts: { hold?: () => Promise<void> } = {}) {
  const calls: { options: ImageBitmapOptions | undefined; bitmap: Bmp }[] = []
  let running = 0
  let peak = 0
  const create: CreateBitmap = async (blob, options) => {
    running++
    peak = Math.max(peak, running)
    try {
      if (opts.hold) await opts.hold()
      const s = sizeOf.get(blob)
      if (!s) throw new Error('not a picture')
      const b = options?.resizeWidth ? new Bmp(options.resizeWidth, options.resizeHeight ?? 1) : new Bmp(s.w, s.h)
      calls.push({ options, bitmap: b })
      return b
    } finally {
      running--
    }
  }
  return {
    create,
    calls,
    get peak() {
      return peak
    },
  }
}

function host(files: Record<string, { w: number; h: number; preview?: { w: number; h: number } | null }>) {
  const sizeOf = new Map<Blob, { w: number; h: number }>()
  const previewCalls: [string, number][] = []
  const originalCalls: string[] = []
  const blob = (s: { w: number; h: number }, head = pngHead(s.w, s.h)) => {
    const b = new Blob([head])
    sizeOf.set(b, s)
    return b
  }
  const pictures = {
    preview: async (p: string, px: number) => {
      previewCalls.push([p, px])
      const f = files[p]
      return f?.preview ? blob(f.preview) : null
    },
    original: async (p: string) => {
      originalCalls.push(p)
      const f = files[p]
      return f ? blob(f) : null
    },
  }
  return { pictures, sizeOf, previewCalls, originalCalls }
}

describe('the loader reads a picture\'s size from its header and never decodes a picture that is too big', () => {
  it('refuses a picture of more than 150 megapixels without decoding anything, at every tier, and says why', async () => {
    expect(MAX_LOAD_PIXELS).toBe(150e6)
    const h = host({ 'huge.png': { w: 30000, h: 30000 } })
    const e = engine(h.sizeOf)
    const load = createImageLoader(h.pictures, e.create)
    for (const tier of [256, 1024, 8192] as const) {
      expect(await load('huge.png', tier)).toEqual({ failure: 'too-large', natural: { w: 30000, h: 30000 } })
    }
    expect(e.calls).toHaveLength(0)
    expect(e.peak).toBe(0)
  })

  it('decodes a picture of exactly 150 megapixels and refuses one pixel more across', async () => {
    const h = host({ 'edge.png': { w: 15000, h: 10000 }, 'over.png': { w: 15001, h: 10000 } })
    const e = engine(h.sizeOf)
    const load = createImageLoader(h.pictures, e.create)
    expect(await load('edge.png', 1024)).toMatchObject({ natural: { w: 15000, h: 10000 } })
    expect(await load('over.png', 1024)).toMatchObject({ failure: 'too-large' })
    expect(e.calls).toHaveLength(1)
  })

  it('decodes a picture between 64 and 150 megapixels once, straight to the size wanted, never at its own size', async () => {
    const h = host({ 'pano.png': { w: 12000, h: 8000 } })
    const e = engine(h.sizeOf)
    const load = createImageLoader(h.pictures, e.create)
    const small = await load('pano.png', 256)
    const mid = await load('pano.png', 1024)
    const full = await load('pano.png', 8192)
    expect(e.calls.map((c) => c.options)).toEqual([
      { ...UPRIGHT, resizeWidth: 256, resizeHeight: 171, resizeQuality: 'medium' },
      { ...UPRIGHT, resizeWidth: 1024, resizeHeight: 683, resizeQuality: 'medium' },
      // 96 megapixels: held to 32 (a third of the area).
      { ...UPRIGHT, resizeWidth: 6928, resizeHeight: 4619, resizeQuality: 'medium' },
    ])
    expect([small, mid, full].map((i) => ('natural' in i! ? i!.natural : null))).toEqual([{ w: 12000, h: 8000 }, { w: 12000, h: 8000 }, { w: 12000, h: 8000 }])
  })

  it('turns the size by the EXIF orientation the header says (a picture shown on its side)', async () => {
    // 9000 x 30 as stored, orientation 6: shown 30 x 9000, so it is the height that is scaled to 8192.
    const sizeOf = new Map<Blob, { w: number; h: number }>()
    const blob = new Blob([jpegHead(9000, 30, 6)])
    sizeOf.set(blob, { w: 30, h: 9000 })
    const e = engine(sizeOf)
    const load = createImageLoader({ preview: async () => null, original: async () => blob }, e.create)
    const img = await load('a.jpg', 8192)
    expect(e.calls[0]!.options).toEqual({ ...UPRIGHT, resizeWidth: 27, resizeHeight: 8192, resizeQuality: 'medium' })
    expect(img).toMatchObject({ natural: { w: 30, h: 9000 } })
    // Not turned: the same bytes with orientation 1 are 9000 x 30 and scale the other way.
    const flat = new Blob([jpegHead(9000, 30, 1)])
    sizeOf.set(flat, { w: 9000, h: 30 })
    const img2 = await createImageLoader({ preview: async () => null, original: async () => flat }, e.create)('b.jpg', 8192)
    expect(e.calls[1]!.options).toEqual({ ...UPRIGHT, resizeWidth: 8192, resizeHeight: 27, resizeQuality: 'medium' })
    expect(img2).toMatchObject({ natural: { w: 9000, h: 30 } })
  })

  it('does not decode a file whose header it cannot read when that file is big, and decodes a small one the old way', async () => {
    const big = new Blob([new Uint8Array(17 * 1024 * 1024)])
    const sizeOf = new Map<Blob, { w: number; h: number }>()
    const e = engine(sizeOf)
    expect(await createImageLoader({ preview: async () => null, original: async () => big }, e.create)('a.bin', 8192)).toBeNull()
    expect(e.calls).toHaveLength(0)
    const small = new Blob(['no header here'])
    sizeOf.set(small, { w: 400, h: 300 })
    const img = await createImageLoader({ preview: async () => null, original: async () => small }, e.create)('a.bin', 8192)
    expect(img).toMatchObject({ natural: { w: 400, h: 300 } })
    expect(e.calls).toHaveLength(1)
  })

  it('refuses a bitmap the engine made bigger than its header said (a lying header understates), closing it', async () => {
    const blob = new Blob([pngHead(4000, 3000)])
    // The engine gives 20000 x 10000 (200 megapixels) for a file that claimed 12.
    const create: CreateBitmap = async () => new Bmp(20000, 10000)
    const made: Bmp[] = []
    const lying: CreateBitmap = async (b, o) => {
      const bmp = (await create(b, o)) as Bmp
      made.push(bmp)
      return bmp
    }
    const img = await createImageLoader({ preview: async () => null, original: async () => blob }, lying)('liar.png', 8192)
    expect(img).toEqual({ failure: 'too-large', natural: { w: 4000, h: 3000 } })
    expect(made.map((b) => b.closed)).toEqual([1])
  })
})

describe('the pictures from 64 megapixels up decode one at a time, for the whole page', () => {
  /** A promise settled by hand. */
  const gate = () => {
    let open!: () => void
    const p = new Promise<void>((r) => (open = r))
    return { p, open }
  }

  it('runs three 100-megapixel loads in a row, not side by side, and lets the smaller ones through beside them', async () => {
    const files: Record<string, { w: number; h: number }> = {}
    for (const n of ['a', 'b', 'c']) files[`${n}.png`] = { w: 10000, h: 10000 }
    for (const n of ['s1', 's2', 's3']) files[`${n}.png`] = { w: 7000, h: 7000 } // 49 megapixels: not gated
    const h = host(files)
    const g = gate()
    const e = engine(h.sizeOf, { hold: () => g.p })
    const load = createImageLoader(h.pictures, e.create)
    // Two loaders share the line.
    const other = createImageLoader(h.pictures, e.create)
    const all = Promise.all([load('a.png', 1024), other('b.png', 1024), load('c.png', 8192)])
    await new Promise((r) => setTimeout(r, 20))
    expect(e.peak).toBe(1)
    g.open()
    const done = await all
    expect(done.every((d) => d && 'bitmap' in d)).toBe(true)
    expect(e.peak).toBe(1)

    // Under 64 megapixels nothing waits for anything.
    const g2 = gate()
    const e2 = engine(h.sizeOf, { hold: () => g2.p })
    const load2 = createImageLoader(h.pictures, e2.create)
    const small = Promise.all([load2('s1.png', 1024), load2('s2.png', 1024), load2('s3.png', 1024)])
    await new Promise((r) => setTimeout(r, 20))
    expect(e2.peak).toBe(3)
    g2.open()
    await small
  })

  it('does not let a decode that never ends hold the line for good', async () => {
    vi.useFakeTimers()
    try {
      const h = host({ 'hang.png': { w: 10000, h: 10000 }, 'next.png': { w: 10000, h: 10000 } })
      let first = true
      const made: Bmp[] = []
      const create: CreateBitmap = async (blob, o) => {
        if (first) {
          first = false
          return new Promise<Bmp>(() => {})
        }
        const s = h.sizeOf.get(blob)!
        const b = new Bmp(o?.resizeWidth ?? s.w, o?.resizeHeight ?? s.h)
        made.push(b)
        return b
      }
      const load = createImageLoader(h.pictures, create)
      void load('hang.png', 8192)
      const next = load('next.png', 1024)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(made).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(40_000)
      expect(await next).toMatchObject({ natural: { w: 10000, h: 10000 } })
      expect(made).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a picture the host has no preview of is made into one from its original (renderer-cache-3, desktop-4)', () => {
  it('gives the 256 and 1024 tiers from the original, scaled while decoding, and the picture\'s own size', async () => {
    // Over the host\'s 64 megapixel thumbnail cap: preview() answers null.
    const h = host({ 'big.png': { w: 9000, h: 8000, preview: null } })
    const e = engine(h.sizeOf)
    const load = createImageLoader(h.pictures, e.create)
    const t256 = await load('big.png', 256)
    const t1024 = await load('big.png', 1024)
    expect(h.previewCalls).toEqual([['big.png', 256], ['big.png', 1024]])
    expect(h.originalCalls).toEqual(['big.png', 'big.png'])
    expect(t256).toMatchObject({ bitmap: { width: 256, height: 228 }, natural: { w: 9000, h: 8000 } })
    expect(t1024).toMatchObject({ bitmap: { width: 1024, height: 910 }, natural: { w: 9000, h: 8000 } })
    expect(e.calls).toHaveLength(2)
  })

  it('does not need the original when the host has the preview, and reports no size for a preview that fills its tier', async () => {
    const h = host({ 'ok.png': { w: 4000, h: 3000, preview: { w: 1024, h: 768 } } })
    const e = engine(h.sizeOf)
    const img = await createImageLoader(h.pictures, e.create)('ok.png', 1024)
    expect(h.originalCalls).toEqual([])
    expect(img).toMatchObject({ bitmap: { width: 1024, height: 768 } })
    expect('natural' in img!).toBe(false)
  })

  it('shows such a picture at every zoom through a real ImageCache: the small tier first, no wait for the full one', async () => {
    const h = host({ 'big.png': { w: 9000, h: 8000, preview: null } })
    const e = engine(h.sizeOf)
    const cache = new ImageCache({ load: createImageLoader(h.pictures, e.create), onLoaded: () => {} })
    cache.setVisible(['big.png'])
    cache.get('big.png', 200)
    await new Promise((r) => setTimeout(r, 20))
    const slot = cache.get('big.png', 200)
    expect(slot.failed).toBe(false)
    expect(slot.bitmap).toMatchObject({ width: 256, height: 228 })
    expect(slot.natural).toEqual({ w: 9000, h: 8000 })
    expect(h.originalCalls).toHaveLength(1)
    cache.dispose()
  })
})

describe('the loader says why a picture cannot be shown', () => {
  it('answers \'missing\' without asking the host for anything when the vault says the file is gone', async () => {
    const h = host({})
    const e = engine(h.sizeOf)
    const load = createImageLoader({ ...h.pictures, exists: () => false }, e.create)
    for (const tier of [256, 1024, 8192] as const) expect(await load('gone.png', tier)).toEqual({ failure: 'missing' })
    expect(h.previewCalls).toEqual([['gone.png', 256], ['gone.png', 1024]])
    expect(h.originalCalls).toEqual([])
  })

  it('takes the reason a host rejection carries (the file is over its byte limit, say) and calls any other rejection unreadable', async () => {
    const reject = (reason?: string) => async () => {
      throw Object.assign(new Error('refused'), reason ? { reason } : {})
    }
    const e = engine(new Map())
    expect(await createImageLoader({ preview: reject('too-large'), original: reject('too-large') }, e.create)('a.png', 256)).toEqual({ failure: 'too-large' })
    expect(await createImageLoader({ preview: async () => null, original: reject('too-large') }, e.create)('a.png', 8192)).toEqual({ failure: 'too-large' })
    expect(await createImageLoader({ preview: reject('missing'), original: reject() }, e.create)('a.png', 1024)).toEqual({ failure: 'missing' })
    expect(await createImageLoader({ preview: reject('nonsense'), original: reject() }, e.create)('a.png', 1024)).toBeNull()
    expect(await createImageLoader({ preview: reject(), original: reject() }, e.create)('a.png', 8192)).toBeNull()
  })

  it('tells the cache, which keeps the verdict: a too-large picture is read once, not every 15 seconds', async () => {
    const h = host({ 'huge.png': { w: 30000, h: 30000 } })
    const e = engine(h.sizeOf)
    let now = 0
    const cache = new ImageCache({ load: createImageLoader(h.pictures, e.create), onLoaded: () => {}, now: () => now })
    cache.setVisible(['huge.png'])
    const tick = async () => {
      cache.get('huge.png', 300)
      await new Promise((r) => setTimeout(r, 5))
    }
    await tick()
    await tick()
    expect(cache.get('huge.png', 300)).toMatchObject({ bitmap: null, failed: true, reason: 'too-large' })
    expect(cache.failureOf('huge.png')).toBe('too-large')
    const reads = h.originalCalls.length
    expect(reads).toBe(1) // the preview fell back to the original once; the verdict applies to every tier of the picture
    now += 10 * 60_000
    await tick()
    await tick()
    expect(h.originalCalls).toHaveLength(reads)
    expect(e.calls).toHaveLength(0)
    cache.dispose()
  })
})
