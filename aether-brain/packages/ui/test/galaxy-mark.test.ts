import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, folderKey, isGalaxyNode, isProjectNote, scaleOf, type GraphNode, type VaultFile, type VaultRootInfo } from '@aether/core'

/**
 * Marking a folder as a galaxy in the app (docs/COSMOLOGY.md, "A galaxy is a folder you mark"): `scale: galaxy` in the folder's project
 * note, written and taken away through the palette or the folder inspector, and how the graph and the inspector answer.
 */

class MemoryStorage {
  map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v))
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
}

async function freshStore() {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  const store = await import('../src/store')
  const { COMMANDS } = await import('../src/commands')
  const inspector = async (): Promise<string> => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { Inspector } = await import('../src/components/Inspector')
    Object.assign(store.useAether.getInitialState(), store.useAether.getState())
    return renderToStaticMarkup(createElement(Inspector))
  }
  return { s: () => store.useAether.getState(), set: store.useAether.setState, commands: COMMANDS, inspector }
}

afterEach(() => void vi.unstubAllGlobals())

const FILES: VaultFile[] = [
  { path: 'Home.md', content: '# Home\n' },
  { path: 'Games/Notes.md', content: '# Notes\n' },
  { path: 'Games/Darktide/Plan.md', content: '# Plan\n' },
  { path: 'Games/Darktide/Mods/Hero.md', content: '# Hero\n' },
  { path: 'Games/Cake/Cake.md', content: '---\ntype: project\nstatus: active\n---\n# Cake\n' },
]
const vault = (o: { readOnly?: boolean; files?: VaultFile[] } = {}) => new MemoryVaultAdapter(o.files ?? FILES, { readOnly: o.readOnly ?? false })
const nodeOf = (g: { nodes: GraphNode[]; index: Map<string, number> }, path: string): GraphNode => g.nodes[g.index.get(folderKey(path))!]!

