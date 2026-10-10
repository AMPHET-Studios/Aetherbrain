import { afterEach, describe, expect, it, vi } from 'vitest'
import { History } from '../src/board/history'

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** States are objects, as board documents are: identity is what history hands back. */
const S = (name: string): { name: string } => ({ name })

afterEach(() => {
  vi.useRealTimers()
})

describe('History: the basics', () => {
  it('starts from the initial state with nothing to undo or redo', () => {
    const h = new History<{ name: string }>()
    const s0 = S('s0')
    h.reset(s0)
    expect(h.current).toBe(s0)
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.size).toBe(1)
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBeNull()
    expect(h.undoLabel).toBeNull()
    expect(h.redoLabel).toBeNull()
    expect(h.current).toBe(s0)
  })

  it('undo and redo hand back the very objects that were pushed, in order', () => {
    const h = new History<{ name: string }>()
    const [s0, s1, s2, s3] = [S('0'), S('1'), S('2'), S('3')] as const
    h.reset(s0)
    h.push(s1, { now: 0 })
    h.push(s2, { now: 5000 })
    h.push(s3, { now: 10000 })
    expect(h.current).toBe(s3)
    expect(h.size).toBe(4)
    expect(h.undo()).toBe(s2)
    expect(h.current).toBe(s2)
    expect(h.undo()).toBe(s1)
    expect(h.undo()).toBe(s0)
    expect(h.undo()).toBeNull()
    expect(h.current).toBe(s0)
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(true)
    expect(h.redo()).toBe(s1)
    expect(h.redo()).toBe(s2)
    expect(h.redo()).toBe(s3)
    expect(h.redo()).toBeNull()
    expect(h.current).toBe(s3)
    expect(h.canRedo).toBe(false)
    expect(h.canUndo).toBe(true)
  })

  it('a push drops the redo steps', () => {
    const h = new History<{ name: string }>()
    const [s0, s1, s2, s3] = [S('0'), S('1'), S('2'), S('3')] as const
    h.reset(s0)
    h.push(s1, { now: 0 })
    h.push(s2, { now: 5000 })
    h.undo()
    h.undo()
    expect(h.canRedo).toBe(true)
    h.push(s3, { now: 10000 })
    expect(h.canRedo).toBe(false)
    expect(h.redo()).toBeNull()
    expect(h.current).toBe(s3)
    expect(h.size).toBe(2)
    expect(h.undo()).toBe(s0)
    expect(h.redo()).toBe(s3)
  })

  it('pushing the very object that is current changes nothing, not even the redo steps', () => {
    const h = new History<{ name: string }>()
    const [s0, s1] = [S('0'), S('1')] as const
    h.reset(s0)
    h.push(s1, { now: 0, label: 'one' })
    h.undo()
    h.push(s0, { now: 100, label: 'nothing' })
    expect(h.canRedo).toBe(true)
    expect(h.redoLabel).toBe('one')
    expect(h.size).toBe(2)
    h.redo()
    h.push(s1, { now: 200 })
    expect(h.size).toBe(2)
    expect(h.undoLabel).toBe('one')
    // an equal-looking copy is a different object, and a step
    h.push({ name: '1' }, { now: 5000 })
    expect(h.size).toBe(3)
  })

  it('works with plain values too', () => {
    const h = new History<number>()
    h.reset(0)
    h.push(1, { now: 0 })
    h.push(2, { now: 5000 })
    expect(h.undo()).toBe(1)
    expect(h.undo()).toBe(0)
    expect(h.redo()).toBe(1)
  })

  it('reset forgets every step, the redo steps and what could be merged', () => {
    const h = new History<{ name: string }>()
    const [s0, s1, s2, s3] = [S('0'), S('1'), S('2'), S('3')] as const
    h.reset(s0)
    h.push(s1, { now: 0, key: 'k', label: 'a' })
    h.push(s2, { now: 5000, label: 'b' })
    h.undo()
    h.reset(s3)
    expect(h.current).toBe(s3)
    expect(h.size).toBe(1)
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.undoLabel).toBeNull()
    expect(h.redoLabel).toBeNull()
    h.push(s1, { now: 5100, key: 'k' })
    expect(h.size).toBe(2)
    expect(h.undo()).toBe(s3)
  })

  it('a first push with no reset becomes the first state', () => {
    const h = new History<number>()
    h.push(5)
    expect(h.current).toBe(5)
    expect(h.canUndo).toBe(false)
    h.push(6, { now: 0 })
    expect(h.undo()).toBe(5)
  })
})

