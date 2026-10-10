/**
 * The board as a markdown note: read it (`parseBoard`, never fails), write it back (`serializeBoard`, which replaces exactly the
 * `## Board` section of the note and nothing else), and the small rules around it (which picture paths can be embedded, what a board's
 * folder and its pictures are called). Design and the file format: docs/design/reference-board.md ("The board file").
 *
 * One list line per item, back to front, `key=value` pairs and bare flags, text after the first ` » ` escaped so a line stays inert
 * (text.ts). Numbers are cut to at most two decimals (three for a crop, four for the zoom) and every value is clamped to BOARD_LIMITS
 * by the same functions on the way in and on the way out, so that reading what was written and writing it again gives the same text.
 */
import { asString, rewriteFrontmatter, splitFrontmatter } from '../markdown/frontmatter'
import { IMAGE_EXTENSIONS, isImagePath } from '../vault/assets'
import { todayIso } from '../vault/paths'
import { escapeBoardText, unescapeBoardText } from './text'
import { BOARD_LIMITS, FULL_CROP, emptyBoard } from './types'
import type {
  BoardDoc,
  BoardItem,
  Crop,
  EllipseItem,
  ItemCommon,
  LineItem,
  NoteItem,
  PictureItem,
  RectItem,
  StrokeItem,
} from './types'

const L = BOARD_LIMITS

/* -------------------------------------------------------------- numbers --- */

/** A field's allowed range and how many decimals the file keeps. */
interface Spec {
  lo: number
  hi: number
  dec: number
}

const COORD: Spec = { lo: -L.coordinate, hi: L.coordinate, dec: 2 }
const PICTURE_SIDE: Spec = { lo: L.pictureMin, hi: L.pictureMax, dec: 2 }
const NOTE_SIZE: Spec = { lo: 1, hi: 1000, dec: 2 }
const MARK_WIDTH: Spec = { lo: 0.1, hi: 1000, dec: 2 }
const OPACITY: Spec = { lo: 0.05, hi: 1, dec: 2 }
/** The zoom floor (0.005) has three decimals, so the zoom keeps four. */
const ZOOM: Spec = { lo: L.zoomMin, hi: L.zoomMax, dec: 4 }
const GRID: Spec = { lo: 0, hi: 10000, dec: 2 }
const CROP_EDGE: Spec = { lo: 0, hi: 1, dec: 3 }
const ANGLE_DEC = 2

const DEFAULT_PICTURE_SIDE = 200
const DEFAULT_NOTE_WIDTH = 300
const DEFAULT_NOTE_SIZE = 18
const DEFAULT_MARK_WIDTH = 2
const DEFAULT_INK = 'ffffff'
const DEFAULT_BG = '14161d'

function finite(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

/** `n` rounded to `dec` decimals as a number (no negative zero). */
function round(n: number, dec: number): number {
  return Number(n.toFixed(dec)) + 0
}

/** The value the file holds for `n`: finite, inside the range, rounded. */
function norm(spec: Spec, n: number, fallback: number): number {
  return round(clamp(finite(n, fallback), spec.lo, spec.hi), spec.dec)
}

/** An angle in degrees as (-180, 180]. Rounded first: -179.996 is written -180, which reads back as 180. */
function normAngle(n: number): number {
  let r = round(finite(n, 0) % 360, ANGLE_DEC)
  if (r > 180) r -= 360
  else if (r <= -180) r += 360
  return r + 0
}

/**
 * A number as the file writes it: `dec` decimals at most, trailing zeros and a leading `0` before the point dropped (`0.8` is `.8`,
 * `-0.5` is `-.5`), never an exponent, never `-0`. Not finite is `0`.
 */
export function formatNumber(n: number, dec = 2): string {
  if (!Number.isFinite(n)) return '0'
  // toFixed switches to exponent notation at 1e21.
  let s = clamp(n, -1e15, 1e15).toFixed(dec)
  if (s.includes('.')) {
    let end = s.length
    while (s.charCodeAt(end - 1) === 48) end--
    if (s.charCodeAt(end - 1) === 46) end--
    s = s.slice(0, end)
  }
  if (s === '-0' || s === '') return '0'
  if (s.startsWith('0.')) return s.slice(1)
  if (s.startsWith('-0.')) return '-' + s.slice(2)
  return s
}

const fmt = (n: number, spec: Spec): string => formatNumber(n, spec.dec)

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

/**
 * A number as written in a file: an optional sign, digits with an optional point (`.5` and `5.` too), an optional exponent. Null
 * when it is anything else or not finite. Scanned by hand: a long token must not make a regex backtrack.
 */
function parseNumber(s: string): number | null {
  if (s.length === 0 || s.length > 40) return null
  let i = 0
  if (s[0] === '-' || s[0] === '+') i++
  let digits = 0
  while (isDigit(s.charCodeAt(i))) {
    i++
    digits++
  }
  if (s[i] === '.') {
    i++
    while (isDigit(s.charCodeAt(i))) {
      i++
      digits++
    }
  }
  if (digits === 0) return null
  if (s[i] === 'e' || s[i] === 'E') {
    i++
    if (s[i] === '-' || s[i] === '+') i++
    let exp = 0
    while (isDigit(s.charCodeAt(i))) {
      i++
      exp++
    }
    if (exp === 0) return null
  }
  if (i !== s.length) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

const HEX6 = /^#?[0-9a-fA-F]{6}$/

/** A colour as the file holds it (6 lower-case hex digits, no `#`), or `fallback` when `c` is none. */
function normColor(c: unknown, fallback: string): string {
  return typeof c === 'string' && HEX6.test(c) ? c.replace('#', '').toLowerCase() : fallback
}

/** `s` cut to the note text limit, never between the halves of a surrogate pair. */
function capText(s: string): string {
  if (s.length <= L.noteChars) return s
  const high = s.charCodeAt(L.noteChars - 1)
  return s.slice(0, high >= 0xd800 && high <= 0xdbff ? L.noteChars - 1 : L.noteChars)
}

/* ---------------------------------------------------------- the section --- */

interface Line {
  /** Without its line break. */
  text: string
  start: number
  /** Where the next line starts. */
  next: number
  /** `\n`, `\r\n`, or '' for a last line with no break. */
  eol: string
}

function lineAt(raw: string, start: number): Line {
  const nl = raw.indexOf('\n', start)
  if (nl < 0) return { text: raw.slice(start), start, next: raw.length, eol: '' }
  const cr = nl > start && raw.charCodeAt(nl - 1) === 13
  return { text: raw.slice(start, cr ? nl - 1 : nl), start, next: nl + 1, eol: cr ? '\r\n' : '\n' }
}

/** No visible character (blank, or spaces and tabs only). */
function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c !== 32 && c !== 9) return false
  }
  return true
}

