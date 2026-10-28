import { describe, expect, it } from 'vitest'
import {
  EMPTY_FOLDER_DATA,
  GALAXY_MAX_LEVELS,
  GALAXY_MAX_MARKS,
  assetMap,
  bindProjects,
  buildGraph,
  dataWeight,
  folderKey,
  homeKey,
  galaxyChildren,
  isGalaxyNode,
  legendBodies,
  parseNote,
  planGalaxies,
  scaleOf,
  shedGalaxies,
  bodyOwners,
  bodyTiers,
  type FolderData,
  type GraphData,
  type GraphNode,
  type NoteId,
  type ParsedNote,
} from '../src'

/**
 * Galaxies you mark: the plan (which marks count, how deep, what they sit on), how much a folder holds, and what the real folder graph
 * does with them (docs/COSMOLOGY.md, "A galaxy is a folder you mark").
 */

const data = (over: Partial<FolderData> = {}): FolderData => ({ ...EMPTY_FOLDER_DATA, ...over })

function notesOf(files: Record<string, string>): Map<NoteId, ParsedNote> {
  const out = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    out.set(n.meta.id, n)
  }
  return out
}

function node(g: GraphData, id: string): GraphNode {
  const i = g.index.get(id)
  const n = i === undefined ? undefined : g.nodes[i]
  if (!n) throw new Error(`no node ${id}`)
  return n
}

describe('the mark', () => {
  it('is `scale: galaxy` in any letter case, and nothing else makes a galaxy', () => {
    expect(scaleOf({ scale: 'galaxy' })).toBe('galaxy')
    expect(scaleOf({ scale: 'Galaxy' })).toBe('galaxy')
    expect(scaleOf({ scale: '  GALAXY ' })).toBe('galaxy')
    // (A one-item list reads as its item, like every other key of a note: `type: [project]` is a project too.)
    for (const other of [{}, { scale: 'star' }, { scale: 'galaxies' }, { scale: '' }, { scale: 3 }, { scale: ['star'] }, { type: 'galaxy' }]) {
      expect(scaleOf(other as never), JSON.stringify(other)).toBe('star')
    }
  })
})

describe('which marks count', () => {
  it('puts a galaxy on the vault, however deep its folder is: the folders between stay stars', () => {
    const plan = planGalaxies(['Games/Darktide', 'A/B/C/D/Lab'], false)
    expect(plan.galaxies.get('Games/Darktide')).toEqual({ level: 2, onto: '' })
    expect(plan.galaxies.get('A/B/C/D/Lab')).toEqual({ level: 2, onto: '' })
    expect(plan.ignored.size).toBe(0)
  })

  it('nests a galaxy on the galaxy above it, and counts the vault as level 1', () => {
    const plan = planGalaxies(['G', 'G/x/Inner', 'G/x/Inner/y/Core'], false)
    expect(plan.galaxies.get('G')).toEqual({ level: 2, onto: '' })
    expect(plan.galaxies.get('G/x/Inner')).toEqual({ level: 3, onto: 'G' })
    // A third mark would be level 4: it is told about, and its folder stays a star.
    expect(GALAXY_MAX_LEVELS).toBe(3)
    expect(plan.galaxies.has('G/x/Inner/y/Core')).toBe(false)
    expect(plan.ignored.get('G/x/Inner/y/Core')).toBe('depth')
  })

  it('counts a drive as level 1 in a vault of several, and never makes a drive or the vault a mark', () => {
    const plan = planGalaxies(['D', 'D/Lab', 'D/Lab/Deep/Core', 'F/Art', ''], true)
    expect(plan.ignored.get('D')).toBe('drive')
    expect(plan.ignored.get('')).toBe('drive')
    expect(plan.galaxies.get('D/Lab')).toEqual({ level: 2, onto: 'D' })
    expect(plan.galaxies.get('D/Lab/Deep/Core')).toEqual({ level: 3, onto: 'D/Lab' })
    expect(plan.galaxies.get('F/Art')).toEqual({ level: 2, onto: 'F' })
  })

  it('does not let an ignored mark stop the galaxies inside it from counting, only from nesting deeper', () => {
    // Four deep in a chain: the fourth is ignored; a sibling chain elsewhere is unaffected.
    const plan = planGalaxies(['A', 'A/B', 'A/B/C', 'Z'], false)
    expect([...plan.galaxies.keys()].sort()).toEqual(['A', 'A/B', 'Z'])
    expect(plan.ignored.get('A/B/C')).toBe('depth')
  })

  it('stops counting at the cap, shallowest first and then by path, whatever order the marks come in', () => {
    const many = Array.from({ length: GALAXY_MAX_MARKS + 6 }, (_, i) => `P${String(i).padStart(3, '0')}`)
    const a = planGalaxies(many, false)
    const b = planGalaxies([...many].reverse(), false)
    expect(a.galaxies.size).toBe(GALAXY_MAX_MARKS)
    expect([...a.galaxies.keys()]).toEqual(many.slice(0, GALAXY_MAX_MARKS))
    expect([...a.ignored.entries()]).toEqual(many.slice(GALAXY_MAX_MARKS).map((p) => [p, 'count']))
    expect([...b.galaxies.keys()]).toEqual([...a.galaxies.keys()])
    // Shallow marks win over deeper ones when there is no room for all.
    const deepFirst = planGalaxies([...Array.from({ length: GALAXY_MAX_MARKS }, (_, i) => `A/B/G${String(i).padStart(3, '0')}`), 'Top'], false)
    expect(deepFirst.galaxies.has('Top')).toBe(true)
    expect(deepFirst.ignored.size).toBe(1)
  })

  it('counts one mark once', () => {
    const plan = planGalaxies(['G', 'G'], false)
    expect(plan.galaxies.size).toBe(1)
  })
})

