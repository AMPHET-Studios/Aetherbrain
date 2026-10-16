import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { FsVault, isAssetName, isImageName, isMediaName, isModelName, isVideoName } from '../src/main/fsvault.js'
import { GLB_HEAD_BYTES, MAX_MODEL_BYTES, MAX_THUMB_FILE_BYTES, modelKindOf } from '../src/main/assets.js'
import { THUMB_IPC, ThumbQueue, type ThumbHelper, type ThumbJob } from '../src/main/thumbnailer.js'
import { IPC } from '../src/shared/ipc.js'
import { rig } from './board-fix-desktop-fakes.js'

/**
 * 3D models in the desktop app: a `.glb` is listed and watched like a picture, has its own door into the vault (never
 * `assetAbs`, which pictures and boards use), is checked by its first bytes, and is drawn by the thumbnail helper's small
 * software rasterizer. The rasterizer is pure (the preload exports it for exactly this), so it is run here on hand-built
 * files; the real Chromium decode tests of thumbnailer.test.ts are untouched.
 */

const here = path.dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ */
/* Building binary glTF files                                         */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder()
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** A binary glTF: the JSON, then the BIN chunk when there is one, each padded to four bytes as the format asks. */
function glb(doc: unknown, bin?: Uint8Array, declared?: number): Uint8Array {
  const json = enc.encode(JSON.stringify(doc))
  const jsonLen = (json.length + 3) & ~3
  const binLen = bin ? (bin.length + 3) & ~3 : 0
  const total = 12 + 8 + jsonLen + (bin ? 8 + binLen : 0)
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x46546c67, true)
  v.setUint32(4, 2, true)
  v.setUint32(8, declared ?? total, true)
  v.setUint32(12, jsonLen, true)
  v.setUint32(16, 0x4e4f534a, true)
  out.fill(0x20, 20, 20 + jsonLen)
  out.set(json, 20)
  if (bin) {
    const at = 20 + jsonLen
    v.setUint32(at, binLen, true)
    v.setUint32(at + 4, 0x004e4942, true)
    out.set(bin, at + 8)
  }
  return out
}

interface Mesh {
  positions: number[]
  indices?: number[]
  normals?: number[]
  mode?: number
  color?: [number, number, number, number]
}

/** The glTF document and BIN buffer of one mesh with one primitive (the accessors the spec asks for), not yet in a node. */
function meshParts(m: Mesh): { doc: Doc; bin: Uint8Array } {
  const parts: Uint8Array[] = []
  const views: Doc[] = []
  const accessors: Doc[] = []
  let offset = 0
  const add = (bytes: Uint8Array, accessor: Doc): number => {
    const padded = new Uint8Array((bytes.length + 3) & ~3)
    padded.set(bytes)
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length })
    accessors.push({ bufferView: views.length - 1, ...accessor })
    parts.push(padded)
    offset += padded.length
    return accessors.length - 1
  }
  const floats = (a: number[]) => new Uint8Array(new Float32Array(a).buffer)
  const attributes: Doc = { POSITION: add(floats(m.positions), { componentType: 5126, count: m.positions.length / 3, type: 'VEC3' }) }
  if (m.normals) attributes['NORMAL'] = add(floats(m.normals), { componentType: 5126, count: m.normals.length / 3, type: 'VEC3' })
  const primitive: Doc = { attributes, material: 0 }
  if (m.mode !== undefined) primitive['mode'] = m.mode
  if (m.indices) primitive['indices'] = add(new Uint8Array(new Uint16Array(m.indices).buffer), { componentType: 5123, count: m.indices.length, type: 'SCALAR' })
  const bin = new Uint8Array(offset)
  let at = 0
  for (const p of parts) {
    bin.set(p, at)
    at += p.length
  }
  const doc: Doc = {
    asset: { version: '2.0' },
    bufferViews: views,
    accessors,
    buffers: [{ byteLength: bin.length }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: m.color ?? [0.8, 0.8, 0.8, 1] } }],
    meshes: [{ primitives: [primitive] }],
  }
  return { doc, bin }
}

/** One mesh in one node of one scene: the typical single-object file. */
function modelOf(m: Mesh, nodes: Doc[] = [{ mesh: 0 }]): Uint8Array {
  const { doc, bin } = meshParts(m)
  doc['nodes'] = nodes
  doc['scenes'] = [{ nodes: [0] }]
  doc['scene'] = 0
  return glb(doc, bin)
}

