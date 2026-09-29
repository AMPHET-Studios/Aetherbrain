import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, extractTasks, folderKey, isProjectNote, projectSummary, todayIso, type VaultFile, type VaultRootInfo } from '@aether/core'

/** localStorage for the node test environment. */
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v))
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
  clear(): void {
    this.map.clear()
  }
}

/** A fresh store module (fresh settings, controller and state); optional stored settings first. */
async function freshStore(stored?: unknown) {
  const storage = new MemoryStorage()
  if (stored !== undefined) storage.setItem('aether:settings', typeof stored === 'string' ? stored : JSON.stringify(stored))
  vi.stubGlobal('localStorage', storage)
  vi.resetModules()
  const { useAether } = await import('../src/store')
  const { listProjects } = await import('../src/projects')
  return { useAether, storage, s: () => useAether.getState(), listProjects }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const PORTAL = `---
title: Portal Game
type: project
tags: [gamedev]
created: 2026-01-01
updated: 2026-01-02
status: active
---
# Portal Game

> Build the gate.

## To do

- [ ] First
- [ ] Second
- [x] Done one ✅ 2026-01-05
- [ ] Third

## Notes

Some text.
`

function files(): VaultFile[] {
  return [
    { path: 'Projects/Portal Game.md', content: PORTAL },
    { path: 'Projects/Portal Game/Art/Glyphs.md', content: '# Glyphs\n\nPart of [[Portal Game]].\n' },
    { path: 'Inbox/Idea.md', content: '# Idea\n' },
    { path: 'Resources/Drawing/Value.md', content: '# Value\n\nSee [[Idea]].\n' },
  ]
}

/** A vault on two drives (D:\ and F:\), like the desktop app's multi-root vaults. */
class TwoRoots extends MemoryVaultAdapter {
  readonly roots: VaultRootInfo[] = [
    { path: 'D:\\', mount: 'D', label: 'D:\\' },
    { path: 'F:\\', mount: 'F', label: 'F:\\' },
  ]
}

/** Every markdown file of the bundled demo vault. */
function demoVault(): VaultFile[] {
  const root = fileURLToPath(new URL('../../../vault-demo', import.meta.url))
  const out: VaultFile[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.name.endsWith('.md')) out.push({ path: relative(root, abs).split('\\').join('/'), content: readFileSync(abs, 'utf8') })
    }
  }
  walk(root)
  return out
}

