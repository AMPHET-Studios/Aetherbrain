import { describe, expect, it } from 'vitest'
import {
  GALLERY_MAX,
  SearchIndex,
  applyChanges,
  assetMap,
  buildGraph,
  folderKey,
  imageBaseName,
  imageKey,
  isImagePath,
  isMediaPath,
  isVideoPath,
  mimeOf,
  parseNote,
  type BuildGraphOptions,
  type NoteId,
  type ParsedNote,
} from '../src'

function notesOf(files: Record<string, string>): Map<NoteId, ParsedNote> {
  const m = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    m.set(n.meta.id, n)
  }
  return m
}

describe('star gallery', () => {
  const assets = assetMap([
    { path: 'Projects/PORTALz/Art/gate.png', mtime: 30 },
    { path: 'Projects/PORTALz/Art/ruins.JPG', mtime: 20 },
    { path: 'Projects/PORTALz/Art/old.webp', mtime: 10 },
    { path: 'Projects/PORTALz/Art/Sketches/Deep/pose.png', mtime: 40 },
    { path: 'Projects/PORTALz/cover.png', mtime: 5 },
    { path: 'Projects/PORTALzOther/not-mine.png', mtime: 50 },
    { path: 'Resources/Refs/tree.png', mtime: 4 },
  ])
  const files = {
    'Projects/PORTALz.md': '---\ntype: project\n---\n# PORTALz\n\n![[ruins.JPG]]\n',
    'Projects/PORTALz/Art/Moodboard.md': '# Moodboard\n',
    'Resources/Refs/Trees.md': '# Trees\n',
  }
  const folders = new Set([
    'Projects',
    'Projects/PORTALz',
    'Projects/PORTALz/Art',
    'Projects/PORTALz/Art/Sketches',
    'Projects/PORTALz/Art/Sketches/Deep',
    'Projects/PORTALzOther',
    'Resources',
    'Resources/Refs',
  ])
  const build = (images: Partial<NonNullable<BuildGraphOptions['images']>>, maxDepth = 3) =>
    buildGraph(notesOf(files), {
      images: { all: assets, moons: true, maxPerFolder: 2, ...images },
      folders: { all: folders, rootTitle: 'Vault', multiRoot: false, maxDepth },
    })
  const cards = (g: ReturnType<typeof build>) =>
    g.nodes.filter((n) => n.image?.gallery).map((n) => [n.image!.path, n.parent, n.image!.gallery!.rank, n.image!.gallery!.only])

  it('turns every picture under a project star into a card, newest first; moons keep their orbit', () => {
    const closed = build({})
    expect(closed.gallery).toBeNull()
    expect(closed.nodes[closed.index.get(folderKey('Projects/PORTALz'))!]!.folder!.role).toBe('project')
    const open = build({ gallery: 'Projects/PORTALz' })
    const star = folderKey('Projects/PORTALz')
    expect(open.gallery).toEqual({ star, path: 'Projects/PORTALz', cards: 5, videos: 0, total: 5 })
    // The linked picture and the moons stay where they orbit; the rest come in around the star.
    expect(cards(open)).toEqual([
      ['Projects/PORTALz/Art/ruins.JPG', 'folder:Projects/PORTALz/Art', 2, false],
      ['Projects/PORTALz/Art/gate.png', 'folder:Projects/PORTALz/Art', 1, false],
      ['Projects/PORTALz/cover.png', star, 4, false],
      ['Projects/PORTALz/Art/Sketches/Deep/pose.png', star, 0, true],
      ['Projects/PORTALz/Art/old.webp', star, 3, true],
    ])
    // Nothing else changes: the closed graph's nodes come first, in order, with the same parents.
    expect(open.nodes.slice(0, closed.nodes.length - countFolders(closed)).map((n) => [n.id, n.parent])).toEqual(
      closed.nodes.slice(0, closed.nodes.length - countFolders(closed)).map((n) => [n.id, n.parent]),
    )
    expect(open.nodes.filter((n) => n.folder).map((n) => [n.id, n.folder!.shownImages])).toEqual(
      closed.nodes.filter((n) => n.folder).map((n) => [n.id, n.folder!.shownImages]),
    )
    // Pictures of a sibling folder whose name starts the same are not the star's.
    expect(open.nodes[open.index.get(imageKey('Projects/PORTALzOther/not-mine.png'))!]!.image!.gallery).toBeUndefined()
    // Gallery-only cards are structure: no links.
    const pose = open.nodes[open.index.get(imageKey('Projects/PORTALz/Art/Sketches/Deep/pose.png'))!]!
    expect([pose.degree, open.backlinks.get(pose.id)?.size, open.outlinks.get(pose.id)?.size]).toEqual([0, 0, 0])
  })

  it('caps the cards it adds; pictures already in the graph always count', () => {
    const g = build({ gallery: 'Projects/PORTALz', maxGallery: 1 })
    expect(g.gallery).toMatchObject({ cards: 4, total: 5 })
    expect(cards(g).filter((c) => c[3]).map((c) => c[0])).toEqual(['Projects/PORTALz/Art/Sketches/Deep/pose.png'])
    expect(GALLERY_MAX).toBeGreaterThan(100)
  })

  it('works with image moons off: every picture becomes a gallery card', () => {
    const g = build({ gallery: 'Projects/PORTALz', moons: false })
    expect(g.gallery).toMatchObject({ cards: 5, total: 5 })
    expect(cards(g).filter((c) => !c[3]).map((c) => c[0])).toEqual(['Projects/PORTALz/Art/ruins.JPG'])
  })

  it('opens only on a shown project star of a system graph', () => {
    for (const gallery of ['Resources/Refs', 'Projects', '', 'Nope/Missing', 'Projects/PORTALz/Art']) {
      const g = build({ gallery })
      expect(g.gallery).toBeNull()
      expect(cards(g)).toEqual([])
    }
    const classic = buildGraph(notesOf(files), { images: { all: assets, gallery: 'Projects/PORTALz' } })
    expect(classic.gallery).toBeNull()
    expect(classic.nodes.some((n) => n.image?.gallery)).toBe(false)
    // A star with no pictures: no gallery.
    const empty = buildGraph(notesOf(files), {
      images: { all: assetMap([{ path: 'Resources/Refs/tree.png', mtime: 1 }]), gallery: 'Projects/PORTALz' },
      folders: { all: folders, rootTitle: 'Vault', multiRoot: false, maxDepth: 3 },
    })
    expect(empty.gallery).toBeNull()
  })

  it('copes with a folder of 130,000 pictures', () => {
    const many = assetMap(Array.from({ length: 130_000 }, (_, i) => ({ path: `Projects/PORTALz/dataset/frame ${i}.png`, mtime: i })))
    const g = buildGraph(notesOf(files), {
      images: { all: many, moons: false, gallery: 'Projects/PORTALz' },
      folders: { all: new Set([...folders, 'Projects/PORTALz/dataset']), rootTitle: 'Vault', multiRoot: false, maxDepth: 3 },
    })
    expect(g.gallery).toMatchObject({ cards: GALLERY_MAX, total: 130_000 })
  })

  it('sees a new picture once the asset map changes', () => {
    const more = new Map(assets)
    more.set('Projects/PORTALz/new.png', { path: 'Projects/PORTALz/new.png', mtime: 99 })
    const g = buildGraph(notesOf(files), {
      images: { all: more, moons: false, gallery: 'Projects/PORTALz' },
      folders: { all: folders, rootTitle: 'Vault', multiRoot: false, maxDepth: 3 },
    })
    expect(g.gallery).toMatchObject({ cards: 6, total: 6 })
    expect(cards(g).find((c) => c[2] === 0)?.[0]).toBe('Projects/PORTALz/new.png')
  })
})

