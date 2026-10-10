/**
 * The checks behind the reference board's floating window saving and reading its note (`board:save`, `board:read`, and the check
 * `board:open` makes). The window is a second page with the whole bridge, but it exists to edit a board: it may overwrite a board
 * note that is already there, never create a note, never touch a note that is not a board, and never write more than a board can
 * hold. Pure Node (no electron import), tested against a temp vault.
 *
 * Main cannot import @aether/core at runtime (tsc compiles it as plain Node ESM, the package is TypeScript source), so "is this a
 * board" is a small local check of the note's head. `isBoardHead` follows `isBoardNote` of core: the test pins the two to each other.
 */
import { promises as fs } from 'node:fs'
import { readHead } from './assets.js'
import type { BoardSaveResult } from '../shared/ipc.js'

/** The most characters one board note may hold in a save (the editor goes read-only at 400,000; a board note stays far under it). */
export const MAX_BOARD_TEXT = 400_000
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
const TYPE_LINE = /^type:/
// YAML wants a space after the colon and one before a comment: `type:board` is a key of its own and `board#x` a different word, neither of
// which core's `isBoardNote` reads as a board.
const TYPE_BOARD = /^type:[ \t]+(?:board|"board"|'board')(?:[ \t]+#.*)?[ \t]*$/

/** The key of a top-level `key: value` line (column 0, not a comment, list item or flow), or null. */
function topLevelKey(line: string): string | null {
  const m = /^([^\s#\-?:{}[\],&*!|>'"%@`][^:]*?|"[^"]*"|'[^']*')[ \t]*:(?:[ \t]|$)/.exec(line)
  return m ? m[1]!.replace(/^["']|["']$/g, '') : null
}

/**
 * Whether the head of a note is a frontmatter block with `type: board` at its top level: a `---` line first (a byte-order mark may
 * come before it), a closing `---` line, and exactly one `type:` key at column 0 whose value is board (plain or quoted, a trailing
 * comment allowed). A block that is not closed within the head, a nested or repeated `type` and `Board` are not; neither is a block
 * that repeats any other key, which YAML refuses as a whole (core then reads the note as an ordinary one, and so does this).
 * Main cannot run core's YAML parser, so this is a check of lines: it may say no where core says yes (a flow mapping, a tag on
 * the value), and it is tested never to say yes where core says no for a block core can read.
 */
export function isBoardHead(head: string): boolean {
  const open = FM_OPEN.exec(head)
  if (!open) return false
  const rest = head.slice(open[0].length)
  const close = FM_CLOSE_EMPTY.exec(rest) ?? FM_CLOSE.exec(rest)
  if (!close) return false
  const lines = rest
    .slice(0, close.index)
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
  const keys = new Set<string>()
  for (const line of lines) {
    const key = topLevelKey(line)
    if (key === null) continue
    if (keys.has(key)) return false
    keys.add(key)
  }
  const types = lines.filter((l) => TYPE_LINE.test(l))
  return types.length === 1 && TYPE_BOARD.test(types[0]!)
}

/**
 * The first BOARD_HEAD_BYTES bytes of `text` as they would be on disk (UTF-8), decoded: what `inspect` reads from the file. A save is
 * judged by the same head the next read will see, so a long non-ASCII title cannot push the closing `---` out of the window the
 * check looks at after the write (the note would then save fine and never open again).
 */
function headOf(text: string): string {
  // At most 4,096 characters can matter, whatever they weigh in bytes.
  return new TextDecoder().decode(new TextEncoder().encode(text.slice(0, BOARD_HEAD_BYTES)).subarray(0, BOARD_HEAD_BYTES))
}

/** A path as a short line for a message. */
function shown(p: string): string {
  return p.length > 120 ? `${p.slice(0, 117)}...` : p
}

type Inspected = { ok: true; abs: string } | { ok: false; reason: string }

/**
 * The note at `path` if it is a board note that is there: a text vault path of a `.md` file, inside the vault (the same refusals
 * the note writer gives: a path that leaves it, an excluded folder), a plain file, whose head says `type: board`. Never throws.
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
  let head: string
  try {
    head = new TextDecoder().decode(await readHead(abs, BOARD_HEAD_BYTES))
  } catch {
    return { ok: false, reason: `The note could not be read: ${shown(path)}` }
  }
  if (!isBoardHead(head)) return { ok: false, reason: `${shown(path)} is not a board note (it needs type: board in its frontmatter)` }
  return { ok: true, abs }
}

/** Whether `path` is a board note that is there (what `board:open` asks before it opens a window). */
export async function checkBoard(path: unknown, vault: BoardVault | null): Promise<BoardSaveResult> {
  const found = await inspect(path, vault)
  return found.ok ? { ok: true } : found
}

/**
 * A save as the floating window sent it: the path of a board note that is already there, and the new text (at most 400,000
 * characters, and itself a board note). Creating a board is the docked view's job, through the store; this only overwrites.
 */
export async function validateBoardSave(dto: { path: unknown; text: unknown }, vault: BoardVault | null): Promise<BoardSaveResult> {
  const found = await inspect(dto.path, vault)
  if (!found.ok) return found
  if (typeof dto.text !== 'string') return { ok: false, reason: 'The board text must be text' }
  if (dto.text.length > MAX_BOARD_TEXT) return { ok: false, reason: `The board is longer than ${MAX_BOARD_TEXT.toLocaleString('en-US')} characters` }
  // A page that lost the frontmatter would leave a note nobody can open as a board again.
  if (!isBoardHead(headOf(dto.text))) return { ok: false, reason: 'The text is not a board note (type: board is missing from its frontmatter)' }
  return { ok: true }
}

/** Why a write failed, in words for the window (an absolute path in an fs message stays out). */
function writeFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'The board file cannot be written (permission denied or read-only)'
  if (code === 'ENOSPC') return 'The disk is full'
  const msg = err instanceof Error ? err.message : String(err)
  return `The board could not be written: ${msg.split('\n')[0]!.slice(0, 160)}`
}

/**
 * `board:save`: validate, then write with the vault's atomic write. The watcher is NOT told that this write was ours
 * (`noteSelfWrite`), on purpose: it then reports the change like any edit made outside the app, and the brain window rebuilds its
 * graph (the board's links to its pictures) from it. The note writer of the brain window does the opposite, because it already
 * knows what it wrote.
 */
export async function saveBoard(dto: { path: unknown; text: unknown }, vault: BoardVault | null): Promise<BoardSaveResult> {
  const check = await validateBoardSave(dto, vault)
  if (!check.ok || !vault) return check
  try {
    await vault.write(dto.path as string, dto.text as string)
  } catch (err) {
    return { ok: false, reason: writeFailure(err) }
  }
  return { ok: true }
}

/**
 * `board:read`: the text of a board note for the floating window, or null when the path is not a board note that is there, or it
 * is too long for the window to save back (more than MAX_BOARD_TEXT characters: the file is not read at all when its size cannot
 * fit, whatever its encoding).
 */
export async function readBoard(path: unknown, vault: BoardVault | null): Promise<string | null> {
  const found = await inspect(path, vault)
  if (!found.ok || !vault) return null
  // A character takes at most 4 bytes in UTF-8: a bigger file cannot be a short enough text, and is not read.
  const size = await fs.stat(found.abs).then(
    (st) => st.size,
    () => -1,
  )
  if (size < 0 || size > MAX_BOARD_TEXT * 4) return null
  const text = await vault.read(path as string)
  return text !== null && text.length <= MAX_BOARD_TEXT ? text : null
}
