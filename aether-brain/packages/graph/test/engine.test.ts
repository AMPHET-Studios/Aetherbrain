import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildGraph, parseNote, type GraphData, type NoteId, type ParsedNote } from '@aether/core'
import type { MainToWorker, WorkerToMain } from '../src/layout/protocol'

/** Stands in for the layout worker: records what the engine sends, replies on demand. */
class FakeWorker {
  static last: FakeWorker | null = null
  sent: MainToWorker[] = []
  onmessage: ((ev: { data: WorkerToMain }) => void) | null = null
  constructor() {
    FakeWorker.last = this
  }
  postMessage(msg: MainToWorker): void {
    this.sent.push(msg)
  }
  onerror: ((ev: { message: string; filename: string; lineno: number; preventDefault: () => void }) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminate(): void {}
  reply(msg: WorkerToMain): void {
    this.onmessage?.({ data: msg })
  }
  fail(message: string, filename = '', lineno = 0): void {
    this.onerror?.({ message, filename, lineno, preventDefault: () => {} })
  }
}

function graphOf(paths: string[]): GraphData {
  const notes = new Map<NoteId, ParsedNote>()
  for (const path of paths) {
    const note = parseNote({ path, content: `# ${path}\n` })
    notes.set(note.meta.id, note)
  }
  return buildGraph(notes)
}

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LayoutEngine', () => {
  it('says when the worker fails (it used to fail silently: no positions ever came, one clump, no orbits), once per message, and clears it on an answer', async () => {
    const { LayoutEngine } = await import('../src/layout/LayoutEngine')
    const engine = new LayoutEngine()
    const worker = FakeWorker.last!
    const told: string[] = []
    const off = engine.onError((m) => told.push(m))
    engine.setGraph(graphOf(['a.md', 'b.md']), 'system')
    expect(engine.error).toBeNull()
    worker.fail('RangeError: Invalid typed array length: 4294967296', 'http://x/assets/layout.worker-abc.js', 42)
    worker.fail('RangeError: Invalid typed array length: 4294967296', 'http://x/assets/layout.worker-abc.js', 42)
    expect(told).toEqual(['RangeError: Invalid typed array length: 4294967296 (layout.worker-abc.js:42)'])
    expect(engine.error).toBe(told[0])
    worker.onmessageerror?.()
    expect(told).toHaveLength(2)
    expect(told[1]).toBe('a layout answer could not be read')
    // An answer for the current graph clears it, so the next failure is told again.
    worker.reply({ type: 'positions', positions: new Float32Array(6).fill(1), alpha: 0, settled: true, generation: 1 })
    expect(engine.error).toBeNull()
    worker.fail('again')
    expect(told).toHaveLength(3)
    off()
    worker.fail('after off')
    expect(told).toHaveLength(3)
  })

  it('drops frames and rings of a superseded layout, even before the new one is ready', async () => {
    const { LayoutEngine } = await import('../src/layout/LayoutEngine')
    const engine = new LayoutEngine()
    const worker = FakeWorker.last!
    const a = graphOf(['a.md', 'b.md', 'c.md'])
    engine.setGraph(a, 'system')
    // Same size, other nodes: a length check alone cannot tell the two apart.
    const b = graphOf(['x.md', 'y.md', 'z.md'])
    engine.setGraph(b, 'system')
    expect(worker.sent.filter((m) => m.type === 'graph').length).toBe(2)
    const seeded = engine.positions
    const rings = engine.rings

    // The worker's replies for the first graph arrive only now.
    worker.reply({ type: 'ready', generation: 1 })
    worker.reply({ type: 'rings', rings: new Float32Array([0, 10, 0, 0, 0, 1]), cards: new Float32Array(3), extent: new Float32Array(3), generation: 1 })
    worker.reply({ type: 'positions', positions: new Float32Array(9).fill(5), alpha: 0, settled: true, generation: 1 })
    expect(engine.positions).toBe(seeded)
    expect(engine.rings).toBe(rings)
    expect(engine.settled).toBe(false)

    // The second graph's replies are taken.
    worker.reply({ type: 'ready', generation: 2 })
    const r2 = new Float32Array([1, 12, 0, 0, 0, 1])
    worker.reply({ type: 'rings', rings: r2, cards: new Float32Array(3), extent: new Float32Array(3), generation: 2 })
    const p2 = new Float32Array(9).fill(7)
    worker.reply({ type: 'positions', positions: p2, alpha: 0, settled: true, generation: 2 })
    expect(engine.rings).toBe(r2)
    expect(engine.positions).toBe(p2)
    expect(engine.settled).toBe(true)
    engine.dispose()
  })

  it('keeps taking frames across a plain mode switch (same node set, same generation)', async () => {
    const { LayoutEngine } = await import('../src/layout/LayoutEngine')
    const engine = new LayoutEngine()
    const worker = FakeWorker.last!
    engine.setGraph(graphOf(['a.md', 'b.md']), 'constellation')
    engine.setMode('orbit')
    const p = new Float32Array(6).fill(3)
    worker.reply({ type: 'positions', positions: p, alpha: 0.5, settled: false, generation: 1 })
    expect(engine.positions).toBe(p)
    engine.dispose()
  })

  it('says whether the positions are a layout or only the seed a new node set starts from', async () => {
    const { LayoutEngine } = await import('../src/layout/LayoutEngine')
    const engine = new LayoutEngine()
    const worker = FakeWorker.last!
    expect(engine.placed).toBe(false)
    engine.setGraph(graphOf(['a.md', 'b.md']), 'system')
    // All zeros until the worker answers: nothing may show them as the brain's places.
    expect(engine.placed).toBe(false)
    expect(engine.answered).toBe(false)
    expect(engine.carried).toBe(0)
    expect(Array.from(engine.positions)).toEqual([0, 0, 0, 0, 0, 0])
    // A reply for a graph that is already gone does not count.
    worker.reply({ type: 'positions', positions: new Float32Array(6).fill(4), alpha: 0, settled: true, generation: 0 })
    expect(engine.placed).toBe(false)
    expect(engine.answered).toBe(false)
    worker.reply({ type: 'positions', positions: new Float32Array(6).fill(4), alpha: 0, settled: true, generation: 1 })
    expect(engine.placed).toBe(true)
    expect(engine.answered).toBe(true)
    // A node set most of which was there before starts from the old places, which are places: placed at once, not yet answered.
    engine.setGraph(graphOf(['a.md', 'b.md', 'c.md']), 'system')
    expect(engine.placed).toBe(true)
    expect(engine.answered).toBe(false)
    expect(engine.carried).toBeCloseTo(2 / 3, 5)
    expect(engine.positions[0]).toBe(4)
    worker.reply({ type: 'positions', positions: new Float32Array(9).fill(6), alpha: 0, settled: true, generation: 2 })
    expect(engine.answered).toBe(true)
    // Another vault shares almost nothing with it: a seed again.
    engine.setGraph(graphOf(['x.md', 'y.md', 'z.md', 'a.md']), 'system')
    expect(engine.carried).toBe(0.25)
    expect(engine.placed).toBe(false)
    // And a node set that follows one nobody has laid out yet inherits no places, whatever it shares with it.
    engine.setGraph(graphOf(['x.md', 'y.md', 'z.md', 'a.md', 'b.md']), 'system')
    expect(engine.carried).toBe(0.8)
    expect(engine.placed).toBe(false)
    engine.dispose()
  })
})