interface Fence {
  /** Character code of the fence: backtick or tilde. */
  ch: number
  len: number
}

function fenceRun(text: string): { ch: number; len: number; rest: number } | null {
  let i = 0
  while (i < 3 && text.charCodeAt(i) === 32) i++
  const ch = text.charCodeAt(i)
  if (ch !== 96 && ch !== 126) return null
  let j = i
  while (text.charCodeAt(j) === ch) j++
  return j - i >= 3 ? { ch, len: j - i, rest: j } : null
}

/** The fence a line opens (``` or ~~~, up to three spaces in; a backtick fence's info text holds no backtick), or null. */
function opensFence(text: string): Fence | null {
  const run = fenceRun(text)
  if (!run || (run.ch === 96 && text.indexOf('`', run.rest) >= 0)) return null
  return { ch: run.ch, len: run.len }
}

function closesFence(text: string, fence: Fence): boolean {
  const run = fenceRun(text)
  return run !== null && run.ch === fence.ch && run.len >= fence.len && isBlank(text.slice(run.rest))
}

/** An ATX heading's level (1 to 6) and text (closing hashes dropped), or null. `#tag` is no heading. */
function headingOf(text: string): { level: number; text: string } | null {
  let i = 0
  while (i < 3 && text.charCodeAt(i) === 32) i++
  let level = 0
  while (text.charCodeAt(i + level) === 35) level++
  if (level === 0 || level > 6) return null
  const after = i + level
  if (after < text.length) {
    const c = text.charCodeAt(after)
    if (c !== 32 && c !== 9) return null
  }
  let t = text.slice(after).trim()
  let end = t.length
  while (end > 0 && t.charCodeAt(end - 1) === 35) end--
  if (end < t.length && (end === 0 || t.charCodeAt(end - 1) === 32 || t.charCodeAt(end - 1) === 9)) t = t.slice(0, end).trimEnd()
  return { level, text: t }
}

interface Section {
  /** The `## Board` heading line. */
  heading: Line
  /** The end of the section's last line that is not blank (its break included); the heading's end when it holds nothing. */
  end: number
  /** The line break of that last line ('' at the end of a file with no final break). */
  endEol: string
}

interface Scan {
  section: Section | null
  /** The text of the note's first level-1 heading outside a code fence. */
  h1: string | null
  /** A code fence still open at the end of the note. */
  openFence: Fence | null
}

/**
 * Finds the board section in the part of the note from `from`: from the first `## Board` heading (case-sensitive) outside code fences
 * to the line before the next heading of level 1 or 2 outside code fences, or the end of the note. Blank lines at the end of the
 * section do not belong to it.
 */
function scan(raw: string, from: number): Scan {
  let fence: Fence | null = null
  let h1: string | null = null
  let section: Section | null = null
  let ended = false
  for (let pos = from; pos < raw.length; ) {
    const line = lineAt(raw, pos)
    pos = line.next
    let heading: { level: number; text: string } | null = null
    if (fence) {
      if (closesFence(line.text, fence)) fence = null
    } else {
      fence = opensFence(line.text)
      if (!fence) heading = headingOf(line.text)
    }
    if (heading && heading.level === 1 && h1 === null) h1 = heading.text
    if (ended) continue
    if (!section) {
      if (heading && heading.level === 2 && heading.text === 'Board') section = { heading: line, end: line.next, endEol: line.eol }
      continue
    }
    if (heading && heading.level <= 2) ended = true
    else if (!isBlank(line.text)) {
      section.end = line.next
      section.endEol = line.eol
    }
  }
  return { section, h1, openFence: fence }
}

/** The line break the note uses: the first one it has (CRLF or LF), LF when it has none. */
function detectEol(raw: string): string {
  const nl = raw.indexOf('\n')
  return nl > 0 && raw.charCodeAt(nl - 1) === 13 ? '\r\n' : '\n'
}

function lineNumberAt(raw: string, offset: number): number {
  let n = 1
  for (let at = raw.indexOf('\n'); at >= 0 && at < offset; at = raw.indexOf('\n', at + 1)) n++
  return n
}

/**
 * True when the note has a frontmatter block whose YAML does not parse (as the store's `hasBrokenFrontmatter` tells it: the parser
 * gives nothing, yet the block holds lines that are not comments). Such a note is not touched.
 */
function hasBrokenFrontmatter(raw: string): boolean {
  const split = splitFrontmatter(raw)
  if (!split.hasFrontmatter || Object.keys(split.frontmatter).length > 0) return false
  return raw
    .slice(0, split.bodyOffset)
    .split(/\r?\n/)
    .slice(1)
    .some((l) => {
      const t = l.trim()
      return !(t === '' || t[0] === '#' || t === '---' || t === '...')
    })
}

