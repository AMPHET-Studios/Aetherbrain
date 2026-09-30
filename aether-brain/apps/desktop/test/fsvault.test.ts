import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FsVault, HEAVY_DIRS, isImageName, isNoteName } from '../src/main/fsvault.js'

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-fsvault-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

/** Create a file (and parents) under the temp dir. */
async function put(rel: string, content = ''): Promise<string> {
  const full = path.join(tmp, ...rel.split('/'))
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
  return full
}

const exists = (rel: string) =>
  fs.stat(path.join(tmp, ...rel.split('/'))).then(
    () => true,
    () => false,
  )

describe('FsVault.mountNames', () => {
  it('names drive roots by letter and labels them D:\\', () => {
    const r = FsVault.mountNames(['D:\\', 'f:\\'])
    expect(r.map((x) => [x.mount, x.label])).toEqual([
      ['D', 'D:\\'],
      ['F', 'F:\\'],
    ])
  })

  it("names '/' root and folders by basename", () => {
    const r = FsVault.mountNames(['/', '/home/me/Notes'])
    expect(r.map((x) => [x.mount, x.label])).toEqual([
      ['root', '/'],
      ['Notes', 'Notes'],
    ])
  })

  it('de-duplicates collisions with " 2", " 3" (case-insensitive)', () => {
    expect(FsVault.mountNames(['/a/Notes', '/b/Notes', '/c/notes']).map((x) => x.mount)).toEqual([
      'Notes',
      'Notes 2',
      'notes 3',
    ])
    expect(FsVault.mountNames(['/x/Notes 2', '/a/Notes', '/b/Notes']).map((x) => x.mount)).toEqual([
      'Notes 2',
      'Notes',
      'Notes 3',
    ])
  })

  it('never gives a mount a hidden-looking name (core drops dot-prefixed paths)', () => {
    const r = FsVault.mountNames(['/home/me/.notes', '/srv/$Work', '/x/...'])
    expect(r.map((x) => [x.mount, x.label])).toEqual([
      ['notes', '.notes'],
      ['Work', '$Work'],
      ['root', '...'],
    ])
  })

  it("gives a single root mount ''", () => {
    expect(FsVault.mountNames(['/home/me/Notes'])).toEqual([{ abs: '/home/me/Notes', mount: '', label: 'Notes' }])
  })

  it('dedupes identical roots and refuses an empty root list', () => {
    const v = new FsVault([tmp, `${tmp}/`, path.join(tmp, 'x', '..')])
    expect(v.multi).toBe(false)
    expect(v.roots).toHaveLength(1)
    expect(() => new FsVault([])).toThrow()
  })
})

