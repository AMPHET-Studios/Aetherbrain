import { describe, expect, it } from 'vitest'
import { addNote, addPicture } from '../src/board/ops'
import { boardNoteParts, parseBoard, serializeBoard } from '../src/board/format'
import { BOARD_LIMITS, emptyBoard } from '../src/board/types'
import { parseNote } from '../src/markdown/parse'
import { splitFrontmatter } from '../src/markdown/frontmatter'
import { SearchIndex } from '../src/search/index'

/**
 * Round-2 review fix diff-core-m1: what is written on a board is searchable again. The board's item lines are read by the board's own
 * scanner and kept out of the markdown parser (a full board cost 0.3 to 0.8 s on every save), which also took the text of the notes and
 * the picture captions out of `plain` (the search body) and the word count. `boardNoteParts` now hands those words over (`texts`) and
 * parseNote adds them to `plain`: as words only, never as links, tags or coordinates.
 */

const NOW = new Date(2026, 9, 10, 9, 0, 0)

/** A board note with the given items, written by the real serializer. */
function boardNote(build: (doc: ReturnType<typeof emptyBoard>) => ReturnType<typeof emptyBoard>): string {
  return serializeBoard(build(emptyBoard('Gate reference')), undefined, NOW)
}

function search(raw: string, query: string): string[] {
  const note = parseNote({ path: 'Boards/Gate reference.md', content: raw })
  const other = parseNote({ path: 'Notes/Other.md', content: '# Other\n\nnothing about the query here\n' })
  const index = new SearchIndex()
  index.rebuild([note, other])
  return index.search(query).map((h) => h.id)
}

describe('diff-core-m1: the words on a board are search text and count as words', () => {
  it('search finds a board by the text typed in one of its notes ("rust gate") and by a picture caption', () => {
    const raw = boardNote((d0) => {
      const d1 = addNote(d0, { text: 'unicornmarker rust gate patina', x: 10, y: 20 }).doc
      return addPicture(d1, { path: 'Boards/Gate reference/gate.png', w: 400, h: 300, caption: 'captionmarker lintel' }).doc
    })
    expect(search(raw, 'rust gate')).toEqual(['Boards/Gate reference'])
    expect(search(raw, 'unicornmarker')).toEqual(['Boards/Gate reference'])
    expect(search(raw, 'captionmarker')).toEqual(['Boards/Gate reference'])
    expect(search(raw, 'lintel')).toEqual(['Boards/Gate reference'])
    // A word that is nowhere on the board finds nothing.
    expect(search(raw, 'xyzzyplugh')).toEqual([])
  })

  it('puts exactly those words in plain - no coordinate, attribute, colour, flag or item line - and counts them', () => {
    const raw = boardNote((d0) => {
      const d1 = addNote(d0, { text: 'rust gate', x: 123, y: -456, w: 321 }).doc
      return addPicture(d1, { path: 'Boards/Gate reference/gate.png', w: 400, h: 300, caption: 'old lintel' }).doc
    })
    const n = parseNote({ path: 'Boards/Gate reference.md', content: raw })
    // The text of the note and of the caption, after the words the note itself holds (its heading, its intro, "Board").
    expect(n.plain.split(' Board ').pop()).toBe('rust gate old lintel')
    // Not a digit anywhere (the intro's "(8)" apart): no coordinate, size, colour or group number, no '=' of an attribute, no path.
    expect(n.plain.replace('(8)', '')).not.toMatch(/\d|=|gate\.png/)
    // The same note without the words has four fewer.
    const bare = boardNote((d0) => addPicture(d0, { path: 'Boards/Gate reference/gate.png', w: 400, h: 300 }).doc)
    expect(n.meta.wordCount).toBe(parseNote({ path: 'Boards/Gate reference.md', content: bare }).meta.wordCount + 4)
  })

  it('reads the words as the board decodes them: line breaks, escaped characters and the "»" survive; none of it is a link, a tag or a task', () => {
    const text = 'see [[Gate]] and #urgent\n*now* » then _later_ \\ done'
    const raw = boardNote((d0) => addNote(d0, { text }).doc)
    const n = parseNote({ path: 'Boards/Gate reference.md', content: raw })
    // `plain` is what search and mentions read: the link syntax is stripped to its words, as for any note; the rest is as typed.
    expect(n.plain.endsWith(' Board see Gate and #urgent *now* » then _later_ \\ done')).toBe(true)
    expect(n.links).toEqual([])
    expect(n.inlineTags).toEqual([])
    expect(n.meta.tags).toEqual([])
    const parts = boardNoteParts(splitFrontmatter(raw).body)!
    expect(parts.texts).toEqual([text])
  })

  it('reads hand-written lines the way the board does (a note with " » ", a caption on a `pic` line), and leaves out the lines the board keeps as extras (they are markdown, not items)', () => {
    const body = ['## Board', '', '- view x=0 y=0', '- note » typed by hand', '- pic Boards/a.png w=10 h=10 » hand caption', '- stroke pts=1,2 3,4', 'a remark between items', '- note x=1 »', '- line x1=0 y1=0 x2=1 y2=1', '- note x=2 y=3 » second note', ''].join('\n')
    const parts = boardNoteParts(body)!
    // (An empty text is no words; a line the board keeps as an extra stays in `text`, where the markdown parser reads it.)
    expect(parts.texts).toEqual(['typed by hand', 'hand caption', 'second note'])
    expect(parts.text).toContain('a remark between items')
    expect(parts.text).not.toContain('typed by hand')
    const n = parseNote({ path: 'B.md', content: `---\ntype: board\n---\n${body}` })
    expect(n.plain).toContain('typed by hand hand caption second note')
    expect(n.plain).toContain('a remark between items')
  })

  it('counts the words of the first 1,500 items only, the ones the board shows', () => {
    const lines = Array.from({ length: BOARD_LIMITS.items + 3 }, (_, i) => `- note x=${i} y=0 » word${i}`)
    const parts = boardNoteParts(['## Board', '', '- view x=0', ...lines, ''].join('\n'))!
    expect(parts.texts).toHaveLength(BOARD_LIMITS.items)
    expect(parts.texts[BOARD_LIMITS.items - 1]).toBe(`word${BOARD_LIMITS.items - 1}`)
  })

  it('is unchanged by a save of the same board, and follows an edit of the words (and only them)', () => {
    const raw = boardNote((d0) => addNote(d0, { text: 'first words' }).doc)
    const doc = parseBoard(raw).doc
    const again = serializeBoard(doc, raw, NOW)
    expect(parseNote({ path: 'Boards/Gate reference.md', content: again }).plain).toBe(parseNote({ path: 'Boards/Gate reference.md', content: raw }).plain)
    const edited = serializeBoard(addNote(doc, { text: 'second words' }).doc, raw, NOW)
    expect(search(edited, 'second')).toEqual(['Boards/Gate reference'])
    expect(search(raw, 'second')).toEqual([])
  })

  it('a note without a board section, or not of type board, is read as before', () => {
    expect(boardNoteParts('# Just prose\n\n- note x=1 » a\n')).toBeNull()
    const n = parseNote({ path: 'N.md', content: '---\ntype: note\n---\n## Board\n\n- note x=1 » plain words\n' })
    expect(n.plain).toContain('plain words')
    expect(n.plain).toContain('x=1')
  })
})
