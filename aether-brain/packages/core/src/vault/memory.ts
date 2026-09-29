import type { VaultAdapter, VaultChange, VaultFile } from '../types'
import { folderOf, isIgnoredPath, isMarkdownPath, normalizeFolderPath, normalizePath } from './paths'

export interface MemoryVaultOptions {
  name?: string
  location?: string
  readOnly?: boolean
  /** Folders that exist without notes in them (e.g. restored from persistence). */
  folders?: string[]
  /**
   * Optional persistence hook: called after every mutation with the full file
   * map and the explicit folder set (folders created or given, not the ones
   * implied by file paths).
   */
  onPersist?: (files: Map<string, VaultFile>, folders: Set<string>) => void
}

/**
 * In-memory vault. Used for the bundled demo (with an IndexedDB overlay in the
 * web app), for tests, and as the base for synthetic stress vaults.
 */
export class MemoryVaultAdapter implements VaultAdapter {
  readonly kind = 'memory' as const
  readonly name: string
  readonly location: string
  readonly readOnly: boolean
  private files = new Map<string, VaultFile>()
  /** Folders that exist on their own; folders holding files are implied by the file paths. */
  private folders = new Set<string>()
  private listeners = new Set<(changes: VaultChange[]) => void>()
  private onPersist: ((files: Map<string, VaultFile>, folders: Set<string>) => void) | undefined

  constructor(files: VaultFile[] = [], opts: MemoryVaultOptions = {}) {
    this.name = opts.name ?? 'Memory vault'
    this.location = opts.location ?? 'memory://'
    this.readOnly = opts.readOnly ?? false
    this.onPersist = opts.onPersist
    for (const f of files) {
      const path = normalizePath(f.path)
      if (!isMarkdownPath(path) || isIgnoredPath(path)) continue
      this.files.set(path, { ...f, path })
    }
    for (const f of opts.folders ?? []) {
      const path = normalizeFolderPath(f)
      if (path && !isIgnoredPath(path)) this.folders.add(path)
    }
  }

  async list(): Promise<VaultFile[]> {
    return [...this.files.values()].map((f) => ({ ...f }))
  }

  async read(path: string): Promise<string | null> {
    return this.files.get(normalizePath(path))?.content ?? null
  }

  async write(path: string, content: string): Promise<void> {
    if (this.readOnly) throw new Error('Vault is read-only')
    const p = normalizePath(path)
    const existed = this.files.has(p)
    const file: VaultFile = { path: p, content, mtime: Date.now() }
    this.files.set(p, file)
    this.persist()
    this.emit([{ kind: existed ? 'change' : 'add', path: p, content, mtime: file.mtime }])
  }

  async remove(path: string): Promise<void> {
    if (this.readOnly) throw new Error('Vault is read-only')
    const p = normalizePath(path)
    if (!this.files.delete(p)) return
    this.keepFolderOf(p)
    this.persist()
    this.emit([{ kind: 'unlink', path: p }])
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.readOnly) throw new Error('Vault is read-only')
    const a = normalizePath(from)
    const b = normalizePath(to)
    const f = this.files.get(a)
    if (!f) throw new Error(`No such file: ${a}`)
    if (this.files.has(b)) throw new Error(`Target exists: ${b}`)
    this.files.delete(a)
    this.keepFolderOf(a)
    const file: VaultFile = { path: b, content: f.content, mtime: Date.now() }
    this.files.set(b, file)
    this.persist()
    this.emit([
      { kind: 'unlink', path: a },
      { kind: 'add', path: b, content: file.content, mtime: file.mtime },
    ])
  }

  /** Every folder: the explicit ones plus every folder a file sits in, with ancestors; sorted, root excluded. */
  async listFolders(): Promise<string[]> {
    const out = new Set<string>()
    const add = (path: string): void => {
      for (let cur = path; cur !== '' && !out.has(cur); cur = folderOf(cur)) out.add(cur)
    }
    for (const f of this.folders) add(f)
    for (const p of this.files.keys()) add(folderOf(p))
    return [...out].sort()
  }

  /** Create a folder (parents are implied). Emits an 'addDir' change when it is new. */
  async createFolder(path: string): Promise<void> {
    if (this.readOnly) throw new Error('Vault is read-only')
    const p = normalizeFolderPath(path)
    if (!p) throw new Error('Invalid folder path')
    if (isIgnoredPath(p)) throw new Error(`Folder is ignored: ${p}`)
    const existed = (await this.listFolders()).includes(p)
    this.folders.add(p)
    this.persist()
    if (!existed) this.emit([{ kind: 'addDir', path: p }])
  }

  watch(cb: (changes: VaultChange[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Simulate an external change (tests / demo "someone edited on disk"). */
  external(changes: VaultChange[]): void {
    for (const c of changes) {
      const p = normalizePath(c.path)
      if (c.kind === 'unlink') {
        if (this.files.delete(p)) this.keepFolderOf(p)
      } else if (c.kind === 'addDir') {
        const dir = normalizeFolderPath(p)
        if (dir && !isIgnoredPath(dir)) this.folders.add(dir)
      } else if (c.kind === 'unlinkDir') {
        // The whole tree is gone on disk: its folders and its files; its parent stays.
        const dir = normalizeFolderPath(p)
        if (!dir) continue
        for (const f of [...this.folders]) if (f === dir || f.startsWith(`${dir}/`)) this.folders.delete(f)
        for (const f of [...this.files.keys()]) if (f.startsWith(`${dir}/`)) this.files.delete(f)
        this.keepFolderOf(dir)
      } else this.files.set(p, { path: p, content: c.content ?? '', mtime: c.mtime ?? Date.now() })
    }
    this.emit(changes)
  }

  snapshot(): Map<string, VaultFile> {
    return new Map(this.files)
  }

  /** A folder outlives its last note, as on a real disk (only unlinkDir removes it). */
  private keepFolderOf(path: string): void {
    const dir = folderOf(path)
    if (dir) this.folders.add(dir)
  }

  private persist(): void {
    this.onPersist?.(this.files, this.folders)
  }

  private emit(changes: VaultChange[]): void {
    for (const l of this.listeners) l(changes)
  }
}
