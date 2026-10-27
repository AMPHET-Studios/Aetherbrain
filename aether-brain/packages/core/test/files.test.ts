import { describe, expect, it } from 'vitest'
import { assetMap, buildGraph, fileKindOf, fileMap, folderKey, imageKey, isFileMoonPath, isPlanetNode, parseNote, type NoteId, type ParsedNote, type VaultAsset } from '../src'
import { FILE_MOONS_PER_FOLDER, FILE_MOONS_TOTAL, extOf } from '../src/vault/files'

/** Every file is a moon: what counts as one, and how few of them a folder and the sky ever show. */

describe('which files can be moons', () => {
  it('takes the things people keep: audio, documents, archives, data, code, design files', () => {
    for (const p of ['Music/theme.mp3', 'Docs/plan.pdf', 'Backup/old.zip', 'Data/sheet.xlsx', 'Mod/weapon.lua', 'Art/char.psd', 'Misc/notes.xyz']) {
      expect(isFileMoonPath(p), p).toBe(true)
    }
  })

  it('leaves out notes, pictures, videos and models (they have their own kinds)', () => {
    for (const p of ['A/note.md', 'A/pic.png', 'A/clip.mp4', 'A/robot.glb', 'A/PIC.JPG']) expect(isFileMoonPath(p), p).toBe(false)
  })

  it('leaves out clutter: hidden, build output, caches, system files, no extension', () => {
    for (const p of ['A/.hidden.txt', '.git/config.txt', 'node_modules/x/readme.txt', 'A/app.js.map', 'A/yarn.lock', 'A/debug.log', 'A/x.dll', 'A/Thumbs.db', 'A/desktop.ini', 'A/Makefile', 'proj/dist/bundle.zip', 'Game/Intermediate/a.txt', 'Game/DerivedDataCache/b.bin', 'p/__pycache__/m.txt']) {
      expect(isFileMoonPath(p), p).toBe(false)
    }
  })

  it('names the kind by extension, in any letter case, and calls the rest other', () => {
    expect(fileKindOf('a/Song.MP3')).toBe('audio')
    expect(fileKindOf('a/x.pdf')).toBe('document')
    expect(fileKindOf('a/x.7z')).toBe('archive')
    expect(fileKindOf('a/x.json')).toBe('data')
    expect(fileKindOf('a/x.lua')).toBe('code')
    expect(fileKindOf('a/x.blend')).toBe('design')
    expect(fileKindOf('a/x.zzz')).toBe('other')
    expect(extOf('a/b.c/d')).toBe('')
    expect(extOf('a/.env')).toBe('')
    expect(extOf('a/file.')).toBe('')
  })

  it('makes a map of the files only, with a time and size only where they are known', () => {
    const list: VaultAsset[] = [{ path: 'M/a.mp3', mtime: 5, size: 100 }, { path: 'M/b.png' }, { path: 'M/c.md' }, { path: 'M/d.lock' }, { path: 'M/e.pdf', mtime: Number.NaN }]
    const m = fileMap(list)
    expect([...m.keys()].sort()).toEqual(['M/a.mp3', 'M/e.pdf'])
    expect(m.get('M/a.mp3')).toEqual({ path: 'M/a.mp3', mtime: 5, size: 100 })
    expect(m.get('M/e.pdf')).toEqual({ path: 'M/e.pdf' })
  })
})

function graphOf(files: VaultAsset[], opts: { perFolder?: number; total?: number; pictures?: VaultAsset[] } = {}) {
  const notes = new Map<NoteId, ParsedNote>()
  for (const path of ['Music/Music.md', 'Docs/Docs.md', 'Docs/Deep/Spec.md']) {
    const n = parseNote({ path, content: '# Note\n' })
    notes.set(n.meta.id, n)
  }
  const folders = new Set(['Music', 'Docs', 'Docs/Deep'])
  return buildGraph(notes, {
    folders: { all: folders, rootTitle: 'Vault', multiRoot: false, maxDepth: 3, maxFolders: 0 },
    images: {
      all: assetMap(opts.pictures ?? []),
      moons: true,
      files: fileMap(files),
      ...(opts.perFolder !== undefined ? { maxFilesPerFolder: opts.perFolder } : {}),
      ...(opts.total !== undefined ? { maxFiles: opts.total } : {}),
    },
  })
}

