/**
 * How much of the brain the companion link sends to a viewer (the Unreal app).
 *
 * The brain window draws every node with GPU instancing, so nothing in the graph is capped for it. The Unreal
 * viewer makes a real object for every sphere, link and 48 pieces per orbit ring, rewrites them every frame, and
 * parses the whole scene as JSON on its game thread: a drive with tens of thousands of notes and folders gave it
 * 0.3 to 1.1 million instances and a multi-second stall, then "ran out of memory". So the scene is cut to a budget
 * here, before it is published:
 *
 *   plan   = planBase(graph)              once per graph          (what stays, by importance)
 *   plan   = planFor(graph, base, id)     once per selection      (the selected note is always shown)
 *   dto    = companionScene(graph, o, plan)                       (companion-scene.ts: the nodes, links, `limits`)
 *   xyz    = gatherPositions(plan, all)   every position tick     (the kept nodes' places, in the new order)
 *   rings  = boundRings(graph, plan, ...) when the rings change   (only rings of shown bodies, best first)
 *
 * The kept set is closed under the structural parent (a kept node's parent is kept), so every kept node still
 * orbits exactly the body it orbits in the brain window and no parent index is ever re-pointed. Indices are
 * positional, so parents, links, rings, the selection and the positions all go through one `newIndex` table.
 * Places come from the brain window's own layout, so what the viewer shows is where the same bodies are there.
 * Pure (no electron, no three.js): unit-tested.
 */
import type { GraphData, GraphNode, NoteId } from '@aether/core'
import { companionKind } from './companion-scene'

export interface SceneBudget {
  /** The most nodes kept by importance (suns, the Today hub and the selection come on top, never displaced). */
  nodes: number
  stars: number
  planets: number
  /** Note moons in all, and per folder (a folder with more than 24 leaf notes is a ring-less shell in the layout anyway). */
  moons: number
  perFolderMoons: number
  /** Notes every kept folder gets before the rest of the moon budget is spent by importance. */
  guaranteedMoons: number
  ghosts: number
  pictures: number
  perFolderPictures: number
  links: number
  rings: number
  /** Notes the Today hub points at that are kept when their folder is, though they would not make the cut. */
  beams: number
}

/**
 * About 40,000 things for the viewer to draw at most (nodes + links + 48 per ring + its stars), which leaves
 * room on an ordinary PC. Raise them only after measuring in Unreal.
 */
export const COMPANION_BUDGET: SceneBudget = {
  nodes: 12_000,
  stars: 200,
  planets: 2_500,
  moons: 8_000,
  perFolderMoons: 24,
  guaranteedMoons: 2,
  ghosts: 300,
  pictures: 300,
  perFolderPictures: 3,
  links: 8_000,
  rings: 400,
  beams: 60,
}

/** What `planBase` decides for one graph: independent of the selection. */
export interface BasePlan {
  n: number
  cls: Uint8Array
  /** Structural parent per node, -1 for none. */
  parent: Int32Array
  keep: Uint8Array
  /** Nodes of each class in the graph, and kept. */
  total: number[]
  kept: number[]
  /** Links as node indices (-1 when an end is not in the graph), their weight, and 1 for the Today hub's beams. */
  ea: Int32Array
  eb: Int32Array
  ew: Float32Array
  ebeam: Uint8Array
}

/** What the viewer is sent for one graph and selection. */
export interface ScenePlan {
  /** Nodes in the graph. */
  n: number
  /** Original index of each kept node, ascending (the kept nodes keep the brain's own relative order). */
  keep: Int32Array
  /** New index per original index, -1 when dropped. */
  newIndex: Int32Array
  /** Structural parent per original index, -1 for none. */
  parent: Int32Array
  /** Kept links as pairs of ORIGINAL indices, most important first. */
  edges: number[]
  /** The selected node (original index), -1 for none. */
  selected: number
  /** Links in the graph. */
  linksTotal: number
}

const SUN = 0
const STAR = 1
const PLANET = 2
const MOON = 3
const GHOST = 4
const PICTURE = 5
const TODAY = 6
const CLASS_OF: Record<ReturnType<typeof companionKind>, number> = { sun: SUN, star: STAR, planet: PLANET, moon: MOON, ghost: GHOST, picture: PICTURE, today: TODAY }

/** Longest chain of parents followed (a cycle in the data must not hang the window). */
const MAX_DEPTH = 64

/** A stable total order: bigger score first, then id, so an unrelated edit never reshuffles the kept set. */
function byScore(score: Float64Array, ids: string[]) {
  return (a: number, b: number): number => score[b]! - score[a]! || (ids[a]! < ids[b]! ? -1 : ids[a]! > ids[b]! ? 1 : 0)
}

