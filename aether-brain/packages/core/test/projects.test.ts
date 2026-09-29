import { describe, expect, it } from 'vitest'
import {
  buildGraph,
  defaultProjectFolder,
  extractTasks,
  folderProjectNote,
  isProjectNote,
  parseNote,
  projectFolderOf,
  projectNote,
  projectSummary,
  setProjectFields,
  splitFrontmatter,
  type NoteId,
  type ParsedNote,
} from '../src'

const note = (path: string, content = '# Note\n') => parseNote({ path, content })

const PORTALZ = `---
title: PORTALz
type: project
tags: [gamedev, portal-game]
created: 2026-01-12
updated: 2026-09-24
status: active
aliases: [Portalz, Portal game]
---
# PORTALz

> The portal game, whole.

This board is the umbrella; see [[Portal Game Vertical Slice]].

## To do

- [ ] Hero monolith
- [x] Mood boards ✅ 2026-03-02

> A quote in the notes that is not the summary.
`

describe('isProjectNote', () => {
  it('uses position in the Projects area folder', () => {
    expect(isProjectNote(note('Projects/X.md'))).toBe(true)
    expect(isProjectNote(note('1 Projects/X.md'))).toBe(true)
    expect(isProjectNote(note('D/Projects/X.md'))).toBe(true)
    expect(isProjectNote(note('a/b/Projects/X.md'))).toBe(false)
    expect(isProjectNote(note('Areas/Projects/X.md'))).toBe(false)
    expect(isProjectNote(note('Inbox/X.md'))).toBe(false)
    expect(isProjectNote(note('X.md'))).toBe(false)
  })

  it('accepts folder notes of direct children only', () => {
    expect(isProjectNote(note('Projects/X/X.md'))).toBe(true)
    expect(isProjectNote(note('Projects/Portalz/PORTALz.md'))).toBe(true)
    expect(isProjectNote(note('D/Projects/X/X.md'))).toBe(true)
    expect(isProjectNote(note('Projects/X/Y.md'))).toBe(false)
    const deep = note('Projects/X/Art/Y.md')
    expect(deep.meta.type).toBe('project') // folder-derived — not what decides
    expect(isProjectNote(deep)).toBe(false)
    expect(isProjectNote(note('Projects/X/Art/Art.md'))).toBe(false)
  })

  it("does not make the Projects folder's own index note a project", () => {
    expect(isProjectNote(note('Projects/Projects.md'))).toBe(false)
    expect(isProjectNote(note('1 Projects/1 projects.md'))).toBe(false)
    expect(isProjectNote(note('D/Projects/Projects.md'))).toBe(false)
    expect(isProjectNote(note('Projects/Projects.md', '---\ntype: project\n---\n# Projects\n'))).toBe(true)
  })

  it('honours an explicit type: project anywhere, but never in Archive', () => {
    expect(isProjectNote(note('Areas/Work/Client.md', '---\ntype: project\n---\n# Client\n'))).toBe(true)
    expect(isProjectNote(note('Projects/X/Art/Y.md', '---\ntype: project\n---\n# Y\n'))).toBe(true)
    expect(isProjectNote(note('Archive/Old.md', '---\ntype: project\n---\n# Old\n'))).toBe(false)
    expect(isProjectNote(note('D/Archive/Old.md', '---\ntype: project\n---\n# Old\n'))).toBe(false)
    expect(isProjectNote(note('Projects/Done.md', '---\narea: archive\n---\n# Done\n'))).toBe(false)
  })
})

describe('projectFolderOf', () => {
  const folders = new Set(['Projects', 'Projects/PORTALz', 'Projects/PORTALz/Art', 'Work/Client'])

  it('1: an explicit folder wins, normalized, even when missing', () => {
    expect(projectFolderOf(note('Projects/PORTALz.md', '---\nfolder: Work\\Client\\\n---\n'), folders)).toBe('Work/Client')
    expect(projectFolderOf(note('Projects/PORTALz/PORTALz.md', '---\nfolder: New/Place\n---\n'), folders)).toBe('New/Place')
    expect(projectFolderOf(note('Projects/PORTALz.md', '---\nfolder: /\n---\n'), folders)).toBe('Projects/PORTALz')
  })

  it('2: a folder note is the project of its folder', () => {
    expect(projectFolderOf(note('Projects/PORTALz/portalz.md'), new Set())).toBe('Projects/PORTALz')
    expect(projectFolderOf(note('Work/Client/Client.md'), folders)).toBe('Work/Client')
  })

  it('3: a sibling folder named like the note, when it exists', () => {
    expect(projectFolderOf(note('Projects/PORTALz.md'), folders)).toBe('Projects/PORTALz')
    expect(projectFolderOf(note('Projects/ConceptForge.md'), folders)).toBeNull()
    expect(projectFolderOf(note('Projects.md'), folders)).toBe('Projects')
  })

  it('suggests a default folder next to the note', () => {
    expect(defaultProjectFolder(note('Projects/ConceptForge.md'))).toBe('Projects/ConceptForge')
    expect(defaultProjectFolder(note('D/Projects/New Game.md'))).toBe('D/Projects/New Game')
    expect(defaultProjectFolder(note('Loose.md'))).toBe('Loose')
  })
})

