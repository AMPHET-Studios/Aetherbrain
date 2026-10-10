/**
 * Reading a vault picture whole, for the reference board: the bytes of the
 * file as they are on disk, handed to the renderer, which decodes them (the
 * main process never decodes pictures). Pure Node, no electron import, so
 * the IPC handler is one line and this is tested against a temp vault.
 *
 * What main does look at is the file's HEADER: the first 256 KB say how many
 * pixels the picture claims (a few KB of PNG can claim 30,000 x 30,000, which
 * is 3.6 GB once decoded), and a picture over the cap is refused here, before
 * the rest of it is read, with the reason, so that the renderer never holds
 * bytes it must not decode and the board can say why a picture is not shown.
 */
import { promises as fs } from 'node:fs'
import { isImageName } from './fsvault.js'
import { imageSize } from './assets.js'
import type { ReadAssetResult } from '../shared/ipc.js'

/** Largest picture served whole: the same cap as the thumbnail path (MAX_THUMB_FILE_BYTES). Main reads it into memory and the renderer holds a second copy, so it is not raised. */
export const READ_ASSET_MAX_BYTES = 64 * 1024 * 1024
/** Most pixels (width x height) a served picture may claim in its header: the board's loader refuses more as well (MAX_LOAD_PIXELS, imageLoader.ts; the test pins the two together). */
export const READ_ASSET_MAX_PIXELS = 150_000_000
/** How much of the file is read to judge its header (a JPEG's frame header can sit behind a long EXIF or ICC segment). */
export const READ_ASSET_HEAD_BYTES = 256 * 1024

/**
 * What the read needs of the vault: the absolute path of a picture or video
 * inside the visible vault, or null. `FsVault` is one; it answers with a
 * promise (it resolves links on disk), so a plain value is accepted too.
 */
export interface AssetReader {
  assetAbs(path: string): Promise<string | null> | string | null
}

const missing = (detail: string): ReadAssetResult => ({ ok: false, reason: 'missing', detail })
const unreadable = (detail: string): ReadAssetResult => ({ ok: false, reason: 'unreadable', detail })
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`

/**
 * The bytes of a picture of the vault, or the reason there are none: 'missing' (not a picture name - a video is a vault asset too,
 * but the board shows pictures - not a plain file inside the visible vault, where `assetAbs` refuses links, ignored folders and
 * paths that leave the vault), 'too-large' (over `max` bytes, or a header that claims more than `maxPixels`) or 'unreadable'
 * (empty, or the disk said no). Never throws.
 *
 * The file is opened once, stat-ed, its head read and judged, and only then the rest: it never holds more than `max + 1` bytes,
 * even for a file that grows while it is read. A header that cannot be read (not a real picture, or a frame header past the first
 * 256 KB) is served as it is: the renderer's decoder refuses what is not a picture, and its loader checks the header again.
 */
export async function readAssetChecked(
  vault: AssetReader,
  path: string,
  max: number = READ_ASSET_MAX_BYTES,
  maxPixels: number = READ_ASSET_MAX_PIXELS,
): Promise<ReadAssetResult> {
  try {
    // Lexical first: no fs call for a note or a video.
    if (!isImageName(path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '')) return missing('That is not a picture of the vault')
    const abs = await vault.assetAbs(path)
    if (!abs) return missing('The picture is not in the vault (or is in a folder the vault leaves out)')
    const handle = await fs.open(abs, 'r')
    try {
      // (A folder opens, but cannot be read: EISDIR, below.)
      const { size } = await handle.stat()
      if (size === 0) return unreadable('The picture file is empty')
      if (size > max) return { ok: false, reason: 'too-large', detail: `The picture file is ${mb(size)}; the board shows pictures of up to ${mb(max)}` }
      // The head: read once, judged, and kept as the start of the bytes.
      const head = new Uint8Array(Math.min(size, READ_ASSET_HEAD_BYTES))
      let got = 0
      while (got < head.length) {
        const { bytesRead } = await handle.read(head, got, head.length - got, got)
        if (!bytesRead) break
        got += bytesRead
      }
      const claimed = imageSize(head.subarray(0, got))
      if (claimed && claimed.width * claimed.height > maxPixels) {
        const million = Math.round((claimed.width * claimed.height) / 1e6)
        return {
          ok: false,
          reason: 'too-large',
          detail: `The picture is ${claimed.width} x ${claimed.height} pixels (${million} million); the board shows pictures of up to ${Math.round(maxPixels / 1e6)} million`,
        }
      }
      // One byte of room past the size it had: a file that grew is read on, up to one byte past `max`.
      let buf = new Uint8Array(size + 1)
      buf.set(head.subarray(0, got))
      for (;;) {
        if (got === buf.length) {
          if (got > max) return { ok: false, reason: 'too-large', detail: `The picture file is over ${mb(max)}; the board shows pictures of up to ${mb(max)}` }
          const more = new Uint8Array(Math.min(got * 2, max + 1))
          more.set(buf)
          buf = more
        }
        const { bytesRead } = await handle.read(buf, got, buf.length - got, got)
        if (!bytesRead) break
        got += bytesRead
      }
      return got ? { ok: true, bytes: buf.subarray(0, got) } : unreadable('The picture file is empty')
    } finally {
      await handle.close()
    }
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    return code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR' ? missing('The picture file is gone') : unreadable('The picture file could not be read')
  }
}

/** The bytes of a picture of the vault, or null for every reason there is none (see `readAssetChecked`). Never throws. */
export async function readAssetBytes(
  vault: AssetReader,
  path: string,
  max: number = READ_ASSET_MAX_BYTES,
  maxPixels: number = READ_ASSET_MAX_PIXELS,
): Promise<Uint8Array | null> {
  const res = await readAssetChecked(vault, path, max, maxPixels)
  return res.ok ? res.bytes : null
}
