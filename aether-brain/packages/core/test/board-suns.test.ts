import { describe, expect, it } from 'vitest'
import { assetMap, buildGraph, folderKey, imageKey, parseNote, type BuildGraphOptions, type GraphData, type GraphNode, type NoteId, type ParsedNote } from '../src'

/**
 * A reference board is a sun (docs/COSMOLOGY.md): in the system layout the pictures on it orbit it instead of their
 * folders, and it is marked (`GraphNode.board`) so it is drawn as a star and laid out as a system of its own.
 */

const board = (title: string, pictures: string[]): string =>
  ['---', `title: ${title}`, 'type: board', '---', `# ${title}`, '', '## Board', '', ...pictures.map((p, i) => `- pic ${p} x=${i * 10} y=0 w=100 h=100`), ''].join('\n')

function notesOf(files: Record<string, string>): Map<NoteId, ParsedNote> {
  const m = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    m.set(n.meta.id, n)
  }
  return m
}

const ASSETS = assetMap([
  { path: 'Art/a.png', mtime: 50, size: 200_000 },
  { path: 'Art/b.png', mtime: 40, size: 200_000 },
  { path: 'Art/free.png', mtime: 30, size: 200_000 },
  { path: 'Refs/c.png', mtime: 20, size: 200_000 },
  { path: 'Refs/clip.mp4', mtime: 10, size: 5_000_000 },
])
const FOLDERS = new Set(['Art', 'Refs', 'Boards'])

function build(files: Record<string, string>, opts: Partial<BuildGraphOptions> = {}): GraphData {
  return buildGraph(notesOf(files), {
    images: { all: ASSETS, moons: true, maxPerFolder: 24 },
    folders: { all: FOLDERS, rootTitle: 'Vault', multiRoot: false, maxDepth: 3 },
    ...opts,
  })
}

const nodeOf = (g: GraphData, id: string): GraphNode => g.nodes[g.index.get(id) ?? -1]!

