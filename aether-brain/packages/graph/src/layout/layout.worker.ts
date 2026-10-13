/// <reference lib="webworker" />
/**
 * Layout worker: everything that moves nodes runs here, off the main thread.
 *
 * Constellation mode — d3-force-3d; clusters by PARA area (each area has an
 * anchor on a ring), links pull, charge repels, collide keeps neurons from
 * overlapping.
 *
 * Orbit mode — d3-force-3d; time is the layout: newer notes orbit close to the
 * core, older notes drift to outer rings, flattened into a tilted disc.
 *
 * System mode — no physics: the folder tree is laid out analytically as
 * nested solar systems (see system.ts). Positions ease in from the previous
 * layout over 1.2 s (a fading offset on top of the live orbits, so a body
 * whose orbit did not change never lags), then planets and moons orbit while
 * motion is on.
 */
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type SimLink,
  type SimNode,
  type Simulation,
} from 'd3-force-3d'
import type { LayoutEdgeInput, LayoutMode, LayoutNodeInput, MainToWorker, WorkerToMain } from './protocol'
import { finiteOr, healBodies, linkStrength } from './safe'
import { computeSystemLayout, systemPositions, type SystemLayout } from './system'

interface Node extends SimNode {
  id: string
  area: number
  degree: number
  created: number | null
  ghost: boolean
  radius: number
  /** 0 = newest .. 1 = oldest, for orbit mode. */
  age: number
}

interface Link extends SimLink<Node> {
  source: Node
  target: Node
  w: number
}

const ctx = self as unknown as DedicatedWorkerGlobalScope

const ANCHOR_RADIUS = 150
/** Area anchors in area-index order: inbox, projects, areas, resources, archive, untagged. */
const ANCHORS: [number, number, number][] = Array.from({ length: 6 }, (_, i) => {
  const a = (i / 6) * Math.PI * 2 + Math.PI / 7
  const y = [40, -20, 30, -35, 10, -10][i] ?? 0
  return [Math.cos(a) * ANCHOR_RADIUS, y, Math.sin(a) * ANCHOR_RADIUS]
})

let sim: Simulation<Node, Link> | null = null
let nodes: Node[] = []
let links: Link[] = []
let mode: LayoutMode = 'constellation'
let generation = 0
let timer: ReturnType<typeof setTimeout> | null = null
let running = false
/** The current node set as sent by the main thread (the d3 simulation is built from it lazily). */
let inputs: LayoutNodeInput[] = []
let edgeInputs: LayoutEdgeInput[] = []
let seedValue = 7

/* System mode state. */
const TRANSITION_MS = 1200
const EASE_FRAME_MS = 16
const MOTION_FRAME_MS = 33
let layout: SystemLayout | null = null
/** Ids the system buffers are indexed by (to carry drag offsets across rebuilds). */
let sysIds: string[] = []
/** Last computed positions (what the main thread shows). */
let sysPos = new Float32Array(0)
/**
 * Transition: where each body started minus where its orbit had it then. The
 * shown position is the live orbit plus this offset, fading out: zero for a
 * body whose orbit did not change, so a rebuild never makes the others lag.
 */
let sysFrom: Float32Array = new Float32Array(0)
/** Scratch: analytic positions at the current orbit time. */
let sysTarget = new Float32Array(0)
/** User drags, xyz per node; children follow because they are placed relative to their parent. */
let offsets = new Float32Array(0)
/** Orbit clock in seconds; only advances while motion is on, so pausing never jumps. */
let sysTime = 0
let lastTick = 0
/** Transition start (ms), -1 when no transition is running. */
let transitionStart = -1
let motion = true

