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
  modelFile: 'thumbs:modelfile',
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
  /** One embedded picture bigger than this is not decoded; a drawn texture is this many pixels square (UVs are 0..1, so the shape of the original does not matter). */
  imageBytes: 24 * 1024 * 1024,
  textureSide: 512,
  /** Bytes read from a model that is not sent whole: the mesh data it draws (a Meshy export of 300 MB is mostly texture maps it never reads). */
  rangedBytes: 224 * 1024 * 1024,
  /** Time to draw, in ms: what is drawn by then is the picture. */
  budgetMs: 6_000,
}

type Rgb = readonly [number, number, number]

const NO_TINTS: ReadonlyMap<number, Rgb> = new Map()

/** The parts of a glTF document this reads. It comes from a file: every field may be anything, so each is checked. */
interface GltfDoc {
  scene?: number
  scenes?: { nodes?: number[] }[]
  nodes?: { children?: number[]; mesh?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[]
  meshes?: { primitives?: { attributes?: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[]
  accessors?: { bufferView?: number; byteOffset?: number; componentType?: number; normalized?: boolean; count?: number; type?: string; sparse?: unknown }[]
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number; byteStride?: number; extensions?: Record<string, unknown> }[]
  buffers?: { byteLength?: number; uri?: string }[]
  materials?: { pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: { index?: number } }; alphaMode?: string; alphaCutoff?: number }[]
  textures?: { source?: number; sampler?: number }[]
  samplers?: { wrapS?: number; wrapT?: number }[]
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

/** Where an accessor's elements lie in the BIN chunk, once every rule of `readAccessor` is met. */
interface Span {
  /** The first byte of the first element, and one past the last byte of the last one. */
  first: number
  end: number
  count: number
  type: { size: number; read: (v: DataView, at: number) => number; max: number }
  /** Bytes in one element, and from the start of one to the start of the next. */
  element: number
  stride: number
  scaled: boolean
}

/**
 * Where accessor `index` lies in a BIN chunk of `binLength` bytes, as `comps` numbers per element, or null when it cannot be read: not
 * in the file's own buffer, sparse, compressed, the wrong type, more than `maxCount` elements, or reaching outside its buffer view or the
 * buffer. `allowed`: the component types the caller takes (a normalized integer is turned into 0..1 or -1..1).
 */
function accessorSpan(doc: GltfDoc, binLength: number, index: unknown, comps: number, maxCount: number, allowed: readonly number[]): Span | null {
  if (!isIndex(index)) return null
  // Buffer 0 is the BIN chunk only when it names no file: one that does is data this never reads.
  if (doc.buffers?.[0]?.uri !== undefined) return null
  const acc = doc.accessors?.[index]
  if (!acc || typeof acc !== 'object' || acc.sparse !== undefined) return null
  const type = isIndex(acc.componentType) ? COMPONENT[acc.componentType] : undefined
  const count = acc.count
  if (!type || !allowed.includes(acc.componentType as number) || ACCESSOR_COMPONENTS[String(acc.type)] !== comps) return null
  if (!isIndex(count) || count === 0 || count > maxCount) return null
  const view = isIndex(acc.bufferView) ? doc.bufferViews?.[acc.bufferView] : undefined
  // The file's own buffer only (index 0, the BIN chunk): nothing is fetched from anywhere.
  if (!view || typeof view !== 'object' || (view.buffer ?? 0) !== 0 || view.extensions?.['EXT_meshopt_compression'] !== undefined) return null
  const viewStart = view.byteOffset ?? 0
  const viewLength = view.byteLength
  if (!isIndex(viewStart) || !isIndex(viewLength) || viewStart + viewLength > binLength) return null
  const element = type.size * comps
  const stride = isIndex(view.byteStride) && view.byteStride >= element ? view.byteStride : element
  const offset = acc.byteOffset ?? 0
  if (!isIndex(offset)) return null
  const first = viewStart + offset
  const end = first + stride * (count - 1) + element
  if (end > viewStart + viewLength) return null
  return { first, end, count, type, element, stride, scaled: acc.normalized === true && type.max > 0 }
}

/** The values of accessor `index` as `comps` numbers per element, or null when it cannot be read (see `accessorSpan`). */
function readAccessor<T extends Float32Array | Uint32Array>(
  g: Glb,
  index: unknown,
  comps: number,
  maxCount: number,
  allowed: readonly number[],
  make: (length: number) => T,
): T | null {
  const bin = g.bin
  if (!bin) return null
  const s = accessorSpan(g.doc, bin.length, index, comps, maxCount, allowed)
  if (!s) return null
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const out = make(s.count * comps)
  for (let i = 0; i < s.count; i++) {
    const at = s.first + i * s.stride
    for (let c = 0; c < comps; c++) {
      const x = s.type.read(data, at + c * s.type.size)
      out[i * comps + c] = s.scaled ? Math.max(x / s.type.max, -1) : x
    }
  }
  return out
}

/** One drawable primitive: vertex positions (and normals), the triangles as index triples, and its material (-1: none). */
interface Prim {
  pos: Float32Array
  nrm: Float32Array | null
  /** The first texture coordinates (two numbers a vertex), when the primitive has them. */
  uv: Float32Array | null
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
const UV_TYPES = [5126, 5121, 5123]

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
    const uv = readAccessor(g, p.attributes?.['TEXCOORD_0'], 2, vertices, UV_TYPES, (n) => new Float32Array(n))
    let idx: Uint32Array | null = null
    if (p.indices !== undefined) {
      idx = readAccessor(g, p.indices, 1, GLB_LIMITS.triangles * 3, INDEX_TYPES, (n) => new Uint32Array(n))
      if (!idx) continue
    }
    out.push({
      pos,
      nrm: normals && normals.length === pos.length ? normals : null,
      uv: uv && uv.length === vertices * 2 ? uv : null,
      tri: trianglesOf(mode, idx, vertices),
      material: isIndex(p.material) ? p.material : -1,
    })
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
  /** Base colour textures by material index (`loadTextures`): a primitive with UVs and a texture is drawn in the texture's colours. */
  textures?: ReadonlyMap<number, Tex>
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
  const textures = opts.textures
  const texel = new Float64Array(4)
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
    // A textured primitive takes its colours from the texture: only the material's factor is left to multiply it by.
    const uv = prim.uv
    const tex = uv ? textures?.get(prim.material) : undefined
    const colorKey = prim.material * 2 + (tex ? 1 : 0)
    let color = colors.get(colorKey)
    if (!color) colors.set(colorKey, (color = materialColor(g, prim.material, tex ? NO_TINTS : tints)))
    const [cr, cg, cb] = color
    const tri = prim.tri
    for (let t = 0; t + 2 < tri.length; t += 3 * every) {
      if ((drawn++ & 255) === 0 && now() > deadline) {
        late = true
        break
      }
      const a = tri[t]! * 3, b = tri[t + 1]! * 3, d = tri[t + 2]! * 3
      if (a >= pos.length || b >= pos.length || d >= pos.length) continue
      const ua = tri[t]! * 2, ub = tri[t + 1]! * 2, ud = tri[t + 2]! * 2
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
          let tr = 1, tg = 1, tb = 1
          if (tex && uv) {
            sampleTex(tex, w0 * uv[ua]! + w1 * uv[ub]! + w2 * uv[ud]!, w0 * uv[ua + 1]! + w1 * uv[ub + 1]! + w2 * uv[ud + 1]!, texel)
            // A see-through texel of a masked or blended material lets what is behind it show.
            if (texel[3]! < tex.cutoff) continue
            tr = texel[0]! / 255
            tg = texel[1]! / 255
            tb = texel[2]! / 255
          }
          depth[at] = z
          let r = fr * tr, gr = fg * tg, bl = fb * tb
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
            r = cr * k * tr
            gr = cg * k * tg
            bl = cb * k * tb
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

/* ---- base colour textures ---- */

/**
 * A base colour texture, decoded and made `GLB_LIMITS.textureSide` pixels square for drawing (UVs are 0..1, so the shape of the
 * original does not matter).
 */
export interface Tex {
  width: number
  height: number
  /** RGBA, sRGB, straight alpha. */
  data: Uint8ClampedArray
  /** The sampler's wrap modes (glTF: 10497 repeat, 33071 clamp to edge, 33648 mirrored repeat). */
  wrapS: number
  wrapT: number
  /** A texel with less alpha than this (0..255) is not drawn: the material's alpha mask or blend; 0 for an opaque material. */
  cutoff: number
}

const WRAP_REPEAT = 10497
const WRAP_CLAMP = 33071
const WRAP_MIRROR = 33648

/** Texel `i` of `n` under a wrap mode. */
function wrapTexel(i: number, n: number, mode: number): number {
  if (mode === WRAP_CLAMP) return i < 0 ? 0 : i >= n ? n - 1 : i
  const period = mode === WRAP_MIRROR ? n * 2 : n
  let w = i % period
  if (w < 0) w += period
  return mode === WRAP_MIRROR && w >= n ? period - 1 - w : w
}

/** The colour of `tex` at (u, v), bilinear: R, G, B and A, each 0..255, into `out`. A coordinate that is not a number is 0. */
export function sampleTex(tex: Tex, u: number, v: number, out: Float64Array): void {
  const x = (Number.isFinite(u) ? u : 0) * tex.width - 0.5
  const y = (Number.isFinite(v) ? v : 0) * tex.height - 0.5
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const xa = wrapTexel(x0, tex.width, tex.wrapS)
  const xb = wrapTexel(x0 + 1, tex.width, tex.wrapS)
  const ya = wrapTexel(y0, tex.height, tex.wrapT)
  const yb = wrapTexel(y0 + 1, tex.height, tex.wrapT)
  const d = tex.data
  const w = tex.width
  const a = (ya * w + xa) * 4
  const b = (ya * w + xb) * 4
  const c = (yb * w + xa) * 4
  const e = (yb * w + xb) * 4
  const w00 = (1 - fx) * (1 - fy)
  const w10 = fx * (1 - fy)
  const w01 = (1 - fx) * fy
  const w11 = fx * fy
  for (let k = 0; k < 4; k++) out[k] = d[a + k]! * w00 + d[b + k]! * w10 + d[c + k]! * w01 + d[e + k]! * w11
}

/** The average colour of the texels of `tex` that are not see-through (sRGB, 0..1), or null when there are none. */
function averageColor(tex: Tex): Rgb | null {
  const d = tex.data
  let r = 0, g = 0, b = 0, n = 0
  for (let i = 0; i + 3 < d.length; i += 4) {
    if (d[i + 3]! < 128) continue
    r += d[i]!
    g += d[i + 1]!
    b += d[i + 2]!
    n++
  }
  return n ? [r / n / 255, g / n / 255, b / n / 255] : null
}

/** Material `m`'s base colour picture, when it is one embedded in the file's own buffer: its image index, buffer view and type. */
function baseColorImage(doc: GltfDoc, m: number): { image: number; view: NonNullable<GltfDoc['bufferViews']>[number]; type: string; sampler: number | undefined } | null {
  const texture = doc.materials?.[m]?.pbrMetallicRoughness?.baseColorTexture?.index
  const entry = isIndex(texture) ? doc.textures?.[texture] : undefined
  const source = entry && isIndex(entry.source) ? entry.source : undefined
  const image = source !== undefined ? doc.images?.[source] : undefined
  const view = image && isIndex(image.bufferView) ? doc.bufferViews?.[image.bufferView] : undefined
  const type = image?.mimeType
  if (source === undefined || !view || typeof view !== 'object' || (view.buffer ?? 0) !== 0 || (type !== 'image/png' && type !== 'image/jpeg')) return null
  return { image: source, view, type, sampler: entry && isIndex(entry.sampler) ? entry.sampler : undefined }
}

/** The pixels of a PNG or JPEG scaled to a square of `side` (RGBA), or null when it does not decode. */
async function decodePixels(bytes: Uint8Array, type: string, side: number): Promise<Uint8ClampedArray | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), {
      resizeWidth: side,
      resizeHeight: side,
      resizeQuality: 'medium',
    })
    try {
      const canvas = canvasOf(side, side)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return null
      ctx.drawImage(bitmap, 0, 0)
      return ctx.getImageData(0, 0, side, side).data
    } finally {
      bitmap.close()
    }
  } catch {
    // A texture that does not decode: the material keeps its factor.
    return null
  }
}

