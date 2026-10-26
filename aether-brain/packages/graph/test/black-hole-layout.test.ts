import { describe, expect, it } from 'vitest'
import { BLACK_HOLE_INCLINATION, BLACK_HOLE_REACH, BLACK_HOLE_ROLE, computeSystemLayout, systemPositions, type SystemLayout } from '../src/layout/system'
import { BH_DISC_REACH } from '../src/scene/blackHole'

/**
 * The Bio black hole in the system layout (docs/COSMOLOGY.md, "The Bio black hole"): it is the centre, never moves, its pages orbit just
 * outside its disc, and every galaxy revolves around it on a nearly flat plane, clear of each other and of the disc.
 */

interface Body {
  id: string
  parent: number
  kind: 0 | 2
  role: number
  radius: number
}

const HOLE_RADIUS = 24

function layoutOf(bodies: Body[]): SystemLayout {
  return computeSystemLayout({
    parent: Int32Array.from(bodies.map((b) => b.parent)),
    kind: Uint8Array.from(bodies.map((b) => b.kind)),
    role: Int8Array.from(bodies.map((b) => b.role)),
    radius: Float32Array.from(bodies.map((b) => b.radius)),
    ids: bodies.map((b) => b.id),
  })
}

/** The Bio with six pages; the vault (a galaxy, with stars), two galaxies you marked, and a small drive-like galaxy, all circling it. */
function sky(): Body[] {
  const out: Body[] = [{ id: 'folder:Bio', parent: -1, kind: 2, role: BLACK_HOLE_ROLE, radius: HOLE_RADIUS }]
  const add = (b: Omit<Body, 'kind'> & { kind?: 0 | 2 }): number => out.push({ kind: 2, ...b }) - 1
  for (let p = 0; p < 6; p++) add({ id: `Bio/page${p}`, parent: 0, role: -1, radius: 1, kind: 0 })
  const galaxy = (id: string, role: number, radius: number, stars: number): void => {
    const gi = add({ id, parent: 0, role, radius })
    for (let s = 0; s < stars; s++) {
      const si = add({ id: `${id}/S${s}`, parent: gi, role: 3, radius: 4 + (s % 3) })
      for (let n = 0; n < 3; n++) add({ id: `${id}/S${s}/n${n}`, parent: si, role: -1, radius: 1, kind: 0 })
    }
  }
  galaxy('folder:', 0, 16, 9)
  galaxy('folder:Lab', 4, 13, 5)
  galaxy('folder:Lab/Core', 4, 12, 4)
  galaxy('folder:D', 1, 16, 3)
  return out
}

const positionsAt = (L: SystemLayout, t: number): Float32Array => {
  const out = new Float32Array(L.parent.length * 3)
  systemPositions(L, t, out)
  return out
}
const dist = (pos: Float32Array, a: number, b: number): number => Math.hypot(pos[a * 3]! - pos[b * 3]!, pos[a * 3 + 1]! - pos[b * 3 + 1]!, pos[a * 3 + 2]! - pos[b * 3 + 2]!)
const tiltOf = (L: SystemLayout, i: number): number => 2 * Math.asin(Math.hypot(L.plane[i * 4]!, L.plane[i * 4 + 1]!, L.plane[i * 4 + 2]!))

