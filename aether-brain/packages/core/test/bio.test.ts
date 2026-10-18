import { describe, expect, it } from 'vitest'
import {
  BIO_FOLDER,
  BIO_NOTES,
  bioNotePath,
  bioNoteText,
  bioStatus,
  buildGraph,
  extractTasks,
  folderKey,
  parseNote,
  planBio,
  type GraphData,
  type GraphNode,
  type NoteId,
  type ParsedNote,
} from '../src'

/**
 * The Bio star: the folder `Bio` at the vault's home, drawn as the one big, bright, blue star, with a starting page each for sleep,
 * food, meds, exercise, drugs and mental health. The pages are the user's to fill in: what is written is questions and empty lists,
 * and a page that is there is never touched.
 */

const TITLES = ['Sleep schedule', 'Food', 'Meds', 'Exercise', 'Drugs', 'Mental health']
const DAY = '2026-10-17'
/** The coach's own rule (chat.test.ts): no hotline or phone numbers anywhere. */
const PHONE = /\b911\b|\b9-8-8\b|\b8-1-1\b|\b\d{3}-\d{4}\b|\b\d{3}-\d{3}-\d{4}\b|\b1-800/

describe('the pages of the Bio star', () => {
  it('are the six he named, in his order, one file each in the Bio folder', () => {
    expect(BIO_FOLDER).toBe('Bio')
    expect(BIO_NOTES.map((n) => n.title)).toEqual(TITLES)
    expect(BIO_NOTES.map((n) => bioNotePath(BIO_FOLDER, n))).toEqual(TITLES.map((t) => `Bio/${t}.md`))
    expect(BIO_NOTES.map((n) => bioNotePath('D/Bio', n))[0]).toBe('D/Bio/Sleep schedule.md')
  })

  it('read as ordinary notes: titled, dated, tagged bio and their topic, ending in a Log', () => {
    const topics = new Set<string>()
    for (const def of BIO_NOTES) {
      const text = bioNoteText(def, DAY)
      const note = parseNote({ path: bioNotePath(BIO_FOLDER, def), content: text })
      expect(note.meta.title, def.title).toBe(def.title)
      expect(note.meta.tags, def.title).toEqual(expect.arrayContaining(['bio', def.tag]))
      // The YAML writer quotes a date-looking string, as it does for the daily note.
      expect(text, def.title).toMatch(new RegExp(`\\ncreated: "?${DAY}"?\\n`))
      expect(text, def.title).toMatch(new RegExp(`\\nupdated: "?${DAY}"?\\n`))
      expect(text, def.title).toContain(`\n# ${def.title}\n`)
      expect(text.replace(/\n+$/, '').split('\n').slice(-3), def.title).toEqual(['## Log', '', '- '])
      topics.add(def.tag)
    }
    // One topic tag each, none shared.
    expect(topics.size).toBe(BIO_NOTES.length)
  })

  it('hold nothing the brain would act on by itself: no task, link, tag or address in the text', () => {
    for (const def of BIO_NOTES) {
      const text = bioNoteText(def, DAY)
      const note = parseNote({ path: bioNotePath(BIO_FOLDER, def), content: text })
      // A task would land on the daily brief; a link would make a ghost or a synapse; an inline tag would join the tag list.
      expect(extractTasks(text), def.title).toEqual([])
      expect(note.links, def.title).toEqual([])
      expect(note.inlineTags, def.title).toEqual([])
      expect(text, def.title).not.toMatch(/\[\[|https?:|www\.|#[A-Za-z]/)
    }
  })

  it('give no advice, name no number, and never speak of changing a medicine', () => {
    const all = BIO_NOTES.map((d) => bioNoteText(d, DAY)).join('\n')
    expect(all).not.toMatch(PHONE)
    expect(all).not.toMatch(/\b(hotline|helpline|lifeline|crisis|emergency|suicid)/i)
    expect(all).not.toMatch(/\b(you should|you must|you need to|stop taking|start taking|increase|decrease|take more|take less|skip a dose|double)\b/i)
    expect(all).not.toMatch(/\bdiagnos|\bcure\b/i)
    // The one line about medicines points at the people who decide; the drugs page says plainly there is no judgment.
    expect(bioNoteText(BIO_NOTES.find((d) => d.title === 'Meds')!, DAY)).toContain('Changes go through my doctor or pharmacist.')
    expect(bioNoteText(BIO_NOTES.find((d) => d.title === 'Drugs')!, DAY)).toContain('no judgment')
    // "My people" is the user's own list to fill in: nothing is pre-written there.
    const mental = bioNoteText(BIO_NOTES.find((d) => d.title === 'Mental health')!, DAY)
    expect(mental).toMatch(/## My people \(who I can reach\)\n\n- \n/)
  })
})

describe('planBio: what making the star writes', () => {
  const now = new Date(2026, 9, 17, 9, 0)

  it('plans every page, in order and dated that day, when the folder has none (a Food note elsewhere does not count)', () => {
    const plan = planBio('Bio', ['Work/Food', 'Inbox/idea'], now)
    expect(plan.folder).toBe('Bio')
    expect(plan.present).toEqual([])
    expect(plan.create.map((c) => c.path)).toEqual(TITLES.map((t) => `Bio/${t}.md`))
    expect(plan.create.map((c) => c.title)).toEqual(TITLES)
    expect(plan.create[0]!.content).toMatch(new RegExp(`\\ncreated: "?${DAY}"?\\n`))
  })

  it('plans only what is missing, and a page under any letter case counts as there', () => {
    const plan = planBio('Bio', ['Bio/Food', 'bio/MEDS', 'Bio/Mental health'], now)
    expect(plan.present).toEqual(['Food', 'Meds', 'Mental health'])
    expect(plan.create.map((c) => c.title)).toEqual(['Sleep schedule', 'Exercise', 'Drugs'])
    // Never a path that is there.
    for (const c of plan.create) expect(['Bio/Food', 'bio/MEDS', 'Bio/Mental health']).not.toContain(c.path.replace(/\.md$/, ''))
  })

  it('plans nothing when every page is there', () => {
    const plan = planBio('Bio', TITLES.map((t) => `Bio/${t}`), now)
    expect(plan.create).toEqual([])
    expect(plan.present).toEqual(TITLES)
  })

  it('works under a drive of a vault with several roots, and another drive’s pages do not count', () => {
    const plan = planBio('D/Bio', ['D/Bio/Food', 'F/Bio/Meds'], now)
    expect(plan.present).toEqual(['Food'])
    expect(plan.create[0]!.path).toBe('D/Bio/Sleep schedule.md')
    expect(plan.create.map((c) => c.title)).toEqual(['Sleep schedule', 'Meds', 'Exercise', 'Drugs', 'Mental health'])
  })

  it('bioStatus says the same thing the plan does', () => {
    const s = bioStatus('Bio', ['Bio/food', 'Bio/Drugs'])
    expect(s.present.map((d) => d.title)).toEqual(['Food', 'Drugs'])
    expect(s.missing.map((d) => d.title)).toEqual(['Sleep schedule', 'Meds', 'Exercise', 'Mental health'])
  })
})

describe('the Bio star in the graph', () => {
  function notesOf(files: Record<string, string>): Map<NoteId, ParsedNote> {
    const m = new Map<NoteId, ParsedNote>()
    for (const [path, content] of Object.entries(files)) {
      const n = parseNote({ path, content })
      m.set(n.meta.id, n)
    }
    return m
  }
  const build = (files: Record<string, string>, folders: string[], o: { bio?: string | null; multiRoot?: boolean; maxDepth?: number } = {}): GraphData =>
    buildGraph(notesOf(files), {
      folders: {
        all: new Set(folders),
        rootTitle: 'Vault',
        multiRoot: o.multiRoot ?? false,
        maxDepth: o.maxDepth ?? 3,
        ...(o.bio !== undefined ? { bio: o.bio } : {}),
      },
    })
  const nodeOf = (g: GraphData, id: string): GraphNode | undefined => g.nodes[g.index.get(id) ?? -1]

  const files = { 'Bio/Food.md': '# Food\n', 'Work/Plan.md': '# Plan\n' }

  it('marks the Bio folder and no other', () => {
    const g = build(files, ['Bio', 'Work'], { bio: 'Bio' })
    expect(nodeOf(g, folderKey('Bio'))?.folder?.bio).toBe(true)
    expect(nodeOf(g, folderKey('Bio'))?.folder?.role).toBe('folder')
    for (const id of [folderKey('Work'), folderKey('')]) expect(nodeOf(g, id)?.folder && 'bio' in nodeOf(g, id)!.folder!, id).toBe(false)
    expect(g.nodes.filter((n) => n.folder?.bio).length).toBe(1)
  })

  it('marks nothing when it is not asked for', () => {
    for (const bio of [undefined, null, '']) expect(build(files, ['Bio', 'Work'], bio === undefined ? {} : { bio }).nodes.some((n) => n.folder?.bio), String(bio)).toBe(false)
  })

  it('shows it even when it is empty and deep, like a project star', () => {
    // Two roots, one level shown: D/Bio is depth 2 and holds nothing, so only being asked for keeps it in the sky.
    const folders = ['D', 'D/Bio', 'F']
    expect(nodeOf(build({}, folders, { multiRoot: true, maxDepth: 1 }), folderKey('D/Bio'))).toBeUndefined()
    const g = build({}, folders, { multiRoot: true, maxDepth: 1, bio: 'D/Bio' })
    expect(nodeOf(g, folderKey('D/Bio'))?.folder?.bio).toBe(true)
    expect(nodeOf(g, folderKey('D/Bio'))?.parent).toBe(folderKey('D'))
  })

  it('never makes a folder up: with no Bio folder there is no Bio star', () => {
    const g = build({ 'Work/Plan.md': '# Plan\n' }, ['Work'], { bio: 'Bio' })
    expect(nodeOf(g, folderKey('Bio'))).toBeUndefined()
    expect(g.nodes.some((n) => n.folder?.bio)).toBe(false)
  })

  it('never takes a drive for the Bio star', () => {
    // In a vault of several roots a top-level folder is a drive, even one called Bio.
    const g = build({ 'Bio/Food.md': '# Food\n' }, ['Bio', 'Other'], { multiRoot: true, bio: 'Bio' })
    expect(nodeOf(g, folderKey('Bio'))?.folder?.role).toBe('mount')
    expect(g.nodes.some((n) => n.folder?.bio)).toBe(false)
  })

  it('takes the spelling it is given: the store passes the vault’s own', () => {
    expect(build(files, ['Bio', 'Work'], { bio: 'bio' }).nodes.some((n) => n.folder?.bio)).toBe(false)
    const g = build({ 'bio/Food.md': '# Food\n' }, ['bio'], { bio: 'bio' })
    expect(nodeOf(g, folderKey('bio'))?.folder?.bio).toBe(true)
  })

  it('leaves a project star a project star: the mark is on top of its role', () => {
    const g = build(
      { 'Bio/Bio.md': '---\ntype: project\nstatus: active\n---\n# Bio\n', 'Bio/Food.md': '# Food\n' },
      ['Bio'],
      { bio: 'Bio' },
    )
    const star = nodeOf(g, folderKey('Bio'))!
    expect(star.folder?.role).toBe('project')
    expect(star.folder?.bio).toBe(true)
  })

  it('the notes of the Bio folder orbit it like any folder’s', () => {
    const g = build(files, ['Bio', 'Work'], { bio: 'Bio' })
    expect(nodeOf(g, 'Bio/Food')?.parent).toBe(folderKey('Bio'))
    expect(nodeOf(g, folderKey('Bio'))?.folder).toMatchObject({ notes: 1, totalNotes: 1 })
  })
})
