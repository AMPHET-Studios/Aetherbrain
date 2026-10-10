import { describe, expect, it, vi } from 'vitest'
import { BOARD_LIMITS, addPicture, addNote, boardPictures, emptyBoard, itemsBounds, estimateTextMetrics, newBoardNote, parseBoard, serializeBoard, parseNote, type ParsedNote } from '@aether/core'
import {
  ADDED_PICTURE_EDGE,
  COLLAGE_PICTURES,
  PreviewUrls,
  addPicturesToBoardText,
  boardFolderFallback,
  boardFolderOf,
  boardStem,
  fitPictureSize,
  forgetSummaries,
  isBoard,
  listBoards,
  pictureAspect,
  samePath,
  summarizeBoard,
  uniqueBoardStem,
} from '../src/board/boardRegistry'
import { boardRaw } from './board-integration-harness'

const note = (path: string, content: string, mtime?: number): ParsedNote => parseNote({ path, content, ...(mtime !== undefined ? { mtime } : {}) })
const mapOf = (...notes: ParsedNote[]) => new Map(notes.map((n) => [n.meta.id, n]))

describe('which notes are boards', () => {
  it('reads the type from the parsed frontmatter', () => {
    expect(isBoard(note('Boards/A.md', boardRaw('A')))).toBe(true)
    expect(isBoard(note('Boards/B.md', '---\ntype: project\n---\n# B\n'))).toBe(false)
    expect(isBoard(note('Boards/C.md', '# C\n\ntype: board\n'))).toBe(false)
  })

  it('orders boards by their updated day, newest first; a tie by title, then path', () => {
    const boards = listBoards(
      mapOf(
        note('Boards/Old.md', boardRaw('Old', [], '2026-01-01')),
        note('Boards/Newer.md', boardRaw('Newer', [], '2026-10-01')),
        note('Boards/Beta.md', boardRaw('Beta', [], '2026-05-05')),
        note('Boards/Alpha.md', boardRaw('Alpha', [], '2026-05-05')),
        note('Inbox/Not a board.md', '# Not\n'),
      ),
    )
    expect(boards.map((b) => b.meta.title)).toEqual(['Newer', 'Alpha', 'Beta', 'Old'])
  })

  it('puts a board with no updated day by its file time, after the dated ones that are newer', () => {
    const undated = (path: string, mtime: number) => note(path, '---\ntitle: U\ntype: board\n---\n# U\n', mtime)
    const dated = note('Boards/Dated.md', boardRaw('Dated', [], '2026-01-01'))
    const list = listBoards(mapOf(undated('Boards/U1.md', 1), undated('Boards/U2.md', Date.parse('2026-12-01')), dated))
    expect(list.map((b) => b.meta.path)).toEqual(['Boards/U2.md', 'Boards/Dated.md', 'Boards/U1.md'])
  })
})

describe('names', () => {
  it('turns a typed name into a file name every system takes', () => {
    expect(boardStem('Gate reference')).toBe('Gate reference')
    expect(boardStem('  a / b : c ? d ')).toBe('a b c d')
    expect(boardStem('#tag [x] ^y')).toBe('tag x y')
    expect(boardStem('...')).toBe('Reference board')
    expect(boardStem('')).toBe('Reference board')
    expect(boardStem('.hidden. ')).toBe('hidden')
    expect(boardStem('x'.repeat(300)).length).toBe(120)
    expect(boardStem('a\u0000b\u0007c')).toBe('a b c')
  })

  it('numbers a name until nothing has it, comparing without regard to letter case', () => {
    const taken = new Set(['gate', 'gate 2', 'gate 3'])
    expect(uniqueBoardStem('Gate', (l) => taken.has(l))).toBe('Gate 4')
    expect(uniqueBoardStem('Ring', (l) => taken.has(l))).toBe('Ring')
    expect(uniqueBoardStem('GATE', (l) => taken.has(l))).toBe('GATE 4')
  })

  it('keeps a board’s pictures in the folder next to it, named like the file', () => {
    expect(boardFolderOf('Boards/Gate reference.md')).toBe('Boards/Gate reference')
    expect(boardFolderOf('Gate.md')).toBe('Gate')
    expect(boardFolderOf('D/Boards/a#b.md')).toBe('D/Boards/a-b')
    expect(boardFolderOf('Boards/Out.md')).toBe('Boards/Out pictures')
    expect(boardFolderFallback('Boards/Gate')).toBe('Boards/Gate pictures')
  })

  it('tells one board from another by its path, letter case aside unless asked', () => {
    expect(samePath('Boards/A.md', 'boards/a.md')).toBe(true)
    expect(samePath('Boards/A.md', 'boards/a.md', true)).toBe(false)
    expect(samePath('Boards/A.md', 'Boards/B.md')).toBe(false)
  })
})

