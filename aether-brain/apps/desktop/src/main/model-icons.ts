/**
 * The pictures of 3D models, kept on disk. A model's picture costs the helper a read of the file and a drawing (a big model, a few hundred
 * ms and some tens of MB read), and the in-memory thumbnail cache is lost with every launch, so every launch redrew every model it showed.
 * Here a picture is kept in the app's own data folder (never in the vault: nothing is written next to the user's files), under a name made
 * from the file's path, modification time, size and the size of the picture: a changed model never finds its old picture, and an old one
 * ages out. A model that could not be drawn is remembered too (for a day: a share that was slow, or a helper that crashed, may be the
 * reason and not the model).
 *
 * Bounded: at most `maxBytes` and `maxFiles` (the oldest go first, a hit makes a picture young again), written whole to a temporary file and
 * renamed into place, read back only when it still starts like a PNG and is no bigger than a thumbnail may be.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MAX_THUMB_PNG } from './thumbnailer.js'

export const MODEL_ICON_BYTES = 192 * 1024 * 1024
export const MODEL_ICON_FILES = 6000
/** How long "this model has no picture" is believed. */
export const NO_ICON_MS = 24 * 60 * 60 * 1000

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const isPng = (b: Uint8Array): boolean => b.length >= PNG_SIG.length && b.length <= MAX_THUMB_PNG && PNG_SIG.every((x, i) => b[i] === x)
const isKey = (k: unknown): k is string => typeof k === 'string' && /^[0-9a-f]{40}$/.test(k)

export interface ModelIconOptions {
  maxBytes?: number
  maxFiles?: number
  noIconMs?: number
  /** A clock in ms (tests pass a fake one). */
  now?: () => number
}

export class ModelIconCache {
  private sets = 0
  private temps = 0
  private pruning: Promise<void> | null = null

  constructor(
    readonly dir: string,
    private readonly opts: ModelIconOptions = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  /** The name of one version of a model's picture at one size. */
  static key(abs: string, mtimeMs: number, size: number, px: number): string {
    return createHash('sha1').update(`${abs}\n${mtimeMs}\n${size}\n${px}`).digest('hex')
  }

  private file(key: string, ext: 'png' | 'none'): string {
    return path.join(this.dir, `${key}.${ext}`)
  }

  /** The kept picture (PNG bytes), null for a model known to have none, or undefined when nothing is kept (or it is too old to believe). */
  async get(key: string): Promise<Uint8Array | null | undefined> {
    if (!isKey(key)) return undefined
    const png = this.file(key, 'png')
    try {
      const bytes = new Uint8Array(await fs.readFile(png))
      if (isPng(bytes)) {
        // A hit keeps it young, so the pictures that are used stay and the ones that are not age out.
        const at = new Date(this.now())
        void fs.utimes(png, at, at).catch(() => undefined)
        return bytes
      }
      // Whatever it is, it is not a picture of ours: gone.
      await fs.unlink(png).catch(() => undefined)
    } catch {
      /* not kept */
    }
    const none = this.file(key, 'none')
    try {
      const st = await fs.stat(none)
      if (this.now() - st.mtimeMs < (this.opts.noIconMs ?? NO_ICON_MS)) return null
      await fs.unlink(none).catch(() => undefined)
    } catch {
      /* no note either */
    }
    return undefined
  }

  /** Keep a picture, or (null) the fact that there is none. Anything that is not a PNG of a thumbnail's size is not kept. */
  async set(key: string, png: Uint8Array | null): Promise<void> {
    if (!isKey(key) || (png && !isPng(png))) return
    await fs.mkdir(this.dir, { recursive: true })
    const target = this.file(key, png ? 'png' : 'none')
    const temp = `${target}.${process.pid}.${++this.temps}.tmp`
    try {
      await fs.writeFile(temp, png ?? new Uint8Array(0))
      await fs.rename(temp, target)
    } catch (err) {
      await fs.unlink(temp).catch(() => undefined)
      throw err
    }
    // A picture replaces a "no picture" note, and the other way round.
    await fs.unlink(this.file(key, png ? 'none' : 'png')).catch(() => undefined)
    if (++this.sets % 64 === 0) void this.prune()
  }

  /** Delete the oldest files until what is kept is under its limits (a fifth under, so it does not run at every write). */
  prune(): Promise<void> {
    this.pruning ??= this.pruneNow()
      .catch(() => undefined)
      .finally(() => {
        this.pruning = null
      })
    return this.pruning
  }

  private async pruneNow(): Promise<void> {
    const maxBytes = this.opts.maxBytes ?? MODEL_ICON_BYTES
    const maxFiles = this.opts.maxFiles ?? MODEL_ICON_FILES
    const names = await fs.readdir(this.dir).catch(() => [] as string[])
    const files: { abs: string; bytes: number; at: number }[] = []
    let total = 0
    for (const name of names) {
      const abs = path.join(this.dir, name)
      const st = await fs.stat(abs).catch(() => null)
      if (!st?.isFile()) continue
      // A temporary file left by a write that did not finish (the app quit): an hour is more than any write takes.
      if (name.endsWith('.tmp')) {
        if (this.now() - st.mtimeMs > 60 * 60 * 1000) await fs.unlink(abs).catch(() => undefined)
        continue
      }
      if (!/^[0-9a-f]{40}\.(png|none)$/.test(name)) continue
      files.push({ abs, bytes: st.size, at: st.mtimeMs })
      total += st.size
    }
    if (total <= maxBytes && files.length <= maxFiles) return
    files.sort((a, b) => a.at - b.at)
    let count = files.length
    for (const f of files) {
      if (total <= maxBytes * 0.8 && count <= maxFiles * 0.8) break
      await fs.unlink(f.abs).catch(() => undefined)
      total -= f.bytes
      count--
    }
  }

  /** Forget every kept picture (the files only: the folder stays). */
  async clear(): Promise<void> {
    const names = await fs.readdir(this.dir).catch(() => [] as string[])
    for (const name of names) if (/^[0-9a-f]{40}\.(png|none)(\..*\.tmp)?$/.test(name)) await fs.unlink(path.join(this.dir, name)).catch(() => undefined)
  }
}
