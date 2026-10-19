/**
 * What the app lends the AI link so an AI can see the vault's pictures (find_pictures, get_image): a list of them by words in the
 * path, and a look at one, the still the thumbnail helper makes of it. Pure Node over what main already has (the last scan, the
 * doors that judge a picture, the thumbnailer), so it can be tested without Electron; main.ts passes those in.
 *
 * Nothing here decodes a picture: the main process must not (decoding blocks its UI thread). The helper does, as for the
 * brain's own moons; this only asks it, and reads the first bytes of the file to say how big the picture is.
 */
import { promises as fs } from 'node:fs'
import { imageSize, readHead, turnsSideways } from './assets.js'
import { isModelName, isVideoName } from './fsvault.js'
import type { FoundPicture, LookedAt, PictureHost } from './ai-link.js'

/**
 * How much of a file is read to find its pixel size. A JPEG's size can come after metadata (an EXIF block with a thumbnail of its
 * own), a megabyte reaches it for any camera file.
 */
export const SIZE_HEAD_BYTES = 1024 * 1024

/** What main knows, as this module needs it. */
export interface PictureSource {
  /**
   * The vault paths of the pictures, videos and 3D models as they are now (the last scan with what the watcher reported since, so
   * a picture sent a moment ago is there), or null when no vault is open.
   */
  paths(): readonly string[] | null
  /** Their size and last change (FsVault.statAssets): what a stat reached in time, the rest listed without. */
  stat(paths: readonly string[]): Promise<{ path: string; mtime?: number; size?: number }[]>
  /** The file at a vault path if it is a picture, video or 3D model of the visible vault, with its canonical vault path; else null. */
  open(path: string): Promise<{ abs: string; path: string } | null>
  /** The still of a picture as PNG bytes of at most `px` on the longer side, or null when it cannot be made (main's thumbnail). */
  thumbnail(path: string, px: number): Promise<Uint8Array | null>
}

/** A vault path's file name. */
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** What kind of thing a vault path names. */
export function kindOf(p: string): FoundPicture['kind'] {
  const name = nameOf(p)
  return isVideoName(name) ? 'video' : isModelName(name) ? 'model' : 'picture'
}

/** Alphabetical by path, capital letters not first; the exact spelling breaks a tie so the order never changes between calls. */
function byPath(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  if (x !== y) return x < y ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

export function makePictureHost(src: PictureSource): PictureHost {
  return {
    async find(query, opts) {
      const all = src.paths()
      if (!all) return { pictures: [], more: false }
      const words = query.toLowerCase().split(/\s+/).filter(Boolean)
      const prefix = opts.folder ? `${opts.folder.replace(/\/+$/, '')}/` : ''
      const hits = all
        .filter((p) => {
          if (prefix && !p.startsWith(prefix)) return false
          const low = p.toLowerCase()
          return words.every((w) => low.includes(w))
        })
        .sort(byPath)
      const shown = hits.slice(0, Math.max(0, opts.limit))
      // Only the pictures listed are stat'ed, never the whole drive.
      const stats = new Map((await src.stat(shown)).map((s) => [s.path, s]))
      return {
        pictures: shown.map((p) => {
          const st = stats.get(p)
          return { path: p, kind: kindOf(p), bytes: st?.size ?? null, modified: st?.mtime ?? null }
        }),
        more: hits.length > shown.length,
      }
    },

    async look(p, px): Promise<LookedAt | null> {
      const file = await src.open(p)
      if (!file) return null
      const png = await src.thumbnail(file.path, px)
      if (!png) return null
      const st = await fs.stat(file.abs).catch(() => null)
      if (!st?.isFile()) return null
      const kind = kindOf(file.path)
      let width: number | null = null
      let height: number | null = null
      if (kind === 'picture') {
        // The size as the picture is shown (a phone photo taken sideways is tall), not as it is stored.
        const head = await readHead(file.abs, SIZE_HEAD_BYTES).catch(() => null)
        const size = head ? imageSize(head) : null
        if (head && size) {
          const turned = turnsSideways(head)
          width = turned ? size.height : size.width
          height = turned ? size.width : size.height
        }
      }
      return { png, path: file.path, kind, bytes: st.size, width, height }
    },
  }
}