/** Which nodes of `graph` the viewer is sent, whatever is selected. O(n log n); once per graph. */
export function planBase(graph: GraphData, B: SceneBudget = COMPANION_BUDGET): BasePlan {
  const nodes = graph.nodes
  const n = nodes.length
  const parent = new Int32Array(n).fill(-1)
  const cls = new Uint8Array(n)
  const ids: string[] = new Array<string>(n)
  for (let i = 0; i < n; i++) {
    const nd = nodes[i]!
    ids[i] = nd.id
    cls[i] = CLASS_OF[companionKind(nd)]
    parent[i] = nd.parent === null ? -1 : (graph.index.get(nd.parent) ?? -1)
  }
  const E = graph.edges.length
  const ea = new Int32Array(E)
  const eb = new Int32Array(E)
  const ew = new Float32Array(E)
  const ebeam = new Uint8Array(E)
  for (let k = 0; k < E; k++) {
    const e = graph.edges[k]!
    ea[k] = graph.index.get(e.from) ?? -1
    eb[k] = graph.index.get(e.to) ?? -1
    ew[k] = e.weight
    ebeam[k] = e.kind === 'today' ? 1 : 0
  }
  const keep = new Uint8Array(n)
  const total = [0, 0, 0, 0, 0, 0, 0]
  const kept = [0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < n; i++) total[cls[i]!]!++

  /** Keep `i` and every ancestor of it; returns how many were new. */
  const take = (i: number): number => {
    let added = 0
    for (let c = i, guard = 0; c >= 0 && !keep[c] && guard < MAX_DEPTH; c = parent[c]!, guard++) {
      keep[c] = 1
      kept[cls[c]!]!++
      added++
    }
    return added
  }
  let used = 0

  // 1. Suns (the vault and its drives) and the Today hub always show.
  for (let i = 0; i < n; i++) if (cls[i] === SUN || cls[i] === TODAY) used += take(i)

  // 2. Project stars, the ones with the most notes first.
  const totalNotes = (i: number): number => nodes[i]!.folder?.totalNotes ?? 0
  const score = new Float64Array(n)
  const stars: number[] = []
  for (let i = 0; i < n; i++) if (cls[i] === STAR) stars.push(i)
  for (const i of stars) score[i] = totalNotes(i)
  stars.sort(byScore(score, ids))
  for (const i of stars) {
    if (kept[STAR]! >= B.stars) break
    if (!keep[i]) used += take(i)
  }

  // 3. Folders. A kept project always shows its first subfolders; then the folders that hold the most notes
  //    (a kept folder pulls in the chain of its ancestors), so a deep vault keeps where its notes are and not a
  //    ring of empty shallow folders.
  const planets: number[] = []
  for (let i = 0; i < n; i++) if (cls[i] === PLANET) planets.push(i)
  for (const i of planets) score[i] = totalNotes(i) + (nodes[i]!.folder?.childFolders ?? 0) * 0.001
  const planetsLeft = (): number => B.planets - kept[PLANET]!
  const ofStars = planets.filter((i) => parent[i]! >= 0 && cls[parent[i]!] === STAR && keep[parent[i]!]).sort(byScore(score, ids))
  const perStar = new Map<number, number>()
  for (const i of ofStars) {
    if (planetsLeft() <= 0 || used >= B.nodes) break
    const p = parent[i]!
    const c = perStar.get(p) ?? 0
    if (c >= 40 || keep[i]) continue
    perStar.set(p, c + 1)
    used += take(i)
  }
  planets.sort((a, b) => {
    const fa = nodes[a]!.folder!
    const fb = nodes[b]!.folder!
    return fb.notes - fa.notes || fb.totalNotes - fa.totalNotes || fa.depth - fb.depth || (ids[a]! < ids[b]! ? -1 : 1)
  })
  for (const i of planets) {
    if (planetsLeft() <= 0 || used >= B.nodes) break
    if (!keep[i]) used += take(i)
  }

  // 4. Note moons. Each kept folder keeps its best `perFolderMoons` (a bounded insertion, O(n·K)) and is
  //    guaranteed its first few; the rest of the moon budget goes to the notes with the most links.
  const noteScore = (nd: GraphNode): number =>
    nd.degree * 1000 + (nd.type === 'moc' ? 400 : nd.type === 'project' || nd.type === 'area' ? 200 : 0) + Math.min(999, ((nd.created ?? 0) / 1e13) * 999)
  const best = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    if (cls[i] !== MOON) continue
    const p = parent[i]!
    if (p >= 0 && !keep[p]) continue
    score[i] = noteScore(nodes[i]!)
    const cap = p < 0 ? B.moons : B.perFolderMoons
    let list = best.get(p)
    if (!list) best.set(p, (list = []))
    let at = list.length
    while (at > 0 && (score[list[at - 1]!]! < score[i]! || (score[list[at - 1]!] === score[i] && ids[list[at - 1]!]! > ids[i]!))) at--
    if (at >= cap) continue
    list.splice(at, 0, i)
    if (list.length > cap) list.pop()
  }
  const moonsLeft = (): number => Math.min(B.moons - kept[MOON]!, B.nodes - used)
  const rest: number[] = []
  for (const [, list] of [...best.entries()].sort((a, b) => a[0] - b[0])) {
    for (let r = 0; r < list.length; r++) {
      const i = list[r]!
      if (r < B.guaranteedMoons) {
        if (moonsLeft() > 0) used += take(i)
      } else rest.push(i)
    }
  }
  rest.sort(byScore(score, ids))
  for (const i of rest) {
    if (moonsLeft() <= 0) break
    if (!keep[i]) used += take(i)
  }

  // 4b. The notes the Today hub points at, when their folder is kept: the hub keeps its beams.
  let beams = 0
  for (let k = 0; k < E && beams < B.beams; k++) {
    if (!ebeam[k]) continue
    const b = eb[k]!
    if (b < 0 || keep[b] || cls[b] !== MOON) continue
    const p = parent[b]!
    if (p >= 0 && keep[p]) {
      used += take(b)
      beams++
    }
  }

  // 5. Ghosts (notes still to be written): only those of a kept note, the most linked first.
  const ghosts: number[] = []
  for (let i = 0; i < n; i++) {
    if (cls[i] !== GHOST) continue
    const p = parent[i]!
    let ok = p >= 0 && keep[p] && cls[p] === MOON
    if (p < 0 && !graph.folderSelection) {
      for (const ref of graph.unresolved.get(nodes[i]!.id) ?? []) {
        const r = graph.index.get(ref)
        if (r !== undefined && keep[r]) ok = true
      }
    }
    if (ok) {
      score[i] = nodes[i]!.inDegree
      ghosts.push(i)
    }
  }
  ghosts.sort(byScore(score, ids))
  for (const i of ghosts) {
    if (kept[GHOST]! >= B.ghosts || used >= B.nodes) break
    used += take(i)
  }

  // 6. Pictures: never the cards of an open gallery (they belong to the brain window's camera); a few per kept
  //    folder, the ones notes embed first, then the newest.
  const perFolder = new Map<number, number>()
  const pics: number[] = []
  for (let i = 0; i < n; i++) {
    if (cls[i] !== PICTURE) continue
    const img = nodes[i]!.image
    if (img?.gallery?.only) continue
    const p = parent[i]!
    if (p >= 0 && !keep[p]) continue
    score[i] = (img?.embeddedBy ?? 0) * 1e13 + (img?.mtime ?? 0)
    pics.push(i)
  }
  pics.sort(byScore(score, ids))
  for (const i of pics) {
    if (kept[PICTURE]! >= B.pictures || used >= B.nodes) break
    const p = parent[i]!
    const c = perFolder.get(p) ?? 0
    if (c >= B.perFolderPictures) continue
    perFolder.set(p, c + 1)
    used += take(i)
  }

  return { n, cls, parent, keep, total, kept, ea, eb, ew, ebeam }
}

