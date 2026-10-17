import type { GraphData, GraphNode, NoteId } from '@aether/core'
import { GALLERY_DWELL_MS, GALLERY_FOLD_MS, GALLERY_FRAMING_MS, GALLERY_REACH_MS, nearestStar as starNearCamera } from './gallery'
import { LayoutEngine } from './layout/LayoutEngine'
import type { LayoutMode } from './layout/protocol'
import { nodeRadius, type ColorMode, type PictureSize } from './theme'

/**
 * Loads a picture preview: at most `size` px on its longer side, or null when
 * it can't be read. Set from the vault adapter's `thumbnail`.
 */
export type ThumbnailLoader = (path: string, size: number) => Promise<Blob | null>

export interface BrainEvents {
  onSelect?: (id: NoteId | null) => void
  onOpen?: (id: NoteId) => void
  onHover?: (id: NoteId | null) => void
  /**
   * Show the gallery of this project star (its folder id), or none. The
   * owner rebuilds the graph with that gallery (`images.gallery`) and hands
   * it back through `setGraph` / `setLayoutMode`.
   */
  onGallery?: (star: NoteId | null) => void
  /** The layout worker failed (see `LayoutEngine.onError`): until it answers, every body sits at the origin. */
  onLayoutError?: (message: string) => void
}

/**
 * Who serves a star screen (see `StarScreen`): the desktop app streams the
 * Concept Forge window's frames into it.
 */
export interface ScreenHost {
  /** The screen came into view (frames are wanted from now on) or folded away (none are). */
  want(on: boolean): void
  /** The user clicked the screen, or pressed Enter while it was open: open the app itself. */
  activate(): void
}

/** A live screen floating above one project star (system layout), shown while the camera is close to it. */
export interface StarScreen {
  /** The star (its folder id). */
  star: NoteId
  host: ScreenHost
  /** Shown on the screen until its first frame arrives (one or two short lines). */
  placeholder?: string
}

/** One picture of the screen: 4 bytes per pixel, rows from the top. */
export interface ScreenFrame {
  data: Uint8Array
  width: number
  height: number
  /** True for BGRA (what Electron's frames are), false for RGBA. */
  bgra: boolean
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
  /** Where the camera is now, or where its flight ends (world space). */
  getPosition?(out: [number, number, number]): [number, number, number]
  /** The point the camera looks at (or will, once its flight ends). */
  getTarget?(out: [number, number, number]): [number, number, number]
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
  /** System layout: urgency speeds an orbit up less, never past a normal orbit (`calmSpeed`). */
  calm = false
  /** The camera follows the selected node while it orbits (system layout, motion on). */
  follow = true
  activeTag: string | null = null
  /** Show labels for the largest hubs even when nothing is selected. */
  hubLabels = true
  bloom = true
  private loader: ThumbnailLoader | null = null
  private thumbsOn = true
  /**
   * Where image moons get their pictures (null: plain moons, no thumbnails).
   * A new loader is a new vault: the scene forgets every picture it holds.
   */
  get thumbnails(): ThumbnailLoader | null {
    return this.loader
  }
  set thumbnails(loader: ThumbnailLoader | null) {
    if (this.loader === loader) return
    this.loader = loader
    this.touch()
  }
  /**
   * How big pictures are drawn (`PICTURE_RADIUS`). The layout spaces orbits by it, so a change takes a
   * new graph: the store rebuilds it right after (`setGraph`), and the scene and the layout read the size then.
   */
  get pictureSize(): PictureSize {
    return this.engine.pictureSize
  }
  set pictureSize(size: PictureSize) {
    this.engine.pictureSize = size
  }
  /** Draw picture thumbnails on image moons (when a loader is set). */
  get showThumbnails(): boolean {
    return this.thumbsOn
  }
  set showThumbnails(on: boolean) {
    if (this.thumbsOn === on) return
    this.thumbsOn = on
    this.touch()
  }
  /**
   * Star galleries open by themselves when the camera comes close to a
   * project star (system layout). Off: only Shift+G (`openGallery`) opens one.
   */
  get galleries(): boolean {
    return this.galleryAuto
  }
  set galleries(on: boolean) {
    if (this.galleryAuto === on) return
    this.galleryAuto = on
    this.applyGallery()
  }
  /** The star whose gallery the graph shows (its folder id), or null. */
  get gallery(): NoteId | null {
    return this.graph?.gallery?.star ?? null
  }
  /** When the open gallery started folding (performance.now() ms), −1 while it isn't: the scene shrinks its cards. */
  galleryFold = -1
  /** The project star the camera was last found close to (`nearStar`). */
  get nearId(): NoteId | null {
    return this.galleryNear
  }
  /**
   * The star the camera is measured against first (hysteresis): the one opened
   * with Shift+G, else the gallery asked for, else the last star found close.
   */
  get galleryHeld(): NoteId | null {
    return this.galleryManual ?? this.galleryWanted ?? this.galleryNear
  }
  private galleryAuto = true
  /** The project star the camera is close to (the scene reports it), and since when (performance.now() ms). */
  private galleryNear: NoteId | null = null
  private nearSince = 0
  /** Opened with Shift+G: held open until the camera has reached the star and left it again. */
  private galleryManual: NoteId | null = null
  private galleryReached = false
  /** Closed with Shift+G while close to it: stays shut until the camera leaves that star. */
  private galleryDismissed: NoteId | null = null
  /** What the owner was last asked to show (`onGallery`). */
  private galleryWanted: NoteId | null = null
  private foldTimer: ReturnType<typeof setTimeout> | null = null
  private reachTimer: ReturnType<typeof setTimeout> | null = null
  /** Asks again once the camera has dwelt near a star (or the first framing is over). */
  private dwellTimer: ReturnType<typeof setTimeout> | null = null
  /** Bumped whenever a visual property changes; the scene diffs against it. */
  version = 0

