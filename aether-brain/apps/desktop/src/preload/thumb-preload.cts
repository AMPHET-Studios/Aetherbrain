/// <reference lib="dom" />
/**
 * Preload of the hidden thumbnail helper (sandboxed, context-isolated, an
 * empty page; see src/main/thumbnailer.ts). Main sends a picture's bytes
 * with the size to make; this decodes them with Chromium's own decoders,
 * scaled while decoding (createImageBitmap resizes before it hands the
 * bitmap over, so a big picture is not kept at full size), draws the result
 * into an OffscreenCanvas and sends back PNG bytes, or null when the bytes
 * do not decode. A video comes as an address its session serves for this one
 * job: it is loaded, sought to one frame and that frame drawn, never played.
 * A 3D model (binary glTF) comes as bytes too and is drawn here by a small
 * software rasterizer (the helper has no GPU): see "3D models" below.
 * Nothing is exposed to the page, and nothing else is read here: the
 * helper's session refuses every other request.
 * (CommonJS on purpose — Electron preloads run in a sandbox that loads CJS.)
 */
import { ipcRenderer } from 'electron'

/** Same channels as THUMB_IPC in src/main/thumbnailer.ts (a sandboxed preload cannot import it at runtime). */
const IPC = {
  ready: 'thumbs:ready',
  job: 'thumbs:job',
  done: 'thumbs:done',
  video: 'thumbs:video',
  model: 'thumbs:model',
  psd: 'thumbs:psd',
  pdf: 'thumbs:pdf',
  fbx: 'thumbs:fbx',
  audio: 'thumbs:audio',
} as const

/** Addresses main hands out for videos (VIDEO_URL_PREFIX in src/main/thumbnailer.ts). */
const VIDEO_URL = 'aether-video://clip/'
/** A video's still is a tenth of the way in, at most 5 s: past a title card or a fade-in, still near the start. */
const STILL_AT = 0.1
const STILL_MAX_S = 5
/** A video that has not given its still by then gets none (before main's own timeout ends the helper). */
const VIDEO_TIMEOUT_MS = 15_000
/**
 * `seeked` can come a moment before the frame can be drawn: a still that comes
 * out see-through is drawn again, this often at most, this far apart; then it
 * is kept as drawn when the video has its frame (a transparent background).
 */
const DRAW_TRIES = 25
const DRAW_WAIT_MS = 40

/** True when a few points of the canvas are painted (a video frame has no see-through pixels; a frame not ready yet is all see-through). */
function painted(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  for (const fx of [0.25, 0.5, 0.75]) {
    for (const fy of [0.25, 0.5, 0.75]) {
      if ((ctx.getImageData(Math.floor(w * fx), Math.floor(h * fy), 1, 1).data[3] ?? 0) > 0) return true
    }
  }
  return false
}

/** Largest side main ever asks for (THUMB_MAX in src/main/assets.ts). */
const MAX_SIDE = 1024

const side = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_SIDE

/** A canvas of the page, `width` × `height`. */
function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/**
 * PNG bytes of what is drawn on `canvas`, encoded right away. Not
 * `convertToBlob`: it waits for an idle period, and a hidden page stops
 * getting those a few seconds after it is hidden (every thumbnail then took a
 * second).
 */
function pngBytes(canvas: HTMLCanvasElement): Uint8Array | null {
  const url = canvas.toDataURL('image/png')
  const comma = url.indexOf(',')
  if (!url.startsWith('data:image/png') || comma < 0) return null
  const bin = atob(url.slice(comma + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** PNG bytes of `bytes` (a picture of media type `type`) at `width` × `height`. */
async function thumbnail(bytes: Uint8Array, type: string, width: number, height: number): Promise<Uint8Array | null> {
  // Bytes that crossed IPC sit in a plain ArrayBuffer, never a shared one.
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type })
  const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
  try {
    const canvas = canvasOf(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    return pngBytes(canvas)
  } finally {
    bitmap.close()
  }
}

/** Resolves on `event` of `video`, rejects on its `error`. */
function until(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = (ok: boolean) => {
      video.removeEventListener(event, onEvent)
      video.removeEventListener('error', onError)
      if (ok) resolve()
      else reject(new Error(video.error?.message || 'The video could not be read'))
    }
    const onEvent = () => done(true)
    const onError = () => done(false)
    video.addEventListener(event, onEvent)
    video.addEventListener('error', onError)
  })
}

/**
 * PNG bytes of one still frame of the video at `url`, at most `px` px on its
 * longer side: sought to, never played. Null when there is none within
 * VIDEO_TIMEOUT_MS (a share that stopped answering): the video is let go of
 * then too, which ends its stream.
 */
async function videoStill(url: string, px: number): Promise<Uint8Array | null> {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  // Served with CORS, so the frame can be drawn and read back.
  video.crossOrigin = 'anonymous'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([drawStill(video, url, px), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), VIDEO_TIMEOUT_MS)))])
  } finally {
    clearTimeout(timer)
    // Let go of the stream (and the file main serves) at once.
    video.removeAttribute('src')
    video.load()
  }
}

/** Load `url` into `video`, seek to its still and draw it (see videoStill). */
async function drawStill(video: HTMLVideoElement, url: string, px: number): Promise<Uint8Array | null> {
  const meta = until(video, 'loadedmetadata')
  video.src = url
  await meta
  const d = video.duration
  const at = Number.isFinite(d) && d > 0 ? Math.min(d * STILL_AT, STILL_MAX_S) : 0
  if (at > 0) {
    const seeked = until(video, 'seeked')
    video.currentTime = at
    await seeked
  } else if (video.readyState < 2) {
    await until(video, 'loadeddata')
  }
  const w = video.videoWidth
  const h = video.videoHeight
  if (!(w > 0 && h > 0)) return null
  const scale = Math.min(1, px / Math.max(w, h))
  const canvas = canvasOf(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  for (let tries = 1; ; tries++) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    if (painted(ctx, canvas.width, canvas.height)) break
    if (tries >= DRAW_TRIES) {
      if (video.readyState >= 2) break
      return null
    }
    await new Promise((r) => setTimeout(r, DRAW_WAIT_MS))
  }
  return pngBytes(canvas)
}

/* ------------------------------------------------------------------ */
/* 3D models: a small software rasterizer                             */
/* ------------------------------------------------------------------ */

/*
 * The helper has no GPU (`webgl: false`) and no page to load a viewer in, so a model is drawn here, on the CPU, into a
 * square of pixels. A binary glTF is parsed (never anything it points to outside itself), every mesh of its scene is
 * placed by its nodes, and the triangles are drawn orthographically from one fixed side (a little off the front and a
 * little above) with a z-buffer, per-vertex normals when it has them, one key light and the material's base colour (a
 * textured material takes its texture's average colour).
 *
 * What it does not do, said plainly: textures are not mapped; skins, morph targets, animation, lights and cameras are
 * ignored (the bind pose is drawn); Draco- or meshopt-compressed and sparse geometry is skipped, and a model with nothing
 * else to draw gets no thumbnail.
 *
 * The file is untrusted. Every index, offset and count is checked before it is used, and the work is bounded (vertices,
 * triangles, nodes, a time budget): a model that is too much is drawn in part, or not at all, never forever.
 */

/** What one model may cost the helper (a 64 MB file is at most a few million vertices). */
const GLB_LIMITS = {
  /** The JSON chunk, in bytes. */
  json: 16 * 1024 * 1024,
  /** Nodes visited, and how deep the hierarchy may go. */
  nodes: 100_000,
  depth: 64,
  /** Mesh placements drawn (a mesh used by many nodes is read once and drawn at each). */
  instances: 20_000,
  /** Vertices read from the file, and vertices handled per drawing (instances count again). */
  vertices: 4_000_000,
  /** Triangles drawn; a model with more is drawn with every n-th. */
  triangles: 1_500_000,
  /** Embedded texture bytes decoded for an average colour, and how many materials look at one. */
  textureBytes: 32 * 1024 * 1024,
  materials: 32,
  /** Time to draw, in ms: what is drawn by then is the picture. */
  budgetMs: 6_000,
}

type Rgb = readonly [number, number, number]