function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildNodes(input: LayoutNodeInput[], prev?: { ids: string[]; positions: Float32Array }, seed = 7): Node[] {
  const rnd = seeded(seed)
  const prevIndex = new Map<string, number>()
  if (prev) prev.ids.forEach((id, i) => prevIndex.set(id, i))
  // A loop, not Math.min(...times): spreading more than about 125,000 numbers overflows the call stack.
  let minT = Infinity
  let maxT = -Infinity
  for (const n of input) {
    if (n.created === null) continue
    if (n.created < minT) minT = n.created
    if (n.created > maxT) maxT = n.created
  }
  if (minT === Infinity) {
    minT = 0
    maxT = 1
  }
  const span = Math.max(1, maxT - minT)
  return input.map((n) => {
    const pi = prevIndex.get(n.id)
    const anchor = ANCHORS[n.area] ?? [0, 0, 0]
    let x: number, y: number, z: number
    if (pi !== undefined && prev) {
      // A place that is not a number (an earlier layout that went wrong) starts at the area's anchor instead.
      x = finiteOr(prev.positions[pi * 3], anchor[0])
      y = finiteOr(prev.positions[pi * 3 + 1], anchor[1])
      z = finiteOr(prev.positions[pi * 3 + 2], anchor[2])
    } else {
      // Spawn near the area anchor so clusters form immediately.
      x = anchor[0] + (rnd() - 0.5) * 80
      y = anchor[1] + (rnd() - 0.5) * 80
      z = anchor[2] + (rnd() - 0.5) * 80
    }
    const age = n.created === null ? 0.85 : 1 - (n.created - minT) / span
    return { ...n, x, y, z, age }
  })
}

function createSimulation(prev?: { ids: string[]; positions: Float32Array }): void {
  nodes = buildNodes(inputs, prev, seedValue)
  links = edgeInputs
    .filter((e) => nodes[e.s] && nodes[e.t])
    .map((e) => ({ source: nodes[e.s]!, target: nodes[e.t]!, w: e.w }))
  sim = forceSimulation<Node, Link>(nodes, 3)
    .alphaDecay(nodes.length > 600 ? 0.035 : 0.02)
    .alphaMin(0.004)
    .velocityDecay(0.42)
    .randomSource(seeded(seedValue + 1))
    .stop()
}

function applyForces(): void {
  if (!sim) return
  const n = nodes.length
  const big = n > 600
  sim.force('link', null).force('charge', null).force('center', null).force('collide', null)
  sim.force('ax', null).force('ay', null).force('az', null).force('radial', null).force('flat', null)

  const link = forceLink<Node, Link>(links)
    .id((d) => d.id)
    .distance((l) => 22 + 5 * Math.sqrt(l.source.degree + l.target.degree) + (l.w > 1 ? -4 : 0))
    .strength((l) => linkStrength(mode === 'orbit' ? 0.25 : 0.9, l.source.degree, l.target.degree))
    .iterations(big ? 1 : 2)
  sim.force('link', link)

  sim.force(
    'charge',
    forceManyBody<Node>()
      .strength((d) => (mode === 'orbit' ? -18 : -42) * (d.ghost ? 0.4 : 1) * (1 + Math.min(d.degree, 20) * 0.08))
      .theta(big ? 1.1 : 0.9)
      .distanceMax(220),
  )
  sim.force('collide', forceCollide<Node>((d) => d.radius * 1.9 + 1.5).strength(0.7).iterations(1))

  if (mode === 'constellation') {
    sim.force('center', forceCenter<Node>(0, 0, 0).strength(0.02))
    const k = 0.07
    sim.force('ax', forceX<Node>((d) => ANCHORS[d.area]?.[0] ?? 0).strength(k))
    sim.force('ay', forceY<Node>((d) => ANCHORS[d.area]?.[1] ?? 0).strength(k))
    sim.force('az', forceZ<Node>((d) => ANCHORS[d.area]?.[2] ?? 0).strength(k))
  } else {
    // Rings: newest at r≈40, oldest at r≈300. Quantized so the "orbital
    // layers" read as bands rather than a smear.
    sim.force(
      'radial',
      forceRadial<Node>((d) => {
        const band = Math.round(d.age * 7) / 7
        return 40 + band * 260
      }, 0, 0, 0).strength(0.35),
    )
    sim.force('flat', forceY<Node>(0).strength(0.22))
  }
}

/** Where a body that lost its place goes back to: its area's anchor. */
function areaAnchor(d: Node): [number, number, number] {
  return ANCHORS[d.area] ?? [0, 0, 0]
}

let healedWarned = false
function warnHealed(): void {
  if (healedWarned) return
  healedWarned = true
  console.warn('[aether] the layout put back a body whose place was not a number')
}

