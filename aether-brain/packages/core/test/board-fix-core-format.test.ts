/**
 * The review round of the reference board's file format (format-1 to 5, format-m1/m4/m5, geometry-m7, integration-m5/m6): the size
 * budget, attributes this version does not know, the user's text under the board, late autolinks, and a parseNote that reads a board
 * from its own lines. Fuzzers live in board-format-fuzz.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'
import { BOARD_ITEM_LIMITS, addMark, addNote, addPicture, duplicateItems, moveItems, setProps } from '../src/board/ops'
import {
  boardChars,
  boardFolderName,
  boardPictureName,
  isBoardNote,
  itemChars,
  newBoardNote,
  parseBoard,
  serializeBoard,
} from '../src/board/format'
import { cleanText, cutText } from '../src/board/text'
import { BOARD_LIMITS, FULL_CROP, emptyBoard } from '../src/board/types'
import type { BoardDoc, BoardItem, NoteItem, PictureItem, StrokeItem } from '../src/board/types'
import { buildGraph } from '../src/graph/build'
import { parseMarkdown, parseNote } from '../src/markdown/parse'
import { splitFrontmatter } from '../src/markdown/frontmatter'
import { remarkNoLateAutolinks, remarkWikilink } from '../src/markdown/wikilink'
import { isProjectNote } from '../src/markdown/projects'
import { isNoteType, slugifyTitle } from '../src/vault/paths'
import { renderChatNote } from '../src/chats/notes'
import type { ChatConversation } from '../src/chats/exports'

const NOW = new Date(2026, 9, 9, 14, 35, 12)
const LATER = new Date(2026, 9, 20, 8, 0, 0)

function pic(over: Partial<PictureItem> = {}): PictureItem {
  return { id: 0, group: 0, locked: false, kind: 'picture', path: 'Boards/a.png', x: 0, y: 0, w: 100, h: 80, rotation: 0, crop: { ...FULL_CROP }, flipH: false, flipV: false, gray: false, opacity: 1, caption: '', ...over }
}
function note(over: Partial<NoteItem> = {}): NoteItem {
  return { id: 0, group: 0, locked: false, kind: 'note', text: 'hello', x: 0, y: 0, w: 300, size: 18, rotation: 0, color: 'ffffff', fill: '', ...over }
}
function stroke(over: Partial<StrokeItem> = {}): StrokeItem {
  return { id: 0, group: 0, locked: false, kind: 'stroke', points: [1, 2, 3, 4], color: 'ff0000', width: 2, ...over }
}
function board(items: BoardItem[], over: Partial<BoardDoc> = {}): BoardDoc {
  return { ...emptyBoard('Test board'), ...over, items: items.map((it, i) => ({ ...it, id: i + 1 })), nextId: items.length + 1 }
}

const FM = ['---', 'title: Gate', 'type: board', '---', ''].join('\n')
const VIEW = '- view x=0 y=0 zoom=1 bg=14161d gray=0 smooth=1 captions=0 grid=0'
const NOTE1 = '- note x=1 y=2 w=300 size=18 color=ffffff fill= r=0 » one'
const NOTE2 = '- note x=3 y=4 w=300 size=18 color=ffffff fill= r=0 » two'
const bodyOf = (raw: string): string => splitFrontmatter(raw).body
/** The note without the `updated:` line a save stamps. */
const unstamped = (raw: string): string => raw.replace(/updated: .*\n/, '')
/** The same board note as a plain note: its lines go through the real markdown parser. */
const plain = (raw: string): string => raw.replace('type: board', 'type: note')

/** A board with every kind of line, groups past 9 and 99, captions, extras and attributes this version does not know. */
function richDoc(): BoardDoc {
  const items: BoardItem[] = []
  for (let i = 0; i < 120; i++) {
    const group = i % 3 === 0 ? 1 + (i % 120) : 0
    items.push(
      pic({ path: `Boards/Gate reference/photo ${i}.jpg`, x: i * 13.37, y: -i * 7.1, caption: i % 2 ? `caption ${i} with [brackets] and #hash` : '', group, crop: i % 5 === 0 ? { l: 0.1, t: 0.2, r: 0.9, b: 0.8 } : { ...FULL_CROP }, rotation: i % 7 === 0 ? 33.33 : 0 }),
      note({ text: `note ${i} `.repeat(1 + (i % 17)), x: i, group: i % 4 === 0 ? i + 3 : 0 }),
      stroke({ points: Array.from({ length: 2 * (5 + (i % 40)) }, (_, k) => Math.round((k * 31.7 + i) * 100) / 100), group }),
    )
  }
  items.push(
    { id: 0, group: 0, locked: true, kind: 'line', x1: 0, y1: 0, x2: 100, y2: 50, color: 'ff0000', width: 2.5, arrow: true },
    { id: 0, group: 0, locked: false, kind: 'rect', x1: -5, y1: -5, x2: 105, y2: 55, color: '00ff00', width: 1, fill: '202530' },
    { id: 0, group: 0, locked: false, kind: 'ellipse', x1: 0, y1: 0, x2: 10, y2: 10, color: '0000ff', width: 1, fill: '' },
  )
  return board(items, { extra: ['a hand-written remark', '- gizmo size=9 » from a newer version'], viewUnknown: ['theme=dark'] })
}

/* ================================================================ format-1 === */

