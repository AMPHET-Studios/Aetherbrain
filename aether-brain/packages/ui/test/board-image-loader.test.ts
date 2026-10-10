import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { Browser } from 'playwright-core'
import type { ImageTier } from '../src/board/api'
import { ImageCache } from '../src/board/imageCache'
import { createImageLoader, type CreateBitmap } from '../src/board/imageLoader'

/**
 * The picture cache's loader against a fake host and a fake `createImageBitmap`: which host call each tier makes, what comes back
 * (a bitmap, and the picture's size when the load knows it), the scaled decode of a picture over 8192 px, failures, and that no
 * bitmap it makes is left open. Then the same code in real Chromium (skipped without one): the options it passes are ones the engine
 * takes and honours. And the loader feeding a real ImageCache.
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

interface Decode {
  blob: Blob
  options: ImageBitmapOptions | undefined
  bitmap: Bmp | null
}

/** A host whose pictures are blobs with sizes registered here, and a createImageBitmap that makes bitmaps of those sizes. */
function rig(opts: { previewSize?: (path: string, px: number) => { w: number; h: number } | null; originalSize?: (path: string) => { w: number; h: number } | null } = {}) {
  const sizes = new Map<Blob, { w: number; h: number }>()
  const previewCalls: [string, number][] = []
  const originalCalls: string[] = []
  const decodes: Decode[] = []
  const blobOf = (size: { w: number; h: number } | null): Blob | null => {
    if (!size) return null
    const b = new Blob(['x'])
    sizes.set(b, size)
    return b
  }
  const pictures = {
    preview: async (p: string, px: number) => {
      previewCalls.push([p, px])
      return blobOf(opts.previewSize ? opts.previewSize(p, px) : null)
    },
    original: async (p: string) => {
      originalCalls.push(p)
      return blobOf(opts.originalSize ? opts.originalSize(p) : null)
    },
  }
  const create: CreateBitmap = async (blob, options) => {
    const d: Decode = { blob, options, bitmap: null }
    decodes.push(d)
    const size = sizes.get(blob)
    if (!size) throw new Error('not a picture')
    const resized = options?.resizeWidth && options.resizeHeight ? { w: options.resizeWidth, h: options.resizeHeight } : size
    d.bitmap = new Bmp(resized.w, resized.h)
    return d.bitmap
  }
  return { pictures, create, previewCalls, originalCalls, decodes, sizes }
}

const UPRIGHT = { imageOrientation: 'from-image' }

describe('createImageLoader: the previews (tiers 256 and 1024)', () => {
  it.each([256, 1024] as const)('asks the host for a preview of the tier and decodes it: tier %s', async (tier) => {
    const r = rig({ previewSize: () => ({ w: tier, h: Math.round(tier * 0.75) }) })
    const load = createImageLoader(r.pictures, r.create)
    const img = await load('Boards/x/a.png', tier)
    expect(r.previewCalls).toEqual([['Boards/x/a.png', tier]])
    expect(r.originalCalls).toEqual([])
    expect(r.decodes).toHaveLength(1)
    expect(r.decodes[0]!.options).toEqual(UPRIGHT)
    expect(img?.bitmap).toBe(r.decodes[0]!.bitmap)
    expect(r.decodes[0]!.bitmap!.closed).toBe(0)
  })

  it('reports the picture\'s size only when the preview is smaller than the tier, which makes it the picture itself', async () => {
    for (const [tier, w, h, natural] of [
      [256, 200, 100, { w: 200, h: 100 }],
      [256, 100, 255, { w: 100, h: 255 }],
      [256, 256, 100, undefined],
      [256, 256, 256, undefined],
      [1024, 1023, 600, { w: 1023, h: 600 }],
      [1024, 600, 1023, { w: 600, h: 1023 }],
      [1024, 1024, 600, undefined],
      [1024, 1024, 1024, undefined],
    ] as const) {
      const r = rig({ previewSize: () => ({ w, h }) })
      const img = await createImageLoader(r.pictures, r.create)('p.png', tier)
      expect(img).not.toBeNull()
      if (natural) expect(img!.natural).toEqual(natural)
      else expect('natural' in img!).toBe(false)
    }
  })

  it('makes a request of its own for each tier, however many it holds', async () => {
    const r = rig({ previewSize: (_p, px) => ({ w: px, h: px }) })
    const load = createImageLoader(r.pictures, r.create)
    await load('a.png', 256)
    await load('a.png', 1024)
    await load('a.png', 256)
    expect(r.previewCalls).toEqual([
      ['a.png', 256],
      ['a.png', 1024],
      ['a.png', 256],
    ])
    expect(r.decodes).toHaveLength(3)
  })
})

