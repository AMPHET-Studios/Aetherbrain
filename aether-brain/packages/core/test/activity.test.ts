import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_HALF_LIFE_MS,
  ACTIVITY_HEAT_K,
  ACTIVITY_MAX_NOTES,
  ACTIVITY_OPEN,
  ACTIVITY_REPEAT_MS,
  ACTIVITY_SAVE,
  ActivityLog,
  buildGraph,
  computeActivity,
  folderKey,
  parseNote,
  type GraphData,
  type NoteId,
  type ParsedNote,
} from '../src'

/**
 * How much each note and folder is used (docs/COSMOLOGY.md, "A star's brightness is how much you use it"): opening and saving leave heat
 * on a note that fades with time, a folder is as bright as its whole system, and the log is bounded and tolerant.
 */

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0)
const MIN = 60_000
const DAY = 24 * 3600 * 1000

describe('what counts', () => {
  it('is an open (1) and a save (2), and they add up', () => {
    const log = new ActivityLog()
    expect(log.record('A', 'open', T0)).toBe(true)
    expect(log.scoreOf('A', T0)).toBe(ACTIVITY_OPEN)
    expect(log.record('A', 'save', T0 + MIN)).toBe(true)
    expect(log.scoreOf('A', T0 + MIN)).toBeCloseTo(ACTIVITY_OPEN * Math.pow(0.5, MIN / ACTIVITY_HALF_LIFE_MS) + ACTIVITY_SAVE, 6)
    expect(ACTIVITY_SAVE).toBeGreaterThan(ACTIVITY_OPEN)
  })

  it('counts the same kind of interaction with the same note once within a few seconds, and again after', () => {
    const log = new ActivityLog()
    expect(log.record('A', 'open', T0)).toBe(true)
    expect(log.record('A', 'open', T0 + 1000)).toBe(false)
    expect(log.record('A', 'open', T0 + ACTIVITY_REPEAT_MS - 1)).toBe(false)
    expect(log.record('A', 'open', T0 + ACTIVITY_REPEAT_MS)).toBe(true)
    // A save is not an open: it counts at once, and another note is its own.
    expect(log.record('A', 'save', T0 + 5)).toBe(true)
    expect(log.record('B', 'open', T0 + 5)).toBe(true)
  })

  it('refuses a note with no name and a time that is not a number', () => {
    const log = new ActivityLog()
    expect(log.record('', 'open', T0)).toBe(false)
    expect(log.record('A', 'open', Number.NaN)).toBe(false)
    expect(log.record('A', 'open', Number.POSITIVE_INFINITY)).toBe(false)
    expect(log.size).toBe(0)
  })
})

describe('how it fades', () => {
  it('halves every two weeks, so a month leaves about a fifth and two months almost nothing', () => {
    const log = new ActivityLog()
    log.record('A', 'save', T0)
    const s = log.scoreOf('A', T0)
    expect(log.scoreOf('A', T0 + 14 * DAY)).toBeCloseTo(s / 2, 6)
    expect(log.scoreOf('A', T0 + 28 * DAY)).toBeCloseTo(s / 4, 6)
    expect(log.scoreOf('A', T0 + 60 * DAY)).toBeLessThan(s * 0.06)
    expect(log.heatOf('A', T0 + 14 * DAY)).toBeLessThan(log.heatOf('A', T0))
  })

  it('never makes a note hotter by waiting, and a clock that went back changes nothing', () => {
    const log = new ActivityLog()
    log.record('A', 'save', T0)
    expect(log.scoreOf('A', T0 - DAY)).toBe(log.scoreOf('A', T0))
    log.record('A', 'open', T0 - DAY)
    expect(Number.isFinite(log.scoreOf('A', T0))).toBe(true)
    expect(log.scoreOf('A', T0)).toBeGreaterThanOrEqual(ACTIVITY_SAVE)
  })

  it('is heat from 0 up towards 1: more use is hotter, and it never reaches 1', () => {
    const log = new ActivityLog()
    expect(log.heatOf('nothing', T0)).toBe(0)
    let last = 0
    for (let i = 1; i <= 40; i++) {
      log.record('A', 'save', T0 + i * MIN)
      const h = log.heatOf('A', T0 + i * MIN)
      expect(h).toBeGreaterThan(last)
      expect(h).toBeLessThan(1)
      last = h
    }
    // Half as hot as it can get at a score of K.
    const k = new ActivityLog()
    for (let i = 0; i < ACTIVITY_HEAT_K / ACTIVITY_SAVE; i++) k.record('A', 'save', T0 + i * MIN)
    expect(k.heatOf('A', T0 + (ACTIVITY_HEAT_K / ACTIVITY_SAVE) * MIN)).toBeGreaterThan(0.45)
  })
})

