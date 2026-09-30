/**
 * The checks behind the picture IPC (thumbnails, new pictures, opening one
 * in the OS), as pure functions so they are tested without Electron: size
 * caps, the thumbnail size clamp, what a real picture's first bytes look
 * like, its pixel size from the header, and the thumbnail cache.
 */
import { promises as fs } from 'node:fs'
import { isImageName } from './fsvault.js'

/** Largest picture the renderer may write (a dropped file, a Concept Forge drawing). */
export const MAX_ASSET_BYTES = 40 * 1024 * 1024
/** Larger files get no thumbnail. */
export const MAX_THUMB_FILE_BYTES = 64 * 1024 * 1024
/**
 * Most pixels decoded inside the app for a thumbnail (an 8000 × 8000
 * painting, 256 MB as RGBA). That decode is synchronous in the main process,
 * and a few KB of PNG can claim a 30 000 × 30 000 canvas. The OS thumbnailers
 * (Windows, macOS) run on their own and are not limited by this.
 */
export const MAX_DECODE_PIXELS = 64_000_000
/**
 * Bytes read from a file to find its kind and pixel size: a JPEG's frame
 * header comes after its metadata segments (EXIF, XMP, an ICC profile,
 * Photoshop's resources with their own preview), up to 64 KB each.
 */
export const HEADER_BYTES = 512 * 1024
export const THUMB_MIN = 32
export const THUMB_MAX = 1024

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
const i32le = (b: Uint8Array, i: number): number => u16le(b, i) | (u16le(b, i + 2) << 16)

/**
 * Pixel size a picture's header claims (PNG, JPEG, GIF, WebP, BMP), or null
 * when the header is not there or not understood (AVIF is not parsed).
 * `b` is the start of the file; HEADER_BYTES is enough for real files.
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

/** Walks the JPEG markers up to the first frame header (SOF0–SOF15 except DHT, JPG and DAC). */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2
  while (i + 8 < b.length) {
    if (b[i] !== 0xff) return null
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
    // End of image or start of scan before any frame header: not a picture we can size.
    if (m === 0xd9 || m === 0xda) return null
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const height = u16be(b, i + 5)
      const width = u16be(b, i + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    const len = u16be(b, i + 2)
    if (len < 2) return null
    i += 2 + len
  }
  return null
}

/**
 * True when a file starting with `header` may be decoded inside the app
 * (Electron's own decoder, which reads PNG and JPEG): its header must name a
 * sane pixel count. Anything else, or a header that does not add up, is left alone.
 */
export function decodableInProcess(header: Uint8Array): boolean {
  const kind = imageKindOf(header)
  if (kind !== 'png' && kind !== 'jpeg') return false
  const size = imageSize(header)
  return size !== null && size.width * size.height <= MAX_DECODE_PIXELS
}

/** The first HEADER_BYTES of a file (fewer when it is shorter). */
export async function readHeader(abs: string): Promise<Uint8Array> {
  const handle = await fs.open(abs, 'r')
  try {
    const buf = new Uint8Array(HEADER_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
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
