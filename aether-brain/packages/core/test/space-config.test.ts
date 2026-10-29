import { describe, expect, it } from 'vitest'
import {
  FB_GALAXY,
  FB_MOON,
  FB_NONE,
  FB_PLANET,
  FB_STAR,
  bodyOwners,
  bodyTiers,
  buildGraph,
  folderBodies,
  folderKey,
  homeKey,
  isHomeId,
  isVirtualId,
  legendBodiesIn,
  levelId,
  parseNote,
  sunCounts,
  type GraphData,
  type NoteId,
  type ParsedNote,
} from '../src'

/**
 * Space configuration (docs/COSMOLOGY.md, *Galaxy, star, planet, moon, satellite*): a folder is a star, a planet or a moon by how deep it
 * sits below its galaxy, and every file is a satellite.
 */

function notesOf(files: Record<string, string>): Map<NoteId, ParsedNote> {
  const m = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    m.set(n.meta.id, n)
  }
  return m
}

const FOLDERS = ['Projects', 'Projects/Alpha', 'Projects/Alpha/Art', 'Projects/Alpha/Art/Weapons', 'Projects/Alpha/Art/Weapons/Rifles', 'Work']
const FILES = {
  'Home.md': '# Home\n',
  'Projects/Alpha/Plan.md': '# Plan\n',
  'Projects/Alpha/Art/Weapons/Rifles/Skin.md': '# Skin\n',
}

function build(files: Record<string, string> = FILES, folders: string[] = FOLDERS): GraphData {
  return buildGraph(notesOf(files), { folders: { all: new Set(folders), rootTitle: 'Vault', multiRoot: false, maxDepth: 8 } })
}

const at = (g: GraphData, id: string): number => {
  const i = g.index.get(id)
  if (i === undefined) throw new Error(`no node ${id}`)
  return i
}

describe('which body a folder is', () => {
  const g = build()
  const bodies = folderBodies(g)
  const of = (path: string): number => bodies[at(g, folderKey(path))]!

  it('is a galaxy for the vault, a star directly in it, a planet in a star, a moon in a planet', () => {
    expect(of('')).toBe(FB_GALAXY)
    expect(of('Projects')).toBe(FB_STAR)
    expect(of('Work')).toBe(FB_STAR)
    expect(of('Projects/Alpha')).toBe(FB_PLANET)
    expect(of('Projects/Alpha/Art')).toBe(FB_MOON)
  })

  it('keeps going with moons of moons, however deep the folders go', () => {
    expect(of('Projects/Alpha/Art/Weapons')).toBe(FB_MOON)
    expect(of('Projects/Alpha/Art/Weapons/Rifles')).toBe(FB_MOON)
  })

  it('is nothing for a file', () => {
    expect(bodies[at(g, 'Home')]).toBe(FB_NONE)
    expect(bodies[at(g, 'Projects/Alpha/Plan')]).toBe(FB_NONE)
  })

  it('counts a drive as a galaxy, so a folder on it is a star and the one below a planet', () => {
    const drives = buildGraph(notesOf({ 'D/Work/Plan.md': '# Plan\n', 'D/Work/Sub/Deep.md': '# Deep\n' }), {
      folders: { all: new Set(['D', 'D/Work', 'D/Work/Sub']), rootTitle: 'Drives', multiRoot: true, maxDepth: 4 },
    })
    const b = folderBodies(drives)
    expect(b[at(drives, folderKey('D'))]).toBe(FB_GALAXY)
    expect(b[at(drives, folderKey('D/Work'))]).toBe(FB_STAR)
    expect(b[at(drives, folderKey('D/Work/Sub'))]).toBe(FB_PLANET)
  })

  it('does not hang on a parent cycle', () => {
    const c = build()
    c.nodes[at(c, folderKey('Work'))]!.parent = folderKey('Work')
    expect(folderBodies(c)).toHaveLength(c.nodes.length)
  })
})