describe('what is kept', () => {
  it('survives being saved and read back, with the heat it had', () => {
    const log = new ActivityLog()
    log.record('A', 'save', T0)
    log.record('B/C', 'open', T0 + MIN)
    const back = ActivityLog.from(JSON.parse(JSON.stringify(log.toJSON())), T0 + 2 * MIN)
    expect(back.size).toBe(2)
    for (const id of ['A', 'B/C']) expect(back.heatOf(id, T0 + 2 * MIN)).toBeCloseTo(log.heatOf(id, T0 + 2 * MIN), 3)
  })

  it('reads whatever is in storage without being fooled: garbage, wrong shapes, bad numbers, the future', () => {
    for (const bad of [null, undefined, 7, 'x', [], {}, { v: 2, e: {} }, { v: 1 }, { v: 1, e: [] }, { v: 1, e: 'x' }]) {
      expect(ActivityLog.from(bad, T0).size, JSON.stringify(bad)).toBe(0)
    }
    const log = ActivityLog.from(
      { v: 1, e: { ok: [3, T0 - DAY], neg: [-5, T0], nan: ['x', T0], short: [1], inf: [Number.POSITIVE_INFINITY, T0], huge: [1e12, T0], future: [2, T0 + 400 * DAY], faded: [1, T0 - 400 * DAY] } },
      T0,
    )
    expect(log.scoreOf('ok', T0)).toBeGreaterThan(0)
    expect(log.scoreOf('neg', T0)).toBe(0)
    expect(log.scoreOf('nan', T0)).toBe(0)
    expect(log.scoreOf('short', T0)).toBe(0)
    expect(log.scoreOf('inf', T0)).toBe(0)
    // A corrupt number cannot make a note burn for ever, and a time in the future is read as now.
    expect(log.scoreOf('huge', T0 + 365 * DAY)).toBeLessThan(1)
    expect(log.scoreOf('future', T0)).toBeCloseTo(2, 6)
    // What has faded away, or is no number, is not kept: only ok, huge and future are.
    expect(log.size).toBe(3)
  })

  it('keeps at most a few thousand notes and forgets the coolest first', () => {
    const log = new ActivityLog()
    for (let i = 0; i < ACTIVITY_MAX_NOTES; i++) log.record(`n${i}`, 'open', T0 + i)
    // One that is much hotter than the rest, and the newest of all.
    log.record('hot', 'save', T0 + 10 * DAY)
    log.record('hot', 'save', T0 + 10 * DAY + ACTIVITY_REPEAT_MS)
    log.record('newest', 'open', T0 + 10 * DAY + 2 * ACTIVITY_REPEAT_MS)
    expect(log.size).toBeLessThanOrEqual(ACTIVITY_MAX_NOTES)
    expect(log.scoreOf('hot', T0 + 10 * DAY + 3 * ACTIVITY_REPEAT_MS)).toBeGreaterThan(3)
    expect(log.scoreOf('newest', T0 + 10 * DAY + 3 * ACTIVITY_REPEAT_MS)).toBeGreaterThan(0)
    // The oldest of the plain ones went.
    expect(log.scoreOf('n0', T0 + 10 * DAY + 3 * ACTIVITY_REPEAT_MS)).toBe(0)
    // And what is read back from a log over the cap is cut the same way.
    const big: Record<string, [number, number]> = {}
    for (let i = 0; i < ACTIVITY_MAX_NOTES + 500; i++) big[`m${i}`] = [1 + (i % 7), T0]
    expect(ActivityLog.from({ v: 1, e: big }, T0).size).toBeLessThanOrEqual(ACTIVITY_MAX_NOTES)
  })

  it('keeps a note called __proto__ (or constructor) as the data it is, and saves and reads it back', () => {
    const log = new ActivityLog()
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) log.record(id, 'save', T0)
    const saved = JSON.parse(JSON.stringify(log.toJSON())) as { e: Record<string, unknown> }
    expect(Object.keys(saved.e).sort()).toEqual(['__proto__', 'constructor', 'hasOwnProperty', 'toString'])
    const back = ActivityLog.from(saved, T0)
    expect(back.size).toBe(4)
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(back.scoreOf(id, T0)).toBeCloseTo(ACTIVITY_SAVE, 3)
    // Nothing leaked into every object.
    expect(({} as { s?: unknown }).s).toBeUndefined()
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })

  it('forgets everything on request', () => {
    const log = new ActivityLog()
    log.record('A', 'open', T0)
    log.clear()
    expect(log.size).toBe(0)
    expect(log.heatOf('A', T0)).toBe(0)
    // And counts afresh: the repeat guard is cleared too.
    expect(log.record('A', 'open', T0 + 1)).toBe(true)
  })
})

