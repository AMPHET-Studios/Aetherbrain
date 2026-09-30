import { describe, expect, it } from 'vitest'
import {
  AssetResolver,
  MemoryVaultAdapter,
  SearchIndex,
  TODAY_ID,
  applyChanges,
  assetMap,
  buildGraph,
  cleanGrade,
  cleanScore,
  critiqueBaseName,
  critiqueNote,
  dailyBrief,
  extractTasks,
  folderKey,
  imageKey,
  isImageId,
  isImagePath,
  isVirtualId,
  loadVault,
  normalizeGrade,
  nextDay,
  parseNote,
  taskDates,
  taskLabel,
  tasksOf,
  type NoteId,
  type ParsedNote,
  type VaultAsset,
} from '../src'

function notesOf(files: Record<string, string>): Map<NoteId, ParsedNote> {
  const m = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    m.set(n.meta.id, n)
  }
  return m
}

describe('task dates', () => {
  it('reads due and scheduled dates in the common notations', () => {
    expect(taskDates('Ink the gate 📅 2026-10-01')).toEqual({ due: '2026-10-01', scheduled: null })
    expect(taskDates('Ink 📅2026-10-01 ⏳ 2026-09-30')).toEqual({ due: '2026-10-01', scheduled: '2026-09-30' })
    expect(taskDates('Ink 🗓️ 2026-10-02')).toEqual({ due: '2026-10-02', scheduled: null })
    expect(taskDates('Ink [due:: 2026-10-03]')).toEqual({ due: '2026-10-03', scheduled: null })
    expect(taskDates('Ink (scheduled:: 2026-10-04)')).toEqual({ due: null, scheduled: '2026-10-04' })
    expect(taskDates('Ink @due(2026-10-05)')).toEqual({ due: '2026-10-05', scheduled: null })
    expect(taskDates('Ink due:2026-10-06')).toEqual({ due: '2026-10-06', scheduled: null })
  })

  it('ignores lookalikes and impossible dates', () => {
    expect(taskDates('overdue:2026-10-06')).toEqual({ due: null, scheduled: null })
    expect(taskDates('Ink 📅 2026-13-01')).toEqual({ due: null, scheduled: null })
    expect(taskDates('Ink 📅 2026-02-30')).toEqual({ due: null, scheduled: null })
    expect(taskDates('Ink 📅 2026-10-011')).toEqual({ due: null, scheduled: null })
    expect(taskDates('Ink 📅 2024-02-29').due).toBe('2024-02-29')
    expect(taskDates('the due date is soon')).toEqual({ due: null, scheduled: null })
  })

  it('puts due, scheduled and tags on extracted tasks', () => {
    const [t] = extractTasks('- [ ] Paint #today #Art 📅 2026-10-01 ✅ 2026-09-01\n')
    expect(t).toMatchObject({ text: 'Paint #today #Art 📅 2026-10-01', due: '2026-10-01', scheduled: null, tags: ['today', 'art'] })
  })

  it('strips date markers for display', () => {
    expect(taskLabel('Ink the gate 📅 2026-10-01 ⏳ 2026-09-30')).toBe('Ink the gate')
    expect(taskLabel('Ink [due:: 2026-10-03] now')).toBe('Ink now')
    expect(taskLabel('Ink @due(2026-10-05)')).toBe('Ink')
    expect(taskLabel('📅 2026-10-01')).toBe('📅 2026-10-01')
  })

  it('stays linear on hostile text', () => {
    const ws = ' '.repeat(60_000)
    const start = performance.now()
    taskDates(`📅${ws}📅${ws}due${ws}due::${ws}@due(${ws}`)
    taskDates('📅 '.repeat(40_000))
    taskDates('due'.repeat(40_000))
    taskLabel(`a${ws}📅${ws}b${ws}[due::${ws}`)
    expect(performance.now() - start).toBeLessThan(400)
  })

  it('remembers tasks per parsed note', () => {
    const n = parseNote({ path: 'a.md', content: '- [ ] one\n' })
    expect(tasksOf(n)).toBe(tasksOf(n))
    expect(tasksOf(parseNote({ path: 'b.md', content: 'no tasks here' }))).toEqual([])
  })
})

