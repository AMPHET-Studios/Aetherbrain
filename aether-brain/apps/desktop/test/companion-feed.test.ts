import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphData } from '@aether/core'
import { COMPANION_BUDGET, boundRings } from '../src/renderer/companion-bound'
import { COMPANION_RETRY_MS, CompanionFeed, type FeedEngine, type FeedSource } from '../src/renderer/companion-feed'
import type { CompanionGraphDto } from '../src/shared/ipc'
import { vaultOf } from './fixtures/vault-shapes'

const SHAPE = { areas: 3, subs: 3, topics: 3, notes: 5, ghostEvery: 7, projects: 2 }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(25)
  }
}

type Engine = import('../../../packages/graph/src/layout/LayoutEngine').LayoutEngine

/** The REAL LayoutEngine driving the REAL layout.worker.ts through a fake Worker (messages cloned, delivered on the event loop). */
async function realEngine(): Promise<Engine> {
  vi.resetModules()
  const workerCtx: { onmessage: ((ev: { data: unknown }) => void) | null; postMessage: (msg: unknown) => void } = { onmessage: null, postMessage: () => {} }
  ;(globalThis as { self?: unknown }).self = workerCtx
  let main: { onmessage: ((ev: { data: unknown }) => void) | null } | null = null
  class FakeWorker {
    onmessage: ((ev: { data: unknown }) => void) | null = null
    constructor() {
      main = this
    }
    postMessage(msg: unknown): void {
      const m = structuredClone(msg)
      setTimeout(() => workerCtx.onmessage?.({ data: m }), 0)
    }
    terminate(): void {}
  }
  vi.stubGlobal('Worker', FakeWorker)
  workerCtx.postMessage = (msg) => {
    const m = structuredClone(msg)
    setTimeout(() => main?.onmessage?.({ data: m }), 0)
  }
  const { LayoutEngine } = await import('../../../packages/graph/src/layout/LayoutEngine')
  await import('../../../packages/graph/src/layout/layout.worker')
  return new LayoutEngine()
}

interface Post {
  version: number
  count: number
  rings: number
  alpha: number
  answered: boolean
}

/** The bridge to main, recording what is published and what the layout was doing at that moment. */
class Sink {
  scenes: CompanionGraphDto[] = []
  posts: Post[] = []
  failNext = 0
  constructor(private readonly eng: () => FeedEngine) {}
  companionGraph(scene: CompanionGraphDto): void {
    if (this.failNext > 0) {
      this.failNext--
      throw new Error('out of memory')
    }
    this.scenes.push(scene)
  }
  companionPositions(version: number, positions: Float32Array, rings: Float32Array): void {
    const e = this.eng()
    this.posts.push({ version, count: positions.length / 3, rings: rings.length / 6, alpha: e.alpha, answered: e.answered })
  }
}

function sourceOf(get: () => { graph: GraphData | null; engine: FeedEngine; layout?: 'system' | 'constellation' }): () => FeedSource | null {
  return () => {
    const s = get()
    if (!s.graph) return null
    return {
      graph: s.graph,
      engine: s.engine,
      vault: 'Vault',
      adapter: null,
      selectedId: null,
      colorMode: 'area',
      activeTag: null,
      layoutMode: s.layout ?? 'system',
      pictureSize: 'medium',
    }
  }
}