describe('createImageLoader: the picture itself (tier 8192)', () => {
  it('reads the original, not a preview, decodes it once and reports its size', async () => {
    const r = rig({ originalSize: () => ({ w: 5000, h: 3000 }) })
    const img = await createImageLoader(r.pictures, r.create)('a.png', 8192)
    expect(r.originalCalls).toEqual(['a.png'])
    expect(r.previewCalls).toEqual([])
    expect(r.decodes).toHaveLength(1)
    expect(r.decodes[0]!.options).toEqual(UPRIGHT)
    expect(img).toEqual({ bitmap: r.decodes[0]!.bitmap, natural: { w: 5000, h: 3000 } })
    expect(r.decodes[0]!.bitmap!.closed).toBe(0)
  })

  it('reports the size even of a picture smaller than a preview would be (the cache decides what to ask for)', async () => {
    const r = rig({ originalSize: () => ({ w: 300, h: 200 }) })
    const img = await createImageLoader(r.pictures, r.create)('a.png', 8192)
    expect(img?.natural).toEqual({ w: 300, h: 200 })
  })

  it('does not scale a picture of exactly 8192 px, and scales one of 8193', async () => {
    const exact = rig({ originalSize: () => ({ w: 8192, h: 4000 }) })
    const a = await createImageLoader(exact.pictures, exact.create)('a.png', 8192)
    expect(exact.decodes).toHaveLength(1)
    expect(a?.bitmap).toMatchObject({ width: 8192, height: 4000 })
    expect(a?.natural).toEqual({ w: 8192, h: 4000 })

    const over = rig({ originalSize: () => ({ w: 4000, h: 8193 }) })
    const b = await createImageLoader(over.pictures, over.create)('a.png', 8192)
    expect(over.decodes).toHaveLength(2)
    expect(b?.bitmap).toMatchObject({ height: 8192 })
    expect(b?.natural).toEqual({ w: 4000, h: 8193 })
  })

  it('decodes a bigger picture again, scaled while decoding to 8192 on its longer side, and closes the first decode', async () => {
    const r = rig({ originalSize: () => ({ w: 20000, h: 10000 }) })
    const img = await createImageLoader(r.pictures, r.create)('a.png', 8192)
    expect(r.originalCalls).toEqual(['a.png']) // read once, decoded twice
    expect(r.decodes).toHaveLength(2)
    const [first, second] = r.decodes
    expect(first!.blob).toBe(second!.blob)
    expect(first!.options).toEqual(UPRIGHT)
    expect(second!.options).toEqual({ ...UPRIGHT, resizeWidth: 8192, resizeHeight: 4096, resizeQuality: 'medium' })
    expect(first!.bitmap).toMatchObject({ width: 20000, height: 10000, closed: 1 })
    expect(second!.bitmap!.closed).toBe(0)
    expect(img).toEqual({ bitmap: second!.bitmap, natural: { w: 20000, h: 10000 } })
  })

  it.each([
    [8193, 100, 8192, 100],
    [100, 8193, 100, 8192],
    [9000, 6000, 8192, 5461],
    [6000, 9000, 5461, 8192],
    [16384, 16384, 8192, 8192],
    [30000, 1, 8192, 1],
    [1, 30000, 1, 8192],
    [100000, 10, 8192, 1],
    [12345, 9876, 8192, 6554],
  ])('scales %s × %s to %s × %s: the longer side is 8192, the shape is kept, no side is 0', async (w, h, rw, rh) => {
    const r = rig({ originalSize: () => ({ w, h }) })
    const img = await createImageLoader(r.pictures, r.create)('a.png', 8192)
    expect(r.decodes[1]!.options).toMatchObject({ resizeWidth: rw, resizeHeight: rh })
    expect(img?.bitmap).toMatchObject({ width: rw, height: rh })
    expect(Math.max(rw, rh)).toBe(8192)
    expect(img?.natural).toEqual({ w, h })
  })
})

