import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { FsVault, isAssetName, isPsdName } from '../src/main/fsvault.js'
import { MAX_PSD_COMPOSITE_BYTES, PSD_HEADER_BYTES, readPsdComposite } from '../src/main/assets.js'
import { THUMB_IPC, ThumbQueue, type ThumbHelper, type ThumbJob } from '../src/main/thumbnailer.js'
import { buildGraph, parseNote, previewKindOf } from '@aether/core'

/**
 * Photoshop documents (docs/COSMOLOGY.md, *Every file is a satellite*): a `.psd` is a file moon that shows the flattened picture the
 * document keeps. Main reads only the header and that picture (`readPsdComposite`); the helper's preload decodes them (`decodePsd`, pure,
 * run here on hand-built documents).
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const PRELOAD = path.join(here, '..', 'src', 'preload', 'thumb-preload.cts')

interface Pre {
  decodePsd(bytes: Uint8Array, px: number): { width: number; height: number; data: Uint8ClampedArray } | null
  PSD_MAX_PIXELS: number
}

async function loadPreload(): Promise<Pre> {
  const src = await fs.readFile(PRELOAD, 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const electron = { ipcRenderer: { send: () => undefined, on: () => undefined } }
  const require = (id: string): unknown => {
    if (id === 'electron') return electron
    throw new Error(`the sandboxed preload cannot require ${id}`)
  }
  const module = { exports: {} as Record<string, unknown> }
  new Function('require', 'module', 'exports', js)(require, module, module.exports)
  return module.exports as unknown as Pre
}

/* ------------------------------------------------------------------ */
/* Building documents                                                 */
/* ------------------------------------------------------------------ */

interface Doc {
  width: number
  height: number
  /** One array of width x height sample values (0 to 255) per channel. */
  planes: number[][]
  depth?: number
  mode?: number
  compression?: 0 | 1 | 2
  /** Bytes standing for the layers, which a real document has before its merged picture. */
  layers?: Uint8Array
}

function packBits(row: number[]): number[] {
  const out: number[] = []
  let i = 0
  while (i < row.length) {
    let run = 1
    while (i + run < row.length && row[i + run] === row[i] && run < 128) run++
    if (run >= 3) {
      out.push((257 - run) & 0xff, row[i]!)
      i += run
      continue
    }
    const start = i
    while (i < row.length && i - start < 128 && !(i + 2 < row.length && row[i] === row[i + 1] && row[i] === row[i + 2])) i++
    out.push(i - start - 1, ...row.slice(start, i))
  }
  return out
}

function psd(d: Doc): Uint8Array {
  const depth = d.depth ?? 8
  const mode = d.mode ?? 3
  const compression = d.compression ?? 0
  const bytes: number[] = []
  const u16 = (n: number) => bytes.push((n >> 8) & 0xff, n & 0xff)
  const u32 = (n: number) => bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
  bytes.push(0x38, 0x42, 0x50, 0x53)
  u16(1)
  bytes.push(0, 0, 0, 0, 0, 0)
  u16(d.planes.length)
  u32(d.height)
  u32(d.width)
  u16(depth)
  u16(mode)
  u32(0)
  u32(0)
  u32(d.layers?.length ?? 0)
  if (d.layers) bytes.push(...d.layers)
  u16(compression)
  const rows: number[][] = []
  for (const plane of d.planes) {
    for (let y = 0; y < d.height; y++) {
      const row = plane.slice(y * d.width, (y + 1) * d.width)
      rows.push(depth === 16 ? row.flatMap((v) => [v, 0]) : row)
    }
  }
  if (compression === 0) for (const r of rows) bytes.push(...r)
  else {
    const packed = rows.map(packBits)
    for (const p of packed) u16(p.length)
    for (const p of packed) bytes.push(...p)
  }
  return Uint8Array.from(bytes)
}

const flat = (n: number, v: number): number[] => new Array<number>(n).fill(v)

/* ------------------------------------------------------------------ */

