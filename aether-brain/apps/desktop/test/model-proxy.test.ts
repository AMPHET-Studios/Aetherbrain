import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROXY_HEADER_BYTES,
  PROXY_LIMITS,
  PROXY_MAGIC,
  PROXY_MAX_BYTES,
  PROXY_TARGET_TRIANGLES,
  decodeProxy,
  modelBrightness as coreBrightness,
  proxyBytes as coreProxyBytes,
  renderProxy,
} from '@aether/core'
import { serveVideo } from '../src/main/assets.js'
import { MAX_PROXY_BYTES, PROXY_MAGIC as MAIN_MAGIC, PROXY_HEADER_BYTES as MAIN_HEADER, PROXY_MAX_TRIANGLES, PROXY_MAX_VERTICES, THUMB_IPC, VIDEO_URL_PREFIX, proxyOf, proxySize } from '../src/main/thumbnailer.js'
import { Packer, fakePage, glb, loadPreload, type Doc, type Pre } from './helpers/glb-preload.js'
import { lf } from './lf.js'

/**
 * The model proxy as the thumbnail helper bakes it: up to 24,000 triangles of a model, in the world, with a colour at every vertex (its
 * base colour texture sampled there), which a window draws itself. Read here with core's own decoder and drawn with core's own renderer,
 * so that what the helper writes, main checks and a window reads are one format.
 */

const here = path.dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ */
/* Models                                                             */
/* ------------------------------------------------------------------ */

/** The stand-in decoder's "picture": the left half of the texture is `left`, the right half `right` (RGBA each). */
const picture = (left: number[], right: number[]): Uint8Array => Uint8Array.of(...left, ...right)
const RED = [255, 0, 0, 255]
const BLUE = [0, 0, 255, 255]
const GONE = [0, 0, 0, 0]

interface SphereOptions {
  lat?: number
  lon?: number
  /** baseColorFactor (linear 0..1, RGB). Default none: a light grey. */
  factor?: number[]
  /** A base colour picture: the u coordinate runs 0 to 1 round the sphere, so the left half of it is the left half of the texture. */
  image?: Uint8Array
  alphaMode?: string
  /** Node placements: one node per entry, each with its own translation and scale. */
  nodes?: { translation?: number[]; scale?: number[] }[]
  noNormals?: boolean
}

/** A UV sphere of radius 1. */
function sphereGlb(o: SphereOptions = {}): Uint8Array {
  const lat = o.lat ?? 12
  const lon = o.lon ?? 16
  const pos: number[] = []
  const nrm: number[] = []
  const uv: number[] = []
  for (let i = 0; i <= lat; i++) {
    const t = (i / lat) * Math.PI
    for (let j = 0; j <= lon; j++) {
      const a = (j / lon) * Math.PI * 2
      const x = Math.sin(t) * Math.cos(a), y = Math.cos(t), z = Math.sin(t) * Math.sin(a)
      pos.push(x, y, z)
      nrm.push(x, y, z)
      uv.push(j / lon, i / lat)
    }
  }
  const idx: number[] = []
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const a = i * (lon + 1) + j
      const b = a + 1
      const c = a + (lon + 1)
      const d = c + 1
      idx.push(a, c, b, b, c, d)
    }
  }
  const p = new Packer()
  const attributes: Doc = { POSITION: p.floats(pos, 'VEC3'), TEXCOORD_0: p.floats(uv, 'VEC2') }
  if (!o.noNormals) attributes['NORMAL'] = p.floats(nrm, 'VEC3')
  const indices = pos.length / 3 > 65_535 ? p.accessor(p.view(new Uint8Array(new Uint32Array(idx).buffer)), { componentType: 5125, count: idx.length, type: 'SCALAR' }) : p.indices16(idx)
  const material: Doc = { pbrMetallicRoughness: { baseColorFactor: o.factor ? [...o.factor, 1] : [1, 1, 1, 1] } }
  const doc: Doc = { asset: { version: '2.0' } }
  if (o.image) {
    const at = p.view(o.image)
    doc['images'] = [{ bufferView: at, mimeType: 'image/png' }]
    doc['textures'] = [{ source: 0 }]
    material['pbrMetallicRoughness'].baseColorTexture = { index: 0 }
  }
  if (o.alphaMode) material['alphaMode'] = o.alphaMode
  doc['meshes'] = [{ primitives: [{ attributes, indices, material: 0 }] }]
  doc['materials'] = [material]
  doc['nodes'] = (o.nodes ?? [{}]).map((n) => ({ mesh: 0, ...n }))
  doc['scenes'] = [{ nodes: doc['nodes'].map((_: unknown, i: number) => i) }]
  doc['scene'] = 0
  doc['bufferViews'] = p.views
  doc['accessors'] = p.accessors
  const bin = p.bin()
  doc['buffers'] = [{ byteLength: bin.length }]
  return glb(doc, bin)
}