describe('FsVault paths', () => {
  it('jails a single root', () => {
    const v = new FsVault([tmp])
    expect(v.abs('x/y.md')).toBe(path.join(tmp, 'x', 'y.md'))
    expect(v.abs('')).toBe(tmp)
    expect(v.abs('a/../b.md')).toBe(path.join(tmp, 'b.md'))
    expect(v.abs('a\\b.md')).toBe(path.join(tmp, 'a', 'b.md'))
    // Absolute-looking input is taken as relative to the root, never as a disk path.
    expect(v.abs('/etc/passwd')).toBe(path.join(tmp, 'etc', 'passwd'))
    expect(v.abs('//x//y.md')).toBe(path.join(tmp, 'x', 'y.md'))
    expect(() => v.abs('../x.md')).toThrow(/escapes/)
    expect(() => v.abs('a/../../x.md')).toThrow(/escapes/)
    expect(() => v.abs('..\\x.md')).toThrow(/escapes/)
    expect(() => v.abs('..')).toThrow(/escapes/)
    // A name that merely starts with '..' is not an escape.
    expect(v.abs('..notes.md')).toBe(path.join(tmp, '..notes.md'))
    // '.' segments are dropped ('./Inbox' is how people and AI clients often write it); '..' stays refused.
    expect(v.isIgnored('./Inbox/./x.md')).toBe(false)
    expect(v.isIgnored('a/../b.md')).toBe(true)
  })

  it('routes multi-root paths by mount', () => {
    const a = path.join(tmp, 'Alpha')
    const b = path.join(tmp, 'Beta')
    const v = new FsVault([a, b])
    expect(v.multi).toBe(true)
    expect(v.roots.map((r) => r.mount)).toEqual(['Alpha', 'Beta'])
    expect(v.abs('Alpha/x.md')).toBe(path.join(a, 'x.md'))
    expect(v.abs('beta/y/z.md')).toBe(path.join(b, 'y', 'z.md'))
    expect(v.abs('Alpha')).toBe(a)
    expect(v.abs('\\Beta\\q.md')).toBe(path.join(b, 'q.md'))
    expect(() => v.abs('')).toThrow()
    expect(() => v.abs('/')).toThrow()
    expect(() => v.abs('Gamma/x.md')).toThrow(/Unknown vault root/)
    // Leaving one root is an escape even when it lands inside another.
    expect(() => v.abs('Alpha/../Beta/x.md')).toThrow(/escapes/)
    expect(() => v.abs('Alpha/../../x.md')).toThrow(/escapes/)
  })

  it('maps absolute paths back to vault paths', () => {
    const single = new FsVault([tmp])
    expect(single.toVault(path.join(tmp, 'a', 'b.md'))).toBe('a/b.md')
    expect(single.toVault(tmp)).toBe('')
    expect(single.toVault(path.dirname(tmp))).toBeNull()
    expect(single.toVault(`${tmp}-sibling/x.md`)).toBeNull()

    const a = path.join(tmp, 'Alpha')
    const multi = new FsVault([a, path.join(tmp, 'Beta')])
    expect(multi.toVault(path.join(a, 'x', 'y.md'))).toBe('Alpha/x/y.md')
    expect(multi.toVault(a)).toBe('Alpha')
    expect(multi.toVault(path.join(tmp, 'Other', 'x.md'))).toBeNull()
    for (const p of ['Alpha/x/y.md', 'Beta/z.md']) expect(multi.toVault(multi.abs(p))).toBe(p)
  })

  it('ignores hidden, $, heavy and system folders, temp files and user excludes', () => {
    const v = new FsVault([tmp], { exclude: [' Secret ', 'Private'] })
    const ignored = [
      '.obsidian/x.md',
      'a/.git/HEAD',
      '$RECYCLE.BIN/x.md',
      'Users/me/AppData/Local/x.md',
      'proj/node_modules/pkg/readme.md',
      'Game/Intermediate/x.md',
      'System Volume Information',
      'Program Files (x86)/App/readme.md',
      'SteamLibrary/steamapps/common/readme.md',
      'py/Lib/site-packages/x.md',
      'Notes/x.md.aether-tmp',
      'secret/plan.md',
      'a/PRIVATE/b.md',
    ]
    for (const p of ignored) expect(v.isIgnored(p), p).toBe(true)
    for (const p of ['a.md', 'Projects/PORTALz/Design.md', 'Notes/Windows tips.md', '']) {
      expect(v.isIgnored(p), p).toBe(false)
    }
    // Windows opens `AppData.` and `node_modules ` as AppData and node_modules.
    for (const p of ['Users/me/AppData./x.md', 'proj/node_modules /x.md', 'x.md.aether-tmp.', 'Secret. /x.md']) {
      expect(v.isIgnored(p), p).toBe(true)
    }
    expect(v.isIgnored('Notes./x.md')).toBe(false)
    v.exclude = []
    expect(v.isIgnored('secret/plan.md')).toBe(false)
    expect(HEAVY_DIRS.has('windows')).toBe(true)
    for (const name of HEAVY_DIRS) expect(name).toBe(name.toLowerCase())
  })

  it('evaluates ignore rules inside the root, skipping the mount segment', () => {
    const v = new FsVault([path.join(tmp, '.dotroot'), path.join(tmp, 'build')])
    expect(v.roots.map((r) => r.mount)).toEqual(['dotroot', 'build'])
    expect(v.isIgnored('dotroot/x.md')).toBe(false)
    expect(v.isIgnored('build/sub/x.md')).toBe(false)
    expect(v.isIgnored('dotroot/.git/x')).toBe(true)
    expect(v.isIgnored('build/sub/AppData/x.md')).toBe(true)
    expect(v.abs('dotroot/x.md')).toBe(path.join(tmp, '.dotroot', 'x.md'))
  })

  it('knows which file names are notes', () => {
    expect(isNoteName('a.md')).toBe(true)
    expect(isNoteName('A.MD')).toBe(true)
    expect(isNoteName('LICENSE.md')).toBe(false)
    expect(isNoteName('License.md')).toBe(true)
    expect(isNoteName('a.txt')).toBe(false)
  })
})

