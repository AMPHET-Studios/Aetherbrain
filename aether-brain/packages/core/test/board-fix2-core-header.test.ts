import { describe, expect, it } from 'vitest'
import { IMAGE_BLIND_DECODE_MAX_BYTES, IMAGE_HEADER_BYTES, IMAGE_HEADER_MAX_BYTES, readBlobHeader, readImageHeader } from '../src'

/**
 * Round-2 review fix diff-core-2: the 150-megapixel gate read the header from the first 256 KB only, so a JPEG whose frame header (SOF)
 * lies behind long COM / APP segments read as "no header" and the loader decoded the whole raster blind (156 Mpx from a 1 MB file).
 * `readBlobHeader` looks further into a JPEG or AVIF (2 MiB), the walk reads the bytes between segments as libjpeg does, and a file with
 * no header that is not tiny is a file to refuse (`IMAGE_BLIND_DECODE_MAX_BYTES`; the loader's side is in the ui package's tests).
 */

const u16 = (n: number): number[] => [(n >> 8) & 255, n & 255]
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
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

/** COM segments holding `bytes` bytes in all (65,533 a segment, the most one holds). */
function com(bytes: number): Uint8Array {
  const parts: Uint8Array[] = []
  for (let left = bytes; left > 0; ) {
    const n = Math.min(left, 65533)
    parts.push(cat([0xff, 0xfe, ...u16(n + 2)], new Uint8Array(n).fill(0x20)))
    left -= n
  }
  return cat(...parts)
}

const SOF = (w: number, h: number): number[] => [0xff, 0xc0, ...u16(11), 8, ...u16(h), ...u16(w), 1, 1, 0x11, 0]
const DQT: number[] = [0xff, 0xdb, ...u16(67), 0, ...new Array<number>(64).fill(1)]
const SOS_EOI: number[] = [0xff, 0xda, ...u16(8), 1, 1, 0, 0, 63, 0, 0, 0, 0xff, 0xd9]

/** A JPEG claiming w x h, with `pad` bytes of COM segments and then `between` in front of the frame header. */
function jpeg(w: number, h: number, pad = 0, between: number[] = []): Uint8Array {
  return cat([0xff, 0xd8], com(pad), between, DQT, SOF(w, h), SOS_EOI)
}

const blobOf = (b: Uint8Array): Blob => new Blob([b as BlobPart])

describe('readBlobHeader: the frame header behind long segments', () => {
  it('finds a JPEG header that the first 256 KB do not hold (300 KB of COM before the SOF, 14000 x 11000 = 154 Mpx)', async () => {
    const file = jpeg(14000, 11000, 300 * 1024)
    expect(file.length).toBeGreaterThan(IMAGE_HEADER_BYTES)
    // The old read: the first 256 KB say nothing, which is how a 0.3 MB file passed the gate and was decoded whole.
    expect(readImageHeader(file.subarray(0, IMAGE_HEADER_BYTES))).toBeNull()
    const header = await readBlobHeader(blobOf(file))
    expect(header).toMatchObject({ kind: 'jpeg', width: 14000, height: 11000, shownWidth: 14000, shownHeight: 11000 })
    expect(header!.width * header!.height).toBeGreaterThan(150e6)
  })

  it('reads the EXIF turn of a picture whose header is that far in too', async () => {
    const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]
    const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
    const app1 = [0xff, 0xe1, ...u16(exif.length + 2), ...exif]
    const file = cat([0xff, 0xd8], com(300 * 1024), app1, DQT, SOF(12000, 9000), SOS_EOI)
    expect(await readBlobHeader(blobOf(file))).toMatchObject({ width: 12000, height: 9000, shownWidth: 9000, shownHeight: 12000 })
  })

  it('looks no further than IMAGE_HEADER_MAX_BYTES (a header past it is no header) and leaves a header in the first bytes alone', async () => {
    expect(IMAGE_HEADER_MAX_BYTES).toBeGreaterThan(IMAGE_HEADER_BYTES)
    expect(await readBlobHeader(blobOf(jpeg(10, 10, IMAGE_HEADER_MAX_BYTES + 1024)))).toBeNull()
    expect(await readBlobHeader(blobOf(jpeg(10, 10, IMAGE_HEADER_MAX_BYTES - 4096)))).toMatchObject({ width: 10, height: 10 })
    expect(await readBlobHeader(blobOf(jpeg(4000, 3000)))).toMatchObject({ kind: 'jpeg', width: 4000, height: 3000 })
  })

  it('reads the bytes between JPEG segments as libjpeg does: padding, a stray byte, a stuffed zero are skipped (a real Chromium decodes such a file)', async () => {
    for (const between of [[0], [0, 0, 0, 0], [0x41], [0xff, 0x00, 0x41], [0xff, 0xff, 0xff]]) {
      // (After a first segment: the picture's first three bytes are FF D8 FF, for Chromium's sniffer as for ours.)
      const file = jpeg(12504, 12504, 1, between)
      // The old walk stopped at the first byte that is no marker: no header, so the whole raster was decoded to see what it was.
      expect(await readBlobHeader(blobOf(file)), `between ${between}`).toMatchObject({ kind: 'jpeg', width: 12504, height: 12504 })
    }
    // Both: a stray byte after a long COM.
    expect(await readBlobHeader(blobOf(jpeg(12504, 12504, 300 * 1024, [0])))).toMatchObject({ width: 12504, height: 12504 })
  })

  it('does not follow a marker that lies inside a segment (an EXIF thumbnail has a frame header of its own)', async () => {
    const thumb = jpeg(160, 120)
    const app1 = [0xff, 0xe1, ...u16(thumb.length + 2), ...thumb]
    const file = cat([0xff, 0xd8], app1, DQT, SOF(6000, 4000), SOS_EOI)
    expect(await readBlobHeader(blobOf(file))).toMatchObject({ width: 6000, height: 4000 })
  })

  it('gives null, never a hang or a throw, for hostile JPEG bytes (seeded)', async () => {
    let seed = 20261010
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
    for (let n = 0; n < 400; n++) {
      const body = new Uint8Array(Math.floor(rnd() * 3000))
      // Mostly markers and 0xFF: the bytes that make a walker loop.
      for (let i = 0; i < body.length; i++) body[i] = rnd() < 0.4 ? 0xff : Math.floor(rnd() * 256)
      const file = cat([0xff, 0xd8, 0xff], body)
      const h = readImageHeader(file)
      expect(h === null || (h.width > 0 && h.height > 0)).toBe(true)
      const b = await readBlobHeader(blobOf(file))
      expect(b === null || b.kind === 'jpeg').toBe(true)
    }
  })
})

