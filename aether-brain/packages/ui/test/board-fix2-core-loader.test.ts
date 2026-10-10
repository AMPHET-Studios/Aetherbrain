import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser } from 'playwright-core'
import { IMAGE_BLIND_DECODE_MAX_BYTES } from '@aether/core'
import { ImageCache } from '../src/board/imageCache'
import { createImageLoader, type CreateBitmap } from '../src/board/imageLoader'

/**
 * Round-2 review fix diff-core-2: the 150-megapixel gate must not be bypassed by a JPEG whose frame header (SOF) lies beyond the first
 * 256 KB (long COM or APP segments, or a stray byte between segments). The loader used to read the header from 256 KB only; a file with
 * "no header" was decoded whole when it was up to 16 MB (a flat 156-megapixel JPEG is 0.6 MB and decodes to 625 MB). Now the header is
 * looked for in the first 2 MiB of a JPEG, the walk reads the bytes between segments as libjpeg does, and a file whose header still
 * cannot be read is refused unless it is tiny (an icon). The same cases in real Chromium (skipped without one) with real flat JPEGs.
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

const u16 = (n: number): number[] => [(n >> 8) & 255, n & 255]
const cat = (...parts: (number[] | Uint8Array)[]): Uint8Array => {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** COM segments holding `bytes` bytes in all. */
function com(bytes: number): Uint8Array {
  const parts: Uint8Array[] = []
  for (let left = bytes; left > 0; ) {
    const n = Math.min(left, 65533)
    parts.push(cat([0xff, 0xfe, ...u16(n + 2)], new Uint8Array(n).fill(0x20)))
    left -= n
  }
  return cat(...parts)
}

/**
 * A flat grey baseline JPEG of w x h that a real decoder decodes: every 8 x 8 block is "DC difference 0, end of block" (two zero bits).
 * `pad` bytes of COM segments, then `between` (stray bytes), come before the frame header.
 */
function flatJpeg(w: number, h: number, pad = 0, between: number[] = []): Uint8Array {
  const blocks = Math.ceil(w / 8) * Math.ceil(h / 8)
  return cat(
    [0xff, 0xd8],
    com(pad),
    between,
    [0xff, 0xdb, ...u16(67), 0x00, ...new Array<number>(64).fill(1)],
    [0xff, 0xc0, ...u16(11), 8, ...u16(h), ...u16(w), 1, 1, 0x11, 0],
    [0xff, 0xc4, ...u16(2 + 1 + 16 + 1), 0x00, 1, ...new Array<number>(15).fill(0), 0x00],
    [0xff, 0xc4, ...u16(2 + 1 + 16 + 1), 0x10, 1, ...new Array<number>(15).fill(0), 0x00],
    [0xff, 0xda, ...u16(8), 1, 1, 0x00, 0, 63, 0],
    new Uint8Array(Math.ceil((blocks * 2) / 8)),
    [0xff, 0xd9],
  )
}

const blobOf = (b: Uint8Array): Blob => new Blob([b as BlobPart])

/** A fake engine that makes a bitmap of the size `says` and counts what it was asked. */
function engine(says: { w: number; h: number } = { w: 400, h: 300 }) {
  const calls: (ImageBitmapOptions | undefined)[] = []
  const made: Bmp[] = []
  const create: CreateBitmap = async (_blob, options) => {
    calls.push(options)
    const b = options?.resizeWidth ? new Bmp(options.resizeWidth, options.resizeHeight ?? 1) : new Bmp(says.w, says.h)
    made.push(b)
    return b
  }
  return { create, calls, made }
}

/** The host: no preview (main makes none above 64 megapixels, nor for a file it cannot read), the original as given. */
const hostOf = (file: Blob) => ({ preview: async () => null, original: async () => file })