  /** The live screen above a star (desktop: Concept Forge), or null. */
  screen: StarScreen | null = null
  /** Its latest picture, and a counter the scene diffs against (frames arrive without a re-render). */
  screenFrame: ScreenFrame | null = null
  screenFrameVersion = 0
  private screenIsOpen = false

  /** True while the screen is on view (the camera is close to its star). */
  get screenOpen(): boolean {
    return this.screenIsOpen
  }

  /** Show a live screen above a star, or none. The same star and host keep the screen (and its frames) as they are. */
  setScreen(screen: StarScreen | null): void {
    const old = this.screen
    if (old?.star === screen?.star && old?.host === screen?.host) {
      if (old && screen && old.placeholder !== screen.placeholder) {
        this.screen = screen
        this.touch()
      }
      return
    }
    if (old && this.screenIsOpen) old.host.want(false)
    this.screenIsOpen = false
    this.screen = screen
    this.screenFrame = null
    this.screenFrameVersion++
    this.touch()
  }

  /** A new picture for the screen (drawn on the next frame; no re-render). */
  pushScreenFrame(frame: ScreenFrame): void {
    if (!this.screen) return
    this.screenFrame = frame
    this.screenFrameVersion++
  }

  /** The scene: the screen came into view or folded away. Its host is told (frames wanted or not). */
  screenShown(open: boolean): void {
    if (open === this.screenIsOpen) return
    this.screenIsOpen = open
    this.screen?.host.want(open)
    this.touch()
  }

  /** Open the screen's app (a click on it, Enter while it is open). */
  activateScreen(): void {
    this.screen?.host.activate()
  }

  /** How long (ms, at `now`) the camera has been close to the star it is close to (`nearId`); 0 when none. */
  nearFor(now: number): number {
    return this.galleryNear === null ? 0 : Math.max(0, now - this.nearSince)
  }
  events: BrainEvents = {}
  /** The layout worker's failures go to the owner (the engine tells once per distinct message). */
  private readonly unError = this.engine.onError((m) => this.events.onLayoutError?.(m))
  camera: CameraLike | null = null
  private cameraListeners = new Set<() => void>()

  private fitPending = false
  private fitRefit = false
  /** When the last framing flight was armed (performance.now() ms). */
  private refitArmedAt = 0
  private unTick: (() => void) | null = null

