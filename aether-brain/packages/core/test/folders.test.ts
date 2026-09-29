import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MemoryVaultAdapter,
  buildGraph,
  isProjectNote,
  loadVault,
  parseNote,
  selectFolders,
  type GraphData,
  type GraphNode,
  type NoteId,
  type ParsedNote,
  type VaultFile,
} from '../src'

function notesOf(files: { path: string; content: string }[]): Map<NoteId, ParsedNote> {
  const out = new Map<NoteId, ParsedNote>()
  for (const f of files) {
    const n = parseNote(f)
    out.set(n.meta.id, n)
  }
  return out
}

function node(graph: GraphData, id: string): GraphNode {
  const i = graph.index.get(id)
  const n = i === undefined ? undefined : graph.nodes[i]
  if (!n) throw new Error(`no node ${id}`)
  return n
}

describe('selectFolders', () => {
  it('shows folders down to maxDepth and counts the hidden ones', () => {
    const s = selectFolders(['a', 'a/b', 'a/b/c', 'a/b/c/d', 'z/'], [], { multiRoot: false })
    expect([...s.visible]).toEqual(['', 'a', 'a/b', 'a/b/c', 'z'])
    expect(s.hidden.get('a/b/c')).toBe(1)
    expect(s.hidden.get('a')).toBe(0)
    expect(s.childCount.get('')).toBe(2)
    expect(s.childCount.get('a/b/c')).toBe(1)
    expect(s.childCount.get('a/b/c/d')).toBe(0)
    expect(s.hidden.has('a/b/c/d')).toBe(false)
    expect(s.dropped).toBe(0)
  })

  it('always shows every note folder chain, however deep', () => {
    const s = selectFolders(['x', 'y'], ['x/y/z/w/Note.md', 'Top.md'], { multiRoot: false, maxDepth: 0 })
    expect([...s.visible]).toEqual(['', 'x', 'x/y', 'x/y/z', 'x/y/z/w'])
    expect(s.hidden.get('')).toBe(1)
    expect(s.dropped).toBe(0)
  })

  it('shows pinned folders with their ancestors, even when not listed', () => {
    const s = selectFolders([], [], { multiRoot: false, maxDepth: 0, pinned: ['p/q/r/s/'] })
    expect([...s.visible]).toEqual(['', 'p', 'p/q', 'p/q/r', 'p/q/r/s'])
  })

  it('shows the direct children of expanded folders', () => {
    const all = ['a', 'a/b', 'a/b/c', 'a/b/c/d1', 'a/b/c/d2', 'a/b/c/d1/e']
    const collapsed = selectFolders(all, [], { multiRoot: false, maxDepth: 1 })
    expect([...collapsed.visible]).toEqual(['', 'a'])
    expect(collapsed.hidden.get('a')).toBe(1)
    const s = selectFolders(all, [], { multiRoot: false, maxDepth: 1, expanded: ['a/b/c'] })
    expect([...s.visible]).toEqual(['', 'a', 'a/b', 'a/b/c', 'a/b/c/d1', 'a/b/c/d2'])
    expect(s.hidden.get('a/b/c/d1')).toBe(1)
    expect(s.hidden.get('a/b/c')).toBe(0)
  })

  it('always shows every mount in a multi-root vault', () => {
    const s = selectFolders(['D', 'D/Games', 'F', 'F/Art', 'G'], ['F/Art/x.md'], { multiRoot: true, maxDepth: 0 })
    expect([...s.visible]).toEqual(['', 'D', 'F', 'F/Art', 'G'])
    expect(s.hidden.get('D')).toBe(1)
    expect(s.dropped).toBe(0)
  })

  it('caps optional folders breadth-first, alphabetically, and counts the dropped ones', () => {
    const all = ['c', 'a', 'b', 'a/x', 'b/y']
    const s = selectFolders(all, [], { multiRoot: false, maxFolders: 2 })
    expect([...s.visible]).toEqual(['', 'a', 'b'])
    expect(s.dropped).toBe(3)
    expect(s.hidden.get('')).toBe(1)
    expect(s.hidden.get('a')).toBe(1)
    // Must-show folders never count against the cap.
    const withNote = selectFolders(all, ['c/n.md', 'b/y/m.md'], { multiRoot: false, maxFolders: 1 })
    expect([...withNote.visible]).toEqual(['', 'a', 'b', 'b/y', 'c'])
    expect(withNote.dropped).toBe(1)
    const none = selectFolders(all, [], { multiRoot: false, maxFolders: 0 })
    expect([...none.visible]).toEqual([''])
    expect(none.dropped).toBe(5)
  })

  it('is independent of input order', () => {
    const a = selectFolders(['b', 'a/c', 'a'], ['a/c/n.md'], { multiRoot: false })
    const b = selectFolders(['a', 'b', 'a/c'], ['a/c/n.md'], { multiRoot: false })
    expect([...a.visible]).toEqual([...b.visible])
    expect([...a.hidden]).toEqual([...b.hidden])
    expect([...a.childCount]).toEqual([...b.childCount])
  })
})