describe('how much a folder holds', () => {
  it('is notes, sub-folders, a note per thousand words, a quarter per picture and a half per video or model', () => {
    expect(dataWeight(data(), 0)).toBe(0)
    expect(dataWeight(data({ notes: 10 }), 3)).toBe(13)
    expect(dataWeight(data({ words: 2500 }), 0)).toBe(2.5)
    expect(dataWeight(data({ pictures: 8 }), 0)).toBe(2)
    expect(dataWeight(data({ videos: 2, models: 2 }), 0)).toBe(2)
    expect(dataWeight(data({ notes: 100, words: 50_000, pictures: 40, videos: 4, models: 6 }), 12)).toBe(100 + 12 + 50 + 10 + 5)
  })

  it('is always finite and never negative, whatever it is given', () => {
    const bad = data({ notes: Number.NaN, words: Number.POSITIVE_INFINITY, pictures: -4, videos: Number.NEGATIVE_INFINITY, models: Number.NaN })
    expect(dataWeight(bad, Number.NaN)).toBe(0)
    expect(dataWeight(data({ notes: 5 }), -3)).toBe(5)
  })
})

describe('what a galaxy takes with it', () => {
  const rolled = new Map<string, FolderData>([
    ['', data({ notes: 100, words: 1000, pictures: 10 })],
    ['Games', data({ notes: 70, words: 700, pictures: 8 })],
    ['Games/Darktide', data({ notes: 50, words: 500, pictures: 6 })],
    ['Games/Darktide/Mods', data({ notes: 30, words: 300, pictures: 4 })],
    ['Games/Darktide/Mods/Cake', data({ notes: 12, words: 120, pictures: 2 })],
    ['Other', data({ notes: 30, words: 300, pictures: 2 })],
  ])

  it('leaves the stars between a galaxy and the galaxy it sits on holding only what is still theirs', () => {
    const plan = planGalaxies(['Games/Darktide'], false)
    const out = shedGalaxies(rolled, plan)
    // Games and the vault lose the whole of Darktide; Darktide itself keeps everything under it (nothing nested).
    expect(out.get('Games')).toEqual(data({ notes: 20, words: 200, pictures: 2 }))
    expect(out.get('')).toEqual(data({ notes: 50, words: 500, pictures: 4 }))
    expect(out.get('Games/Darktide')).toEqual(rolled.get('Games/Darktide'))
    expect(out.get('Other')).toEqual(rolled.get('Other'))
  })

  it('takes a nested galaxy out of the galaxy it sits on, and out of the folders between, but only once from above', () => {
    const plan = planGalaxies(['Games/Darktide', 'Games/Darktide/Mods/Cake'], false)
    const out = shedGalaxies(rolled, plan)
    // Cake leaves Mods and Darktide (the galaxy it sits on) ...
    expect(out.get('Games/Darktide/Mods')).toEqual(data({ notes: 18, words: 180, pictures: 2 }))
    expect(out.get('Games/Darktide')).toEqual(data({ notes: 38, words: 380, pictures: 4 }))
    // ... and Darktide, with Cake inside it, leaves Games and the vault once: Cake is not taken off them a second time.
    expect(out.get('Games')).toEqual(data({ notes: 20, words: 200, pictures: 2 }))
    expect(out.get('')).toEqual(data({ notes: 50, words: 500, pictures: 4 }))
    expect(out.get('Games/Darktide/Mods/Cake')).toEqual(rolled.get('Games/Darktide/Mods/Cake'))
  })

  it('changes nothing it was given, and never goes below nothing', () => {
    const before = JSON.stringify([...rolled])
    shedGalaxies(rolled, planGalaxies(['Games/Darktide'], false))
    expect(JSON.stringify([...rolled])).toBe(before)
    const odd = new Map<string, FolderData>([
      ['', data({ notes: 1 })],
      ['G', data({ notes: 5 })],
    ])
    expect(shedGalaxies(odd, planGalaxies(['G'], false)).get('')?.notes).toBe(0)
  })

  it('counts the galaxies that sit directly under a folder on disk', () => {
    const plan = planGalaxies(['Games/Darktide', 'Games/Other', 'Top'], false)
    expect(galaxyChildren(plan)).toEqual(new Map([['Games', 2], ['', 1]]))
  })
})