function post(settled: boolean): void {
  const out = new Float32Array(nodes.length * 3)
  for (let i = 0; i < nodes.length; i++) {
    const d = nodes[i]!
    out[i * 3] = d.x
    out[i * 3 + 1] = d.y
    out[i * 3 + 2] = d.z
  }
  const msg: WorkerToMain = { type: 'positions', positions: out, alpha: sim?.alpha() ?? 0, settled, generation }
  ctx.postMessage(msg, [out.buffer])
}

function loop(): void {
  if (!sim || !running) return
  // A body that is not finite would hang the next tick inside d3-octree (see safe.ts): put it back first.
  if (healBodies(nodes, areaAnchor) > 0) warnHealed()
  const alphaMin = sim.alphaMin()
  // Large graphs: several ticks per posted frame so they settle in seconds.
  const ticks = nodes.length > 600 ? 2 : 1
  for (let i = 0; i < ticks; i++) sim.tick()
  const alpha = sim.alpha()
  if (alpha < alphaMin) {
    running = false
    post(true)
    return
  }
  post(false)
  timer = setTimeout(loop, 16)
}

function start(alpha = 1): void {
  if (!sim) return
  sim.alpha(Math.max(sim.alpha(), alpha))
  if (running) return
  running = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(loop, 0)
}

function stopLoop(): void {
  running = false
  if (timer) clearTimeout(timer)
  timer = null
}

/** The system layout's per-generation data (nothing, outside the system layout). */
function postRings(next: SystemLayout | null): void {
  const rings = next ? next.rings.slice() : new Float32Array(0)
  const cards = next ? next.card.slice() : new Float32Array(0)
  const extent = next ? next.extent.slice() : new Float32Array(0)
  const msg: WorkerToMain = { type: 'rings', rings, cards, extent, generation }
  ctx.postMessage(msg, [rings.buffer, cards.buffer, extent.buffer])
}

function setGraph(input: LayoutNodeInput[], edges: LayoutEdgeInput[], prev?: { ids: string[]; positions: Float32Array }, seed?: number): void {
  generation++
  stopLoop()
  const wasSystem = layout !== null
  inputs = input
  edgeInputs = edges
  seedValue = seed ?? 7
  ctx.postMessage({ type: 'ready', generation } satisfies WorkerToMain)
  if (mode === 'system') {
    // The d3 simulation is only built when leaving system mode.
    sim = null
    nodes = []
    links = []
    const n = input.length
    const from = new Float32Array(n * 3)
    const known = new Uint8Array(n)
    if (prev) {
      const prevIndex = new Map<string, number>()
      prev.ids.forEach((id, i) => prevIndex.set(id, i))
      for (let i = 0; i < n; i++) {
        const j = prevIndex.get(input[i]!.id)
        if (j === undefined || j * 3 + 2 >= prev.positions.length) continue
        from[i * 3] = prev.positions[j * 3]!
        from[i * 3 + 1] = prev.positions[j * 3 + 1]!
        from[i * 3 + 2] = prev.positions[j * 3 + 2]!
        known[i] = 1
      }
    }
    enterSystem(from, known, wasSystem)
    return
  }
  layout = null
  postRings(null)
  createSimulation(prev)
  applyForces()
  start(prev ? 0.35 : 1)
}

/* ------------------------------------------------------------------ */
/* System mode                                                        */
/* ------------------------------------------------------------------ */

/**
 * Lay the current node set out as nested solar systems and ease into it.
 * `from`: start positions; nodes not marked in `known` are born at their
 * parent's start position. `keepOffsets`: carry drag offsets over by id.
 */
