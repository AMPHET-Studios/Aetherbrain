import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { BLACK_HOLE_REACH } from '../src/layout/system'
import {
  BH_DISC_IN,
  BH_DISC_OUT,
  BH_DISC_REACH,
  BH_PHOTON,
  BH_QUAD,
  BH_RS,
  BH_START,
  BH_STEPS,
  DORMANT_FEED,
  buildBlackHole,
  createBlackHoleMaterial,
  feedOf,
  fitBlackHole,
  holeFeed,
  placeBlackHole,
  planeAxes,
} from '../src/scene/blackHole'

/**
 * The Bio black hole's maths (docs/COSMOLOGY.md, "The Bio black hole"): the plane its disc lies in, how hungry it is, where it is put,
 * and the numbers the shader and the layout agree on. The picture itself is checked in the real app.
 */

const dot = (a: ArrayLike<number>, b: ArrayLike<number>, i = 0, j = 0): number => a[i]! * b[j]! + a[i + 1]! * b[j + 1]! + a[i + 2]! * b[j + 2]!

describe('the numbers the shader, the layout and the picture share', () => {
  it('puts the apparent shadow just beyond the node’s own radius, so the node is what you pick', () => {
    const shadow = BH_PHOTON * BH_RS
    expect(shadow).toBeGreaterThan(1)
    expect(shadow).toBeLessThan(1.25)
  })

  it('orders the disc, the photon ring and the horizon: the disc starts outside the ring, which is outside the horizon (1 Rs)', () => {
    expect(BH_PHOTON).toBeGreaterThan(1.5)
    expect(BH_DISC_IN).toBeGreaterThan(BH_PHOTON)
    expect(BH_DISC_OUT).toBeGreaterThan(BH_DISC_IN)
    expect(BH_START).toBeGreaterThan(BH_DISC_OUT)
    expect(BH_STEPS).toBeGreaterThanOrEqual(48)
    expect(BH_STEPS).toBeLessThanOrEqual(128)
  })

  it('draws the quad wide enough for the disc and a glow around it, and the layout keeps the whole disc clear', () => {
    expect(BH_QUAD / BH_RS).toBeGreaterThan(BH_DISC_OUT + 1.5)
    expect(BH_DISC_REACH).toBeCloseTo(BH_DISC_OUT * BH_RS, 9)
    // The first ring starts 2.4 reaches out: outside the disc, with room to spare.
    expect(BLACK_HOLE_REACH * 2.4).toBeGreaterThan(BH_DISC_REACH + 1)
    expect(BH_DISC_REACH).toBeLessThan(BH_QUAD)
  })

  it('is written into the shader, not a second copy of the numbers', () => {
    const m = createBlackHoleMaterial()
    const f = m.fragmentShader
    expect(f).toContain(`const float RIN = ${BH_DISC_IN.toFixed(1)};`)
    expect(f).toContain(`const float ROUT = ${BH_DISC_OUT.toFixed(1)};`)
    expect(f).toContain(`const float RSTART = ${BH_START.toFixed(1)};`)
    expect(f).toContain(`const float PHOTON = ${BH_PHOTON.toFixed(2)};`)
    expect(f).toContain(`for (int i = 0; i < ${BH_STEPS}; i++)`)
    expect(f).toContain('-1.5 * h2 * pos')
    m.dispose()
  })

  it('is a billboard in view space that adds light and hides what is behind the shadow', () => {
    const m = createBlackHoleMaterial()
    expect(m.vertexShader).toContain('viewMatrix * modelMatrix')
    expect(m.vertexShader).toContain('position.xy * uSize')
    expect(m.transparent).toBe(true)
    expect(m.depthWrite).toBe(false)
    expect(m.depthTest).toBe(true)
    m.dispose()
  })
})

