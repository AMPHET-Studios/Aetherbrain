import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DataArrayTexture, InstancedBufferGeometry, ShaderMaterial } from 'three'
import { assetMap, buildGraph, parseNote, type NoteId, type ParsedNote } from '@aether/core'
import { BrainController } from '../src/BrainController'
import { ThumbLayer, thumbTargets, type ThumbTargets, type ThumbView } from '../src/scene/thumbLayer'
import {
  THUMB_MAX_IN_FLIGHT,
  THUMB_RETRY_MS,
  THUMB_REQUEST,
  THUMB_SIZE,
  thumbHalf,
  thumbPickHit,
  ThumbScheduler,
  claimSlot,
  coverRect,
  createSlotTable,
  rankThumbCandidates,
  thumbKey,
  type ThumbSource,
} from '../src/scene/thumbs'

/** Wait for every pending promise callback (loads, decodes, finishes). */
const settle = () => new Promise<void>((r) => setTimeout(r, 0))

/** Screen buffer (x, y, depth, radius px per node). */
function screenOf(rows: [number, number, number, number][]): Float32Array {
  return Float32Array.from(rows.flat())
}

/** A source whose loads finish when the test says so. */
function manualSource(): ThumbSource<string> & {
  started: string[]
  stored: [number, string][]
  resolve(path: string, value: string | null): void
  reject(path: string): void
} {
  const pending = new Map<string, { resolve: (v: string | null) => void; reject: (e: Error) => void }[]>()
  const started: string[] = []
  const stored: [number, string][] = []
  return {
    started,
    stored,
    load(path) {
      started.push(path)
      return new Promise((resolve, reject) => {
        const list = pending.get(path) ?? []
        list.push({ resolve, reject })
        pending.set(path, list)
      })
    },
    store(layer, picture) {
      stored.push([layer, picture])
    },
    resolve(path, value) {
      pending.get(path)?.shift()?.resolve(value)
    },
    reject(path) {
      pending.get(path)?.shift()?.reject(new Error('unreadable'))
    },
  }
}

const keysOf = (paths: string[]) => paths.map((p) => thumbKey({ path: p, mtime: 1, size: 10 }))

describe('thumbnail candidates', () => {
  it('ranks on-screen image moons by projected radius, biggest first, capped', () => {
    const screen = screenOf([
      [100, 100, 0.5, 8], // 0: fine
      [200, 100, 0.5, 30], // 1: biggest
      [300, 100, 1.2, 40], // 2: beyond the far plane / behind the camera
      [400, 100, 0.5, 4.9], // 3: too small
      [-500, 100, 0.5, 20], // 4: off the left edge
      [805, 605, 0.5, 8], // 5: centre just off the corner, but its picture reaches in
      [150, 150, 0.5, 8], // 6: ties with 0
      [0, 0, 0, 0], // 7: never projected
    ])
    const nodes = [0, 1, 2, 3, 4, 5, 6, 7]
    const out: number[] = []
    expect(rankThumbCandidates(screen, nodes, 800, 600, out)).toEqual([1, 0, 5, 6])
    expect(rankThumbCandidates(screen, nodes, 800, 600, out, 2)).toEqual([1, 0])
    // Positions refer to the `nodes` list, not to graph indices.
    expect(rankThumbCandidates(screen, [6, 1], 800, 600, out)).toEqual([1, 0])
    expect(rankThumbCandidates(screen, [], 800, 600, out)).toEqual([])
    expect(rankThumbCandidates(new Float32Array([1, 1, Number.NaN, 9]), [0], 10, 10, out)).toEqual([])
  })

  it('keys pictures by path and version, and cover-crops to the centred square', () => {
    expect(thumbKey({ path: 'Art/a.png', mtime: 1, size: 2 })).toBe(thumbKey({ path: 'Art/a.png', mtime: 1, size: 2 }))
    expect(thumbKey({ path: 'Art/a.png', mtime: 1, size: 2 })).not.toBe(thumbKey({ path: 'Art/a.png', mtime: 3, size: 2 }))
    expect(thumbKey({ path: 'Art/a.png', mtime: null, size: null })).not.toBe(thumbKey({ path: 'Art/b.png', mtime: null, size: null }))
    expect(coverRect(300, 200)).toEqual({ sx: 50, sy: 0, side: 200 })
    expect(coverRect(100, 400)).toEqual({ sx: 0, sy: 150, side: 100 })
    expect(coverRect(64, 64)).toEqual({ sx: 0, sy: 0, side: 64 })
    expect(coverRect(0, 10).side).toBe(0)
    expect(coverRect(Number.NaN, 10).side).toBe(0)
  })
})

