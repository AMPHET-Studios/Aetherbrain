import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { kindOf, makePictureHost, type PictureSource } from '../src/main/ai-pictures.js'
import { lf } from './lf'

/**
 * What the app lends the AI link so an AI can see the vault's pictures: a list by words in the path, and a look at one. The
 * files here are real (a size comes from the file's own first bytes); the thumbnail helper is a stand-in, since only the app has it.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const be16 = (n: number): number[] => [(n >>> 8) & 255, n & 255]
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

/** A PNG's first bytes with its pixel size, then `pad` more bytes so files differ in size. */
function png(width: number, height: number, pad = 0): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii('IHDR'), ...be32(width), ...be32(height), 8, 6, 0, 0, 0, ...new Array<number>(4 + pad).fill(0)])
}

/** A JPEG of `width` × `height` as stored whose EXIF says it is turned by `orientation` (5 to 8 are turned a quarter). */
function jpeg(width: number, height: number, orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, ...be16(42), ...be32(8), ...be16(1), ...be16(0x0112), ...be16(3), ...be32(1), ...be16(orientation), 0, 0, ...be32(0)]
  const exif = [...ascii('Exif'), 0, 0, ...tiff]
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, ...be16(exif.length + 2), ...exif,
    0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0,
  ])
}

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-aipic-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function put(rel: string, bytes: Uint8Array | string): Promise<string> {
  const full = path.join(dir, ...rel.split('/'))
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, bytes)
  return full
}

const LIST = [
  'Art/Gate/concept-02.jpg',
  'Art/Gate/Concept-01.png',
  'Art/ring.webp',
  'Artwork/other.png',
  'Refs/clip.mp4',
  'Refs/robot.glb',
  'Inbox/Pictures/shot.png',
]

/** A source over `paths` whose stat answers `sizes` (the rest has none), and which remembers what it was asked. */
function source(paths: string[] = LIST, over: Partial<PictureSource> = {}, sizes: Record<string, { size: number; mtime: number }> = {}) {
  const asked: string[][] = []
  const src: PictureSource = {
    paths: () => paths,
    stat: async (wanted) => {
      asked.push([...wanted])
      return wanted.map((p) => ({ path: p, ...(sizes[p] ?? {}) }))
    },
    open: async (p) => ({ abs: path.join(dir, ...p.split('/')), path: p }),
    thumbnail: async () => Uint8Array.from([1, 2, 3]),
    ...over,
  }
  return { src, asked }
}

describe('what kind of thing a path is', () => {
  it('tells pictures, videos and 3D models by their file names', () => {
    expect(kindOf('Art/gate.png')).toBe('picture')
    expect(kindOf('Art/GATE.JPG')).toBe('picture')
    expect(kindOf('Refs/clip.mp4')).toBe('video')
    expect(kindOf('Refs/clip.MOV')).toBe('video')
    expect(kindOf('Refs/robot.glb')).toBe('model')
    expect(kindOf('no-folder.webp')).toBe('picture')
  })
})

