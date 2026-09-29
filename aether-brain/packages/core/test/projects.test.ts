import { describe, expect, it } from 'vitest'
import {
  basenameOf,
  buildGraph,
  defaultProjectFolder,
  extractTasks,
  folderProjectNote,
  isProjectNote,
  parseNote,
  portableFolderRef,
  projectFolderOf,
  projectNote,
  projectSummary,
  setProjectFields,
  splitFrontmatter,
  type NoteId,
  type ParsedNote,
  type VaultRootInfo,
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

  it('resolves a folder written relative to the note\'s root, whichever drives are open', () => {
    const content = '---\ntype: project\nfolder: Unreal Projects/PORTALz\n---\n# PORTALz\n'
    const single = new Set(['Projects', 'Unreal Projects', 'Unreal Projects/PORTALz'])
    expect(projectFolderOf(note('Projects/PORTALz.md', content), single)).toBe('Unreal Projects/PORTALz')
    // F:\ added: the note is now D/Projects/PORTALz.md and the folder D/Unreal Projects/PORTALz.
    const multi = new Set(['D', 'F', ...[...single].map((f) => `D/${f}`)])
    expect(projectFolderOf(note('D/Projects/PORTALz.md', content), multi)).toBe('D/Unreal Projects/PORTALz')
    // A full path written while two drives were open still binds after one is removed.
    const full = '---\ntype: project\nfolder: D/Unreal Projects/PORTALz\n---\n# PORTALz\n'
    expect(projectFolderOf(note('D/Projects/PORTALz.md', full), multi)).toBe('D/Unreal Projects/PORTALz')
    expect(projectFolderOf(note('Projects/PORTALz.md', full), single)).toBe('Unreal Projects/PORTALz')
    // A folder on another drive, written in full, stays there.
    const other = '---\ntype: project\nfolder: F/Games/X\n---\n# X\n'
    expect(projectFolderOf(note('D/Projects/X.md', other), new Set(['D', 'F', 'F/Games', 'F/Games/X', 'D/F/Games/X']))).toBe('F/Games/X')
    // Missing everywhere: returned as written, so the UI can offer to create it.
    expect(projectFolderOf(note('D/Projects/X.md', '---\nfolder: Nope/Here\n---\n'), multi)).toBe('Nope/Here')
  })

  it('writes folder: relative to the note\'s root', () => {
    const roots: VaultRootInfo[] = [
      { abs: 'D:\\', mount: 'D', label: 'D:\\' },
      { abs: 'F:\\', mount: 'F', label: 'F:\\' },
    ]
    expect(portableFolderRef('D/Projects/X.md', 'D/Unreal Projects/X', roots)).toBe('Unreal Projects/X')
    expect(portableFolderRef('D/Projects/X.md', 'D\\Games\\X\\', roots)).toBe('Games/X')
    expect(portableFolderRef('D/Projects/X.md', 'F/Games/X', roots)).toBe('F/Games/X')
    expect(portableFolderRef('D/Projects/X.md', 'D', roots)).toBe('D')
    expect(portableFolderRef('D/Projects/X.md', 'Dx/Games', roots)).toBe('Dx/Games')
    expect(portableFolderRef('Projects/X.md', 'Games/X', [roots[0]!])).toBe('Games/X')
    expect(portableFolderRef('Projects/X.md', 'Games/X', null)).toBe('Games/X')
    // Round trip: what is written binds the same folder with one drive or two.
    const ref = portableFolderRef('D/Projects/X.md', 'D/Unreal Projects/X', roots)
    const content = `---\ntype: project\nfolder: ${ref}\n---\n# X\n`
    expect(projectFolderOf(note('D/Projects/X.md', content), new Set(['D', 'D/Unreal Projects', 'D/Unreal Projects/X', 'F']))).toBe('D/Unreal Projects/X')
    expect(projectFolderOf(note('Projects/X.md', content), new Set(['Unreal Projects', 'Unreal Projects/X']))).toBe('Unreal Projects/X')
  })

  it('never reads a folder of the note\'s own drive as another drive\'s folder', () => {
    const roots: VaultRootInfo[] = [
      { abs: 'D:\\', mount: 'D', label: 'D:\\' },
      { abs: 'F:\\', mount: 'F', label: 'F:\\' },
    ]
    // D:\F\Games stays written in full: `F/Games` would bind drive F's Games folder.
    expect(portableFolderRef('D/Projects/X.md', 'D/F/Games', roots)).toBe('D/F/Games')
    expect(portableFolderRef('D/Projects/X.md', 'D/f', roots)).toBe('D/f')
    const content = `---\ntype: project\nfolder: ${portableFolderRef('D/Projects/X.md', 'D/F/Games', roots)}\n---\n# X\n`
    expect(projectFolderOf(note('D/Projects/X.md', content), new Set(['D', 'D/F', 'D/F/Games', 'F', 'F/Games']))).toBe('D/F/Games')
    // With only D:\ open the same text still finds it.
    expect(projectFolderOf(note('Projects/X.md', content), new Set(['F', 'F/Games', 'Projects']))).toBe('F/Games')
  })

  it('never shifts a plain vault path that does not exist yet onto an unrelated folder', () => {
    // `Projects/Game` is to be created; the top-level `Game` and `Projects/Projects/Game` are other folders.
    const content = '---\ntype: project\nfolder: Projects/Game\n---\n# Game\n'
    expect(projectFolderOf(note('Projects/Game.md', content), new Set(['Projects', 'Game']))).toBe('Projects/Game')
    expect(projectFolderOf(note('Projects/Game.md', content), new Set(['Projects', 'Projects/Projects', 'Projects/Projects/Game']))).toBe(
      'Projects/Game',
    )
    // A single segment that is itself a folder resolves as written.
    expect(projectFolderOf(note('Projects/Game.md', '---\nfolder: Game\n---\n'), new Set(['Projects', 'Game']))).toBe('Game')
    // The mount-shift rules still apply when the first segment is no folder here.
    expect(projectFolderOf(note('Projects/Game.md', '---\nfolder: D/Game\n---\n'), new Set(['Projects', 'Game']))).toBe('Game')
    expect(projectFolderOf(note('D/Projects/Game.md', '---\nfolder: Game\n---\n'), new Set(['D', 'D/Game']))).toBe('D/Game')
  })

  it('keeps a linked project bound (a star) when a drive is added', () => {
    const content = '---\ntype: project\nfolder: Unreal Projects/PORTALz\n---\n# PORTALz\n'
    const folders = ['Projects', 'Unreal Projects', 'Unreal Projects/PORTALz', 'Unreal Projects/PORTALz/Art']
    const stars = (paths: [string, string[]], multiRoot: boolean) => {
      const n = parseNote({ path: paths[0], content })
      const g = buildGraph(new Map([[n.meta.id, n]]), { folders: { all: paths[1], rootTitle: 'V', multiRoot } })
      return g.nodes.filter((x) => x.folder?.role === 'project').map((x) => [x.id, x.folder?.projectId])
    }
    expect(stars(['Projects/PORTALz.md', folders], false)).toEqual([['folder:Unreal Projects/PORTALz', 'Projects/PORTALz']])
    expect(stars(['D/Projects/PORTALz.md', ['D', 'F', ...folders.map((f) => `D/${f}`)]], true)).toEqual([
      ['folder:D/Unreal Projects/PORTALz', 'D/Projects/PORTALz'],
    ])
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
    // Blank or comment-only blocks parse (to nothing): the new key joins them, the comment stays.
    expect(setProjectFields('---\n# only a comment\n---\n# A\n', { status: 'x' })).toBe('---\n# only a comment\nstatus: x\n---\n# A\n')
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

describe('setProjectFields: renames keep every old name resolving', () => {
  /** Rename like the board does: new title + file renamed to the title's slug. */
  const rename = (n: ParsedNote, title: string): ParsedNote => {
    const raw = setProjectFields(n.raw, { title }, { oldTitle: n.meta.title, keepAliases: [basenameOf(n.meta.path)] })
    return parseNote({ path: `${n.meta.folder}/${title}.md`, content: raw })
  }

  it('keeps file-name titles, setext titles and old file names as aliases', () => {
    const monolith = parseNote({ path: 'Projects/Monolith.md', content: 'Big stone generator.\n\n- [ ] carve\n' })
    const gate = parseNote({ path: 'Projects/Gate.md', content: 'Gate\n====\n\nSome text\n' })
    const portal = parseNote({ path: 'Projects/portal-game.md', content: '---\ntitle: Portal Game\n---\n# Portal Game\n\nx\n' })
    expect([monolith.meta.title, gate.meta.title, portal.meta.title]).toEqual(['Monolith', 'Gate', 'Portal Game'])
    const a = rename(monolith, 'Obelisk')
    expect(a.raw).toBe('---\ntitle: Obelisk\naliases: [Monolith]\n---\n\nBig stone generator.\n\n- [ ] carve\n')
    const b = rename(gate, 'Verdant Gate')
    expect(b.meta.aliases).toEqual(['Gate'])
    const c = rename(portal, 'Portal Quest')
    expect(c.meta.aliases).toEqual(['Portal Game', 'portal-game'])
    expect(c.raw).toBe('---\ntitle: Portal Quest\naliases: [Portal Game, portal-game]\n---\n# Portal Quest\n\nx\n')

    const links = parseNote({ path: 'Notes/A.md', content: '# A\n\n[[Monolith]] [[Gate]] [[portal-game]] [[Portal Game]]\n' })
    const notes = new Map<NoteId, ParsedNote>([a, b, c, links].map((n) => [n.meta.id, n]))
    const g = buildGraph(notes)
    expect(g.nodes.filter((n) => n.ghost).map((n) => n.id)).toEqual([])
    expect(g.outlinks.get('Notes/A')).toEqual(new Set(['Projects/Obelisk', 'Projects/Verdant Gate', 'Projects/Portal Quest']))
  })

  it('adds the extra names only on a real title change', () => {
    const raw = '# Old\n'
    expect(setProjectFields(raw, { title: 'Old' }, { oldTitle: 'Old', keepAliases: ['old-file'] })).toBe(raw)
    expect(setProjectFields(raw, { status: 'x' }, { oldTitle: 'Old', keepAliases: ['old-file'] })).toBe('---\nstatus: x\n---\n\n# Old\n')
    // A note titled by its file name, saved under that same title: nothing to write.
    const plain = 'Big stone generator.\n'
    expect(setProjectFields(plain, { title: 'Monolith' }, { oldTitle: 'Monolith', keepAliases: ['Monolith'] })).toBe(plain)
    // The new title itself and duplicates (any case) are not kept.
    const out = setProjectFields(raw, { title: 'New' }, { oldTitle: 'Old', keepAliases: ['new', 'OLD', ' spaced   name '] })
    expect(splitFrontmatter(out).frontmatter['aliases']).toEqual(['Old', 'spaced name'])
  })
})

describe('setProjectFields: frontmatter is patched in place', () => {
  it('leaves comments and the values of untouched keys exactly as written', () => {
    const raw =
      '---\ntitle: Gate\n# owner: me (keep this)\nversion: 1.10\nstatus: active\nid: 01234\ndiscord: 123456789012345678901\n---\n# Gate\n\nx\n'
    expect(setProjectFields(raw, { status: 'paused' })).toBe(raw.replace('status: active', 'status: paused'))
    expect(setProjectFields(raw, { tags: ['a'] })).toBe(raw.replace('discord: 123456789012345678901\n', 'discord: 123456789012345678901\ntags: [a]\n'))
    expect(setProjectFields(raw, { status: null })).toBe(raw.replace('status: active\n', ''))
    // A multi-line value is replaced as a whole; the lines around it stay.
    const block = '---\ntitle: A\ntags:\n  - one\n  - two\n# after the tags\nstatus: active\n---\n# A\n'
    expect(setProjectFields(block, { tags: ['three'] })).toBe('---\ntitle: A\ntags: [three]\n# after the tags\nstatus: active\n---\n# A\n')
    expect(setProjectFields(block, { title: 'B' })).toBe(
      '---\ntitle: B\ntags:\n  - one\n  - two\n# after the tags\nstatus: active\naliases: [A]\n---\n# B\n',
    )
  })

  it('keeps a CRLF block CRLF, untouched lines included', () => {
    const raw = '---\r\ntitle: A\r\nversion: 1.10\r\n---\r\n# A\r\n'
    expect(setProjectFields(raw, { status: 'x' })).toBe('---\r\ntitle: A\r\nversion: 1.10\r\nstatus: x\r\n---\r\n# A\r\n')
    expect(setProjectFields(raw, { title: 'B' })).toBe('---\r\ntitle: B\r\nversion: 1.10\r\naliases: [A]\r\n---\r\n# B\r\n')
  })

  it('stays fast on long whitespace runs in the H1 and a broken block', () => {
    const ws = ' '.repeat(50_000)
    const start = performance.now()
    expect(setProjectFields(`# a${ws}x\n`, { summary: 'S' })).toBe(`# a${ws}x\n\n> S\n`)
    expect(() => setProjectFields(`---\n${ws}x: [\n---\n# A\n`, { status: 'x' })).toThrow(/not valid YAML/)
    const note = parseNote({ path: 'Projects/A.md', content: '# A\n' })
    expect(projectSummary({ ...note, body: `# A\n\n> [[${'[['.repeat(25_000)}\n\n> [a](${'[a]('.repeat(12_000)}\n` }).length).toBeGreaterThan(0)
    expect(performance.now() - start).toBeLessThan(300)
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
