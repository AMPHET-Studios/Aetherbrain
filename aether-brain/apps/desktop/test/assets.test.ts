import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  HEADER_BYTES,
  MAX_ASSET_BYTES,
  MAX_DECODE_PIXELS,
  ThumbCache,
  assetBytes,
  assetPath,
  decodableInProcess,
  fitWithin,
  imageKindOf,
  imageSize,
  readHeader,
  thumbPx,
} from '../src/main/assets.js'

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >>> 8) & 255]
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255]
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
const be16 = (n: number) => [(n >>> 8) & 255, n & 255]

const png = (w: number, h: number) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IHDR', be32(w), be32(h), [8, 6, 0, 0, 0], [0, 0, 0, 0])
const gif = (w: number, h: number) => bytes('GIF89a', le16(w), le16(h), [0, 0, 0])
const bmp = (w: number, h: number) => bytes('BM', le32(0), le32(0), le32(54), le32(40), le32(w), le32(h), le16(1), le16(24))
const bmpCore = (w: number, h: number) => bytes('BM', le32(0), le32(0), le32(26), le32(12), le16(w), le16(h), le16(1), le16(24))
const webpLossy = (w: number, h: number) => bytes('RIFF', le32(0), 'WEBP', 'VP8 ', le32(0), [0, 0, 0], [0x9d, 0x01, 0x2a], le16(w), le16(h))
const webpLossless = (w: number, h: number) => {
  const a = w - 1
  const b = h - 1
  return bytes('RIFF', le32(0), 'WEBP', 'VP8L', le32(0), [0x2f, a & 0xff, ((a >> 8) & 0x3f) | ((b & 0x3) << 6), (b >> 2) & 0xff, (b >> 10) & 0xf])
}
const webpExtended = (w: number, h: number) => bytes('RIFF', le32(0), 'WEBP', 'VP8X', le32(10), [0, 0, 0, 0], le24(w - 1), le24(h - 1))
/** A JPEG with an APP0, a long APP1 (EXIF) and a quantization table before the frame header. */
const jpeg = (w: number, h: number, sof = 0xc0, exif = 300) =>
  bytes(
    [0xff, 0xd8],
    [0xff, 0xe0], be16(16), 'JFIF', [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, 0xe1], be16(exif + 2), new Array<number>(exif).fill(0x45),
    [0xff, 0xdb], be16(4), [0, 1],
    [0xff, 0xff, 0xff],
    [0xff, sof], be16(17), [8], be16(h), be16(w), [3, 1, 0x22, 0],
  )
const avif = bytes(be32(28), 'ftyp', 'avif', be32(0), 'mif1', 'miaf', 'avif')

describe('picture signatures', () => {
  it('knows each format the vault shows by its first bytes', () => {
    expect(imageKindOf(png(1, 1))).toBe('png')
    expect(imageKindOf(jpeg(1, 1))).toBe('jpeg')
    expect(imageKindOf(gif(1, 1))).toBe('gif')
    expect(imageKindOf(bytes('GIF87a', le16(1), le16(1)))).toBe('gif')
    expect(imageKindOf(webpLossy(1, 1))).toBe('webp')
    expect(imageKindOf(bmp(1, 1))).toBe('bmp')
    expect(imageKindOf(avif)).toBe('avif')
    expect(imageKindOf(bytes(be32(28), 'ftyp', 'avis'))).toBe('avif')
  })

  it('refuses anything else, however it is named', () => {
    const others = [
      bytes('MZ', new Array<number>(64).fill(0)),
      bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      bytes('# A note\n'),
      bytes([0x7f], 'ELF'),
      bytes('PK', [3, 4]),
      bytes([0x89, 0x50, 0x4e, 0x47]),
      bytes('GIF8'),
      bytes('RIFF', le32(0), 'WAVE'),
      bytes('BM'),
      bytes(be32(28), 'ftyp', 'heic'),
      new Uint8Array(0),
    ]
    for (const b of others) expect(imageKindOf(b)).toBeNull()
  })
})

