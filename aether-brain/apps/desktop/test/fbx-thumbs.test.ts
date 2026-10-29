import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { FsVault, isAssetName, isFbxName } from '../src/main/fsvault.js'
import { FBX_HEAD_BYTES, fbxKindOf } from '../src/main/assets.js'
import { THUMB_IPC, ThumbQueue, type ThumbHelper, type ThumbJob } from '../src/main/thumbnailer.js'
import { previewKindOf } from '@aether/core'

/**
 * FBX models (docs/COSMOLOGY.md, *Every file is a satellite*): a `.fbx` is drawn like a glb. The helper's preload reads the binary file
 * into the same structure a glTF has (`parseFbx`) and the rasterizer draws that. The reader is pure, so it is run here on hand-built files.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const PRELOAD = path.join(here, '..', 'src', 'preload', 'thumb-preload.cts')

interface Glb {
  doc: {
    nodes?: { mesh?: number; matrix?: number[] }[]
    meshes?: { primitives?: unknown[] }[]
    accessors?: { count?: number }[]
  }
  bin: Uint8Array | null
}
interface Pre {
  parseFbx(bytes: Uint8Array): Promise<Glb | null>
  rasterGlb(g: Glb, side: number): Uint8ClampedArray | null
  FBX_LIMITS: { nodes: number; depth: number; arrayBytes: number; totalBytes: number; models: number }
}

async function loadPreload(): Promise<Pre> {
  const src = await fs.readFile(PRELOAD, 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const electron = { ipcRenderer: { send: () => undefined, on: () => undefined } }
  const module = { exports: {} as Record<string, unknown> }
  new Function('require', 'module', 'exports', js)(() => electron, module, module.exports)
  return module.exports as unknown as Pre
}

/* ------------------------------------------------------------------ */
/* Building binary FBX files                                          */
/* ------------------------------------------------------------------ */

type Prop = { t: 'I' | 'L' | 'D' | 'S'; v: number | string } | { t: 'd' | 'i'; v: number[]; deflate?: boolean }
interface N {
  name: string
  props?: Prop[]
  kids?: N[]
}
const I = (v: number): Prop => ({ t: 'I', v })
const L = (v: number): Prop => ({ t: 'L', v })
const D = (v: number): Prop => ({ t: 'D', v })
const S = (v: string): Prop => ({ t: 'S', v })
const arr = (t: 'd' | 'i', v: number[], deflate = false): Prop => ({ t, v, deflate })

const enc = new TextEncoder()

function propBytes(p: Prop): number[] {
  const out: number[] = []
  const u32 = (n: number) => out.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff)
  if (p.t === 'I') {
    out.push(0x49)
    u32(p.v as number)
  } else if (p.t === 'L') {
    out.push(0x4c)
    const b = Buffer.alloc(8)
    b.writeBigInt64LE(BigInt(p.v as number))
    out.push(...b)
  } else if (p.t === 'D') {
    out.push(0x44)
    const b = Buffer.alloc(8)
    b.writeDoubleLE(p.v as number)
    out.push(...b)
  } else if (p.t === 'S') {
    out.push(0x53)
    const s = enc.encode(p.v as string)
    u32(s.length)
    out.push(...s)
  } else {
    out.push(p.t.charCodeAt(0))
    const raw = Buffer.alloc(p.v.length * (p.t === 'd' ? 8 : 4))
    p.v.forEach((x, i) => (p.t === 'd' ? raw.writeDoubleLE(x, i * 8) : raw.writeInt32LE(x, i * 4)))
    const data = p.deflate ? deflateSync(raw) : raw
    u32(p.v.length)
    u32(p.deflate ? 1 : 0)
    u32(data.length)
    out.push(...data)
  }
  return out
}