const SINGLE = [
  { path: 'Home.md', content: '# Home\n\nStart at [[PORTALz]]. Someday: [[Missing Thing]].\n' },
  {
    path: 'Projects/PORTALz.md',
    content: '---\ntitle: PORTALz\ntype: project\ntags: [gamedev]\n---\n# PORTALz\n\n> The portal game.\n\nSee [[Art Bible]].\n',
  },
  { path: 'Projects/PORTALz/Art/Art Bible.md', content: '# Art Bible\n\nFor [[PORTALz]]. Also [[Nowhere]] and [[Missing Thing]].\n' },
  { path: 'Projects/ConceptForge/ConceptForge.md', content: '# ConceptForge\n\n> Drills.\n' },
  { path: 'Projects/ConceptForge/Drills/Gesture.md', content: '---\ntype: note\n---\n# Gesture\n\n[[ConceptForge]]\n' },
  { path: 'Projects/Alpha.md', content: '---\ntype: project\nfolder: Work/Alpha/\n---\n# Alpha\n' },
  { path: 'Projects/Beta.md', content: '---\ntype: project\nfolder: Nope/Missing\n---\n# Beta\n' },
  { path: 'Resources/Drawing/Value.md', content: '---\ntags: [drawing]\n---\n# Value\n' },
]
const SINGLE_FOLDERS = [
  'Projects',
  'Projects/PORTALz',
  'Projects/PORTALz/Art',
  'Projects/PORTALz/Tech',
  'Projects/ConceptForge',
  'Projects/ConceptForge/Drills',
  'Resources',
  'Resources/Drawing',
  'Work',
  'Work/Alpha',
  'Empty/Deep/Deeper/Deepest',
]

