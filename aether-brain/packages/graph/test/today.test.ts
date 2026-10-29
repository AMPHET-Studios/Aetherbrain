import { afterEach, describe, expect, it, vi } from 'vitest'
import { TODAY_ID, assetMap, buildGraph, dailyBrief, homeKey, imageKey, parseNote, type GraphData, type NoteId, type ParsedNote } from '@aether/core'
import { BrainController, type CameraLike } from '../src/BrainController'
import type { MainToWorker } from '../src/layout/protocol'
import { computeSystemLayout, systemPositions } from '../src/layout/system'
import { todayLabel } from '../src/scene/labels'
import { IMAGE_COLOR, TODAY_COLOR, cachedColor, nodeBaseColor, nodeRadius, type ColorMode } from '../src/theme'

const DATE = '2026-09-30'

function notesOf(files: Record<string, string>): Map<NoteId, ParsedNote> {
  const notes = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    notes.set(n.meta.id, n)
  }
  return notes
}

/** A system graph with the Today hub, an embedded picture and picture moons. */
function systemGraph(): GraphData {
  const notes = notesOf({
    'Projects/PORTALz.md': '---\ntype: project\n---\n# PORTALz\n\n![[gate.png]]\n\n- [ ] Paint the gate 📅 2026-09-30\n- [ ] Late sketch 📅 2026-09-20\n',
    'Inbox/Errand.md': '# Errand\n\n- [ ] Buy paper #today\n',
  })
  const folders = new Set(['Projects', 'Projects/PORTALz', 'Projects/PORTALz/Art', 'Inbox'])
  const assets = assetMap([
    { path: 'Projects/PORTALz/Art/gate.png', mtime: 3 },
    { path: 'Projects/PORTALz/Art/ruins.png', mtime: 2 },
  ])
  const brief = dailyBrief(notes.values(), { date: DATE, folders })
  return buildGraph(notes, {
    folders: { all: folders, rootTitle: 'Vault', multiRoot: false, maxDepth: 3 },
    images: { all: assets, moons: true },
    today: { brief },
  })
}

/** A fake camera that records the flights it is asked for. */
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Today hub and picture moons: theme', () => {
  it('colors the hub and pictures the same in every color mode, at fixed sizes', () => {
    const g = systemGraph()
    const hub = g.nodes[g.index.get(TODAY_ID)!]!
    const gate = g.nodes[g.index.get(imageKey('Projects/PORTALz/Art/gate.png'))!]!
    for (const mode of ['area', 'type', 'tag', 'age'] as ColorMode[]) {
      expect(nodeBaseColor(hub, mode, 'x', () => 0.5)).toBe(cachedColor(TODAY_COLOR))
      expect(nodeBaseColor(gate, mode, 'x', () => 0.5)).toBe(cachedColor(IMAGE_COLOR))
    }
    expect(TODAY_COLOR).toBe('#8ff7ff')
    expect(IMAGE_COLOR).toBe('#f4f1ff')
    expect(nodeRadius(hub)).toBe(4.6)
    expect(nodeRadius({ ...hub, degree: 400 })).toBe(4.6)
    expect(nodeRadius(gate)).toBe(1.4)
  })

  it('labels the hub with its count, a tick when clear, and what is late', () => {
    expect(todayLabel(0, 0)).toBe('☀ Today ✓')
    expect(todayLabel(5, 0)).toBe('☀ Today · 5')
    expect(todayLabel(5, 2)).toBe('☀ Today · 5 · 2 late')
  })
})

describe('Today hub and picture moons: controller', () => {
  it('bumps the version when the thumbnail loader or switch changes, only then', () => {
    const c = new BrainController()
    const v = c.version
    c.showThumbnails = true
    c.thumbnails = null
    expect(c.version).toBe(v)
    c.showThumbnails = false
    expect(c.showThumbnails).toBe(false)
    expect(c.version).toBe(v + 1)
    const loader = async () => null
    c.thumbnails = loader
    c.thumbnails = loader
    expect(c.thumbnails).toBe(loader)
    expect(c.version).toBe(v + 2)
    c.dispose()
  })

  it('flies to the hub from afar and close up to a picture', () => {
    const c = new BrainController()
    const g = systemGraph()
    c.setGraph(g)
    const cam = recorder()
    c.registerCamera(cam)
    expect(c.flyTo(TODAY_ID)).toBe(true)
    expect(c.flyTo(imageKey('Projects/PORTALz/Art/ruins.png'))).toBe(true)
    expect(cam.flights.map((f) => f[3])).toEqual([90, 26])
    c.dispose()
  })
})

describe('Today hub and picture moons: system layout through the engine', () => {
  it('hangs the hub above the galaxy and has pictures orbit their folder', async () => {
    const sent: MainToWorker[] = []
    vi.stubGlobal(
      'Worker',
      class {
        onmessage: unknown = null
        postMessage(msg: MainToWorker) {
          sent.push(msg)
        }
        terminate() {}
      },
    )
    const { LayoutEngine } = await import('../src/layout/LayoutEngine')
    const engine = new LayoutEngine()
    const g = systemGraph()
    engine.setGraph(g, 'system')
    const msg = sent.find((m) => m.type === 'graph')
    if (msg?.type !== 'graph') throw new Error('no graph message')
    const nodes = msg.nodes
    const hubI = g.index.get(TODAY_ID)!
    const rootI = g.index.get('folder:')!
    const artI = g.index.get('folder:Projects/PORTALz/Art')!
    const gateI = g.index.get(imageKey('Projects/PORTALz/Art/gate.png'))!
    expect(nodes[hubI]).toMatchObject({ kind: 3, parent: rootI, radius: 4.6 })
    // A picture orbits its folder's home moon (files orbit moons), which orbits the folder.
    const homeI = g.index.get(homeKey('Projects/PORTALz/Art'))!
    expect(nodes[gateI]).toMatchObject({ kind: 4, parent: homeI, radius: 1.4 })
    expect(nodes[homeI]!.parent).toBe(artI)

    const layout = computeSystemLayout({
      parent: Int32Array.from(nodes.map((n) => n.parent)),
      kind: Uint8Array.from(nodes.map((n) => n.kind)),
      role: Int8Array.from(nodes.map((n) => n.role)),
      radius: Float32Array.from(nodes.map((n) => n.radius)),
      ids: nodes.map((n) => n.id),
    })
    const pos = new Float32Array(nodes.length * 3)
    for (const t of [0, 12]) {
      systemPositions(layout, t, pos)
      expect(pos[hubI * 3]! - pos[rootI * 3]!).toBeCloseTo(0, 4)
      // Straight above the galaxy: its radius times the first ring factor, plus the lift.
      expect(nodes[rootI]!.radius).toBe(16)
      expect(pos[hubI * 3 + 1]! - pos[rootI * 3 + 1]!).toBeCloseTo(nodes[rootI]!.radius * 2.4 + 30, 4)
      expect(pos[hubI * 3 + 2]! - pos[rootI * 3 + 2]!).toBeCloseTo(0, 4)
      const d = Math.hypot(pos[gateI * 3]! - pos[homeI * 3]!, pos[gateI * 3 + 1]! - pos[homeI * 3 + 1]!, pos[gateI * 3 + 2]! - pos[homeI * 3 + 2]!)
      expect(d).toBeCloseTo(layout.orbitRadius[gateI]!, 3)
    }
    expect(layout.speed[gateI]).not.toBe(0)
    engine.dispose()
  })
})