/** One node record at absolute `at`, with its children and the zero record that ends them. */
function node(n: N, at: number): number[] {
  const name = enc.encode(n.name)
  const props = (n.props ?? []).flatMap(propBytes)
  const headLen = 13 + name.length
  let body: number[] = []
  let cursor = at + headLen + props.length
  for (const k of n.kids ?? []) {
    const bytes = node(k, cursor)
    body = body.concat(bytes)
    cursor += bytes.length
  }
  if (n.kids?.length) {
    body = body.concat(new Array(13).fill(0))
    cursor += 13
  }
  const out: number[] = []
  const u32 = (x: number) => out.push(x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >>> 24) & 0xff)
  u32(cursor)
  u32(n.props?.length ?? 0)
  u32(props.length)
  out.push(name.length, ...name, ...props, ...body)
  return out
}

function fbx(roots: N[], version = 7400): Uint8Array {
  const head = [...enc.encode('Kaydara FBX Binary  '), 0, 0x1a, 0, version & 0xff, (version >> 8) & 0xff, 0, 0]
  let bytes = head
  for (const r of roots) bytes = bytes.concat(node(r, bytes.length))
  return Uint8Array.from(bytes.concat(new Array(13).fill(0)))
}

const P = (name: string, ...v: number[]): N => ({ name: 'P', props: [S(name), S('Lcl'), S(''), S('A'), ...v.map(D)] })

/** A cube as FBX stores a mesh: doubles for the corners, the index of a polygon's last corner stored as its complement. */
function cube(id: number, deflate = false): N {
  const v = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]]
  const poly = quads.flatMap((q) => [q[0]!, q[1]!, q[2]!, ~q[3]!])
  return { name: 'Geometry', props: [L(id), S('Cube\0\x01Geometry'), S('Mesh')], kids: [{ name: 'Vertices', props: [arr('d', v, deflate)] }, { name: 'PolygonVertexIndex', props: [arr('i', poly, deflate)] }] }
}

function model(id: number, props: N[] = []): N {
  return { name: 'Model', props: [L(id), S('Box\0\x01Model'), S('Mesh')], kids: props.length ? [{ name: 'Properties70', kids: props }] : [] }
}
const link = (child: number, parent: number): N => ({ name: 'C', props: [S('OO'), L(child), L(parent)] })

function scene(opts: { models?: N[]; links?: N[]; geometry?: N[]; globals?: N[] } = {}): Uint8Array {
  const roots: N[] = []
  if (opts.globals) roots.push({ name: 'GlobalSettings', kids: [{ name: 'Properties70', kids: opts.globals }] })
  roots.push({ name: 'Objects', kids: [...(opts.geometry ?? [cube(10)]), ...(opts.models ?? [model(20)])] })
  roots.push({ name: 'Connections', kids: opts.links ?? [link(10, 20), link(20, 0)] })
  return fbx(roots)
}

/* ------------------------------------------------------------------ */

