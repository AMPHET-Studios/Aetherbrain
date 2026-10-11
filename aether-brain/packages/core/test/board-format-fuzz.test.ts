import { describe, expect, it } from 'vitest'
import { splitFrontmatter } from '../src/markdown/frontmatter'
import { parseMarkdown, parseNote } from '../src/markdown/parse'
import { extractTasks } from '../src/markdown/tasks'
import { isBoardNote, parseBoard, safeEmbedPath, serializeBoard } from '../src/board/format'
import { BOARD_ITEM_LIMITS } from '../src/board/ops'
import { escapeBoardText, unescapeBoardText } from '../src/board/text'
import { isMediaPath } from '../src/vault/assets'
import { BOARD_LIMITS, emptyBoard } from '../src/board/types'
import type { BoardDoc, BoardItem, Crop } from '../src/board/types'

const NOW = new Date(2026, 9, 9, 14, 35, 12)
const LATER = new Date(2026, 9, 20, 8, 0, 0)

/* ------------------------------------------------------------ the random -- */

/** mulberry32: a small seeded generator, so a failure can be run again. */
class R {
  private a: number
  constructor(seed: number) {
    this.a = seed >>> 0
  }
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0
    let t = this.a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  /** An integer from lo to hi, both included. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)]!
  }
  chance(p: number): boolean {
    return this.next() < p
  }
}

const q = (n: number, dec: number): number => Number(n.toFixed(dec)) + 0

/** A number in [lo, hi] with `dec` decimals: now and then an edge or zero, mostly a modest one. */
function num(r: R, lo: number, hi: number, dec: number): number {
  const roll = r.next()
  if (roll < 0.04) return q(lo, dec)
  if (roll < 0.08) return q(hi, dec)
  if (roll < 0.14 && lo <= 0 && hi >= 0) return 0
  const wide = hi - lo <= 2000 || r.chance(0.3)
  const a = wide ? lo : Math.max(lo, -2000)
  const b = wide ? hi : Math.min(hi, 2000)
  return Math.min(hi, Math.max(lo, q(a + r.next() * (b - a), dec)))
}

const TEXT_BITS = [
  'a', 'Word', 'x', '1', ' ', ' ', '  ', '_', '*', '~', '#', '|', '[', ']', '[[', ']]', '<', '>', '!', '`', '```', '\\', '\\\\', '\\n', '\n', '\r', '\r\n', '&', '&amp;', '&#91;', ';',
  ':', '@', '/', '.', '-', '(', ')', '»', ' » ', ' »', '» ', 'ü', '日本', '😀', ' ', '=', ',', 'x=1', '![[a.png]]', '[[Secret]]', '#tag', ' #tag', '- [ ] task', '<script>',
  '<!--', '-->', '| a |', '\t', '"', "'", '***', '___', '~~', '1. ', '> ', '# ', '---',
]

/**
 * Web and e-mail addresses. GFM turns these into links; when it did so late (after a punctuation mark: `)www.a.b`) the pieces of the
 * text lost their place in the source, and parseNote read an escaped `\[\[x\]\]` or `\#tag` next to them as live (the last test of this
 * file). They are in the mix of every test now.
 */
const ADDRESS_BITS = ['http://x.example', 'www.x.example', 'a@b.example']

function randText(r: R, maxBits: number, addresses = true): string {
  const bits = addresses ? [...TEXT_BITS, ...ADDRESS_BITS] : TEXT_BITS
  let s = ''
  for (let n = r.int(0, maxBits); n > 0; n--) s += r.pick(bits)
  return s
}

const NAME_BITS = ['a', 'b', 'Z', '0', '9', ' ', ' ', '_', '*', '~', '#', '|', '[', ']', '<', '>', '&', '@', ':', '.', '-', '(', ')', 'ü', '日', '😀', '`', '\\', "'", '!', ' » ', '%', 'www.', 'http://', '&amp;', 'photo@2x']
const EXTENSIONS = ['.png', '.png', '.jpg', '.PNG', '.webp', '.gif', '.jpeg', '.bmp', '.avif', '.txt', '']

/** Name pieces that GFM would link as an address (see ADDRESS_BITS). */
const ADDRESS_NAME_BITS = new Set(['@', 'www.', 'http://', 'photo@2x'])

function randPath(r: R, addresses = true): string {
  if (r.chance(0.02)) return ''
  const bits = addresses ? NAME_BITS : NAME_BITS.filter((b) => !ADDRESS_NAME_BITS.has(b))
  const parts: string[] = []
  for (let n = r.int(1, 3); n > 0; n--) {
    let part = ''
    for (let k = r.int(1, 6); k > 0; k--) part += r.pick(bits)
    parts.push(part)
  }
  return parts.join('/') + r.pick(EXTENSIONS)
}

function plainPath(r: R): string {
  const words = ['Boards', 'Gate reference', 'rust', 'ref 2026-10-09 143512', 'Größe', '日本語', 'D', 'Pictures', 'x_y', 'a (1)', 'v2.final']
  const parts: string[] = []
  for (let n = r.int(1, 3); n > 0; n--) parts.push(r.pick(words))
  return parts.join('/') + r.pick(['.png', '.jpg', '.webp'])
}

const IL = BOARD_ITEM_LIMITS

/** The same board note, read as a plain note: its lines go through the real markdown parser (the preview and the MCP tools read them so). */
const plain = (raw: string): string => raw.replace('type: board', 'type: note')

/** Attributes and flags this version does not know; the reader keeps them and writes them back after the known ones. */
const UNKNOWN_TOKENS = ['theme=dark', 'pinned', 'tint=ff0000', 'blend=multiply', 'smooth=3', 'dash=4', 'radius=5', 'shadow', 'v2', 'k=1,2', 'url=www.x.y', 'a-b=c:d']

function unknownOf(r: R): string[] | undefined {
  if (!r.chance(0.25)) return undefined
  const out: string[] = []
  for (let n = r.int(1, 3); n > 0; n--) out.push(r.pick(UNKNOWN_TOKENS))
  return out
}

const hex = (r: R): string => Array.from({ length: 6 }, () => '0123456789abcdef'[r.int(0, 15)]).join('')
const GROUPS = [0, 0, 0, 0, 0, 1, 2, 3, 7, 12]

function randCrop(r: R): Crop {
  if (r.chance(0.5)) return { l: 0, t: 0, r: 1, b: 1 }
  const pair = (): [number, number] => {
    for (let i = 0; i < 20; i++) {
      const a = num(r, 0, 1, 3)
      const b = num(r, 0, 1, 3)
      if (a < b) return [a, b]
    }
    return [0, 1]
  }
  const [l, rr] = pair()
  const [t, b] = pair()
  return { l, t, r: rr, b }
}

function randItem(r: R): BoardItem {
  const unknown = unknownOf(r)
  const common = { id: 0, group: r.pick(GROUPS), locked: r.chance(0.2), ...(unknown ? { unknown } : {}) }
  const coord = () => num(r, -1_000_000, 1_000_000, 2)
  const width = () => num(r, IL.markWidth.min, IL.markWidth.max, 3)
  switch (r.pick(['picture', 'picture', 'note', 'note', 'stroke', 'line', 'rect', 'ellipse'] as const)) {
    case 'picture':
      return {
        ...common,
        kind: 'picture',
        path: r.chance(0.5) ? plainPath(r) : randPath(r),
        x: coord(),
        y: coord(),
        w: num(r, 8, 40000, 2),
        h: num(r, 8, 40000, 2),
        rotation: num(r, -179.99, 180, 2),
        crop: randCrop(r),
        flipH: r.chance(0.3),
        flipV: r.chance(0.3),
        gray: r.chance(0.3),
        opacity: num(r, 0.05, 1, 2),
        caption: r.chance(0.5) ? '' : randText(r, 12),
      }
    case 'note':
      return {
        ...common,
        kind: 'note',
        text: r.chance(0.1) ? '' : randText(r, 25),
        x: coord(),
        y: coord(),
        w: num(r, IL.noteWidth.min, IL.noteWidth.max, 2),
        size: num(r, IL.noteSize.min, IL.noteSize.max, 2),
        rotation: num(r, -179.99, 180, 2),
        color: hex(r),
        fill: r.chance(0.5) ? '' : hex(r),
      }
    case 'stroke': {
      const points: number[] = []
      for (let n = r.chance(0.1) ? r.int(100, 600) : r.int(0, 40); n > 0; n--) points.push(coord(), coord())
      return { ...common, kind: 'stroke', points, color: hex(r), width: width() }
    }
    case 'line':
      return { ...common, kind: 'line', x1: coord(), y1: coord(), x2: coord(), y2: coord(), color: hex(r), width: width(), arrow: r.chance(0.5) }
    case 'rect':
      return { ...common, kind: 'rect', x1: coord(), y1: coord(), x2: coord(), y2: coord(), color: hex(r), width: width(), fill: r.chance(0.5) ? '' : hex(r) }
    default:
      return { ...common, kind: 'ellipse', x1: coord(), y1: coord(), x2: coord(), y2: coord(), color: hex(r), width: width(), fill: r.chance(0.5) ? '' : hex(r) }
  }
}

const TITLES = ['Gate reference', 'A: "b" [c] #d', 'yes', 'null', '123', '2026-10-09', '- dash', '日本 ü 😀', "it's", 'x  y', '[[Secret]]', '#tag', '**bold**', 'Board', 'a'.repeat(60)]

/** Remarks and unknown items a hand or a newer version might leave in the section, and fenced blocks. */
const EXTRA_CHUNKS: string[][] = [
  ['a hand-written remark'],
  ['- gizmo size=9 » from a newer version'],
  ['* a bullet of another kind'],
  ['> a quote'],
  ['-no-space'],
  ['- ![[broken.png x=1'],
  ['- ![[a|b.png]] x=1'],
  ['- pic'],
  ['```js', '- gizmo x=9 » inside a fence', '', '## inner heading', '```'],
  ['~~~~', 'x', '```', '~~~~~'],
  ['<!-- a comment on one line -->'],
  ['<!--', '- gizmo x=1 » inside a comment', '', '## inner heading', '-->'],
  ['   <!-- indented, closed on the next line', 'more -->'],
]

function randDoc(r: R, maxItems = 30): BoardDoc {
  const items: BoardItem[] = []
  for (let n = r.chance(0.1) ? 0 : r.int(1, maxItems); n > 0; n--) items.push(randItem(r))
  const extra: string[] = []
  if (r.chance(0.3)) for (let n = r.int(1, 3); n > 0; n--) extra.push(...r.pick(EXTRA_CHUNKS))
  return {
    ...emptyBoard(r.pick(TITLES)),
    view: { x: num(r, -1_000_000, 1_000_000, 2), y: num(r, -1_000_000, 1_000_000, 2), zoom: num(r, 0.005, 64, 4) },
    bg: hex(r),
    gray: r.chance(0.3),
    smooth: r.chance(0.7),
    captions: r.chance(0.3),
    grid: r.chance(0.6) ? 0 : num(r, IL.grid.min, IL.grid.max, 2),
    items: items.map((it, i) => ({ ...it, id: i + 1 })),
    nextId: items.length + 1,
    extra,
    // (`smooth` is a key of the view line: a token of that name is not unknown there.)
    ...(r.chance(0.25) ? { viewUnknown: [r.pick(UNKNOWN_TOKENS.filter((t) => !t.startsWith('smooth')))] } : {}),
  }
}

/** What reading the file of `d` must give: ids from 1, groups renumbered in order of first appearance, the title on one line. */
function normalised(d: BoardDoc): BoardDoc {
  const labels = new Map<number, number>()
  const items = d.items.map((it, i) => {
    let group = 0
    if (it.group > 0) {
      group = labels.get(it.group) ?? labels.size + 1
      labels.set(it.group, group)
    }
    return { ...it, id: i + 1, group }
  })
  return { ...d, title: d.title.replace(/\s+/g, ' ').trim() || 'Board', items, nextId: items.length + 1 }
}

const bodyOf = (raw: string): string => splitFrontmatter(raw).body

/* ------------------------------------------------------------ the laws ---- */

describe('round trip: random boards', () => {
  it('parse(serialize(doc)) is the doc, with no warning, and writing it again changes nothing (400 boards, all kinds)', () => {
    const r = new R(20261009)
    const kinds = new Set<string>()
    let pics = 0
    let unsafe = 0
    for (let i = 0; i < 400; i++) {
      const d = randDoc(r)
      const text = serializeBoard(d, undefined, NOW)
      const back = parseBoard(text)
      // The only thing to say about a board it wrote is the extras it was given (unknown items are reported, remarks are not).
      expect(back.warnings.filter((w) => !/kept as written/.test(w)), `doc ${i}`).toEqual([])
      if (d.extra.length === 0 && d.viewUnknown === undefined && d.items.every((it) => it.unknown === undefined)) expect(back.warnings, `doc ${i}`).toEqual([])
      expect(back.doc, `doc ${i}`).toEqual(normalised(d))
      expect(serializeBoard(back.doc, text, LATER), `doc ${i}`).toBe(text)
      for (const it of d.items) {
        kinds.add(it.kind)
        if (it.kind === 'picture') {
          pics++
          if (!safeEmbedPath(it.path)) unsafe++
        }
      }
    }
    // The generator really covers what it claims to.
    expect([...kinds].sort()).toEqual(['ellipse', 'line', 'note', 'picture', 'rect', 'stroke'])
    expect(pics).toBeGreaterThan(300)
    expect(unsafe).toBeGreaterThan(100)
    expect(pics - unsafe).toBeGreaterThan(100)
  })

  it('serializing never changes the doc it is given (frozen docs, 100 boards), and the same doc gives the same text every time', () => {
    const freeze = <T,>(v: T): T => {
      if (v !== null && typeof v === 'object') {
        Object.values(v as Record<string, unknown>).forEach(freeze)
        Object.freeze(v)
      }
      return v
    }
    const r = new R(555)
    for (let i = 0; i < 100; i++) {
      const d = freeze(randDoc(r))
      const text = serializeBoard(d, undefined, NOW)
      expect(serializeBoard(d, undefined, NOW)).toBe(text)
      expect(serializeBoard(d, text, LATER)).toBe(text)
      expect(() => parseBoard(text)).not.toThrow()
    }
  })

  it('wild boards (out of range, not finite, off the grid, too long, odd colours) still settle: writing what was read gives the same text', () => {
    const r = new R(7)
    const wild = (n: number): number => {
      const roll = r.next()
      if (roll < 0.08) return Number.NaN
      if (roll < 0.14) return Infinity
      if (roll < 0.2) return -Infinity
      if (roll < 0.3) return n * 1e9
      if (roll < 0.4) return -n * 37.123456789
      if (roll < 0.5) return n + 0.004999
      if (roll < 0.55) return -0
      return n
    }
    for (let i = 0; i < 300; i++) {
      const d = randDoc(r, 12)
      const items = d.items.map((it): BoardItem => {
        const copy = { ...it, group: r.pick([0, 5, 5, 9, -1, 2.5, Number.NaN]) } as Record<string, unknown>
        for (const key of Object.keys(copy)) {
          const v = copy[key]
          if (typeof v === 'number' && key !== 'id' && key !== 'group') copy[key] = wild(v)
          else if (typeof v === 'string' && (key === 'color' || key === 'fill' || key === 'bg') && r.chance(0.4)) copy[key] = r.pick(['', 'red', '#ABCDEF', 'ABCDEF', '[[x]]', '12345', 'ggggggg'])
          else if (Array.isArray(v)) copy[key] = (v as number[]).map((p) => wild(p))
          else if (typeof v === 'string' && (key === 'text' || key === 'caption') && r.chance(0.2)) copy[key] = v + 'x'.repeat(4500)
          else if (key === 'crop') copy[key] = { l: wild(0.2), t: wild(0.1), r: wild(0.9), b: wild(0.8) }
        }
        return copy as unknown as BoardItem
      })
      const doc: BoardDoc = { ...d, items, view: { x: wild(d.view.x), y: wild(d.view.y), zoom: wild(d.view.zoom) }, grid: wild(d.grid), bg: r.chance(0.2) ? 'nonsense' : d.bg }
      const text = serializeBoard(doc, undefined, NOW)
      const back = parseBoard(text)
      expect(back.warnings.filter((w) => /internal error/.test(w)), `doc ${i}`).toEqual([])
      expect(serializeBoard(back.doc, text, LATER), `doc ${i}`).toBe(text)
      const third = parseBoard(serializeBoard(back.doc, text, NOW))
      expect(third.doc, `doc ${i}`).toEqual(back.doc)
      // Every value read is inside the limits, whatever was written.
      for (const it of back.doc.items) {
        for (const [key, v] of Object.entries(it)) {
          if (typeof v === 'number') expect(Number.isFinite(v) && Math.abs(v) <= 1_000_000, `${key}=${v}`).toBe(true)
        }
        if (it.kind === 'picture') {
          expect(it.opacity).toBeGreaterThanOrEqual(0.05)
          expect(it.opacity).toBeLessThanOrEqual(1)
          expect(it.crop.l < it.crop.r && it.crop.t < it.crop.b).toBe(true)
          expect(it.rotation > -180 && it.rotation <= 180).toBe(true)
          expect(it.caption.length).toBeLessThanOrEqual(BOARD_LIMITS.noteCharsFile)
        }
        if (it.kind === 'note') expect(it.text.length).toBeLessThanOrEqual(BOARD_LIMITS.noteCharsFile)
      }
    }
  })

  it('a board merged into a random note: only the section changes, byte for byte, and line endings stay (400 notes)', () => {
    const r = new R(424242)
    const fenced = (eol: string): string[] => {
      const fence = r.pick(['```', '~~~', '````'])
      const info = fence.startsWith('`') ? r.pick(['', 'js']) : r.pick(['', 'md'])
      const inner = r.pick<string[]>([['## Board', '- note x=1 » decoy'], ['# H1 in a fence'], ['code', ''], ['## Other']])
      return [fence + info, ...inner, fence].map((l) => l + eol)
    }
    let withSection = 0
    let withoutSection = 0
    for (let i = 0; i < 400; i++) {
      const eol = r.chance(0.4) ? '\r\n' : '\n'
      const hasSection = r.chance(0.7)
      const chunk = (): string[] =>
        r.pick<string[]>([
          ['Some prose with **bold**, a [[link]] and a #tag.' + eol],
          [eol],
          ['# A heading' + eol],
          ['## Other section' + eol],
          ['### Deeper' + eol],
          ['- a list' + eol, '- of things' + eol],
          ['<!-- comment -->' + eol],
          ['    indented' + eol],
          fenced(eol),
          ['trailing spaces   ' + eol],
        ])
      let above = ''
      for (let n = r.int(0, 6); n > 0; n--) above += chunk().join('')
      let below = ''
      if (r.chance(0.7)) {
        below += eol.repeat(r.int(0, 3))
        below += r.pick(hasSection ? ['## Next', '# Next top', '## Board', '## Board ##'] : ['## Next', '# Next top']) + eol
        for (let n = r.int(0, 4); n > 0; n--) below += r.pick<string[]>([['text after' + eol], [eol], ['- note x=2 » not mine' + eol], fenced(eol), ['### sub' + eol]]).join('')
      }
      const fm = ['---', 'title: Gate', 'type: board', 'tags: [ref]', '# a comment', 'updated: "2026-01-01"', '---'].map((l) => l + eol).join('')
      const d = randDoc(r, 8)
      const doc: BoardDoc = { ...d, title: 'Gate' }
      // What the section looks like in a fresh note, with this note's line breaks: "\n- view ...\n- ...\n".
      const fresh = serializeBoard(doc, undefined, NOW)
      const region = fresh.slice(fresh.indexOf('## Board\n') + '## Board\n'.length).replace(/\n/g, eol)

      let raw: string
      let expected: string
      if (hasSection) {
        withSection++
        const heading = r.pick(['## Board', '## Board', '## Board ##', '   ## Board'])
        const recognised = (l: string): boolean => l.startsWith('- note') || l.startsWith('- view')
        const old = Array.from({ length: r.int(0, 5) }, () => r.pick(['- note x=1 y=1 w=300 size=18 color=ffffff fill= r=0 » old', 'remark', '', '- gizmo x=1', '- view zoom=3']))
        while (old.length > 0 && old[old.length - 1] === '') old.pop()
        const blanks = eol.repeat(r.int(0, 3))
        // The last line of the note has a break, unless nothing follows the section and we choose to leave it out.
        const finalBreak = below !== '' || blanks !== '' || r.chance(0.8)
        // The board is the heading to the last line it understands and the lines that touch it (no blank between); a blank line and what
        // follows it is the user's, and stays exactly as it was. The lines of the span are written again from the doc.
        const last = old.reduce((at, l, k) => (recognised(l) ? k + 1 : at), 0)
        let end = last
        if (last > 0) while (end < old.length && old[end] !== '') end++
        const tail = old.slice(end)
        const lineText = (l: string, k: number, all: string[]): string => l + (k === all.length - 1 && !finalBreak ? '' : eol)
        const all = [heading, ...old]
        raw = fm + above + all.map((l, k) => lineText(l, k, all)).join('') + blanks + below
        const tailText = tail.map((l, k) => lineText(l, end + k + 1, all)).join('')
        // A bare heading with text right under it gets a blank line before it, so the new view line does not run into it.
        const apart = last === 0 && tail.length > 0 && tail[0] !== '' ? eol : ''
        const spanEndsTheNote = tailText === '' && blanks === '' && below === '' && !finalBreak
        expected = above + heading + eol + (spanEndsTheNote ? region.slice(0, -eol.length) : region) + apart + tailText + blanks + below
      } else {
        withoutSection++
        let body = above + below
        if (body !== '' && r.chance(0.2)) body = body.slice(0, body.length - eol.length)
        raw = fm + body
        const terminated = raw.endsWith('\n') ? raw : raw + eol
        const last = terminated.split(/\r?\n/).slice(-2, -1)[0] ?? ''
        expected = terminated.slice(fm.length) + (last.trim() === '' ? '' : eol) + '## Board' + eol + region
      }
      const out = serializeBoard(doc, raw, NOW)
      expect(bodyOf(out), `note ${i}\n${JSON.stringify(raw)}`).toBe(expected)
      expect(isBoardNote(out)).toBe(true)
      if (eol === '\r\n') expect(out, `note ${i}`).not.toMatch(/(^|[^\r])\n/)
      else expect(out).not.toContain('\r')
      const back = parseBoard(out)
      expect(back.doc.items, `note ${i}`).toHaveLength(doc.items.length)
      expect(back.doc.title).toBe('Gate')
      expect(serializeBoard(back.doc, out, LATER), `note ${i}`).toBe(out)
    }
    expect(withSection).toBeGreaterThan(200)
    expect(withoutSection).toBeGreaterThan(80)
  })
})

describe('corruption: nothing that was not corrupted is lost', () => {
  const garbageLine = (r: R): string => {
    const pool = ['- ', '- note x=', '- pic ', '- ![[', ']]', '```', '~~~', '## ', '# ', '---', '\u0000', 'ÿ', '�', ' » ', '=', ',', 'x=1', 'lock', 'g=', 'pts=', '1,2', '[[', '\\', '😀', '    ', '\t', '|', '>']
    let s = ''
    for (let n = r.int(0, 8); n > 0; n--) s += r.pick(pool)
    return s
  }

  it('random line and character damage to a written board never throws and keeps every line it did not touch (300 boards)', () => {
    const r = new R(99)
    let intactTotal = 0
    let damaged = 0
    for (let i = 0; i < 300; i++) {
      const d = randDoc(r, 15)
      // No groups: renumbering after a lost member would rewrite the g= of lines nobody touched.
      const doc: BoardDoc = { ...d, items: d.items.map((it) => ({ ...it, group: 0 })) }
      const text = serializeBoard(doc, undefined, NOW)
      const lines = text.split('\n')
      const start = lines.indexOf('## Board') + 1
      const kept: string[] = []
      const out: string[] = lines.slice(0, start)
      for (let k = start; k < lines.length; k++) {
        const line = lines[k]!
        if (line === '' || !r.chance(0.35)) {
          out.push(line)
          if (line !== '') kept.push(line)
          continue
        }
        damaged++
        switch (r.int(0, 5)) {
          case 0: // gone
            break
          case 1: // replaced by rubbish
            out.push(garbageLine(r))
            break
          case 2: // characters changed, never a line break
            out.push(damage(r, line))
            break
          case 3: // doubled, one copy damaged
            out.push(line, damage(r, line))
            break
          case 4: // cut short
            out.push(line.slice(0, r.int(0, line.length)))
            break
          default: // a rubbish line before it, the line itself damaged
            out.push(garbageLine(r), damage(r, line))
        }
      }
      // A line that was doubled and left whole counts once, because it was damaged: only lines nobody touched are checked.
      const corrupted = out.join('\n')
      const read = parseBoard(corrupted)
      expect(read.warnings.filter((w) => /internal error/.test(w)), `board ${i}`).toEqual([])
      const written = serializeBoard(read.doc, corrupted, NOW)
      const have = new Map<string, number>()
      for (const l of written.split('\n')) have.set(l, (have.get(l) ?? 0) + 1)
      const need = new Map<string, number>()
      for (const l of kept) need.set(l, (need.get(l) ?? 0) + 1)
      for (const [l, n] of need) {
        expect(have.get(l) ?? 0, `board ${i} lost ${JSON.stringify(l.slice(0, 80))}\n${JSON.stringify(corrupted)}`).toBeGreaterThanOrEqual(n)
      }
      intactTotal += kept.length
    }
    expect(intactTotal).toBeGreaterThan(1200)
    expect(damaged).toBeGreaterThan(500)
  })

  function damage(r: R, line: string): string {
    let s = line
    for (let n = r.int(1, 3); n > 0; n--) {
      const at = r.int(0, s.length)
      const junk = r.pick(['', 'x', '=', ' ', '\u0000', '[', ']', '\\', '`', '#', '»', ',', '-', '😀', '\r'])
      s = r.chance(0.5) ? s.slice(0, at) + junk + s.slice(at) : s.slice(0, at) + s.slice(at + 1)
    }
    return s.replace(/\n/g, ' ')
  }

  it('garbage notes never make the reader throw, and the writer settles on them too (400 strings)', () => {
    const r = new R(31337)
    const bits = ['---', '\n', '\r\n', '\r', '## Board', '## board', '# T', '- ', '- note x=1 » t', '- pic a.png', '- ![[a.png]] x=1', '- view', '```', '~~~', '\u0000', 'ÿ', '�', '\ud800', '\udc00', 'title: x', 'type: board', ': ', '{', '}', '[', ']', '*', '&a', '*a', '!!', '|', '>', '    ', '\t', 'x=', 'g=9', 'pts=', ',', '1,2', 'lock', '»', ' » ', '\\', '😀', ' ', '﻿']
    for (let i = 0; i < 400; i++) {
      let raw = ''
      if (r.chance(0.5)) raw += '---\n'
      for (let n = r.int(0, 120); n > 0; n--) raw += r.pick(bits)
      if (i % 40 === 0) raw = String.fromCharCode(...Array.from({ length: 3000 }, () => r.int(0, 255)))
      const read = parseBoard(raw)
      expect(read.warnings.filter((w) => /internal error/.test(w)), JSON.stringify(raw.slice(0, 200))).toEqual([])
      expect(read.doc.items.length).toBeLessThanOrEqual(1500)
      const out = serializeBoard(read.doc, raw, NOW)
      expect(typeof out).toBe('string')
      expect(serializeBoard(parseBoard(out).doc, out, LATER), JSON.stringify(raw.slice(0, 200))).toBe(out)
      isBoardNote(raw)
    }
  })

  it('hostile sizes finish quickly (long lines, runs of spaces, dashes, brackets, many lines)', () => {
    const head = '## Board\n'
    const cases: [string, string][] = [
      ['1 MB of one word', head + 'x'.repeat(1_000_000)],
      ['300,000 spaces then text', head + '- note ' + ' '.repeat(300_000) + 'x'],
      ['a million "- " markers', head + '- '.repeat(500_000)],
      ['200,000 empty lines', head + '\n'.repeat(200_000) + '- note x=1'],
      ['200,000 lines of items', head + '- note x=1 » t\n'.repeat(200_000)],
      ['a million stars in a caption', head + '- pic a.png x=1 » ' + '\\*'.repeat(500_000)],
      ['brackets', head + '- ![[' + '['.repeat(300_000)],
      ['points', head + '- stroke color=ffffff width=2 pts=' + '1,2 '.repeat(300_000)],
      ['number tokens', head + '- note x=' + '1'.repeat(300_000) + ' y=' + '-'.repeat(300_000)],
      ['tokens without values', head + '- note ' + 'a '.repeat(300_000)],
      ['equals signs', head + '- note ' + '='.repeat(300_000)],
      ['a title with a long run of dots', '---\ntitle: ' + '. '.repeat(100_000) + '\n---\n' + head],
      ['frontmatter lines of spaces', '---\n' + ' '.repeat(300_000) + 'x\n---\n' + head],
      ['crlf everywhere', (head + '- note x=1 » t\n').replace(/\n/g, '\r\n').repeat(50_000)],
      ['fences', '```\n'.repeat(100_000) + head],
      ['headings', '# a\n'.repeat(100_000) + head],
    ]
    for (const [name, raw] of cases) {
      const t0 = Date.now()
      const read = parseBoard(raw)
      const out = serializeBoard(read.doc, raw, NOW)
      expect(out.length).toBeGreaterThan(0)
      expect(Date.now() - t0, name).toBeLessThan(4000)
    }
  }, 30_000)
})

describe('text and paths against the real markdown parser', () => {
  it('escape then unescape is the identity for 6,000 random strings, and the escaped form is one line', () => {
    const r = new R(5)
    for (let i = 0; i < 6000; i++) {
      const s = randText(r, 30)
      const e = escapeBoardText(s)
      expect(e).not.toMatch(/[\r\n]/)
      expect(unescapeBoardText(e)).toBe(s)
    }
  })

  it('random note texts and captions never make a link, tag, task, html or block (300 boards of 4 items)', () => {
    const r = new R(77)
    for (let i = 0; i < 300; i++) {
      const items: BoardItem[] = []
      for (let k = 0; k < 4; k++) {
        const text = randText(r, 25)
        items.push(
          r.chance(0.5)
            ? { id: k + 1, group: 0, locked: false, kind: 'note', text, x: 0, y: 0, w: 100, size: 18, rotation: 0, color: 'ffffff', fill: '' }
            : { id: k + 1, group: 0, locked: false, kind: 'picture', path: `Boards/p ${k}.png`, x: 0, y: 0, w: 10, h: 10, rotation: 0, crop: { l: 0, t: 0, r: 1, b: 1 }, flipH: false, flipV: false, gray: false, opacity: 1, caption: text },
        )
      }
      const doc: BoardDoc = { ...emptyBoard('Fuzz'), items, nextId: 5 }
      const raw = serializeBoard(doc, undefined, NOW)
      const embeds = items.filter((it) => it.kind === 'picture').map((it) => (it.kind === 'picture' ? it.path : ''))
      // Read as a board (its item lines never reach the markdown parser) and as a plain note (they all do): no link but the embeds, no tag, no task.
      for (const content of [raw, plain(raw)]) {
        const n = parseNote({ path: 'Boards/Fuzz.md', content })
        expect(n.links.map((l) => l.to), JSON.stringify(items)).toEqual(embeds)
        expect(n.inlineTags).toEqual([])
        expect(extractTasks(content)).toEqual([])
      }
      const tree = parseMarkdown(bodyOf(raw))
      expect(tree.children.map((c) => c.type), JSON.stringify(items)).toEqual(['heading', 'paragraph', 'heading', 'list'])
      const list = tree.children[3]
      if (list?.type !== 'list') throw new Error('no list')
      expect(list.children).toHaveLength(5)
      for (const li of list.children) expect(li.children.map((c) => c.type)).toEqual(['paragraph'])
    }
  }, 30_000)

  it('a path safeEmbedPath accepts comes back from the real parser as exactly that one embed (4,000 random paths)', () => {
    const r = new R(2026)
    let safe = 0
    let unsafe = 0
    for (let i = 0; i < 4000; i++) {
      const path = r.chance(0.5) ? randPath(r) : plainPath(r) + r.pick(['', '_', '*', '~', ' x', '_x_', '__', '&amp;', '@y.z'])
      if (!safeEmbedPath(path)) {
        unsafe++
        continue
      }
      safe++
      const n = parseNote({ path: 'Boards/b.md', content: `- ![[${path}]] x=0 y=0 w=10 h=10 » \\*caption\\*\n` })
      expect(
        n.links.map((l) => [l.kind, l.to]),
        JSON.stringify(path),
      ).toEqual([['embed', path]])
    }
    expect(safe).toBeGreaterThan(300)
    expect(unsafe).toBeGreaterThan(800)
  })

  it('in a whole board, every picture with a picture path is a link in order (the others none), the safe ones as the real parser reads them, and all of them read back (200 boards of 20 pictures)', () => {
    const r = new R(1)
    for (let i = 0; i < 200; i++) {
      const paths = Array.from({ length: 20 }, () => (r.chance(0.5) ? randPath(r) : plainPath(r)))
      const items: BoardItem[] = paths.map((path, k) => ({ id: k + 1, group: 0, locked: false, kind: 'picture', path, x: k, y: 0, w: 10, h: 10, rotation: 0, crop: { l: 0, t: 0, r: 1, b: 1 }, flipH: false, flipV: false, gray: false, opacity: 1, caption: '' }))
      const doc: BoardDoc = { ...emptyBoard('Paths'), items, nextId: 21 }
      const raw = serializeBoard(doc, undefined, NOW)
      // The board's own reader: the `pic` lines give links too (their paths hold what a wikilink cannot).
      const n = parseNote({ path: 'Boards/Paths.md', content: raw })
      expect(n.links.map((l) => l.to)).toEqual(paths.filter((p) => isMediaPath(p)))
      expect(n.links.every((l) => l.kind === 'embed' && (l.literal === true) === !safeEmbedPath(l.to))).toBe(true)
      expect(n.inlineTags).toEqual([])
      // The real markdown parser reads exactly the safe paths, as embeds.
      const generic = parseNote({ path: 'Boards/Paths.md', content: plain(raw) })
      expect(generic.links.map((l) => l.to)).toEqual(paths.filter((p) => safeEmbedPath(p)))
      expect(generic.inlineTags).toEqual([])
      expect(parseBoard(raw).doc.items.map((it) => (it.kind === 'picture' ? it.path : null))).toEqual(paths)
    }
  }, 30_000)
})

describe('a hole in parseNote that used to be open: GFM\'s late autolinks cut a text node into pieces with no position', () => {
  /**
   * parseNote reads a bracket or a hash as escaped by looking at the source of its text node. GFM's autolink transform (mdast-util-
   * gfm-autolink-literal) cut a text node into new nodes that have no position when it linked a web or e-mail address that the
   * tokenizer did not (one that follows punctuation: `),www.a.b`), and from then on `[[x]]` and `#tag` in those pieces counted as live
   * although the source escapes them. `remarkNoLateAutolinks` (markdown/wikilink.ts, used by parseMarkdown and the preview) closes it.
   */
  it('escaped [[x]] and #tag next to an address linked late stay inert', () => {
    const doc: BoardDoc = {
      ...emptyBoard('Hole'),
      items: [{ id: 1, group: 0, locked: false, kind: 'note', text: '[[Secret]] #tag ),www.a.example', x: 0, y: 0, w: 100, size: 18, rotation: 0, color: 'ffffff', fill: '' }],
      nextId: 2,
    }
    // As a board (the item lines are never given to the markdown parser) and as a plain note (they are).
    for (const content of [serializeBoard(doc, undefined, NOW), plain(serializeBoard(doc, undefined, NOW))]) {
      const n = parseNote({ path: 'Boards/Hole.md', content })
      expect(n.links).toEqual([])
      expect(n.inlineTags).toEqual([])
    }
  })
})