describe('the loader and a JPEG whose frame header is not in the first 256 KB', () => {
  it('refuses it at every tier without decoding anything (300 KB of COM before the SOF, 14000 x 11000 = 154 megapixels)', async () => {
    const file = flatJpeg(14000, 11000, 300 * 1024)
    expect(file.length).toBeGreaterThan(256 * 1024)
    const e = engine()
    const load = createImageLoader(hostOf(blobOf(file)), e.create)
    for (const tier of [256, 1024, 8192] as const) {
      expect(await load('big.jpg', tier)).toEqual({ failure: 'too-large', natural: { w: 14000, h: 11000 } })
    }
    expect(e.calls).toHaveLength(0)
  })

  it('refuses it when a stray byte sits between its segments (one junk byte after a short COM)', async () => {
    const e = engine()
    const load = createImageLoader(hostOf(blobOf(flatJpeg(12504, 12504, 1, [0]))), e.create)
    expect(await load('junk.jpg', 8192)).toEqual({ failure: 'too-large', natural: { w: 12504, h: 12504 } })
    expect(e.calls).toHaveLength(0)
  })

  it('still decodes a long-headed JPEG that is not too big, once, at the size wanted', async () => {
    const e = engine()
    const file = flatJpeg(6000, 4000, 300 * 1024)
    const img = await createImageLoader(hostOf(blobOf(file)), e.create)('photo.jpg', 1024)
    expect(img).toMatchObject({ natural: { w: 6000, h: 4000 } })
    expect(e.calls).toEqual([{ imageOrientation: 'from-image', resizeWidth: 1024, resizeHeight: 683, resizeQuality: 'medium' }])
  })

  it('does not decode a JPEG whose header is past even the first 2 MiB: no header, not a tiny file, so it cannot be read', async () => {
    const file = flatJpeg(16000, 16000, 2 * 1024 * 1024 + 64 * 1024)
    const e = engine({ w: 16000, h: 16000 })
    const load = createImageLoader(hostOf(blobOf(file)), e.create)
    for (const tier of [256, 1024, 8192] as const) expect(await load('far.jpg', tier)).toBeNull()
    expect(e.calls).toHaveLength(0)
  })

  it('does not decode a truncated or odd file of any kind that has no header and is not tiny', async () => {
    const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    // A PNG whose first chunk is not the IHDR (its header is not where a decoder looks), and a JPEG that never gets to a frame header.
    const odd = [cat(pngSig, new Uint8Array(IMAGE_BLIND_DECODE_MAX_BYTES + 1)), cat([0xff, 0xd8, 0xff, 0xe0], new Uint8Array(300 * 1024)), new Uint8Array(17 * 1024 * 1024)]
    for (const bytes of odd) {
      const e = engine({ w: 30000, h: 30000 })
      expect(await createImageLoader(hostOf(blobOf(bytes)), e.create)('odd.png', 8192)).toBeNull()
      expect(e.calls).toHaveLength(0)
    }
  })

  it('shows such a picture as unreadable in the cache (a placeholder that says so), not as a bitmap', async () => {
    const e = engine({ w: 16000, h: 16000 })
    const cache = new ImageCache({ load: createImageLoader(hostOf(blobOf(flatJpeg(16000, 16000, 2 * 1024 * 1024 + 4096))), e.create), onLoaded: () => {} })
    cache.setVisible(['far.jpg'])
    cache.get('far.jpg', 900)
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
    expect(cache.failureOf('far.jpg')).toBe('unreadable')
    expect(e.calls).toHaveLength(0)
    cache.dispose()
  })

  it('keeps decoding a tiny file with no readable header the old way (an icon, a few KB), and a GIF whose header is fine the normal way', async () => {
    const gif = (w: number, h: number, extra: number): Uint8Array => cat([...'GIF89a'].map((c) => c.charCodeAt(0)), [w & 255, w >> 8, h & 255, h >> 8], new Uint8Array(extra))
    // A 2 KB GIF whose logical screen is 0 x 0: no size in the header, so the engine is asked what it is.
    const noSize = gif(0, 0, 2048)
    expect(noSize.length).toBeLessThanOrEqual(IMAGE_BLIND_DECODE_MAX_BYTES)
    const a = engine({ w: 32, h: 32 })
    expect(await createImageLoader(hostOf(blobOf(noSize)), a.create)('icon.gif', 8192)).toMatchObject({ natural: { w: 32, h: 32 } })
    expect(a.calls).toHaveLength(1)
    // A cut-off PNG (20 bytes) and a few bytes of nothing: the engine is asked, as before.
    for (const tiny of [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 40]), new TextEncoder().encode('no header here')]) {
      const t = engine({ w: 40, h: 30 })
      expect(await createImageLoader(hostOf(blobOf(tiny)), t.create)('t.png', 8192)).toMatchObject({ natural: { w: 40, h: 30 } })
      expect(t.calls).toHaveLength(1)
    }
    // The same 2 KB GIF with a real size is read from its header and decoded once, at that size.
    const b = engine({ w: 320, h: 240 })
    expect(await createImageLoader(hostOf(blobOf(gif(320, 240, 2048))), b.create)('anim.gif', 8192)).toMatchObject({ natural: { w: 320, h: 240 } })
    expect(b.calls).toHaveLength(1)
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

describe('the same JPEGs in real Chromium', () => {
  let browser: Browser | null = null
  let js = ''
  let dir = ''

  beforeAll(async () => {
    const exe = findChromium()
    if (!exe) return
    try {
      const { chromium } = await import('playwright-core')
      browser = await chromium.launch({ executablePath: exe })
    } catch {
      browser = null
      return
    }
    // The real loader with the real core (its header reader), bundled; a bundle that fails to build is a failure, not a skip.
    const { build } = await import('vite')
    const posix = (...p: string[]) => path.join(here, '..', ...p).replace(/\\/g, '/')
    dir = mkdtempSync(path.join(os.tmpdir(), 'board-fix2-loader-'))
    const entry = path.join(dir, 'entry.ts')
    writeFileSync(entry, `import { createImageLoader } from '${posix('src', 'board', 'imageLoader.ts')}'\n;(window as unknown as { L: unknown }).L = { createImageLoader }\n`)
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      root: path.join(here, '..'),
      resolve: { alias: [{ find: /^@aether\/core$/, replacement: posix('..', 'core', 'src', 'index.ts') }] },
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'BoardLoader', fileName: 'l' } },
    })
    const bundle = Array.isArray(out) ? out[0]! : out
    const chunk = 'output' in bundle ? bundle.output.find((o) => o.type === 'chunk') : undefined
    js = chunk && chunk.type === 'chunk' ? chunk.code : ''
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  type Out = { failure?: string; natural?: { w: number; h: number }; size?: { w: number; h: number } | null; decodes: number }

  /** Loads each file (base64) at the 8192 tier with the page's own createImageBitmap, counting how many decodes the loader started. */
  async function loadAll(files: Record<string, string>): Promise<Record<string, Out>> {
    const page = await browser!.newPage()
    try {
      await page.setContent('<!doctype html><title>loader</title>')
      await page.addScriptTag({ content: js })
      return await page.evaluate(async (named) => {
        const w = window as unknown as {
          L: { createImageLoader(p: unknown, c: (b: Blob, o?: ImageBitmapOptions) => Promise<ImageBitmap>): (path: string, tier: number) => Promise<{ bitmap?: ImageBitmap; failure?: string; natural?: { w: number; h: number } } | null> }
        }
        const result: Record<string, Out> = {}
        for (const [name, b64] of Object.entries(named)) {
          const bin = atob(b64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          const blob = new Blob([bytes], { type: 'image/jpeg' })
          let decodes = 0
          const load = w.L.createImageLoader({ preview: async () => null, original: async () => blob }, (b, o) => {
            decodes++
            return createImageBitmap(b, o)
          })
          const r = await load(name, 8192)
          const out: Out = { decodes }
          if (r?.failure) out.failure = r.failure
          if (r?.natural) out.natural = r.natural
          out.size = r?.bitmap ? { w: r.bitmap.width, h: r.bitmap.height } : null
          r?.bitmap?.close()
          result[name] = out
        }
        return result
      }, files)
    } finally {
      await page.close()
    }
  }

  const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

  it('refuses 156-megapixel JPEGs with the header behind 300 KB of COM, behind a stray byte, and the plain one, without one decode; decodes a small one with a stray byte', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const out = await loadAll({
      plain: b64(flatJpeg(12504, 12504)),
      padded: b64(flatJpeg(12504, 12504, 300 * 1024)),
      junk: b64(flatJpeg(12504, 12504, 1, [0])),
      // Past the 2 MiB looked at: nothing is known of it, so it is not decoded.
      far: b64(flatJpeg(16000, 16000, 2 * 1024 * 1024 + 64 * 1024)),
      // Chromium takes a stray byte between segments, so the picture is a picture: its size from the header is the one the engine makes.
      small: b64(flatJpeg(64, 48, 1, [0])),
    })
    for (const name of ['plain', 'padded', 'junk']) expect(out[name], name).toEqual({ failure: 'too-large', natural: { w: 12504, h: 12504 }, size: null, decodes: 0 })
    expect(out['far']).toEqual({ size: null, decodes: 0 })
    expect(out['small']).toEqual({ natural: { w: 64, h: 48 }, size: { w: 64, h: 48 }, decodes: 1 })
  }, 120_000)
})
