import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { encodeProxy } from '@aether/core'
import { MAX_MODEL_BYTES, MAX_MODEL_FILE_BYTES, serveVideo } from '../src/main/assets.js'
import {
  MODEL_FILE_TIMEOUT,
  THUMB_IPC,
  ThumbQueue,
  Thumbnailer,
  VIDEO_SCHEME,
  VIDEO_URL_PREFIX,
  proxyOf,
  type ThumbElectron,
  type ThumbHelper,
  type ThumbJob,
} from '../src/main/thumbnailer.js'
import { lf } from './lf.js'
import { Packer, fakePage, glb, loadPreload, type Doc, type Pre, type RangeSource, type Tex } from './helpers/glb-preload.js'

/**
 * 3D icons that look like the model: a model's picture is drawn with its base colour texture (UVs, wrap modes, alpha masks), and a
 * model too big to send (a Meshy export is 80 to 325 MB, mostly texture maps nothing draws) is read in pieces by the helper, only
 * what the drawing needs, from a one-job address main serves by byte range. The pure parts run here on hand-built files; the real
 * `serveVideo` answers the helper's reads.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/* ------------------------------------------------------------------ */
/* Building binary glTF files                                         */
/* ------------------------------------------------------------------ */

/** The fake "picture" the stand-in decoder understands: the left half of the texture is `left`, the right half `right` (RGBA each). */
const picture = (left: number[], right: number[]): Uint8Array => Uint8Array.of(...left, ...right)
const RED = [255, 0, 0, 255]
const BLUE = [0, 0, 255, 255]
const GONE = [0, 0, 0, 0]

interface QuadOptions {
  /** Texture coordinates of the four corners (bottom left, bottom right, top right, top left); default 0..1. */
  uvs?: number[]
  /** The base colour picture (default red | blue), or null for a material with no texture. */
  image?: Uint8Array | null
  mime?: string
  alphaMode?: string
  alphaCutoff?: number
  sampler?: Doc
  normals?: boolean
  noUvs?: boolean
  /** Bytes of data nothing draws, before and after what is drawn. */
  junk?: number
}

const QUAD_UVS = [0, 1, 1, 1, 1, 0, 0, 0]

/** A square facing the viewer, textured. `used` is the bytes of the BIN chunk the drawing needs. */
function quadModel(o: QuadOptions = {}): { file: Uint8Array; used: number } {
  const p = new Packer()
  const junk = o.junk ?? 0
  const doc: Doc = { asset: { version: '2.0' } }
  let normalMap = -1
  if (junk) normalMap = p.junk(junk)
  const attributes: Doc = { POSITION: p.floats([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 'VEC3') }
  let used = 48
  if (o.normals !== false) {
    attributes['NORMAL'] = p.floats([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3')
    used += 48
  }
  if (!o.noUvs) {
    attributes['TEXCOORD_0'] = p.floats(o.uvs ?? QUAD_UVS, 'VEC2')
    used += 32
  }
  const indices = p.indices16([0, 1, 2, 0, 2, 3])
  used += 12
  const material: Doc = { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }
  if (o.alphaMode) material['alphaMode'] = o.alphaMode
  if (o.alphaCutoff !== undefined) material['alphaCutoff'] = o.alphaCutoff
  const image = o.image === undefined ? picture(RED, BLUE) : o.image
  if (image) {
    const at = p.view(image)
    doc['images'] = [{ bufferView: at, mimeType: o.mime ?? 'image/png' }]
    doc['textures'] = [{ source: 0, ...(o.sampler ? { sampler: 0 } : {}) }]
    if (o.sampler) doc['samplers'] = [o.sampler]
    material['pbrMetallicRoughness'].baseColorTexture = { index: 0 }
    used += (image.length + 3) & ~3
  }
  if (junk) {
    // A second picture nothing draws: a normal map, with its own texture, and more junk after it.
    doc['images'] = [...(doc['images'] ?? []), { bufferView: normalMap, mimeType: 'image/png' }]
    doc['textures'] = [...(doc['textures'] ?? []), { source: (doc['images'] as Doc[]).length - 1 }]
    material['normalTexture'] = { index: (doc['textures'] as Doc[]).length - 1 }
    p.junk(junk)
  }
  doc['meshes'] = [{ primitives: [{ attributes, indices, material: 0 }] }]
  doc['materials'] = [material]
  doc['nodes'] = [{ mesh: 0 }]
  doc['scenes'] = [{ nodes: [0] }]
  doc['scene'] = 0
  doc['bufferViews'] = p.views
  doc['accessors'] = p.accessors
  const bin = p.bin()
  doc['buffers'] = [{ byteLength: bin.length }]
  return { file: glb(doc, bin), used }
}

/**
 * A model the way exporters write one: an interleaved vertex view (position, normal, UV at a stride of 32), 32-bit indices, a second
 * mesh with plain views and 16-bit indices, two nodes that place them, and a lot of data nothing draws before, between and after.
 */
function exporterModel(): Uint8Array {
  const p = new Packer()
  p.junk(3 << 20)
  const vertex = new Float32Array([
    // position       normal      uv
    -1, -1, 0, 0, 0, 1, 0, 1,
    1, -1, 0, 0, 0, 1, 1, 1,
    1, 1, 0, 0, 0, 1, 1, 0,
    -1, 1, 0, 0, 0, 1, 0, 0,
  ])
  const interleaved = p.view(new Uint8Array(vertex.buffer), { byteStride: 32 })
  const position = p.accessor(interleaved, { byteOffset: 0, componentType: 5126, count: 4, type: 'VEC3' })
  const normal = p.accessor(interleaved, { byteOffset: 12, componentType: 5126, count: 4, type: 'VEC3' })
  const uv = p.accessor(interleaved, { byteOffset: 24, componentType: 5126, count: 4, type: 'VEC2' })
  const index32 = p.accessor(p.view(new Uint8Array(new Uint32Array([0, 1, 2, 0, 2, 3]).buffer)), { componentType: 5125, count: 6, type: 'SCALAR' })
  p.junk(2 << 20)
  const triangle = p.floats([0, 0, 0, 1, 0, 0, 0, 1, 0], 'VEC3')
  const triangleIndex = p.indices16([0, 1, 2])
  const image = p.view(picture(RED, BLUE))
  p.junk(1 << 20)
  const doc: Doc = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0, 1] }],
    scene: 0,
    nodes: [{ mesh: 0 }, { mesh: 1, translation: [2.5, 0, 0], scale: [0.7, 0.7, 0.7] }],
    meshes: [
      { primitives: [{ attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv }, indices: index32, material: 0 }] },
      { primitives: [{ attributes: { POSITION: triangle }, indices: triangleIndex, material: 1 }] },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: 0 } } }, { pbrMetallicRoughness: { baseColorFactor: [0.2, 0.8, 0.3, 1] } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: image, mimeType: 'image/png' }],
    bufferViews: p.views,
    accessors: p.accessors,
  }
  const bin = p.bin()
  doc['buffers'] = [{ byteLength: bin.length }]
  return glb(doc, bin)
}

