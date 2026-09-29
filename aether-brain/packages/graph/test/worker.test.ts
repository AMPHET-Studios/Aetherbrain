import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutNodeInput, MainToWorker, WorkerToMain } from '../src/layout/protocol'

/** Runs the real layout worker module in-process with a fake `self` and fake timers. */
async function startWorker() {
  const posted: WorkerToMain[] = []
  const scope = {
    postMessage: (msg: WorkerToMain) => posted.push(msg),
    onmessage: null as null | ((ev: { data: MainToWorker }) => void),
  }
  ;(globalThis as { self?: unknown }).self = scope
  vi.resetModules()
  await import('../src/layout/layout.worker')
  const send = (msg: MainToWorker) => scope.onmessage!({ data: msg })
  const positions = () => posted.filter((m): m is Extract<WorkerToMain, { type: 'positions' }> => m.type === 'positions')
  const rings = () => posted.filter((m): m is Extract<WorkerToMain, { type: 'rings' }> => m.type === 'rings')
  return { posted, send, positions, rings }
}

function node(id: string, parent: number, kind: 0 | 1 | 2 = 0, role: LayoutNodeInput['role'] = -1, radius = 1): LayoutNodeInput {
  return { id, area: 5, degree: 0, created: null, ghost: kind === 1, radius, parent, kind, role }
}