/**
 * The base colour textures of the model (embedded PNG or JPEG only), decoded for drawing, by material index, and each one's
 * average colour: what a primitive without UVs is drawn in. Failures are left out.
 */
export async function loadTextures(g: Glb): Promise<{ textures: Map<number, Tex>; tints: Map<number, Rgb> }> {
  const textures = new Map<number, Tex>()
  const tints = new Map<number, Rgb>()
  const bin = g.bin
  const materials = g.doc.materials
  if (!bin || !Array.isArray(materials)) return { textures, tints }
  const side = GLB_LIMITS.textureSide
  const decoded = new Map<number, Uint8ClampedArray | null>()
  let spent = 0
  for (let m = 0; m < Math.min(materials.length, GLB_LIMITS.materials); m++) {
    const found = baseColorImage(g.doc, m)
    if (!found) continue
    let data = decoded.get(found.image)
    if (data === undefined) {
      const start = found.view.byteOffset ?? 0
      const length = found.view.byteLength
      if (!isIndex(start) || !isIndex(length) || length === 0 || length > GLB_LIMITS.imageBytes || start + length > bin.length || spent + length > GLB_LIMITS.textureBytes) continue
      spent += length
      data = await decodePixels(bin.slice(start, start + length), found.type, side)
      decoded.set(found.image, data)
    }
    if (!data) continue
    const sampler = found.sampler !== undefined ? g.doc.samplers?.[found.sampler] : undefined
    const material = materials[m]
    const mode = material?.alphaMode
    const cutoffAt = material?.alphaCutoff
    const cutoffFactor = isFiniteNumber(cutoffAt) ? Math.min(1, Math.max(0, cutoffAt)) : 0.5
    const tex: Tex = {
      width: side,
      height: side,
      data,
      wrapS: sampler && isIndex(sampler.wrapS) ? sampler.wrapS : WRAP_REPEAT,
      wrapT: sampler && isIndex(sampler.wrapT) ? sampler.wrapT : WRAP_REPEAT,
      cutoff: mode === 'MASK' ? Math.round(255 * cutoffFactor) : mode === 'BLEND' ? 128 : 0,
    }
    textures.set(m, tex)
    const average = averageColor(tex)
    if (average) tints.set(m, average)
  }
  return { textures, tints }
}