describe('what a card shows', () => {
  it('counts pictures (each path once), notes and marks, and names the first few pictures', () => {
    forgetSummaries()
    let doc = emptyBoard('Mixed')
    for (const [i, p] of ['a.png', 'b.png', 'a.png', 'c.png', 'd.png', 'e.png', 'f.png'].entries()) doc = addPicture(doc, { path: p, w: 100, h: 100, x: i * 120, y: 0 }).doc
    doc = addNote(doc, { text: 'hello', x: 0, y: 200 }).doc
    doc = addNote(doc, { text: 'again', x: 0, y: 300 }).doc
    const raw = serializeBoard(doc, newBoardNote('Mixed', new Date('2026-10-01T10:00:00')))
    const sum = summarizeBoard('Boards/Mixed.md', raw)
    expect(sum.pictures).toBe(6)
    expect(sum.notes).toBe(2)
    expect(sum.marks).toBe(0)
    expect(sum.first).toEqual(['a.png', 'b.png', 'c.png', 'd.png'])
    expect(sum.first).toHaveLength(COLLAGE_PICTURES)
  })

  it('parses a note once per version of its text, and keeps only a bounded number', () => {
    forgetSummaries()
    const raw = boardRaw('Cached', ['x.png'])
    const first = summarizeBoard('Boards/Cached.md', raw)
    expect(summarizeBoard('Boards/Cached.md', raw)).toBe(first)
    const changed = summarizeBoard('Boards/Cached.md', boardRaw('Cached', ['x.png', 'y.png']))
    expect(changed).not.toBe(first)
    expect(changed.pictures).toBe(2)
    // Far more boards than are kept: the earliest are parsed again, nothing grows without end.
    const a = summarizeBoard('Boards/First.md', boardRaw('First', ['p.png']))
    for (let i = 0; i < 400; i++) summarizeBoard(`Boards/B${i}.md`, boardRaw(`B${i}`))
    expect(summarizeBoard('Boards/First.md', boardRaw('First', ['p.png']))).not.toBe(a)
  })
})

