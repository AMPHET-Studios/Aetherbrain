/**
 * The checks behind the reference board's floating window saving and reading its note (`board:save`, `board:read`, and the check
 * `board:open` makes). The window's page has a bridge of its own (board-preload.cts: these calls, the pictures, nothing else) and
 * main answers no other channel to it; what this file guarantees is about the calls it does make: `board:save` may overwrite a board
 * note that is already there, never create a note, never touch a note that is not a board (or a link to one), and never write more
 * than a board can hold. Pure Node (no electron import), tested against a temp vault.
 *
 * Main cannot import @aether/core at runtime (tsc compiles it as plain Node ESM, the package is TypeScript source), so "is this a
 * board" is a small local check of the note's head. `isBoardHead` follows `isBoardNote` of core: the test pins the two to each other.
 */
import { promises as fs } from 'node:fs'
import { readHead } from './assets.js'
import type { BoardSaveResult } from '../shared/ipc.js'

/**
 * The most characters the floating window handles of one board NOTE (the whole note: the prose around the board counts, not only
 * the board section, which core's BOARD_LIMITS.noteTotal holds to 500,000). `board:open` refuses a longer note up front, so that a
 * window is never opened on a board it cannot read.
 */
export const MAX_BOARD_TEXT = 1_000_000
/** How much of the head of a note decides whether it is a board (its frontmatter is a few lines). */
export const BOARD_HEAD_BYTES = 4096
/** Longest vault path taken (the same bound the Forge window's ids have). */
export const MAX_BOARD_PATH = 4096

/** What the checks need of the vault: `FsVault` has all of it. */
export interface BoardVault {
  /** Absolute path of a vault path; throws on a path that leaves the vault. */
  abs(path: string): string
  /** Info on a file or folder, or null when it is missing, excluded or not a valid vault path. */
  stat(path: string): Promise<{ isDir: boolean; isFile: boolean; mtime: number } | null>
  read(path: string): Promise<string | null>
  /** Atomic: a temp sibling and a rename. */
  write(path: string, content: string): Promise<void>
}

const FM_OPEN = /^﻿?---[ \t]*\r?\n/
const FM_CLOSE = /\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/
const FM_CLOSE_EMPTY = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

/*
 * The frontmatter grammar this check reads: a small subset of YAML in which every line can be judged on its own, so that what it
 * accepts is a mapping to YAML as well. A line outside it makes the whole block "not a board" (the note is left alone), whatever
 * YAML would have made of it. What it knows:
 *   key: value            at column 0; the key plain or in simple quotes, the value empty, a one-line plain or quoted scalar, a one-line
 *                         list of those in [ ], or a block scalar header (| or >) whose text is the more indented lines after it
 *   key:                  followed by `- item` lines (all in one column): a block list of one-line scalars
 *   # comment, blank      anywhere
 * What it refuses: a value that goes on to the next line (a quote or bracket left open, a plain scalar continued on an indented line),
 * nested mappings, flow mappings, anchors, aliases, tags, directives, complex keys, a key repeated, a block indented as a whole, tabs
 * and control characters. Each of those is a place where YAML reads the lines after it differently from a line-by-line reader.
 */
