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
  isExistsError,
  isFolderId,
  isIgnoredPath,
  loadVault,
  mountOf,
  neighborhood,
  parseMarkdown,
  parseNote,
  splitFrontmatter,
  tokenizeWikilinks,
  updateFrontmatter,
  type GraphOptionsFn,
  type NoteId,
  type ParsedNote,
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
  it('patches keys in place: comments and untouched values stay exactly as written', () => {
    const raw = '---\ntitle: Gate\n# owner: me (keep this)\nversion: 1.10\nstatus: active\nid: 01234\ndiscord: 123456789012345678901\n---\n# Gate\n\nx\n'
    expect(updateFrontmatter(raw, { status: 'paused' })).toBe(raw.replace('status: active', 'status: paused'))
    expect(updateFrontmatter(raw, { updated: '2026-09-29' })).toBe(raw.replace('\n---\n#', '\nupdated: "2026-09-29"\n---\n#'))
    expect(updateFrontmatter(raw, { status: undefined, version: undefined })).toBe(raw.replace('version: 1.10\nstatus: active\n', ''))
    // Nothing changes: the very same text, not a re-serialized block.
    expect(updateFrontmatter(raw, { status: 'active', missing: undefined })).toBe(raw)
    // No blank line is added (or removed) between the block and the body.
    expect(updateFrontmatter('---\na: 1\n---\n# A\n', { b: 2 })).toBe('---\na: 1\nb: 2\n---\n# A\n')
    // Every key gone: the block goes.
    expect(updateFrontmatter('---\na: 1\n---\n# A\n', { a: undefined })).toBe('# A\n')
  })
  it('round-trips any value it writes, in place or appended', () => {
    for (const v of ['a\n\n', 'a\nb', 'x', ['a', 'b'], { k: 1 }, '', null, 'line: with colon', '2026-09-29', '# not a comment']) {
      expect(splitFrontmatter(updateFrontmatter('---\nt: 1\n---\n# A\n', { v })).frontmatter).toEqual({ t: 1, v })
      expect(splitFrontmatter(updateFrontmatter('---\nv: 1\nt: 1\n---\n# A\n', { v })).frontmatter).toEqual({ v, t: 1 })
    }
  })
  it('keeps a byte-order mark first, so an H1 after it still titles the note', () => {
    const bom = '\uFEFF# Big Idea\n\ntext\n'
    const out = updateFrontmatter(bom, { status: 'active' })
    expect(out).toBe('\uFEFF---\nstatus: active\n---\n\n# Big Idea\n\ntext\n')
    expect(parseNote({ path: 'Resources/Idea.md', content: out }).meta.title).toBe('Big Idea')
    const crlf = '\uFEFF# Drawing Practice\r\n\r\nDaily sketches.\r\n'
    const moved = updateFrontmatter(crlf, { type: 'project', status: 'active' })
    expect(moved).toBe('\uFEFF---\r\ntype: project\r\nstatus: active\r\n---\r\n\r\n# Drawing Practice\r\n\r\nDaily sketches.\r\n')
    expect(parseNote({ path: 'Art/Drawing/Drawing.md', content: moved }).meta.title).toBe('Drawing Practice')
    // With a block already there, the mark stays in front of it and a CRLF block stays CRLF.
    expect(updateFrontmatter('\uFEFF---\r\na: 1\r\n---\r\n# A\r\n', { b: 'x' })).toBe('\uFEFF---\r\na: 1\r\nb: x\r\n---\r\n# A\r\n')
  })
  it('never drops a block it cannot parse, and re-serializes YAML the line model cannot follow', () => {
    const broken = '---\ntitle: A\ntags: [unclosed\nnotes: keep me\n---\n# A\n'
    expect(updateFrontmatter(broken, { tags: ['x'] })).toBe('---\ntitle: A\ntags: [x]\nnotes: keep me\n---\n# A\n')
    expect(updateFrontmatter(broken, { status: 'x' })).toBe(broken.replace('keep me\n', 'keep me\nstatus: x\n'))
    const opaque = '---\n{broken: [\n---\n# A\n'
    expect(updateFrontmatter(opaque, { status: 'x' })).toBe(opaque)
    // A flow mapping parses fine but has no key lines: the whole block is rewritten, as before.
    expect(updateFrontmatter('---\n{a: 1, b: two}\n---\n# A\n', { c: 3 })).toBe('---\na: 1\nb: two\nc: 3\n---\n# A\n')
    // Quoted keys and values that span lines are recognized.
    const quoted = '---\n"my key": 1\n\'it\'\'s\': 2\ndesc: |\n  one\n\n  two\nz: 3\n---\n'
    expect(updateFrontmatter(quoted, { desc: 'short' })).toBe('---\n"my key": 1\n\'it\'\'s\': 2\ndesc: short\nz: 3\n---\n')
    expect(updateFrontmatter(quoted, { 'my key': 5 })).toBe(quoted.replace('"my key": 1', 'my key: 5'))
  })
  it('never leaves a block that no longer parses: a replaced anchor re-serializes the block', () => {
    // Replacing `a: &x 1` in place would leave `b: *x` pointing at nothing, and
    // a block that doesn't parse loses every key (title, tags) of the note.
    const anchored = '---\ntitle: A\na: &x 1\nb: *x\n---\n# A\n'
    const out = updateFrontmatter(anchored, { a: 2 })
    expect(splitFrontmatter(out).frontmatter).toEqual({ title: 'A', a: 2, b: 1 })
    expect(out).toBe('---\ntitle: A\na: 2\nb: 1\n---\n# A\n')
    const merged = '---\nbase: &b {x: 1}\nc:\n  <<: *b\n  y: 2\nstatus: active\n---\n# A\n'
    expect(splitFrontmatter(updateFrontmatter(merged, { base: 'z' })).frontmatter).toMatchObject({ base: 'z', c: { y: 2 }, status: 'active' })
    // Keys the alias doesn't depend on are still patched in place.
    expect(updateFrontmatter(anchored, { title: 'B' })).toBe(anchored.replace('title: A', 'title: B'))
    expect(updateFrontmatter(merged, { status: 'paused' })).toBe(merged.replace('status: active', 'status: paused'))
  })
  it('stays fast on long whitespace runs', () => {
    const ws = ' '.repeat(50_000)
    const start = performance.now()
    expect(updateFrontmatter(`---\ntitle: a${ws}x\n---\n# A${ws}x\n`, { status: 'x' })).toContain('status: x')
    // Not a mapping, and its lines can't be told apart: left exactly as it is.
    const scalar = `---\n${ws}x\n---\n# A\n`
    expect(updateFrontmatter(scalar, { status: 'x' }) === scalar).toBe(true)
    expect(updateFrontmatter(`---\na: 1\n${ws}\nb: 2${ws}\n---\n# A\n`, { b: 3 }).endsWith(`${ws}\nb: 3\n---\n# A\n`)).toBe(true)
    expect(performance.now() - start).toBeLessThan(300)
  })
})