describe('setProjectFields', () => {
  const bodyOf = (raw: string) => splitFrontmatter(raw).body
  const fmOf = (raw: string) => splitFrontmatter(raw).frontmatter

  it('renames: frontmatter title, first H1, old title kept as an alias', () => {
    const out = setProjectFields(PORTALZ, { title: 'Verdant Gate' })
    expect(fmOf(out)['title']).toBe('Verdant Gate')
    // 'Portalz' already covers 'PORTALz' (resolution is case-insensitive).
    expect(fmOf(out)['aliases']).toEqual(['Portalz', 'Portal game'])
    expect(bodyOf(out)).toBe(bodyOf(PORTALZ).replace('# PORTALz', '# Verdant Gate'))
    // Renaming to the same title changes nothing.
    expect(setProjectFields(out, { title: 'Verdant Gate' })).toBe(out)
    const next = setProjectFields(out, { title: 'Ruin Runner' })
    expect(fmOf(next)['aliases']).toEqual(['Portalz', 'Portal game', 'Verdant Gate'])
    // Renaming back to an alias drops that alias, and keeps the others.
    const back = setProjectFields(next, { title: 'Portal game' })
    expect(fmOf(back)['aliases']).toEqual(['Portalz', 'Verdant Gate', 'Ruin Runner'])
    const plain = setProjectFields('---\ntitle: A\n---\n# A\n', { title: 'B' })
    expect(plain).toBe('---\ntitle: B\naliases: [A]\n---\n# B\n')
  })

  it('keeps [[links]] to the old title resolving after a rename', () => {
    const renamed = setProjectFields(PORTALZ, { title: 'Verdant Gate' })
    const notes = new Map<NoteId, ParsedNote>()
    for (const n of [
      parseNote({ path: 'Projects/PORTALz.md', content: renamed }),
      parseNote({ path: 'Inbox/Idea.md', content: '# Idea\n\nFor [[PORTALz]] and [[Verdant Gate]].\n' }),
    ])
      notes.set(n.meta.id, n)
    const g = buildGraph(notes)
    expect(g.outlinks.get('Inbox/Idea')).toEqual(new Set(['Projects/PORTALz']))
    expect(g.unresolved.has('ghost:PORTALz')).toBe(false)
    expect(g.nodes.filter((n) => n.ghost).map((n) => n.id)).toEqual(['ghost:Portal Game Vertical Slice'])
    expect(notes.get('Projects/PORTALz')?.meta.title).toBe('Verdant Gate')
  })

  it('replaces, inserts and removes the summary blockquote', () => {
    const replaced = setProjectFields(PORTALZ, { summary: 'A gate in the rainforest.\nTwo lines become one.' })
    expect(bodyOf(replaced)).toBe(bodyOf(PORTALZ).replace('> The portal game, whole.', '> A gate in the rainforest. Two lines become one.'))
    // Frontmatter untouched byte for byte when no key changes.
    expect(replaced.slice(0, replaced.indexOf('# PORTALz'))).toBe(PORTALZ.slice(0, PORTALZ.indexOf('# PORTALz')))

    const removed = setProjectFields(PORTALZ, { summary: null })
    expect(bodyOf(removed)).toBe(bodyOf(PORTALZ).replace('> The portal game, whole.\n\n', ''))
    expect(setProjectFields(PORTALZ, { summary: '' })).toBe(removed)
    // The later quote in the notes is not the summary.
    expect(setProjectFields(removed, { summary: null })).toBe(removed)
    expect(removed).toContain('> A quote in the notes that is not the summary.')

    const inserted = setProjectFields(removed, { summary: 'Back again.' })
    expect(inserted).toBe(setProjectFields(PORTALZ, { summary: 'Back again.' }))
    expect(setProjectFields('# X\n', { summary: 'S' })).toBe('# X\n\n> S\n')
    expect(setProjectFields('# X', { summary: 'S' })).toBe('# X\n\n> S')
    expect(setProjectFields('# X\nText\n', { summary: 'S' })).toBe('# X\n\n> S\n\nText\n')
    expect(setProjectFields('Intro text\n', { summary: 'S' })).toBe('> S\n\nIntro text\n')
    expect(setProjectFields('# X\r\n\r\nText\r\n', { summary: 'S' })).toBe('# X\r\n\r\n> S\r\n\r\nText\r\n')
  })

  it('sets and deletes status, tags and folder; the body stays byte-identical', () => {
    const out = setProjectFields(PORTALZ, { status: 'paused', tags: ['#Unreal', 'gamedev', 'gamedev', ' '], folder: 'Projects\\PORTALz\\' })
    const fm = fmOf(out)
    expect(fm['status']).toBe('paused')
    expect(fm['tags']).toEqual(['unreal', 'gamedev'])
    expect(fm['folder']).toBe('Projects/PORTALz')
    expect(fm['created']).toBe('2026-01-12')
    expect(bodyOf(out)).toBe(bodyOf(PORTALZ))
    expect(out.endsWith(bodyOf(PORTALZ))).toBe(true)
    expect(Object.keys(fm)).toEqual(['title', 'type', 'tags', 'created', 'updated', 'status', 'aliases', 'folder'])

    const cleared = setProjectFields(out, { status: null, folder: null })
    expect('status' in fmOf(cleared)).toBe(false)
    expect('folder' in fmOf(cleared)).toBe(false)
    expect(fmOf(setProjectFields(out, { status: '  ', folder: '' }))).toEqual(fmOf(cleared))
    expect(bodyOf(cleared)).toBe(bodyOf(PORTALZ))
    expect(extractTasks(cleared).map((t) => t.text)).toEqual(['Hero monolith', 'Mood boards'])
    expect(setProjectFields(PORTALZ, {})).toBe(PORTALZ)
  })

  it('adds frontmatter to a note without any', () => {
    const out = setProjectFields('# Old\n\nBody\n', { title: 'New', status: 'active' })
    expect(out).toBe('---\ntitle: New\naliases: [Old]\nstatus: active\n---\n\n# New\n\nBody\n')
  })

  it('treats saving the current title as a no-op', () => {
    for (const raw of ['# Learn C#\n\nBody\n', '# **PORTALz**\n', '---\ntitle: PORTALz\n---\n# PORTALz, the portal game\n', '# A\n']) {
      const title = parseNote({ path: 'Projects/x.md', content: raw }).meta.title
      expect(setProjectFields(raw, { title, status: undefined })).toBe(raw)
    }
    // A real rename still rewrites the H1 and keeps the old title as it reads.
    const bold = setProjectFields('# **PORTALz**\n', { title: 'Verdant Gate' })
    expect(fmOf(bold)).toEqual({ title: 'Verdant Gate', aliases: ['PORTALz'] })
    expect(bodyOf(bold)).toBe('\n# Verdant Gate\n')
    const sharp = setProjectFields('# Learn C#\n', { title: 'Learn F#' })
    expect(fmOf(sharp)).toEqual({ title: 'Learn F#', aliases: ['Learn C#'] })
    expect(bodyOf(sharp)).toBe('\n# Learn F#\n')
    expect(setProjectFields('# Closed #\n', { title: 'New' })).toContain('aliases: [Closed]')
  })

  it('keeps CRLF files CRLF, frontmatter included', () => {
    const crlf = PORTALZ.replace(/\n/g, '\r\n')
    const out = setProjectFields(crlf, { title: 'Verdant Gate', status: 'paused', summary: 'New summary.' })
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
    expect(out).toBe(setProjectFields(PORTALZ, { title: 'Verdant Gate', status: 'paused', summary: 'New summary.' }).replace(/\n/g, '\r\n'))
    expect(setProjectFields('# A\r\n\r\nBody\r\n', { status: 'x' })).toBe('---\r\nstatus: x\r\n---\r\n\r\n# A\r\n\r\nBody\r\n')
  })

  it('leaves every untouched line of a mixed-ending body byte-identical', () => {
    const mixed = '# A\r\n\r\n> old\nText one\r\nText two\n'
    expect(setProjectFields(mixed, { summary: 'new' })).toBe('# A\r\n\r\n> new\nText one\r\nText two\n')
    expect(setProjectFields(mixed, { title: 'B' })).toBe('---\r\ntitle: B\r\naliases: [A]\r\n---\r\n\r\n# B\r\n\r\n> old\nText one\r\nText two\n')
    expect(setProjectFields('# A\n\n> S\r\nMore\n', { summary: null })).toBe('# A\n\nMore\n')
  })

  it('keeps a byte-order mark first and rewrites an empty frontmatter block in place', () => {
    expect(setProjectFields('\uFEFF---\ntitle: A\n---\n# A\n', { status: 'x' })).toBe('\uFEFF---\ntitle: A\nstatus: x\n---\n# A\n')
    expect(setProjectFields('\uFEFF# A\n', { title: 'B' })).toBe('\uFEFF---\ntitle: B\naliases: [A]\n---\n\n# B\n')
    expect(setProjectFields('\uFEFF# A\n', { summary: 'S' })).toBe('\uFEFF# A\n\n> S\n')
    expect(setProjectFields('---\n---\n# A\n', { status: 'x' })).toBe('---\nstatus: x\n---\n# A\n')
  })

  it('refuses to rewrite frontmatter it could not parse', () => {
    const broken = '---\ntitle: A\ntags: [unclosed\nnotes: keep me\n---\n# A\n'
    expect(() => setProjectFields(broken, { status: 'paused' })).toThrow(/not valid YAML/)
    expect(() => setProjectFields(broken, { title: 'B' })).toThrow(/not valid YAML/)
    // Body-only edits leave the block alone, so they still work.
    expect(setProjectFields(broken, { summary: 'S' })).toBe(`${broken.replace('# A\n', '# A\n\n> S\n')}`)
    // Blank or comment-only blocks hold nothing to lose.
    expect(setProjectFields('---\n# only a comment\n---\n# A\n', { status: 'x' })).toBe('---\nstatus: x\n---\n# A\n')
  })

  it('keeps multi-word string aliases whole and dedupes the alias list', () => {
    expect(fmOf(setProjectFields('---\ntitle: Old\naliases: Portal game\n---\n# Old\n', { title: 'New' }))['aliases']).toEqual([
      'Portal game',
      'Old',
    ])
    expect(fmOf(setProjectFields('---\ntitle: Old\naliases: One, Two words\n---\n', { title: 'New' }))['aliases']).toEqual([
      'One',
      'Two words',
      'Old',
    ])
    expect(fmOf(setProjectFields('---\ntitle: A\naliases: [X, x, X, new]\n---\n# A\n', { title: 'New' }))['aliases']).toEqual(['X', 'A'])
  })
})

