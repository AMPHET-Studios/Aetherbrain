import { describe, expect, it } from 'vitest'
import { buildGraph, parseNote, type GraphData, type NoteId, type ParsedNote } from '@aether/core'
import { COMPANION_BUDGET, boundRings, gatherPositions, planBase, planFor, type SceneBudget } from '../src/renderer/companion-bound'
import { companionScene } from '../src/renderer/companion-scene'

const OPTS = { version: 1, vault: 'Vault', layout: 'system', colorMode: 'area', activeTag: null, selectedId: null } as const

interface Shape {
  /** Top-level areas, subfolders per area, topic folders per subfolder, notes per topic folder. */
  areas: number
  subs: number
  topics: number
  notes: number
  /** One in this many notes links to a note that does not exist yet (a ghost). */
  ghostEvery?: number
  projects?: number
}

/** A vault of `areas × subs × topics × notes` notes, each linking to the next, some to a ghost; and some project stars. */
function vaultOf(s: Shape): { graph: GraphData; folders: string[] } {
  const notes = new Map<NoteId, ParsedNote>()
  const folders = new Set<string>()
  let k = 0
  const add = (path: string, content: string): void => {
    const n = parseNote({ path, content, mtime: 1_700_000_000_000 + k })
    notes.set(n.meta.id, n)
  }
  for (let a = 0; a < s.areas; a++) {
    for (let b = 0; b < s.subs; b++) {
      for (let c = 0; c < s.topics; c++) {
        const dir = `Area${a}/Sub${b}/Topic${c}`
        folders.add(`Area${a}`).add(`Area${a}/Sub${b}`).add(dir)
        for (let i = 0; i < s.notes; i++, k++) {
          const next = `Note ${k + 1}`
          const ghost = s.ghostEvery && k % s.ghostEvery === 0 ? `\n[[Todo ${k}]]` : ''
          add(`${dir}/Note ${k}.md`, `# Note ${k}\n\n[[${next}]]${ghost}\n`)
        }
      }
    }
  }
  for (let p = 0; p < (s.projects ?? 0); p++) {
    folders.add('Projects').add(`Projects/P${p}`)
    add(`Projects/P${p}.md`, `---\nstatus: active\n---\n# P${p}\n\n[[Note ${p}]]\n`)
    for (let t = 0; t < 5; t++) add(`Projects/P${p}/Task ${t}.md`, `# Task ${p}-${t}\n\n[[P${p}]]\n`)
  }
  const graph = buildGraph(notes, { folders: { multiRoot: false, all: [...folders], rootTitle: 'Vault', maxDepth: 3, maxFolders: 0 } })
  return { graph, folders: [...folders] }
}

/** A small budget, so a few thousand notes need cutting. */
const SMALL: SceneBudget = {
  nodes: 300,
  stars: 4,
  planets: 60,
  moons: 160,
  perFolderMoons: 4,
  guaranteedMoons: 1,
  ghosts: 12,
  pictures: 10,
  perFolderPictures: 1,
  links: 200,
  rings: 20,
  beams: 5,
}

const idsOf = (g: GraphData, keep: Int32Array): string[] => Array.from(keep, (i) => g.nodes[i]!.id)