describe('find', () => {
  it('lists every picture alphabetically by path, capital letters not first', async () => {
    const host = makePictureHost(source().src)
    const r = await host.find('', { limit: 50 })
    expect(r.pictures.map((p) => p.path)).toEqual([
      'Art/Gate/Concept-01.png',
      'Art/Gate/concept-02.jpg',
      'Art/ring.webp',
      'Artwork/other.png',
      'Inbox/Pictures/shot.png',
      'Refs/clip.mp4',
      'Refs/robot.glb',
    ])
    expect(r.more).toBe(false)
    expect(r.pictures.map((p) => p.kind)).toEqual(['picture', 'picture', 'picture', 'picture', 'picture', 'video', 'model'])
  })

  it('needs every word in the path, in any case and any order, folders included', async () => {
    const host = makePictureHost(source().src)
    const paths = async (q: string) => (await host.find(q, { limit: 50 })).pictures.map((p) => p.path)
    expect(await paths('gate concept')).toEqual(['Art/Gate/Concept-01.png', 'Art/Gate/concept-02.jpg'])
    expect(await paths('CONCEPT 02')).toEqual(['Art/Gate/concept-02.jpg'])
    expect(await paths('01 gate')).toEqual(['Art/Gate/Concept-01.png'])
    expect(await paths('  gate   ')).toEqual(['Art/Gate/Concept-01.png', 'Art/Gate/concept-02.jpg'])
    expect(await paths('gate dragon')).toEqual([])
    expect(await paths('.glb')).toEqual(['Refs/robot.glb'])
  })

  it('stays inside a folder, and a folder named like the start of another is not it', async () => {
    const host = makePictureHost(source().src)
    const inside = async (folder: string, q = '') => (await host.find(q, { folder, limit: 50 })).pictures.map((p) => p.path)
    expect(await inside('Art')).toEqual(['Art/Gate/Concept-01.png', 'Art/Gate/concept-02.jpg', 'Art/ring.webp'])
    expect(await inside('Art/Gate')).toEqual(['Art/Gate/Concept-01.png', 'Art/Gate/concept-02.jpg'])
    expect(await inside('Art/', 'ring')).toEqual(['Art/ring.webp'])
    expect(await inside('Artwork')).toEqual(['Artwork/other.png'])
    expect(await inside('Art/Gate', 'ring')).toEqual([])
  })

  it('stops at the limit, says more exist, and asks the disk about the pictures it lists only', async () => {
    const { src, asked } = source(LIST, {}, { 'Art/Gate/Concept-01.png': { size: 2048, mtime: 1700000000000 } })
    const r = await makePictureHost(src).find('', { limit: 2 })
    expect(r.pictures).toEqual([
      { path: 'Art/Gate/Concept-01.png', kind: 'picture', bytes: 2048, modified: 1700000000000 },
      // A stat that did not get to it (a slow share) lists it without a size or a date.
      { path: 'Art/Gate/concept-02.jpg', kind: 'picture', bytes: null, modified: null },
    ])
    expect(r.more).toBe(true)
    expect(asked).toEqual([['Art/Gate/Concept-01.png', 'Art/Gate/concept-02.jpg']])
    // Exactly the limit is not "more".
    expect((await makePictureHost(source().src).find('gate', { limit: 2 })).more).toBe(false)
  })

  it('lists nothing before a vault is open, and nothing for a limit of nothing', async () => {
    const none = makePictureHost(source([], { paths: () => null }).src)
    expect(await none.find('', { limit: 10 })).toEqual({ pictures: [], more: false })
    expect(await makePictureHost(source().src).find('', { limit: 0 })).toEqual({ pictures: [], more: true })
  })
})