describe('reading a binary FBX file', () => {
  it('turns a mesh and the model that places it into one glTF-like node with the cube’s eight corners and twelve triangles', async () => {
    const pre = await loadPreload()
    const g = (await pre.parseFbx(scene()))!
    expect(g.doc.nodes).toHaveLength(1)
    expect(g.doc.meshes).toHaveLength(1)
    expect(g.doc.accessors![0]!.count).toBe(8)
    expect(g.doc.accessors![1]!.count).toBe(36)
    expect(g.doc.nodes![0]!.matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  })

  it('reads the same file when its arrays are deflated', async () => {
    const pre = await loadPreload()
    const raw = (await pre.parseFbx(scene()))!
    const zipped = (await pre.parseFbx(scene({ geometry: [cube(10, true)] })))!
    expect(Array.from(zipped.bin!)).toEqual(Array.from(raw.bin!))
  })

  it('places a model by its translation, rotation and scale, and by its parent', async () => {
    const pre = await loadPreload()
    const moved = (await pre.parseFbx(scene({ models: [model(20, [P('Lcl Translation', 5, 6, 7), P('Lcl Scaling', 2, 2, 2)])] })))!
    expect(moved.doc.nodes![0]!.matrix).toEqual([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 6, 7, 1])
    const turned = (await pre.parseFbx(scene({ models: [model(20, [P('Lcl Rotation', 0, 90, 0)])] })))!
    const m = turned.doc.nodes![0]!.matrix!
    // A quarter turn about y sends x to -z.
    expect([Math.round(m[0]!), Math.round(m[2]!), Math.round(m[8]!), Math.round(m[10]!)]).toEqual([0, -1, 1, 0])
    const child = (await pre.parseFbx(scene({ models: [model(20, [P('Lcl Translation', 1, 0, 0)]), model(21, [P('Lcl Translation', 0, 3, 0)])], links: [link(10, 21), link(21, 20), link(20, 0)] })))!
    expect(child.doc.nodes![0]!.matrix!.slice(12, 15)).toEqual([1, 3, 0])
  })

  it('turns a Z-up file so its Z is the camera’s up', async () => {
    const pre = await loadPreload()
    const up = (await pre.parseFbx(scene({ globals: [{ name: 'P', props: [S('UpAxis'), S('int'), S('Integer'), S(''), I(2)] }] })))!
    const m = up.doc.nodes![0]!.matrix!
    // z → y and y → -z.
    expect([m[5], m[6], m[9], m[10]]).toEqual([0, -1, 1, 0])
  })

  it('draws one mesh used by two models twice, from one copy of its geometry', async () => {
    const pre = await loadPreload()
    const g = (await pre.parseFbx(scene({ models: [model(20), model(21, [P('Lcl Translation', 4, 0, 0)])], links: [link(10, 20), link(10, 21)] })))!
    expect(g.doc.nodes).toHaveLength(2)
    expect(g.doc.meshes).toHaveLength(1)
  })

  it('cuts a polygon of five corners into a fan of three triangles, and skips a corner that is not in the mesh', async () => {
    const pre = await loadPreload()
    const pent: N = { name: 'Geometry', props: [L(10), S('P'), S('Mesh')], kids: [{ name: 'Vertices', props: [arr('d', [0, 0, 0, 1, 0, 0, 2, 1, 0, 1, 2, 0, 0, 1, 0])] }, { name: 'PolygonVertexIndex', props: [arr('i', [0, 1, 2, 3, ~4])] }] }
    const g = (await pre.parseFbx(scene({ geometry: [pent] })))!
    expect(g.doc.accessors![1]!.count).toBe(9)
    const bad: N = { name: 'Geometry', props: [L(10), S('P'), S('Mesh')], kids: [{ name: 'Vertices', props: [arr('d', [0, 0, 0, 1, 0, 0, 0, 1, 0])] }, { name: 'PolygonVertexIndex', props: [arr('i', [0, 1, ~9])] }] }
    expect(await pre.parseFbx(scene({ geometry: [bad] }))).toBeNull()
  })

  it('is drawn by the rasterizer like any model: something in the middle, and the same every time', async () => {
    const pre = await loadPreload()
    const g = (await pre.parseFbx(scene()))!
    const a = pre.rasterGlb(g, 64)!
    expect(a).not.toBeNull()
    expect(Array.from(pre.rasterGlb(g, 64)!)).toEqual(Array.from(a))
    const at = (x: number, y: number) => a[(y * 64 + x) * 4]!
    // The cube fills the middle and the corner is the background gradient.
    expect(at(32, 32)).toBeGreaterThan(at(1, 1) + 20)
  })

  it('refuses what it cannot read: other bytes, old and unknown versions, a cut-off file, an array too big, a file with no mesh', async () => {
    const pre = await loadPreload()
    const good = scene()
    expect(await pre.parseFbx(enc.encode('Kaydara FBX Binary  not really'))).toBeNull()
    expect(await pre.parseFbx(enc.encode('; FBX 7.4.0 project file\n; ASCII form is not read'.repeat(3)))).toBeNull()
    expect(await pre.parseFbx(fbx([{ name: 'Objects' }], 6100))).toBeNull()
    expect(await pre.parseFbx(good.slice(0, good.length - 40))).toBeNull()
    expect(await pre.parseFbx(new Uint8Array(10))).toBeNull()
    expect(await pre.parseFbx(scene({ geometry: [], models: [model(20)] }))).toBeNull()
    // An array that claims to be larger than any model may be.
    const huge = good.slice()
    const at = Array.from(huge).findIndex((_, i) => String.fromCharCode(...huge.slice(i, i + 8)) === 'Vertices')
    new DataView(huge.buffer).setUint32(at + 8 + 1, 0x7fffffff, true)
    expect(await pre.parseFbx(huge)).toBeNull()
  })

  it('does not follow a loop of models forever', async () => {
    const pre = await loadPreload()
    const g = await pre.parseFbx(scene({ models: [model(20), model(21)], links: [link(10, 20), link(20, 21), link(21, 20)] }))
    expect(g?.doc.nodes).toHaveLength(1)
  })

  it('refuses an array that expands past what it said (a zip bomb)', async () => {
    const pre = await loadPreload()
    const bomb = scene({ geometry: [cube(10, true)] })
    // Cut the stored length of the vertices array in half: the data inflates to more than it claims.
    const at = Array.from(bomb).findIndex((_, i) => String.fromCharCode(...bomb.slice(i, i + 8)) === 'Vertices')
    const v = new DataView(bomb.buffer)
    const props = at + 8 + 1
    v.setUint32(props, 12, true)
    expect(await pre.parseFbx(bomb)).toBeNull()
  })
})

describe('telling and fetching an FBX', () => {
  it('knows a binary FBX of version 7100 to 8000 by its first bytes', () => {
    const good = scene()
    expect(fbxKindOf(good.subarray(0, FBX_HEAD_BYTES))).toBe(true)
    expect(fbxKindOf(fbx([], 7700).subarray(0, FBX_HEAD_BYTES))).toBe(true)
    expect(fbxKindOf(fbx([], 6100).subarray(0, FBX_HEAD_BYTES))).toBe(false)
    expect(fbxKindOf(fbx([], 9000).subarray(0, FBX_HEAD_BYTES))).toBe(false)
    expect(fbxKindOf(enc.encode('; FBX 7.4.0 project file; ASCII'))).toBe(false)
    expect(fbxKindOf(good.subarray(0, 10))).toBe(false)
  })

  it('names a .fbx a model to preview, not a picture, and opens it only through previewAbs', async () => {
    expect(isFbxName('Kit.FBX')).toBe(true)
    expect(isFbxName('kit.fbx.txt')).toBe(false)
    expect(isAssetName('kit.fbx')).toBe(false)
    expect(previewKindOf('Art/kit.FBX')).toBe('fbx')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-fbx-door-'))
    try {
      await fs.mkdir(path.join(dir, 'Art'))
      await fs.writeFile(path.join(dir, 'Art', 'kit.fbx'), scene())
      const vault = new FsVault([dir])
      expect(await vault.previewAbs('Art/kit.fbx')).not.toBeNull()
      expect(await vault.assetAbs('Art/kit.fbx')).toBeNull()
      expect(await vault.modelAbs('Art/kit.fbx')).toBeNull()
      expect(await vault.previewAbs('../outside.fbx')).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('hands the job to the helper on its own channel', async () => {
    const sent: { id: number; job: ThumbJob }[] = []
    const helper: ThumbHelper = { id: 1, send: (id, job) => void sent.push({ id, job }), destroy: () => undefined }
    const q = new ThumbQueue(() => helper, { timeoutMs: 1000 })
    const bytes = scene()
    const out = q.render({ fbx: bytes, px: 256 })
    q.ready(1)
    expect(sent[0]!.job).toEqual({ fbx: bytes, px: 256 })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4])
    q.done(1, sent[0]!.id, png)
    expect(await out).toEqual(png)
    expect(THUMB_IPC.fbx).toBe('thumbs:fbx')
  })
})