describe('projects', () => {
  it('creates a project and edits its name, status, summary and tags', async () => {
    const { s } = await freshStore()
    const vault = new MemoryVaultAdapter(files())
    await s().openVault(vault)
    const id = await s().createProject('Monolith', 'A big stone')
    expect(id).toBe('Projects/Monolith')
    expect(isProjectNote(s().notes.get(id!)!)).toBe(true)
    s().openNote(id!)

    const renamed = await s().updateProject(id!, { title: 'Monolith Generator', renameFile: true })
    expect(renamed).toBe('Projects/Monolith Generator')
    expect(s().notes.has(id!)).toBe(false)
    // The board, the editor and the selection follow the file (the memory vault reports the move synchronously).
    expect(s().projectId).toBe(renamed)
    expect(s().editorId).toBe(renamed)
    expect(s().selectedId).toBe(renamed)
    expect(s().draft).toBe(s().notes.get(renamed)!.raw)
    const n = s().notes.get(renamed)!
    expect(n.meta.title).toBe('Monolith Generator')
    expect(n.meta.aliases).toContain('Monolith')
    expect(await vault.read('Projects/Monolith.md')).toBeNull()

    await s().updateProject(renamed, { status: 'paused', summary: 'Procedural monoliths', tags: ['3d', '#Unreal'] })
    const m = s().notes.get(renamed)!
    expect(m.meta.status).toBe('paused')
    expect(projectSummary(m)).toBe('Procedural monoliths')
    expect(m.meta.tags).toEqual(['3d', 'unreal'])
    expect(await vault.read('Projects/Monolith Generator.md')).toBe(m.raw)
  })

  it('keeps a folder note in place and a sibling folder bound when renaming', async () => {
    const { s } = await freshStore()
    const vault = new MemoryVaultAdapter([
      ...files(),
      { path: 'Projects/Forge/Forge.md', content: '---\ntype: project\n---\n# Forge\n' },
    ])
    await s().openVault(vault)
    // A folder note: the title changes, the file does not.
    expect(await s().updateProject('Projects/Forge/Forge', { title: 'Concept Forge', renameFile: true })).toBe('Projects/Forge/Forge')
    expect(s().notes.get('Projects/Forge/Forge')!.meta.title).toBe('Concept Forge')
    // A note with a same-named sibling folder moves, and keeps that folder as its home.
    const moved = await s().updateProject('Projects/Portal Game', { title: 'Verdant Gate', renameFile: true })
    expect(moved).toBe('Projects/Verdant Gate')
    const star = s().graph!.nodes[s().graph!.index.get(folderKey('Projects/Portal Game'))!]!
    expect(star.folder?.projectId).toBe('Projects/Verdant Gate')
  })

  it('shows an error instead of throwing when the frontmatter is not valid YAML', async () => {
    const { s } = await freshStore()
    const broken = '---\ntitle: Broken\ntags: [a, b\n---\n# Broken\n'
    const vault = new MemoryVaultAdapter([...files(), { path: 'Projects/Broken.md', content: broken }])
    await s().openVault(vault)
    await expect(s().updateProject('Projects/Broken', { status: 'done' })).resolves.toBe('Projects/Broken')
    expect(s().toasts.some((t) => t.kind === 'error' && /not valid YAML/.test(t.text))).toBe(true)
    expect(await vault.read('Projects/Broken.md')).toBe(broken)
  })

  it('archives and deletes projects from the board without closing it', async () => {
    const { s } = await freshStore()
    const vault = new MemoryVaultAdapter(files())
    await s().openVault(vault)
    const mono = (await s().createProject('Monolith'))!
    s().openNote(mono)
    s().setView('projects')
    s().selectProject(mono)
    await s().archiveProject(mono)
    expect(s().notes.has('Archive/Monolith')).toBe(true)
    expect(s().projectId).toBeNull()
    expect(s().view).toBe('projects')
    // The project note is also open in the (hidden) editor: deleting it closes the editor, not the board.
    const id = 'Projects/Portal Game'
    s().openNote(id, { view: 'projects' })
    s().selectProject(id)
    await s().deleteProject(id)
    expect(await vault.read('Projects/Portal Game.md')).toBeNull()
    expect(s().editorId).toBeNull()
    expect(s().projectId).toBeNull()
    expect(s().view).toBe('projects')
  })

  it('lists projects with isProjectNote: notes inside a project folder are not projects', async () => {
    const { s, listProjects } = await freshStore()
    await s().openVault(new MemoryVaultAdapter(demoVault()))
    expect(s().notes.size).toBe(70)
    const rows = listProjects(s().notes, s().folders)
    const titles = rows.map((r) => r.note.meta.title)
    expect(titles).toContain('PORTALz')
    expect(titles).toContain('ConceptForge')
    for (const r of rows) expect(r.note.meta.path.startsWith('Projects/PORTALz/Art/')).toBe(false)
    const art = [...s().notes.values()].filter((n) => n.meta.path.startsWith('Projects/PORTALz/Art/'))
    expect(art.length).toBeGreaterThan(0)
    for (const n of art) expect(isProjectNote(n)).toBe(false)
    expect(rows.find((r) => r.note.meta.title === 'PORTALz')?.home).toBe('Projects/PORTALz')
  })
})

