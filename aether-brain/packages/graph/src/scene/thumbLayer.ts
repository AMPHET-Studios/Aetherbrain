import {
  DataArrayTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  PlaneGeometry,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type ShaderMaterial,
} from 'three'
import type { GraphData } from '@aether/core'
import type { BrainController, ThumbnailLoader } from '../BrainController'
import { createThumbMaterial } from './materials'
import {
  THUMB_LAYERS,
  THUMB_HOVER_SCALE,
  THUMB_REQUEST,
  THUMB_SCALE,
  THUMB_SELECTED_SCALE,
  THUMB_SIZE,
  THUMB_TICK_MS,
  ThumbScheduler,
  coverRect,
  rankThumbCandidates,
  thumbKey,
} from './thumbs'

/** Bytes of one texture layer. */
const LAYER_BYTES = THUMB_SIZE * THUMB_SIZE * 4
/** New pictures reach the GPU (and their nodes) at most this often (ms): one mipmap rebuild per batch. */
const FLUSH_MS = 120
/** What shows through the transparent parts of a picture: a dark card. */
const BACKDROP = '#151827'

/** The image nodes of one graph, as the thumbnail layer needs them. */
export interface ThumbTargets {
  /** Graph indices of the image nodes. */
  nodes: Int32Array
  /** Picture key (`thumbKey`) and vault path per entry of `nodes`. */
  keys: string[]
  paths: string[]
  /** Per graph node: 1 while its picture is drawn (the scene shrinks its core and drops its halo). */
  shown: Uint8Array
}

export function thumbTargets(graph: GraphData): ThumbTargets {
  const idx: number[] = []
  const keys: string[] = []
  const paths: string[] = []
  graph.nodes.forEach((n, i) => {
    if (n.kind !== 'image' || !n.image) return
    idx.push(i)
    keys.push(thumbKey(n.image))
    paths.push(n.image.path)
  })
  return { nodes: Int32Array.from(idx), keys, paths, shown: new Uint8Array(graph.nodes.length) }
}

/** What the layer reads from the scene's per-graph buffers each frame. */
export interface ThumbView {
  thumbs: ThumbTargets
  /** 4 floats per node: screen x, y, NDC depth, projected radius (px). */
  screen: Float32Array
  radii: Float32Array
  /** 4 floats per node; [1] is the dim state (0.12..1). */
  glow: { array: ArrayLike<number> }
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/**
 * The thumbnail piece of the scene: ONE instanced billboard mesh sampling ONE
 * texture array of `THUMB_LAYERS` pictures. It picks the image moons worth a
 * picture every `THUMB_TICK_MS` from the screen projection the scene already
 * computes, loads them through the controller's `thumbnails` loader
 * (decoded with `createImageBitmap`, cover-cropped into a 128² canvas) and
 * keeps them by picture key, so graph rebuilds never reload anything. The
 * texture (16 MB) is only allocated once the first picture arrives.
 */
export class ThumbLayer {
  readonly mesh: Mesh
  private readonly geometry: InstancedBufferGeometry
  private readonly material: ShaderMaterial
  private readonly center: InstancedBufferAttribute
  private readonly size: InstancedBufferAttribute
  private readonly layer: InstancedBufferAttribute
  private readonly alpha: InstancedBufferAttribute
  private readonly scheduler: ThumbScheduler<Uint8ClampedArray>
  private texture: DataArrayTexture | null = null
  private ctx: Ctx2D | null = null
  private loader: ThumbnailLoader | null = null
  private on = false
  private targets: ThumbTargets | null = null
  /** Scheduler version the node → layer mapping reflects (−1: map again now). */
  private mapped = -1
  /** Graph index per instance. */
  private readonly instNode = new Int32Array(THUMB_LAYERS)
  private count = 0
  private lastTick = -Infinity
  private lastFlush = -Infinity
  private readonly ranked: number[] = []
  private readonly wantKeys: string[] = []
  private readonly wantPaths: string[] = []