/* ----------------------------------------------------------- warnings ---- */

const MAX_WARNINGS = 50

class Warnings {
  readonly list: string[] = []
  private dropped = 0
  add(text: string): void {
    if (this.list.length < MAX_WARNINGS) this.list.push(text)
    else this.dropped++
  }
  done(): string[] {
    return this.dropped > 0 ? [...this.list, `and ${this.dropped} more`] : this.list
  }
}

/* ------------------------------------------------------------ attributes -- */

/** The `key=value` pairs and bare flags of one item line, each read once; what is left over is reported. */
class Attrs {
  private readonly kv = new Map<string, string>()
  private readonly flags = new Set<string>()
  private readonly used = new Set<string>()
  /** The tokens after `pts=` (the first one included), or null without `pts`. */
  points: string[] | null = null

  constructor(
    tokens: string[],
    private readonly say: (text: string) => void,
  ) {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!
      const eq = t.indexOf('=')
      if (eq > 0) {
        const key = t.slice(0, eq)
        const value = t.slice(eq + 1)
        if (key === 'pts') {
          const pts = [value]
          // The points are separated by spaces too: take the tokens that look like one.
          while (i + 1 < tokens.length && tokens[i + 1]!.indexOf('=') < 0 && tokens[i + 1]!.indexOf(',') > 0) pts.push(tokens[++i]!)
          this.points = pts
        } else this.kv.set(key, value)
      } else if (eq === 0) this.say(`"${shorten(t)}" is not an attribute and was ignored`)
      else this.flags.add(t)
    }
  }

  number(key: string, spec: Spec, fallback: number): number {
    this.used.add(key)
    const v = this.kv.get(key)
    if (v === undefined) return norm(spec, fallback, fallback)
    const n = parseNumber(v)
    if (n === null) {
      this.say(`${key}="${shorten(v)}" is not a number, ${formatNumber(fallback, spec.dec)} used`)
      return norm(spec, fallback, fallback)
    }
    const c = clamp(n, spec.lo, spec.hi)
    if (c !== n) this.say(`${key}=${shorten(v)} is outside ${formatNumber(spec.lo, spec.dec)} to ${formatNumber(spec.hi, spec.dec)}, ${formatNumber(c, spec.dec)} used`)
    return round(c, spec.dec)
  }

  angle(key: string): number {
    this.used.add(key)
    const v = this.kv.get(key)
    if (v === undefined) return 0
    const n = parseNumber(v)
    if (n === null) {
      this.say(`${key}="${shorten(v)}" is not a number, 0 used`)
      return 0
    }
    return normAngle(n)
  }

  bool(key: string, fallback: boolean): boolean {
    this.used.add(key)
    const v = this.kv.get(key)
    if (v === undefined) return this.flags.has(key) ? true : fallback
    if (v === '1' || v === 'true') return true
    if (v === '0' || v === 'false') return false
    this.say(`${key}="${shorten(v)}" is not 0 or 1, ${fallback ? 1 : 0} used`)
    return fallback
  }

  /** A group label: a whole number, 0 for none. */
  group(): number {
    this.used.add('g')
    const v = this.kv.get('g')
    if (v === undefined) return 0
    const n = parseNumber(v)
    if (n === null || !Number.isInteger(n) || n < 0) {
      this.say(`g="${shorten(v)}" is not a group number and was ignored`)
      return 0
    }
    return n
  }

  color(key: string, fallback: string, allowNone = false): string {
    this.used.add(key)
    const v = this.kv.get(key)
    if (v === undefined) return fallback
    if (allowNone && v === '') return ''
    if (!HEX6.test(v)) {
      this.say(`${key}="${shorten(v)}" is not a colour (6 hex digits), ${fallback || 'none'} used`)
      return fallback
    }
    return normColor(v, fallback)
  }

  text(key: string): string | undefined {
    this.used.add(key)
    return this.kv.get(key)
  }

  /** Reports every pair and flag nobody read. */
  rest(): void {
    for (const key of this.kv.keys()) if (!this.used.has(key)) this.say(`unknown attribute ${key} ignored`)
    for (const flag of this.flags) if (!this.used.has(flag)) this.say(`unknown flag ${flag} ignored`)
  }
}

function shorten(s: string): string {
  return s.length > 24 ? s.slice(0, 24) + '...' : s
}

/** Splits at single spaces, dropping the empty pieces. */
function tokens(s: string): string[] {
  const out: string[] = []
  let from = 0
  for (let i = 0; i <= s.length; i++) {
    if (i === s.length || s.charCodeAt(i) === 32) {
      if (i > from) out.push(s.slice(from, i))
      from = i + 1
    }
  }
  return out
}

/** The path of a `pic` line: up to the first space that is not escaped. Returns the end of the path too. */
function picPath(s: string, from: number): { path: string; end: number } {
  let i = from
  while (i < s.length && s.charCodeAt(i) !== 32) i += s.charCodeAt(i) === 92 ? 2 : 1
  const end = Math.min(i, s.length)
  return { path: unescapeBoardText(s.slice(from, end)), end }
}

/* --------------------------------------------------------- item reading --- */

type Parsed =
  | { type: 'view'; apply: (doc: BoardDoc) => void }
  | { type: 'item'; item: BoardItem }
  | { type: 'extra'; why: string | null }

const KINDS = new Set(['view', 'pic', 'note', 'stroke', 'line', 'rect', 'ellipse'])

/** Whether a hand-written embed's path can be a picture's: non-empty, none of `[ ] | #`, no space at either end. */
function readableEmbedPath(path: string): boolean {
  if (path.length === 0 || path !== path.trim()) return false
  for (let i = 0; i < path.length; i++) {
    const c = path[i]
    if (c === '[' || c === ']' || c === '|' || c === '#') return false
  }
  return true
}

