/**
 * The text of a board: how a note's words and a picture's caption are written into one markdown line (and read back), and a
 * rough measure of wrapped text for the places that have no canvas (hit testing in node, the controller before a font is known).
 * Design: docs/design/reference-board.md ("The board file").
 */
import { NOTE_LINE_HEIGHT_EM, NOTE_PADDING_EM } from './types'
import type { TextLayout, TextMetrics } from './types'

/** A note's inner margin as a multiple of its font size (the contract's name for `NOTE_PADDING_EM`). */
export const NOTE_PADDING = NOTE_PADDING_EM

/** Average width of a glyph, as a multiple of the font size. */
const GLYPH_EM = 0.55

/** Every character the escape puts a backslash in front of, besides the backslash itself (what a markdown parser would read). */
const ESCAPED = /[\\\n\r[\]#<>|*_~!`]/g

/** ASCII punctuation: a backslash before one of these is an escape in markdown too, so reading it back as the bare character is right. */
function isAsciiPunctuation(code: number): boolean {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126)
}

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair (a cut emoji would be written as a lone surrogate). */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text
  let end = Math.max(0, max)
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--
  return text.slice(0, end)
}

/**
 * Text as one inert line: `\` becomes `\\`, a line feed `\n`, a carriage return `\r`, and `\` goes before each of
 * `[ ] # < > | * _ ~ ! \``. What comes out holds no link, tag, task, table or HTML a markdown parser would read, and no line break.
 * `unescapeBoardText` is its exact inverse.
 */
export function escapeBoardText(s: string): string {
  return s.replace(ESCAPED, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\' + c))
}

/**
 * Reads escaped text back. `\n` and `\r` are the line breaks, `\ ` is a space (only the path of a `pic` line writes it), a backslash
 * before any other ASCII punctuation is that character (as markdown reads it), and a backslash before anything else (or at the end)
 * is itself: a hand-written line never loses a character it did not mean as an escape.
 */
export function unescapeBoardText(s: string): string {
  if (!s.includes('\\')) return s
  let out = ''
  let from = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 92) continue
    const next = s.charCodeAt(i + 1)
    let decoded: string | null = null
    if (next === 110) decoded = '\n'
    else if (next === 114) decoded = '\r'
    else if (next === 32) decoded = ' '
    else if (isAsciiPunctuation(next)) decoded = s[i + 1]!
    if (decoded === null) continue
    out += s.slice(from, i) + decoded
    i++
    from = i + 1
  }
  return out + s.slice(from)
}

/** Code points in a string (an emoji is one glyph, not two UTF-16 units). */
function glyphCount(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}

/** `s` cut into pieces of at most `cap` glyphs (never inside a surrogate pair). */
function chunks(s: string, cap: number): string[] {
  const out: string[] = []
  let piece = ''
  let n = 0
  for (const ch of s) {
    if (n === cap) {
      out.push(piece)
      piece = ''
      n = 0
    }
    piece += ch
    n++
  }
  out.push(piece)
  return out
}

/** One paragraph (no line feed) wrapped greedily at spaces to at most `cap` glyphs a line; a longer word is broken. */
function wrapParagraph(paragraph: string, cap: number, out: string[]): void {
  if (!Number.isFinite(cap) || glyphCount(paragraph) <= cap) {
    out.push(paragraph)
    return
  }
  const words = paragraph.split(' ')
  let line = ''
  let lineGlyphs = 0
  let started = false
  for (const word of words) {
    const w = glyphCount(word)
    if (started && lineGlyphs + 1 + w <= cap) {
      line += ' ' + word
      lineGlyphs += 1 + w
      continue
    }
    if (started) out.push(line)
    started = true
    if (w <= cap) {
      line = word
      lineGlyphs = w
      continue
    }
    // A word wider than the line: full lines of it, the rest starts the next line.
    const pieces = chunks(word, cap)
    for (let i = 0; i < pieces.length - 1; i++) out.push(pieces[i]!)
    line = pieces[pieces.length - 1]!
    lineGlyphs = glyphCount(line)
  }
  out.push(line)
}

/**
 * Text measured without a canvas: every glyph is `0.55 × size` wide, lines break at spaces (a word wider than the line is broken
 * where it fills the line), `\n` starts a new line, a line is `NOTE_LINE_HEIGHT_EM × size` high. Empty text is one empty line, and
 * non-empty text never comes back with no lines. `maxWidth` is the width the text wraps to; at least one glyph goes on a line.
 */
export const estimateTextMetrics: TextMetrics = {
  layout(text: string, size: number, maxWidth: number): TextLayout {
    const px = Number.isFinite(size) && size > 0 ? size : 0
    const glyph = px * GLYPH_EM
    // The epsilon keeps a width meant to hold exactly n glyphs (n × 5.5) from falling to n - 1 by rounding.
    const cap = glyph > 0 && Number.isFinite(maxWidth) ? Math.max(1, Math.floor(maxWidth / glyph + 1e-9)) : Infinity
    const lines: string[] = []
    for (const paragraph of text.split('\n')) wrapParagraph(paragraph.replace(/\r$/, ''), cap, lines)
    let widest = 0
    for (const line of lines) widest = Math.max(widest, glyphCount(line))
    return { lines, width: widest * glyph, height: lines.length * px * NOTE_LINE_HEIGHT_EM }
  },
}
