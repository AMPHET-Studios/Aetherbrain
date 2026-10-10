import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { visit } from 'unist-util-visit'
import { buildGraph } from '../src/graph/build'
import { splitFrontmatter } from '../src/markdown/frontmatter'
import { parseMarkdown, parseNote } from '../src/markdown/parse'
import { extractTasks } from '../src/markdown/tasks'
import {
  boardFolderName,
  boardPictureName,
  boardPictures,
  formatNumber,
  isBoardNote,
  newBoardNote,
  parseBoard,
  safeEmbedPath,
  serializeBoard,
} from '../src/board/format'
import { NOTE_LINE_HEIGHT_EM, BOARD_LIMITS, FULL_CROP, emptyBoard } from '../src/board/types'
import type { BoardDoc, BoardItem, NoteItem, PictureItem, StrokeItem } from '../src/board/types'
import { NOTE_PADDING, escapeBoardText, estimateTextMetrics, unescapeBoardText } from '../src/board/text'

/** 2026-10-09 14:35:12 local time (todayIso and the picture names read local time). */
const NOW = new Date(2026, 9, 9, 14, 35, 12)
const LATER = new Date(2026, 9, 12, 8, 0, 0)

function pic(over: Partial<PictureItem> = {}): PictureItem {
  return {
    id: 0,
    group: 0,
    locked: false,
    kind: 'picture',
    path: 'Boards/a.png',
    x: 0,
    y: 0,
    w: 100,
    h: 80,
    rotation: 0,
    crop: { ...FULL_CROP },
    flipH: false,
    flipV: false,
    gray: false,
    opacity: 1,
    caption: '',
    ...over,
  }
}

function note(over: Partial<NoteItem> = {}): NoteItem {
  return { id: 0, group: 0, locked: false, kind: 'note', text: 'hello', x: 0, y: 0, w: 300, size: 18, rotation: 0, color: 'ffffff', fill: '', ...over }
}

function stroke(over: Partial<StrokeItem> = {}): StrokeItem {
  return { id: 0, group: 0, locked: false, kind: 'stroke', points: [1, 2, 3, 4], color: 'ff0000', width: 2, ...over }
}

/** A board with ids assigned in order, as the reader would give them. */
function board(items: BoardItem[], over: Partial<BoardDoc> = {}): BoardDoc {
  return { ...emptyBoard('Test board'), ...over, items: items.map((it, i) => ({ ...it, id: i + 1 })), nextId: items.length + 1 }
}

/** The lines under the `## Board` heading that are not blank. */
function boardLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/)
  const rest = lines.slice(lines.indexOf('## Board') + 1)
  const end = rest.findIndex((l) => /^#{1,2} /.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.trim() !== '')
}

const VIEW = '- view x=0 y=0 zoom=1 bg=14161d gray=0 smooth=1 captions=0 grid=0'

/** The example of docs/design/reference-board.md, as written there. */
const CONTRACT_EXAMPLE = [
  '---',
  'title: Gate reference',
  'type: board',
  'created: "2026-10-09"',
  'updated: "2026-10-09"',
  '---',
  '# Gate reference',
  '',
  'Reference board. Open it from the Boards view (8). Everything under "Board" is rewritten by the board view; write anything else here or below.',
  '',
  '## Board',
  '',
  VIEW,
  '- ![[Boards/Gate reference/rust.png]] x=120 y=-40 w=640 h=480 r=3 flip=h crop=.1,.1,.9,.8 gray op=.8 lock g=2 » Rusted gate',
  '- pic Boards/odd#name.png x=-300 y=10 w=200 h=300',
  '- note x=10 y=10 w=300 size=18 color=ffffff fill=202530 r=0 » Check the edge\\nof the lintel \\[sic\\]',
  '- stroke color=ff5533 width=3 pts=12,34 13,36 15,40',
  '- line x1=0 y1=0 x2=100 y2=40 color=ffffff width=2 arrow',
  '- rect x1=0 y1=0 x2=100 y2=60 color=ffffff width=2 fill=',
  '- ellipse x1=0 y1=0 x2=100 y2=60 color=ffffff width=2 fill=',
  '',
].join('\n')

describe('board text: escaping', () => {
  const SPECIAL = '[]#<>|*_~!`'

  it('puts a backslash before each markup character and doubles the backslash', () => {
    for (const c of SPECIAL) expect(escapeBoardText(c)).toBe('\\' + c)
    expect(escapeBoardText('a\\b')).toBe('a\\\\b')
    expect(escapeBoardText('plain words 123, ok.')).toBe('plain words 123, ok.')
    expect(escapeBoardText('[[Secret]] #tag')).toBe('\\[\\[Secret\\]\\] \\#tag')
  })

  it('writes line breaks as \\n and \\r so the line stays one line', () => {
    expect(escapeBoardText('a\nb')).toBe('a\\nb')
    expect(escapeBoardText('a\r\nb')).toBe('a\\r\\nb')
    expect(escapeBoardText('\n\r\n\r')).not.toMatch(/[\r\n]/)
  })

  it('is exactly undone by unescape, for every character and every pair of special ones', () => {
    for (let code = 0; code < 0x3000; code++) {
      const s = String.fromCharCode(code)
      expect(unescapeBoardText(escapeBoardText(s))).toBe(s)
      expect(unescapeBoardText(escapeBoardText('a' + s + 'n'))).toBe('a' + s + 'n')
    }
    const specials = [...SPECIAL, '\\', '\n', '\r', 'n', 'r', ' ', 'a']
    for (const a of specials) {
      for (const b of specials) {
        for (const c of specials) {
          const s = a + b + c
          expect(unescapeBoardText(escapeBoardText(s))).toBe(s)
          expect(escapeBoardText(s)).not.toMatch(/[\r\n]/)
        }
      }
    }
    for (const s of ['\\n', '\\\\n', '\\\\\\', '😀[[x]]😀', '\ud800', 'x\udc00y', '日本語 ü', '']) expect(unescapeBoardText(escapeBoardText(s))).toBe(s)
  })

  it('reads hand-written text kindly: a backslash that escapes nothing stays a backslash', () => {
    expect(unescapeBoardText('a\\qb')).toBe('a\\qb')
    expect(unescapeBoardText('end\\')).toBe('end\\')
    expect(unescapeBoardText('\\[sic\\]')).toBe('[sic]')
    expect(unescapeBoardText('one\\ntwo')).toBe('one\ntwo')
    expect(unescapeBoardText('no backslash at all')).toBe('no backslash at all')
  })

  it('NOTE_PADDING is the contract name for the shared padding constant', () => {
    expect(NOTE_PADDING).toBe(0.5)
  })
})