describe('format-1: the budget is measured, not guessed', () => {
  it('boardChars is within a few percent of the real length of the section the board writes', () => {
    const doc = richDoc()
    const raw = serializeBoard(doc, undefined, NOW)
    const real = raw.length - raw.indexOf('## Board')
    const estimate = boardChars(doc)
    expect(real).toBeGreaterThan(30_000)
    expect(Math.abs(estimate - real) / real).toBeLessThan(0.03)
    // Never off by much on the small ones either: the view line and the heading are counted for real.
    const tiny = board([note({ text: 'x' })])
    const tinyRaw = serializeBoard(tiny, undefined, NOW)
    expect(Math.abs(boardChars(tiny) - (tinyRaw.length - tinyRaw.indexOf('## Board')))).toBeLessThan(8)
    expect(boardChars(emptyBoard('Empty'))).toBe(serializeBoard(emptyBoard('Empty'), undefined, NOW).length - serializeBoard(emptyBoard('Empty'), undefined, NOW).indexOf('## Board'))
  })

  it('itemChars is the length of the item\'s line with its break, unknown attributes and all', () => {
    const plainItem = { ...note({ text: 'abc' }), id: 1 }
    const withUnknown = { ...plainItem, unknown: ['theme=dark', 'pinned'] }
    const line = (it: BoardItem): number => serializeBoard(board([it]), undefined, NOW).split('\n').find((l) => l.startsWith('- note'))!.length + 1
    expect(itemChars(plainItem)).toBe(line(plainItem))
    expect(itemChars(withUnknown)).toBe(line(withUnknown))
    expect(itemChars(withUnknown)).toBeGreaterThan(itemChars(plainItem))
  })

  it('is cheap on 1,500 items: one pass, and nothing but a sum the second time (cached per item)', () => {
    const items = Array.from({ length: BOARD_LIMITS.items }, (_, i) => (i % 3 === 0 ? pic({ path: `Boards/p ${i}.png`, caption: 'c' }) : i % 3 === 1 ? note({ text: `n${i}` }) : stroke({ points: Array.from({ length: 80 }, (_, k) => k * 1.5) })))
    const doc = board(items)
    const t0 = performance.now()
    const first = boardChars(doc)
    const t1 = performance.now()
    for (let i = 0; i < 100; i++) expect(boardChars(doc)).toBe(first)
    const t2 = performance.now()
    expect(t1 - t0).toBeLessThan(300)
    // A hundred sums over 1,500 cached items.
    expect(t2 - t1).toBeLessThan(300)
    const raw = serializeBoard(doc, undefined, NOW)
    expect(Math.abs(first - (raw.length - raw.indexOf('## Board'))) / raw.length).toBeLessThan(0.03)
  })

  it('parseBoard warns when the board section is past BOARD_LIMITS.noteTotal (500,000), not at the old 300,000, and not for the user\'s prose', () => {
    const lineOf = (i: number): string => `- note x=${i} y=0 w=300 size=18 color=ffffff fill= r=0 » ${'w'.repeat(3900)}`
    const section = (n: number): string => ['---', 'type: board', '---', '## Board', '', ...Array.from({ length: n }, (_, i) => lineOf(i)), ''].join('\n')
    const limit = new RegExp(String(BOARD_LIMITS.noteTotal))
    // About 400,000 characters: past the old limit, inside the new one.
    const between = parseBoard(section(100))
    expect(section(100).length).toBeGreaterThan(300_000)
    expect(section(100).length).toBeLessThan(BOARD_LIMITS.noteTotal)
    expect(between.warnings).toEqual([])
    const over = parseBoard(section(130))
    expect(section(130).length).toBeGreaterThan(BOARD_LIMITS.noteTotal)
    expect(over.doc.items).toHaveLength(130)
    expect(over.warnings.filter((w) => limit.test(w))).toHaveLength(1)
    // Prose after a blank line is the user's: it does not count, however long.
    expect(parseBoard(section(10) + '\n' + 'x'.repeat(BOARD_LIMITS.noteTotal + 10)).warnings).toEqual([])
  })

  it('the limit says what it is: noteTotal is the board section\'s budget', () => {
    expect(BOARD_LIMITS.noteTotal).toBe(500_000)
  })
})

/* ================================================================ format-2 === */

describe('format-2: attributes and flags this version does not know are kept and written back', () => {
  const RAW = [
    FM.trimEnd(),
    '# Gate',
    '',
    '## Board',
    '',
    '- view x=0 y=0 zoom=1 bg=14161d gray=0 smooth=1 captions=0 grid=0 theme=dark pinned',
    '- ![[Boards/a.png]] x=0 y=0 w=100 h=100 tint=ff0000 pinned blend=multiply » a caption',
    '- pic Boards/a\\#b.png x=1 y=1 w=50 h=50 shadow » another',
    '- note x=1 y=2 w=300 size=18 color=ffffff fill= r=0 lock g=1 pinned » text',
    '- stroke color=ffffff width=2 smooth=3 pts=1,2 3,4 5,6',
    '- line x1=0 y1=0 x2=1 y2=1 color=ffffff width=2 arrow dash=4',
    '- rect x1=0 y1=0 x2=1 y2=1 color=ffffff width=2 fill= radius=5',
    '- ellipse x1=0 y1=0 x2=1 y2=1 color=ffffff width=2 fill= shadow',
    '',
  ].join('\n')

  it('keeps them for every kind and for the view line: an unchanged board is written back as it was', () => {
    const { doc, warnings } = parseBoard(RAW)
    expect(doc.items).toHaveLength(7)
    expect(doc.viewUnknown).toEqual(['theme=dark', 'pinned'])
    expect(doc.items.map((i) => i.unknown)).toEqual([['tint=ff0000', 'pinned', 'blend=multiply'], ['shadow'], ['pinned'], ['smooth=3'], ['dash=4'], ['radius=5'], ['shadow']])
    // Said, and kept.
    expect(warnings.filter((w) => /kept as written/.test(w))).toHaveLength(11)
    expect(warnings.some((w) => /dropped|ignored/.test(w))).toBe(false)
    expect(serializeBoard(doc, RAW, NOW)).toBe(RAW)
  })

  it('keeps them through an edit (the item is moved, scaled, copied)', () => {
    const { doc } = parseBoard(RAW)
    const moved = moveItems(doc, [1, 4], 10, 10)
    const out = serializeBoard(moved, RAW, NOW)
    expect(out).toContain('- ![[Boards/a.png]] x=10 y=10 w=100 h=100 tint=ff0000 pinned blend=multiply » a caption')
    expect(out).toContain('- stroke color=ffffff width=2 smooth=3 pts=11,12 13,14 15,16')
    const copied = duplicateItems(doc, [2], { x: 5, y: 5 }).doc
    expect(copied.items[copied.items.length - 1]!.unknown).toEqual(['shadow'])
    expect(serializeBoard(copied, RAW, NOW)).toContain('- pic Boards/a\\#b.png x=6 y=6 w=50 h=50 shadow » another')
  })

  it('writes them where the reader finds them again: before the text of a picture or note, before the points of a stroke', () => {
    const doc = board([
      { ...pic({ caption: 'cap » with, 1,2 commas' }), unknown: ['k=1,2', 'flag'] },
      { ...note({ text: 'a » b' }), unknown: ['x2=5'] },
      { ...stroke(), unknown: ['dash=4', 'k=1,2'] },
    ])
    const out = serializeBoard(doc, undefined, NOW)
    expect(out).toContain('- ![[Boards/a.png]] x=0 y=0 w=100 h=80 k=1,2 flag » cap » with, 1,2 commas')
    expect(out).toContain('color=ffffff fill= r=0 x2=5 » a » b')
    expect(out).toContain('- stroke color=ff0000 width=2 dash=4 k=1,2 pts=1,2 3,4')
    const back = parseBoard(out)
    expect(back.doc.items.map((i) => i.unknown)).toEqual([['k=1,2', 'flag'], ['x2=5'], ['dash=4', 'k=1,2']])
    expect((back.doc.items[2] as StrokeItem).points).toEqual([1, 2, 3, 4])
    expect(serializeBoard(back.doc, out, LATER)).toBe(out)
  })

  it('keeps only plain names and values: anything a markdown parser would read is dropped, with a warning', () => {
    const hostile = ['#tag', '[[x]]', 'a=[[x]]', '<b>', 'a=`x`', 'a|b', 'a*b', 'a_b', 'a~b', 'a=b*', 'a=@x.y', 'a=http://x', 'x\\y', '1abc', 'a'.repeat(40), `k=${'v'.repeat(70)}`, '-x', 'a&amp;b']
    const raw = `${FM}## Board\n\n- note x=1 y=2 w=300 size=18 color=ffffff fill= r=0 ${hostile.join(' ')} » text\n`
    const { doc, warnings } = parseBoard(raw)
    expect(doc.items[0]!.unknown).toBeUndefined()
    expect(warnings.filter((w) => /dropped/.test(w)).length).toBeGreaterThanOrEqual(10)
    const out = serializeBoard(doc, raw, NOW)
    for (const t of ['#tag', '[[x]]', '<b>', 'a|b', 'a*b', 'a_b', 'a~b']) expect(out).not.toContain(t)
    // A doc built by hand cannot write them either.
    const forged = serializeBoard(board([{ ...note(), unknown: ['#tag', '[[x]]', 'ok=1'] }]), undefined, NOW)
    expect(forged).toContain(' ok=1 »')
    expect(forged).not.toContain('#tag')
  })

  it('keeps at most eight per line', () => {
    const many = Array.from({ length: 12 }, (_, i) => `k${i}=${i}`)
    const raw = `${FM}## Board\n\n- note x=1 y=2 w=300 size=18 color=ffffff fill= r=0 ${many.join(' ')} » t\n`
    const { doc, warnings } = parseBoard(raw)
    expect(doc.items[0]!.unknown).toEqual(many.slice(0, 8))
    expect(warnings.filter((w) => /at most 8/.test(w))).toHaveLength(4)
  })

  it('a known attribute that was read is not unknown, a bad value is replaced, and the rest of the line is untouched', () => {
    const raw = `${FM}## Board\n\n- note x=abc y=2 w=300 size=18 color=ffffff fill= r=0 extra=1 » t\n`
    const { doc } = parseBoard(raw)
    expect(doc.items[0]).toMatchObject({ x: 0, y: 2, unknown: ['extra=1'] })
  })

  it('counts them in the budget', () => {
    const doc = board([{ ...note(), unknown: ['theme=dark', 'pinned'] }])
    const raw = serializeBoard(doc, undefined, NOW)
    expect(boardChars(doc)).toBe(raw.length - raw.indexOf('## Board'))
  })
})

