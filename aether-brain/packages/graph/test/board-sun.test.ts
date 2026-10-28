import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assetMap, buildGraph, homeKey, imageKey, isPlanetNode, parseNote, type GraphData, type GraphNode, type NoteId, type ParsedNote } from '@aether/core'
import { computeSystemLayout, systemPositions, type SystemInput } from '../src/layout/system'
import type { LayoutNodeInput, MainToWorker } from '../src/layout/protocol'
import { BOARD_SUN_COLOR, STAR_COLOR, SUN_COLOR, TODAY_COLOR, nodeBaseColor, nodeRadius, type ColorMode } from '../src/theme'

/**
 * A reference board with pictures on it is a sun (docs/COSMOLOGY.md): the graph makes its pictures orbit it, the layout
 * (through the real LayoutEngine input) puts them on rings around it, and the scene draws it as a bright, big star.
 */

class FakeWorker {
  static last: FakeWorker | null = null
  sent: MainToWorker[] = []
  onmessage: unknown = null
  onerror: unknown = null
  onmessageerror: unknown = null
  constructor() {
    FakeWorker.last = this
  }
  postMessage(msg: MainToWorker): void {
    this.sent.push(msg)
  }
  terminate(): void {}
}

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const board = (title: string, pictures: string[]): string =>
  ['---', `title: ${title}`, 'type: board', '---', `# ${title}`, '', '## Board', '', ...pictures.map((p, i) => `- pic ${p} x=${i * 10} y=0 w=100 h=100`), ''].join('\n')

function notesOf(files: Record<string, string>): Map<NoteId, ParsedNote> {
  const m = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    m.set(n.meta.id, n)
  }
  return m
}

/** A vault with a Boards folder, a board with `count` pictures that lie in an Art folder, and a few pictures on no board. */
function vaultWith(count: number): { graph: GraphData; pictures: string[] } {
  const pictures = Array.from({ length: count }, (_, i) => `Art/p${String(i).padStart(2, '0')}.png`)
  const assets = assetMap([...pictures, 'Art/free1.png', 'Art/free2.png'].map((path, i) => ({ path, mtime: 100 - i, size: 300_000 })))
  const graph = buildGraph(notesOf({ 'Boards/PORTALz.md': board('PORTALz', pictures), 'Art/Note.md': '# Note\n', 'Boards/Other.md': '# Other\n' }), {
    images: { all: assets, moons: true, maxPerFolder: 24 },
    folders: { all: new Set(['Art', 'Boards']), rootTitle: 'Vault', multiRoot: false, maxDepth: 3 },
  })
  return { graph, pictures }
}

/** What the layout worker is sent for `graph` (the real LayoutEngine mapping), as the arrays it lays out. */
async function layoutInputOf(graph: GraphData): Promise<{ input: SystemInput; nodes: LayoutNodeInput[] }> {
  const { LayoutEngine } = await import('../src/layout/LayoutEngine')
  const engine = new LayoutEngine()
  engine.setGraph(graph, 'system')
  const msg = FakeWorker.last!.sent.find((m) => m.type === 'graph')
  if (!msg || msg.type !== 'graph') throw new Error('the engine sent no graph')
  const nodes = msg.nodes
  const n = nodes.length
  const input: SystemInput = {
    parent: Int32Array.from(nodes.map((d) => d.parent)),
    kind: Uint8Array.from(nodes.map((d) => d.kind)),
    role: Int8Array.from(nodes.map((d) => d.role)),
    radius: Float32Array.from(nodes.map((d) => d.radius)),
    ids: nodes.map((d) => d.id),
    urgency: Float32Array.from(nodes.map((d) => d.urgency ?? 0)),
    planet: Uint8Array.from(nodes.map((d) => (d.planet ? 1 : 0))),
  }
  expect(input.parent.length).toBe(n)
  return { input, nodes }
}

const nodeOf = (g: GraphData, id: string): GraphNode => g.nodes[g.index.get(id) ?? -1]!

describe('a board sun in the scene’s terms', () => {
  it('is drawn bigger as it holds more pictures, never above 9, and a board with none is a plain note', () => {
    const radius = (count: number): number => nodeRadius(nodeOf(vaultWith(count).graph, 'Boards/PORTALz'))
    const few = radius(2)
    const some = radius(13)
    const many = radius(200)
    expect(few).toBeGreaterThan(4)
    expect(some).toBeGreaterThan(few)
    expect(many).toBeGreaterThan(some)
    expect(many).toBeLessThanOrEqual(9)
    expect(radius(400)).toBeLessThanOrEqual(9)
    // A board with no pictures is not a sun: a small note.
    const plain = nodeOf(vaultWith(3).graph, 'Boards/Other')
    expect(plain.board).toBeUndefined()
    expect(nodeRadius(plain)).toBeLessThan(2.5)
  })

  it('keeps its colour whatever the colour mode, and it is not the colour of a galaxy, a project star or the Today hub', () => {
    const sun = nodeOf(vaultWith(5).graph, 'Boards/PORTALz')
    const modes: ColorMode[] = ['area', 'type', 'tag', 'age']
    for (const mode of modes) {
      const c = nodeBaseColor(sun, mode, null, () => 0.5)
      expect(`#${c.getHexString()}`, mode).toBe(BOARD_SUN_COLOR)
    }
    expect(new Set([BOARD_SUN_COLOR, SUN_COLOR, STAR_COLOR, TODAY_COLOR]).size).toBe(4)
  })
})

