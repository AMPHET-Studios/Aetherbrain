import type { GraphData, GraphNode, NoteId } from '@aether/core'
import { LayoutEngine } from './layout/LayoutEngine'
import type { LayoutMode } from './layout/protocol'
import { nodeRadius, type ColorMode } from './theme'

export interface BrainEvents {
  onSelect?: (id: NoteId | null) => void
  onOpen?: (id: NoteId) => void
  onHover?: (id: NoteId | null) => void
}

/** Default depth of the view: the camera's far plane and how far the user can dolly out. */
export const DEFAULT_FAR = 12000
export const DEFAULT_MAX_DISTANCE = 5000

/**
 * How deep the view must reach for a scene framed from `distance` (the
 * distance `fitToGraph` puts the camera at): the far plane sees the whole
 * framed sphere and then some, and the user can dolly out to twice the
 * framing distance. Never below the defaults. A drive's solar system can be
 * tens of thousands of units across; with a fixed far plane it rendered as
 * an empty sky.
 */
export function cameraRange(distance: number): { far: number; maxDistance: number } {
  const d = Number.isFinite(distance) && distance > 0 ? distance : 0
  return { far: Math.max(DEFAULT_FAR, d * 4), maxDistance: Math.max(DEFAULT_MAX_DISTANCE, d * 2) }
}

export interface CameraLike {
  /**
   * Look at (x, y, z) from `distance`, keeping the current view direction but
   * raised to at least `minElevation` radians above the horizon when given.
   */
  flyTo(x: number, y: number, z: number, distance: number, smooth?: boolean, minElevation?: number): void
  /**
   * Make the view deep enough for a scene framed from `distance`: far plane
   * and maximum dolly distance per `cameraRange(distance)`. Called by
   * `fitToGraph` before it flies there.
   */
  setRange(distance: number): void
  reset(): void
  orbit(dAzimuth: number, dPolar: number): void
  dolly(delta: number): void
  truck(dx: number, dy: number): void
  setEnabled(v: boolean): void
  /** Shift the focal point sideways by a fraction of the viewport width (−1..1). */
  setShift(fraction: number): void
}

/**
 * Imperative view state for the 3D scene. The UI layer mutates it (from its
 * Zustand store) and the scene reads it every frame; React never re-renders
 * the Canvas subtree for hover/selection churn.
 */
export class BrainController {
  readonly engine = new LayoutEngine()
  graph: GraphData | null = null
  selected: NoteId | null = null
  hovered: NoteId | null = null
  /** When set, everything outside the set is dimmed (search results, filters). */
  highlight: Set<NoteId> | null = null
  colorMode: ColorMode = 'area'
  layoutMode: LayoutMode = 'constellation'
  /** System layout: planets and moons orbit their parents over time. */
  motion = true
  /** The camera follows the selected node while it orbits (system layout, motion on). */
  follow = true
  activeTag: string | null = null
  /** Show labels for the largest hubs even when nothing is selected. */
  hubLabels = true
  bloom = true
  /** Bumped whenever a visual property changes; the scene diffs against it. */
  version = 0
  events: BrainEvents = {}
  camera: CameraLike | null = null
  private cameraListeners = new Set<() => void>()

  private fitPending = false
  private fitRefit = false
  private unTick: (() => void) | null = null

  setGraph(graph: GraphData): void {
    const fresh = !this.graph || this.graph.nodes.length === 0
    this.graph = graph
    // `motion` may have been assigned directly: make sure the worker agrees.
    this.engine.setMotion(this.motion)
    this.engine.setGraph(graph, this.layoutMode)
    if (this.selected && !graph.index.has(this.selected)) this.selected = null
    if (this.hovered && !graph.index.has(this.hovered)) this.hovered = null
    // A brand-new vault gets framed as soon as positions arrive, and again
    // once the physics settle. Incremental rebuilds keep the camera put.
    if (fresh) {
      this.fitPending = true
      this.armRefit()
    }
    this.touch()
  }

  /** Refit the camera to the whole graph on the next settled layout frame (once). */
  private armRefit(): void {
    this.fitRefit = true
    this.unTick ??= this.engine.onTick((eng) => {
      if (this.fitPending && eng.frame > 1) {
        this.fitPending = false
        this.fitToGraph(false)
      }
      if (this.fitRefit && eng.settled) {
        this.fitRefit = false
        this.fitToGraph(true)
      }
    })
  }

