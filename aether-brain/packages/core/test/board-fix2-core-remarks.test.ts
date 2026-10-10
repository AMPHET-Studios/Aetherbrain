import { describe, expect, it } from 'vitest'
import { parseBoard, serializeBoard } from '../src/board/format'
import { splitFrontmatter } from '../src/markdown/frontmatter'
import { emptyBoard } from '../src/board/types'
import type { BoardDoc, BoardItem } from '../src/board/types'

/**
 * Round-2 review fix diff-core-m3: a bullet of the user's that starts with the name of a kind and sits after a blank line between two
 * lines of the board (`- line 3 is wrong`) is a remark the board keeps (an extra). It used to be written straight under the last
 * item, where the reader takes such a line for a hand-written item: the next read drew it as a line and lost characters (the `3`).
 * The writer now puts the remark where the reader finds it again: behind a blank line, before the last item it can follow.
 *
 * (diff-core-m2, prose between the heading and the first item or between items, is NOT changed: see the last test.)
 */

const NOW = new Date(2026, 9, 10, 9, 0, 0)
const FM = ['---', 'title: Gate', 'type: board', '---', ''].join('\n')
const VIEW = '- view x=0 y=0 zoom=1 bg=14161d gray=0 smooth=1 captions=0 grid=0'
const A = '- note x=1 y=1 w=300 size=18 color=ffffff fill= r=0 » a'
const B = '- note x=2 y=2 w=300 size=18 color=ffffff fill= r=0 » b'
const bodyOf = (raw: string): string => splitFrontmatter(raw).body