describe('the pictures of a board orbit it in space', () => {
  it('lays the board out as a system: its pictures on rings around it, outside its own radius, none sharing a place', async () => {
    const { graph, pictures } = vaultWith(13)
    const { input, nodes } = await layoutInputOf(graph)
    const layout = computeSystemLayout(input)
    const sun = graph.index.get('Boards/PORTALz')!
    // The mapping sent the board as the parent of every one of its pictures.
    for (const p of pictures) expect(nodes[graph.index.get(imageKey(p))!]!.parent, p).toBe(sun)
    // The layout agrees: those bodies' parent is the board, on an orbit clear of the sun's own body.
    const out = new Float32Array(graph.nodes.length * 3)
    systemPositions(layout, 0, out)
    const at = (i: number) => [out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!] as const
    const around = pictures.map((p) => graph.index.get(imageKey(p))!)
    for (const i of around) {
      expect(layout.parent[i]).toBe(sun)
      expect(layout.orbitRadius[i]!).toBeGreaterThan(nodeRadius(graph.nodes[sun]!) * 2)
      const [sx, sy, sz] = at(sun)
      const [x, y, z] = at(i)
      // Its distance from the sun is its orbit radius.
      expect(Math.hypot(x - sx, y - sy, z - sz)).toBeCloseTo(layout.orbitRadius[i]!, 2)
    }
    // No two pictures of the board overlap (each is at least its radius apart from the others).
    for (let a = 0; a < around.length; a++) {
      for (let b = a + 1; b < around.length; b++) {
        const [ax, ay, az] = at(around[a]!)
        const [bx, by, bz] = at(around[b]!)
        expect(Math.hypot(ax - bx, ay - by, az - bz), `${a}/${b}`).toBeGreaterThan(5.5)
      }
    }
    // The board is a system of its own, so its extent holds its pictures.
    expect(layout.extent[sun]!).toBeGreaterThan(Math.max(...around.map((i) => layout.orbitRadius[i]!)))
  })

  it('keeps the pictures that are on no board with their folder, not with the sun', async () => {
    const { graph } = vaultWith(4)
    const { input } = await layoutInputOf(graph)
    const layout = computeSystemLayout(input)
    const art = graph.index.get(folderId('Art'))!
    const free = graph.index.get(imageKey('Art/free1.png'))!
    // Files orbit moons: Art holds its pictures on its home moon.
    expect(layout.parent[free]).toBe(graph.index.get(homeKey('Art'))!)
    expect(layout.parent[graph.index.get(homeKey('Art'))!]).toBe(art)
    expect(isPlanetNode(graph.nodes[free]!)).toBe(true)
  })

  it('turns every picture of the board round the sun, each at the speed of its orbit', async () => {
    const { graph, pictures } = vaultWith(6)
    const { input } = await layoutInputOf(graph)
    const layout = computeSystemLayout(input)
    const sun = graph.index.get('Boards/PORTALz')!
    const a = new Float32Array(graph.nodes.length * 3)
    const b = new Float32Array(graph.nodes.length * 3)
    systemPositions(layout, 0, a)
    systemPositions(layout, 7, b)
    for (const p of pictures) {
      const i = graph.index.get(imageKey(p))!
      // After seven seconds it has moved, and it is still the same distance from the sun (it went round, not away).
      const moved = Math.hypot(a[i * 3]! - b[i * 3]!, a[i * 3 + 1]! - b[i * 3 + 1]!, a[i * 3 + 2]! - b[i * 3 + 2]!)
      expect(moved, p).toBeGreaterThan(0.1)
      const d0 = Math.hypot(a[i * 3]! - a[sun * 3]!, a[i * 3 + 1]! - a[sun * 3 + 1]!, a[i * 3 + 2]! - a[sun * 3 + 2]!)
      const d1 = Math.hypot(b[i * 3]! - b[sun * 3]!, b[i * 3 + 1]! - b[sun * 3 + 1]!, b[i * 3 + 2]! - b[sun * 3 + 2]!)
      expect(d1, p).toBeCloseTo(d0, 2)
    }
  })
})

function folderId(path: string): string {
  return `folder:${path}`
}