function common(a: Attrs): ItemCommon {
  return { id: 0, group: a.group(), locked: a.bool('lock', false) }
}

function readCrop(a: Attrs, say: (text: string) => void): Crop {
  const v = a.text('crop')
  if (v === undefined) return { ...FULL_CROP }
  const parts = v.split(',')
  const nums = parts.length === 4 ? parts.map(parseNumber) : null
  if (!nums || nums.some((n) => n === null)) {
    say(`crop="${shorten(v)}" is not four numbers, no crop used`)
    return { ...FULL_CROP }
  }
  return validCrop({ l: nums[0]!, t: nums[1]!, r: nums[2]!, b: nums[3]! }) ?? (say(`crop="${shorten(v)}" leaves nothing to show, no crop used`), { ...FULL_CROP })
}

/** The crop clamped and rounded as the file keeps it, or null when no area is left (l < r and t < b must hold). */
function validCrop(c: Crop): Crop | null {
  const crop = { l: norm(CROP_EDGE, c.l, 0), t: norm(CROP_EDGE, c.t, 0), r: norm(CROP_EDGE, c.r, 1), b: norm(CROP_EDGE, c.b, 1) }
  return crop.l < crop.r && crop.t < crop.b ? crop : null
}

function readPoints(raw: string[], say: (text: string) => void): number[] {
  const out: number[] = []
  let left = 0
  for (const token of raw) {
    if (token === '') continue
    const comma = token.indexOf(',')
    const x = comma > 0 ? parseNumber(token.slice(0, comma)) : null
    const y = comma > 0 ? parseNumber(token.slice(comma + 1)) : null
    if (x === null || y === null || out.length >= L.strokePoints * 2) left++
    else out.push(norm(COORD, x, 0), norm(COORD, y, 0))
  }
  if (left > 0) say(`${left} point${left === 1 ? '' : 's'} of the stroke could not be read or were past the limit of ${L.strokePoints}, and were left out`)
  return out
}

/**
 * Reads the part of an item line after the `- `. `at` is the line number for warnings. A line it cannot understand comes back as
 * 'extra'; one it understands never fails (a bad value is replaced by its default, with a warning).
 */
function parseItemLine(rest: string, at: number, say: (text: string) => void): Parsed {
  const warn = (text: string): void => say(`line ${at}: ${text}`)
  let kind: string
  let after: string
  let path = ''
  if (rest.startsWith('![[')) {
    const close = rest.indexOf(']]', 3)
    if (close < 0) return { type: 'extra', why: 'an embed that is never closed' }
    path = rest.slice(3, close)
    if (!readableEmbedPath(path)) return { type: 'extra', why: 'an embed whose picture path cannot be read' }
    after = rest.slice(close + 2)
    if (after !== '' && after.charCodeAt(0) !== 32) return { type: 'extra', why: 'an embed followed by text' }
    kind = 'pic'
  } else {
    const sp = rest.indexOf(' ')
    kind = sp < 0 ? rest : rest.slice(0, sp)
    if (!KINDS.has(kind)) return { type: 'extra', why: `an item kind this version does not know (${shorten(kind)})` }
    after = sp < 0 ? '' : rest.slice(sp)
    if (kind === 'pic') {
      if (after === '') return { type: 'extra', why: 'a picture without a path' }
      const p = picPath(after, 1)
      path = p.path
      after = after.slice(p.end)
    }
  }
  // Text follows the first " » " after the path (an escaped path holds no raw space, so none can be inside it).
  let attrText = after
  let text: string | null = null
  const sep = after.indexOf(' » ')
  if (sep >= 0) {
    attrText = after.slice(0, sep)
    text = after.slice(sep + 3)
  } else if (after.endsWith(' »')) {
    attrText = after.slice(0, -2)
    text = ''
  }
  const a = new Attrs(tokens(attrText), warn)
  const readText = (): string => {
    const t = unescapeBoardText(text ?? '')
    if (t.length > L.noteChars) warn(`text of ${t.length} characters cut to ${L.noteChars}`)
    return capText(t)
  }

  let result: Parsed
  switch (kind) {
    case 'view':
      result = readView(a)
      break
    case 'pic': {
      const item: PictureItem = {
        ...common(a),
        kind: 'picture',
        path,
        x: a.number('x', COORD, 0),
        y: a.number('y', COORD, 0),
        w: a.number('w', PICTURE_SIDE, DEFAULT_PICTURE_SIDE),
        h: a.number('h', PICTURE_SIDE, DEFAULT_PICTURE_SIDE),
        rotation: a.angle('r'),
        crop: readCrop(a, warn),
        flipH: false,
        flipV: false,
        gray: a.bool('gray', false),
        opacity: a.number('op', OPACITY, 1),
        caption: readText(),
      }
      const flip = a.text('flip')
      if (flip !== undefined) {
        if (flip === 'h' || flip === 'v' || flip === 'hv' || flip === 'vh') {
          item.flipH = flip.includes('h')
          item.flipV = flip.includes('v')
        } else warn(`flip="${shorten(flip)}" is not h, v or hv and was ignored`)
      }
      result = { type: 'item', item }
      break
    }
    case 'note': {
      const item: NoteItem = {
        ...common(a),
        kind: 'note',
        x: a.number('x', COORD, 0),
        y: a.number('y', COORD, 0),
        w: a.number('w', PICTURE_SIDE, DEFAULT_NOTE_WIDTH),
        size: a.number('size', NOTE_SIZE, DEFAULT_NOTE_SIZE),
        rotation: a.angle('r'),
        color: a.color('color', DEFAULT_INK),
        fill: a.color('fill', '', true),
        text: readText(),
      }
      result = { type: 'item', item }
      break
    }
    case 'stroke': {
      const pts = a.points
      const item: StrokeItem = {
        ...common(a),
        kind: 'stroke',
        color: a.color('color', DEFAULT_INK),
        width: a.number('width', MARK_WIDTH, DEFAULT_MARK_WIDTH),
        points: pts ? readPoints(pts, warn) : [],
      }
      result = { type: 'item', item }
      break
    }
    case 'line': {
      const item: LineItem = {
        ...common(a),
        kind: 'line',
        x1: a.number('x1', COORD, 0),
        y1: a.number('y1', COORD, 0),
        x2: a.number('x2', COORD, 0),
        y2: a.number('y2', COORD, 0),
        color: a.color('color', DEFAULT_INK),
        width: a.number('width', MARK_WIDTH, DEFAULT_MARK_WIDTH),
        arrow: a.bool('arrow', false),
      }
      result = { type: 'item', item }
      break
    }
    default: {
      const item: RectItem | EllipseItem = {
        ...common(a),
        kind: kind === 'rect' ? 'rect' : 'ellipse',
        x1: a.number('x1', COORD, 0),
        y1: a.number('y1', COORD, 0),
        x2: a.number('x2', COORD, 0),
        y2: a.number('y2', COORD, 0),
        color: a.color('color', DEFAULT_INK),
        width: a.number('width', MARK_WIDTH, DEFAULT_MARK_WIDTH),
        fill: a.color('fill', '', true),
      }
      result = { type: 'item', item }
    }
  }
  // Text on a kind that has none (or a stroke's point list on a note) is not an error of the line, but it is not kept either.
  if (text !== null && kind !== 'pic' && kind !== 'note') warn(`${kind} has no text; the text after » was ignored`)
  if (a.points !== null && kind !== 'stroke') warn('pts belongs to a stroke and was ignored')
  a.rest()
  return result
}

