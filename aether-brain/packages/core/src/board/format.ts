/**
 * The board as a markdown note: read it (`parseBoard`, never fails), write it back (`serializeBoard`, which replaces exactly the
 * `## Board` section of the note and nothing else), and the small rules around it (which picture paths can be embedded, what a board's
 * folder and its pictures are called). Design and the file format: docs/design/reference-board.md ("The board file").
 *
 * One list line per item, back to front, `key=value` pairs and bare flags, text after the first ` » ` escaped so a line stays inert
 * (text.ts). Numbers are cut to at most two decimals (three for a crop and for a mark's width, four for the zoom) and every value is
 * clamped to BOARD_LIMITS / BOARD_ITEM_LIMITS by the same functions on the way in and on the way out, so that reading what was written
 * and writing it again gives the same text.
 *
 * What is the board's and what is the user's. The board is the `## Board` heading and the lines from its first to its last item (or view)
 * line, plus any lines that follow the last one with no blank line in between: that span is rewritten on every save. Everything else is
 * the user's and survives a save byte for byte, blank lines and position included: the text above the heading, and the text under the
 * items once a blank line separates it from them. Lines the reader does not understand inside the span are kept in `doc.extra` and
 * written back right after the items; attributes it does not know on a line it does understand are kept in the item (`unknown`).
 */
import { asString, rewriteFrontmatter, splitFrontmatter } from '../markdown/frontmatter'
import { IMAGE_EXTENSIONS, isBoardAssetPath, isImagePath, isModelPath } from '../vault/assets'
import { MODEL_PITCH_MAX, MODEL_VIEW_DEFAULT, isDefaultView, normaliseView } from '../models/proxyRaster'
import { todayIso } from '../vault/paths'
import { BOARD_ITEM_LIMITS } from './ops'
import { cleanText, cutText, escapeBoardText, unescapeBoardText } from './text'
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
const IL = BOARD_ITEM_LIMITS

/* -------------------------------------------------------------- numbers --- */

/** A field's allowed range and how many decimals the file keeps. */
interface Spec {
  lo: number
  hi: number
  dec: number
}

const COORD: Spec = { lo: -L.coordinate, hi: L.coordinate, dec: 2 }
// The ranges are the operations' own (ops.ts BOARD_ITEM_LIMITS): a value valid in memory is never changed by a save.
const PICTURE_SIDE: Spec = { lo: L.pictureMin, hi: L.pictureMax, dec: 2 }
const NOTE_WIDTH: Spec = { lo: IL.noteWidth.min, hi: IL.noteWidth.max, dec: 2 }
const NOTE_SIZE: Spec = { lo: IL.noteSize.min, hi: IL.noteSize.max, dec: 2 }
/** The width floor (0.005) has three decimals, so a mark's width keeps three. */
const MARK_WIDTH: Spec = { lo: IL.markWidth.min, hi: IL.markWidth.max, dec: 3 }
const OPACITY: Spec = { lo: IL.opacity.min, hi: IL.opacity.max, dec: 2 }
/** A model's view: where the camera is, in degrees (a turn is `normaliseView`'s: one decimal). */
const YAW: Spec = { lo: 0, hi: 360, dec: 1 }
const PITCH: Spec = { lo: -MODEL_PITCH_MAX, hi: MODEL_PITCH_MAX, dec: 1 }
/** The zoom floor (0.005) has three decimals, so the zoom keeps four. */
const ZOOM: Spec = { lo: L.zoomMin, hi: L.zoomMax, dec: 4 }
const GRID: Spec = { lo: IL.grid.min, hi: IL.grid.max, dec: 2 }
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

/** A note's or caption's text as the file keeps it: no control characters, cut (never inside a surrogate pair) to what a file may hold. */
function capText(s: string): string {
  return cutText(cleanText(s), L.noteCharsFile)
}

/* ---------------------------------------------------------- the section --- */

interface Line {
  /** Without its line break. */
  text: string
  start: number
  /** Where the next line starts. */
  next: number
  /** `\n`, `\r\n`, a lone `\r`, or '' for a last line with no break. */
  eol: string
}

/** The line that starts at `start`. A line ends at `\n`, `\r\n` or a lone `\r` (markdown reads all three as a line break). */
function lineAt(raw: string, start: number): Line {
  let i = start
  while (i < raw.length) {
    const c = raw.charCodeAt(i)
    if (c === 10 || c === 13) break
    i++
  }
  if (i >= raw.length) return { text: raw.slice(start), start, next: raw.length, eol: '' }
  const crlf = raw.charCodeAt(i) === 13 && raw.charCodeAt(i + 1) === 10
  const eol = crlf ? '\r\n' : raw[i]!
  return { text: raw.slice(start, i), start, next: i + eol.length, eol }
}

