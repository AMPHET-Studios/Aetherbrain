/// <reference lib="webworker" />
/**
 * Layout worker: d3-force-3d simulation off the main thread.
 *
 * Constellation mode — clusters by PARA area (each area has an anchor on a
 * ring), links pull, charge repels, collide keeps neurons from overlapping.
 *
 * Orbit mode — time is the layout: newer notes orbit close to the core, older
 * notes drift to outer rings, flattened into a tilted disc.
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
  const times = input.map((n) => n.created).filter((t): t is number => t !== null)
  const minT = times.length ? Math.min(...times) : 0
  const maxT = times.length ? Math.max(...times) : 1
  const span = Math.max(1, maxT - minT)
  return input.map((n) => {
    const pi = prevIndex.get(n.id)
    const anchor = ANCHORS[n.area] ?? [0, 0, 0]
    let x: number, y: number, z: number
    if (pi !== undefined && prev) {
      x = prev.positions[pi * 3] ?? 0
      y = prev.positions[pi * 3 + 1] ?? 0
      z = prev.positions[pi * 3 + 2] ?? 0
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

function applyForces(): void {
  if (!sim) return
  const n = nodes.length
  const big = n > 600
  sim.force('link', null).force('charge', null).force('center', null).force('collide', null)
  sim.force('ax', null).force('ay', null).force('az', null).force('radial', null).force('flat', null)

  const link = forceLink<Node, Link>(links)
    .id((d) => d.id)
    .distance((l) => 22 + 5 * Math.sqrt(l.source.degree + l.target.degree) + (l.w > 1 ? -4 : 0))
    .strength((l) => (mode === 'orbit' ? 0.25 : 0.9) / Math.min(l.source.degree, l.target.degree, 12))
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

function setGraph(input: LayoutNodeInput[], edges: LayoutEdgeInput[], prev?: { ids: string[]; positions: Float32Array }, seed?: number): void {
  generation++
  if (timer) clearTimeout(timer)
  running = false
  nodes = buildNodes(input, prev, seed)
  links = edges
    .filter((e) => nodes[e.s] && nodes[e.t])
    .map((e) => ({ source: nodes[e.s]!, target: nodes[e.t]!, w: e.w }))
  sim = forceSimulation<Node, Link>(nodes, 3)
    .alphaDecay(nodes.length > 600 ? 0.035 : 0.02)
    .alphaMin(0.004)
    .velocityDecay(0.42)
    .randomSource(seeded((seed ?? 7) + 1))
    .stop()
  applyForces()
  ctx.postMessage({ type: 'ready', generation } satisfies WorkerToMain)
  start(prev ? 0.35 : 1)
}

ctx.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data
  switch (msg.type) {
    case 'graph':
      mode = msg.mode
      setGraph(msg.nodes, msg.edges, msg.prev, msg.seed)
      break
    case 'mode':
      if (mode === msg.mode) break
      mode = msg.mode
      applyForces()
      start(0.8)
      break
    case 'pin': {
      const d = nodes[msg.index]
      if (!d) break
      d.fx = msg.x
      d.fy = msg.y
      d.fz = msg.z
      start(0.12)
      break
    }
    case 'release': {
      const d = nodes[msg.index]
      if (!d) break
      d.fx = null
      d.fy = null
      d.fz = null
      if (msg.reheat) start(0.12)
      break
    }
    case 'reheat':
      start(msg.alpha ?? 0.5)
      break
    case 'stop':
      running = false
      if (timer) clearTimeout(timer)
      break
  }
}