/** The parts of a glTF document this reads. It comes from a file: every field may be anything, so each is checked. */
interface GltfDoc {
  scene?: number
  scenes?: { nodes?: number[] }[]
  nodes?: { children?: number[]; mesh?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[]
  meshes?: { primitives?: { attributes?: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[]
  accessors?: { bufferView?: number; byteOffset?: number; componentType?: number; normalized?: boolean; count?: number; type?: string; sparse?: unknown }[]
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number; byteStride?: number; extensions?: Record<string, unknown> }[]
  buffers?: { byteLength?: number; uri?: string }[]
  materials?: { pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: { index?: number } } }[]
  textures?: { source?: number }[]
  images?: { bufferView?: number; mimeType?: string }[]
}

/** A parsed binary glTF: its JSON, and its one embedded buffer (the BIN chunk) when it has one. */
export interface Glb {
  doc: GltfDoc
  bin: Uint8Array | null
}

const GLB_MAGIC = 0x46546c67
const GLB_CHUNK_JSON = 0x4e4f534a
const GLB_CHUNK_BIN = 0x004e4942

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const numbers = (v: unknown, n: number): number[] | null => (Array.isArray(v) && v.length >= n && v.slice(0, n).every(isFiniteNumber) ? (v.slice(0, n) as number[]) : null)

/**
 * The JSON and the BIN chunk of a binary glTF 2.0 file, or null when the bytes are not one (wrong magic or version, a
 * length that is more than the file, a chunk that runs past it, no JSON that reads as an object).
 */
export function parseGlb(bytes: Uint8Array): Glb | null {
  if (bytes.length < 20) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (v.getUint32(0, true) !== GLB_MAGIC || v.getUint32(4, true) !== 2) return null
  const total = v.getUint32(8, true)
  if (total < 20 || total > bytes.length) return null
  let doc: unknown = null
  let bin: Uint8Array | null = null
  for (let at = 12; at + 8 <= total; ) {
    const length = v.getUint32(at, true)
    const type = v.getUint32(at + 4, true)
    const start = at + 8
    if (length > total - start) return null
    if (type === GLB_CHUNK_JSON && doc === null) {
      if (length > GLB_LIMITS.json) return null
      try {
        doc = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + length)))
      } catch {
        return null
      }
    } else if (type === GLB_CHUNK_BIN && bin === null) {
      bin = bytes.subarray(start, start + length)
    }
    // Chunks are padded to four bytes.
    at = start + ((length + 3) & ~3)
  }
  return typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? { doc: doc as GltfDoc, bin } : null
}

/** How each accessor component type is read: its size, how to read one, and the largest value (for `normalized`). */
const COMPONENT: Record<number, { size: number; read: (v: DataView, at: number) => number; max: number }> = {
  5120: { size: 1, read: (v, at) => v.getInt8(at), max: 127 },
  5121: { size: 1, read: (v, at) => v.getUint8(at), max: 255 },
  5122: { size: 2, read: (v, at) => v.getInt16(at, true), max: 32767 },
  5123: { size: 2, read: (v, at) => v.getUint16(at, true), max: 65535 },
  5125: { size: 4, read: (v, at) => v.getUint32(at, true), max: 0 },
  5126: { size: 4, read: (v, at) => v.getFloat32(at, true), max: 0 },
}
const ACCESSOR_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }

/**
 * The values of accessor `index` as `comps` numbers per element, or null when it cannot be read: not in the file's own
 * buffer, sparse, compressed, the wrong type, more than `maxCount` elements, or reaching outside its buffer view or the
 * buffer. `allowed`: the component types the caller takes (a normalized integer is turned into 0..1 or -1..1).
 */
function readAccessor<T extends Float32Array | Uint32Array>(
  g: Glb,
  index: unknown,
  comps: number,
  maxCount: number,
  allowed: readonly number[],
  make: (length: number) => T,
): T | null {
  const bin = g.bin
  if (!bin || !isIndex(index)) return null
  // Buffer 0 is the BIN chunk only when it names no file: one that does is data this never reads.
  if (g.doc.buffers?.[0]?.uri !== undefined) return null
  const acc = g.doc.accessors?.[index]
  if (!acc || typeof acc !== 'object' || acc.sparse !== undefined) return null
  const type = isIndex(acc.componentType) ? COMPONENT[acc.componentType] : undefined
  const count = acc.count
  if (!type || !allowed.includes(acc.componentType as number) || ACCESSOR_COMPONENTS[String(acc.type)] !== comps) return null
  if (!isIndex(count) || count === 0 || count > maxCount) return null
  const view = isIndex(acc.bufferView) ? g.doc.bufferViews?.[acc.bufferView] : undefined
  // The file's own buffer only (index 0, the BIN chunk): nothing is fetched from anywhere.
  if (!view || typeof view !== 'object' || (view.buffer ?? 0) !== 0 || view.extensions?.['EXT_meshopt_compression'] !== undefined) return null
  const viewStart = view.byteOffset ?? 0
  const viewLength = view.byteLength
  if (!isIndex(viewStart) || !isIndex(viewLength) || viewStart + viewLength > bin.length) return null
  const element = type.size * comps
  const stride = isIndex(view.byteStride) && view.byteStride >= element ? view.byteStride : element
  const offset = acc.byteOffset ?? 0
  if (!isIndex(offset)) return null
  const first = viewStart + offset
  const end = first + stride * (count - 1) + element
  if (end > viewStart + viewLength) return null
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const out = make(count * comps)
  const scaled = acc.normalized === true && type.max > 0
  for (let i = 0; i < count; i++) {
    const at = first + i * stride
    for (let c = 0; c < comps; c++) {
      const x = type.read(data, at + c * type.size)
      out[i * comps + c] = scaled ? Math.max(x / type.max, -1) : x
    }
  }
  return out
}

/** One drawable primitive: vertex positions (and normals), the triangles as index triples, and its material (-1: none). */
interface Prim {
  pos: Float32Array
  nrm: Float32Array | null
  tri: Uint32Array
  material: number
}

/** The triangles of a primitive as index triples: a list as it is, a strip or fan unrolled, a missing index sequential. */
function trianglesOf(mode: number, idx: Uint32Array | null, vertices: number): Uint32Array {
  const n = idx ? idx.length : vertices
  const at = (i: number): number => (idx ? idx[i]! : i)
  const cap = GLB_LIMITS.triangles
  if (mode === 4) {
    const count = Math.min(Math.floor(n / 3), cap)
    const out = new Uint32Array(count * 3)
    for (let i = 0; i < count * 3; i++) out[i] = at(i)
    return out
  }
  const count = Math.min(Math.max(0, n - 2), cap)
  const out = new Uint32Array(count * 3)
  for (let i = 0; i < count; i++) {
    if (mode === 5) {
      // A strip alternates its winding.
      out[i * 3] = at(i % 2 === 0 ? i : i + 1)
      out[i * 3 + 1] = at(i % 2 === 0 ? i + 1 : i)
      out[i * 3 + 2] = at(i + 2)
    } else {
      out[i * 3] = at(0)
      out[i * 3 + 1] = at(i + 1)
      out[i * 3 + 2] = at(i + 2)
    }
  }
  return out
}

/** Position component types a primitive may use: float, or an integer (KHR_mesh_quantization, with its scale in the node). */
const POSITION_TYPES = [5126, 5120, 5121, 5122, 5123]
const NORMAL_TYPES = [5126, 5120, 5122]
const INDEX_TYPES = [5121, 5123, 5125]

/** The drawable primitives of mesh `index` (triangles only; points and lines are left out); `budget.vertices` is spent as they are read. */
function meshPrims(g: Glb, index: number, budget: { vertices: number }): Prim[] {
  const list = g.doc.meshes?.[index]?.primitives
  if (!Array.isArray(list)) return []
  const out: Prim[] = []
  for (const p of list.slice(0, 256)) {
    if (!p || typeof p !== 'object') continue
    const mode = p.mode ?? 4
    if (mode !== 4 && mode !== 5 && mode !== 6) continue
    const pos = readAccessor(g, p.attributes?.['POSITION'], 3, budget.vertices, POSITION_TYPES, (n) => new Float32Array(n))
    if (!pos) continue
    const vertices = pos.length / 3
    budget.vertices -= vertices
    const normals = readAccessor(g, p.attributes?.['NORMAL'], 3, vertices, NORMAL_TYPES, (n) => new Float32Array(n))
    let idx: Uint32Array | null = null
    if (p.indices !== undefined) {
      idx = readAccessor(g, p.indices, 1, GLB_LIMITS.triangles * 3, INDEX_TYPES, (n) => new Uint32Array(n))
      if (!idx) continue
    }
    out.push({ pos, nrm: normals && normals.length === pos.length ? normals : null, tri: trianglesOf(mode, idx, vertices), material: isIndex(p.material) ? p.material : -1 })
  }
  return out
}

/* ---- matrices: 4 × 4, column-major as glTF writes them ---- */

const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** `a × b`. */
function mul(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!
    }
  }
  return out
}