/** No visible character (blank, or spaces and tabs only). */
function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c !== 32 && c !== 9) return false
  }
  return true
}

/**
 * A stretch of lines that is kept as it is and hides what it holds (items, headings): a code fence, or an HTML comment that is not
 * closed on the line that opens it. `ch` is the fence character (backtick or tilde), 0 for a comment.
 */
interface Fence {
  ch: number
  len: number
}

const COMMENT: Fence = { ch: 0, len: 0 }

function fenceRun(text: string): { ch: number; len: number; rest: number } | null {
  let i = 0
  while (i < 3 && text.charCodeAt(i) === 32) i++
  const ch = text.charCodeAt(i)
  if (ch !== 96 && ch !== 126) return null
  let j = i
  while (text.charCodeAt(j) === ch) j++
  return j - i >= 3 ? { ch, len: j - i, rest: j } : null
}

/** The block a line opens (``` or ~~~, up to three spaces in; a backtick fence's info text holds no backtick; or `<!--` with no `-->` after it), or null. */
function opensFence(text: string): Fence | null {
  const run = fenceRun(text)
  if (run) return run.ch === 96 && text.indexOf('`', run.rest) >= 0 ? null : { ch: run.ch, len: run.len }
  let i = 0
  while (i < 3 && text.charCodeAt(i) === 32) i++
  return text.startsWith('<!--', i) && !text.includes('-->', i + 2) ? COMMENT : null
}

function closesFence(text: string, fence: Fence): boolean {
  if (fence.ch === 0) return text.includes('-->')
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
  /** The end of the board's last line (its break included); the heading's end when the section holds no board line. */
  end: number
  /** The line break of that last line ('' at the end of a file with no final break). */
  endEol: string
  /** Whether the section holds a view or item line (else it is a bare heading, and what follows it is the user's). */
  lines: boolean
}

interface Scan {
  section: Section | null
  /** The text of the note's first level-1 heading outside a code fence. */
  h1: string | null
  /** A code fence (or comment) still open at the end of the note. */
  openFence: Fence | null
}

/**
 * Whether a line the reader understands looks like one the board WRITES: attributes (`x=1`), text after ` » `, or a picture file. The
 * user's own bullets that start with the name of a kind (`- note the colours`, `- line 3 is wrong`, `- view from the north`) do not.
 */
function writtenLike(head: Extract<Head, { ok: true }>): boolean {
  if (head.kind === 'pic') return isBoardAssetPath(head.path)
  const after = head.after
  if (after.endsWith(' »') || after.includes(' » ')) return true
  for (let i = after.indexOf('='); i >= 0; i = after.indexOf('=', i + 1)) {
    if (i > 0 && after.charCodeAt(i - 1) !== 32) return true
  }
  return false
}

/**
 * Whether `text` is a list line of the board: a view line, or an item (an embed, `pic`, `note`, `stroke`, `line`, `rect`, `ellipse`).
 * `loose` is a line that follows a blank line once the board has begun: it must look like one the board writes (`writtenLike`), so that
 * a bullet of the user's under the board is not taken for an item. Lines right under the board's lines, and the first ones, are read as
 * hand-written (`- note » hi`, `- view smooth`).
 */
function isBoardLine(text: string, loose: boolean): boolean {
  if (!text.startsWith('- ')) return false
  const head = lineHead(text.slice(2))
  return head.ok && (!loose || writtenLike(head))
}

/**
 * Finds the board section in the part of the note from `from`: from the first `## Board` heading (case-sensitive) outside code fences
 * and comments to the board's last line, within the lines before the next heading of level 1 or 2 outside fences, or the end of the
 * note. The board's lines are the view and item lines, anything between them, and whatever follows the last of them with no blank line
 * in between; a blank line after the last item starts the user's own text, which is not the board's (and neither is anything after it).
 */