describe('file moons in the graph', () => {
  const files: VaultAsset[] = [
    { path: 'Music/old.mp3', mtime: 1, size: 5_000_000 },
    { path: 'Music/new.mp3', mtime: 9, size: 3_000_000 },
    { path: 'Docs/plan.pdf', mtime: 5, size: 20_000 },
    { path: 'Docs/Deep/spec.docx', mtime: 4, size: 90_000 },
  ]

  it('gives each file a moon of its folder, with its kind, and never a thumbnail', () => {
    const g = graphOf(files)
    const node = g.nodes[g.index.get(imageKey('Music/new.mp3'))!]!
    expect(node.kind).toBe('image')
    expect(node.parent).toBe(folderKey('Music'))
    expect(node.image?.file).toBe('audio')
    expect(node.image?.video).toBeUndefined()
    expect(node.title).toBe('new.mp3')
    expect(g.nodes[g.index.get(imageKey('Docs/Deep/spec.docx'))!]!.parent).toBe(folderKey('Docs/Deep'))
  })

  it('is a planet when big (or of unknown size) and a moon when small, as for pictures', () => {
    const g = graphOf(files)
    const at = (p: string) => g.nodes[g.index.get(imageKey(p))!]!
    expect(isPlanetNode(at('Music/new.mp3'))).toBe(true)
    expect(isPlanetNode(at('Docs/plan.pdf'))).toBe(false)
  })

  it('shows only the newest few of a folder, and the sky only so many in all', () => {
    const many: VaultAsset[] = Array.from({ length: 40 }, (_, i) => ({ path: `Music/t${String(i).padStart(2, '0')}.mp3`, mtime: i, size: 1000 }))
    const g = graphOf(many)
    const shown = g.nodes.filter((n) => n.image?.file)
    expect(shown.length).toBe(FILE_MOONS_PER_FOLDER)
    expect(shown.map((n) => n.image!.mtime).sort((a, b) => a! - b!)[0]).toBe(40 - FILE_MOONS_PER_FOLDER)
    expect(graphOf(files, { perFolder: 1 }).nodes.filter((n) => n.image?.file).length).toBe(3)
    expect(graphOf(files, { total: 2 }).nodes.filter((n) => n.image?.file).length).toBe(2)
    expect(graphOf(files, { total: 0 }).nodes.filter((n) => n.image?.file).length).toBe(0)
    expect(FILE_MOONS_TOTAL).toBe(800)
  })

  it('leaves the pictures alone: the same pictures, the same counts, with or without files', () => {
    const pics: VaultAsset[] = [{ path: 'Music/cover.png', mtime: 3, size: 100_000 }]
    const without = graphOf([], { pictures: pics })
    const withFiles = graphOf(files, { pictures: pics })
    const picsOf = (g: ReturnType<typeof graphOf>) => g.nodes.filter((n) => n.image && !n.image.file).map((n) => n.id)
    expect(picsOf(withFiles)).toEqual(picsOf(without))
    expect(withFiles.nodes.find((n) => n.id === folderKey('Music'))?.folder?.images).toBe(without.nodes.find((n) => n.id === folderKey('Music'))?.folder?.images)
  })

  it('is the same graph every time', () => {
    expect(graphOf(files).nodes.map((n) => n.id)).toEqual(graphOf(files).nodes.map((n) => n.id))
  })

  it('has no file moons when the graph is built without files', () => {
    const notes = new Map<NoteId, ParsedNote>()
    const g = buildGraph(notes, { folders: { all: new Set(['Music']), rootTitle: 'Vault', multiRoot: false, maxDepth: 3 }, images: { all: new Map(), moons: true } })
    expect(g.nodes.some((n) => n.image?.file)).toBe(false)
  })
})