describe('board text: estimated metrics', () => {
  const layout = (text: string, size: number, width: number) => estimateTextMetrics.layout(text, size, width)

  it('empty text is one empty line, and a line is 1.25 sizes high', () => {
    const l = layout('', 10, 100)
    expect(l.lines).toEqual([''])
    expect(l.width).toBe(0)
    expect(l.height).toBe(10 * NOTE_LINE_HEIGHT_EM)
  })

  it('a glyph is 0.55 of the size wide; width is the widest line, height is lines times line height', () => {
    const l = layout('hello', 10, 1000)
    expect(l.lines).toEqual(['hello'])
    expect(l.width).toBeCloseTo(5 * 5.5)
    expect(l.height).toBeCloseTo(12.5)
    const two = layout('hi\nthere', 20, 1000)
    expect(two.lines).toEqual(['hi', 'there'])
    expect(two.width).toBeCloseTo(5 * 11)
    expect(two.height).toBeCloseTo(2 * 20 * 1.25)
  })

  it('wraps greedily at spaces', () => {
    // 5.5 per glyph: 33 wide holds 6, 38.5 holds 7.
    expect(layout('aaa bbb ccc', 10, 33).lines).toEqual(['aaa', 'bbb', 'ccc'])
    expect(layout('aaa bbb ccc', 10, 38.5).lines).toEqual(['aaa bbb', 'ccc'])
    expect(layout('aaa bbb ccc', 10, 5.5 * 11).lines).toEqual(['aaa bbb ccc'])
    expect(layout('ab cd ef gh', 10, 5.5 * 5).lines).toEqual(['ab cd', 'ef gh'])
  })

  it('breaks a word wider than the line where it fills the line', () => {
    expect(layout('abcdefghij', 10, 5.5 * 4).lines).toEqual(['abcd', 'efgh', 'ij'])
    expect(layout('xx abcdefghij yy', 10, 5.5 * 4).lines).toEqual(['xx', 'abcd', 'efgh', 'ij', 'yy'])
  })

  it('honours line feeds, keeps empty lines, and never answers with no lines', () => {
    expect(layout('a\n\nb', 10, 1000).lines).toEqual(['a', '', 'b'])
    expect(layout('a\n', 10, 1000).lines).toEqual(['a', ''])
    for (const text of [' ', '\n', 'x', '   ', 'a\nb\n\n', '😀']) {
      for (const w of [0, 1, 5, -3, Number.NaN, Infinity]) expect(layout(text, 12, w).lines.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('puts at least one glyph on a line, however narrow', () => {
    expect(layout('abc', 10, 0.1).lines).toEqual(['a', 'b', 'c'])
    expect(layout('abc', 10, -5).lines).toEqual(['a', 'b', 'c'])
  })

  it('counts an emoji as one glyph and never splits it', () => {
    const l = layout('😀😀😀😀😀', 10, 5.5 * 2)
    expect(l.lines).toEqual(['😀😀', '😀😀', '😀'])
    expect(l.width).toBeCloseTo(2 * 5.5)
  })

  it('a bad size gives a zero-size layout, not a crash or an endless loop', () => {
    expect(layout('abc def', 0, 100).lines).toEqual(['abc def'])
    expect(layout('abc', Number.NaN, 100).height).toBe(0)
    expect(layout('abc', -4, 100).width).toBe(0)
  })
})

describe('board numbers', () => {
  it('at most the given decimals, trailing zeros and the zero before the point dropped, no exponent, no -0', () => {
    const cases: [number, number | undefined, string][] = [
      [0, undefined, '0'],
      [-0, undefined, '0'],
      [1, undefined, '1'],
      [100, undefined, '100'],
      [120, undefined, '120'],
      [1000000, undefined, '1000000'],
      [0.5, undefined, '.5'],
      [-0.5, undefined, '-.5'],
      [0.8, undefined, '.8'],
      [12.3456, undefined, '12.35'],
      [1.1, undefined, '1.1'],
      [1.999, undefined, '2'],
      [-0.001, undefined, '0'],
      [-0.004, undefined, '0'],
      [1e-7, undefined, '0'],
      [1e21, undefined, '1000000000000000'],
      [-1e300, undefined, '-1000000000000000'],
      [Number.NaN, undefined, '0'],
      [Infinity, undefined, '0'],
      [0.1234, 3, '.123'],
      [0.9996, 3, '1'],
      [0.005, 4, '.005'],
    ]
    for (const [n, dec, text] of cases) expect(formatNumber(n, dec), String(n)).toBe(text)
    expect(formatNumber(123456.789)).not.toMatch(/e/i)
  })
})

describe('the contract example', () => {
  const { doc, warnings } = parseBoard(CONTRACT_EXAMPLE)

  it('reads without a warning', () => {
    expect(warnings).toEqual([])
    expect(doc.title).toBe('Gate reference')
    expect(doc.items.map((i) => i.kind)).toEqual(['picture', 'picture', 'note', 'stroke', 'line', 'rect', 'ellipse'])
    expect(doc.items.map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(doc.nextId).toBe(8)
    expect(doc.extra).toEqual([])
    expect(doc.view).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(doc.bg).toBe('14161d')
    expect([doc.gray, doc.smooth, doc.captions, doc.grid]).toEqual([false, true, false, 0])
  })

  it('reads every attribute of the first picture', () => {
    expect(doc.items[0]).toEqual({
      id: 1,
      group: 1,
      locked: true,
      kind: 'picture',
      path: 'Boards/Gate reference/rust.png',
      x: 120,
      y: -40,
      w: 640,
      h: 480,
      rotation: 3,
      crop: { l: 0.1, t: 0.1, r: 0.9, b: 0.8 },
      flipH: true,
      flipV: false,
      gray: true,
      opacity: 0.8,
      caption: 'Rusted gate',
    })
  })

  it('reads a pic line, a note with escapes, a stroke and the shapes', () => {
    expect(doc.items[1]).toMatchObject({ kind: 'picture', path: 'Boards/odd#name.png', x: -300, y: 10, w: 200, h: 300, caption: '', opacity: 1, rotation: 0 })
    expect(doc.items[2]).toEqual({
      id: 3,
      group: 0,
      locked: false,
      kind: 'note',
      x: 10,
      y: 10,
      w: 300,
      size: 18,
      rotation: 0,
      color: 'ffffff',
      fill: '202530',
      text: 'Check the edge\nof the lintel [sic]',
    })
    expect(doc.items[3]).toMatchObject({ kind: 'stroke', color: 'ff5533', width: 3, points: [12, 34, 13, 36, 15, 40] })
    expect(doc.items[4]).toMatchObject({ kind: 'line', x1: 0, y1: 0, x2: 100, y2: 40, arrow: true })
    expect(doc.items[5]).toMatchObject({ kind: 'rect', x2: 100, y2: 60, fill: '' })
    expect(doc.items[6]).toMatchObject({ kind: 'ellipse', fill: '' })
  })

  it('writes it back the same, except the group number (renumbered from 1) and the # of the pic path (escaped)', () => {
    const expected = CONTRACT_EXAMPLE.replace('g=2', 'g=1').replace('odd#name', 'odd\\#name')
    expect(serializeBoard(doc, CONTRACT_EXAMPLE, NOW)).toBe(expected)
  })
})

describe('writing a board', () => {
  it('writes every kind and attribute exactly as the format says', () => {
    const doc = board(
      [
        pic({
          path: 'Boards/x y/ü.png',
          x: -0.5,
          y: 1000,
          w: 640,
          h: 480.25,
          rotation: -90,
          flipH: true,
          flipV: true,
          crop: { l: 0.1, t: 0.25, r: 0.875, b: 1 },
          gray: true,
          opacity: 0.5,
          locked: true,
          group: 7,
          caption: 'Cap [1]',
        }),
        pic({ path: 'Boards/a b#c.png', x: 5, y: 6, w: 8.5, h: 8 }),
        note({ text: 'a\nb', x: 1, y: 2, fill: '' }),
        note({ text: '', x: -1, y: 1.005, rotation: 30, fill: 'aabbcc', color: 'ff8800', group: 7 }),
        stroke({ points: [1, 2, 3.5, 4], width: 2.5, group: 7 }),
        { id: 0, group: 0, locked: true, kind: 'line', x1: 0, y1: 0, x2: 10, y2: -10.55, color: '00ff00', width: 1, arrow: true },
        { id: 0, group: 3, locked: false, kind: 'rect', x1: 1, y1: 2, x2: 3, y2: 4, color: '0000ff', width: 1, fill: 'ffff00' },
        { id: 0, group: 0, locked: false, kind: 'ellipse', x1: 1, y1: 2, x2: 3, y2: 4, color: '0000ff', width: 1, fill: '' },
      ],
      { view: { x: 12.5, y: -3, zoom: 0.25 }, bg: 'ff8800', gray: true, smooth: false, captions: true, grid: 20 },
    )
    expect(boardLines(serializeBoard(doc, undefined, NOW))).toEqual([
      '- view x=12.5 y=-3 zoom=.25 bg=ff8800 gray=1 smooth=0 captions=1 grid=20',
      '- ![[Boards/x y/ü.png]] x=-.5 y=1000 w=640 h=480.25 r=-90 flip=hv crop=.1,.25,.875,1 gray op=.5 lock g=1 » Cap \\[1\\]',
      '- pic Boards/a\\ b\\#c.png x=5 y=6 w=8.5 h=8',
      '- note x=1 y=2 w=300 size=18 color=ffffff fill= r=0 » a\\nb',
      '- note x=-1 y=1 w=300 size=18 color=ff8800 fill=aabbcc r=30 g=1',
      '- stroke color=ff0000 width=2.5 g=1 pts=1,2 3.5,4',
      '- line x1=0 y1=0 x2=10 y2=-10.55 color=00ff00 width=1 arrow lock',
      '- rect x1=1 y1=2 x2=3 y2=4 color=0000ff width=1 fill=ffff00 g=2',
      '- ellipse x1=1 y1=2 x2=3 y2=4 color=0000ff width=1 fill=',
    ])
  })

  it('renumbers group labels from 1 in order of first appearance, on every write', () => {
    const doc = board([pic({ group: 9 }), pic({ group: 0 }), pic({ group: 4 }), pic({ group: 9 }), pic({ group: 4 }), pic({ group: 100 })])
    const groups = boardLines(serializeBoard(doc, undefined, NOW))
      .slice(1)
      .map((l) => /g=(\d+)/.exec(l)?.[1] ?? '-')
    expect(groups).toEqual(['1', '-', '2', '1', '2', '3'])
    const back = parseBoard(serializeBoard(doc, undefined, NOW)).doc
    expect(back.items.map((i) => i.group)).toEqual([1, 0, 2, 1, 2, 3])
  })

  it('leaves out the defaults of a picture and writes opacity, crop and rotation only when they matter', () => {
    const line = boardLines(serializeBoard(board([pic({ rotation: 0, opacity: 1, crop: { l: 0, t: 0, r: 1, b: 1 } })]), undefined, NOW))[1]!
    expect(line).toBe('- ![[Boards/a.png]] x=0 y=0 w=100 h=80')
    // A crop that rounds away to nothing is no crop, and one that rounds to an empty area is dropped.
    expect(boardLines(serializeBoard(board([pic({ crop: { l: 0.0001, t: 0.2, r: 0.0004, b: 0.9 } })]), undefined, NOW))[1]).not.toContain('crop')
  })

  it('never writes an exponent, a negative zero, an unreadable colour or a number that is not finite', () => {
    const text = serializeBoard(
      board([note({ x: Number.NaN, y: -1e-9, w: Infinity, size: 1e30, color: '[[x]]', fill: 'nothex' }), stroke({ points: [1e40, -0, Number.NaN, 5] })]),
      undefined,
      NOW,
    )
    expect(boardLines(text).slice(1)).toEqual([
      '- note x=0 y=0 w=300 size=1000 color=ffffff fill= r=0 » hello',
      '- stroke color=ff0000 width=2 pts=1000000,0 0,5',
    ])
  })

  it('reorders nothing: items are written back to front in their own order', () => {
    const doc = board([note({ text: 'one' }), pic({ caption: 'two' }), note({ text: 'three' })])
    const lines = boardLines(serializeBoard(doc, undefined, NOW))
    expect(lines.map((l) => l.split(' » ')[1] ?? '')).toEqual(['', 'one', 'two', 'three'])
  })
})

describe('reading a board: clamps, defaults and warnings', () => {
  const read = (...itemLines: string[]) => parseBoard(['---', 'title: T', 'type: board', '---', '## Board', '', ...itemLines, ''].join('\n'))

  it('the view line sets the canvas; a missing one leaves the defaults; a second one is kept as written', () => {
    const r = read('- view x=-12.5 y=40 zoom=2.5 bg=AABBCC gray=1 smooth=0 captions=1 grid=16')
    expect(r.doc.view).toEqual({ x: -12.5, y: 40, zoom: 2.5 })
    expect([r.doc.bg, r.doc.gray, r.doc.smooth, r.doc.captions, r.doc.grid]).toEqual(['aabbcc', true, false, true, 16])
    expect(r.warnings).toEqual([])
    const none = read('- note x=1 y=2 w=300 size=18 color=ffffff fill= r=0')
    expect(none.doc.view).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(none.doc.smooth).toBe(true)
    const two = read('- view zoom=2', '- view zoom=3')
    expect(two.doc.view.zoom).toBe(2)
    expect(two.doc.extra).toEqual(['- view zoom=3'])
    expect(two.warnings.some((w) => /second view/.test(w))).toBe(true)
    expect(read('- view smooth').doc.smooth).toBe(true)
  })

  it('clamps coordinates, zoom, picture sizes, opacity, rotation, note and stroke sizes, each with a warning', () => {
    const r = read(
      '- view x=9999999999 y=-9999999999 zoom=1000',
      '- pic a.png x=2000000 y=-2000000 w=1 h=99999 op=0 r=190',
      '- pic b.png x=0 y=0 w=100 h=100 op=7 r=-180',
      '- pic c.png x=0 y=0 w=100 h=100 r=720',
      '- note x=0 y=0 w=2 size=0 color=ffffff fill= r=1e3',
      '- stroke color=ffffff width=0 pts=1,2',
      '- line x1=1 y1=1 x2=2 y2=2 color=ffffff width=5000',
    )
    expect(r.doc.view).toEqual({ x: 1_000_000, y: -1_000_000, zoom: BOARD_LIMITS.zoomMax })
    expect(r.doc.items[0]).toMatchObject({ x: 1_000_000, y: -1_000_000, w: BOARD_LIMITS.pictureMin, h: BOARD_LIMITS.pictureMax, opacity: 0.05, rotation: -170 })
    expect(r.doc.items[1]).toMatchObject({ opacity: 1, rotation: 180 })
    expect(r.doc.items[2]).toMatchObject({ rotation: 0 })
    expect(r.doc.items[3]).toMatchObject({ w: BOARD_LIMITS.pictureMin, size: 1, rotation: -80 })
    expect(r.doc.items[4]).toMatchObject({ width: 0.1 })
    expect(r.doc.items[5]).toMatchObject({ width: 1000 })
    expect(r.warnings.length).toBeGreaterThanOrEqual(8)
    const zoomLow = read('- view zoom=0')
    expect(zoomLow.doc.view.zoom).toBe(BOARD_LIMITS.zoomMin)
  })

  it('keeps a crop only when it leaves an area (l < r and t < b), else the full picture', () => {
    const crop = (c: string) => (read(`- pic a.png x=0 y=0 w=100 h=100 crop=${c}`).doc.items[0] as PictureItem).crop
    expect(crop('.1,.2,.9,.8')).toEqual({ l: 0.1, t: 0.2, r: 0.9, b: 0.8 })
    expect(crop('0.123456,0,1,1')).toEqual({ l: 0.123, t: 0, r: 1, b: 1 })
    for (const bad of ['.5,.5,.5,.9', '.9,.1,.2,.8', '.1,.6,.9,.6', '.1,.9,.9,.2', '1,0,0,1', '0,0,0,0', 'x,y,z,w', '.1,.2,.3', '.1,.2,.3,.4,.5', '']) {
      expect(crop(bad), bad).toEqual(FULL_CROP)
    }
    expect(crop('-1,-1,2,2')).toEqual(FULL_CROP)
    expect(crop('.2,0,5,1')).toEqual({ l: 0.2, t: 0, r: 1, b: 1 })
    expect(read('- pic a.png x=0 y=0 w=100 h=100 crop=.5,.5,.5,.9').warnings.length).toBe(1)
  })

  it('a bad value is replaced by its default for that attribute only, with a warning; the line stays', () => {
    const r = read('- note x=abc y=7 w=1e999 size=18 color=red fill=zzzzzz r=north g=-1 » kept')
    expect(r.doc.items[0]).toMatchObject({ x: 0, y: 7, w: 300, size: 18, color: 'ffffff', fill: '', rotation: 0, group: 0, text: 'kept' })
    expect(r.warnings.length).toBe(6)
    for (const w of r.warnings) expect(w).toMatch(/^line 7: /)
    const g = read('- pic a.png g=2.5', '- pic b.png g=abc')
    expect(g.doc.items.map((i) => i.group)).toEqual([0, 0])
    expect(read('- pic a.png flip=zz').doc.items[0]).toMatchObject({ flipH: false, flipV: false })
    expect(read('- pic a.png flip=vh').doc.items[0]).toMatchObject({ flipH: true, flipV: true })
    expect(read('- pic a.png flip=v').doc.items[0]).toMatchObject({ flipH: false, flipV: true })
  })

  it('reads colours with or without #, in any case', () => {
    const r = read('- note x=0 y=0 w=300 size=18 color=#FF8800 fill=AbCdEf r=0')
    expect(r.doc.items[0]).toMatchObject({ color: 'ff8800', fill: 'abcdef' })
    expect(r.warnings).toEqual([])
  })

  it('ignores unknown attributes and flags on a known line, with a warning, and keeps the line', () => {
    const r = read('- note x=1 y=2 w=300 size=18 color=ffffff fill= r=0 foo=bar blink lock » text')
    expect(r.doc.items).toHaveLength(1)
    expect(r.doc.items[0]).toMatchObject({ x: 1, y: 2, locked: true, text: 'text' })
    expect(r.warnings.filter((w) => /foo/.test(w))).toHaveLength(1)
    expect(r.warnings.filter((w) => /blink/.test(w))).toHaveLength(1)
    expect(r.doc.extra).toEqual([])
  })

  it('text on a kind with no text, and a points list on a non-stroke, are reported and not kept', () => {
    const r = read('- line x1=0 y1=0 x2=1 y2=1 color=ffffff width=2 » words', '- rect x1=0 y1=0 x2=1 y2=1 color=ffffff width=2 fill= pts=1,2')
    expect(r.doc.items).toHaveLength(2)
    expect(r.warnings.some((w) => /no text/.test(w))).toBe(true)
    expect(r.warnings.some((w) => /pts/.test(w))).toBe(true)
  })

  it('the text after the FIRST " » " is the text; later ones belong to it', () => {
    const r = read('- note x=0 y=0 w=300 size=18 color=ffffff fill= r=0 » one » two » three', '- pic a.png x=0 y=0 w=10 h=10 »')
    expect((r.doc.items[0] as NoteItem).text).toBe('one » two » three')
    expect((r.doc.items[1] as PictureItem).caption).toBe('')
  })

  it('cuts a note to 4,000 characters without splitting an emoji, and a stroke to 3,000 points', () => {
    const long = read(`- note x=0 y=0 w=300 size=18 color=ffffff fill= r=0 » ${'a'.repeat(5000)}`)
    expect((long.doc.items[0] as NoteItem).text).toHaveLength(4000)
    expect(long.warnings.some((w) => /4000/.test(w))).toBe(true)
    const split = read(`- note x=0 y=0 w=300 size=18 color=ffffff fill= r=0 » ${'a'.repeat(3999)}😀`)
    expect((split.doc.items[0] as NoteItem).text).toBe('a'.repeat(3999))
    const pts = Array.from({ length: 3005 }, (_, i) => `${i},${i}`).join(' ')
    const s = read(`- stroke color=ffffff width=2 pts=${pts}`)
    expect((s.doc.items[0] as StrokeItem).points).toHaveLength(6000)
    expect(s.warnings.some((w) => /5 points/.test(w))).toBe(true)
  })

  it('reads stroke points that are spread over spaces, skips a bad one, and takes flags written after them', () => {
    const s = read('- stroke color=ffffff width=2 pts=1,2 a,b 3.5,-4 lock g=3 ')
    expect((s.doc.items[0] as StrokeItem).points).toEqual([1, 2, 3.5, -4])
    expect(s.doc.items[0]).toMatchObject({ locked: true, group: 1 })
    expect(s.warnings).toHaveLength(1)
    expect((read('- stroke color=ffffff width=2 pts=').doc.items[0] as StrokeItem).points).toEqual([])
    expect((read('- stroke color=ffffff width=2').doc.items[0] as StrokeItem).points).toEqual([])
  })

  it('numbers may be written .5, -.5, 5., +5 or 1e2; anything else is not a number', () => {
    const r = read('- pic a.png x=.5 y=-.5 w=5. h=+50', '- pic b.png x=1e2 y=1,5 w=0x10 h=--5')
    expect(r.doc.items[0]).toMatchObject({ x: 0.5, y: -0.5, w: 8, h: 50 })
    expect(r.doc.items[1]).toMatchObject({ x: 100, y: 0, w: 200, h: 200 })
  })

  it('warnings name the line of the NOTE (frontmatter counted), and are capped', () => {
    const r = read('- note x=ok')
    expect(r.warnings).toEqual(['line 7: x="ok" is not a number, 0 used'])
    const many = read(...Array.from({ length: 200 }, () => '- note x=bad'))
    expect(many.warnings.length).toBe(51)
    expect(many.warnings[50]).toBe('and 150 more')
  })

  it('numbers its own items and sets nextId, whatever the file said', () => {
    const r = read('- pic a.png x=1 y=1 w=10 h=10', '- pic b.png x=1 y=1 w=10 h=10')
    expect(r.doc.items.map((i) => i.id)).toEqual([1, 2])
    expect(r.doc.nextId).toBe(3)
  })
})

describe('lines the reader does not understand are kept', () => {
  const RAW = [
    '---',
    'title: T',
    'type: board',
    '---',
    '## Board',
    '',
    '- note x=1 y=2 w=300 size=18 color=ffffff fill= r=0 » mine',
    'a hand-written remark',
    '- gizmo size=9 » from a newer version',
    '* a bullet of another kind',
    '-no-space',
    '   - indented item',
    '- ![[broken.png x=1',
    '- ![[a|b.png]] x=1',
    '- ![[]]',
    '- pic',
    '',
    '- stroke color=ffffff width=2 pts=1,2',
    '> a quote',
    '',
    '## After',
    'tail',
    '',
  ].join('\n')

  it('goes to doc.extra verbatim, in order, and is written back after the items', () => {
    const { doc, warnings } = parseBoard(RAW)
    expect(doc.items.map((i) => i.kind)).toEqual(['note', 'stroke'])
    expect(doc.extra).toEqual([
      'a hand-written remark',
      '- gizmo size=9 » from a newer version',
      '* a bullet of another kind',
      '-no-space',
      '   - indented item',
      '- ![[broken.png x=1',
      '- ![[a|b.png]] x=1',
      '- ![[]]',
      '- pic',
      '> a quote',
    ])
    // Plain remarks are normal; an item the reader should have understood is worth a word.
    expect(warnings.some((w) => /gizmo/.test(w))).toBe(true)
    expect(warnings.filter((w) => /kept as written/.test(w)).length).toBe(5)
    const out = serializeBoard(doc, RAW, NOW)
    expect(boardLines(out)).toEqual([
      VIEW,
      '- note x=1 y=2 w=300 size=18 color=ffffff fill= r=0 » mine',
      '- stroke color=ffffff width=2 pts=1,2',
      'a hand-written remark',
      '- gizmo size=9 » from a newer version',
      '* a bullet of another kind',
      '-no-space',
      '   - indented item',
      '- ![[broken.png x=1',
      '- ![[a|b.png]] x=1',
      '- ![[]]',
      '- pic',
      '> a quote',
    ])
    expect(out.endsWith('\n## After\ntail\n')).toBe(true)
    expect(parseBoard(out).doc.extra).toEqual(doc.extra)
    expect(serializeBoard(parseBoard(out).doc, out, LATER)).toBe(out)
  })

  it('a separating blank line keeps the extras out of the last item\'s paragraph', () => {
    const out = serializeBoard(parseBoard(RAW).doc, RAW, NOW)
    const lines = out.split('\n')
    const at = lines.indexOf('a hand-written remark')
    expect(lines[at - 1]).toBe('')
  })

  it('a code fence inside the section is kept whole, blank lines in it too, and hides the items it holds', () => {
    const raw = ['## Board', '', '- note x=1 y=2 w=300 size=18 color=ffffff fill= r=0 » before', '```js', '- note x=9 » not an item', '', '## not a heading', '```', '- note x=3 y=4 w=300 size=18 color=ffffff fill= r=0 » after', '## End', ''].join('\n')
    const { doc } = parseBoard(raw)
    expect(doc.items.map((i) => (i as NoteItem).text)).toEqual(['before', 'after'])
    expect(doc.extra).toEqual(['```js', '- note x=9 » not an item', '', '## not a heading', '```'])
    const out = serializeBoard(doc, raw, NOW)
    expect(out).toContain('```js\n- note x=9 » not an item\n\n## not a heading\n```')
    expect(serializeBoard(parseBoard(out).doc, out, LATER)).toBe(out)
  })

  it('a tilde fence is closed only by a tilde fence at least as long', () => {
    const raw = ['## Board', '~~~~', '```', '- note x=1 » inside', '~~~', '- note x=2 » still inside', '~~~~~', '- note x=3 y=3 w=300 size=18 color=ffffff fill= r=0 » out', ''].join('\n')
    const { doc } = parseBoard(raw)
    expect(doc.items.map((i) => (i as NoteItem).text)).toEqual(['out'])
    expect(doc.extra).toHaveLength(6)
  })

  it('a fence that is never closed holds the rest of the note: everything stays, nothing is read as an item', () => {
    const raw = ['## Board', '- note x=1 y=1 w=300 size=18 color=ffffff fill= r=0 » a', '```', '- note x=2 » b', '## Later', 'more', ''].join('\n')
    const { doc } = parseBoard(raw)
    expect(doc.items).toHaveLength(1)
    expect(doc.extra).toEqual(['```', '- note x=2 » b', '## Later', 'more'])
    const out = serializeBoard(doc, raw, NOW)
    expect(out.endsWith('```\n- note x=2 » b\n## Later\nmore\n')).toBe(true)
  })
})

describe('the board section in a whole note', () => {
  const FM = ['---', 'title: Gate', 'type: board', 'tags: [ref]', '# a comment', 'updated: "2026-01-01"', '---', ''].join('\n')

  function bodyOf(raw: string): string {
    return splitFrontmatter(raw).body
  }

  it('a note without a board section is an empty board; saving adds the heading at the end and changes nothing above', () => {
    const raw = `${FM}# Gate\n\nSome prose.\n\n## Other\n\ntext\n`
    const { doc, warnings } = parseBoard(raw)
    expect(warnings).toEqual([])
    expect(doc.items).toEqual([])
    expect(doc.title).toBe('Gate')
    const out = serializeBoard({ ...doc, items: [{ ...note({ text: 'n' }), id: 1 }], nextId: 2 }, raw, NOW)
    expect(bodyOf(out).startsWith(bodyOf(raw))).toBe(true)
    expect(bodyOf(out).slice(bodyOf(raw).length)).toBe(`\n## Board\n\n${VIEW}\n- note x=0 y=0 w=300 size=18 color=ffffff fill= r=0 » n\n`)
  })

  it('adds a blank line before the new heading only when there is none, and a final line break only when it is missing', () => {
    const empty = emptyBoard('Gate')
    const view = `## Board\n\n${VIEW}\n`
    expect(bodyOf(serializeBoard(empty, `${FM}text`, NOW))).toBe(`text\n\n${view}`)
    expect(bodyOf(serializeBoard(empty, `${FM}text\n`, NOW))).toBe(`text\n\n${view}`)
    expect(bodyOf(serializeBoard(empty, `${FM}text\n\n`, NOW))).toBe(`text\n\n${view}`)
    expect(bodyOf(serializeBoard(empty, `${FM}text\n\n\n\n`, NOW))).toBe(`text\n\n\n\n${view}`)
    expect(bodyOf(serializeBoard(empty, FM, NOW))).toBe(`\n${view}`)
  })

  it('merges into prose above and below byte for byte', () => {
    const above = '# Gate\n\nSome prose with **bold**, a [[link]] and a #tag.\n\n- a list\n- of things\n\n```\ncode\n```\n\n'
    const below = '\n\n## Notes after\n\nMore text.   \n\n\n# Another top heading\nend'
    const raw = `${FM}${above}## Board\n\n- note x=1 y=1 w=300 size=18 color=ffffff fill= r=0 » old${below}`
    const out = serializeBoard({ ...parseBoard(raw).doc, items: [{ ...pic({ path: 'P/new.png' }), id: 1 }], nextId: 2 }, raw, NOW)
    expect(bodyOf(out)).toBe(`${above}## Board\n\n${VIEW}\n- ![[P/new.png]] x=0 y=0 w=100 h=80${below}`)
  })

  it('the blank lines between the section and the next heading are not part of the section', () => {
    const raw = `${FM}## Board\n${VIEW}\n\n\n\n## Next\n`
    expect(bodyOf(serializeBoard(emptyBoard('Gate'), raw, NOW))).toBe(`## Board\n\n${VIEW}\n\n\n\n## Next\n`)
  })

  it('only the first "## Board" is the board; the second heading and its lines stay note text', () => {
    const raw = FM + ['# T', '## Board', '- note x=1 y=1 w=300 size=18 color=ffffff fill= r=0 » first', '## Board', '- note x=2 y=2 w=300 size=18 color=ffffff fill= r=0 » second', ''].join('\n')
    const { doc } = parseBoard(raw)
    expect(doc.items.map((i) => (i as NoteItem).text)).toEqual(['first'])
    const out = serializeBoard({ ...doc, title: 'Gate', items: [{ ...note({ text: 'changed' }), id: 1 }] }, raw, NOW)
    expect(bodyOf(out)).toBe(['# T', '## Board', '', VIEW, '- note x=0 y=0 w=300 size=18 color=ffffff fill= r=0 » changed', '## Board', '- note x=2 y=2 w=300 size=18 color=ffffff fill= r=0 » second', ''].join('\n'))
  })

  it('"## Board" must be a level-2 heading with exactly that text: other spellings are not the board', () => {
    for (const heading of ['## board', '### Board', '# Board', '## Boards', '## Board games', '##Board', 'Board', '    ## Board', '> ## Board']) {
      const raw = `${heading}\n- note x=1 y=1 w=300 size=18 color=ffffff fill= r=0 » hidden\n`
      expect(parseBoard(raw).doc.items, heading).toEqual([])
    }
    for (const heading of ['## Board', '## Board  ', '## Board ##', '   ## Board', '##\tBoard']) {
      const raw = `${heading}\n- note x=1 y=1 w=300 size=18 color=ffffff fill= r=0 » seen\n`
      expect(parseBoard(raw).doc.items, heading).toHaveLength(1)
    }
  })

  it('a heading inside a code fence is not the board, and a "## " inside a fence does not end the section', () => {
    const raw = FM + ['```', '## Board', '- note x=1 y=1 w=300 size=18 color=ffffff fill= r=0 » decoy', '```', '', '~~~md', '## Board', '~~~', '', '## Board', '- note x=2 y=2 w=300 size=18 color=ffffff fill= r=0 » real', '```', '# Title in a fence', '## Fence ends nothing', '```', '- note x=3 y=3 w=300 size=18 color=ffffff fill= r=0 » also real', '# Real end', '- note x=4 » not mine', ''].join('\n')
    const { doc } = parseBoard(raw)
    expect(doc.items.map((i) => (i as NoteItem).text)).toEqual(['real', 'also real'])
    expect(doc.extra).toEqual(['```', '# Title in a fence', '## Fence ends nothing', '```'])
    const out = serializeBoard({ ...doc, title: 'Gate' }, raw, NOW)
    expect(bodyOf(out).startsWith(bodyOf(raw).slice(0, bodyOf(raw).indexOf('## Board\n- note x=2')))).toBe(true)
    expect(out.endsWith('# Real end\n- note x=4 » not mine\n')).toBe(true)
  })

  it('a code fence the note never closes is closed before the new heading, so the board is found again', () => {
    const raw = `${FM}text\n\n\`\`\`js\nunclosed\n`
    const out = serializeBoard(board([note({ text: 'n' })]), raw, NOW)
    expect(bodyOf(out)).toBe(`text\n\n\`\`\`js\nunclosed\n\`\`\`\n\n## Board\n\n${VIEW}\n- note x=0 y=0 w=300 size=18 color=ffffff fill= r=0 » n\n`)
    expect(parseBoard(out).doc.items).toHaveLength(1)
    const tilde = serializeBoard(board([note({ text: 'n' })]), `${FM}~~~~\nx`, NOW)
    expect(bodyOf(tilde)).toContain('x\n~~~~\n\n## Board')
  })

  it('CRLF notes keep CRLF everywhere, including the new section and the frontmatter lines', () => {
    const lf = `${FM}# Gate\n\nprose\n\n## Board\n\n${VIEW}\n- note x=1 y=1 w=300 size=18 color=ffffff fill= r=0 » old\n\n## After\ntail\n`
    const raw = lf.replace(/\n/g, '\r\n')
    const { doc } = parseBoard(raw)
    expect(doc.items).toHaveLength(1)
    const out = serializeBoard({ ...doc, items: [...doc.items, { ...pic({ caption: 'two\nlines' }), id: 2 }], nextId: 3 }, raw, NOW)
    expect(out).not.toMatch(/[^\r]\n/)
    expect(out).toContain('updated: "2026-10-09"\r\n')
    expect(bodyOf(out).startsWith(bodyOf(raw).slice(0, bodyOf(raw).indexOf('## Board')))).toBe(true)
    expect(out.endsWith('\r\n\r\n## After\r\ntail\r\n')).toBe(true)
    expect(parseBoard(out).doc.items).toHaveLength(2)
    // An unchanged board is not rewritten at all.
    expect(serializeBoard(parseBoard(out).doc, out, LATER)).toBe(out)
  })

  it('a byte-order mark stays the first thing in the file', () => {
    const raw = `\uFEFF${FM}text\n\n## Board\n${VIEW}\n`
    expect(isBoardNote(raw)).toBe(true)
    const out = serializeBoard(board([note({ text: 'n' })]), raw, NOW)
    expect(out.startsWith('\uFEFF---\n')).toBe(true)
    expect(out.indexOf('\uFEFF', 1)).toBe(-1)
    expect(parseBoard(out).doc.items).toHaveLength(1)
    const bare = serializeBoard(board([]), '\uFEFF# Plain\n', NOW)
    expect(bare.startsWith('\uFEFF---\n')).toBe(true)
    expect(bare.indexOf('\uFEFF', 1)).toBe(-1)
  })

  it('a note without a final line break stays without one; the heading as the last line gets its break', () => {
    const noBreak = `${FM}## Board\n${VIEW}\n- note x=1 y=1 w=300 size=18 color=ffffff fill= r=0 » a`
    const out = serializeBoard(board([note({ text: 'b' })]), noBreak, NOW)
    expect(out.endsWith('» b')).toBe(true)
    const headingLast = serializeBoard(board([note({ text: 'b' })]), `${FM}## Board`, NOW)
    expect(bodyOf(headingLast)).toBe(`## Board\n\n${VIEW}\n- note x=0 y=0 w=300 size=18 color=ffffff fill= r=0 » b`)
    expect(parseBoard(headingLast).doc.items).toHaveLength(1)
  })

  it('a note whose frontmatter cannot be parsed is not touched, and is no board note', () => {
    const broken = ['---', 'title: [unclosed', 'type: board', '---', '## Board', '', VIEW, ''].join('\n')
    expect(isBoardNote(broken)).toBe(false)
    expect(serializeBoard(board([note({ text: 'x' })], { title: 'Other' }), broken, NOW)).toBe(broken)
    const parsed = parseBoard(broken)
    expect(parsed.warnings.some((w) => /frontmatter/.test(w))).toBe(true)
    const colon = ['---', 'a: b: c', 'type: board', '---', 'body', ''].join('\n')
    expect(serializeBoard(board([]), colon, NOW)).toBe(colon)
    // A list instead of a mapping is no frontmatter either.
    const list = ['---', '- one', '- two', '---', 'body', ''].join('\n')
    expect(serializeBoard(board([]), list, NOW)).toBe(list)
  })

  it('comments and empty frontmatter blocks are not "broken"', () => {
    const empty = '---\n# nothing here\n---\nbody\n'
    expect(serializeBoard(board([]), empty, NOW)).not.toBe(empty)
    expect(parseBoard(empty).warnings).toEqual([])
  })

  it('patches title, type and updated in place and nothing else of the frontmatter', () => {
    const raw = ['---', '# my comment', 'title:   Old name  ', 'type: note', 'version: 1.10', 'tags: [a, b]', 'updated: 2026-01-01', '---', '# Heading stays', '', '## Board', '', VIEW, ''].join('\n')
    const out = serializeBoard(board([note({ text: 'x' })], { title: 'New: name' }), raw, NOW)
    expect(out.split('\n').slice(0, 9)).toEqual(['---', '# my comment', 'title: "New: name"', 'type: board', 'version: 1.10', 'tags: [a, b]', 'updated: "2026-10-09"', '---', '# Heading stays'])
  })

  it('does not touch the title when it is the one the note already has, even from its first heading', () => {
    const raw = ['# Only a heading', '', '## Board', '', VIEW, ''].join('\n')
    expect(parseBoard(raw).doc.title).toBe('Only a heading')
    const out = serializeBoard({ ...parseBoard(raw).doc, items: [{ ...note(), id: 1 }] }, raw, NOW)
    expect(out.startsWith('---\ntype: board\nupdated: "2026-10-09"\n---\n')).toBe(true)
    expect(out).not.toContain('title:')
  })

  it('a title with a double space is the title the note has, not a rename: an unchanged board is still given back as it was', () => {
    const raw = ['---', 'title: "Gate  reference"', 'type: board', 'updated: "2026-01-01"', '---', '## Board', '', VIEW, ''].join('\n')
    const { doc } = parseBoard(raw)
    expect(doc.title).toBe('Gate  reference')
    expect(serializeBoard(doc, raw, NOW)).toBe(raw)
    expect(serializeBoard(doc, raw)).toBe(raw)
  })

  it('without a clock argument it stamps today', () => {
    const out = serializeBoard(board([note()], { title: 'Gate' }), newBoardNote('Gate', NOW))
    expect(out).toMatch(/\nupdated: "\d{4}-\d{2}-\d{2}"\n/)
    expect(out).toContain('created: "2026-10-09"')
  })

  it('saving a board that did not change returns the note itself, and does not move "updated"', () => {
    const fresh = newBoardNote('Gate', NOW)
    const doc = parseBoard(fresh).doc
    expect(serializeBoard(doc, fresh, LATER)).toBe(fresh)
    const edited = serializeBoard(board([note()], { title: 'Gate' }), fresh, LATER)
    expect(edited).toContain('updated: "2026-10-12"')
    expect(edited).toContain('created: "2026-10-09"')
    expect(serializeBoard(parseBoard(edited).doc, edited, new Date(2030, 0, 1))).toBe(edited)
  })

  it('without raw it writes a fresh note', () => {
    const doc = board([note({ text: 'n' })], { title: 'Fresh one' })
    const out = serializeBoard(doc, undefined, NOW)
    expect(out.startsWith(newBoardNote('Fresh one', NOW).split('## Board')[0]!)).toBe(true)
    expect(isBoardNote(out)).toBe(true)
    expect(parseBoard(out).doc.items).toHaveLength(1)
  })

  it('an empty doc title never blanks the note title', () => {
    const raw = newBoardNote('Keep me', NOW)
    const out = serializeBoard(board([note()], { title: '  ' }), raw, NOW)
    expect(parseBoard(out).doc.title).toBe('Keep me')
  })
})

describe('limits', () => {
  const noteLine = (i: number) => `- note x=${i} y=0 w=100 size=18 color=ffffff fill= r=0 » n${i}`
  const rawWith = (n: number) => ['---', 'title: Big', 'type: board', '---', '## Board', '', ...Array.from({ length: n }, (_, i) => noteLine(i + 1)), ''].join('\n')

  it('1,500 items are read; the 1,501st is cut from the board, warned about, and kept in the file as an extra', () => {
    const exact = parseBoard(rawWith(1500))
    expect(exact.doc.items).toHaveLength(1500)
    expect(exact.warnings).toEqual([])
    const over = parseBoard(rawWith(1501))
    expect(over.doc.items).toHaveLength(BOARD_LIMITS.items)
    expect(over.doc.items[1499]).toMatchObject({ id: 1500, text: 'n1500' })
    expect(over.doc.nextId).toBe(1501)
    expect(over.doc.extra).toEqual([noteLine(1501)])
    expect(over.warnings).toEqual(['The board holds 1501 items; the first 1500 are shown and the rest are kept in the file.'])
    // Saving keeps the extra line; it is still not an item next time.
    const out = serializeBoard(over.doc, rawWith(1501), NOW)
    expect(out).toContain(noteLine(1501))
    expect(parseBoard(out).doc.items).toHaveLength(1500)
    expect(serializeBoard(parseBoard(out).doc, out, LATER)).toBe(out)
    // Room again: the kept line comes back as an item.
    const room = serializeBoard({ ...over.doc, items: over.doc.items.slice(1) }, out, NOW)
    expect(parseBoard(room).doc.items).toHaveLength(1500)
    expect(parseBoard(room).doc.extra).toEqual([])
  })

  it('a doc with more than 1,500 items is written without losing one, and reads back the same on the second pass', () => {
    const items = Array.from({ length: 1503 }, (_, i) => note({ text: `t${i + 1}`, x: i }))
    const text = serializeBoard(board(items), undefined, NOW)
    expect(text).toContain('» t1503')
    const again = parseBoard(text)
    expect(again.doc.items).toHaveLength(1500)
    expect(again.doc.extra).toHaveLength(3)
    expect(serializeBoard(again.doc, text, LATER)).toBe(text)
  })

  it('a note over 300,000 characters is read (and warned about), not refused', () => {
    const raw = rawWith(10) + 'x'.repeat(300_001)
    const r = parseBoard(raw)
    expect(r.doc.items.length).toBeGreaterThan(0)
    expect(r.warnings.some((w) => /300000/.test(w))).toBe(true)
  })
})

describe('safeEmbedPath', () => {
  it('ordinary paths, with spaces, unicode, dots, digits and single markup characters, can be embedded', () => {
    for (const p of [
      'a.png',
      'Boards/Gate reference/rust.png',
      'Boards/My Board/ref 2026-10-09 143512.png',
      'Größe ü/日本語 写真.jpg',
      'D/Pictures/😀 smile.webp',
      'a_b.png',
      'my_pic_2.PNG',
      'a__b.png',
      'a (1).png',
      'x/y/z.v2.final.avif',
      "it's.gif",
      'a&b.png',
      'a & b.png',
      '100%.png',
      'a+b=c.bmp',
      'a  b.png',
      '1.png',
      'x/_.png',
    ]) {
      expect(safeEmbedPath(p), p).toBe(true)
    }
  })

  it('# | [ ] < > and a space at either end can never be embedded', () => {
    for (const p of ['a#b.png', 'a|b.png', 'a[b.png', 'a]b.png', 'a<b.png', 'a>b.png', ' a.png', 'a.png ', '\ta.png', 'a.png\n', '', ' ', '[[x]].png', '#tag.png', 'a/#b/c.png']) {
      expect(safeEmbedPath(p), JSON.stringify(p)).toBe(false)
    }
  })

  it('a flanking _ * ~ that would pair up into emphasis or strikethrough is not safe; a lone one is', () => {
    for (const p of ['_a_.png', '_a.png/_b_.png', 'a _b_ c.png', 'x/_y_/z.png', 'a*b*c.png', '*a*.png', '**a**.png', 'a~b~c.png', '~~a~~.png', 'a~~b~~.png', 'a_b _c_.png', 'a_ b_c.png', '__a__.png']) {
      expect(safeEmbedPath(p), p).toBe(false)
    }
    for (const p of ['a*b.png', 'a~b.png', '_a.png', 'a_.png', 'a_b_c.png']) expect(safeEmbedPath(p), p).toBe(true)
  })

  it('other things a markdown parser would change are not embedded: backslash, backtick, control characters, references, addresses, non-pictures', () => {
    for (const p of ['a\\b.png', 'a`b.png', 'a\u0000b.png', 'a\u001fb.png', 'a\u007fb.png', 'a\u2028b.png', 'a&amp;b.png', 'a&#91;b.png', 'a&lt;b.png', 'http://x.png', 'a/https://b.png', 'www.x.com/a.png', 'my www.x.png', 'photo@2x.png', 'me@x.com.png', 'notes.txt', 'folder/Secret', 'a.png.md', 'x.svg']) {
      expect(safeEmbedPath(p), JSON.stringify(p)).toBe(false)
    }
  })

  it('what it calls safe really comes back from the real markdown parser as that one embed (a table of tricky names)', () => {
    const names = [
      'a.png', 'Boards/x y/ü.png', 'a_b.png', 'a__b.png', 'a*b.png', 'a~b.png', '_a.png', 'a_.png', 'a_b_c.png', 'x/_/y.png', 'a (1).png', 'a&b.png', 'a & b.png', 'a:b.png', 'https.png', 'a/ftp.png',
      'photo@2x.png', 'a@b.png', 'a b@c d.png', 'www.png', 'a www.png', '😀_😀.png', 'a_😀_b.png', '- a.png', '1. a.png', '+ a.png', '> a.png', '= a.png', '    a.png', 'a  b.png', '!a.png', 'a!.png',
    ]
    for (const p of names) {
      if (!safeEmbedPath(p)) continue
      const n = parseNote({ path: 'Boards/b.md', content: serializeBoard(board([pic({ path: p })]), undefined, NOW) })
      expect(n.links.map((l) => [l.kind, l.to]), p).toEqual([['embed', p]])
    }
  })

  it('writes an unsafe path as a pic line with no link, and a safe one as an embed', () => {
    const text = serializeBoard(board([pic({ path: 'Boards/a b.png' }), pic({ path: 'Boards/a#b [1].png' }), pic({ path: 'Boards/_a_.png' })]), undefined, NOW)
    const lines = boardLines(text).slice(1)
    expect(lines[0]).toBe('- ![[Boards/a b.png]] x=0 y=0 w=100 h=80')
    expect(lines[1]).toBe('- pic Boards/a\\#b\\ \\[1\\].png x=0 y=0 w=100 h=80')
    expect(lines[2]).toBe('- pic Boards/\\_a\\_.png x=0 y=0 w=100 h=80')
    const n = parseNote({ path: 'Boards/b.md', content: text })
    expect(n.links.map((l) => l.to)).toEqual(['Boards/a b.png'])
    // And they read back as the same paths.
    expect(parseBoard(text).doc.items.map((i) => (i as PictureItem).path)).toEqual(['Boards/a b.png', 'Boards/a#b [1].png', 'Boards/_a_.png'])
  })

  it('a path holding " » ", spaces, backslashes and escapes survives, embedded or as pic', () => {
    for (const path of ['a » b.png', 'a » b#.png', 'x\\ » y.png', 'trail\\.png', 'a\\\\ b.png', '\\ .png', 'a\\n b.png', 'ü » 日本 [x].png']) {
      const text = serializeBoard(board([pic({ path, caption: ' » cap » tion ' }), note({ text: 'next' })]), undefined, NOW)
      const back = parseBoard(text)
      expect(back.warnings, path).toEqual([])
      expect(back.doc.items[0], path).toMatchObject({ path, caption: ' » cap » tion ' })
      expect(back.doc.items[1]).toMatchObject({ text: 'next' })
    }
  })

  it('an empty path is kept as a pic line with an empty path', () => {
    const text = serializeBoard(board([pic({ path: '', caption: 'c' })]), undefined, NOW)
    expect(boardLines(text)[1]).toBe('- pic  x=0 y=0 w=100 h=80 » c')
    expect(parseBoard(text).doc.items[0]).toMatchObject({ path: '', caption: 'c' })
  })

  it('reads an embed with a path the format would not have embedded (a hand edit) and writes it the safe way', () => {
    const raw = ['## Board', '- ![[sub/_odd_.png]] x=1 y=2 w=30 h=40', ''].join('\n')
    const { doc, warnings } = parseBoard(raw)
    expect(warnings).toEqual([])
    expect((doc.items[0] as PictureItem).path).toBe('sub/_odd_.png')
    expect(boardLines(serializeBoard(doc, raw, NOW))[1]).toBe('- pic sub/\\_odd\\_.png x=1 y=2 w=30 h=40')
  })
})

describe('boardPictures', () => {
  it('lists the distinct picture paths in order of first appearance, safe to embed or not', () => {
    const doc = board([pic({ path: 'b.png' }), note(), pic({ path: 'a#.png' }), pic({ path: 'b.png' }), pic({ path: 'c.png' }), pic({ path: 'a#.png' })])
    expect(boardPictures(doc)).toEqual(['b.png', 'a#.png', 'c.png'])
    expect(boardPictures(board([note()]))).toEqual([])
  })
})

describe('isBoardNote and newBoardNote', () => {
  it('is true only for frontmatter type exactly "board"', () => {
    expect(isBoardNote('---\ntype: board\n---\n')).toBe(true)
    expect(isBoardNote('---\ntitle: x\r\ntype: board\r\n---\r\n')).toBe(true)
    expect(isBoardNote('\uFEFF---\ntype: board\n---\n')).toBe(true)
    expect(isBoardNote('---\ntype: "board"\n---\n')).toBe(true)
    for (const raw of ['', 'type: board', '---\ntype: Board\n---\n', '---\ntype: boards\n---\n', '---\ntype: [board]\n---\n', '---\ntype: note\n---\n## Board\n', '# T\n\ntype: board\n', '---\ntype: board', '---\ntype: [board\n---\n', '---\ntitle: x\n---\n', '---\n---\n']) {
      expect(isBoardNote(raw), JSON.stringify(raw)).toBe(false)
    }
  })

  it('makes the note of the contract', () => {
    expect(newBoardNote('Gate reference', NOW)).toBe(CONTRACT_EXAMPLE.slice(0, CONTRACT_EXAMPLE.indexOf(VIEW) + VIEW.length + 1))
  })

  it('a new note is a board with no items, whose title reads back, however odd the title', () => {
    for (const title of ['Gate reference', 'A: "b" [c] #d', 'yes', 'null', '123', '2026-10-09', '- dash', '日本 ü 😀', "it's", 'x\ny\tz', '  padded  ', '[[Secret]]', '#tag', '**bold**']) {
      const raw = newBoardNote(title, NOW)
      expect(isBoardNote(raw), title).toBe(true)
      const { doc, warnings } = parseBoard(raw)
      expect(warnings, title).toEqual([])
      expect(doc.title, title).toBe(title.replace(/\s+/g, ' ').trim())
      expect(doc.items).toEqual([])
      const n = parseNote({ path: 'Boards/x.md', content: raw })
      expect(n.links, title).toEqual([])
      expect(n.inlineTags, title).toEqual([])
      expect(serializeBoard(doc, raw, LATER), title).toBe(raw)
    }
    expect(parseBoard(newBoardNote('', NOW)).doc.title).toBe('Board')
    expect(parseBoard(newBoardNote('   ', NOW)).doc.title).toBe('Board')
  })

  it('stamps created and updated with the local date of now', () => {
    expect(newBoardNote('x', new Date(2026, 0, 2, 23, 59, 59))).toContain('created: "2026-01-02"\nupdated: "2026-01-02"')
  })
})

describe('what a board note does to the brain: imported text stays inert', () => {
  const HOSTILE = [
    '[[Secret]]',
    '![[pic.png]]',
    '[[Secret|alias]]',
    '[[Secret#Heading]]',
    '#tag',
    ' #tag more',
    'x (#tag) y',
    '- [ ] task',
    '- [x] done',
    '\n- [ ] on its own line',
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<!--',
    '-->',
    '<!-- hidden -->',
    '`code`',
    '```\nfence\n```',
    '~~~\nfence\n~~~',
    '| table |\n|---|---|\n| a | b |',
    '*bold* **b** ***bi***',
    '_x_ __y__',
    '~~y~~ ~z~',
    '# heading\n## heading 2',
    '> quote',
    '1. one\n2. two',
    '    indented code',
    '***',
    '---',
    '===',
    '[ref]: http://example.com',
    '[a](http://b.example)',
    '![img](http://i.example/x.png)',
    '\\[[Secret]]',
    '[[Se\\cret]]',
    '&#91;&#91;Secret&#93;&#93;',
    '&#x5B;&#x5B;Secret&#x5D;&#x5D;',
    '&lbrack;&lbrack;Secret&rbrack;&rbrack; &num;tag',
    '&lt;script&gt;',
    '[^1]: footnote',
    ' » ',
    'trailing backslash\\',
    '\u2028line separator\u2029',
    'a\r\nb\r\n- [ ] c\rd',
    '*'.repeat(5000),
    '_'.repeat(5000),
    '[['.repeat(3000),
  ]

  /** A board whose notes and captions are all hostile, with embedded and unembeddable pictures. */
  function hostileDoc(): BoardDoc {
    const items: BoardItem[] = []
    for (const [i, text] of HOSTILE.entries()) {
      items.push(note({ text, x: i }))
      items.push(pic({ path: `Boards/pic ${i}.png`, caption: text, x: i }))
    }
    items.push(pic({ path: 'Boards/[[Secret]].png' }), pic({ path: 'Boards/#tag.png' }), pic({ path: 'Boards/a|b.png' }), pic({ path: 'Boards/<script>.png' }), pic({ path: 'Boards/- [ ] t.png' }), pic({ path: 'Boards/`c`.png' }))
    return board(items, { title: 'Hostile' })
  }

  function checkInert(raw: string, embedded: string[]): void {
    const n = parseNote({ path: 'Boards/Hostile.md', content: raw })
    expect(n.links.map((l) => [l.kind, l.to])).toEqual(embedded.map((p) => ['embed', p]))
    expect(n.inlineTags).toEqual([])
    expect(n.meta.tags).toEqual([])
    expect(extractTasks(raw)).toEqual([])
    const graph = buildGraph(new Map([[n.meta.id, n]]))
    expect(graph.nodes.filter((x) => x.ghost)).toEqual([])
    expect(graph.nodes).toHaveLength(1)

    // The markdown tree: a title, the intro, "Board", and ONE list of single-paragraph items. No html, code, table, quote, break,
    // image, link, reference or heading came out of the text.
    const tree = parseMarkdown(n.body)
    expect(tree.children.map((c) => c.type)).toEqual(['heading', 'paragraph', 'heading', 'list'])
    const types = new Set<string>()
    visit(tree, (node) => {
      types.add(node.type)
    })
    for (const forbidden of ['html', 'code', 'inlineCode', 'table', 'blockquote', 'thematicBreak', 'image', 'imageReference', 'linkReference', 'definition', 'footnoteDefinition', 'footnoteReference', 'break', 'yaml', 'emphasis', 'strong', 'delete']) {
      expect(types.has(forbidden), forbidden).toBe(false)
    }
    // A web address written in the text is still turned into a link by GFM's autolink literals (nothing in the brain follows it), but
    // a `[text](address)` is never made: a link node's text is the address itself.
    visit(tree, 'link', (node) => {
      const first = node.children[0]
      expect(first?.type === 'text' && node.url.endsWith(first.value), node.url).toBe(true)
    })
    const list = tree.children[3]
    if (list?.type !== 'list') throw new Error('no list')
    for (const li of list.children) {
      expect(li.children.map((c) => c.type)).toEqual(['paragraph'])
    }
  }

  it('the only links parseNote finds are the embeds the board wrote; no tags, tasks, ghosts, html or blocks', () => {
    const doc = hostileDoc()
    const raw = serializeBoard(doc, undefined, NOW)
    const embedded = doc.items.filter((i): i is PictureItem => i.kind === 'picture' && safeEmbedPath(i.path)).map((i) => i.path)
    expect(embedded).toHaveLength(HOSTILE.length)
    checkInert(raw, embedded)
  })

  it('the same inside a CRLF note', () => {
    const doc = hostileDoc()
    const embedded = doc.items.filter((i): i is PictureItem => i.kind === 'picture' && safeEmbedPath(i.path)).map((i) => i.path)
    const crlf = newBoardNote('Hostile', NOW).replace(/\n/g, '\r\n')
    checkInert(serializeBoard(doc, crlf, NOW), embedded)
  })

  it('every line under the board heading is one list line; no raw line break or carriage return survives in the text', () => {
    const doc = hostileDoc()
    const raw = serializeBoard(doc, undefined, NOW)
    const lines = boardLines(raw)
    expect(lines).toHaveLength(doc.items.length + 1)
    for (const l of lines) expect(l.startsWith('- '), l.slice(0, 40)).toBe(true)
    expect(raw).not.toContain('\r')
    // In the source, once escaped characters and the embeds the board wrote are taken out, no markup character is left to be read.
    for (const l of lines) {
      const bare = l.replace(/\\[\s\S]/g, '').replace(/!\[\[[^\]]*\]\]/g, '')
      expect(bare, l.slice(0, 60)).not.toMatch(/[[\]#<>|*_~!`]/)
    }
    // Back again, exactly.
    const back = parseBoard(raw)
    expect(back.warnings.filter((w) => !/4000/.test(w))).toEqual([])
    expect(back.doc.items.map((i) => (i.kind === 'note' ? i.text : i.kind === 'picture' ? i.caption : ''))).toEqual(
      doc.items.map((i) => (i.kind === 'note' ? i.text.slice(0, 4000) : i.kind === 'picture' ? i.caption.slice(0, 4000) : '')),
    )
  })

  it('a hostile board TITLE stays inert in the heading and the frontmatter too', () => {
    const raw = newBoardNote('[[Secret]] #tag <b>x</b> `y`', NOW)
    const n = parseNote({ path: 'Boards/x.md', content: raw })
    expect(n.links).toEqual([])
    expect(n.inlineTags).toEqual([])
    expect(n.meta.title).toBe('[[Secret]] #tag <b>x</b> `y`')
  })

  it('a hostile caption is not a link target', () => {
    const raw = serializeBoard(board([pic({ caption: 'see [[Secret]] and #tag' })]), undefined, NOW)
    const n = parseNote({ path: 'Boards/x.md', content: raw })
    expect(n.links.map((l) => l.to)).toEqual(['Boards/a.png'])
  })
})

describe('boardFolderName', () => {
  /** The names the vault ignores, read from the desktop source so the two lists cannot drift apart. */
  function heavyDirs(): string[] {
    const src = readFileSync(fileURLToPath(new URL('../../../apps/desktop/src/main/fsvault.ts', import.meta.url)), 'utf8')
    const start = src.indexOf('export const HEAVY_DIRS')
    const body = src.slice(src.indexOf('new Set([', start), src.indexOf('])', start))
    return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
  }

  it('adds " pictures" to every folder name the vault ignores, in any letter case and with trailing dots or spaces', () => {
    const names = heavyDirs()
    expect(names.length).toBeGreaterThan(35)
    expect(names).toContain('library')
    for (const name of names) {
      for (const spelled of [name, name.toUpperCase(), name[0]!.toUpperCase() + name.slice(1)]) {
        expect(boardFolderName(spelled), spelled).toBe(`${spelled} pictures`)
      }
      expect(boardFolderName(`${name}. `), name).toBe(`${name} pictures`)
    }
    expect(boardFolderName('Library')).toBe('Library pictures')
    expect(boardFolderName('Temp')).toBe('Temp pictures')
    expect(boardFolderName('Out')).toBe('Out pictures')
  })

  it('does not touch names that merely contain an ignored word', () => {
    for (const name of ['Library of Babel', 'My Cache', 'Outdoors', 'Build 2', 'Temple', 'Binary', 'Gate reference', 'Windows 95 art']) expect(boardFolderName(name), name).toBe(name)
  })

  it('replaces \\ / : * ? " < > | # [ ] by "-", collapses white space and trims', () => {
    expect(boardFolderName('a/b\\c:d*e?f"g<h>i|j#k[l]m')).toBe('a-b-c-d-e-f-g-h-i-j-k-l-m')
    expect(boardFolderName('  Gate   reference \t')).toBe('Gate reference')
    expect(boardFolderName('line\nbreak')).toBe('line break')
    expect(boardFolderName('a\u0000b')).toBe('a b')
  })

  it('has no trailing dots or spaces, no leading dot or $ (the vault skips those), at most 80 characters, and "Board" when empty', () => {
    expect(boardFolderName('Gate...')).toBe('Gate')
    expect(boardFolderName('Gate . . ')).toBe('Gate')
    expect(boardFolderName('.hidden')).toBe('hidden')
    expect(boardFolderName('$100 ideas')).toBe('100 ideas')
    for (const empty of ['', '   ', '...', '. . .', '$']) expect(boardFolderName(empty), JSON.stringify(empty)).toBe('Board')
    expect(boardFolderName('///')).toBe('---')
    const long = boardFolderName('x'.repeat(200))
    expect(long).toHaveLength(80)
    expect(boardFolderName('a'.repeat(79) + '😀')).toBe('a'.repeat(79))
    expect(boardFolderName('b'.repeat(78) + '. ' + 'c'.repeat(30))).toBe('b'.repeat(78))
  })

  it('also keeps out of the way of Windows device names and the temp suffix of the vault', () => {
    expect(boardFolderName('CON')).toBe('CON pictures')
    expect(boardFolderName('lpt1')).toBe('lpt1 pictures')
    expect(boardFolderName('nul.txt')).toBe('nul.txt pictures')
    expect(boardFolderName('console')).toBe('console')
    expect(boardFolderName('x.aether-tmp')).toBe('x.aether-tmp pictures')
  })
})

describe('boardPictureName', () => {
  const name = (original: string, mime = '', now = NOW) => boardPictureName(original, mime, now)

  it('a generic name becomes "ref YYYY-MM-DD HHMMSS" in local time, with the right extension', () => {
    expect(name('image.png', 'image/png')).toBe('ref 2026-10-09 143512.png')
    expect(name('blob', 'image/jpeg')).toBe('ref 2026-10-09 143512.jpg')
    expect(name('Screenshot.PNG', 'image/png')).toBe('ref 2026-10-09 143512.png')
    expect(name('unnamed', 'image/webp')).toBe('ref 2026-10-09 143512.webp')
    expect(name('', 'image/gif')).toBe('ref 2026-10-09 143512.gif')
    expect(name('', '')).toBe('ref 2026-10-09 143512.png')
    expect(name('image (1).png')).toBe('ref 2026-10-09 143512.png')
    expect(name('Image 2.jpg')).toBe('ref 2026-10-09 143512.jpg')
    expect(name('  ..  .png')).toBe('ref 2026-10-09 143512.png')
    expect(name('###.png')).toBe('ref 2026-10-09 143512.png')
    expect(name('image.png', 'image/png', new Date(2026, 0, 2, 3, 4, 5))).toBe('ref 2026-01-02 030405.png')
  })

  it('a real name is kept; unsafe characters become "-" and runs of them one "-"', () => {
    expect(name('rust gate.jpeg', 'image/jpeg')).toBe('rust gate.jpeg')
    expect(name('imagery.png')).toBe('imagery.png')
    expect(name('Screenshot 2026-10-09 at 14.35.12.png')).toBe('Screenshot 2026-10-09 at 14.35.12.png')
    expect(name('a#b|c[d]e<f>g*h_i~j:m?n"o.png')).toBe('a-b-c-d-e-f-g-h-i-j-m-n-o.png')
    expect(name('a##__~~b.png')).toBe('a-b.png')
    expect(name('_lead_.png')).toBe('lead.png')
    expect(name('[Ref] #1.png')).toBe('Ref- -1.png')
    expect(name('tab\tand\nnewline.png')).toBe('tab and newline.png')
  })

  it('only the file name is used, not the folders in front of it (either separator)', () => {
    expect(name('C:\\Users\\me\\Pictures\\rust.png')).toBe('rust.png')
    expect(name('some/dir/rust.png')).toBe('rust.png')
    expect(name('some/dir\\mixed/rust.png')).toBe('rust.png')
  })

  it('keeps the extension when it is a picture type (any case, lower-cased), else uses the MIME type, else png', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']) expect(name(`x.${ext.toUpperCase()}`, 'image/tiff')).toBe(`x.${ext}`)
    expect(name('rust.tiff', 'image/webp')).toBe('rust.webp')
    expect(name('rust.tiff', 'image/tiff')).toBe('rust.png')
    expect(name('rust', 'image/gif')).toBe('rust.gif')
    expect(name('rust', 'image/jpeg')).toBe('rust.jpg')
    expect(name('rust', 'IMAGE/AVIF')).toBe('rust.avif')
    expect(name('rust', 'image/bmp')).toBe('rust.bmp')
    expect(name('rust.heic', '')).toBe('rust.png')
    expect(name('rust.svg', 'image/svg+xml')).toBe('rust.png')
    expect(name('Mr. Smith', 'image/png')).toBe('Mr. Smith.png')
  })

  it('is at most 80 characters of name, never ends in a dot, and keeps off Windows device names', () => {
    const long = name(`${'x'.repeat(200)}.png`)
    expect(long).toBe(`${'x'.repeat(80)}.png`)
    expect(name(`${'a'.repeat(79)}😀.png`)).toBe(`${'a'.repeat(79)}.png`)
    expect(name('con.png')).toBe('con-.png')
    expect(name('NUL.jpg')).toBe('NUL-.jpg')
    expect(name('trailing dots...png')).toBe('trailing dots.png')
  })

  it('its result is always a name safe to embed', () => {
    for (const original of ['a#b.png', 'x_y_z.png', '_a_.png', '*a*.png', '~a~.png', '[[x]].png', 'a|b.png', 'img<1>.png', 'a_b_c_d.png']) {
      const result = name(original)
      expect(safeEmbedPath(`Boards/Gate/${result}`), `${original} -> ${result}`).toBe(true)
    }
  })
})
