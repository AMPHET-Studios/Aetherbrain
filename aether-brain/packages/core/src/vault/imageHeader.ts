/**
 * What a picture's first bytes say about it, as pure functions of the bytes: its kind (PNG, JPEG, GIF, WebP, BMP, AVIF), the pixel size its
 * header claims and whether it is shown turned a quarter (EXIF orientation 5 to 8, an AVIF `irot`). No decoding: a board asks this of the
 * first 256 KB of a file (a JPEG or AVIF whose header is not there: the first 2 MiB, `readBlobHeader`) BEFORE it lets the browser decode
 * it, because a few KB of PNG can claim a 30,000 x 30,000 canvas (3.6 GB). A file whose header cannot be found is refused, not decoded to
 * see what it is (only a file of at most IMAGE_BLIND_DECODE_MAX_BYTES still is).
 * The same logic lives in apps/desktop/src/main/assets.ts (main cannot share the renderer's bundle); apps/desktop/test/image-header.test.ts
 * keeps the two in agreement.
 */

/** Largest header size (pixels) a board decodes at all (an 8000 x 8000 painting, 256 MB as RGBA); the thumbnail cap in main is 64 million. */
export const MAX_DECODE_PIXELS = 64_000_000
/** How much of a file is enough to read its header (a JPEG's frame header can sit behind a long EXIF or ICC segment). */
export const IMAGE_HEADER_BYTES = 256 * 1024
/**
 * How far into a JPEG or AVIF `readBlobHeader` looks when the first IMAGE_HEADER_BYTES hold no header (long COM, APP or ICC segments
 * push the frame header back; each JPEG segment is at most 64 KB, so this is thirty-odd of them).
 */
export const IMAGE_HEADER_MAX_BYTES = 2 * 1024 * 1024
/**
 * A file whose header cannot be read (after `readBlobHeader`) is decoded blind, to learn what it is, only when it is at most this big
 * (an icon, a few-pixel picture): what a decode takes is not known, and a flat raster compresses to a few hundred KB (a JPEG of
 * 12,504 x 12,504 pixels is 0.6 MB, two bits a block). A JPEG of this size, whose header is the one that can be missing, holds under
 * ten megapixels.
 */
export const IMAGE_BLIND_DECODE_MAX_BYTES = 16 * 1024

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif'