  constructor() {
    const plane = new PlaneGeometry(1, 1)
    this.geometry = new InstancedBufferGeometry()
    this.geometry.setIndex(plane.getIndex())
    this.geometry.setAttribute('position', plane.getAttribute('position'))
    this.geometry.setAttribute('uv', plane.getAttribute('uv'))
    const attr = (itemSize: number, dynamic: boolean) => {
      const a = new InstancedBufferAttribute(new Float32Array(THUMB_LAYERS * itemSize), itemSize)
      if (dynamic) a.setUsage(DynamicDrawUsage)
      return a
    }
    this.center = attr(3, true)
    this.size = attr(1, true)
    this.layer = attr(1, false)
    this.alpha = attr(1, true)
    this.geometry.setAttribute('iCenter', this.center)
    this.geometry.setAttribute('iSize', this.size)
    this.geometry.setAttribute('iLayer', this.layer)
    this.geometry.setAttribute('iAlpha', this.alpha)
    this.geometry.instanceCount = 0
    this.material = createThumbMaterial()
    this.mesh = new Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    // Before every transparent pass: edges, rings and halos then depth-test against the pictures.
    this.mesh.renderOrder = -1
    this.scheduler = new ThumbScheduler<Uint8ClampedArray>({
      load: (path) => this.load(path),
      store: (layer, picture) => this.store(layer, picture),
    })
  }

  /**
   * One frame: follow the controller's loader and switch, rank and request
   * pictures every tick, upload new ones, and write the instances from the
   * live positions. Returns true when the set of nodes showing a picture
   * changed (the caller rewrites the core and halo matrices).
   */
  update(
    view: ThumbView,
    c: BrainController,
    pos: Float32Array,
    selI: number,
    hovI: number,
    width: number,
    height: number,
    now: number,
  ): boolean {
    const t = view.thumbs
    if (c.thumbnails !== this.loader) {
      // Another vault (or none): its pictures are not ours, not even for a frame.
      this.loader = c.thumbnails
      this.scheduler.reset()
      this.mapped = -1
    }
    const on = c.showThumbnails && this.loader !== null
    // Switched back on: pictures that failed before get another try.
    if (on && !this.on) this.scheduler.retryFailed()
    this.on = on
    // A new graph: map its nodes now; rank them once the scene has projected them (next frame).
    const fresh = t !== this.targets
    if (fresh) {
      this.targets = t
      this.mapped = -1
    }
    if (!on) {
      this.mesh.visible = false
      this.mapped = -1
      if (this.count === 0) return false
      t.shown.fill(0)
      this.count = 0
      this.geometry.instanceCount = 0
      return true
    }

    if (!fresh && now - this.lastTick >= THUMB_TICK_MS) {
      this.lastTick = now
      const ranked = rankThumbCandidates(view.screen, t.nodes, width, height, this.ranked, THUMB_LAYERS)
      this.wantKeys.length = 0
      this.wantPaths.length = 0
      for (let r = 0; r < ranked.length; r++) {
        const k = ranked[r]!
        this.wantKeys.push(t.keys[k]!)
        this.wantPaths.push(t.paths[k]!)
      }
      this.scheduler.want(this.wantKeys, this.wantPaths, this.wantKeys.length, now)
    }

    // New pictures reach the GPU and their nodes in the same frame, so a
    // reused layer never shows its old picture on its new node.
    let changed = false
    if (this.mapped !== this.scheduler.version && (this.mapped === -1 || now - this.lastFlush >= FLUSH_MS)) {
      this.lastFlush = now
      if (this.texture && this.texture.layerUpdates.size > 0) this.texture.needsUpdate = true
      this.remap(t)
      changed = true
    }

    const center = this.center.array as Float32Array
    const size = this.size.array as Float32Array
    const alpha = this.alpha.array as Float32Array
    const glow = view.glow.array
    for (let j = 0; j < this.count; j++) {
      const i = this.instNode[j]!
      center[j * 3] = pos[i * 3] ?? 0
      center[j * 3 + 1] = pos[i * 3 + 1] ?? 0
      center[j * 3 + 2] = pos[i * 3 + 2] ?? 0
      let s = (view.radii[i] ?? 1) * THUMB_SCALE
      if (i === selI) s *= THUMB_SELECTED_SCALE
      else if (i === hovI) s *= THUMB_HOVER_SCALE
      size[j] = s
      alpha[j] = glow[i * 4 + 1] ?? 1
    }
    if (this.count > 0) {
      // Whole buffers (5 KB): update ranges would allocate every frame.
      this.center.needsUpdate = true
      this.size.needsUpdate = true
      this.alpha.needsUpdate = true
    }
    this.mesh.visible = this.count > 0 && this.texture !== null
    return changed
  }