/** A node's own matrix: its `matrix`, or translation × rotation × scale. */
function nodeMatrix(n: NonNullable<GltfDoc['nodes']>[number]): number[] {
  const m = numbers(n.matrix, 16)
  if (m) return m
  const [tx, ty, tz] = numbers(n.translation, 3) ?? [0, 0, 0]
  const [sx, sy, sz] = numbers(n.scale, 3) ?? [1, 1, 1]
  let [x, y, z, w] = numbers(n.rotation, 4) ?? [0, 0, 0, 1]
  const len = Math.hypot(x!, y!, z!, w!)
  if (len > 1e-9) {
    x = x! / len
    y = y! / len
    z = z! / len
    w = w! / len
  } else {
    x = y = z = 0
    w = 1
  }
  const xx = x! * x!, yy = y! * y!, zz = z! * z!
  const xy = x! * y!, xz = x! * z!, yz = y! * z!
  const wx = w! * x!, wy = w! * y!, wz = w! * z!
  return [
    (1 - 2 * (yy + zz)) * sx!, 2 * (xy + wz) * sx!, 2 * (xz - wy) * sx!, 0,
    2 * (xy - wz) * sy!, (1 - 2 * (xx + zz)) * sy!, 2 * (yz + wx) * sy!, 0,
    2 * (xz + wy) * sz!, 2 * (yz - wx) * sz!, (1 - 2 * (xx + yy)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ]
}

/** Every mesh placement of the default scene (or of the nodes nothing holds, when there is no scene), with its world matrix. */
function placements(g: Glb): { mesh: number; m: number[] }[] {
  const nodes = g.doc.nodes
  if (!Array.isArray(nodes)) return []
  const roots: number[] = []
  const scene = Array.isArray(g.doc.scenes) ? g.doc.scenes[isIndex(g.doc.scene) ? g.doc.scene : 0] : undefined
  if (scene && Array.isArray(scene.nodes)) {
    for (const r of scene.nodes) if (isIndex(r)) roots.push(r)
  } else {
    const held = new Set<number>()
    for (const n of nodes) if (n && Array.isArray(n.children)) for (const c of n.children) if (isIndex(c)) held.add(c)
    for (let i = 0; i < nodes.length; i++) if (!held.has(i)) roots.push(i)
  }
  const out: { mesh: number; m: number[] }[] = []
  let visited = 0
  const walk = (i: number, parent: readonly number[], depth: number): void => {
    if (depth > GLB_LIMITS.depth || visited >= GLB_LIMITS.nodes || out.length >= GLB_LIMITS.instances) return
    const n = nodes[i]
    if (!n || typeof n !== 'object') return
    visited++
    const m = mul(parent, nodeMatrix(n))
    if (isIndex(n.mesh)) out.push({ mesh: n.mesh, m })
    if (Array.isArray(n.children)) for (const c of n.children) if (isIndex(c)) walk(c, m, depth + 1)
  }
  for (const r of roots) walk(r, IDENTITY, 0)
  return out
}

/* ---- the camera and the light ---- */

/** Seen a third of a quarter turn off the front (the model's +Z) and a little above. */
const VIEW_AZIMUTH = (35 * Math.PI) / 180
const VIEW_ELEVATION = (24 * Math.PI) / 180

/** World → view: x right, y up, z away from the camera (a surface that faces the camera has a normal with z < 0). */
const VIEW: readonly number[] = (() => {
  const f = [-Math.sin(VIEW_AZIMUTH) * Math.cos(VIEW_ELEVATION), -Math.sin(VIEW_ELEVATION), -Math.cos(VIEW_AZIMUTH) * Math.cos(VIEW_ELEVATION)] as const
  // right = normalize(f × worldUp), up = right × f
  const rx = -f[2], rz = f[0]
  const rl = Math.hypot(rx, rz)
  const r = [rx / rl, 0, rz / rl] as const
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]] as const
  return [r[0], u[0], f[0], 0, r[1], u[1], f[1], 0, r[2], u[2], f[2], 0, 0, 0, 0, 1]
})()

/** The key light's direction (toward it, in view space): from the upper left, in front. */
const LIGHT: Rgb = (() => {
  const x = -0.45, y = 0.65, z = -0.62
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
})()

/**
 * How bright a lit part of a model is drawn: the whole look of a model planet, in one small pure function.
 *   diffuse  how squarely the surface faces the key light: 0 turned away from it … 1 straight at it
 *   facing   how squarely it faces the camera: 0 edge-on … 1 straight at us
 * It returns a multiple of the material's own colour: 0 is black, 1 the colour as it is, more than 1 pushes it toward white.
 * Called once for every pixel drawn, so keep it to arithmetic.
 *
 * This is a plain starting point (a floor of ambient light, the diffuse on top and a little rim), not a decided look. Change it to
 * taste: soft clay, hard cel steps, a bright rim where the surface turns away, cold shadows. The tests only ask that it stays
 * finite, not negative and at most 3.
 */
export function modelBrightness(diffuse: number, facing: number): number {
  const rim = (1 - facing) * (1 - facing)
  return 0.3 + 0.78 * diffuse + 0.22 * rim
}

/**
 * Exposure. A dark material (stone, or a texture that averages dark) would sit on the background as a black shape, so the
 * model's mean brightness is brought up to this level (0..1) when it is below it: never darker, and never by more than
 * MODEL_MAX_GAIN times. Hue and the shading `modelBrightness` makes are kept; only the level moves.
 */
const MODEL_EXPOSURE = 0.42
const MODEL_MAX_GAIN = 3

/** sRGB encoding of a linear 0..1 value. */
const encodeSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

/** The colour a material is drawn in (sRGB, 0..1): its base colour factor, times its texture's average when it has one. */
function materialColor(g: Glb, index: number, tints: ReadonlyMap<number, Rgb>): Rgb {
  // White would burn out under the light: a model with no colour of its own is a light grey.
  const grey = 0.8
  const factor = index >= 0 ? numbers(g.doc.materials?.[index]?.pbrMetallicRoughness?.baseColorFactor, 3) : null
  const base = factor ? factor.map((c) => encodeSrgb(Math.min(1, Math.max(0, c)))) : [1, 1, 1]
  const tint = tints.get(index) ?? [1, 1, 1]
  return [base[0]! * tint[0] * grey, base[1]! * tint[1] * grey, base[2]! * tint[2] * grey]
}

export interface RasterOptions {
  /** A clock in ms (tests pass a fake one); default `performance.now`. */
  now?: () => number
  /** Time to draw before what is there is the picture; default GLB_LIMITS.budgetMs. */
  budgetMs?: number
  /** Most triangles drawn; a model with more is drawn with every n-th. Default GLB_LIMITS.triangles. */
  maxTriangles?: number
}

/**
 * The model drawn as `side` × `side` RGBA pixels (opaque, on a dark gradient), or null when there is nothing to draw: no
 * mesh, only geometry this cannot read, or only degenerate triangles. `tints`: a material's texture average, by material
 * index. Pure: the same bytes and size give the same pixels.
 */
