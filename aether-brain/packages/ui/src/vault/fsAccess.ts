import {
  ancestorsOf,
  folderOf,
  isIgnoredPath,
  isImagePath,
  isMarkdownPath,
  isMediaPath,
  isVideoPath,
  mimeOf,
  normalizeFolderPath,
  normalizePath,
  type VaultAdapter,
  type VaultAsset,
  type VaultChange,
  type VaultFile,
} from '@aether/core'
import { resizeImage } from '../util'

/* Minimal File System Access API typings (Chromium). */
interface FSHandle {
  kind: 'file' | 'directory'
  name: string
  /** True when both handles are the same entry on disk (one file under two spellings on Windows / macOS). */
  isSameEntry?(other: FSHandle): Promise<boolean>
}
interface FSFileHandle extends FSHandle {
  kind: 'file'
  getFile(): Promise<File>
  createWritable(): Promise<{ write(data: string | Uint8Array): Promise<void>; close(): Promise<void> }>
}
interface FSDirHandle extends FSHandle {
  kind: 'directory'
  values(): AsyncIterable<FSFileHandle | FSDirHandle>
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FSDirHandle>
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FSFileHandle>
  removeEntry(name: string): Promise<void>
  queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>
  requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>
}
declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FSDirHandle>
  }
}

export const supportsFsAccess = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'

const POLL_MS = 2500

/** The error `create` and `rename` fail with when the path is taken (`isExistsError` recognizes it). */
function existsError(path: string): Error {
  return Object.assign(new Error(`EEXIST: file already exists, ${path}`), { code: 'EEXIST' })
}

/** True when two handles are one entry on disk; false when the browser can't tell. */
async function sameEntry(a: FSHandle, b: FSHandle): Promise<boolean> {
  try {
    return (await a.isSameEntry?.(b)) ?? false
  } catch {
    return false
  }
}

/**
 * A real folder on disk, in the browser, via the File System Access API.
 * No watcher API exists, so we poll mtimes every few seconds.
 */
export class FsAccessVaultAdapter implements VaultAdapter {
  readonly kind = 'fs-access' as const
  readonly name: string
  readonly location: string
  readonly readOnly = false
  private mtimes = new Map<string, number>()
  private listeners = new Set<(c: VaultChange[]) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  /** Paths we wrote ourselves recently; skip their echo in the poll. */
  private selfWrites = new Map<string, number>()
  /** Every folder seen by the last walk (vault paths, root excluded). */
  private folders = new Set<string>()
  /** Every picture seen by the last walk (or written since): listed without reading a byte of them. */
  private images = new Set<string>()
  private walked = false

  constructor(private root: FSDirHandle) {
    this.name = root.name
    this.location = `folder: ${root.name}`
  }