describe('marking a folder as a galaxy', () => {
  it('makes a plain folder a project first, then a galaxy that sits on the vault', async () => {
    const { s } = await freshStore()
    const adapter = vault()
    await s().openVault(adapter)
    expect(await s().setFolderScale('Games/Darktide', 'galaxy')).toBe(true)
    const note = s().notes.get('Games/Darktide/Darktide')!
    expect(isProjectNote(note)).toBe(true)
    expect(scaleOf(note.frontmatter)).toBe('galaxy')
    expect(await adapter.read('Games/Darktide/Darktide.md')).toMatch(/^---[\s\S]*type: project[\s\S]*scale: galaxy[\s\S]*---/)
    const star = nodeOf(s().graph!, 'Games/Darktide')
    expect(star.folder).toMatchObject({ role: 'project', galaxyLevel: 2 })
    expect(star.parent).toBe(folderKey(''))
    expect(isGalaxyNode(star)).toBe(true)
    expect(s().toasts.at(-1)).toMatchObject({ text: '✦ Darktide is a galaxy now', kind: 'success' })
  })

  it('turns a project star into a galaxy by adding one key to its note, and nothing else of it changes', async () => {
    const { s } = await freshStore()
    const adapter = vault()
    await s().openVault(adapter)
    expect(nodeOf(s().graph!, 'Games/Cake').folder?.galaxyLevel).toBeUndefined()
    expect(await s().setFolderScale('Games/Cake', 'galaxy')).toBe(true)
    const text = await adapter.read('Games/Cake/Cake.md')
    expect(text).toContain('scale: galaxy')
    expect(text).toContain('type: project')
    expect(text).toContain('status: active')
    expect(text).toContain('# Cake')
    expect(nodeOf(s().graph!, 'Games/Cake').folder?.galaxyLevel).toBe(2)
  })

  it('says so when it already is one, and writes nothing', async () => {
    const { s } = await freshStore()
    const adapter = vault()
    await s().openVault(adapter)
    await s().setFolderScale('Games/Cake', 'galaxy')
    const before = await adapter.read('Games/Cake/Cake.md')
    expect(await s().setFolderScale('Games/Cake', 'galaxy')).toBe(true)
    expect(await adapter.read('Games/Cake/Cake.md')).toBe(before)
    expect(s().toasts.at(-1)?.text).toBe('Cake is a galaxy already')
  })

  it('takes the mark away again: the key goes, the project stays, the folder is a star', async () => {
    const { s } = await freshStore()
    const adapter = vault()
    await s().openVault(adapter)
    await s().setFolderScale('Games/Cake', 'galaxy')
    expect(await s().setFolderScale('Games/Cake', 'star')).toBe(true)
    const text = await adapter.read('Games/Cake/Cake.md')
    expect(text).not.toContain('scale')
    expect(text).toContain('type: project')
    const star = nodeOf(s().graph!, 'Games/Cake')
    expect(star.folder).toMatchObject({ role: 'project' })
    expect(star.folder?.galaxyLevel).toBeUndefined()
    expect(star.parent).toBe(folderKey('Games'))
    expect(s().toasts.at(-1)?.text).toBe('★ Cake is a star again')
    // A star made a star again is told so, not rewritten.
    expect(await s().setFolderScale('Games/Cake', 'star')).toBe(true)
    expect(s().toasts.at(-1)?.text).toBe('Cake is a star already')
  })

  it('makes a plain folder a star when asked for a star: a project, nothing more', async () => {
    const { s } = await freshStore()
    const adapter = vault()
    await s().openVault(adapter)
    expect(await s().setFolderScale('Games/Darktide', 'star')).toBe(true)
    expect(await adapter.read('Games/Darktide/Darktide.md')).not.toContain('scale')
    expect(nodeOf(s().graph!, 'Games/Darktide').folder).toMatchObject({ role: 'project' })
  })

  it('nests: a galaxy marked inside a galaxy sits on it, a third level too, and a fourth is told about and stays a star', async () => {
    const { s } = await freshStore()
    const files: VaultFile[] = [
      { path: 'A/A.md', content: '---\ntype: project\nscale: galaxy\n---\n# A\n' },
      { path: 'A/B/B.md', content: '---\ntype: project\nscale: galaxy\n---\n# B\n' },
      { path: 'A/B/C/C.md', content: '---\ntype: project\nscale: galaxy\n---\n# C\n' },
      { path: 'A/B/C/D/x.md', content: '# x\n' },
    ]
    await s().openVault(vault({ files }))
    expect(await s().setFolderScale('A/B/C/D', 'galaxy')).toBe(true)
    const g = s().graph!
    expect(nodeOf(g, 'A').folder?.galaxyLevel).toBe(2)
    expect(nodeOf(g, 'A/B').folder?.galaxyLevel).toBe(3)
    expect(nodeOf(g, 'A/B').parent).toBe(folderKey('A'))
    expect(nodeOf(g, 'A/B/C').folder).toMatchObject({ markIgnored: 'depth' })
    expect(nodeOf(g, 'A/B/C/D').folder).toMatchObject({ markIgnored: 'depth' })
    // The line is written, and the toast says the truth: it does not count, and why.
    const toast = s().toasts.at(-1)!
    expect(toast.text).toContain('D: This folder is marked as a galaxy, but the mark does not count')
    expect(toast.text).toContain('three levels deep at most')
    expect(toast.text).not.toContain('is a galaxy now')
    expect(toast.kind).toBe('info')
  })

  it('writes the mark into the note the graph reads when two project notes name one folder, and takes it off from the same one', async () => {
    const { s } = await freshStore()
    // A sibling note and the folder note, both projects: the graph binds the folder note (listed second, so a first-found lookup would pick the sibling).
    const files: VaultFile[] = [
      { path: 'Games/Darktide.md', content: '---\ntype: project\n---\n# Darktide sibling\n' },
      { path: 'Games/Darktide/Darktide.md', content: '---\ntype: project\n---\n# Darktide\n' },
    ]
    const adapter = vault({ files })
    await s().openVault(adapter)
    expect(nodeOf(s().graph!, 'Games/Darktide').folder?.projectId).toBe('Games/Darktide/Darktide')
    expect(await s().setFolderScale('Games/Darktide', 'galaxy')).toBe(true)
    expect(await adapter.read('Games/Darktide/Darktide.md')).toContain('scale: galaxy')
    expect(await adapter.read('Games/Darktide.md')).not.toContain('scale')
    expect(nodeOf(s().graph!, 'Games/Darktide').folder?.galaxyLevel).toBe(2)
    expect(s().toasts.at(-1)?.text).toBe('✦ Darktide is a galaxy now')
    // And back: from the same note, so the galaxy really is gone, not "a star already".
    expect(await s().setFolderScale('Games/Darktide', 'star')).toBe(true)
    expect(await adapter.read('Games/Darktide/Darktide.md')).not.toContain('scale')
    expect(nodeOf(s().graph!, 'Games/Darktide').folder?.galaxyLevel).toBeUndefined()
    expect(s().toasts.at(-1)?.text).toBe('★ Darktide is a star again')
  })

  it('does not say "galaxy now" when the write did not land', async () => {
    const { s, set } = await freshStore()
    await s().openVault(vault())
    // A patch that refuses without throwing, as the real one does when the note changed on disk or its frontmatter broke.
    set({ patchFrontmatter: async () => {} })
    const toasts = s().toasts.length
    expect(await s().setFolderScale('Games/Cake', 'galaxy')).toBe(false)
    expect(s().toasts.slice(toasts).map((t) => t.text)).toEqual([])
    expect(nodeOf(s().graph!, 'Games/Cake').folder?.galaxyLevel).toBeUndefined()
  })

  it('refuses in a read-only vault, for the vault itself and for Archive, and writes nothing', async () => {
    const { s } = await freshStore()
    await s().openVault(vault({ readOnly: true }))
    expect(await s().setFolderScale('Games/Darktide', 'galaxy')).toBe(false)
    expect(s().toasts.at(-1)).toMatchObject({ text: 'This vault is read-only', kind: 'error' })
    expect(s().notes.has('Games/Darktide/Darktide')).toBe(false)

    const { s: w } = await freshStore()
    await w().openVault(vault({ files: [...FILES, { path: 'Archive/Old/Old.md', content: '# Old\n' }] }))
    expect(await w().setFolderScale('', 'galaxy')).toBe(false)
    expect(w().toasts.at(-1)?.kind).toBe('error')
    expect(await w().setFolderScale('Archive/Old', 'galaxy')).toBe(false)
    expect(w().toasts.at(-1)?.text).toMatch(/Archived folders are not projects/)
  })

  it('refuses a note whose frontmatter is not valid YAML, and says which', async () => {
    const { s } = await freshStore()
    const bad: VaultFile = { path: 'Games/Broken/Broken.md', content: '---\ntype: project\nstatus: [oops\n---\n# Broken\n' }
    await s().openVault(vault({ files: [...FILES, bad] }))
    expect(await s().setFolderScale('Games/Broken', 'galaxy')).toBe(false)
    expect(s().toasts.at(-1)?.text).toMatch(/not valid YAML/)
  })
})