/** True when `b` holds `bytes` at offset `at`. */
function has(b: Uint8Array, at: number, bytes: readonly number[]): boolean {
  if (at + bytes.length > b.length) return false
  for (let i = 0; i < bytes.length; i++) if (b[at + i] !== bytes[i]) return false
  return true
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIG = [0xff, 0xd8, 0xff]
const GIF87 = ascii('GIF87a')
const GIF89 = ascii('GIF89a')
const RIFF = ascii('RIFF')
const WEBP = ascii('WEBP')
const BM = ascii('BM')
const FTYP = ascii('ftyp')
const AVIF = ascii('avif')
const AVIS = ascii('avis')
const EXIF = [...ascii('Exif'), 0, 0]
const TIFF_LE = ascii('II')
const TIFF_BE = ascii('MM')

/**
 * What kind of picture the bytes start with, or null for anything else: the
 * signature of each format the vault shows (PNG, JPEG, GIF, WebP, BMP, AVIF
 * still or sequence). A renamed text file or executable is null.
 */
export function imageKindOf(b: Uint8Array): ImageKind | null {
  if (has(b, 0, PNG_SIG)) return 'png'
  if (has(b, 0, JPEG_SIG)) return 'jpeg'
  if (has(b, 0, GIF87) || has(b, 0, GIF89)) return 'gif'
  if (has(b, 0, RIFF) && has(b, 8, WEBP)) return 'webp'
  // Two letters alone say little: a BMP has at least its 14-byte file header and a 12-byte DIB header.
  if (has(b, 0, BM) && b.length >= 26) return 'bmp'
  if (has(b, 4, FTYP) && (has(b, 8, AVIF) || has(b, 8, AVIS))) return 'avif'
  return null
}

const u16be = (b: Uint8Array, i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
const u16le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
const u24le = (b: Uint8Array, i: number): number => u16le(b, i) + (b[i + 2] ?? 0) * 0x10000
const u32be = (b: Uint8Array, i: number): number => u16be(b, i) * 0x10000 + u16be(b, i + 2)
const u32le = (b: Uint8Array, i: number): number => u16le(b, i) + u16le(b, i + 2) * 0x10000
const i32le = (b: Uint8Array, i: number): number => u16le(b, i) | (u16le(b, i + 2) << 16)
const fourcc = (b: Uint8Array, i: number): string => String.fromCharCode(b[i] ?? 0, b[i + 1] ?? 0, b[i + 2] ?? 0, b[i + 3] ?? 0)

/**
 * Pixel size a picture's header claims (PNG, JPEG, GIF, WebP, BMP, AVIF), as
 * stored (before any EXIF rotation), or null when the header is not there or
 * not understood. `b` is the file, or at least its start.
 */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const out = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null)
  switch (imageKindOf(b)) {
    case 'png':
      // The IHDR chunk comes first: length, "IHDR", width, height.
      return has(b, 12, ascii('IHDR')) && b.length >= 24 ? out(u32be(b, 16), u32be(b, 20)) : null
    case 'gif':
      return b.length >= 10 ? out(u16le(b, 6), u16le(b, 8)) : null
    case 'bmp': {
      // OS/2 headers (12 bytes) hold 16-bit sizes; the others 32-bit, height negative for top-down rows.
      if (u16le(b, 14) === 12 && u16le(b, 16) === 0) return out(u16le(b, 18), u16le(b, 20))
      return out(Math.abs(i32le(b, 18)), Math.abs(i32le(b, 22)))
    }
    case 'webp':
      return webpSize(b)
    case 'jpeg':
      return jpegSize(b)
    case 'avif':
      return avifSize(b)
    default:
      return null
  }
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (has(b, 12, ascii('VP8 '))) {
    // Lossy: a key frame's start code, then 14-bit width and height.
    if (!has(b, 23, [0x9d, 0x01, 0x2a]) || b.length < 30) return null
    const width = u16le(b, 26) & 0x3fff
    const height = u16le(b, 28) & 0x3fff
    return width && height ? { width, height } : null
  }
  if (has(b, 12, ascii('VP8L'))) {
    // Lossless: a 0x2f signature, then width - 1 and height - 1 in 14 bits each.
    if (b[20] !== 0x2f || b.length < 25) return null
    const b1 = b[21] ?? 0
    const b2 = b[22] ?? 0
    const b3 = b[23] ?? 0
    const b4 = b[24] ?? 0
    return { width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) }
  }
  if (has(b, 12, ascii('VP8X')) && b.length >= 30) return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) }
  return null
}

/**
 * Calls `visit(marker, at, len)` for each JPEG segment with a length (`at`:
 * its 0xFF, `len`: its length field) up to the start of scan, until `visit`
 * returns true. Reads the bytes between segments as the decoder does (libjpeg
 * skips whatever is not a marker: padding after an EXIF segment, a stray
 * byte), so that the frame header the decoder will use is the one found here.
 */
function jpegSegments(b: Uint8Array, visit: (marker: number, at: number, len: number) => boolean): void {
  let i = 2
  while (i + 8 < b.length) {
    if (b[i] !== 0xff) {
      // Not a marker: skipped up to the next 0xFF, as libjpeg's next_marker does.
      do i++
      while (i < b.length && b[i] !== 0xff)
      continue
    }
    const m = b[i + 1] ?? 0
    if (m === 0xff) {
      // Fill byte before a marker.
      i++
      continue
    }
    if (m === 0) {
      // A stuffed zero (0xFF 0x00) is no marker either.
      i += 2
      continue
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      // Markers without a length.
      i += 2
      continue
    }
    // End of image or start of scan: no more headers.
    if (m === 0xd9 || m === 0xda) return
    const len = u16be(b, i + 2)
    if (len < 2 || visit(m, i, len)) return
    i += 2 + len
  }
}