/* ------------------------------------------------------------------ */
/* In the folder graph                                                */
/* ------------------------------------------------------------------ */

const FILES: Record<string, string> = {
  'Home.md': '# Home\n',
  'Games/Notes.md': '# Notes\nsome words here\n',
  'Games/Darktide/Darktide.md': '---\ntype: project\nscale: galaxy\n---\n# Darktide\n',
  'Games/Darktide/Mods/Plan.md': `# Plan\n${'word '.repeat(2000)}\n`,
  'Games/Darktide/Mods/Deep/Deeper/Cake/Cake.md': '---\ntype: project\nscale: Galaxy\n---\n# Cake\n',
  'Games/Darktide/Mods/Deep/Deeper/Cake/Recipe.md': '# Recipe\n',
  'Games/Darktide/Mods/Deep/Deeper/Cake/Sub/Deeper/Zed/Zed.md': '---\ntype: project\nscale: galaxy\n---\n# Zed\n',
  'Games/Other/Other.md': '---\ntype: project\n---\n# Other\n',
  'Games/Other/Thing.md': '# Thing\n',
  'Games/Star/Star.md': '---\ntype: project\nscale: star\n---\n# Star\n',
}

const FOLDERS = [
  'Games',
  'Games/Darktide',
  'Games/Darktide/Mods',
  'Games/Darktide/Mods/Deep',
  'Games/Darktide/Mods/Deep/Deeper',
  'Games/Darktide/Mods/Deep/Deeper/Cake',
  'Games/Darktide/Mods/Deep/Deeper/Cake/Sub',
  'Games/Darktide/Mods/Deep/Deeper/Cake/Sub/Deeper',
  'Games/Darktide/Mods/Deep/Deeper/Cake/Sub/Deeper/Zed',
  'Games/Other',
  'Games/Star',
]