/* ------------------------------------------------------------------ */
/* The preload, loaded the way the sandbox loads it                   */
/* ------------------------------------------------------------------ */

let pre: Pre
let page: ReturnType<typeof fakePage>
beforeAll(async () => {
  page = fakePage()
  pre = (await loadPreload(page.globals)).pre
})
beforeEach(() => {
  page.stats.decodes = 0
})

/** Parse, load the textures and draw. */
async function drawWhole(file: Uint8Array, side = 64): Promise<Uint8ClampedArray | null> {
  const g = pre.parseGlb(file)
  if (!g) return null
  const t = await pre.loadTextures(g)
  return pre.rasterGlb(g, side, t.tints, { textures: t.textures })
}

/** Which pixels are the model (they differ from their row's background, read at x = 0), and the mean colour of each half of it. */
function halves(img: Uint8ClampedArray, side: number) {
  const px = (x: number, y: number) => [img[(y * side + x) * 4]!, img[(y * side + x) * 4 + 1]!, img[(y * side + x) * 4 + 2]!] as const
  const covered: { x: number; r: number; g: number; b: number }[] = []
  for (let y = 0; y < side; y++) {
    const bg = px(0, y)
    for (let x = 0; x < side; x++) {
      const p = px(x, y)
      if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 6) covered.push({ x, r: p[0], g: p[1], b: p[2] })
    }
  }
  const mid = covered.length ? (Math.min(...covered.map((c) => c.x)) + Math.max(...covered.map((c) => c.x))) / 2 : 0
  const mean = (list: typeof covered) => ({
    r: list.reduce((s, c) => s + c.r, 0) / Math.max(1, list.length),
    g: list.reduce((s, c) => s + c.g, 0) / Math.max(1, list.length),
    b: list.reduce((s, c) => s + c.b, 0) / Math.max(1, list.length),
  })
  return { count: covered.length, left: mean(covered.filter((c) => c.x < mid)), right: mean(covered.filter((c) => c.x >= mid)) }
}

const same = (a: Uint8ClampedArray, b: Uint8ClampedArray): boolean => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

/** Fraction of pixels whose channels differ by more than `tolerance`. */
function differing(a: Uint8ClampedArray, b: Uint8ClampedArray, tolerance = 8): number {
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i]! - b[i]!) > tolerance || Math.abs(a[i + 1]! - b[i + 1]!) > tolerance || Math.abs(a[i + 2]! - b[i + 2]!) > tolerance) n++
  }
  return n / (a.length / 4)
}

/* ------------------------------------------------------------------ */
/* Sampling a texture                                                 */
/* ------------------------------------------------------------------ */

describe('sampleTex', () => {
  /** A 2 × 2 texture: red, green / blue, white. */
  const tex = (wrapS = 10497, wrapT = 10497): Tex => ({
    width: 2,
    height: 2,
    data: Uint8ClampedArray.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255),
    wrapS,
    wrapT,
    cutoff: 0,
  })
  const at = (t: Tex, u: number, v: number): number[] => {
    const out = new Float64Array(4)
    pre.sampleTex(t, u, v, out)
    return [...out].map((x) => Math.round(x))
  }

  it('gives the colour of a texel at its centre, and blends the two on either side of the line between them', () => {
    expect(at(tex(), 0.25, 0.25)).toEqual([255, 0, 0, 255])
    expect(at(tex(), 0.75, 0.25)).toEqual([0, 255, 0, 255])
    expect(at(tex(), 0.25, 0.75)).toEqual([0, 0, 255, 255])
    // Halfway between the red and the green texel: half of each.
    expect(at(tex(), 0.5, 0.25)).toEqual([128, 128, 0, 255])
    // Between all four.
    expect(at(tex(), 0.5, 0.5)).toEqual([128, 128, 128, 255])
  })

  it('repeats, clamps and mirrors, as the sampler says', () => {
    const base = at(tex(10497, 10497), 0.25, 0.25)
    expect(at(tex(10497, 10497), 1.25, -0.75)).toEqual(base)
    // Clamp to the edge: past the right edge is the right column, left of 0 the left one.
    expect(at(tex(33071, 33071), 2.75, 0.25)).toEqual(at(tex(), 0.75, 0.25))
    expect(at(tex(33071, 33071), -3, 0.25)).toEqual(at(tex(), 0.25, 0.25))
    // Mirrored: 1.25 is the picture turned round, so it is where 0.75 is.
    expect(at(tex(33648, 33648), 1.25, 0.25)).toEqual(at(tex(), 0.75, 0.25))
    expect(at(tex(33648, 33648), -0.25, 0.25)).toEqual(at(tex(), 0.25, 0.25))
  })

  it('takes a coordinate that is not a number for 0, and never throws or answers NaN', () => {
    const t = tex()
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      const out = at(t, bad, bad)
      expect(out.every(Number.isFinite)).toBe(true)
    }
    expect(at(t, Number.NaN, 0.25)).toEqual(at(t, 0, 0.25))
  })
})

/* ------------------------------------------------------------------ */
/* Decoding the textures of a model                                   */
/* ------------------------------------------------------------------ */