function scan(raw: string, from: number): Scan {
  let fence: Fence | null = null
  let h1: string | null = null
  let section: Section | null = null
  let ended = false
  // True while the lines seen follow the board's last line directly (no blank line since).
  let touching = false
  for (let pos = from; pos < raw.length; ) {
    const line = lineAt(raw, pos)
    pos = line.next
    // A byte-order mark in front of the first line of a note without frontmatter is not part of the line.
    const text = line.start === 0 && line.text.charCodeAt(0) === 0xfeff ? line.text.slice(1) : line.text
    let heading: { level: number; text: string } | null = null
    let held = false
    if (fence) {
      held = true
      if (closesFence(text, fence)) fence = null
    } else {
      fence = opensFence(text)
      if (fence) held = true
      else heading = headingOf(text)
    }
    if (heading && heading.level === 1 && h1 === null) h1 = heading.text
    if (ended) continue
    if (!section) {
      if (heading && heading.level === 2 && heading.text === 'Board') section = { heading: line, end: line.next, endEol: line.eol, lines: false }
      continue
    }
    if (heading && heading.level <= 2) {
      ended = true
      continue
    }
    if (!held && isBlank(text)) {
      touching = false
      continue
    }
    if (!held && isBoardLine(text, section.lines && !touching)) {
      section.lines = true
      touching = true
    }
    if (touching) {
      section.end = line.next
      section.endEol = line.eol
    }
  }
  return { section, h1, openFence: fence }
}

/** The last line of `text` (a final line break does not start another one). */
function lastLineOf(text: string): string {
  let end = text.length
  if (text.endsWith('\r\n')) end -= 2
  else if (end > 0 && (text.charCodeAt(end - 1) === 10 || text.charCodeAt(end - 1) === 13)) end--
  let i = end
  while (i > 0 && text.charCodeAt(i - 1) !== 10 && text.charCodeAt(i - 1) !== 13) i--
  return text.slice(i, end)
}

/** The line break the note uses: the first one it has (CRLF, a lone CR or LF), LF when it has none. */
function detectEol(raw: string): string {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    if (c === 10) return '\n'
    if (c === 13) return raw.charCodeAt(i + 1) === 10 ? '\r\n' : '\r'
  }
  return '\n'
}

/** The number of the line that starts at `offset` (1 for the first). */
function lineNumberAt(raw: string, offset: number): number {
  let n = 1
  for (let pos = 0; pos < offset && pos < raw.length; n++) pos = lineAt(raw, pos).next
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

/** The most attributes and flags this version does not know that a line keeps (the rest are dropped, with a warning). */
const MAX_UNKNOWN = 8

/**
 * An attribute or flag this version does not know is kept and written back only when it is a plain name, optionally with a plain
 * value: nothing a markdown parser would read as a link, tag, emphasis or html (no `[ ] # < > | * _ ~ \ ` ! & @ /`, no space, no `»`).
 */
const KEPT_TOKEN = /^[A-Za-z][A-Za-z0-9-]{0,31}(?:=[A-Za-z0-9.,:+-]{0,64})?$/

/** The unknown tokens that are safe to write, at most MAX_UNKNOWN: the filter on the way out too, for a doc not made by the reader. */
function keptTokens(tokens: readonly string[] | undefined): string[] {
  if (!tokens || tokens.length === 0) return []
  const out: string[] = []
  for (const t of tokens) {
    if (typeof t === 'string' && KEPT_TOKEN.test(t) && out.length < MAX_UNKNOWN) out.push(t)
  }
  return out
}

/** The `key=value` pairs and bare flags of one item line, each read once; what is left over is reported and kept. */
class Attrs {
  private readonly kv = new Map<string, string>()
  private readonly flags = new Set<string>()
  private readonly used = new Set<string>()
  /** Every token that is a pair or a flag, in the order it was written, with the name it is read by. */
  private readonly order: { token: string; name: string; flag: boolean }[] = []
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
        } else {
          this.kv.set(key, value)
          this.order.push({ token: t, name: key, flag: false })
        }
      } else if (eq === 0) this.say(`"${shorten(t)}" is not an attribute and was dropped`)
      else {
        this.flags.add(t)
        this.order.push({ token: t, name: t, flag: true })
      }
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

  /**
   * The pairs and flags nobody read, as written and in the order written: kept and written back with the line (a note saved by a
   * newer version, or edited by hand, loses nothing), each with a warning. Those that are not a plain name (or are too many) are dropped.
   */
  rest(): string[] {
    const kept: string[] = []
    for (const e of this.order) {
      if (this.used.has(e.name)) continue
      const what = e.flag ? 'flag' : 'attribute'
      if (!KEPT_TOKEN.test(e.token)) this.say(`unknown ${what} ${shorten(e.name)} is not a plain name and was dropped`)
      else if (kept.length >= MAX_UNKNOWN) this.say(`unknown ${what} ${e.name} was dropped: a line keeps at most ${MAX_UNKNOWN}`)
      else {
        kept.push(e.token)
        this.say(`unknown ${what} ${e.name} kept as written`)
      }
    }
    return kept
  }
}

