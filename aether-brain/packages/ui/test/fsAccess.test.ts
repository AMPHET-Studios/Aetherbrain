import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, isExistsError } from '@aether/core'
import { FsAccessVaultAdapter } from '../src/vault/fsAccess'

/* A case-insensitive folder, like NTFS or APFS behind Chromium's File System Access API (lookups go by OS path). */

interface FileEntry {
  kind: 'file'
  name: string
  content: string
  mtime: number
}
interface DirEntry {
  kind: 'directory'
  name: string
  dir: CIDir
}
type Entry = FileEntry | DirEntry

let clock = 1

class CIFile {
  readonly kind = 'file' as const
  constructor(
    private parent: CIDir,
    readonly name: string,
  ) {}
  private entry(): FileEntry {
    const e = this.parent.find(this.name)
    if (!e || e.kind !== 'file') throw new Error('NotFoundError')
    return e
  }
  async getFile() {
    const e = this.entry()
    return { lastModified: e.mtime, text: async () => e.content }
  }
  async createWritable() {
    let buf = ''
    return {
      write: async (d: string) => {
        buf += d
      },
      close: async () => {
        const e = this.entry()
        e.content = buf
        e.mtime = clock++
      },
    }
  }
  async isSameEntry(other: { kind: string }): Promise<boolean> {
    if (sameEntry === 'missing') throw new TypeError('isSameEntry is not a function')
    if (!(other instanceof CIFile) || other.parent !== this.parent) return false
    // Chromium compares the paths the handles were opened with, not the file they reach.
    return sameEntry === 'path' ? other.name === this.name : other.entry() === this.entry()
  }
}

/**
 * How the stub's `isSameEntry` answers: by the file reached ('entry'), by the
 * spelling the handle was opened with ('path', like Chromium), or not at all
 * ('missing', an older browser).
 */
let sameEntry: 'entry' | 'path' | 'missing' = 'entry'

class CIDir {
  readonly kind = 'directory' as const
  readonly entries = new Map<string, Entry>()
  constructor(readonly name: string) {}
  find(name: string): Entry | undefined {
    for (const [k, v] of this.entries) if (k.toLowerCase() === name.toLowerCase()) return v
    return undefined
  }
  async *values() {
    for (const e of this.entries.values()) yield e.kind === 'directory' ? e.dir : new CIFile(this, e.name)
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<CIDir> {
    const e = this.find(name)
    if (e?.kind === 'directory') return e.dir
    if (e || !opts?.create) throw new Error(e ? 'TypeMismatchError' : 'NotFoundError')
    const dir = new CIDir(name)
    this.entries.set(name, { kind: 'directory', name, dir })
    return dir
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<CIFile> {
    const e = this.find(name)
    // The handle keeps the spelling it was asked for (the OS finds the file under any case).
    if (e?.kind === 'file') return new CIFile(this, name)
    if (e || !opts?.create) throw new Error(e ? 'TypeMismatchError' : 'NotFoundError')
    this.entries.set(name, { kind: 'file', name, content: '', mtime: clock++ })
    return new CIFile(this, name)
  }
  async removeEntry(name: string): Promise<void> {
    const e = this.find(name)
    if (!e) throw new Error('NotFoundError')
    this.entries.delete(e.name)
  }
  async isSameEntry(other: { kind: string }): Promise<boolean> {
    return other === this
  }
}

async function vaultWith(files: Record<string, string>) {
  const root = new CIDir('vault')
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/')
    const name = parts.pop()!
    let dir = root
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true })
    dir.entries.set(name, { kind: 'file', name, content, mtime: clock++ })
  }
  return { root, adapter: new FsAccessVaultAdapter(root as never) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  sameEntry = 'entry'
})