describe('what a file is', () => {
  const g = build()
  const tiers = bodyTiers(g)

  it('is a satellite: shown with its folder’s files, never with the sub-folders', () => {
    expect(tiers[at(g, 'Home')]).toBe(2)
    expect(tiers[at(g, 'Projects/Alpha/Plan')]).toBe(2)
    expect(tiers[at(g, folderKey('Projects/Alpha/Art'))]).toBe(1)
  })

  it('is a satellite in the legend, and a folder is named by its body', () => {
    const bodies = folderBodies(g)
    expect(legendBodiesIn(g, at(g, 'Home'), bodies)).toEqual(['satellite'])
    expect(legendBodiesIn(g, at(g, folderKey('Projects')), bodies)).toEqual(['star'])
    expect(legendBodiesIn(g, at(g, folderKey('Projects/Alpha')), bodies)).toEqual(['planet'])
    expect(legendBodiesIn(g, at(g, folderKey('Projects/Alpha/Art')), bodies)).toEqual(['moon'])
    expect(legendBodiesIn(g, at(g, folderKey('')), bodies)).toEqual(['galaxy'])
  })
})

describe('the home moon: files orbit moons, never a star or a planet', () => {
  const g = build()
  const node = (id: string) => g.nodes[at(g, id)]!

  it('is made for a galaxy, a star or a planet that holds files, and the files orbit it', () => {
    expect(node(homeKey('')).folder).toMatchObject({ home: true, path: '' })
    expect(node('Home').orbit).toBe(homeKey(''))
    expect(node(homeKey('Projects/Alpha')).folder?.home).toBe(true)
    expect(node('Projects/Alpha/Plan').orbit).toBe(homeKey('Projects/Alpha'))
  })

  it('orbits its folder, is always a moon, and leaves the file’s parent alone (the folder, for roll-ups and breadcrumbs)', () => {
    expect(node(homeKey('Projects/Alpha')).parent).toBe(folderKey('Projects/Alpha'))
    expect(folderBodies(g)[at(g, homeKey('Projects/Alpha'))]).toBe(FB_MOON)
    expect(node('Projects/Alpha/Plan').parent).toBe(folderKey('Projects/Alpha'))
  })

  it('is not made for a folder that is a moon already, nor for one with no files', () => {
    expect(g.index.has(homeKey('Projects/Alpha/Art/Weapons/Rifles'))).toBe(false)
    expect(node('Projects/Alpha/Art/Weapons/Rifles/Skin').orbit).toBeUndefined()
    expect(g.index.has(homeKey('Work'))).toBe(false)
    expect(g.index.has(homeKey('Projects'))).toBe(false)
  })

  it('gives the sun a file belongs to as its home moon, and counts the files for the folder', () => {
    const owners = bodyOwners(g)
    expect(owners[at(g, 'Projects/Alpha/Plan')]).toBe(at(g, homeKey('Projects/Alpha')))
    expect(owners[at(g, homeKey('Projects/Alpha'))]).toBe(at(g, folderKey('Projects/Alpha')))
    expect(sunCounts(g).get(folderKey('Projects/Alpha'))).toMatchObject({ systems: 1, moons: 1 })
    expect(sunCounts(g).has(homeKey('Projects/Alpha'))).toBe(false)
  })

  it('opens and closes with its folder', () => {
    expect(levelId(homeKey('Projects/Alpha'))).toBe(folderKey('Projects/Alpha'))
    expect(levelId('Home')).toBe('Home')
    expect(isHomeId(homeKey('x'))).toBe(true)
    expect(isVirtualId(homeKey('x'))).toBe(true)
  })

  it('is not made in a graph without folders', () => {
    const flat = buildGraph(notesOf(FILES))
    expect(flat.nodes.some((n) => n.folder?.home)).toBe(false)
    expect(flat.nodes.every((n) => n.orbit === undefined)).toBe(true)
  })
})

describe('a project folder and the Bio are stars wherever they sit', () => {
  it('counts a project folder as a star even three folders deep, and its sub-folders as planets', () => {
    const g = buildGraph(
      notesOf({
        'Studio/Projects/Gate.md': '---\ntype: project\n---\n# Gate\n',
        'Studio/Projects/Gate/Art/Study.md': '# Study\n',
      }),
      { folders: { all: new Set(['Studio', 'Studio/Projects', 'Studio/Projects/Gate', 'Studio/Projects/Gate/Art']), rootTitle: 'Vault', multiRoot: false, maxDepth: 8 } },
    )
    const b = folderBodies(g)
    expect(b[at(g, folderKey('Studio/Projects'))]).toBe(FB_PLANET)
    expect(g.nodes[at(g, folderKey('Studio/Projects/Gate'))]!.folder?.role).toBe('project')
    expect(b[at(g, folderKey('Studio/Projects/Gate'))]).toBe(FB_STAR)
    expect(b[at(g, folderKey('Studio/Projects/Gate/Art'))]).toBe(FB_PLANET)
  })
})
