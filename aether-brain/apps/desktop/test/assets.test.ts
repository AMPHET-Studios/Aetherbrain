import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_ASSET_BYTES,
  MAX_DECODE_PIXELS,
  ThumbCache,
  assetBytes,
  assetPath,
  fitWithin,
  imageKindOf,
  imageSize,
  readUpTo,
  readHead,
  thumbPx,
  thumbTarget,
  turnsSideways,
  byteRange,
  serveVideo,
  videoKindOf,
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

/** EXIF data (a TIFF stream) whose IFD0 holds `tags` ([tag, type, value] SHORTs), little or big endian. */
const tiff = (tags: [number, number, number][], little = false) => {
  const u16 = (n: number) => (little ? le16(n) : be16(n))
  const u32 = (n: number) => (little ? le32(n) : be32(n))
  return [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...u16(tags.length),
    ...tags.flatMap(([tag, type, value]) => [...u16(tag), ...u16(type), ...u32(1), ...u16(value), 0, 0]),
    ...u32(0),
  ]
}
const orientationTag = (o: number): [number, number, number] => [0x0112, 3, o]
/** A JPEG whose first APP1 is EXIF data with orientation `o` (after an XMP APP1 with `xmpFirst`). */
const jpegExif = (w: number, h: number, o: number, opts: { little?: boolean; xmpFirst?: boolean } = {}) => {
  const exif = bytes('Exif', [0, 0], tiff([[0x010f, 2, 0], orientationTag(o)], opts.little))
  const xmp = bytes('http://ns.adobe.com/xap/1.0/', [0], '<x:xmpmeta/>')
  const app1 = (body: Uint8Array) => [0xff, 0xe1, ...be16(body.length + 2), ...body]
  const rest = jpeg(w, h).subarray(2)
  return bytes([0xff, 0xd8], opts.xmpFirst ? app1(xmp) : [], app1(exif), [...rest])
}
/** A PNG with an eXIf chunk (orientation `o`) before its image data, or after it with `late`. */
const pngExif = (w: number, h: number, o: number, late = false) => {
  const data = tiff([orientationTag(o)])
  const chunk = (type: string, body: number[]) => [...be32(body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body, 0, 0, 0, 0]
  const head = [...png(w, h)]
  const idat = chunk('IDAT', [0, 0, 0])
  const exif = chunk('eXIf', data)
  return new Uint8Array([...head, ...(late ? [...idat, ...exif] : [...exif, ...idat]), ...chunk('IEND', [])])
}
/** ISO-BMFF boxes: `box(type, ...body)`, a full box has version and flags first. */
const box = (type: string, ...body: (number[] | string)[]) => {
  const b = [...bytes(...body)]
  return [...be32(8 + b.length), ...[...type].map((c) => c.charCodeAt(0)), ...b]
}
const fullBox = (type: string, ...body: (number[] | string)[]) => box(type, [0, 0, 0, 0], ...body)
const ispe = (w: number, h: number) => fullBox('ispe', be32(w), be32(h))
const irot = (quarterTurns: number) => box('irot', [quarterTurns])
/** An AVIF with these item properties (meta → iprp → ipco). */
const avifWith = (...props: number[][]) =>
  bytes(box('ftyp', 'avif', be32(0), 'mif1', 'miaf'), fullBox('meta', fullBox('hdlr', be32(0), 'pict', new Array<number>(13).fill(0)), box('iprp', box('ipco', ...props))))

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

  it('reads an AVIF size from its largest ispe property (a grid, not its tiles), 64-bit box sizes included', () => {
    expect(imageSize(avifWith(ispe(512, 512), ispe(2048, 1536), ispe(512, 512)))).toEqual({ width: 2048, height: 1536 })
    expect(imageSize(avifWith(ispe(0, 10)))).toBeNull()
    expect(imageSize(avifWith(irot(1)))).toBeNull()
    // A box whose size is in the 64-bit field (size 1).
    const meta = fullBox('meta', box('iprp', box('ipco', ispe(3000, 2000))))
    const large = [...be32(1), ...meta.slice(4, 8), ...be32(0), ...be32(meta.length + 8), ...meta.slice(8)]
    expect(imageSize(bytes(box('ftyp', 'avif', be32(0), 'mif1'), large))).toEqual({ width: 3000, height: 2000 })
    // Boxes that claim more than there is, or less than their own header, end the walk without throwing.
    expect(imageSize(bytes(box('ftyp', 'avif', be32(0)), be32(4), 'meta'))).toBeNull()
    expect(imageSize(avifWith(ispe(640, 480)).subarray(0, 60))).toBeNull()
  })
})

