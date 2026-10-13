import { describe, expect, it } from 'vitest'
import { computeSystemLayout, orbitSpeed, urgencySpeed, type SystemInput } from '../src/layout/system'

/**
 * The cosmology of the system layout (docs/COSMOLOGY.md): around a star, from the inside out, urgent files, small
 * files (moons), big files (planets), then the stars of its sub-folders; and the speed of an orbit is its urgency.
 */

interface Body {
  id: string
  parent: number
  kind: 0 | 2 | 4
  role: number
  radius: number
  urgency?: number
  planet?: boolean
}

function layoutOf(bodies: Body[]) {
  const input: SystemInput = {
    parent: Int32Array.from(bodies.map((b) => b.parent)),
    kind: Uint8Array.from(bodies.map((b) => b.kind)),
    role: Int8Array.from(bodies.map((b) => b.role)),
    radius: Float32Array.from(bodies.map((b) => b.radius)),
    ids: bodies.map((b) => b.id),
    urgency: Float32Array.from(bodies.map((b) => b.urgency ?? 0)),
    planet: Uint8Array.from(bodies.map((b) => (b.planet ? 1 : 0))),
  }
  return computeSystemLayout(input)
}

/** A galaxy (the vault) with one star (a folder) holding: 3 urgent notes, 6 calm notes, 3 big pictures, 2 sub-folders. */
function folderOf(kids: Partial<Body>[]): Body[] {
  const out: Body[] = [
    { id: 'folder:', parent: -1, kind: 2, role: 0, radius: 16 },
    { id: 'folder:Work', parent: 0, kind: 2, role: 3, radius: 4 },
  ]
  for (const k of kids) out.push({ parent: 1, kind: 0, role: -1, radius: 1, id: `n${out.length}`, ...k })
  return out
}

describe('the cosmology of the system layout', () => {
  const bodies = folderOf([
    ...[0.9, 0.8, 0.6].map((urgency, i) => ({ id: `hot${i}`, urgency })),
    ...[0, 0, 0.05, 0.1, 0, 0.15].map((urgency, i) => ({ id: `calm${i}`, urgency })),
    ...[0, 0.1, 0].map((urgency, i) => ({ id: `pic${i}`, kind: 4 as const, radius: 5.5, planet: true, urgency })),
    ...[0.9, 0].map((urgency, i) => ({ id: `sub${i}`, kind: 2 as const, role: 3, radius: 3.4, urgency })),
  ])
  // The sub-folders need something in them to be systems of their own (they are folders: kind 2 is enough).
  const L = layoutOf(bodies)
  const idx = (id: string): number => bodies.findIndex((b) => b.id === id)
  const group = (prefix: string): number[] => bodies.map((b, i) => (b.id.startsWith(prefix) ? i : -1)).filter((i) => i >= 0)
  const maxR = (ids: number[]): number => Math.max(...ids.map((i) => L.orbitRadius[i]!))
  const minR = (ids: number[]): number => Math.min(...ids.map((i) => L.orbitRadius[i]!))

  it('puts urgent files closest in, then small files, then big files, then sub-folders', () => {
    const hot = group('hot')
    const calm = group('calm')
    const pics = group('pic')
    const subs = group('sub')
    expect(maxR(hot)).toBeLessThan(minR(calm))
    expect(maxR(calm)).toBeLessThan(minR(pics))
    expect(maxR(pics)).toBeLessThan(minR(subs))
  })

  it('runs orbits faster the more urgent they are, never at a standstill', () => {
    // Speed relative to what the radius alone would give: that is the urgency factor.
    const factor = (id: string): number => Math.abs(L.speed[idx(id)]!) / orbitSpeed(L.orbitRadius[idx(id)]!)
    expect(factor('hot0')).toBeGreaterThan(1.3)
    expect(factor('calm0')).toBeLessThan(0.9)
    expect(factor('sub0')).toBeGreaterThan(factor('sub1'))
    for (const b of bodies) if (b.parent >= 0) expect(L.speed[idx(b.id)]).not.toBe(0)
    // The numbers: 0.55 for a calm orbit up to 2 for an overdue one.
    expect(urgencySpeed(0)).toBeCloseTo(0.55, 10)
    expect(urgencySpeed(1)).toBeCloseTo(2, 10)
    expect(urgencySpeed(NaN)).toBeCloseTo(0.55, 10)
    expect(urgencySpeed(7)).toBeCloseTo(2, 10)
  })

  it('keeps one speed per ring, so bodies of a ring never pass through each other', () => {
    const byRing = new Map<string, Set<number>>()
    for (let i = 0; i < bodies.length; i++) {
      if (bodies[i]!.parent !== 1) continue
      const key = L.orbitRadius[i]!.toFixed(4)
      let set = byRing.get(key)
      if (!set) byRing.set(key, (set = new Set()))
      set.add(Math.round(L.speed[i]! * 1e6))
    }
    for (const speeds of byRing.values()) expect(speeds.size).toBe(1)
  })

  it('lays what orbits a galaxy nearly flat, a disc, and what orbits a star at the usual tilt', () => {
    // plane = quaternion about an axis in the XZ plane: |q.xyz| = sin(inclination / 2).
    const tilt = (i: number): number => 2 * Math.asin(Math.hypot(L.plane[i * 4]!, L.plane[i * 4 + 1]!, L.plane[i * 4 + 2]!))
    expect(tilt(idx('folder:Work'))).toBeLessThanOrEqual(0.05 + 1e-6)
    const kidsTilt = group('hot').map(tilt)
    expect(Math.max(...kidsTilt)).toBeLessThanOrEqual(0.45 + 1e-6)
  })

  it('lays out exactly as before when the graph carries no urgency and no planets', () => {
    const plain: Body[] = bodies.map((b) => {
      const { urgency: _u, planet: _p, ...rest } = b
      return rest
    })
    const a = computeSystemLayout({
      parent: Int32Array.from(plain.map((b) => b.parent)),
      kind: Uint8Array.from(plain.map((b) => b.kind)),
      role: Int8Array.from(plain.map((b) => b.role)),
      radius: Float32Array.from(plain.map((b) => b.radius)),
      ids: plain.map((b) => b.id),
    })
    // One speed per ring (the urgency factor is 0.55 for all), moons then systems, finite everywhere.
    for (const v of a.orbitRadius) expect(Number.isFinite(v)).toBe(true)
    const factors = new Set<number>()
    for (let i = 2; i < plain.length; i++) factors.add(Math.round((Math.abs(a.speed[i]!) / orbitSpeed(a.orbitRadius[i]!)) * 1e4))
    expect([...factors]).toEqual([5500])
  })
})
