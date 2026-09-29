import { describe, expect, it } from 'vitest'
import {
  MemoryVaultAdapter,
  SearchIndex,
  ancestorsOf,
  applyChanges,
  areaFromFolder,
  buildGraph,
  dailyNote,
  findUnlinkedMentions,
  folderKey,
  folderPathOf,
  generateSyntheticVault,
  homePrefix,
  inboxNote,
  isBoilerplateMarkdown,
  isFolderId,
  isIgnoredPath,
  loadVault,
  mountOf,
  neighborhood,
  parseNote,
  splitFrontmatter,
  tokenizeWikilinks,
  updateFrontmatter,
  type VaultChange,
  type VaultFile,
} from '../src'

const VAULT = [
  {
    path: 'Resources/Drawing/Value Structure.md',
    content: `---
title: Value Structure
type: concept
tags: [drawing, fundamentals]
created: 2025-04-02
updated: 2026-01-10
status: evergreen
aliases: [Values]
---

# Value Structure

Squint. See [[Composition]] and [[Gesture Drawing|gesture]] and [[Bloom Post-Processing#Selective Bloom]].

## Three-Value Rule

Keep it to three. #drawing #color

## Squint Test

\`\`\`ts
const x = "[[not a link]] #not-a-tag"
\`\`\`

Inline \`[[also not a link]]\` here. ![[Composition]]
`,
  },
  {
    path: 'Resources/Drawing/Composition.md',
    content: `---
title: Composition
tags: drawing
---
# Composition

Value structure matters. Also values matter. Link back to [[Values]] and to [[Ghost Note]].
`,
  },
  {
    path: 'Resources/Drawing/Gesture Drawing.md',
    content: `# Gesture Drawing\n\nNo frontmatter. Links to [[Resources/Drawing/Composition]].\n`,
  },
  {
    path: 'Resources/Graphics/Bloom Post-Processing.md',
    content: `---\ntitle: Bloom Post-Processing\n---\n# Bloom\n\n## Selective Bloom\n\nOnly bright things.\n`,
  },
  { path: 'Daily/2026-09-16.md', content: `# 2026-09-16\n\nWorked on Value Structure today.\n` },
  { path: 'Archive/Orphan.md', content: `---\ntitle: Orphan\n---\n# Orphan\n\nNobody links here.\n` },
  { path: '.obsidian/workspace.md', content: 'ignored' },
]

describe('frontmatter', () => {
  it('splits and parses yaml', () => {
    const r = splitFrontmatter(VAULT[0]!.content)
    expect(r.hasFrontmatter).toBe(true)
    expect(r.frontmatter['title']).toBe('Value Structure')
    expect(r.frontmatter['tags']).toEqual(['drawing', 'fundamentals'])
    expect(r.body.startsWith('\n# Value Structure')).toBe(true)
  })
  it('tolerates missing and broken frontmatter', () => {
    expect(splitFrontmatter('# Hi').hasFrontmatter).toBe(false)
    const broken = splitFrontmatter('---\ntitle: [unclosed\n---\n# Hi')
    expect(broken.hasFrontmatter).toBe(true)
    expect(broken.frontmatter).toEqual({})
  })
  it('recognizes an empty frontmatter block', () => {
    expect(splitFrontmatter('---\n---\n# Hi\n')).toEqual({ frontmatter: {}, body: '# Hi\n', bodyOffset: 8, hasFrontmatter: true })
    expect(splitFrontmatter('---\r\n...\r\nBody').body).toBe('Body')
    expect(parseNote({ path: 'x.md', content: '---\n---\n# Hi\n' }).body).toBe('# Hi\n')
  })
  it('updates keys while preserving the body', () => {
    const out = updateFrontmatter('---\ntitle: A\nstatus: seedling\n---\n\n# A\n\nbody', { status: 'evergreen', tags: ['x'] })
    expect(out).toContain('status: evergreen')
    expect(out).toContain('tags: [x]')
    expect(out.endsWith('# A\n\nbody')).toBe(true)
  })
})