describe('orientation', () => {
  it('reads EXIF orientation from the first EXIF APP1 of a JPEG, either byte order, after an XMP APP1 too', () => {
    for (const o of [5, 6, 7, 8]) expect(turnsSideways(jpegExif(40, 30, o)), `orientation ${o}`).toBe(true)
    for (const o of [1, 2, 3, 4]) expect(turnsSideways(jpegExif(40, 30, o)), `orientation ${o}`).toBe(false)
    expect(turnsSideways(jpegExif(40, 30, 6, { little: true }))).toBe(true)
    expect(turnsSideways(jpegExif(40, 30, 6, { xmpFirst: true }))).toBe(true)
    expect(imageSize(jpegExif(40, 30, 6))).toEqual({ width: 40, height: 30 })
    // Out of range, or not a SHORT, is no orientation at all.
    expect(turnsSideways(jpegExif(40, 30, 9))).toBe(false)
    const long = bytes([0xff, 0xd8], [0xff, 0xe1], be16(2 + 6 + 26), 'Exif', [0, 0], tiff([[0x0112, 4, 6]]), [...jpeg(4, 3).subarray(2)])
    expect(turnsSideways(long)).toBe(false)
    expect(turnsSideways(jpeg(40, 30))).toBe(false)
  })

  it('reads a PNG eXIf chunk only before the image data (the decoder ignores a later one)', () => {
    expect(turnsSideways(pngExif(40, 30, 6))).toBe(true)
    expect(turnsSideways(pngExif(40, 30, 3))).toBe(false)
    expect(turnsSideways(pngExif(40, 30, 6, true))).toBe(false)
    expect(turnsSideways(png(40, 30))).toBe(false)
  })

  it('turns an AVIF rotated by an odd number of quarter turns, and nothing else', () => {
    expect(turnsSideways(avifWith(ispe(40, 30), irot(1)))).toBe(true)
    expect(turnsSideways(avifWith(ispe(40, 30), irot(3)))).toBe(true)
    expect(turnsSideways(avifWith(ispe(40, 30), irot(2)))).toBe(false)
    expect(turnsSideways(avifWith(ispe(40, 30)))).toBe(false)
    expect(turnsSideways(gif(40, 30))).toBe(false)
    expect(turnsSideways(bytes('not a picture at all'))).toBe(false)
  })
})

describe('what the thumbnail helper is asked to make', () => {
  it('fits the picture as shown within the thumbnail size, never enlarged, with its media type', () => {
    expect(thumbTarget(png(4000, 3000), 128)).toEqual({ type: 'image/png', width: 128, height: 96 })
    expect(thumbTarget(png(100, 50), 128)).toEqual({ type: 'image/png', width: 100, height: 50 })
    expect(thumbTarget(jpeg(3000, 4000), 512)).toEqual({ type: 'image/jpeg', width: 384, height: 512 })
    expect(thumbTarget(gif(320, 200), 128)).toEqual({ type: 'image/gif', width: 128, height: 80 })
    expect(thumbTarget(webpLossy(1920, 1080), 128)).toEqual({ type: 'image/webp', width: 128, height: 72 })
    expect(thumbTarget(bmp(800, -600), 128)).toEqual({ type: 'image/bmp', width: 128, height: 96 })
    expect(thumbTarget(avifWith(ispe(2048, 1536)), 128)).toEqual({ type: 'image/avif', width: 128, height: 96 })
  })

  it('swaps width and height for a picture the decoder turns a quarter (it scales after turning)', () => {
    // Stored 4000 × 3000, shown 3000 × 4000: asking for 128 × 96 would squash it.
    expect(thumbTarget(jpegExif(4000, 3000, 6), 128)).toEqual({ type: 'image/jpeg', width: 96, height: 128 })
    expect(thumbTarget(jpegExif(4000, 3000, 3), 128)).toEqual({ type: 'image/jpeg', width: 128, height: 96 })
    expect(thumbTarget(pngExif(60, 20, 8), 128)).toEqual({ type: 'image/png', width: 20, height: 60 })
    expect(thumbTarget(avifWith(ispe(400, 100), irot(1)), 128)).toEqual({ type: 'image/avif', width: 32, height: 128 })
  })

  it('makes nothing of a picture whose size it cannot read or that claims too many pixels', () => {
    expect(thumbTarget(png(8000, 8000), 128)).toEqual({ type: 'image/png', width: 128, height: 128 })
    expect(8000 * 8000).toBeLessThanOrEqual(MAX_DECODE_PIXELS)
    expect(thumbTarget(png(8001, 8000), 128)).toBeNull()
    // A few bytes claiming a 30 000 × 30 000 canvas (3.6 GB of pixels) are never decoded.
    expect(thumbTarget(png(30_000, 30_000), 128)).toBeNull()
    expect(thumbTarget(jpeg(65_535, 65_535), 128)).toBeNull()
    expect(thumbTarget(avifWith(ispe(20_000, 20_000)), 128)).toBeNull()
    expect(thumbTarget(png(640, 480).subarray(0, 20), 128)).toBeNull()
    expect(thumbTarget(avif, 128)).toBeNull()
    expect(thumbTarget(bytes('MZ', new Array<number>(64).fill(0)), 128)).toBeNull()
    expect(thumbTarget(new Uint8Array(0), 128)).toBeNull()
  })
})