/** The first frame header's size (SOF0–SOF15 except DHT, JPG and DAC). */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let size: { width: number; height: number } | null = null
  jpegSegments(b, (m, at) => {
    if (m < 0xc0 || m > 0xcf || m === 0xc4 || m === 0xc8 || m === 0xcc) return false
    const height = u16be(b, at + 5)
    const width = u16be(b, at + 7)
    size = width > 0 && height > 0 ? { width, height } : null
    return true
  })
  return size
}

/** EXIF orientation (1–8) of the first APP1 segment holding EXIF data (an XMP one may come first); 1 without one. */
function jpegOrientation(b: Uint8Array): number {
  let orientation = 1
  jpegSegments(b, (m, at, len) => {
    if (m !== 0xe1 || !has(b, at + 4, EXIF)) return false
    orientation = tiffOrientation(b, at + 4 + EXIF.length, at + 2 + len)
    return true
  })
  return orientation
}

/** EXIF orientation (1–8) in a TIFF stream at `start`..`end` (IFD0, tag 0x0112, one SHORT); 1 when there is none. */
function tiffOrientation(b: Uint8Array, start: number, end: number): number {
  const little = has(b, start, TIFF_LE)
  if (!little && !has(b, start, TIFF_BE)) return 1
  const stop = Math.min(end, b.length)
  const u16 = (i: number): number => (little ? u16le(b, i) : u16be(b, i))
  if (u16(start + 2) !== 42) return 1
  const ifd = start + (little ? u32le(b, start + 4) : u32be(b, start + 4))
  if (ifd + 2 > stop) return 1
  const entries = u16(ifd)
  for (let k = 0; k < entries; k++) {
    const e = ifd + 2 + k * 12
    if (e + 12 > stop) return 1
    if (u16(e) !== 0x0112) continue
    const value = u16(e + 8)
    return u16(e + 2) === 3 && value >= 1 && value <= 8 ? value : 1
  }
  return 1
}

/** EXIF orientation of a PNG: an eXIf chunk before the image data (one after it is not applied by the decoder). */
function pngOrientation(b: Uint8Array): number {
  for (let i = 8; i + 8 <= b.length; ) {
    const len = u32be(b, i)
    const type = fourcc(b, i + 4)
    if (type === 'IDAT' || type === 'IEND') return 1
    if (type === 'eXIf') return tiffOrientation(b, i + 8, i + 8 + len)
    i += 12 + len
  }
  return 1
}

/**
 * Calls `visit(type, body, end)` for each ISO-BMFF box in `start`..`end`
 * (`body`: where its content starts) until `visit` returns true.
 */
function boxes(b: Uint8Array, start: number, end: number, visit: (type: string, body: number, end: number) => boolean): void {
  const stop = Math.min(end, b.length)
  for (let i = start; i + 8 <= stop; ) {
    let size = u32be(b, i)
    let header = 8
    if (size === 1) {
      // A 64-bit size: anything past 4 GB is past the file anyway.
      if (i + 16 > stop || u32be(b, i + 8) !== 0) return
      size = u32be(b, i + 12)
      header = 16
    } else if (size === 0) {
      size = stop - i
    }
    if (size < header) return
    if (visit(fourcc(b, i + 4), i + header, Math.min(i + size, stop))) return
    i += size
  }
}

/**
 * The item properties of an AVIF (meta → iprp → ipco): each `ispe` (image
 * spatial extents) and `irot` (rotation) box, in file order.
 */