describe('buildGraph with folders', () => {
  const notes = notesOf(SINGLE)
  const classic = buildGraph(notesOf(SINGLE))
  const graph = buildGraph(notes, { folders: { multiRoot: false, all: SINGLE_FOLDERS, rootTitle: 'My Vault' } })

  it('leaves the classic graph alone apart from kind / parent / folderSelection', () => {
    expect(classic.folderSelection).toBeNull()
    expect(classic.nodes.every((n) => n.parent === null && n.folder === undefined)).toBe(true)
    expect(classic.nodes.filter((n) => n.kind === 'ghost').map((n) => n.id)).toEqual(['ghost:Missing Thing', 'ghost:Nowhere'])
    expect(classic.nodes.every((n) => n.ghost === (n.kind === 'ghost'))).toBe(true)
    // Same notes, ghosts, edges and counts with folders on.
    const strip = ({ parent: _p, ...rest }: GraphNode) => rest
    expect(graph.nodes.filter((n) => n.kind !== 'folder').map(strip)).toEqual(classic.nodes.map(strip))
    expect(graph.edges).toEqual(classic.edges)
    expect(graph.orphans).toEqual(classic.orphans)
    expect(graph.tagCounts).toEqual(classic.tagCounts)
    expect(graph.areaCounts).toEqual(classic.areaCounts)
    expect(graph.backlinks).toEqual(classic.backlinks)
    expect(graph.outlinks).toEqual(classic.outlinks)
    expect([...graph.backlinks.keys()].some((id) => id.startsWith('folder:'))).toBe(false)
  })

  it('appends folder nodes after ghosts, sorted by path, with stable ids', () => {
    const kinds = graph.nodes.map((n) => n.kind)
    expect(kinds.indexOf('folder')).toBe(classic.nodes.length)
    expect(kinds.slice(classic.nodes.length).every((k) => k === 'folder')).toBe(true)
    const folders = graph.nodes.filter((n) => n.kind === 'folder').map((n) => n.id)
    expect(folders).toEqual([
      'folder:',
      'folder:Empty',
      'folder:Empty/Deep',
      'folder:Empty/Deep/Deeper',
      'folder:Projects',
      'folder:Projects/ConceptForge',
      'folder:Projects/ConceptForge/Drills',
      'folder:Projects/PORTALz',
      'folder:Projects/PORTALz/Art',
      'folder:Projects/PORTALz/Tech',
      'folder:Resources',
      'folder:Resources/Drawing',
      'folder:Work',
      'folder:Work/Alpha',
    ])
    for (const [id, i] of graph.index) expect(graph.nodes[i]?.id).toBe(id)
    const again = buildGraph(notesOf([...SINGLE].reverse()), {
      folders: { multiRoot: false, all: [...SINGLE_FOLDERS].reverse(), rootTitle: 'My Vault' },
    })
    expect(again.nodes.map((n) => [n.id, n.parent])).toEqual(graph.nodes.map((n) => [n.id, n.parent]))
  })

  it('builds root, project and plain folder nodes', () => {
    const root = node(graph, 'folder:')
    expect(root).toMatchObject({ title: 'My Vault', kind: 'folder', ghost: false, parent: null, type: 'moc', area: 'untagged', tags: [] })
    expect(root.folder).toMatchObject({ path: '', role: 'root', depth: 0, projectId: null, inProject: false, totalNotes: 8, notes: 1 })
    expect(root.folder?.childFolders).toBe(4)

    const star = node(graph, 'folder:Projects/PORTALz')
    expect(star).toMatchObject({ title: 'PORTALz', type: 'project', area: 'projects', parent: 'folder:Projects', degree: 0 })
    expect(star.folder).toMatchObject({ role: 'project', depth: 2, projectId: 'Projects/PORTALz', inProject: false })
    expect(star.folder).toMatchObject({ childFolders: 2, hiddenFolders: 0, notes: 0, totalNotes: 1 })

    const planet = node(graph, 'folder:Projects/PORTALz/Art')
    expect(planet).toMatchObject({ title: 'Art', type: 'moc', area: 'projects', parent: 'folder:Projects/PORTALz' })
    expect(planet.folder).toMatchObject({ role: 'folder', depth: 3, projectId: null, inProject: true, notes: 1, totalNotes: 1 })

    const cf = node(graph, 'folder:Projects/ConceptForge')
    expect(cf.folder).toMatchObject({ role: 'project', projectId: 'Projects/ConceptForge/ConceptForge', notes: 1, totalNotes: 2 })
    expect(node(graph, 'folder:Projects').folder).toMatchObject({ role: 'folder', inProject: false, notes: 3, totalNotes: 6 })
    expect(node(graph, 'folder:Resources/Drawing').area).toBe('resources')
    expect(node(graph, 'folder:Work').area).toBe('untagged')
  })

  it('binds an explicit folder, and skips project folders that do not exist', () => {
    expect(node(graph, 'folder:Work/Alpha').folder).toMatchObject({ role: 'project', projectId: 'Projects/Alpha' })
    expect(node(graph, 'Projects/Alpha').parent).toBe('folder:Work/Alpha')
    expect(graph.index.has('folder:Nope/Missing')).toBe(false)
    expect(node(graph, 'Projects/Beta').parent).toBe('folder:Projects')
  })

  it('parents notes to their folder, project notes to their star, ghosts to the first linking note', () => {
    expect(node(graph, 'Home').parent).toBe('folder:')
    expect(node(graph, 'Projects/PORTALz').parent).toBe('folder:Projects/PORTALz')
    expect(node(graph, 'Projects/PORTALz/Art/Art Bible').parent).toBe('folder:Projects/PORTALz/Art')
    expect(node(graph, 'Projects/ConceptForge/ConceptForge').parent).toBe('folder:Projects/ConceptForge')
    expect(node(graph, 'Projects/ConceptForge/Drills/Gesture').parent).toBe('folder:Projects/ConceptForge/Drills')
    expect(node(graph, 'ghost:Missing Thing').parent).toBe('Home')
    expect(node(graph, 'ghost:Nowhere').parent).toBe('Projects/PORTALz/Art/Art Bible')
    expect(node(graph, 'folder:Projects/PORTALz/Tech').parent).toBe('folder:Projects/PORTALz')
    for (const n of graph.nodes) if (n.parent !== null) expect(graph.index.has(n.parent)).toBe(true)
  })

  it('collapses folders below maxDepth and reports them as hidden', () => {
    expect(graph.index.has('folder:Empty/Deep/Deeper/Deepest')).toBe(false)
    expect(node(graph, 'folder:Empty/Deep/Deeper').folder).toMatchObject({ childFolders: 1, hiddenFolders: 1, totalNotes: 0 })
    expect(graph.folderSelection?.visible.has('Empty/Deep/Deeper')).toBe(true)
    const shallow = buildGraph(notes, { folders: { multiRoot: false, all: SINGLE_FOLDERS, rootTitle: 'V', maxDepth: 1 } })
    // Tech holds no notes and sits below depth 1, but it is a planet of the
    // PORTALz star, and a star always shows its planets.
    expect(node(shallow, 'folder:Projects/PORTALz/Tech').parent).toBe('folder:Projects/PORTALz')
    expect(node(shallow, 'folder:Projects/PORTALz').folder?.hiddenFolders).toBe(0)
    expect(shallow.index.has('folder:Work/Alpha')).toBe(true)
    expect(shallow.index.has('folder:Empty/Deep')).toBe(false)
    const expanded = buildGraph(notes, {
      folders: { multiRoot: false, all: SINGLE_FOLDERS, rootTitle: 'V', maxDepth: 1, expanded: ['Empty'] },
    })
    expect(node(expanded, 'folder:Empty/Deep').parent).toBe('folder:Empty')
  })

  it('omits ghosts cleanly with ghosts: false', () => {
    const g = buildGraph(notes, { ghosts: false, folders: { multiRoot: false, all: [], rootTitle: 'V' } })
    expect(g.nodes.some((n) => n.kind === 'ghost')).toBe(false)
    expect(node(g, 'folder:Projects/PORTALz/Art').parent).toBe('folder:Projects/PORTALz')
    // Tech is not in `all` any more, so the sibling rule still finds PORTALz/ through its notes.
    expect(g.index.has('folder:Projects/PORTALz/Tech')).toBe(false)
  })
})