describe('what the companion feed publishes, against the real layout engine and worker', () => {
  let timer: ReturnType<typeof setInterval> | null = null
  let engine: Engine | null = null
  beforeEach(() => {
    timer = null
    engine = null
  })
  afterEach(() => {
    if (timer) clearInterval(timer)
    engine?.dispose()
    vi.unstubAllGlobals()
    delete (globalThis as { self?: unknown }).self
  })

  /** A feed ticking 10 times a second over `engine`, with `graph` the graph it is shown. */
  async function rig(): Promise<{ eng: Engine; sink: Sink; feed: CompanionFeed; show: (g: GraphData | null, layout?: 'system' | 'constellation') => void; truth: () => number }> {
    const eng = await realEngine()
    engine = eng
    let graph: GraphData | null = null
    let layout: 'system' | 'constellation' = 'system'
    const sink = new Sink(() => eng)
    const feed = new CompanionFeed(sourceOf(() => ({ graph, engine: eng, layout })), sink)
    timer = setInterval(() => feed.tick(), 100)
    return {
      eng,
      sink,
      feed,
      show: (g, l) => {
        graph = g
        if (l) layout = l
      },
      // The rings a viewer should have: those of the final, settled places.
      truth: () => (feed.plan && graph ? boundRings(graph, feed.plan, eng.rings, eng.positions, COMPANION_BUDGET.rings).length / 6 : -1),
    }
  }

  it('holds a new vault back until it has grown out of its root, then sends every orbit ring with it', async () => {
    const { eng, sink, feed, show, truth } = await rig()
    await sleep(250) // the viewer is waiting before there is a vault
    const g = vaultOf(SHAPE).graph
    show(g)
    eng.setGraph(g, 'system')
    await until(() => sink.posts.length > 0)
    // Nothing went out while the bodies were still on their way out of the root (that frame would frame the camera on a clump).
    expect(sink.posts.every((p) => p.alpha === 0 && p.answered)).toBe(true)
    await until(() => eng.alpha === 0 && sink.posts.length > 2)
    const rings = truth()
    expect(rings).toBeGreaterThan(10)
    // The first frame it sent already had every ring; none was lost for good.
    expect(sink.posts[0]!.rings).toBe(rings)
    expect(sink.posts.at(-1)!.rings).toBe(rings)
    expect(sink.scenes).toHaveLength(1)
    expect(sink.posts.every((p) => p.version === feed.version)).toBe(true)
  })

  it('sends the places of an edited vault at once, and all its rings once they have settled', async () => {
    const { eng, sink, show, truth } = await rig()
    const g1 = vaultOf(SHAPE).graph
    show(g1)
    eng.setGraph(g1, 'system')
    await until(() => eng.alpha === 0 && sink.posts.length > 1)
    sink.posts.length = 0
    // A note is added: a new node set, nearly all of it as it was.
    const g2 = vaultOf(SHAPE, { extra: (add) => add('Area0/Sub0/Topic0/Extra.md', '# Extra\n[[Note 3]]\n') }).graph
    show(g2)
    eng.setGraph(g2, 'system')
    expect(eng.carried).toBeGreaterThan(0.9)
    await until(() => sink.scenes.length === 2 && sink.posts.length > 0)
    // It does not wait for the new note to grow out of its folder …
    await until(() => sink.posts.some((p) => p.alpha > 0) || eng.alpha === 0)
    // … and when it has, no ring is missing.
    await until(() => eng.alpha === 0 && sink.posts.length > 3)
    await until(() => sink.posts.at(-1)!.rings === truth())
    expect(truth()).toBeGreaterThan(10)
  })

  it('does not hand the viewer a second copy of a scene that did not change (a note edited, a file seen twice)', async () => {
    const { eng, sink, feed, show, truth } = await rig()
    const g1 = vaultOf(SHAPE).graph
    show(g1)
    eng.setGraph(g1, 'system')
    await until(() => eng.alpha === 0 && sink.posts.length > 1)
    const version = feed.version
    // The same vault read again: a new graph object, the very same nodes, colours and links.
    const g2 = vaultOf(SHAPE).graph
    show(g2)
    eng.setGraph(g2, 'system')
    await until(() => eng.alpha === 0)
    const seen = sink.posts.length
    await until(() => sink.posts.length > seen + 1)
    expect(sink.scenes).toHaveLength(1)
    expect(feed.version).toBe(version)
    await until(() => sink.posts.at(-1)!.rings === truth())
    expect(sink.posts.at(-1)!.version).toBe(version)
  })

  it('finds every ring again after the layout is switched while a viewer reads', async () => {
    const { eng, sink, show, truth } = await rig()
    const g1 = vaultOf(SHAPE).graph
    show(g1, 'constellation')
    eng.setGraph(g1, 'constellation')
    await until(() => sink.posts.length > 1)
    expect(sink.posts.at(-1)!.rings).toBe(0)
    const g2 = vaultOf(SHAPE).graph
    show(g2, 'system')
    eng.setGraph(g2, 'system')
    await until(() => eng.mode === 'system' && eng.alpha === 0 && eng.rings.length > 0)
    await until(() => sink.posts.at(-1)!.rings === truth() && truth() > 10)
  })
})

