import { describe, expect, it } from 'vitest'
import { buildGraph, folderKey, parseNote, type GraphData, type NoteId, type ParsedNote } from '@aether/core'
import {
  FULL_WEIGHT,
  GALAXY_MAX_RADIUS,
  GALAXY_MIN_RADIUS,
  STAR_MAX_RADIUS,
  STAR_MIN_RADIUS,
  SUN_COLOR,
  fullness,
  nodeBaseColor,
  nodeRadius,
} from '../src/theme'

/**
 * A star grows with what it holds, and a folder you marked as a galaxy is a bigger body than any star (docs/COSMOLOGY.md, "A star grows
 * with what it holds"). The sizes are the one number the layout spaces orbits by, so they are pinned as numbers and as an order.
 */

const folder = (over: Record<string, unknown>) => ({ kind: 'folder', folder: { totalNotes: 0, childFolders: 0, images: 0, role: 'folder', ...over } }) as never
const star = (weight: number) => nodeRadius(folder({ weight }))
const project = (weight: number) => nodeRadius(folder({ role: 'project', weight }))
const galaxy = (weight: number) => nodeRadius(folder({ role: 'project', galaxyLevel: 2, weight }))

describe('how full a folder is', () => {
  it('is 0 for nothing, 1 at the weight where growth stops, and grows in between', () => {
    expect(fullness(0)).toBe(0)
    expect(fullness(FULL_WEIGHT)).toBe(1)
    expect(fullness(FULL_WEIGHT * 100)).toBe(1)
    let last = 0
    for (const w of [1, 3, 10, 30, 100, 300, 1000, 10_000, 40_000]) {
      const f = fullness(w)
      expect(f, String(w)).toBeGreaterThan(last)
      expect(f).toBeLessThan(1)
      last = f
    }
  })

  it('is finite and 0 or more for any number it is given', () => {
    for (const w of [Number.NaN, -5, Number.NEGATIVE_INFINITY]) expect(fullness(w)).toBe(0)
    expect(fullness(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('a star’s size', () => {
  it('is 3.4 with nothing in it, and never more than 8', () => {
    expect(star(0)).toBeCloseTo(STAR_MIN_RADIUS, 6)
    expect(star(FULL_WEIGHT)).toBeCloseTo(STAR_MAX_RADIUS, 6)
    expect(star(FULL_WEIGHT * 1000)).toBeCloseTo(STAR_MAX_RADIUS, 6)
    expect(STAR_MIN_RADIUS).toBe(3.4)
    expect(STAR_MAX_RADIUS).toBe(8)
  })

  it('tells a folder of a hundred notes from one of a thousand and one of ten thousand', () => {
    // Before, every folder holding about 200 or more looked the same (8); now each decade is a visible step.
    const sizes = [10, 100, 1000, 10_000].map(star)
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]! - sizes[i - 1]!, `${i}`).toBeGreaterThan(0.5)
    expect(star(200)).toBeLessThan(star(5000) - 0.8)
  })

  it('is the table in docs/COSMOLOGY.md: what a folder holding 10, 100, 1,000 and 10,000 looks like', () => {
    // The rows of "A star grows with what it holds": plain star, project star, galaxy you marked (one decimal).
    const rows: [number, number, number, number][] = [
      [0, 3.4, 4.6, 12.0],
      [10, 4.9, 6.1, 13.0],
      [100, 5.8, 7.0, 13.6],
      [1000, 6.7, 7.9, 14.1],
      [10_000, 7.5, 8.7, 14.7],
      [50_000, 8.0, 9.2, 15.0],
    ]
    for (const [w, plain, proj, gal] of rows) {
      expect(star(w), `plain ${w}`).toBeCloseTo(plain, 1)
      expect(project(w), `project ${w}`).toBeCloseTo(proj, 1)
      expect(galaxy(w), `galaxy ${w}`).toBeCloseTo(gal, 1)
    }
  })

  it('does not move for a few words: only a change of about a tenth in what it holds does', () => {
    // A thousand words are one note's worth: typing 30 words into a note changes a folder's weight by 0.03 and must not change its size.
    expect(star(100.03)).toBe(star(100))
    expect(star(5000.03)).toBe(star(5000))
    expect(galaxy(300.03)).toBe(galaxy(300))
    // A tenth more (ten notes among a hundred) is a different size.
    expect(star(110)).toBeGreaterThan(star(100))
    // Still finite and monotonic across the steps.
    let last = -1
    for (let w = 0; w <= 60_000; w += 137) {
      const r = star(w)
      expect(r).toBeGreaterThanOrEqual(last)
      last = r
    }
  })

  it('is the Bio black hole’s own size, measured from what is on disk, not from the galaxy-aware weight', () => {
    // The Bio keeps its band (22 to 28) and its own formula; a number the weight carries does not move it.
    const bio = (extra: Record<string, unknown>) => nodeRadius(folder({ bio: true, totalNotes: 6, childFolders: 1, images: 4, ...extra }))
    expect(bio({ weight: 1 })).toBe(bio({ weight: 1e9 }))
    expect(bio({})).toBeCloseTo(22 + 0.9 * Math.log2(1 + 6 + 1 + 0.25 * 4), 6)
  })

  it('grows with the notes, the folders and the pictures it holds (the number the graph measured)', () => {
    expect(star(500)).toBeGreaterThan(star(50))
    expect(star(3)).toBeGreaterThan(star(0))
  })

  it('falls back to the counts for a folder made by hand, as it always did', () => {
    const byCounts = nodeRadius(folder({ totalNotes: 80, childFolders: 10, images: 40 }))
    expect(byCounts).toBeCloseTo(star(80 + 10 + 0.25 * 40), 6)
  })

  it('is a little more for a project star, at most 9.2', () => {
    for (const w of [0, 10, 1000]) expect(project(w)).toBeCloseTo(star(w) + 1.2, 6)
    expect(project(1e9)).toBeCloseTo(9.2, 6)
  })
})

describe('a galaxy you marked', () => {
  it('is 12 with nothing in it, 15 when full, and grows in between', () => {
    expect(galaxy(0)).toBeCloseTo(GALAXY_MIN_RADIUS, 6)
    expect(galaxy(FULL_WEIGHT)).toBeCloseTo(GALAXY_MAX_RADIUS, 6)
    expect(galaxy(10)).toBeGreaterThan(galaxy(0))
    expect(galaxy(1000)).toBeGreaterThan(galaxy(10))
    expect(GALAXY_MIN_RADIUS).toBe(12)
    expect(GALAXY_MAX_RADIUS).toBe(15)
  })

  it('stays in the order of the sky: the Bio black hole, then a drive, then any galaxy, then any project star, then any star', () => {
    const bioMax = nodeRadius(folder({ bio: true, totalNotes: 10_000_000 }))
    expect(nodeRadius(folder({ role: 'mount' }))).toBe(16)
    expect(galaxy(1e9)).toBeLessThan(16)
    expect(bioMax).toBe(28)
    expect(nodeRadius(folder({ bio: true }))).toBe(22)
    expect(nodeRadius(folder({ bio: true }))).toBeGreaterThan(16)
    expect(galaxy(0)).toBeGreaterThan(project(1e9))
    expect(project(1e9)).toBeGreaterThan(star(1e9))
    // A board sun (at most 9) is smaller than a galaxy too.
    expect(nodeRadius({ kind: 'note', board: { pictures: 1e9 } } as never)).toBeLessThanOrEqual(9)
  })

  it('is cream, like a drive, and not the gold of a project star', () => {
    const g = galaxyGraph()
    const color = (id: string) => `#${nodeBaseColor(g.nodes[g.index.get(id)!]!, 'area', null, () => 0).getHexString()}`
    expect(color(folderKey('Lab'))).toBe(SUN_COLOR)
    expect(color(folderKey('Lab/Core'))).not.toBe(SUN_COLOR)
  })

  it('is what the real graph measures: a folder of many notes is bigger than one of few, a galaxy bigger than both', () => {
    const g = galaxyGraph()
    const r = (id: string) => nodeRadius(g.nodes[g.index.get(folderKey(id))!]!)
    expect(r('Lab')).toBeGreaterThan(12)
    expect(r('Lab')).toBeLessThanOrEqual(15)
    expect(r('Lab/Big')).toBeGreaterThan(r('Lab/Small'))
    expect(r('Lab')).toBeGreaterThan(r('Lab/Big'))
  })
})

function galaxyGraph(): GraphData {
  const notes = new Map<NoteId, ParsedNote>()
  const files: Record<string, string> = {
    'Lab/Lab.md': '---\ntype: project\nscale: galaxy\n---\n# Lab\n',
    'Lab/Core/Core.md': '---\ntype: project\n---\n# Core\n',
    'Lab/Small/One.md': '# One\n',
  }
  for (let i = 0; i < 300; i++) files[`Lab/Big/n${i}.md`] = `# n${i}\n`
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    notes.set(n.meta.id, n)
  }
  return buildGraph(notes, { folders: { all: new Set(['Lab', 'Lab/Core', 'Lab/Big', 'Lab/Small']), rootTitle: 'Vault', multiRoot: false, maxDepth: 3, maxFolders: 0 } })
}
