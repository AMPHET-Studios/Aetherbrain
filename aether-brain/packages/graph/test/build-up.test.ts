import { describe, expect, it } from 'vitest'
import type { GraphData, GraphNode } from '@aether/core'
import { FB_MOON, FB_PLANET, FB_STAR } from '@aether/core'
import { BUILD_FILE, BUILD_GALAXY, BUILD_MOON, BUILD_PLANET, BUILD_STAGE_SECONDS, BUILD_STAR, bodyStages, buildDelays, holdBodies, stageOf } from '../src/scene/buildUp'
import { revealTargets } from '../src/scene/reveal'

/** The sky builds itself in order: galaxies, stars, planets, moons, files (docs/COSMOLOGY.md, *The sky builds itself*). */

function node(id: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, title: id, kind: 'note', parent: null, wordCount: 10, ...extra } as unknown as GraphNode
}
const galaxy = (id: string) => node(id, { kind: 'folder', folder: { role: 'mount' } } as Partial<GraphNode>)
const star = (id: string) => node(id, { kind: 'folder', folder: { role: 'folder' } } as Partial<GraphNode>)
const planet = (id: string) => node(id, { kind: 'folder', folder: { role: 'folder' } } as Partial<GraphNode>)
const moon = (id: string) => node(id, { kind: 'folder', folder: { role: 'folder' } } as Partial<GraphNode>)
const file = (id: string) => node(id, { kind: 'image', image: { size: 1000, file: 'audio' } } as Partial<GraphNode>)

function graphOf(nodes: GraphNode[]): GraphData {
  return { nodes, links: [], index: new Map(nodes.map((n, i) => [n.id, i])) } as unknown as GraphData
}

describe('which stage a body is', () => {
  it('puts galaxies first, then stars, planets, moons and files', () => {
    expect(stageOf(galaxy('g'))).toBe(BUILD_GALAXY)
    expect(stageOf(star('s'), FB_STAR)).toBe(BUILD_STAR)
    expect(stageOf(planet('p'), FB_PLANET)).toBe(BUILD_PLANET)
    expect(stageOf(moon('m'), FB_MOON)).toBe(BUILD_MOON)
    expect(stageOf(file('f'))).toBe(BUILD_FILE)
    expect([BUILD_GALAXY, BUILD_STAR, BUILD_PLANET, BUILD_MOON, BUILD_FILE]).toEqual([0, 1, 2, 3, 4])
  })

  it('treats the Today hub and a board as stars, and every file, a long note and an unresolved link as satellites', () => {
    expect(stageOf(node('t', { kind: 'today' } as Partial<GraphNode>))).toBe(BUILD_STAR)
    expect(stageOf(node('b', { board: { pictures: 3 } } as unknown as Partial<GraphNode>))).toBe(BUILD_STAR)
    expect(stageOf(node('x', { ghost: true } as Partial<GraphNode>))).toBe(BUILD_FILE)
    expect(stageOf(node('long', { wordCount: 5000 }))).toBe(BUILD_FILE)
    expect(stageOf(node('small'))).toBe(BUILD_FILE)
  })

  it('reads a whole graph', () => {
    // A chain of folders: the depth below the galaxy makes a star, a planet and a moon.
    const g = graphOf([galaxy('g'), { ...star('s'), parent: 'g' }, { ...planet('p'), parent: 's' }, { ...moon('m'), parent: 'p' }, file('f')] as GraphNode[])
    expect(Array.from(bodyStages(g))).toEqual([0, 1, 2, 3, 4])
  })
})

describe('when each body is due', () => {
  const stage = Uint8Array.from([0, 1, 2, 3, 4])
  const out = new Float32Array(5)

  it('times a whole new sky from the galaxies: each stage is later than the last', () => {
    const latest = buildDelays(stage, () => true, 5, out)
    for (let i = 0; i < 5; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(i * BUILD_STAGE_SECONDS)
      expect(out[i]).toBeLessThan((i + 1) * BUILD_STAGE_SECONDS)
    }
    expect(latest).toBeCloseTo(Math.max(...out), 4)
    for (let i = 1; i < 5; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!)
  })

  it('never holds what was already in the sky', () => {
    const latest = buildDelays(stage, (i) => i === 3, 5, out)
    expect(Array.from(out).filter((d) => d > 0).length).toBe(1)
    expect(out[0]).toBe(0)
    expect(out[4]).toBe(0)
    expect(latest).toBeLessThan(BUILD_STAGE_SECONDS)
  })

  it('times a new folder with its notes from the folder, not from the galaxies it never added', () => {
    buildDelays(stage, (i) => i === 1 || i === 3, 5, out)
    expect(out[1]).toBeLessThan(BUILD_STAGE_SECONDS)
    expect(out[3]!).toBeGreaterThanOrEqual(2 * BUILD_STAGE_SECONDS)
    expect(out[3]!).toBeGreaterThan(out[1]!)
  })

  it('has nothing to wait for when nothing is new', () => {
    expect(buildDelays(stage, () => false, 5, out)).toBe(0)
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0])
  })

  it('is the same every time it is asked', () => {
    const a = new Float32Array(5)
    const b = new Float32Array(5)
    buildDelays(stage, () => true, 5, a)
    buildDelays(stage, () => true, 5, b)
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})

describe('holding the bodies that are not due', () => {
  it('holds the later stages first and lets go as the clock runs', () => {
    const delay = Float32Array.from([0, 0.9, 1.7, 2.5, 3.3])
    const hold = new Uint8Array(5)
    expect(holdBodies(delay, 0, 5, hold)).toBe(4)
    expect(Array.from(hold)).toEqual([0, 1, 1, 1, 1])
    expect(holdBodies(delay, 1.8, 5, hold)).toBe(2)
    expect(Array.from(hold)).toEqual([0, 0, 0, 1, 1])
    expect(holdBodies(delay, 10, 5, hold)).toBe(0)
  })
})

describe('what the reveal does with a hold', () => {
  const base = {
    count: 3,
    tier: Uint8Array.from([0, 1, 2]),
    owner: Int32Array.from([-1, 0, 1]),
    order: Int32Array.from([0, 1, 2]),
    level: Uint8Array.from([2, 2, 2]),
    card: [0, 0, 0],
    selected: -1,
    lit: null,
  }

  it('hides a held body and what floats round it, and shows the rest', () => {
    const out = new Uint8Array(3)
    revealTargets({ ...base, all: false, hold: Uint8Array.from([0, 1, 0]) }, out)
    expect(Array.from(out)).toEqual([1, 0, 0])
  })

  it('holds with the sun levels off too', () => {
    const out = new Uint8Array(3)
    revealTargets({ ...base, all: true, hold: Uint8Array.from([0, 0, 1]) }, out)
    expect(Array.from(out)).toEqual([1, 1, 0])
  })

  it('never hides the selected body', () => {
    const out = new Uint8Array(3)
    revealTargets({ ...base, selected: 1, all: false, hold: Uint8Array.from([0, 1, 1]) }, out)
    expect(out[1]).toBe(1)
  })

  it('is the old behaviour with no hold', () => {
    const out = new Uint8Array(3)
    revealTargets({ ...base, all: false }, out)
    expect(Array.from(out)).toEqual([1, 1, 1])
  })
})