/** A flat model of `triangles` triangles: each a separate three vertices, with u at `us[i]` (the same for its three corners). */
function stripGlb(us: number[], image?: Uint8Array, alphaMode?: string, extraPositions?: (i: number) => number[]): Uint8Array {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  us.forEach((u, i) => {
    const x = i * 3
    pos.push(...(extraPositions ? extraPositions(i) : [x, 0, 0, x + 1, 0, 0, x, 1, 0]))
    uv.push(u, 0.5, u, 0.5, u, 0.5)
    idx.push(i * 3, i * 3 + 1, i * 3 + 2)
  })
  const p = new Packer()
  const attributes: Doc = { POSITION: p.floats(pos, 'VEC3'), TEXCOORD_0: p.floats(uv, 'VEC2') }
  const indices = p.indices16(idx)
  const material: Doc = { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }
  const doc: Doc = { asset: { version: '2.0' } }
  if (image) {
    doc['images'] = [{ bufferView: p.view(image), mimeType: 'image/png' }]
    doc['textures'] = [{ source: 0 }]
    material['pbrMetallicRoughness'].baseColorTexture = { index: 0 }
  }
  if (alphaMode) material['alphaMode'] = alphaMode
  doc['meshes'] = [{ primitives: [{ attributes, indices, material: 0 }] }]
  doc['materials'] = [material]
  doc['nodes'] = [{ mesh: 0 }]
  doc['scenes'] = [{ nodes: [0] }]
  doc['scene'] = 0
  doc['bufferViews'] = p.views
  doc['accessors'] = p.accessors
  const bin = p.bin()
  doc['buffers'] = [{ byteLength: bin.length }]
  return glb(doc, bin)
}

/* ------------------------------------------------------------------ */
/* The preload                                                        */
/* ------------------------------------------------------------------ */

let pre: Pre
beforeAll(async () => {
  pre = (await loadPreload(fakePage().globals)).pre
})

/** Parse the file, load its textures and bake. */
async function bake(file: Uint8Array, opts?: { now?: () => number; budgetMs?: number; target?: number }): Promise<Uint8Array | null> {
  const g = pre.parseGlb(file)
  if (!g) return null
  const t = await pre.loadTextures(g)
  return pre.bakeProxy(g, t.textures, t.tints, opts)
}

const baked = async (file: Uint8Array, opts?: { target?: number }) => decodeProxy((await bake(file, opts))!)!

/** Pixels that are not the ground, as in the core tests. */
function covered(img: Uint8ClampedArray, side: number): number {
  let n = 0
  for (let y = 0; y < side; y++) {
    const bg = [img[y * side * 4]!, img[y * side * 4 + 1]!, img[y * side * 4 + 2]!]
    for (let x = 0; x < side; x++) {
      const o = (y * side + x) * 4
      if (Math.abs(img[o]! - bg[0]!) + Math.abs(img[o + 1]! - bg[1]!) + Math.abs(img[o + 2]! - bg[2]!) > 6) n++
    }
  }
  return n
}