describe('thumbnail slots', () => {
  it('fills free layers first, then evicts the least recently wanted', () => {
    const t = createSlotTable(3)
    expect(claimSlot(t, 'a', 1)).toBe(0)
    expect(claimSlot(t, 'b', 2)).toBe(1)
    expect(claimSlot(t, 'c', 3)).toBe(2)
    // Its own layer when it already has one.
    expect(claimSlot(t, 'b', 4)).toBe(1)
    // Full: 'a' (wanted at 1) goes.
    expect(claimSlot(t, 'd', 5)).toBe(0)
    expect(t.layerOf.has('a')).toBe(false)
    expect(t.keys).toEqual(['d', 'b', 'c'])
    // Never pushes out a picture wanted as recently as the newcomer.
    t.lastWanted.fill(9)
    expect(claimSlot(t, 'e', 9)).toBe(-1)
    expect(claimSlot(t, 'e', 8)).toBe(-1)
    expect(t.keys).toEqual(['d', 'b', 'c'])
    expect([...t.layerOf.entries()].sort()).toEqual([
      ['b', 1],
      ['c', 2],
      ['d', 0],
    ])
  })
})

describe('picking pictures', () => {
  it('hits a picture anywhere on its square as drawn, grown when hovered or selected', () => {
    // A 52 px moon shows a picture 2.4 radii wide: 62 px to each side, 81 px when selected.
    const r = 52
    expect(thumbHalf(3, -1, -1)).toBeCloseTo(1.2)
    expect(thumbHalf(3, 3, -1)).toBeCloseTo(1.56)
    expect(thumbHalf(3, -1, 3)).toBeCloseTo(1.38)
    // The corner of a selected picture (a circle of 1.2 r + 5 missed it).
    expect(thumbPickHit(78, 78, r, true, thumbHalf(3, 3, -1))).toBe(true)
    expect(thumbPickHit(78, 78, r, true, thumbHalf(3, -1, -1))).toBe(false)
    expect(thumbPickHit(90, 0, r, true, thumbHalf(3, 3, -1))).toBe(false)
    // A body is round.
    expect(thumbPickHit(40, 40, r, false, 1)).toBe(true)
    expect(thumbPickHit(45, 45, r, false, 1)).toBe(false)
    // Tiny on screen: never under 9 px.
    expect(thumbPickHit(8, 0, 1, true, thumbHalf(0, -1, -1))).toBe(true)
    expect(thumbPickHit(8, 0, 1, false, 1)).toBe(true)
  })
})