describe('tasks', () => {
  const texts = (s: () => { notes: Map<string, { raw: string }> }) => extractTasks(s().notes.get('Projects/Portal Game')!.raw).map((t) => t.text)
  const lineOf = (s: () => { notes: Map<string, { raw: string }> }, text: string) =>
    extractTasks(s().notes.get('Projects/Portal Game')!.raw).find((t) => t.text === text)!.line

  it('edits, moves and deletes tasks (with undo), stamping updated in place', async () => {
    const { s } = await freshStore()
    const vault = new MemoryVaultAdapter(files())
    await s().openVault(vault)
    const id = 'Projects/Portal Game'
    const lines = s().notes.get(id)!.raw.split('\n').length

    await s().editTask(id, lineOf(s, 'First'), 'First, sharper')
    expect(texts(s)).toEqual(['First, sharper', 'Second', 'Done one', 'Third'])
    const raw = s().notes.get(id)!.raw
    expect(raw).toContain(`updated: ${todayIso()}`)
    expect(raw.split('\n').length).toBe(lines)
    expect(raw).toContain('- [x] Done one ✅ 2026-01-05')

    // The board shows open and done tasks apart: moving an open task up passes over
    // the done one between them and swaps with the previous open task.
    await s().moveTask(id, lineOf(s, 'Third'), -1)
    expect(texts(s)).toEqual(['First, sharper', 'Third', 'Done one', 'Second'])
    await s().moveTask(id, lineOf(s, 'First, sharper'), -1) // at the edge: no-op
    expect(texts(s)).toEqual(['First, sharper', 'Third', 'Done one', 'Second'])

    await s().deleteTask(id, lineOf(s, 'Second'))
    expect(texts(s)).toEqual(['First, sharper', 'Third', 'Done one'])
    expect(await vault.read('Projects/Portal Game.md')).not.toContain('Second')
    expect(s().toasts.at(-1)?.action?.label).toBe('Undo')
    expect(s().toastAction()).toBe(true)
    await vi.waitFor(() => expect(texts(s)).toEqual(['First, sharper', 'Third', 'Done one', 'Second']))
  })

  it('saves a dirty editor draft first and finds the task the board showed in it', async () => {
    const { s } = await freshStore()
    const vault = new MemoryVaultAdapter(files())
    await s().openVault(vault)
    const id = 'Projects/Portal Game'
    s().openNote(id)
    // The board lists the saved note (the editor is hidden behind it): its line numbers are the saved file's.
    const first = lineOf(s, 'First')
    const second = lineOf(s, 'Second')
    // The unsaved draft adds a task above them, so every line below moves.
    s().setDraft(s().draft!.replace('## To do\n', '## To do\n\n- [ ] Zeroth\n'))
    expect(s().dirty).toBe(true)
    await s().toggleTask(id, first, true)
    expect(s().dirty).toBe(false)
    let tasks = extractTasks(s().notes.get(id)!.raw)
    expect(tasks.find((t) => t.text === 'Zeroth')?.done).toBe(false)
    expect(tasks.find((t) => t.text === 'First')?.done).toBe(true)

    // A task the draft removed is not guessed at: nothing else is touched, the draft is saved.
    s().setDraft(s().draft!.replace('- [ ] Second\n', ''))
    const saved = s().notes.get(id)!.raw
    await s().deleteTask(id, second + 2)
    expect(s().notes.get(id)!.raw).toBe(saved.replace('- [ ] Second\n', ''))
    expect(s().toasts.at(-1)?.kind).toBe('error')
    tasks = extractTasks(s().notes.get(id)!.raw)
    expect(tasks.map((t) => t.text)).toEqual(['Zeroth', 'First', 'Done one', 'Third'])
  })

  it('counts lines in the text the caller showed: the editor preview renders the draft', async () => {
    const { s } = await freshStore()
    await s().openVault(new MemoryVaultAdapter(files()))
    const id = 'Projects/Portal Game'
    s().openNote(id)
    s().setDraft(s().draft!.replace('## To do\n', '## To do\n\n- [ ] Zeroth\n'))
    // The split preview shows the draft, so its checkbox lines are the draft's.
    const draft = s().draft!
    const line = extractTasks(draft).find((t) => t.text === 'Second')!.line
    await s().toggleTask(id, line, true, draft)
    const tasks = extractTasks(s().notes.get(id)!.raw)
    expect(tasks.filter((t) => t.done).map((t) => t.text)).toEqual(['Second', 'Done one'])
    expect(s().dirty).toBe(false)
    // With nothing pending, the caller's text is the saved note itself (the board passes the card's note).
    const saved = s().notes.get(id)!.raw
    await s().editTask(id, extractTasks(saved).find((t) => t.text === 'Third')!.line, 'Third, renamed', saved)
    expect(extractTasks(s().notes.get(id)!.raw).map((t) => t.text)).toEqual(['Zeroth', 'First', 'Second', 'Done one', 'Third, renamed'])
  })

  it('never overwrites a draft that could not be saved', async () => {
    const { s } = await freshStore()
    const vault = new FlakyVault(files())
    await s().openVault(vault)
    const id = 'Projects/Portal Game'
    const before = await vault.read('Projects/Portal Game.md')
    const first = lineOf(s, 'First')
    s().openNote(id)
    const draft = `${s().draft!}\nTyped but not saved.\n`
    s().setDraft(draft)
    vault.failWrites = 1
    await s().toggleTask(id, first, true)
    expect(s().draft).toBe(draft)
    expect(s().dirty).toBe(true)
    expect(await vault.read('Projects/Portal Game.md')).toBe(before)
    vault.failWrites = 1
    expect(await s().moveToArea(id, 'archive')).toBe(id)
    expect(s().draft).toBe(draft)
    expect(await vault.read('Projects/Portal Game.md')).toBe(before)
    vault.failWrites = 1
    expect(await s().updateProject(id, { status: 'done' })).toBe(id)
    expect(s().draft).toBe(draft)
    expect(await vault.read('Projects/Portal Game.md')).toBe(before)
  })
})