describe('bakeProxy', () => {
  it('keeps a small model as it is: its vertices and triangles, centred and scaled to the box the format uses', async () => {
    const p = await baked(sphereGlb({ lat: 6, lon: 8 }))
    expect(p.vertices).toBe(7 * 9)
    expect(p.triangles).toBe(6 * 8 * 2)
    expect(p.centre[0]).toBeCloseTo(0, 5)
    expect(p.centre[1]).toBeCloseTo(0, 5)
    expect(p.centre[2]).toBeCloseTo(0, 5)
    expect(p.half).toBeCloseTo(1, 5)
    expect(p.radius).toBeCloseTo(1, 2)
    // Every vertex of a sphere is a unit away from its middle.
    for (let i = 0; i < p.vertices; i++) expect(Math.hypot(p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!)).toBeCloseTo(1, 3)
  })

  it('colours a vertex with the material’s colour: a light grey with none, the factor with one', async () => {
    const grey = await baked(sphereGlb({ lat: 4, lon: 6 }))
    // No colour of its own is drawn as a light grey (0.8), never white.
    for (let i = 0; i < grey.vertices * 3; i++) expect(grey.colors[i]).toBe(204)
    const red = await baked(sphereGlb({ lat: 4, lon: 6, factor: [1, 0, 0] }))
    expect([...red.colors.slice(0, 3)]).toEqual([204, 0, 0])
    // The factor is linear light, drawn as sRGB: 0.5 is 0.735 of the way up.
    const half = await baked(sphereGlb({ lat: 4, lon: 6, factor: [0.5, 0.5, 0.5] }))
    expect(half.colors[0]).toBeGreaterThan(140)
    expect(half.colors[0]).toBeLessThan(155)
  })

  it('samples the base colour texture at every vertex (a picture inside the file, wrapped as the file asks)', async () => {
    // A sphere whose u runs round it: the vertices of the first half of the turn are red and the others blue (the stand-in decoder's picture).
    const p = await baked(sphereGlb({ lat: 8, lon: 16, image: picture(RED, BLUE) }))
    let red = 0
    let blue = 0
    for (let i = 0; i < p.vertices; i++) {
      const r = p.colors[i * 3]!, b = p.colors[i * 3 + 2]!
      if (r > 150 && b < 60) red++
      else if (b > 150 && r < 60) blue++
    }
    expect(red).toBeGreaterThan(p.vertices * 0.3)
    expect(blue).toBeGreaterThan(p.vertices * 0.3)
  })

  it('leaves out a triangle whose three corners are see-through in a masked material, and keeps the rest', async () => {
    // Four triangles, u = 0.1 (the left half of the picture: transparent) twice and 0.9 (opaque blue) twice.
    const file = stripGlb([0.1, 0.9, 0.1, 0.9], picture(GONE, BLUE), 'MASK')
    const p = await baked(file)
    expect(p.triangles).toBe(2)
    for (let i = 0; i < p.vertices; i++) expect([...p.colors.slice(i * 3, i * 3 + 3)]).toEqual([0, 0, 204])
    // Without the mask the material is opaque: every triangle stays, and the transparent half is the colour its pixels have.
    expect((await baked(stripGlb([0.1, 0.9, 0.1, 0.9], picture(GONE, BLUE)))).triangles).toBe(4)
  })

  it('merges a bigger model on a grid until it has no more triangles than the target, and keeps its shape', async () => {
    // 44,800 triangles: nearly twice what a proxy aims for.
    const file = sphereGlb({ lat: 140, lon: 160 })
    const p = await baked(file)
    expect(p.triangles).toBeLessThanOrEqual(PROXY_TARGET_TRIANGLES)
    expect(p.triangles).toBeGreaterThan(PROXY_TARGET_TRIANGLES / 3)
    expect(p.vertices).toBeLessThanOrEqual(PROXY_LIMITS.vertices)
    // Merged vertices are means of the ones they replace: a little inside the sphere, never off it by more than a cell.
    for (let i = 0; i < p.vertices; i++) {
      const d = Math.hypot(p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!)
      expect(d).toBeGreaterThan(0.9)
      expect(d).toBeLessThan(1.001)
    }
    const small = await baked(file, { target: 300 })
    expect(small.triangles).toBeLessThanOrEqual(300)
    expect(small.triangles).toBeGreaterThan(30)
    // A coarser target is fewer triangles still: the grid is the dial.
    const smaller = await baked(file, { target: 100 })
    expect(smaller.triangles).toBeLessThanOrEqual(100)
    expect(smaller.triangles).toBeLessThan(small.triangles)
  })

  it('merges a colour with the others in its cell: a red half and a blue half stay two colours, with purple only along the seam', async () => {
    const p = await baked(sphereGlb({ lat: 48, lon: 64, image: picture(RED, BLUE) }), { target: 800 })
    let pure = 0
    for (let i = 0; i < p.vertices; i++) {
      const r = p.colors[i * 3]!, b = p.colors[i * 3 + 2]!
      if ((r > 150 && b < 60) || (b > 150 && r < 60)) pure++
    }
    expect(pure).toBeGreaterThan(p.vertices * 0.7)
  })

  it('draws like the thumbnail does: the same lit sphere in the same colour, a little bigger (the proxy’s scale is its bounding sphere)', async () => {
    const file = sphereGlb({ lat: 32, lon: 48, factor: [0.8, 0.1, 0.1] })
    const proxy = await baked(file)
    const g = pre.parseGlb(file)!
    const still = pre.rasterGlb(g, 128)!
    const mine = renderProxy(proxy, { side: 128, yaw: 35, pitch: 24 })!
    // Discs of 0.8 and 0.86 of the side: an area ratio of (0.86 / 0.8)^2 = 1.156.
    const ratio = covered(mine.pixels, 128) / covered(still, 128)
    expect(ratio).toBeGreaterThan(1.1)
    expect(ratio).toBeLessThan(1.22)
    // The brightest spot and the middle are the same colour to within a few steps: the same light, the same exposure.
    const at = (img: Uint8ClampedArray, x: number, y: number) => [img[(y * 128 + x) * 4]!, img[(y * 128 + x) * 4 + 1]!, img[(y * 128 + x) * 4 + 2]!]
    const a = at(still, 64, 64)
    const b = at(mine.pixels, 64, 64)
    for (let k = 0; k < 3; k++) expect(Math.abs(a[k]! - b[k]!)).toBeLessThan(Math.max(10, a[k]! * 0.08))
  })

  it('places the model in the world: its node’s translation and scale, and every node that uses its mesh', async () => {
    const moved = await baked(sphereGlb({ lat: 6, lon: 8, nodes: [{ translation: [5, 0, 0], scale: [2, 2, 2] }] }))
    expect(moved.centre[0]).toBeCloseTo(5, 4)
    expect(moved.centre[1]).toBeCloseTo(0, 4)
    expect(moved.half).toBeCloseTo(2, 4)
    const two = await baked(sphereGlb({ lat: 6, lon: 8, nodes: [{ translation: [3, 0, 0] }, { translation: [-3, 0, 0] }] }))
    expect(two.triangles).toBe(6 * 8 * 2 * 2)
    expect(two.centre[0]).toBeCloseTo(0, 4)
    // Two unit spheres three either side of the middle: bounds -4 to 4 along x, so half is 4, and they sit at x = ±0.75 of that box.
    expect(two.half).toBeCloseTo(4, 4)
  })

  it('is the same bytes every time, and the bytes the decoder and the size formula agree on', async () => {
    const file = sphereGlb({ lat: 48, lon: 64, image: picture(RED, BLUE) })
    const a = (await bake(file))!
    const b = (await bake(file))!
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0)
    const p = decodeProxy(a)!
    expect(a.length).toBe(coreProxyBytes(p.vertices, p.triangles))
    expect(a.length).toBeLessThan(PROXY_MAX_BYTES)
    // At the target a proxy is a few hundred KB at most.
    expect(a.length).toBeLessThan(400 * 1024)
  })

  it('answers null for a model with nothing to draw, and skips a vertex that is not a place', async () => {
    // Lines only (mode 1): nothing a proxy holds.
    const p = new Packer()
    const lines = glb(
      {
        asset: { version: '2.0' },
        meshes: [{ primitives: [{ attributes: { POSITION: p.floats([0, 0, 0, 1, 1, 1], 'VEC3') }, mode: 1 }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
        bufferViews: p.views,
        accessors: p.accessors,
        buffers: [{ byteLength: p.bin().length }],
      },
      p.bin(),
    )
    expect(await bake(lines)).toBeNull()
    // No mesh at all.
    expect(await bake(glb({ asset: { version: '2.0' }, nodes: [{}], scenes: [{ nodes: [0] }] }))).toBeNull()
    // One of a quad's corners is NaN: the triangle that uses it is left out, and the numbers written are finite.
    const q = stripGlb([0.5, 0.5], undefined, undefined, (i) => (i === 0 ? [0, 0, 0, 1, 0, 0, 0, 1, 0] : [NaN, 0, 0, 1, 0, 0, 0, 1, 0]))
    const out = await baked(q)
    expect(out.triangles).toBe(1)
    expect(Number.isFinite(out.half)).toBe(true)
    // Everything is the same place: no size, no proxy.
    expect(await bake(stripGlb([0.5], undefined, undefined, () => [1, 1, 1, 1, 1, 1, 1, 1, 1]))).toBeNull()
  })

  it('gives up when it takes longer than its time, with nothing and not a half-made proxy', async () => {
    let t = 0
    const out = await bake(sphereGlb({ lat: 8, lon: 8 }), { now: () => (t += 1000), budgetMs: 10 })
    expect(out).toBeNull()
  })

  it('merges a model with more vertices than a proxy may hold', async () => {
    // 300 by 300 bands: 90,601 vertices (the indices need 32 bits) and 180,000 triangles: merged, never above the limits.
    const p = await baked(sphereGlb({ lat: 300, lon: 300 }))
    expect(p.vertices).toBeLessThanOrEqual(PROXY_LIMITS.vertices)
    expect(p.triangles).toBeLessThanOrEqual(PROXY_TARGET_TRIANGLES)
  })
})

/* ------------------------------------------------------------------ */
/* The job, over its channel                                          */
/* ------------------------------------------------------------------ */

describe('thumb-preload: the proxy job', () => {
  let dir: string
  let abs: string
  let size: number
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-proxy-'))
    abs = path.join(dir, 'ball.glb')
    const file = sphereGlb({ lat: 12, lon: 16, image: picture(RED, BLUE) })
    size = file.length
    await fs.writeFile(abs, file)
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const URL = `${VIDEO_URL_PREFIX}job-9`

  async function helper(served: Map<string, string>) {
    const fetchStub = async (url: string, init?: { headers?: Record<string, string> }) => {
      const file = served.get(url)
      if (!file) return new Response(null, { status: 404 })
      return serveVideo(file, 'model/gltf-binary', init?.headers?.['Range'] ?? null)
    }
    const { sent, listeners } = await loadPreload(fakePage({ fetch: fetchStub }).globals)
    return async (...args: unknown[]) => {
      const before = sent.length
      listeners.get(THUMB_IPC.modelProxy)!({}, ...args)
      const deadline = Date.now() + 5000
      while (sent.length === before) {
        if (Date.now() > deadline) throw new Error('no answer')
        await new Promise((r) => setTimeout(r, 5))
      }
      return sent.at(-1)!
    }
  }

  it('is on its own channel, and answers the proxy of the model it read from the address, in pieces', async () => {
    expect(THUMB_IPC.modelProxy).toBe('thumbs:modelproxy')
    const run = await helper(new Map([[URL, abs]]))
    const [channel, id, bytes] = (await run(7, URL, size)) as [string, number, Uint8Array]
    expect([channel, id]).toEqual([THUMB_IPC.done, 7])
    const p = decodeProxy(bytes)!
    expect(p.triangles).toBe(12 * 16 * 2)
    // The picture inside the file was read and sampled: red and blue vertices, not the grey of no texture.
    expect([...new Set(Array.from({ length: p.vertices }, (_, i) => p.colors[i * 3]! > 150 && p.colors[i * 3 + 2]! < 60))]).toContain(true)
    expect(proxyOf(bytes)).not.toBeNull()
  })

  it('answers null for an address that is not a job, a size that is not a number, a model that is not one, and a file that is gone', async () => {
    const run = await helper(new Map([[URL, abs]]))
    expect((await run(1, 'https://example.com/x.glb', size))[2]).toBeNull()
    expect((await run(2, 'file:///etc/passwd', size))[2]).toBeNull()
    expect((await run(3, 7, size))[2]).toBeNull()
    expect((await run(4, URL, -1))[2]).toBeNull()
    expect((await run(5, URL, 1.5))[2]).toBeNull()
    expect((await run(6, URL, '100'))[2]).toBeNull()
    expect((await run(7, `${VIDEO_URL_PREFIX}nobody`, size))[2]).toBeNull()
    const junk = path.join(dir, 'junk.glb')
    await fs.writeFile(junk, new Uint8Array(500).fill(7))
    const run2 = await helper(new Map([[URL, junk]]))
    expect((await run2(8, URL, 500))[2]).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* Main's check, and the numbers written three times                  */
/* ------------------------------------------------------------------ */

describe('main’s check of what the helper sends back', () => {
  let good: Uint8Array
  beforeAll(async () => {
    good = (await bake(sphereGlb({ lat: 6, lon: 8 })))!
  })

  const patched = (edit: (b: Uint8Array, v: DataView) => void): Uint8Array => {
    const copy = good.slice()
    edit(copy, new DataView(copy.buffer))
    return copy
  }

  it('takes a proxy and nothing else: the same header and length rules as core, for every way the header can be wrong', () => {
    expect(proxyOf(good)).toBe(good)
    const edits: [string, (b: Uint8Array, v: DataView) => void][] = [
      ['magic', (b) => void (b[0] = 0x50)],
      ['version', (b) => void (b[4] = 2)],
      ['reserved byte', (b) => void (b[5] = 1)],
      ['no vertices', (_b, v) => v.setUint16(6, 0, true)],
      ['too many vertices for the bytes', (_b, v) => v.setUint16(6, 500, true)],
      ['no triangles', (_b, v) => v.setUint32(8, 0, true)],
      ['too many triangles', (_b, v) => v.setUint32(8, PROXY_LIMITS.triangles + 1, true)],
      ['reserved word', (_b, v) => v.setUint32(28, 9, true)],
      ['half zero', (_b, v) => v.setFloat32(24, 0, true)],
      ['half NaN', (_b, v) => v.setFloat32(24, NaN, true)],
      ['half huge', (_b, v) => v.setFloat32(24, 1e13, true)],
      ['centre NaN', (_b, v) => v.setFloat32(16, NaN, true)],
    ]
    for (const [name, edit] of edits) {
      const bad = patched(edit)
      expect(proxyOf(bad), name).toBeNull()
      expect(decodeProxy(bad), name).toBeNull()
    }
    for (const bad of [good.subarray(0, good.length - 1), new Uint8Array([...good, 0]), good.subarray(0, 10), new Uint8Array(0), new Uint8Array(PROXY_MAX_BYTES + 1)]) {
      expect(proxyOf(bad)).toBeNull()
      expect(decodeProxy(bad)).toBeNull()
    }
    for (const bad of [null, undefined, 'ABPX', [1, 2, 3], {}, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(40)])]) expect(proxyOf(bad)).toBeNull()
  })

  it('agrees with core on every number: the magic, the header, the limits, the size of every proxy and the biggest one', () => {
    expect(MAIN_MAGIC).toEqual([...PROXY_MAGIC])
    expect(MAIN_HEADER).toBe(PROXY_HEADER_BYTES)
    expect(PROXY_MAX_VERTICES).toBe(PROXY_LIMITS.vertices)
    expect(PROXY_MAX_TRIANGLES).toBe(PROXY_LIMITS.triangles)
    expect(MAX_PROXY_BYTES).toBe(PROXY_MAX_BYTES)
    for (const [v, t] of [[1, 1], [2, 1], [3, 1], [7, 12], [8, 12], [4096, 8000], [65_535, 40_000], [65_534, 39_999]] as const) expect(proxySize(v, t), `${v}/${t}`).toBe(coreProxyBytes(v, t))
  })

  it('has the helper write the same numbers: the layout in its source is core’s, and what it writes is what core reads', () => {
    const src = lf(readFileSync(path.join(here, '..', 'src', 'preload', 'thumb-preload.cts'), 'utf8'))
    const us = (n: number) => n.toLocaleString('en-US').replace(/,/g, '_')
    expect(src).toContain(`magic: [${PROXY_MAGIC.map((b) => '0x' + b.toString(16)).join(', ')}],`)
    expect(src).toContain(`header: ${PROXY_HEADER_BYTES},`)
    expect(src).toContain(`maxVertices: ${us(PROXY_LIMITS.vertices)},`)
    expect(src).toContain(`maxTriangles: ${us(PROXY_LIMITS.triangles)},`)
    expect(src).toContain(`target: ${us(PROXY_TARGET_TRIANGLES)},`)
    expect(src).toContain('version: 1,')
  })

  it('keeps the helper’s look and core’s together: the same brightness for every angle the light can make', () => {
    for (let d = 0; d <= 1; d += 0.125) for (let f = 0; f <= 1; f += 0.125) expect(coreBrightness(d, f), `${d}, ${f}`).toBeCloseTo(pre.modelBrightness(d, f), 12)
  })
})