describe('which part of a big brain the viewer is sent', () => {
  const { graph } = vaultOf({ areas: 6, subs: 5, topics: 8, notes: 14, ghostEvery: 5, projects: 8 })
  const base = planBase(graph, SMALL)
  const plan = planFor(graph, base, null, SMALL)

  it('cuts a graph far over the budget down to it, with every sun kept', () => {
    expect(graph.nodes.length).toBeGreaterThan(1500)
    // A single kept node pulls in its folder chain, so the cap can be passed by that much, not more.
    expect(plan.keep.length).toBeLessThanOrEqual(SMALL.nodes + 16)
    expect(plan.keep.length).toBeGreaterThan(SMALL.nodes * 0.5)
    const kinds = new Map<string, number>()
    for (const i of plan.keep) kinds.set(graph.nodes[i]!.kind, (kinds.get(graph.nodes[i]!.kind) ?? 0) + 1)
    const roots = graph.nodes.filter((n) => n.folder?.role === 'root' || n.folder?.role === 'mount')
    expect(roots.length).toBeGreaterThan(0)
    for (const r of roots) expect(plan.newIndex[graph.index.get(r.id)!]).toBeGreaterThanOrEqual(0)
    // Notes were cut, folders mostly kept.
    expect(kinds.get('note') ?? 0).toBeLessThan(graph.nodes.filter((n) => n.kind === 'note').length)
  })

  it('keeps every kept node under the parent it orbits in the brain, and numbers things from zero without a gap', () => {
    const scene = companionScene(graph, OPTS, plan)
    const ids = scene.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    scene.nodes.forEach((n, k) => {
      const orig = graph.nodes[plan.keep[k]!]!
      expect(n.id).toBe(orig.id)
      if (orig.parent === null) expect(n.parent).toBe(-1)
      else {
        expect(n.parent).toBeGreaterThanOrEqual(0)
        expect(n.parent).toBeLessThan(scene.nodes.length)
        expect(scene.nodes[n.parent]!.id).toBe(orig.parent)
      }
    })
    // The brain's own order is kept.
    const pos = ids.map((id) => graph.index.get(id)!)
    expect([...pos].sort((a, b) => a - b)).toEqual(pos)
  })

  it('sends only links between kept nodes, as pairs, at most the budget', () => {
    const scene = companionScene(graph, OPTS, plan)
    expect(scene.edges.length % 2).toBe(0)
    expect(scene.edges.length / 2).toBeLessThanOrEqual(SMALL.links)
    expect(scene.edges.length).toBeGreaterThan(0)
    for (let k = 0; k < scene.edges.length; k += 2) {
      const a = scene.nodes[scene.edges[k]!]!
      const b = scene.nodes[scene.edges[k + 1]!]!
      expect(a).toBeTruthy()
      expect(b).toBeTruthy()
      const linked = graph.edges.some((e) => e.from === a.id && e.to === b.id)
      expect(linked).toBe(true)
    }
  })

  it('says how much of the brain it is', () => {
    const scene = companionScene(graph, OPTS, plan)
    expect(scene.limits).toEqual({ nodes: scene.nodes.length, ofNodes: graph.nodes.length, links: scene.edges.length / 2, ofLinks: graph.edges.length })
    expect(scene.limits!.nodes).toBeLessThan(scene.limits!.ofNodes)
  })

  it('always shows the selected note, with the chain of folders it sits in, and nothing else is displaced', () => {
    const dropped = graph.nodes.findIndex((n, i) => n.kind === 'note' && plan.newIndex[i]! < 0)
    expect(dropped).toBeGreaterThanOrEqual(0)
    const id = graph.nodes[dropped]!.id
    const sel = planFor(graph, base, id, SMALL)
    const scene = companionScene(graph, { ...OPTS, selectedId: id }, sel)
    expect(scene.selected).toBeGreaterThanOrEqual(0)
    expect(scene.nodes[scene.selected]!.id).toBe(id)
    // Only the note and the folders above it that were not shown yet came on top.
    expect(sel.keep.length).toBeGreaterThan(plan.keep.length)
    expect(sel.keep.length - plan.keep.length).toBeLessThanOrEqual(6)
    for (const i of plan.keep) expect(sel.newIndex[i]).toBeGreaterThanOrEqual(0)
    // A selection that is not in the brain selects nothing.
    expect(companionScene(graph, OPTS, planFor(graph, base, 'Nope', SMALL)).selected).toBe(-1)
  })

  it('shows the same nodes after an edit that changes nobody’s links (the viewer must not rebuild for it)', () => {
    const before = idsOf(graph, plan.keep)
    const again = vaultOf({ areas: 6, subs: 5, topics: 8, notes: 14, ghostEvery: 5, projects: 8 }).graph
    const p2 = planFor(again, planBase(again, SMALL), null, SMALL)
    expect(idsOf(again, p2.keep)).toEqual(before)
  })

  it('gathers the kept nodes’ places in the new order', () => {
    const all = new Float32Array(graph.nodes.length * 3)
    graph.nodes.forEach((_, i) => {
      all[i * 3] = i
      all[i * 3 + 1] = i + 0.25
      all[i * 3 + 2] = -i
    })
    const out = gatherPositions(plan, all)
    expect(out.length).toBe(plan.keep.length * 3)
    plan.keep.forEach((orig, k) => {
      expect([out[k * 3], out[k * 3 + 1], out[k * 3 + 2]]).toEqual([orig, orig + 0.25, -orig])
    })
    // Reuses a buffer of the right size.
    const reuse = new Float32Array(out.length)
    expect(gatherPositions(plan, all, reuse)).toBe(reuse)
  })
})

describe('a brain that fits', () => {
  it('is sent whole, as before, apart from the note about how much it is', () => {
    const { graph } = vaultOf({ areas: 2, subs: 2, topics: 2, notes: 3, projects: 1 })
    const plan = planFor(graph, planBase(graph))
    expect(plan.keep.length).toBe(graph.nodes.length)
    const whole = companionScene(graph, OPTS)
    const cut = companionScene(graph, OPTS, plan)
    expect(cut.nodes).toEqual(whole.nodes)
    expect([...cut.edges].sort()).toEqual([...whole.edges].sort())
    expect(cut.limits).toEqual({ nodes: graph.nodes.length, ofNodes: graph.nodes.length, links: whole.edges.length / 2, ofLinks: graph.edges.length })
  })
})