const BAD_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\uFEFF\uFFFE\uFFFF]/
/** After a value: nothing, or a comment set off by white space. */
const AFTER_VALUE = /^(?:[ \t]+#.*)?$/
// A double-quoted scalar on one line, with the escapes YAML has (\U is left out: a code point past U+10FFFF is an error to the reader).
const DOUBLE = /"((?:[^"\\]|\\(?:[0abt\tnvfre "\/\\N_LP]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}))*)"/
const SINGLE = /'((?:[^']|'')*)'/
const DOUBLE_AT_START = new RegExp(`^${DOUBLE.source}`)
const SINGLE_AT_START = new RegExp(`^${SINGLE.source}`)
// One item of a one-line list: a quoted scalar, or plain words with none of , [ ] { } # : in them (and not starting with an indicator).
const LIST_ITEM_AT_START = new RegExp(`^(?:${DOUBLE.source}|${SINGLE.source}|-[0-9.][^,\\[\\]{}#:]*?|[^\\s,\\[\\]{}#:&*!|>'"%@\`?-][^,\\[\\]{}#:]*?)(?=[ \\t]*[,\\]])`)
/** `key: value` at column 0: the key (plain and not starting with an indicator or `<`, so no merge key, or in quotes with nothing escaped in it) and what follows the colon. */
const ENTRY = /^(?:([^\s#\-?:{}[\],&*!|>'"%@`<][^:]*?)|"([^"\\]*)"|'([^']*)')[ \t]*:(?:[ \t]+(.*))?$/
const DASH_ITEM = /^( *)-(?: (.*))?$/
const MAX_KEY = 512

/** Spaces and tabs off both ends: YAML's own idea of white space (JS `trim()` also takes the no-break spaces, which YAML keeps). */
const trimBlanks = (v: string): string => v.replace(/^[ \t]+|[ \t]+$/g, '')
const isBlank = (v: string): boolean => /^[ \t]*$/.test(v)

type Value = { kind: 'empty' | 'block' | 'flow' } | { kind: 'scalar'; text: string } | null

/** A one-line list `[a, "b", 'c']`; trailing comma allowed, nothing nested. */
function oneLineList(v: string): boolean {
  let rest = v.slice(1)
  for (;;) {
    rest = rest.replace(/^[ \t]+/, '')
    if (rest.startsWith(']')) break
    const item = LIST_ITEM_AT_START.exec(rest)
    if (!item) return false
    rest = rest.slice(item[0].length).replace(/^[ \t]+/, '')
    if (rest.startsWith(',')) rest = rest.slice(1)
    else if (!rest.startsWith(']')) return false
  }
  return AFTER_VALUE.test(rest.slice(1))
}

/** What follows `key:` (or `- `) on its line, read as one of the forms above; null for anything else. */
function readValue(v: string): Value {
  if (v === '' || v.startsWith('#')) return { kind: 'empty' }
  const first = v[0]!
  if (first === '|' || first === '>') return /^[|>][+-]?(?:[ \t]+#.*)?$/.test(v) ? { kind: 'block' } : null
  if (first === '"' || first === "'") {
    const m = (first === '"' ? DOUBLE_AT_START : SINGLE_AT_START).exec(v)
    return m && AFTER_VALUE.test(v.slice(m[0].length)) ? { kind: 'scalar', text: m[1]! } : null
  }
  if (first === '[') return oneLineList(v) ? { kind: 'flow' } : null
  // Flow mappings, anchors, aliases, tags, directives, reserved indicators, and `?` `:` `-` that open something rather than a word.
  if ('{&*!%@`,]}?:'.includes(first) || (first === '-' && !/^-[0-9.]/.test(v))) return null
  const cut = v.search(/[ \t]#/)
  const text = trimBlanks(cut < 0 ? v : v.slice(0, cut))
  // A `: ` inside a plain scalar is a mapping where YAML wants none.
  return /:(?:[ \t]|$)/.test(text) ? null : { kind: 'scalar', text }
}

/** What the grammar says of a head: it is a board; it is not (no frontmatter, another type); or it could not be judged (a line outside the grammar, a block that runs past the head). */
export type HeadVerdict = 'yes' | 'no' | 'unsure'

/**
 * Whether the head of a note is a frontmatter block with `type: board` at its top level: a `---` line first (a byte-order mark may
 * come before it), a closing `---` line within the head, and in between a block of the grammar above with exactly one `type` key
 * whose value is board (plain or quoted, a trailing comment allowed; `Board`, `[board]` and an empty value are not).
 * Main cannot run core's YAML parser, so this is a check of lines, and one-sided on purpose: it may say no where core's `isBoardNote`
 * says yes (a block YAML reads but this grammar does not: flow mappings, nested mappings, tags, a block indented as a whole ... all
 * legal and none of them written by hand in a board, and the window then says the note is not a board), and it must never say yes
 * where core says no, because a yes lets the floating window overwrite a note. The test pins the second half over thousands of odd
 * frontmatters, the unreadable ones included.
 */
export function isBoardHead(head: string): boolean {
  return judgeBoardHead(head, false) === 'yes'
}

/**
 * `isBoardHead` with the reason for a no: 'no' for a note that is plainly no board (no frontmatter, no `type`, another type),
 * 'unsure' for a frontmatter this grammar cannot follow or that goes on past the head (`truncated`: the head is all the file was
 * read up to). The window tells the two apart, because "it needs type: board" is wrong to say of a board with a nested mapping.
 */
export function judgeBoardHead(head: string, truncated: boolean): HeadVerdict {
  const open = FM_OPEN.exec(head)
  if (!open) return 'no'
  const rest = head.slice(open[0].length)
  const close = FM_CLOSE_EMPTY.exec(rest) ?? FM_CLOSE.exec(rest)
  if (!close) return truncated ? 'unsure' : 'no'
  const keys = new Set<string>()
  let type: string | null = null
  // After a key with no value a list may follow; after a block scalar header, its text.
  let mode: 'entries' | 'list' | 'text' = 'entries'
  let dashColumn = -1
  let textIndent = -1
  for (const raw of rest.slice(0, close.index).split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (BAD_CHARS.test(line)) return 'unsure'
    if (isBlank(line)) {
      // Spaces on an empty line before a block's text would have to be no longer than the text's own indentation: not worth reading.
      if (mode === 'text' && textIndent < 0 && line !== '') return 'unsure'
      continue
    }
    const indent = /^ */.exec(line)![0].length
    if (mode === 'text' && indent > 0) {
      if (textIndent < 0) textIndent = indent
      else if (indent < textIndent) return 'unsure'
      continue
    }
    const body = line.slice(indent)
    if (body.startsWith('\t')) return 'unsure'
    if (body.startsWith('#')) {
      if (mode === 'text') mode = 'entries'
      continue
    }
    if (indent > 0 || /^-(?: |$)/.test(body)) {
      const item = mode === 'list' ? DASH_ITEM.exec(line) : null
      if (!item) return 'unsure'
      if (dashColumn < 0) dashColumn = item[1]!.length
      else if (item[1]!.length !== dashColumn) return 'unsure'
      const value = readValue(trimBlanks(item[2] ?? ''))
      if (value?.kind !== 'scalar' && value?.kind !== 'empty') return 'unsure'
      continue
    }
    const entry = ENTRY.exec(body)
    if (!entry) return 'unsure'
    const key = entry[1] ?? entry[2] ?? entry[3]!
    if (key.length > MAX_KEY || /[ \t]#/.test(key) || keys.has(key)) return 'unsure'
    keys.add(key)
    const value = readValue(trimBlanks(entry[4] ?? ''))
    if (!value) return 'unsure'
    if (key === 'type') type = value.kind === 'scalar' ? value.text : null
    mode = value.kind === 'empty' ? 'list' : value.kind === 'block' ? 'text' : 'entries'
    dashColumn = -1
    textIndent = -1
  }
  return type === 'board' ? 'yes' : 'no'
}

/**
 * The first BOARD_HEAD_BYTES bytes of `text` as they would be on disk (UTF-8), decoded: what `inspect` reads from the file. A save is
 * judged by the same head the next read will see, so a long non-ASCII title cannot push the closing `---` out of the window the
 * check looks at after the write (the note would then save fine and never open again).
 */
function headOf(text: string): { head: string; truncated: boolean } {
  // At most 4,096 characters can matter, whatever they weigh in bytes.
  const bytes = new TextEncoder().encode(text.slice(0, BOARD_HEAD_BYTES))
  return { head: new TextDecoder().decode(bytes.subarray(0, BOARD_HEAD_BYTES)), truncated: text.length > BOARD_HEAD_BYTES || bytes.length > BOARD_HEAD_BYTES }
}

/** What the grammar says of a whole note's text (its head as it would be read from disk): the verdict `board:save` and `board:open` would reach. */
export function boardNoteVerdict(text: string): HeadVerdict {
  const { head, truncated } = headOf(text)
  return judgeBoardHead(head, truncated)
}

/** A path as a short line for a message. */
function shown(p: string): string {
  return p.length > 120 ? `${p.slice(0, 117)}...` : p
}

const grouped = (n: number): string => n.toLocaleString('en-US')

/** Said of a note whose frontmatter is a board's but outside what main can read line by line (a nested mapping, a very long block ...). */
const unsureReason = (p: string): string =>
  `The board window cannot read the frontmatter of ${shown(p)} (it is longer than ${grouped(BOARD_HEAD_BYTES)} bytes or has more than plain \`key: value\` lines), so it cannot be opened there. Open this board in the app instead`

/** Said of a note that is longer than the window handles. `chars` is null when only its size in bytes is known (it cannot be that few characters). */
function tooLong(p: string, chars: number | null): string {
  const length = chars === null ? `over ${grouped(MAX_BOARD_TEXT)} characters` : `${grouped(chars)} characters`
  return `${shown(p)} is ${length} long; the board window opens notes of up to ${grouped(MAX_BOARD_TEXT)} characters (the text around the board counts too). It stays in the app`
}

type Inspected = { ok: true; abs: string } | { ok: false; reason: string }

/**
 * The note at `path` if it is a board note that is there: a text vault path of a `.md` file, inside the vault (the same refusals
 * the note writer gives: a path that leaves it, an excluded folder), a plain file (a link is refused: a write would replace the link
 * with a copy and the real note would not change), whose head says `type: board`. Never throws.
 */
async function inspect(path: unknown, vault: BoardVault | null): Promise<Inspected> {
  if (!vault) return { ok: false, reason: 'No vault is open' }
  if (typeof path !== 'string') return { ok: false, reason: 'The board path must be text' }
  if (!path.trim() || path.length > MAX_BOARD_PATH || path.includes('\0')) return { ok: false, reason: 'The board path is empty or too long' }
  if (!/\.md$/i.test(path)) return { ok: false, reason: `Only markdown notes can be boards: ${shown(path)}` }
  let abs: string
  try {
    abs = vault.abs(path)
  } catch {
    return { ok: false, reason: `Not a path inside the vault: ${shown(path)}` }
  }
  const st = await vault.stat(path)
  if (!st?.isFile) return { ok: false, reason: `There is no note at ${shown(path)}` }
  const link = await fs.lstat(abs).then(
    (l) => l.isSymbolicLink(),
    () => false,
  )
  if (link) return { ok: false, reason: `${shown(path)} is a link to a note: open the board it points to instead` }
  let head: Uint8Array
  try {
    head = await readHead(abs, BOARD_HEAD_BYTES)
  } catch {
    return { ok: false, reason: `The note could not be read: ${shown(path)}` }
  }
  const verdict = judgeBoardHead(new TextDecoder().decode(head), head.length >= BOARD_HEAD_BYTES)
  if (verdict === 'unsure') return { ok: false, reason: unsureReason(path) }
  if (verdict === 'no') return { ok: false, reason: `${shown(path)} is not a board note (it needs type: board in its frontmatter)` }
  return { ok: true, abs }
}

/** Why the note at `abs` is longer than the window can hold, or null when it fits. Reads the note only when its size does not settle it. */
async function lengthProblem(path: string, abs: string, vault: BoardVault): Promise<string | null> {
  // A character takes at most 4 bytes in UTF-8 and at least 1: the size settles every note but those in between.
  const size = await fs.stat(abs).then(
    (st) => st.size,
    () => -1,
  )
  if (size < 0 || size <= MAX_BOARD_TEXT) return null
  if (size > MAX_BOARD_TEXT * 4) return tooLong(path, null)
  const text = await vault.read(path)
  return text !== null && text.length > MAX_BOARD_TEXT ? tooLong(path, text.length) : null
}

/** Whether `path` is a board note that is there and short enough for the window (what `board:open` asks before it opens a window). */
export async function checkBoard(path: unknown, vault: BoardVault | null): Promise<BoardSaveResult> {
  const found = await inspect(path, vault)
  if (!found.ok || !vault) return found
  const problem = await lengthProblem(path as string, found.abs, vault)
  return problem ? { ok: false, reason: problem } : { ok: true }
}

/** What a save carries: the path, the new text, and the text it was made from (see `saveBoard`). */
export interface BoardSaveDto {
  path: unknown
  text: unknown
  expectedBase?: unknown
}

/** Judges a save without writing: the note it names must be a board note that is there, and the text must be a board note of a size the window handles. */
async function validate(dto: BoardSaveDto, vault: BoardVault | null): Promise<Inspected> {
  const found = await inspect(dto.path, vault)
  if (!found.ok) return found
  if (typeof dto.text !== 'string') return { ok: false, reason: 'The board text must be text' }
  if (dto.text.length > MAX_BOARD_TEXT) return { ok: false, reason: `The board is longer than ${grouped(MAX_BOARD_TEXT)} characters` }
  // A page that lost the frontmatter would leave a note nobody can open as a board again.
  const verdict = boardNoteVerdict(dto.text)
  if (verdict === 'unsure') return { ok: false, reason: 'The text is a board note the board window could not read again (its frontmatter has more than plain `key: value` lines, or is long), so it was not saved' }
  if (verdict === 'no') return { ok: false, reason: 'The text is not a board note (type: board is missing from its frontmatter)' }
  return found
}

/**
 * A save as the floating window sent it: the path of a board note that is already there, and the new text (at most 1,000,000
 * characters, and itself a board note). Creating a board is the docked view's job, through the store; this only overwrites.
 */
export async function validateBoardSave(dto: BoardSaveDto, vault: BoardVault | null): Promise<BoardSaveResult> {
  const found = await validate(dto, vault)
  return found.ok ? { ok: true } : found
}

/** Why a write failed, in words for the window (an absolute path in an fs message stays out). */
function writeFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'The board file cannot be written (permission denied or read-only)'
  if (code === 'ENOSPC') return 'The disk is full'
  const msg = err instanceof Error ? err.message : String(err)
  return `The board could not be written: ${msg.split('\n')[0]!.slice(0, 160)}`
}

/** Saves of one note run one after the other (two windows, or a retry that overtakes a slow write, must not interleave their compare and their write). */
const lines = new Map<string, Promise<unknown>>()
function inLine<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (lines.get(key) ?? Promise.resolve()).then(job, job)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  lines.set(key, tail)
  void tail.then(() => {
    if (lines.get(key) === tail) lines.delete(key)
  })
  return run
}

const CHANGED_OUTSIDE = 'The board was changed outside this window: it has been left as it is. Reload to see the change.'

/**
 * `board:save`: validate, compare, then write with the vault's atomic write, all in this one call. `expectedBase` is the text the new
 * text was made from: when the note on disk is neither that nor already the new text (a retry whose answer was lost), the save is
 * refused with `changed` and nothing is written; the page asks again after it has read the note. Without `expectedBase` the note is
 * overwritten. The watcher is NOT told that this write was ours (`noteSelfWrite`), on purpose: it then reports the change like any
 * edit made outside the app, and the brain window rebuilds its graph (the board's links to its pictures) from it. The note writer of
 * the brain window does the opposite, because it already knows what it wrote.
 */
export async function saveBoard(dto: BoardSaveDto, vault: BoardVault | null): Promise<BoardSaveResult> {
  const found = await validate(dto, vault)
  if (!found.ok || !vault) return found
  const { expectedBase } = dto
  if (expectedBase !== undefined && typeof expectedBase !== 'string') return { ok: false, reason: 'The text the save was made from must be text' }
  const path = dto.path as string
  const text = dto.text as string
  return inLine(found.abs, async (): Promise<BoardSaveResult> => {
    if (expectedBase !== undefined) {
      const current = await vault.read(path)
      if (current === null) return { ok: false, reason: 'The board note is gone, or is no longer a board: nothing was saved' }
      // Already what is being saved: an earlier try got through and its answer did not come back.
      if (current === text) return { ok: true }
      if (current !== expectedBase) return { ok: false, reason: CHANGED_OUTSIDE, changed: true }
    }
    try {
      await vault.write(path, text)
    } catch (err) {
      return { ok: false, reason: writeFailure(err) }
    }
    return { ok: true }
  })
}

/**
 * `board:read`: the text of a board note for the floating window, or null when the path is not a board note that is there. Rejects
 * with the reason when the note is too long for the window to hold (`board:open` refuses those before a window exists, so this is a
 * note that grew since): that is neither a missing note nor a note that is no board.
 */
export async function readBoard(path: unknown, vault: BoardVault | null): Promise<string | null> {
  const found = await inspect(path, vault)
  if (!found.ok || !vault) return null
  // A character takes at most 4 bytes in UTF-8: a bigger file cannot be a short enough text, and is not read.
  const size = await fs.stat(found.abs).then(
    (st) => st.size,
    () => -1,
  )
  if (size < 0) return null
  if (size > MAX_BOARD_TEXT * 4) throw new Error(tooLong(path as string, null))
  const text = await vault.read(path as string)
  if (text === null) return null
  if (text.length > MAX_BOARD_TEXT) throw new Error(tooLong(path as string, text.length))
  return text
}
