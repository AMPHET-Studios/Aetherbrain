import { describe, expect, it } from 'vitest'
import { buildGraph, folderKey, parseNote, type GraphData, type NoteId, type ParsedNote } from '@aether/core'
import { BrainController, type CameraLike } from '../src/BrainController'
import { nodeRadius } from '../src/theme'

/**
 * Suns open into planets, then moons: the controller holds how open each sun is (the 3D scene reads it every frame and keeps a
 * reveal per body), and flying to a sun frames it at a distance that suits the star itself.
 */

describe('how open each sun is', () => {
  it('starts with every sun closed and the levels on', () => {
    const c = new BrainController()
    expect(c.suns).toBe(true)
    expect(c.sunDefaultLevel).toBe(0)
    expect(c.sunLevel('folder:A')).toBe(0)
    expect(c.sunLevelsOwn.size).toBe(0)
    expect(c.sunVersion).toBe(0)
    c.dispose()
  })

  it('opens one sun without touching the others, and tells the scene (the version moves)', () => {
    const c = new BrainController()
    const v = c.version
    c.setSunLevel('folder:A', 2)
    expect(c.sunLevel('folder:A')).toBe(2)
    expect(c.sunLevel('folder:B')).toBe(0)
    expect(c.sunVersion).toBe(1)
    expect(c.version).toBeGreaterThan(v)
    expect([...c.sunLevelsOwn]).toEqual([['folder:A', 2]])
    c.dispose()
  })

  it('says nothing when a sun is already at that level', () => {
    const c = new BrainController()
    c.setSunLevel('folder:A', 1)
    const version = c.version
    c.setSunLevel('folder:A', 1)
    c.setSunLevel('folder:B', 0)
    expect(c.sunVersion).toBe(1)
    expect(c.version).toBe(version)
    c.dispose()
  })

  it('keeps no entry of its own for a sun that is back at the default', () => {
    const c = new BrainController()
    c.setSunLevel('folder:A', 1)
    c.setSunLevel('folder:A', 0)
    expect(c.sunLevelsOwn.size).toBe(0)
    expect(c.sunLevel('folder:A')).toBe(0)
    c.dispose()
  })

  it('replaces every level at once: a new default and the suns that differ from it', () => {
    const c = new BrainController()
    c.setSunLevel('folder:Old', 2)
    c.setSunLevels(2, new Map([['folder:A', 0], ['folder:B', 2], ['folder:C', 1]]))
    expect(c.sunDefaultLevel).toBe(2)
    expect(c.sunLevel('folder:Old')).toBe(2)
    expect(c.sunLevel('folder:A')).toBe(0)
    expect(c.sunLevel('folder:C')).toBe(1)
    // B is the default's level: nothing of its own to keep.
    expect([...c.sunLevelsOwn.keys()].sort()).toEqual(['folder:A', 'folder:C'])
    c.setSunLevels(0)
    expect(c.sunLevel('folder:A')).toBe(0)
    expect(c.sunLevel('folder:C')).toBe(0)
    expect(c.sunLevelsOwn.size).toBe(0)
    c.dispose()
  })

  it('opens or closes every sun at once with a new default, whatever each one was before', () => {
    const c = new BrainController()
    c.setSunLevel('folder:A', 1)
    c.setSunLevels(2, null)
    expect(c.sunLevel('folder:A')).toBe(2)
    expect(c.sunLevel('folder:Z')).toBe(2)
    c.dispose()
  })

  it('switches the levels off and on, telling the scene only when it changes', () => {
    const c = new BrainController()
    c.setSuns(true)
    expect(c.sunVersion).toBe(0)
    c.setSuns(false)
    expect(c.suns).toBe(false)
    expect(c.sunVersion).toBe(1)
    c.setSuns(false)
    expect(c.sunVersion).toBe(1)
    c.setSuns(true)
    expect(c.sunVersion).toBe(2)
    c.dispose()
  })
})