/** root folder → two planets → a few moons. */
function system(): LayoutNodeInput[] {
  return [
    node('folder:', -1, 2, 0, 8),
    node('folder:A', 0, 2, 3, 3),
    node('folder:B', 0, 2, 3, 2),
    node('A/one', 1),
    node('A/two', 1),
    node('B/three', 2),
    node('loose', 0),
  ]
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('layout worker, system mode', () => {
  it('posts ready, rings once, then eases in and settles when the transition completes', async () => {
    const w = await startWorker()
    w.send({ type: 'graph', nodes: system(), edges: [], mode: 'system' })
    expect(w.posted[0]).toEqual({ type: 'ready', generation: 1 })
    expect(w.posted[1]?.type).toBe('rings')
    const ringMsg = w.rings()[0]!
    expect(ringMsg.generation).toBe(1)
    expect(ringMsg.rings.length).toBeGreaterThan(0)
    expect(ringMsg.rings.length % 6).toBe(0)

    vi.advanceTimersByTime(600)
    expect(w.positions().length).toBeGreaterThan(5)
    expect(w.positions().every((m) => !m.settled)).toBe(true)
    vi.advanceTimersByTime(700)
    const settledFrames = w.positions().filter((m) => m.settled)
    expect(settledFrames.length).toBe(1)
    // Motion is on: orbit frames keep coming, not settled, ~30 fps.
    const before = w.positions().length
    vi.advanceTimersByTime(1000)
    const motionFrames = w.positions().slice(before)
    expect(motionFrames.length).toBeGreaterThanOrEqual(25)
    expect(motionFrames.length).toBeLessThanOrEqual(35)
    expect(motionFrames.every((m) => !m.settled && m.generation === 1)).toBe(true)
    expect(w.rings().length).toBe(1)
    // Frames move: planets orbit.
    const a = motionFrames[0]!.positions
    const b = motionFrames[motionFrames.length - 1]!.positions
    expect(a[3 * 3]).not.toBe(b[3 * 3])
    for (const m of w.positions()) for (const v of m.positions) expect(Number.isFinite(v)).toBe(true)
  })

  it('motion off: one settled frame, then silence; on again resumes without a jump', async () => {
    const w = await startWorker()
    w.send({ type: 'graph', nodes: system(), edges: [], mode: 'system' })
    vi.advanceTimersByTime(2000)
    w.send({ type: 'motion', on: false })
    vi.advanceTimersByTime(100)
    const last = w.positions().at(-1)!
    expect(last.settled).toBe(true)
    const count = w.positions().length
    vi.advanceTimersByTime(2000)
    expect(w.positions().length).toBe(count)
    w.send({ type: 'motion', on: true })
    vi.advanceTimersByTime(40)
    const resumed = w.positions().at(-1)!
    expect(resumed.settled).toBe(false)
    // The orbit clock paused, so the first frame after resuming is close to where it stopped.
    for (let i = 0; i < resumed.positions.length; i++) expect(Math.abs(resumed.positions[i]! - last.positions[i]!)).toBeLessThan(2)
  })

  it('with motion off before the graph, posts exactly one settled frame at the end of the transition', async () => {
    const w = await startWorker()
    w.send({ type: 'motion', on: false })
    w.send({ type: 'graph', nodes: system(), edges: [], mode: 'system' })
    vi.advanceTimersByTime(3000)
    const frames = w.positions()
    expect(frames.filter((m) => m.settled).length).toBe(1)
    expect(frames.at(-1)!.settled).toBe(true)
  })

  it('pin moves the dragged node and its whole subtree; release keeps it', async () => {
    const w = await startWorker()
    w.send({ type: 'motion', on: false })
    w.send({ type: 'graph', nodes: system(), edges: [], mode: 'system' })
    vi.advanceTimersByTime(2000)
    const before = w.positions().at(-1)!.positions
    const target = [before[3]! + 20, before[4]! - 10, before[5]! + 5]
    w.send({ type: 'pin', index: 1, x: target[0]!, y: target[1]!, z: target[2]! })
    const pinned = w.positions().at(-1)!.positions
    expect(pinned[3]).toBeCloseTo(target[0]!, 3)
    expect(pinned[4]).toBeCloseTo(target[1]!, 3)
    expect(pinned[5]).toBeCloseTo(target[2]!, 3)
    // Moons of folder:A (3, 4) moved by the same delta; folder:B (2) did not.
    for (const i of [3, 4]) {
      expect(pinned[i * 3]! - before[i * 3]!).toBeCloseTo(20, 3)
      expect(pinned[i * 3 + 1]! - before[i * 3 + 1]!).toBeCloseTo(-10, 3)
    }
    expect(pinned[2 * 3]).toBeCloseTo(before[2 * 3]!, 4)
    w.send({ type: 'release', index: 1, reheat: true })
    const released = w.positions().at(-1)!
    expect(released.settled).toBe(true)
    expect(released.positions[3]).toBeCloseTo(target[0]!, 3)
    // A rebuild of the same node set keeps the drag (offsets carry over by id).
    w.send({ type: 'graph', nodes: system(), edges: [], mode: 'system', prev: { ids: system().map((n) => n.id), positions: released.positions } })
    vi.advanceTimersByTime(2000)
    expect(w.positions().at(-1)!.positions[3]).toBeCloseTo(target[0]!, 2)
  })

  it('switches out of system (lazy d3) and back, with the rings following', async () => {
    const w = await startWorker()
    w.send({ type: 'graph', nodes: system(), edges: [], mode: 'system' })
    vi.advanceTimersByTime(1500)
    w.send({ type: 'mode', mode: 'constellation' })
    expect(w.rings().at(-1)!.rings.length).toBe(0)
    vi.advanceTimersByTime(20_000)
    expect(w.positions().at(-1)!.settled).toBe(true)
    const n = w.positions().length
    w.send({ type: 'mode', mode: 'system' })
    expect(w.rings().at(-1)!.rings.length).toBeGreaterThan(0)
    vi.advanceTimersByTime(1300)
    expect(w.positions().slice(n).filter((m) => m.settled).length).toBe(1)
  })

  it('several pins before the next frame do not add up while planets orbit', async () => {
    const w = await startWorker()
    w.send({ type: 'graph', nodes: system(), edges: [], mode: 'system' })
    vi.advanceTimersByTime(2000)
    const before = w.positions().at(-1)!.positions
    const p = [before[3]!, before[4]!, before[5]!]
    // Pointer moves arrive faster than the 33 ms motion frames.
    for (const k of [10, 20, 30]) w.send({ type: 'pin', index: 1, x: p[0]! + k, y: p[1]! - k / 2, z: p[2]! })
    vi.advanceTimersByTime(34)
    const after = w.positions().at(-1)!.positions
    // Under the last pointer position, give or take one frame of orbit.
    expect(Math.hypot(after[3]! - (p[0]! + 30), after[4]! - (p[1]! - 15), after[5]! - p[2]!)).toBeLessThan(1)
  })

  it('a drag during the ease-in moves the node and its moons by the drag, and nothing piles up', async () => {
    /** Motion off, graph, then the pointer held at a fixed spot for ten frames early in the transition. */
    const run = async (pin: boolean) => {
      const w = await startWorker()
      w.send({ type: 'motion', on: false })
      w.send({ type: 'graph', nodes: system(), edges: [], mode: 'system' })
      vi.advanceTimersByTime(100)
      const start = w.positions().at(-1)!.positions
      const x = [start[3]! + 15, start[4]! + 5, start[5]! - 4]
      const frames: Float32Array[] = []
      for (let f = 0; f < 10; f++) {
        if (pin) w.send({ type: 'pin', index: 1, x: x[0]!, y: x[1]!, z: x[2]! })
        vi.advanceTimersByTime(16)
        frames.push(w.positions().at(-1)!.positions)
      }
      if (pin) w.send({ type: 'release', index: 1, reheat: true })
      vi.advanceTimersByTime(2000)
      return { x, frames, end: w.positions().at(-1)!.positions }
    }
    const free = await run(false)
    const drag = await run(true)
    const x = drag.x
    const at = (p: Float32Array, i: number) => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!]
    const gap = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)
    for (let f = 0; f < 10; f++) {
      const p = drag.frames[f]!
      // The dragged planet is shown under the pointer (the ease still nudges it a little).
      expect(gap(at(p, 1), x)).toBeLessThan(1)
      // Its moons moved with it: same place relative to the planet as without the drag.
      const q = free.frames[f]!
      for (const moon of [3, 4]) {
        const rel = at(p, moon).map((v, c) => v - at(p, 1)[c]!)
        const relFree = at(q, moon).map((v, c) => v - at(q, 1)[c]!)
        expect(gap(rel, relFree)).toBeLessThan(1e-3)
      }
    }
    // After release it eases out by at most its remaining way to its layout spot (it started at the origin).
    const layoutSpot = at(free.end, 1)
    expect(gap(at(drag.end, 1), x)).toBeLessThanOrEqual(Math.hypot(...layoutSpot) + 1e-3)
  })

  it('a graph message that leaves system starts the force layout hot', async () => {
    const w = await startWorker()
    w.send({ type: 'graph', nodes: system(), edges: [], mode: 'system' })
    vi.advanceTimersByTime(1500)
    const flat = system().map((d) => ({ ...d, parent: -1 }))
    const prev = { ids: flat.map((n) => n.id), positions: w.positions().at(-1)!.positions }
    w.send({ type: 'graph', nodes: flat, edges: [], mode: 'constellation', prev })
    vi.advanceTimersByTime(20)
    expect(w.positions().find((m) => m.generation === 2)!.alpha).toBeGreaterThan(0.7)
  })

  it('an empty system layout stops posting once its transition is done', async () => {
    const w = await startWorker()
    // Before any vault is open, the layout can still be switched.
    w.send({ type: 'mode', mode: 'system' })
    vi.advanceTimersByTime(1300)
    const n = w.positions().length
    expect(n).toBeGreaterThan(0)
    vi.advanceTimersByTime(1000)
    expect(w.positions().length).toBe(n)
  })

  it('posts an empty rings message on every non-system generation', async () => {
    const w = await startWorker()
    const flat = system().map((d) => ({ ...d, parent: -1 }))
    w.send({ type: 'graph', nodes: flat, edges: [{ s: 3, t: 4, w: 1 }], mode: 'constellation' })
    w.send({ type: 'graph', nodes: flat, edges: [], mode: 'orbit' })
    const r = w.rings()
    expect(r.map((m) => [m.generation, m.rings.length])).toEqual([
      [1, 0],
      [2, 0],
    ])
    vi.advanceTimersByTime(30_000)
    expect(w.positions().at(-1)!.settled).toBe(true)
    expect(w.positions().at(-1)!.generation).toBe(2)
  })
})