  static async pick(): Promise<FsAccessVaultAdapter | null> {
    if (!window.showDirectoryPicker) return null
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'aether-vault' })
      return new FsAccessVaultAdapter(handle)
    } catch {
      return null
    }
  }

  private async walk(
    dir: FSDirHandle,
    prefix: string,
    out: { path: string; handle: FSFileHandle }[],
    folders: Set<string>,
    images: Set<string>,
  ): Promise<void> {
    for await (const entry of dir.values()) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isIgnoredPath(path)) continue
      if (entry.kind === 'directory') {
        folders.add(path)
        await this.walk(entry, path, out, folders, images)
      } else if (isMarkdownPath(path)) out.push({ path, handle: entry })
      else if (isMediaPath(path)) images.add(path)
    }
  }

  async list(): Promise<VaultFile[]> {
    const entries: { path: string; handle: FSFileHandle }[] = []
    const folders = new Set<string>()
    const images = new Set<string>()
    await this.walk(this.root, '', entries, folders, images)
    this.folders = folders
    this.images = images
    this.walked = true
    const files = await Promise.all(
      entries.map(async ({ path, handle }) => {
        const f = await handle.getFile()
        this.mtimes.set(path, f.lastModified)
        return { path, content: await f.text(), mtime: f.lastModified }
      }),
    )
    return files
  }

  private async resolve(path: string, create = false): Promise<{ dir: FSDirHandle; name: string }> {
    const parts = normalizePath(path).split('/')
    const name = parts.pop() ?? ''
    let dir = this.root
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create })
    return { dir, name }
  }

  /** Every folder from the last walk (the one `list()` just did, else a fresh one). */
  async listFolders(): Promise<string[]> {
    if (!this.walked) await this.list()
    return [...this.folders].sort()
  }

  /** Every picture from the last walk; no file is opened for it (mtime and size stay unknown). */
  async listAssets(): Promise<VaultAsset[]> {
    if (!this.walked) await this.list()
    return [...this.images].map((path) => ({ path }))
  }

  /**
   * A preview of a picture, at most `size` px on its longer side (see
   * `resizeImage`), or null. A video comes as itself (read lazily from disk):
   * the store takes one still frame of it (`stillOf`).
   */
  async thumbnail(path: string, size: number): Promise<Blob | null> {
    const p = normalizePath(path)
    if (!isMediaPath(p)) return null
    try {
      const { dir, name } = await this.resolve(p)
      const file = await (await dir.getFileHandle(name)).getFile()
      if (isVideoPath(p)) return file.size > 0 ? new Blob([file], { type: mimeOf(p) }) : null
      return await resizeImage(file, size)
    } catch {
      return null
    }
  }

  /**
   * Write a NEW picture from its bytes; fails with an `EEXIST` error when
   * anything is at the path (on Windows and macOS also another letter case),
   * like `create`. Picture paths only. Reports an 'add'.
   */
  async createAsset(path: string, data: Uint8Array): Promise<void> {
    const p = normalizePath(path)
    if (!isImagePath(p)) throw new Error(`Not a picture: ${p}`)
    if (isIgnoredPath(p)) throw new Error(`Path is ignored: ${p}`)
    if (await this.entry(p)) throw existsError(p)
    const { dir, name } = await this.resolve(p, true)
    const fh = await dir.getFileHandle(name, { create: true })
    try {
      const w = await fh.createWritable()
      await w.write(data)
      await w.close()
    } catch (err) {
      // The file this call just made: an empty picture must not stay behind.
      await dir.removeEntry(name).catch(() => undefined)
      throw err
    }
    const f = await fh.getFile()
    this.images.add(p)
    this.selfWrites.set(p, Date.now())
    const added: VaultChange[] = [{ kind: 'add', path: p, mtime: f.lastModified, size: f.size }]
    for (const l of this.listeners) l(added)
  }

  /** Create a folder and any missing parents; emits 'addDir' for each one that is new. */
  async createFolder(path: string): Promise<void> {
    const p = normalizeFolderPath(path)
    if (!p) throw new Error('Invalid folder path')
    if (isIgnoredPath(p)) throw new Error(`Folder is ignored: ${p}`)
    let dir = this.root
    for (const seg of p.split('/')) dir = await dir.getDirectoryHandle(seg, { create: true })
    const added: VaultChange[] = []
    for (const f of [...ancestorsOf(p), p]) {
      if (this.folders.has(f)) continue
      this.folders.add(f)
      this.selfWrites.set(f, Date.now())
      added.push({ kind: 'addDir', path: f })
    }
    if (added.length) for (const l of this.listeners) l(added)
  }

  async read(path: string): Promise<string | null> {
    try {
      const { dir, name } = await this.resolve(path)
      const fh = await dir.getFileHandle(name)
      return await (await fh.getFile()).text()
    } catch {
      return null
    }
  }

  /** The file or folder at `path`, or null (the OS decides whether the name's letter case matters). */
  private async entry(path: string): Promise<FSHandle | null> {
    let at: { dir: FSDirHandle; name: string }
    try {
      at = await this.resolve(path)
    } catch {
      return null
    }
    try {
      return await at.dir.getFileHandle(at.name)
    } catch {
      /* not a file */
    }
    try {
      return await at.dir.getDirectoryHandle(at.name)
    } catch {
      return null
    }
  }

  /**
   * Create a new file; fails with an `EEXIST` error when anything is at the
   * path already (on Windows and macOS also a name that differs only in
   * letter case). The API has no exclusive create, so this checks first.
   */
  async create(path: string, content: string): Promise<void> {
    const p = normalizePath(path)
    if (await this.entry(p)) throw existsError(p)
    await this.write(p, content)
  }

  async write(path: string, content: string): Promise<void> {
    const { dir, name } = await this.resolve(path, true)
    const fh = await dir.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    await w.write(content)
    await w.close()
    const f = await fh.getFile()
    this.mtimes.set(normalizePath(path), f.lastModified)
    this.selfWrites.set(normalizePath(path), Date.now())
  }

  async remove(path: string): Promise<void> {
    const { dir, name } = await this.resolve(path)
    await dir.removeEntry(name)
    this.mtimes.delete(normalizePath(path))
    this.images.delete(normalizePath(path))
    this.selfWrites.set(normalizePath(path), Date.now())
  }

  /**
   * True when `to`, found on disk, is only `from` under another letter case
   * on a disk that ignores case: the paths match case-insensitively and the
   * folder lists no entry spelled exactly like `to`. Needed because
   * `isSameEntry` may compare the spellings the handles were opened with
   * (Chromium does) rather than the file they reach, or be missing.
   */
  private async caseVariantOf(from: string, to: string): Promise<boolean> {
    if (from.toLowerCase() !== to.toLowerCase()) return false
    try {
      const { dir, name } = await this.resolve(to)
      for await (const e of dir.values()) if (e.name === name) return false
      return true
    } catch {
      return false
    }
  }

  /**
   * Move a file (the API has no rename: read, write the new one, remove the
   * old). Refuses when another file is at `to`. When `to` is the same file
   * under another spelling (`portal game.md` → `Portal Game.md` on Windows or
   * macOS), writing `to` would write `from` and removing `from` would delete
   * the note, so it steps through a temporary name.
   */
  async rename(from: string, to: string): Promise<void> {
    const f = normalizePath(from)
    const t = normalizePath(to)
    if (f === t) return
    const content = await this.read(f)
    const src = await this.entry(f)
    if (content === null || !src) throw new Error(`No such file: ${from}`)
    const dst = await this.entry(t)
    if (!dst) {
      await this.write(t, content)
      await this.remove(f)
      return
    }
    if (!(await sameEntry(src, dst)) && !(await this.caseVariantOf(f, t))) throw existsError(t)
    // A dot name: the poll never reports it, and the vault ignores it if it is left behind.
    const dir = folderOf(t)
    const tmp = `${dir ? `${dir}/` : ''}.aether-rename-${Date.now().toString(36)}.md`
    await this.write(tmp, content)
    await this.remove(f)
    await this.write(t, content)
    await this.remove(tmp)
  }

  watch(cb: (changes: VaultChange[]) => void): () => void {
    this.listeners.add(cb)
    if (!this.timer) this.timer = setInterval(() => void this.poll(), POLL_MS)
    return () => {
      this.listeners.delete(cb)
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    }
  }

  private polling = false
  private async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const entries: { path: string; handle: FSFileHandle }[] = []
      const folders = new Set<string>()
      const images = new Set<string>()
      await this.walk(this.root, '', entries, folders, images)
      const seen = new Set<string>()
      const changes: VaultChange[] = []
      const now = Date.now()
      // Folders made or removed outside the app (the files inside them follow below).
      for (const f of [...folders].sort()) if (!this.folders.has(f)) changes.push({ kind: 'addDir', path: f })
      for (const f of this.folders) {
        if (folders.has(f)) continue
        // Created by us while this walk was already under way: still there.
        const self = this.selfWrites.get(f)
        if (self && now - self < POLL_MS * 2) folders.add(f)
        else changes.push({ kind: 'unlinkDir', path: f })
      }
      this.folders = folders
      for (const { path, handle } of entries) {
        seen.add(path)
        const f = await handle.getFile()
        const prev = this.mtimes.get(path)
        if (prev === f.lastModified) continue
        this.mtimes.set(path, f.lastModified)
        const self = this.selfWrites.get(path)
        if (self && now - self < POLL_MS * 2) continue
        changes.push({ kind: prev === undefined ? 'add' : 'change', path, content: await f.text(), mtime: f.lastModified })
      }
      for (const path of [...this.mtimes.keys()]) {
        if (seen.has(path)) continue
        this.mtimes.delete(path)
        const self = this.selfWrites.get(path)
        if (self && now - self < POLL_MS * 2) continue
        changes.push({ kind: 'unlink', path })
      }
      // Pictures come and go by name only: opening every one on every poll would crawl on a big drive.
      for (const path of images) if (!this.images.has(path)) changes.push({ kind: 'add', path })
      for (const path of this.images) {
        if (images.has(path)) continue
        // Written by us while this walk was already under way: still there.
        const self = this.selfWrites.get(path)
        if (self && now - self < POLL_MS * 2) images.add(path)
        else changes.push({ kind: 'unlink', path })
      }
      this.images = images
      if (changes.length) for (const l of this.listeners) l(changes)
    } catch (err) {
      console.warn('[aether] poll failed', err)
    } finally {
      this.polling = false
    }
  }
}
