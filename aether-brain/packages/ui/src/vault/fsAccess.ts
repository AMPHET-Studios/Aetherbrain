import { ancestorsOf, isIgnoredPath, isMarkdownPath, normalizeFolderPath, normalizePath, type VaultAdapter, type VaultChange, type VaultFile } from '@aether/core'

/* Minimal File System Access API typings (Chromium). */
interface FSHandle {
  kind: 'file' | 'directory'
  name: string
}
interface FSFileHandle extends FSHandle {
  kind: 'file'
  getFile(): Promise<File>
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>
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

  private async walk(dir: FSDirHandle, prefix: string, out: { path: string; handle: FSFileHandle }[], folders: Set<string>): Promise<void> {
    for await (const entry of dir.values()) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isIgnoredPath(path)) continue
      if (entry.kind === 'directory') {
        folders.add(path)
        await this.walk(entry, path, out, folders)
      } else if (isMarkdownPath(path)) out.push({ path, handle: entry })
    }
  }

  async list(): Promise<VaultFile[]> {
    const entries: { path: string; handle: FSFileHandle }[] = []
    const folders = new Set<string>()
    await this.walk(this.root, '', entries, folders)
    this.folders = folders
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
    this.selfWrites.set(normalizePath(path), Date.now())
  }

  async rename(from: string, to: string): Promise<void> {
    const content = await this.read(from)
    if (content === null) throw new Error(`No such file: ${from}`)
    await this.write(to, content)
    await this.remove(from)
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
      await this.walk(this.root, '', entries, folders)
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
      if (changes.length) for (const l of this.listeners) l(changes)
    } catch (err) {
      console.warn('[aether] poll failed', err)
    } finally {
      this.polling = false
    }
  }
}
