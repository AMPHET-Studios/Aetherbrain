import type { FolderRole, GraphData, NodeKind } from '@aether/core'
import type { LayoutEdgeInput, LayoutKind, LayoutMode, LayoutNodeInput, LayoutRole, MainToWorker, WorkerToMain } from './protocol'
import { AREA_INDEX, nodeRadius, type PictureSize } from '../theme'

const KIND_CODE: Record<NodeKind, LayoutKind> = { note: 0, ghost: 1, folder: 2, today: 3, image: 4 }
const ROLE_CODE: Record<FolderRole, LayoutRole> = { root: 0, mount: 1, project: 2, folder: 3 }

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
  /**
   * False from `setGraph` until `positions` are the brain's places: a node set most of which was there before is placed
   * at once (its seed is the old places), a new vault only when the worker has answered (its seed is all zeros, and
   * nothing should show that as the brain's places).
   */
  placed = false
  /** False from `setGraph` until the worker has answered for that node set (its first frame is in `positions`). */
  answered = false
  /**
   * The share (0 to 1) of the last `setGraph`'s nodes that were there before, by their own id. High: an edit, a new note,
   * a folder opened; the bodies are where they were and only the new ones grow out of their parents. Low: another vault.
   */
  carried = 0
  /**
   * Orbit rings of the system layout: 6 floats per ring (parentIndex, radius,
   * qx, qy, qz, qw; see protocol). Empty in the other modes.
   */
  rings: Float32Array = new Float32Array(0)
  /**
   * System layout, per node: the radius each star gallery card is drawn with
   * (0 for other nodes), and the radius of each node's system. Empty in the
   * other modes, and until the worker has laid out the current node set
   * (re-indexed from the previous one meanwhile).
   */
  cards: Float32Array = new Float32Array(0)
  extents: Float32Array = new Float32Array(0)
  /** Bumped whenever `rings` is replaced (and with it `cards` and `extents`). */
  ringsVersion = 0
  /** System layout: planets and moons orbit while on (mirrors what the worker was told). */
  motion = true
  /** How big pictures are: their radius spaces the orbits (set before setGraph; see BrainController.setPictureSize). */
  pictureSize: PictureSize = 'medium'
  private worker: Worker | null = null
  private listeners = new Set<TickListener>()
  private errorListeners = new Set<(message: string) => void>()
  /** What the worker last failed with (a thrown error or a reply that could not be read), or null. Until it answers, every node sits at the origin. */
  error: string | null = null
  /**
   * Generation of the last 'graph' message sent. The worker numbers its
   * layouts the same way (one per 'graph' message), so anything it posts for
   * an older node set is dropped, including frames still in flight after a
   * rebuild: their indices belong to the old node order.
   */
  private generation = 0
  private disposed = false

  constructor() {
    if (typeof Worker !== 'undefined') {
      this.worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module', name: 'aether-layout' })
      this.worker.onmessage = (ev: MessageEvent<WorkerToMain>) => this.onMessage(ev.data)
      // A worker that throws (or cannot start) used to fail silently: no positions ever came, every node stayed at the origin
      // (one clumped star, no orbits) and nothing said why. Say it.
      this.worker.onerror = (ev: ErrorEvent) => {
        ev.preventDefault?.()
        this.fail(ev.message || 'the layout worker failed', ev.filename ? `${ev.filename.split('/').pop()}:${ev.lineno}` : '')
      }
      this.worker.onmessageerror = () => this.fail('a layout answer could not be read', '')
    }
  }

  get running(): boolean {
    return !this.settled
  }

  /** Told when the layout worker fails (its message, once per distinct message). */
  onError(cb: (message: string) => void): () => void {
    this.errorListeners.add(cb)
    return () => this.errorListeners.delete(cb)
  }

  private fail(message: string, where: string): void {
    const text = where ? `${message} (${where})` : message
    if (text === this.error) return
    this.error = text
    for (const l of this.errorListeners) l(text)
  }

  onTick(cb: TickListener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  setGraph(graph: GraphData, mode = this.mode, seed = 7): void {
    this.mode = mode
    const prev = this.ids.length ? { ids: this.ids, positions: this.positions } : undefined
    // The old places only count as places if they were (a vault still waiting for its first layout has none).
    const prevPlaced = this.placed
    const nodes: LayoutNodeInput[] = graph.nodes.map((n) => ({
      id: n.id,
      area: AREA_INDEX[n.area] ?? 5,
      degree: n.degree,
      created: n.created,
      ghost: n.ghost,
      radius: nodeRadius(n, this.pictureSize),
      parent: n.parent === null ? -1 : (graph.index.get(n.parent) ?? -1),
      kind: KIND_CODE[n.kind] ?? 0,
      role: n.folder ? (ROLE_CODE[n.folder.role] ?? 3) : -1,
    }))
    graph.nodes.forEach((n, i) => {
      const card = n.image?.gallery
      const anchor = card ? graph.index.get(card.star) : undefined
      if (card && anchor !== undefined) nodes[i]!.gallery = { anchor, rank: card.rank, only: card.only }
    })
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
    // before the worker replies has something sane to draw. New nodes start
    // where their parent was, so they grow out of it instead of the origin.
    const next = new Float32Array(nodes.length * 3)
    let rings: Float32Array = new Float32Array(0)
    let cards: Float32Array = new Float32Array(0)
    let extents: Float32Array = new Float32Array(0)
    let known = 0
    if (prev) {
      const pi = new Map(prev.ids.map((id, i) => [id, i]))
      nodes.forEach((n, i) => {
        let j = pi.get(n.id)
        if (j !== undefined) known++
        else if (n.parent >= 0) j = pi.get(nodes[n.parent]!.id)
        if (j !== undefined) {
          next[i * 3] = prev.positions[j * 3] ?? 0
          next[i * 3 + 1] = prev.positions[j * 3 + 1] ?? 0
          next[i * 3 + 2] = prev.positions[j * 3 + 2] ?? 0
        }
      })
      // Keep drawing the old rings (re-indexed by id) until the worker sends the new ones.
      if (this.rings.length && mode === 'system') {
        const out: number[] = []
        for (let k = 0; k + 5 < this.rings.length; k += 6) {
          const id = prev.ids[this.rings[k]!]
          const p = id === undefined ? undefined : this.index.get(id)
          if (p === undefined) continue
          out.push(p, this.rings[k + 1]!, this.rings[k + 2]!, this.rings[k + 3]!, this.rings[k + 4]!, this.rings[k + 5]!)
        }
        rings = new Float32Array(out)
      }
      // The same for the card sizes and system radii: a rebuild while a gallery is open keeps its cards' size.
      if (mode === 'system' && this.cards.length === prev.ids.length && this.extents.length === prev.ids.length) {
        const pi = new Map(prev.ids.map((id, i) => [id, i]))
        cards = new Float32Array(nodes.length)
        extents = new Float32Array(nodes.length)
        nodes.forEach((n, i) => {
          const j = pi.get(n.id)
          if (j === undefined) return
          cards[i] = n.gallery ? this.cards[j]! : 0
          extents[i] = this.extents[j]!
        })
      }
    }
    this.rings = rings
    this.cards = cards
    this.extents = extents
    this.ringsVersion++
    this.positions = next
    this.settled = false
    this.carried = nodes.length > 0 ? known / nodes.length : 0
    this.answered = false
    this.placed = prevPlaced && this.carried >= 0.5
    this.frame++
    const msg: MainToWorker = { type: 'graph', nodes, edges, mode, seed }
    if (prev) msg.prev = { ids: prev.ids, positions: prev.positions }
    this.generation++
    this.post(msg)
    this.emit()
  }

  setMode(mode: LayoutMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.settled = false
    if (mode !== 'system' && (this.rings.length || this.cards.length || this.extents.length)) {
      this.rings = new Float32Array(0)
      this.cards = new Float32Array(0)
      this.extents = new Float32Array(0)
      this.ringsVersion++
    }
    this.post({ type: 'mode', mode })
  }

  /** System layout: start or stop the orbit motion. */
  setMotion(on: boolean): void {
    if (this.motion === on) return
    this.motion = on
    this.post({ type: 'motion', on })
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
    if (msg.type === 'ready' || msg.generation !== this.generation) return
    if (msg.type === 'rings') {
      this.rings = msg.rings
      // Per-node arrays only when they fit the node set.
      const n = this.ids.length
      this.cards = msg.cards.length === n ? msg.cards : new Float32Array(0)
      this.extents = msg.extent.length === n ? msg.extent : new Float32Array(0)
      this.ringsVersion++
      return
    }
    if (msg.positions.length !== this.ids.length * 3) return
    this.error = null
    this.positions = msg.positions as Float32Array<ArrayBuffer>
    this.placed = true
    this.answered = true
    this.alpha = msg.alpha
    this.settled = msg.settled
    this.frame++
    this.emit()
  }

  private emit(): void {
    for (const l of this.listeners) l(this)
  }
}