describe('decoding the merged picture of a Photoshop document', () => {
  it('reads an RGB picture stored raw', async () => {
    const pre = await loadPreload()
    const out = pre.decodePsd(psd({ width: 2, height: 2, planes: [[255, 0, 0, 10], [0, 255, 0, 20], [0, 0, 255, 30]] }), 64)!
    expect([out.width, out.height]).toEqual([2, 2])
    expect(Array.from(out.data)).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255])
  })

  it('reads the same picture run-length coded, and rows that repeat', async () => {
    const pre = await loadPreload()
    const planes = [flat(12, 200), [...flat(6, 10), ...flat(6, 90)], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]
    const a = pre.decodePsd(psd({ width: 4, height: 3, planes, compression: 0 }), 64)!
    const b = pre.decodePsd(psd({ width: 4, height: 3, planes, compression: 1 }), 64)!
    expect(Array.from(b.data)).toEqual(Array.from(a.data))
    expect(a.data[0]).toBe(200)
    expect(a.data[(2 * 4 + 3) * 4 + 1]).toBe(90)
    expect(a.data[(2 * 4 + 3) * 4 + 2]).toBe(12)
  })

  it('reads greyscale, an alpha channel after the colours, and 16-bit samples by their high byte', async () => {
    const pre = await loadPreload()
    const grey = pre.decodePsd(psd({ width: 2, height: 1, planes: [[40, 200]], mode: 1 }), 64)!
    expect(Array.from(grey.data)).toEqual([40, 40, 40, 255, 200, 200, 200, 255])
    const alpha = pre.decodePsd(psd({ width: 1, height: 1, planes: [[9], [8], [7], [128]] }), 64)!
    expect(Array.from(alpha.data)).toEqual([9, 8, 7, 128])
    const deep = pre.decodePsd(psd({ width: 2, height: 1, planes: [[250, 5], [0, 0], [0, 0]], depth: 16, compression: 1 }), 64)!
    expect(Array.from(deep.data.slice(0, 8))).toEqual([250, 0, 0, 255, 5, 0, 0, 255])
  })

  it('reads CMYK as Photoshop stores it, inverted: no ink at all is white, full black ink is black', async () => {
    const pre = await loadPreload()
    const white = pre.decodePsd(psd({ width: 1, height: 1, planes: [[255], [255], [255], [255]], mode: 4 }), 64)!
    expect(Array.from(white.data)).toEqual([255, 255, 255, 255])
    const black = pre.decodePsd(psd({ width: 1, height: 1, planes: [[255], [255], [255], [0]], mode: 4 }), 64)!
    expect(Array.from(black.data)).toEqual([0, 0, 0, 255])
  })

  it('fits a big picture to the size asked, keeping its shape, and averages instead of dropping pixels', async () => {
    const pre = await loadPreload()
    const w = 40
    const h = 20
    // Left half black, right half white: a downscaled column stays black or white, never a made-up grey, away from the middle.
    const red = Array.from({ length: w * h }, (_, i) => (i % w < w / 2 ? 0 : 255))
    const out = pre.decodePsd(psd({ width: w, height: h, planes: [red, red, red], compression: 1 }), 10)!
    expect([out.width, out.height]).toEqual([10, 5])
    expect(out.data[0]).toBe(0)
    expect(out.data[(0 * 10 + 9) * 4]).toBe(255)
    // A picture smaller than the size is not made bigger.
    expect(pre.decodePsd(psd({ width: 3, height: 3, planes: [flat(9, 1), flat(9, 2), flat(9, 3)] }), 512)!.width).toBe(3)
  })

  it('refuses what it cannot read: indexed colour, zip coding, a cut-off file, a wrong signature, the big format, a huge picture', async () => {
    const pre = await loadPreload()
    const good = psd({ width: 2, height: 2, planes: [flat(4, 1), flat(4, 2), flat(4, 3)] })
    expect(pre.decodePsd(psd({ width: 2, height: 2, planes: [flat(4, 1)], mode: 2 }), 64)).toBeNull()
    expect(pre.decodePsd(psd({ width: 2, height: 2, planes: [flat(4, 1), flat(4, 2), flat(4, 3)], compression: 2 }), 64)).toBeNull()
    expect(pre.decodePsd(good.slice(0, good.length - 3), 64)).toBeNull()
    const wrong = good.slice()
    wrong[0] = 0x58
    expect(pre.decodePsd(wrong, 64)).toBeNull()
    const big = good.slice()
    big[5] = 2
    expect(pre.decodePsd(big, 64)).toBeNull()
    const huge = good.slice()
    new DataView(huge.buffer).setUint32(14, 30_000)
    new DataView(huge.buffer).setUint32(18, 30_000)
    expect(pre.decodePsd(huge, 64)).toBeNull()
    expect(pre.decodePsd(new Uint8Array(10), 64)).toBeNull()
  })

  it('does not read past what it was given when a row claims more bytes than there are', async () => {
    const pre = await loadPreload()
    const doc = psd({ width: 4, height: 2, planes: [flat(8, 5), flat(8, 5), flat(8, 5)], compression: 1 })
    // The first row's byte count is made huge.
    const lying = doc.slice()
    new DataView(lying.buffer).setUint16(PSD_HEADER_BYTES + 12 + 2, 60_000)
    expect(pre.decodePsd(lying, 64)).toBeNull()
  })
})