describe('daily brief', () => {
  const DATE = '2026-09-30'
  const files = {
    'Projects/PORTALz.md': `---\ntitle: PORTALz\ntype: project\nstatus: active\nupdated: 2026-09-29\n---\n# PORTALz\n\n## To do\n\n- [ ] Block out the terrace\n- [ ] Ink the gate 📅 2026-09-28\n- [x] Done thing 📅 2026-09-01 ✅ 2026-09-01\n`,
    'Projects/PORTALz/Art/Gate study.md': '# Gate study\n\n- [ ] Value pass 📅 2026-09-30\n- [ ] Later 📅 2026-10-09\n',
    'Projects/ConceptForge.md': `---\ntitle: ConceptForge\ntype: project\nstatus: active\nupdated: 2026-09-20\n---\n# ConceptForge\n\n## To do\n\n- [ ] Future only 📅 2026-12-01\n  - [ ] nested\n- [ ] Grade ten gestures\n`,
    'Projects/Old.md': `---\ntitle: Old\ntype: project\nstatus: done\n---\n# Old\n\n- [ ] never next\n`,
    'Inbox/Errands.md': '# Errands\n\n- [ ] Buy paper #today\n- [ ] Scheduled ⏳ 2026-09-29\n',
    'Daily/2026-09-30.md': '# 2026-09-30\n\n- [ ] Stretch\n- [ ] Tomorrow 📅 2026-10-01\n',
    'Archive/Stale.md': '# Stale\n\n- [ ] Old overdue 📅 2020-01-01\n',
  }

  it('gathers overdue, today and next-up tasks with their projects', () => {
    const b = dailyBrief(notesOf(files).values(), { date: DATE, folders: new Set(['Projects', 'Projects/PORTALz', 'Projects/PORTALz/Art', 'Inbox', 'Daily', 'Archive']) })
    expect(b.date).toBe(DATE)
    expect(b.overdue.map((t) => [t.label, t.reason, t.projectTitle])).toEqual([['Ink the gate', 'overdue', 'PORTALz']])
    expect(b.today.map((t) => [t.label, t.reason, t.projectTitle])).toEqual([
      ['Value pass', 'due', 'PORTALz'],
      ['Scheduled', 'scheduled', null],
      ['Stretch', 'daily', null],
      ['Buy paper #today', 'flagged', null],
    ])
    // PORTALz is covered above; ConceptForge's first open top-level task that isn't due later; Old is done.
    expect(b.next.map((t) => [t.label, t.projectTitle, t.reason])).toEqual([['Grade ten gestures', 'ConceptForge', 'next']])
    expect(b.total).toBe(6)
    expect(b.noteIds).toEqual(['Projects/PORTALz', 'Projects/PORTALz/Art/Gate study', 'Inbox/Errands', 'Daily/2026-09-30', 'Projects/ConceptForge'])
    const gate = b.today[0]!
    expect(gate).toMatchObject({ notePath: 'Projects/PORTALz/Art/Gate study.md', line: 2, text: 'Value pass 📅 2026-09-30', due: '2026-09-30' })
  })

  it('is empty for an empty vault and caps sections', () => {
    expect(dailyBrief([], { date: DATE })).toMatchObject({ overdue: [], today: [], next: [], total: 0, noteIds: [] })
    const many = { 'Inbox/Many.md': Array.from({ length: 30 }, (_, i) => `- [ ] t${i} #today`).join('\n') }
    expect(dailyBrief(notesOf(many).values(), { date: DATE, maxPerSection: 5 }).today).toHaveLength(5)
  })

  it('computes the next day across month and year ends', () => {
    expect(nextDay('2026-09-30')).toBe('2026-10-01')
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
    expect(nextDay('2028-02-28')).toBe('2028-02-29')
  })
})