function readView(a: Attrs): Parsed {
  const x = a.number('x', COORD, 0)
  const y = a.number('y', COORD, 0)
  const zoom = a.number('zoom', ZOOM, 1)
  const bg = a.color('bg', DEFAULT_BG)
  const gray = a.bool('gray', false)
  const smooth = a.bool('smooth', true)
  const captions = a.bool('captions', false)
  const grid = a.number('grid', GRID, 0)
  return {
    type: 'view',
    apply(doc) {
      doc.view = { x, y, zoom }
      doc.bg = bg
      doc.gray = gray
      doc.smooth = smooth
      doc.captions = captions
      doc.grid = grid
    },
  }
}

/* ----------------------------------------------------------------- parse -- */

/**
 * Reads a board note. Never throws, whatever `raw` is (a binary file, CRLF, a byte-order mark, no board section at all, a section
 * of garbage): a note without a board section is an empty board. Everything that is wrong is repaired and reported in `warnings`.
 */
export function parseBoard(raw: string): { doc: BoardDoc; warnings: string[] } {
  const warn = new Warnings()
  try {
    return { doc: readBoard(String(raw), warn), warnings: warn.done() }
  } catch (e) {
    // A bug in the reader must not take the app down; the board opens empty and the note is not rewritten by this version.
    return { doc: emptyBoard('Board'), warnings: [`internal error while reading the board: ${e instanceof Error ? e.message : String(e)}`] }
  }
}

function readBoard(raw: string, warn: Warnings): BoardDoc {
  const split = splitFrontmatter(raw)
  if (hasBrokenFrontmatter(raw)) warn.add('The frontmatter could not be read; the note is left alone.')
  const found = scan(raw, split.bodyOffset)
  const doc = emptyBoard(asString(split.frontmatter['title']) ?? found.h1 ?? 'Board')
  if (raw.length > L.noteTotal) warn.add(`The note is ${raw.length} characters long, past the ${L.noteTotal} a board should stay under.`)
  const section = found.section
  if (!section) return doc

  const items: BoardItem[] = []
  const extra: string[] = []
  const labels = new Map<number, number>()
  let viewSeen = false
  let overflow = 0
  let fence: Fence | null = null
  let no = lineNumberAt(raw, section.heading.start)
  for (let pos = section.heading.next; pos < section.end; ) {
    const line = lineAt(raw, pos)
    pos = line.next
    no++
    const t = line.text
    if (fence) {
      extra.push(t)
      if (closesFence(t, fence)) fence = null
      continue
    }
    if (isBlank(t)) continue
    fence = opensFence(t)
    if (fence || !t.startsWith('- ')) {
      extra.push(t)
      continue
    }
    const parsed = parseItemLine(t.slice(2), no, (text) => warn.add(text))
    if (parsed.type === 'view') {
      if (viewSeen) {
        extra.push(t)
        warn.add(`line ${no}: a second view line, kept as written`)
      } else {
        viewSeen = true
        parsed.apply(doc)
      }
    } else if (parsed.type === 'extra') {
      extra.push(t)
      warn.add(`line ${no}: ${parsed.why ?? 'not understood'}, kept as written`)
    } else if (items.length >= L.items) {
      overflow++
      extra.push(t)
    } else {
      const item = parsed.item
      let group = 0
      if (item.group > 0) {
        group = labels.get(item.group) ?? labels.size + 1
        labels.set(item.group, group)
      }
      items.push({ ...item, id: items.length + 1, group })
    }
  }
  if (overflow > 0) warn.add(`The board holds ${items.length + overflow} items; the first ${L.items} are shown and the rest are kept in the file.`)
  doc.items = items
  doc.nextId = items.length + 1
  doc.extra = extra
  return doc
}

/* ------------------------------------------------------------- serialise -- */