/** A memory vault whose next `failWrites` writes throw, like a disk that refuses them. */
class FlakyVault extends MemoryVaultAdapter {
  failWrites = 0
  override async write(path: string, content: string): Promise<void> {
    if (this.failWrites > 0) {
      this.failWrites--
      throw new Error('disk says no')
    }
    return super.write(path, content)
  }
}

describe('existing spellings (Windows and macOS names are case-insensitive)', () => {
  const lower = (): VaultFile[] => [
    { path: 'inbox/Old.md', content: '---\ntype: inbox\nstatus: unprocessed\n---\n# Old\n' },
    { path: 'projects/Portal Game.md', content: PORTAL },
    { path: `daily/${todayIso()}.md`, content: `# ${todayIso()}\n\nAlready written today.\n` },
    { path: 'archive/Gone.md', content: '# Gone\n' },
    { path: 'Resources/Drawing/drawing.md', content: '# drawing\n\nThe folder note, lower case.\n' },
  ]

  it('writes new notes into the folders that exist instead of a second spelling of them', async () => {
    const { s } = await freshStore()
    const vault = new MemoryVaultAdapter(lower(), { folders: ['projects/Portal Game/Art'] })
    await s().openVault(vault)
    expect(await s().capture('Fresh idea')).toBe('inbox/Fresh idea')
    await s().openDaily()
    expect(s().editorId).toBe(`daily/${todayIso()}`)
    expect(s().notes.get(`daily/${todayIso()}`)!.raw).toContain('Already written today.')
    expect(s().notes.has(`Daily/${todayIso()}`)).toBe(false)
    // Same project under another case: not a second file that would replace it on Windows.
    expect(await s().createProject('portal game')).toBe('projects/Portal Game')
    expect([...s().notes.keys()].filter((k) => k.toLowerCase() === 'projects/portal game')).toHaveLength(1)
    expect(await s().createProject('Monolith')).toBe('projects/Monolith')
    expect(await s().moveToArea('inbox/Old', 'archive')).toBe('archive/Old')
    expect(await s().createFolder('Projects/portal game/Levels')).toBe('projects/Portal Game/Levels')
    expect(s().folders.has('Projects/portal game')).toBe(false)
    // The folder's own note already exists in lower case: it becomes the star, no second file.
    expect(await s().makeProject('Resources/Drawing')).toBe('Resources/Drawing/drawing')
    expect(isProjectNote(s().notes.get('Resources/Drawing/drawing')!)).toBe(true)
    expect(s().notes.has('Resources/Drawing/Drawing')).toBe(false)
    expect([...s().folders].filter((f) => f.toLowerCase() === 'inbox')).toEqual(['inbox'])
  })

  it('accepts existing folders whose names a new folder could not have', async () => {
    const { s } = await freshStore()
    await s().openVault(new MemoryVaultAdapter(files(), { folders: ['Resources/Q&A?'] }))
    expect(await s().createFolder('Resources/Q&A?/Answers')).toBe('Resources/Q&A?/Answers')
    expect(await s().createFolder('Resources/Q&A?/Why?')).toBeNull()
  })
})