describe('FsVault.scan', () => {
  it('finds notes and folders breadth first, skipping ignored trees and boilerplate', async () => {
    await put('a.md', 'A')
    await put('Notes/b.MD', 'B')
    await put('Notes/deep/c.md', 'C')
    await put('Notes/readme.txt')
    await put('LICENSE.md')
    await put('docs/CHANGELOG.md')
    // A differently-cased twin lives in another folder: on Windows (case-insensitive
    // file names) docs/Changelog.md and docs/CHANGELOG.md would be the same file.
    await put('Notes/Changelog.md')
    await put('.obsidian/x.md')
    await put('node_modules/pkg/readme.md')
    await put('$RECYCLE.BIN/x.md')
    await put('Notes/draft.md.aether-tmp')
    await fs.mkdir(path.join(tmp, 'Empty'))
    const v = new FsVault([tmp])
    const progress: number[] = []
    const res = await v.scan((p) => progress.push(p.found))
    expect(res.files.map((f) => f.path).sort()).toEqual(['Notes/Changelog.md', 'Notes/b.MD', 'Notes/deep/c.md', 'a.md'])
    for (const f of res.files) expect(f.abs).toBe(v.abs(f.path))
    expect([...res.folders].sort()).toEqual(['Empty', 'Notes', 'Notes/deep', 'docs'])
    expect(res.truncated).toBe(false)
    expect(res.dirs).toBe(5)
    expect(progress.at(-1)).toBe(4)
    expect(v.lastScan).toBe(res)
  })

  it('stops at maxDirs and reports truncation', async () => {
    await put('a/x.md')
    await put('b/y.md')
    await put('c/d/z.md')
    const small = await new FsVault([tmp], { maxDirs: 2 }).scan()
    expect(small.truncated).toBe(true)
    expect(small.dirs).toBe(2)
    expect(small.folders).toHaveLength(1)
    const exact = await new FsVault([tmp], { maxDirs: 5 }).scan()
    expect(exact.truncated).toBe(false)
    expect(exact.files).toHaveLength(3)
  })

  it('prefixes multi-root paths with mounts and includes mounts as folders', async () => {
    await put('Alpha/x.md')
    await put('Alpha/sub/y.md')
    await put('Beta/z.md')
    await put('Beta/.trash/gone.md')
    const v = new FsVault([path.join(tmp, 'Alpha'), path.join(tmp, 'Beta'), path.join(tmp, 'Missing')])
    const res = await v.scan()
    expect(res.files.map((f) => f.path).sort()).toEqual(['Alpha/sub/y.md', 'Alpha/x.md', 'Beta/z.md'])
    expect([...res.folders].sort()).toEqual(['Alpha', 'Alpha/sub', 'Beta', 'Missing'])
  })

  it('walks a nested root once, as itself, and never follows symlinks', async () => {
    await put('Alpha/x.md')
    await put('Alpha/sub/y.md')
    await fs.symlink(path.join(tmp, 'Alpha'), path.join(tmp, 'Alpha', 'loop'))
    const v = new FsVault([path.join(tmp, 'Alpha'), path.join(tmp, 'Alpha', 'sub')])
    const res = await v.scan()
    expect(res.files.map((f) => f.path).sort()).toEqual(['Alpha/x.md', 'sub/y.md'])
    expect([...res.folders].sort()).toEqual(['Alpha', 'sub'])
    expect(v.toVault(path.join(tmp, 'Alpha', 'sub', 'y.md'))).toBe('sub/y.md')
  })

  it('scans one root on its own without touching lastScan', async () => {
    await put('Alpha/x.md')
    await put('Alpha/sub/y.md')
    await put('Alpha/Nested/n.md')
    await put('Beta/z.md')
    const v = new FsVault([path.join(tmp, 'Alpha'), path.join(tmp, 'Beta'), path.join(tmp, 'Alpha', 'Nested')])
    const full = await v.scan()
    const alpha = await v.scanRoot(v.roots[0]!)
    expect(alpha.files.map((f) => f.path).sort()).toEqual(['Alpha/sub/y.md', 'Alpha/x.md'])
    expect([...alpha.folders].sort()).toEqual(['Alpha', 'Alpha/sub'])
    expect(alpha.dirs).toBe(2)
    expect(v.lastScan).toBe(full)
    // A root that cannot be read is walked zero folders.
    await fs.rm(path.join(tmp, 'Beta'), { recursive: true })
    expect((await v.scanRoot(v.roots[1]!)).dirs).toBe(0)
  })

  it('reads scanned files in order with mtimes, skipping vanished ones', async () => {
    await put('a.md', 'alpha')
    await put('b.md', 'beta')
    const v = new FsVault([tmp])
    const files = [
      { path: 'b.md', abs: v.abs('b.md') },
      { path: 'gone.md', abs: v.abs('gone.md') },
      { path: 'a.md', abs: v.abs('a.md') },
    ]
    let done = 0
    const out = await v.readAll(files, (n) => (done = n))
    expect(out.map((f) => [f.path, f.content])).toEqual([
      ['b.md', 'beta'],
      ['a.md', 'alpha'],
    ])
    for (const f of out) expect(f.mtime).toBeGreaterThan(0)
    expect(done).toBe(3)
  })
})

