import { describe, expect, it } from 'vitest'
import { buildGraph, parseNote, type GraphData, type NoteId, type ParsedNote } from '@aether/core'
import { BrainController, DEFAULT_FAR, DEFAULT_MAX_DISTANCE, cameraRange, type CameraLike } from '../src/BrainController'
import { computeSystemLayout, systemPositions } from '../src/layout/system'
import { nodeRadius } from '../src/theme'

const ROLE = { root: 0, mount: 1, project: 2, folder: 3 } as const

/** System-layout positions of a graph, as the worker computes them (t = 0). */
function systemLayoutOf(g: GraphData): Float32Array {
  const n = g.nodes.length
  const parent = new Int32Array(n)
  const kind = new Uint8Array(n)
  const role = new Int8Array(n)
  const radius = new Float32Array(n)
  g.nodes.forEach((node, i) => {
    parent[i] = node.parent === null ? -1 : (g.index.get(node.parent) ?? -1)
    kind[i] = node.kind === 'note' ? 0 : node.kind === 'ghost' ? 1 : 2
    role[i] = node.folder ? ROLE[node.folder.role] : -1
    radius[i] = nodeRadius(node)
  })
  const layout = computeSystemLayout({ parent, kind, role, radius, ids: g.nodes.map((x) => x.id) })
  const pos = new Float32Array(n * 3)
  systemPositions(layout, 0, pos)
  return pos
}

/** A fake camera that records what the controller asks of it. */
function recorder(): CameraLike & { ranges: number[]; flights: number[][] } {
  const ranges: number[] = []
  const flights: number[][] = []
  return {
    ranges,
    flights,
    setRange: (d) => void ranges.push(d),
    flyTo: (x, y, z, d) => void flights.push([x, y, z, d]),
    reset() {},
    orbit() {},
    dolly() {},
    truck() {},
    setEnabled() {},
    setShift() {},
  }
}

describe('camera range', () => {
  it('never goes below the defaults', () => {
    expect(cameraRange(100)).toEqual({ far: DEFAULT_FAR, maxDistance: DEFAULT_MAX_DISTANCE })
    expect(cameraRange(Number.NaN)).toEqual({ far: DEFAULT_FAR, maxDistance: DEFAULT_MAX_DISTANCE })
    expect(cameraRange(20_000)).toEqual({ far: 80_000, maxDistance: 40_000 })
  })

  it('fits a deep drive system inside the far plane and the dolly limit', () => {
    // A project star 14 folders down a drive: the star is pinned with its whole
    // chain, and every level at least doubles the size of the system.
    const chain = Array.from({ length: 13 }, (_, i) => `f${i}`).join('/')
    const notes = new Map<NoteId, ParsedNote>()
    for (const [path, content] of [
      [`D/${chain}/Deep/Deep.md`, '---\ntype: project\n---\n# Deep\n'],
      [`D/${chain}/Deep/Art/Sketch.md`, '# Sketch\n'],
      ['F/Notes/Idea.md', '# Idea\n'],
    ] as const) {
      const n = parseNote({ path, content })
      notes.set(n.meta.id, n)
    }
    const g = buildGraph(notes, { folders: { all: ['D', 'F', `D/${chain}/Deep/Art`], rootTitle: 'Drives', multiRoot: true, maxDepth: 3 } })
    const pos = systemLayoutOf(g)

    const controller = new BrainController()
    controller.layoutMode = 'system'
    controller.engine.positions = pos
    const cam = recorder()
    controller.registerCamera(cam)
    expect(controller.fitToGraph(false)).toBe(true)
    const [cx = 0, cy = 0, cz = 0, distance = 0] = cam.flights[0] ?? []
    expect(cam.ranges).toEqual([distance])

    // Farthest node from the framed centre: from any view direction the camera
    // is at most `distance + far` away from it.
    let reach = 0
    for (let i = 0; i < pos.length / 3; i++) {
      reach = Math.max(reach, Math.hypot((pos[i * 3] ?? 0) - cx, (pos[i * 3 + 1] ?? 0) - cy, (pos[i * 3 + 2] ?? 0) - cz))
    }
    // The fixed far plane (12000) could not see this system at all.
    expect(distance + reach).toBeGreaterThan(DEFAULT_FAR)
    const range = cameraRange(distance)
    expect(distance + reach).toBeLessThan(range.far)
    // The first wheel tick must not snap the camera back in.
    expect(range.maxDistance).toBeGreaterThan(distance)
    controller.dispose()
  })
})