function countFolders(g: { nodes: { folder?: unknown }[] }): number {
  return g.nodes.filter((n) => n.folder).length
}

describe('videos', () => {
  it('are media the brain shows, never pictures it writes', () => {
    for (const p of ['a/turntable.mp4', 'b/Clip.MOV', 'c/x.webm', 'd/y.m4v']) {
      expect([isVideoPath(p), isMediaPath(p), isImagePath(p)]).toEqual([true, true, false])
    }
    expect([isVideoPath('a/gate.png'), isMediaPath('a/gate.png'), isMediaPath('a/notes.md'), isMediaPath('a/x.mkv'), isMediaPath('a/old.ogv')]).toEqual([false, true, false, false, false])
    expect([mimeOf('a.mp4'), mimeOf('a.MOV'), mimeOf('a.webm'), mimeOf('a.m4v')]).toEqual(['video/mp4', 'video/quicktime', 'video/webm', 'video/mp4'])
    expect(imageBaseName('Art/turntable.final.mp4')).toBe('turntable.final')
    expect([...assetMap([{ path: 'Art/t.mp4', mtime: 1 }, { path: 'Art/x.mkv' }]).keys()]).toEqual(['Art/t.mp4'])
  })

  const files = {
    'Projects/PORTALz.md': '---\ntype: project\n---\n# PORTALz\n\n![[turntable.mp4]] and ![[missing.webm]]\n',
    'Projects/PORTALz/Art/Moodboard.md': '# Moodboard\n',
  }
  const folders = new Set(['Projects', 'Projects/PORTALz', 'Projects/PORTALz/Art'])
  const assets = assetMap([
    { path: 'Projects/PORTALz/Art/turntable.mp4', mtime: 9, size: 5_000_000 },
    { path: 'Projects/PORTALz/Art/timelapse.webm', mtime: 8 },
    { path: 'Projects/PORTALz/Art/gate.png', mtime: 7 },
  ])

  it('embed like pictures, orbit as moons and come into the gallery, flagged as videos', () => {
    const g = buildGraph(notesOf(files), {
      images: { all: assets, moons: true, gallery: 'Projects/PORTALz' },
      folders: { all: folders, rootTitle: 'Vault', multiRoot: false, maxDepth: 3 },
    })
    const node = (p: string) => g.nodes[g.index.get(imageKey(p))!]!
    expect(node('Projects/PORTALz/Art/turntable.mp4')).toMatchObject({ kind: 'image', title: 'turntable.mp4', inDegree: 1, image: { video: true, size: 5_000_000 } })
    expect(node('Projects/PORTALz/Art/gate.png').image!.video).toBeUndefined()
    expect(g.nodes.some((n) => n.kind === 'ghost')).toBe(false)
    expect(g.gallery).toMatchObject({ cards: 3, videos: 2, total: 3 })
    expect(notesOf(files).get('Projects/PORTALz')!.links.find((l) => l.raw === 'missing.webm')).toBeDefined()
  })

  it('come and go with the files', () => {
    const search = new SearchIndex()
    const next = applyChanges(notesOf(files), [{ kind: 'add', path: 'Projects/PORTALz/Art/new.mov', mtime: 10, size: 3 }], search, { assets })
    expect(next.assets.get('Projects/PORTALz/Art/new.mov')).toEqual({ path: 'Projects/PORTALz/Art/new.mov', mtime: 10, size: 3 })
    const gone = applyChanges(next.notes, [{ kind: 'unlink', path: 'Projects/PORTALz/Art/new.mov' }], search, { assets: next.assets })
    expect(gone.assets.has('Projects/PORTALz/Art/new.mov')).toBe(false)
  })
})