export function rasterGlb(g: Glb, side: number, tints: ReadonlyMap<number, Rgb> = new Map(), opts: RasterOptions = {}): Uint8ClampedArray | null {
  const now = opts.now ?? (() => performance.now())
  const deadline = now() + (opts.budgetMs ?? GLB_LIMITS.budgetMs)
  const budget = { vertices: GLB_LIMITS.vertices }
  const meshes = new Map<number, Prim[]>()
  const placed: { prim: Prim; c: number[] }[] = []
  let handled = 0
  let triangles = 0
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  // Pass 1: which primitives go where, and how big the model is as seen from the camera.
  for (const at of placements(g)) {
    let prims = meshes.get(at.mesh)
    if (!prims) meshes.set(at.mesh, (prims = meshPrims(g, at.mesh, budget)))
    if (!prims.length) continue
    const c = mul(VIEW, at.m)
    for (const prim of prims) {
      handled += prim.pos.length / 3
      if (handled > GLB_LIMITS.vertices * 2) break
      placed.push({ prim, c })
      triangles += prim.tri.length / 3
      const p = prim.pos
      for (let i = 0; i + 2 < p.length; i += 3) {
        const x = c[0]! * p[i]! + c[4]! * p[i + 1]! + c[8]! * p[i + 2]! + c[12]!
        const y = c[1]! * p[i]! + c[5]! * p[i + 1]! + c[9]! * p[i + 2]! + c[13]!
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (!placed.length || !Number.isFinite(minX) || !Number.isFinite(minY)) return null

  // Pass 2: the triangles, nearest wins. Supersampled 2 × 2 up to 512 px, then averaged down.
  const ss = side <= 512 ? 2 : 1
  const n = side * ss
  const depth = new Float32Array(n * n).fill(Infinity)
  const px = new Uint8ClampedArray(n * n * 3)
  const cover = new Uint8Array(n * n)
  const span = Math.max(maxX - minX, maxY - minY, 1e-9)
  const scale = (n * 0.8) / span
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const half = n / 2
  const every = Math.max(1, Math.ceil(triangles / (opts.maxTriangles ?? GLB_LIMITS.triangles)))
  const colors = new Map<number, Rgb>()
  let scratch = new Float32Array(0)
  let normals = new Float32Array(0)
  // The clock is read every 256 triangles and every couple of million pixels filled (a few huge triangles are slow too).
  let drawn = 0
  let work = 0
  let nextLook = 1 << 21
  let late = false
  for (const { prim, c } of placed) {
    if (late) break
    const pos = prim.pos
    if (scratch.length < pos.length) {
      scratch = new Float32Array(pos.length)
      normals = new Float32Array(pos.length)
    }
    // Everything in view space once per primitive.
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i]!, y = pos[i + 1]!, z = pos[i + 2]!
      scratch[i] = c[0]! * x + c[4]! * y + c[8]! * z + c[12]!
      scratch[i + 1] = c[1]! * x + c[5]! * y + c[9]! * z + c[13]!
      scratch[i + 2] = c[2]! * x + c[6]! * y + c[10]! * z + c[14]!
    }
    const smooth = prim.nrm
    if (smooth) {
      for (let i = 0; i < smooth.length; i += 3) {
        const x = smooth[i]!, y = smooth[i + 1]!, z = smooth[i + 2]!
        const nx = c[0]! * x + c[4]! * y + c[8]! * z
        const ny = c[1]! * x + c[5]! * y + c[9]! * z
        const nz = c[2]! * x + c[6]! * y + c[10]! * z
        const l = Math.hypot(nx, ny, nz) || 1
        normals[i] = nx / l
        normals[i + 1] = ny / l
        normals[i + 2] = nz / l
      }
    }
    let color = colors.get(prim.material)
    if (!color) colors.set(prim.material, (color = materialColor(g, prim.material, tints)))
    const [cr, cg, cb] = color
    const tri = prim.tri
    for (let t = 0; t + 2 < tri.length; t += 3 * every) {
      if ((drawn++ & 255) === 0 && now() > deadline) {
        late = true
        break
      }
      const a = tri[t]! * 3, b = tri[t + 1]! * 3, d = tri[t + 2]! * 3
      if (a >= pos.length || b >= pos.length || d >= pos.length) continue
      const ax = scratch[a]!, ay = scratch[a + 1]!, az = scratch[a + 2]!
      const bx = scratch[b]!, by = scratch[b + 1]!, bz = scratch[b + 2]!
      const dx = scratch[d]!, dy = scratch[d + 1]!, dz = scratch[d + 2]!
      const x0 = half + (ax - cx) * scale, y0 = half - (ay - cy) * scale
      const x1 = half + (bx - cx) * scale, y1 = half - (by - cy) * scale
      const x2 = half + (dx - cx) * scale, y2 = half - (dy - cy) * scale
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
      if (!Number.isFinite(area) || Math.abs(area) < 1e-9) continue
      const xmin = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
      const xmax = Math.min(n - 1, Math.ceil(Math.max(x0, x1, x2)))
      const ymin = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
      const ymax = Math.min(n - 1, Math.ceil(Math.max(y0, y1, y2)))
      if (xmin > xmax || ymin > ymax) continue
      work += (xmax - xmin + 1) * (ymax - ymin + 1)
      if (work >= nextLook) {
        nextLook = work + (1 << 21)
        if (now() > deadline) {
          late = true
          break
        }
      }
      // Flat shading from the triangle's own normal when there are no vertex normals.
      let fr = 0, fg = 0, fb = 0
      if (!smooth) {
        let nx = (by - ay) * (dz - az) - (bz - az) * (dy - ay)
        let ny = (bz - az) * (dx - ax) - (bx - ax) * (dz - az)
        let nz = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax)
        const l = Math.hypot(nx, ny, nz)
        if (!(l > 0)) continue
        nx /= l
        ny /= l
        nz /= l
        // Two-sided: a surface seen from behind is lit as if it faced us.
        if (nz > 0) {
          nx = -nx
          ny = -ny
          nz = -nz
        }
        const k = modelBrightness(Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]), -nz)
        fr = cr * k
        fg = cg * k
        fb = cb * k
      }
      const inv = 1 / area
      for (let y = ymin; y <= ymax; y++) {
        const py = y + 0.5
        for (let x = xmin; x <= xmax; x++) {
          const qx = x + 0.5
          const w0 = ((x1 - qx) * (y2 - py) - (x2 - qx) * (y1 - py)) * inv
          const w1 = ((x2 - qx) * (y0 - py) - (x0 - qx) * (y2 - py)) * inv
          const w2 = 1 - w0 - w1
          // A hair of slack so neighbouring triangles leave no cracks (the z-test settles the overlap).
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue
          const z = w0 * az + w1 * bz + w2 * dz
          const at = y * n + x
          if (z >= depth[at]!) continue
          depth[at] = z
          let r = fr, gr = fg, bl = fb
          if (smooth) {
            let nx = w0 * normals[a]! + w1 * normals[b]! + w2 * normals[d]!
            let ny = w0 * normals[a + 1]! + w1 * normals[b + 1]! + w2 * normals[d + 1]!
            let nz = w0 * normals[a + 2]! + w1 * normals[b + 2]! + w2 * normals[d + 2]!
            const l = Math.hypot(nx, ny, nz) || 1
            nx /= l
            ny /= l
            nz /= l
            if (nz > 0) {
              nx = -nx
              ny = -ny
              nz = -nz
            }
            const k = modelBrightness(Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]), -nz)
            r = cr * k
            gr = cg * k
            bl = cb * k
          }
          const o = at * 3
          px[o] = r * 255
          px[o + 1] = gr * 255
          px[o + 2] = bl * 255
          cover[at] = 1
        }
      }
    }
  }
  // Exposure: the mean brightness of what was drawn, and the gain that brings a dark model up to MODEL_EXPOSURE.
  let lit = 0
  let seen = 0
  for (let i = 0; i < cover.length; i++) {
    if (!cover[i]) continue
    lit += 0.299 * px[i * 3]! + 0.587 * px[i * 3 + 1]! + 0.114 * px[i * 3 + 2]!
    seen++
  }
  const mean = seen ? lit / seen : 0
  const gain = mean > 0 ? Math.min(MODEL_MAX_GAIN, Math.max(1, (MODEL_EXPOSURE * 255) / mean)) : 1
  // Average each ss × ss block down, over a dark gradient where nothing was drawn.
  const out = new Uint8ClampedArray(side * side * 4)
  const area = ss * ss
  let any = false
  for (let y = 0; y < side; y++) {
    const t = y / Math.max(1, side - 1)
    const br = 20 - 12 * t, bg = 26 - 15 * t, bb = 46 - 26 * t
    for (let x = 0; x < side; x++) {
      let r = 0, gr = 0, bl = 0, covered = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const at = (y * ss + sy) * n + (x * ss + sx)
          if (!cover[at]) continue
          covered++
          r += px[at * 3]! * gain
          gr += px[at * 3 + 1]! * gain
          bl += px[at * 3 + 2]! * gain
        }
      }
      if (covered) any = true
      const rest = area - covered
      const o = (y * side + x) * 4
      out[o] = (r + br * rest) / area
      out[o + 1] = (gr + bg * rest) / area
      out[o + 2] = (bl + bb * rest) / area
      out[o + 3] = 255
    }
  }
  return any ? out : null
}

/** The average colour of each material's base colour texture (embedded PNG or JPEG only), by material index; failures are left out. */
async function textureTints(g: Glb): Promise<Map<number, Rgb>> {
  const out = new Map<number, Rgb>()
  const bin = g.bin
  const materials = g.doc.materials
  if (!bin || !Array.isArray(materials)) return out
  let spent = 0
  for (let m = 0; m < Math.min(materials.length, GLB_LIMITS.materials); m++) {
    const texture = materials[m]?.pbrMetallicRoughness?.baseColorTexture?.index
    const source = isIndex(texture) ? g.doc.textures?.[texture]?.source : undefined
    const image = isIndex(source) ? g.doc.images?.[source] : undefined
    const view = image && isIndex(image.bufferView) ? g.doc.bufferViews?.[image.bufferView] : undefined
    const type = image?.mimeType
    if (!view || (view.buffer ?? 0) !== 0 || (type !== 'image/png' && type !== 'image/jpeg')) continue
    const start = view.byteOffset ?? 0
    const length = view.byteLength
    if (!isIndex(start) || !isIndex(length) || length === 0 || start + length > bin.length || spent + length > GLB_LIMITS.textureBytes) continue
    spent += length
    try {
      // One pixel: the decoder averages the whole picture down to it.
      const bitmap = await createImageBitmap(new Blob([bin.slice(start, start + length) as Uint8Array<ArrayBuffer>], { type }), {
        resizeWidth: 1,
        resizeHeight: 1,
        resizeQuality: 'high',
      })
      try {
        const canvas = canvasOf(1, 1)
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) continue
        ctx.drawImage(bitmap, 0, 0)
        const [r, gr, b, a] = ctx.getImageData(0, 0, 1, 1).data
        // A see-through picture has no colour to speak of.
        if ((a ?? 0) >= 128) out.set(m, [(r ?? 255) / 255, (gr ?? 255) / 255, (b ?? 255) / 255])
      } finally {
        bitmap.close()
      }
    } catch {
      // A texture that does not decode: the material keeps its factor.
    }
  }
  return out
}