describe('what the companion feed does when things go wrong', () => {
  /** A layout engine that is just numbers. */
  function stub(g: GraphData, over: Partial<FeedEngine> = {}): FeedEngine {
    const positions = new Float32Array(g.nodes.length * 3)
    for (let i = 0; i < positions.length; i++) positions[i] = (i * 37) % 101
    return { placed: true, answered: true, carried: 0, mode: 'constellation', alpha: 0, frame: 1, positions, rings: new Float32Array(0), ringsVersion: 1, ...over }
  }
  const small = () => vaultOf({ areas: 2, subs: 2, topics: 2, notes: 3, projects: 1 }).graph

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('numbers its scenes from the clock, so a reloaded window never repeats a number a viewer already holds', () => {
    const t0 = Math.floor(Date.parse('2026-10-01T10:00:00Z') / 1000)
    let g = small()
    const eng = stub(g)
    const sinkA = new Sink(() => eng)
    const a = new CompanionFeed(sourceOf(() => ({ graph: g, engine: eng })), sinkA)
    a.tick()
    expect(sinkA.scenes[0]!.version).toBe(t0 + 1)
    // A scene per change in the first window …
    for (let i = 0; i < 3; i++) {
      g = vaultOf({ areas: 2, subs: 2, topics: 2, notes: 4 + i, projects: 1 }).graph
      eng.positions = new Float32Array(g.nodes.length * 3).fill(i + 1)
      eng.frame++
      a.tick()
    }
    expect(sinkA.scenes.map((x) => x.version)).toEqual([t0 + 1, t0 + 2, t0 + 3, t0 + 4])
    // … and the window reloads a few seconds later: its module starts again, and its first number is a new one.
    vi.setSystemTime(new Date('2026-10-01T10:00:08Z'))
    const sinkB = new Sink(() => eng)
    const b = new CompanionFeed(sourceOf(() => ({ graph: g, engine: eng })), sinkB)
    b.tick()
    expect(sinkB.scenes[0]!.version).toBe(t0 + 8 + 1)
    expect(sinkB.scenes[0]!.version).toBeGreaterThan(sinkA.scenes.at(-1)!.version)
  })

  it('tries again later, not at every tick, when a scene could not be made or sent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = small()
    const eng = stub(g)
    const sink = new Sink(() => eng)
    sink.failNext = 1
    const feed = new CompanionFeed(sourceOf(() => ({ graph: g, engine: eng })), sink)
    feed.tick()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(sink.scenes).toHaveLength(0)
    // No positions go out for a scene the viewer never got.
    expect(sink.posts).toHaveLength(0)
    const before = feed.version
    vi.setSystemTime(Date.now() + COMPANION_RETRY_MS / 2)
    feed.tick()
    expect(sink.scenes).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + COMPANION_RETRY_MS)
    feed.tick()
    expect(sink.scenes).toHaveLength(1)
    expect(feed.version).toBe(before + 1)
    expect(sink.posts).toHaveLength(1)
    expect(sink.posts[0]!.version).toBe(feed.version)
    warn.mockRestore()
  })

  it('sends no places while the layout has none, or while they are for another node set', () => {
    const g = small()
    const eng = stub(g, { placed: false })
    const sink = new Sink(() => eng)
    const feed = new CompanionFeed(sourceOf(() => ({ graph: g, engine: eng })), sink)
    feed.tick()
    expect(sink.scenes).toHaveLength(1)
    expect(sink.posts).toHaveLength(0)
    eng.placed = true
    eng.positions = new Float32Array(g.nodes.length * 3 - 3)
    eng.frame++
    feed.tick()
    expect(sink.posts).toHaveLength(0)
    eng.positions = new Float32Array(g.nodes.length * 3)
    eng.frame++
    feed.tick()
    expect(sink.posts).toHaveLength(1)
  })

  it('holds a layout that is still growing out of its root, but not an edit of the one it has', () => {
    const g = vaultOf(SHAPE).graph
    const eng = stub(g, { mode: 'system', alpha: 0.8, carried: 0 })
    const sink = new Sink(() => eng)
    const feed = new CompanionFeed(sourceOf(() => ({ graph: g, engine: eng })), sink)
    feed.tick()
    expect(sink.scenes).toHaveLength(1)
    expect(sink.posts).toHaveLength(0)
    // The same ease, but of a node set most of which was there: it is shown while it moves.
    eng.carried = 0.97
    eng.frame++
    feed.tick()
    expect(sink.posts).toHaveLength(1)
    // And a new vault is shown once the ease is over.
    const fresh = stub(g, { mode: 'system', alpha: 0.4, carried: 0.1 })
    const sink2 = new Sink(() => fresh)
    const feed2 = new CompanionFeed(sourceOf(() => ({ graph: g, engine: fresh })), sink2)
    feed2.tick()
    expect(sink2.posts).toHaveLength(0)
    fresh.alpha = 0
    fresh.frame++
    feed2.tick()
    expect(sink2.posts).toHaveLength(1)
  })

  it('sends the same places again when asked, under the same scene', () => {
    const g = small()
    const eng = stub(g)
    const sink = new Sink(() => eng)
    const feed = new CompanionFeed(sourceOf(() => ({ graph: g, engine: eng })), sink)
    feed.tick()
    feed.tick()
    expect(sink.posts).toHaveLength(1)
    feed.resend()
    feed.tick()
    expect(sink.posts).toHaveLength(2)
    expect(sink.scenes).toHaveLength(1)
    expect(sink.posts[1]!.version).toBe(sink.posts[0]!.version)
    // A viewer that comes back gets the scene again.
    feed.restart()
    feed.tick()
    expect(sink.scenes).toHaveLength(2)
    expect(sink.scenes[1]!.version).toBe(sink.scenes[0]!.version + 1)
  })
})
