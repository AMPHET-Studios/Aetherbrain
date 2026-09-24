import { isIgnoredPath, isMarkdownPath, normalizePath, type VaultAdapter, type VaultChange, type VaultFile } from '@aether/core'

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

  private async walk(dir: FSDirHandle, prefix: string, out: { path: string; handle: FSFileHandle }[]): Promise<void> {
    for await (const entry of dir.values()) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isIgnoredPath(path)) continue
      if (entry.kind === 'directory') await this.walk(entry, path, out)
      else if (isMarkdownPath(path)) out.push({ path, handle: entry })
    }
  }

  async list(): Promise<VaultFile[]> {
    const entries: { path: string; handle: FSFileHandle }[] = []
    await this.walk(this.root, '', entries)
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
      await this.walk(this.root, '', entries)
      const seen = new Set<string>()
      const changes: VaultChange[] = []
      const now = Date.now()
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