describe('ThumbScheduler', () => {
  it('keeps at most six loads in flight and starts the next as one finishes', async () => {
    const src = manualSource()
    const s = new ThumbScheduler(src, 16)
    const paths = Array.from({ length: 10 }, (_, i) => `Art/${i}.png`)
    const keys = keysOf(paths)
    s.want(keys, paths, paths.length, 100)
    expect(src.started).toEqual(paths.slice(0, THUMB_MAX_IN_FLIGHT))
    expect(s.loading).toBe(THUMB_MAX_IN_FLIGHT)
    // Asking again does not start anything twice.
    s.want(keys, paths, paths.length, 350)
    expect(src.started).toHaveLength(THUMB_MAX_IN_FLIGHT)
    src.resolve('Art/2.png', 'pic 2')
    await settle()
    expect(src.stored).toEqual([[0, 'pic 2']])
    expect(s.layerOf(keys[2]!)).toBe(0)
    expect(src.started).toEqual(paths.slice(0, THUMB_MAX_IN_FLIGHT + 1))
    expect(s.version).toBe(1)
    // A held picture is never loaded again.
    s.want(keys, paths, paths.length, 600)
    expect(src.started.filter((p) => p === 'Art/2.png')).toHaveLength(1)
  })

  it('never loads one path twice at once, even when its file changed meanwhile', async () => {
    const src = manualSource()
    const s = new ThumbScheduler(src, 4)
    const old = thumbKey({ path: 'Art/a.png', mtime: 1, size: 1 })
    const edited = thumbKey({ path: 'Art/a.png', mtime: 2, size: 1 })
    s.want([old], ['Art/a.png'], 1, 0)
    s.want([edited], ['Art/a.png'], 1, 250)
    expect(src.started).toEqual(['Art/a.png'])
    src.resolve('Art/a.png', 'old picture')
    await settle()
    // The old version finished; the edited one starts right away.
    expect(src.started).toEqual(['Art/a.png', 'Art/a.png'])
    src.resolve('Art/a.png', 'new picture')
    await settle()
    expect(s.layerOf(edited)).toBeGreaterThanOrEqual(0)
  })

  it('remembers failures per picture until retried or the file changes', async () => {
    const src = manualSource()
    const s = new ThumbScheduler(src, 4)
    const paths = ['Art/null.png', 'Art/reject.png']
    const keys = keysOf(paths)
    s.want(keys, paths, 2, 0)
    src.resolve('Art/null.png', null)
    src.reject('Art/reject.png')
    await settle()
    expect(s.hasFailed(keys[0]!)).toBe(true)
    expect(s.hasFailed(keys[1]!)).toBe(true)
    for (const now of [250, 500, 750]) s.want(keys, paths, 2, now)
    expect(src.started).toHaveLength(2)
    // A new version of the file gets its own try.
    s.want([thumbKey({ path: 'Art/null.png', mtime: 9, size: 10 })], ['Art/null.png'], 1, 1000)
    expect(src.started).toHaveLength(3)
    s.want(keys, paths, 2, 1250)
    s.retryFailed()
    expect(src.started).toHaveLength(4)

    // A failure is tried again once it is a minute old (a thumbnail that timed out while a drive woke up).
    const lateSrc = manualSource()
    const again = new ThumbScheduler(lateSrc, 4)
    again.want([keys[0]!], [paths[0]!], 1, 0)
    lateSrc.resolve('Art/null.png', null)
    await settle()
    again.want([keys[0]!], [paths[0]!], 1, THUMB_RETRY_MS - 1)
    expect(lateSrc.started).toHaveLength(1)
    expect(again.hasFailed(keys[0]!)).toBe(true)
    again.want([keys[0]!], [paths[0]!], 1, THUMB_RETRY_MS)
    expect(lateSrc.started).toHaveLength(2)
    lateSrc.resolve('Art/null.png', 'back')
    await settle()
    expect(again.layerOf(keys[0]!)).toBeGreaterThanOrEqual(0)
    expect(again.hasFailed(keys[0]!)).toBe(false)

    // A loader that throws synchronously counts as a failure too.
    const throwing = new ThumbScheduler<string>({
      load: () => {
        throw new Error('boom')
      },
      store: () => {},
    })
    throwing.want(keys, paths, 1, 0)
    await settle()
    expect(throwing.hasFailed(keys[0]!)).toBe(true)
    expect(throwing.loading).toBe(0)
  })

  it('evicts the pictures no longer wanted, least recently wanted first', async () => {
    const src = manualSource()
    const s = new ThumbScheduler(src, 2)
    const paths = ['a', 'b', 'c', 'd']
    const keys = keysOf(paths)
    s.want(keys.slice(0, 2), paths.slice(0, 2), 2, 0)
    src.resolve('a', 'A')
    src.resolve('b', 'B')
    await settle()
    // 'b' is still wanted at t = 250, 'a' is not: 'c' takes a's layer.
    s.want([keys[1]!, keys[2]!], ['b', 'c'], 2, 250)
    src.resolve('c', 'C')
    await settle()
    expect(s.layerOf(keys[0]!)).toBe(-1)
    expect(s.layerOf(keys[1]!)).toBe(1)
    expect(s.layerOf(keys[2]!)).toBe(0)
    // A load that finishes after it stopped being wanted does not push out what is shown.
    s.want([keys[3]!], ['d'], 1, 500)
    s.want([keys[1]!, keys[2]!], ['b', 'c'], 2, 750)
    src.resolve('d', 'D')
    await settle()
    expect(s.layerOf(keys[3]!)).toBe(-1)
    expect(src.stored.map(([, p]) => p)).toEqual(['A', 'B', 'C'])
  })

  it('drops loads in flight on reset and gives a layer back when storing fails', async () => {
    const src = manualSource()
    const s = new ThumbScheduler(src, 4)
    const keys = keysOf(['a'])
    s.want(keys, ['a'], 1, 0)
    const v = s.version
    s.reset()
    expect(s.version).toBe(v + 1)
    expect(s.loading).toBe(0)
    src.resolve('a', 'stale')
    await settle()
    expect(src.stored).toEqual([])
    expect(s.layerOf(keys[0]!)).toBe(-1)

    const failing = new ThumbScheduler<string>({ load: async () => 'pic', store: () => { throw new Error('no GPU') } }, 4)
    failing.want(keys, ['a'], 1, 0)
    await settle()
    expect(failing.layerOf(keys[0]!)).toBe(-1)
    expect(failing.table.keys.every((k) => k === null)).toBe(true)
    expect(failing.hasFailed(keys[0]!)).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* The GPU side, without a GPU: three objects work in node; the decode  */
/* path gets a fake createImageBitmap and OffscreenCanvas.              */
/* ------------------------------------------------------------------ */

const LAYER = THUMB_SIZE * THUMB_SIZE * 4

function stubDecoder(): { crops: number[][] } {
  const crops: number[][] = []
  vi.stubGlobal('createImageBitmap', async () => ({ width: 300, height: 200, close() {} }))
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return {
          fillStyle: '',
          fillRect() {},
          drawImage(_img: unknown, ...args: number[]) {
            crops.push(args)
          },
          getImageData: () => ({ data: new Uint8ClampedArray(LAYER).fill(7) }),
        }
      }
    },
  )
  return { crops }
}

function graphWithImages(): { targets: ThumbTargets; nodes: number } {
  const notes = new Map<NoteId, ParsedNote>()
  const n = parseNote({ path: 'Art/Board.md', content: '# Board\n\n![[a.png]] ![[b.png]]\n' })
  notes.set(n.meta.id, n)
  const all = assetMap([
    { path: 'Art/a.png', mtime: 1, size: 10 },
    { path: 'Art/b.png', mtime: 2, size: 20 },
  ])
  const g = buildGraph(notes, { images: { all } })
  return { targets: thumbTargets(g), nodes: g.nodes.length }
}

function viewOf(targets: ThumbTargets, count: number, screen: Float32Array): ThumbView {
  return { thumbs: targets, screen, radii: new Float32Array(count).fill(1.4), glow: { array: new Float32Array(count * 4).fill(0.5) } }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('thumbTargets', () => {
  it('flags videos, whose cards wear a play badge', () => {
    const notes = new Map<NoteId, ParsedNote>()
    const n = parseNote({ path: 'Art/Board.md', content: '# Board\n\n![[a.png]] ![[turntable.mp4]]\n' })
    notes.set(n.meta.id, n)
    const g = buildGraph(notes, { images: { all: assetMap([{ path: 'Art/a.png', mtime: 1 }, { path: 'Art/turntable.mp4', mtime: 2 }]) } })
    const t = thumbTargets(g)
    expect(t.paths.map((p, k) => [p, t.video[k]])).toEqual([
      ['Art/a.png', 0],
      ['Art/turntable.mp4', 1],
    ])
  })
})

describe('ThumbLayer', () => {
  it('collects the image nodes of a graph by path', () => {
    const { targets, nodes } = graphWithImages()
    expect(targets.paths).toEqual(['Art/a.png', 'Art/b.png'])
    expect(Array.from(targets.nodes)).toEqual([1, 2])
    expect(targets.keys[0]).toBe(thumbKey({ path: 'Art/a.png', mtime: 1, size: 10 }))
    expect(targets.shown).toHaveLength(nodes)
  })

  it('loads the pictures worth it, shows them, and follows the switch and the vault', async () => {
    const { crops } = stubDecoder()
    const { targets, nodes } = graphWithImages()
    // Node 1 (a.png) is big on screen, node 2 (b.png) too small to bother.
    const screen = screenOf([
      [100, 100, 0.5, 20],
      [300, 300, 0.5, 12],
      [320, 300, 0.5, 2],
    ])
    const view = viewOf(targets, nodes, screen)
    const pos = new Float32Array(nodes * 3).fill(4)
    const c = new BrainController()
    const load = vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
    c.thumbnails = load
    const layer = new ThumbLayer()

    // The first frame of a graph only maps it (the scene has not projected it yet); the next one ranks.
    expect(layer.update(view, c, pos, -1, -1, 800, 600, 0)).toBe(true)
    expect(load).not.toHaveBeenCalled()
    layer.update(view, c, pos, -1, -1, 800, 600, 1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith('Art/a.png', THUMB_REQUEST)
    await settle()
    expect(crops).toEqual([[50, 0, 200, 200, 0, 0, THUMB_SIZE, THUMB_SIZE]])
    // New pictures are uploaded in batches: not yet...
    expect(layer.update(view, c, pos, -1, -1, 800, 600, 16)).toBe(false)
    expect(targets.shown[1]).toBe(0)
    // ...then together with the node mapping.
    expect(layer.update(view, c, pos, 1, -1, 800, 600, 200)).toBe(true)
    expect(Array.from(targets.shown)).toEqual([0, 1, 0])
    expect(layer.mesh.visible).toBe(true)
    const tex = (layer.mesh.material as ShaderMaterial).uniforms['uMap']!.value as DataArrayTexture
    expect(tex.version).toBeGreaterThan(0)
    expect([...tex.layerUpdates]).toEqual([0])
    expect((tex.image.data as Uint8Array)[0]).toBe(7)
    const geo = layer.mesh.geometry as InstancedBufferGeometry
    expect(geo.instanceCount).toBe(1)
    // Instance: at the node, 2.4 × radius × 1.3 (selected), alpha = the node's dim state.
    expect(Array.from(geo.getAttribute('iCenter').array.slice(0, 3))).toEqual([4, 4, 4])
    expect(geo.getAttribute('iSize').array[0]).toBeCloseTo(1.4 * 2.4 * 1.3, 5)
    expect(geo.getAttribute('iAlpha').array[0]).toBeCloseTo(0.5, 5)
    expect(layer.update(view, c, pos, 1, -1, 800, 600, 216)).toBe(false)

    // Switched off: plain moons again; back on: no reload.
    c.showThumbnails = false
    expect(layer.update(view, c, pos, -1, -1, 800, 600, 300)).toBe(true)
    expect(Array.from(targets.shown)).toEqual([0, 0, 0])
    expect(layer.mesh.visible).toBe(false)
    expect(layer.update(view, c, pos, -1, -1, 800, 600, 320)).toBe(false)
    c.showThumbnails = true
    expect(layer.update(view, c, pos, -1, -1, 800, 600, 340)).toBe(true)
    expect(targets.shown[1]).toBe(1)
    expect(load).toHaveBeenCalledTimes(1)

    // A rebuilt graph maps the picture onto the new node at once, by path.
    const moved: ThumbTargets = {
      nodes: Int32Array.from([1, 2]),
      keys: [targets.keys[1]!, targets.keys[0]!],
      paths: [targets.paths[1]!, targets.paths[0]!],
      video: new Uint8Array(2),
      wide: new Uint8Array(2),
      shown: new Uint8Array(nodes),
    }
    const movedScreen = screenOf([
      [100, 100, 0.5, 20],
      [320, 300, 0.5, 2],
      [300, 300, 0.5, 12],
    ])
    const movedView = { ...view, thumbs: moved, screen: movedScreen }
    expect(layer.update(movedView, c, pos, -1, -1, 800, 600, 360)).toBe(true)
    expect(Array.from(moved.shown)).toEqual([0, 0, 1])
    layer.update(movedView, c, pos, -1, -1, 800, 600, 400)
    expect(load).toHaveBeenCalledTimes(1)

    // Another vault: nothing of the old one shows, and its pictures load afresh.
    const other = vi.fn(async () => null)
    c.thumbnails = other
    expect(layer.update(movedView, c, pos, -1, -1, 800, 600, 700)).toBe(true)
    expect(Array.from(moved.shown)).toEqual([0, 0, 0])
    expect(layer.mesh.visible).toBe(false)
    expect(other).toHaveBeenCalledTimes(1)
    await settle()
    // Its failure is remembered: no retry on the next ticks.
    layer.update(movedView, c, pos, -1, -1, 800, 600, 1000)
    layer.update(movedView, c, pos, -1, -1, 800, 600, 1300)
    expect(other).toHaveBeenCalledTimes(1)

    // No loader: no billboards, no loads.
    c.thumbnails = null
    layer.update(movedView, c, pos, -1, -1, 800, 600, 1600)
    expect(layer.mesh.visible).toBe(false)
    expect(other).toHaveBeenCalledTimes(1)
    layer.dispose()
    c.dispose()
  })
})