describe('folders and the system layout', () => {
  it('creates a folder that becomes a planet of the project star and gets selected', async () => {
    const { s } = await freshStore()
    const vault = new MemoryVaultAdapter(files())
    await s().openVault(vault)
    expect(s().settings.layoutMode).toBe('system')
    const path = await s().createFolder('Projects/Portal Game/Levels')
    expect(path).toBe('Projects/Portal Game/Levels')
    expect(await vault.listFolders()).toContain('Projects/Portal Game/Levels')
    expect(s().folders.has('Projects/Portal Game/Levels')).toBe(true)
    const g = s().graph!
    const star = g.nodes[g.index.get(folderKey('Projects/Portal Game'))!]!
    expect(star.folder?.role).toBe('project')
    expect(star.folder?.projectId).toBe('Projects/Portal Game')
    const planet = g.nodes[g.index.get(folderKey('Projects/Portal Game/Levels'))!]!
    expect(planet.kind).toBe('folder')
    expect(planet.parent).toBe(star.id)
    expect(planet.folder?.inProject).toBe(true)
    expect(s().selectedId).toBe(planet.id)
    // The project note orbits its own star.
    expect(g.nodes[g.index.get('Projects/Portal Game')!]!.parent).toBe(star.id)
  })

  it('refuses folder names that are not safe on every OS', async () => {
    const { s } = await freshStore()
    const vault = new MemoryVaultAdapter(files())
    await s().openVault(vault)
    for (const bad of ['Projects/../x', 'Projects/.hidden', 'Projects/a:b', 'Projects/CON', '  ']) {
      expect(await s().createFolder(bad)).toBeNull()
    }
    expect(s().toasts.every((t) => t.kind === 'error')).toBe(true)
    expect(await s().createFolder('Projects/Portal Game/Sketches. ')).toBe('Projects/Portal Game/Sketches')
  })

  it('makes a folder a project with a folder note', async () => {
    const { s } = await freshStore()
    const vault = new MemoryVaultAdapter(files())
    await s().openVault(vault)
    const id = await s().makeProject('Resources/Drawing')
    expect(id).toBe('Resources/Drawing/Drawing')
    expect(isProjectNote(s().notes.get(id!)!)).toBe(true)
    const g = s().graph!
    const star = g.nodes[g.index.get(folderKey('Resources/Drawing'))!]!
    expect(star.folder?.role).toBe('project')
    expect(star.folder?.projectId).toBe(id)
    // Twice is still one project.
    expect(await s().makeProject('Resources/Drawing')).toBe(id)
    expect([...s().notes.keys()].filter((k) => k.startsWith('Resources/Drawing/')).length).toBe(2)
  })

  it('expands folders past the depth limit and remembers it per vault', async () => {
    const { s, storage } = await freshStore()
    await s().openVault(new MemoryVaultAdapter(files(), { folders: ['Deep/a/b'] }))
    s().setFolderDepth(1)
    expect(s().graph!.index.has(folderKey('Deep'))).toBe(true)
    expect(s().graph!.index.has(folderKey('Deep/a'))).toBe(false)
    // Double-click / Enter on a folder: expand + select.
    s().openNote(folderKey('Deep'))
    expect(s().selectedId).toBe(folderKey('Deep'))
    expect(s().graph!.index.has(folderKey('Deep/a'))).toBe(true)
    expect(JSON.parse(storage.getItem('aether:expanded:memory://')!)).toEqual(['Deep'])
    // Tab from a folder walks its parent and children.
    s().cycleNeighbor(1)
    expect(s().hoveredId).toBe(folderKey(''))
    s().toggleFolder('Deep')
    expect(s().graph!.index.has(folderKey('Deep/a'))).toBe(false)
    expect(s().settings.folderDepth).toBe(1)
    s().setFolderDepth(20)
    expect(s().settings.folderDepth).toBe(8)
  })

  it('puts new notes under the first root of a multi-root vault', async () => {
    const { s } = await freshStore()
    const vault = new TwoRoots([
      { path: 'D/Projects/Portal.md', content: '# Portal\n' },
      { path: 'F/Art/Sketch.md', content: '# Sketch\n' },
    ])
    await s().openVault(vault)
    expect(s().roots).toHaveLength(2)
    expect(s().homePrefix()).toBe('D/')
    expect(await s().capture('A new idea\nwith a body')).toBe('D/Inbox/A new idea')
    await s().openDaily()
    expect(s().notes.has(`D/Daily/${todayIso()}`)).toBe(true)
    expect(await s().createProject('Monolith')).toBe('D/Projects/Monolith')
    // Moving keeps the note on its own drive.
    expect(await s().moveToArea('F/Art/Sketch', 'archive')).toBe('F/Archive/Sketch')
    // Drives are the mounts of the system layout.
    const g = s().graph!
    const d = g.nodes[g.index.get(folderKey('D'))!]!
    expect(d.folder?.role).toBe('mount')
    expect(d.title).toBe('D:\\')
    // A folder must live inside a drive.
    expect(await s().createFolder('Loose')).toBeNull()
    expect(await s().createFolder('F/Art/Loose')).toBe('F/Art/Loose')
  })
})