describe('createImageLoader: when it cannot', () => {
  it('gives null when the host has no preview or no original, and decodes nothing', async () => {
    const r = rig()
    const load = createImageLoader(r.pictures, r.create)
    expect(await load('a.png', 256)).toBeNull()
    expect(await load('a.png', 1024)).toBeNull()
    expect(await load('a.png', 8192)).toBeNull()
    expect(r.decodes).toHaveLength(0)
  })

  it('gives null, never a throw, when the host rejects or throws', async () => {
    const calls: string[] = []
    const make = (kind: 'reject' | 'throw') => ({
      preview: (_p: string, _px: number): Promise<Blob | null> => {
        calls.push('preview')
        if (kind === 'throw') throw new Error('sync')
        return Promise.reject(new Error('async'))
      },
      original: (_p: string): Promise<Blob | null> => {
        calls.push('original')
        if (kind === 'throw') throw new Error('sync')
        return Promise.reject(new Error('async'))
      },
    })
    for (const kind of ['reject', 'throw'] as const) {
      const load = createImageLoader(make(kind), async () => new Bmp(1, 1))
      expect(await load('a.png', 256)).toBeNull()
      expect(await load('a.png', 1024)).toBeNull()
      expect(await load('a.png', 8192)).toBeNull()
    }
    expect(calls).toHaveLength(6)
  })

  it('gives null when the picture does not decode, at every tier', async () => {
    const blob = new Blob(['not a picture'])
    const pictures = { preview: async () => blob, original: async () => blob }
    const create: CreateBitmap = async () => {
      throw new Error('EncodingError')
    }
    const load = createImageLoader(pictures, create)
    for (const tier of [256, 1024, 8192] as const) expect(await load('a.png', tier)).toBeNull()
  })

  it('closes the first decode and gives null when the scaled decode fails', async () => {
    const r = rig({ originalSize: () => ({ w: 20000, h: 10000 }) })
    const failing: CreateBitmap = async (blob, options) => {
      if (options?.resizeWidth) throw new Error('out of memory')
      return r.create(blob, options)
    }
    const img = await createImageLoader(r.pictures, failing)('a.png', 8192)
    expect(img).toBeNull()
    expect(r.decodes).toHaveLength(1)
    expect(r.decodes[0]!.bitmap!.closed).toBe(1)
  })

  it('still hands over the scaled picture when the first decode refuses to close', async () => {
    const r = rig({ originalSize: () => ({ w: 20000, h: 10000 }) })
    const create: CreateBitmap = async (blob, options) => {
      const b = (await r.create(blob, options)) as Bmp
      if (!options?.resizeWidth) {
        b.close = () => {
          b.closed++
          throw new Error('gone')
        }
      }
      return b
    }
    const img = await createImageLoader(r.pictures, create)('a.png', 8192)
    expect(img?.bitmap).toMatchObject({ width: 8192, height: 4096 })
    expect(r.decodes[0]!.bitmap!.closed).toBe(1)
  })

  it('leaves no bitmap open that it did not hand over, whatever fails (seeded)', async () => {
    let seed = 12345
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
    for (let i = 0; i < 300; i++) {
      const made: Bmp[] = []
      const size = { w: 1 + Math.floor(rnd() * 20000), h: 1 + Math.floor(rnd() * 20000) }
      const failAt = Math.floor(rnd() * 3) // which decode throws: 0 none, 1 the first, 2 the second
      let n = 0
      const pictures = { preview: async () => new Blob(['x']), original: async () => new Blob(['x']) }
      const create: CreateBitmap = async (_blob, options) => {
        n++
        if (n === failAt) throw new Error('boom')
        const b = options?.resizeWidth ? new Bmp(options.resizeWidth, options.resizeHeight ?? 1) : new Bmp(size.w, size.h)
        made.push(b)
        return b
      }
      const tier = ([256, 1024, 8192] as const)[Math.floor(rnd() * 3)]!
      const img = await createImageLoader(pictures, create)('a.png', tier)
      const open = made.filter((b) => b.closed === 0)
      if (img) expect(open).toEqual([img.bitmap])
      else expect(open).toEqual([])
      for (const b of made) expect(b.closed).toBeLessThanOrEqual(1)
    }
  })
})