describe('critique notes', () => {
  it('writes a readable note with the drawing, grade fields, fixes and a practice task', () => {
    const md = critiqueNote(
      {
        title: 'Gesture Warm-Up',
        project: 'PORTALz',
        drill: 'Gesture',
        grade: 'b+',
        score: 0.82,
        scores: [
          { label: 'Value Range', score: 71, note: 'darks | lights' },
          { label: 'Line Economy', score: 90 },
        ],
        fixes: ['- [ ] Push the darks', 'Vary edges\nmore'],
        strengths: ['Confident lines'],
        deep: '## Big picture\nNice rhythm.\n- [ ] not a task',
      },
      '2026-09-30 Gesture Warm-Up.png',
      { date: '2026-09-30', practiceDue: '2026-10-01' },
    )
    expect(md).toContain('title: Gesture Warm-Up — 2026-09-30')
    expect(md).toContain('![[2026-09-30 Gesture Warm-Up.png]]')
    expect(md).toContain('Grade **B+ · 82/100** · Drill: Gesture · Project: [[PORTALz]] · Source: Concept Forge')
    expect(md).toContain('grade:: B+\nscore:: 82')
    expect(md).toContain('| Value Range | 71 | darks \\| lights |')
    expect(md).toContain('- [ ] Push the darks 📅 2026-10-01\n- [ ] Vary edges more\n')
    expect(md).toContain('> ## Big picture\n> Nice rhythm.\n> - [ ] not a task')
    const note = parseNote({ path: 'Projects/PORTALz/Critique/2026-09-30 Gesture Warm-Up.md', content: md })
    expect(note.meta.tags).toEqual(expect.arrayContaining(['critique', 'concept-forge', 'drill/gesture']))
    expect(extractTasks(md).map((t) => [t.text, t.due])).toEqual([
      ['Push the darks 📅 2026-10-01', '2026-10-01'],
      ['Vary edges more', null],
    ])
    expect(note.links.map((l) => [l.kind, l.raw])).toEqual([
      ['embed', '2026-09-30 Gesture Warm-Up.png'],
      ['wikilink', 'PORTALz'],
    ])
  })

  it('reads grade objects of any shape', () => {
    expect(
      normalizeGrade({
        letter: 'B+',
        overall: 82,
        drill: 'Value Study',
        breakdown: [
          { name: 'Value Range', score: 71, tip: 'Push the darks' },
          { criterion: 'Edges', value: 0.64 },
          { name: 'Broken' },
        ],
        opportunities: [{ label: 'Value Range', fix: 'Push the darks further' }, 'Soften far edges'],
        strengths: ['Line economy'],
        deepCritique: 'A long enough written critique of the piece.',
      }),
    ).toEqual({
      grade: 'B+',
      score: 82,
      drill: 'Value Study',
      scores: [
        { label: 'Value Range', score: 71, note: 'Push the darks' },
        { label: 'Edges', score: 64 },
      ],
      fixes: ['Value Range: Push the darks further', 'Soften far edges'],
      strengths: ['Line economy'],
      deep: 'A long enough written critique of the piece.',
    })
    expect(normalizeGrade({ result: { grade: 'a', scores: { Composition: 90, Values: { score: 70 } } } })).toMatchObject({
      grade: 'A',
      scores: [
        { label: 'Composition', score: 90 },
        { label: 'Values', score: 70 },
      ],
    })
    expect(normalizeGrade(null)).toEqual({ grade: null, score: null, drill: null, scores: [], fixes: [], strengths: [], deep: null })
    // A criterion named like a score field is a criterion, not the overall score.
    expect(normalizeGrade({ letter: 'B', scores: { line: 88, value: 74, form: 70 } })).toMatchObject({ grade: 'B', score: null })
    expect(normalizeGrade({ letter: 'B', breakdown: { line: 88, total: 60 } }).score).toBeNull()
    expect(normalizeGrade({ letter: 'B', score: '' }).score).toBeNull()
    expect(normalizeGrade({ result: { letter: 'C', score: '71%' } })).toMatchObject({ grade: 'C', score: 71 })
    expect(normalizeGrade('B')).toMatchObject({ grade: null })
  })

  it('cleans grades, scores and file names', () => {
    expect(cleanGrade(' a- ')).toBe('A-')
    expect(cleanGrade('Excellent')).toBeNull()
    expect(cleanScore(82.4)).toBe(82)
    expect(cleanScore('0.5')).toBe(50)
    expect(cleanScore(140)).toBeNull()
    expect(cleanScore(-1)).toBeNull()
    expect(cleanScore('')).toBeNull()
    expect(cleanScore('   ')).toBeNull()
    expect(cleanScore('82%')).toBe(82)
    expect(cleanScore(' 64 / 100 ')).toBe(64)
    expect(critiqueBaseName('Value: study / "night"?', '2026-09-30')).toBe('2026-09-30 Value study night')
    expect(critiqueBaseName('   ', '2026-09-30')).toBe('2026-09-30 Drawing')
  })
})