/** PNG bytes of the model in `bytes` drawn as a square of `side` px, or null when there is nothing to draw. */
async function modelStill(bytes: Uint8Array, side: number): Promise<Uint8Array | null> {
  const glb = parseGlb(bytes)
  if (!glb) return null
  const pixels = rasterGlb(glb, side, await textureTints(glb))
  if (!pixels) return null
  const canvas = canvasOf(side, side)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, side, side), 0, 0)
  return pngBytes(canvas)
}

/* ------------------------------------------------------------------ */
/* Songs                                                              */
/* ------------------------------------------------------------------ */

/** The bars of a waveform, and how many times wider than tall its picture is (the scene draws the card at the same shape). */
export const WAVE_COLUMNS = 256
export const WAVE_ASPECT = 3

/**
 * How loud each of `columns` equal slices of a song is, two ways, each 0 to 1 over the whole song: `peak` is the largest sample of the slice
 * over every channel (what a recording that is mastered loud nearly always fills), `energy` is the root mean square (the loudness the ear
 * hears, which still moves in a loud recording), the loudest slice being 1 and a quiet one lifted a little so that it shows. Silence is all
 * zeros, and a sample that is not a number counts as silence. Pure.
 */
export function waveformLevels(channels: readonly Float32Array[], columns: number): { peak: Float32Array; energy: Float32Array } {
  const peak = new Float32Array(Math.max(0, columns))
  const energy = new Float32Array(Math.max(0, columns))
  const longest = channels.reduce((n, c) => Math.max(n, c.length), 0)
  if (longest === 0 || columns < 1) return { peak, energy }
  const squares = new Float64Array(columns)
  const counts = new Float64Array(columns)
  for (const channel of channels) {
    for (let c = 0; c < columns; c++) {
      const from = Math.floor((c * channel.length) / columns)
      const to = Math.max(from + 1, Math.floor(((c + 1) * channel.length) / columns))
      for (let i = from; i < to && i < channel.length; i++) {
        const raw = channel[i]!
        const v = Number.isFinite(raw) ? Math.abs(raw) : 0
        if (v > peak[c]!) peak[c] = v
        squares[c] = squares[c]! + v * v
        counts[c] = counts[c]! + 1
      }
    }
  }
  let loudestPeak = 0
  let loudestEnergy = 0
  for (let c = 0; c < columns; c++) {
    energy[c] = counts[c]! > 0 ? Math.sqrt(squares[c]! / counts[c]!) : 0
    if (peak[c]! > loudestPeak) loudestPeak = peak[c]!
    if (energy[c]! > loudestEnergy) loudestEnergy = energy[c]!
  }
  for (let c = 0; c < columns; c++) {
    peak[c] = loudestPeak > 0 ? Math.min(1, peak[c]! / loudestPeak) : 0
    energy[c] = loudestEnergy > 0 ? Math.pow(Math.min(1, energy[c]! / loudestEnergy), 0.8) : 0
  }
  return { peak, energy }
}

/**
 * The waveform as RGBA pixels, `WAVE_ASPECT` times as wide as `height`: a dark card with one bar per slice, mirrored about the middle: the
 * peak as a dim outline and the energy inside it, bright and warmer the louder it is. Pure: the same levels and height give the same pixels.
 */
export function waveformImage(levels: { peak: Float32Array; energy: Float32Array }, height: number): { width: number; height: number; data: Uint8ClampedArray } {
  const width = height * WAVE_ASPECT
  const data = new Uint8ClampedArray(width * height * 4)
  const columns = Math.max(1, levels.peak.length)
  const slot = width / columns
  const mid = (height - 1) / 2
  for (let y = 0; y < height; y++) {
    const t = y / Math.max(1, height - 1)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      data[o] = 23 - 9 * t
      data[o + 1] = 26 - 9 * t
      data[o + 2] = 44 - 14 * t
      data[o + 3] = 255
    }
  }
  const bar = (x0: number, x1: number, half: number, r: number, g: number, b: number): void => {
    for (let y = Math.max(0, Math.round(mid - half)); y <= Math.min(height - 1, Math.round(mid + half)); y++) {
      for (let x = x0; x < x1 && x < width; x++) {
        const o = (y * width + x) * 4
        data[o] = r
        data[o + 1] = g
        data[o + 2] = b
      }
    }
  }
  for (let c = 0; c < levels.peak.length; c++) {
    // A bar is two thirds of its slot; even silence leaves a hairline, so the card reads as a waveform.
    const x0 = Math.floor(c * slot + slot / 6)
    const x1 = Math.max(x0 + 1, Math.floor(c * slot + (slot * 5) / 6))
    const p = levels.peak[c]!
    const e = Math.min(p, levels.energy[c] ?? 0)
    bar(x0, x1, Math.max(1, Math.round(p * (height * 0.46))), 62 + 40 * p, 92 + 40 * p, 120 + 20 * p)
    bar(x0, x1, Math.max(1, Math.round(e * (height * 0.46))), 70 + 185 * e, 205 - 15 * e, 190 - 100 * e)
  }
  return { width, height, data }
}