describe('the brightness of the folders', () => {
  const files: Record<string, string> = {
    'Home.md': '# Home\n',
    'Work/Plan.md': '# Plan\n',
    'Work/Deep/Notes.md': '# Notes\n',
    'Play/Game.md': '# Game\n',
    'Play/Other.md': '# Other\n',
    'Quiet/Still.md': '# Still\n',
  }
  const graph = (): GraphData => {
    const notes = new Map<NoteId, ParsedNote>()
    for (const [path, content] of Object.entries(files)) {
      const n = parseNote({ path, content })
      notes.set(n.meta.id, n)
    }
    return buildGraph(notes, { folders: { multiRoot: false, all: ['Work', 'Work/Deep', 'Play', 'Quiet'], rootTitle: 'Vault', maxDepth: 3, maxFolders: 0 } })
  }
  const at = (g: GraphData, id: string, a: Float32Array) => a[g.index.get(id)!]!

  it('is the note’s own heat for a note, and nothing for what you do not open (pictures, ghosts, the hub)', () => {
    const g = graph()
    const log = new ActivityLog()
    log.record('Work/Plan', 'save', T0)
    const a = computeActivity(g, log, T0)
    expect(at(g, 'Work/Plan', a)).toBeCloseTo(log.heatOf('Work/Plan', T0), 5)
    expect(at(g, 'Play/Game', a)).toBe(0)
    for (let i = 0; i < g.nodes.length; i++) if (g.nodes[i]!.kind !== 'note' && !g.nodes[i]!.folder) expect(a[i]).toBe(0)
  })

  it('makes a folder as bright as the hottest thing in it, so the busy star glows and the quiet one does not', () => {
    const g = graph()
    const log = new ActivityLog()
    for (let i = 0; i < 4; i++) log.record('Work/Plan', 'save', T0 + i * MIN)
    log.record('Play/Game', 'open', T0 + 5 * MIN)
    const now = T0 + 6 * MIN
    const a = computeActivity(g, log, now)
    expect(at(g, folderKey('Work'), a)).toBeGreaterThanOrEqual(log.heatOf('Work/Plan', now) - 1e-6)
    expect(at(g, folderKey('Work'), a)).toBeGreaterThan(at(g, folderKey('Play'), a))
    expect(at(g, folderKey('Play'), a)).toBeGreaterThan(at(g, folderKey('Quiet'), a))
    expect(at(g, folderKey('Quiet'), a)).toBe(0)
  })

  it('lights the folders above what you touched, so a deep note brightens its whole branch, and not the others', () => {
    const g = graph()
    const log = new ActivityLog()
    log.record('Work/Deep/Notes', 'save', T0)
    const a = computeActivity(g, log, T0)
    const heat = log.heatOf('Work/Deep/Notes', T0)
    expect(at(g, folderKey('Work/Deep'), a)).toBeCloseTo(heat, 5)
    expect(at(g, folderKey('Work'), a)).toBeCloseTo(heat, 5)
    expect(at(g, folderKey(''), a)).toBeCloseTo(heat, 5)
    expect(at(g, folderKey('Play'), a)).toBe(0)
  })

  it('stays between 0 and 1 however much is done (a folder of many touched notes is a glow, not a blaze)', () => {
    const g = graph()
    const log = new ActivityLog()
    for (let i = 0; i < 200; i++) {
      log.record('Play/Game', 'save', T0 + i * MIN)
      log.record('Play/Other', 'save', T0 + i * MIN)
    }
    const a = computeActivity(g, log, T0 + 200 * MIN)
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
      expect(Number.isFinite(v)).toBe(true)
    }
    expect(at(g, folderKey('Play'), a)).toBeGreaterThan(0.8)
  })

  it('fades: a folder you left alone is dimmer a month later', () => {
    const g = graph()
    const log = new ActivityLog()
    log.record('Work/Plan', 'save', T0)
    const now = computeActivity(g, log, T0)
    const later = computeActivity(g, log, T0 + 30 * DAY)
    expect(at(g, folderKey('Work'), later)).toBeLessThan(at(g, folderKey('Work'), now) / 2)
  })

  it('is the same for the same use, and works on a graph with no folders', () => {
    const g = graph()
    const log = new ActivityLog()
    log.record('Work/Plan', 'open', T0)
    expect(Array.from(computeActivity(g, log, T0))).toEqual(Array.from(computeActivity(g, log, T0)))
    const notes = new Map<NoteId, ParsedNote>()
    const n = parseNote({ path: 'Solo.md', content: '# Solo\n' })
    notes.set(n.meta.id, n)
    const flat = buildGraph(notes)
    const l2 = new ActivityLog()
    l2.record('Solo', 'save', T0)
    expect(computeActivity(flat, l2, T0)[0]).toBeGreaterThan(0)
  })
})
