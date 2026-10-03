import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MIN_CREATIVE_FILES, findProjects, isContainerName, projectKind, type FinderVault, type FolderEntry } from '../src/main/projects.js'
import { FsVault } from '../src/main/fsvault.js'

const files = (...names: string[]): FolderEntry[] => names.map((name) => ({ name, dir: false }))
const dirs = (...names: string[]): FolderEntry[] => names.map((name) => ({ name, dir: true }))

describe('projectKind: what a folder’s own entries say it is', () => {
  it('knows engine, git and code projects for sure', () => {
    expect(projectKind(files('Portals.uproject', 'notes.md'))).toEqual({ kind: 'Unreal project', strong: true, files: 0 })
    expect(projectKind(dirs('Assets', 'ProjectSettings', 'Library'))?.kind).toBe('Unity project')
    expect(projectKind(files('project.godot'))?.kind).toBe('Godot project')
    expect(projectKind(dirs('.git', 'src'))?.kind).toBe('git repository')
    // A worktree or submodule has a `.git` file.
    expect(projectKind(files('.git', 'README.md'))?.kind).toBe('git repository')
    expect(projectKind(files('package.json'))?.kind).toBe('code project')
    expect(projectKind(files('Game.sln'))?.kind).toBe('code project')
    // The engine wins over git: an Unreal project under git is an Unreal project.
    expect(projectKind([...dirs('.git'), ...files('Portals.uproject')])?.kind).toBe('Unreal project')
  })

  it('needs a couple of art files, and names the program most of them are from', () => {
    expect(MIN_CREATIVE_FILES).toBe(2)
    expect(projectKind(files('robot.blend'))).toBeNull()
    expect(projectKind(files('robot.blend', 'robot_v2.BLEND', 'ref.png'))).toEqual({ kind: 'Blender files', strong: false, files: 2 })
    expect(projectKind(files('head.ztl', 'body.ztl', 'paint.psd'))).toEqual({ kind: 'ZBrush and other art files', strong: false, files: 3 })
    // Pictures, notes and folders alone are no project; nor is Unity's half.
    expect(projectKind([...files('a.png', 'b.jpg', 'c.md'), ...dirs('Assets')])).toBeNull()
    expect(projectKind([])).toBeNull()
  })

  it('never takes the folders that hold everything for projects', () => {
    for (const n of ['Downloads', 'desktop', 'Documents', 'OneDrive', 'Dropbox', ' Pictures ']) expect(isContainerName(n)).toBe(true)
    for (const n of ['Portals', 'Unreal Projects', 'Art']) expect(isContainerName(n)).toBe(false)
  })
})

/** A vault whose folders are listed from a map (no disk). */
function fakeVault(listing: Record<string, FolderEntry[]>, opts: { multi?: boolean; ignored?: string[] } = {}) {
  const vault: FinderVault = {
    multi: opts.multi ?? false,
    abs: (p) => `/v/${p}`,
    isIgnored: (p) => (opts.ignored ?? []).some((i) => p === i || p.startsWith(`${i}/`)),
  }
  const looked: string[] = []
  const list = async (abs: string) => {
    const p = abs.slice(3)
    looked.push(p)
    return listing[p] ?? []
  }
  return { vault, list, looked }
}

describe('findProjects', () => {
  it('finds the project folders among the given ones, shallowest first, and looks into each once', async () => {
    const { vault, list, looked } = fakeVault({
      'Work/Portals': files('Portals.uproject'),
      'Work/Portals/SourceArt': files('a.blend', 'b.blend'),
      Sculpts: files('x.ztl', 'y.ztl'),
      'Code/brain': dirs('.git'),
      'Code/junk': files('one.psd'),
    })
    const folders = ['Work/Portals/SourceArt', 'Work', 'Work/Portals', 'Sculpts', 'Code', 'Code/brain', 'Code/junk']
    const res = await findProjects(vault, folders, { list })
    expect(res.candidates.map((c) => [c.path, c.kind])).toEqual([
      ['Sculpts', 'ZBrush files'],
      ['Code/brain', 'git repository'],
      ['Work/Portals', 'Unreal project'],
      ['Work/Portals/SourceArt', 'Blender files'],
    ])
    expect(res.candidates[0]).toMatchObject({ name: 'Sculpts', strong: false, files: 2 })
    expect(res).toMatchObject({ looked: 7, truncated: false })
    expect([...looked].sort()).toEqual([...folders].sort())
  })

  it('skips the roots of a multi-root vault, ignored folders and containers', async () => {
    const { vault, list, looked } = fakeVault(
      {
        D: dirs('.git'),
        'D/Downloads': files('Portals.uproject'),
        'D/Downloads/Game': files('Game.uproject'),
        'D/Hidden/Thing': dirs('.git'),
        'D/Art': files('a.psd', 'b.psd'),
      },
      { multi: true, ignored: ['D/Hidden'] },
    )
    const res = await findProjects(vault, ['D', 'D/Downloads', 'D/Downloads/Game', 'D/Hidden', 'D/Hidden/Thing', 'D/Art', ''], { list })
    expect(res.candidates.map((c) => c.path)).toEqual(['D/Art', 'D/Downloads/Game'])
    expect(looked.sort()).toEqual(['D/Art', 'D/Downloads/Game'])
  })

  it('stops when cancelled and reports progress', async () => {
    const listing: Record<string, FolderEntry[]> = {}
    const folders = Array.from({ length: 500 }, (_, i) => `F${i}`)
    for (const f of folders) listing[f] = files('a.blend', 'b.blend')
    const { vault, list } = fakeVault(listing)
    let calls = 0
    const progress: number[] = []
    const res = await findProjects(vault, folders, {
      list: async (abs) => {
        calls++
        return list(abs)
      },
      cancelled: () => calls >= 100,
      onProgress: (done, total) => progress.push(done, total),
    })
    expect(calls).toBeLessThan(140)
    expect(res.looked).toBe(calls)
    expect(progress.at(-1)).toBe(500)
  })
})

describe('findProjects on disk', () => {
  let root = ''
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-find-'))
    const put = async (rel: string, content = '') => {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
      await fs.writeFile(path.join(root, rel), content)
    }
    await put('Games/Portals/Portals.uproject', '{}')
    await put('Games/Portals/Content/readme.md', '# x')
    await put('Repos/brain/.git/HEAD', 'ref: refs/heads/main')
    await put('Repos/brain/notes.md', '# brain')
    await put('Sculpts/head.ztl')
    await put('Sculpts/body.ztl')
    await put('Notes/idea.md', '# idea')
  })
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true })
  })

  it('finds them through the real vault and its last scan, opening no file', async () => {
    const vault = new FsVault([root])
    const scan = await vault.scan()
    const res = await findProjects(vault, [...scan.folders])
    expect(res.candidates.map((c) => [c.path, c.kind])).toEqual([
      ['Sculpts', 'ZBrush files'],
      ['Games/Portals', 'Unreal project'],
      ['Repos/brain', 'git repository'],
    ])
    expect(res.truncated).toBe(false)
  })
})