describe('the black hole in the layout', () => {
  const bodies = sky()
  const L = layoutOf(bodies)
  const kidsOf = (parent: number): number[] => bodies.map((b, i) => (b.parent === parent ? i : -1)).filter((i) => i >= 0)
  const galaxies = bodies.map((b, i) => (b.role === 0 || b.role === 1 || b.role === 4 ? i : -1)).filter((i) => i >= 0)
  const pages = kidsOf(0).filter((i) => bodies[i]!.role === -1)

  it('is the one root, at the origin, and never moves', () => {
    expect(L.parent[0]).toBe(-1)
    expect(bodies.filter((b) => b.parent === -1).length).toBe(1)
    for (const t of [0, 3.7, 90, 4000]) {
      const pos = positionsAt(L, t)
      expect([pos[0], pos[1], pos[2]]).toEqual([0, 0, 0])
    }
  })

  it('has every galaxy revolve around it, the vault, a drive and a marked one alike', () => {
    expect(galaxies.length).toBe(4)
    for (const g of galaxies) {
      expect(L.parent[g], bodies[g]!.id).toBe(0)
      expect(L.speed[g], bodies[g]!.id).not.toBe(0)
      expect(L.orbitRadius[g]!, bodies[g]!.id).toBeGreaterThan(0)
    }
  })

  it('leaves what a galaxy holds with it', () => {
    bodies.forEach((b, i) => {
      if (b.parent > 0) expect(L.parent[i]).toBe(b.parent)
    })
  })

  it('keeps the room its disc needs: nothing comes within the disc’s reach, its pages included', () => {
    const reach = BH_DISC_REACH * HOLE_RADIUS
    expect(BLACK_HOLE_REACH * 2.4).toBeGreaterThan(BH_DISC_REACH)
    for (const page of pages) expect(L.orbitRadius[page]!, bodies[page]!.id).toBeGreaterThan(reach)
    for (const g of galaxies) expect(L.orbitRadius[g]! - L.extent[g]!, bodies[g]!.id).toBeGreaterThan(reach)
    for (const t of [0, 11, 250]) {
      const pos = positionsAt(L, t)
      for (const page of pages) expect(dist(pos, 0, page), `${bodies[page]!.id} at ${t}`).toBeGreaterThan(reach)
    }
  })

  it('lays what circles it nearly flat, in one plane', () => {
    for (const k of kidsOf(0)) {
      expect(tiltOf(L, k), bodies[k]!.id).toBeLessThanOrEqual(BLACK_HOLE_INCLINATION + 1e-6)
      expect([...L.plane.slice(k * 4, k * 4 + 4)]).toEqual([...L.plane.slice(kidsOf(0)[0]! * 4, kidsOf(0)[0]! * 4 + 4)])
    }
    expect(BLACK_HOLE_INCLINATION).toBeLessThan(0.3)
    expect(L.rings.length).toBeGreaterThan(0)
  })

  it('keeps every galaxy clear of the others and of the pages, at any time', () => {
    const kids = kidsOf(0)
    for (const t of [0, 2.5, 60, 1000]) {
      const pos = positionsAt(L, t)
      for (let a = 0; a < kids.length; a++) {
        for (let b = a + 1; b < kids.length; b++) {
          const ia = kids[a]!
          const ib = kids[b]!
          expect(dist(pos, ia, ib), `${bodies[ia]!.id} / ${bodies[ib]!.id} at ${t}`).toBeGreaterThanOrEqual(L.extent[ia]! + L.extent[ib]! - 1e-3)
        }
      }
    }
  })

  it('is the same every time: the same sky lays out the same way', () => {
    const again = layoutOf(sky())
    expect([...again.orbitRadius]).toEqual([...L.orbitRadius])
    expect([...again.phase]).toEqual([...L.phase])
    expect([...again.speed]).toEqual([...L.speed])
  })

  it('gives the layout a body twice as big as the hole, so the first ring starts outside the disc', () => {
    expect(BLACK_HOLE_REACH).toBe(2)
    // The first ring is at least the reach times the radius times 2.4 out (the usual first ring), plus the gap.
    const innermost = Math.min(...kidsOf(0).map((k) => L.orbitRadius[k]! - L.extent[k]!))
    expect(innermost).toBeGreaterThanOrEqual(HOLE_RADIUS * BLACK_HOLE_REACH * 2.4)
  })
})

describe('a sky without a black hole', () => {
  it('lays out as it always did: a role of 5 is all that makes the difference', () => {
    const bodies = sky().map((b) => (b.role === BLACK_HOLE_ROLE ? { ...b, role: 3 } : b))
    // Without a role of 5 the first body is an ordinary star with its own, smaller room.
    const plain = layoutOf(bodies)
    const withHole = layoutOf(sky())
    const first = (L: SystemLayout) => Math.min(...Array.from(L.parent, (p, i) => (p === 0 ? L.orbitRadius[i]! - L.extent[i]! : Infinity)))
    expect(first(plain)).toBeLessThan(first(withHole))
  })
})