/** Whether a picture path can be written as an embed `![[path]]` that a markdown parser reads back as exactly that link. */
export function safeEmbedPath(path: string): boolean {
  if (path.length === 0 || path !== path.trim()) return false
  // Control characters, the line breaks, and what ends or splits a link or opens something else: # | [ ] < > \ `
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029#|[\]<>\\`]/.test(path)) return false
  // Only a picture is embedded: any other target would become a link to a note, or a ghost.
  if (!isImagePath(path)) return false
  // A character reference (&amp; &#91;) would be read as the character it names.
  if (/&#?[A-Za-z0-9]+;/.test(path)) return false
  // GFM autolinks cut the text node in two: a web address or www. after anything but a letter or digit, an email address.
  if (/(?:^|[^\p{L}\p{N}])(?:(?:https?|ftp):\/\/|www\.)/iu.test(path) || /[A-Za-z0-9._+-]@[A-Za-z0-9_-]+\./.test(path)) return false
  return delimitersSafe(path)
}

/** Whether `*`, `~` and `_` in a path can never pair into emphasis or strikethrough (one of each alone cannot). */
function delimitersSafe(path: string): boolean {
  let stars = 0
  let tildes = 0
  let unders = 0
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i)
    if (c === 42) stars++
    else if (c === 126) tildes++
    else if (c === 95) unders++
  }
  if (stars > 1 || tildes > 1) return false
  if (unders <= 1) return true
  // Several underscores: each run must sit between letters or digits, where `_` opens and closes nothing.
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) !== 95) continue
    let j = i
    while (path.charCodeAt(j) === 95) j++
    if (i === 0 || j >= path.length) return false
    if (!/[\p{L}\p{N}]$/u.test(path.slice(Math.max(0, i - 2), i)) || !/^[\p{L}\p{N}]/u.test(path.slice(j, j + 2))) return false
    i = j - 1
  }
  return true
}

/** A picture path written for a `pic` line: escaped like text, and every space escaped too so the path ends at the first bare space. */
function escapePicPath(path: string): string {
  return escapeBoardText(path).replace(/ /g, '\\ ')
}

/** The distinct picture paths of a board, in order of first appearance. */
export function boardPictures(doc: BoardDoc): string[] {
  const seen = new Set<string>()
  for (const item of doc.items) if (item.kind === 'picture') seen.add(item.path)
  return [...seen]
}

interface Out {
  group(g: number): number
}

function flags(item: ItemCommon, out: Out): string[] {
  const parts: string[] = []
  if (item.locked) parts.push('lock')
  const g = out.group(item.group)
  if (g > 0) parts.push(`g=${g}`)
  return parts
}

function itemLine(item: BoardItem, out: Out): string {
  const n = (spec: Spec, v: number, fallback = 0): string => fmt(norm(spec, v, fallback), spec)
  switch (item.kind) {
    case 'picture': {
      const parts = [
        safeEmbedPath(item.path) ? `![[${item.path}]]` : `pic ${escapePicPath(item.path)}`,
        `x=${n(COORD, item.x)}`,
        `y=${n(COORD, item.y)}`,
        `w=${n(PICTURE_SIDE, item.w, DEFAULT_PICTURE_SIDE)}`,
        `h=${n(PICTURE_SIDE, item.h, DEFAULT_PICTURE_SIDE)}`,
      ]
      const r = normAngle(item.rotation)
      if (r !== 0) parts.push(`r=${formatNumber(r, ANGLE_DEC)}`)
      if (item.flipH || item.flipV) parts.push(`flip=${item.flipH ? 'h' : ''}${item.flipV ? 'v' : ''}`)
      const crop = validCrop(item.crop)
      if (crop && !(crop.l === 0 && crop.t === 0 && crop.r === 1 && crop.b === 1)) {
        parts.push(`crop=${[crop.l, crop.t, crop.r, crop.b].map((v) => formatNumber(v, CROP_EDGE.dec)).join(',')}`)
      }
      if (item.gray) parts.push('gray')
      const op = norm(OPACITY, item.opacity, 1)
      if (op !== 1) parts.push(`op=${fmt(op, OPACITY)}`)
      parts.push(...flags(item, out))
      const caption = capText(item.caption)
      return `- ${parts.join(' ')}${caption === '' ? '' : ` » ${escapeBoardText(caption)}`}`
    }
    case 'note': {
      const parts = [
        'note',
        `x=${n(COORD, item.x)}`,
        `y=${n(COORD, item.y)}`,
        `w=${n(PICTURE_SIDE, item.w, DEFAULT_NOTE_WIDTH)}`,
        `size=${n(NOTE_SIZE, item.size, DEFAULT_NOTE_SIZE)}`,
        `color=${normColor(item.color, DEFAULT_INK)}`,
        `fill=${normColor(item.fill, '')}`,
        `r=${formatNumber(normAngle(item.rotation), ANGLE_DEC)}`,
        ...flags(item, out),
      ]
      const text = capText(item.text)
      return `- ${parts.join(' ')}${text === '' ? '' : ` » ${escapeBoardText(text)}`}`
    }
    case 'stroke': {
      const pts: string[] = []
      const count = Math.min(Math.floor(item.points.length / 2), L.strokePoints)
      for (let i = 0; i < count; i++) pts.push(`${n(COORD, item.points[2 * i]!)},${n(COORD, item.points[2 * i + 1]!)}`)
      return `- ${['stroke', `color=${normColor(item.color, DEFAULT_INK)}`, `width=${n(MARK_WIDTH, item.width, DEFAULT_MARK_WIDTH)}`, ...flags(item, out), `pts=${pts.join(' ')}`].join(' ')}`
    }
    case 'line':
      return `- ${[
        'line',
        `x1=${n(COORD, item.x1)}`,
        `y1=${n(COORD, item.y1)}`,
        `x2=${n(COORD, item.x2)}`,
        `y2=${n(COORD, item.y2)}`,
        `color=${normColor(item.color, DEFAULT_INK)}`,
        `width=${n(MARK_WIDTH, item.width, DEFAULT_MARK_WIDTH)}`,
        ...(item.arrow ? ['arrow'] : []),
        ...flags(item, out),
      ].join(' ')}`
    default:
      return `- ${[
        item.kind,
        `x1=${n(COORD, item.x1)}`,
        `y1=${n(COORD, item.y1)}`,
        `x2=${n(COORD, item.x2)}`,
        `y2=${n(COORD, item.y2)}`,
        `color=${normColor(item.color, DEFAULT_INK)}`,
        `width=${n(MARK_WIDTH, item.width, DEFAULT_MARK_WIDTH)}`,
        `fill=${normColor(item.fill, '')}`,
        ...flags(item, out),
      ].join(' ')}`
  }
}