const CUBE: Mesh = {
  positions: [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
  indices: [4, 5, 6, 4, 6, 7, 1, 0, 3, 1, 3, 2, 5, 1, 2, 5, 2, 6, 0, 4, 7, 0, 7, 3, 7, 6, 2, 7, 2, 3, 0, 1, 5, 0, 5, 4],
}

/* ------------------------------------------------------------------ */
/* The preload, loaded the way the sandbox loads it                   */
/* ------------------------------------------------------------------ */

type Rgb = readonly [number, number, number]
interface Pre {
  parseGlb(bytes: Uint8Array): { doc: unknown; bin: Uint8Array | null } | null
  rasterGlb(g: unknown, side: number, tints?: ReadonlyMap<number, Rgb>, opts?: { now?: () => number; budgetMs?: number; maxTriangles?: number }): Uint8ClampedArray | null
  modelBrightness(diffuse: number, facing: number): number
}

const PRELOAD = path.join(here, '..', 'src', 'preload', 'thumb-preload.cts')

/** Runs the preload source with a stand-in `electron` (the only module a sandboxed preload may require) and `globals`. */
async function loadPreload(globals: Record<string, unknown> = {}) {
  const src = await fs.readFile(PRELOAD, 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const sent: unknown[][] = []
  const listeners = new Map<string, (e: unknown, ...args: unknown[]) => void>()
  const electron = {
    ipcRenderer: {
      send: (...args: unknown[]) => void sent.push(args),
      on: (channel: string, fn: (e: unknown, ...args: unknown[]) => void) => void listeners.set(channel, fn),
    },
  }
  const require = (id: string): unknown => {
    if (id === 'electron') return electron
    throw new Error(`the sandboxed preload cannot require ${id}`)
  }
  const module = { exports: {} as Record<string, unknown> }
  new Function('require', 'module', 'exports', ...Object.keys(globals), js)(require, module, module.exports, ...Object.values(globals))
  return { pre: module.exports as unknown as Pre, sent, listeners }
}

let pre: Pre
beforeEach(async () => {
  if (!pre) pre = (await loadPreload()).pre
})

/** Parse and draw; null when it is not a model or there is nothing to draw. */
function draw(bytes: Uint8Array, side = 64, opts?: Parameters<Pre['rasterGlb']>[3], tints?: ReadonlyMap<number, Rgb>): Uint8ClampedArray | null {
  const g = pre.parseGlb(bytes)
  return g ? pre.rasterGlb(g, side, tints, opts) : null
}

/** Which pixels are the model (they differ from their row's background, read at x = 0), and where its middle and box are. */
function look(img: Uint8ClampedArray, side: number) {
  const px = (x: number, y: number) => [img[(y * side + x) * 4]!, img[(y * side + x) * 4 + 1]!, img[(y * side + x) * 4 + 2]!] as const
  let count = 0
  let minX = side, maxX = -1, minY = side, maxY = -1, sx = 0, sy = 0, r = 0, g = 0, b = 0
  for (let y = 0; y < side; y++) {
    const bg = px(0, y)
    for (let x = 0; x < side; x++) {
      const p = px(x, y)
      if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) <= 6) continue
      count++
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      sx += x
      sy += y
      r += p[0]
      g += p[1]
      b += p[2]
    }
  }
  return { count, minX, maxX, minY, maxY, cx: sx / Math.max(1, count), cy: sy / Math.max(1, count), meanR: r / Math.max(1, count), meanG: g / Math.max(1, count), meanB: b / Math.max(1, count) }
}

/** Fraction of pixels whose channels differ by more than `tolerance`. */
function differing(a: Uint8ClampedArray, b: Uint8ClampedArray, tolerance = 8): number {
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i]! - b[i]!) > tolerance || Math.abs(a[i + 1]! - b[i + 1]!) > tolerance || Math.abs(a[i + 2]! - b[i + 2]!) > tolerance) n++
  }
  return n / (a.length / 4)
}

/* ------------------------------------------------------------------ */
/* Names, the scan and the vault's own door                           */
/* ------------------------------------------------------------------ */

