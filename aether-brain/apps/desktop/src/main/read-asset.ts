/**
 * Reading a vault picture whole, for the reference board: the bytes of the
 * file as they are on disk, handed to the renderer, which decodes them (the
 * main process never decodes pictures). Pure Node, no electron import, so
 * the IPC handler is one line and this is tested against a temp vault.
 */
import { isImageName } from './fsvault.js'
import { readUpTo } from './assets.js'

/** Largest picture served whole: the same cap as the thumbnail path (MAX_THUMB_FILE_BYTES). */
export const READ_ASSET_MAX_BYTES = 64 * 1024 * 1024

/**
 * What the read needs of the vault: the absolute path of a picture or video
 * inside the visible vault, or null. `FsVault` is one; it answers with a
 * promise (it resolves links on disk), so a plain value is accepted too.
 */
export interface AssetReader {
  assetAbs(path: string): Promise<string | null> | string | null
}

/**
 * The bytes of a picture of the vault, or null: not a picture name (a video
 * is a vault asset too, but the board shows pictures), not a plain file
 * inside the visible vault (`assetAbs`: links, ignored folders and paths
 * that leave the vault are refused there), empty, over `max` bytes, or
 * unreadable. Never throws.
 *
 * The file is read by `readUpTo`, which stats it first and never holds more
 * than `max + 1` bytes, even for a file that grows while it is read. Nothing
 * here looks inside the bytes (no signature, no pixel size): a file that is
 * not really a picture is the renderer's decoder's to refuse.
 */
export async function readAssetBytes(vault: AssetReader, path: string, max: number = READ_ASSET_MAX_BYTES): Promise<Uint8Array | null> {
  try {
    // Lexical first: no fs call for a note or a video.
    if (!isImageName(path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '')) return null
    const abs = await vault.assetAbs(path)
    if (!abs) return null
    const bytes = await readUpTo(abs, max)
    return bytes?.length ? bytes : null
  } catch {
    return null
  }
}
