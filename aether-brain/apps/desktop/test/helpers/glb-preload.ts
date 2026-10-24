/**
 * Shared by the tests of the model pictures (model-icons.test.ts, model-proxy.test.ts): hand-built binary glTF files, and the thumbnail
 * helper's preload loaded the way the sandbox loads it (a stand-in `electron`, a fake page that keeps what is drawn).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
export const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/* ------------------------------------------------------------------ */
/* Building binary glTF files                                         */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder()
export type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** A binary glTF: the JSON, then the BIN chunk when there is one, each padded to four bytes as the format asks. */
export function glb(doc: unknown, bin?: Uint8Array): Uint8Array {
  const json = enc.encode(JSON.stringify(doc))
  const jsonLen = (json.length + 3) & ~3
  const binLen = bin ? (bin.length + 3) & ~3 : 0
  const total = 12 + 8 + jsonLen + (bin ? 8 + binLen : 0)
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x46546c67, true)
  v.setUint32(4, 2, true)
  v.setUint32(8, total, true)
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

/** The BIN chunk being laid out: buffer views and the accessors on them. */
export class Packer {
  parts: Uint8Array[] = []
  views: Doc[] = []
  accessors: Doc[] = []
  size = 0

  view(bytes: Uint8Array, extra: Doc = {}): number {
    const padded = new Uint8Array((bytes.length + 3) & ~3)
    padded.set(bytes)
    this.views.push({ buffer: 0, byteOffset: this.size, byteLength: bytes.length, ...extra })
    this.parts.push(padded)
    this.size += padded.length
    return this.views.length - 1
  }

  accessor(view: number, acc: Doc): number {
    this.accessors.push({ bufferView: view, ...acc })
    return this.accessors.length - 1
  }

  floats(values: number[], type: 'VEC3' | 'VEC2' | 'SCALAR'): number {
    const comps = type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1
    return this.accessor(this.view(new Uint8Array(new Float32Array(values).buffer)), { componentType: 5126, count: values.length / comps, type })
  }

  indices16(values: number[]): number {
    return this.accessor(this.view(new Uint8Array(new Uint16Array(values).buffer)), { componentType: 5123, count: values.length, type: 'SCALAR' })
  }

  /** Bytes nothing draws (a normal map's picture, a metal-rough map): a buffer view of `bytes` of 0xAB. */
  junk(bytes: number): number {
    return this.view(new Uint8Array(bytes).fill(0xab))
  }

  bin(): Uint8Array {
    const out = new Uint8Array(this.size)
    let at = 0
    for (const p of this.parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }
}


/* ------------------------------------------------------------------ */
/* The preload, loaded the way the sandbox loads it                   */
/* ------------------------------------------------------------------ */

export type Rgb = readonly [number, number, number]
export interface Tex {
  width: number
  height: number
  data: Uint8ClampedArray
  wrapS: number
  wrapT: number
  cutoff: number
}
export interface Glb {
  doc: Doc
  bin: Uint8Array | null
}
export interface RangeSource {
  size: number
  read(start: number, length: number): Promise<Uint8Array | null>
}
export interface Pre {
  parseGlb(bytes: Uint8Array): Glb | null
  rasterGlb(g: Glb, side: number, tints?: ReadonlyMap<number, Rgb>, opts?: { textures?: ReadonlyMap<number, Tex> }): Uint8ClampedArray | null
  loadTextures(g: Glb): Promise<{ textures: Map<number, Tex>; tints: Map<number, Rgb> }>
  sampleTex(tex: Tex, u: number, v: number, out: Float64Array): void
  readGlbRanged(src: RangeSource, opts?: { maxBytes?: number }): Promise<Glb | null>
  bakeProxy(g: Glb, textures: ReadonlyMap<number, Tex>, tints: ReadonlyMap<number, Rgb>, opts?: { now?: () => number; budgetMs?: number; target?: number }): Uint8Array | null
  modelBrightness(diffuse: number, facing: number): number
}

const PRELOAD = path.join(here, '..', '..', 'src', 'preload', 'thumb-preload.cts')

/** A stand-in for what the page gives the preload: a decoder that understands `picture()`, canvases that keep what is drawn, a counter. */
export function fakePage(extra: Record<string, unknown> = {}) {
  const stats = { decodes: 0, puts: [] as { width: number; height: number; data: Uint8ClampedArray }[] }
  const globals = {
    Blob,
    atob,
    ImageData: class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    },
    createImageBitmap: async (blob: Blob, opts: { resizeWidth: number; resizeHeight: number }) => {
      stats.decodes++
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (bytes.length < 8) throw new Error('not a picture')
      const w = opts.resizeWidth
      const h = opts.resizeHeight
      const pixels = new Uint8ClampedArray(w * h * 4)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.set(bytes.subarray(x < w / 2 ? 0 : 4, x < w / 2 ? 4 : 8), (y * w + x) * 4)
      return { width: w, height: h, pixels, close() {} }
    },
    document: {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          px: null as Uint8ClampedArray | null,
          getContext() {
            return {
              drawImage: (bmp: { pixels: Uint8ClampedArray }) => void (canvas.px = bmp.pixels),
              getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: canvas.px ?? new Uint8ClampedArray(w * h * 4) }),
              putImageData: (img: { width: number; height: number; data: Uint8ClampedArray }) => void stats.puts.push(img),
            }
          },
          toDataURL() {
            return `data:image/png;base64,${Buffer.from([...PNG_SIG, this.width, this.height]).toString('base64')}`
          },
        }
        return canvas
      },
    },
    ...extra,
  }
  return { globals, stats }
}

/** Runs the preload source with a stand-in `electron` (the only module a sandboxed preload may require) and `globals`. */
export async function loadPreload(globals: Record<string, unknown>) {
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

