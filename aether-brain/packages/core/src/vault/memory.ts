import type { VaultAdapter, VaultAsset, VaultChange, VaultFile } from '../types'
import { isImagePath } from './assets'
import { folderOf, isIgnoredPath, isMarkdownPath, normalizeFolderPath, normalizePath } from './paths'

/** An image held by a MemoryVaultAdapter: its bytes (possibly empty in tests) and when it was written. */
export interface MemoryAsset {
  path: string
  data: Uint8Array
  mtime: number
}

export interface MemoryVaultOptions {
  name?: string
  location?: string
  readOnly?: boolean
  /** Folders that exist without notes in them (e.g. restored from persistence). */
  folders?: string[]
  /** Image files (their bytes; `mtime` defaults to now). */
  assets?: { path: string; data: Uint8Array; mtime?: number }[]
  /**
   * Optional persistence hook: called after every mutation with the full file
   * map, the explicit folder set (folders created or given, not the ones
   * implied by file paths) and the images.
   */
  onPersist?: (files: Map<string, VaultFile>, folders: Set<string>, assets: Map<string, MemoryAsset>) => void
}

/**
 * True for the error a create-only write fails with when something already
 * exists at the path: Node's `EEXIST` (`err.code`), or any error whose message
 * carries it (errors that crossed Electron IPC keep only their message).
 */
export function isExistsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return typeof err === 'string' && err.includes('EEXIST')
  const e = err as { code?: unknown; message?: unknown }
  return e.code === 'EEXIST' || (typeof e.message === 'string' && e.message.includes('EEXIST'))
}

/** The error `create` fails with when the path is taken (see `isExistsError`). */
function existsError(path: string): Error {
  return Object.assign(new Error(`EEXIST: file already exists, create '${path}'`), { code: 'EEXIST' })
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
  private assets = new Map<string, MemoryAsset>()
  private listeners = new Set<(changes: VaultChange[]) => void>()
  private onPersist: ((files: Map<string, VaultFile>, folders: Set<string>, assets: Map<string, MemoryAsset>) => void) | undefined

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
    for (const a of opts.assets ?? []) {
      const path = normalizePath(a.path)
      if (!isImagePath(path) || isIgnoredPath(path)) continue
      this.assets.set(path, { path, data: a.data, mtime: a.mtime ?? Date.now() })
    }
  }

  /** Every image (path, mtime, size). */
  async listAssets(): Promise<VaultAsset[]> {
    return [...this.assets.values()].map((a) => ({ path: a.path, mtime: a.mtime, size: a.data.byteLength }))
  }

  /** The image's own bytes as a Blob (no resizing here), or null when there is no such image. */
  async thumbnail(path: string, _size: number): Promise<Blob | null> {
    const a = this.assets.get(normalizePath(path))
    if (!a || typeof Blob === 'undefined') return null
    return new Blob([a.data.slice()], { type: mimeOf(a.path) })
  }

  /** Bytes of an image (tests / persistence), or null. */
  assetData(path: string): Uint8Array | null {
    return this.assets.get(normalizePath(path))?.data ?? null
  }

  /**
   * Create a new image; fails with an `EEXIST` error when anything exists at
   * the path (a note, an image, a folder, in any letter case). Image paths
   * only. Emits 'add' (no content, with mtime and size).
   */
  async createAsset(path: string, data: Uint8Array): Promise<void> {
    if (this.readOnly) throw new Error('Vault is read-only')
    const p = normalizePath(path)
    if (!isImagePath(p)) throw new Error(`Not an image path: ${p}`)
    if (isIgnoredPath(p)) throw new Error(`Path is ignored: ${p}`)
    this.assertFree(p)
    const asset: MemoryAsset = { path: p, data: data.slice(), mtime: Date.now() }
    this.assets.set(p, asset)
    this.persist()
    this.emit([{ kind: 'add', path: p, mtime: asset.mtime, size: asset.data.byteLength }])
  }

  /** Throws EEXIST when a note, image or folder sits at `p` (case-insensitive). */
  private assertFree(p: string): void {
    const lower = p.toLowerCase()
    for (const f of this.files.keys()) if (f.toLowerCase() === lower) throw existsError(p)
    for (const f of this.assets.keys()) if (f.toLowerCase() === lower) throw existsError(p)
    for (const f of this.folderList()) if (f.toLowerCase() === lower) throw existsError(p)
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

  /**
   * Create a new file; fails with an `EEXIST` error when anything already
   * exists at the path: a file (in any letter case, like a case-insensitive
   * disk) or a folder. Emits 'add' like `write`.
   */
  async create(path: string, content: string): Promise<void> {
    if (this.readOnly) throw new Error('Vault is read-only')
    const p = normalizePath(path)
    // Checked and written without an await in between, so two creates can't both win.
    this.assertFree(p)
    return this.write(p, content)
  }

  async remove(path: string): Promise<void> {
    if (this.readOnly) throw new Error('Vault is read-only')
    const p = normalizePath(path)
    if (this.assets.delete(p)) {
      this.keepFolderOf(p)
      this.persist()
      this.emit([{ kind: 'unlink', path: p }])
      return
    }
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
    return this.folderList()
  }

  private folderList(): string[] {
    const out = new Set<string>()
    const add = (path: string): void => {
      for (let cur = path; cur !== '' && !out.has(cur); cur = folderOf(cur)) out.add(cur)
    }
    for (const f of this.folders) add(f)
    for (const p of this.files.keys()) add(folderOf(p))
    for (const p of this.assets.keys()) add(folderOf(p))
    return [...out].sort()
  }

  /** Create a folder (parents are implied). Emits an 'addDir' change when it is new. */
  async createFolder(path: string): Promise<void> {
    if (this.readOnly) throw new Error('Vault is read-only')
    const p = normalizeFolderPath(path)
    if (!p) throw new Error('Invalid folder path')
    if (isIgnoredPath(p)) throw new Error(`Folder is ignored: ${p}`)
    const existed = this.folderList().includes(p)
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
      if (isImagePath(p) && (c.kind === 'add' || c.kind === 'change' || c.kind === 'unlink')) {
        if (c.kind === 'unlink') {
          if (this.assets.delete(p)) this.keepFolderOf(p)
        } else {
          this.assets.set(p, { path: p, data: this.assets.get(p)?.data ?? new Uint8Array(), mtime: c.mtime ?? Date.now() })
        }
        continue
      }
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
        for (const f of [...this.assets.keys()]) if (f.startsWith(`${dir}/`)) this.assets.delete(f)
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
    this.onPersist?.(this.files, this.folders, this.assets)
  }

  private emit(changes: VaultChange[]): void {
    for (const l of this.listeners) l(changes)
  }
}

/** MIME type of an image path (by extension). */
export function mimeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png' || ext === 'webp' || ext === 'gif' || ext === 'bmp' || ext === 'avif') return `image/${ext}`
  return 'application/octet-stream'
}
