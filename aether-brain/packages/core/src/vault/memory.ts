import type { VaultAdapter, VaultChange, VaultFile } from '../types'
import { isIgnoredPath, isMarkdownPath, normalizePath } from './paths'

export interface MemoryVaultOptions {
  name?: string
  location?: string
  readOnly?: boolean
  /** Optional persistence hook: called after every mutation with the full file map. */
  onPersist?: (files: Map<string, VaultFile>) => void
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
  private listeners = new Set<(changes: VaultChange[]) => void>()
  private onPersist: ((files: Map<string, VaultFile>) => void) | undefined

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
    this.onPersist?.(this.files)
    this.emit([{ kind: existed ? 'change' : 'add', path: p, content, mtime: file.mtime }])
  }

  async remove(path: string): Promise<void> {
    if (this.readOnly) throw new Error('Vault is read-only')
    const p = normalizePath(path)
    if (!this.files.delete(p)) return
    this.onPersist?.(this.files)
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
    const file: VaultFile = { path: b, content: f.content, mtime: Date.now() }
    this.files.set(b, file)
    this.onPersist?.(this.files)
    this.emit([
      { kind: 'unlink', path: a },
      { kind: 'add', path: b, content: file.content, mtime: file.mtime },
    ])
  }

  watch(cb: (changes: VaultChange[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Simulate an external change (tests / demo "someone edited on disk"). */
  external(changes: VaultChange[]): void {
    for (const c of changes) {
      const p = normalizePath(c.path)
      if (c.kind === 'unlink') this.files.delete(p)
      else this.files.set(p, { path: p, content: c.content ?? '', mtime: c.mtime ?? Date.now() })
    }
    this.emit(changes)
  }

  snapshot(): Map<string, VaultFile> {
    return new Map(this.files)
  }

  private emit(changes: VaultChange[]): void {
    for (const l of this.listeners) l(changes)
  }
}
