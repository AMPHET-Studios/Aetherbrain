import { describe, expect, it } from 'vitest'
import {
  EMPTY_PICKER_SELECTION,
  PICKER_MAX_ENTRIES,
  PICKER_MAX_ROWS,
  PICKER_ROW_PX,
  clickRow,
  filterEntries,
  moveCursor,
  pickerWindow,
  selectAllRows,
  toEntries,
  toggleRow,
  type PickerSelection,
} from '../src/board/view/picker-model'
import { MAX_PICKER_ADD } from '../src/board/view/session'
import { THUMB_CONCURRENCY, THUMB_MAX, ThumbCache } from '../src/board/view/thumbs'
import { settle } from './helpers/board-view-fakes'

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `p${i}.png` }))
const mods = (shift = false, ctrl = false) => ({ shift, ctrl })

describe('the picker’s list', () => {
  it('lists pictures only, newest first, ties by path; a vault without times is by path', () => {
    const { entries, cut } = toEntries([
      { path: 'Art/old.png', mtime: 100 },
      { path: 'Art/new.PNG', mtime: 300 },
      { path: 'clip.mp4', mtime: 999 },
      { path: 'notes/readme.md', mtime: 999 },
      { path: 'b.jpg' },
      { path: 'a.jpg' },
      { path: 'Art/mid.webp', mtime: 200 },
    ])
    expect(cut).toBe(0)
    expect(entries.map((e) => e.path)).toEqual(['Art/new.PNG', 'Art/mid.webp', 'Art/old.png', 'a.jpg', 'b.jpg'])
    expect(entries[0]).toMatchObject({ name: 'new.PNG', dir: 'Art', lower: 'art/new.png' })
    expect(entries[3]).toMatchObject({ name: 'a.jpg', dir: '' })
  })

  it('a vault with more pictures than the picker lists is cut to the newest, and says by how many', () => {
    const many = Array.from({ length: PICKER_MAX_ENTRIES + 5 }, (_, i) => ({ path: `f/${i}.png`, mtime: i }))
    const { entries, cut } = toEntries(many)
    expect(entries).toHaveLength(PICKER_MAX_ENTRIES)
    expect(cut).toBe(5)
    expect(entries[0]!.path).toBe(`f/${PICKER_MAX_ENTRIES + 4}.png`)
  })

  it('the search is a case-insensitive substring of the path (folders count), trimmed; an empty query keeps all', () => {
    const { entries } = toEntries([
      { path: 'Concept/Gate Rust.png' },
      { path: 'Concept/tower.png' },
      { path: 'Refs/RUSTY-door.jpg' },
      { path: 'Refs/castle.jpg' },
    ])
    expect(filterEntries(entries, 'rust').map((e) => e.path)).toEqual(['Concept/Gate Rust.png', 'Refs/RUSTY-door.jpg'])
    expect(filterEntries(entries, '  CONCEPT/ ').map((e) => e.path)).toEqual(['Concept/Gate Rust.png', 'Concept/tower.png'])
    expect(filterEntries(entries, 'gate rust')).toHaveLength(1)
    expect(filterEntries(entries, '')).toBe(entries)
    expect(filterEntries(entries, '   ')).toBe(entries)
    expect(filterEntries(entries, 'zzz')).toEqual([])
  })
})