describe('picture sizes from headers', () => {
  it('reads PNG, GIF, BMP and WebP sizes', () => {
    expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480 })
    expect(imageSize(png(30_000, 30_000))).toEqual({ width: 30_000, height: 30_000 })
    expect(imageSize(gif(320, 200))).toEqual({ width: 320, height: 200 })
    expect(imageSize(bmp(800, -600))).toEqual({ width: 800, height: 600 })
    expect(imageSize(bmpCore(64, 32))).toEqual({ width: 64, height: 32 })
    expect(imageSize(webpLossy(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(imageSize(webpLossless(1000, 3000))).toEqual({ width: 1000, height: 3000 })
    expect(imageSize(webpLossless(16384, 16384))).toEqual({ width: 16384, height: 16384 })
    expect(imageSize(webpExtended(20_000, 12_000))).toEqual({ width: 20_000, height: 12_000 })
  })

  it('walks JPEG markers (EXIF, tables, fill bytes) to the frame header, baseline or progressive', () => {
    expect(imageSize(jpeg(4000, 3000))).toEqual({ width: 4000, height: 3000 })
    expect(imageSize(jpeg(1200, 900, 0xc2, 60_000))).toEqual({ width: 1200, height: 900 })
    // DHT (C4) is not a frame header.
    const dht = bytes([0xff, 0xd8], [0xff, 0xc4], be16(4), [0, 0], [0xff, 0xc0], be16(17), [8], be16(10), be16(20), [3, 1, 0x22, 0])
    expect(imageSize(dht)).toEqual({ width: 20, height: 10 })
  })

  it('says nothing for headers that are cut short, broken or not understood', () => {
    expect(imageSize(png(640, 480).subarray(0, 20))).toBeNull()
    expect(imageSize(png(0, 480))).toBeNull()
    expect(imageSize(jpeg(4000, 3000).subarray(0, 200))).toBeNull()
    expect(imageSize(bytes([0xff, 0xd8], [0xff, 0xda], be16(2), new Array<number>(16).fill(0)))).toBeNull()
    expect(imageSize(bytes([0xff, 0xd8], [0x00, 0x00], new Array<number>(16).fill(0)))).toBeNull()
    expect(imageSize(bytes([0xff, 0xd8], [0xff, 0xe0], be16(0), new Array<number>(16).fill(0)))).toBeNull()
    expect(imageSize(bytes('RIFF', le32(0), 'WEBP', 'VP8 ', le32(0), [0, 0, 0], [1, 2, 3], le16(1), le16(1)))).toBeNull()
    expect(imageSize(avif)).toBeNull()
    expect(imageSize(bytes('hello world, this is text'))).toBeNull()
  })

  it('lets only PNG and JPEG with a sane pixel count be decoded in the app', () => {
    expect(decodableInProcess(png(8000, 8000))).toBe(true)
    expect(8000 * 8000).toBeLessThanOrEqual(MAX_DECODE_PIXELS)
    expect(decodableInProcess(png(8001, 8000))).toBe(false)
    // A few bytes claiming a 30 000 × 30 000 canvas (3.6 GB of pixels) are never decoded.
    expect(decodableInProcess(png(30_000, 30_000))).toBe(false)
    expect(decodableInProcess(jpeg(4000, 3000))).toBe(true)
    expect(decodableInProcess(jpeg(65_535, 65_535))).toBe(false)
    expect(decodableInProcess(png(640, 480).subarray(0, 20))).toBe(false)
    expect(decodableInProcess(gif(10, 10))).toBe(false)
    expect(decodableInProcess(bytes('MZ'))).toBe(false)
  })
})

describe('reading a header', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-assets-'))
  })
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('reads at most HEADER_BYTES, and all of a shorter file', async () => {
    const big = path.join(tmp, 'big.png')
    const data = new Uint8Array(HEADER_BYTES + 5000).fill(1)
    data.set(png(10, 10))
    await fs.writeFile(big, data)
    const head = await readHeader(big)
    expect(head.length).toBe(HEADER_BYTES)
    expect(imageSize(head)).toEqual({ width: 10, height: 10 })
    const small = path.join(tmp, 'small.gif')
    await fs.writeFile(small, gif(3, 4))
    expect(await readHeader(small)).toEqual(gif(3, 4))
    await expect(readHeader(path.join(tmp, 'missing.png'))).rejects.toThrow()
  })
})