describe('3D model names', () => {
  it('a .glb is a model, in any letter case, and is not media: boards and reveals never see it', () => {
    for (const platform of ['linux', 'win32']) {
      expect(isModelName('robot.glb', platform)).toBe(true)
      expect(isModelName('Robot.GLB', platform)).toBe(true)
      expect(isModelName('scene.gltf', platform)).toBe(false)
      expect(isModelName('robot.glb.exe', platform)).toBe(false)
      expect(isModelName('robot.glbx', platform)).toBe(false)
      expect(isModelName('~$robot.glb', platform)).toBe(false)
      // What pictures and videos were, they still are; a model is neither and the media rules do not widen.
      expect(isMediaName('robot.glb', platform)).toBe(false)
      expect(isImageName('robot.glb', platform)).toBe(false)
      expect(isVideoName('robot.glb', platform)).toBe(false)
      for (const n of ['a.png', 'a.JPG', 'a.mp4', 'a.webm']) expect(isMediaName(n, platform)).toBe(true)
      for (const n of ['a.png', 'a.mp4', 'robot.glb']) expect(isAssetName(n, platform)).toBe(true)
      for (const n of ['note.md', 'scene.gltf', 'icon.svg']) expect(isAssetName(n, platform)).toBe(false)
    }
  })

  it('on Windows a device name or an NTFS stream is no model either (a path that is handed to the OS to open)', () => {
    expect(isModelName('nul.glb', 'win32')).toBe(false)
    expect(isModelName('tool.exe:x.glb', 'win32')).toBe(false)
    expect(isModelName('nul.glb', 'linux')).toBe(true)
  })
})

