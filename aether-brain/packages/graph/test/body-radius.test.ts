import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@aether/core'
import { HOME_MOON_RADIUS, MOON_FOLDER_MAX_RADIUS, PLANET_MAX_RADIUS, PLANET_MIN_RADIUS, STAR_MIN_RADIUS, nodeRadius } from '../src/theme'

/** Planets and moons that are folders are smaller than the star they hang from (docs/COSMOLOGY.md, *Galaxy, star, planet, moon, satellite*). */
function folder(over: Record<string, unknown>, weight = 100): GraphNode {
  return { kind: 'folder', degree: 0, folder: { path: 'a', role: 'folder', weight, totalNotes: 0, childFolders: 0, images: 0, ...over } } as unknown as GraphNode
}

describe('the size of a folder by its body', () => {
  it('is smaller for a planet than a star, and smaller again for a moon, with the same contents', () => {
    const star = nodeRadius(folder({ body: 'star' }))
    const planet = nodeRadius(folder({ body: 'planet' }))
    const moon = nodeRadius(folder({ body: 'moon' }))
    expect(star).toBeGreaterThan(planet)
    expect(planet).toBeGreaterThan(moon)
  })

  it('grows with what a planet holds, inside its own band', () => {
    expect(nodeRadius(folder({ body: 'planet' }, 0))).toBeCloseTo(PLANET_MIN_RADIUS, 5)
    expect(nodeRadius(folder({ body: 'planet' }, 1e9))).toBeCloseTo(PLANET_MAX_RADIUS, 5)
    expect(nodeRadius(folder({ body: 'moon' }, 1e9))).toBeCloseTo(MOON_FOLDER_MAX_RADIUS, 5)
    expect(PLANET_MAX_RADIUS).toBeLessThan(STAR_MIN_RADIUS * 2)
  })

  it('is a small steady size for a home moon, whatever it holds', () => {
    expect(nodeRadius(folder({ home: true, body: 'moon' }, 0))).toBe(HOME_MOON_RADIUS)
    expect(nodeRadius(folder({ home: true, body: 'moon' }, 1e9))).toBe(HOME_MOON_RADIUS)
  })

  it('keeps a folder with no body (the other layouts) a star', () => {
    expect(nodeRadius(folder({}))).toBe(nodeRadius(folder({ body: 'star' })))
  })
})