describe('images', () => {
  const assets = assetMap([
    { path: 'Projects/PORTALz/Art/gate.png', mtime: 3 },
    { path: 'Projects/PORTALz/Art/ruins.JPG', mtime: 2 },
    { path: 'Projects/PORTALz/Art/old.webp', mtime: 1 },
    { path: 'Resources/Refs/gate.png', mtime: 5 },
    { path: 'Resources/Refs/tree.png', mtime: 4 },
    { path: 'node_modules/x.png' },
    { path: 'notes.md' },
  ])

  it('knows image paths and ids', () => {
    expect(isImagePath('a/B.JPEG')).toBe(true)
    expect(isImagePath('a/b.svg')).toBe(false)
    expect(assets.has('node_modules/x.png')).toBe(false)
    expect(assets.has('notes.md')).toBe(false)
    expect(imageKey('Art/gate.png')).toBe('image:Art/gate.png')
    expect(isImageId('image:Art/gate.png')).toBe(true)
    expect(isVirtualId(TODAY_ID) && isVirtualId('folder:') && isVirtualId('ghost:x') && !isVirtualId('Inbox/x')).toBe(true)
  })

  it('resolves image links like Obsidian: path, relative, nearest file name', () => {
    const r = new AssetResolver(assets.keys())
    expect(r.resolve('Resources/Refs/gate.png')).toBe('Resources/Refs/gate.png')
    expect(r.resolve('./Art/gate.png', 'Projects/PORTALz')).toBe('Projects/PORTALz/Art/gate.png')
    expect(r.resolve('../PORTALz/Art/ruins.jpg', 'Projects/Other')).toBe('Projects/PORTALz/Art/ruins.JPG')
    expect(r.resolve('gate.png', 'Projects/PORTALz/Notes')).toBe('Projects/PORTALz/Art/gate.png')
    expect(r.resolve('gate.png', 'Resources')).toBe('Resources/Refs/gate.png')
    expect(r.resolve('Refs/gate.png', 'Projects/PORTALz')).toBe('Resources/Refs/gate.png')
    expect(r.resolve('missing.png')).toBeNull()
    expect(r.resolve('Other/gate.png')).toBeNull()
    expect(r.resolve('../../../../x.png', 'a')).toBeNull()
    // Folders in the link count even when only one file has that name.
    const one = new AssetResolver(['Refs/gate.png'])
    expect(one.resolve('Art/gate.png', 'Notes')).toBeNull()
    expect(one.resolve('../Art/gate.png', 'Notes')).toBeNull()
    expect(one.resolve('Refs/gate.png', 'Notes')).toBe('Refs/gate.png')
    expect(one.resolve('gate.png', 'Notes')).toBe('Refs/gate.png')
  })

  const files = {
    'Projects/PORTALz.md': '---\ntype: project\n---\n# PORTALz\n\n![[gate.png]] and [[tree.png]] and ![[missing.png]]\n',
    'Projects/PORTALz/Art/Moodboard.md': '# Moodboard\n',
  }
  const folders = new Set(['Projects', 'Projects/PORTALz', 'Projects/PORTALz/Art', 'Resources', 'Resources/Refs'])

  it('links embedded images in every layout, and never makes ghosts of pictures', () => {
    const notes = notesOf(files)
    const g = buildGraph(notes, { images: { all: assets } })
    const ids = g.nodes.map((n) => n.id)
    expect(ids).toContain('image:Projects/PORTALz/Art/gate.png')
    expect(ids).toContain('image:Resources/Refs/tree.png')
    expect(ids.some((id) => id.startsWith('ghost:'))).toBe(false)
    const gate = g.nodes[g.index.get('image:Projects/PORTALz/Art/gate.png')!]!
    expect(gate).toMatchObject({ kind: 'image', title: 'gate.png', parent: null, inDegree: 1, image: { embeddedBy: 1, mtime: 3 } })
    expect(g.edges.filter((e) => e.from === 'Projects/PORTALz').map((e) => [e.to, e.kind])).toEqual([
      ['image:Projects/PORTALz/Art/gate.png', 'embed'],
      ['image:Resources/Refs/tree.png', 'wikilink'],
    ])
    const links = notes.get('Projects/PORTALz')!.links
    expect(links.find((l) => l.raw === 'missing.png')).toMatchObject({ resolved: false, to: 'missing.png' })
    // Without images every picture link stays unresolved and nothing is added.
    const plain = buildGraph(notesOf(files))
    expect(plain.nodes.map((n) => n.kind)).toEqual(['note', 'note'])
  })

  it('adds the newest images of shown folders as moons, capped per folder and overall', () => {
    const g = buildGraph(notesOf(files), {
      images: { all: assets, moons: true, maxPerFolder: 2 },
      folders: { all: folders, rootTitle: 'Vault', multiRoot: false, maxDepth: 3 },
    })
    const imgs = g.nodes.filter((n) => n.kind === 'image')
    expect(imgs.map((n) => [n.image!.path, n.parent])).toEqual([
      ['Projects/PORTALz/Art/gate.png', 'folder:Projects/PORTALz/Art'],
      ['Resources/Refs/tree.png', 'folder:Resources/Refs'],
      ['Projects/PORTALz/Art/ruins.JPG', 'folder:Projects/PORTALz/Art'],
      ['Resources/Refs/gate.png', 'folder:Resources/Refs'],
    ])
    const art = g.nodes[g.index.get(folderKey('Projects/PORTALz/Art'))!]!
    expect(art.folder).toMatchObject({ images: 3, shownImages: 2 })
    const capped = buildGraph(notesOf(files), {
      images: { all: assets, moons: true, maxTotal: 3 },
      folders: { all: folders, rootTitle: 'Vault', multiRoot: false, maxDepth: 3 },
    })
    expect(capped.nodes.filter((n) => n.kind === 'image')).toHaveLength(3)
  })

  it('tracks images through changes, copy on write', () => {
    const search = new SearchIndex()
    const base = new Map<string, VaultAsset>([['A/x.png', { path: 'A/x.png', mtime: 1 }]])
    const same = applyChanges(new Map(), [{ kind: 'add', path: 'Inbox/n.md', content: '# n' }], search, { assets: base })
    expect(same.assets).toBe(base)
    const next = applyChanges(new Map(), [{ kind: 'add', path: 'B/y.png', mtime: 2, size: 10 }, { kind: 'unlink', path: 'A/x.png' }], search, { assets: base })
    expect(next.assets).not.toBe(base)
    expect([...next.assets.values()]).toEqual([{ path: 'B/y.png', mtime: 2, size: 10 }])
    expect(next.folders.has('B')).toBe(true)
    expect(base.has('A/x.png')).toBe(true)
    const gone = applyChanges(new Map(), [{ kind: 'unlinkDir', path: 'B' }], search, { assets: next.assets, folders: next.folders })
    expect(gone.assets.size).toBe(0)
  })

  it('creates, lists and serves images in the memory adapter, never over anything', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
    const a = new MemoryVaultAdapter([{ path: 'Art/note.md', content: '# n' }], { assets: [{ path: 'Art/old.png', data: png, mtime: 7 }] })
    const seen: string[] = []
    a.watch((c) => seen.push(...c.map((x) => `${x.kind}:${x.path}`)))
    await a.createAsset('Art/new.png', png)
    expect(seen).toEqual(['add:Art/new.png'])
    await expect(a.createAsset('Art/NEW.png', png)).rejects.toThrow(/EEXIST/)
    await expect(a.createAsset('Art/note.md', png)).rejects.toThrow(/image/)
    await expect(a.create('Art/old.png', 'x')).rejects.toThrow(/EEXIST/)
    expect((await a.listAssets()).map((x) => [x.path, x.size])).toEqual([
      ['Art/old.png', 7],
      ['Art/new.png', 7],
    ])
    const blob = await a.thumbnail('Art/new.png', 128)
    expect(blob?.type).toBe('image/png')
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(png)
    const loaded = await loadVault(a)
    expect([...loaded.assets.keys()]).toEqual(['Art/old.png', 'Art/new.png'])
    await a.remove('Art/new.png')
    expect(seen).toContain('unlink:Art/new.png')
  })
})

