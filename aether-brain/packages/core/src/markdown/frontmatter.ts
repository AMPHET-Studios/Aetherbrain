import yaml from 'js-yaml'
import type { Frontmatter } from '../types'

const FM_OPEN = /^(?:﻿)?---[ \t]*\r?\n/
const FM_CLOSE = /\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/
const FM_CLOSE_EMPTY = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

export interface SplitResult {
  frontmatter: Frontmatter
  body: string
  /** Character index where the body starts inside the original string. */
  bodyOffset: number
  /** True when a frontmatter block was present (even if empty). */
  hasFrontmatter: boolean
}

/** Where the frontmatter block of `raw` sits, or null when there is none. */
interface BlockAt {
  /** End of the opening `---` line (a byte-order mark before it included). */
  openEnd: number
  /** End of the YAML text; the line break before the closing `---` is not part of it. */
  yamlEnd: number
  /** Where the body starts (after the closing line). */
  bodyOffset: number
}

function locateBlock(raw: string): BlockAt | null {
  const open = FM_OPEN.exec(raw)
  if (!open) return null
  const rest = raw.slice(open[0].length)
  // An empty block closes on the very next line (`---\n---`).
  const close = FM_CLOSE_EMPTY.exec(rest) ?? FM_CLOSE.exec(rest)
  if (!close) return null
  const openEnd = open[0].length
  return { openEnd, yamlEnd: openEnd + close.index, bodyOffset: openEnd + close.index + close[0].length }
}

/** Parse a frontmatter block's YAML: a mapping (`{}` for a blank or comment-only block), or null when it is not one. */
function loadBlock(yamlText: string): Frontmatter | null {
  try {
    const parsed = yaml.load(yamlText, { schema: yaml.JSON_SCHEMA })
    if (parsed === null || parsed === undefined) return {}
    if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Frontmatter
  } catch {
    // fall through
  }
  return null
}

/**
 * Split a markdown document into YAML frontmatter + body.
 * Tolerant: invalid YAML yields an empty object rather than throwing, because a
 * single broken note should never take the whole graph down.
 */
export function splitFrontmatter(raw: string): SplitResult {
  const at = locateBlock(raw)
  if (!at) return { frontmatter: {}, body: raw, bodyOffset: 0, hasFrontmatter: false }
  const frontmatter = loadBlock(raw.slice(at.openEnd, at.yamlEnd)) ?? {}
  return { frontmatter, body: raw.slice(at.bodyOffset), bodyOffset: at.bodyOffset, hasFrontmatter: true }
}

const DUMP_OPTIONS: yaml.DumpOptions = { lineWidth: 120, noRefs: true, flowLevel: 1, quotingType: '"' }

/** Serialize frontmatter + body back into a markdown document. */
export function joinFrontmatter(frontmatter: Frontmatter, body: string): string {
  const keys = Object.keys(frontmatter)
  if (keys.length === 0) return body
  const text = yaml.dump(frontmatter, DUMP_OPTIONS).trimEnd()
  const trimmedBody = body.replace(/^\s*\n/, '')
  return `---\n${text}\n---\n\n${trimmedBody}`
}

/**
 * Update frontmatter keys on a raw document in place (see `rewriteFrontmatter`).
 * Pass `undefined` as a value to delete a key.
 */
export function updateFrontmatter(raw: string, patch: Record<string, unknown>): string {
  return rewriteFrontmatter(raw, patch)
}

/**
 * Set and delete top-level frontmatter keys in place; `undefined` deletes a key.
 *
 * Only the lines of keys whose value really changes are rewritten (the key
 * line plus its indented continuation lines); new keys go at the end of the
 * block. Everything else stays byte-identical: comments, untouched keys and
 * how their values are spelled (`version: 1.10`, `id: 01234`), the gap before
 * the body, and the body itself. A document without frontmatter gets a new
 * block in front of the body (its leading blank lines give way to one). A
 * byte-order mark stays the first thing in the file, and new lines follow
 * the file's CRLF / LF. Returns `raw` itself when nothing changes.
 *
 * A block whose YAML does not parse is patched in place when its lines can
 * still be told apart, and otherwise left alone: its text is never dropped.
 * Exotic YAML the line model can't follow (flow mappings, complex keys) is
 * re-serialized as a whole, as before; so is a block whose patched lines
 * would not read back as exactly the data intended (an anchor on a replaced
 * line that an alias elsewhere refers to).
 *
 * `body` replaces the text after the block (default: keep it as it is).
 */