describe('FsVault and models', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-models-'))
  })
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })
  const put = async (rel: string, content: string | Uint8Array = ''): Promise<string> => {
    const full = path.join(tmp, ...rel.split('/'))
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
    return full
  }

  it('the scan lists a model with the pictures, and not the text form of glTF', async () => {
    await put('Art/robot.glb', modelOf(CUBE))
    await put('Art/gate.png', 'x')
    await put('Art/Note.md', '# n')
    await put('Art/scene.gltf', '{}')
    await put('node_modules/pkg/ship.glb', 'x')
    const res = await new FsVault([tmp]).scan()
    expect(res.assets.map((a) => a.path).sort()).toEqual(['Art/gate.png', 'Art/robot.glb'])
  })

  it('modelAbs opens a model of the vault and nothing else; assetAbs never opens one', async () => {
    const full = await put('Art/robot.glb', modelOf(CUBE))
    await put('Art/gate.png', 'x')
    await fs.mkdir(path.join(tmp, 'Art', 'dir.glb'))
    const v = new FsVault([tmp])
    expect(await v.modelAbs('Art/robot.glb')).toBe(full)
    expect(await v.assetAbs('Art/robot.glb')).toBeNull()
    // The other door: a picture is not a model, a folder named like one is not a file, a missing or escaping path is null.
    expect(await v.modelAbs('Art/gate.png')).toBeNull()
    expect(await v.modelAbs('Art/dir.glb')).toBeNull()
    expect(await v.modelAbs('Art/missing.glb')).toBeNull()
    expect(await v.modelAbs('../outside.glb')).toBeNull()
    expect(await v.modelAbs('')).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* What a model's first bytes say                                     */
/* ------------------------------------------------------------------ */

describe('modelKindOf', () => {
  const good = modelOf(CUBE)

  it('knows a binary glTF 2.0 file by its header', () => {
    expect(modelKindOf(good)).toBe('glb')
    // Only the start of a big file was read: the size says whether the length it declares fits.
    expect(modelKindOf(good.subarray(0, GLB_HEAD_BYTES), good.length)).toBe('glb')
  })

  it('refuses text, other versions, a cut-off copy, and a header whose parts do not add up', () => {
    const edit = (f: (v: DataView) => void, from = good): Uint8Array => {
      const copy = from.slice()
      f(new DataView(copy.buffer))
      return copy
    }
    expect(modelKindOf(new Uint8Array(0))).toBeNull()
    expect(modelKindOf(enc.encode('{"asset":{"version":"2.0"}}   '))).toBeNull()
    expect(modelKindOf(edit((v) => v.setUint32(0, 0x46546c68, true)))).toBeNull()
    expect(modelKindOf(edit((v) => v.setUint32(4, 1, true)))).toBeNull()
    // Declared longer than the file (a download that stopped), or shorter than a header.
    expect(modelKindOf(good.subarray(0, good.length - 4))).toBeNull()
    expect(modelKindOf(edit((v) => v.setUint32(8, 12, true)))).toBeNull()
    // The first chunk must be the JSON, not empty, and inside the declared length.
    expect(modelKindOf(edit((v) => v.setUint32(16, 0x004e4942, true)))).toBeNull()
    expect(modelKindOf(edit((v) => v.setUint32(12, 0, true)))).toBeNull()
    expect(modelKindOf(edit((v) => v.setUint32(12, good.length, true)))).toBeNull()
  })

  it('the helper is sent at most what a picture is, and the head it reads is the header and the first chunk', () => {
    expect(MAX_MODEL_BYTES).toBe(MAX_THUMB_FILE_BYTES)
    expect(GLB_HEAD_BYTES).toBe(20)
  })
})

/* ------------------------------------------------------------------ */
/* The board window never reaches a model                             */
/* ------------------------------------------------------------------ */

describe('the board window and models', () => {
  it('may not ask for a model’s thumbnail or open one, while pictures and videos go on as before', () => {
    const t = rig({ platform: 'linux' })
    for (const channel of [IPC.thumb, IPC.openAsset]) {
      expect(t.host.pageRefusal(channel, ['Art/robot.glb', 256]), channel).toMatch(/pictures and videos only/)
      expect(t.host.pageRefusal(channel, ['Art/ROBOT.GLB']), channel).toMatch(/pictures and videos only/)
      for (const p of ['Art/gate.png', 'Art/clip.mp4', 'a.webp']) expect(t.host.pageRefusal(channel, [p, 128]), `${channel} ${p}`).toBeNull()
    }
    // Not a path at all: left to the handler, as before.
    expect(t.host.pageRefusal(IPC.thumb, [7, 128])).toBeNull()
    // The file manager still shows pictures, videos and the board's own note only.
    expect(t.host.pageRefusal(IPC.reveal, ['Art/robot.glb'])).toMatch(/only pictures, videos/)
  })

  it('main routes a model to the helper by its own door, and still decodes nothing itself', async () => {
    const main = await fs.readFile(path.join(here, '..', 'src', 'main', 'main.ts'), 'utf8')
    expect(main).toMatch(/thumbnailer\.renderModel\(/)
    expect(main).toMatch(/v\.modelAbs\(/)
    expect(main).toMatch(/modelKindOf\(/)
    expect(main).not.toMatch(/\bnativeImage\s*[.,}]|createThumbnailFromPath\(|createFromPath\(|createFromBuffer\(/)
    // The door pictures use is not widened: a model is asked for by name, never through assetAbs's list.
    const fsvault = await fs.readFile(path.join(here, '..', 'src', 'main', 'fsvault.ts'), 'utf8')
    expect(fsvault).toMatch(/async assetAbs\(p: string\): Promise<string \| null> \{\s*return this\.shownAbs\(p, isMediaName\)/)
    expect(fsvault).toMatch(/async modelAbs\(p: string\): Promise<string \| null> \{\s*return this\.shownAbs\(p, isModelName\)/)
  })
})

/* ------------------------------------------------------------------ */
/* The helper queue carries a model job                               */
/* ------------------------------------------------------------------ */

describe('ThumbQueue with a model job', () => {
  it('hands the model job to the helper as it is and gives back the PNG it answers', async () => {
    const sent: { id: number; job: ThumbJob }[] = []
    const helper: ThumbHelper = { id: 1, send: (id, job) => void sent.push({ id, job }), destroy: () => undefined }
    const q = new ThumbQueue(() => helper, { timeoutMs: 1000 })
    const bytes = modelOf(CUBE)
    const out = q.render({ model: bytes, px: 256 })
    q.ready(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.job).toEqual({ model: bytes, px: 256 })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    q.done(1, sent[0]!.id, png)
    expect(await out).toEqual(png)
  })
})

/* ------------------------------------------------------------------ */
/* The rasterizer                                                     */
/* ------------------------------------------------------------------ */

describe('parseGlb', () => {
  it('reads the JSON and the BIN chunk of a binary glTF', () => {
    const g = pre.parseGlb(modelOf(CUBE))!
    expect(g).not.toBeNull()
    expect((g.doc as Doc)['meshes']).toHaveLength(1)
    expect(g.bin!.length).toBe(8 * 12 + 36 * 2)
  })

  it('refuses everything that is not a whole binary glTF 2.0 file', () => {
    const good = modelOf(CUBE)
    const mut = (f: (v: DataView) => void): Uint8Array => {
      const c = good.slice()
      f(new DataView(c.buffer))
      return c
    }
    expect(pre.parseGlb(new Uint8Array(10))).toBeNull()
    expect(pre.parseGlb(mut((v) => v.setUint32(0, 0, true)))).toBeNull()
    expect(pre.parseGlb(mut((v) => v.setUint32(4, 1, true)))).toBeNull()
    // Longer than the file, and a chunk that runs past the end.
    expect(pre.parseGlb(mut((v) => v.setUint32(8, good.length + 4, true)))).toBeNull()
    expect(pre.parseGlb(mut((v) => v.setUint32(12, good.length * 2, true)))).toBeNull()
    // JSON that is not an object: a number, an array, text.
    expect(pre.parseGlb(glb(7))).toBeNull()
    expect(pre.parseGlb(glb([1, 2]))).toBeNull()
    const text = good.slice()
    text.fill(0x78, 20, 40)
    expect(pre.parseGlb(text)).toBeNull()
  })
})

describe('rasterGlb', () => {
  const SIDE = 64

  it('draws a cube in the middle of the square, fitted with a margin, on a background that is not the model', () => {
    const img = draw(modelOf(CUBE), SIDE)!
    expect(img).not.toBeNull()
    expect(img.length).toBe(SIDE * SIDE * 4)
    // Opaque everywhere.
    for (let i = 3; i < img.length; i += 4) expect(img[i]).toBe(255)
    const l = look(img, SIDE)
    expect(l.count).toBeGreaterThan(SIDE * SIDE * 0.15)
    expect(l.count).toBeLessThan(SIDE * SIDE * 0.8)
    expect(l.minX).toBeGreaterThan(0)
    expect(l.maxX).toBeLessThan(SIDE - 1)
    expect(l.minY).toBeGreaterThan(0)
    expect(l.maxY).toBeLessThan(SIDE - 1)
    expect(Math.abs(l.cx - (SIDE - 1) / 2)).toBeLessThan(4)
    expect(Math.abs(l.cy - (SIDE - 1) / 2)).toBeLessThan(4)
  })

  it('draws the same bytes the same way every time, and a larger square the same shape', () => {
    const bytes = modelOf(CUBE)
    const a = draw(bytes, SIDE)!
    const b = draw(bytes, SIDE)!
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0)
    const big = look(draw(bytes, 256)!, 256)
    const small = look(a, SIDE)
    expect(Math.abs(big.count / (256 * 256) - small.count / (SIDE * SIDE))).toBeLessThan(0.05)
  })

  it('keeps the material’s hue: a red model is red', () => {
    const red = look(draw(modelOf({ ...CUBE, color: [1, 0, 0, 1] }), SIDE)!, SIDE)
    expect(red.meanR).toBeGreaterThan(red.meanG * 2)
    expect(red.meanR).toBeGreaterThan(red.meanB * 2)
    const blue = look(draw(modelOf({ ...CUBE, color: [0, 0, 1, 1] }), SIDE)!, SIDE)
    expect(blue.meanB).toBeGreaterThan(blue.meanR * 2)
    // A texture's average colour (what the helper reads from an embedded picture) tints the material.
    const tinted = look(draw(modelOf(CUBE), SIDE, undefined, new Map([[0, [0, 1, 0] as const]]))!, SIDE)
    expect(tinted.meanG).toBeGreaterThan(tinted.meanR * 2)
  })

  it('brings a very dark model up to a readable level, and leaves a bright one as it is', () => {
    const level = (c: number) => {
      const l = look(draw(modelOf({ ...CUBE, color: [c, c, c, 1] }), SIDE)!, SIDE)
      return (l.meanR + l.meanG + l.meanB) / 3
    }
    const black = level(0.0005)
    const dark = level(0.01)
    const bright = level(0.9)
    // Compared with a bright model, so the test does not pin the look: a dark colour is about a tenth as bright as a bright one
    // before the lift (sRGB 0.1 against 0.95); the lift brings it to about a third.
    expect(dark / bright).toBeGreaterThan(0.2)
    expect(dark / bright).toBeLessThan(0.6)
    // The lift is capped, so a black material is not turned grey; and a bright model is left alone, short of white.
    expect(black / bright).toBeLessThan(0.06)
    expect(black).toBeLessThan(dark)
    expect(bright).toBeLessThan(255)
  })

  it('shades with vertex normals when the file has them (a lit side and a dark side are told apart)', () => {
    // Smooth cube: every corner's normal points out of the corner.
    const n = CUBE.positions.map((c) => c / Math.sqrt(3))
    const flat = draw(modelOf(CUBE), SIDE)!
    const smooth = draw(modelOf({ ...CUBE, normals: n }), SIDE)!
    expect(look(smooth, SIDE).count).toBe(look(flat, SIDE).count)
    expect(differing(flat, smooth, 4)).toBeGreaterThan(0.05)
  })

  it('places every use of a mesh by its node: one mesh in two nodes is two objects, fitted together', () => {
    const one = look(draw(modelOf(CUBE), SIDE)!, SIDE)
    const nodes: Doc[] = [{ children: [1, 2] }, { mesh: 0, translation: [-3, 0, 0] }, { mesh: 0, translation: [3, 0, 0] }]
    const two = look(draw(modelOf(CUBE, nodes), SIDE)!, SIDE)
    // Two cubes side by side are wider than tall and fill the width the fit gives them.
    expect(two.maxX - two.minX).toBeGreaterThan((two.maxY - two.minY) * 1.5)
    expect(two.maxX - two.minX).toBeGreaterThan(one.maxX - one.minX)
    expect(two.minX).toBeGreaterThan(0)
    expect(two.maxX).toBeLessThan(SIDE - 1)
  })

  it('composes a parent’s transform with its child’s: two quarter-turns in a chain are one half-turn', () => {
    // A lopsided shape (an L of two triangles) so that a turn about Y shows.
    const L: Mesh = { positions: [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0] }
    const q = (deg: number): number[] => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)]
    const chain = draw(modelOf(L, [{ children: [1], rotation: q(60) }, { mesh: 0, rotation: q(60) }]), SIDE)!
    const single = draw(modelOf(L, [{ mesh: 0, rotation: q(120) }]), SIDE)!
    const none = draw(modelOf(L, [{ mesh: 0 }]), SIDE)!
    expect(differing(chain, single)).toBeLessThan(0.01)
    expect(differing(chain, none)).toBeGreaterThan(0.03)
    // And a matrix is the same as its translation, rotation and scale.
    const trs = draw(modelOf(L, [{ mesh: 0, rotation: q(120), scale: [1.5, 1.5, 1.5] }]), SIDE)!
    const c = Math.cos((120 * Math.PI) / 180), s = Math.sin((120 * Math.PI) / 180)
    const asMatrix = draw(modelOf(L, [{ mesh: 0, matrix: [1.5 * c, 0, -1.5 * s, 0, 0, 1.5, 0, 0, 1.5 * s, 0, 1.5 * c, 0, 0, 0, 0, 1] }]), SIDE)!
    expect(differing(trs, asMatrix)).toBeLessThan(0.01)
  })

  it('draws strips and fans as the triangles they unroll to', () => {
    const quad = [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]
    const strip = look(draw(modelOf({ positions: quad, mode: 5 }), SIDE)!, SIDE)
    const fan = look(draw(modelOf({ positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], mode: 6 }), SIDE)!, SIDE)
    expect(strip.count).toBeGreaterThan(SIDE * SIDE * 0.1)
    expect(Math.abs(strip.count - fan.count) / strip.count).toBeLessThan(0.08)
  })

  it('reads positions stored as normalized integers (KHR_mesh_quantization) like the floats they stand for', () => {
    const ints = new Int16Array(CUBE.positions.map((c) => c * 32767))
    const idx = new Uint16Array(CUBE.indices!)
    const bin = new Uint8Array(ints.byteLength + idx.byteLength)
    bin.set(new Uint8Array(ints.buffer), 0)
    bin.set(new Uint8Array(idx.buffer), ints.byteLength)
    const doc: Doc = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: ints.byteLength },
        { buffer: 0, byteOffset: ints.byteLength, byteLength: idx.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5122, normalized: true, count: 8, type: 'VEC3' },
        { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    }
    const quantized = draw(glb(doc, bin), SIDE)!
    expect(differing(quantized, draw(modelOf(CUBE), SIDE)!, 40)).toBeLessThan(0.02)
  })

  it('draws nothing, and does not throw, for geometry it cannot read', () => {
    const { doc, bin } = meshParts(CUBE)
    const asFile = (d: Doc, b: Uint8Array | null = bin): Uint8Array => glb({ ...d, nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] }, b ?? undefined)
    // No mesh at all, or a mesh with no primitives.
    expect(draw(glb({ asset: { version: '2.0' } }))).toBeNull()
    expect(draw(asFile({ ...doc, meshes: [{ primitives: [] }] }))).toBeNull()
    // Compressed geometry has no buffer view to read (Draco), a meshopt view is refused, and sparse accessors are skipped.
    const noView = structuredClone(doc)
    delete noView['accessors'][0].bufferView
    noView['meshes'][0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } }
    expect(draw(asFile(noView))).toBeNull()
    const meshopt = structuredClone(doc)
    meshopt['bufferViews'][0].extensions = { EXT_meshopt_compression: { buffer: 0, byteLength: 1, byteStride: 12, count: 1, mode: 'ATTRIBUTES' } }
    expect(draw(asFile(meshopt))).toBeNull()
    const sparse = structuredClone(doc)
    sparse['accessors'][0].sparse = { count: 1, indices: {}, values: {} }
    expect(draw(asFile(sparse))).toBeNull()
    // An accessor that reaches past its buffer, a count that is a lie, and a buffer that lives in another file.
    const past = structuredClone(doc)
    past['accessors'][0].count = 1_000_000
    expect(draw(asFile(past))).toBeNull()
    const short = structuredClone(doc)
    short['accessors'][0].count = 9
    expect(draw(asFile(short))).toBeNull()
    // (a file that names its buffer is not reading the BIN chunk, with or without one; and no BIN chunk at all is nothing to read)
    expect(draw(asFile({ ...doc, buffers: [{ byteLength: bin.length, uri: 'robot.bin' }] }))).toBeNull()
    expect(draw(asFile({ ...doc, buffers: [{ byteLength: 8, uri: 'robot.bin' }] }, null))).toBeNull()
    expect(draw(asFile(doc, null))).toBeNull()
    // Points and lines are not surfaces; indices past the vertices make no triangle; NaN is no place.
    const points = structuredClone(doc)
    points['meshes'][0].primitives[0].mode = 0
    expect(draw(asFile(points))).toBeNull()
    expect(draw(modelOf({ positions: CUBE.positions, indices: [0, 1, 99, 98, 97, 96] }))).toBeNull()
    expect(draw(modelOf({ positions: [NaN, 0, 0, 1, NaN, 0, 0, 1, NaN], indices: [0, 1, 2] }))).toBeNull()
  })

  it('draws the triangles it can and leaves a broken one out', () => {
    // A cube whose last triangle names a vertex that is not there.
    const bad = { ...CUBE, indices: [...CUBE.indices!.slice(0, -3), 0, 1, 500] }
    const l = look(draw(modelOf(bad), SIDE)!, SIDE)
    expect(l.count).toBeGreaterThan(SIDE * SIDE * 0.1)
  })

  it('ends on a node that holds itself, and stops at the depth it allows', () => {
    // A node that is its own child.
    const loop = look(draw(modelOf(CUBE, [{ mesh: 0, children: [0] }]), SIDE)!, SIDE)
    expect(loop.count).toBeGreaterThan(SIDE * SIDE * 0.15)
    const chain = (length: number): Doc[] =>
      Array.from({ length }, (_, i) => (i === length - 1 ? { mesh: 0 } : { children: [i + 1] }))
    expect(draw(modelOf(CUBE, chain(30)), SIDE)).not.toBeNull()
    // 200 nodes deep: past the limit, so the mesh at the bottom is never reached (and nothing overflows the stack).
    expect(draw(modelOf(CUBE, chain(200)), SIDE)).toBeNull()
  })

  it('places a mesh at most so many times, however many nodes name it', () => {
    const many: Doc[] = [{ children: Array.from({ length: 25_000 }, (_, i) => i + 1) }, ...Array.from({ length: 25_000 }, () => ({ mesh: 0 }))]
    const started = Date.now()
    const img = draw(modelOf(CUBE, many), 32)
    expect(img).not.toBeNull()
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('stops at its time budget and keeps what it drew, and draws every n-th triangle of a model that is too big', () => {
    // A grid of 40 × 40 quads (3,200 triangles) in the XY plane.
    const positions: number[] = []
    const indices: number[] = []
    const n = 40
    for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) positions.push(x / n, y / n, 0)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const a = y * (n + 1) + x
        indices.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1)
      }
    }
    const bytes = modelOf({ positions, indices })
    const full = look(draw(bytes, 128)!, 128).count
    expect(full).toBeGreaterThan(128 * 128 * 0.2)
    // A clock that moves one tick a look and a budget of three ticks: it looks every 256 triangles, so it stops near 768.
    let t = 0
    const limited = look(draw(bytes, 128, { now: () => t++, budgetMs: 3 })!, 128).count
    expect(limited).toBeGreaterThan(0)
    expect(limited).toBeLessThan(full * 0.5)
    // A budget that is gone before the first triangle draws nothing: no thumbnail, not a picture of the background.
    let u = 0
    expect(draw(bytes, 128, { now: () => u++, budgetMs: 0 })).toBeNull()
    // Every tenth triangle: fewer pixels, the same square.
    const sparse = draw(bytes, 128, { maxTriangles: 320 })!
    expect(look(sparse, 128).count).toBeGreaterThan(0)
    expect(look(sparse, 128).count).toBeLessThan(full)
  })
})