function enterSystem(from: Float32Array, known: Uint8Array | null, keepOffsets: boolean): void {
  stopLoop()
  const n = inputs.length
  // The ease runs from these places: one that is not a number would make the settled place NaN (Infinity × 0).
  for (let k = 0; k < from.length; k++) {
    if (Number.isFinite(from[k])) continue
    from[k] = 0
    if (known) known[Math.floor(k / 3)] = 0
  }
  const parent = new Int32Array(n)
  const kind = new Uint8Array(n)
  const role = new Int8Array(n)
  const radius = new Float32Array(n)
  const ids = new Array<string>(n)
  const gallery = new Int32Array(n).fill(-1)
  const galleryRank = new Int32Array(n)
  const galleryOnly = new Uint8Array(n)
  const urgency = new Float32Array(n)
  const planet = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const d = inputs[i]!
    urgency[i] = d.urgency ?? 0
    planet[i] = d.planet ? 1 : 0
    parent[i] = d.parent
    kind[i] = d.kind
    role[i] = d.role
    radius[i] = d.radius
    ids[i] = d.id
    if (d.gallery) {
      gallery[i] = d.gallery.anchor
      galleryRank[i] = d.gallery.rank
      galleryOnly[i] = d.gallery.only ? 1 : 0
    }
  }
  const next = computeSystemLayout({ parent, kind, role, radius, ids, gallery, galleryRank, galleryOnly, urgency, planet })

  const nextOffsets = new Float32Array(n * 3)
  if (keepOffsets && offsets.length) {
    const old = new Map<string, number>()
    sysIds.forEach((id, i) => old.set(id, i))
    for (let i = 0; i < n; i++) {
      const j = old.get(ids[i]!)
      if (j === undefined) continue
      nextOffsets[i * 3] = offsets[j * 3]!
      nextOffsets[i * 3 + 1] = offsets[j * 3 + 1]!
      nextOffsets[i * 3 + 2] = offsets[j * 3 + 2]!
    }
  }
  layout = next
  sysIds = ids
  offsets = nextOffsets
  sysTarget = new Float32Array(n * 3)
  systemPositions(next, sysTime, sysTarget, offsets)
  sysFrom = from
  if (known) {
    // Parents come first in `order`, so a newborn moon starts where its planet starts.
    for (let o = 0; o < n; o++) {
      const i = next.order[o]!
      if (known[i]) continue
      const p = next.parent[i]!
      const src = p >= 0 ? sysFrom : sysTarget
      const k = p >= 0 ? p : i
      sysFrom[i * 3] = src[k * 3]!
      sysFrom[i * 3 + 1] = src[k * 3 + 1]!
      sysFrom[i * 3 + 2] = src[k * 3 + 2]!
    }
  }
  sysPos = new Float32Array(sysFrom)
  for (let i = 0; i < sysFrom.length; i++) sysFrom[i] = sysFrom[i]! - sysTarget[i]!
  postRings(next)
  transitionStart = performance.now()
  startSystemLoop()
}

function startSystemLoop(): void {
  if (running) return
  running = true
  lastTick = performance.now()
  if (timer) clearTimeout(timer)
  timer = setTimeout(systemLoop, 0)
}

function postSystem(settled: boolean, alpha: number): void {
  const out = new Float32Array(sysPos)
  const msg: WorkerToMain = { type: 'positions', positions: out, alpha, settled, generation }
  ctx.postMessage(msg, [out.buffer])
}

/**
 * One system frame: advance the orbit clock (motion on), ease from the start
 * positions while the transition runs, post. `settled: true` goes out on the
 * frame the transition completes, and on the single frame after motion stops.
 */
function systemLoop(): void {
  timer = null
  if (!running || !layout) return
  const now = performance.now()
  const dt = Math.min(0.1, Math.max(0, (now - lastTick) / 1000))
  lastTick = now
  if (motion) sysTime += dt
  systemPositions(layout, sysTime, sysTarget, offsets)
  let settled: boolean
  let alpha = 0
  if (transitionStart >= 0) {
    const k = Math.min(1, (now - transitionStart) / TRANSITION_MS)
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
    for (let i = 0; i < sysPos.length; i++) sysPos[i] = sysTarget[i]! + sysFrom[i]! * (1 - e)
    alpha = 1 - k
    settled = k >= 1
    if (settled) transitionStart = -1
  } else {
    sysPos.set(sysTarget)
    settled = !motion
  }
  postSystem(settled, alpha)
  if (transitionStart >= 0) timer = setTimeout(systemLoop, EASE_FRAME_MS)
  // Nothing to orbit (no vault yet): no motion frames.
  else if (motion && sysPos.length > 0) timer = setTimeout(systemLoop, MOTION_FRAME_MS)
  else running = false
}