/* ================================================================ format-3 === */

describe('format-3: the user\'s text under the board stays byte for byte, where it was', () => {
  const ITEMS = `${VIEW}\n${NOTE1}\n${NOTE2}\n`
  const raw = (tail: string, heading = '## Board'): string => `${FM}# Gate\n\n${heading}\n\n${ITEMS}${tail}`
  const edit = (doc: BoardDoc): BoardDoc => ({ ...doc, items: doc.items.map((it, i) => (i === 0 ? ({ ...it, x: 99 } as BoardItem) : it)) })
  const saved = (text: string): string => serializeBoard(edit(parseBoard(text).doc), text, NOW)

  it('two paragraphs and a to-do list under the items: their blank lines, their order and every byte stay, after a real edit', () => {
    const tail = '\nMy notes about this board.\n\nSecond paragraph.\n\n- [ ] todo one\n- [ ] todo two\n'
    const text = raw(tail)
    const { doc, warnings } = parseBoard(text)
    expect(doc.extra).toEqual([])
    expect(warnings).toEqual([])
    expect(serializeBoard(doc, text, NOW)).toBe(text)
    const out = saved(text)
    expect(out.endsWith(tail)).toBe(true)
    expect(out).toContain('- note x=99 y=2')
    expect(saved(out)).toBe(out)
  })

  it('markdown that depends on a blank line keeps its meaning: a thematic break, indented code, an ordered list, two block quotes', () => {
    for (const tail of ['\nSome thoughts.\n\n---\n\nMore.\n', '\nSome thoughts.\n\n    code line\n', '\nSome thoughts.\n\n2. second\n', '\n> one\n\n> two\n', '\nPara one.\n\nPara two.\n']) {
      const text = raw(tail)
      const out = saved(text)
      expect(out.endsWith(tail), JSON.stringify(tail)).toBe(true)
      expect(parseMarkdown(bodyOf(out)).children.map((c) => c.type)).toEqual(parseMarkdown(bodyOf(text.replace('x=1', 'x=99'))).children.map((c) => c.type))
    }
    const setext = parseMarkdown('Some thoughts.\n---\nMore.').children.map((c) => c.type)
    expect(setext).toEqual(['heading', 'paragraph'])
    expect(parseMarkdown(bodyOf(saved(raw('\nSome thoughts.\n\n---\n\nMore.\n')))).children.map((c) => c.type)).not.toEqual(setext)
  })

  it('"- [ ] task" lines under the board are the user\'s: no warning, whether they touch the items (the board keeps them) or not', () => {
    const touching = parseBoard(raw('- [ ] right under the items\n- [x] done\n\n- [ ] after a blank line\n'))
    expect(touching.warnings).toEqual([])
    // The first two touch the items: lines the board kept, written back right after them. The third is the user's.
    expect(touching.doc.extra).toEqual(['- [ ] right under the items', '- [x] done'])
    const apart = parseBoard(raw('\n- [ ] after a blank line\n- [X] done too\n'))
    expect(apart.warnings).toEqual([])
    expect(apart.doc.extra).toEqual([])
    // A newer version's unknown kind is still said so.
    expect(parseBoard(raw('- gizmo x=1\n')).warnings.some((w) => /gizmo/.test(w))).toBe(true)
  })

  it('a bullet of the user\'s that starts with the name of a kind, after a blank line, is theirs: "- note the colours", "- line 3 is wrong", "- view from the north"', () => {
    const tail = '\n- note the colours\n- line 3 is wrong\n- view from the north\n- pic of the gate\n- ![[Some Note]]\n- rect\n\nand a paragraph\n'
    const text = raw(tail)
    const { doc, warnings } = parseBoard(text)
    expect(doc.items).toHaveLength(2)
    expect(doc.extra).toEqual([])
    expect(warnings).toEqual([])
    expect(serializeBoard(doc, text, NOW)).toBe(text)
    expect(saved(text).endsWith(tail)).toBe(true)
    // The brain reads them as the note's own prose (and the embed of a note as a link), not as items of the board.
    const n = parseNote({ path: 'Boards/Gate.md', content: text })
    expect(n.plain).toContain('note the colours')
    expect(n.plain).toContain('line 3 is wrong')
    expect(n.links.map((l) => l.to)).toEqual(['Some Note'])
    // Between two lines of the board, after a blank line, such a bullet is a line the board keeps (an extra), for the brain as well.
    const between = raw('\n- note the colours\n- note x=9 y=9 w=300 size=18 color=ffffff fill= r=0 » real\n')
    const mixed = parseBoard(between)
    expect(mixed.doc.items).toHaveLength(3)
    expect(mixed.doc.extra).toEqual(['- note the colours'])
    expect(parseNote({ path: 'Boards/Gate.md', content: between }).plain).toContain('note the colours')
  })

  it('lines that look written by the board are its own wherever they come, after a blank line too (hand-written items, a loose list)', () => {
    const text = raw('\n- note » hand-written, no attributes\n\n- stroke pts=1,2 3,4\n\n- pic Boards/a.png\n- ![[Boards/b.png]]\n\nafter\n')
    const { doc, warnings } = parseBoard(text)
    expect(warnings).toEqual([])
    expect(doc.items.map((i) => i.kind)).toEqual(['note', 'note', 'note', 'stroke', 'picture', 'picture'])
    const out = serializeBoard(doc, text, NOW)
    expect(out.endsWith('\nafter\n')).toBe(true)
    expect(out).not.toContain('hand-written, no attributes\n\n')
    // And the brain, which reads the same lines without the markdown parser, agrees on which ones they are.
    const n = parseNote({ path: 'Boards/Gate.md', content: text })
    expect(n.links.map((l) => l.to)).toEqual(['Boards/a.png', 'Boards/b.png'])
    expect(n.plain).toContain('after')
    // (Round 2: the text of a note on the board is search text, without its line.)
    expect(n.plain).toContain('hand-written, no attributes')
    expect(n.plain).not.toMatch(/stroke|pts=|Boards\/a/)
  })

  it('text that touches the last item is a line the board keeps (written back right after the items); a blank line makes it the user\'s', () => {
    const touching = parseBoard(raw('stuck to the list\n'))
    expect(touching.doc.extra).toEqual(['stuck to the list'])
    expect(serializeBoard(touching.doc, raw('stuck to the list\n'), NOW)).toBe(raw('stuck to the list\n'))
    const apart = parseBoard(raw('\nnot stuck\n'))
    expect(apart.doc.extra).toEqual([])
  })

  it('a prologue between the heading and the view line, and a remark between items, are kept (written after the items)', () => {
    const text = `${FM}## Board\n\nPrologue text.\n\n${VIEW}\n${NOTE1}\nremark between\n${NOTE2}\n\nuser tail\n`
    const { doc } = parseBoard(text)
    expect(doc.extra).toEqual(['Prologue text.', 'remark between'])
    const out = serializeBoard(doc, text, NOW)
    expect(bodyOf(out)).toBe(`## Board\n\n${VIEW}\n${NOTE1}\n${NOTE2}\nPrologue text.\nremark between\n\nuser tail\n`)
    expect(serializeBoard(parseBoard(out).doc, out, LATER)).toBe(out)
  })

  it('a bare heading with the user\'s text right under it: the view line does not run into it', () => {
    const text = `${FM}## Board\nsome text\nmore\n`
    const out = serializeBoard(parseBoard(text).doc, text, NOW)
    expect(bodyOf(out)).toBe(`## Board\n\n${VIEW}\n\nsome text\nmore\n`)
    expect(serializeBoard(parseBoard(out).doc, out, LATER)).toBe(out)
    // A heading right after needs no blank line.
    const next = `${FM}## Board\n## Next\ntext\n`
    expect(bodyOf(serializeBoard(parseBoard(next).doc, next, NOW))).toBe(`## Board\n\n${VIEW}\n## Next\ntext\n`)
  })

  it('the text below survives the board growing, shrinking and emptying', () => {
    const tail = '\nA paragraph.\n\nAnother.\n'
    const text = raw(tail)
    const { doc } = parseBoard(text)
    const grown = serializeBoard({ ...doc, items: [...doc.items, { ...note({ text: 'three' }), id: 3 }], nextId: 4 }, text, NOW)
    expect(grown.endsWith(tail)).toBe(true)
    const empty = serializeBoard({ ...doc, items: [] }, text, NOW)
    expect(empty.endsWith(tail)).toBe(true)
    expect(parseBoard(empty).doc.items).toEqual([])
  })

  it('an HTML comment holding "## Board" is not the board; a comment inside the board is kept whole', () => {
    const hidden = `${FM}<!--\n## Board\n\n- view x=9 y=9 zoom=2\n- note x=1 y=2 w=300 » old\n-->\n\nreal text\n`
    const { doc } = parseBoard(hidden)
    expect(doc.items).toEqual([])
    const out = serializeBoard(doc, hidden, NOW)
    expect(bodyOf(out).startsWith('<!--\n## Board\n\n- view x=9 y=9 zoom=2\n- note x=1 y=2 w=300 » old\n-->\n\nreal text\n')).toBe(true)
    expect(out.endsWith(`## Board\n\n${VIEW}\n`)).toBe(true)
    expect(parseBoard(out).doc.items).toEqual([])
    // An unclosed comment would swallow the new heading: it is closed first.
    const open = `${FM}text\n\n<!--\nnever closed\n`
    const written = serializeBoard(emptyBoard('Gate'), open, NOW)
    expect(written).toContain('never closed\n-->\n\n## Board')
    // A comment among the items is kept as a whole, blank lines in it too.
    const inside = `${FM}## Board\n\n${VIEW}\n${NOTE1}\n<!--\nremark\n\nmore\n-->\n${NOTE2}\n`
    const kept = parseBoard(inside).doc
    expect(kept.items).toHaveLength(2)
    expect(kept.extra).toEqual(['<!--', 'remark', '', 'more', '-->'])
    expect(serializeBoard(kept, inside, NOW)).toContain('<!--\nremark\n\nmore\n-->')
  })

  it('CRLF notes keep their line breaks in the tail and the board', () => {
    const tail = '\nA paragraph.\n\n- [ ] todo\n'
    const text = raw(tail).replace(/\n/g, '\r\n')
    const out = saved(text)
    expect(out.endsWith(tail.replace(/\n/g, '\r\n'))).toBe(true)
    expect(out).not.toMatch(/[^\r]\n/)
  })

  it('a randomly written tail of the user\'s survives any edit byte for byte (300 notes)', () => {
    let seed = 7
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      return seed / 4294967296
    }
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
    const blocks = ['Plain text.', '- [ ] a task', '- a bullet', '1. numbered', '> quote', '---', '***', '    indented', '```js\ncode\n\nmore\n```', '| a | b |\n|---|---|', '### Sub', '<!-- note -->', '[link](http://x.y)', '#tag [[link]]', '* star', 'text  ', 'a\\', '']
    for (let n = 0; n < 300; n++) {
      let tail = '\n'
      for (let k = Math.floor(rnd() * 8); k > 0; k--) tail += pick(blocks) + '\n' + (rnd() < 0.6 ? '\n' : '')
      const eol = rnd() < 0.3 ? '\r\n' : '\n'
      const text = raw(tail).replace(/\n/g, eol)
      const out = saved(text)
      expect(out.endsWith(tail.replace(/\n/g, eol)), JSON.stringify(tail)).toBe(true)
      expect(parseBoard(out).doc.items).toHaveLength(2)
      expect(serializeBoard(parseBoard(out).doc, out, LATER).replace(/updated: .*/, '')).toBe(out.replace(/updated: .*/, ''))
    }
  })
})