/* ---- a model too big to be sent whole: read in pieces ---- */

/** A file to read in pieces: its size, and `read(start, length)`, which gives exactly those bytes or null. */
export interface RangeSource {
  size: number
  read(start: number, length: number): Promise<Uint8Array | null>
}

/** Pieces of the BIN chunk read together when they lie within this many bytes of each other, and never more than this many at once. */
const RUN_GAP = 1 << 20
const RUN_MAX = 48 << 20

/** One piece of the BIN chunk the drawing needs: a mesh accessor's elements, or an embedded picture (`accessor` or `image` is -1). */
interface Piece {
  start: number
  length: number
  accessor: number
  image: number
  element: number
  stride: number
}

/**
 * A model out of a file that is not read whole (a Meshy export of 300 MB is mostly texture maps nothing here draws): the JSON, then
 * only the pieces of the BIN chunk that the drawing reads (the positions, normals, UVs and indices of the primitives it draws, and the
 * base colour pictures), laid end to end in a smaller buffer, with the document's accessors and pictures pointing at the copies.
 * What `rasterGlb` draws from the result is what it would draw from the whole file. Null when the file is no binary glTF, a read
 * fails, or there is no data to draw. The file is untrusted: every offset is checked, and what is read is bounded (`rangedBytes`,
 * or `opts.maxBytes`: tests lower it).
 */