/** Back to a force layout from the system positions; the simulation is created on first use. */
function leaveSystem(): void {
  stopLoop()
  transitionStart = -1
  const n = inputs.length
  if (!sim || nodes.length !== n) {
    createSimulation({ ids: inputs.map((d) => d.id), positions: sysPos })
  } else {
    for (let i = 0; i < n; i++) {
      const d = nodes[i]!
      d.x = finiteOr(sysPos[i * 3], d.x ?? 0)
      d.y = finiteOr(sysPos[i * 3 + 1], d.y ?? 0)
      d.z = finiteOr(sysPos[i * 3 + 2], d.z ?? 0)
      d.vx = 0
      d.vy = 0
      d.vz = 0
    }
  }
  layout = null
  postRings(null)
  applyForces()
  start(0.8)
}

/** Current force-layout positions as a flat buffer. */
function forcePositions(): Float32Array {
  const out = new Float32Array(inputs.length * 3)
  for (let i = 0; i < nodes.length && i < inputs.length; i++) {
    const d = nodes[i]!
    out[i * 3] = d.x
    out[i * 3 + 1] = d.y
    out[i * 3 + 2] = d.z
  }
  return out
}

ctx.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data
  switch (msg.type) {
    case 'graph':
      mode = msg.mode
      setGraph(msg.nodes, msg.edges, msg.prev, msg.seed)
      break
    case 'mode': {
      if (mode === msg.mode) break
      const was = mode
      mode = msg.mode
      if (mode === 'system') {
        enterSystem(forcePositions(), null, false)
      } else if (was === 'system') {
        leaveSystem()
      } else {
        applyForces()
        start(0.8)
      }
      break
    }
    case 'pin': {
      if (layout) {
        // Drag in system mode: shift the node's offset so it sits under the pointer.
        const i = msg.index
        if (i < 0 || i * 3 + 2 >= sysPos.length) break
        const dx = msg.x - sysPos[i * 3]!
        const dy = msg.y - sysPos[i * 3 + 1]!
        const dz = msg.z - sysPos[i * 3 + 2]!
        offsets[i * 3] = offsets[i * 3]! + dx
        offsets[i * 3 + 1] = offsets[i * 3 + 1]! + dy
        offsets[i * 3 + 2] = offsets[i * 3 + 2]! + dz
        // Mid-transition the shown position is the orbit (which carries the offset) plus a fading
        // start offset, so the drag counts in full right away.
        if (!running) {
          systemPositions(layout, sysTime, sysPos, offsets)
          postSystem(false, 0)
        } else {
          // Several pins can arrive before the next frame: measure the next one from here.
          sysPos[i * 3] = msg.x
          sysPos[i * 3 + 1] = msg.y
          sysPos[i * 3 + 2] = msg.z
        }
        break
      }
      const d = nodes[msg.index]
      if (!d) break
      d.fx = msg.x
      d.fy = msg.y
      d.fz = msg.z
      start(0.12)
      break
    }
    case 'release': {
      if (layout) {
        // The offset stays: a dragged planet keeps its new place, with its moons.
        if (!running) postSystem(true, 0)
        break
      }
      const d = nodes[msg.index]
      if (!d) break
      d.fx = null
      d.fy = null
      d.fz = null
      if (msg.reheat) start(0.12)
      break
    }
    case 'reheat':
      if (layout) {
        // Re-run the system layout: forget drags and ease back into place.
        offsets.fill(0)
        systemPositions(layout, sysTime, sysTarget, offsets)
        sysFrom = new Float32Array(sysPos.length)
        for (let i = 0; i < sysFrom.length; i++) sysFrom[i] = sysPos[i]! - sysTarget[i]!
        transitionStart = performance.now()
        startSystemLoop()
        break
      }
      start(msg.alpha ?? 0.5)
      break
    case 'motion':
      if (motion === msg.on) break
      motion = msg.on
      // Off: the next frame is posted settled and the loop stops (a running transition finishes first).
      if (motion && layout) startSystemLoop()
      break
    case 'stop':
      stopLoop()
      break
  }
}