/** The plan for one selection: the base set, the selected node and its chain of parents, and the links between kept nodes. */
export function planFor(graph: GraphData, base: BasePlan, selectedId: NoteId | null, B: SceneBudget = COMPANION_BUDGET): ScenePlan {
  const { n, parent } = base
  const nodes = graph.nodes
  const keep = Uint8Array.from(base.keep)
  const selected = selectedId === null ? -1 : (graph.index.get(selectedId) ?? -1)
  if (selected >= 0) {
    for (let c = selected, guard = 0; c >= 0 && !keep[c] && guard < MAX_DEPTH; c = parent[c]!, guard++) keep[c] = 1
  }

  let count = 0
  for (let i = 0; i < n; i++) if (keep[i]) count++
  const kept = new Int32Array(count)
  const newIndex = new Int32Array(n).fill(-1)
  for (let i = 0, k = 0; i < n; i++) {
    if (!keep[i]) continue
    newIndex[i] = k
    kept[k++] = i
  }

  // Links between kept nodes, the Today hub's beams and the selection's first; the viewer draws the first it is sent.
  const { ea, eb, ew, ebeam } = base
  const cand: { a: number; b: number; s: number }[] = []
  for (let k = 0; k < ea.length; k++) {
    const a = ea[k]!
    const b = eb[k]!
    if (a < 0 || b < 0 || !keep[a] || !keep[b]) continue
    cand.push({ a, b, s: (ebeam[k] ? 3e9 : 0) + (a === selected || b === selected ? 2e9 : 0) + ew[k]! * 1e6 + nodes[a]!.degree + nodes[b]!.degree })
  }
  cand.sort((x, y) => y.s - x.s || x.a - y.a || x.b - y.b)
  const edges: number[] = []
  for (let k = 0; k < cand.length && k < B.links; k++) edges.push(cand[k]!.a, cand[k]!.b)
  return { n, keep: kept, newIndex, parent, edges, selected, linksTotal: ea.length }
}