describe('buildGraph with folders, multi-root', () => {
  const files = [
    { path: 'D/Projects/PORTALz.md', content: '# PORTALz\n\n> Game.\n\n[[Sketch]]\n' },
    { path: 'D/Projects/PORTALz/Art/Sketch.md', content: '---\ntype: note\n---\n# Sketch\n' },
    { path: 'F/Notes/Idea.md', content: '# Idea\n\n[[Sketch]] [[Later]]\n' },
  ]
  const all = ['D', 'D/Projects', 'D/Projects/PORTALz', 'D/Projects/PORTALz/Art', 'F', 'F/Notes', 'F/Games', 'F/Games/Old', 'G']
  const graph = buildGraph(notesOf(files), {
    folders: { multiRoot: true, all, rootTitle: 'Drives', mountLabels: { D: 'D:\\', F: 'F:\\' }, maxDepth: 1 },
  })

  it('makes mounts from top-level folders, labelled, always shown', () => {
    expect(node(graph, 'folder:').folder?.role).toBe('root')
    expect(node(graph, 'folder:D')).toMatchObject({ title: 'D:\\', parent: 'folder:' })
    expect(node(graph, 'folder:D').folder).toMatchObject({ role: 'mount', depth: 1, totalNotes: 2 })
    expect(node(graph, 'folder:G')).toMatchObject({ title: 'G', parent: 'folder:' })
    expect(node(graph, 'folder:G').folder).toMatchObject({ role: 'mount', totalNotes: 0, childFolders: 0 })
    expect(node(graph, 'folder:F').folder).toMatchObject({ childFolders: 2, hiddenFolders: 1 })
    expect(graph.index.has('folder:F/Games')).toBe(false)
  })

  it('finds projects under <mount>/Projects and parents notes into the system', () => {
    expect(node(graph, 'folder:D/Projects').area).toBe('projects')
    const star = node(graph, 'folder:D/Projects/PORTALz')
    expect(star.folder).toMatchObject({ role: 'project', projectId: 'D/Projects/PORTALz', depth: 3 })
    expect(node(graph, 'D/Projects/PORTALz').parent).toBe('folder:D/Projects/PORTALz')
    expect(node(graph, 'D/Projects/PORTALz/Art/Sketch').parent).toBe('folder:D/Projects/PORTALz/Art')
    expect(node(graph, 'folder:D/Projects/PORTALz/Art').folder?.inProject).toBe(true)
    expect(node(graph, 'F/Notes/Idea').parent).toBe('folder:F/Notes')
    expect(node(graph, 'ghost:Later').parent).toBe('F/Notes/Idea')
    expect(graph.edges).toHaveLength(3)
  })
})