describe('keyboard', () => {
  /** A keydown as the global handler sees it; `target` fakes the focused element. */
  const key = (k: string, target: { tagName: string; role?: string; href?: boolean } = { tagName: 'BODY' }) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: {
      tagName: target.tagName,
      isContentEditable: false,
      getAttribute: (n: string) => (n === 'role' ? (target.role ?? null) : null),
      hasAttribute: (n: string) => n === 'href' && !!target.href,
    },
    preventDefault() {},
    stopPropagation() {},
  })

  it('leaves Enter on a focused button or link to that control', async () => {
    const { s } = await freshStore()
    await s().openVault(new MemoryVaultAdapter(files(), { folders: ['Deep/a/b'] }))
    const { handleKey } = await import('../src/hooks/useKeyboard')
    const press = (k: string, target?: Parameters<typeof key>[1]) => handleKey(key(k, target) as unknown as KeyboardEvent)
    s().setFolderDepth(1)
    s().select(folderKey('Deep'))
    // The inspector's Expand button (or ✕, or a toast's Undo) has focus: its click does the work, not a second toggle.
    press('Enter', { tagName: 'BUTTON' })
    press('Enter', { tagName: 'A', href: true })
    press('Enter', { tagName: 'DIV', role: 'option' })
    expect(s().expandedFolders.has('Deep')).toBe(false)
    // Nothing focused: Enter opens the selection (a folder expands).
    press('Enter')
    expect(s().expandedFolders.has('Deep')).toBe(true)
    // `e` is not a control's key: it works with a button focused.
    press('e', { tagName: 'BUTTON' })
    expect(s().expandedFolders.has('Deep')).toBe(false)
    // Single keys stay out of text fields.
    press('x', { tagName: 'INPUT' })
    expect(s().expandedFolders.has('Deep')).toBe(false)
    press('x')
    expect(s().expandedFolders.has('Deep')).toBe(true)
  })
})