describe('FsVault file operations', () => {
  it('writes atomically, creating parents, and reads back', async () => {
    const v = new FsVault([tmp])
    await v.write('new/deep/n.md', 'hello')
    expect(await v.read('new/deep/n.md')).toBe('hello')
    await v.write('./new/./deep/n.md', 'again')
    expect(await v.read('new/deep/n.md')).toBe('again')
    expect(await v.read('./new/deep/n.md')).toBe('again')
    expect(await fs.readdir(path.join(tmp, 'new', 'deep'))).toEqual(['n.md'])
  })

  it('refuses writes outside the vault, into ignored folders, or onto a root', async () => {
    const v = new FsVault([tmp])
    await expect(v.write('../x.md', 'x')).rejects.toThrow(/escapes/)
    await expect(v.write('.obsidian/x.md', 'x')).rejects.toThrow(/excluded/)
    await expect(v.write('proj/node_modules/x.md', 'x')).rejects.toThrow(/excluded/)
    await expect(v.write('x.md.aether-tmp', 'x')).rejects.toThrow(/excluded/)
    await expect(v.write('', 'x')).rejects.toThrow()
    expect(await exists('.obsidian')).toBe(false)

    const multi = new FsVault([path.join(tmp, 'A'), path.join(tmp, 'B')])
    await expect(multi.write('A', 'x')).rejects.toThrow()
    await expect(multi.write('C/x.md', 'x')).rejects.toThrow(/Unknown/)
    await multi.write('b/x.md', 'x')
    expect(await exists('B/x.md')).toBe(true)
  })

  it('creates a new note, making parents, and refuses to replace anything', async () => {
    const v = new FsVault([tmp])
    await v.create('Inbox/deep/new.md', 'hello')
    expect(await v.read('Inbox/deep/new.md')).toBe('hello')
    // An existing note, repo boilerplate the scan skips, and a folder are all taken.
    await put('Code/Game/CHANGELOG.md', '# Changelog\n\n## 1.0\n- important history\n')
    await fs.mkdir(path.join(tmp, 'Inbox', 'dir.md'))
    for (const p of ['Inbox/deep/new.md', 'Code/Game/CHANGELOG.md', 'Inbox/dir.md']) {
      const err = await v.create(p, 'template').then(
        () => null,
        (e: unknown) => e as NodeJS.ErrnoException,
      )
      expect(err?.code, p).toBe('EEXIST')
      expect(err?.message, p).toMatch(/EEXIST/)
    }
    expect(await v.read('Inbox/deep/new.md')).toBe('hello')
    expect(await fs.readFile(path.join(tmp, 'Code', 'Game', 'CHANGELOG.md'), 'utf8')).toMatch(/important history/)
    expect((await fs.stat(path.join(tmp, 'Inbox', 'dir.md'))).isDirectory()).toBe(true)
    // A file where a parent folder should be is not "name taken" (the next suffix would not help).
    const notDir = await v.create('Inbox/deep/new.md/child.md', 'x').then(
      () => null,
      (e: unknown) => e as NodeJS.ErrnoException,
    )
    expect(notDir?.message).not.toMatch(/EEXIST/)
    expect(notDir?.code).not.toBe('EEXIST')
  })

  it('treats a name that differs only in letter case as taken, on any disk', async () => {
    await put('Code/Changelog.md', 'kept')
    await put('Inbox/Buy milk.md', 'external')
    const v = new FsVault([tmp])
    await expect(v.create('Code/CHANGELOG.md', 'x')).rejects.toThrow(/EEXIST/)
    await expect(v.create('Inbox/buy MILK.md', 'x')).rejects.toThrow(/EEXIST/)
    expect((await fs.readdir(path.join(tmp, 'Code'))).sort()).toEqual(['Changelog.md'])
    expect(await fs.readFile(path.join(tmp, 'Inbox', 'Buy milk.md'), 'utf8')).toBe('external')
    await v.create('Inbox/Buy milk 2.md', 'x')
    expect(await v.read('Inbox/Buy milk 2.md')).toBe('x')
  })

  it('refuses to create outside the vault, in ignored folders, or through a link out of the root', async () => {
    await fs.mkdir(path.join(tmp, 'vault'))
    await fs.mkdir(path.join(tmp, 'outside'))
    await fs.symlink(path.join(tmp, 'outside'), path.join(tmp, 'vault', 'Link'))
    const v = new FsVault([path.join(tmp, 'vault')])
    await expect(v.create('../x.md', 'x')).rejects.toThrow(/escapes/)
    await expect(v.create('.obsidian/x.md', 'x')).rejects.toThrow(/excluded/)
    await expect(v.create('proj/node_modules/x.md', 'x')).rejects.toThrow(/excluded/)
    await expect(v.create('Link/x.md', 'x')).rejects.toThrow(/escapes/)
    await expect(v.create('', 'x')).rejects.toThrow()
    expect(await fs.readdir(path.join(tmp, 'outside'))).toEqual([])
    expect(await exists('vault/.obsidian')).toBe(false)
  })

  it('removes the file it created when the write fails', async () => {
    const v = new FsVault([tmp])
    const open = fs.open
    vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      vi.spyOn(handle, 'writeFile').mockRejectedValue(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }))
      return handle
    }) as typeof fs.open)
    await expect(v.create('full.md', 'x')).rejects.toThrow(/no space/)
    expect(await exists('full.md')).toBe(false)
    // Nothing left behind, temp files included.
    expect(await fs.readdir(tmp)).toEqual([])
  })

  it('never shows a new note half written', async () => {
    const v = new FsVault([tmp])
    const full = path.join(tmp, 'Inbox', 'New.md')
    // Hold every content write until released, then look at the note's path in the meantime.
    let release = (): void => undefined
    const gate = new Promise<void>((r) => (release = r))
    let writing = (): void => undefined
    const started = new Promise<void>((r) => (writing = r))
    const open = fs.open
    vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      const writeFile = handle.writeFile.bind(handle)
      vi.spyOn(handle, 'writeFile').mockImplementation((async (...a: Parameters<typeof handle.writeFile>) => {
        writing()
        await gate
        return writeFile(...a)
      }) as typeof handle.writeFile)
      return handle
    }) as typeof fs.open)
    const created = v.create('Inbox/New.md', 'captured text')
    await started
    // A watcher or another app looking now finds nothing there, never an empty note.
    expect(await fs.readFile(full, 'utf8').catch(() => null)).toBeNull()
    release()
    await created
    expect(await fs.readFile(full, 'utf8')).toBe('captured text')
    expect(await fs.readdir(path.join(tmp, 'Inbox'))).toEqual(['New.md'])
  })

  it('never replaces a file that appears after the name check', async () => {
    const v = new FsVault([tmp])
    await put('Inbox/Race.md', 'written by another app')
    // The listing is read before the file shows up; the final step must still refuse.
    const readdir = fs.readdir
    vi.spyOn(fs, 'readdir').mockImplementation(((p: Parameters<typeof fs.readdir>[0], opts?: never) =>
      String(p) === path.join(tmp, 'Inbox') ? Promise.resolve([]) : readdir(p, opts)) as typeof fs.readdir)
    await expect(v.create('Inbox/Race.md', 'template')).rejects.toThrow(/EEXIST/)
    // Same on a disk without hard links.
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }))
    await expect(v.create('Inbox/Race.md', 'template')).rejects.toThrow(/EEXIST/)
    vi.mocked(fs.readdir).mockRestore()
    expect(await fs.readdir(path.join(tmp, 'Inbox'))).toEqual(['Race.md'])
    expect(await fs.readFile(path.join(tmp, 'Inbox', 'Race.md'), 'utf8')).toBe('written by another app')
  })

  it('creates in place on a disk without hard links, still refusing anything that is there', async () => {
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' }))
    await put('Code/Changelog.md', 'kept')
    const v = new FsVault([tmp])
    await v.create('Inbox/New.md', 'hello')
    expect(await v.read('Inbox/New.md')).toBe('hello')
    await expect(v.create('Inbox/New.md', 'x')).rejects.toThrow(/EEXIST/)
    await expect(v.create('Code/CHANGELOG.md', 'x')).rejects.toThrow(/EEXIST/)
    expect(await v.read('Inbox/New.md')).toBe('hello')
    expect(await fs.readdir(path.join(tmp, 'Inbox'))).toEqual(['New.md'])
    expect(await fs.readdir(path.join(tmp, 'Code'))).toEqual(['Changelog.md'])
  })

  it('cleans up the temp file when the target cannot be replaced', async () => {
    await fs.mkdir(path.join(tmp, 'dir.md'))
    const v = new FsVault([tmp])
    await expect(v.write('dir.md', 'x')).rejects.toThrow()
    expect((await fs.readdir(tmp)).sort()).toEqual(['dir.md'])
  })

  it('reads null for missing, escaping, unknown-mount and ignored paths', async () => {
    await put('.env', 'SECRET=1')
    const v = new FsVault([tmp])
    expect(await v.read('missing.md')).toBeNull()
    expect(await v.read('../etc/passwd')).toBeNull()
    expect(await v.read('.env')).toBeNull()
    expect(await new FsVault([tmp, path.join(tmp, 'B')]).read('Nope/x.md')).toBeNull()
  })

  it('renames files and folders without overwriting', async () => {
    await put('a.md', 'A')
    await put('b.md', 'B')
    await put('Folder/f.md', 'F')
    const v = new FsVault([tmp])
    await v.rename('a.md', 'Moved/Deeper/a.md')
    expect(await exists('a.md')).toBe(false)
    expect(await v.read('Moved/Deeper/a.md')).toBe('A')
    await expect(v.rename('b.md', 'Moved/Deeper/a.md')).rejects.toThrow(/exists/)
    expect(await v.read('b.md')).toBe('B')
    expect(await v.read('Moved/Deeper/a.md')).toBe('A')
    await v.rename('Folder', 'Planets/Folder')
    expect(await v.read('Planets/Folder/f.md')).toBe('F')
    await expect(v.rename('b.md', '.hidden/b.md')).rejects.toThrow(/excluded/)
    await expect(v.rename('b.md', '../b.md')).rejects.toThrow(/escapes/)
    await expect(v.rename('missing.md', 'x.md')).rejects.toThrow()
    await v.rename('b.md', 'b.md')
    expect(await v.read('b.md')).toBe('B')
  })

  it('creates folders and refuses ignored ones', async () => {
    const v = new FsVault([tmp])
    await v.mkdir('Planets/Moon/Crater')
    expect((await v.stat('Planets/Moon/Crater'))?.isDir).toBe(true)
    await v.mkdir('Planets/Moon')
    await v.mkdir('')
    await expect(v.mkdir('.git/objects')).rejects.toThrow(/excluded/)
    await expect(v.mkdir('src/node_modules')).rejects.toThrow(/excluded/)
    await expect(v.mkdir('../outside')).rejects.toThrow(/escapes/)
    expect(await exists('.git')).toBe(false)
    expect(await exists('src')).toBe(false)
  })

  it('removes files only', async () => {
    await put('a.md', 'A')
    await put('Folder/f.md', 'F')
    await put('.hidden.md', 'H')
    const v = new FsVault([tmp])
    await v.remove('a.md')
    expect(await exists('a.md')).toBe(false)
    await v.remove('a.md')
    await expect(v.remove('Folder')).rejects.toThrow(/folder/)
    expect(await exists('Folder/f.md')).toBe(true)
    await expect(v.remove('.hidden.md')).rejects.toThrow(/excluded/)
    expect(await exists('.hidden.md')).toBe(true)
    await expect(v.remove('')).rejects.toThrow()
  })

  it('lets two writers save the same note at once (unique temp names)', async () => {
    const v = new FsVault([tmp])
    const x = 'x'.repeat(2_000_000)
    const y = 'y'.repeat(2_000_000)
    await Promise.all([v.write('a.md', x), v.write('a.md', y), v.write('a.md', x)])
    expect([x, y]).toContain(await v.read('a.md'))
    expect(await fs.readdir(tmp)).toEqual(['a.md'])
  })

  it('fails a rename without creating folders when the source is missing or it would nest in itself', async () => {
    await put('Folder/f.md', 'F')
    const v = new FsVault([tmp])
    await expect(v.rename('missing.md', 'New/Deep/x.md')).rejects.toThrow()
    expect(await exists('New')).toBe(false)
    await expect(v.rename('Folder', 'Folder/Sub/Folder')).rejects.toThrow(/itself/)
    expect(await exists('Folder/Sub')).toBe(false)
    expect(await v.read('Folder/f.md')).toBe('F')
  })

  it.skipIf(process.platform === 'win32')('never renames over a dangling symlink', async () => {
    await put('b.md', 'B')
    await fs.symlink(path.join(tmp, 'nowhere.md'), path.join(tmp, 'dangling.md'))
    const v = new FsVault([tmp])
    await expect(v.rename('b.md', 'dangling.md')).rejects.toThrow(/exists/)
    expect(await v.read('b.md')).toBe('B')
  })

  it('moves notes and folders to another drive (EXDEV) by copy + delete, keeping mtimes', async () => {
    await put('D/Inbox/idea.md', 'idea')
    await put('D/Folder/a.md', 'A')
    await put('D/Folder/Sub/b.md', 'B')
    const old = new Date('2024-01-02T03:04:05Z')
    await fs.utimes(path.join(tmp, 'D', 'Inbox', 'idea.md'), old, old)
    const v = new FsVault([path.join(tmp, 'D'), path.join(tmp, 'F')])
    const exdev = () => Promise.reject(Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }))
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(exdev)
    await v.rename('D/Inbox/idea.md', 'F/Projects/idea.md')
    expect(await v.read('F/Projects/idea.md')).toBe('idea')
    expect(await exists('D/Inbox/idea.md')).toBe(false)
    expect((await v.stat('F/Projects/idea.md'))!.mtime).toBe(old.getTime())
    rename.mockImplementationOnce(exdev)
    await v.rename('D/Folder', 'F/Folder')
    expect(await v.read('F/Folder/Sub/b.md')).toBe('B')
    expect(await v.read('F/Folder/a.md')).toBe('A')
    expect(await exists('D/Folder')).toBe(false)
    expect((await fs.readdir(path.join(tmp, 'F'))).sort()).toEqual(['Folder', 'Projects'])
    expect(await fs.readdir(path.join(tmp, 'F', 'Projects'))).toEqual(['idea.md'])
  })

  it('stats files and folders', async () => {
    await put('Folder/f.md', 'F')
    await put('.secret/x.md')
    const v = new FsVault([tmp])
    const file = await v.stat('Folder/f.md')
    expect(file).toMatchObject({ isFile: true, isDir: false })
    expect(file!.mtime).toBeGreaterThan(0)
    expect(await v.stat('Folder')).toMatchObject({ isFile: false, isDir: true })
    expect(await v.stat('missing')).toBeNull()
    expect(await v.stat('.secret/x.md')).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('FsVault on-disk jail (symlinks)', () => {
  let v: FsVault
  beforeEach(async () => {
    await put('outside/secret.md', 'SECRET')
    await put('vault/Notes/a.md', 'A')
    await put('vault/.private/key.md', 'KEY')
    await fs.symlink(path.join(tmp, 'outside'), path.join(tmp, 'vault', 'Link'))
    await fs.symlink(path.join(tmp, 'outside', 'secret.md'), path.join(tmp, 'vault', 'leak.md'))
    await fs.symlink(path.join(tmp, 'vault', '.private'), path.join(tmp, 'vault', 'Hidden'))
    await fs.symlink(path.join(tmp, 'vault', 'Notes'), path.join(tmp, 'vault', 'Alias'))
    v = new FsVault([path.join(tmp, 'vault')])
  })

  it('refuses reads and stats that leave the root or reach an ignored folder through a link', async () => {
    expect(await v.read('Link/secret.md')).toBeNull()
    expect(await v.read('leak.md')).toBeNull()
    expect(await v.stat('Link')).toBeNull()
    expect(await v.stat('Link/secret.md')).toBeNull()
    expect(await v.read('Hidden/key.md')).toBeNull()
    // A link that stays inside the visible vault is fine.
    expect(await v.read('Alias/a.md')).toBe('A')
  })

  it('refuses writes, folders and moves through a link out of the root', async () => {
    await expect(v.write('Link/new.md', 'x')).rejects.toThrow(/escapes/)
    await expect(v.write('Link/Deep/new.md', 'x')).rejects.toThrow(/escapes/)
    await expect(v.mkdir('Link/Planet')).rejects.toThrow(/escapes/)
    await expect(v.rename('Notes/a.md', 'Link/a.md')).rejects.toThrow(/escapes/)
    await expect(v.rename('Link/secret.md', 'Notes/s.md')).rejects.toThrow(/escapes/)
    await expect(v.write('Hidden/x.md', 'x')).rejects.toThrow(/excluded/)
    expect((await fs.readdir(path.join(tmp, 'outside'))).sort()).toEqual(['secret.md'])
    expect(await fs.readFile(path.join(tmp, 'outside', 'secret.md'), 'utf8')).toBe('SECRET')
    expect(await v.read('Notes/a.md')).toBe('A')
  })

  it('works through a root that is itself a symlink', async () => {
    await fs.symlink(path.join(tmp, 'vault'), path.join(tmp, 'rootlink'))
    const linked = new FsVault([path.join(tmp, 'rootlink')])
    expect(await linked.read('Notes/a.md')).toBe('A')
    await linked.write('Notes/b.md', 'B')
    expect(await v.read('Notes/b.md')).toBe('B')
    expect(await linked.read('Link/secret.md')).toBeNull()
  })
})

describe('FsVault pictures', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

  it('knows which file names are pictures', () => {
    for (const n of ['a.png', 'B.JPG', 'c.jpeg', 'd.webp', 'e.gif', 'f.bmp', 'g.avif', 'Gate at dusk.Png']) expect(isImageName(n), n).toBe(true)
    for (const n of ['a.svg', 'a.psd', 'a.md', 'a.txt', 'png', 'a.png.aether-tmp', 'a.pngx', '~$a.png']) expect(isImageName(n), n).toBe(false)
    // On Windows a device name or NTFS stream syntax is never a picture (the OS would open something else).
    for (const n of ['tool.exe:x.png', 'nul.png', 'CON .png', 'com1.jpg', 'lpt¹.gif']) expect(isImageName(n, 'win32'), n).toBe(false)
    for (const n of ['console.png', 'nullify.png', 'a.png']) expect(isImageName(n, 'win32'), n).toBe(true)
    expect(isImageName('12:30 sketch.png', 'linux')).toBe(true)
  })

  it('scans pictures by name with the same skip rules as notes, without touching them', async () => {
    await put('a.md', 'A')
    await put('cover.png')
    await put('Art/gate.JPG')
    await put('Art/Deep/ring.webp')
    await put('Art/sketch.psd')
    await put('Art/icon.svg')
    await put('.obsidian/x.png')
    await put('Art/.thumbs/t.png')
    await put('node_modules/pkg/logo.png')
    await put('Private/secret.png')
    const v = new FsVault([tmp], { exclude: ['Private'] })
    const stat = vi.spyOn(fs, 'stat')
    const lstat = vi.spyOn(fs, 'lstat')
    const res = await v.scan()
    expect(stat).not.toHaveBeenCalled()
    expect(lstat).not.toHaveBeenCalled()
    expect(res.assets.map((a) => a.path).sort()).toEqual(['Art/Deep/ring.webp', 'Art/gate.JPG', 'cover.png'])
    for (const a of res.assets) expect(a.abs).toBe(v.abs(a.path))
    expect(res.assetsTruncated).toBe(false)
    expect(res.files.map((f) => f.path)).toEqual(['a.md'])
  })

  it('stops listing pictures at maxAssets and says so, while notes and folders go on', async () => {
    for (const n of ['a', 'b', 'c']) await put(`Art/${n}.png`)
    await put('Art/Deep/n.md')
    const v = new FsVault([tmp], { maxAssets: 2 })
    const res = await v.scan()
    expect(res.assets).toHaveLength(2)
    expect(res.assetsTruncated).toBe(true)
    expect(res.files.map((f) => f.path)).toEqual(['Art/Deep/n.md'])
    expect(res.folders.sort()).toEqual(['Art', 'Art/Deep'])
    const all = await new FsVault([tmp], { maxAssets: 3 }).scan()
    expect(all.assetsTruncated).toBe(false)
  })

  it('prefixes pictures with the mount in a multi-root vault', async () => {
    await put('Alpha/a.png')
    await put('Beta/Art/b.gif')
    const v = new FsVault([path.join(tmp, 'Alpha'), path.join(tmp, 'Beta')])
    expect((await v.scan()).assets.map((a) => a.path).sort()).toEqual(['Alpha/a.png', 'Beta/Art/b.gif'])
  })

  it('stats scanned pictures within a time budget, keeping order and what it could not reach', async () => {
    await put('a.png', 'aaaa')
    await put('b.png', 'bb')
    const v = new FsVault([tmp])
    const list = [
      { path: 'b.png', abs: v.abs('b.png') },
      { path: 'gone.png', abs: v.abs('gone.png') },
      { path: 'a.png', abs: v.abs('a.png') },
    ]
    const out = await v.statAssets(list)
    expect(out.map((a) => [a.path, a.size])).toEqual([
      ['b.png', 2],
      ['gone.png', undefined],
      ['a.png', 4],
    ])
    expect(out[0]!.mtime).toBeGreaterThan(0)
    expect(out[1]).toEqual({ path: 'gone.png' })
    // No time left: listed as scanned.
    expect(await v.statAssets(list, 0)).toEqual(list.map((a) => ({ path: a.path })))
    // A stat that hangs (a share that stopped answering) does not hold the list up.
    const lstat = fs.lstat
    vi.spyOn(fs, 'lstat').mockImplementation(((p: Parameters<typeof fs.lstat>[0], opts?: never) =>
      String(p).endsWith('a.png') ? new Promise(() => undefined) : lstat(p, opts)) as typeof fs.lstat)
    const started = Date.now()
    const partial = await v.statAssets(list, 150)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(partial.map((a) => a.size)).toEqual([2, undefined, undefined])
  })

  it('finds a picture on disk for thumbnails and opening, and nothing else', async () => {
    await fs.mkdir(path.join(tmp, 'vault'))
    await fs.mkdir(path.join(tmp, 'outside'))
    await put('vault/Art/gate.png', 'x')
    await put('vault/Art/notes.md', 'x')
    await put('vault/.hidden/x.png', 'x')
    await put('vault/node_modules/x.png', 'x')
    await put('outside/secret.png', 'x')
    await put('vault/Art/tool.exe', 'MZ')
    await fs.mkdir(path.join(tmp, 'vault', 'Folder.png'))
    await fs.symlink(path.join(tmp, 'outside'), path.join(tmp, 'vault', 'Link'))
    await fs.symlink(path.join(tmp, 'vault', 'Art', 'gate.png'), path.join(tmp, 'vault', 'Art', 'alias.png'))
    await fs.symlink(path.join(tmp, 'vault', 'Art', 'tool.exe'), path.join(tmp, 'vault', 'Art', 'tool.png'))
    const v = new FsVault([path.join(tmp, 'vault')])
    expect(await v.assetAbs('Art/gate.png')).toBe(path.join(tmp, 'vault', 'Art', 'gate.png'))
    expect(await v.assetAbs('Art\\gate.png')).toBe(path.join(tmp, 'vault', 'Art', 'gate.png'))
    const refused = [
      'Art/notes.md',
      'Art/tool.exe',
      'Art/missing.png',
      'Folder.png',
      '.hidden/x.png',
      'node_modules/x.png',
      '../outside/secret.png',
      'Link/secret.png',
      // Links are never pictures of the vault (the scan does not list them either), whatever they point at.
      'Art/alias.png',
      'Art/tool.png',
      '',
    ]
    for (const p of refused) expect(await v.assetAbs(p), p).toBeNull()
    const multi = new FsVault([path.join(tmp, 'vault'), path.join(tmp, 'outside')])
    expect(await multi.assetAbs('vault/Art/gate.png')).toBe(path.join(tmp, 'vault', 'Art', 'gate.png'))
    expect(await multi.assetAbs('Nope/gate.png')).toBeNull()
  })

  it('creates a new picture from bytes, making parents, and never replaces anything', async () => {
    const v = new FsVault([tmp])
    await v.createBinary('Projects/PORTALz/Critique/study.png', PNG)
    expect(new Uint8Array(await fs.readFile(path.join(tmp, 'Projects', 'PORTALz', 'Critique', 'study.png')))).toEqual(PNG)
    await put('Art/Gate.PNG', 'kept')
    await fs.mkdir(path.join(tmp, 'Art', 'dir.png'))
    for (const p of ['Projects/PORTALz/Critique/study.png', 'Art/gate.png', 'Art/GATE.png', 'Art/dir.png']) {
      const err = await v.createBinary(p, PNG).then(
        () => null,
        (e: unknown) => e as NodeJS.ErrnoException,
      )
      expect(err?.code, p).toBe('EEXIST')
      expect(err?.message, p).toMatch(/EEXIST/)
    }
    expect(await fs.readFile(path.join(tmp, 'Art', 'Gate.PNG'), 'utf8')).toBe('kept')
    expect((await fs.readdir(path.join(tmp, 'Art'))).sort()).toEqual(['Gate.PNG', 'dir.png'])
    await v.createBinary('Art/Gate 2.png', PNG)
    expect((await fs.readdir(path.join(tmp, 'Art'))).sort()).toEqual(['Gate 2.png', 'Gate.PNG', 'dir.png'])
  })

  it('creates pictures only, never in skipped folders or outside the vault', async () => {
    const v = new FsVault([tmp])
    for (const p of ['Inbox/note.md', 'Inbox/x.svg', 'Inbox/run.exe', 'Inbox/png']) {
      const err = await v.createBinary(p, PNG).then(
        () => null,
        (e: unknown) => e as Error,
      )
      expect(err?.message, p).toMatch(/Not a picture/)
      expect(err?.message, p).not.toMatch(/EEXIST/)
    }
    await expect(v.createBinary('.obsidian/x.png', PNG)).rejects.toThrow(/excluded/)
    await expect(v.createBinary('proj/node_modules/x.png', PNG)).rejects.toThrow(/excluded/)
    await expect(v.createBinary('../x.png', PNG)).rejects.toThrow(/escapes/)
    expect(await exists('.obsidian')).toBe(false)
    expect(await exists('Inbox/note.md')).toBe(false)
  })

  it('never shows a new picture half written, on disks with or without hard links', async () => {
    const v = new FsVault([tmp])
    const big = new Uint8Array(256 * 1024).fill(7)
    big.set(PNG)
    await v.createBinary('a.png', big)
    expect((await fs.readFile(path.join(tmp, 'a.png'))).length).toBe(big.length)
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' }))
    await v.createBinary('b.png', big)
    expect((await fs.readFile(path.join(tmp, 'b.png'))).length).toBe(big.length)
    await expect(v.createBinary('B.png', PNG)).rejects.toThrow(/EEXIST/)
    // No temp files left behind.
    expect((await fs.readdir(tmp)).sort()).toEqual(['a.png', 'b.png'])
  })
})