describe('reading only the merged picture of a document from disk', () => {
  async function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-psd-'))
    try {
      return await fn(dir)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  it('leaves the layers out and decodes to the same picture as the whole file', async () => {
    const pre = await loadPreload()
    const planes = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]
    const layered = psd({ width: 2, height: 2, planes, layers: new Uint8Array(5000).fill(7), compression: 1 })
    await inTemp(async (dir) => {
      const file = path.join(dir, 'art.psd')
      await fs.writeFile(file, layered)
      const mini = (await readPsdComposite(file))!
      expect(mini.length).toBeLessThan(layered.length - 4000)
      expect(Array.from(pre.decodePsd(mini, 64)!.data)).toEqual(Array.from(pre.decodePsd(layered, 64)!.data))
    })
  })

  it('answers null for a file that is not a document, one that is cut short, and an empty one', async () => {
    await inTemp(async (dir) => {
      const write = async (name: string, bytes: Uint8Array) => {
        const f = path.join(dir, name)
        await fs.writeFile(f, bytes)
        return f
      }
      const good = psd({ width: 2, height: 2, planes: [flat(4, 1), flat(4, 2), flat(4, 3)] })
      expect(await readPsdComposite(await write('text.psd', new TextEncoder().encode('not a photoshop document at all, just text')))).toBeNull()
      expect(await readPsdComposite(await write('short.psd', good.slice(0, 30)))).toBeNull()
      expect(await readPsdComposite(await write('empty.psd', new Uint8Array(0)))).toBeNull()
      const lying = good.slice()
      new DataView(lying.buffer).setUint32(PSD_HEADER_BYTES + 8, 0x7fffffff)
      expect(await readPsdComposite(await write('lying.psd', lying))).toBeNull()
    })
    expect(MAX_PSD_COMPOSITE_BYTES).toBeGreaterThan(64 * 1024 * 1024)
  })
})