describe('picture IPC arguments', () => {
  it('clamps the thumbnail size to 32–1024 whole pixels and refuses anything but a number', () => {
    expect(thumbPx(128)).toBe(128)
    expect(thumbPx(1)).toBe(32)
    expect(thumbPx(-5)).toBe(32)
    expect(thumbPx(5000)).toBe(1024)
    expect(thumbPx(Infinity)).toBe(1024)
    expect(thumbPx(100.6)).toBe(101)
    for (const bad of [Number.NaN, '128', null, undefined, {}]) expect(() => thumbPx(bad)).toThrow(/number/)
  })

  it('fits a picture inside the thumbnail size, keeping its shape and never enlarging it', () => {
    expect(fitWithin(100, 50, 128)).toBeNull()
    expect(fitWithin(128, 128, 128)).toBeNull()
    expect(fitWithin(4000, 3000, 128)).toEqual({ width: 128, height: 96 })
    expect(fitWithin(128, 1024, 128)).toEqual({ width: 16, height: 128 })
    expect(fitWithin(10_000, 3, 128)).toEqual({ width: 128, height: 1 })
  })

  it('takes picture paths only', () => {
    expect(assetPath('Projects/PORTALz/Critique/study.png')).toBe('Projects/PORTALz/Critique/study.png')
    expect(assetPath('D\\Art\\gate.JPG')).toBe('D\\Art\\gate.JPG')
    for (const bad of ['Inbox/note.md', 'Art/icon.svg', 'Art/run.exe', 'Art', '', '   ', 42, null, undefined]) {
      expect(() => assetPath(bad), String(bad)).toThrow()
    }
  })

  it('takes real picture bytes of at most 40 MB', () => {
    const p = png(2, 2)
    expect(assetBytes(p)).toBe(p)
    expect(assetBytes(p.buffer)).toEqual(p)
    expect(assetBytes(Buffer.from(jpeg(1, 1)))).toBeInstanceOf(Uint8Array)
    expect(() => assetBytes(new Uint8Array(0))).toThrow(/empty/)
    expect(() => assetBytes(bytes('MZ', new Array<number>(100).fill(0)))).toThrow(/Not a picture/)
    expect(() => assetBytes(bytes('<svg/>'))).toThrow(/Not a picture/)
    for (const bad of ['iVBORw0KGgo=', [0x89, 0x50], null, undefined, { length: 3 }]) expect(() => assetBytes(bad)).toThrow(/bytes/)
    const tooBig = new Uint8Array(MAX_ASSET_BYTES + 1)
    tooBig.set(p)
    expect(() => assetBytes(tooBig)).toThrow(/too big/)
    const limit = new Uint8Array(MAX_ASSET_BYTES)
    limit.set(p)
    expect(assetBytes(limit).length).toBe(MAX_ASSET_BYTES)
  })
})

describe('ThumbCache', () => {
  const b = (n: number) => new Uint8Array(n)

  it('keys a picture by path, file version and thumbnail size', () => {
    const k = ThumbCache.key('/v/a.png', 1000, 50, 128)
    expect(k).not.toBe(ThumbCache.key('/v/a.png', 1001, 50, 128))
    expect(k).not.toBe(ThumbCache.key('/v/a.png', 1000, 51, 128))
    expect(k).not.toBe(ThumbCache.key('/v/a.png', 1000, 50, 512))
    expect(k).not.toBe(ThumbCache.key('/v/b.png', 1000, 50, 128))
  })

  it('drops the least recently used entries past its entry limit', () => {
    const c = new ThumbCache(3, 1000)
    c.set('a', b(1))
    c.set('b', b(1))
    c.set('c', null)
    expect(c.get('a')).toEqual(b(1))
    c.set('d', b(1))
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toEqual(b(1))
    // An unreadable picture is remembered too (null), unlike a miss (undefined).
    expect(c.get('c')).toBeNull()
    expect(c.size).toBe(3)
  })

  it('keeps within its byte budget and counts replaced entries once', () => {
    const c = new ThumbCache(100, 10)
    c.set('a', b(4))
    c.set('b', b(4))
    expect(c.bytes).toBe(8)
    c.set('a', b(2))
    expect(c.bytes).toBe(6)
    c.set('c', b(5))
    // b was the least recently used: it goes, a (touched by the replace) stays.
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toEqual(b(2))
    expect(c.bytes).toBe(7)
    // One thumbnail bigger than the whole budget is not kept (and pushes nothing out).
    c.set('huge', b(11))
    expect(c.get('huge')).toBeUndefined()
    expect(c.bytes).toBe(7)
    c.clear()
    expect([c.size, c.bytes]).toEqual([0, 0])
  })
})