describe('putting pictures on a board that is not open', () => {
  const NOW = new Date('2026-10-09T12:00:00')
  const pics = (...paths: string[]) => paths.map((path) => ({ path, w: 400, h: 300 }))

  it('adds them to the board section and leaves every other byte as it was', () => {
    // Under a heading of its own, as the board view itself writes things around the board.
    const hand = '\n## Notes\n\nMy own paragraph, with a [[link]] and #tag.\r\n'
    const raw = boardRaw('Gate', ['a.png']) + hand
    const res = addPicturesToBoardText(raw, pics('b.png', 'c.png'), NOW)
    expect(res).toMatchObject({ added: 2, skipped: 0, full: 0, paths: ['b.png', 'c.png'] })
    expect(res.text.endsWith(hand)).toBe(true)
    expect(boardPictures(parseBoard(res.text).doc)).toEqual(['a.png', 'b.png', 'c.png'])
    // Above the board only the frontmatter's updated day may differ.
    const head = (t: string) => t.slice(0, t.indexOf('## Board')).replace(/updated: .*/, '')
    expect(head(res.text)).toBe(head(raw))
    expect(res.text).toMatch(/updated: "?2026-10-09"?/)
  })

  it('skips a picture the board already shows, and a repeat in the same call', () => {
    const raw = boardRaw('Gate', ['a.png'])
    const res = addPicturesToBoardText(raw, pics('a.png', 'b.png', 'b.png'), NOW)
    expect(res).toMatchObject({ added: 1, skipped: 2, paths: ['b.png'] })
    const none = addPicturesToBoardText(raw, pics('a.png'), NOW)
    expect(none).toEqual({ text: raw, added: 0, paths: [], skipped: 1, full: 0 })
  })

  it('puts them right of everything that is there, level with its top, and clear of it', () => {
    const raw = boardRaw('Gate', ['a.png', 'b.png'])
    const before = itemsBounds(parseBoard(raw).doc.items, estimateTextMetrics)!
    const res = addPicturesToBoardText(raw, pics('c.png', 'd.png', 'e.png'), NOW)
    const doc = parseBoard(res.text).doc
    const added = doc.items.filter((i) => i.kind === 'picture' && ['c.png', 'd.png', 'e.png'].includes(i.path))
    const mine = itemsBounds(added, estimateTextMetrics)!
    expect(mine.x).toBeGreaterThan(before.x + before.w)
    expect(mine.y).toBeCloseTo(before.y, 1)
    // The old pictures did not move.
    const old = doc.items.filter((i) => i.kind === 'picture' && ['a.png', 'b.png'].includes(i.path))
    expect(itemsBounds(old, estimateTextMetrics)).toEqual(before)
    // And the new ones do not overlap each other.
    for (const [i, p] of added.entries()) {
      for (const q of added.slice(i + 1)) {
        const a = itemsBounds([p], estimateTextMetrics)!
        const b = itemsBounds([q], estimateTextMetrics)!
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlap).toBe(false)
      }
    }
  })

  it('centres the first pictures of an empty board on the origin and fits the view to them', () => {
    const res = addPicturesToBoardText(boardRaw('Fresh'), pics('a.png', 'b.png', 'c.png', 'd.png'), NOW)
    const doc = parseBoard(res.text).doc
    const bounds = itemsBounds(doc.items, estimateTextMetrics)!
    expect(bounds.x + bounds.w / 2).toBeCloseTo(0, 0)
    expect(bounds.y + bounds.h / 2).toBeCloseTo(0, 0)
    expect(doc.view.x).toBeCloseTo(0, 0)
    // Shown whole in a 1200 by 760 view.
    expect(bounds.w * doc.view.zoom).toBeLessThanOrEqual(1200)
    expect(bounds.h * doc.view.zoom).toBeLessThanOrEqual(760)
    expect(doc.view.zoom).toBeGreaterThan(0.2)
  })

  it('leaves the view of a board that has pictures alone', () => {
    const raw = boardRaw('Gate', ['a.png'])
    const res = addPicturesToBoardText(raw, pics('b.png'), NOW)
    expect(parseBoard(res.text).doc.view).toEqual(parseBoard(raw).doc.view)
  })

  it('stops at the size of a board and says how many did not fit', () => {
    let doc = emptyBoard('Full')
    for (let i = 0; i < BOARD_LIMITS.items - 1; i++) doc = addPicture(doc, { path: `p${i}.png`, w: 10, h: 10, x: i, y: 0 }).doc
    const raw = serializeBoard(doc, newBoardNote('Full', NOW))
    const res = addPicturesToBoardText(raw, pics('x.png', 'y.png', 'z.png'), NOW)
    expect(res).toMatchObject({ added: 1, full: 2, paths: ['x.png'] })
    expect(parseBoard(res.text).doc.items).toHaveLength(BOARD_LIMITS.items)
  })

  it('refuses a note that is not a board', () => {
    expect(() => addPicturesToBoardText('# A note\n', pics('a.png'), NOW)).toThrow(/not a board/)
  })

  it('writes no duplicate of the path in hand-written lines: they stay in the extra lines', () => {
    const raw = boardRaw('Gate', ['a.png']).replace('\n## Board\n', '\n## Board\n\nA remark about the board.\n')
    const res = addPicturesToBoardText(raw, pics('b.png'), NOW)
    expect(res.text).toContain('A remark about the board.')
  })
})