function shorten(s: string): string {
  return s.length > 24 ? cutText(s, 24) + '...' : s
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
    if (x === null || y === null || out.length >= L.strokePointsFile * 2) left++
    else out.push(norm(COORD, x, 0), norm(COORD, y, 0))
  }
  if (left > 0) say(`${left} point${left === 1 ? '' : 's'} of the stroke could not be read or were past the limit of ${L.strokePointsFile}, and were left out`)
  return out
}

/** What the start of an item line says it is: the kind, the picture path (pictures only) and the rest of the line; or why it is not understood. */
type Head = { ok: true; kind: string; path: string; after: string } | { ok: false; why: string }

/** Reads the kind (and a picture's path) at the start of the part of a line after the `- `. Everything after that is attributes, which never fail. */
function lineHead(rest: string): Head {
  if (rest.startsWith('![[')) {
    const close = rest.indexOf(']]', 3)
    if (close < 0) return { ok: false, why: 'an embed that is never closed' }
    const path = rest.slice(3, close)
    if (!readableEmbedPath(path)) return { ok: false, why: 'an embed whose picture path cannot be read' }
    const after = rest.slice(close + 2)
    if (after !== '' && after.charCodeAt(0) !== 32) return { ok: false, why: 'an embed followed by text' }
    return { ok: true, kind: 'pic', path, after }
  }
  const sp = rest.indexOf(' ')
  const kind = sp < 0 ? rest : rest.slice(0, sp)
  if (!KINDS.has(kind)) return { ok: false, why: `an item kind this version does not know (${shorten(kind)})` }
  let after = sp < 0 ? '' : rest.slice(sp)
  let path = ''
  if (kind === 'pic') {
    if (after === '') return { ok: false, why: 'a picture without a path' }
    const p = picPath(after, 1)
    path = p.path
    after = after.slice(p.end)
  }
  return { ok: true, kind, path, after }
}

/**
 * Reads the part of an item line after the `- `. `at` is the line number for warnings. A line it cannot understand comes back as
 * 'extra'; one it understands never fails (a bad value is replaced by its default, with a warning).
 */