describe('wikilinks', () => {
  it('strips a long run of [[ from the plain text in linear time', () => {
    const body = `x ${'[['.repeat(25_000)} y [[Target|shown]] z`
    parseMarkdown(body)
    const t0 = performance.now()
    parseMarkdown(body)
    const markdown = performance.now() - t0
    const t1 = performance.now()
    const n = parseNote({ path: 'x.md', content: body })
    // parseNote = the markdown parse plus a little; the old wikilink strip alone took ~0.7 s here.
    expect(performance.now() - t1 - markdown).toBeLessThan(250)
    expect(n.plain.endsWith('y shown z')).toBe(true)
  })

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

  it('MemoryVaultAdapter.create never overwrites, whatever the letter case', async () => {
    const vault = new MemoryVaultAdapter([{ path: 'Code/Game/README.md', content: '# Readme' }], { folders: ['Code/Game/Notes.md'] })
    const seen: VaultChange[] = []
    vault.watch((c) => seen.push(...c))
    await vault.create('Code/Game/New.md', '# New')
    expect(await vault.read('Code/Game/New.md')).toBe('# New')
    expect(seen).toEqual([expect.objectContaining({ kind: 'add', path: 'Code/Game/New.md', content: '# New' })])
    for (const taken of ['Code/Game/README.md', 'code/game/readme.md', 'Code\\Game\\New.md', 'Code/Game/Notes.md']) {
      const err = await vault.create(taken, 'clobber').catch((e: unknown) => e)
      expect(isExistsError(err), taken).toBe(true)
    }
    expect(await vault.read('Code/Game/README.md')).toBe('# Readme')
    expect(seen).toHaveLength(1)
    // A file planted outside the app (a changelog the vault ignores) is still there to refuse.
    vault.external([{ kind: 'add', path: 'Code/Game/CHANGELOG.md', content: '## 1.0' }])
    expect(isExistsError(await vault.create('Code/Game/Changelog.md', '# x').catch((e: unknown) => e))).toBe(true)
    await expect(new MemoryVaultAdapter([], { readOnly: true }).create('A.md', '')).rejects.toThrow(/read-only/)
    // Two creates of one path at once: exactly one wins.
    const results = await Promise.allSettled([vault.create('Race.md', 'a'), vault.create('race.md', 'b')])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
  })

  it('isExistsError recognizes EEXIST however it arrives', () => {
    expect(isExistsError(Object.assign(new Error('boom'), { code: 'EEXIST' }))).toBe(true)
    expect(isExistsError(new Error("Error invoking remote method 'vault:create': Error: EEXIST: file already exists"))).toBe(true)
    expect(isExistsError('EEXIST')).toBe(true)
    expect(isExistsError(new Error('ENOENT: no such file'))).toBe(false)
    expect(isExistsError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(false)
    expect(isExistsError(null)).toBe(false)
    expect(isExistsError(undefined)).toBe(false)
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

  it('applyChanges keeps the folder Set when a batch adds or removes no folder, and never mutates it', () => {
    const folders = new Set(['Inbox', 'Projects', 'Projects/X'])
    const notes = new Map<NoteId, ParsedNote>()
    const n = parseNote({ path: 'Projects/X/a.md', content: '# a\n' })
    notes.set(n.meta.id, n)
    const search = new SearchIndex()
    const same = applyChanges(
      notes,
      [
        { kind: 'change', path: 'Projects/X/a.md', content: '# a\n\nedited\n' },
        { kind: 'add', path: 'Inbox/b.md', content: '# b\n' },
        { kind: 'unlink', path: 'Inbox/b.md' },
        { kind: 'addDir', path: 'Projects/X/' },
        { kind: 'unlinkDir', path: 'Nowhere' },
        // Ignored folders are never added, so they don't cost a copy either.
        { kind: 'addDir', path: 'Projects/X/node_modules' },
        { kind: 'addDir', path: '.git' },
      ],
      search,
      { folders },
    )
    expect(same.folders).toBe(folders)
    const grown = applyChanges(notes, [{ kind: 'add', path: 'New/c.md', content: '# c\n' }], search, { folders })
    expect(grown.folders).not.toBe(folders)
    expect([...grown.folders].sort()).toEqual(['Inbox', 'New', 'Projects', 'Projects/X'])
    const shrunk = applyChanges(notes, [{ kind: 'unlinkDir', path: 'Inbox' }], search, { folders })
    expect([...shrunk.folders].sort()).toEqual(['Projects', 'Projects/X'])
    expect([...folders].sort()).toEqual(['Inbox', 'Projects', 'Projects/X'])
  })

  it('a content-only save stays fast on a whole drive (~100k folders) in the system layout', () => {
    // A synthetic drive: D and F, each folder with 1-6 subfolders, breadth-first.
    let seed = 3
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
    const all: string[] = ['D', 'F']
    for (let i = 0; all.length < 100_000; i++) {
      const parent = all[i]!
      for (let k = 1 + Math.floor(rnd() * 6); k > 0 && all.length < 100_000; k--) all.push(`${parent}/Folder_${all.length}`)
    }
    const folders = new Set(all)
    const notes = new Map<NoteId, ParsedNote>()
    for (let i = 0; i < 300; i++) {
      const n = parseNote({ path: `${all[Math.floor(rnd() * all.length)]}/README ${i}.md`, content: `# Readme ${i}\n\nSee [[Readme ${(i * 7) % 300}]].\n` })
      notes.set(n.meta.id, n)
    }
    const graph: GraphOptionsFn = (f) => ({
      folders: { all: f, rootTitle: 'Drives', mountLabels: { D: 'D:\\', F: 'F:\\' }, maxDepth: 3, expanded: [], multiRoot: true },
    })
    const search = new SearchIndex()
    search.rebuild(notes.values())
    // Opening the vault indexes the folders once.
    const first = buildGraph(notes, graph(folders, notes))
    const one = [...notes.values()][5]!
    let current = notes
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now()
      const r = applyChanges(current, [{ kind: 'change', path: one.meta.path, content: `${one.raw}\nedit ${k}\n`, mtime: Date.now() }], search, {
        folders,
        graph,
      })
      // Was ~0.6 s per save here (1.2 s at 200k folders), all on the renderer's main thread.
      expect(performance.now() - t0).toBeLessThan(200)
      expect(r.folders).toBe(folders)
      expect(r.graph.nodes.filter((x) => x.kind === 'folder').map((x) => x.id)).toEqual(
        first.nodes.filter((x) => x.kind === 'folder').map((x) => x.id),
      )
      current = r.notes
    }
    // The memoized index is the one a fresh build computes.
    const fresh = buildGraph(current, graph(new Set(all), current))
    expect(fresh.folderSelection?.visible).toEqual(first.folderSelection?.visible)
    expect(fresh.folderSelection?.hidden).toEqual(first.folderSelection?.hidden)
    expect(fresh.folderSelection?.dropped).toBe(first.folderSelection?.dropped)
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

describe('pathological nesting', () => {
  it('parses a note with a list thousands of levels deep quickly, without overflowing', () => {
    const deep = `# Deep\n\n${'- '.repeat(8000)}x [[Target]]\n\n${'> '.repeat(4000)}quote\n\nafter [[Other]]\n`
    const t0 = performance.now()
    const n = parseNote({ path: 'Inbox/Deep.md', content: deep })
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(n.meta.title).toBe('Deep')
    expect(n.links.map((l) => l.raw)).toContain('Other')
    // Normal nesting is untouched.
    const ok = parseNote({ path: 'a.md', content: '- a\n  - b [[B]]\n    - c\n' })
    expect(ok.links.map((l) => l.raw)).toEqual(['B'])
  })
})