function viewLine(doc: BoardDoc): string {
  const view = doc.view
  return `- view ${[
    `x=${fmt(norm(COORD, view.x, 0), COORD)}`,
    `y=${fmt(norm(COORD, view.y, 0), COORD)}`,
    `zoom=${fmt(norm(ZOOM, view.zoom, 1), ZOOM)}`,
    `bg=${normColor(doc.bg, DEFAULT_BG)}`,
    `gray=${doc.gray ? 1 : 0}`,
    `smooth=${doc.smooth ? 1 : 0}`,
    `captions=${doc.captions ? 1 : 0}`,
    `grid=${fmt(norm(GRID, doc.grid, 0), GRID)}`,
  ].join(' ')}`
}

const charsOfItem = new WeakMap<BoardItem, number>()

/**
 * How many characters the item's line takes in the note (its line break included). Group labels are written as small numbers, so the
 * count is made with a one-digit label: within a few characters of the real line and cheap enough for every edit. Cached per item
 * (items are never mutated, only replaced).
 */
export function itemChars(item: BoardItem): number {
  let n = charsOfItem.get(item)
  if (n === undefined) {
    n = itemLine(item, { group: (g) => (g > 0 && Number.isFinite(g) ? 1 : 0) }).length + 1
    charsOfItem.set(item, n)
  }
  return n
}

/**
 * How many characters the board section takes in the note: the budget `BOARD_LIMITS.noteTotal` is measured with this. The controller
 * refuses to grow a board past it (shrinking is always allowed), the Boards code refuses to add pictures past it.
 */
export function boardChars(doc: BoardDoc): number {
  let total = 160 // the heading, the view line and the blank lines
  for (const item of doc.items) total += itemChars(item)
  for (const entry of doc.extra) total += entry.length + 1
  return total
}

/** The lines the board writes under its heading (the blank line after the heading included), without line breaks. */
function sectionLines(doc: BoardDoc): string[] {
  const labels = new Map<number, number>()
  const out: Out = {
    group(g) {
      if (!(g > 0) || !Number.isFinite(g)) return 0
      let label = labels.get(g)
      if (label === undefined) labels.set(g, (label = labels.size + 1))
      return label
    },
  }
  const itemLines = doc.items.map((item) => itemLine(item, out))
  // Past the limit the lines are kept after the items, where the reader keeps them too, instead of being dropped.
  const lines = ['', viewLine(doc), ...itemLines.slice(0, L.items)]
  const after: string[] = itemLines.slice(L.items)
  let fence: Fence | null = null
  for (const entry of doc.extra) {
    for (const t of entry.split(/\r?\n/)) {
      if (fence) {
        if (closesFence(t, fence)) fence = null
      } else if (isBlank(t)) continue
      else fence = opensFence(t)
      after.push(t)
    }
  }
  // A loop, not push(...after): a hostile note can leave a hundred thousand extra lines, more than a call takes as arguments.
  if (after.length > 0) {
    lines.push('')
    for (const t of after) lines.push(t)
  }
  return lines
}

/** The title as one line of text (`Board` when there is none). */
function cleanTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim() || 'Board'
}