describe('FsAccessVaultAdapter on a case-insensitive disk', () => {
  const NOTE = '---\ntitle: portal game\n---\n# portal game\n\n- [ ] x\n'

  it('renames a note to another letter case without deleting it', async () => {
    const { root, adapter } = await vaultWith({ 'Projects/portal game.md': NOTE })
    await adapter.rename('Projects/portal game.md', 'Projects/Portal Game.md')
    const projects = await root.getDirectoryHandle('Projects')
    expect([...projects.entries.keys()]).toEqual(['Portal Game.md'])
    expect(await adapter.read('Projects/Portal Game.md')).toBe(NOTE)
  })

  for (const mode of ['path', 'missing'] as const) {
    it(`renames to another letter case when isSameEntry ${mode === 'path' ? 'compares spellings (Chromium)' : 'is missing'}`, async () => {
      sameEntry = mode
      const { root, adapter } = await vaultWith({ 'Projects/portal game.md': NOTE, 'Projects/other.md': '# other\n' })
      await adapter.rename('Projects/portal game.md', 'Projects/Portal Game.md')
      const projects = await root.getDirectoryHandle('Projects')
      expect([...projects.entries.keys()].sort()).toEqual(['Portal Game.md', 'other.md'])
      expect(await adapter.read('Projects/Portal Game.md')).toBe(NOTE)
      // Onto another file it still refuses, and both stay.
      const err = await adapter.rename('Projects/other.md', 'Projects/portal game.md').catch((e: unknown) => e)
      expect(isExistsError(err)).toBe(true)
      expect(await adapter.read('Projects/other.md')).toBe('# other\n')
      expect(await adapter.read('Projects/Portal Game.md')).toBe(NOTE)
    })
  }

  it('refuses to rename onto another file, and moves a note to a free name', async () => {
    const { root, adapter } = await vaultWith({ 'Inbox/a.md': '# a\n', 'Inbox/b.md': '# b\n' })
    const err = await adapter.rename('Inbox/a.md', 'Inbox/B.md').catch((e: unknown) => e)
    expect(isExistsError(err)).toBe(true)
    expect(await adapter.read('Inbox/a.md')).toBe('# a\n')
    expect(await adapter.read('Inbox/b.md')).toBe('# b\n')
    await adapter.rename('Inbox/a.md', 'Archive/a.md')
    expect(await adapter.read('Archive/a.md')).toBe('# a\n')
    expect((await root.getDirectoryHandle('Inbox')).find('a.md')).toBeUndefined()
  })

  it('creates only where nothing is (any letter case, a folder too)', async () => {
    const { adapter } = await vaultWith({ 'Inbox/Buy milk.md': '# Buy milk\n', 'Code/CHANGELOG.md': '# history\n' })
    for (const taken of ['Inbox/buy milk.md', 'Code/Changelog.md', 'Inbox']) {
      const err = await adapter.create(taken, 'new').catch((e: unknown) => e)
      expect(isExistsError(err)).toBe(true)
    }
    expect(await adapter.read('Inbox/Buy milk.md')).toBe('# Buy milk\n')
    expect(await adapter.read('Code/CHANGELOG.md')).toBe('# history\n')
    await adapter.create('Inbox/Buy milk 2.md', '# Buy milk\n\nsecond\n')
    expect(await adapter.read('Inbox/Buy milk 2.md')).toBe('# Buy milk\n\nsecond\n')
  })

  it('lets the store rename a project to a new letter case (the note survives)', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
    vi.resetModules()
    const { useAether } = await import('../src/store')
    const s = () => useAether.getState()
    const { root, adapter } = await vaultWith({ 'Projects/portal game.md': NOTE })
    await s().openVault(adapter)
    const id = await s().updateProject('Projects/portal game', { title: 'Portal Game', renameFile: true })
    expect(id).toBe('Projects/Portal Game')
    const projects = await root.getDirectoryHandle('Projects')
    expect([...projects.entries.keys()]).toEqual(['Portal Game.md'])
    expect(await adapter.read('Projects/Portal Game.md')).toContain('title: Portal Game')
    // Stop the adapter's poll.
    await s().openVault(new MemoryVaultAdapter())
  })
})