/** PNG bytes of the waveform of the song in `bytes`, at most `side` px tall, or null when Chromium cannot decode it or it has no sound. */
async function audioStill(bytes: Uint8Array, side: number): Promise<Uint8Array | null> {
  // A context only for its decoder: it plays nothing and reads nothing but these bytes. Decoded at its own rate, whatever the file was.
  const context = new OfflineAudioContext(1, 1, 44100)
  const copy = bytes.slice().buffer
  const decoded = await context.decodeAudioData(copy)
  const channels: Float32Array[] = []
  for (let c = 0; c < Math.min(decoded.numberOfChannels, 2); c++) channels.push(decoded.getChannelData(c))
  const height = Math.min(256, side)
  const image = waveformImage(waveformLevels(channels, WAVE_COLUMNS), height)
  const canvas = canvasOf(image.width, image.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.putImageData(new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0)
  return pngBytes(canvas)
}

ipcRenderer.on(IPC.audio, (_e, id: unknown, bytes: unknown, px: unknown) => {
  const job = bytes instanceof Uint8Array && side(px) ? audioStill(bytes, px) : Promise.resolve(null)
  void job.then(
    (png) => ipcRenderer.send(IPC.done, id, png),
    () => ipcRenderer.send(IPC.done, id, null),
  )
})

/* ------------------------------------------------------------------ */
/* FBX models                                                         */
/* ------------------------------------------------------------------ */

/**
 * A binary FBX file read as the same thing a glTF is to the rasterizer above: its geometry placed by its models. The file is untrusted
 * like any other: every offset and count is checked, the nodes, arrays and bytes it may cost are bounded, and a file that is too much is
 * not drawn. Read: the meshes (`Geometry`), the models that place them (`Model`: translation, rotation, scaling) and their `Connections`,
 * and the file's up axis. Not read: the ASCII form of FBX, textures and materials (a model is a light grey), normals (shaded flat),
 * pivots, pre-rotations, skins, animation and blend shapes.
 */
export const FBX_LIMITS = {
  /** Nodes read from the file, and how deep they may nest. */
  nodes: 400_000,
  depth: 32,
  /** Bytes one array may expand to when it is decompressed, and all of them together. */
  arrayBytes: 128 * 1024 * 1024,
  totalBytes: 384 * 1024 * 1024,
  /** Models placed. */
  models: 20_000,
}

const FBX_MAGIC = 'Kaydara FBX Binary  \0'

/** One array property of a node, not decoded until it is asked for: where it is and how it is stored. */
interface FbxArray {
  array: 'f' | 'd' | 'l' | 'i' | 'b'
  length: number
  encoding: number
  at: number
  size: number
}

type FbxValue = number | string | FbxArray

interface FbxNode {
  name: string
  props: FbxValue[]
  children: FbxNode[]
}

const FBX_ELEMENT: Record<string, number> = { f: 4, d: 8, l: 8, i: 4, b: 1 }

/** The node tree of a binary FBX file (version 7100 and later), or null for anything else, a file cut short or one past the limits. */
function fbxTree(bytes: Uint8Array): FbxNode[] | null {
  if (bytes.length < 27 + 13) return null
  for (let i = 0; i < FBX_MAGIC.length; i++) if (bytes[i] !== FBX_MAGIC.charCodeAt(i)) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = v.getUint32(23, true)
  if (version < 7100 || version > 8000) return null
  const wide = version >= 7500
  const head = wide ? 25 : 13
  let seen = 0
  const decoder = new TextDecoder()
  /** One node record at `pos` and what follows it; null for the all-zero record that ends a list, undefined for a broken file. */
  const record = (pos: number, depth: number): { node: FbxNode; next: number } | null | undefined => {
    if (pos + head > bytes.length || depth > FBX_LIMITS.depth || ++seen > FBX_LIMITS.nodes) return undefined
    const end = wide ? Number(v.getBigUint64(pos, true)) : v.getUint32(pos, true)
    const count = wide ? Number(v.getBigUint64(pos + 8, true)) : v.getUint32(pos + 4, true)
    const listLength = wide ? Number(v.getBigUint64(pos + 16, true)) : v.getUint32(pos + 8, true)
    const nameLength = bytes[pos + head - 1] ?? 0
    if (end === 0) return null
    if (!Number.isSafeInteger(end) || end > bytes.length || end < pos + head + nameLength + listLength) return undefined
    const name = decoder.decode(bytes.subarray(pos + head, pos + head + nameLength))
    const props: FbxValue[] = []
    let at = pos + head + nameLength
    const listEnd = at + listLength
    if (count > listLength) return undefined
    for (let p = 0; p < count; p++) {
      if (at >= listEnd) return undefined
      const type = String.fromCharCode(bytes[at++] ?? 0)
      if (type === 'Y') {
        props.push(v.getInt16(at, true))
        at += 2
      } else if (type === 'C') {
        props.push(bytes[at] ?? 0)
        at += 1
      } else if (type === 'I') {
        props.push(v.getInt32(at, true))
        at += 4
      } else if (type === 'F') {
        props.push(v.getFloat32(at, true))
        at += 4
      } else if (type === 'D') {
        props.push(v.getFloat64(at, true))
        at += 8
      } else if (type === 'L') {
        props.push(Number(v.getBigInt64(at, true)))
        at += 8
      } else if (type === 'S' || type === 'R') {
        const length = v.getUint32(at, true)
        at += 4
        if (length > listEnd - at) return undefined
        props.push(type === 'S' ? decoder.decode(bytes.subarray(at, at + length)) : '')
        at += length
      } else if (type in FBX_ELEMENT) {
        const length = v.getUint32(at, true)
        const encoding = v.getUint32(at + 4, true)
        const size = v.getUint32(at + 8, true)
        at += 12
        if (encoding > 1 || size > listEnd - at || (encoding === 0 && size !== length * FBX_ELEMENT[type]!) || length * FBX_ELEMENT[type]! > FBX_LIMITS.arrayBytes) return undefined
        props.push({ array: type as FbxArray['array'], length, encoding, at, size })
        at += size
      } else return undefined
      if (at > listEnd) return undefined
    }
    const children: FbxNode[] = []
    let next = listEnd
    // A node with nested nodes ends with an all-zero record; one without ends where its properties do.
    if (next < end) {
      for (;;) {
        if (next >= end) return undefined
        const child = record(next, depth + 1)
        if (child === undefined) return undefined
        if (child === null) {
          next += head
          break
        }
        children.push(child.node)
        next = child.next
      }
    }
    if (next !== end) return undefined
    return { node: { name, props, children }, next: end }
  }
  const roots: FbxNode[] = []
  let pos = 27
  for (;;) {
    const r = record(pos, 0)
    if (r === undefined) return null
    if (r === null) break
    roots.push(r.node)
    pos = r.next
    if (pos + head > bytes.length) break
  }
  return roots
}

/** The bytes of a zlib stream inflated, or null when it is not one or would expand to more than `size` (nothing bigger is ever held). */
async function inflate(zipped: Uint8Array, size: number): Promise<Uint8Array | null> {
  try {
    const reader = new Blob([zipped as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate')).getReader()
    const out = new Uint8Array(size)
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (got + value.length > size) {
        void reader.cancel()
        return null
      }
      out.set(value, got)
      got += value.length
    }
    return got === size ? out : null
  } catch {
    return null
  }
}

/** The numbers of an array property, whether stored raw or deflated; null when it is not an array, cannot be read or is over what is left to spend. */
async function fbxNumbers(bytes: Uint8Array, value: FbxValue | undefined, spend: { left: number }): Promise<Float64Array | Int32Array | null> {
  if (typeof value !== 'object') return null
  const bytesNeeded = value.length * FBX_ELEMENT[value.array]!
  if (bytesNeeded > spend.left) return null
  spend.left -= bytesNeeded
  const raw = value.encoding === 1 ? await inflate(bytes.subarray(value.at, value.at + value.size), bytesNeeded) : bytes.subarray(value.at, value.at + value.size)
  if (!raw || raw.length !== bytesNeeded) return null
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  if (value.array === 'd') {
    const out = new Float64Array(value.length)
    for (let i = 0; i < out.length; i++) out[i] = v.getFloat64(i * 8, true)
    return out
  }
  if (value.array === 'i') {
    const out = new Int32Array(value.length)
    for (let i = 0; i < out.length; i++) out[i] = v.getInt32(i * 4, true)
    return out
  }
  if (value.array === 'f') {
    const out = new Float64Array(value.length)
    for (let i = 0; i < out.length; i++) out[i] = v.getFloat32(i * 4, true)
    return out
  }
  return null
}

const child = (n: FbxNode, name: string): FbxNode | undefined => n.children.find((c) => c.name === name)

/** A column-major matrix of a translation, an Euler rotation in degrees (x, then y, then z: FBX's default order) and a scale. */
function fbxLocal(t: readonly number[], r: readonly number[], s: readonly number[]): number[] {
  const [rx, ry, rz] = r.map((d) => (d * Math.PI) / 180) as [number, number, number]
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)]
  const X = [1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1]
  const Y = [cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]
  const Z = [cz, sz, 0, 0, -sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const rot = mul(Z, mul(Y, X))
  for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) rot[c * 4 + row] = rot[c * 4 + row]! * s[c]!
  rot[12] = t[0]!
  rot[13] = t[1]!
  rot[14] = t[2]!
  return rot
}

/** A Properties70 vector (`Lcl Translation` and the like): its three numbers, or `fallback`. */
function fbxVector(model: FbxNode, name: string, fallback: readonly number[]): readonly number[] {
  const p = child(model, 'Properties70')?.children.find((c) => c.name === 'P' && c.props[0] === name)
  const vec = p ? p.props.slice(4, 7) : []
  return vec.length === 3 && vec.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (vec as number[]) : fallback
}

/**
 * An FBX file as a `Glb` with every mesh of it placed by its model's transform, so that `rasterGlb` draws it exactly as it draws a model
 * that was a glTF to begin with. Null for anything that is not a binary FBX with a mesh in it, or is past the limits.
 */
