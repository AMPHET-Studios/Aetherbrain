import { describe, expect, it } from 'vitest'
import { finiteOr, healBodies, linkStrength } from '../src/layout/safe'

describe('linkStrength', () => {
  it('is base over the smaller degree of the two ends, as it was for any link that has degrees', () => {
    expect(linkStrength(0.9, 3, 5)).toBeCloseTo(0.3, 10)
    expect(linkStrength(0.9, 5, 3)).toBeCloseTo(0.3, 10)
    expect(linkStrength(0.25, 2, 40)).toBeCloseTo(0.125, 10)
    expect(linkStrength(0.9, 1, 1)).toBeCloseTo(0.9, 10)
  })

  it('stops dividing at 12: a hub of many links does not weaken its links further', () => {
    expect(linkStrength(0.9, 12, 40)).toBeCloseTo(0.9 / 12, 10)
    expect(linkStrength(0.9, 500, 900)).toBeCloseTo(0.9 / 12, 10)
  })

  it('is finite whatever an end claims to have: no links (a Today beam), a negative number, NaN', () => {
    for (const [a, b] of [
      [0, 14],
      [14, 0],
      [0, 0],
      [-3, 4],
      [Number.NaN, 4],
      [4, Number.NaN],
    ] as const) {
      const v = linkStrength(0.9, a, b)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeCloseTo(0.9, 10)
    }
  })
})

describe('finiteOr', () => {
  it('keeps numbers and replaces everything else', () => {
    expect(finiteOr(4.5, 1)).toBe(4.5)
    expect(finiteOr(0, 1)).toBe(0)
    expect(finiteOr(undefined, 1)).toBe(1)
    expect(finiteOr(Number.NaN, 1)).toBe(1)
    expect(finiteOr(Infinity, 1)).toBe(1)
    expect(finiteOr(-Infinity, 1)).toBe(1)
  })
})

describe('healBodies', () => {
  it('puts back only the bodies that are not finite, at rest, and counts them', () => {
    const ok = { x: 1, y: 2, z: 3, vx: 0.1, vy: 0.2, vz: 0.3 }
    const lost = { x: Infinity, y: 2, z: 3, vx: 0, vy: 0, vz: 0 }
    const fast = { x: 1, y: 2, z: 3, vx: 0, vy: Number.NaN, vz: 0 }
    const unplaced = { x: undefined, y: 2, z: 3, vx: 0, vy: 0, vz: 0 }
    const healed = healBodies([ok, lost, fast, unplaced], () => [10, 20, 30])
    expect(healed).toBe(3)
    expect(ok).toEqual({ x: 1, y: 2, z: 3, vx: 0.1, vy: 0.2, vz: 0.3 })
    for (const b of [lost, fast, unplaced]) expect(b).toEqual({ x: 10, y: 20, z: 30, vx: 0, vy: 0, vz: 0 })
  })

  it('does nothing, and says so, when every body is fine', () => {
    expect(healBodies([{ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }], () => [9, 9, 9])).toBe(0)
    expect(healBodies([], () => [9, 9, 9])).toBe(0)
  })
})