describe('Today hub', () => {
  it('adds one hub with beams to the notes of the brief, outside notes’ backlinks', () => {
    const notes = notesOf({ 'Inbox/A.md': '- [ ] a #today\n', 'Inbox/B.md': '# B\n' })
    const brief = dailyBrief(notes.values(), { date: '2026-09-30' })
    const g = buildGraph(notes, { today: { brief } })
    const hub = g.nodes[g.index.get(TODAY_ID)!]!
    expect(hub).toMatchObject({ kind: 'today', title: 'Today', parent: null, outDegree: 1, today: { date: '2026-09-30', today: 1, total: 1 } })
    expect(g.edges).toContainEqual({ from: TODAY_ID, to: 'Inbox/A', kind: 'today', weight: 1 })
    expect(g.backlinks.get('Inbox/A')?.has(TODAY_ID)).toBe(false)
    expect(g.orphans).toEqual(['Inbox/A', 'Inbox/B'])
    const sys = buildGraph(notes, { today: { brief }, folders: { all: new Set(['Inbox']), rootTitle: 'V', multiRoot: false } })
    expect(sys.nodes[sys.index.get(TODAY_ID)!]!.parent).toBe('folder:')
    expect(sys.nodes[sys.nodes.length - 1]!.id).toBe(TODAY_ID)
  })
})