describe('flying to a sun', () => {
  /** A fake camera that records the flights asked of it. */
  function recorder(): CameraLike & { flights: number[][] } {
    const flights: number[][] = []
    return {
      flights,
      setRange() {},
      flyTo: (x, y, z, d) => void flights.push([x, y, z, d]),
      reset() {},
      orbit() {},
      dolly() {},
      truck() {},
      setEnabled() {},
      setShift() {},
    }
  }

  function graphOf(files: Record<string, string>, folders: string[], bio?: string): GraphData {
    const notes = new Map<NoteId, ParsedNote>()
    for (const [path, content] of Object.entries(files)) {
      const n = parseNote({ path, content })
      notes.set(n.meta.id, n)
    }
    return buildGraph(notes, { folders: { all: new Set(folders), rootTitle: 'Vault', multiRoot: false, maxDepth: 3, ...(bio ? { bio } : {}) } })
  }

  /** A controller on `g` with the star at the origin and its children `reach` away; everything else far off. */
  function placed(g: GraphData, star: string, reach: number) {
    const c = new BrainController()
    c.layoutMode = 'system'
    ;(c as unknown as { graph: GraphData }).graph = g
    const positions = new Float32Array(g.nodes.length * 3)
    g.nodes.forEach((n, i) => {
      positions[i * 3] = n.id === star ? 0 : n.parent === star ? reach : 9000 + i
    })
    c.engine.positions = positions
    c.engine.ids = g.nodes.map((n) => n.id)
    c.engine.index = new Map(g.nodes.map((n, i) => [n.id, i]))
    const cam = recorder()
    c.camera = cam
    return { c, cam }
  }

  const bioFiles = {
    'Bio/Sleep.md': '# Sleep\n',
    'Bio/Food.md': '# Food\n',
    'Bio/Meds.md': '# Meds\n',
    'Bio/Exercise.md': '# Exercise\n',
    'Bio/Drugs.md': '# Drugs\n',
    'Bio/Mental.md': '# Mental\n',
  }

  it('stays at least 13 star radii away from a big star with a small system: the Bio star never fills the view', () => {
    const g = graphOf(bioFiles, ['Bio'], 'Bio')
    const star = g.nodes.find((n) => n.folder?.bio)!
    const r = nodeRadius(star)
    const { c, cam } = placed(g, star.id, 20)
    expect(c.flyTo(star.id)).toBe(true)
    // Its moons are 20 away, so framing them alone would put the camera at about 2.3 × 25: the star itself would fill the view.
    expect(cam.flights[0]![3]).toBeCloseTo(r * 13, 5)
    expect(cam.flights[0]![3]).toBeGreaterThan(20 * 2.3 * 2)
    c.dispose()
  })

  it('frames a star with a big system by its system, as before', () => {
    const g = graphOf({ 'Work/A.md': '# A\n', 'Work/B.md': '# B\n' }, ['Work'])
    const star = g.nodes.find((n) => n.id === folderKey('Work'))!
    const { c, cam } = placed(g, star.id, 300)
    c.flyTo(star.id)
    const d = cam.flights[0]![3]!
    const moon = g.nodes.find((n) => n.id === 'Work/A')!
    expect(d).toBeCloseTo((300 + nodeRadius(moon) * 3) * 2.3, 3)
    expect(d).toBeGreaterThan(nodeRadius(star) * 13)
    c.dispose()
  })

  it('frames a star with nothing around it by its own size', () => {
    const g = graphOf({ 'Work/A.md': '# A\n' }, ['Work', 'Lonely'])
    const star = g.nodes.find((n) => n.id === folderKey('Lonely'))!
    const { c, cam } = placed(g, star.id, 50)
    c.flyTo(star.id)
    expect(cam.flights[0]![3]).toBeCloseTo(34 + nodeRadius(star) * 14, 5)
    c.dispose()
  })

  it('does nothing for a body it has no place for, or without a camera', () => {
    const g = graphOf({ 'Work/A.md': '# A\n' }, ['Work'])
    const { c } = placed(g, folderKey('Work'), 50)
    expect(c.flyTo('folder:Nowhere')).toBe(false)
    c.camera = null
    expect(c.flyTo(folderKey('Work'))).toBe(false)
    c.dispose()
  })
})