describe('palette commands', () => {
  it('open the in-app forms instead of window.prompt (which Electron does not have)', async () => {
    const { s } = await freshStore()
    vi.stubGlobal('window', {
      prompt: () => {
        throw new Error('prompt() is not supported')
      },
    })
    await s().openVault(new MemoryVaultAdapter(files()))
    const { findCommands } = await import('../src/commands')
    const run = (id: string) => findCommands('', s()).find((c) => c.id === id)!.run(s())

    await run('new-project')
    expect(s().view).toBe('projects')
    expect(s().formRequest).toBe('project')
    s().requestForm(null)

    // From the board, a folder form brings the graph back (the board hides the folder inspector).
    s().select(folderKey('Projects/Portal Game'))
    await run('folder-new')
    expect(s().formRequest).toBe('folder')
    expect(s().view).toBe('graph')
    await run('folder-note')
    expect(s().formRequest).toBe('note')
  })

  it('offers no folder forms on the root of several drives, and no edits in a read-only vault', async () => {
    const { s } = await freshStore()
    const { findCommands } = await import('../src/commands')
    const ids = () => findCommands('', s()).map((c) => c.id)
    await s().openVault(new TwoRoots([{ path: 'D/Notes/a.md', content: '# a\n' }]))
    s().select(folderKey(''))
    expect(ids()).not.toContain('folder-new')
    expect(ids()).not.toContain('folder-note')
    s().select(folderKey('D'))
    expect(ids()).toContain('folder-note')

    await s().openVault(new MemoryVaultAdapter(files(), { readOnly: true }))
    s().select('Inbox/Idea')
    for (const id of ['move-archive', 'status-evergreen', 'delete', 'new-project']) expect(ids()).not.toContain(id)
    expect(ids()).toContain('fly')
  })
})

describe('layout settings', () => {
  it('moves settings written before v2 to the system layout once, then keeps the choice', async () => {
    const old = { colorMode: 'type', layoutMode: 'constellation', bloom: false, hubLabels: true, previewMode: 'split' }
    const first = await freshStore(old)
    expect(first.s().settings.layoutMode).toBe('system')
    expect(first.s().settings.colorMode).toBe('type')
    expect(first.s().settings.bloom).toBe(false)
    expect(first.s().settings.folderDepth).toBe(3)
    expect(first.s().settings.motion).toBe(true)
    expect(JSON.parse(first.storage.getItem('aether:settings')!).v).toBe(2)

    first.s().toggleLayout()
    expect(first.s().settings.layoutMode).toBe('constellation')
    const second = await freshStore(first.storage.getItem('aether:settings')!)
    expect(second.s().settings.layoutMode).toBe('constellation')
  })

  it('cycles constellation → orbit → system, with folder nodes only in the system layout', async () => {
    const { s } = await freshStore()
    await s().openVault(new MemoryVaultAdapter(files()))
    const folderNodes = () => s().graph!.nodes.filter((n) => n.kind === 'folder').length
    expect(s().settings.layoutMode).toBe('system')
    expect(folderNodes()).toBeGreaterThan(0)
    s().select(folderKey('Projects/Portal Game'))

    s().toggleLayout()
    expect(s().settings.layoutMode).toBe('constellation')
    expect(s().controller.layoutMode).toBe('constellation')
    expect(folderNodes()).toBe(0)
    expect(s().graph!.folderSelection).toBeNull()
    // The project star's selection falls back to its project note.
    expect(s().selectedId).toBe('Projects/Portal Game')
    expect(s().toasts.at(-1)?.text).toMatch(/Constellation/)

    s().toggleLayout()
    expect(s().settings.layoutMode).toBe('orbit')
    expect(folderNodes()).toBe(0)

    s().toggleLayout()
    expect(s().settings.layoutMode).toBe('system')
    expect(s().controller.layoutMode).toBe('system')
    expect(folderNodes()).toBeGreaterThan(0)

    s().toggleMotion()
    expect(s().settings.motion).toBe(false)
    expect(s().controller.motion).toBe(false)
  })
})
