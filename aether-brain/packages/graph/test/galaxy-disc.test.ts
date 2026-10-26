import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AdditiveBlending, DoubleSide, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three'
import { DISC_ARM, DISC_BASE, DISC_CORE, DISC_SCALE, buildDiscs, fitDiscs, placeDiscs } from '../src/scene/galaxyDisc'

/**
 * The disc of a galaxy (docs/COSMOLOGY.md, "A galaxy is a folder you mark"): one instanced mesh for every galaxy, each fitted to the
 * outermost orbit ring around its galaxy and following it. The fitting and the placing are plain numbers, so they are tested as numbers.
 */

const CREAM = [1, 0.95, 0.84] as const
/** Nodes 0 and 3 are galaxies, of 6 nodes. */
const make = () => buildDiscs([0, 3], 6, () => CREAM)
const ring = (parent: number, radius: number, q: [number, number, number, number] = [0, 0, 0, 1]) => ({ parent, radius, q })
function fit(set: ReturnType<typeof make>, rings: ReturnType<typeof ring>[]) {
  fitDiscs(
    set,
    Int32Array.from(rings.map((r) => r.parent)),
    Float32Array.from(rings.map((r) => r.radius)),
    Float32Array.from(rings.flatMap((r) => r.q)),
    rings.length,
  )
}

describe('the discs of the galaxies', () => {
  it('are one instanced mesh, one instance per galaxy, hidden until a ring gives them a size', () => {
    const set = make()
    expect(set.mesh).toBeInstanceOf(InstancedMesh)
    expect(set.mesh.count).toBe(2)
    expect(set.node).toEqual(Int32Array.from([0, 3]))
    expect([...set.slotOf]).toEqual([0, -1, -1, 1, -1, -1])
    expect(set.mesh.visible).toBe(false)
    expect(set.fitted).toBe(0)
  })

  it('take the size and plane of the OUTERMOST ring around their galaxy, a little wider, whatever order the rings come in', () => {
    const rings = [ring(0, 10, [0.1, 0, 0, 0.995]), ring(0, 25, [0, 0.2, 0, 0.98]), ring(3, 7, [0, 0, 0.3, 0.954]), ring(0, 18)]
    for (const order of [rings, [...rings].reverse()]) {
      const set = make()
      fit(set, order)
      expect(set.radius[0]).toBeCloseTo(25 * DISC_SCALE, 4)
      expect([...set.quat.slice(0, 4)].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0.2, 0, 0.98])
      expect(set.radius[1]).toBeCloseTo(7 * DISC_SCALE, 4)
      expect(set.fitted).toBe(2)
      expect(set.mesh.visible).toBe(true)
    }
    expect(DISC_SCALE).toBeGreaterThan(1)
  })

  it('leave out what is not a galaxy, and a galaxy with no ring has no disc', () => {
    const set = make()
    // Node 2 is no galaxy; node 3 has no ring.
    fit(set, [ring(2, 100), ring(0, 12)])
    expect(set.radius[0]).toBeCloseTo(12 * DISC_SCALE, 4)
    expect(set.radius[1]).toBe(0)
    expect(set.fitted).toBe(1)
    // Nothing at all: nothing is drawn.
    fit(set, [])
    expect([...set.radius.slice(0, 2)]).toEqual([0, 0])
    expect(set.fitted).toBe(0)
    expect(set.mesh.visible).toBe(false)
  })

  it('start again from nothing at every fit: a ring that went away takes its disc with it', () => {
    const set = make()
    fit(set, [ring(0, 20), ring(3, 9)])
    expect(set.fitted).toBe(2)
    fit(set, [ring(0, 20)])
    expect(set.radius[1]).toBe(0)
    expect(set.fitted).toBe(1)
  })

  it('never turn a bad ring into a disc the size of the sky', () => {
    const set = make()
    fit(set, [ring(0, Number.NaN), ring(0, -5), ring(0, Number.POSITIVE_INFINITY), ring(3, 4, [Number.NaN, 0, 0, 1]), ring(7, 50), ring(-1, 50)])
    expect(set.fitted).toBe(0)
    for (let s = 0; s < 2; s++) expect(set.radius[s]).toBe(0)
  })

  it('follow their galaxy: centred on its place, in its plane, as wide as the disc', () => {
    const set = make()
    // A ring tipped a quarter turn about X: the disc's up (+Y) must become +Z.
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2)
    fit(set, [ring(0, 10, [q.x, q.y, q.z, q.w]), ring(3, 5)])
    const pos = new Float32Array(18)
    pos.set([100, 20, -30], 0)
    pos.set([-8, 4, 12], 9)
    placeDiscs(set, pos)
    const m = new Matrix4()
    set.mesh.getMatrixAt(0, m)
    const p = new Vector3()
    const rot = new Quaternion()
    const scale = new Vector3()
    m.decompose(p, rot, scale)
    expect(p.toArray()).toEqual([100, 20, -30])
    expect(scale.x).toBeCloseTo(10 * DISC_SCALE, 4)
    expect(new Vector3(0, 1, 0).applyQuaternion(rot).z).toBeCloseTo(1, 4)
    set.mesh.getMatrixAt(1, m)
    m.decompose(p, rot, scale)
    expect(p.toArray()).toEqual([-8, 4, 12])
    expect(scale.x).toBeCloseTo(5 * DISC_SCALE, 4)
    // And it moves with the galaxy.
    pos.set([1, 2, 3], 0)
    placeDiscs(set, pos)
    set.mesh.getMatrixAt(0, m)
    expect(m.elements[12]).toBe(1)
    expect(m.elements[13]).toBe(2)
    expect(m.elements[14]).toBe(3)
  })

  it('are a point where they have no size, and finite everywhere', () => {
    const set = make()
    placeDiscs(set, new Float32Array(18))
    for (const v of set.mesh.instanceMatrix.array) expect(Number.isFinite(v)).toBe(true)
    const m = new Matrix4()
    set.mesh.getMatrixAt(0, m)
    expect(new Vector3().setFromMatrixScale(m).x).toBe(0)
  })

  it('are a faint plate that adds light and keeps out of the bloom: even three stacked ones stay under its threshold of 1', () => {
    const set = make()
    const material = set.mesh.material as { blending: number; depthWrite: boolean; transparent: boolean; side: number }
    expect(material.blending).toBe(AdditiveBlending)
    expect(material.transparent).toBe(true)
    expect(material.depthWrite).toBe(false)
    expect(material.side).toBe(DoubleSide)
    // The brightest the plate gets is its base and an arm together (or its core's haze): well under what a star's halo adds.
    expect(DISC_BASE + DISC_ARM).toBeGreaterThan(0)
    expect(3 * (DISC_BASE + DISC_ARM + DISC_CORE)).toBeLessThan(1)
    expect(set.mesh.renderOrder).toBeLessThan(0)
  })

  it('has the scene draw them: one primitive, fitted when the rings change, placed with the rings, freed with the buffers', () => {
    const scene = readFileSync(fileURLToPath(new URL('../src/scene/BrainScene.tsx', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
    expect(scene).toContain('<primitive object={buffers.discs.mesh} />')
    expect(scene).toContain('fitDiscs(buffers.discs, buffers.ringParent,')
    expect(scene).toContain('placeDiscs(buffers.discs, dp)')
    expect(scene).toContain('discs.dispose()')
    // Every galaxy (a drive, a one-folder vault, a folder you marked) and nothing else.
    expect(scene).toContain('graph.nodes.forEach((n, i) => isGalaxyNode(n) && galaxies.push(i))')
  })
})
