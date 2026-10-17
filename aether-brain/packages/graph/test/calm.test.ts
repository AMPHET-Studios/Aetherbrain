import { describe, expect, it } from 'vitest'
import { CALM_MAX_SPEED, calmSpeed, computeSystemLayout, orbitSpeed, systemPositions, urgencySpeed, type SystemInput, type SystemLayout } from '../src/layout/system'

/**
 * Calm orbits (docs/COSMOLOGY.md, "Calm orbits"): the speed urgency gives an orbit is held to a normal orbit's pace.
 * Calm is a clock, not a layout: every orbit carries `slack`, the speed calm takes off it, and `systemPositions`
 * takes `slack × calm seconds` off the angle.
 */

interface Body {
  id: string
  parent: number
  kind: 0 | 2 | 3 | 4
  role: number
  radius: number
  urgency?: number
  planet?: boolean
}

function inputOf(bodies: Body[]): SystemInput {
  return {
    parent: Int32Array.from(bodies.map((b) => b.parent)),
    kind: Uint8Array.from(bodies.map((b) => b.kind)),
    role: Int8Array.from(bodies.map((b) => b.role)),
    radius: Float32Array.from(bodies.map((b) => b.radius)),
    ids: bodies.map((b) => b.id),
    urgency: Float32Array.from(bodies.map((b) => b.urgency ?? 0)),
    planet: Uint8Array.from(bodies.map((b) => (b.planet ? 1 : 0))),
  }
}

/** A vault galaxy with one star holding `kids`. */
function starOf(kids: Partial<Body>[]): Body[] {
  const out: Body[] = [
    { id: 'folder:', parent: -1, kind: 2, role: 0, radius: 16 },
    { id: 'folder:Work', parent: 0, kind: 2, role: 3, radius: 4 },
  ]
  for (const k of kids) out.push({ parent: 1, kind: 0, role: -1, radius: 1, id: `n${out.length}`, ...k })
  return out
}

/** How many times a normal orbit's speed an orbit runs at (its angular speed over `orbitSpeed(radius)`). */
const pace = (L: SystemLayout, i: number, calm = false): number => Math.abs(L.speed[i]! - (calm ? L.slack[i]! : 0)) / orbitSpeed(L.orbitRadius[i]!)

describe('calm orbits: the speed', () => {
  it('runs from the calm pace up to a normal one, never past it', () => {
    expect(CALM_MAX_SPEED).toBe(1)
    expect(calmSpeed(0)).toBeCloseTo(0.55, 10)
    expect(calmSpeed(0.5)).toBeCloseTo(0.775, 10)
    expect(calmSpeed(1)).toBeCloseTo(1, 10)
    // Not a number, or out of range: the calm end and the normal end, like `urgencySpeed`.
    expect(calmSpeed(NaN)).toBeCloseTo(0.55, 10)
    expect(calmSpeed(-3)).toBeCloseTo(0.55, 10)
    expect(calmSpeed(7)).toBeCloseTo(1, 10)
  })

  it('keeps the order: a more urgent orbit is still a faster one, and a calm orbit is the same as before', () => {
    let last = 0
    for (let k = 0; k <= 20; k++) {
      const u = k / 20
      expect(calmSpeed(u)).toBeGreaterThan(last)
      expect(calmSpeed(u)).toBeLessThanOrEqual(urgencySpeed(u) + 1e-12)
      last = calmSpeed(u)
    }
    expect(calmSpeed(0)).toBe(urgencySpeed(0))
  })
})

