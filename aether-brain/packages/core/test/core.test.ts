import { describe, expect, it } from 'vitest'
import {
  MemoryVaultAdapter,
  SearchIndex,
  applyChanges,
  buildGraph,
  dailyNote,
  findUnlinkedMentions,
  generateSyntheticVault,
  inboxNote,
  loadVault,
  neighborhood,
  parseNote,
  splitFrontmatter,
  tokenizeWikilinks,
  updateFrontmatter,
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