describe('wikilinks', () => {
  it('tokenizes all forms', () => {
    const t = tokenizeWikilinks('a [[B]] c [[D|alias]] e [[F#Head]] g ![[H]] [[I#J|K]]')
    expect(t.map((x) => x.target)).toEqual(['B', 'D', 'F', 'H', 'I'])
    expect(t[1]!.alias).toBe('alias')
    expect(t[2]!.heading).toBe('Head')
    expect(t[3]!.embed).toBe(true)
    expect(t[4]).toMatchObject({ heading: 'J', alias: 'K' })
  })
})

describe('parseNote', () => {
  const note = parseNote(VAULT[0]!)
  it('derives meta', () => {
    expect(note.meta.id).toBe('Resources/Drawing/Value Structure')
    expect(note.meta.area).toBe('resources')
    expect(note.meta.type).toBe('concept')
    expect(note.meta.tags).toEqual(['drawing', 'fundamentals', 'color'])
    expect(note.meta.headings.map((h) => h.text)).toEqual(['Value Structure', 'Three-Value Rule', 'Squint Test'])
    expect(note.meta.aliases).toEqual(['Values'])
    expect(note.meta.wordCount).toBeGreaterThan(10)
  })
  it('ignores links and tags inside code', () => {
    expect(note.links.map((l) => l.raw)).toEqual([
      'Composition',
      'Gesture Drawing|gesture',
      'Bloom Post-Processing#Selective Bloom',
      'Composition',
    ])
    expect(note.links[3]!.kind).toBe('embed')
    expect(note.links[2]!.heading).toBe('selective bloom')
    expect(note.meta.tags).not.toContain('not-a-tag')
  })
  it('falls back to H1 then filename for titles + folder for type', () => {
    const g = parseNote(VAULT[2]!)
    expect(g.meta.title).toBe('Gesture Drawing')
    const d = parseNote(VAULT[4]!)
    expect(d.meta.type).toBe('daily')
    expect(d.meta.area).toBe('untagged')
  })
})

describe('graph', () => {
  it('resolves by title, alias, path; creates ghosts; finds orphans', async () => {
    const vault = new MemoryVaultAdapter(VAULT)
    const { notes, graph } = await loadVault(vault)
    expect(notes.size).toBe(6)
    const vs = 'Resources/Drawing/Value Structure'
    expect(graph.outlinks.get(vs)).toEqual(
      new Set(['Resources/Drawing/Composition', 'Resources/Drawing/Gesture Drawing', 'Resources/Graphics/Bloom Post-Processing']),
    )
    expect(graph.backlinks.get(vs)).toEqual(new Set(['Resources/Drawing/Composition']))
    expect(graph.outlinks.get('Resources/Drawing/Gesture Drawing')).toEqual(new Set(['Resources/Drawing/Composition']))
    expect(graph.unresolved.has('ghost:Ghost Note')).toBe(true)
    const ghost = graph.nodes.find((n) => n.ghost)
    expect(ghost?.title).toBe('Ghost Note')
    expect(graph.orphans).toEqual(['Archive/Orphan', 'Daily/2026-09-16'])
    const edge = graph.edges.find((e) => e.from === vs && e.to === 'Resources/Drawing/Composition')
    expect(edge?.weight).toBe(1)
    expect(graph.edges.find((e) => e.from === vs && e.to === 'Resources/Drawing/Composition' && e.kind === 'embed')?.weight).toBe(1)
    expect(neighborhood(graph, vs, 1).size).toBe(4)
    expect(graph.nodes.find((n) => n.id === vs)?.degree).toBe(4)
    // Classic graphs: kind set, no structural parents, no folder selection.
    expect(graph.nodes.map((n) => n.kind)).toEqual([...Array(6).fill('note'), 'ghost'])
    expect(graph.nodes.every((n) => n.parent === null)).toBe(true)
    expect(graph.folderSelection).toBeNull()
  })

  it('finds unlinked mentions', async () => {
    const { notes, graph } = await loadVault(new MemoryVaultAdapter(VAULT))
    const m = findUnlinkedMentions(notes, graph, 'Resources/Drawing/Value Structure')
    expect(m.map((x) => x.id)).toEqual(['Daily/2026-09-16'])
  })

  it('applies changes incrementally and un-ghosts', async () => {
    const vault = new MemoryVaultAdapter(VAULT)
    const loaded = await loadVault(vault)
    const next = applyChanges(
      loaded.notes,
      [{ kind: 'add', path: 'Inbox/Ghost Note.md', content: '# Ghost Note\n\nnow real, links [[Composition]]' }],
      loaded.search,
    )
    expect(next.notes.size).toBe(7)
    expect(next.graph.nodes.some((n) => n.ghost)).toBe(false)
    expect(next.graph.backlinks.get('Inbox/Ghost Note')).toEqual(new Set(['Resources/Drawing/Composition']))
    const removed = applyChanges(next.notes, [{ kind: 'unlink', path: 'Inbox/Ghost Note.md' }], loaded.search)
    expect(removed.graph.nodes.some((n) => n.ghost)).toBe(true)
  })

  it('handles a 1000-node synthetic vault quickly', async () => {
    const files = generateSyntheticVault(1000, 2500)
    const t0 = performance.now()
    const { graph } = await loadVault(new MemoryVaultAdapter(files))
    const dt = performance.now() - t0
    expect(graph.nodes.length).toBeGreaterThanOrEqual(1000)
    expect(graph.edges.length).toBeGreaterThan(2000)
    expect(dt).toBeLessThan(5000)
  })
})

