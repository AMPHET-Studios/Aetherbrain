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
  terminate(): void {}
  reply(msg: WorkerToMain): void {
    this.onmessage?.({ data: msg })
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
})