describe('modelBrightness', () => {
  it('is a plain, finite, non-negative number for every light and angle the rasterizer asks it about', () => {
    for (const diffuse of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      for (const facing of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
        const k = pre.modelBrightness(diffuse, facing)
        expect(Number.isFinite(k), `${diffuse} ${facing}`).toBe(true)
        expect(k, `${diffuse} ${facing}`).toBeGreaterThanOrEqual(0)
        expect(k, `${diffuse} ${facing}`).toBeLessThanOrEqual(3)
      }
    }
  })
})

/* ------------------------------------------------------------------ */
/* The preload, end to end over its IPC                               */
/* ------------------------------------------------------------------ */

describe('thumb-preload model jobs', () => {
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

  async function helper() {
    const puts: { width: number; height: number; data: Uint8ClampedArray }[] = []
    const globals = {
      Blob,
      atob,
      createImageBitmap: async () => {
        throw new Error('no textures in these models')
      },
      ImageData: class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
      document: {
        createElement: (tag: string) => {
          expect(tag).toBe('canvas')
          return {
            width: 0,
            height: 0,
            getContext: () => ({ putImageData: (img: { width: number; height: number; data: Uint8ClampedArray }) => void puts.push(img) }),
            toDataURL(type: string) {
              return `data:${type};base64,${Buffer.from([...PNG_SIG, this.width, this.height]).toString('base64')}`
            },
          }
        },
      },
    }
    const { sent, listeners } = await loadPreload(globals)
    const run = async (...args: unknown[]) => {
      const before = sent.length
      listeners.get(THUMB_IPC.model)!({}, ...args)
      await vi_waitFor(() => sent.length === before + 1)
      return sent.at(-1)!
    }
    return { sent, run, puts }
  }

  async function vi_waitFor(ok: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000
    while (!ok()) {
      if (Date.now() > deadline) throw new Error('no answer')
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  it('listens on the model channel, draws a square of the size asked and answers PNG bytes', async () => {
    const h = await helper()
    expect(h.sent[0]).toEqual([THUMB_IPC.ready])
    const out = await h.run(11, modelOf(CUBE), 48)
    expect(out).toEqual([THUMB_IPC.done, 11, new Uint8Array([...PNG_SIG, 48, 48])])
    expect(h.puts).toHaveLength(1)
    expect([h.puts[0]!.width, h.puts[0]!.height, h.puts[0]!.data.length]).toEqual([48, 48, 48 * 48 * 4])
  })

  it('answers null for bytes that are no model, a model with nothing to draw, and arguments that are no job', async () => {
    const h = await helper()
    expect((await h.run(1, new Uint8Array([1, 2, 3, 4]), 48))[2]).toBeNull()
    expect((await h.run(2, glb({ asset: { version: '2.0' } }), 48))[2]).toBeNull()
    for (const [i, bad] of ([
      ['not bytes', 48],
      [modelOf(CUBE), 0],
      [modelOf(CUBE), 5000],
      [modelOf(CUBE), 48.5],
      [modelOf(CUBE), '48'],
    ] as const).entries()) {
      expect((await h.run(10 + i, ...bad))[2], String(i)).toBeNull()
    }
    // Nothing was drawn for any of them.
    expect(h.puts).toHaveLength(0)
  })
})