describe('search', () => {
  it('finds by title, tag, body and path', async () => {
    const { search } = await loadVault(new MemoryVaultAdapter(VAULT))
    expect(search.search('value')[0]?.id).toBe('Resources/Drawing/Value Structure')
    expect(search.search('fundamentals').map((h) => h.id)).toContain('Resources/Drawing/Value Structure')
    expect(search.search('nobody links')[0]?.id).toBe('Archive/Orphan')
    expect(search.search('graphics').map((h) => h.id)).toContain('Resources/Graphics/Bloom Post-Processing')
    expect(search.suggestTitles('comp')[0]?.title).toBe('Composition')
  })
})

describe('templates', () => {
  it('builds an inbox note from a capture', () => {
    const n = inboxNote({ text: '# Portal hum\n\nUse a low drone.' }, new Date('2026-09-23T10:00:00Z'))
    expect(n.path).toBe('Inbox/Portal hum.md')
    const parsed = parseNote({ path: n.path, content: n.content })
    expect(parsed.meta.title).toBe('Portal hum')
    expect(parsed.meta.type).toBe('inbox')
    expect(parsed.meta.status).toBe('unprocessed')
    expect(parsed.body).toContain('Use a low drone.')
  })
  it('builds a daily note', () => {
    const d = dailyNote('2026-09-24', '2026-09-23')
    expect(d.path).toBe('Daily/2026-09-24.md')
    expect(parseNote({ path: d.path, content: d.content }).links[0]?.raw).toBe('2026-09-23')
  })
})

describe('search index sync', () => {
  it('upserts and removes', () => {
    const idx = new SearchIndex()
    idx.upsert(parseNote({ path: 'A.md', content: '# Alpha\n\nzebra' }))
    expect(idx.search('zebra')).toHaveLength(1)
    idx.upsert(parseNote({ path: 'A.md', content: '# Alpha\n\nyak' }))
    expect(idx.search('zebra')).toHaveLength(0)
    expect(idx.search('yak')).toHaveLength(1)
    idx.remove('A')
    expect(idx.size).toBe(0)
  })
})

