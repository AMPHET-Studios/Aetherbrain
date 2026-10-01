/**
 * The checks behind the picture IPC (thumbnails, new pictures, opening one
 * in the OS), as pure functions so they are tested without Electron: size
 * caps, the thumbnail size clamp, what a real picture's first bytes look
 * like, its pixel size and orientation from the header, what the thumbnail
 * helper is asked to make, and the thumbnail cache. Videos: what their first
 * bytes look like, and the byte ranges of one served to the thumbnail helper
 * (it takes a still frame; nothing here decodes).
 */
import { createReadStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { isImageName } from './fsvault.js'

/** Largest picture the renderer may write (a dropped file, a Concept Forge drawing). */
export const MAX_ASSET_BYTES = 40 * 1024 * 1024
/** Larger files get no thumbnail (their bytes are read whole and handed to the thumbnail helper). */
export const MAX_THUMB_FILE_BYTES = 64 * 1024 * 1024
/**
 * Most pixels decoded for a thumbnail (an 8000 × 8000 painting, 256 MB as
 * RGBA, held for a moment before it is scaled down). A few KB of PNG can
 * claim a 30 000 × 30 000 canvas: the helper would run out of memory on it,
 * so a header claiming more is never decoded.
 */
export const MAX_DECODE_PIXELS = 64_000_000
export const THUMB_MIN = 32
export const THUMB_MAX = 1024

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif'

/** The media type the thumbnail helper decodes each kind as. */
const MIME: Record<ImageKind, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

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
 * returns true. Stops at anything that is not a marker.
 */
function jpegSegments(b: Uint8Array, visit: (marker: number, at: number, len: number) => boolean): void {
  let i = 2
  while (i + 8 < b.length) {
    if (b[i] !== 0xff) return
    const m = b[i + 1] ?? 0
    if (m === 0xff) {
      // Fill byte before a marker.
      i++
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

/** What the thumbnail helper is asked to make of a picture's bytes: decode them as `type`, scaled to `width` × `height`. */
export interface ThumbTarget {
  type: string
  width: number
  height: number
}

/**
 * The thumbnail to make of a picture (its whole file in `b`): its kind from
 * its signature, and its size as shown (header size, turned by its
 * orientation) fitted within `px` on the longer side, never enlarged. Null
 * when it is not a picture, its size cannot be read from the header, or the
 * header claims more than MAX_DECODE_PIXELS.
 */
export function thumbTarget(b: Uint8Array, px: number): ThumbTarget | null {
  const kind = imageKindOf(b)
  const size = kind ? imageSize(b) : null
  if (!kind || !size || size.width * size.height > MAX_DECODE_PIXELS) return null
  const shown = turnsSideways(b) ? { width: size.height, height: size.width } : size
  return { type: MIME[kind], ...(fitWithin(shown.width, shown.height, px) ?? shown) }
}

/**
 * A whole file, or null when it holds more than `max` bytes (it is never
 * read past that, even if it grew since it was stat'ed).
 */
export async function readUpTo(abs: string, max: number): Promise<Uint8Array | null> {
  const handle = await fs.open(abs, 'r')
  try {
    const { size } = await handle.stat()
    if (size > max) return null
    // One byte of room past the size it had: a file that grew is read on, up to one byte past `max`.
    let buf = new Uint8Array(size + 1)
    let got = 0
    for (;;) {
      if (got === buf.length) {
        if (got > max) return null
        const more = new Uint8Array(Math.min(got * 2, max + 1))
        more.set(buf)
        buf = more
      }
      const { bytesRead } = await handle.read(buf, got, buf.length - got, got)
      if (!bytesRead) return buf.subarray(0, got)
      got += bytesRead
    }
  } finally {
    await handle.close()
  }
}

/* ---- videos ---- */

export type VideoKind = 'mp4' | 'quicktime' | 'webm' | 'ogg'

/** The media type a video is served to the thumbnail helper as. */
export const VIDEO_MIME: Record<VideoKind, string> = {
  mp4: 'video/mp4',
  quicktime: 'video/quicktime',
  webm: 'video/webm',
  ogg: 'video/ogg',
}

/** Bytes read from the start of a video to tell its kind. */
export const VIDEO_HEAD_BYTES = 64
/** Boxes an old QuickTime movie may start with instead of `ftyp`. */
const QT_BOXES = ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].map(ascii)
/** `ftyp` brands of pictures (AVIF, HEIF), not videos. */
const STILL_BRANDS = ['avif', 'avis', 'mif1', 'msf1', 'heic', 'heix'].map(ascii)
const EBML = [0x1a, 0x45, 0xdf, 0xa3]
const OGGS = ascii('OggS')

/**
 * What kind of video the first bytes start with (ISO BMFF: mp4, m4v, mov;
 * Matroska / WebM; Ogg), or null for anything else, a picture in an
 * ISO BMFF box (AVIF, HEIF) included. A video is opened with the OS player:
 * a file named `.mp4` that is not one is never handed over.
 */
export function videoKindOf(b: Uint8Array): VideoKind | null {
  if (has(b, 4, FTYP)) {
    if (STILL_BRANDS.some((brand) => has(b, 8, brand))) return null
    return has(b, 8, ascii('qt  ')) ? 'quicktime' : 'mp4'
  }
  if (QT_BOXES.some((box) => has(b, 4, box))) return 'quicktime'
  if (has(b, 0, EBML)) return 'webm'
  if (has(b, 0, OGGS)) return 'ogg'
  return null
}

/** The first `n` bytes of a file (fewer when it is shorter). */
export async function readHead(abs: string, n: number): Promise<Uint8Array> {
  const handle = await fs.open(abs, 'r')
  try {
    const buf = new Uint8Array(n)
    const { bytesRead } = await handle.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * The bytes asked for by an HTTP `Range` header over a file of `size` bytes
 * (`bytes=a-b`, `bytes=a-`, `bytes=-n`; one range): null when there is no
 * usable header (the whole file is sent), 'unsatisfiable' when it starts past
 * the end.
 */
export function byteRange(header: string | null, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    // The last n bytes.
    const n = Number(m[2])
    if (!(n > 0) || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  if (!(start < size)) return 'unsatisfiable'
  const end = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]))
  return end < start ? 'unsatisfiable' : { start, end }
}

/**
 * The answer to one request of the thumbnail helper for a video it was
 * handed: the whole file or the range asked for, streamed from disk (never
 * held whole), as `mime`, readable by the helper's page (CORS) so a frame of
 * it can be drawn and saved.
 */
export async function serveVideo(abs: string, mime: string, rangeHeader: string | null): Promise<Response> {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  const st = await fs.stat(abs).catch(() => null)
  if (!st?.isFile()) return new Response(null, { status: 404, headers: cors })
  const range = byteRange(rangeHeader, st.size)
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...cors, 'Content-Range': `bytes */${st.size}` } })
  const { start, end } = range ?? { start: 0, end: st.size - 1 }
  const length = Math.max(0, end - start + 1)
  const body = length > 0 ? (Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream<Uint8Array>) : null
  const headers: Record<string, string> = { ...cors, 'Content-Type': mime, 'Content-Length': String(length), 'Accept-Ranges': 'bytes' }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`
  return new Response(body, { status: range ? 206 : 200, headers })
}

/** The thumbnail size the renderer asked for, in whole pixels, clamped to 32–1024. */
export function thumbPx(raw: unknown): number {
  if (typeof raw !== 'number' || Number.isNaN(raw)) throw new TypeError('A thumbnail size is a number of pixels')
  return Math.round(Math.min(THUMB_MAX, Math.max(THUMB_MIN, raw)))
}

/** The size to scale `width` × `height` to so its longer side is `max` (aspect kept), or null when it already fits. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } | null {
  if (width <= max && height <= max) return null
  const scale = max / Math.max(width, height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** A new picture's vault path as the renderer sent it; throws for anything that is not a picture name. */
export function assetPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('A picture needs a vault path')
  const name = raw.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? ''
  if (!isImageName(name)) throw new Error(`Only pictures (png, jpg, jpeg, webp, gif, bmp, avif) can be written here: ${raw}`)
  return raw
}

/** A new picture's bytes as the renderer sent them; throws unless they are a real picture of at most 40 MB. */
export function assetBytes(raw: unknown): Uint8Array {
  const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null
  if (!bytes) throw new Error('A picture is sent as bytes (Uint8Array)')
  if (!bytes.length) throw new Error('The picture is empty')
  if (bytes.length > MAX_ASSET_BYTES) {
    throw new Error(`The picture is too big: ${(bytes.length / 1024 / 1024).toFixed(1)} MB (at most ${MAX_ASSET_BYTES / 1024 / 1024} MB)`)
  }
  if (!imageKindOf(bytes)) throw new Error('Not a picture: the data is not a PNG, JPEG, GIF, WebP, BMP or AVIF image')
  return bytes
}

/**
 * Thumbnails most recently used first (PNG bytes, or null for a picture that
 * could not be read), by file version and size, within an entry and a byte
 * budget. A changed file (mtime, size) never hits an old entry; old ones age out.
 */
export class ThumbCache {
  private entries = new Map<string, Uint8Array | null>()
  private total = 0

  constructor(
    readonly maxEntries = 1500,
    readonly maxBytes = 96 * 1024 * 1024,
  ) {}

  /** Key of one version of a picture (`abs`, its mtime and byte size) at one thumbnail size. */
  static key(abs: string, mtimeMs: number, fileSize: number, px: number): string {
    return `${abs}\n${mtimeMs}\n${fileSize}\n${px}`
  }

  get size(): number {
    return this.entries.size
  }

  get bytes(): number {
    return this.total
  }

  /** The cached thumbnail (null: unreadable), or undefined when not cached. Marks it most recently used. */
  get(key: string): Uint8Array | null | undefined {
    const hit = this.entries.get(key)
    if (hit === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit
  }

  set(key: string, value: Uint8Array | null): void {
    const old = this.entries.get(key)
    if (old !== undefined) {
      this.total -= old?.length ?? 0
      this.entries.delete(key)
    }
    if (value && value.length > this.maxBytes) return
    this.entries.set(key, value)
    this.total += value?.length ?? 0
    for (const [k, v] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.total <= this.maxBytes) break
      this.entries.delete(k)
      this.total -= v?.length ?? 0
    }
  }

  clear(): void {
    this.entries.clear()
    this.total = 0
  }
}