describe('look', () => {
  it('returns the still, the file it came from and the size the file claims', async () => {
    await put('Art/gate.png', png(640, 480, 100))
    const thumbs: [string, number][] = []
    const { src } = source([], {
      thumbnail: async (p, px) => {
        thumbs.push([p, px])
        return Uint8Array.from([9, 9])
      },
    })
    const seen = await makePictureHost(src).look('Art/gate.png', 768)
    expect(seen).toEqual({ png: Uint8Array.from([9, 9]), path: 'Art/gate.png', kind: 'picture', bytes: 133, width: 640, height: 480 })
    expect(thumbs).toEqual([['Art/gate.png', 768]])
  })

  it('reports the canonical vault path the app resolved, not the spelling it was asked with', async () => {
    await put('Art/Gate.png', png(8, 8))
    const { src } = source([], { open: async () => ({ abs: path.join(dir, 'Art', 'Gate.png'), path: 'Art/Gate.png' }) })
    expect((await makePictureHost(src).look('art/gate.png', 256))?.path).toBe('Art/Gate.png')
  })

  it('gives the size as the picture is shown: a photo taken sideways is tall', async () => {
    await put('Refs/phone.jpg', jpeg(400, 300, 6))
    await put('Refs/flat.jpg', jpeg(400, 300, 1))
    const host = makePictureHost(source([]).src)
    const turned = await host.look('Refs/phone.jpg', 512)
    expect([turned?.width, turned?.height]).toEqual([300, 400])
    const flat = await host.look('Refs/flat.jpg', 512)
    expect([flat?.width, flat?.height]).toEqual([400, 300])
  })

  it('a video or a model has a still and a size on disk but no pixel size of its own', async () => {
    await put('Refs/clip.mp4', 'not really a video, the helper is a stand-in')
    await put('Refs/robot.glb', 'not really a model either')
    const host = makePictureHost(source([]).src)
    const video = await host.look('Refs/clip.mp4', 512)
    expect(video).toMatchObject({ kind: 'video', width: null, height: null, bytes: 'not really a video, the helper is a stand-in'.length })
    const model = await host.look('Refs/robot.glb', 512)
    expect(model).toMatchObject({ kind: 'model', width: null, height: null })
  })

  it('a picture whose header cannot be read still comes back, without a size', async () => {
    await put('Art/odd.png', 'this is not a png header at all')
    const seen = await makePictureHost(source([]).src).look('Art/odd.png', 512)
    expect(seen).toMatchObject({ kind: 'picture', width: null, height: null })
  })

  it('is null for anything the app will not show or the helper cannot draw', async () => {
    await put('Art/gate.png', png(8, 8))
    expect(await makePictureHost(source([], { open: async () => null }).src).look('Notes/idea.md', 512)).toBeNull()
    expect(await makePictureHost(source([], { thumbnail: async () => null }).src).look('Art/gate.png', 512)).toBeNull()
    // The file vanished between the app finding it and the look.
    expect(await makePictureHost(source([]).src).look('Art/gone.png', 512)).toBeNull()
  })

  it('finds the size of a large file from its start, and reports the whole file’s size in bytes', async () => {
    const big = new Uint8Array(3 * 1024 * 1024)
    big.set(jpeg(1000, 500, 1))
    await put('Refs/big.jpg', big)
    const seen = await makePictureHost(source([]).src).look('Refs/big.jpg', 512)
    expect([seen?.width, seen?.height]).toEqual([1000, 500])
    expect(seen?.bytes).toBe(big.length)
  })
})

describe('main.ts wiring', () => {
  let src = ''
  let link = ''
  beforeEach(async () => {
    src = lf(await fs.readFile(path.join(here, '..', 'src', 'main', 'main.ts'), 'utf8'))
    const start = src.indexOf('function createAiLink()')
    link = src.slice(start, src.indexOf('\n}\n', start))
  })

  it('lends the link the app’s pictures: the ledger’s list, the thumbnail with its time limit, the doors that judge a picture', () => {
    expect(link).toContain('pictures: makePictureHost({')
    expect(link).toContain('assetLedger.list(scan.assets).map((a) => a.path)')
    expect(link).toContain('v.statAssets(paths.map((p) => ({ path: p, abs: v.abs(p) })))')
    expect(link).toContain('(await v.assetAbs(p)) ?? (await v.modelAbs(p))')
    expect(link).toContain('thumbnail: (p, px) => within(thumbnail(p, px), THUMB_TIMEOUT, null)')
  })

  it('lends the link the window: one message to the brain window, and an answer when there is none', () => {
    expect(link).toContain('toRenderer(IPC.aiShow, target)')
    expect(link).toContain("if (!win || win.isDestroyed()) throw new Error('The Aether Brain window is not open.")
  })

  it('feeds the ledger of every picture, video and model wherever the board’s ledger is fed', () => {
    const board = src.match(/pictureLedger\.(clear|apply|add)\(/g) ?? []
    const assets = src.match(/assetLedger\.(clear|apply|add)\(/g) ?? []
    expect(board.length).toBeGreaterThanOrEqual(4)
    expect(assets.map((m) => m.replace('assetLedger', 'pictureLedger'))).toEqual(board)
    expect(src).toContain('const assetLedger = new PictureLedger(isAssetName)')
  })
})