export async function parseFbx(bytes: Uint8Array): Promise<Glb | null> {
  const roots = fbxTree(bytes)
  if (!roots) return null
  const objects = roots.find((n) => n.name === 'Objects')
  const connections = roots.find((n) => n.name === 'Connections')
  if (!objects) return null
  const geometries = new Map<number, FbxNode>()
  const models = new Map<number, FbxNode>()
  for (const o of objects.children) {
    const id = o.props[0]
    if (typeof id !== 'number') continue
    if (o.name === 'Geometry' && o.props[2] === 'Mesh') geometries.set(id, o)
    else if (o.name === 'Model' && models.size < FBX_LIMITS.models) models.set(id, o)
  }
  const parentOf = new Map<number, number>()
  const meshesOf = new Map<number, number[]>()
  for (const c of connections?.children ?? []) {
    if (c.name !== 'C' || c.props[0] !== 'OO') continue
    const from = c.props[1]
    const to = c.props[2]
    if (typeof from !== 'number' || typeof to !== 'number') continue
    if (models.has(from) && (models.has(to) || to === 0)) parentOf.set(from, to)
    else if (geometries.has(from) && models.has(to)) meshesOf.set(to, [...(meshesOf.get(to) ?? []), from])
  }
  // The file's up axis: a Z-up file is turned so that its Z is the camera's up (Y).
  const settings = roots.find((n) => n.name === 'GlobalSettings')?.children.find((c) => c.name === 'Properties70')
  const up = settings?.children.find((c) => c.name === 'P' && c.props[0] === 'UpAxis')?.props[4]
  const base: number[] = up === 2 ? [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] : [...IDENTITY]
  const worlds = new Map<number, number[]>()
  const worldOf = (id: number, depth: number): number[] => {
    const known = worlds.get(id)
    if (known) return known
    const model = models.get(id)
    if (!model || depth > FBX_LIMITS.depth) return base
    const local = fbxLocal(fbxVector(model, 'Lcl Translation', [0, 0, 0]), fbxVector(model, 'Lcl Rotation', [0, 0, 0]), fbxVector(model, 'Lcl Scaling', [1, 1, 1]))
    const parent = parentOf.get(id)
    const world = mul(parent !== undefined && parent !== 0 && parent !== id ? worldOf(parent, depth + 1) : base, local)
    worlds.set(id, world)
    return world
  }
  const spend = { left: FBX_LIMITS.totalBytes }
  const parts: Uint8Array[] = []
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = []
  const accessors: { bufferView: number; componentType: number; count: number; type: string }[] = []
  const meshes: { primitives: { attributes: { POSITION: number }; indices: number }[] }[] = []
  const meshOfGeometry = new Map<number, number>()
  let offset = 0
  let vertices = 0
  const add = (data: Uint8Array, componentType: number, count: number, type: string): number => {
    views.push({ buffer: 0, byteOffset: offset, byteLength: data.length })
    accessors.push({ bufferView: views.length - 1, componentType, count, type })
    parts.push(data)
    offset += data.length
    return accessors.length - 1
  }
  const meshFor = async (id: number): Promise<number> => {
    const known = meshOfGeometry.get(id)
    if (known !== undefined) return known
    meshOfGeometry.set(id, -1)
    const g = geometries.get(id)!
    const xyz = await fbxNumbers(bytes, child(g, 'Vertices')?.props[0], spend)
    const poly = await fbxNumbers(bytes, child(g, 'PolygonVertexIndex')?.props[0], spend)
    if (!xyz || !poly || xyz.length < 9 || vertices + xyz.length / 3 > GLB_LIMITS.vertices) return -1
    const count = xyz.length / 3
    const positions = new Float32Array(Math.floor(count) * 3)
    for (let i = 0; i < positions.length; i++) positions[i] = xyz[i]!
    // A polygon ends at the index stored as its bitwise complement; it is cut into a fan of triangles.
    const tris: number[] = []
    let first = -1
    let previous = -1
    let fan = 0
    for (const raw of poly) {
      const index = raw < 0 ? ~raw : raw
      if (index >= count) {
        first = -1
        fan = 0
      } else if (first < 0) {
        first = index
        fan = 1
      } else {
        if (fan >= 2) tris.push(first, previous, index)
        previous = index
        fan++
      }
      if (raw < 0) {
        first = -1
        fan = 0
      }
      if (tris.length > GLB_LIMITS.triangles * 3) break
    }
    if (!tris.length) return -1
    vertices += count
    const position = add(new Uint8Array(positions.buffer), 5126, positions.length / 3, 'VEC3')
    const indices = add(new Uint8Array(Uint32Array.from(tris).buffer), 5125, tris.length, 'SCALAR')
    meshes.push({ primitives: [{ attributes: { POSITION: position }, indices }] })
    meshOfGeometry.set(id, meshes.length - 1)
    return meshes.length - 1
  }
  const nodes: { mesh: number; matrix: number[] }[] = []
  for (const [modelId, geometryIds] of meshesOf) {
    for (const geometryId of geometryIds) {
      const mesh = await meshFor(geometryId)
      if (mesh >= 0 && nodes.length < GLB_LIMITS.instances) nodes.push({ mesh, matrix: worldOf(modelId, 0) })
    }
  }
  if (!nodes.length) return null
  const bin = new Uint8Array(offset)
  let at = 0
  for (const p of parts) {
    bin.set(p, at)
    at += p.length
  }
  return {
    doc: { scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }] },
    bin,
  }
}

/** PNG bytes of the FBX model in `bytes` drawn as a square of `side` px (as a glTF is), or null when there is nothing to draw. */
async function fbxStill(bytes: Uint8Array, side: number): Promise<Uint8Array | null> {
  const glb = await parseFbx(bytes)
  if (!glb) return null
  const pixels = rasterGlb(glb, side)
  if (!pixels) return null
  const canvas = canvasOf(side, side)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, side, side), 0, 0)
  return pngBytes(canvas)
}

ipcRenderer.on(IPC.fbx, (_e, id: unknown, bytes: unknown, px: unknown) => {
  const job = bytes instanceof Uint8Array && side(px) ? fbxStill(bytes, px) : Promise.resolve(null)
  void job.then(
    (png) => ipcRenderer.send(IPC.done, id, png),
    () => ipcRenderer.send(IPC.done, id, null),
  )
})

/* ------------------------------------------------------------------ */
/* Photoshop documents                                                */
/* ------------------------------------------------------------------ */

/** Most pixels of a Photoshop picture read whole: each channel is a byte a pixel, kept at full size while it is read. */
export const PSD_MAX_PIXELS = 36_000_000

/**
 * The flattened picture of a Photoshop document (its "merged image", which Photoshop keeps for programs that do not read layers when
 * Maximize Compatibility is on) fitted to `px` on its longer side, as RGBA. Main sends a document with its colour table, resources and
 * layers cut out (their three lengths are zero) so that only the merged picture crosses over: a layered file is mostly layers. RGB,
 * greyscale and CMYK at 8 or 16 bits, stored raw or run-length coded; anything else (indexed, Lab, zip-coded, the big PSB format, a
 * picture over `PSD_MAX_PIXELS`) is null, and so is a file that ends early. Reads only inside `bytes`.
 */