describe('diff-core-m3: a kind-named bullet of the user\'s between two lines of the board', () => {
  const raw = `${FM}## Board\n\n${VIEW}\n${A}\n\n- line 3 is wrong\n${B}\n\nAfter\n`

  it('is kept as an extra, written back where it is read as an extra again, and the second read, the second save and an in-session save change nothing', () => {
    const first = parseBoard(raw)
    expect(first.doc.items).toHaveLength(2)
    expect(first.doc.extra).toEqual(['- line 3 is wrong'])
    const saved = serializeBoard(first.doc, raw, NOW)
    // The bullet keeps its place behind a blank line, before the last item: not under it (where it would be an item).
    expect(bodyOf(saved)).toBe(`## Board\n\n${VIEW}\n${A}\n\n- line 3 is wrong\n${B}\n\nAfter\n`)
    // Read again: two items, the same remark, no word of it lost or drawn, no warning.
    const second = parseBoard(saved)
    expect(second.warnings).toEqual([])
    expect(second.doc.items.map((i) => i.kind)).toEqual(['note', 'note'])
    expect(second.doc.extra).toEqual(['- line 3 is wrong'])
    expect(serializeBoard(second.doc, saved, NOW)).toBe(saved)
    // The session keeps the doc it read the first time and saves it onto the text it wrote: the remark is not written twice.
    expect(serializeBoard(first.doc, saved, NOW)).toBe(saved)
    expect(saved.split('line 3 is wrong')).toHaveLength(2)
  })

  it('keeps the order of the lines the board keeps: prose before the remark, the remark, prose after the last item', () => {
    const text = `${FM}## Board\n\n${VIEW}\n${A}\nprose one\n\n- note the colours\n- view from the north\n${B}\nprose two\n\nAfter\n`
    const { doc } = parseBoard(text)
    expect(doc.items).toHaveLength(2)
    expect(doc.extra).toEqual(['prose one', '- note the colours', '- view from the north', 'prose two'])
    const saved = serializeBoard(doc, text, NOW)
    expect(saved).toBe(text.replace(/updated: .*\n/, ''))
    const again = parseBoard(saved).doc
    expect(again.extra).toEqual(doc.extra)
    expect(serializeBoard(again, saved, NOW)).toBe(saved)
    expect(serializeBoard(doc, saved, NOW)).toBe(saved)
  })

  it('moves a remark that was behind the last item (after a blank line, where it was theirs) nowhere: it stays outside the board', () => {
    const text = `${FM}## Board\n\n${VIEW}\n${A}\n${B}\n\n- line 3 is wrong\n\nAfter\n`
    const { doc } = parseBoard(text)
    expect(doc.extra).toEqual([])
    expect(serializeBoard(doc, text, NOW)).toBe(text)
  })

  it('with a code fence or a comment among the lines, and a remark inside a fence (which is no remark)', () => {
    const text = `${FM}## Board\n\n${VIEW}\n${A}\n\`\`\`\n- line inside a fence\n\n## not a heading\n\`\`\`\n\n- line 3 is wrong\n<!--\n- note inside a comment\n-->\n${B}\n\nAfter\n`
    const { doc } = parseBoard(text)
    expect(doc.items).toHaveLength(2)
    expect(doc.extra).toEqual(['```', '- line inside a fence', '', '## not a heading', '```', '- line 3 is wrong', '<!--', '- note inside a comment', '-->'])
    const saved = serializeBoard(doc, text, NOW)
    // Up to the last remark the lines go before the last item (the fence and the remark); what follows it goes after the items, as ever.
    expect(bodyOf(saved)).toBe(
      `## Board\n\n${VIEW}\n${A}\n\`\`\`\n- line inside a fence\n\n## not a heading\n\`\`\`\n\n- line 3 is wrong\n${B}\n<!--\n- note inside a comment\n-->\n\nAfter\n`,
    )
    expect(parseBoard(saved).doc.extra).toEqual(doc.extra)
    expect(serializeBoard(doc, saved, NOW)).toBe(saved)
    expect(serializeBoard(parseBoard(saved).doc, saved, NOW)).toBe(saved)
  })

  it('a board with no item to follow the remark keeps it as it did before (written under the view line), and nothing is written twice', () => {
    const text = `${FM}## Board\n\n${VIEW}\n\n- line 3 is wrong\n- view from the north\n\nAfter\n`
    const { doc } = parseBoard(text)
    const saved = serializeBoard(doc, text, NOW)
    expect(saved.split('line 3 is wrong')).toHaveLength(2)
    expect(serializeBoard(doc, saved, NOW)).toBe(saved)
  })

  it('works in a CRLF note, and on a board that is over the item limit (the remark goes before the last item the board shows; the lines past the limit stay after)', () => {
    const crlf = raw.replace(/\n/g, '\r\n')
    const saved = serializeBoard(parseBoard(crlf).doc, crlf, NOW)
    expect(saved.replace(/\r\n/g, '\n')).toContain(`${A}\n\n- line 3 is wrong\n${B}\n\nAfter`)
    expect(saved).not.toMatch(/[^\r]\n/)
    expect(serializeBoard(parseBoard(saved).doc, saved, NOW)).toBe(saved)

    const notes = Array.from({ length: 1503 }, (_, i) => `- note x=${i} y=0 w=300 size=18 color=ffffff fill= r=0 » n${i}`)
    const big = `${FM}## Board\n\n${VIEW}\n${notes.slice(0, 10).join('\n')}\n\n- line 3 is wrong\n${notes.slice(10).join('\n')}\n\nAfter\n`
    const first = parseBoard(big)
    expect(first.doc.items).toHaveLength(1500)
    expect(first.doc.extra).toEqual(['- line 3 is wrong', ...notes.slice(1500)])
    const out = serializeBoard(first.doc, big, NOW)
    const again = parseBoard(out)
    expect(again.doc.items).toHaveLength(1500)
    expect(again.doc.extra).toEqual(first.doc.extra)
    expect(serializeBoard(again.doc, out, NOW)).toBe(out)
    expect(serializeBoard(first.doc, out, NOW)).toBe(out)
    expect(out.split('line 3 is wrong')).toHaveLength(2)
  })

  it('does not touch a board that has no such remark: the same bytes as before', () => {
    const plain = `${FM}## Board\n\n${VIEW}\n${A}\nstuck to the list\n${B}\n\nAfter\n`
    const { doc } = parseBoard(plain)
    expect(bodyOf(serializeBoard(doc, plain, NOW))).toBe(`## Board\n\n${VIEW}\n${A}\n${B}\nstuck to the list\n\nAfter\n`)
  })
})

/* ------------------------------------------------------------------ fuzz --- */

class R {
  constructor(private a: number) {}
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0
    let t = this.a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!
  }
}

/** Chunks of lines the board may keep: remarks of every kind, prose, other bullets, fences and comments that hold bullets. */
const CHUNKS: string[][] = [
  ['- line 3 is wrong'],
  ['- note the colours of [[Palette]] and #tagged'],
  ['- view from the north'],
  ['- pic of the gate'],
  ['- ![[Some Note]]'],
  ['- rect'],
  ['- stroke a deal with [[Bob]]'],
  ['- ellipse is round', '- line up the panels'],
  ['some prose'],
  ['---'],
  ['- [ ] a task'],
  ['- [x] done'],
  ['- gizmo x=1 » a newer version'],
  ['* a star bullet'],
  ['1. numbered'],
  ['```js', '- note x=9 » inside a fence', '', '## inner heading', '```'],
  ['~~~', '- line in a tilde fence', '~~~'],
  ['<!-- one line -->'],
  ['<!--', '- note inside a comment', '', '-->'],
]

