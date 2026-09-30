/**
 * A small zip reader for AI chat exports (Claude and ChatGPT both send a
 * .zip). Only what those archives use: stored and deflated entries, zip64
 * sizes and offsets, UTF-8 names. Entries are read on demand through a
 * random-access source, so a multi-gigabyte ChatGPT export with pictures is
 * never loaded whole: the central directory, then only the entries asked for.
 * Inflating uses the platform's `DecompressionStream` (browsers, Electron,
 * Node 18+), so there is no dependency.
 */

/** Random access to the bytes of an archive. */
export interface ZipSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export interface ZipEntry {
  /** Path inside the archive, `/`-separated (folders end with `/`). */
  name: string
  /** 0 = stored, 8 = deflated. */
  method: number
  compressedSize: number
  /** Uncompressed size as the archive states it. */
  size: number
  /** Offset of the entry's local header. */
  localOffset: number
  encrypted: boolean
}

/** Bytes of an entry as they come out: never more than this unless the caller allows it. */
export const MAX_ENTRY_BYTES = 1024 * 1024 * 1024

export class ZipError extends Error {
  override name = 'ZipError'
}

export function bytesZipSource(bytes: Uint8Array): ZipSource {
  return {
    size: bytes.byteLength,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, Math.min(bytes.byteLength, offset + length))),
  }
}

export function blobZipSource(blob: Blob): ZipSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  }
}

const EOCD = 0x06054b50
const EOCD64 = 0x06064b50
const EOCD64_LOCATOR = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

const u16 = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
const u32 = (b: Uint8Array, at: number): number => (u16(b, at) + u16(b, at + 2) * 0x10000) >>> 0
/** A little-endian u64 as a number (exact below 2^53, which any real archive is). */
const u64 = (b: Uint8Array, at: number): number => u32(b, at) + u32(b, at + 4) * 0x100000000

const utf8 = new TextDecoder('utf-8')

/** Every entry of the archive, from its central directory. Throws `ZipError` when `src` is not a zip. */
export async function zipEntries(src: ZipSource): Promise<ZipEntry[]> {
  if (src.size < 22) throw new ZipError('Not a zip file')
  const tailLen = Math.min(src.size, 22 + 0xffff)
  const tailAt = src.size - tailLen
  const tail = await src.read(tailAt, tailLen)
  let eocd = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tail, i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('Not a zip file (no central directory)')
  let count = u16(tail, eocd + 10)
  let cdSize = u32(tail, eocd + 12)
  let cdOffset = u32(tail, eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20
    const locator = loc >= 0 && u32(tail, loc) === EOCD64_LOCATOR ? u64(tail, loc + 8) : -1
    if (locator < 0) throw new ZipError('Broken zip64 archive')
    const rec = await src.read(locator, 56)
    if (u32(rec, 0) !== EOCD64) throw new ZipError('Broken zip64 archive')
    count = u64(rec, 32)
    cdSize = u64(rec, 40)
    cdOffset = u64(rec, 48)
  }
  if (cdOffset + cdSize > src.size) throw new ZipError('Truncated zip file (was the download cut off?)')
  const cd = await src.read(cdOffset, cdSize)
  const out: ZipEntry[] = []
  let p = 0
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (u32(cd, p) !== CENTRAL) throw new ZipError('Broken central directory')
    const flags = u16(cd, p + 8)
    const method = u16(cd, p + 10)
    let compressedSize = u32(cd, p + 20)
    let size = u32(cd, p + 24)
    const nameLen = u16(cd, p + 28)
    const extraLen = u16(cd, p + 30)
    const commentLen = u16(cd, p + 32)
    let localOffset = u32(cd, p + 42)
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/')
    // Zip64 extra field: the 64-bit values of the fields set to 0xFFFFFFFF, in this order.
    let e = p + 46 + nameLen
    const extraEnd = e + extraLen
    while (e + 4 <= extraEnd) {
      const id = u16(cd, e)
      const len = u16(cd, e + 2)
      if (id === 0x0001) {
        let q = e + 4
        if (size === 0xffffffff) {
          size = u64(cd, q)
          q += 8
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(cd, q)
          q += 8
        }
        if (localOffset === 0xffffffff) localOffset = u64(cd, q)
      }
      e += 4 + len
    }
    out.push({ name, method, compressedSize, size, localOffset, encrypted: (flags & 1) === 1 })
    p = extraEnd + commentLen
  }
  return out
}

/** The uncompressed bytes of `entry`. Throws `ZipError` for encrypted, unsupported or oversized entries. */
export async function zipRead(src: ZipSource, entry: ZipEntry, maxBytes = MAX_ENTRY_BYTES): Promise<Uint8Array> {
  if (entry.encrypted) throw new ZipError(`${entry.name} is encrypted`)
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError(`${entry.name} uses an unsupported compression (${entry.method})`)
  if (entry.size > maxBytes) throw new ZipError(`${entry.name} is too large (${Math.round(entry.size / 1048576)} MB)`)
  const head = await src.read(entry.localOffset, 30)
  if (u32(head, 0) !== LOCAL) throw new ZipError(`Broken entry ${entry.name}`)
  const start = entry.localOffset + 30 + u16(head, 26) + u16(head, 28)
  if (start + entry.compressedSize > src.size) throw new ZipError(`Truncated entry ${entry.name}`)
  const data = await src.read(start, entry.compressedSize)
  if (entry.method === 0) return data
  return inflateRaw(data, maxBytes, entry.name)
}

/** Raw DEFLATE → bytes, stopping at `maxBytes` (a zip bomb can claim any size). */
async function inflateRaw(data: Uint8Array, maxBytes: number, name: string): Promise<Uint8Array> {
  // A copy owns a plain ArrayBuffer (a Blob part must; the input may be a view of a shared one).
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new ZipError(`${name} is too large`)
      chunks.push(value)
    }
  } catch (err) {
    void reader.cancel().catch(() => undefined)
    if (err instanceof ZipError) throw err
    throw new ZipError(`${name} is damaged (${err instanceof Error ? err.message : String(err)})`)
  }
  if (chunks.length === 1) return chunks[0]!
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** Text of a UTF-8 entry (a byte-order mark is dropped). */
export async function zipReadText(src: ZipSource, entry: ZipEntry, maxBytes = MAX_ENTRY_BYTES): Promise<string> {
  const text = utf8.decode(await zipRead(src, entry, maxBytes))
  return text.startsWith('\uFEFF') ? text.slice(1) : text
}