describe('projectSummary', () => {
  it('reads the blockquote after the H1', () => {
    expect(projectSummary(parseNote({ path: 'Projects/PORTALz.md', content: PORTALZ }))).toBe('The portal game, whole.')
    expect(projectSummary(note('Projects/A.md', '# A\n\n> One [[B|bee]] and\n> **two** lines.\n'))).toBe('One bee and two lines.')
  })

  it('falls back to the first paragraph, skipping headings and lists', () => {
    const n = note('Projects/A.md', '# A\n\n## To do\n\n- [ ] task\n\nThe *real* point of [[Aether Brain#Idea]], see [site](http://x).\nSecond line.\n\nLater.\n')
    expect(projectSummary(n)).toBe('The real point of Aether Brain, see site. Second line.')
    expect(projectSummary(note('Projects/B.md', '# B\n'))).toBe('')
  })
})

describe('project notes', () => {
  const now = new Date('2026-09-24T12:00:00Z')

  it('projectNote takes a dir and a home folder', () => {
    const p = projectNote({ name: 'Verdant Gate', dir: 'D/Projects/', folder: 'D/Games/Verdant Gate/' }, now)
    expect(p.path).toBe('D/Projects/Verdant Gate.md')
    const n = parseNote({ path: p.path, content: p.content })
    expect(n.frontmatter['folder']).toBe('D/Games/Verdant Gate')
    expect(isProjectNote(n)).toBe(true)
    expect(projectFolderOf(n, new Set())).toBe('D/Games/Verdant Gate')
    expect(projectNote({ name: 'Root', dir: '' }, now).path).toBe('Root.md')
    expect(projectNote({ name: 'Plain' }, now).content).not.toContain('folder:')
  })

  it('folderProjectNote makes an existing folder a project', () => {
    const p = folderProjectNote('Projects/PORTALz/', { summary: 'Portal game', tags: ['gamedev'] }, now)
    expect(p).toMatchObject({ path: 'Projects/PORTALz/PORTALz.md', title: 'PORTALz' })
    const n = parseNote({ path: p.path, content: p.content })
    expect(isProjectNote(n)).toBe(true)
    expect(projectFolderOf(n, new Set())).toBe('Projects/PORTALz')
    expect(projectSummary(n)).toBe('Portal game')
    expect(n.meta.tags).toEqual(['gamedev'])
    expect(extractTasks(n.raw)).toHaveLength(1)

    const outside = folderProjectNote('Work/Client #1', {}, now)
    expect(outside.path).toBe('Work/Client #1/Client #1.md')
    const o = parseNote({ path: outside.path, content: outside.content })
    expect(isProjectNote(o)).toBe(true)
    expect(projectFolderOf(o, new Set())).toBe('Work/Client #1')
    expect(() => folderProjectNote('/')).toThrow()
  })
})