describe('the plane of the disc', () => {
  it('is the flat sky for no turn, with u along x, the normal up and v along z', () => {
    const a = new Float32Array(9)
    planeAxes(0, 0, 0, 1, a)
    expect([...a]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
  })

  it('turns with the quaternion: a quarter turn about x stands the disc on its edge', () => {
    const a = new Float32Array(9)
    const s = Math.SQRT1_2
    planeAxes(s, 0, 0, s, a)
    const near = (got: number, want: number) => expect(got).toBeCloseTo(want, 6)
    ;[1, 0, 0, 0, 0, 1, 0, -1, 0].forEach((want, k) => near(a[k]!, want))
  })

  it('is always three unit vectors at right angles, for any turn, even one that is not normalised', () => {
    const a = new Float32Array(9)
    for (const q of [
      [0.12, -0.3, 0.05, 0.9],
      [0.5, 0.5, 0.5, 0.5],
      [3, -2, 1, 7],
      [0, 0.9, 0, 0.4],
    ] as const) {
      planeAxes(q[0], q[1], q[2], q[3], a)
      for (const [i, j] of [
        [0, 0],
        [3, 3],
        [6, 6],
      ] as const) expect(dot(a, a, i, j)).toBeCloseTo(1, 5)
      for (const [i, j] of [
        [0, 3],
        [0, 6],
        [3, 6],
      ] as const) expect(dot(a, a, i, j)).toBeCloseTo(0, 5)
      // Right-handed: u × n = v.
      const cross = new Vector3(a[0], a[1], a[2]).cross(new Vector3(a[3], a[4], a[5]))
      expect(cross.x).toBeCloseTo(a[6]!, 5)
      expect(cross.y).toBeCloseTo(a[7]!, 5)
      expect(cross.z).toBeCloseTo(a[8]!, 5)
    }
  })

  it('falls back to the flat sky for a turn that is not a number or has no size', () => {
    const a = new Float32Array(9)
    for (const q of [
      [Number.NaN, 0, 0, 1],
      [0, 0, 0, 0],
      [Infinity, 0, 0, 1],
    ] as const) {
      planeAxes(q[0], q[1], q[2], q[3], a)
      expect([...a]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
    }
  })
})

describe('how hungry the black hole is', () => {
  it('is dormant, a faint ring only, before the folder exists (or for no folder)', () => {
    expect(feedOf({ placeholder: true, totalNotes: 0 })).toBe(DORMANT_FEED)
    expect(feedOf({ placeholder: true, totalNotes: 40 })).toBe(DORMANT_FEED)
    expect(feedOf(undefined)).toBe(DORMANT_FEED)
    expect(DORMANT_FEED).toBeGreaterThan(0)
    expect(DORMANT_FEED).toBeLessThan(0.2)
  })

  it('is always between 0 and 1, whatever the folder holds', () => {
    for (const totalNotes of [0, 1, 6, 7, 60, 1e9, -3, Number.NaN, Infinity]) {
      const f = feedOf({ placeholder: false, totalNotes })
      expect(f, String(totalNotes)).toBeGreaterThanOrEqual(0)
      expect(f, String(totalNotes)).toBeLessThanOrEqual(1)
      expect(Number.isFinite(f)).toBe(true)
    }
  })

  it('burns brighter for a Bio that exists than for one that does not, and is full when all six pages are there', () => {
    expect(feedOf({ placeholder: false, totalNotes: 0 })).toBeGreaterThan(DORMANT_FEED)
    expect(feedOf({ placeholder: false, totalNotes: 6 })).toBeGreaterThanOrEqual(feedOf({ placeholder: false, totalNotes: 3 }))
    expect(holeFeed({ placeholder: false, totalNotes: 6 })).toBe(1)
  })
})

describe('putting the black hole in the sky', () => {
  it('is hidden until it is placed, drawn last, and has the flat plane to begin with', () => {
    const h = buildBlackHole(3)
    expect(h.mesh.visible).toBe(false)
    expect(h.mesh.renderOrder).toBe(10)
    expect(h.mesh.frustumCulled).toBe(false)
    expect(h.node).toBe(3)
    expect([...h.axes]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
    h.dispose()
  })

  it('lies in the plane of the first ring the layout draws around it, and in no other', () => {
    const h = buildBlackHole(2)
    const s = Math.SQRT1_2
    // Ring 0 circles node 5, ring 1 circles node 2 (turned a quarter about x), ring 2 circles node 2 too.
    const parent = [5, 2, 2]
    const quat = [0, 0, 0, 1, s, 0, 0, s, 0, s, 0, s]
    expect(fitBlackHole(h, parent, quat, 3)).toBe(true)
    expect(h.axes[4]).toBeCloseTo(0, 6)
    expect(h.axes[5]).toBeCloseTo(1, 6)
    const n = h.material.uniforms['uN']!.value as Vector3
    expect(n.z).toBeCloseTo(1, 6)
    expect(n.y).toBeCloseTo(0, 6)
    h.dispose()
  })

  it('keeps its plane when there is no ring for it yet, or the ring’s turn is not a number', () => {
    const h = buildBlackHole(2)
    expect(fitBlackHole(h, [5, 6], [0, 0, 0, 1, 0, 0, 0, 1], 2)).toBe(false)
    expect(fitBlackHole(h, [2], [Number.NaN, 0, 0, 1], 1)).toBe(false)
    expect([...h.axes]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
    expect(fitBlackHole(h, [2], [0, 0, 0, 1], 0)).toBe(false)
    h.dispose()
  })

  it('is as wide as its node is drawn, where its node is, and hides when the node has no size', () => {
    const h = buildBlackHole(0)
    placeBlackHole(h, 10, -4, 7, 25, 0.8, 12.5, 0.5)
    expect(h.mesh.visible).toBe(true)
    expect(h.mesh.position.toArray()).toEqual([10, -4, 7])
    const u = h.material.uniforms
    expect(u['uSize']!.value).toBeCloseTo(BH_QUAD * 25, 9)
    expect(u['uRs']!.value).toBeCloseTo(BH_RS * 25, 9)
    expect(u['uFeed']!.value).toBe(0.8)
    expect(u['uTime']!.value).toBe(12.5)
    expect(u['uLift']!.value).toBe(0.5)
    placeBlackHole(h, 0, 0, 0, 0, 1, 0, 0)
    expect(h.mesh.visible).toBe(false)
    h.dispose()
  })

  it('never takes a number that is not one: the sky must not go blank because of a bad frame', () => {
    const h = buildBlackHole(0)
    placeBlackHole(h, Number.NaN, Infinity, -Infinity, Number.NaN, Number.NaN, Number.NaN, 7)
    expect(h.mesh.visible).toBe(false)
    expect(h.mesh.position.toArray()).toEqual([0, 0, 0])
    const u = h.material.uniforms
    expect(u['uFeed']!.value).toBe(0)
    expect(u['uTime']!.value).toBe(0)
    expect(u['uLift']!.value).toBe(1)
    expect(u['uRs']!.value).toBeGreaterThan(0)
    placeBlackHole(h, 1, 2, 3, 20, 5, 1, -2)
    expect(u['uFeed']!.value).toBe(1)
    expect(u['uLift']!.value).toBe(0)
    h.dispose()
  })
})