describe('the palette', () => {
  it('offers "Make the selected folder a galaxy" for a folder or a star, and the way back for a galaxy', async () => {
    const { s, commands } = await freshStore()
    await s().openVault(vault())
    const make = commands.find((c) => c.id === 'folder-galaxy')!
    const back = commands.find((c) => c.id === 'folder-galaxy-off')!
    expect(make.title).toBe('Make the selected folder a galaxy')
    expect(back.title).toBe('Make the selected galaxy a star again')
    // Nothing selected: neither.
    s().select(null)
    expect(make.when!(s())).toBe(false)
    expect(back.when!(s())).toBe(false)
    // A plain folder and a project star: the galaxy; not the way back.
    for (const path of ['Games/Darktide', 'Games/Cake']) {
      s().select(folderKey(path))
      expect(make.when!(s()), path).toBe(true)
      expect(back.when!(s()), path).toBe(false)
    }
    // The vault is a galaxy already; a note is no folder.
    s().select(folderKey(''))
    expect(make.when!(s())).toBe(false)
    s().select('Home')
    expect(make.when!(s())).toBe(false)
    // A galaxy: the way back, not the galaxy.
    await s().setFolderScale('Games/Cake', 'galaxy')
    s().select(folderKey('Games/Cake'))
    expect(make.when!(s())).toBe(false)
    expect(back.when!(s())).toBe(true)
    await back.run(s())
    expect(nodeOf(s().graph!, 'Games/Cake').folder?.galaxyLevel).toBeUndefined()
  })

  it('is hidden in a read-only vault', async () => {
    const { s, commands } = await freshStore()
    await s().openVault(vault({ readOnly: true }))
    s().select(folderKey('Games/Darktide'))
    expect(commands.find((c) => c.id === 'folder-galaxy')!.when!(s())).toBe(false)
  })

  it('also offers the way back for a mark that does not count, so it can be taken away', async () => {
    const { s, commands } = await freshStore()
    const files: VaultFile[] = [
      { path: 'A/A.md', content: '---\ntype: project\nscale: galaxy\n---\n# A\n' },
      { path: 'A/B/B.md', content: '---\ntype: project\nscale: galaxy\n---\n# B\n' },
      { path: 'A/B/C/C.md', content: '---\ntype: project\nscale: galaxy\n---\n# C\n' },
      { path: 'A/B/C/D/D.md', content: '---\ntype: project\nscale: galaxy\n---\n# D\n' },
    ]
    await s().openVault(vault({ files }))
    s().select(folderKey('A/B/C'))
    expect(commands.find((c) => c.id === 'folder-galaxy')!.when!(s())).toBe(false)
    expect(commands.find((c) => c.id === 'folder-galaxy-off')!.when!(s())).toBe(true)
  })
})