function build(files: Record<string, string> = FILES, extra: object = {}): GraphData {
  return buildGraph(notesOf(files), {
    folders: { multiRoot: false, all: FOLDERS, rootTitle: 'Vault', maxDepth: 3, maxFolders: 0 },
    ...extra,
  })
}

describe('in the folder graph', () => {
  const g = build()
  const ids = {
    games: folderKey('Games'),
    dark: folderKey('Games/Darktide'),
    mods: folderKey('Games/Darktide/Mods'),
    cake: folderKey('Games/Darktide/Mods/Deep/Deeper/Cake'),
    zed: folderKey('Games/Darktide/Mods/Deep/Deeper/Cake/Sub/Deeper/Zed'),
    other: folderKey('Games/Other'),
    star: folderKey('Games/Star'),
  }

  it('makes a marked project folder a galaxy that is still a project', () => {
    const dark = node(g, ids.dark)
    expect(dark.folder).toMatchObject({ role: 'project', projectId: 'Games/Darktide/Darktide', galaxyLevel: 2 })
    expect(dark.type).toBe('project')
    expect(isGalaxyNode(dark)).toBe(true)
    expect(legendBodies(dark)).toEqual(['galaxy'])
    expect(dark.folder?.markIgnored).toBeUndefined()
  })

  it('sits a galaxy on the galaxy above it, not on the folder it is in', () => {
    expect(node(g, ids.dark).parent).toBe(folderKey(''))
    expect(node(g, ids.games).parent).toBe(folderKey(''))
    // Nested: Cake sits on Darktide, past Mods, Deep and Deeper, which stay stars.
    expect(node(g, ids.cake).parent).toBe(ids.dark)
    expect(node(g, ids.cake).folder?.galaxyLevel).toBe(3)
    expect(node(g, ids.mods).parent).toBe(ids.dark)
  })

  it('keeps the sub-folders of a galaxy on its disc, and the sub-folders of a star on the star', () => {
    expect(node(g, ids.mods).parent).toBe(ids.dark)
    expect(node(g, folderKey('Games/Darktide/Mods/Deep')).parent).toBe(ids.mods)
    expect(isGalaxyNode(node(g, ids.mods))).toBe(false)
  })

  it('leaves a mark that is too deep a star, with the reason, in the place its folder is', () => {
    const zed = node(g, ids.zed)
    expect(zed.folder).toMatchObject({ role: 'project', markIgnored: 'depth' })
    expect(zed.folder?.galaxyLevel).toBeUndefined()
    expect(isGalaxyNode(zed)).toBe(false)
    expect(zed.parent).toBe(folderKey('Games/Darktide/Mods/Deep/Deeper/Cake/Sub/Deeper'))
  })

  it('leaves a project that is not marked a star, whatever else its note says', () => {
    for (const id of [ids.other, ids.star]) {
      const n = node(g, id)
      expect(n.folder?.role).toBe('project')
      expect(n.folder?.galaxyLevel).toBeUndefined()
      expect(n.folder?.markIgnored).toBeUndefined()
      expect(n.parent).toBe(ids.games)
    }
  })

  it('does not change a vault with no mark: nothing is lifted and nothing is a galaxy but the vault', () => {
    const plain = build(Object.fromEntries(Object.entries(FILES).map(([p, c]) => [p, c.replace(/scale: \w+\n/g, '')])))
    for (const n of plain.nodes) {
      if (!n.folder || n.folder.home) continue
      expect(n.folder.galaxyLevel).toBeUndefined()
      expect(n.folder.markIgnored).toBeUndefined()
      if (n.id !== folderKey('')) expect(n.parent).toBe(folderKey(n.folder.path.includes('/') ? n.folder.path.slice(0, n.folder.path.lastIndexOf('/')) : ''))
    }
  })

  it('is the same graph whatever order the notes come in', () => {
    const shuffled = Object.fromEntries(Object.entries(FILES).reverse())
    const again = build(shuffled)
    const view = (x: GraphData) => x.nodes.filter((n) => n.folder).map((n) => [n.id, n.parent, n.folder?.galaxyLevel, n.folder?.markIgnored])
    expect(view(again)).toEqual(view(g))
  })

  it('lets a galaxy hold its own sub-folders as always shown, and owns nothing above it', () => {
    const owners = bodyOwners(g)
    const tiers = bodyTiers(g)
    const at = (id: string) => g.index.get(id)!
    // A galaxy, like a drive, belongs to no sun; the folders directly on its disc are always shown.
    expect(owners[at(ids.dark)]).toBe(-1)
    expect(tiers[at(ids.dark)]).toBe(0)
    expect(tiers[at(ids.mods)]).toBe(0)
    expect(tiers[at(ids.cake)]).toBe(0)
    // A folder deeper in a star waits for its star to open.
    expect(tiers[at(folderKey('Games/Darktide/Mods/Deep'))]).toBe(1)
    // A note of a galaxy's folder belongs to the galaxy.
    expect(owners[at('Games/Darktide/Mods/Plan')]).toBe(at(homeKey('Games/Darktide/Mods')))
    expect(owners[at(homeKey('Games/Darktide/Mods'))]).toBe(at(ids.mods))
  })

  it('counts what a folder holds without the galaxies that left it', () => {
    const games = node(g, ids.games).folder!
    const dark = node(g, ids.dark).folder!
    const cake = node(g, ids.cake).folder!
    // Games holds its own note and Other and Star; Darktide (a galaxy on the vault) took the rest with it.
    expect(games.data).toMatchObject({ notes: 1 + 2 + 1 })
    expect(games.totalNotes).toBe(9)
    // Darktide keeps its own note and Plan; Cake, a galaxy on it, took its three notes (Cake, Recipe and Zed's) with it.
    expect(dark.data?.notes).toBe(2)
    expect(dark.data?.words).toBeGreaterThan(2000)
    expect(cake.data?.notes).toBe(3)
    expect(games.weight).toBeLessThan((games.totalNotes + games.childFolders) as number)
  })

  it('does not count a galaxy among the sub-folders of the star it left', () => {
    const games = node(g, ids.games).folder!
    // Darktide, Other and Star are its folders on disk; Darktide is a galaxy on the vault now, so two count.
    expect(games.childFolders).toBe(3)
    expect(games.weight).toBe(dataWeight(games.data!, 3 - 1))
  })

  it('adds the pictures, videos and models listed under a folder, once per asset list', () => {
    const assets = assetMap([
      { path: 'Games/Other/a.png', size: 100_000 },
      { path: 'Games/Other/b.png', size: 100_000 },
      { path: 'Games/Other/clip.mp4', size: 100_000 },
      { path: 'Games/Other/robot.glb', size: 100_000 },
      { path: 'Games/Darktide/Mods/hero.glb', size: 100_000 },
      { path: 'Games/Darktide/Mods/Deep/Deeper/Cake/slice.png', size: 100_000 },
    ])
    const withAssets = build(FILES, { images: { all: assets, moons: false } })
    expect(node(withAssets, ids.other).folder?.data).toMatchObject({ pictures: 2, videos: 1, models: 1 })
    expect(node(withAssets, ids.games).folder?.data).toMatchObject({ pictures: 2, videos: 1, models: 1 })
    // Darktide keeps its model but not Cake's picture; Cake holds its own.
    expect(node(withAssets, ids.dark).folder?.data).toMatchObject({ pictures: 0, models: 1 })
    expect(node(withAssets, ids.cake).folder?.data).toMatchObject({ pictures: 1 })
    expect(node(withAssets, ids.other).folder?.weight).toBeGreaterThan(node(g, ids.other).folder!.weight!)
    // The list is rolled up once for the same asset map.
    const again = build(FILES, { images: { all: assets, moons: false } })
    expect(node(again, ids.other).folder?.data).toEqual(node(withAssets, ids.other).folder?.data)
  })

  it('knows nothing of pictures when none are listed, and says so with zeros', () => {
    expect(node(g, ids.other).folder?.data).toMatchObject({ pictures: 0, videos: 0, models: 0 })
  })
})

