/**
 * The model proxy: a small, bounded stand-in for a 3D model (`.glb`), the one thing a window that draws a model is ever given. A model
 * on a reference board is turned with the pointer, and a model in the brain is shown as a real shape when the camera comes near; both
 * would otherwise have to read a file that can be 300 MB and parse it, in a window that already decodes the user's pictures. So the
 * thumbnail helper (the sandboxed window that has the model's reader, its texture sampler and no GPU) bakes the model once into
 * this: up to 24,000 triangles (vertices merged on a grid), a colour for every vertex (the model's base colour texture sampled
 * there), and nothing else. A window that draws it reads typed arrays whose sizes this file checks, never anything a model file says.
 *
 * Layout, little-endian, exactly `proxyBytes(vertices, triangles)` long:
 *   0   'ABPX'
 *   4   u8   version (1)
 *   5   u8   reserved, 0
 *   6   u16  vertices (1 to PROXY_LIMITS.vertices)
 *   8   u32  triangles (1 to PROXY_LIMITS.triangles)
 *   12  f32  centre x, y, z of the model's bounds, in the model's own units
 *   24  f32  half: half the longest side of the bounds (> 0)
 *   28  u32  reserved, 0
 *   32  i16  x, y, z of every vertex: (p - centre) / half, so -32767 to 32767 is -1 to 1
 *       u8   r, g, b of every vertex (sRGB: the material's colour with its texture applied, before light)
 *       u8   one pad byte when the vertex count is odd
 *       u16  a, b, c of every triangle: indices of vertices
 *
 * The same numbers are written down in the helper's preload (the encoder: a sandboxed preload cannot import this file) and in main's
 * `proxyOf` (the check on what the helper sends back); a test pins the three together.
 */

export const PROXY_MAGIC = [0x41, 0x42, 0x50, 0x58] as const
export const PROXY_VERSION = 1
export const PROXY_HEADER_BYTES = 32
/** The most a proxy may hold (what `decodeProxy` accepts). */
export const PROXY_LIMITS = { vertices: 65_535, triangles: 40_000 } as const
/** What the helper aims for: more triangles than this are merged away by a coarser grid. */
export const PROXY_TARGET_TRIANGLES = 24_000

/** The exact size in bytes of a proxy with this many vertices and triangles. */
export function proxyBytes(vertices: number, triangles: number): number {
  return PROXY_HEADER_BYTES + vertices * 6 + vertices * 3 + (vertices & 1) + triangles * 6
}

/** The size of the biggest proxy there can be. */
export const PROXY_MAX_BYTES = proxyBytes(PROXY_LIMITS.vertices, PROXY_LIMITS.triangles)

export interface ModelProxy {
  vertices: number
  triangles: number
  /** The middle of the model's bounds, in its own units, and half its longest side: what `positions` were scaled by. */
  centre: [number, number, number]
  half: number
  /** x, y, z of every vertex, centred and scaled so that the longest side of the bounds is 2 (every number is within -1 to 1). */
  positions: Float32Array
  /** Smooth normals (unit length), from the triangles: a vertex's is the area-weighted sum of its triangles' normals. */
  normals: Float32Array
  /** r, g, b of every vertex, 0 to 255. */
  colors: Uint8Array
  /** a, b, c of every triangle: vertex indices, each below `vertices`. */
  indices: Uint16Array
  /** How far the furthest vertex is from the origin (at most the square root of 3). */
  radius: number
}

/** The vertex and triangle counts a proxy's header promises, or null when the bytes cannot be one (wrong magic, version, sizes or length). */
export function proxyHeader(bytes: Uint8Array): { vertices: number; triangles: number } | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < PROXY_HEADER_BYTES || bytes.length > PROXY_MAX_BYTES) return null
  for (let i = 0; i < 4; i++) if (bytes[i] !== PROXY_MAGIC[i]) return null
  if (bytes[4] !== PROXY_VERSION || bytes[5] !== 0) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const vertices = v.getUint16(6, true)
  const triangles = v.getUint32(8, true)
  if (vertices < 1 || vertices > PROXY_LIMITS.vertices || triangles < 1 || triangles > PROXY_LIMITS.triangles) return null
  if (v.getUint32(28, true) !== 0) return null
  const half = v.getFloat32(24, true)
  if (!Number.isFinite(half) || !(half > 0) || half > 1e12) return null
  for (let i = 0; i < 3; i++) if (!Number.isFinite(v.getFloat32(12 + i * 4, true))) return null
  return bytes.length === proxyBytes(vertices, triangles) ? { vertices, triangles } : null
}

/**
 * The proxy in `bytes`, or null when it is anything else: the header checks of `proxyHeader`, and every triangle must name vertices
 * that exist. Nothing is trusted past that: the arrays are copied into aligned arrays of exactly the sizes the header gave.
 */
