import { describe, expect, it } from 'vitest'
import { BOARD_LIMITS, addNote, addPicture, boardChars, boardPictures, emptyBoard, newBoardNote, parseBoard, serializeBoard, type BoardDoc } from '@aether/core'
import { BOARD_BUDGET_TEXT, addPicturesToBoardText } from '../src/board/boardRegistry'

/*
 * format-1 (registry half), shell-7: pictures put on a board that is not open never grow it past its size budget
 * (BOARD_LIMITS.noteTotal characters of items, measured by core's boardChars); as many as fit are added, the rest are counted in
 * `over`, and a board that is over the budget already takes none (it can be thinned, never grown).
 */

const NOW = new Date('2026-10-10T10:00:00')
const pics = (n: number, prefix = 'new') => Array.from({ length: n }, (_, i) => ({ path: `Art/${prefix}${i}.png`, w: 400, h: 300 }))
const noteText = 'x'.repeat(BOARD_LIMITS.noteChars)

/** A board of 4,000-character notes, then one shorter note, until it has `room` characters of the budget left (below 0: over it). */
function boardWithRoom(room: number): { raw: string; doc: BoardDoc } {
  let doc = emptyBoard('Heavy')
  const target = BOARD_LIMITS.noteTotal - room
  let i = 0
  while (boardChars(doc) + 4400 < target) doc = addNote(doc, { text: noteText, x: (i++ % 20) * 600, y: Math.floor(i / 20) * 400 }).doc
  const gap = target - boardChars(doc)
  if (gap > 400) doc = addNote(doc, { text: 'x'.repeat(gap - 300), x: 0, y: -400 }).doc
  return { raw: serializeBoard(doc, newBoardNote('Heavy', NOW), NOW), doc }
}

describe('pictures onto a board close to its size budget', () => {
  it('adds as many as fit, counts the rest as over, and stays within the budget', () => {
    const { raw, doc } = boardWithRoom(1500)
    expect(boardChars(doc)).toBeLessThan(BOARD_LIMITS.noteTotal)
    const res = addPicturesToBoardText(raw, pics(150), NOW)
    expect(res.added).toBeGreaterThan(0)
    expect(res.added).toBeLessThan(150)
    expect(res.over).toBe(150 - res.added)
    expect(res.full).toBe(0)
    const after = parseBoard(res.text).doc
    expect(boardChars(after)).toBeLessThanOrEqual(BOARD_LIMITS.noteTotal)
    expect(boardPictures(after)).toHaveLength(res.added)
    expect(res.paths).toHaveLength(res.added)
  })

  it('adds nothing to a board that is over the budget already, and hands back the very same text', () => {
    // Loaded over the budget (a hand-written or older board): editable and thinnable, never grown.
    const { raw } = boardWithRoom(-20_000)
    expect(boardChars(parseBoard(raw).doc)).toBeGreaterThan(BOARD_LIMITS.noteTotal)
    const res = addPicturesToBoardText(raw, pics(5), NOW)
    expect(res).toMatchObject({ added: 0, over: 5, full: 0, skipped: 0 })
    expect(res.text).toBe(raw)
  })

  it('adds all of them with room to spare, and says nothing about the budget', () => {
    const { raw } = boardWithRoom(100_000)
    const res = addPicturesToBoardText(raw, pics(20), NOW)
    expect(res).toMatchObject({ added: 20, over: 0 })
  })

  it('counts a picture that does not fit apart from one the board already shows and from the item limit', () => {
    const { raw, doc } = boardWithRoom(1500)
    const seen = addPicture(doc, { path: 'Art/seen.png', w: 10, h: 10, x: 0, y: 0 }).doc
    const withSeen = serializeBoard(seen, raw, NOW)
    const res = addPicturesToBoardText(withSeen, [...pics(150), { path: 'Art/seen.png', w: 10, h: 10 }], NOW)
    expect(res.skipped).toBe(1)
    expect(res.full).toBe(0)
    expect(res.over).toBeGreaterThan(0)
    expect(res.added + res.over).toBe(150)
  })

  it('names the budget in the words the board itself uses', () => {
    expect(BOARD_BUDGET_TEXT).toBe(`it holds at most about ${BOARD_LIMITS.noteTotal.toLocaleString('en-US')} characters of items`)
    expect(BOARD_BUDGET_TEXT).toContain('500,000')
  })
})