describe('in a vault of several drives', () => {
  const files: Record<string, string> = {
    'D/D.md': '---\ntype: project\nscale: galaxy\n---\n# D\n',
    'D/Lab/Lab.md': '---\ntype: project\nscale: galaxy\n---\n# Lab\n',
    'D/Lab/Plan.md': '# Plan\n',
    'D/Lab/x/y/Core/Core.md': '---\ntype: project\nscale: galaxy\n---\n# Core\n',
    'F/Art/Art.md': '---\ntype: project\nscale: galaxy\n---\n# Art\n',
  }
  const g = buildGraph(notesOf(files), {
    folders: { multiRoot: true, all: ['D', 'D/Lab', 'D/Lab/x', 'D/Lab/x/y', 'D/Lab/x/y/Core', 'F', 'F/Art'], rootTitle: 'Drives', maxDepth: 3, maxFolders: 0 },
  })

  it('sits a galaxy on its drive, and a drive that is marked stays the drive it was', () => {
    expect(node(g, folderKey('D')).folder).toMatchObject({ role: 'mount', markIgnored: 'drive' })
    expect(node(g, folderKey('D')).folder?.galaxyLevel).toBeUndefined()
    expect(node(g, folderKey('D/Lab')).parent).toBe(folderKey('D'))
    expect(node(g, folderKey('D/Lab')).folder?.galaxyLevel).toBe(2)
    expect(node(g, folderKey('D/Lab/x/y/Core')).parent).toBe(folderKey('D/Lab'))
    expect(node(g, folderKey('D/Lab/x/y/Core')).folder?.galaxyLevel).toBe(3)
    expect(node(g, folderKey('F/Art')).parent).toBe(folderKey('F'))
  })

  it('never lets a galaxy sit on the origin of the drives, only on a drive or another galaxy', () => {
    for (const n of g.nodes) {
      if (!n.folder || n.folder.galaxyLevel === undefined) continue
      const parent = node(g, n.parent!)
      expect(isGalaxyNode(parent) && parent.folder?.role !== 'root').toBe(true)
    }
  })
})

