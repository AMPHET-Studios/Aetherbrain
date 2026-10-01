import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, promises as fs, writeFileSync, type FSWatcher, type Stats } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { VaultChangeDto } from '../src/shared/ipc.js'
import { FsVault } from '../src/main/fsvault.js'
import { VaultWatcher, type WatchFn } from '../src/main/watcher.js'

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
    { files: scan.files.map((f) => f.path), folders: scan.folders, images: scan.assets.map((a) => a.path) },
    (batch) => changes.push(...batch),
    { debounceMs: 60 },
  )
  await watcher.start()
  const probeAbs = vault.abs(probe)
  for (let i = 0; !changes.some((c) => c.path === probe); i++) {
    if (i > 40) throw new Error('watcher never became ready')
    await fs.writeFile(probeAbs, `probe ${i}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  changes = []
  return vault
}

type Listener = Parameters<WatchFn>[2]
type FakeFsWatcher = EventEmitter & { close(): void; closed: boolean }

/**
 * fs.watch stand-in: arms instantly and delivers only the events a test
 * fires, so "the OS lost these events" can be played out on a real disk.
 */
function fakeWatch() {
  const calls: { dir: string; listener: Listener; w: FakeFsWatcher }[] = []
  const fn: WatchFn = (dir, _opts, listener) => {
    const w: FakeFsWatcher = Object.assign(new EventEmitter(), {
      closed: false,
      close() {
        w.closed = true
      },
    })
    calls.push({ dir, listener, w })
    return w as unknown as FSWatcher
  }
  /** The live watcher of `dir`. */
  const of = (dir: string) => {
    const c = calls.filter((x) => x.dir === dir && !x.w.closed).at(-1)
    if (!c) throw new Error(`no live watcher for ${dir}`)
    return c
  }
  return { fn, calls, of }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

  it('reports a new picture with its size and without content', async () => {
    await open([root])
    await put('vault/Art/gate.png', 'pixels')
    const c = await waitChange('add', 'Art/gate.png')
    expect(c.content).toBeUndefined()
    expect(c.size).toBe(6)
    await fs.rm(path.join(root, 'Art', 'gate.png'))
    await waitChange('unlink', 'Art/gate.png')
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
    await put('vault/sketch.psd', 'x')
    await put('vault/.thumbs/gate.png', 'x')
    await put('vault/node_modules/pkg/logo.png', 'x')
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
    await watcher.start()
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

describe('VaultWatcher started before the scan', () => {
  beforeEach(async () => {
    await put('vault/known.md', 'old')
    await put('vault/Folder/inner.md', 'inner')
  })

  it('reports a note and a folder created in an already-scanned folder while the scan runs', async () => {
    const vault = new FsVault([root])
    watcher = new VaultWatcher(vault, null, (batch) => changes.push(...batch), { debounceMs: 40 })
    await watcher.start()
    let made = false
    // The last progress call comes after every folder was walked: what appears now is not in the scan.
    const scan = await vault.scan(() => {
      if (made) return
      made = true
      writeFileSync(path.join(root, 'Folder', 'during.md'), 'made during the scan')
      mkdirSync(path.join(root, 'Planet'))
    })
    expect(scan.files.map((f) => f.path)).not.toContain('Folder/during.md')
    await sleep(200)
    // Held until the scan is handed over.
    expect(changes).toEqual([])
    watcher.seed({ files: scan.files.map((f) => f.path), folders: scan.folders })
    const c = await waitChange('add', 'Folder/during.md')
    expect(c.content).toBe('made during the scan')
    await waitChange('addDir', 'Planet')
    expect(count('add', 'known.md')).toBe(0)
    // Live from here on.
    await put('vault/after.md', 'after')
    await waitChange('add', 'after.md')
  })

  it('classifies buffered paths against the seeded sets and resyncs a root that lost events before the seed', async () => {
    const fake = fakeWatch()
    const vault = new FsVault([root])
    watcher = new VaultWatcher(vault, null, (batch) => changes.push(...batch), { debounceMs: 20, resyncMs: 20, watch: fake.fn })
    await watcher.start()
    const scan = await vault.scan()
    await put('vault/seen.md', 'reported by the OS')
    fake.of(root).listener('rename', 'seen.md')
    await put('vault/Folder/unseen.md', 'its event was lost')
    fake.of(root).listener('change', null)
    await sleep(120)
    expect(changes).toEqual([])
    watcher.seed({ files: scan.files.map((f) => f.path), folders: scan.folders })
    expect((await waitChange('add', 'seen.md')).content).toBe('reported by the OS')
    expect((await waitChange('add', 'Folder/unseen.md')).content).toBe('its event was lost')
  })
})

describe('VaultWatcher resync after lost events', () => {
  let other: string
  let fake: ReturnType<typeof fakeWatch>

  beforeEach(async () => {
    other = path.join(tmp, 'Other')
    await put('vault/known.md', 'old')
    await put('vault/Folder/inner.md', 'inner')
    await put('vault/Folder/Sub/leaf.md', 'leaf')
    await put('Other/a.md', 'a')
    fake = fakeWatch()
  })

  async function watched(opts: { rearmMs?: number; probeMs?: number } = {}): Promise<FsVault> {
    const vault = new FsVault([root, other])
    const scan = await vault.scan()
    watcher = new VaultWatcher(
      vault,
      { files: scan.files.map((f) => f.path), folders: scan.folders },
      (batch) => changes.push(...batch),
      { debounceMs: 20, resyncMs: 30, ...opts, watch: fake.fn },
    )
    await watcher.start()
    return vault
  }

  /** Everything the rescan may report for a note nobody touched: at most a change with its own content. */
  const untouched = (p: string, content: string) =>
    changes.filter((c) => c.path === p).every((c) => c.kind === 'change' && c.content === content)

  it('rescans a root after an event without a file name (Windows buffer overflow) and reports what was missed', async () => {
    await watched()
    // All of this happens while the OS drops the events.
    await put('vault/new.md', 'fresh')
    await put('vault/known.md', 'edited')
    await fs.rm(path.join(root, 'Folder', 'Sub'), { recursive: true })
    await put('vault/Planet/Moon/m.md', 'moon')
    await put('Other/b.md', 'not lost: Other kept its events')
    await sleep(100)
    expect(changes).toEqual([])
    fake.of(root).listener('change', null)
    expect((await waitChange('add', 'vault/new.md')).content).toBe('fresh')
    expect((await waitChange('change', 'vault/known.md')).content).toBe('edited')
    await waitChange('unlink', 'vault/Folder/Sub/leaf.md')
    await waitChange('unlinkDir', 'vault/Folder/Sub')
    await waitChange('addDir', 'vault/Planet')
    await waitChange('addDir', 'vault/Planet/Moon')
    expect((await waitChange('add', 'vault/Planet/Moon/m.md')).content).toBe('moon')
    await sleep(100)
    expect(count('add', 'vault/Planet/Moon/m.md')).toBe(1)
    expect(changes.some((c) => c.path.startsWith('Other/'))).toBe(false)
    expect(untouched('vault/Folder/inner.md', 'inner')).toBe(true)
    expect(changes.some((c) => c.kind === 'unlinkDir' && c.path === 'vault/Folder')).toBe(false)
    // An empty file name means the same thing.
    await put('vault/second.md', '2')
    fake.of(root).listener('change', '')
    await waitChange('add', 'vault/second.md')
  })

  it('never reports notes gone from a folder the rescan could not read', async () => {
    await watched()
    const folder = path.join(root, 'Folder')
    const readdir = fs.readdir
    vi.spyOn(fs, 'readdir').mockImplementation(((p: Parameters<typeof fs.readdir>[0], opts?: never) => {
      if (String(p) === folder) return Promise.reject(Object.assign(new Error('access denied'), { code: 'EACCES' }))
      return readdir(p, opts)
    }) as typeof fs.readdir)
    await put('vault/new.md', 'fresh')
    fake.of(root).listener('change', null)
    await waitChange('add', 'vault/new.md')
    await sleep(100)
    expect(untouched('vault/Folder/inner.md', 'inner')).toBe(true)
    expect(untouched('vault/Folder/Sub/leaf.md', 'leaf')).toBe(true)
    expect(changes.some((c) => c.kind === 'unlinkDir')).toBe(false)
  })

  it('catches up after a watcher error once the root is watched again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await watched({ rearmMs: 80 })
    fake.of(root).w.emit('error', new Error('The specified network name is no longer available.'))
    expect(warn).toHaveBeenCalled()
    await put('vault/while-down.md', 'written while unwatched')
    await fs.rm(path.join(root, 'known.md'))
    await waitFor(() => fake.calls.filter((c) => c.dir === root).length === 2, 're-arm')
    expect((await waitChange('add', 'vault/while-down.md')).content).toBe('written while unwatched')
    await waitChange('unlink', 'vault/known.md')
  })

  it('re-arms only once an async check says the root answers, and never piles up checks on a hung share', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await watched({ rearmMs: 20, probeMs: 30 })
    const stat = fs.stat
    let release = (_st: Stats): void => undefined
    let answering = false
    let rootStats = 0
    vi.spyOn(fs, 'stat').mockImplementation(((p: Parameters<typeof fs.stat>[0], opts?: never) => {
      if (String(p) !== root || answering) return stat(p, opts)
      rootStats++
      // A network share that stopped answering: the stat hangs.
      return new Promise<Stats>((resolve) => (release = resolve))
    }) as typeof fs.stat)
    fake.of(root).w.emit('error', new Error('The network path was not found.'))
    // Several re-arm rounds (20, 40, 80, 160 ms …) with a 30 ms answer limit each.
    await sleep(500)
    // fs.watch (synchronous, would block on the dead share) was never called again,
    expect(fake.calls.filter((c) => c.dir === root)).toHaveLength(1)
    // and the one hung stat was reused instead of starting another each round.
    expect(rootStats).toBe(1)
    answering = true
    release(await stat(root))
    await waitFor(() => fake.calls.filter((c) => c.dir === root).length === 2, 're-arm after the share answers')
  })

  it('never calls fs.watch at start on a root that does not answer, and watches it once it does', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const stat = fs.stat
    let answering = false
    let timeOut = (_err: Error): void => undefined
    vi.spyOn(fs, 'stat').mockImplementation(((p: Parameters<typeof fs.stat>[0], opts?: never) => {
      if (String(p) !== other || answering) return stat(p, opts)
      // A share that does not answer, until the redirector gives up.
      return new Promise<Stats>((_resolve, reject) => (timeOut = reject))
    }) as typeof fs.stat)
    const started = Date.now()
    await watched({ rearmMs: 20, probeMs: 50 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(fake.calls.map((c) => c.dir)).toEqual([root])
    // Written while Other is not watched.
    await put('Other/while-away.md', 'x')
    // The reachable root is live right away.
    await put('vault/live.md', 'live')
    fake.of(root).listener('rename', 'live.md')
    await waitChange('add', 'vault/live.md')
    await sleep(200)
    expect(fake.calls.map((c) => c.dir)).toEqual([root])
    answering = true
    timeOut(Object.assign(new Error('The semaphore timeout period has expired.'), { code: 'ETIMEDOUT' }))
    await waitFor(() => fake.calls.some((c) => c.dir === other), 'watching Other once it answers')
    // Rescanned once watched: what the scan could not see is reported.
    expect((await waitChange('add', 'Other/while-away.md')).content).toBe('x')
  })

  it('does not re-arm a root that is gone until it is back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await watched({ rearmMs: 20 })
    await fs.rename(root, path.join(tmp, 'unplugged'))
    fake.of(root).w.emit('error', new Error('EPERM'))
    await sleep(300)
    expect(fake.calls.filter((c) => c.dir === root)).toHaveLength(1)
    expect(warn.mock.calls.filter(([m]) => m === '[aether] cannot watch')).toEqual([])
    await fs.rename(path.join(tmp, 'unplugged'), root)
    await waitFor(() => fake.calls.filter((c) => c.dir === root).length === 2, 're-arm when back')
  })
})

describe('VaultWatcher and a note being created', () => {
  it('never reports a note it is creating as empty, even where it is filled in place (no hard links)', async () => {
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }))
    await put('vault/known.md', 'old')
    const fake = fakeWatch()
    const vault = new FsVault([root])
    const scan = await vault.scan()
    watcher = new VaultWatcher(
      vault,
      { files: scan.files.map((f) => f.path), folders: scan.folders },
      (batch) => changes.push(...batch),
      { debounceMs: 20, watch: fake.fn },
    )
    await watcher.start()
    // Hold the content write of the note itself so a flush runs while it is still empty.
    const full = path.join(root, 'Inbox', 'New.md')
    let release = (): void => undefined
    const gate = new Promise<void>((r) => (release = r))
    let writing = (): void => undefined
    const started = new Promise<void>((r) => (writing = r))
    const open = fs.open
    vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (String(args[0]) !== full) return handle
      const writeFile = handle.writeFile.bind(handle)
      vi.spyOn(handle, 'writeFile').mockImplementation((async (...a: Parameters<typeof handle.writeFile>) => {
        writing()
        await gate
        return writeFile(...a)
      }) as typeof handle.writeFile)
      return handle
    }) as typeof fs.open)
    // As main's createNote does it: noted first, then created.
    watcher.noteSelfWrite('Inbox/New.md', 'captured text')
    const created = vault.create('Inbox/New.md', 'captured text')
    await started
    expect(await fs.readFile(full, 'utf8')).toBe('')
    fake.of(root).listener('rename', 'Inbox')
    fake.of(root).listener('rename', path.join('Inbox', 'New.md'))
    // Several flushes see it empty.
    await sleep(150)
    release()
    await created
    fake.of(root).listener('change', path.join('Inbox', 'New.md'))
    await waitChange('addDir', 'Inbox')
    await sleep(150)
    expect(await fs.readFile(full, 'utf8')).toBe('captured text')
    // Its own write: nothing to report, and above all never an empty note.
    expect(changes.filter((c) => c.path === 'Inbox/New.md')).toEqual([])
    // Live as usual afterwards.
    await put('vault/Inbox/New.md', 'edited elsewhere')
    fake.of(root).listener('change', path.join('Inbox', 'New.md'))
    expect((await waitChange('change', 'Inbox/New.md')).content).toBe('edited elsewhere')
  })
})

describe('VaultWatcher pictures', () => {
  let fake: ReturnType<typeof fakeWatch>

  beforeEach(async () => {
    await put('vault/known.md', 'old')
    await put('vault/keep.png', 'keep')
    await put('vault/Folder/inner.md', 'inner')
    await put('vault/Folder/Sub/old.png', 'old')
    fake = fakeWatch()
  })

  /** A watcher on `root` seeded from a scan (pictures included), fed by the fake fs.watch. */
  async function watched(opts: { images?: boolean; maxAssets?: number; known?: string[]; videoSettleMs?: number } = {}) {
    const vault = new FsVault([root], opts.maxAssets ? { maxAssets: opts.maxAssets } : {})
    const scan = await vault.scan()
    watcher = new VaultWatcher(
      vault,
      { files: scan.files.map((f) => f.path), folders: scan.folders, images: opts.known ?? scan.assets.map((a) => a.path) },
      (batch) => changes.push(...batch),
      {
        debounceMs: 20,
        resyncMs: 20,
        watch: fake.fn,
        ...(opts.images === false ? { images: false } : {}),
        ...(opts.videoSettleMs === undefined ? {} : { videoSettleMs: opts.videoSettleMs }),
      },
    )
    await watcher.start()
    return vault
  }

  /** Deliver an event for a vault path (null: the OS lost events). */
  const fire = (rel: string | null) => fake.of(root).listener('rename', rel === null ? null : rel.split('/').join(path.sep))

  /** Wait until a flush that also reported `sentinel` is done, so "nothing else was reported" can be checked. */
  async function settle(sentinel: string): Promise<void> {
    await put(`vault/${sentinel}`, 's')
    fire(sentinel)
    await waitChange('add', sentinel)
  }

  it('reports a new picture with mtime and size (no content), a rewrite as a change, and a deletion', async () => {
    await watched()
    await put('vault/Art/gate.png', 'x'.repeat(10))
    fire('Art/gate.png')
    const add = await waitChange('add', 'Art/gate.png')
    expect(add.content).toBeUndefined()
    expect(add.size).toBe(10)
    expect(add.mtime).toBeGreaterThan(0)
    await waitChange('addDir', 'Art')
    // Another event with nothing changed (Windows reports reads as changes too) reports nothing.
    fire('Art/gate.png')
    await settle('sentinel-1.md')
    expect(changes.filter((c) => c.path === 'Art/gate.png')).toHaveLength(1)
    await put('vault/Art/gate.png', 'y'.repeat(20))
    fire('Art/gate.png')
    const change = await waitChange('change', 'Art/gate.png')
    expect(change.size).toBe(20)
    expect(change.content).toBeUndefined()
    await fs.rm(path.join(root, 'Art', 'gate.png'))
    fire('Art/gate.png')
    await waitChange('unlink', 'Art/gate.png')
  })

  it('reports a video being written once it is left alone, not on every write', async () => {
    await watched({ videoSettleMs: 300 })
    await put('vault/Clips/take.mp4', 'a')
    fire('Clips/take.mp4')
    // New: there at once (its moon shows; its still comes with the change).
    expect((await waitChange('add', 'Clips/take.mp4')).size).toBe(1)
    for (const more of ['ab', 'abc', 'abcd']) {
      await sleep(60)
      await put('vault/Clips/take.mp4', more)
      fire('Clips/take.mp4')
    }
    await settle('sentinel-v.md')
    expect(count('change', 'Clips/take.mp4')).toBe(0)
    expect((await waitChange('change', 'Clips/take.mp4')).size).toBe(4)
    await sleep(500)
    expect(count('change', 'Clips/take.mp4')).toBe(1)
    // A picture rewritten is reported at once, as before.
    await put('vault/keep.png', 'repainted')
    fire('keep.png')
    await waitChange('change', 'keep.png')
  })

  it('reports a change, not an add, for a picture the scan saw', async () => {
    await watched()
    await put('vault/keep.png', 'repainted')
    fire('keep.png')
    const c = await waitChange('change', 'keep.png')
    expect(c.size).toBe('repainted'.length)
    expect(count('add', 'keep.png')).toBe(0)
  })

  it('unlinks the pictures of a removed folder with its notes', async () => {
    await watched()
    await fs.rm(path.join(root, 'Folder'), { recursive: true })
    fire('Folder')
    await waitChange('unlinkDir', 'Folder')
    await waitChange('unlink', 'Folder/Sub/old.png')
    await waitChange('unlink', 'Folder/inner.md')
    await waitChange('unlinkDir', 'Folder/Sub')
    expect(count('unlink', 'Folder/Sub/old.png')).toBe(1)
    // Unlinks come before the folders they were in go.
    const at = (kind: VaultChangeDto['kind'], p: string) => changes.findIndex((c) => c.kind === kind && c.path === p)
    expect(at('unlink', 'Folder/Sub/old.png')).toBeLessThan(at('unlinkDir', 'Folder/Sub'))
  })

  it('reports every picture of a folder moved in, with sizes, and nothing that is not a picture', async () => {
    await put('outside/Renders/r1.png', '1')
    await put('outside/Renders/r2.JPG', '22')
    await put('outside/Renders/Deep/r3.webp', '333')
    await put('outside/Renders/notes.txt', 'x')
    await put('outside/Renders/icon.svg', '<svg/>')
    await put('outside/Renders/.cache/hidden.png', 'x')
    await watched()
    await fs.rename(path.join(tmp, 'outside', 'Renders'), path.join(root, 'Renders'))
    fire('Renders')
    expect((await waitChange('add', 'Renders/r1.png')).size).toBe(1)
    expect((await waitChange('add', 'Renders/r2.JPG')).size).toBe(2)
    expect((await waitChange('add', 'Renders/Deep/r3.webp')).size).toBe(3)
    await waitChange('addDir', 'Renders/Deep')
    await settle('sentinel.md')
    expect(changes.map((c) => c.path).filter((p) => /notes\.txt|icon\.svg|hidden/.test(p))).toEqual([])
    // Known now: a later event for one is not a second add.
    fire('Renders/r1.png')
    await settle('sentinel-2.md')
    expect(count('add', 'Renders/r1.png')).toBe(1)
  })

  it('rescans pictures after lost events: new ones are added, gone ones unlinked, the rest left alone', async () => {
    await watched()
    await put('vault/Fresh/new.png', 'new')
    await fs.rm(path.join(root, 'Folder', 'Sub', 'old.png'))
    fire(null)
    expect((await waitChange('add', 'Fresh/new.png')).size).toBe(3)
    await waitChange('unlink', 'Folder/Sub/old.png')
    await waitChange('addDir', 'Fresh')
    await sleep(100)
    expect(changes.some((c) => c.path === 'keep.png')).toBe(false)
  })

  it('never takes the pictures a capped rescan did not list for gone', async () => {
    await put('vault/b.png', 'b')
    await watched({ maxAssets: 1, known: ['keep.png', 'b.png', 'Folder/Sub/old.png'] })
    await put('vault/late.md', 'late')
    fire(null)
    await waitChange('add', 'late.md')
    await sleep(100)
    expect(changes.filter((c) => c.kind === 'unlink')).toEqual([])
  })

  it('never adds back, on a resync of one root, the pictures the shared cap of a multi-root scan left out', async () => {
    const other = path.join(tmp, 'Other')
    await put('vault/a2.png', 'a')
    await put('Other/b1.png', 'b')
    await put('Other/b2.png', 'b')
    await put('Other/b3.png', 'b')
    // One cap for both roots (breadth first: vault's two top pictures, then two of Other's).
    const vault = new FsVault([root, other], { maxAssets: 4 })
    const scan = await vault.scan()
    expect(scan.assetsTruncated).toBe(true)
    const known = scan.assets.map((a) => a.path)
    expect(known.filter((p) => p.startsWith('Other/'))).toHaveLength(2)
    watcher = new VaultWatcher(
      vault,
      { files: scan.files.map((f) => f.path), folders: scan.folders, images: known, imagesCapped: scan.assetsTruncated },
      (batch) => changes.push(...batch),
      { debounceMs: 20, resyncMs: 20, watch: fake.fn },
    )
    await watcher.start()
    // Events on Other are lost; its rescan (a cap of four for Other alone) lists all three of its pictures.
    await put('Other/late.md', 'late')
    fake.of(other).listener('rename', null)
    await waitChange('add', 'Other/late.md')
    await sleep(100)
    expect(changes.filter((c) => /\.png$/.test(c.path))).toEqual([])
    // A picture really made now still arrives through its own event.
    await put('Other/b4.png', 'new')
    fake.of(other).listener('rename', 'b4.png')
    expect((await waitChange('add', 'Other/b4.png')).size).toBe(3)
  })

  it('reports no pictures when told not to (the AI link brain)', async () => {
    await watched({ images: false })
    await put('vault/Art/gate.png', 'x')
    fire('Art/gate.png')
    await fs.rm(path.join(root, 'keep.png'))
    fire('keep.png')
    await put('outside/Renders/r1.png', '1')
    await fs.rename(path.join(tmp, 'outside', 'Renders'), path.join(root, 'Renders'))
    fire('Renders')
    await settle('sentinel.md')
    // A rescan does not bring them back either.
    await put('vault/late.md', 'late')
    fire(null)
    await waitChange('add', 'late.md')
    expect(changes.filter((c) => /\.png$/.test(c.path))).toEqual([])
    // Their folders still come and go as folders.
    await waitChange('addDir', 'Renders')
  })
})