describe('calm orbits: what a layout carries', () => {
  it('takes exactly the urgency off an orbit: a ring that is 0.9 urgent runs at 1.855 normally and 0.955 calm', () => {
    // One urgent leaf: it has a ring of its own, so the ring's urgency is its own.
    const bodies = starOf([{ id: 'hot', urgency: 0.9 }])
    const L = computeSystemLayout(inputOf(bodies))
    const hot = 2
    expect(pace(L, hot)).toBeCloseTo(urgencySpeed(0.9), 5)
    expect(pace(L, hot, true)).toBeCloseTo(calmSpeed(0.9), 5)
    // The same direction: calm slows an orbit, it never turns it around.
    expect(Math.sign(L.slack[hot]!)).toBe(Math.sign(L.speed[hot]!))
  })

  it('leaves orbits that urgency does not speed up as they are: nothing calm, nothing to take off', () => {
    // (An orbit turning the other way has a slack of -0: nothing either way.)
    const L = computeSystemLayout(inputOf(starOf([{ id: 'a' }, { id: 'b' }, { id: 'c' }])))
    for (const s of L.slack) expect(Math.abs(s)).toBe(0)
    const plain = computeSystemLayout({ ...inputOf(starOf([{ id: 'a' }])), urgency: undefined, planet: undefined })
    for (const s of plain.slack) expect(Math.abs(s)).toBe(0)
  })

  it('holds every orbit of a busy sky to a normal pace while calm, urgent files, moons on rings and on a shell, planets and stars', () => {
    const kids: Partial<Body>[] = [
      ...[0.95, 0.9, 0.8, 0.6, 0.55].map((urgency, i) => ({ id: `hot${i}`, urgency })),
      // More than 24 small files: a shell that turns as one, at the speed of their mean urgency.
      ...Array.from({ length: 30 }, (_, i) => ({ id: `moon${i}`, urgency: i % 3 === 0 ? 0.4 : 0.1 })),
      ...[0.9, 0.3, 0].map((urgency, i) => ({ id: `pic${i}`, kind: 4 as const, radius: 5.5, planet: true, urgency })),
      ...[1, 0.7, 0.1].map((urgency, i) => ({ id: `sub${i}`, kind: 2 as const, role: 3, radius: 3.4, urgency })),
    ]
    const bodies = starOf(kids)
    const L = computeSystemLayout(inputOf(bodies))
    let faster = 0
    for (let i = 0; i < bodies.length; i++) {
      if (bodies[i]!.parent < 0) continue
      expect(pace(L, i, true), bodies[i]!.id).toBeLessThanOrEqual(CALM_MAX_SPEED + 1e-5)
      // Calm only ever takes speed off.
      expect(Math.abs(L.slack[i]!), bodies[i]!.id).toBeLessThanOrEqual(Math.abs(L.speed[i]!) + 1e-7)
      expect(L.slack[i]! * L.speed[i]!).toBeGreaterThanOrEqual(0)
      if (pace(L, i) > CALM_MAX_SPEED + 1e-5) faster++
    }
    // The sky has orbits that urgency made faster than normal, or this test would prove nothing.
    expect(faster).toBeGreaterThan(5)
    // And a body is never stopped by it.
    for (let i = 0; i < bodies.length; i++) if (bodies[i]!.parent >= 0) expect(pace(L, i, true)).toBeGreaterThan(0.5)
  })

  it('leaves a gallery card out of it: the sphere turns at its own pace even for a picture that is also an urgent moon', () => {
    const bodies = starOf([{ id: 'pic', kind: 4, radius: 5.5, planet: true, urgency: 0.9 }])
    const gallery = new Int32Array(bodies.length).fill(-1)
    gallery[2] = 1
    const L = computeSystemLayout({ ...inputOf(bodies), gallery, galleryRank: new Int32Array(bodies.length), galleryOnly: new Uint8Array(bodies.length) })
    expect(L.shell[2]).toBe(1)
    // The card first had a ring of its own (an urgent moon), then moved onto the gallery sphere: no slack left over.
    expect(L.slack[2]).toBe(0)
  })

  it('leaves the roots and the Today hub alone: they do not orbit', () => {
    const bodies: Body[] = [...starOf([{ id: 'hot', urgency: 0.9 }]), { id: 'today', parent: 0, kind: 3, role: -1, radius: 4.6, urgency: 1 }]
    const L = computeSystemLayout(inputOf(bodies))
    for (const i of [0, bodies.length - 1]) {
      expect(L.speed[i]).toBe(0)
      expect(L.slack[i]).toBe(0)
    }
  })
})

describe('calm orbits: where things are', () => {
  const bodies = starOf([
    ...[0.9, 0.7, 0.2].map((urgency, i) => ({ id: `hot${i}`, urgency })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `calm${i}`, urgency: 0 })),
    { id: 'pic', kind: 4 as const, radius: 5.5, planet: true, urgency: 0.8 },
    { id: 'sub', kind: 2 as const, role: 3, radius: 3.4, urgency: 0.9 },
  ])
  const L = computeSystemLayout(inputOf(bodies))
  const out = (t: number, calm?: number): Float32Array => {
    const o = new Float32Array(bodies.length * 3)
    systemPositions(L, t, o, undefined, calm)
    return o
  }

  it('is the same as before when no time was calm', () => {
    for (const t of [0, 3.5, 250]) {
      const plain = new Float32Array(bodies.length * 3)
      systemPositions(L, t, plain)
      expect(Array.from(out(t, 0))).toEqual(Array.from(plain))
    }
  })

  it('moves an urgent body less the more of the time was calm, and a calm one not at all', () => {
    const t = 40
    const lively = out(t)
    const half = out(t, t / 2)
    const calm = out(t, t)
    const idx = (id: string): number => bodies.findIndex((b) => b.id === id)
    // Everything here orbits the star (index 1), which itself orbits the galaxy: look at where a body is around it.
    const around = (p: Float32Array, i: number): [number, number, number] => [p[i * 3]! - p[3]!, p[i * 3 + 1]! - p[4]!, p[i * 3 + 2]! - p[5]!]
    const gap = (a: number[], b: number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)

    // A ring of moons with nothing urgent has nothing taken off: the same place however long calm lasted.
    const calm0 = idx('calm0')
    expect(Math.abs(L.slack[calm0]!)).toBe(0)
    expect(gap(around(lively, calm0), around(calm, calm0))).toBeLessThan(1e-3)

    // An urgent one turned less, so it is somewhere else, and half way when half the time was calm. It is still on its ring.
    const hot0 = idx('hot0')
    expect(Math.abs(L.slack[hot0]!)).toBeGreaterThan(0)
    for (const p of [lively, half, calm]) expect(Math.hypot(...around(p, hot0))).toBeCloseTo(L.orbitRadius[hot0]!, 3)
    const full = gap(around(lively, hot0), around(calm, hot0))
    const part = gap(around(lively, hot0), around(half, hot0))
    expect(full).toBeGreaterThan(1)
    expect(part).toBeGreaterThan(0.1)
    expect(part).not.toBeCloseTo(full, 1)

    // The same arithmetic as running the whole time at the calm speed: a layout whose speeds already are the calm ones.
    const calmLayout: SystemLayout = { ...L, speed: Float32Array.from(L.speed, (v, i) => v - L.slack[i]!), slack: new Float32Array(L.slack.length) }
    const asCalm = new Float32Array(bodies.length * 3)
    systemPositions(calmLayout, t, asCalm)
    for (let i = 0; i < asCalm.length; i++) expect(calm[i]!).toBeCloseTo(asCalm[i]!, 2)
  })
})