describe('the Bio star', () => {
  it('stays a star even when its project note says galaxy', () => {
    const g = buildGraph(notesOf({ 'Bio/Bio.md': '---\ntype: project\nscale: galaxy\n---\n# Bio\n', 'Bio/Sleep.md': '# Sleep\n' }), {
      folders: { multiRoot: false, all: ['Bio'], rootTitle: 'Vault', maxDepth: 3, maxFolders: 0, bio: 'Bio' },
    })
    const bio = node(g, folderKey('Bio'))
    expect(bio.folder?.bio).toBe(true)
    expect(bio.folder?.galaxyLevel).toBeUndefined()
    expect(isGalaxyNode(bio)).toBe(false)
  })
})

describe('a star gallery and the galaxies inside it', () => {
  const files: Record<string, string> = {
    ...FILES,
    'Games/Games.md': '---\ntype: project\n---\n# Games\n',
  }
  const assets = assetMap([
    { path: 'Games/cover.png', size: 100_000 },
    { path: 'Games/Other/b.png', size: 100_000 },
    { path: 'Games/Darktide/Mods/hero.png', size: 100_000 },
    { path: 'Games/Darktide/Mods/Deep/Deeper/Cake/slice.png', size: 100_000 },
  ])
  const gallery = (folder: string) => build(files, { images: { all: assets, moons: false, gallery: folder } })

  it('leaves the pictures of a galaxy to the galaxy: its cards could not float round a star that is no longer their parent', () => {
    const g = gallery('Games')
    expect(g.gallery).toMatchObject({ path: 'Games', cards: 2, total: 2 })
    const cards = g.nodes.filter((n) => n.image?.gallery).map((n) => n.image!.path).sort()
    expect(cards).toEqual(['Games/Other/b.png', 'Games/cover.png'])
  })

  it('gives a galaxy its own pictures, and leaves out the galaxy inside it', () => {
    const g = gallery('Games/Darktide')
    expect(g.gallery).toMatchObject({ path: 'Games/Darktide', cards: 1, total: 1 })
    expect(g.nodes.filter((n) => n.image?.gallery).map((n) => n.image!.path)).toEqual(['Games/Darktide/Mods/hero.png'])
    // The galaxy inside it has the last one.
    expect(gallery('Games/Darktide/Mods/Deep/Deeper/Cake').gallery).toMatchObject({ cards: 1, total: 1 })
  })

  it('is as it was for a star with no galaxy in it', () => {
    const g = gallery('Games/Other')
    expect(g.gallery).toMatchObject({ path: 'Games/Other', cards: 1, total: 1 })
  })
})