  /** Free the GPU side and forget every picture; the layer can be used again (StrictMode remounts). */
  dispose(): void {
    this.scheduler.reset()
    this.texture?.dispose()
    this.texture = null
    this.material.uniforms['uMap']!.value = null
    this.geometry.dispose()
    this.material.dispose()
    this.loader = null
    this.on = false
    this.targets = null
    this.mapped = -1
    this.count = 0
    this.geometry.instanceCount = 0
    this.mesh.visible = false
    this.lastTick = -Infinity
    this.lastFlush = -Infinity
  }

  /** Which nodes of the current graph show a picture, and in which layer. */
  private remap(t: ThumbTargets): void {
    const layers = this.layer.array as Float32Array
    let n = 0
    for (let k = 0; k < t.nodes.length; k++) {
      const i = t.nodes[k]!
      const l = this.scheduler.layerOf(t.keys[k]!)
      const show = l >= 0 && n < THUMB_LAYERS
      t.shown[i] = show ? 1 : 0
      if (!show) continue
      this.instNode[n] = i
      layers[n] = l
      n++
    }
    this.count = n
    this.geometry.instanceCount = n
    if (n > 0) this.layer.needsUpdate = true
    this.mapped = this.scheduler.version
  }

  /** Read one picture through the loader and cover-crop it into a layer's worth of RGBA. */
  private async load(path: string): Promise<Uint8ClampedArray | null> {
    const loader = this.loader
    if (!loader) return null
    const blob = await loader(path, THUMB_REQUEST)
    if (!blob || blob.size === 0) return null
    // Decodes off the main thread; only the 128² crop below runs here.
    const bitmap = await createImageBitmap(blob)
    try {
      const { sx, sy, side } = coverRect(bitmap.width, bitmap.height)
      const ctx = this.context()
      if (!ctx || side <= 0) return null
      ctx.fillStyle = BACKDROP
      ctx.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE)
      ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, THUMB_SIZE, THUMB_SIZE)
      return ctx.getImageData(0, 0, THUMB_SIZE, THUMB_SIZE).data
    } finally {
      bitmap.close()
    }
  }

  /** One 128² canvas for every crop (each crop runs start to end synchronously). */
  private context(): Ctx2D | null {
    if (this.ctx) return this.ctx
    if (typeof OffscreenCanvas !== 'undefined') {
      this.ctx = new OffscreenCanvas(THUMB_SIZE, THUMB_SIZE).getContext('2d', { willReadFrequently: true })
    } else {
      const canvas = document.createElement('canvas')
      canvas.width = THUMB_SIZE
      canvas.height = THUMB_SIZE
      this.ctx = canvas.getContext('2d', { willReadFrequently: true })
    }
    return this.ctx
  }

  /** Copy a decoded picture into its layer; the upload waits for the next flush. */
  private store(layer: number, picture: Uint8ClampedArray): void {
    if (picture.length !== LAYER_BYTES) throw new Error('thumbnail has the wrong size')
    const tex = this.texture ?? this.createTexture()
    ;(tex.image.data as Uint8Array).set(picture, layer * LAYER_BYTES)
    tex.addLayerUpdate(layer)
  }

  private createTexture(): DataArrayTexture {
    const tex = new DataArrayTexture(new Uint8Array(LAYER_BYTES * THUMB_LAYERS), THUMB_SIZE, THUMB_SIZE, THUMB_LAYERS)
    tex.format = RGBAFormat
    tex.type = UnsignedByteType
    tex.colorSpace = SRGBColorSpace
    tex.magFilter = LinearFilter
    tex.minFilter = LinearMipmapLinearFilter
    tex.generateMipmaps = true
    tex.unpackAlignment = 4
    this.texture = tex
    this.material.uniforms['uMap']!.value = tex
    return tex
  }
}