export function decodePsd(bytes: Uint8Array, px: number): { width: number; height: number; data: Uint8ClampedArray } | null {
  if (bytes.length < 26 + 12 + 2) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (v.getUint32(0) !== 0x38425053 || v.getUint16(4) !== 1) return null
  const channels = v.getUint16(12)
  const height = v.getUint32(14)
  const width = v.getUint32(18)
  const depth = v.getUint16(22)
  const mode = v.getUint16(24)
  if (width < 1 || height < 1 || width > 30_000 || height > 30_000 || width * height > PSD_MAX_PIXELS) return null
  if (depth !== 8 && depth !== 16) return null
  // Colour mode: 1 greyscale, 3 RGB, 4 CMYK; the colour channels first, then an optional alpha.
  const colours = mode === 1 ? 1 : mode === 3 ? 3 : mode === 4 ? 4 : 0
  if (colours === 0 || channels < colours || channels > 56) return null
  // Colour table, image resources and layers: main sent them empty, but a whole file works too.
  let at = 26
  for (let i = 0; i < 3; i++) {
    if (at + 4 > bytes.length) return null
    at += 4 + v.getUint32(at)
  }
  if (at + 2 > bytes.length) return null
  const compression = v.getUint16(at)
  at += 2
  const bpp = depth / 8
  const rowBytes = width * bpp
  const used = Math.min(channels, colours + 1)
  // One plane of 8-bit samples per channel used (a 16-bit sample keeps its high byte).
  const planes: Uint8Array[] = []
  const rowOf = (row: Uint8Array, plane: Uint8Array, y: number): void => {
    if (bpp === 1) plane.set(row.subarray(0, width), y * width)
    else for (let x = 0; x < width; x++) plane[y * width + x] = row[x * 2] ?? 0
  }
  if (compression === 0) {
    if (at + channels * height * rowBytes > bytes.length) return null
    for (let c = 0; c < used; c++) {
      const plane = new Uint8Array(width * height)
      for (let y = 0; y < height; y++) rowOf(bytes.subarray(at + (c * height + y) * rowBytes, at + (c * height + y + 1) * rowBytes), plane, y)
      planes.push(plane)
    }
  } else if (compression === 1) {
    // Run-length: a table of 16-bit byte counts, one per row of every channel, then the rows (PackBits).
    const table = at
    let data = table + channels * height * 2
    if (data > bytes.length) return null
    const row = new Uint8Array(rowBytes)
    for (let c = 0; c < channels; c++) {
      const plane = c < used ? new Uint8Array(width * height) : null
      for (let y = 0; y < height; y++) {
        const count = v.getUint16(table + (c * height + y) * 2)
        const end = data + count
        if (end > bytes.length) return null
        if (plane) {
          let o = 0
          let i = data
          while (i < end && o < rowBytes) {
            const n = (bytes[i++] ?? 0) << 24 >> 24
            if (n >= 0) {
              const len = Math.min(n + 1, end - i, rowBytes - o)
              row.set(bytes.subarray(i, i + len), o)
              i += n + 1
              o += len
            } else if (n !== -128) {
              const len = Math.min(1 - n, rowBytes - o)
              row.fill(bytes[i++] ?? 0, o, o + len)
              o += len
            }
          }
          if (o < rowBytes) row.fill(0, o)
          rowOf(row, plane, y)
        }
        data = end
      }
      if (plane) planes.push(plane)
    }
  } else return null
  const alpha = channels > colours ? planes[colours] : undefined
  const scale = Math.min(1, px / Math.max(width, height))
  const tw = Math.max(1, Math.round(width * scale))
  const th = Math.max(1, Math.round(height * scale))
  const out = new Uint8ClampedArray(tw * th * 4)
  // Each output pixel is the mean of up to 3 x 3 samples spread over the source pixels it covers.
  const sx = width / tw
  const sy = height / th
  const taps = Math.max(1, Math.min(3, Math.floor(Math.min(sx, sy))))
  const sample = (plane: Uint8Array, x0: number, y0: number): number => {
    let sum = 0
    for (let j = 0; j < taps; j++) {
      const y = Math.min(height - 1, Math.floor(y0 + ((j + 0.5) / taps) * sy))
      for (let i = 0; i < taps; i++) sum += plane[y * width + Math.min(width - 1, Math.floor(x0 + ((i + 0.5) / taps) * sx))] ?? 0
    }
    return sum / (taps * taps)
  }
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const o = (y * tw + x) * 4
      const x0 = x * sx
      const y0 = y * sy
      if (colours === 3) {
        out[o] = sample(planes[0]!, x0, y0)
        out[o + 1] = sample(planes[1]!, x0, y0)
        out[o + 2] = sample(planes[2]!, x0, y0)
      } else if (colours === 1) {
        const g = sample(planes[0]!, x0, y0)
        out[o] = g
        out[o + 1] = g
        out[o + 2] = g
      } else {
        // Photoshop stores CMYK inverted (255 is no ink): the ink left is the stored value, so red = C x K / 255 and so on.
        const k = sample(planes[3]!, x0, y0)
        out[o] = (sample(planes[0]!, x0, y0) * k) / 255
        out[o + 1] = (sample(planes[1]!, x0, y0) * k) / 255
        out[o + 2] = (sample(planes[2]!, x0, y0) * k) / 255
      }
      out[o + 3] = alpha ? sample(alpha, x0, y0) : 255
    }
  }
  return { width: tw, height: th, data: out }
}

/** PNG bytes of the flattened picture in a Photoshop document, at most `side` px on its longer side, or null when it cannot be read. */
async function psdStill(bytes: Uint8Array, side: number): Promise<Uint8Array | null> {
  const still = decodePsd(bytes, side)
  if (!still) return null
  const canvas = canvasOf(still.width, still.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.putImageData(new ImageData(still.data as Uint8ClampedArray<ArrayBuffer>, still.width, still.height), 0, 0)
  return pngBytes(canvas)
}

/* ------------------------------------------------------------------ */
/* PDF                                                                */
/* ------------------------------------------------------------------ */

/** The page module that runs pdf.js (src/pdf-host/host.mjs), served by the helper session's `aether-pdf` scheme. */
const PDF_HOST = 'aether-pdf://app/host.mjs'
/** Longest the page module may take to load, and a page to draw: main's own limit for a job ends the helper first. */
const PDF_LOAD_MS = 10_000

let pdfHost: Promise<boolean> | null = null
let pdfSeq = 0
const pdfWaiting = new Map<number, (page: { width: number; height: number; buffer: ArrayBuffer } | null) => void>()

interface PdfMessage {
  aether?: string
  id?: number
  width?: number
  height?: number
  buffer?: ArrayBuffer | null
}

/** The page module's answers: listened for from the first PDF on (a helper that never gets one never touches `window`). */
function onPdfDone(e: MessageEvent<PdfMessage>): void {
  const m = e.data
  if (e.source !== window || !m || m.aether !== 'pdf-done' || typeof m.id !== 'number') return
  const wait = pdfWaiting.get(m.id)
  pdfWaiting.delete(m.id)
  wait?.(m.buffer instanceof ArrayBuffer && typeof m.width === 'number' && typeof m.height === 'number' ? { width: m.width, height: m.height, buffer: m.buffer } : null)
}

/** Loads the page module once (it posts `pdf-ready` when it listens); false when it could not load, and the next job tries again. */
function loadPdfHost(): Promise<boolean> {
  if (pdfHost) return pdfHost
  window.addEventListener('message', onPdfDone)
  const loading = new Promise<boolean>((resolve) => {
    const finish = (ok: boolean): void => {
      window.removeEventListener('message', onReady)
      clearTimeout(timer)
      if (!ok) window.removeEventListener('message', onPdfDone)
      resolve(ok)
    }
    const onReady = (e: MessageEvent<PdfMessage>): void => {
      if (e.source === window && e.data?.aether === 'pdf-ready') finish(true)
    }
    const timer = setTimeout(() => finish(false), PDF_LOAD_MS)
    window.addEventListener('message', onReady)
    const script = document.createElement('script')
    script.type = 'module'
    script.src = PDF_HOST
    script.onerror = () => finish(false)
    document.documentElement.appendChild(script)
  })
  pdfHost = loading
  void loading.then((ok) => {
    if (!ok) pdfHost = null
  })
  return loading
}

/** PNG bytes of the first page of the PDF in `bytes`, drawn on white and at most `side` px on its longer side, or null when it cannot be drawn. */
async function pdfStill(bytes: Uint8Array, side: number): Promise<Uint8Array | null> {
  if (!(await loadPdfHost())) return null
  const id = ++pdfSeq
  const copy = bytes.slice().buffer
  const page = await new Promise<{ width: number; height: number; buffer: ArrayBuffer } | null>((resolve) => {
    pdfWaiting.set(id, resolve)
    window.postMessage({ aether: 'pdf', id, bytes: copy, px: side }, '*', [copy])
  })
  if (!page || page.width < 1 || page.height < 1 || page.buffer.byteLength !== page.width * page.height * 4) return null
  const canvas = canvasOf(page.width, page.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.putImageData(new ImageData(new Uint8ClampedArray(page.buffer), page.width, page.height), 0, 0)
  return pngBytes(canvas)
}

ipcRenderer.on(IPC.pdf, (_e, id: unknown, bytes: unknown, px: unknown) => {
  const job = bytes instanceof Uint8Array && side(px) ? pdfStill(bytes, px) : Promise.resolve(null)
  void job.then(
    (png) => ipcRenderer.send(IPC.done, id, png),
    () => ipcRenderer.send(IPC.done, id, null),
  )
})

ipcRenderer.on(IPC.psd, (_e, id: unknown, bytes: unknown, px: unknown) => {
  const job = bytes instanceof Uint8Array && side(px) ? psdStill(bytes, px) : Promise.resolve(null)
  void job.then(
    (png) => ipcRenderer.send(IPC.done, id, png),
    () => ipcRenderer.send(IPC.done, id, null),
  )
})

ipcRenderer.on(IPC.model, (_e, id: unknown, bytes: unknown, px: unknown) => {
  const job = bytes instanceof Uint8Array && side(px) ? modelStill(bytes, px) : Promise.resolve(null)
  void job.then(
    (png) => ipcRenderer.send(IPC.done, id, png),
    () => ipcRenderer.send(IPC.done, id, null),
  )
})

ipcRenderer.on(IPC.video, (_e, id: unknown, url: unknown, px: unknown) => {
  const job = typeof url === 'string' && url.startsWith(VIDEO_URL) && side(px) ? videoStill(url, px) : Promise.resolve(null)
  void job.then(
    (png) => ipcRenderer.send(IPC.done, id, png),
    () => ipcRenderer.send(IPC.done, id, null),
  )
})

ipcRenderer.on(IPC.job, (_e, id: unknown, bytes: unknown, type: unknown, width: unknown, height: unknown) => {
  const job =
    bytes instanceof Uint8Array && typeof type === 'string' && side(width) && side(height)
      ? thumbnail(bytes, type, width, height)
      : Promise.resolve(null)
  void job.then(
    (png) => ipcRenderer.send(IPC.done, id, png),
    () => ipcRenderer.send(IPC.done, id, null),
  )
})

ipcRenderer.send(IPC.ready)