  /** Frame the whole graph: bounding sphere → camera distance from the vertical FOV. */
  fitToGraph(smooth = true): boolean {
    const p = this.engine.positions
    const n = p.length / 3
    if (!this.camera || n === 0) return false
    let cx = 0
    let cy = 0
    let cz = 0
    for (let i = 0; i < n; i++) {
      cx += p[i * 3] ?? 0
      cy += p[i * 3 + 1] ?? 0
      cz += p[i * 3 + 2] ?? 0
    }
    cx /= n
    cy /= n
    cz /= n
    // Robust radius: ignore the few outliers physics flings out so the bulk of
    // the brain fills the frame.
    const d2 = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const dx = (p[i * 3] ?? 0) - cx
      const dy = (p[i * 3 + 1] ?? 0) - cy
      const dz = (p[i * 3 + 2] ?? 0) - cz
      d2[i] = dx * dx + dy * dy + dz * dz
    }
    d2.sort()
    const radius = Math.max(30, Math.sqrt(d2[Math.min(n - 1, Math.floor(n * 0.92))] ?? 0) * 1.12)
    const fov = (55 * Math.PI) / 180
    const distance = (radius / Math.sin(fov / 2)) * 0.95
    // The far plane and the dolly limit follow the scene's size, so a huge
    // system is not clipped away (nor snapped back in on the first wheel tick).
    this.camera.setRange(distance)
    // Solar systems are flat-ish discs: look at them from above, not edge-on.
    this.camera.flyTo(cx, cy, cz, distance, smooth, this.layoutMode === 'system' ? 0.55 : undefined)
    return true
  }

  setSelected(id: NoteId | null): void {
    if (this.selected === id) return
    this.selected = id
    this.touch()
  }

  setHovered(id: NoteId | null): void {
    if (this.hovered === id) return
    this.hovered = id
    this.touch()
  }

  setHighlight(ids: Set<NoteId> | null): void {
    this.highlight = ids
    this.touch()
  }

  setColorMode(mode: ColorMode): void {
    if (this.colorMode === mode) return
    this.colorMode = mode
    this.touch()
  }

  setActiveTag(tag: string | null): void {
    if (this.activeTag === tag) return
    this.activeTag = tag
    this.touch()
  }

  /**
   * Switch layout; pass the rebuilt graph when the node set changes (system ↔
   * others: only system graphs carry folder nodes). With a graph the worker
   * gets one 'graph' message in the new mode. A real mode change reframes the
   * camera once the new layout settles; a same-mode rebuild (depth, expand)
   * keeps the camera where it is.
   */
  setLayoutMode(mode: LayoutMode, graph?: GraphData): void {
    const changed = this.layoutMode !== mode
    if (!changed && !graph) return
    this.layoutMode = mode
    if (graph) this.setGraph(graph)
    else this.engine.setMode(mode)
    if (changed) this.armRefit()
    this.touch()
  }

  /** System layout: start or stop the orbit motion. */
  setMotion(on: boolean): void {
    if (this.motion === on) return
    this.motion = on
    this.engine.setMotion(on)
    this.touch()
  }

  setBloom(v: boolean): void {
    if (this.bloom === v) return
    this.bloom = v
    this.touch()
  }

  setHubLabels(v: boolean): void {
    this.hubLabels = v
    this.touch()
  }

  /** Smoothly move the camera to frame a node. */
  flyTo(id: NoteId, distance?: number): boolean {
    const p = this.engine.positionOf(id)
    if (!p || !this.camera) return false
    // Default distance scales with the neuron so hubs don't fill the screen;
    // folders back off far enough to show the planets and moons around them.
    const node = this.graph?.nodes[this.graph.index.get(id) ?? -1]
    const d = distance ?? (node?.kind === 'folder' ? this.systemDistance(id, p, node) : 34 + (node ? nodeRadius(node) * 10 : 10))
    this.camera.flyTo(p[0], p[1], p[2], d)
    return true
  }

  /** Camera distance that frames a folder's system: its furthest live child, else a radius-based guess. */
  private systemDistance(id: NoteId, p: [number, number, number], node: GraphNode): number {
    const nodes = this.graph?.nodes ?? []
    const pos = this.engine.positions
    let far = 0
    for (let i = 0; i < nodes.length; i++) {
      const c = nodes[i]!
      if (c.parent !== id) continue
      const dx = (pos[i * 3] ?? 0) - p[0]
      const dy = (pos[i * 3 + 1] ?? 0) - p[1]
      const dz = (pos[i * 3 + 2] ?? 0) - p[2]
      far = Math.max(far, Math.sqrt(dx * dx + dy * dy + dz * dz) + nodeRadius(c) * 3)
    }
    const r = nodeRadius(node)
    // A sphere of radius `far` fills the 55° view at far / sin(27.5°) ≈ 2.17 far.
    return Math.min(3000, far > r * 2 ? far * 2.3 : 34 + r * 14)
  }

  resetCamera(): void {
    if (!this.fitToGraph(true)) this.camera?.reset()
  }

  registerCamera(cam: CameraLike | null): void {
    this.camera = cam
    cam?.setShift(this.viewShift)
    for (const l of this.cameraListeners) l()
  }

  /** Fraction of the viewport the focus is pushed right (e.g. while the editor panel is open). */
  viewShift = 0
  setViewShift(fraction: number): void {
    if (this.viewShift === fraction) return
    this.viewShift = fraction
    this.camera?.setShift(fraction)
  }

  onCameraReady(cb: () => void): () => void {
    this.cameraListeners.add(cb)
    return () => this.cameraListeners.delete(cb)
  }

  touch(): void {
    this.version++
    for (const l of this.subs) l()
  }

  /** Subscribe to any visual/structural change (used by the scene via useSyncExternalStore). */
  subscribe(cb: () => void): () => void {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }

  private subs = new Set<() => void>()

  dispose(): void {
    this.unTick?.()
    this.unTick = null
    this.engine.dispose()
    this.subs.clear()
  }
}
