import { describe, expect, it } from 'vitest'
import { assetMap, buildGraph, dailyBrief, parseNote, TODAY_ID, type GraphData, type NoteId, type ParsedNote } from '@aether/core'
import { COMPANION_BUDGET, boundRings, gatherPositions, planBase, planFor, type SceneBudget } from '../src/renderer/companion-bound'
import { companionScene, sceneSignature } from '../src/renderer/companion-scene'
import { vaultOf } from './fixtures/vault-shapes'

const OPTS = { version: 1, vault: 'Vault', layout: 'system', colorMode: 'area', activeTag: null, selectedId: null } as const

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
  // Bigger than the budget, so that the plan really drops folders and notes (and their rings must go with them).
  const { graph } = vaultOf({ areas: 4, subs: 4, topics: 4, notes: 8, projects: 2 })
  const plan = planFor(graph, planBase(graph, { ...SMALL, nodes: 400, perFolderMoons: 24 }), null, SMALL)
  it('start from a plan that really drops nodes', () => {
    expect(plan.keep.length).toBeLessThan(graph.nodes.length * 0.8)
    expect(graph.nodes.findIndex((n, i) => n.folder && plan.newIndex[i]! < 0)).toBeGreaterThanOrEqual(0)
  })

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
    const dropped = graph.nodes.findIndex((n, i) => n.folder && plan.newIndex[i]! < 0)
    expect(dropped).toBeGreaterThanOrEqual(0)
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

  it('still finds the ring a body is on when the places are single precision a long way from the origin', () => {
    const { rings, positions } = ringsFor()
    // The whole brain moved 300,000 units away: a float32 there is only good to 0.03.
    const far = new Float32Array(positions.length)
    for (let i = 0; i < positions.length; i += 3) {
      far[i] = positions[i]! + 300_000.3
      far[i + 1] = positions[i + 1]! - 300_000.7
      far[i + 2] = positions[i + 2]! + 12_345.1
    }
    const near = boundRings(graph, plan, rings, positions, 1000)
    const away = boundRings(graph, plan, rings, far, 1000)
    expect(away.length).toBe(near.length)
    expect(Array.from(away)).toEqual(Array.from(near))
  })

  it('is empty, not made up, for places that are not one for every node', () => {
    const { rings, positions } = ringsFor()
    expect(boundRings(graph, plan, rings, positions.slice(0, positions.length - 3), 1000).length).toBe(0)
    expect(gatherPositions(plan, positions.slice(0, positions.length - 3))).toBeNull()
    expect(gatherPositions(plan, positions)).not.toBeNull()
  })

  it('leaves out a ring that has no radius, and keeps the others', () => {
    const { rings, positions } = ringsFor()
    const good = boundRings(graph, plan, rings, positions, 1000)
    const bad = new Float32Array(rings.length + 6)
    bad.set(rings)
    bad.set([plan.keep.find((i) => plan.parent[i]! >= 0 && graph.nodes[plan.parent[i]!]!.folder)! >= 0 ? plan.parent[plan.keep.find((i) => plan.parent[i]! >= 0)!]! : 0, NaN, 0, 0, 0, 1], rings.length)
    const out = boundRings(graph, plan, bad, positions, 1000)
    expect(Array.from(out)).toEqual(Array.from(good))
  })

  it('sends a system whole before the next one starts when it has to stop short', () => {
    // Two planets of equal rank, each with three bodies on three rings: 10, 20, 30 and 11, 21, 31 from their planet.
    const folder = (role: 'root' | 'folder') => ({ role, notes: 3, totalNotes: 3, childFolders: 0, depth: 1 })
    const node = (id: string, parent: string | null, role?: 'root' | 'folder') => ({ id, parent, folder: role ? folder(role) : undefined })
    const nodes = [node('sun', null, 'root'), node('A', 'sun', 'folder'), node('B', 'sun', 'folder')]
    const parent = [-1, 0, 0]
    const positions: number[] = [0, 0, 0, 1000, 0, 0, -1000, 0, 0]
    const rings: number[] = []
    for (const [p, base, dx] of [[1, 10, 1000], [2, 11, -1000]] as const) {
      for (let k = 0; k < 3; k++) {
        const r = base + k * 10
        nodes.push(node(`${p}-${k}`, p === 1 ? 'A' : 'B'))
        parent.push(p)
        positions.push(dx + r, 0, 0)
        rings.push(p, r, 0, 0, 0, 1)
      }
    }
    const fake = { nodes } as unknown as GraphData
    const n = nodes.length
    const fakePlan = { n, ofNodes: n, keep: Int32Array.from({ length: n }, (_, i) => i), newIndex: Int32Array.from({ length: n }, (_, i) => i), parent: Int32Array.from(parent), edges: [], selected: -1, linksTotal: 0 }
    const out = boundRings(fake, fakePlan, new Float32Array(rings), new Float32Array(positions), 4)
    expect(out.length / 6).toBe(4)
    // All three of planet A (10, 20, 30), then the first of planet B (11): not 10, 11, 20, 21.
    expect(Array.from({ length: 4 }, (_, k) => [out[k * 6], out[k * 6 + 1]])).toEqual([[1, 10], [1, 20], [1, 30], [2, 11]])
  })

  it('ignores a parent index that is not a node', () => {
    const { positions } = ringsFor()
    const junk = new Float32Array([1e9, 5, 0, 0, 0, 1, -3, 5, 0, 0, 0, 1, 2.5, 5, 0, 0, 0, 1])
    expect(boundRings(graph, plan, junk, positions, 10).length).toBe(0)
  })
})