describe('createImageLoader: the engine\'s createImageBitmap by default', () => {
  it('calls the global one, looked up when it is called', async () => {
    const calls: [Blob, ImageBitmapOptions | undefined][] = []
    vi.stubGlobal('createImageBitmap', async (b: Blob, o?: ImageBitmapOptions) => {
      calls.push([b, o])
      return new Bmp(40, 30)
    })
    try {
      const blob = new Blob(['x'])
      const load = createImageLoader({ preview: async () => blob, original: async () => blob })
      const img = await load('a.png', 256)
      expect(calls).toEqual([[blob, UPRIGHT]])
      expect(img).toMatchObject({ bitmap: { width: 40, height: 30 }, natural: { w: 40, h: 30 } })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('gives null where there is none (it never throws)', async () => {
    const blob = new Blob(['x'])
    const load = createImageLoader({ preview: async () => blob, original: async () => blob })
    expect(await load('a.png', 256)).toBeNull()
    expect(await load('a.png', 8192)).toBeNull()
  })
})

describe('createImageLoader feeding an ImageCache', () => {
  const settle = () => new Promise<void>((r) => setImmediate(r))

  it('reads each original once, scales a huge one, and shows the preview of a picture whose original cannot be read', async () => {
    const sizes: Record<string, { preview: { w: number; h: number }; original: { w: number; h: number } | null }> = {
      'small.png': { preview: { w: 600, h: 400 }, original: { w: 600, h: 400 } },
      'big.png': { preview: { w: 1024, h: 683 }, original: { w: 3000, h: 2000 } },
      'huge.png': { preview: { w: 1024, h: 512 }, original: { w: 20000, h: 10000 } },
      'locked.png': { preview: { w: 1024, h: 768 }, original: null },
    }
    const originalCalls: string[] = []
    const previewCalls: string[] = []
    const made: Bmp[] = []
    const sizeOf = new Map<Blob, { w: number; h: number }>()
    const blob = (s: { w: number; h: number } | null) => {
      if (!s) return null
      const b = new Blob(['x'])
      sizeOf.set(b, s)
      return b
    }
    const pictures = {
      preview: async (p: string, px: number) => {
        previewCalls.push(`${p}@${px}`)
        return blob(sizes[p]!.preview)
      },
      original: async (p: string) => {
        originalCalls.push(p)
        return blob(sizes[p]!.original)
      },
    }
    const create: CreateBitmap = async (b, o) => {
      const s = sizeOf.get(b)!
      const out = o?.resizeWidth ? new Bmp(o.resizeWidth, o.resizeHeight!) : new Bmp(s.w, s.h)
      made.push(out)
      return out
    }
    let loaded = 0
    const cache = new ImageCache({ load: createImageLoader(pictures, create), onLoaded: () => void loaded++, concurrency: 4 })
    const names = Object.keys(sizes)
    cache.setVisible(names)
    // Zoomed in on all of them at once: the board asks 5000 px of each.
    const frame = () => names.map((n) => cache.get(n, 5000))
    frame()
    await settle()
    // Nothing is known of a picture yet, so the first thing asked of each is the picture itself.
    expect([...originalCalls].sort()).toEqual(['big.png', 'huge.png', 'locked.png', 'small.png'])
    expect(previewCalls).toEqual([])
    // The one that could not be read has nothing to draw: its preview is asked for next. The others are not asked for anything more.
    frame()
    await settle()
    expect(previewCalls).toEqual(['locked.png@1024'])
    expect(originalCalls).toHaveLength(4)
    const [small, big, huge, locked] = frame()
    expect(small).toMatchObject({ failed: false, natural: { w: 600, h: 400 } })
    expect(small!.bitmap).toMatchObject({ width: 600, height: 400 })
    expect(big).toMatchObject({ natural: { w: 3000, h: 2000 } })
    expect(big!.bitmap).toMatchObject({ width: 3000, height: 2000 })
    expect(huge).toMatchObject({ natural: { w: 20000, h: 10000 } })
    expect(huge!.bitmap).toMatchObject({ width: 8192, height: 4096 })
    expect(locked).toMatchObject({ failed: false, natural: null })
    expect(locked!.bitmap).toMatchObject({ width: 1024, height: 768 })
    await settle()
    expect(originalCalls).toHaveLength(4)
    expect(cache.stats()).toMatchObject({ bitmaps: 4, failed: 0, loading: 0, queued: 0 })
    // The huge picture's full-size first decode was closed on the spot; the four bitmaps held are the only ones open.
    expect(made.filter((b) => b.closed === 0)).toHaveLength(4)
    expect(made.filter((b) => b.width === 20000).map((b) => b.closed)).toEqual([1])
    cache.dispose()
    expect(made.every((b) => b.closed === 1)).toBe(true)
    expect(loaded).toBeGreaterThan(0)
  })

  it('learns a picture\'s size from its preview, so the original of a picture under 1024 px is never read', async () => {
    const originalCalls: string[] = []
    const blob = new Blob(['x'])
    const pictures = {
      preview: async () => blob,
      original: async (p: string) => {
        originalCalls.push(p)
        return blob
      },
    }
    const create: CreateBitmap = async () => new Bmp(600, 400)
    const cache = new ImageCache({ load: createImageLoader(pictures, create), onLoaded: () => {} })
    cache.setVisible(['a.png'])
    // Fit to the window first: the 1024 preview is what a mid-size view asks for.
    cache.get('a.png', 900)
    await settle()
    for (let i = 0; i < 3; i++) {
      cache.get('a.png', 6000)
      await settle()
    }
    expect(originalCalls).toEqual([])
    expect(cache.get('a.png', 6000)).toMatchObject({ natural: { w: 600, h: 400 }, failed: false })
    cache.dispose()
  })
})

/* ------------------------------------------------------------- Chromium --- */

const here = path.dirname(fileURLToPath(import.meta.url))

function findChromium(): string | undefined {
  const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false
  const bases = [process.env['PLAYWRIGHT_BROWSERS_PATH'], '/opt/pw-browsers'].filter((b): b is string => !!b && b !== '0')
  for (const base of bases) {
    if (isFile(path.join(base, 'chromium'))) return path.join(base, 'chromium')
    let dirs: string[] = []
    try {
      dirs = readdirSync(base)
        .filter((n) => /^chromium-\d+$/.test(n))
        .sort()
        .reverse()
    } catch {
      continue
    }
    for (const d of dirs) {
      for (const rel of ['chrome-linux/chrome', 'chrome-win/chrome.exe', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        if (isFile(path.join(base, d, rel))) return path.join(base, d, rel)
      }
    }
  }
  return undefined
}

describe('createImageLoader in Chromium', () => {
  let browser: Browser | null = null
  let js = ''

  beforeAll(async () => {
    const src = await fs.readFile(path.join(here, '..', 'src', 'board', 'imageLoader.ts'), 'utf8')
    // The loader imports one value (the tiers) and types: take the import out and define the value in front of it.
    js = ts
      .transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
      .outputText.replace(/^import .*$/gm, '')
      .replace(/^export /gm, '')
    try {
      const { chromium } = await import('playwright-core')
      browser = await chromium.launch({ executablePath: findChromium() })
    } catch {
      browser = null
    }
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('decodes previews and originals with the engine\'s own createImageBitmap, scales a wide picture to 8192, and turns a picture by its EXIF', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await browser.newPage()
    try {
      await page.setContent('<!doctype html><title>loader</title>')
      const out = await page.evaluate(async (code) => {
        const { createImageLoader } = new Function(`const IMAGE_TIERS = [256, 1024, 8192]; ${code}; return { createImageLoader }`)() as {
          createImageLoader(p: { preview(path: string, px: number): Promise<Blob | null>; original(path: string): Promise<Blob | null> }): (path: string, tier: number) => Promise<{ bitmap: ImageBitmap; natural?: { w: number; h: number } } | null>
        }
        const png = async (w: number, h: number) => {
          const c = new OffscreenCanvas(w, h)
          const g = c.getContext('2d')!
          g.fillStyle = '#e33'
          g.fillRect(0, 0, w, h)
          return c.convertToBlob({ type: 'image/png' })
        }
        // A JPEG whose EXIF says "turn 90 degrees clockwise" (orientation 6): 40 × 20 as stored, 20 × 40 as shown.
        const jpegTurned = async () => {
          const c = new OffscreenCanvas(40, 20)
          const g = c.getContext('2d')!
          g.fillStyle = '#36c'
          g.fillRect(0, 0, 40, 20)
          const plain = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg' })).arrayBuffer())
          // Big-endian TIFF: header, one entry (tag 0x0112 Orientation, SHORT, one value: 6), no next directory.
          const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]
          const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
          const len = exif.length + 2
          const app1 = [0xff, 0xe1, len >> 8, len & 255, ...exif]
          // After the SOI (and the JFIF segment the encoder may write first, which can stay).
          return new Blob([plain.slice(0, 2), new Uint8Array(app1), plain.slice(2)], { type: 'image/jpeg' })
        }
        const wide = await png(9000, 30)
        const small = await png(300, 200)
        const turned = await jpegTurned()
        const host = {
          preview: async (p: string) => (p === 'small' ? small : p === 'turned' ? turned : null),
          original: async (p: string) => (p === 'wide' ? wide : p === 'turned' ? turned : p === 'small' ? small : null),
        }
        const load = createImageLoader(host)
        const sizeOf = (r: Awaited<ReturnType<typeof load>>) => (r ? { w: r.bitmap.width, h: r.bitmap.height, natural: r.natural ?? null } : null)
        const a = sizeOf(await load('small', 256))
        const b = sizeOf(await load('small', 1024))
        const c = sizeOf(await load('wide', 8192))
        const d = sizeOf(await load('turned', 1024))
        const e = sizeOf(await load('turned', 8192))
        const f = sizeOf(await load('missing', 256))
        return { a, b, c, d, e, f }
      }, js)
      // 300 × 200 is above the 256 tier: the engine gave it whole here, the host would have scaled it, so there is no size to report.
      expect(out.a).toEqual({ w: 300, h: 200, natural: null })
      expect(out.b).toEqual({ w: 300, h: 200, natural: { w: 300, h: 200 } })
      // 9000 × 30 scaled while decoding to 8192 × 27 (30 × 8192 / 9000), the picture's own size reported.
      expect(out.c).toEqual({ w: 8192, h: 27, natural: { w: 9000, h: 30 } })
      // Turned by its EXIF, preview and original alike: 20 × 40.
      expect(out.d).toEqual({ w: 20, h: 40, natural: { w: 20, h: 40 } })
      expect(out.e).toEqual({ w: 20, h: 40, natural: { w: 20, h: 40 } })
      expect(out.f).toBeNull()
    } finally {
      await page.close()
    }
  }, 60_000)
})
