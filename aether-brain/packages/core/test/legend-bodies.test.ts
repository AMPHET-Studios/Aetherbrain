import { describe, expect, it } from 'vitest'
import { LEGEND_BODIES, PLANET_MIN_BYTES, PLANET_MIN_WORDS, legendBodies, type GraphNode } from '../src'

/**
 * Which of the legend's kinds a body is (docs/COSMOLOGY.md): what the legend's chips light up. The rules are the cosmology's own
 * (`isPlanetNode`, `isGalaxyNode`), seen from the legend: a picture is also a picture.
 */

/** A node with only what the classification reads. */
const node = (over: Record<string, unknown>): GraphNode => ({ kind: 'note', ghost: false, wordCount: 10, parent: null, ...over }) as unknown as GraphNode

describe('the legend’s kinds', () => {
  it('lists the six the legend names, in its order', () => {
    expect([...LEGEND_BODIES]).toEqual(['galaxy', 'star', 'planet', 'moon', 'sun', 'picture'])
  })

  it('calls a drive, or a one-folder vault, a galaxy, and every other folder a star', () => {
    expect(legendBodies(node({ kind: 'folder', folder: { role: 'mount' } }))).toEqual(['galaxy'])
    expect(legendBodies(node({ kind: 'folder', folder: { role: 'root', galaxy: true } }))).toEqual(['galaxy'])
    // The root of several drives is the origin they orbit: not a galaxy, so a star here (it is a folder).
    expect(legendBodies(node({ kind: 'folder', folder: { role: 'root' } }))).toEqual(['star'])
    expect(legendBodies(node({ kind: 'folder', folder: { role: 'project' } }))).toEqual(['star'])
    expect(legendBodies(node({ kind: 'folder', folder: { role: 'folder' } }))).toEqual(['star'])
  })

  it('calls a board with pictures orbiting it a sun, and a plain board note a moon like any note', () => {
    expect(legendBodies(node({ type: 'board', board: { pictures: 3 } }))).toEqual(['sun'])
    expect(legendBodies(node({ type: 'board' }))).toEqual(['moon'])
  })

  it('calls a big file a planet and a small one a moon, and a picture a picture as well', () => {
    expect(legendBodies(node({ wordCount: PLANET_MIN_WORDS }))).toEqual(['planet'])
    expect(legendBodies(node({ wordCount: PLANET_MIN_WORDS - 1 }))).toEqual(['moon'])
    expect(legendBodies(node({ kind: 'ghost', ghost: true }))).toEqual(['moon'])
    expect(legendBodies(node({ kind: 'image', image: { size: PLANET_MIN_BYTES } }))).toEqual(['planet', 'picture'])
    expect(legendBodies(node({ kind: 'image', image: { size: PLANET_MIN_BYTES - 1 } }))).toEqual(['moon', 'picture'])
    // A picture nobody measured is a planet until it says it is small.
    expect(legendBodies(node({ kind: 'image', image: { size: null } }))).toEqual(['planet', 'picture'])
  })

  it('leaves the Today hub out of all of them', () => {
    expect(legendBodies(node({ kind: 'today' }))).toEqual([])
  })
})