export async function readGlbRanged(src: RangeSource, opts: { maxBytes?: number } = {}): Promise<Glb | null> {
  const maxBytes = opts.maxBytes ?? GLB_LIMITS.rangedBytes
  const size = src.size
  if (!isIndex(size) || size < 20) return null
  const head = await src.read(0, 20)
  if (!head || head.length !== 20) return null
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const total = hv.getUint32(8, true)
  const jsonLength = hv.getUint32(12, true)
  if (hv.getUint32(0, true) !== GLB_MAGIC || hv.getUint32(4, true) !== 2) return null
  if (total < 20 || total > size || hv.getUint32(16, true) !== GLB_CHUNK_JSON) return null
  if (jsonLength === 0 || jsonLength > GLB_LIMITS.json || 20 + jsonLength > total) return null
  const jsonBytes = await src.read(20, jsonLength)
  if (!jsonBytes || jsonBytes.length !== jsonLength) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(jsonBytes))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const doc = parsed as GltfDoc

  // The BIN chunk comes right after the JSON chunk (each is padded to four bytes).
  const binAt = 20 + ((jsonLength + 3) & ~3)
  if (binAt + 8 > total) return null
  const binHead = await src.read(binAt, 8)
  if (!binHead || binHead.length !== 8) return null
  const bv = new DataView(binHead.buffer, binHead.byteOffset, binHead.byteLength)
  const binLength = bv.getUint32(0, true)
  if (bv.getUint32(4, true) !== GLB_CHUNK_BIN || binLength > total - binAt - 8) return null
  const binStart = binAt + 8

  // Which accessors the drawing will read: the same primitives, in the same order, under the same budgets as `meshPrims`.
  const spans = new Map<number, Span>()
  let geometryBytes = 0
  const budget = { vertices: GLB_LIMITS.vertices }
  const seen = new Set<number>()
  const view: Glb = { doc, bin: null }
  plan: for (const at of placements(view)) {
    if (seen.has(at.mesh)) continue
    seen.add(at.mesh)
    const list = doc.meshes?.[at.mesh]?.primitives
    if (!Array.isArray(list)) continue
    for (const p of list.slice(0, 256)) {
      if (!p || typeof p !== 'object') continue
      const mode = p.mode ?? 4
      if (mode !== 4 && mode !== 5 && mode !== 6) continue
      const positionAt = p.attributes?.['POSITION']
      const position = accessorSpan(doc, binLength, positionAt, 3, budget.vertices, POSITION_TYPES)
      if (!position) continue
      const vertices = position.count
      budget.vertices -= vertices
      const found: [number, Span][] = [[positionAt as number, position]]
      const normalAt = p.attributes?.['NORMAL']
      const normal = accessorSpan(doc, binLength, normalAt, 3, vertices, NORMAL_TYPES)
      if (normal && normal.count === vertices) found.push([normalAt as number, normal])
      const uvAt = p.attributes?.['TEXCOORD_0']
      const uv = accessorSpan(doc, binLength, uvAt, 2, vertices, UV_TYPES)
      if (uv && uv.count === vertices) found.push([uvAt as number, uv])
      if (p.indices !== undefined) {
        const indices = accessorSpan(doc, binLength, p.indices, 1, GLB_LIMITS.triangles * 3, INDEX_TYPES)
        // A primitive whose indices cannot be read is left out, as `meshPrims` leaves it out.
        if (!indices) continue
        found.push([p.indices, indices])
      }
      // A primitive is taken whole or not at all.
      let extra = 0
      for (const [index, s] of found) if (!spans.has(index)) extra += s.end - s.first
      if (geometryBytes + extra > maxBytes) break plan
      for (const [index, s] of found) spans.set(index, s)
      geometryBytes += extra
    }
  }

  // The base colour pictures of the materials.
  const images = new Map<number, { start: number; length: number }>()
  let imageBytes = 0
  const materials = doc.materials
  if (Array.isArray(materials)) {
    for (let m = 0; m < Math.min(materials.length, GLB_LIMITS.materials); m++) {
      const found = baseColorImage(doc, m)
      if (!found || images.has(found.image)) continue
      const start = found.view.byteOffset ?? 0
      const length = found.view.byteLength
      if (!isIndex(start) || !isIndex(length) || length === 0 || length > GLB_LIMITS.imageBytes || start + length > binLength || imageBytes + length > GLB_LIMITS.textureBytes) continue
      imageBytes += length
      images.set(found.image, { start, length })
    }
  }
  if (!spans.size) return null

  const pieces: Piece[] = []
  for (const [accessor, s] of spans) pieces.push({ start: s.first, length: s.end - s.first, accessor, image: -1, element: s.element, stride: s.stride })
  for (const [image, im] of images) pieces.push({ start: im.start, length: im.length, accessor: -1, image, element: 0, stride: 0 })
  pieces.sort((a, b) => a.start - b.start)

  // Read them in file order, neighbours together, and lay them end to end.
  const compact = new Uint8Array(geometryBytes + imageBytes)
  const views: NonNullable<GltfDoc['bufferViews']> = Array.isArray(doc.bufferViews) ? [...doc.bufferViews] : []
  const accessors: NonNullable<GltfDoc['accessors']> = Array.isArray(doc.accessors) ? [...doc.accessors] : []
  const pictures: NonNullable<GltfDoc['images']> = Array.isArray(doc.images) ? [...doc.images] : []
  let put = 0
  for (let i = 0; i < pieces.length; ) {
    const first = pieces[i]!
    let runEnd = first.start + first.length
    let j = i
    while (j + 1 < pieces.length) {
      const next = pieces[j + 1]!
      const end = Math.max(runEnd, next.start + next.length)
      if (next.start - runEnd > RUN_GAP || end - first.start > RUN_MAX) break
      runEnd = end
      j++
    }
    const run = await src.read(binStart + first.start, runEnd - first.start)
    if (!run || run.length !== runEnd - first.start) return null
    for (let k = i; k <= j; k++) {
      const piece = pieces[k]!
      const from = piece.start - first.start
      compact.set(run.subarray(from, from + piece.length), put)
      views.push({ buffer: 0, byteOffset: put, byteLength: piece.length, ...(piece.stride > piece.element ? { byteStride: piece.stride } : {}) })
      const at = views.length - 1
      if (piece.accessor >= 0) accessors[piece.accessor] = { ...accessors[piece.accessor], bufferView: at, byteOffset: 0 }
      else pictures[piece.image] = { ...pictures[piece.image], bufferView: at }
      put += piece.length
    }
    i = j + 1
  }
  return { doc: { ...doc, accessors, bufferViews: views, images: pictures, buffers: [{ byteLength: compact.length }] }, bin: compact }
}