/** A title for a heading: what a markdown parser would read as a link or a tag is escaped. */
function headingText(title: string): string {
  return cleanTitle(title).replace(/[\\[\]#<>`]/g, (c) => '\\' + c)
}

const INTRO =
  'Reference board. Open it from the Boards view (8). Everything under "Board" is rewritten by the board view; write anything else here or below.'

/** A new, empty board note: frontmatter (`title`, `type: board`, `created`, `updated`), the title as a heading, a line of help, the board. */
export function newBoardNote(title: string, now: Date): string {
  const day = todayIso(now)
  const name = cleanTitle(title)
  const body = `# ${headingText(name)}\n\n${INTRO}\n\n## Board\n${sectionLines(emptyBoard(name)).join('\n')}\n`
  return rewriteFrontmatter(`---\n---\n${body}`, { title: name, type: 'board', created: day, updated: day })
}

/** Whether the note's frontmatter says `type: board`. False for a note whose frontmatter cannot be parsed. */
export function isBoardNote(raw: string): boolean {
  return splitFrontmatter(raw).frontmatter['type'] === 'board'
}

/**
 * Writes `doc` into a note: with `raw`, exactly the board section is replaced (the heading is added at the end when there is none) and
 * every other byte stays, line endings included; the frontmatter's `title`, `type` and `updated` are patched in place, only when
 * something changed (so saving an unchanged board gives back `raw` itself). Without `raw` it is a fresh note (`newBoardNote`).
 * A note whose frontmatter cannot be parsed is returned unchanged. `now` stamps `updated`.
 */
export function serializeBoard(doc: BoardDoc, raw?: string, now: Date = new Date()): string {
  const base = raw ?? newBoardNote(doc.title, now)
  if (hasBrokenFrontmatter(base)) return base
  const split = splitFrontmatter(base)
  const found = scan(base, split.bodyOffset)
  const lines = sectionLines(doc)

  let text: string
  const section = found.section
  if (section) {
    const eol = section.heading.eol || detectEol(base)
    const after = base.slice(section.end)
    // The heading is the last line of a file with no final break: it needs one now. The section's own last line gets none there.
    const lead = section.heading.eol === '' ? eol : ''
    const closing = after === '' && section.endEol === '' ? '' : eol
    text = base.slice(0, section.heading.next) + lead + lines.join(eol) + closing + after
  } else {
    const eol = detectEol(base)
    let head = base
    if (head !== '' && !head.endsWith('\n')) head += eol
    // A code fence the note never closed would swallow the new heading: close it (adds a line, changes none).
    if (found.openFence) head += String.fromCharCode(found.openFence.ch).repeat(found.openFence.len) + eol
    if (head !== '') {
      const last = lineAt(head, head.lastIndexOf('\n', head.length - 2) + 1)
      if (!isBlank(last.text)) head += eol
    }
    text = `${head}## Board${eol}${lines.join(eol)}${eol}`
  }

  const patch: Record<string, unknown> = {}
  const name = cleanTitle(doc.title)
  // Compared as one line: a title with a double space is the title the note has, not a rename.
  const known = cleanTitle(asString(split.frontmatter['title']) ?? found.h1 ?? 'Board')
  if (doc.title.trim() !== '' && name !== known) patch['title'] = name
  if (split.frontmatter['type'] !== 'board') patch['type'] = 'board'
  if (text === base && Object.keys(patch).length === 0) return base
  patch['updated'] = todayIso(now)
  return rewriteFrontmatter(text, patch)
}

/* ------------------------------------------------- folder and file names --- */

/**
 * The folder names the vault never looks into (lower case): `HEAVY_DIRS` of apps/desktop/src/main/fsvault.ts, copied because core
 * cannot import the desktop app. A board's pictures in a folder of one of these names would not be found. Keep the two lists the same.
 */
const IGNORED_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules', '__macosx', '__pycache__', 'venv', 'env', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  'intermediate', 'saved', 'deriveddatacache', 'binaries', 'library', 'temp', 'logs',
  'cache', 'caches', 'tmp', 'coverage', 'bower_components', 'vendor', 'third_party', 'thirdparty', 'site-packages',
  'steamapps', 'windowsapps', 'appdata', 'system volume information', 'windows', 'program files',
  'program files (x86)', 'programdata', 'recovery', 'perflogs', 'msocache', 'config.msi',
])

/** Names Windows will not create as a file or folder, with or without an extension. */
const DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/** `s` without the characters of `chars` at either end. Linear: a regex for this backtracks quadratically on a long run. */
function trimEnds(s: string, chars: string, start = true, end = true): string {
  let a = 0
  let b = s.length
  if (start) while (a < b && chars.includes(s[a]!)) a++
  if (end) while (b > a && chars.includes(s[b - 1]!)) b--
  return s.slice(a, b)
}

/** `s` cut to `max` UTF-16 units without splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s
  const high = s.charCodeAt(max - 1)
  return s.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max)
}

/**
 * The name of the folder a board keeps its pictures in: the title with `\ / : * ? " < > | # [ ]` made `-`, white space collapsed,
 * no dots, spaces or `$` in front (the vault skips such folders) and no dots or spaces behind, at most 80 characters, `Board` when
 * nothing is left. A name the vault ignores (`Library`, `Temp`, `Cache`, `Out` ...), a name ending in `.aether-tmp` and a Windows
 * device name get ` pictures` after them.
 */
export function boardFolderName(title: string): string {
  let name = title
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\\/:*?"<>|#[\]]/g, '-')
    .replace(/\s+/g, ' ')
  name = trimEnds(cut(trimEnds(name, '.$ ', true, false), 80), '. ', false, true)
  if (name === '') return 'Board'
  const bare = name.toLowerCase()
  if (IGNORED_FOLDERS.has(bare) || DEVICE_NAMES.test(name) || bare.endsWith('.aether-tmp')) return `${name} pictures`
  return name
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/avif': 'avif',
}

/** File names a paste or drop gives a picture that say nothing: `image.png`, `blob`, `Screenshot` ... (optionally numbered). */
const GENERIC_NAME = /^(?:image|img|blob|unnamed|untitled|screenshot|screen shot|pasted image|clipboard|download|picture|photo|pic|file|unknown)(?: ?[-(]?\d{1,4}\)?)?$/i

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/**
 * A safe file name for a picture added to a board. The original's base name with `# | [ ] < > * _ ~ \ / : ? "` made `-` (runs
 * become one), or `ref YYYY-MM-DD HHMMSS` (local time of `now`) when that leaves nothing or a name that says nothing. The extension
 * is the original's when it is a picture type (png jpg jpeg webp gif bmp avif, lower case), else the MIME type's, else png.
 */
export function boardPictureName(original: string, mimeType: string, now: Date): string {
  const file = original.slice(Math.max(original.lastIndexOf('/'), original.lastIndexOf('\\')) + 1)
  const dot = /\.([A-Za-z0-9]{1,5})$/.exec(file)
  const given = dot ? dot[1]!.toLowerCase() : ''
  const keep = IMAGE_EXTENSIONS.includes(given)
  const ext = keep ? given : (MIME_EXTENSIONS[mimeType.trim().toLowerCase()] ?? 'png')
  const stem = dot ? file.slice(0, -dot[0].length) : file
  let base = stem
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[#|[\]<>*_~\\/:?"]+/g, '-')
    .replace(/\s+/g, ' ')
  base = trimEnds(cut(trimEnds(base, '-. '), 80), '-. ')
  if (base === '' || GENERIC_NAME.test(base)) {
    base = `ref ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  } else if (DEVICE_NAMES.test(base)) base += '-'
  return `${base}.${ext}`
}