describe('History: labels', () => {
  it('undoLabel names the step an undo would take back, redoLabel the one a redo would apply', () => {
    const h = new History<number>()
    h.reset(0)
    expect(h.undoLabel).toBeNull()
    h.push(1, { now: 0, label: 'Move' })
    h.push(2, { now: 5000, label: 'Rotate' })
    h.push(3, { now: 10000, label: 'Delete' })
    expect(h.undoLabel).toBe('Delete')
    expect(h.redoLabel).toBeNull()
    h.undo()
    expect(h.undoLabel).toBe('Rotate')
    expect(h.redoLabel).toBe('Delete')
    h.undo()
    expect(h.undoLabel).toBe('Move')
    expect(h.redoLabel).toBe('Rotate')
    h.undo()
    expect(h.undoLabel).toBeNull()
    expect(h.redoLabel).toBe('Move')
    h.redo()
    h.redo()
    expect(h.undoLabel).toBe('Rotate')
    expect(h.redoLabel).toBe('Delete')
  })

  it('a step without a label has the label null, and the label goes with the step it names', () => {
    const h = new History<number>()
    h.reset(0)
    h.push(1, { now: 0 })
    expect(h.canUndo).toBe(true)
    expect(h.undoLabel).toBeNull()
    h.push(2, { now: 5000, label: 'x' })
    h.undo()
    expect(h.undoLabel).toBeNull()
    expect(h.redoLabel).toBe('x')
  })

  it('a new push replaces the labels of the dropped redo steps', () => {
    const h = new History<number>()
    h.reset(0)
    h.push(1, { now: 0, label: 'a' })
    h.push(2, { now: 5000, label: 'b' })
    h.undo()
    h.push(3, { now: 10000, label: 'c' })
    expect(h.redoLabel).toBeNull()
    expect(h.undoLabel).toBe('c')
  })
})

describe('History: coalescing', () => {
  it('pushes with the same key within the window are one step', () => {
    const h = new History<number>()
    h.reset(0)
    h.push(1, { key: 'nudge', now: 1000, label: 'Move' })
    h.push(2, { key: 'nudge', now: 1300 })
    h.push(3, { key: 'nudge', now: 1600 })
    expect(h.current).toBe(3)
    expect(h.size).toBe(2)
    expect(h.undo()).toBe(0)
    expect(h.redo()).toBe(3)
  })

  it('the window slides: a long run of pushes, each close to the one before, stays one step', () => {
    const h = new History<number>()
    h.reset(0)
    let t = 0
    for (let i = 1; i <= 50; i++) {
      h.push(i, { key: 'nudge', now: t })
      t += 700
    }
    expect(h.size).toBe(2)
    expect(h.undo()).toBe(0)
  })

  it('a gap longer than the window starts a new step; the edge itself still merges', () => {
    const h = new History<number>()
    h.reset(0)
    h.push(1, { key: 'k', now: 0 })
    h.push(2, { key: 'k', now: 800 })
    expect(h.size).toBe(2)
    h.push(3, { key: 'k', now: 1601 })
    expect(h.size).toBe(3)
    expect(h.undo()).toBe(2)
    expect(h.undo()).toBe(0)
  })

  it('does not merge different keys, a missing key, or a key against none', () => {
    const h = new History<number>()
    h.reset(0)
    h.push(1, { key: 'a', now: 0 })
    h.push(2, { key: 'b', now: 10 })
    h.push(3, { now: 20 })
    h.push(4, { now: 30 })
    h.push(5, { key: 'a', now: 40 })
    expect(h.size).toBe(6)
    expect(h.undo()).toBe(4)
    expect(h.undo()).toBe(3)
    expect(h.undo()).toBe(2)
    expect(h.undo()).toBe(1)
    expect(h.undo()).toBe(0)
  })

  it('the first push after a reset is a step of its own, whatever its key', () => {
    const h = new History<number>()
    h.reset(0)
    h.push(1, { key: 'k', now: 0 })
    expect(h.undo()).toBe(0)
    expect(h.size).toBe(2)
  })

  it('keeps the first label unless a later push brings its own', () => {
    const h = new History<number>()
    h.reset(0)
    h.push(1, { key: 'k', now: 0, label: 'Move' })
    h.push(2, { key: 'k', now: 100 })
    expect(h.undoLabel).toBe('Move')
    h.push(3, { key: 'k', now: 200, label: 'Nudge' })
    expect(h.undoLabel).toBe('Nudge')
    expect(h.size).toBe(2)
  })

  it('a push after an undo is a new step, not folded into the older one it lands next to', () => {
    const h = new History<number>()
    h.reset(0)
    h.push(1, { key: 'x', now: 0, label: 'one' })
    h.push(2, { key: 'y', now: 10, label: 'two' })
    expect(h.undo()).toBe(1)
    h.push(3, { key: 'x', now: 20, label: 'three' })
    expect(h.size).toBe(3)
    expect(h.undo()).toBe(1)
    expect(h.undo()).toBe(0)
    expect(h.redo()).toBe(1)
    expect(h.redo()).toBe(3)
    expect(h.redo()).toBeNull()
  })

  it('a push after a redo is a new step too', () => {
    const h = new History<number>()
    h.reset(0)
    h.push(1, { key: 'x', now: 0 })
    h.push(2, { key: 'y', now: 10 })
    h.undo()
    expect(h.redo()).toBe(2)
    h.push(3, { key: 'y', now: 20 })
    expect(h.size).toBe(4)
    expect(h.undo()).toBe(2)
  })

  it('a clock that goes backwards does not merge', () => {
    const h = new History<number>()
    h.reset(0)
    h.push(1, { key: 'k', now: 5000 })
    h.push(2, { key: 'k', now: 100 })
    expect(h.size).toBe(3)
  })

  it('coalesceMs sets the window, and 0 turns merging off', () => {
    const short = new History<number>({ coalesceMs: 100 })
    short.reset(0)
    short.push(1, { key: 'k', now: 0 })
    short.push(2, { key: 'k', now: 100 })
    short.push(3, { key: 'k', now: 201 })
    expect(short.size).toBe(3)

    const off = new History<number>({ coalesceMs: 0 })
    off.reset(0)
    off.push(1, { key: 'k', now: 0 })
    off.push(2, { key: 'k', now: 0 })
    expect(off.size).toBe(3)

    const long = new History<number>({ coalesceMs: 60_000 })
    long.reset(0)
    long.push(1, { key: 'k', now: 0 })
    long.push(2, { key: 'k', now: 59_000 })
    expect(long.size).toBe(2)
  })

  it('uses the clock when no time is given: 800 ms by default', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const h = new History<number>()
    h.reset(0)
    h.push(1, { key: 'k' })
    vi.setSystemTime(1_000_700)
    h.push(2, { key: 'k' })
    expect(h.size).toBe(2)
    vi.setSystemTime(1_001_700)
    h.push(3, { key: 'k' })
    expect(h.size).toBe(3)
    vi.setSystemTime(1_002_400)
    h.push(4, { key: 'k' })
    expect(h.size).toBe(3)
  })

  it('a coalesced push of the very current object is still a no-op', () => {
    const h = new History<{ name: string }>()
    const s1 = S('1')
    h.reset(S('0'))
    h.push(s1, { key: 'k', now: 0, label: 'a' })
    h.push(s1, { key: 'k', now: 10, label: 'b' })
    expect(h.undoLabel).toBe('a')
    expect(h.size).toBe(2)
  })
})