export function decodeProxy(bytes: Uint8Array): ModelProxy | null {
  const head = proxyHeader(bytes)
  if (!head) return null
  const { vertices, triangles } = head
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const centre: [number, number, number] = [v.getFloat32(12, true), v.getFloat32(16, true), v.getFloat32(20, true)]
  const half = v.getFloat32(24, true)

  const positions = new Float32Array(vertices * 3)
  let radius = 0
  for (let i = 0; i < vertices; i++) {
    const at = PROXY_HEADER_BYTES + i * 6
    const x = Math.max(-1, v.getInt16(at, true) / 32767)
    const y = Math.max(-1, v.getInt16(at + 2, true) / 32767)
    const z = Math.max(-1, v.getInt16(at + 4, true) / 32767)
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z
    radius = Math.max(radius, Math.hypot(x, y, z))
  }
  const colorAt = PROXY_HEADER_BYTES + vertices * 6
  const colors = bytes.slice(colorAt, colorAt + vertices * 3)
  const indexAt = colorAt + vertices * 3 + (vertices & 1)
  const indices = new Uint16Array(triangles * 3)
  for (let i = 0; i < indices.length; i++) {
    const k = v.getUint16(indexAt + i * 2, true)
    if (k >= vertices) return null
    indices[i] = k
  }

  // Smooth normals: each triangle's (unnormalised, so area-weighted) normal goes to its three corners.
  const normals = new Float32Array(vertices * 3)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!
    const wx = positions[c]! - positions[a]!, wy = positions[c + 1]! - positions[a + 1]!, wz = positions[c + 2]! - positions[a + 2]!
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
    for (const k of [a, b, c]) {
      normals[k] = normals[k]! + nx
      normals[k + 1] = normals[k + 1]! + ny
      normals[k + 2] = normals[k + 2]! + nz
    }
  }
  for (let i = 0; i < vertices; i++) {
    const x = normals[i * 3]!, y = normals[i * 3 + 1]!, z = normals[i * 3 + 2]!
    const l = Math.hypot(x, y, z)
    if (l > 1e-12) {
      normals[i * 3] = x / l
      normals[i * 3 + 1] = y / l
      normals[i * 3 + 2] = z / l
    } else {
      normals[i * 3] = 0
      normals[i * 3 + 1] = 1
      normals[i * 3 + 2] = 0
    }
  }
  return { vertices, triangles, centre, half, positions, normals, colors, indices, radius }
}

/** What `encodeProxy` takes: the same numbers the file holds. */
export interface ProxyParts {
  centre: readonly [number, number, number]
  half: number
  /** x, y, z of every vertex as the file keeps them (-32767 to 32767). */
  positions: ArrayLike<number>
  colors: ArrayLike<number>
  indices: ArrayLike<number>
}

/**
 * The bytes of a proxy (the helper writes its own copy of this; here for tests and tools). Throws on counts the format cannot hold,
 * so that nothing writes a file `decodeProxy` would refuse.
 */
export function encodeProxy(parts: ProxyParts): Uint8Array {
  const vertices = parts.positions.length / 3
  const triangles = parts.indices.length / 3
  if (!Number.isInteger(vertices) || vertices < 1 || vertices > PROXY_LIMITS.vertices) throw new Error(`a proxy holds 1 to ${PROXY_LIMITS.vertices} vertices, not ${vertices}`)
  if (!Number.isInteger(triangles) || triangles < 1 || triangles > PROXY_LIMITS.triangles) throw new Error(`a proxy holds 1 to ${PROXY_LIMITS.triangles} triangles, not ${triangles}`)
  if (parts.colors.length !== vertices * 3) throw new Error('a proxy needs one colour for every vertex')
  const out = new Uint8Array(proxyBytes(vertices, triangles))
  const v = new DataView(out.buffer)
  for (let i = 0; i < 4; i++) out[i] = PROXY_MAGIC[i]!
  out[4] = PROXY_VERSION
  v.setUint16(6, vertices, true)
  v.setUint32(8, triangles, true)
  for (let i = 0; i < 3; i++) v.setFloat32(12 + i * 4, parts.centre[i]!, true)
  v.setFloat32(24, parts.half, true)
  for (let i = 0; i < vertices * 3; i++) v.setInt16(PROXY_HEADER_BYTES + i * 2, Math.max(-32767, Math.min(32767, Math.round(parts.positions[i]!))), true)
  const colorAt = PROXY_HEADER_BYTES + vertices * 6
  for (let i = 0; i < vertices * 3; i++) out[colorAt + i] = Math.max(0, Math.min(255, Math.round(parts.colors[i]!)))
  const indexAt = colorAt + vertices * 3 + (vertices & 1)
  for (let i = 0; i < triangles * 3; i++) {
    const k = parts.indices[i]!
    if (!Number.isInteger(k) || k < 0 || k >= vertices) throw new Error('a triangle names a vertex that is not there')
    v.setUint16(indexAt + i * 2, k, true)
  }
  return out
}