export function rewriteFrontmatter(raw: string, patch: Record<string, unknown>, body?: string): string {
  const at = locateBlock(raw)
  if (!at) {
    const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
    const text = body ?? raw.slice(bom.length)
    const set = Object.entries(patch).filter(([, v]) => v !== undefined)
    if (set.length === 0) return body === undefined ? raw : bom + text
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const block = dumpEntries(set).join(eol)
    return `${bom}---${eol}${block}${eol}---${eol}${eol}${text.replace(/^\s*\n/, '')}`
  }
  const head = raw.slice(0, at.openEnd)
  const yamlText = raw.slice(at.openEnd, at.yamlEnd)
  const tail = raw.slice(at.yamlEnd, at.bodyOffset)
  const rest = body ?? raw.slice(at.bodyOffset)
  const unchanged = body === undefined ? raw : raw.slice(0, at.bodyOffset) + rest
  const eol = raw.slice(0, at.bodyOffset).includes('\r\n') ? '\r\n' : '\n'
  const current = loadBlock(yamlText)
  const lines = yamlText === '' ? [] : yamlText.split('\n')
  const model = entriesOf(lines)

  // What really changes: a value that differs, a key that goes.
  const present = (k: string): boolean =>
    current ? Object.hasOwn(current, k) : (model?.some((e) => e.key === k) ?? false)
  const changes: [string, unknown][] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined ? present(k) : !current || !Object.hasOwn(current, k) || !sameValue(current[k], v)) changes.push([k, v])
  }
  if (changes.length === 0) return unchanged

  // The data the block must hold afterwards (known when the block parses).
  let next: Frontmatter | null = null
  if (current) {
    next = { ...current }
    for (const [k, v] of changes) {
      if (v === undefined) delete next[k]
      else next[k] = v
    }
  }
  /** The whole block re-serialized from `next`, as before in-place patching. */
  const redump = (data: Frontmatter): string => {
    const keys = Object.entries(data)
    if (keys.length === 0) return (head.startsWith('\uFEFF') ? '\uFEFF' : '') + rest
    return head + withBreak(dumpEntries(keys).join(eol), tail, eol) + tail + rest
  }
  const keysMatch = !!model && !!current && sameKeys(model, current)
  // The line model can't follow this YAML: re-serialize the whole block.
  if (!keysMatch && next) return redump(next)
  // Unparsed YAML whose lines can't be told apart: leave it alone rather than lose it.
  if (!model) return unchanged

  // Patch line by line, bottom-up so earlier indices stay valid. Each line
  // keeps its own `\r`; the last YAML line has no break of its own (the
  // closing line's follows it), so it takes the block's in case it moves up.
  const cr = eol === '\r\n' ? '\r' : ''
  const out = lines.map((l, i) => {
    const hasCr = l.endsWith('\r')
    return { text: hasCr ? l.slice(0, -1) : l, cr: i === lines.length - 1 ? cr : hasCr ? '\r' : '' }
  })
  const byKey = new Map(model.map((e) => [e.key, e]))
  const appended: string[] = []
  const edits: { start: number; end: number; lines: string[] }[] = []
  for (const [k, v] of changes) {
    const e = byKey.get(k)
    const dumped = v === undefined ? [] : dumpEntries([[k, v]])
    if (e) edits.push({ start: e.start, end: e.end, lines: dumped })
    else appended.push(...dumped)
  }
  edits.sort((a, b) => b.start - a.start)
  for (const e of edits) out.splice(e.start, e.end - e.start, ...e.lines.map((text) => ({ text, cr })))
  if (appended.length) {
    // New keys go after the last non-blank line, so a trailing blank line stays last.
    let end = out.length
    while (end > 0 && (out[end - 1]?.text ?? '').trim() === '') end--
    out.splice(end, 0, ...appended.map((text) => ({ text, cr })))
  }
  // Every key gone and nothing else written there: the block goes.
  if (!out.some((l) => l.text.trim() !== '')) return (head.startsWith('\uFEFF') ? '\uFEFF' : '') + rest
  const text = out.map((l, i) => (i === out.length - 1 ? l.text : l.text + l.cr)).join('\n')
  // The patched block must read back as exactly the data intended. It may
  // not when the lines depend on each other (an anchor `&x` on a replaced
  // line that a `*x` elsewhere refers to): then re-serialize the whole block,
  // which never leaves YAML that no longer parses.
  if (next) {
    const back = loadBlock(text)
    if (!back || canonical(back) !== canonical(next)) return redump(next)
  }
  return head + withBreak(text, tail, eol) + tail + rest
}