/** Notes from a path → content map. */
function notesOf(files: Record<string, string>): Map<NoteId, ParsedNote> {
  const m = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content, mtime: 1_700_000_000_000 })
    m.set(n.meta.id, n)
  }
  return m
}
const kindsOf = (g: GraphData, keep: Int32Array, kind: string): number => Array.from(keep).filter((i) => g.nodes[i]!.kind === kind).length

describe('what the budget leaves out, and what it must not', () => {
  it('keeps every note of a crowded folder while the vault is under the budget (the per-folder cap is a start, not a ceiling)', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 100; i++) files[`Big/Note ${i}.md`] = `# Note ${i}\n`
    for (let i = 0; i < 10; i++) files[`Small/Note ${i}.md`] = `# S${i}\n`
    const graph = buildGraph(notesOf(files), { folders: { multiRoot: false, all: ['Big', 'Small'], rootTitle: 'Vault', maxDepth: 3, maxFolders: 0 } })
    const plan = planFor(graph, planBase(graph))
    expect(plan.keep.length).toBe(graph.nodes.length)
    // A short moon budget is spent by importance, a crowded folder not taking more than its share first.
    const tight: SceneBudget = { ...COMPANION_BUDGET, moons: 30, perFolderMoons: 8 }
    const cut = planFor(graph, planBase(graph, tight), null, tight)
    expect(kindsOf(graph, cut.keep, 'note')).toBe(30)
    // Each folder gets its 8 first; what is left of the 30 goes to the best of the rest.
    const small = Array.from(cut.keep).filter((i) => graph.nodes[i]!.id.startsWith('Small/')).length
    const big = Array.from(cut.keep).filter((i) => graph.nodes[i]!.id.startsWith('Big/')).length
    expect(small).toBeGreaterThanOrEqual(8)
    expect(big).toBeGreaterThanOrEqual(8)
    expect(small + big).toBe(30)
    // Importance, not the cap, picks the rest: the notes with the most links.
    const linked = buildGraph(
      notesOf({ ...files, 'Big/Hub.md': '# Hub\n' + Array.from({ length: 12 }, (_, i) => `[[Note ${i + 50}]]`).join(' ') }),
      { folders: { multiRoot: false, all: ['Big', 'Small'], rootTitle: 'Vault', maxDepth: 3, maxFolders: 0 } },
    )
    const kept = planFor(linked, planBase(linked, tight), null, tight)
    const ids = new Set(Array.from(kept.keep, (i) => linked.nodes[i]!.id))
    for (let i = 50; i < 62; i++) expect(ids.has(`Big/Note ${i}`)).toBe(true)
  })

  it('cuts a layout without folders to the budget, quickly, whatever the number of notes', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 6000; i++) files[`n${i}.md`] = `# N${i}\n[[N${(i * 7 + 1) % 6000}]]\n`
    const graph = buildGraph(notesOf(files))
    expect(graph.nodes.every((n) => n.parent === null)).toBe(true)
    const t0 = Date.now()
    const base = planBase(graph, SMALL)
    const plan = planFor(graph, base, null, SMALL)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(kindsOf(graph, plan.keep, 'note')).toBe(SMALL.moons)
    // The best-linked notes are the ones kept.
    const min = Math.min(...Array.from(plan.keep, (i) => graph.nodes[i]!.degree))
    const dropped = graph.nodes.filter((_, i) => plan.newIndex[i]! < 0)
    expect(dropped.every((n) => n.degree <= min)).toBe(true)
    expect(plan.edges.length).toBeGreaterThan(0)
  })

  it('shows pictures that sit in folders of their own, with the folder they sit in', () => {
    const files: Record<string, string> = {}
    for (let f = 0; f < 40; f++) for (let i = 0; i < 3; i++) files[`Notes${f}/N${i}.md`] = `# N${f}-${i}\n`
    const pics = []
    for (let f = 0; f < 5; f++) for (let i = 0; i < 4; i++) pics.push({ path: `Art${f}/pic${i}.png`, mtime: 100 + f * 10 + i })
    const folders = [...Array.from({ length: 40 }, (_, f) => `Notes${f}`), ...Array.from({ length: 5 }, (_, f) => `Art${f}`)]
    const graph = buildGraph(notesOf(files), {
      images: { all: assetMap(pics), moons: true, maxPerFolder: 4 },
      folders: { multiRoot: false, all: folders, rootTitle: 'Vault', maxDepth: 3, maxFolders: 100 },
    })
    expect(graph.nodes.filter((n) => n.kind === 'image').length).toBe(20)
    const B: SceneBudget = { ...SMALL, planets: 12, nodes: 400, pictures: 6, perFolderPictures: 2 }
    const plan = planFor(graph, planBase(graph, B), null, B)
    const scene = companionScene(graph, OPTS, plan)
    const pictures = scene.nodes.filter((n) => n.kind === 'picture')
    // The budget of pictures is spent (two per folder), though none of their folders held a note.
    expect(pictures.length).toBe(6)
    for (const p of pictures) {
      const parent = scene.nodes[p.parent]
      expect(parent?.kind).toBe('planet')
      expect(parent?.id.startsWith('folder:Art')).toBe(true)
    }
    // The newest first.
    expect(pictures.map((p) => p.id).sort()).toContain('image:Art4/pic3.png')
  })

  it('keeps the hub’s beams, and the cards of an open gallery out of the count of what could be sent', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 600; i++) files[`n${i}.md`] = i % 100 === 7 ? `- [ ] do it #today\n# N${i}\n` : `# N${i}\n`
    const notes = notesOf(files)
    const brief = dailyBrief(notes.values(), { date: '2026-09-30' })
    const flat = buildGraph(notes, { today: { brief } })
    const hub = flat.index.get(TODAY_ID)!
    const targets = flat.edges.filter((e) => e.kind === 'today').map((e) => flat.index.get(e.to)!)
    expect(targets.length).toBe(6)
    const B: SceneBudget = { ...SMALL, moons: 20, beams: 6 }
    const plan = planFor(flat, planBase(flat, B), null, B)
    expect(plan.newIndex[hub]).toBeGreaterThanOrEqual(0)
    // No folders in this layout, and the hub still reaches the notes it points at.
    for (const t of targets) expect(plan.newIndex[t]).toBeGreaterThanOrEqual(0)
    const scene = companionScene(flat, OPTS, plan)
    const beams = []
    for (let k = 0; k < scene.edges.length; k += 2) if (scene.edges[k] === plan.newIndex[hub]) beams.push(scene.edges[k + 1])
    expect(beams.length).toBe(6)

    // A gallery open on a star: its far cards are the brain window's own, never sent, and not counted as cut.
    const assets = assetMap([
      { path: 'Projects/P/Art/a.png', mtime: 3 },
      { path: 'Projects/P/Art/Deep/Deeper/b.png', mtime: 2 },
      { path: 'Projects/P/Art/Deep/Deeper/c.png', mtime: 1 },
    ])
    const gal = buildGraph(notesOf({ 'Projects/P.md': '---\ntype: project\n---\n# P\n', 'Projects/P/Art/N.md': '# N\n' }), {
      images: { all: assets, moons: true, maxPerFolder: 1, gallery: 'Projects/P' },
      folders: { multiRoot: false, all: ['Projects', 'Projects/P', 'Projects/P/Art', 'Projects/P/Art/Deep', 'Projects/P/Art/Deep/Deeper'], rootTitle: 'Vault', maxDepth: 3, maxFolders: 0 },
    })
    const only = gal.nodes.filter((n) => n.image?.gallery?.only).length
    expect(only).toBeGreaterThan(0)
    const gp = planFor(gal, planBase(gal), null)
    expect(gp.keep.length).toBe(gal.nodes.length - only)
    expect(gp.ofNodes).toBe(gal.nodes.length - only)
    const gs = companionScene(gal, OPTS, gp)
    expect(gs.limits!.ofNodes).toBe(gs.limits!.nodes)
  })

  it('keeps a whole chain of folders, however deep the selected note sits', () => {
    const dir = Array.from({ length: 80 }, (_, i) => `d${i}`).join('/')
    const folders: string[] = []
    for (let i = 1; i <= 80; i++) folders.push(Array.from({ length: i }, (_, j) => `d${j}`).join('/'))
    const graph = buildGraph(notesOf({ [`${dir}/Deep.md`]: '# Deep\n', 'Top.md': '# Top\n' }), {
      folders: { multiRoot: false, all: folders, rootTitle: 'Vault', maxDepth: 100, maxFolders: 0 },
    })
    const base = planBase(graph, SMALL)
    const id = graph.nodes.find((n) => n.title === 'Deep')!.id
    const plan = planFor(graph, base, id, SMALL)
    const scene = companionScene(graph, { ...OPTS, selectedId: id }, plan)
    expect(scene.selected).toBeGreaterThanOrEqual(0)
    // Every node but the sun has its parent in the scene: one root, no second tree.
    expect(scene.nodes.filter((n) => n.parent < 0)).toHaveLength(1)
    let depth = 0
    for (let c = scene.selected; c >= 0; c = scene.nodes[c]!.parent) depth++
    expect(depth).toBeGreaterThan(70)
  })

  it('sends the same links in the same order whatever is selected, so the viewer need not make them again', () => {
    const { graph } = vaultOf({ areas: 2, subs: 2, topics: 2, notes: 4, projects: 1 })
    const base = planBase(graph)
    const none = planFor(graph, base, null)
    const pairs = (e: number[]): string[] => Array.from({ length: e.length / 2 }, (_, k) => `${e[2 * k]},${e[2 * k + 1]}`)
    expect(none.edges.length).toBeGreaterThan(20)
    // Ascending pairs.
    const flat = pairs(none.edges).map((p) => p.split(',').map(Number) as [number, number])
    for (let k = 1; k < flat.length; k++) expect(flat[k]![0] > flat[k - 1]![0] || (flat[k]![0] === flat[k - 1]![0] && flat[k]![1] > flat[k - 1]![1])).toBe(true)
    for (const id of [graph.nodes[3]!.id, graph.nodes[graph.nodes.length - 2]!.id]) {
      expect(planFor(graph, base, id).edges).toEqual(none.edges)
    }
    // Over the budget the selection’s own links still come first into the cut, and the cut is in the same order again.
    const tight: SceneBudget = { ...COMPANION_BUDGET, links: 10 }
    const t0 = planFor(graph, planBase(graph, tight), null, tight)
    const id = graph.nodes.find((n) => n.kind === 'note' && !t0.edges.some((v) => v === graph.index.get(n.id)))!.id
    const picked = planFor(graph, planBase(graph, tight), id, tight)
    const own = pairs(picked.edges).filter((p) => p.split(',').map(Number).includes(graph.index.get(id)!))
    expect(own.length).toBeGreaterThan(0)
    expect(picked.edges.length / 2).toBeLessThanOrEqual(10)
    const f2 = pairs(picked.edges).map((p) => p.split(',').map(Number) as [number, number])
    for (let k = 1; k < f2.length; k++) expect(f2[k]![0] >= f2[k - 1]![0]).toBe(true)
  })
})