function avifProperties(b: Uint8Array): { ispe: { width: number; height: number }[]; quarterTurn: boolean } {
  const out = { ispe: [] as { width: number; height: number }[], quarterTurn: false }
  const into = (want: string, then: (body: number, end: number) => void) => (type: string, body: number, end: number) => {
    if (type !== want) return false
    then(body, end)
    return true
  }
  // meta is a full box: version and flags come before its children.
  boxes(b, 0, b.length, into('meta', (meta, metaEnd) =>
    boxes(b, meta + 4, metaEnd, into('iprp', (iprp, iprpEnd) =>
      boxes(b, iprp, iprpEnd, into('ipco', (ipco, ipcoEnd) =>
        boxes(b, ipco, ipcoEnd, (type, body, end) => {
          if (type === 'ispe' && body + 12 <= end) out.ispe.push({ width: u32be(b, body + 4), height: u32be(b, body + 8) })
          // irot: the low two bits count anticlockwise quarter turns.
          if (type === 'irot' && body < end && ((b[body] ?? 0) & 1) === 1) out.quarterTurn = true
          return false
        }),
      )),
    )),
  ))
  return out
}

/** An AVIF's size: its largest `ispe` (a grid's full size, not a tile's or an embedded thumbnail's). */
function avifSize(b: Uint8Array): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null
  for (const s of avifProperties(b).ispe) {
    if (s.width > 0 && s.height > 0 && (!best || s.width * s.height > best.width * best.height)) best = s
  }
  return best
}

/**
 * True when Chromium shows the picture turned a quarter from how it is
 * stored: EXIF orientation 5–8 in a JPEG or in a PNG's eXIf chunk, or an
 * AVIF rotated 90° or 270°. (Chromium ignores a WebP's EXIF.) The thumbnail
 * size is then asked with width and height swapped: Chromium applies the
 * orientation before it scales.
 */
export function turnsSideways(b: Uint8Array): boolean {
  switch (imageKindOf(b)) {
    case 'jpeg':
      return jpegOrientation(b) >= 5
    case 'png':
      return pngOrientation(b) >= 5
    case 'avif':
      return avifProperties(b).quarterTurn
    default:
      return false
  }
}

/** What a header says of a picture: its pixel size as stored, and as shown (turned a quarter when the orientation says so). */
export interface ImageHeader {
  kind: ImageKind
  /** As stored in the file. */
  width: number
  height: number
  /** As shown (width and height swapped for an EXIF quarter turn). */
  shownWidth: number
  shownHeight: number
}

/** The header of the picture whose first bytes are `bytes` (the whole file, or at least its first IMAGE_HEADER_BYTES), or null. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const kind = imageKindOf(bytes)
  const size = kind ? imageSize(bytes) : null
  if (!kind || !size) return null
  const sideways = turnsSideways(bytes)
  return { kind, width: size.width, height: size.height, shownWidth: sideways ? size.height : size.width, shownHeight: sideways ? size.width : size.height }
}

/** What `readBlobHeader` needs of a Blob (a File is one): its size and a slice that can be read as bytes. */
export interface HeaderSource {
  readonly size: number
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> }
}

/**
 * The header of a picture held as a Blob, or null when it has none that can be read: the first IMAGE_HEADER_BYTES, and, for a JPEG or
 * an AVIF whose frame header or `ispe` box is not in them (long COM, APP or ICC segments, a box in front), the first
 * IMAGE_HEADER_MAX_BYTES. Nothing is decoded. A null for a file bigger than IMAGE_BLIND_DECODE_MAX_BYTES is a file to refuse, not to
 * decode "to see": a flat 12,504 x 12,504 JPEG is 0.6 MB and decodes to 625 MB. Never throws.
 */
export async function readBlobHeader(blob: HeaderSource): Promise<ImageHeader | null> {
  try {
    const head = new Uint8Array(await blob.slice(0, IMAGE_HEADER_BYTES).arrayBuffer())
    const header = readImageHeader(head)
    if (header || blob.size <= head.length) return header
    const kind = imageKindOf(head)
    if (kind !== 'jpeg' && kind !== 'avif') return null
    return readImageHeader(new Uint8Array(await blob.slice(0, IMAGE_HEADER_MAX_BYTES).arrayBuffer()))
  } catch {
    return null
  }
}