/* ================================================================ format-4 === */

describe('format-4: GFM\'s late autolinks cannot make a link or tag out of escaped text', () => {
  const exploit = '\\[\\[Secret\\]\\] \\#tag ",www.x.example" ),www.a.example'
  const positionless = (md: string): number => {
    let n = 0
    visit(parseMarkdown(md), 'text', (node) => {
      if (!node.position) n++
    })
    return n
  }

  it('parseMarkdown leaves no text node without a position, so the source of every node can be looked at', () => {
    for (const md of [exploit, '"www.example.com" and (www.a.b) and www.plain.com', 'a,www.b.c me@x.org [http://x.y', '<https://auto.com> https://a.b/c?d=e']) expect(positionless(md), md).toBe(0)
  })

  it('an escaped link or tag next to an address linked late stays inert in parseNote, plain notes included', () => {
    const n = parseNote({ path: 'N.md', content: exploit })
    expect(n.links).toEqual([])
    expect(n.inlineTags).toEqual([])
    const unescaped = parseNote({ path: 'N.md', content: '[[Secret]] #tag' })
    expect(unescaped.links.map((l) => l.to)).toEqual(['Secret'])
    expect(unescaped.inlineTags).toEqual(['tag'])
  })

  it('the preview\'s pipeline (remarkGfm, the shared plugin, remarkWikilink) makes no wikilink out of it', () => {
    const run = (md: string, withPlugin: boolean): string[] => {
      const p = unified().use(remarkParse).use(remarkGfm)
      if (withPlugin) p.use(remarkNoLateAutolinks)
      p.use(remarkWikilink, {})
      const tree = p.runSync(p.parse(md), { value: md } as never)
      const found: string[] = []
      visit(tree, (node) => {
        if (node.type === 'wikilink') found.push((node as unknown as { target: string }).target)
      })
      return found
    }
    expect(run(exploit, false)).toContain('Secret')
    expect(run(exploit, true)).toEqual([])
    expect(run('[[Real]] and www.plain.com', true)).toEqual(['Real'])
  })

  it('tokenizer autolinks are still links; only the late pass is gone', () => {
    const kinds = (md: string): string[] => {
      const found: string[] = []
      visit(parseMarkdown(md), 'link', (node) => {
        found.push(node.url)
      })
      return found
    }
    expect(kinds('www.plain.com')).toEqual(['http://www.plain.com'])
    expect(kinds('(www.paren.com)')).toEqual(['http://www.paren.com'])
    expect(kinds('<https://auto.com>')).toEqual(['https://auto.com'])
    expect(kinds('me@x.org')).toEqual(['mailto:me@x.org'])
    expect(kinds('[https://foo.bar](https://foo.bar)')).toEqual(['https://foo.bar'])
    // GFM allows www. after whitespace and * _ ~ ( only.
    expect(kinds('"www.example.com"')).toEqual([])
  })

  it('imported chats stay inert: the late autolink no longer lets a message\'s [[link]] or #tag through', () => {
    const conv: ChatConversation = {
      source: 'claude', id: 'x', title: 'X', created: null, updated: null, url: 'https://claude.ai/chat/xxxxxx', projectId: null, gptId: null, model: null,
      messages: [{ role: 'user', time: null, text: 'look at [[Diary]] #private ",www.example.com"', attachments: [], images: [], artifacts: [] }],
    }
    const note = renderChatNote(conv, 'X', { utc: true })
    expect(note).toContain('look at \\[\\[Diary\\]\\] \\#private')
    const n = parseNote({ path: 'Chats/X.md', content: note })
    expect(n.links).toEqual([])
    expect(n.inlineTags.filter((t) => t === 'private')).toEqual([])
  })
})