describe('the fingerprint of a scene', () => {
  const { graph } = vaultOf({ areas: 2, subs: 2, topics: 2, notes: 3, projects: 1 })
  const make = (over: Partial<typeof OPTS> = {}, id: NoteId | null = null) => companionScene(graph, { ...OPTS, ...over, selectedId: id }, planFor(graph, planBase(graph), id))

  it('is the same for the same scene, whatever its version, and changes with anything that is drawn', () => {
    const a = make()
    expect(sceneSignature(make({ version: 99 }))).toBe(sceneSignature(a))
    expect(sceneSignature(make({ colorMode: 'age' }))).not.toBe(sceneSignature(a))
    expect(sceneSignature(make({}, graph.nodes[4]!.id))).not.toBe(sceneSignature(a))
    expect(sceneSignature(make({ vault: 'Other' } as never))).not.toBe(sceneSignature(a))
    const edge = { ...a, edges: [...a.edges.slice(0, -2), a.edges[a.edges.length - 1]!, a.edges[a.edges.length - 2]!] }
    expect(sceneSignature(edge)).not.toBe(sceneSignature(a))
    const title = { ...a, nodes: a.nodes.map((n, i) => (i === 3 ? { ...n, title: n.title + 'x' } : n)) }
    expect(sceneSignature(title)).not.toBe(sceneSignature(a))
    const radius = { ...a, nodes: a.nodes.map((n, i) => (i === 5 ? { ...n, radius: n.radius + 0.001 } : n)) }
    expect(sceneSignature(radius)).not.toBe(sceneSignature(a))
    // Where a text ends and the next begins matters.
    const ab = { ...a, nodes: a.nodes.map((n, i) => (i === 1 ? { ...n, id: 'ab', title: 'c' } : n)) }
    const ba = { ...a, nodes: a.nodes.map((n, i) => (i === 1 ? { ...n, id: 'a', title: 'bc' } : n)) }
    expect(sceneSignature(ab)).not.toBe(sceneSignature(ba))
  })
})