describe('a picture’s shape', () => {
  it('fits the longer side to the standard edge, or 400 by 300 when the shape is not known', () => {
    expect(fitPictureSize(2)).toEqual({ w: ADDED_PICTURE_EDGE, h: ADDED_PICTURE_EDGE / 2 })
    expect(fitPictureSize(0.5)).toEqual({ w: ADDED_PICTURE_EDGE / 2, h: ADDED_PICTURE_EDGE })
    expect(fitPictureSize(1)).toEqual({ w: 400, h: 400 })
    for (const bad of [null, NaN, 0, -1, Infinity]) expect(fitPictureSize(bad)).toEqual({ w: 400, h: 300 })
    // A sliver of a picture is not drawn as a hair.
    expect(fitPictureSize(1000).h).toBeCloseTo(20)
  })

  it('reads the shape from a small preview, and lets go of the bitmap', async () => {
    const close = vi.fn()
    const preview = vi.fn(async () => new Blob([new Uint8Array(4)]))
    const aspect = await pictureAspect(preview, 'a.png', async () => ({ width: 300, height: 200, close }))
    expect(aspect).toBe(1.5)
    expect(preview).toHaveBeenCalledWith('a.png', 128)
    expect(close).toHaveBeenCalledOnce()
  })

  it('is null when there is no preview, no way to decode, or the decode fails', async () => {
    const decode = async () => ({ width: 3, height: 2 })
    expect(await pictureAspect(async () => null, 'a.png', decode)).toBeNull()
    expect(await pictureAspect(async () => new Blob([]), 'a.png', undefined)).toBeNull()
    expect(
      await pictureAspect(
        async () => new Blob([]),
        'a.png',
        async () => {
          throw new Error('broken')
        },
      ),
    ).toBeNull()
    expect(await pictureAspect(async () => new Blob([]), 'a.png', async () => ({ width: 0, height: 5 }))).toBeNull()
    expect(
      await pictureAspect(
        async () => {
          throw new Error('no thumbnails')
        },
        'a.png',
        decode,
      ),
    ).toBeNull()
  })
})