describe('loadTextures', () => {
  it('decodes a material’s base colour picture to a square of 512, and averages it for the tint of a surface without UVs', async () => {
    const g = pre.parseGlb(quadModel().file)!
    const { textures, tints } = await pre.loadTextures(g)
    const t = textures.get(0)!
    expect([t.width, t.height, t.data.length]).toEqual([512, 512, 512 * 512 * 4])
    // Red on the left half, blue on the right.
    expect([...t.data.subarray(0, 4)]).toEqual(RED)
    expect([...t.data.subarray(511 * 4, 512 * 4)]).toEqual(BLUE)
    expect([t.wrapS, t.wrapT, t.cutoff]).toEqual([10497, 10497, 0])
    const [r, gr, b] = tints.get(0)!
    expect([r, gr, b].map((x) => Math.round(x * 100))).toEqual([50, 0, 50])
  })

  it('decodes a picture that two materials share once', async () => {
    const g = pre.parseGlb(quadModel().file)!
    ;(g.doc['materials'] as Doc[]).push(structuredClone((g.doc['materials'] as Doc[])[0]))
    const { textures } = await pre.loadTextures(g)
    expect([...textures.keys()]).toEqual([0, 1])
    expect(page.stats.decodes).toBe(1)
  })

  it('takes the sampler’s wrap modes, and turns alpha masks into a cut-off: a mask by its cutoff (half by default), a blend at half', async () => {
    const wraps = pre.parseGlb(quadModel({ sampler: { wrapS: 33071, wrapT: 33648 } }).file)!
    const w = (await pre.loadTextures(wraps)).textures.get(0)!
    expect([w.wrapS, w.wrapT]).toEqual([33071, 33648])
    const cutoffOf = async (o: QuadOptions) => (await pre.loadTextures(pre.parseGlb(quadModel(o).file)!)).textures.get(0)!.cutoff
    expect(await cutoffOf({})).toBe(0)
    expect(await cutoffOf({ alphaMode: 'OPAQUE' })).toBe(0)
    expect(await cutoffOf({ alphaMode: 'MASK', alphaCutoff: 0.3 })).toBe(77)
    expect(await cutoffOf({ alphaMode: 'MASK' })).toBe(128)
    expect(await cutoffOf({ alphaMode: 'MASK', alphaCutoff: 7 })).toBe(255)
    expect(await cutoffOf({ alphaMode: 'BLEND' })).toBe(128)
  })

  it('leaves out what it cannot use: a picture that does not decode, another kind of picture, one that lives outside the file, a material with none', async () => {
    const none = async (g: Glb) => (await pre.loadTextures(g)).textures.size
    expect(await none(pre.parseGlb(quadModel({ image: Uint8Array.of(1, 2, 3) }).file)!)).toBe(0)
    expect(await none(pre.parseGlb(quadModel({ mime: 'image/webp' }).file)!)).toBe(0)
    expect(await none(pre.parseGlb(quadModel({ image: null }).file)!)).toBe(0)
    const outside = pre.parseGlb(quadModel().file)!
    ;(outside.doc['images'] as Doc[])[0] = { uri: 'texture.png', mimeType: 'image/png' }
    expect(await none(outside)).toBe(0)
    const otherBuffer = pre.parseGlb(quadModel().file)!
    ;(otherBuffer.doc['bufferViews'] as Doc[]).forEach((v) => (v['buffer'] = 1))
    expect(await none(otherBuffer)).toBe(0)
    // A model with no BIN chunk has nothing to decode.
    expect(await none({ doc: pre.parseGlb(quadModel().file)!.doc, bin: null })).toBe(0)
  })

  it('does not decode a picture bigger than it allows, nor more than its total budget', async () => {
    const g = pre.parseGlb(quadModel().file)!
    // The view claims 25 MB (one picture may be 24): it is not read, whatever the file holds.
    const view = (g.doc['bufferViews'] as Doc[]).at(-1)!
    view['byteLength'] = 25 << 20
    g.bin = new Uint8Array(26 << 20)
    expect(await pre.loadTextures(g).then((r) => r.textures.size)).toBe(0)
    expect(page.stats.decodes).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* Drawing with textures                                              */
/* ------------------------------------------------------------------ */

describe('rasterGlb with textures', () => {
  const SIDE = 64

  it('draws a model in the colours of its texture: red where the picture is red, blue where it is blue, left to right as the UVs say', async () => {
    const img = (await drawWhole(quadModel().file, SIDE))!
    const h = halves(img, SIDE)
    expect(h.count).toBeGreaterThan(SIDE * SIDE * 0.2)
    expect(h.left.r).toBeGreaterThan(h.left.b + 40)
    expect(h.right.b).toBeGreaterThan(h.right.r + 40)
  })

  it('follows the UVs: turned round they turn the picture round', async () => {
    const mirrored = quadModel({ uvs: [1, 1, 0, 1, 0, 0, 1, 0] })
    const h = halves((await drawWhole(mirrored.file, SIDE))!, SIDE)
    expect(h.left.b).toBeGreaterThan(h.left.r + 40)
    expect(h.right.r).toBeGreaterThan(h.right.b + 40)
  })

  it('repeats a picture whose UVs run past 1, and clamps it when the sampler says so', async () => {
    const plain = (await drawWhole(quadModel().file, SIDE))!
    // The same square with its UVs a whole picture further along: the same colours.
    const shifted = (await drawWhole(quadModel({ uvs: [1, 3, 2, 3, 2, 2, 1, 2] }).file, SIDE))!
    expect(differing(plain, shifted)).toBeLessThan(0.01)
    // Clamped, everything past the right edge is the right-hand colour: the whole square is blue.
    const clamped = halves((await drawWhole(quadModel({ uvs: [1, 3, 2, 3, 2, 2, 1, 2], sampler: { wrapS: 33071, wrapT: 33071 } }).file, SIDE))!, SIDE)
    expect(clamped.left.b).toBeGreaterThan(clamped.left.r + 40)
    expect(clamped.right.b).toBeGreaterThan(clamped.right.r + 40)
  })

  it('lets what is behind show where a masked or blended material is see-through', async () => {
    const opaque = halves((await drawWhole(quadModel().file, SIDE))!, SIDE)
    const masked = halves((await drawWhole(quadModel({ image: picture(RED, GONE), alphaMode: 'MASK' }).file, SIDE))!, SIDE)
    const blended = halves((await drawWhole(quadModel({ image: picture(RED, GONE), alphaMode: 'BLEND' }).file, SIDE))!, SIDE)
    // Half of the square is gone, the rest is red.
    for (const m of [masked, blended]) {
      expect(m.count).toBeGreaterThan(opaque.count * 0.35)
      expect(m.count).toBeLessThan(opaque.count * 0.65)
      expect(m.left.r).toBeGreaterThan(m.left.b + 40)
    }
    // An opaque material ignores the picture's alpha.
    const ignored = halves((await drawWhole(quadModel({ image: picture(RED, GONE) }).file, SIDE))!, SIDE)
    expect(ignored.count).toBeGreaterThan(opaque.count * 0.95)
  })

  it('falls back to the average colour for a surface with no UVs, and for a material with no texture, as it always did', async () => {
    const g = pre.parseGlb(quadModel({ noUvs: true }).file)!
    const t = await pre.loadTextures(g)
    const noUv = halves(pre.rasterGlb(g, SIDE, t.tints, { textures: t.textures })!, SIDE)
    // Purple on both halves (the average of red and blue), not red and blue.
    expect(Math.abs(noUv.left.r - noUv.right.r)).toBeLessThan(12)
    expect(Math.abs(noUv.left.b - noUv.right.b)).toBeLessThan(12)
    expect(noUv.left.r).toBeGreaterThan(noUv.left.g * 2)
    expect(noUv.left.b).toBeGreaterThan(noUv.left.g * 2)
    // Not given its textures, a model is drawn as before: one tint over the whole surface.
    const full = pre.parseGlb(quadModel().file)!
    const before = halves(pre.rasterGlb(full, SIDE, t.tints)!, SIDE)
    expect(Math.abs(before.left.r - before.right.r)).toBeLessThan(12)
  })

  it('draws the same bytes the same way every time', async () => {
    const a = (await drawWhole(quadModel().file, SIDE))!
    const b = (await drawWhole(quadModel().file, SIDE))!
    expect(same(a, b)).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* Reading a model in pieces                                          */
/* ------------------------------------------------------------------ */

/** A file in memory as a range source; every read is logged. */
function memorySource(bytes: Uint8Array, log: { start: number; length: number }[] = [], size = bytes.length): RangeSource {
  return {
    size,
    read: async (start, length) => {
      log.push({ start, length })
      return start + length > bytes.length ? null : bytes.slice(start, start + length)
    },
  }
}

describe('readGlbRanged', () => {
  const SIDE = 48

  it('gives the picture the whole file gives, reading a sliver of it (everything nothing draws is left on the disk)', async () => {
    const file = exporterModel()
    expect(file.length).toBeGreaterThan(6 << 20)
    const whole = (await drawWhole(file, SIDE))!
    expect(whole).not.toBeNull()
    const log: { start: number; length: number }[] = []
    const g = (await pre.readGlbRanged(memorySource(file, log)))!
    expect(g).not.toBeNull()
    const t = await pre.loadTextures(g)
    const ranged = pre.rasterGlb(g, SIDE, t.tints, { textures: t.textures })!
    expect(same(whole, ranged)).toBe(true)
    const read = log.reduce((sum, r) => sum + r.length, 0)
    expect(read).toBeLessThan(file.length / 200)
    // The textured square is red | blue, the plain triangle beside it is green.
    const h = halves(ranged, SIDE)
    expect(h.count).toBeGreaterThan(100)
  })

  it('reads neighbouring pieces together: a handful of reads for a model of many accessors', async () => {
    const log: { start: number; length: number }[] = []
    await pre.readGlbRanged(memorySource(exporterModel(), log))
    // The header, the JSON, the BIN chunk's header, then the pieces: they lie in three groups between the junk.
    expect(log.length).toBeLessThanOrEqual(3 + 3)
    expect(log.length).toBeGreaterThanOrEqual(3 + 1)
  })

  it('copies exactly what is drawn into a smaller buffer, and points the document at the copies', async () => {
    const { file, used } = quadModel({ junk: 2 << 20 })
    const g = (await pre.readGlbRanged(memorySource(file)))!
    expect(g.bin!.length).toBe(used)
    expect(g.doc['buffers']).toEqual([{ byteLength: used }])
    // The picture of the normal map is still named in the document but nothing is read from it, and the base colour one is a copy.
    const t = await pre.loadTextures(g)
    expect(t.textures.size).toBe(1)
    expect([...t.textures.get(0)!.data.subarray(0, 4)]).toEqual(RED)
  })

  it('keeps an interleaved view’s stride, so each attribute is read from where it lies in it', async () => {
    const g = (await pre.readGlbRanged(memorySource(exporterModel())))!
    const views = g.doc['bufferViews'] as Doc[]
    const position = (g.doc['accessors'] as Doc[])[0]!
    expect(position['byteOffset']).toBe(0)
    expect(views[position['bufferView']]['byteStride']).toBe(32)
    // The plain views have no stride at all.
    expect(views[(g.doc['accessors'] as Doc[])[3]!['bufferView']]['byteStride']).toBeUndefined()
  })

  it('takes a primitive whole or not at all when its bytes do not fit the budget, as the drawing would leave it out', async () => {
    const file = exporterModel()
    // The square's accessors reach 108 + 108 + 104 bytes into the interleaved view and 24 into the indices: 344. The triangle's are
    // 36 + 6. A budget of 344 takes the square and leaves the triangle out.
    const first = (await pre.readGlbRanged(memorySource(file), { maxBytes: 344 }))!
    const meshes = (first.doc['meshes'] as Doc[]).length
    expect(meshes).toBe(2)
    const drawn = pre.rasterGlb(first, SIDE, new Map())!
    const all = pre.rasterGlb((await pre.readGlbRanged(memorySource(file)))!, SIDE, new Map())!
    expect(same(drawn, all)).toBe(false)
    // Less than the square needs: nothing to draw, not a part of it.
    expect(await pre.readGlbRanged(memorySource(file), { maxBytes: 343 })).toBeNull()
  })

  it('refuses what is no binary glTF, or is cut off, or claims more than it is', async () => {
    const good = quadModel().file
    const edit = (f: (v: DataView) => void): Uint8Array => {
      const c = good.slice()
      f(new DataView(c.buffer))
      return c
    }
    const read = (file: Uint8Array, size = file.length) => pre.readGlbRanged(memorySource(file, [], size))
    expect(await read(new Uint8Array(10))).toBeNull()
    expect(await read(edit((v) => v.setUint32(0, 0, true)))).toBeNull()
    expect(await read(edit((v) => v.setUint32(4, 1, true)))).toBeNull()
    // A total that is more than the file, a first chunk that is not JSON, an empty one.
    expect(await read(edit((v) => v.setUint32(8, good.length + 4, true)))).toBeNull()
    expect(await read(edit((v) => v.setUint32(16, 0x004e4942, true)))).toBeNull()
    expect(await read(edit((v) => v.setUint32(12, 0, true)))).toBeNull()
    // A JSON chunk that runs past the file.
    expect(await read(edit((v) => v.setUint32(12, good.length, true)))).toBeNull()
    // JSON that is not an object.
    expect(await read(glb([1, 2], new Uint8Array(8)))).toBeNull()
    expect(await read(glb(7, new Uint8Array(8)))).toBeNull()
    const text = good.slice()
    text.fill(0x78, 20, 40)
    expect(await read(text)).toBeNull()
    // No BIN chunk, and one of another type.
    expect(await read(glb(pre.parseGlb(good)!.doc))).toBeNull()
    const jsonLength = new DataView(good.buffer).getUint32(12, true)
    expect(await read(edit((v) => v.setUint32(20 + jsonLength + 4, 0x4e4f534a, true)))).toBeNull()
    // A BIN chunk that claims to run past the file.
    expect(await read(edit((v) => v.setUint32(20 + jsonLength, good.length * 2, true)))).toBeNull()
  })

  it('does not read a JSON chunk bigger than it allows: it has read the 20 header bytes and nothing else', async () => {
    const good = quadModel().file
    const big = good.slice()
    new DataView(big.buffer).setUint32(12, 17 << 20, true)
    const log: { start: number; length: number }[] = []
    expect(await pre.readGlbRanged(memorySource(big, log, 20 << 20))).toBeNull()
    expect(log).toEqual([{ start: 0, length: 20 }])
  })

  it('gives up, and does not throw, when a read fails or comes back short, at any step', async () => {
    const file = exporterModel()
    const steps = (await (async () => {
      const log: unknown[] = []
      await pre.readGlbRanged(memorySource(file, log as { start: number; length: number }[]))
      return log.length
    })())
    for (let failAt = 0; failAt < steps; failAt++) {
      for (const how of ['null', 'short'] as const) {
        let n = 0
        const src: RangeSource = {
          size: file.length,
          read: async (start, length) => {
            if (n++ !== failAt) return file.slice(start, start + length)
            return how === 'null' ? null : file.slice(start, start + Math.max(0, length - 1))
          },
        }
        expect(await pre.readGlbRanged(src), `${how} at read ${failAt}`).toBeNull()
      }
    }
  })

  it('draws nothing from geometry it cannot read: compressed, sparse, outside its view, or in a file of its own', async () => {
    const broken = (f: (doc: Doc) => void): Promise<Glb | null> => {
      const g = pre.parseGlb(quadModel().file)!
      f(g.doc)
      return pre.readGlbRanged(memorySource(glb(g.doc, g.bin!)))
    }
    expect(await broken((d) => delete d['accessors'][0].bufferView)).toBeNull()
    expect(await broken((d) => (d['accessors'][0].sparse = { count: 1 }))).toBeNull()
    expect(await broken((d) => (d['accessors'][0].byteOffset = 1 << 20))).toBeNull()
    expect(await broken((d) => (d['bufferViews'][0].extensions = { EXT_meshopt_compression: {} }))).toBeNull()
    expect(await broken((d) => (d['buffers'][0].uri = 'data.bin'))).toBeNull()
    expect(await broken((d) => (d['bufferViews'][0].buffer = 1))).toBeNull()
    expect(await broken((d) => (d['accessors'][0].componentType = 5125))).toBeNull()
  })

  it('draws nothing from a file with no mesh, and does not loop on nodes that hold themselves', async () => {
    const empty = glb({ asset: { version: '2.0' } }, new Uint8Array(8))
    expect(await pre.readGlbRanged(memorySource(empty))).toBeNull()
    const loop = pre.parseGlb(quadModel().file)!
    loop.doc['nodes'] = [{ mesh: 0, children: [0] }]
    const g = await pre.readGlbRanged(memorySource(glb(loop.doc, loop.bin!)))
    expect(g).not.toBeNull()
  })

  it('leaves the document it was given alone in the pieces it does not touch', async () => {
    const g = (await pre.readGlbRanged(memorySource(quadModel().file)))!
    expect(g.doc['meshes']).toEqual(pre.parseGlb(quadModel().file)!.doc['meshes'])
    expect(g.doc['nodes']).toEqual([{ mesh: 0 }])
  })
})

/* ------------------------------------------------------------------ */
/* The job, over the preload's channel, from a file on disk           */
/* ------------------------------------------------------------------ */

describe('thumb-preload: a model read in pieces', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-icons-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  /** A model file bigger than a model may be sent whole: the same square, with `extra` unused bytes added to its BIN chunk. */
  async function bigModel(name: string, extra: number): Promise<{ abs: string; size: number }> {
    const { file } = quadModel()
    const jsonLength = new DataView(file.buffer).getUint32(12, true)
    const binAt = 20 + jsonLength
    const patched = file.slice()
    const v = new DataView(patched.buffer)
    v.setUint32(8, file.length + extra, true)
    v.setUint32(binAt, v.getUint32(binAt, true) + extra, true)
    const abs = path.join(dir, name)
    const fh = await fs.open(abs, 'w')
    try {
      await fh.write(patched)
      await fh.truncate(file.length + extra)
    } finally {
      await fh.close()
    }
    return { abs, size: file.length + extra }
  }

  /** The preload, with a `fetch` that is main's: the real `serveVideo` over the files it was told about. */
  async function helper(served: Map<string, string>, how: 'range' | 'whole' | 'gone' | 'throws' = 'range') {
    const requests: string[] = []
    let bytes = 0
    const fetchStub = async (url: string, init?: { headers?: Record<string, string> }) => {
      const abs = served.get(url)
      requests.push(init?.headers?.['Range'] ?? '')
      if (how === 'throws') throw new Error('network down')
      if (!abs || how === 'gone') return new Response(null, { status: 404 })
      const res = await serveVideo(abs, 'model/gltf-binary', how === 'whole' ? null : (init?.headers?.['Range'] ?? null))
      const m = /bytes=(\d+)-(\d+)/.exec(init?.headers?.['Range'] ?? '')
      if (m) bytes += Number(m[2]) - Number(m[1]) + 1
      return res
    }
    const f = fakePage({ fetch: fetchStub })
    const { sent, listeners } = await loadPreload(f.globals)
    const run = async (...args: unknown[]) => {
      const before = sent.length
      listeners.get(THUMB_IPC.modelFile)!({}, ...args)
      const deadline = Date.now() + 5000
      while (sent.length === before) {
        if (Date.now() > deadline) throw new Error('no answer')
        await new Promise((r) => setTimeout(r, 5))
      }
      return sent.at(-1)!
    }
    return { run, requests, bytes: () => bytes, puts: f.stats.puts }
  }

  const URL = `${VIDEO_URL_PREFIX}job-1`

  it('answers the PNG of a model bigger than a model may be sent, having read a few hundred bytes of its 70 MB', async () => {
    const m = await bigModel('big.glb', 70 << 20)
    expect(m.size).toBeGreaterThan(MAX_MODEL_BYTES)
    const h = await helper(new Map([[URL, m.abs]]))
    const out = await h.run(21, URL, m.size, 48)
    expect(out).toEqual([THUMB_IPC.done, 21, new Uint8Array([...PNG_SIG, 48, 48])])
    expect(h.puts).toHaveLength(1)
    expect(h.bytes()).toBeLessThan(64 << 10)
    expect(h.requests.length).toBeGreaterThan(3)
  })

  it('draws what the helper read the way it draws the whole file: the same square, in the same colours', async () => {
    const m = await bigModel('same.glb', 1 << 20)
    const h = await helper(new Map([[URL, m.abs]]))
    await h.run(1, URL, m.size, 64)
    const whole = (await drawWhole(quadModel().file, 64))!
    expect(same(h.puts[0]!.data, whole)).toBe(true)
  })

  it('answers null for an address that is not a job’s, a size that is not a count of bytes, a side it will not draw, and a file that is gone', async () => {
    const m = await bigModel('args.glb', 1 << 20)
    const served = new Map([[URL, m.abs]])
    const h = await helper(served)
    for (const [i, args] of ([
      ['http://example.com/model.glb', m.size, 48],
      [`${VIDEO_URL_PREFIX}other-job`, m.size, 48],
      [URL, 0, 48],
      [URL, -5, 48],
      [URL, 12.5, 48],
      [URL, '70', 48],
      [URL, m.size, 0],
      [URL, m.size, 5000],
      [URL, m.size, 48.5],
      [42, m.size, 48],
    ] as const).entries()) {
      expect((await h.run(100 + i, ...args))[2], String(i)).toBeNull()
    }
    expect(h.puts).toHaveLength(0)
    // An address that does not (or no longer) lead to a file: a 404 for every read.
    const gone = await helper(served, 'gone')
    expect((await gone.run(7, URL, m.size, 48))[2]).toBeNull()
  })

  it('answers null when the server sends the whole file instead of the range asked for, and when it cannot be reached', async () => {
    const m = await bigModel('whole.glb', 1 << 20)
    const served = new Map([[URL, m.abs]])
    const whole = await helper(served, 'whole')
    expect((await whole.run(1, URL, m.size, 48))[2]).toBeNull()
    const down = await helper(served, 'throws')
    expect((await down.run(2, URL, m.size, 48))[2]).toBeNull()
  })

  it('answers null for a file that is not a model, and for a size that is less than the file says it is', async () => {
    const junk = path.join(dir, 'junk.glb')
    await fs.writeFile(junk, new Uint8Array(4096).fill(7))
    const served = new Map([[URL, junk]])
    const h = await helper(served)
    expect((await h.run(1, URL, 4096, 48))[2]).toBeNull()
    // A size that is less than the file's own length (its header says it is longer).
    const m = await bigModel('short.glb', 1 << 20)
    const lie = await helper(new Map([[URL, m.abs]]))
    expect((await lie.run(2, URL, m.size / 2, 48))[2]).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* Main's side: the job, its time, the file server                    */
/* ------------------------------------------------------------------ */

function fakeElectron() {
  const windows: FakeWindow[] = []
  let nextId = 1
  class FakeContents extends EventEmitter {
    id = nextId++
    sent: unknown[][] = []
    send(...args: unknown[]) {
      this.sent.push(args)
    }
    setWindowOpenHandler() {}
    forcefullyCrashRenderer() {}
  }
  class FakeWindow {
    webContents = new FakeContents()
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      windows.push(this)
    }
    loadURL() {
      return Promise.resolve()
    }
    isDestroyed() {
      return false
    }
    destroy() {}
  }
  const protocols: Record<string, (req: Request) => Promise<Response>> = {}
  const session = {
    fromPartition() {
      return {
        webRequest: { onBeforeRequest() {} },
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        protocol: { handle: (scheme: string, fn: (req: Request) => Promise<Response>) => (protocols[scheme] = fn) },
      }
    },
  }
  return { electron: { BrowserWindow: FakeWindow, session } as unknown as ThumbElectron, windows, protocols }
}

describe('Thumbnailer: a model too big to send', () => {
  let dir: string
  let abs: string
  const data = new Uint8Array(100_000).map((_, i) => i % 251)
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-icons-main-'))
    abs = path.join(dir, 'model.glb')
    await fs.writeFile(abs, data)
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('sends the job on its own channel with the address, the size and the side, serves the file by range as a model, and only while the job runs', async () => {
    const e = fakeElectron()
    const t = new Thumbnailer({ electron: e.electron, preload: '/app/dist/preload/thumb-preload.cjs' })
    const out = t.renderModelFile(abs, data.length, 256)
    const w = e.windows[0]!
    t.ready(w.webContents)
    const [channel, id, url, size, px] = w.webContents.sent[0]! as [string, number, string, number, number]
    expect([channel, size, px]).toEqual([THUMB_IPC.modelFile, data.length, 256])
    expect(url.startsWith(VIDEO_URL_PREFIX)).toBe(true)
    const serve = e.protocols[VIDEO_SCHEME]!
    const part = await serve(new Request(url, { headers: { range: 'bytes=100-199' } }))
    expect([part.status, part.headers.get('content-type'), part.headers.get('content-range')]).toEqual([206, 'model/gltf-binary', `bytes 100-199/${data.length}`])
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(data.subarray(100, 200))
    // A page of another origin may read Content-Range from it.
    expect(part.headers.get('access-control-allow-origin')).toBe('*')
    expect(part.headers.get('access-control-expose-headers')).toContain('Content-Range')
    t.done(w.webContents, id, new Uint8Array([...PNG_SIG, 1]))
    expect(await out).toEqual(new Uint8Array([...PNG_SIG, 1]))
    expect((await serve(new Request(url))).status).toBe(404)
  })

  it('answers the page’s pre-check for a Range header while the job runs, and not for an address that is no job', async () => {
    const e = fakeElectron()
    const t = new Thumbnailer({ electron: e.electron, preload: '/p.cjs' })
    void t.renderModelFile(abs, data.length, 128).catch(() => null)
    const w = e.windows[0]!
    t.ready(w.webContents)
    const url = (w.webContents.sent[0] as [string, number, string])[2]
    const serve = e.protocols[VIDEO_SCHEME]!
    const check = await serve(new Request(url, { method: 'OPTIONS', headers: { 'access-control-request-headers': 'range' } }))
    expect(check.status).toBe(204)
    expect(check.headers.get('access-control-allow-headers')).toBe('range')
    expect(check.headers.get('access-control-allow-origin')).toBe('*')
    expect(check.body).toBeNull()
    expect((await serve(new Request(`${VIDEO_URL_PREFIX}nobody`, { method: 'OPTIONS' }))).status).toBe(404)
    t.stop()
  })
})

describe('ThumbQueue: a model read in pieces gets longer than a picture', () => {
  function queue(timeoutMs: number) {
    const sent: { id: number; job: ThumbJob }[] = []
    let helper: ThumbHelper | null = null
    const q = new ThumbQueue(
      () => (helper = { id: 5, send: (id, job) => void sent.push({ id, job }), destroy() {} }),
      { timeoutMs, concurrency: 1 },
    )
    return { q, sent, start: () => q.ready(helper!.id) }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  it('times a picture out at the usual limit', async () => {
    const t = queue(1000)
    const out = t.q.render({ bytes: new Uint8Array([1]), type: 'image/png', width: 10, height: 10 })
    t.start()
    await vi.advanceTimersByTimeAsync(1500)
    expect(await out).toBeNull()
  })

  it('keeps waiting for a model read in pieces well past it, and gives up at its own limit', async () => {
    const t = queue(1000)
    let settled = false
    const out = t.q.render({ modelUrl: `${VIDEO_URL_PREFIX}x`, size: 100 << 20, px: 256 }).then((r) => {
      settled = true
      return r
    })
    t.start()
    expect(t.sent[0]!.job).toEqual({ modelUrl: `${VIDEO_URL_PREFIX}x`, size: 100 << 20, px: 256 })
    await vi.advanceTimersByTimeAsync(MODEL_FILE_TIMEOUT - 1000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await out).toBeNull()
  })

  it('answers with the PNG when the helper does', async () => {
    const t = queue(1000)
    const out = t.q.render({ modelUrl: `${VIDEO_URL_PREFIX}y`, size: 100 << 20, px: 128 })
    t.start()
    await vi.advanceTimersByTimeAsync(5000)
    t.q.done(5, t.sent[0]!.id, new Uint8Array([...PNG_SIG, 9]))
    expect(await out).toEqual(new Uint8Array([...PNG_SIG, 9]))
  })
})

describe('main and models too big to send', () => {
  const main = lf(readFileSync(path.join(here, '..', 'src', 'main', 'main.ts'), 'utf8'))

  it('sends a model over the old limit to the helper by its address, after checking its first bytes, and reads nothing of it', () => {
    expect(main).toContain('async function renderModelThumb(abs: string, size: number, px: number)')
    expect(main).toContain('if (size > MAX_MODEL_BYTES) {')
    expect(main).toContain('modelKindOf(await readHead(abs, GLB_HEAD_BYTES), size)')
    expect(main).toContain('thumbnailer.renderModelFile(abs, size, px)')
    // A model's picture comes from the disk when it is kept there, else from the helper (model-baker.test.ts pins the cache's side).
    expect(main).toContain('renderModelIcon(abs, st.mtimeMs, st.size, px)')
    expect(main).toContain('const png = await renderModelThumb(abs, size, px)')
    expect(main).toContain('(model && st.size > MAX_MODEL_FILE_BYTES)')
  })

  it('still parses and draws nothing itself: only the helper knows what a model holds', () => {
    for (const file of ['main.ts', 'assets.ts', 'thumbnailer.ts']) {
      expect(lf(readFileSync(path.join(here, '..', 'src', 'main', file), 'utf8')), file).not.toMatch(/parseGlb|readGlbRanged|rasterGlb|loadTextures|bakeProxy|decodeProxy|renderProxy/)
    }
  })

  it('has a limit that is a file the disk can hold, not one the helper can: bigger than a model sent whole, 2 GB', () => {
    expect(MAX_MODEL_FILE_BYTES).toBe(2 * 1024 * 1024 * 1024)
    expect(MAX_MODEL_FILE_BYTES).toBeGreaterThan(MAX_MODEL_BYTES)
    expect(MODEL_FILE_TIMEOUT).toBeGreaterThanOrEqual(30_000)
  })
})


/* ------------------------------------------------------------------ */
/* The proxy job, main's side                                         */
/* ------------------------------------------------------------------ */

/** A tiny proxy: one triangle. */
const TINY_PROXY = encodeProxy({ centre: [0, 0, 0], half: 1, positions: [-32767, 0, 0, 32767, 0, 0, 0, 32767, 0], colors: [255, 0, 0, 0, 255, 0, 0, 0, 255], indices: [0, 1, 2] })

describe('Thumbnailer: the proxy of a model', () => {
  let dir: string
  let abs: string
  const data = new Uint8Array(100_000).map((_, i) => i % 251)
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-proxy-main-'))
    abs = path.join(dir, 'model.glb')
    await fs.writeFile(abs, data)
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('sends the job on its own channel with the address and the size (no side), serves the file by range, and only while the job runs', async () => {
    const e = fakeElectron()
    const t = new Thumbnailer({ electron: e.electron, preload: '/p.cjs' })
    const out = t.renderModelProxy(abs, data.length)
    const w = e.windows[0]!
    t.ready(w.webContents)
    const [channel, id, url, size, ...rest] = w.webContents.sent[0]! as [string, number, string, number, ...unknown[]]
    expect([channel, size, rest]).toEqual([THUMB_IPC.modelProxy, data.length, []])
    expect(url.startsWith(VIDEO_URL_PREFIX)).toBe(true)
    const serve = e.protocols[VIDEO_SCHEME]!
    const part = await serve(new Request(url, { headers: { range: 'bytes=10-19' } }))
    expect([part.status, part.headers.get('content-range')]).toEqual([206, `bytes 10-19/${data.length}`])
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(data.subarray(10, 20))
    t.done(w.webContents, id, TINY_PROXY)
    expect(await out).toEqual(TINY_PROXY)
    expect((await serve(new Request(url))).status).toBe(404)
  })

  it('takes the proxy’s bytes only: a PNG, a damaged proxy and anything else the helper answers is no proxy', async () => {
    for (const answer of [new Uint8Array([...PNG_SIG, 1, 2, 3]), TINY_PROXY.subarray(0, TINY_PROXY.length - 2), new Uint8Array(100), null, 'ABPX', 7]) {
      const e = fakeElectron()
      const t = new Thumbnailer({ electron: e.electron, preload: '/p.cjs' })
      const out = t.renderModelProxy(abs, data.length)
      const w = e.windows[0]!
      t.ready(w.webContents)
      t.done(w.webContents, (w.webContents.sent[0] as [string, number])[1], answer)
      expect(await out, String(answer)).toBeNull()
    }
  })

  it('takes a PNG only for a picture job, and a proxy only for a proxy job: a helper cannot answer one with the other', async () => {
    const sent: { id: number; job: ThumbJob }[] = []
    let helper: ThumbHelper | null = null
    const q = new ThumbQueue(() => (helper = { id: 3, send: (id, job) => void sent.push({ id, job }), destroy() {} }), { timeoutMs: 1000, concurrency: 2 })
    const picture = q.render({ modelUrl: `${VIDEO_URL_PREFIX}a`, size: 100 << 20, px: 64 })
    const proxy = q.render({ proxyUrl: `${VIDEO_URL_PREFIX}b`, size: 100 << 20 })
    q.ready(helper!.id)
    expect(sent.map((s) => s.job)).toEqual([
      { modelUrl: `${VIDEO_URL_PREFIX}a`, size: 100 << 20, px: 64 },
      { proxyUrl: `${VIDEO_URL_PREFIX}b`, size: 100 << 20 },
    ])
    q.done(3, sent[0]!.id, TINY_PROXY)
    q.done(3, sent[1]!.id, new Uint8Array([...PNG_SIG, 1]))
    expect(await picture).toBeNull()
    expect(await proxy).toBeNull()
  })

  it('gives a proxy the time a model read in pieces gets, not the time of a picture', async () => {
    vi.useFakeTimers()
    try {
      const sent: { id: number; job: ThumbJob }[] = []
      let helper: ThumbHelper | null = null
      const q = new ThumbQueue(() => (helper = { id: 4, send: (id, job) => void sent.push({ id, job }), destroy() {} }), { timeoutMs: 1000, concurrency: 1 })
      let settled = false
      const out = q.render({ proxyUrl: `${VIDEO_URL_PREFIX}c`, size: 100 << 20 }).then((r) => ((settled = true), r))
      q.ready(helper!.id)
      await vi.advanceTimersByTimeAsync(MODEL_FILE_TIMEOUT - 1000)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(2000)
      expect(await out).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('has main’s check agree that a proxy is a proxy', () => {
    expect(proxyOf(TINY_PROXY)).toBe(TINY_PROXY)
    expect(proxyOf(new Uint8Array([...PNG_SIG, 1]))).toBeNull()
  })
})

describe('main and the proxy of a model', () => {
  const main = lf(readFileSync(path.join(here, '..', 'src', 'main', 'main.ts'), 'utf8'))

  it('asks for a model by its own door, checks its first bytes, bakes through the helper and keeps the result under its own folder, never in the vault', () => {
    expect(main).toContain('async function modelProxy(rel: unknown): Promise<Uint8Array | null> {')
    expect(main).toContain('const abs = await v.modelAbs(rel)')
    expect(main).toContain('modelKindOf(await readHead(abs, GLB_HEAD_BYTES), st.size)')
    expect(main).toContain('thumbnailer.renderModelProxy(abs, st.size)')
    // The kept proxy is named by the bake that made it too.
    expect(main).toContain('const PROXY_BAKE = 1')
    expect(main).toContain('ModelIconCache.key(abs, st.mtimeMs, st.size, PROXY_BAKE)')
    expect(main).toContain("new ModelIconCache(path.join(app.getPath('userData'), 'model-proxies'), {")
    expect(main).toContain("ext: 'px',")
    expect(main).toContain('valid: (bytes) => proxyOf(bytes) !== null,')
    expect(main).toContain('ipc.handle(IPC.modelProxy, (_e, p: unknown) => within(modelProxy(p), MODEL_PROXY_TIMEOUT, null))')
    // Not through the picture door.
    const body = main.slice(main.indexOf('async function modelProxy('), main.indexOf('/** The baker\'s job for one model'))
    expect(body).not.toContain('assetAbs')
  })

  it('shares one bake between two askers, and does not remember a bake that got no answer at all', () => {
    expect(main).toContain('const proxiesInFlight = new Map<string, Promise<Uint8Array | null>>()')
    expect(main).toContain('.catch(() => null)')
    expect(main).toContain('.finally(() => proxiesInFlight.delete(key))')
  })

  it('waits for it longer than for a picture, as long as the helper does', () => {
    expect(main).toContain('const MODEL_PROXY_TIMEOUT = 65_000')
    expect(MODEL_FILE_TIMEOUT).toBeLessThan(65_000)
  })
})
