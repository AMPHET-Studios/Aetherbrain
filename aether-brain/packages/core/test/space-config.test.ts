import { describe, expect, it } from 'vitest'
import {
  FB_GALAXY,
  FB_MOON,
  FB_NONE,
  FB_PLANET,
  FB_STAR,
  bodyTiers,
  buildGraph,
  folderBodies,
  folderKey,
  legendBodiesIn,
  parseNote,
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