describe('windowing the list', () => {
  it('draws the rows in view plus a few, and spacers for the rest', () => {
    const w = pickerWindow(10_000, 5600, 560)
    expect(w.start).toBe(100 - 4)
    expect(w.end).toBe(110 + 4)
    expect(w.padTop).toBe(w.start * PICKER_ROW_PX)
    expect(w.padBottom).toBe((10_000 - w.end) * PICKER_ROW_PX)
    expect(w.padTop + (w.end - w.start) * PICKER_ROW_PX + w.padBottom).toBe(10_000 * PICKER_ROW_PX)
  })

  it('never more than 60 rows in the page, however tall the view or long the list', () => {
    for (const count of [0, 1, 5, 59, 60, 61, 1000, 100_000, 5_000_000]) {
      for (const viewport of [0, 1, 300, 560, 2000, 100_000, NaN]) {
        for (const top of [0, 1, 777, count * PICKER_ROW_PX, count * PICKER_ROW_PX * 2, -5, NaN]) {
          const w = pickerWindow(count, top, viewport)
          expect(w.end - w.start, `${count} ${viewport} ${top}`).toBeLessThanOrEqual(PICKER_MAX_ROWS)
          expect(w.start).toBeGreaterThanOrEqual(0)
          expect(w.end).toBeLessThanOrEqual(count)
          expect(w.end).toBeGreaterThanOrEqual(w.start)
          expect(w.padBottom).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  it('a view taller than the cap still starts at the top rows', () => {
    const w = pickerWindow(1000, 0, 100_000)
    expect(w.start).toBe(0)
    expect(w.end).toBe(PICKER_MAX_ROWS)
  })

  it('an empty list has an empty window', () => {
    expect(pickerWindow(0, 0, 500)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
  })
})

describe('choosing pictures', () => {
  const sel = (s: PickerSelection) => [...s.paths]

  it('a click chooses that row alone; Ctrl-click adds one and takes one away', () => {
    const list = rows(10)
    let s = clickRow(EMPTY_PICKER_SELECTION, list, 2, mods())
    expect(sel(s)).toEqual(['p2.png'])
    s = clickRow(s, list, 5, mods())
    expect(sel(s)).toEqual(['p5.png'])
    s = clickRow(s, list, 7, mods(false, true))
    expect(sel(s)).toEqual(['p5.png', 'p7.png'])
    s = clickRow(s, list, 5, mods(false, true))
    expect(sel(s)).toEqual(['p7.png'])
  })

  it('Shift-click chooses the run from the anchor, either way; Ctrl+Shift adds the run to what was chosen', () => {
    const list = rows(10)
    let s = clickRow(EMPTY_PICKER_SELECTION, list, 3, mods())
    s = clickRow(s, list, 6, mods(true))
    expect(sel(s)).toEqual(['p3.png', 'p4.png', 'p5.png', 'p6.png'])
    s = clickRow(s, list, 1, mods(true))
    expect(sel(s).sort()).toEqual(['p1.png', 'p2.png', 'p3.png'])
    // The anchor stays where it was clicked.
    expect(s.anchor).toBe(3)
    let t = clickRow(EMPTY_PICKER_SELECTION, list, 0, mods())
    t = clickRow(t, list, 8, mods(false, true))
    t = clickRow(t, list, 6, mods(true, true))
    expect(sel(t).sort()).toEqual(['p0.png', 'p6.png', 'p7.png', 'p8.png'])
  })

  it('Shift-click with no anchor is a plain toggle of that row', () => {
    const s = clickRow(EMPTY_PICKER_SELECTION, rows(5), 2, mods(true))
    expect(sel(s)).toEqual(['p2.png'])
  })

  it('at most 100 at a time: a longer choice is cut where it was asked for, and says so', () => {
    const list = rows(400)
    const all = selectAllRows(list)
    expect(all.paths.size).toBe(MAX_PICKER_ADD)
    expect(all.capped).toBe(true)
    expect(selectAllRows(rows(30)).capped).toBe(false)
    let s = clickRow(EMPTY_PICKER_SELECTION, list, 10, mods())
    s = clickRow(s, list, 300, mods(true))
    expect(s.paths.size).toBe(MAX_PICKER_ADD)
    expect(s.capped).toBe(true)
    expect(s.paths.has('p10.png')).toBe(true)
    expect(s.paths.has('p109.png')).toBe(true)
    expect(s.paths.has('p110.png')).toBe(false)
  })

  it('a click past the end, or in an empty list, changes nothing', () => {
    const s = clickRow(EMPTY_PICKER_SELECTION, rows(3), 9, mods())
    expect(s).toBe(EMPTY_PICKER_SELECTION)
    expect(toggleRow(EMPTY_PICKER_SELECTION, [], 0)).toBe(EMPTY_PICKER_SELECTION)
    expect(selectAllRows([]).paths.size).toBe(0)
  })

  it('Space toggles the row under the cursor', () => {
    const list = rows(4)
    let s = toggleRow(EMPTY_PICKER_SELECTION, list, 1)
    s = toggleRow(s, list, 3)
    expect(sel(s)).toEqual(['p1.png', 'p3.png'])
    s = toggleRow(s, list, 1)
    expect(sel(s)).toEqual(['p3.png'])
  })

  it('the cursor stays inside the list', () => {
    expect(moveCursor(0, 5, -1)).toBe(0)
    expect(moveCursor(3, 5, 9)).toBe(4)
    expect(moveCursor(2, 5, 1)).toBe(3)
    expect(moveCursor(2, 0, 1)).toBe(0)
  })
})

describe('thumbnails', () => {
  function rig(opts: { max?: number; concurrency?: number } = {}) {
    const urls = new Map<string, string>()
    const revoked: string[] = []
    const started: string[] = []
    const gates = new Map<string, (b: Blob | null) => void>()
    let changes = 0
    let seq = 0
    const cache = new ThumbCache({
      load: (path) => {
        started.push(path)
        return new Promise<Blob | null>((res) => gates.set(path, res))
      },
      createUrl: () => {
        const u = `blob:${++seq}`
        return u
      },
      revokeUrl: (u) => void revoked.push(u),
      onChange: () => void changes++,
      ...opts,
    })
    return {
      cache,
      urls,
      revoked,
      started,
      resolve: async (path: string, blob: Blob | null = new Blob(['x'])) => {
        gates.get(path)?.(blob)
        gates.delete(path)
        await settle(2)
      },
      changes: () => changes,
    }
  }
  const paths = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => `p${a + i}.png`)

  it('loads only what is in view, three at a time, in order', async () => {
    const r = rig()
    r.cache.want(paths(0, 8))
    expect(r.started).toEqual(paths(0, THUMB_CONCURRENCY))
    expect(r.cache.active).toBe(THUMB_CONCURRENCY)
    await r.resolve('p0.png')
    expect(r.started).toEqual(paths(0, THUMB_CONCURRENCY + 1))
    expect(r.cache.urlOf('p0.png')).toBe('blob:1')
    expect(r.cache.urlOf('p5.png')).toBeUndefined()
    expect(r.changes()).toBe(1)
  })

  it('a row that scrolled away before its turn is never loaded; one that scrolled away while loading gets no URL', async () => {
    const r = rig({ concurrency: 1 })
    r.cache.want(paths(0, 4))
    expect(r.started).toEqual(['p0.png'])
    r.cache.want(paths(10, 12))
    await r.resolve('p0.png')
    expect(r.cache.urlOf('p0.png')).toBeUndefined()
    expect(r.cache.size).toBe(0)
    expect(r.started).toEqual(['p0.png', 'p10.png'])
    expect(r.started).not.toContain('p1.png')
  })

  it('holds at most 120 URLs, gives back the oldest, never one in view', async () => {
    const r = rig({ max: THUMB_MAX, concurrency: 8 })
    for (let page = 0; page < 20; page++) {
      const view = paths(page * 10, page * 10 + 10)
      r.cache.want(view)
      for (const p of view) await r.resolve(p)
    }
    expect(r.cache.size).toBe(THUMB_MAX)
    expect(r.revoked).toHaveLength(200 - THUMB_MAX)
    // The oldest went first.
    expect(r.cache.urlOf('p0.png')).toBeUndefined()
    expect(r.cache.urlOf('p199.png')).toBeDefined()
    // A view bigger than the table keeps all of it.
    const big = rig({ max: 5, concurrency: 20 })
    big.cache.want(paths(0, 9))
    for (const p of paths(0, 9)) await big.resolve(p)
    expect(big.cache.size).toBe(9)
  })

  it('a picture shown again moves to the young end and is not the next to go', async () => {
    const r = rig({ max: 3, concurrency: 8 })
    r.cache.want(['a', 'b', 'c'])
    for (const p of ['a', 'b', 'c']) await r.resolve(p)
    r.cache.want(['a'])
    r.cache.want(['d'])
    await r.resolve('d')
    expect(r.cache.urlOf('b')).toBeUndefined()
    expect(r.cache.urlOf('a')).toBeDefined()
    expect(r.cache.urlOf('c')).toBeDefined()
  })

  it('a picture with no preview is remembered as none, and is not asked for again', async () => {
    const r = rig()
    r.cache.want(['x'])
    await r.resolve('x', null)
    expect(r.cache.urlOf('x')).toBeNull()
    r.cache.want(['x'])
    expect(r.started).toEqual(['x'])
  })

  it('a loader that throws is a missing thumbnail, not a crash', async () => {
    const calls: string[] = []
    const cache = new ThumbCache({
      load: async (p) => {
        calls.push(p)
        throw new Error('boom')
      },
      createUrl: () => 'blob:x',
      revokeUrl: () => undefined,
      onChange: () => undefined,
    })
    cache.want(['a'])
    await settle(2)
    expect(cache.urlOf('a')).toBeNull()
  })

  it('dispose gives every URL back and later loads land nowhere', async () => {
    const r = rig({ concurrency: 4 })
    r.cache.want(['a', 'b', 'c'])
    await r.resolve('a')
    r.cache.dispose()
    expect(r.revoked).toEqual(['blob:1'])
    await r.resolve('b')
    expect(r.cache.size).toBe(0)
    r.cache.want(['z'])
    expect(r.started).not.toContain('z')
  })
})