describe('the default budget on a big vault', () => {
  it('keeps the scene small enough for the viewer: nodes, links and the JSON', { timeout: 120_000 }, () => {
    // Building 30,000 notes takes most of the time; the cut itself is what is timed.
    const { graph } = vaultOf({ areas: 10, subs: 10, topics: 10, notes: 30, ghostEvery: 4, projects: 20 })
    expect(graph.nodes.length).toBeGreaterThan(30_000)
    const t0 = Date.now()
    const plan = planFor(graph, planBase(graph), null)
    const scene = companionScene(graph, OPTS, plan)
    const ms = Date.now() - t0
    expect(scene.nodes.length).toBeLessThanOrEqual(COMPANION_BUDGET.nodes + 64)
    expect(scene.nodes.length).toBeGreaterThan(COMPANION_BUDGET.nodes * 0.5)
    expect(scene.edges.length / 2).toBeLessThanOrEqual(COMPANION_BUDGET.links)
    expect(JSON.stringify(scene).length).toBeLessThan(4_000_000)
    expect(ms).toBeLessThan(8000)
  })
})

describe('the orbit rings the viewer is sent', () => {
  const { graph } = vaultOf({ areas: 3, subs: 3, topics: 3, notes: 5, projects: 2 })
  const plan = planFor(graph, planBase(graph, { ...SMALL, nodes: 400, perFolderMoons: 24 }), null, SMALL)

  /**
   * One ring per kept parent, on which its kept children sit (every body is exactly its ring's radius from its parent);
   * plus an empty ring of the same parent, and a ring of a parent that is not kept.
   */
  function ringsFor(): { rings: Float32Array; positions: Float32Array } {
    const positions = new Float32Array(graph.nodes.length * 3)
    const rings: number[] = []
    const kids = new Map<number, number[]>()
    const roots: number[] = []
    for (const i of plan.keep) {
      const p = plan.parent[i]!
      if (p < 0) roots.push(i)
      else kids.set(p, [...(kids.get(p) ?? []), i])
    }
    const place = (p: number, x: number, y: number, z: number): void => {
      positions[p * 3] = x
      positions[p * 3 + 1] = y
      positions[p * 3 + 2] = z
      const list = kids.get(p)
      if (!list) return
      const radius = 10 + (p % 7)
      rings.push(p, radius, 0, 0, 0, 1)
      // A ring no kept body sits on: it must not be sent.
      rings.push(p, radius + 57, 0, 0, 0, 1)
      list.forEach((c, j) => {
        const t = (j / list.length) * Math.PI * 2
        place(c, x + radius * Math.cos(t), y, z + radius * Math.sin(t))
      })
    }
    roots.forEach((r, j) => place(r, j * 1000, 0, 0))
    const dropped = graph.nodes.findIndex((_, i) => plan.newIndex[i]! < 0)
    rings.push(dropped, 9, 0, 0, 0, 1)
    return { rings: new Float32Array(rings), positions }
  }

  it('are those of kept parents with a kept body on them, renumbered, best first, at most the cap', () => {
    const { rings, positions } = ringsFor()
    const all = boundRings(graph, plan, rings, positions, 1000)
    expect(all.length % 6).toBe(0)
    const parents = new Set(Array.from({ length: all.length / 6 }, (_, k) => all[k * 6]!))
    const kidsOf = new Set<number>()
    for (const i of plan.keep) if (plan.parent[i]! >= 0) kidsOf.add(plan.newIndex[plan.parent[i]!]!)
    // Exactly the parents with kept children, one ring each (the empty rings and the dropped parent's are gone).
    expect(parents).toEqual(kidsOf)
    expect(all.length / 6).toBe(kidsOf.size)
    for (let k = 0; k < all.length / 6; k++) {
      expect(all[k * 6]).toBeLessThan(plan.keep.length)
      expect(all[k * 6 + 5]).toBe(1)
    }
    // Suns and stars first.
    const first = graph.nodes[plan.keep[all[0]!]!]!
    expect(first.folder?.role === 'root' || first.folder?.role === 'mount').toBe(true)
    const few = boundRings(graph, plan, rings, positions, 3)
    expect(few.length).toBe(18)
    expect(Array.from(few)).toEqual(Array.from(all.slice(0, 18)))
    expect(boundRings(graph, plan, rings, positions, 0).length).toBe(0)
    expect(boundRings(graph, plan, new Float32Array(0), positions, 10).length).toBe(0)
  })

  it('ignores a parent index that is not a node', () => {
    const { positions } = ringsFor()
    const junk = new Float32Array([1e9, 5, 0, 0, 0, 1, -3, 5, 0, 0, 0, 1, 2.5, 5, 0, 0, 0, 1])
    expect(boundRings(graph, plan, junk, positions, 10).length).toBe(0)
  })
})