describe('previews for the cards', () => {
  /** Loads that finish when the test says so. */
  function rig(opts: { keep?: number; parallel?: number } = {}) {
    const pending = new Map<string, (blob: Blob | null) => void>()
    const loads: string[] = []
    const load = (path: string) =>
      new Promise<Blob | null>((resolve) => {
        loads.push(path)
        pending.set(path, resolve)
      })
    let n = 0
    const made: string[] = []
    const revoked: string[] = []
    const urls = new PreviewUrls(load, {
      ...opts,
      create: () => {
        const url = `blob:${++n}`
        made.push(url)
        return url
      },
      revoke: (u) => void revoked.push(u),
    })
    const finish = async (path: string, blob: Blob | null = new Blob([new Uint8Array(1)])) => {
      pending.get(path)?.(blob)
      pending.delete(path)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }
    return { urls, loads, made, revoked, finish }
  }

  it('gives the same URL to everyone who asks for a picture, and loads it once', async () => {
    const r = rig()
    const a = r.urls.acquire('a.png')
    const b = r.urls.acquire('a.png')
    await r.finish('a.png')
    expect(await a).toBe('blob:1')
    expect(await b).toBe('blob:1')
    expect(r.loads).toEqual(['a.png'])
    expect(await r.urls.acquire('a.png')).toBe('blob:1')
    expect(r.loads).toEqual(['a.png'])
  })

  it('fetches only a few at a time, in the order asked', async () => {
    const r = rig({ parallel: 2 })
    const got = ['a', 'b', 'c', 'd'].map((p) => r.urls.acquire(`${p}.png`))
    expect(r.loads).toEqual(['a.png', 'b.png'])
    await r.finish('a.png')
    expect(r.loads).toEqual(['a.png', 'b.png', 'c.png'])
    await r.finish('b.png')
    await r.finish('c.png')
    await r.finish('d.png')
    expect((await Promise.all(got)).every((u) => u !== null)).toBe(true)
  })

  it('does not fetch what nobody wants any more by the time its turn comes', async () => {
    const r = rig({ parallel: 1 })
    const a = r.urls.acquire('a.png')
    const b = r.urls.acquire('b.png')
    r.urls.release('b.png')
    await r.finish('a.png')
    expect(await a).not.toBeNull()
    expect(await b).toBeNull()
    expect(r.loads).toEqual(['a.png'])
  })

  it('keeps what is shown however many there are, and only a few idle ones, letting the oldest go', async () => {
    const r = rig({ keep: 2, parallel: 10 })
    const paths = ['a', 'b', 'c', 'd', 'e'].map((p) => `${p}.png`)
    const got = paths.map((p) => r.urls.acquire(p))
    for (const p of paths) await r.finish(p)
    await Promise.all(got)
    // All five are shown: none is let go.
    expect(r.revoked).toEqual([])
    expect(r.urls.size).toBe(5)
    // Scrolled past, in this order: the first three are the oldest idle ones beyond two.
    for (const p of paths) r.urls.release(p)
    expect(r.revoked).toEqual(['blob:1', 'blob:2', 'blob:3'])
    expect(r.urls.size).toBe(2)
    // Scrolling back to a kept one is free; to a lost one loads again.
    expect(await r.urls.acquire('e.png')).toBe('blob:5')
    expect(r.loads.filter((p) => p === 'e.png')).toHaveLength(1)
    void r.urls.acquire('a.png')
    expect(r.loads.filter((p) => p === 'a.png')).toHaveLength(2)
  })

  it('a picture still shown by one of two users stays when the other lets go', async () => {
    const r = rig({ keep: 0 })
    const a = r.urls.acquire('a.png')
    r.urls.acquire('a.png')
    await r.finish('a.png')
    await a
    r.urls.release('a.png')
    expect(r.revoked).toEqual([])
    r.urls.release('a.png')
    expect(r.revoked).toEqual(['blob:1'])
  })

  it('answers null for a picture with no preview, and asks again next time', async () => {
    const r = rig()
    const first = r.urls.acquire('a.png')
    await r.finish('a.png', null)
    expect(await first).toBeNull()
    const second = r.urls.acquire('a.png')
    expect(r.loads).toEqual(['a.png', 'a.png'])
    await r.finish('a.png')
    expect(await second).toBe('blob:1')
  })

  it('lets go of everything on dispose, drops a preview that arrives afterwards, and can be used again', async () => {
    const r = rig({ parallel: 1 })
    const a = r.urls.acquire('a.png')
    await r.finish('a.png')
    await a
    const late = r.urls.acquire('b.png')
    const waiting = r.urls.acquire('c.png')
    r.urls.dispose()
    expect(r.revoked).toEqual(['blob:1'])
    expect(r.urls.size).toBe(0)
    await r.finish('b.png')
    expect(await late).toBeNull()
    expect(await waiting).toBeNull()
    // The object that arrived after the dispose was revoked, not kept.
    expect(r.revoked).toEqual(['blob:1', 'blob:2'])
    expect(r.urls.size).toBe(0)
    const again = r.urls.acquire('a.png')
    await r.finish('a.png')
    expect(await again).toBe('blob:3')
  })

  it('treats a failing load as no preview', async () => {
    const urls = new PreviewUrls(async () => {
      throw new Error('boom')
    }, { create: () => 'x', revoke: () => undefined })
    expect(await urls.acquire('a.png')).toBeNull()
    expect(urls.size).toBe(0)
  })
})
