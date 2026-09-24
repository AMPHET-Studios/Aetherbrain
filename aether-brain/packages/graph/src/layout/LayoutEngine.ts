import type { GraphData } from '@aether/core'
import type { LayoutEdgeInput, LayoutMode, LayoutNodeInput, MainToWorker, WorkerToMain } from './protocol'
import { AREA_INDEX, nodeRadius } from '../theme'

export type TickListener = (engine: LayoutEngine) => void

/**
 * Main-thread handle on the layout worker. Holds the latest positions buffer
 * (xyz triples in graph node order). Rendering code reads `positions` every
 * frame; React never re-renders because of a layout tick.
 */
export class LayoutEngine {
  positions = new Float32Array(0)
  ids: string[] = []
  index = new Map<string, number>()
  mode: LayoutMode = 'constellation'
  settled = false
  alpha = 0
  /** Increments on every positions frame. */
  frame = 0
  private worker: Worker | null = null
  private listeners = new Set<TickListener>()
  private generation = 0
  private disposed = false

  constructor() {
    if (typeof Worker !== 'undefined') {
      this.worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module', name: 'aether-layout' })
      this.worker.onmessage = (ev: MessageEvent<WorkerToMain>) => this.onMessage(ev.data)
    }
  }

  get running(): boolean {
    return !this.settled
  }

  onTick(cb: TickListener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  setGraph(graph: GraphData, mode = this.mode, seed = 7): void {
    this.mode = mode
    const prev = this.ids.length ? { ids: this.ids, positions: this.positions } : undefined
    const nodes: LayoutNodeInput[] = graph.nodes.map((n) => ({
      id: n.id,
      area: AREA_INDEX[n.area] ?? 5,
      degree: n.degree,
      created: n.created,
      ghost: n.ghost,
      radius: nodeRadius(n),
    }))
    const edges: LayoutEdgeInput[] = []
    for (const e of graph.edges) {
      const s = graph.index.get(e.from)
      const t = graph.index.get(e.to)
      if (s === undefined || t === undefined) continue
      edges.push({ s, t, w: e.weight })
    }
    this.ids = nodes.map((n) => n.id)
    this.index = new Map(this.ids.map((id, i) => [id, i]))
    // Seed the buffer with previous positions (or zeros) so the first frame
    // before the worker replies has something sane to draw.
    const next = new Float32Array(nodes.length * 3)
    if (prev) {
      const pi = new Map(prev.ids.map((id, i) => [id, i]))
      nodes.forEach((n, i) => {
        const j = pi.get(n.id)
        if (j !== undefined) {
          next[i * 3] = prev.positions[j * 3] ?? 0
          next[i * 3 + 1] = prev.positions[j * 3 + 1] ?? 0
          next[i * 3 + 2] = prev.positions[j * 3 + 2] ?? 0
        }
      })
    }
    this.positions = next
    this.settled = false
    this.frame++
    const msg: MainToWorker = { type: 'graph', nodes, edges, mode, seed }
    if (prev) msg.prev = { ids: prev.ids, positions: prev.positions }
    this.post(msg)
    this.emit()
  }

  setMode(mode: LayoutMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.settled = false
    this.post({ type: 'mode', mode })
  }

  pin(id: string, x: number, y: number, z: number): void {
    const i = this.index.get(id)
    if (i === undefined) return
    this.positions[i * 3] = x
    this.positions[i * 3 + 1] = y
    this.positions[i * 3 + 2] = z
    this.settled = false
    this.post({ type: 'pin', index: i, x, y, z })
  }

  release(id: string, reheat = true): void {
    const i = this.index.get(id)
    if (i === undefined) return
    this.post({ type: 'release', index: i, reheat })
  }

  reheat(alpha = 0.5): void {
    this.settled = false
    this.post({ type: 'reheat', alpha })
  }

  positionOf(id: string, out: [number, number, number] = [0, 0, 0]): [number, number, number] | null {
    const i = this.index.get(id)
    if (i === undefined) return null
    out[0] = this.positions[i * 3] ?? 0
    out[1] = this.positions[i * 3 + 1] ?? 0
    out[2] = this.positions[i * 3 + 2] ?? 0
    return out
  }

  dispose(): void {
    this.disposed = true
    this.post({ type: 'stop' })
    this.worker?.terminate()
    this.worker = null
    this.listeners.clear()
  }

  private post(msg: MainToWorker): void {
    if (this.disposed) return
    this.worker?.postMessage(msg)
  }

  private onMessage(msg: WorkerToMain): void {
    if (msg.type === 'ready') {
      this.generation = msg.generation
      return
    }
    if (msg.generation !== this.generation) return
    if (msg.positions.length !== this.ids.length * 3) return
    this.positions = msg.positions as Float32Array<ArrayBuffer>
    this.alpha = msg.alpha
    this.settled = msg.settled
    this.frame++
    this.emit()
  }

  private emit(): void {
    for (const l of this.listeners) l(this)
  }
}