describe('the vault door for a document', () => {
  it('names a .psd a document, not a picture, and opens it only through previewAbs', async () => {
    expect(isPsdName('Gate.PSD')).toBe(true)
    expect(isPsdName('gate.png')).toBe(false)
    expect(isAssetName('gate.psd')).toBe(false)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-psd-door-'))
    try {
      await fs.mkdir(path.join(dir, 'Art'))
      await fs.writeFile(path.join(dir, 'Art', 'gate.psd'), psd({ width: 1, height: 1, planes: [[1], [2], [3]] }))
      await fs.writeFile(path.join(dir, 'Art', 'gate.png'), new Uint8Array([1]))
      const vault = new FsVault([dir])
      expect(await vault.previewAbs('Art/gate.psd')).not.toBeNull()
      expect(await vault.assetAbs('Art/gate.psd')).toBeNull()
      expect(await vault.modelAbs('Art/gate.psd')).toBeNull()
      expect(await vault.previewAbs('Art/gate.png')).toBeNull()
      expect(await vault.previewAbs('../outside.psd')).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the helper queue for a document', () => {
  it('hands the document job to the helper as it is and gives back the PNG it answers', async () => {
    const sent: { id: number; job: ThumbJob }[] = []
    const helper: ThumbHelper = { id: 1, send: (id, job) => void sent.push({ id, job }), destroy: () => undefined }
    const q = new ThumbQueue(() => helper, { timeoutMs: 1000 })
    const bytes = new Uint8Array([1, 2, 3])
    const out = q.render({ psd: bytes, px: 128 })
    q.ready(1)
    expect(sent[0]!.job).toEqual({ psd: bytes, px: 128 })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])
    q.done(1, sent[0]!.id, png)
    expect(await out).toEqual(png)
    expect(THUMB_IPC.psd).toBe('thumbs:psd')
  })
})

describe('the helper page for a document', () => {
  it('listens on the document channel, draws the flattened picture and answers PNG bytes, or null for bytes that are no document', async () => {
    const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const puts: { width: number; height: number }[] = []
    const globals = {
      ImageData: class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
      document: {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: () => ({ putImageData: (img: { width: number; height: number }) => void puts.push(img) }),
          toDataURL(type: string) {
            return 'data:' + type + ';base64,' + Buffer.from([...PNG, this.width, this.height]).toString('base64')
          },
        }),
      },
    }
    const src = await fs.readFile(PRELOAD, 'utf8')
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const sent: unknown[][] = []
    const listeners = new Map<string, (e: unknown, ...args: unknown[]) => void>()
    const electron = {
      ipcRenderer: {
        send: (...a: unknown[]) => void sent.push(a),
        on: (c: string, fn: (e: unknown, ...a: unknown[]) => void) => void listeners.set(c, fn),
      },
    }
    const module = { exports: {} as Record<string, unknown> }
    new Function('require', 'module', 'exports', ...Object.keys(globals), js)(() => electron, module, module.exports, ...Object.values(globals))
    const run = async (...args: unknown[]) => {
      const before = sent.length
      listeners.get(THUMB_IPC.psd)!({}, ...args)
      for (let i = 0; i < 200 && sent.length === before; i++) await new Promise((r) => setTimeout(r, 5))
      return sent.at(-1)!
    }
    expect(await run(5, psd({ width: 8, height: 4, planes: [flat(32, 1), flat(32, 2), flat(32, 3)] }), 4)).toEqual([THUMB_IPC.done, 5, new Uint8Array([...PNG, 4, 2])])
    expect(puts[0]).toMatchObject({ width: 4, height: 2 })
    expect((await run(6, new Uint8Array([1, 2, 3, 4]), 4))[2]).toBeNull()
    expect((await run(7, psd({ width: 2, height: 2, planes: [flat(4, 1), flat(4, 2), flat(4, 3)] }), 0))[2]).toBeNull()
  })
})

describe('a document in the graph', () => {
  it('is a file moon with a preview, and a plain file is not', () => {
    expect(previewKindOf('Art/gate.PSD')).toBe('psd')
    expect(previewKindOf('Art/gate.pdf')).toBe('pdf')
    expect(previewKindOf('Art/gate.zip')).toBeUndefined()
    const notes = new Map([[parseNote({ path: 'Home.md', content: '# Home\n' }).meta.id, parseNote({ path: 'Home.md', content: '# Home\n' })]])
    const g = buildGraph(notes, {
      images: {
        all: new Map(),
        moons: true,
        files: new Map([
          ['Art/gate.psd', { path: 'Art/gate.psd', size: 1000, mtime: 1 }],
          ['Art/song.mp3', { path: 'Art/song.mp3', size: 1000, mtime: 1 }],
        ]),
      },
      folders: { all: new Set(['Art']), rootTitle: 'Vault', multiRoot: false, maxDepth: 4 },
    } as never)
    const psdNode = g.nodes.find((n) => n.id === 'image:Art/gate.psd')
    const mp3 = g.nodes.find((n) => n.id === 'image:Art/song.mp3')
    expect(psdNode?.image).toMatchObject({ file: 'design', preview: 'psd' })
    expect(mp3?.image?.preview).toBeUndefined()
  })
})