describe('reading a picture', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-assets-'))
  })
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('reads a whole file of at most `max` bytes, and nothing of a bigger one', async () => {
    const file = path.join(tmp, 'a.gif')
    await fs.writeFile(file, gif(3, 4))
    expect(await readUpTo(file, 1000)).toEqual(gif(3, 4))
    expect(await readUpTo(file, gif(3, 4).length)).toEqual(gif(3, 4))
    expect(await readUpTo(file, gif(3, 4).length - 1)).toBeNull()
    const empty = path.join(tmp, 'empty.png')
    await fs.writeFile(empty, '')
    expect(await readUpTo(empty, 10)).toEqual(new Uint8Array(0))
    await expect(readUpTo(path.join(tmp, 'missing.png'), 10)).rejects.toThrow()
  })

  it.skipIf(process.platform !== 'linux')('keeps reading past the size a stat gave, up to `max` (a file that grew)', async () => {
    // /proc files stat as empty and read as text.
    const text = await fs.readFile('/proc/self/mountinfo')
    expect(text.length).toBeGreaterThan(10)
    expect((await readUpTo('/proc/self/mountinfo', 1_000_000))?.length).toBeGreaterThan(10)
    expect(await readUpTo('/proc/self/mountinfo', 5)).toBeNull()
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

describe('videos', () => {
  it('know a video from its first bytes, and a picture in a video box is not one', () => {
    expect(videoKindOf(bytes(be32(32), 'ftypisom', be32(512), 'isomiso2'))).toBe('mp4')
    expect(videoKindOf(bytes(be32(32), 'ftypmp42'))).toBe('mp4')
    expect(videoKindOf(bytes(be32(20), 'ftypqt  '))).toBe('quicktime')
    expect(videoKindOf(bytes(be32(8), 'wide', be32(100), 'mdat'))).toBe('quicktime')
    expect(videoKindOf(bytes(be32(100), 'moov'))).toBe('quicktime')
    expect(videoKindOf(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f]))).toBe('webm')
    expect(videoKindOf(bytes('OggS', [0, 2]))).toBe('ogg')
    expect(videoKindOf(bytes(be32(28), 'ftypavif'))).toBeNull()
    expect(videoKindOf(bytes(be32(28), 'ftypheic'))).toBeNull()
    expect(videoKindOf(png(4, 4))).toBeNull()
    expect(videoKindOf(bytes('MZ', [0x90, 0, 3, 0, 0, 0]))).toBeNull()
    expect(videoKindOf(new Uint8Array(0))).toBeNull()
  })

  it('read the byte ranges a media player asks for', () => {
    expect(byteRange(null, 100)).toBeNull()
    expect(byteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(byteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(byteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
    expect(byteRange('bytes=-30', 100)).toEqual({ start: 70, end: 99 })
    expect(byteRange('bytes=-300', 100)).toEqual({ start: 0, end: 99 })
    expect(byteRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(byteRange('bytes=20-10', 100)).toBe('unsatisfiable')
    expect(byteRange('bytes=-0', 100)).toBe('unsatisfiable')
    for (const junk of ['bytes=-', 'items=0-1', 'bytes=0-1,5-6', 'bytes=a-b']) expect(byteRange(junk, 100), junk).toBeNull()
  })

  describe('served from disk', () => {
    let dir = ''
    let file = ''
    const data = Uint8Array.from({ length: 1000 }, (_, i) => i & 255)
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-video-'))
      file = path.join(dir, 'clip.webm')
      await fs.writeFile(file, data)
    })
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true })
    })

    it('whole or in ranges, as its media type, readable across origins; nothing for a missing file', async () => {
      const all = await serveVideo(file, 'video/webm', null)
      expect(all.status).toBe(200)
      expect(Object.fromEntries(['content-type', 'content-length', 'accept-ranges', 'access-control-allow-origin'].map((h) => [h, all.headers.get(h)]))).toEqual({
        'content-type': 'video/webm',
        'content-length': '1000',
        'accept-ranges': 'bytes',
        'access-control-allow-origin': '*',
      })
      expect(new Uint8Array(await all.arrayBuffer())).toEqual(data)
      const part = await serveVideo(file, 'video/webm', 'bytes=100-199')
      expect([part.status, part.headers.get('content-range'), part.headers.get('content-length')]).toEqual([206, 'bytes 100-199/1000', '100'])
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(data.subarray(100, 200))
      const tail = await serveVideo(file, 'video/webm', 'bytes=-10')
      expect(new Uint8Array(await tail.arrayBuffer())).toEqual(data.subarray(990))
      const past = await serveVideo(file, 'video/webm', 'bytes=5000-')
      expect([past.status, past.headers.get('content-range')]).toEqual([416, 'bytes */1000'])
      expect((await serveVideo(path.join(dir, 'gone.webm'), 'video/webm', null)).status).toBe(404)
      expect((await serveVideo(dir, 'video/webm', null)).status).toBe(404)
      expect(await readHead(file, 4)).toEqual(data.subarray(0, 4))
      expect(await readHead(file, 5000)).toEqual(data)
    })
  })
})