/* ================================================================ format-5 === */

describe('format-5 / integration-1 / integration-m5: parseNote reads a board from its own lines', () => {
  function boardNote(items: BoardItem[], over: Partial<BoardDoc> = {}): string {
    return serializeBoard(board(items, { title: 'Gate', ...over }), undefined, NOW)
  }

  it('gives a link for every picture: embeds as links, `pic` lines as literal ones, with the offset of the line in the body', () => {
    const raw = boardNote([pic({ path: 'Boards/a b.png' }), note({ text: 'between' }), pic({ path: 'Boards/a#b [1].png' }), pic({ path: 'Boards/under_score_.png' }), pic({ path: 'Boards/a|b.png' })])
    const n = parseNote({ path: 'Boards/Gate.md', content: raw })
    expect(n.links.map((l) => [l.kind, l.to, l.raw, l.literal === true])).toEqual([
      ['embed', 'Boards/a b.png', 'Boards/a b.png', false],
      ['embed', 'Boards/a#b [1].png', 'Boards/a#b [1].png', true],
      ['embed', 'Boards/under_score_.png', 'Boards/under_score_.png', true],
      ['embed', 'Boards/a|b.png', 'Boards/a|b.png', true],
    ])
    expect(n.links.every((l) => l.from === 'Boards/Gate' && !l.resolved)).toBe(true)
    // The offset is where the picture is written in the body.
    expect(n.body.slice(n.links[0]!.offset, n.links[0]!.offset + 3)).toBe('![[')
    expect(n.body.slice(n.links[1]!.offset).startsWith('Boards/a\\#b\\ \\[1\\].png')).toBe(true)
    const offsets = n.links.map((l) => l.offset)
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets)
    expect(n.meta.type).toBe('board')
  })

  it('the graph links a board to its pictures, whatever their names (embeds and `pic` lines)', () => {
    const names = ['a b.png', 'a#b.png', 'a[1].png', 'a|b.png', 'under_score_.png', 'a~b~c.png', 'star*one*.png', 'www.site.png', 'a@b.com.png', 'ü.png', 'a&b.png', 'Upper.PNG']
    const items = names.map((name, i) => pic({ path: `Boards/Gate/${name}`, x: i }))
    const n = parseNote({ path: 'Boards/Gate.md', content: boardNote(items) })
    const other = parseNote({ path: 'Notes/Other.md', content: 'text' })
    const assets = new Map(names.map((name) => [`Boards/Gate/${name}`, { path: `Boards/Gate/${name}`, size: 1, mtime: 1 }]))
    const g = buildGraph(new Map([[n.meta.id, n], [other.meta.id, other]]), { images: { all: assets, moons: false } })
    const linked = g.nodes.filter((x) => x.kind === 'image').map((x) => x.image!.path).sort()
    expect(linked).toEqual(names.map((name) => `Boards/Gate/${name}`).sort())
    expect(g.edges.filter((e) => e.from === 'Boards/Gate' && e.kind === 'embed')).toHaveLength(names.length)
    expect(g.nodes.filter((x) => x.ghost)).toEqual([])
    expect(n.links.every((l) => l.resolved)).toBe(true)
  })

  it('a missing picture is no ghost; two pictures of one name in two folders stay distinct', () => {
    const n = parseNote({ path: 'Boards/Gate.md', content: boardNote([pic({ path: 'A/x.png' }), pic({ path: 'B/x.png' }), pic({ path: 'Gone/x#.png' })]) })
    const assets = new Map(['A/x.png', 'B/x.png'].map((p) => [p, { path: p, size: 1, mtime: 1 }]))
    const g = buildGraph(new Map([[n.meta.id, n]]), { images: { all: assets, moons: false } })
    expect(g.nodes.filter((x) => x.kind === 'image').map((x) => x.id).sort()).toEqual(['image:A/x.png', 'image:B/x.png'])
    expect(g.nodes.filter((x) => x.ghost)).toEqual([])
  })

  it('keeps the section\'s lines out of plain text, word count and tags (only the words written on the board are search text, round 2), and the rest of the note in', () => {
    const items = [note({ text: 'Secret words [[Diary]] #private' }), pic({ caption: 'caption words' }), stroke({ points: Array.from({ length: 400 }, (_, i) => i * 1.5) })]
    const raw = boardNote(items).replace('# Gate', '# Gate\n\nProse about the gate with a #real tag and a [[Real Link]].') + '\nTail prose after the board.\n'
    const n = parseNote({ path: 'Boards/Gate.md', content: raw })
    expect(n.plain).toContain('Prose about the gate')
    expect(n.plain).toContain('Tail prose after the board')
    // The words of a note and a caption are search text now (diff-core-m1; board-fix2-core-search.test.ts), as words only: the link in a
    // note is no link and its tag no tag (below), and no coordinate of the stroke is in it.
    expect(n.plain).toContain('Secret words Diary #private')
    expect(n.plain).toContain('caption words')
    expect(n.plain).not.toMatch(/\d+\.\d/)
    // (The intro sentence and the prose: a few dozen words. The coordinates of the stroke alone were 400 more.)
    expect(n.meta.wordCount).toBeLessThan(80)
    expect(n.inlineTags).toEqual(['real'])
    expect(n.links.map((l) => l.to)).toEqual(['Real Link', 'Boards/a.png'].sort((a, b) => (n.links.findIndex((l) => l.to === a) - n.links.findIndex((l) => l.to === b))))
    expect(n.meta.headings.map((h) => h.text)).toEqual(['Gate', 'Board'])
    expect(n.body).toBe(splitFrontmatter(raw).body)
    expect(n.raw).toBe(raw)
  })

  it('lines the board keeps as extras are the user\'s text: their links and tags still count, at the right offset', () => {
    const text = `${FM}# Gate\n\n## Board\n\n${VIEW}\n${NOTE1}\nsee [[Kept Link]] #kept\n${NOTE2}\n\nafter [[Tail Link]]\n`
    const n = parseNote({ path: 'Boards/Gate.md', content: text })
    expect(n.links.map((l) => l.to)).toEqual(['Kept Link', 'Tail Link'])
    expect(n.inlineTags).toEqual(['kept'])
    for (const l of n.links) expect(n.body.slice(l.offset, l.offset + 2 + l.to.length + 2).replace(/^\[\[/, '')).toContain(l.to.slice(0, 4))
    expect(n.body.slice(n.links[0]!.offset).startsWith('[[Kept Link]]')).toBe(true)
    expect(n.body.slice(n.links[1]!.offset).startsWith('[[Tail Link]]')).toBe(true)
  })

  it('a gesture that only moves, draws or edits board items changes nothing the brain keeps of the note (links by target, tags, headings) but its stamp, and the words written on the board only where they change', () => {
    const items = [pic({ path: 'Boards/a.png' }), pic({ path: 'Boards/a#b.png' }), note({ text: 'some words [[X]] #y' }), stroke()]
    const first = boardNote(items)
    const doc0 = parseBoard(first).doc
    // `words`: the gesture changes what is written on the board (round 2: the text of notes and captions is search text and counts as words).
    const edits: { doc: BoardDoc; words: string | null }[] = [
      { doc: moveItems(doc0, [1, 3], 40, -20), words: null },
      { doc: setProps(doc0, [3], { text: 'completely different words' }), words: 'completely different words' },
      { doc: addMark(doc0, { kind: 'stroke', points: [0, 0, 5, 5, 9, 1], color: 'ff0000', width: 3 }).doc, words: null },
      { doc: addNote(doc0, { text: 'a new note' }).doc, words: 'some words X #y a new note' },
    ]
    const keep = (raw: string, withWords: boolean): unknown => {
      const n = parseNote({ path: 'Boards/Gate.md', content: raw })
      const { updated: _stamp, wordCount, ...meta } = n.meta
      // (A link's offset is where it sits in the text, which moves with the length of the numbers before it: not compared.)
      return {
        links: n.links.map(({ offset: _at, ...l }) => l),
        ...(withWords ? { plain: n.plain, wordCount } : {}),
        tags: n.inlineTags,
        meta,
        frontmatter: { ...n.frontmatter, updated: null },
      }
    }
    const wordsOf = (raw: string): string => parseNote({ path: 'Boards/Gate.md', content: raw }).plain.replace(/^.*\bBoard\b /, '')
    expect(wordsOf(first)).toBe('some words X #y')
    for (const edit of edits) {
      const next = serializeBoard(edit.doc, first, LATER)
      expect(next).not.toBe(first)
      expect(keep(next, edit.words === null)).toEqual(keep(first, edit.words === null))
      if (edit.words !== null) expect(wordsOf(next)).toBe(edit.words)
    }
    // Adding or removing a picture is a change of links, and only that.
    const more = serializeBoard(addPicture(doc0, { path: 'Boards/new.png', w: 10, h: 10 }).doc, first, LATER)
    expect(parseNote({ path: 'Boards/Gate.md', content: more }).links.map((l) => l.to)).toEqual(['Boards/a.png', 'Boards/a#b.png', 'Boards/new.png'])
  })

  it('a note that says type: board but has no board section is parsed as ordinary markdown', () => {
    const n = parseNote({ path: 'B.md', content: '---\ntype: board\n---\n# T\n\nSee [[X]] #y\n' })
    expect(n.links.map((l) => l.to)).toEqual(['X'])
    expect(n.inlineTags).toEqual(['y'])
  })

  it('is far cheaper than reading the section as markdown: 1,500 pictures and 300 strokes of 150 points', () => {
    const pictures = Array.from({ length: 1500 }, (_, i) => pic({ path: `Boards/Gate reference/photo ${i}.jpg`, x: i }))
    const strokes = Array.from({ length: 300 }, (_, i) => stroke({ points: Array.from({ length: 300 }, (_, k) => Math.round(((k * 37 + i * 11) % 20000) / 7) / 100) }))
    for (const items of [pictures, strokes]) {
      const raw = boardNote(items)
      // The best of a few runs: the machine may be busy, the best run is the code's own time.
      const best = (content: string, runs: number): number => {
        let ms = Infinity
        for (let i = 0; i < runs; i++) {
          const t0 = performance.now()
          parseNote({ path: 'Boards/Gate.md', content })
          ms = Math.min(ms, performance.now() - t0)
        }
        return ms
      }
      const fast = best(raw, 9)
      const slow = best(plain(raw), 2)
      expect(fast * 5, `${items.length} items: ${fast.toFixed(1)} ms against ${slow.toFixed(1)} ms`).toBeLessThan(slow)
    }
  }, 60_000)
})

/* ========================================================== integration-m6 === */

describe('integration-m6: a board is a board wherever it lives', () => {
  const raw = newBoardNote('Gate board', NOW)
  it('board is a note type', () => {
    expect(isNoteType('board')).toBe(true)
    expect(isBoardNote(raw)).toBe(true)
  })

  it('under Projects/ it is no project card; under Inbox/ and Areas/ it keeps its type', () => {
    for (const path of ['Projects/Gate board.md', 'D/Projects/Gate board.md', 'Inbox/Gate board.md', 'Areas/Art/Gate board.md', 'Boards/Gate board.md', 'Gate board.md']) {
      const n = parseNote({ path, content: raw })
      expect(n.meta.type, path).toBe('board')
      expect(isProjectNote(n), path).toBe(false)
    }
    // Areas still come from the folders; only the type is the note's own.
    expect(parseNote({ path: 'Projects/Gate board.md', content: raw }).meta.area).toBe('projects')
    expect(parseNote({ path: 'Inbox/Gate board.md', content: raw }).meta.area).toBe('inbox')
    // Other notes in those folders are as before.
    expect(parseNote({ path: 'Projects/Plain.md', content: 'text' }).meta.type).toBe('project')
    expect(isProjectNote(parseNote({ path: 'Projects/Plain.md', content: 'text' }))).toBe(true)
    expect(parseNote({ path: 'Inbox/Plain.md', content: 'text' }).meta.type).toBe('inbox')
  })
})

/* ================================================================ format-m1 === */

describe('format-m1: one table of limits, so a valid value is never changed by a save', () => {
  it('every extreme the operations allow is written and read back as it is', () => {
    const doc = board([note({ text: 'n' }), stroke(), { id: 0, group: 0, locked: false, kind: 'line', x1: 0, y1: 0, x2: 5, y2: 5, color: 'ffffff', width: 2, arrow: false }], { grid: BOARD_ITEM_LIMITS.grid.max })
    const set = (d: BoardDoc, id: number, patch: Parameters<typeof setProps>[2]): BoardDoc => setProps(d, [id], patch)
    let d = set(doc, 1, { size: BOARD_ITEM_LIMITS.noteSize.max, w: BOARD_ITEM_LIMITS.noteWidth.min })
    d = set(d, 2, { width: BOARD_ITEM_LIMITS.markWidth.max })
    d = set(d, 3, { width: BOARD_ITEM_LIMITS.markWidth.min })
    expect(d.items[0]).toMatchObject({ size: 2000, w: 16 })
    const back = parseBoard(serializeBoard(d, undefined, NOW))
    expect(back.warnings).toEqual([])
    expect(back.doc.items).toEqual(d.items)
    expect(back.doc.grid).toBe(BOARD_ITEM_LIMITS.grid.max)
    // The low ends too.
    const low = set(set(d, 1, { size: BOARD_ITEM_LIMITS.noteSize.min }), 2, { width: BOARD_ITEM_LIMITS.markWidth.min })
    expect(parseBoard(serializeBoard(low, undefined, NOW)).doc.items).toEqual(low.items)
  })

  it('a width a pen needs at the zoom limits (0.5 px at zoom 64 and 200 px at zoom 0.005) is a valid width', () => {
    expect(BOARD_ITEM_LIMITS.markWidth.min).toBeLessThanOrEqual(0.5 / BOARD_LIMITS.zoomMax)
    expect(BOARD_ITEM_LIMITS.markWidth.max).toBeGreaterThanOrEqual(200 / BOARD_LIMITS.zoomMin)
    const wide = parseBoard(`${FM}## Board\n- line x1=0 y1=0 x2=1 y2=1 color=ffffff width=40000\n- line x1=0 y1=0 x2=1 y2=1 color=ffffff width=.008\n`)
    expect(wide.warnings).toEqual([])
    expect(wide.doc.items.map((i) => (i as { width: number }).width)).toEqual([40000, 0.008])
  })
})

/* ================================================================ format-m4 === */

describe('format-m4: byte-order marks and lone carriage returns', () => {
  it('a BOM in front of a note without frontmatter does not hide the title or the first-line heading', () => {
    const raw = `\uFEFF# My Title\n\n## Board\n\n${VIEW}\n${NOTE1}\n`
    const { doc } = parseBoard(raw)
    expect(doc.title).toBe('My Title')
    expect(doc.items).toHaveLength(1)
    const out = serializeBoard(doc, raw, NOW)
    expect(out.startsWith('---\n')).toBe(false) // (the BOM stays first)
    const again = serializeBoard(parseBoard(out).doc, out, LATER)
    expect(again.replace(/updated: .*\n/, '')).toBe(out.replace(/updated: .*\n/, ''))
    // The heading itself on the first line.
    const first = `\uFEFF## Board\n\n${VIEW}\n${NOTE1}\n`
    expect(parseBoard(first).doc.items).toHaveLength(1)
    const written = serializeBoard(parseBoard(first).doc, first, NOW)
    expect(parseBoard(written).doc.items).toHaveLength(1)
    expect((written.match(/## Board/g) ?? []).length).toBe(1)
  })

  it('a lone carriage return is a line break', () => {
    const raw = `# T\r\r## Board\r\r${VIEW}\r${NOTE1}\r\rtail\r`
    const { doc } = parseBoard(raw)
    expect(doc.items).toHaveLength(1)
    expect(doc.title).toBe('T')
    const out = serializeBoard(doc, raw, NOW)
    expect(out.endsWith('\r\rtail\r')).toBe(true)
    // (The frontmatter block a note without one gets is written with LF; the note's own lines are not touched.)
    expect(out.slice(out.indexOf('# T'))).not.toContain('\n')
  })

  it('\\r\\r\\n endings settle in one write', () => {
    const raw = `${FM}## Board\r\r\n${VIEW}\r\r\n${NOTE1}\r\r\n`.replace(/^(.*?)## Board/s, (m) => m)
    const once = serializeBoard(parseBoard(raw).doc, raw, NOW)
    const twice = serializeBoard(parseBoard(once).doc, once, NOW)
    expect(twice).toBe(once)
  })
})

/* ================================================================ format-m5 === */

describe('format-m5 / geometry-m7: text is clean and cut safely; what a file holds is not cut by a save', () => {
  it('control characters other than tab and line breaks, DEL and lone surrogates are not kept', () => {
    expect(cleanText('a\u0000b\u0001c\u007fd\te\nf\rg\ud800h\udc00i😀')).toBe('abcd\te\nf\rghi😀')
    const doc = board([note({ text: 'a\u0000b\u001b[31m' }), pic({ caption: 'c\u0000d' })])
    const raw = serializeBoard(doc, undefined, NOW)
    expect(raw).not.toContain('\u0000')
    expect(raw).not.toContain('\u001b')
    const back = parseBoard(raw)
    expect((back.doc.items[0] as NoteItem).text).toBe('ab[31m')
    expect((back.doc.items[1] as PictureItem).caption).toBe('cd')
    // A file that holds them has them dropped on read.
    const dirty = parseBoard(`${FM}## Board\n- note x=0 y=0 w=300 size=18 color=ffffff fill= r=0 » a\u0000b\n`)
    expect((dirty.doc.items[0] as NoteItem).text).toBe('ab')
  })

  it('every cut keeps a surrogate pair whole: creation limits in the operations and the ceilings of the file', () => {
    expect(cutText('a'.repeat(3999) + '😀', 4000)).toBe('a'.repeat(3999))
    expect(cutText('abc', 10)).toBe('abc')
    expect(cutText('😀😀', 3)).toBe('😀')
    const long = 'a'.repeat(BOARD_LIMITS.noteChars - 1) + '😀'
    const made = addNote(emptyBoard('x'), { text: long }).doc.items[0] as NoteItem
    expect(made.text).toBe('a'.repeat(BOARD_LIMITS.noteChars - 1))
    const caption = addPicture(emptyBoard('x'), { path: 'a.png', w: 10, h: 10, caption: long }).doc.items[0] as PictureItem
    expect(caption.caption).toBe('a'.repeat(BOARD_LIMITS.noteChars - 1))
    const edited = setProps(board([note()]), [1], { text: long }).items[0] as NoteItem
    expect(edited.text).toBe('a'.repeat(BOARD_LIMITS.noteChars - 1))
    const big = 'b'.repeat(BOARD_LIMITS.noteCharsFile - 1) + '😀'
    const fromFile = parseBoard(`${FM}## Board\n- note x=0 y=0 w=300 size=18 color=ffffff fill= r=0 » ${big}\n`)
    expect((fromFile.doc.items[0] as NoteItem).text).toBe('b'.repeat(BOARD_LIMITS.noteCharsFile - 1))
    const written = serializeBoard(board([note({ text: big })]), undefined, NOW)
    expect(parseBoard(written).doc.items[0]).toMatchObject({ text: 'b'.repeat(BOARD_LIMITS.noteCharsFile - 1) })
    expect(written).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })

  it('a stroke over 3,000 points or a note over 4,000 characters in a file is not cut by a save, nor by an edit of something else; new ones are held to the creation limits', () => {
    const points = Array.from({ length: 5000 }, (_, i) => `${i},${i % 97}`).join(' ')
    const longNote = 'w'.repeat(9000)
    const raw = `${FM}## Board\n\n${VIEW}\n- stroke color=ffffff width=2 pts=${points}\n- note x=0 y=0 w=300 size=18 color=ffffff fill= r=0 » ${longNote}\n`
    const { doc, warnings } = parseBoard(raw)
    expect(warnings).toEqual([])
    expect((doc.items[0] as StrokeItem).points).toHaveLength(10_000)
    expect((doc.items[1] as NoteItem).text).toHaveLength(9000)
    expect(serializeBoard(doc, raw, NOW)).toBe(raw)
    // Moved, set a colour, saved: all still there.
    const edited = setProps(moveItems(doc, [1, 2], 5, 5), [1, 2], { color: '00ff00' })
    const out = serializeBoard(edited, raw, NOW)
    const back = parseBoard(out).doc
    expect((back.items[0] as StrokeItem).points).toHaveLength(10_000)
    expect((back.items[1] as NoteItem).text).toHaveLength(9000)
    // An edit of the text may not grow it past what a user can make, but keeps what was there.
    expect(((setProps(doc, [2], { text: 'z'.repeat(8000) }).items[1]) as NoteItem).text).toHaveLength(8000)
    expect(((setProps(doc, [2], { text: 'z'.repeat(9500) }).items[1]) as NoteItem).text).toHaveLength(9000)
    expect(((setProps(board([note()]), [1], { text: 'z'.repeat(9500) }).items[0]) as NoteItem).text).toHaveLength(BOARD_LIMITS.noteChars)
    // Creation is held to the limits.
    const pts = Array.from({ length: 2 * 4000 }, (_, i) => i)
    const created = addMark(emptyBoard('x'), { kind: 'stroke', points: pts, color: 'ffffff', width: 2 }).doc.items[0] as StrokeItem
    expect(created.points).toHaveLength(2 * BOARD_LIMITS.strokePoints)
    expect((addNote(emptyBoard('x'), { text: 'q'.repeat(5000) }).doc.items[0] as NoteItem).text).toHaveLength(BOARD_LIMITS.noteChars)
  })
})

/* ============================================================== names ======= */

describe('boardFolderName and boardPictureName keep to what the vault accepts', () => {
  it('a picture name loses a leading $ like a folder name does', () => {
    expect(boardPictureName('$R1A2B3C.png', 'image/png', NOW)).toBe('R1A2B3C.png')
    expect(boardPictureName('$100 bill.png', 'image/png', NOW)).toBe('100 bill.png')
    expect(boardPictureName('$.png', 'image/png', NOW)).toBe('ref 2026-10-09 143512.png')
    expect(boardPictureName('$$$a.png', 'image/png', NOW)).toBe('a.png')
    expect(boardPictureName('-$.a.png', 'image/png', NOW)).toBe('a.png')
    expect(boardPictureName('a$b.png', 'image/png', NOW)).toBe('a$b.png')
    expect(boardPictureName('c:\\Recycle\\$R9.png', 'image/png', NOW)).toBe('R9.png')
  })

  it('a board\'s folder carries its note\'s name, up to the longest file name a note gets (live-docked-m7)', () => {
    const stem = slugifyTitle('Gate reference '.repeat(2) + 'x'.repeat(130))
    expect(stem).toHaveLength(120)
    expect(boardFolderName(stem)).toBe(stem)
    expect(boardFolderName('y'.repeat(300))).toHaveLength(120)
  })

  it('the names of game libraries get " pictures" after them, like the other names the vault leaves out', () => {
    for (const name of ['Steam', 'ubisoft', 'Epic Games', 'Riot Games', 'Rockstar Games', 'Battle.net', 'EA Games', 'Windows.old', 'Found.000', 'Steam Library']) {
      expect(boardFolderName(name), name).toBe(`${name} pictures`)
    }
    expect(boardFolderName('Steam. ')).toBe('Steam pictures')
    expect(boardFolderName('Steamed hams')).toBe('Steamed hams')
  })
})

/* a few helpers kept for the budget tests above */
void LATER