  setGraph(graph: GraphData): void {
    const fresh = !this.graph || this.graph.nodes.length === 0
    this.graph = graph
    // `motion` and `calm` may have been assigned directly: make sure the worker agrees.
    this.engine.setMotion(this.motion)
    this.engine.setCalm(this.calm)
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

  /** Frame the whole graph again once the layout has settled (after a change that moves everything). */
  refitWhenSettled(): void {
    this.armRefit()
  }

  /** Refit the camera to the whole graph on the next settled layout frame (once). */
  private armRefit(): void {
    this.fitRefit = true
    this.refitArmedAt = performance.now()
    this.unTick ??= this.engine.onTick((eng) => {
      if (this.fitPending && eng.frame > 1) {
        this.fitPending = false
        this.fitToGraph(false)
      }
      if (this.fitRefit && eng.settled) {
        this.fitRefit = false
        this.fitToGraph(true)
        // Galleries held back during the framing may open now, once the camera has stayed near a star
        // where this flight takes it (the scene measures the new destination within the dwell).
        this.nearSince = performance.now()
        this.applyGallery()
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
    // Stars exist only in the system layout: leaving it lets the gallery go.
    if (changed && mode !== 'system') {
      this.galleryNear = null
      this.galleryManual = null
      this.galleryDismissed = null
      this.applyGallery()
    }
    this.touch()
  }

  /* ---- star galleries ---- */

  /** The scene: the project star the camera is close to now (null: none). Opens or folds galleries. */
  nearStar(id: NoteId | null): void {
    if (id === this.galleryNear) return
    this.galleryNear = id
    this.nearSince = performance.now()
    if (id !== this.galleryDismissed) this.galleryDismissed = null
    if (this.galleryManual !== null) {
      if (id === this.galleryManual) this.galleryReached = true
      else if (this.galleryReached) this.galleryManual = null
    }
    this.applyGallery()
  }

  /**
   * Open a star's gallery now (Shift+G), wherever the camera is. It stays
   * open while the camera flies there, until the camera has reached the star
   * and left it again (or GALLERY_REACH_MS passed without reaching it).
   */
  openGallery(star: NoteId): void {
    this.galleryManual = star
    this.galleryReached = this.galleryNear === star
    this.galleryDismissed = null
    if (this.reachTimer) clearTimeout(this.reachTimer)
    this.reachTimer = setTimeout(() => {
      this.reachTimer = null
      if (this.galleryManual !== star || this.galleryReached) return
      this.galleryReached = true
      if (this.galleryNear !== star) this.galleryManual = null
      this.applyGallery()
    }, GALLERY_REACH_MS)
    this.applyGallery()
  }

  /** Fold the open gallery (Shift+G). Close to its star, it stays shut until the camera leaves the star. */
  closeGallery(): void {
    const open = this.galleryWanted
    this.galleryManual = null
    if (open !== null && open === this.galleryNear) this.galleryDismissed = open
    this.applyGallery()
  }

  /** Forget every gallery state (another vault); nothing is folded or asked for. */
  resetGallery(): void {
    this.cancelFold()
    this.cancelDwell()
    if (this.reachTimer) clearTimeout(this.reachTimer)
    this.reachTimer = null
    this.galleryNear = null
    this.galleryManual = null
    this.galleryReached = false
    this.galleryDismissed = null
    this.galleryWanted = null
  }

  /**
   * The project star the camera looks at most closely, relative to the size
   * of its system, however far (null: no stars, no camera or no system layout
   * yet).
   */
  nearestStar(): NoteId | null {
    const g = this.graph
    const cam = this.camera?.getPosition?.([0, 0, 0])
    const look = this.camera?.getTarget?.([0, 0, 0]) ?? cam
    const pos = this.engine.positions
    const extents = this.engine.extents
    if (!g || !cam || !look || this.layoutMode !== 'system' || extents.length !== g.nodes.length || pos.length < g.nodes.length * 3) return null
    const stars: number[] = []
    g.nodes.forEach((n, i) => n.folder?.role === 'project' && stars.push(i))
    const i = starNearCamera(stars, pos, extents, cam[0], cam[1], cam[2], look[0], look[1], look[2], -1, Infinity)
    return i >= 0 ? (g.nodes[i]?.id ?? null) : null
  }

  /** Ask the owner for the gallery the camera and Shift+G call for; a gallery going away folds first. */
  private applyGallery(): void {
    const system = this.layoutMode === 'system'
    const manual = system && this.galleryManual !== null
    let want: NoteId | null = null
    if (manual) want = this.galleryManual
    else if (system && this.galleryAuto && this.galleryNear !== this.galleryDismissed) want = this.galleryNear
    if (want !== null && want === this.galleryWanted) {
      this.cancelFold()
      this.cancelDwell()
      return
    }
    if (want !== null) {
      // Opening by itself waits until the camera has stayed near the star, outside the first framing
      // flight; the gallery open meanwhile (another star's) folds.
      const wait = manual ? 0 : this.galleryReadyAt() - performance.now()
      if (wait <= 0) {
        this.cancelFold()
        this.cancelDwell()
        this.galleryWanted = want
        this.events.onGallery?.(want)
        return
      }
      this.cancelDwell()
      this.dwellTimer = setTimeout(() => {
        this.dwellTimer = null
        this.applyGallery()
      }, wait)
    } else {
      this.cancelDwell()
    }
    if (this.galleryWanted === null || this.foldTimer) return
    if (!system) {
      // Nothing is drawn to fold.
      this.galleryWanted = null
      this.events.onGallery?.(null)
      return
    }
    // Fold: the scene shrinks the cards, then the owner lets them go.
    this.galleryFold = performance.now()
    this.foldTimer = setTimeout(() => {
      this.foldTimer = null
      this.galleryFold = -1
      this.galleryWanted = null
      this.events.onGallery?.(null)
      this.touch()
    }, GALLERY_FOLD_MS)
    this.touch()
  }

  /** When a gallery may open by itself (performance.now() ms). */
  private galleryReadyAt(): number {
    let at = this.nearSince + GALLERY_DWELL_MS
    if (this.camera && (this.fitPending || this.fitRefit)) at = Math.max(at, this.refitArmedAt + GALLERY_FRAMING_MS)
    return at
  }

  private cancelDwell(): void {
    if (this.dwellTimer) clearTimeout(this.dwellTimer)
    this.dwellTimer = null
  }

  private cancelFold(): void {
    if (!this.foldTimer) return
    clearTimeout(this.foldTimer)
    this.foldTimer = null
    this.galleryFold = -1
    this.touch()
  }

  /** System layout: start or stop the orbit motion. */
  setMotion(on: boolean): void {
    if (this.motion === on) return
    this.motion = on
    this.engine.setMotion(on)
    this.touch()
  }

  /** System layout: calm orbits on or off (nothing jumps: see `LayoutEngine.setCalm`). */
  setCalm(on: boolean): void {
    if (this.calm === on) return
    this.calm = on
    this.engine.setCalm(on)
    this.touch()
  }

  setBloom(v: boolean): void {
    if (this.bloom === v) return
    this.bloom = v
    this.touch()
  }

  /**
   * While on, the 3D view is not drawn when its window is not the one in front. A viewer reading the scene (the Unreal
   * companion) needs the graphics card for itself, and the layout it reads from runs without any drawing.
   */
  restBehind = false

  setRestBehind(on: boolean): void {
    if (this.restBehind === on) return
    this.restBehind = on
    this.touch()
  }

  /**
   * While on, the 3D view is not drawn: a full-window panel (the Boards view, the Projects board) covers it, so every frame (bloom
   * included) would be paid for by a board's pans and a list's scrolling and seen by nobody. The layout keeps running (positions are
   * not drawing), and the first frame after it goes off again is a plain redraw.
   */
  covered = false

  setCovered(on: boolean): void {
    if (this.covered === on) return
    this.covered = on
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
    const node = this.graph?.nodes[this.graph.index.get(id) ?? -1]
    this.camera.flyTo(p[0], p[1], p[2], distance ?? this.nodeDistance(id, p, node))
    return true
  }

  /**
   * Default distance scales with the neuron so hubs don't fill the screen;
   * folders back off far enough to show the planets and moons around them.
   * The Today hub is seen with some of its beams around it; a picture moon
   * comes close enough for its thumbnail to read.
   */
  private nodeDistance(id: NoteId, p: [number, number, number], node: GraphNode | undefined): number {
    if (!node) return 44
    // A folder star and a board sun are framed whole: with the planets or pictures that orbit it.
    if (node.kind === 'folder' || node.board) return this.systemDistance(id, p, node)
    if (node.kind === 'today') return 90
    if (node.kind === 'image') {
      // A gallery card is bigger than a moon: come close enough for it to fill a third of the view.
      const card = this.engine.cards[this.engine.index.get(id) ?? -1] ?? 0
      return Math.max(26, card * 7, nodeRadius(node, this.pictureSize) * 5)
    }
    return 34 + nodeRadius(node, this.pictureSize) * 10
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
      far = Math.max(far, Math.sqrt(dx * dx + dy * dy + dz * dz) + nodeRadius(c, this.pictureSize) * 3)
    }
    const r = nodeRadius(node, this.pictureSize)
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
    this.unError()
    this.setScreen(null)
    this.resetGallery()
    this.unTick?.()
    this.unTick = null
    this.engine.dispose()
    this.subs.clear()
  }
}