describe('which project note owns a folder', () => {
  const project = (path: string, extra = '') => parseNote({ path, content: `---\ntype: project\n${extra}---\n# ${path}\n` })
  const mapOf = (...ns: ParsedNote[]) => new Map(ns.map((n) => [n.meta.id, n]))
  const known = new Set(['', 'Games', 'Games/Darktide', 'Shared', 'Projects'])

  it('prefers an explicit folder:, then the folder note, then a sibling note, whatever order the notes are in', () => {
    const sibling = project('Games/Darktide.md')
    const folderNote = project('Games/Darktide/Darktide.md')
    const explicit = project('Elsewhere/Notes.md', 'folder: Games/Darktide\n')
    for (const order of [[sibling, folderNote], [folderNote, sibling]]) {
      const m = mapOf(...order)
      expect(bindProjects(m, [...m.keys()].sort(), known).projectAt.get('Games/Darktide')).toBe('Games/Darktide/Darktide')
    }
    const m = mapOf(sibling, folderNote, explicit)
    const { projectAt, homeOf } = bindProjects(m, [...m.keys()].sort(), known)
    expect(projectAt.get('Games/Darktide')).toBe('Elsewhere/Notes')
    // A note that lost has no home; one that won does.
    expect(homeOf.get('Games/Darktide/Darktide')).toBeUndefined()
    expect(homeOf.get('Elsewhere/Notes')).toBe('Games/Darktide')
  })

  it('breaks a tie by plain code-unit order of the ids, the way the graph does, not by locale', () => {
    const upper = project('Projects/Zed.md', 'folder: Shared\n')
    const lower = project('Projects/alpha.md', 'folder: Shared\n')
    const m = mapOf(lower, upper)
    // 'Z' sorts before 'a' in code units; a locale compare would put alpha first.
    expect(bindProjects(m, [...m.keys()].sort(), known).projectAt.get('Shared')).toBe('Projects/Zed')
  })

  it('binds only folders that are there, and only project notes', () => {
    const ghostFolder = project('Projects/Lost.md', 'folder: Nowhere/Yet\n')
    const plain = parseNote({ path: 'Games/Note.md', content: '# Note\n' })
    const m = mapOf(ghostFolder, plain)
    expect(bindProjects(m, [...m.keys()].sort(), known).projectAt.size).toBe(0)
  })

  it('reads the mark from the note that wins, and ignores it on the one that lost', () => {
    const files = (winnerMark: boolean): Record<string, string> => ({
      'Games/Darktide.md': `---\ntype: project\n${winnerMark ? '' : 'scale: galaxy\n'}---\n# Sibling\n`,
      'Games/Darktide/Darktide.md': `---\ntype: project\n${winnerMark ? 'scale: galaxy\n' : ''}---\n# Folder note\n`,
    })
    const level = (f: Record<string, string>) => {
      const g = buildGraph(notesOf(f), { folders: { multiRoot: false, all: ['Games', 'Games/Darktide'], rootTitle: 'Vault', maxDepth: 3, maxFolders: 0 } })
      return node(g, folderKey('Games/Darktide')).folder?.galaxyLevel
    }
    expect(level(files(true))).toBe(2)
    expect(level(files(false))).toBeUndefined()
  })
})