describe('the folder inspector', () => {
  it('has a "Make galaxy" button on a folder and on a star, and "Make star again" on a galaxy', async () => {
    const { s, inspector } = await freshStore()
    await s().openVault(vault())
    s().select(folderKey('Games/Darktide'))
    let out = await inspector()
    expect(out).toContain('✦ Make galaxy')
    expect(out).toContain('Make project')
    s().select(folderKey('Games/Cake'))
    out = await inspector()
    expect(out).toContain('✦ Make galaxy')
    expect(out).not.toContain('Make star again')
    await s().setFolderScale('Games/Cake', 'galaxy')
    s().select(folderKey('Games/Cake'))
    out = await inspector()
    expect(out).toContain('✦ Galaxy · level 2')
    expect(out).toContain('★ Make star again')
    expect(out).not.toContain('✦ Make galaxy')
    expect(out).toContain('A galaxy: its folders lie on its disc as stars, and it sits on')
    expect(out).toContain('scale: galaxy')
  })

  it('still lists a galaxy among the folders of the star it left, and does not count its pictures in that star’s gallery', async () => {
    const { s, inspector } = await freshStore()
    class WithPictures extends MemoryVaultAdapter {}
    const files: VaultFile[] = [
      { path: 'Games/Games.md', content: '---\ntype: project\n---\n# Games\n' },
      { path: 'Games/Darktide/Darktide.md', content: '---\ntype: project\nscale: galaxy\n---\n# Darktide\n' },
      { path: 'Games/Notes.md', content: '# Notes\n' },
    ]
    await s().openVault(
      new WithPictures(files, {
        assets: [
          { path: 'Games/cover.png', data: new Uint8Array([1]), mtime: 1 },
          { path: 'Games/Darktide/hero.png', data: new Uint8Array([1]), mtime: 2 },
        ],
      }),
    )
    s().select(folderKey('Games'))
    const out = await inspector()
    // The galaxy sits on the vault now, but it is still one of Games' folders on disk.
    expect(nodeOf(s().graph!, 'Games/Darktide').parent).toBe(folderKey(''))
    expect(out).toContain('✦ Darktide')
    expect(out).toContain('Planets · 1')
    // Gallery: Games' own picture only; the galaxy has the other.
    expect(out).toContain('Gallery · 1')
    s().select(folderKey('Games/Darktide'))
    expect(await inspector()).toContain('Gallery · 1')
  })

  it('has neither button on the vault, and on a read-only vault', async () => {
    const { s, inspector } = await freshStore()
    await s().openVault(vault({ readOnly: true }))
    s().select(folderKey('Games/Darktide'))
    expect(await inspector()).not.toContain('Make galaxy')
    s().select(folderKey(''))
    expect(await inspector()).not.toContain('Make galaxy')
  })

  it('says what a folder holds, in words, and why a mark does not count', async () => {
    const { s, inspector } = await freshStore()
    const files: VaultFile[] = [
      { path: 'A/A.md', content: '---\ntype: project\nscale: galaxy\n---\n# A\n' },
      { path: 'A/B/B.md', content: '---\ntype: project\nscale: galaxy\n---\n# B\n' },
      { path: 'A/B/C/C.md', content: '---\ntype: project\nscale: galaxy\n---\n# C\n' },
      { path: 'A/B/C/note.md', content: `# note\n${'word '.repeat(2500)}\n` },
    ]
    await s().openVault(vault({ files }))
    s().select(folderKey('A/B/C'))
    const out = await inspector()
    expect(out).toContain('holds 2 notes · 2.5k words')
    expect(out).toContain('the mark does not count')
    expect(out).toContain('three levels deep at most')
    expect(out).toContain('It stays a star.')
    expect(out).toContain('★ Make star again')
  })

  it('says a drive is a galaxy already, where a project note on it asks for more', async () => {
    const { s, inspector } = await freshStore()
    const files: VaultFile[] = [
      { path: 'D/D.md', content: '---\ntype: project\nscale: galaxy\n---\n# D\n' },
      { path: 'F/x.md', content: '# x\n' },
    ]
    class TwoRoots extends MemoryVaultAdapter {
      readonly roots: VaultRootInfo[] = [
        { path: 'D:\\', mount: 'D', label: 'D:\\' },
        { path: 'F:\\', mount: 'F', label: 'F:\\' },
      ]
    }
    await s().openVault(new TwoRoots(files))
    s().select(folderKey('D'))
    const out = await inspector()
    expect(out).toContain('it is a galaxy already')
    expect(out).not.toContain('Make galaxy')
  })
})