describe('readBlobHeader: other kinds', () => {
  const pngHead = (w: number, h: number): number[] => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...u32(w), ...u32(h), 8, 2, 0, 0, 0]

  it('reads a PNG, GIF, WebP and BMP header from the first bytes, whatever follows', async () => {
    expect(await readBlobHeader(blobOf(cat(pngHead(30000, 30000), new Uint8Array(1000))))).toMatchObject({ kind: 'png', width: 30000, height: 30000 })
    const gif = cat([...'GIF89a'].map((c) => c.charCodeAt(0)), [0x40, 0x01, 0xf0, 0x00], new Uint8Array(2048))
    expect(gif.length).toBeGreaterThan(2000)
    expect(await readBlobHeader(blobOf(gif))).toMatchObject({ kind: 'gif', width: 320, height: 240 })
  })

  it('gives null for a truncated PNG and for a PNG whose first chunk is no IHDR, however large (no second look: only a JPEG or AVIF has a header further in)', async () => {
    expect(await readBlobHeader(blobOf(new Uint8Array(pngHead(100, 100)).subarray(0, 20)))).toBeNull()
    const noIhdr = cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(300 * 1024), 0x74, 0x45, 0x58, 0x74], new Uint8Array(300 * 1024), pngHead(30000, 30000).slice(8))
    expect(await readBlobHeader(blobOf(noIhdr))).toBeNull()
  })

  it('finds an AVIF size behind a long box in front of its meta box', async () => {
    const box = (type: string, ...body: (number[] | Uint8Array)[]): Uint8Array => {
      const inner = cat(...body)
      return cat(u32(8 + inner.length), [...type].map((c) => c.charCodeAt(0)), inner)
    }
    const ispe = box('ispe', [0, 0, 0, 0], u32(14000), u32(11000))
    const meta = box('meta', [0, 0, 0, 0], box('iprp', box('ipco', ispe)))
    const ftyp = box('ftyp', [...'avif'].map((c) => c.charCodeAt(0)), u32(0), [...'avif'].map((c) => c.charCodeAt(0)))
    const file = cat(ftyp, box('free', new Uint8Array(300 * 1024)), meta)
    expect(readImageHeader(file.subarray(0, IMAGE_HEADER_BYTES))).toBeNull()
    expect(await readBlobHeader(blobOf(file))).toMatchObject({ kind: 'avif', width: 14000, height: 11000 })
  })

  it('never throws: a blob that cannot be read has no header, and an empty one neither', async () => {
    const broken = { size: 5_000_000, slice: () => ({ arrayBuffer: () => Promise.reject(new Error('gone')) }) }
    expect(await readBlobHeader(broken)).toBeNull()
    expect(await readBlobHeader(blobOf(new Uint8Array(0)))).toBeNull()
    // The first look says "JPEG" and the second fails.
    let calls = 0
    const flaky = {
      size: 5_000_000,
      slice: (_a?: number, b?: number) => ({
        arrayBuffer: async () => {
          calls++
          if (calls > 1) throw new Error('gone')
          return jpeg(10, 10, 300 * 1024).buffer.slice(0, b ?? 0) as ArrayBuffer
        },
      }),
    }
    expect(await readBlobHeader(flaky)).toBeNull()
  })

  it('keeps the blind-decode size small (icons), far under what a flat raster needs', () => {
    expect(IMAGE_BLIND_DECODE_MAX_BYTES).toBeGreaterThanOrEqual(2 * 1024)
    // A flat 156-megapixel JPEG is 0.6 MB; at a thousandth of that nothing can be big.
    expect(IMAGE_BLIND_DECODE_MAX_BYTES).toBeLessThanOrEqual(64 * 1024)
  })
})