describe('a reference board is a sun', () => {
  const files = {
    'Boards/PORTALz.md': board('PORTALz', ['Art/a.png', 'Art/b.png', 'Refs/c.png']),
    'Art/Note.md': '# Note\n',
  }

  it('its pictures orbit it, not their folders, and it is marked with how many', () => {
    const g = build(files)
    const sun = nodeOf(g, 'Boards/PORTALz')
    expect(sun.type).toBe('board')
    expect(sun.board).toEqual({ pictures: 3 })
    // The sun itself orbits its folder like any note.
    expect(sun.parent).toBe(folderKey('Boards'))
    for (const p of ['Art/a.png', 'Art/b.png', 'Refs/c.png']) {
      const picture = nodeOf(g, imageKey(p))
      expect(picture.kind).toBe('image')
      expect(picture.parent, p).toBe('Boards/PORTALz')
    }
  })

  it('leaves the pictures that are on no board with their folder, and counts only those as the folder’s moons', () => {
    const g = build(files)
    expect(nodeOf(g, imageKey('Art/free.png')).parent).toBe(folderKey('Art'))
    expect(nodeOf(g, imageKey('Refs/clip.mp4')).parent).toBe(folderKey('Refs'))
    const art = nodeOf(g, folderKey('Art')).folder!
    // Three pictures lie in Art on disk; two of them are on the board, so one is a moon of the folder.
    expect(art.images).toBe(3)
    expect(art.shownImages).toBe(1)
    // The pictures of Refs: the board holds c.png, the video is a moon.
    expect(nodeOf(g, folderKey('Refs')).folder!.shownImages).toBe(1)
  })

  it('keeps every link: the board still points at each picture (the synapses stay)', () => {
    const g = build(files)
    const out = [...(g.outlinks.get('Boards/PORTALz') ?? [])].sort()
    expect(out).toEqual([imageKey('Art/a.png'), imageKey('Art/b.png'), imageKey('Refs/c.png')])
    expect(g.edges.filter((e) => e.from === 'Boards/PORTALz')).toHaveLength(3)
  })

  it('takes a video on a board too', () => {
    const g = build({ 'Boards/Clips.md': board('Clips', ['Refs/clip.mp4']) })
    expect(nodeOf(g, imageKey('Refs/clip.mp4')).parent).toBe('Boards/Clips')
    expect(nodeOf(g, 'Boards/Clips').board).toEqual({ pictures: 1 })
  })

  it('gives a picture that is on several boards to the first board by id; the others keep their links', () => {
    const g = build({
      'Boards/B.md': board('B', ['Art/a.png', 'Art/b.png']),
      'Boards/A.md': board('A', ['Art/a.png', 'Refs/c.png']),
    })
    // `Boards/A` sorts before `Boards/B`: it holds a.png and c.png, B is left with b.png.
    expect(nodeOf(g, imageKey('Art/a.png')).parent).toBe('Boards/A')
    expect(nodeOf(g, imageKey('Refs/c.png')).parent).toBe('Boards/A')
    expect(nodeOf(g, imageKey('Art/b.png')).parent).toBe('Boards/B')
    expect(nodeOf(g, 'Boards/A').board).toEqual({ pictures: 2 })
    expect(nodeOf(g, 'Boards/B').board).toEqual({ pictures: 1 })
    // B is still linked to a.png.
    expect(g.edges.some((e) => e.from === 'Boards/B' && e.to === imageKey('Art/a.png'))).toBe(true)
  })

  it('does not make a sun of a board with nothing left to orbit it', () => {
    const g = build({
      'Boards/A.md': board('A', ['Art/a.png']),
      // Every picture of B is already A's, and one of its lines names a file that does not exist.
      'Boards/B.md': board('B', ['Art/a.png', 'Art/missing.png']),
      'Boards/Empty.md': board('Empty', []),
    })
    expect(nodeOf(g, 'Boards/A').board).toEqual({ pictures: 1 })
    for (const id of ['Boards/B', 'Boards/Empty']) {
      expect(nodeOf(g, id).board, id).toBeUndefined()
      expect(nodeOf(g, id).parent, id).toBe(folderKey('Boards'))
    }
  })

  it('is only for boards: a note that embeds pictures does not become a sun', () => {
    const g = build({ 'Art/Note.md': '# Note\n\n![[Art/a.png]] ![[Art/b.png]]\n' })
    const note = nodeOf(g, 'Art/Note')
    expect(note.board).toBeUndefined()
    expect(nodeOf(g, imageKey('Art/a.png')).parent).toBe(folderKey('Art'))
  })

  it('is the system layout’s: without folders nothing is parented and no board is marked', () => {
    const g = buildGraph(notesOf(files), { images: { all: ASSETS } })
    expect(nodeOf(g, 'Boards/PORTALz').board).toBeUndefined()
    for (const n of g.nodes) expect(n.parent, n.id).toBeNull()
  })

  it('leaves every parent in the graph (the layout needs each one to exist), whatever the boards hold', () => {
    const g = build({
      'Boards/B.md': board('B', ['Art/a.png', 'Art/b.png']),
      'Boards/A.md': board('A', ['Art/a.png', 'Refs/c.png', 'Refs/clip.mp4']),
      'Art/Note.md': '![[Art/free.png]]\n',
    })
    for (const n of g.nodes) {
      if (n.parent === null) continue
      expect(g.index.has(n.parent), `${n.id} → ${n.parent}`).toBe(true)
    }
  })

  it('does not change what a vault without boards builds', () => {
    const plain = { 'Art/Note.md': '# Note\n\n![[Art/a.png]]\n' }
    const g = build(plain)
    expect(g.nodes.some((n) => n.board)).toBe(false)
    expect(nodeOf(g, imageKey('Art/a.png')).parent).toBe(folderKey('Art'))
    expect(nodeOf(g, folderKey('Art')).folder!.shownImages).toBe(3)
  })
})