function parseItemLine(rest: string, at: number, say: (text: string) => void): Parsed {
  const warn = (text: string): void => say(`line ${at}: ${text}`)
  const head = lineHead(rest)
  if (!head.ok) return { type: 'extra', why: head.why }
  const { kind, path } = head
  const after = head.after
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
    if (t.length > L.noteCharsFile) warn(`text of ${t.length} characters cut to ${L.noteCharsFile}`)
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
      // Only a 3D model has a view; on any other picture `yaw` and `pitch` are attributes this version does not use, and are kept as they are.
      if (isModelPath(path)) {
        const view = normaliseView({ yaw: a.number('yaw', YAW, MODEL_VIEW_DEFAULT.yaw), pitch: a.number('pitch', PITCH, MODEL_VIEW_DEFAULT.pitch) })
        if (!isDefaultView(view)) item.turn = view
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
        w: a.number('w', NOTE_WIDTH, DEFAULT_NOTE_WIDTH),
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
  if (text !== null && kind !== 'pic' && kind !== 'note') warn(`${kind} has no text; the text after » was dropped`)
  if (a.points !== null && kind !== 'stroke') warn('pts belongs to a stroke and was dropped')
  const unknown = a.rest()
  if (unknown.length > 0) {
    if (result.type === 'item') result.item.unknown = unknown
    else if (result.type === 'view') {
      const apply = result.apply
      result = {
        type: 'view',
        apply(doc) {
          apply(doc)
          doc.viewUnknown = unknown
        },
      }
    }
  }
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

/** A to-do line (`- [ ] x`, `- [x] x`): the user's own, not an item kind from a newer version. */
const TASK_LINE = /^- \[[ xX]\](?: |$)/

function readBoard(raw: string, warn: Warnings): BoardDoc {
  const split = splitFrontmatter(raw)
  if (hasBrokenFrontmatter(raw)) warn.add('The frontmatter could not be read; the note is left alone.')
  const found = scan(raw, split.bodyOffset)
  const doc = emptyBoard(asString(split.frontmatter['title']) ?? found.h1 ?? 'Board')
  const section = found.section
  if (!section) return doc
  const size = section.end - section.heading.start
  if (size > L.noteTotal) warn.add(`The board takes ${size} characters of the note, past the ${L.noteTotal} a board should stay under.`)

  const items: BoardItem[] = []
  const extra: string[] = []
  const labels = new Map<number, number>()
  let viewSeen = false
  let overflow = 0
  let fence: Fence | null = null
  let no = lineNumberAt(raw, section.heading.start)
  // As in `scan`: whether the board has begun, and whether the last line seen is directly under a line of the board.
  let begun = false
  let touching = false
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
    if (isBlank(t)) {
      touching = false
      continue
    }
    fence = opensFence(t)
    if (fence || !t.startsWith('- ')) {
      extra.push(t)
      continue
    }
    // A bullet of the user's after a blank line (`- note the colours`) is a remark, not an item.
    if (begun && !touching) {
      const head = lineHead(t.slice(2))
      if (head.ok && !writtenLike(head)) {
        extra.push(t)
        continue
      }
    }
    const parsed = parseItemLine(t.slice(2), no, (text) => warn.add(text))
    if (parsed.type !== 'extra') {
      begun = true
      touching = true
    }
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
      if (!TASK_LINE.test(t)) warn.add(`line ${no}: ${parsed.why ?? 'not understood'}, kept as written`)
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

/** What follows the first ` » ` of the part of an item line after its kind (and a picture's path): its text; null when the line has none. */
function textAfter(after: string): string | null {
  const sep = after.indexOf(' » ')
  if (sep >= 0) return after.slice(sep + 3)
  return after.endsWith(' »') ? '' : null
}

/**
 * What the brain needs of a board note without reading its items as markdown (parseNote): the note's text with the board's own item
 * lines taken out (what the user wrote, the lines the board kept as extras and the heading stay), where each picture of the board is
 * written, and how to turn an offset in that text into an offset in `body`. Null when `body` has no board section. Linear in the size
 * of the note and nothing like a markdown parse, which used to cost 0.3 to 0.8 s for a full board on every save.
 */
export interface BoardNoteParts {
  text: string
  /** The pictures of the first BOARD_LIMITS.items items, in order: the path, the offset in `body` of the embed (or of the path of a `pic` line), and whether the path is written as it is (a `pic` line) or as wikilink text (an embed). */
  pictures: { path: string; offset: number; literal: boolean }[]
  /**
   * The words written on the board: the text of each of the first BOARD_LIMITS.items items that is a note or a picture with a caption
   * (when it has any), decoded as the reader decodes it, in order. For search and the word count only: nothing here is a link or a tag,
   * and no coordinate, attribute or item line is in it.
   */
  texts: string[]
  /** The offset in `body` of `offset` in `text`. */
  original(offset: number): number
}

export function boardNoteParts(body: string): BoardNoteParts | null {
  const section = scan(body, 0).section
  if (!section) return null
  const pieces: string[] = [body.slice(0, section.heading.next)]
  let kept = section.heading.next
  let removed = 0
  const breaks: { at: number; by: number }[] = []
  const pictures: { path: string; offset: number; literal: boolean }[] = []
  const texts: string[] = []
  let items = 0
  let viewSeen = false
  let fence: Fence | null = null
  let begun = false
  let touching = false
  for (let pos = section.heading.next; pos < section.end; ) {
    const line = lineAt(body, pos)
    pos = line.next
    const t = line.text
    let take = true
    if (fence) {
      if (closesFence(t, fence)) fence = null
    } else if (isBlank(t)) {
      touching = false
    } else {
      fence = opensFence(t)
      if (!fence && t.startsWith('- ')) {
        const head = lineHead(t.slice(2))
        // The same lines as `readBoard` takes for the board's own (a bullet of the user's after a blank line is not one).
        if (head.ok && !(begun && !touching && !writtenLike(head))) {
          begun = true
          touching = true
          take = false
          if (head.kind === 'view' && !viewSeen) viewSeen = true
          else if (head.kind !== 'view') {
            if (items < L.items && head.kind === 'pic' && isBoardAssetPath(head.path)) {
              // An embed's offset is its `!`; a `pic` line has no brackets, so its offset is where its path starts.
              const literal = !t.startsWith('- ![[')
              pictures.push({ path: head.path, offset: line.start + (literal ? 6 : 2), literal })
            }
            if (items < L.items && (head.kind === 'note' || head.kind === 'pic')) {
              // The words after the first " » " (parseItemLine reads the same place): a note's text, a picture's caption.
              const words = textAfter(head.after)
              const text = words === null ? '' : capText(unescapeBoardText(words))
              if (text !== '') texts.push(text)
            }
            items++
          }
        }
      }
    }
    if (take) {
      pieces.push(body.slice(line.start, line.next))
      kept += line.next - line.start
    } else {
      removed += line.next - line.start
      const last = breaks[breaks.length - 1]
      if (last && last.at === kept) last.by = removed
      else breaks.push({ at: kept, by: removed })
    }
  }
  pieces.push(body.slice(section.end))
  return {
    text: pieces.join(''),
    pictures,
    texts,
    original(offset) {
      // The last break at or before the offset: everything taken out before it has to be added back.
      let lo = 0
      let hi = breaks.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (breaks[mid]!.at <= offset) lo = mid + 1
        else hi = mid
      }
      return lo === 0 ? offset : offset + breaks[lo - 1]!.by
    },
  }
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
      if (item.turn && isModelPath(item.path)) {
        const view = normaliseView(item.turn)
        if (!isDefaultView(view)) parts.push(`yaw=${formatNumber(view.yaw, YAW.dec)}`, `pitch=${formatNumber(view.pitch, PITCH.dec)}`)
      }
      if (item.gray) parts.push('gray')
      const op = norm(OPACITY, item.opacity, 1)
      if (op !== 1) parts.push(`op=${fmt(op, OPACITY)}`)
      parts.push(...flags(item, out), ...keptTokens(item.unknown))
      const caption = capText(item.caption)
      return `- ${parts.join(' ')}${caption === '' ? '' : ` » ${escapeBoardText(caption)}`}`
    }
    case 'note': {
      const parts = [
        'note',
        `x=${n(COORD, item.x)}`,
        `y=${n(COORD, item.y)}`,
        `w=${n(NOTE_WIDTH, item.w, DEFAULT_NOTE_WIDTH)}`,
        `size=${n(NOTE_SIZE, item.size, DEFAULT_NOTE_SIZE)}`,
        `color=${normColor(item.color, DEFAULT_INK)}`,
        `fill=${normColor(item.fill, '')}`,
        `r=${formatNumber(normAngle(item.rotation), ANGLE_DEC)}`,
        ...flags(item, out),
        ...keptTokens(item.unknown),
      ]
      const text = capText(item.text)
      return `- ${parts.join(' ')}${text === '' ? '' : ` » ${escapeBoardText(text)}`}`
    }
    case 'stroke': {
      const pts: string[] = []
      const count = Math.min(Math.floor(item.points.length / 2), L.strokePointsFile)
      for (let i = 0; i < count; i++) pts.push(`${n(COORD, item.points[2 * i]!)},${n(COORD, item.points[2 * i + 1]!)}`)
      // Tokens this version does not know go before the points: the reader takes any token with a comma that follows them for a point.
      return `- ${['stroke', `color=${normColor(item.color, DEFAULT_INK)}`, `width=${n(MARK_WIDTH, item.width, DEFAULT_MARK_WIDTH)}`, ...flags(item, out), ...keptTokens(item.unknown), `pts=${pts.join(' ')}`].join(' ')}`
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
        ...keptTokens(item.unknown),
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
        ...keptTokens(item.unknown),
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
    ...keptTokens(doc.viewUnknown),
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
 * How many characters the board section takes in the note (the heading, the view line, every item and the lines it keeps): the budget
 * `BOARD_LIMITS.noteTotal` is measured with this. Within a few characters per grouped item of what `serializeBoard` writes, without
 * writing it (cached per item, one pass over the board). The controller refuses to grow a board past it (shrinking is always
 * allowed), the Boards code refuses to add pictures past it. The user's own text round the board is not counted.
 */
export function boardChars(doc: BoardDoc): number {
  let total = HEADING.length + 2 + viewLine(doc).length + 1 // `## Board`, a blank line, the view line, and their breaks
  for (const item of doc.items) total += itemChars(item)
  for (const entry of doc.extra) total += entry.length + 1
  return total
}

const HEADING = '## Board'

/**
 * The lines the board writes under its heading (the blank line after the heading included), without line breaks: the view line, the
 * items, then the lines it kept (right after the last item with no blank line, which is how the reader knows they are the board's).
 */
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
  // A loop, not push(...after): a hostile note can leave a hundred thousand extra lines, more than a call takes as arguments.
  for (let i = L.items; i < itemLines.length; i++) lines.push(itemLines[i]!)
  // The lines the board keeps, blank lines outside a code fence or comment left out. `held`: part of a fence or comment, which the reader
  // never takes for the board's. `remark`: a bullet of the user's that starts with the name of a kind (`- line 3 is wrong`).
  const kept: { text: string; held: boolean; remark: boolean }[] = []
  let fence: Fence | null = null
  for (const entry of doc.extra) {
    for (const t of entry.split(/\r\n|\r|\n/)) {
      let held = true
      if (fence) {
        if (closesFence(t, fence)) fence = null
      } else if (isBlank(t)) continue
      else {
        fence = opensFence(t)
        held = fence !== null
      }
      kept.push({ text: t, held, remark: !held && isBoardLine(t, false) && !isBoardLine(t, true) })
    }
  }
  let rest = 0
  // A remark of the user's is theirs only after a blank line: touching the board's lines it is read as an item (hand-written items are
  // taken there), and its words are lost. A blank line after the last item would put it outside the board, where the next save would
  // write it a second time. So the lines up to the last remark go BEFORE the last item the reader takes after a blank line, behind a
  // blank line of their own, and the reader finds them between two lines of the board, as it found them. (Not when a line among them is
  // one the reader would take for an item there, or when there is no such item to follow: then they are written as they always were.)
  let last = kept.length - 1
  while (last >= 0 && !kept[last]!.remark) last--
  if (last >= 0 && !kept.some((k, i) => i <= last && !k.remark && !k.held && isBoardLine(k.text, false))) {
    let anchor = 1 + Math.min(itemLines.length, L.items)
    while (anchor >= 2 && !isBoardLine(lines[anchor]!, true)) anchor--
    if (anchor >= 2) {
      const first = kept.findIndex((k) => k.remark)
      lines.splice(anchor, 0, ...kept.slice(0, first).map((k) => k.text), '', ...kept.slice(first, last + 1).map((k) => k.text))
      rest = last + 1
    }
  }
  for (let i = rest; i < kept.length; i++) lines.push(kept[i]!.text)
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
  const body = `# ${headingText(name)}\n\n${INTRO}\n\n${HEADING}\n${sectionLines(emptyBoard(name)).join('\n')}\n`
  return rewriteFrontmatter(`---\n---\n${body}`, { title: name, type: 'board', created: day, updated: day })
}

/** Whether the note's frontmatter says `type: board`. False for a note whose frontmatter cannot be parsed. */
export function isBoardNote(raw: string): boolean {
  return splitFrontmatter(raw).frontmatter['type'] === 'board'
}

/**
 * Writes `doc` into a note: with `raw`, exactly the board (the heading's lines down to the last line the board owns: see the header of
 * this file) is replaced, the heading is added at the end when there is none, and every other byte stays: the text above, the user's
 * text under the board with its blank lines, line endings included. The frontmatter's `title`, `type` and `updated` are patched in
 * place, only when something changed (so saving an unchanged board gives back `raw` itself, once the board lines are in the form this
 * function writes them). Without `raw` it is a fresh note (`newBoardNote`). A note whose frontmatter cannot be parsed is returned
 * unchanged. `now` stamps `updated`.
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
    // Everything after the board's last line is the user's and stays as it is.
    const after = base.slice(section.end)
    // The heading is the last line of a file with no final break: it needs one now. The section's own last line gets none there.
    const lead = section.heading.eol === '' ? eol : ''
    const closing = after === '' && section.endEol === '' ? '' : eol
    // A bare heading with the user's text right under it: the new view line must not run into it (a paragraph would continue the list item).
    const apart = !section.lines && after !== '' && !isBlank(lineAt(after, 0).text) && headingOf(lineAt(after, 0).text) === null ? eol : ''
    text = base.slice(0, section.heading.next) + lead + lines.join(eol) + closing + apart + after
  } else {
    const eol = detectEol(base)
    let head = base
    if (head !== '' && !/[\r\n]$/.test(head)) head += eol
    // A code fence (or comment) the note never closed would swallow the new heading: close it (adds a line, changes none).
    if (found.openFence) head += (found.openFence.ch === 0 ? '-->' : String.fromCharCode(found.openFence.ch).repeat(found.openFence.len)) + eol
    if (head !== '' && !isBlank(lastLineOf(head))) head += eol
    text = `${head}${HEADING}${eol}${lines.join(eol)}${eol}`
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
export const IGNORED_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules', '__macosx', '__pycache__', 'venv', 'env', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  'intermediate', 'saved', 'deriveddatacache', 'binaries', 'library', 'temp', 'logs',
  'cache', 'caches', 'tmp', 'coverage', 'bower_components', 'vendor', 'third_party', 'thirdparty', 'site-packages',
  'steamapps', 'windowsapps', 'appdata', 'system volume information', 'windows', 'program files',
  'program files (x86)', 'programdata', 'recovery', 'perflogs', 'msocache', 'config.msi',
])

/**
 * The names of game libraries and Windows leftovers the vault leaves out too (`GAME_DIRS` of apps/desktop/src/main/installs.ts, lower
 * case), copied for the same reason. A board called `Steam` or `Ubisoft` keeps its pictures in `Steam pictures`, not in a folder the
 * vault would refuse.
 */
export const GAME_FOLDERS: ReadonlySet<string> = new Set([
  'steamlibrary', 'steam library', 'steam', 'epic games', 'epicgames', 'xboxgames', 'xbox games', 'gog games', 'gog galaxy', 'riot games',
  'ea games', 'origin games', 'rockstar games', 'ubisoft', 'ubisoft game launcher', 'battle.net', 'blizzard games', 'amazon games',
  'windows.old', 'wpsystem', 'modifiablewindowsapps', 'onedrivetemp', 'msdownld.tmp', 'found.000',
])

/** The device names Windows reserves: `con prn aux nul` and `com` / `lpt` with a digit (the superscript digits too, as the Windows docs list them). */
const DEVICE_WORD = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i

/**
 * Where the device word of `name` ends, or -1 when the name is no device's. Windows reserves a name whose part before the FIRST dot is
 * one of the words (case does not matter, spaces before that dot do not count): `nul`, `NUL.txt`, `com1.tar.gz` and `con .x` are all the
 * device, not a file. A suffix at the end of the name does not free it; it has to come right after the word.
 */
function deviceWordEnd(name: string): number {
  const dot = name.indexOf('.')
  let end = dot < 0 ? name.length : dot
  while (end > 0 && name.charCodeAt(end - 1) === 32) end--
  // (The longest word has four characters: no need to test a long part.)
  return end <= 4 && DEVICE_WORD.test(name.slice(0, end)) ? end : -1
}

/** Whether Windows would take `name` (a file or folder name, with or without an extension) for a device: `CON`, `nul.txt`, `lpt9.a.b`. */
export function isDeviceName(name: string): boolean {
  return deviceWordEnd(name) >= 0
}

/** `s` without the characters of `chars` at either end. Linear: a regex for this backtracks quadratically on a long run. */
function trimEnds(s: string, chars: string, start = true, end = true): string {
  let a = 0
  let b = s.length
  if (start) while (a < b && chars.includes(s[a]!)) a++
  if (end) while (b > a && chars.includes(s[b - 1]!)) b--
  return s.slice(a, b)
}

/** The longest folder name: as long as a note's file name may be (`slugifyTitle` cuts at 120), so a board's folder carries its note's name. */
const FOLDER_NAME_MAX = 120

/**
 * The name of the folder a board keeps its pictures in: the title with `\ / : * ? " < > | # [ ]` made `-`, white space collapsed,
 * no dots, spaces or `$` in front (the vault skips such folders) and no dots or spaces behind, at most 120 characters (the note's own
 * longest name), `Board` when nothing is left. A name the vault ignores (`Library`, `Temp`, `Cache`, `Out` ... or a game library's: `Steam`, `Ubisoft` ...), a name
 * ending in `.aether-tmp` get ` pictures` after them; a Windows device name (`CON`, `nul.txt`: see `deviceWordEnd`) gets it right after
 * the device word (`CON pictures`, `nul pictures.txt`).
 */
export function boardFolderName(title: string): string {
  let name = title
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\\/:*?"<>|#[\]]/g, '-')
    .replace(/\s+/g, ' ')
  name = trimEnds(cutText(trimEnds(name, '.$ ', true, false), FOLDER_NAME_MAX), '. ', false, true)
  if (name === '') return 'Board'
  // A device name gets its suffix right after the device word (`nul.txt` is `nul pictures.txt`: at the end it would still be NUL).
  const device = deviceWordEnd(name)
  if (device >= 0) name = `${name.slice(0, device)} pictures${name.slice(device)}`
  const bare = name.toLowerCase()
  if (IGNORED_FOLDERS.has(bare) || GAME_FOLDERS.has(bare) || bare.endsWith('.aether-tmp')) return `${name} pictures`
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
 * become one), no dots, dashes, spaces or `$` in front (the vault skips a name that starts with a dot or a `$`), or
 * `ref YYYY-MM-DD HHMMSS` (local time of `now`) when that leaves nothing or a name that says nothing. The extension
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
  base = trimEnds(cutText(trimEnds(base, '-.$ ', true, false), 80), '-. ', false, true)
  if (base === '' || GENERIC_NAME.test(base)) {
    base = `ref ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  } else {
    // The dash goes right after the device word, before any dot: `nul.png.png` is `nul-.png.png`; `nul.png-` would still be NUL.
    const device = deviceWordEnd(base)
    if (device >= 0) base = `${base.slice(0, device)}-${base.slice(device)}`
  }
  return `${base}.${ext}`
}