function randDoc(r: R): BoardDoc {
  const items: BoardItem[] = []
  for (let n = r.int(1, 6); n > 0; n--) {
    items.push(
      r.next() < 0.3
        ? { id: 0, group: 0, locked: false, kind: 'picture', path: `Boards/Gate/p${n}.png`, x: n, y: 0, w: 100, h: 80, rotation: 0, crop: { l: 0, t: 0, r: 1, b: 1 }, flipH: false, flipV: false, gray: false, opacity: 1, caption: r.pick(['', 'a caption']) }
        : { id: 0, group: 0, locked: false, kind: 'note', text: r.pick(['one', 'two words', 'x']), x: n, y: n, w: 300, size: 18, rotation: 0, color: 'ffffff', fill: '' },
    )
  }
  const extra: string[] = []
  for (let n = r.int(1, 4); n > 0; n--) extra.push(...r.pick(CHUNKS))
  return { ...emptyBoard('Fuzz'), items: items.map((it, i) => ({ ...it, id: i + 1 })), nextId: items.length + 1, extra }
}

describe('diff-core-m3: random boards with kind-named bullets among their extras', () => {
  it('lose nothing, keep the order of their lines, and change nothing on a second read or save, in or out of the session (800 boards)', () => {
    const r = new R(20261010)
    let remarks = 0
    for (let i = 0; i < 800; i++) {
      const doc = randDoc(r)
      for (const tail of ['', '\nUser tail.\n']) {
        const base = serializeBoard(doc, undefined, NOW)
        const text = base + tail
        const first = serializeBoard(doc, text, NOW)
        const back = parseBoard(first)
        // Everything the board kept comes back, in order, as extras (a blank line outside a fence is not kept), and the items are the items.
        const want = doc.extra.flatMap((e) => e.split('\n')).filter((l, k, all) => l !== '' || allInFence(all, k))
        expect(back.doc.extra, `doc ${i}: ${JSON.stringify(doc.extra)}`).toEqual(want)
        expect(back.doc.items.map((it) => it.kind), `doc ${i}`).toEqual(doc.items.map((it) => it.kind))
        // Stable: the second save from the re-read doc, and from the doc the session still holds, give the same text.
        expect(serializeBoard(back.doc, first, NOW), `doc ${i}`).toBe(first)
        expect(serializeBoard(doc, first, NOW), `doc ${i} in session`).toBe(first)
        // The user's text below the board is where it was, once.
        if (tail) expect(first.endsWith('\nUser tail.\n') && first.split('User tail.').length === 2, `doc ${i}`).toBe(true)
        if (doc.extra.some((l) => /^- (line|view|note|pic|rect|stroke|ellipse|!\[\[)/.test(l))) remarks++
      }
    }
    // The fuzz really met remarks (most of the boards).
    expect(remarks).toBeGreaterThan(800)
  })
})

/** Whether the blank line at `k` of the chunk-lines is inside a fence or comment (where the board keeps it). */
function allInFence(lines: string[], k: number): boolean {
  let fence: string | null = null
  for (let n = 0; n <= k; n++) {
    const t = lines[n]!
    if (fence !== null) {
      if (fence === '<!--' ? t.includes('-->') : t.startsWith(fence)) {
        if (n === k) return false
        fence = null
      }
      continue
    }
    if (t.startsWith('```')) fence = '```'
    else if (t.startsWith('~~~')) fence = '~~~'
    else if (t.startsWith('<!--') && !t.includes('-->')) fence = '<!--'
  }
  return fence !== null
}

describe('diff-core-m2 (prose between the heading and the first item, or between items) is not changed', () => {
  it('still goes after the items, in order, without its blank lines: any blank line the board wrote would end the board for the reader', () => {
    const text = `${FM}## Board\n\nSome thoughts.\n\n---\n\nMore.\n\n${VIEW}\n${A}\n`
    const { doc } = parseBoard(text)
    expect(doc.extra).toEqual(['Some thoughts.', '---', 'More.'])
    // (The documented behaviour: write your own text above the heading or below the board.)
    expect(bodyOf(serializeBoard(doc, text, NOW))).toBe(`## Board\n\n${VIEW}\n${A}\nSome thoughts.\n---\nMore.\n`)
  })
})