describe('buildGraph with folders, deep project stars', () => {
  it('shows a project star\'s planets (direct subfolders) at any depth, even empty ones', () => {
    const files = [{ path: 'F/Lunco/PORTALz/PORTALz.md', content: '---\ntype: project\n---\n# PORTALz\n' }]
    const all = ['F', 'F/Lunco', 'F/Lunco/PORTALz', 'F/Lunco/PORTALz/Content', 'F/Lunco/PORTALz/Content/Maps', 'F/Lunco/PORTALz/Docs', 'F/Other']
    const graph = buildGraph(notesOf(files), { folders: { multiRoot: true, all, rootTitle: 'Drives', maxDepth: 1 } })
    expect(node(graph, 'folder:F/Lunco/PORTALz').folder).toMatchObject({ role: 'project', depth: 3, hiddenFolders: 0 })
    // Planets: shown although deeper than maxDepth and without notes.
    expect(node(graph, 'folder:F/Lunco/PORTALz/Content').parent).toBe('folder:F/Lunco/PORTALz')
    expect(node(graph, 'folder:F/Lunco/PORTALz/Docs').folder?.inProject).toBe(true)
    // Their own subfolders (moons) still follow the depth rule.
    expect(graph.index.has('folder:F/Lunco/PORTALz/Content/Maps')).toBe(false)
    expect(node(graph, 'folder:F/Lunco/PORTALz/Content').folder?.hiddenFolders).toBe(1)
    expect(graph.index.has('folder:F/Other')).toBe(false)
  })
})

describe('buildGraph with folders, edge cases', () => {
  it('keeps an index note named after the Projects folder from swallowing every project', () => {
    const g = buildGraph(
      notesOf([
        { path: 'Projects/Projects.md', content: '# Projects\n\n[[PORTALz]]\n' },
        { path: 'Projects/PORTALz.md', content: '# PORTALz\n' },
        { path: 'Projects/PORTALz/Art/Sketch.md', content: '# Sketch\n' },
      ]),
      { folders: { multiRoot: false, all: ['Projects', 'Projects/PORTALz', 'Projects/PORTALz/Art'], rootTitle: 'V' } },
    )
    expect(node(g, 'folder:Projects').folder).toMatchObject({ role: 'folder', projectId: null })
    expect(node(g, 'folder:Projects/PORTALz').folder).toMatchObject({ role: 'project', inProject: false })
    expect(node(g, 'Projects/Projects').parent).toBe('folder:Projects')
  })

  it('labels mounts from own keys only', () => {
    const g = buildGraph(notesOf([{ path: 'constructor/x.md', content: '# x\n' }]), {
      folders: { multiRoot: true, all: ['constructor', 'toString'], rootTitle: 'V', mountLabels: { D: 'D:\\' } },
    })
    expect(node(g, 'folder:constructor').title).toBe('constructor')
    expect(node(g, 'folder:toString').title).toBe('toString')
    expect(node(g, 'constructor/x')).toMatchObject({ area: 'untagged', type: 'note' })
  })
})

describe('demo vault as a solar system', () => {
  const root = fileURLToPath(new URL('../../../vault-demo', import.meta.url))
  const walk = (dir: string): VaultFile[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : e.name.endsWith('.md')
          ? [{ path: relative(root, join(dir, e.name)).split('\\').join('/'), content: readFileSync(join(dir, e.name), 'utf8') }]
          : [],
    )

  it('gives PORTALz and ConceptForge stars with planets, and every planet note links home', async () => {
    const { notes, graph } = await loadVault(new MemoryVaultAdapter(walk(root)), undefined, undefined, (folders) => ({
      folders: { multiRoot: false, all: folders, rootTitle: 'Demo vault' },
    }))
    const planets = (star: string) => graph.nodes.filter((n) => n.parent === `folder:${star}` && n.kind === 'folder').map((n) => n.title)
    expect(node(graph, 'folder:Projects/PORTALz').folder).toMatchObject({ role: 'project', projectId: 'Projects/PORTALz' })
    expect(planets('Projects/PORTALz')).toEqual(['Art', 'Design', 'Tech'])
    expect(node(graph, 'folder:Projects/ConceptForge').folder).toMatchObject({ role: 'project', projectId: 'Projects/ConceptForge' })
    expect(planets('Projects/ConceptForge')).toEqual(['Critique', 'Drills', 'References'])
    const inside = [...notes.values()].filter((n) => /^Projects\/(PORTALz|ConceptForge)\//.test(n.meta.path))
    expect(inside.length).toBeGreaterThanOrEqual(6)
    for (const n of inside) {
      expect(isProjectNote(n)).toBe(false)
      expect(n.meta.type).not.toBe('project')
      expect(n.links.filter((l) => !l.resolved).map((l) => l.raw)).toEqual([])
      const project = n.meta.path.split('/')[1] ?? ''
      expect(graph.outlinks.get(n.meta.id)?.has(`Projects/${project}`)).toBe(true)
    }
  })
})