describe('paths', () => {
  it('derives the area from the first two folder segments only', () => {
    expect(areaFromFolder('Projects/x.md')).toBe('projects')
    expect(areaFromFolder('D/Projects/x.md')).toBe('projects')
    expect(areaFromFolder('D/1 Projects/Sub/x.md')).toBe('projects')
    expect(areaFromFolder('a/b/Projects/x.md')).toBeNull()
    expect(areaFromFolder('Resources/Archive/x.md')).toBe('resources')
    expect(areaFromFolder('Projects.md')).toBeNull()
    expect(areaFromFolder('x.md')).toBeNull()
    expect(parseNote({ path: 'F/Resources/Drawing/Value.md', content: '# Value' }).meta.area).toBe('resources')
  })

  it('never takes a folder named like an Object.prototype key for an area or type', () => {
    expect(areaFromFolder('Notes/constructor/x.md')).toBeNull()
    expect(areaFromFolder('toString/x.md')).toBeNull()
    const n = parseNote({ path: 'D/constructor/valueOf/__proto__/hasOwnProperty/x.md', content: '# X' })
    expect(n.meta.area).toBe('untagged')
    expect(n.meta.type).toBe('note')
  })

  it('recognizes repo boilerplate exactly and ignores it', () => {
    for (const name of ['LICENSE.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'PULL_REQUEST_TEMPLATE.md', 'NOTICE.md']) {
      expect(isBoilerplateMarkdown(`code/repo/${name}`)).toBe(true)
      expect(isIgnoredPath(name)).toBe(true)
    }
    expect(isBoilerplateMarkdown('License.md')).toBe(false)
    expect(isBoilerplateMarkdown('README.md')).toBe(false)
    expect(isBoilerplateMarkdown('Notes/LICENSE.md.bak')).toBe(false)
    expect(isBoilerplateMarkdown('LICENSE')).toBe(false)
    expect(isIgnoredPath('Notes/My License.md')).toBe(false)
  })

  it('builds folder ids, ancestors, mounts and the home prefix', () => {
    expect(folderKey('')).toBe('folder:')
    expect(folderKey('a\\b/')).toBe('folder:a/b')
    expect(isFolderId('folder:a/b')).toBe(true)
    expect(isFolderId('a/b')).toBe(false)
    expect(folderPathOf('folder:a/b')).toBe('a/b')
    expect(folderPathOf(folderKey(''))).toBe('')
    expect(ancestorsOf('a/b/c')).toEqual(['a', 'a/b'])
    expect(ancestorsOf('a')).toEqual([])
    expect(ancestorsOf('')).toEqual([])
    const roots = [
      { path: 'D:\\', mount: 'D', label: 'D:\\' },
      { path: 'F:\\', mount: 'F', label: 'F:\\' },
    ]
    expect(mountOf('D/Projects/x.md', roots)).toBe('D')
    expect(mountOf('F', roots)).toBe('F')
    expect(mountOf('D/Projects/x.md', roots.slice(0, 1))).toBe('')
    expect(mountOf('D/Projects/x.md')).toBe('')
    expect(homePrefix(roots)).toBe('D/')
    expect(homePrefix(roots.slice(0, 1))).toBe('')
    expect(homePrefix(null)).toBe('')
  })
})

describe('folders in the vault', () => {
  const files: VaultFile[] = [
    { path: 'Projects/PORTALz.md', content: '---\ntype: project\n---\n# PORTALz\n' },
    { path: 'Projects/PORTALz/Art/Sketch.md', content: '# Sketch\n\n[[PORTALz]]\n' },
    { path: 'code/repo/LICENSE.md', content: '# MIT' },
  ]

  it('MemoryVaultAdapter lists and creates folders', async () => {
    const persisted: Set<string>[] = []
    const vault = new MemoryVaultAdapter(files, { folders: ['Empty/Inner/', '.hidden'], onPersist: (_f, folders) => persisted.push(new Set(folders)) })
    expect(await vault.listFolders()).toEqual(['Empty', 'Empty/Inner', 'Projects', 'Projects/PORTALz', 'Projects/PORTALz/Art'])
    const seen: VaultChange[] = []
    vault.watch((c) => seen.push(...c))
    await vault.createFolder('Projects\\PORTALz\\Tech\\')
    expect(seen).toEqual([{ kind: 'addDir', path: 'Projects/PORTALz/Tech' }])
    expect(await vault.listFolders()).toContain('Projects/PORTALz/Tech')
    expect(persisted.at(-1)).toEqual(new Set(['Empty/Inner', 'Projects/PORTALz/Tech']))
    await vault.createFolder('Projects/PORTALz')
    expect(seen).toHaveLength(1)
    await expect(vault.createFolder('')).rejects.toThrow()
    await expect(vault.createFolder('a/.git')).rejects.toThrow()
    await expect(new MemoryVaultAdapter([], { readOnly: true }).createFolder('X')).rejects.toThrow(/read-only/)
    // Old single-argument persistence hooks still work.
    const legacy = new MemoryVaultAdapter([], { onPersist: (map) => void map.size })
    await legacy.createFolder('New')
    expect(await legacy.listFolders()).toEqual(['New'])
  })

  it('MemoryVaultAdapter keeps a folder when its last note goes, like a disk', async () => {
    const vault = new MemoryVaultAdapter([
      { path: 'Inbox/Only.md', content: '# Only' },
      { path: 'A/B/n.md', content: '# n' },
      { path: 'A/B/C/m.md', content: '# m' },
    ])
    await vault.remove('A/B/n.md')
    await vault.rename('Inbox/Only.md', 'Projects/Only.md')
    expect(await vault.listFolders()).toEqual(['A', 'A/B', 'A/B/C', 'Inbox', 'Projects'])
    vault.external([{ kind: 'unlink', path: 'A/B/C/m.md' }])
    expect(await vault.listFolders()).toContain('A/B/C')
    // unlinkDir takes the whole tree, files included, whatever order the batch has.
    vault.external([{ kind: 'unlinkDir', path: 'A/B' }, { kind: 'unlink', path: 'A/B/C/m.md' }, { kind: 'addDir', path: 'x/.git' }])
    expect(await vault.listFolders()).toEqual(['A', 'Inbox', 'Projects'])
    expect((await vault.list()).map((f) => f.path)).toEqual(['Projects/Only.md'])
  })

  it('loadVault returns folders and builds the graph with the options callback', async () => {
    const vault = new MemoryVaultAdapter(files, { folders: ['Projects/PORTALz/Tech'] })
    const { notes, folders, graph } = await loadVault(vault, undefined, undefined, (f) => ({
      folders: { multiRoot: false, all: f, rootTitle: 'Memory' },
    }))
    expect(notes.size).toBe(2)
    expect([...folders].sort()).toEqual(['Projects', 'Projects/PORTALz', 'Projects/PORTALz/Art', 'Projects/PORTALz/Tech'])
    expect(graph.folderSelection).not.toBeNull()
    expect(graph.nodes.find((n) => n.id === 'folder:Projects/PORTALz')?.folder?.role).toBe('project')
    expect(graph.nodes.find((n) => n.id === 'folder:Projects/PORTALz/Tech')?.parent).toBe('folder:Projects/PORTALz')
    // Without listFolders, folders come from the notes.
    const plain = await loadVault(Object.assign(new MemoryVaultAdapter(files), { listFolders: undefined }))
    expect([...plain.folders].sort()).toEqual(['Projects', 'Projects/PORTALz', 'Projects/PORTALz/Art'])
    expect(plain.graph.folderSelection).toBeNull()
  })

  it('applyChanges tracks addDir / unlinkDir and note folders', async () => {
    const loaded = await loadVault(new MemoryVaultAdapter(files, { folders: ['Projects/PORTALz/Tech'] }))
    const graphOpts = (f: Set<string>) => ({ folders: { multiRoot: false, all: f, rootTitle: 'V' } })
    const added = applyChanges(
      loaded.notes,
      [
        { kind: 'addDir', path: 'Projects/PORTALz/Tech/Shaders/' },
        { kind: 'addDir', path: 'Deep/A/B' },
        { kind: 'addDir', path: '.obsidian' },
        { kind: 'add', path: 'Inbox/Idea.md', content: '# Idea\n' },
      ],
      loaded.search,
      { folders: loaded.folders, graph: graphOpts },
    )
    expect(loaded.folders.has('Deep')).toBe(false)
    expect([...added.folders].sort()).toEqual([
      'Deep',
      'Deep/A',
      'Deep/A/B',
      'Inbox',
      'Projects',
      'Projects/PORTALz',
      'Projects/PORTALz/Art',
      'Projects/PORTALz/Tech',
      'Projects/PORTALz/Tech/Shaders',
    ])
    expect(added.touched).toEqual(['Inbox/Idea'])
    expect(added.graph.index.has('folder:Deep/A/B')).toBe(true)
    expect(added.graph.index.has('folder:Inbox')).toBe(true)
    // Depth 4 is below the default maxDepth: collapsed into its parent.
    expect(added.graph.index.has('folder:Projects/PORTALz/Tech/Shaders')).toBe(false)
    const tech = added.graph.nodes[added.graph.index.get('folder:Projects/PORTALz/Tech') ?? -1]
    expect(tech?.folder).toMatchObject({ childFolders: 1, hiddenFolders: 1 })

    const removed = applyChanges(
      added.notes,
      [
        { kind: 'unlinkDir', path: 'Projects/PORTALz/Tech' },
        { kind: 'unlinkDir', path: 'Deep' },
        { kind: 'unlinkDir', path: '' },
      ],
      loaded.search,
      { folders: added.folders, graph: graphOpts },
    )
    expect([...removed.folders].sort()).toEqual(['Inbox', 'Projects', 'Projects/PORTALz', 'Projects/PORTALz/Art'])
    expect(removed.notes.size).toBe(3)
    expect(removed.touched).toEqual([])
    expect(removed.graph.index.has('folder:Projects/PORTALz/Tech')).toBe(false)
    expect(removed.graph.index.has('folder:Deep')).toBe(false)

    // No folder set given: start from the notes' folders.
    const bare = applyChanges(loaded.notes, [{ kind: 'addDir', path: 'X' }], loaded.search)
    expect([...bare.folders].sort()).toEqual(['Projects', 'Projects/PORTALz', 'Projects/PORTALz/Art', 'X'])
    expect(bare.graph.folderSelection).toBeNull()
  })

  it('applyChanges removes a deleted tree reported deepest first, and keeps batch order', () => {
    const folders = new Set(['T', 'T/a', 'T/a/b', 'T/a/b/c', 'T/ab', 'Tx', 'Keep', 'Big'])
    for (let i = 0; i < 300; i++) folders.add(`Big/${i}`)
    // The desktop watcher reports a removed tree deepest folder first, the root last.
    const tree = ['T/a/b/c', 'T/a/b', 'T/ab', 'T/a', 'T'].map((path): VaultChange => ({ kind: 'unlinkDir', path }))
    const r = applyChanges(new Map(), tree, new SearchIndex(), { folders })
    expect([...r.folders].filter((f) => !f.startsWith('Big/')).sort()).toEqual(['Big', 'Keep', 'Tx'])
    expect(r.folders.size).toBe(303)
    expect(folders.has('T/a')).toBe(true)
    // A folder removed and re-created in one batch exists afterwards, and the other way round.
    const again = applyChanges(
      new Map(),
      [
        { kind: 'unlinkDir', path: 'T\\a' },
        { kind: 'addDir', path: 'T/a/new' },
        { kind: 'addDir', path: 'Gone' },
        { kind: 'unlinkDir', path: 'Gone' },
        { kind: 'add', path: 'T/a/b/Note.md', content: '# Note' },
      ],
      new SearchIndex(),
      { folders },
    )
    expect([...again.folders].filter((f) => f.startsWith('T') || f === 'Gone').sort()).toEqual(['T', 'T/a', 'T/a/b', 'T/a/new', 'T/ab', 'Tx'])
  })

  it('applyChanges removes a big tree from a whole-drive folder set in one pass', () => {
    // One scan per unlinkDir was 2 000 × 100 000 comparisons here (seconds); now it is one pass.
    const folders = new Set<string>(['Drive', 'Drive/Gone'])
    for (let i = 0; i < 98_000; i++) folders.add(`Drive/Keep/${i}`)
    folders.add('Drive/Keep')
    const changes: VaultChange[] = []
    for (let i = 0; i < 2000; i++) {
      folders.add(`Drive/Gone/${i}`)
      changes.push({ kind: 'unlinkDir', path: `Drive/Gone/${i}` })
    }
    changes.push({ kind: 'unlinkDir', path: 'Drive/Gone' })
    const t0 = performance.now()
    const r = applyChanges(new Map(), changes, new SearchIndex(), { folders })
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(r.folders.size).toBe(98_002)
    expect(r.folders.has('Drive/Gone')).toBe(false)
  })
})
