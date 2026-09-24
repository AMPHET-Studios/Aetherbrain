import type { GraphData, NoteId } from '@aether/core'
import { LayoutEngine } from './layout/LayoutEngine'
import type { LayoutMode } from './layout/protocol'
import { nodeRadius, type ColorMode } from './theme'

export interface BrainEvents {
  onSelect?: (id: NoteId | null) => void
  onOpen?: (id: NoteId) => void
  onHover?: (id: NoteId | null) => void
}

export interface CameraLike {
  flyTo(x: number, y: number, z: number, distance: number, smooth?: boolean): void
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
    this.engine.setGraph(graph, this.layoutMode)
    if (this.selected && !graph.index.has(this.selected)) this.selected = null
    if (this.hovered && !graph.index.has(this.hovered)) this.hovered = null
    // A brand-new vault gets framed as soon as positions arrive, and again
    // once the physics settle. Incremental rebuilds keep the camera put.
    if (fresh) {
      this.fitPending = true
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
    this.touch()
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
    this.camera.flyTo(cx, cy, cz, distance, smooth)
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

  setLayoutMode(mode: LayoutMode): void {
    if (this.layoutMode === mode) return
    this.layoutMode = mode
    this.engine.setMode(mode)
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
    // Default distance scales with the neuron so hubs don't fill the screen.
    const node = this.graph?.nodes[this.graph.index.get(id) ?? -1]
    const d = distance ?? 34 + (node ? nodeRadius(node) * 10 : 10)
    this.camera.flyTo(p[0], p[1], p[2], d)
    return true
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