/** JSON with every object's keys sorted: the same text for the same data, whatever the key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/** `text` plus the line break the closing line needs when it does not bring its own (`---\n---`). */
function withBreak(text: string, tail: string, eol: string): string {
  return text !== '' && !/^\r?\n/.test(tail) ? text + eol : text
}

/** YAML lines (no trailing break) for `key: value` pairs, dumped the way the app writes frontmatter. */
function dumpEntries(entries: [string, unknown][]): string[] {
  // Only the dump's own final break goes: a kept block scalar (`|+`) ends in meaningful blank lines.
  return yaml.dump(Object.fromEntries(entries), DUMP_OPTIONS).replace(/\n$/, '').split('\n')
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** A top-level key of the block and the lines it spans (`end` exclusive: the key line plus its continuation lines). */
interface Entry {
  key: string
  start: number
  end: number
}

/**
 * The top-level entries of a block mapping, line by line: a key line starts
 * at column 0; indented lines and `- ` items at column 0 continue the entry
 * above; blank lines and column-0 comments belong to no entry (unless deeper
 * lines of the same entry follow them). Null when a line fits none of that.
 */
function entriesOf(lines: string[]): Entry[] | null {
  const out: Entry[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? '').replace(/\r$/, '')
    if (l.trim() === '') continue
    const c = l[0]
    if (c === ' ' || c === '\t' || (c === '-' && (l.length === 1 || l[1] === ' ' || l[1] === '\t'))) {
      const cur = out[out.length - 1]
      if (!cur) return null
      cur.end = i + 1
      continue
    }
    if (c === '#') continue
    const key = keyOfLine(l)
    if (key === null) return null
    out.push({ key, start: i, end: i + 1 })
  }
  return out
}

/** The key a `key: value` line at column 0 sets, or null when the line is not one. Linear time. */
function keyOfLine(line: string): string | null {
  const q = line[0]
  if (q === '"' || q === "'") {
    let i = 1
    for (; i < line.length; i++) {
      if (q === '"' && line[i] === '\\') i++
      else if (line[i] === q) {
        if (q === "'" && line[i + 1] === "'") i++
        else break
      }
    }
    if (i >= line.length) return null
    let j = i + 1
    while (line[j] === ' ' || line[j] === '\t') j++
    if (line[j] !== ':' || !(j + 1 === line.length || line[j + 1] === ' ' || line[j + 1] === '\t')) return null
    try {
      const key = yaml.load(line.slice(0, i + 1), { schema: yaml.JSON_SCHEMA })
      return typeof key === 'string' ? key : null
    } catch {
      return null
    }
  }
  // Flow collections, anchors, tags, block scalars, complex keys: not a plain `key:` line.
  if (q === undefined || '{}[],&*!|>%@`?:'.includes(q)) return null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === ':' && (i + 1 === line.length || line[i + 1] === ' ' || line[i + 1] === '\t')) return line.slice(0, i).trimEnd()
    // A comment before any `key:` separator: not a key line.
    if (c === '#' && (line[i - 1] === ' ' || line[i - 1] === '\t')) return null
  }
  return null
}

/** True when the line model found exactly the keys the YAML parser did, each once. */
function sameKeys(model: Entry[], parsed: Frontmatter): boolean {
  const keys = Object.keys(parsed)
  if (keys.length !== model.length) return false
  const seen = new Set(model.map((e) => e.key))
  return seen.size === model.length && keys.every((k) => seen.has(k))
}

export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') {
    return v
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
  }
  return []
}

export function asString(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v).trim()
  return s.length ? s : null
}

/** Normalize a date-ish frontmatter value to an ISO string (date or datetime). */
export function asIsoDate(v: unknown): string | null {
  const s = asString(v)
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const t = Date.parse(s)
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString()
}