describe('History: the limit', () => {
  it('forgets the oldest steps and never holds more than limit + 1 states', () => {
    const h = new History<number>({ limit: 5 })
    h.reset(0)
    for (let i = 1; i <= 40; i++) {
      h.push(i, { now: i * 10_000 })
      expect(h.size).toBeLessThanOrEqual(6)
    }
    expect(h.size).toBe(6)
    let steps = 0
    const seen: number[] = []
    for (let s = h.undo(); s !== null; s = h.undo()) {
      steps++
      seen.push(s)
    }
    expect(steps).toBe(5)
    expect(seen).toEqual([39, 38, 37, 36, 35])
    expect(h.current).toBe(35)
    expect(h.canUndo).toBe(false)
  })

  it('is 200 steps by default', () => {
    const h = new History<number>()
    h.reset(0)
    for (let i = 1; i <= 500; i++) h.push(i, { now: i * 10_000 })
    expect(h.size).toBe(201)
    let steps = 0
    while (h.undo() !== null) steps++
    expect(steps).toBe(200)
    expect(h.current).toBe(300)
  })

  it('exactly `limit` pushes keep the initial state; one more drops it', () => {
    const h = new History<number>({ limit: 3 })
    h.reset(0)
    for (let i = 1; i <= 3; i++) h.push(i, { now: i * 10_000 })
    expect(h.size).toBe(4)
    while (h.undo() !== null);
    expect(h.current).toBe(0)
    while (h.redo() !== null);
    h.push(4, { now: 100_000 })
    expect(h.size).toBe(4)
    while (h.undo() !== null);
    expect(h.current).toBe(1)
  })

  it('redo steps count in the size, and undoing does not shrink the history', () => {
    const h = new History<number>({ limit: 4 })
    h.reset(0)
    for (let i = 1; i <= 10; i++) h.push(i, { now: i * 10_000 })
    expect(h.size).toBe(5)
    h.undo()
    h.undo()
    expect(h.size).toBe(5)
    h.push(99, { now: 500_000 })
    expect(h.size).toBe(4)
  })

  it('a merged push uses no room', () => {
    const h = new History<number>({ limit: 2 })
    h.reset(0)
    h.push(1, { now: 0, key: 'a' })
    for (let i = 2; i <= 30; i++) h.push(i, { now: i, key: 'a' })
    h.push(100, { now: 100_000 })
    expect(h.size).toBe(3)
    expect(h.undo()).toBe(30)
    expect(h.undo()).toBe(0)
  })

  it('a limit of 0 keeps only the current state', () => {
    const h = new History<number>({ limit: 0 })
    h.reset(0)
    h.push(1, { now: 0 })
    h.push(2, { now: 5000 })
    expect(h.current).toBe(2)
    expect(h.canUndo).toBe(false)
    expect(h.size).toBe(1)
    expect(h.undo()).toBeNull()
  })

  it('takes a limit that is odd as the whole number below it, and a nonsense one as the default', () => {
    const odd = new History<number>({ limit: 2.9 })
    odd.reset(0)
    for (let i = 1; i <= 10; i++) odd.push(i, { now: i * 10_000 })
    expect(odd.size).toBe(3)
    const bad = new History<number>({ limit: NaN, coalesceMs: NaN })
    bad.reset(0)
    for (let i = 1; i <= 300; i++) bad.push(i, { now: i * 10_000 })
    expect(bad.size).toBe(201)
    const negative = new History<number>({ limit: -5 })
    negative.reset(0)
    negative.push(1, { now: 0 })
    expect(negative.size).toBe(1)
  })

  it('caps even a huge limit', () => {
    const h = new History<number>({ limit: 1e12 })
    h.reset(0)
    for (let i = 1; i <= 10_050; i++) h.push(i, { now: i * 10_000 })
    expect(h.size).toBeLessThanOrEqual(10_001)
  })
})