/** How long one piece of a model may take to arrive from main. */
const RANGE_TIMEOUT_MS = 12_000

/** A model file served to this page on a one-job address (main says how big it is), read in pieces with HTTP ranges. */
function urlSource(url: string, size: number): RangeSource {
  return {
    size,
    read: async (start, length) => {
      if (!isIndex(start) || !isIndex(length) || length === 0 || start + length > size) return null
      const stop = new AbortController()
      const timer = setTimeout(() => stop.abort(), RANGE_TIMEOUT_MS)
      try {
        const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` }, signal: stop.signal })
        // Only a range answer counts: a server that sends the whole file instead is not read.
        if (res.status !== 206) {
          void res.body?.cancel()
          return null
        }
        const bytes = new Uint8Array(await res.arrayBuffer())
        return bytes.length === length ? bytes : null
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** PNG bytes of the model drawn as a square of `side` px, textures and all, or null when there is nothing to draw. */
async function drawModel(glb: Glb, side: number): Promise<Uint8Array | null> {
  const { textures, tints } = await loadTextures(glb)
  const pixels = rasterGlb(glb, side, tints, { textures })
  if (!pixels) return null
  const canvas = canvasOf(side, side)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, side, side), 0, 0)
  return pngBytes(canvas)
}

/** PNG bytes of the model in `bytes` (a whole binary glTF) drawn as a square of `side` px, or null when there is nothing to draw. */
async function modelStill(bytes: Uint8Array, side: number): Promise<Uint8Array | null> {
  const glb = parseGlb(bytes)
  return glb ? drawModel(glb, side) : null
}

/** The same for a model on a one-job address that is read in pieces (`size` bytes: main's own count). */
async function modelStillFile(url: string, size: number, side: number): Promise<Uint8Array | null> {
  const glb = await readGlbRanged(urlSource(url, size))
  return glb ? drawModel(glb, side) : null
}

ipcRenderer.on(IPC.modelFile, (_e, id: unknown, url: unknown, size: unknown, px: unknown) => {
  const job = typeof url === 'string' && url.startsWith(VIDEO_URL) && isIndex(size) && side(px) ? modelStillFile(url, size, px) : Promise.resolve(null)
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
