import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { VaultChangeDto } from '../src/shared/ipc.js'
import { FsVault } from '../src/main/fsvault.js'
import { VaultWatcher } from '../src/main/watcher.js'

let tmp: string
let root: string
let watcher: VaultWatcher | null = null
let changes: VaultChangeDto[] = []

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-watch-'))
  root = path.join(tmp, 'vault')
  changes = []
})
afterEach(async () => {
  vi.restoreAllMocks()
  watcher?.stop()
  watcher = null
  await fs.rm(tmp, { recursive: true, force: true })
})

async function put(rel: string, content = ''): Promise<void> {
  const full = path.join(tmp, ...rel.split('/'))
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}

/** Poll until `fn` returns something truthy (up to ~4 s). */
async function waitFor<T>(fn: () => T | null | undefined | false, what = 'condition'): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > 4000) throw new Error(`timed out waiting for ${what}; got ${JSON.stringify(changes)}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const find = (kind: VaultChangeDto['kind'], p: string) => changes.find((c) => c.kind === kind && c.path === p)
const waitChange = (kind: VaultChangeDto['kind'], p: string) => waitFor(() => find(kind, p), `${kind} ${p}`)
const count = (kind: VaultChangeDto['kind'], p: string) => changes.filter((c) => c.kind === kind && c.path === p).length

/** Scan, start watching, and wait until a probe write is seen (the native watcher is armed). */
async function open(roots: string[], probe = 'probe.md'): Promise<FsVault> {
  const vault = new FsVault(roots)
  const scan = await vault.scan()
  watcher = new VaultWatcher(
    vault,
    { files: scan.files.map((f) => f.path), folders: scan.folders },
    (batch) => changes.push(...batch),
    { debounceMs: 60 },
  )
  watcher.start()
  const probeAbs = vault.abs(probe)
  for (let i = 0; !changes.some((c) => c.path === probe); i++) {
    if (i > 40) throw new Error('watcher never became ready')
    await fs.writeFile(probeAbs, `probe ${i}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  changes = []
  return vault
}