describe('History against a plain model', () => {
  /** The same rules as plain arrays, written from the contract. */
  class Model {
    states: number[] = []
    labels: (string | null)[] = []
    keys: (string | undefined)[] = []
    times: number[] = []
    at = 0
    open = false
    constructor(
      readonly limit: number,
      readonly window: number,
    ) {}
    reset(s: number): void {
      this.states = [s]
      this.labels = [null]
      this.keys = [undefined]
      this.times = [0]
      this.at = 0
      this.open = false
    }
    push(s: number, key: string | undefined, label: string | undefined, now: number): void {
      if (s === this.states[this.at]) return
      this.states.length = this.labels.length = this.keys.length = this.times.length = this.at + 1
      if (this.open && key !== undefined && key === this.keys[this.at] && now - this.times[this.at]! >= 0 && now - this.times[this.at]! <= this.window) {
        this.states[this.at] = s
        this.labels[this.at] = label ?? this.labels[this.at]!
        this.times[this.at] = now
        return
      }
      this.states.push(s)
      this.labels.push(label ?? null)
      this.keys.push(key)
      this.times.push(now)
      this.at++
      this.open = true
      if (this.states.length > this.limit + 1) {
        this.states.shift()
        this.labels.shift()
        this.keys.shift()
        this.times.shift()
        this.at--
      }
    }
    undo(): number | null {
      if (this.at === 0) return null
      this.open = false
      return this.states[--this.at]!
    }
    redo(): number | null {
      if (this.at >= this.states.length - 1) return null
      this.open = false
      return this.states[++this.at]!
    }
  }

  it('agrees after thousands of random pushes, undos, redos and resets', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed)
      const limit = [1, 2, 3, 7, 25, 200][seed % 6]!
      const window = [0, 50, 800][seed % 3]!
      const h = new History<number>({ limit, coalesceMs: window })
      const m = new Model(limit, window)
      h.reset(0)
      m.reset(0)
      let now = 0
      let value = 0
      for (let step = 0; step < 1500; step++) {
        const p = r()
        if (p < 0.55) {
          now += Math.floor(r() * 1200)
          value += r() < 0.1 ? 0 : 1
          const key = r() < 0.5 ? undefined : ['a', 'b'][Math.floor(r() * 2)]!
          const label = r() < 0.5 ? undefined : `L${step}`
          h.push(value, { key, label, now })
          m.push(value, key, label, now)
        } else if (p < 0.75) {
          expect(h.undo()).toBe(m.undo())
        } else if (p < 0.95) {
          expect(h.redo()).toBe(m.redo())
        } else {
          value = Math.floor(r() * 5)
          h.reset(value)
          m.reset(value)
        }
        expect(h.current).toBe(m.states[m.at])
        expect(h.canUndo).toBe(m.at > 0)
        expect(h.canRedo).toBe(m.at < m.states.length - 1)
        expect(h.size).toBe(m.states.length)
        expect(h.size).toBeLessThanOrEqual(limit + 1)
        expect(h.undoLabel).toBe(m.at > 0 ? m.labels[m.at]! : null)
        expect(h.redoLabel).toBe(m.at < m.states.length - 1 ? m.labels[m.at + 1]! : null)
      }
    }
  })
})
