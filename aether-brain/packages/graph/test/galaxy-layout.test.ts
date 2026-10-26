import { describe, expect, it } from 'vitest'
import { computeSystemLayout, systemPositions, type SystemInput, type SystemLayout } from '../src/layout/system'

/**
 * A folder you marked as a galaxy in the system layout (docs/COSMOLOGY.md, "A galaxy is a folder you mark"): its sub-folders lie on a
 * disc of its own, tilted a little so galaxies are not one plate, and nothing ever overlaps, however galaxies sit on each other.
 */

interface Body {
  id: string
  parent: number
  kind: 0 | 2
  role: number
  radius: number
}

const GALAXY = 4

function layoutOf(bodies: Body[]): SystemLayout {
  const input: SystemInput = {
    parent: Int32Array.from(bodies.map((b) => b.parent)),
    kind: Uint8Array.from(bodies.map((b) => b.kind)),
    role: Int8Array.from(bodies.map((b) => b.role)),
    radius: Float32Array.from(bodies.map((b) => b.radius)),
    ids: bodies.map((b) => b.id),
  }
  return computeSystemLayout(input)
}

/** The vault, six galaxies on it (one holding a nested galaxy), two plain stars, each with stars and notes of their own. */
function sky(galaxyRadius = 13): Body[] {
  const out: Body[] = [{ id: 'folder:', parent: -1, kind: 2, role: 0, radius: 16 }]
  const add = (b: Omit<Body, 'kind'> & { kind?: 0 | 2 }): number => out.push({ kind: 2, ...b }) - 1
  for (let g = 0; g < 6; g++) {
    const gi = add({ id: `folder:G${g}`, parent: 0, role: GALAXY, radius: galaxyRadius })
    for (let s = 0; s < 5; s++) {
      const si = add({ id: `folder:G${g}/S${s}`, parent: gi, role: 3, radius: 4 + (s % 3) * 1.5 })
      for (let n = 0; n < 3; n++) add({ id: `G${g}/S${s}/n${n}`, parent: si, role: -1, radius: 1, kind: 0 })
    }
    if (g === 0) {
      const ni = add({ id: 'folder:G0/Nested', parent: gi, role: GALAXY, radius: 12 })
      for (let s = 0; s < 4; s++) add({ id: `folder:G0/Nested/S${s}`, parent: ni, role: 3, radius: 5 })
    }
  }
  for (let p = 0; p < 2; p++) {
    const pi = add({ id: `folder:P${p}`, parent: 0, role: 3, radius: 6 })
    for (let s = 0; s < 5; s++) add({ id: `folder:P${p}/S${s}`, parent: pi, role: 3, radius: 4 })
  }
  return out
}

const tiltOf = (L: SystemLayout, i: number): number => 2 * Math.asin(Math.hypot(L.plane[i * 4]!, L.plane[i * 4 + 1]!, L.plane[i * 4 + 2]!))
const positionsAt = (L: SystemLayout, t: number): Float32Array => {
  const out = new Float32Array(L.parent.length * 3)
  systemPositions(L, t, out)
  return out
}
const dist = (pos: Float32Array, a: number, b: number): number =>
  Math.hypot(pos[a * 3]! - pos[b * 3]!, pos[a * 3 + 1]! - pos[b * 3 + 1]!, pos[a * 3 + 2]! - pos[b * 3 + 2]!)

describe('a galaxy you marked, in the layout', () => {
  const bodies = sky()
  const L = layoutOf(bodies)
  const idx = (id: string): number => bodies.findIndex((b) => b.id === id)
  const kidsOf = (parent: number): number[] => bodies.map((b, i) => (b.parent === parent ? i : -1)).filter((i) => i >= 0)

  it('lays its sub-folders on a disc tilted by at most about 17 degrees, where a drive’s disc is nearly flat', () => {
    const tilts = bodies.map((b, i) => (b.role === GALAXY ? Math.max(...kidsOf(i).map((k) => tiltOf(L, k))) : -1)).filter((t) => t >= 0)
    expect(tilts.length).toBe(7)
    for (const t of tilts) expect(t).toBeLessThanOrEqual(0.3 + 1e-6)
    // The galaxies are not all in one plate: the discs differ by more than a drive's 0.05.
    expect(Math.max(...tilts)).toBeGreaterThan(0.05)
    // What orbits the vault stays a nearly flat disc, and what orbits a plain star at the usual tilt.
    for (const k of kidsOf(0)) expect(tiltOf(L, k)).toBeLessThanOrEqual(0.05 + 1e-6)
    const p0 = idx('folder:P0')
    for (const k of kidsOf(p0)) expect(tiltOf(L, k)).toBeLessThanOrEqual(0.45 + 1e-6)
  })

  it('keeps every body clear of its siblings, at any time, with a galaxy nested in a galaxy', () => {
    for (const t of [0, 2.5, 60]) {
      const pos = positionsAt(L, t)
      const groups = new Map<number, number[]>()
      bodies.forEach((b, i) => {
        if (b.parent >= 0) groups.set(b.parent, [...(groups.get(b.parent) ?? []), i])
      })
      for (const kids of groups.values()) {
        for (let a = 0; a < kids.length; a++) {
          for (let b = a + 1; b < kids.length; b++) {
            const ia = kids[a]!
            const ib = kids[b]!
            expect(dist(pos, ia, ib), `${bodies[ia]!.id} / ${bodies[ib]!.id} at ${t}`).toBeGreaterThanOrEqual(L.extent[ia]! + L.extent[ib]! - 1e-3)
          }
        }
      }
    }
  })

  it('sits a nested galaxy on its galaxy’s disc, outside the galaxy’s own body, inside its extent', () => {
    const g0 = idx('folder:G0')
    const n = idx('folder:G0/Nested')
    expect(L.parent[n]).toBe(g0)
    expect(L.orbitRadius[n]!).toBeGreaterThan(13 * 1.6 + 1)
    expect(L.orbitRadius[n]! + L.extent[n]!).toBeLessThanOrEqual(L.extent[g0]! + 1e-3)
    // Its own stars lie on its own, tilted, disc.
    for (const k of kidsOf(n)) expect(tiltOf(L, k)).toBeLessThanOrEqual(0.3 + 1e-6)
  })

  it('is the same sky every time', () => {
    const again = layoutOf(sky())
    expect(Array.from(again.orbitRadius)).toEqual(Array.from(L.orbitRadius))
    expect(Array.from(again.plane)).toEqual(Array.from(L.plane))
    expect(Array.from(positionsAt(again, 9))).toEqual(Array.from(positionsAt(L, 9)))
  })

  it('makes room by the galaxy’s radius: a bigger galaxy pushes its first ring out by 2.4 per unit', () => {
    const small = layoutOf(sky(12))
    const big = layoutOf(sky(15))
    const first = (x: SystemLayout, g: string, bs: Body[]): number => Math.min(...bs.map((b, i) => (b.parent === bs.findIndex((c) => c.id === g) ? x.orbitRadius[i]! : Infinity)))
    expect(first(big, 'folder:G1', sky(15))).toBeGreaterThan(first(small, 'folder:G1', sky(12)))
    expect(first(big, 'folder:G1', sky(15)) - first(small, 'folder:G1', sky(12))).toBeCloseTo(2.4 * 3, 1)
  })

  it('is finite everywhere', () => {
    for (const v of L.orbitRadius) expect(Number.isFinite(v)).toBe(true)
    for (const v of L.extent) expect(Number.isFinite(v)).toBe(true)
    for (const v of positionsAt(L, 123.4)) expect(Number.isFinite(v)).toBe(true)
  })
})