describe('VaultWatcher', () => {
  beforeEach(async () => {
    await put('vault/known.md', 'old')
    await put('vault/Folder/inner.md', 'inner')
    await put('vault/Folder/Sub/leaf.md', 'leaf')
  })

  it('reports a new note with content and mtime', async () => {
    await open([root])
    await put('vault/new.md', 'hello')
    const c = await waitFor(() => changes.find((x) => x.path === 'new.md' && x.content === 'hello'), 'add new.md')
    expect(c.kind).toBe('add')
    expect(c.mtime).toBeGreaterThan(0)
  })

  it('reports a change to a known note', async () => {
    await open([root])
    await put('vault/known.md', 'new content')
    const c = await waitFor(() => changes.find((x) => x.path === 'known.md' && x.content === 'new content'), 'change')
    expect(c.kind).toBe('change')
    expect(count('add', 'known.md')).toBe(0)
  })

  it('reports an unlink for a deleted note', async () => {
    await open([root])
    await fs.rm(path.join(root, 'known.md'))
    await waitChange('unlink', 'known.md')
  })

  it('reports addDir for a new empty folder', async () => {
    await open([root])
    await fs.mkdir(path.join(root, 'Planet'))
    await waitChange('addDir', 'Planet')
  })

  it('reports a folder created with nested folders and notes', async () => {
    await open([root])
    await fs.mkdir(path.join(root, 'Sys', 'Moon', 'Deep'), { recursive: true })
    await fs.writeFile(path.join(root, 'Sys', 'Moon', 'Deep', 'n.md'), 'deep')
    await waitFor(() => changes.some((c) => c.path === 'Sys/Moon/Deep/n.md' && c.content === 'deep'), 'nested note')
    for (const d of ['Sys', 'Sys/Moon', 'Sys/Moon/Deep']) await waitChange('addDir', d)
    for (const d of ['Sys', 'Sys/Moon', 'Sys/Moon/Deep']) expect(count('addDir', d)).toBe(1)
  })

  it('scans a folder moved in from outside exactly once', async () => {
    await put('outside/System/Moon/n.md', 'moved in')
    await put('outside/System/top.md', 'top')
    await put('outside/System/node_modules/x.md', 'nope')
    await open([root])
    await fs.rename(path.join(tmp, 'outside', 'System'), path.join(root, 'System'))
    await waitChange('add', 'System/Moon/n.md')
    await waitChange('add', 'System/top.md')
    expect(find('add', 'System/Moon/n.md')?.content).toBe('moved in')
    for (const d of ['System', 'System/Moon']) expect(count('addDir', d)).toBe(1)
    // A later edit is a change, not a second add.
    await fs.writeFile(path.join(root, 'System', 'top.md'), 'edited')
    await waitFor(() => changes.find((c) => c.path === 'System/top.md' && c.content === 'edited'), 'edit')
    expect(count('add', 'System/top.md')).toBe(1)
    expect(find('change', 'System/top.md')?.content).toBe('edited')
    expect(changes.some((c) => c.path.includes('node_modules'))).toBe(false)
  })

  it('reports unlinkDir and unlink for everything under a removed folder', async () => {
    await open([root])
    await fs.rm(path.join(root, 'Folder'), { recursive: true })
    await waitChange('unlinkDir', 'Folder')
    await waitChange('unlinkDir', 'Folder/Sub')
    await waitChange('unlink', 'Folder/inner.md')
    await waitChange('unlink', 'Folder/Sub/leaf.md')
    expect(count('unlinkDir', 'Folder')).toBe(1)
    expect(count('unlink', 'Folder/inner.md')).toBe(1)
  })

  it('reports a folder renamed inside the vault as gone + new, with every note', async () => {
    await open([root])
    await fs.rename(path.join(root, 'Folder'), path.join(root, 'Renamed'))
    await waitChange('add', 'Renamed/Sub/leaf.md')
    await waitChange('add', 'Renamed/inner.md')
    await waitChange('unlinkDir', 'Folder')
    for (const p of ['Folder/inner.md', 'Folder/Sub/leaf.md']) await waitChange('unlink', p)
    await waitChange('unlinkDir', 'Folder/Sub')
    for (const d of ['Renamed', 'Renamed/Sub']) await waitChange('addDir', d)
    expect(find('add', 'Renamed/Sub/leaf.md')?.content).toBe('leaf')
    for (const d of ['Renamed', 'Renamed/Sub']) expect(count('addDir', d)).toBe(1)
    expect(count('add', 'Renamed/inner.md')).toBe(1)
  })

  it('reports a folder moved out of the vault as unlinkDir + unlink for its contents', async () => {
    await open([root])
    await fs.rename(path.join(root, 'Folder'), path.join(tmp, 'Away'))
    await waitChange('unlinkDir', 'Folder')
    await waitChange('unlinkDir', 'Folder/Sub')
    await waitChange('unlink', 'Folder/inner.md')
    await waitChange('unlink', 'Folder/Sub/leaf.md')
  })

  it('swallows our own folder deletion even when its children arrive in an earlier batch', async () => {
    await open([root])
    watcher!.noteSelfWrite('Folder', null)
    await fs.rm(path.join(root, 'Folder', 'Sub', 'leaf.md'))
    await put('vault/sentinel-1.md', 's')
    await waitChange('add', 'sentinel-1.md')
    await fs.rm(path.join(root, 'Folder'), { recursive: true })
    await put('vault/sentinel-2.md', 's')
    await waitChange('add', 'sentinel-2.md')
    await new Promise((r) => setTimeout(r, 150))
    expect(changes.filter((c) => c.path.startsWith('Folder'))).toEqual([])
  })

  it('swallows echoes of our own writes and deletions, but not different content', async () => {
    const vault = await open([root])
    watcher!.noteSelfWrite('self.md', 'mine')
    await vault.write('self.md', 'mine')
    watcher!.noteSelfWrite('known.md', null)
    await vault.remove('known.md')
    watcher!.noteSelfWrite('raced.md', 'what we wrote')
    await put('vault/raced.md', 'what someone else wrote')
    await put('vault/sentinel.md', 's')
    await waitChange('add', 'sentinel.md')
    await waitChange('add', 'raced.md')
    expect(changes.some((c) => c.path === 'self.md')).toBe(false)
    expect(changes.some((c) => c.path === 'known.md')).toBe(false)
    // The swallowed note is still tracked: an outside edit later is a change.
    await put('vault/self.md', 'edited outside')
    const c = await waitFor(() => changes.find((x) => x.path === 'self.md'), 'edit of self.md')
    expect(c.kind).toBe('change')
  })

  it('never reports (or touches) ignored paths', async () => {
    const vault = await open([root])
    const abs = vi.spyOn(vault, 'abs')
    await put('vault/.obsidian/workspace.md', 'x')
    await put('vault/node_modules/pkg/readme.md', 'x')
    await put('vault/Folder/AppData/x.md', 'x')
    await put('vault/draft.md.aether-tmp', 'x')
    await fs.mkdir(path.join(root, '.git', 'objects'), { recursive: true })
    await put('vault/picture.png', 'x')
    await put('vault/LICENSE.md', 'x')
    await put('vault/sentinel.md', 's')
    await waitChange('add', 'sentinel.md')
    expect(changes.map((c) => `${c.kind} ${c.path}`)).toEqual(['add sentinel.md'])
    const touched = abs.mock.calls.map(([p]) => p)
    for (const p of touched) expect(vault.isIgnored(p), p).toBe(false)
  })

  it('prefixes changes with the mount in a multi-root vault', async () => {
    const other = path.join(tmp, 'Other')
    await put('Other/a.md', 'a')
    await open([root, other], 'vault/probe.md')
    await put('Other/Planet/b.md', 'b')
    await waitChange('add', 'Other/Planet/b.md')
    await waitChange('addDir', 'Other/Planet')
    await fs.rm(path.join(other, 'a.md'))
    await waitChange('unlink', 'Other/a.md')
    await put('vault/known.md', 'changed')
    await waitChange('change', 'vault/known.md')
  })

  it('never reports after stop(), even from a retry that was in flight', async () => {
    await open([root])
    const readFile = fs.readFile
    let started = (): void => undefined
    let fail = (_err: Error): void => undefined
    const reached = new Promise<void>((r) => (started = r))
    vi.spyOn(fs, 'readFile').mockImplementation(((file: Parameters<typeof fs.readFile>[0], opts?: never) => {
      if (!String(file).endsWith('locked.md')) return readFile(file, opts)
      started()
      // Locked (e.g. by antivirus on Windows) until we say so.
      return new Promise((_resolve, reject) => (fail = reject))
    }) as typeof fs.readFile)
    await put('vault/locked.md', 'x')
    await reached
    watcher!.stop()
    fail(Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }))
    vi.restoreAllMocks()
    await new Promise((r) => setTimeout(r, 400))
    expect(changes).toEqual([])
  })

  it('starts watching a root that only appears after start()', async () => {
    const late = path.join(tmp, 'Late')
    const vault = new FsVault([root, late])
    const scan = await vault.scan()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    watcher = new VaultWatcher(
      vault,
      { files: scan.files.map((f) => f.path), folders: scan.folders },
      (batch) => changes.push(...batch),
      { debounceMs: 60 },
    )
    watcher.start()
    expect(warn).toHaveBeenCalled()
    await fs.mkdir(late)
    // Re-armed after a 1 s back-off: keep touching a note until it is seen.
    for (let i = 0; !find('change', 'Late/n.md') && !find('add', 'Late/n.md'); i++) {
      if (i > 40) throw new Error(`never watched the late root; got ${JSON.stringify(changes)}`)
      await fs.writeFile(path.join(late, 'n.md'), `n ${i}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  })

  it('stops reporting after stop()', async () => {
    await open([root])
    watcher!.stop()
    await put('vault/after-stop.md', 'x')
    await new Promise((r) => setTimeout(r, 300))
    expect(changes).toEqual([])
  })
})