/** The kept nodes' xyz, in the new order (into `out` when it fits). */
export function gatherPositions(plan: ScenePlan, positions: Float32Array, out?: Float32Array): Float32Array {
  const m = plan.keep.length
  const dst = out && out.length === m * 3 ? out : new Float32Array(m * 3)
  for (let k = 0; k < m; k++) {
    const i = plan.keep[k]! * 3
    dst[k * 3] = positions[i] ?? 0
    dst[k * 3 + 1] = positions[i + 1] ?? 0
    dst[k * 3 + 2] = positions[i + 2] ?? 0
  }
  return dst
}

/**
 * The orbit rings to send: those of kept parents with a kept body on them, the biggest systems first (the layout
 * lists deepest first, so array order says nothing), at most `cap`, parents remapped to the new indices.
 * `rings` is 6 floats per ring (parent, radius, quaternion x y z w); a body's distance from its parent is the
 * radius of the ring it is on, which is how an empty ring is found.
 */
export function boundRings(graph: GraphData, plan: ScenePlan, rings: Float32Array, positions: Float32Array, cap: number): Float32Array {
  const total = Math.floor(rings.length / 6)
  const mine: number[] = []
  for (let r = 0; r < total; r++) {
    const p = rings[r * 6]!
    if (Number.isInteger(p) && p >= 0 && p < plan.n && plan.newIndex[p]! >= 0) mine.push(r)
  }
  if (mine.length === 0 || cap <= 0) return new Float32Array(0)

  const byParent = new Map<number, number[]>()
  for (const r of mine) {
    const p = rings[r * 6]!
    let list = byParent.get(p)
    if (!list) byParent.set(p, (list = []))
    list.push(r)
  }
  for (const list of byParent.values()) list.sort((a, b) => rings[a * 6 + 1]! - rings[b * 6 + 1]!)
  const bodies = new Int32Array(plan.n)
  const used = new Set<number>()
  for (let k = 0; k < plan.keep.length; k++) {
    const c = plan.keep[k]!
    const p = plan.parent[c]!
    const list = p >= 0 ? byParent.get(p) : undefined
    if (!list) continue
    bodies[p]!++
    const dx = (positions[c * 3] ?? 0) - (positions[p * 3] ?? 0)
    const dy = (positions[c * 3 + 1] ?? 0) - (positions[p * 3 + 1] ?? 0)
    const dz = (positions[c * 3 + 2] ?? 0) - (positions[p * 3 + 2] ?? 0)
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    let lo = 0
    let hi = list.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (rings[list[mid]! * 6 + 1]! < d) lo = mid + 1
      else hi = mid
    }
    for (const j of [lo - 1, lo]) {
      const r = list[j]
      if (r !== undefined && Math.abs(rings[r * 6 + 1]! - d) <= 1e-3 * (1 + d)) used.add(r)
    }
  }
  const live = mine.filter((r) => used.has(r))
  const rank = (r: number): number => {
    const p = rings[r * 6]!
    const f = graph.nodes[p]!.folder
    return (f ? (f.role === 'root' || f.role === 'mount' ? 3e9 : f.role === 'project' ? 2e9 : 1e6) : 0) + bodies[p]!
  }
  live.sort((a, b) => rank(b) - rank(a) || rings[a * 6 + 1]! - rings[b * 6 + 1]! || a - b)
  const top = live.slice(0, cap)
  const out = new Float32Array(top.length * 6)
  top.forEach((r, k) => {
    out[k * 6] = plan.newIndex[rings[r * 6]!]!
    for (let j = 1; j < 6; j++) out[k * 6 + j] = rings[r * 6 + j]!
  })
  return out
}
