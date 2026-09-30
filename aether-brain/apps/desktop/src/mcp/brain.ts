/**
 * The vault as the AI link sees it: every note parsed and indexed in memory,
 * kept current from disk (its own watcher, or the changes a host forwards),
 * with a small set of safe operations on top — resolve a note by id, path or
 * title; read, search and browse; write notes, tasks, projects and folders.
 *
 * Safety rules, enforced here and not only by the tool layer:
 *  - every write goes through FsVault (path jail, excluded folders, atomic);
 *  - only `.md` notes are ever written, and a new note never overwrites an
 *    existing file: it is created with FsVault.create, which fails with
 *    EEXIST when anything is at the path (a note the index has not seen yet,
 *    repo boilerplate, a case variant), and the next name (` 2`, ` 3`) is tried;
 *  - nothing here deletes a note file;
 *  - a read-only brain refuses every write.
 * Markdown is changed only through the core helpers (tasks, projects,
 * frontmatter, templates), so files stay byte-identical outside the edit.
 * Text from an AI is only scanned in linear time (no backtracking regex on a
 * whole line): one crafted argument must not freeze the process it runs in.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  LinkResolver,
  SearchIndex,
  addTask,
  applyChanges,
  areaFromFolder,
  basenameOf,
  blankNote,
  buildGraph,
  dailyBrief,
  defaultProjectFolder,
  deleteTask,
  editTask,
  extractTasks,
  folderOf,
  folderProjectNote,
  homePrefix,
  idFromPath,
  inboxNote,
  isExistsError,
  isIgnoredPath,
  isImagePath,
  isProjectNote,
  joinFrontmatter,
  loadVault,
  normalizeFolderPath,
  normalizePath,
  normalizeTag,
  parseWikilinkRaw,
  portableFolderRef,
  projectFolderOf,
  projectNote,
  projectSummary,
  setProjectFields,
  setTaskDone,
  slugifyTitle,
  splitFrontmatter,
  taskProgress,
  tasksOf,
  todayIso,
  tokenizeWikilinks,
  updateFrontmatter,
} from '@aether/core'
import type {
  BriefReason,
  BriefTask,
  GraphData,
  NoteId,
  NoteType,
  ParsedNote,
  ProjectPatch,
  TaskItem,
  VaultAdapter,
  VaultChange,
  VaultFile,
  VaultRootInfo,
} from '@aether/core'
import { FsVault } from '../main/fsvault.js'
import { VaultWatcher } from '../main/watcher.js'
import type { VaultChangeDto } from '../shared/ipc.js'

/** Files + folders a host already read, so the brain skips its own scan. */
export interface BrainPreload {
  files: { path: string; content: string; mtime: number }[]
  folders: string[]
}

export interface BrainOptions {
  /** Absolute folders on disk; several roots make a multi-root vault (`D/…`, `F/…`). */
  roots: string[]
  /** Extra folder names to skip, on top of FsVault's built-in list. */
  exclude?: string[]
  /** Refuse every write. */
  readOnly?: boolean
  /** Run its own recursive fs.watch (default true). The in-app link passes false and feeds changes itself. */
  watch?: boolean
  /** Skip the initial scan by handing over what the host already read. */
  preload?: BrainPreload
}

/** A note as results name it. */
export interface NoteRef {
  id: NoteId
  title: string
  path: string
}

/** A to-do line of a note. `line` is the 0-based line index in the file. */
export interface TaskInfo {
  line: number
  text: string
  done: boolean
  doneAt: string | null
  section: string
}

/** Which task of a note: its line (from get_project / read_note), its text, or both. */
export interface TaskSelector {
  line?: number
  task?: string
}

/** A folder in a list_folder tree. `kind` follows the solar system: root, mount (a drive), project (a star), folder (a planet or moon). */
export interface FolderNode {
  name: string
  path: string
  kind: 'root' | 'mount' | 'project' | 'folder'
  /** Title of the project bound to this folder (its star note). */
  project?: string
  /** Notes directly inside. */
  notes: number
  /** Notes anywhere below. */
  total: number
  /** Direct subfolders on disk. */
  folders: number
  children?: FolderNode[]
  /** Subfolders not listed (depth or size limit). */
  more?: number
}

/** One task of the daily brief, as daily_brief lists it. */
export interface BriefRow {
  /** The task without its date markers. */
  task: string
  /** The task as written (what set_task_done's `task` matches). */
  text: string
  /** Title of the note it is in. */
  note: string
  /** Vault path of that note (set_task_done's `project`). */
  path: string
  /** 0-based line of the task in the note (set_task_done's `line`). */
  line: number
  /** The project it belongs to (the note itself, or the project whose folder holds it). */
  project: string | null
  due: string | null
  scheduled: string | null
  reason: BriefReason
}

export interface ProjectBrief extends NoteRef {
  status: string | null
  /** Home folder (vault path): the star; its subfolders are the planets. */
  folder: string | null
  folderExists: boolean
  /** `done/total` tasks. */
  progress: string
  next: string[]
  summary: string
  tags: string[]
  updated: string | null
}

/** Characters of note text returned by read_note / fetch before truncating. */
const MAX_TEXT = 60_000
/** Changes queued by applyExternal before they are applied eagerly. */
const MAX_PENDING = 2000
/** Folder entries in one list_folder answer. */
const MAX_TREE = 400

/** Tasks listed after a task is added or deleted (lines below it moved). */
const MAX_TASK_LIST = 100
/** Tasks an error that names the note's tasks lists. */
const MAX_ERROR_TASKS = 25
/** Tasks read_note lists. */
const MAX_NOTE_TASKS = 200
/** Tasks get_project lists. */
const MAX_PROJECT_TASKS = 300
/** Notes whose listed task lines are remembered (see TaskView). */
const MAX_VIEWS = 500
/** Listings remembered per note, newest first: a short reply must not hide what a longer one showed. */
const VIEWS_PER_NOTE = 4
/** Occurrences of edit_note's old_text counted at most (only "exactly once" matters). */
const MAX_OCCURRENCES = 50

const FENCE_RE = /^\s*(```|~~~)/
const LIST_RE = /^\s*([-*+]|\d+[.)])\s/
const DONE_STATUS = /^(done|complete|completed|finished|shipped|archived|cancel+ed|dropped|abandoned)$/i
const ACTIVE_STATUS = /^(active|doing|in[ -]?progress|wip|current|now)$/i
/** Names Windows keeps for devices, alone or with an extension (`CON`, `aux.md`): never a file or folder of the vault. */
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])\s*(\.|$)/i
/** Characters Windows refuses in a file or folder name (`:` would even write an NTFS alternate stream). */
const WIN_BAD_CHARS = /[<>:"|?*\u0000-\u001f]/

interface Derived {
  /** Lowercased id → ids (case variants). */
  byId: Map<string, NoteId[]>
  /** Lowercased title or alias → ids. */
  byName: Map<string, NoteId[]>
  /** Lowercased file name → ids. */
  byBase: Map<string, NoteId[]>
  /** Folder → notes directly inside, sorted by title. */
  notesIn: Map<string, NoteId[]>
  /** Folder → notes anywhere below ('' included). */
  totals: Map<string, number>
  /** Folder → direct subfolders, sorted ('' = the vault root). */
  children: Map<string, string[]>
  /** Lowercased folder → folders. */
  foldersLower: Map<string, string[]>
  /** Lowercased last segment (folder name) → folders. */
  foldersNamed: Map<string, string[]>
  /** Project notes. */
  projects: ParsedNote[]
  /** Project → its home folder (may not exist yet). */
  homeOf: Map<NoteId, string | null>
  /** Existing home folder → the project bound to it (one per folder). */
  projectAt: Map<string, NoteId>
  resolver: LinkResolver
}

/** The tables of Derived that depend on the folder set only (rebuilt when it changes, not per note edit). */
interface FolderTables {
  /** The folder set they were built from (applyChanges keeps its identity when a batch has no folder change). */
  of: Set<string>
  children: Map<string, string[]>
  foldersLower: Map<string, string[]>
  foldersNamed: Map<string, string[]>
}

/**
 * The task lines one reply listed for a note: the lines an AI's `line`
 * numbers count in. When the note changed since (an edit in the app, in
 * another editor, by another client, or a task added above by the AI itself
 * with a reply too short to list this one again), a line-only task call is
 * mapped onto the note as it is now instead of acting on whatever sits there.
 */
interface TaskView {
  /** Hash of the note text the lines were counted in. */
  hash: string
  /** Listed task line → what was on it. Only the tasks the reply listed. */
  tasks: Map<number, ShownTask>
}

/** A listed task line as the listing showed it. */
interface ShownTask {
  /** The line's text (without `\r`). */
  line: string
  /** Which of the note's task lines with that text it was (0 = the first). */
  nth: number
  /** The task's text. */
  text: string
}

/** A task pick that failed; `shown` are the tasks its message lists (their lines count in the note as it is now). */
class TaskPickError extends Error {
  constructor(
    message: string,
    readonly shown: readonly TaskItem[],
  ) {
    super(message)
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** Lowercased, whitespace-collapsed text for name matching. */
function nameKey(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

function lastSegment(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function inFolder(noteFolder: string, folder: string): boolean {
  return folder === '' || noteFolder === folder || noteFolder.startsWith(`${folder}/`)
}

/** Tags from an AI: a list or one comma/space separated string, normalized like frontmatter tags. */
function cleanTags(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map((x) => String(x)) : typeof v === 'string' ? v.split(/[,\s]+/) : []
  return [...new Set(list.map(normalizeTag).filter(Boolean))]
}

/** One line of task text: no line breaks, no checkbox prefix. */
function cleanTaskText(text: string): string {
  // Split and trim, not `/\s*[\r\n]+\s*/g`: that backtracks quadratically on a long run of spaces.
  const one = text
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ')
  return one.replace(/^[-*+]\s+\[[ xX]\]\s*/, '').trim()
}

/** One whitespace character, as `\s` and `String.prototype.trim` define it. */
function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && ch.trim() === ''
}

/**
 * An ATX heading (`## Notes`): its level and trimmed text, or null. A closing
 * `#` run only counts after whitespace (`## Learn C#` keeps its `#`). By hand:
 * the regex `/^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/` backtracks quadratically on a
 * long run of spaces, and note text can come from an AI.
 */
function headingOf(line: string): { level: number; text: string } | null {
  let level = 0
  while (line[level] === '#') level++
  if (level === 0 || level > 6 || !isSpace(line[level])) return null
  let text = line.slice(level).trim()
  let end = text.length
  while (end > 0 && text[end - 1] === '#') end--
  if (end < text.length && end > 0 && isSpace(text[end - 1])) text = text.slice(0, end).trimEnd()
  return { level, text }
}

/** A line without its trailing `\r`. */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** Short fingerprint of a note's text (to tell whether it changed). */
function hashText(raw: string): string {
  return createHash('sha1').update(raw).digest('base64')
}

function taskInfo(t: TaskItem): TaskInfo {
  return { line: t.line, text: t.text, done: t.done, doneAt: t.doneAt, section: t.section }
}

/**
 * Start indexes of `needle` in `hay`, overlapping ones included (so "exactly
 * once" is strict), up to `max` of them: a periodic needle in a periodic note
 * has as many overlapping matches as characters, and only 0, 1 or "more" matter.
 */
function occurrences(hay: string, needle: string, max = MAX_OCCURRENCES): number[] {
  const out: number[] = []
  for (let i = hay.indexOf(needle); i >= 0 && out.length < max; i = hay.indexOf(needle, i + 1)) out.push(i)
  return out
}

/**
 * A frontmatter block whose YAML did not parse into keys. Rewriting it
 * through updateFrontmatter would silently drop that text, so writes refuse.
 */
function brokenFrontmatter(raw: string): boolean {
  const split = splitFrontmatter(raw)
  if (!split.hasFrontmatter || Object.keys(split.frontmatter).length > 0) return false
  const block = raw.slice(0, split.bodyOffset).split(/\r?\n/).slice(1)
  // Blank, comment, `---` or `...` lines hold nothing. Trim, not `/^\s*(…)?\s*$/`: two
  // adjacent `\s*` backtrack quadratically on a long run of spaces.
  return block.some((l) => {
    const t = l.trim()
    return t !== '' && !t.startsWith('#') && t !== '---' && t !== '...'
  })
}

/**
 * updateFrontmatter that keeps what it would otherwise change outside the
 * keys: a byte-order mark stays first in the file (not in front of the H1,
 * where it would break the heading) and a CRLF file keeps CRLF in the
 * rewritten block.
 */
function patchFrontmatter(raw: string, patch: Record<string, unknown>): string {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
  const plain = raw.slice(bom.length)
  const next = updateFrontmatter(plain, patch)
  const split = splitFrontmatter(plain)
  const crlf = (split.hasFrontmatter ? plain.slice(0, split.bodyOffset) : plain).includes('\r\n')
  // updateFrontmatter keeps the body minus its leading blank lines.
  const body = split.body.replace(/^\s*\n/, '')
  if (!crlf || !next.endsWith(body)) return bom + next
  return bom + next.slice(0, next.length - body.length).replace(/\r?\n/g, '\r\n') + body
}

/**
 * Why a new folder name would break on Windows (a vault on D:\ is a Windows
 * folder), or null when it is fine there.
 */
function unsafeFolderName(seg: string): string | null {
  if (WIN_BAD_CHARS.test(seg)) return `A folder name cannot contain < > : " | ? * or control characters: "${seg}"`
  if (/[. ]$/.test(seg)) return `A folder name cannot end in a dot or a space: "${seg}"`
  if (WIN_RESERVED.test(seg)) return `"${seg}" is a device name on Windows; pick another folder name`
  return null
}

/** File name (without .md) for a new note titled `title`: path-safe, never hidden (`.env` → `env`). */
function noteBase(title: string): string {
  return slugifyTitle(title).replace(/^[.$\s]+/, '')
}

/**
 * Touch `updated:` like the app does when a note tracks it. A plain one-line
 * value is replaced in place so the rest of the frontmatter keeps its bytes;
 * anything fancier goes through updateFrontmatter.
 */
function touchUpdated(raw: string, today = todayIso()): string {
  const split = splitFrontmatter(raw)
  if (!split.hasFrontmatter || !Object.hasOwn(split.frontmatter, 'updated')) return raw
  if (split.frontmatter['updated'] === today) return raw
  const lines = raw.slice(0, split.bodyOffset).split('\n')
  const i = lines.findIndex((l) => l.startsWith('updated:'))
  const line = i >= 0 ? stripCr(lines[i] ?? '') : ''
  // A value that goes on below (a block list, a plain scalar continued on an indented line) is not one line.
  const below = i >= 0 ? stripCr(lines[i + 1] ?? '') : ''
  const goesOn = /^[ \t]/.test(below) || below === '-' || below.startsWith('- ')
  const value = i >= 0 && !goesOn ? replaceScalar(line.slice('updated:'.length), today) : null
  if (value === null) return patchFrontmatter(raw, { updated: today })
  lines[i] = `updated:${value}${(lines[i] ?? '').endsWith('\r') ? '\r' : ''}`
  return lines.join('\n') + raw.slice(split.bodyOffset)
}

/**
 * The rest of a `key:` line (` "2026-01-02"  # note`) with its value replaced
 * by `value`, spacing and comment kept; null when the value is not one plain
 * or quoted scalar on this line (a block scalar, a list, escapes). By hand, in
 * one pass: the equivalent regex backtracks quadratically on long space runs.
 */
function replaceScalar(rest: string, value: string): string | null {
  let start = 0
  while (rest[start] === ' ' || rest[start] === '\t') start++
  const first = rest[start]
  let end: number
  if (first === '"' || first === "'") {
    const close = rest.indexOf(first, start + 1)
    if (close < 0) return null
    end = close + 1
  } else {
    // A plain scalar runs to a comment (`#` after whitespace) or the end, minus trailing spaces.
    end = rest.length
    for (let k = start; k < rest.length; k++) {
      if (rest[k] === '#' && (k === start || rest[k - 1] === ' ' || rest[k - 1] === '\t')) {
        end = k
        break
      }
    }
    while (end > start && (rest[end - 1] === ' ' || rest[end - 1] === '\t')) end--
    if (end > start && first !== undefined && '|>[{&*!%@`'.includes(first)) return null
  }
  // Nothing on the line: the value (if any) is a block below it.
  if (end === start) return null
  // `updated:2026` is not a YAML key at all: leave such a line to the full rewrite.
  if (start === 0) return null
  const tail = rest.slice(end)
  const after = tail.trimStart()
  if (after !== '' && !after.startsWith('#')) return null
  return `${rest.slice(0, start) || ' '}${value}${tail.startsWith('#') ? ` ${tail}` : tail}`
}

/** Insert lines at `at`; appended after a last line without an ending, that line gets the ending instead. */
function insertLines(lines: string[], at: number, add: string[], cr: string): void {
  if (at < lines.length) {
    lines.splice(at, 0, ...add.map((l) => l + cr))
    return
  }
  const last = lines.length - 1
  if (last >= 0 && cr && !(lines[last] ?? '').endsWith('\r')) lines[last] = (lines[last] ?? '') + cr
  lines.push(...add.map((l, i) => (i === add.length - 1 ? l : l + cr)))
}

/**
 * Append `text` to the end of a note, or to the end of the section under
 * `heading` (matched case-insensitively, any level; a `## heading` is added at
 * the end when missing). A blank line separates it from what precedes, except
 * list items following list items. Untouched lines stay byte-identical.
 */
export function appendText(raw: string, text: string, heading?: string): string {
  const add = text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd()
  if (!add) return raw
  const addLines = add.split('\n')
  const cr = raw.includes('\r\n') ? '\r' : ''
  const lines = raw.split('\n')
  const plain = lines.map((l) => l.replace(/\r$/, ''))
  let start = -1
  let end = plain.length
  const want = heading?.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim() ?? ''
  if (want) {
    let depth = 0
    let fence = false
    // Headings live in the body: a `# comment` in the YAML frontmatter is not one.
    const bodyLine = raw.slice(0, splitFrontmatter(raw).bodyOffset).split('\n').length - 1
    for (let i = bodyLine; i < plain.length; i++) {
      const l = plain[i] ?? ''
      if (FENCE_RE.test(l)) fence = !fence
      if (fence || FENCE_RE.test(l)) continue
      const h = headingOf(l)
      if (!h) continue
      const level = h.level
      if (start < 0) {
        if (nameKey(h.text) === nameKey(want)) {
          start = i
          depth = level
        }
      } else if (level <= depth) {
        end = i
        break
      }
    }
    if (start < 0) {
      // No such section: a new one at the end of the note.
      let last = plain.length - 1
      while (last >= 0 && (plain[last] ?? '').trim() === '') last--
      const block = [...(last >= 0 ? [''] : []), `## ${want}`, '', ...addLines]
      insertLines(lines, last + 1, block, cr)
      return lines.join('\n')
    }
  }
  let last = end - 1
  while (last > start && (plain[last] ?? '').trim() === '') last--
  const at = last + 1
  const prev = last >= 0 ? (plain[last] ?? '') : ''
  const tight = last > start && LIST_RE.test(prev) && LIST_RE.test(addLines[0] ?? '')
  const block = [...(last >= 0 && !tight ? [''] : []), ...addLines]
  // Keep a blank line before the next heading.
  if (end < plain.length && at === end) block.push('')
  insertLines(lines, at, block, cr)
  return lines.join('\n')
}

/**
 * The core's view of a vault that was already read from disk: loadVault
 * lists it; the write methods go straight to FsVault (the jail).
 */
class SnapshotAdapter implements VaultAdapter {
  readonly kind = 'electron' as const
  readonly name: string
  readonly location: string
  readonly readOnly: boolean

  constructor(
    private readonly vault: FsVault,
    readonly roots: VaultRootInfo[],
    private readonly files: VaultFile[],
    private readonly folderList: string[],
    readOnly: boolean,
  ) {
    this.name = roots.map((r) => r.label).join(' + ')
    this.location = roots[0]?.path ?? ''
    this.readOnly = readOnly
  }

  async list(): Promise<VaultFile[]> {
    return this.files
  }

  async listFolders(): Promise<string[]> {
    return this.folderList
  }

  read(p: string): Promise<string | null> {
    return this.vault.read(p)
  }

  write(p: string, content: string): Promise<void> {
    return this.vault.write(p, content)
  }

  create(p: string, content: string): Promise<void> {
    return this.vault.create(p, content)
  }

  remove(p: string): Promise<void> {
    return this.vault.remove(p)
  }

  rename(from: string, to: string): Promise<void> {
    return this.vault.rename(from, to)
  }

  createFolder(p: string): Promise<void> {
    return this.vault.mkdir(p)
  }

  watch(): () => void {
    return () => undefined
  }
}

/**
 * The vault behind the MCP tools. `Brain.open` resolves once every note is
 * indexed; `Brain.start` returns at once and loads in the background (every
 * operation waits for the load), so an MCP client can finish its handshake
 * while a whole drive is being scanned.
 */
export class Brain {
  readonly vault: FsVault
  readonly readOnly: boolean
  /** Roots in the core's shape (path, mount, label). */
  readonly roots: VaultRootInfo[]
  /** Where new notes go: '' for a single root, `<first mount>/` for several. */
  readonly home: string
  private notes = new Map<NoteId, ParsedNote>()
  private graph: GraphData = buildGraph(new Map())
  private readonly index = new SearchIndex()
  private folders = new Set<string>()
  /** Changes not applied yet: applied in one batch (one graph rebuild) when a tool needs the data. */
  private pending: VaultChange[] = []
  private derived: Derived | null = null
  /** Folder-only tables, kept across note edits (see FolderTables). */
  private folderTables: FolderTables | null = null
  /** Note path → the task lines replies listed for it, newest listing first (see TaskView). */
  private views = new Map<string, TaskView[]>()
  private watcher: VaultWatcher | null = null
  private loaded = false
  private closed = false
  private readonly loading: Promise<void>
  /** Writes run one at a time, each on the latest state (parallel tool calls must not lose edits). */
  private lock: Promise<unknown> = Promise.resolve()

  private constructor(private readonly opts: BrainOptions) {
    // No tool offers pictures: the scan need not list them (a whole drive can hold hundreds of thousands).
    this.vault = new FsVault(opts.roots, { exclude: opts.exclude ?? [], maxAssets: 0 })
    this.readOnly = opts.readOnly === true
    this.roots = this.vault.roots.map((r) => ({ path: r.abs, mount: r.mount, label: r.label }))
    this.home = homePrefix(this.roots)
    this.loading = this.load()
    // Surfaced through ready() and every operation; never an unhandled rejection.
    this.loading.catch(() => undefined)
  }

  /** Open a vault and wait until every note is read and indexed. */
  static async open(opts: BrainOptions): Promise<Brain> {
    const brain = new Brain(opts)
    try {
      await brain.ready()
    } catch (err) {
      brain.close()
      throw err
    }
    return brain
  }

  /** Open a vault and load it in the background (see `ready`). */
  static start(opts: BrainOptions): Brain {
    return new Brain(opts)
  }

  /** Resolves when the initial load is done; rejects when it failed. */
  ready(): Promise<void> {
    return this.loading
  }

  /** Note and folder counts (0 until loaded). */
  stats(): { notes: number; folders: number } {
    return { notes: this.notes.size, folders: this.folders.size }
  }

  /**
   * Apply file/folder changes observed elsewhere (the host's watcher).
   * Idempotent; applied lazily. Pictures are dropped: no tool offers them, and
   * a folder of renders arriving must not rebuild the index.
   */
  applyExternal(changes: VaultChangeDto[]): void {
    if (this.closed || !changes.length) return
    for (const c of changes) {
      if (c.kind !== 'addDir' && c.kind !== 'unlinkDir' && isImagePath(c.path)) continue
      this.pending.push(c)
    }
    if (this.loaded && this.pending.length > MAX_PENDING) this.sync()
  }

  /** Stop the watcher and drop the index. Later calls fail with a clear error. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.watcher?.stop()
    this.watcher = null
    this.pending = []
    this.notes = new Map()
    this.folders = new Set()
    this.derived = null
    this.folderTables = null
    this.views.clear()
    this.index.rebuild([])
  }

  /** file:// URL of a vault path (for citations). */
  url(vaultPath: string): string {
    return pathToFileURL(this.vault.abs(vaultPath)).href
  }

  /* -------------------------------------------------------------- */
  /* Reading                                                        */
  /* -------------------------------------------------------------- */

  /** Orientation: roots, counts, areas, top tags, hubs, top folders, projects, recent notes. */
  async overview() {
    const d = await this.state()
    const g = this.graph
    const tags = [...g.tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20)
    const hubs = g.nodes
      .filter((n) => n.kind === 'note' && n.degree > 0)
      .sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title))
      .slice(0, 10)
    const top = d.children.get('') ?? []
    return {
      roots: this.roots.map((r) => (this.vault.multi ? { label: r.label, path: r.path, folder: r.mount } : { label: r.label, path: r.path })),
      newNotesGoTo: `${this.home}Inbox`,
      readOnly: this.readOnly,
      notes: this.notes.size,
      folders: this.folders.size,
      links: g.edges.length,
      orphans: g.orphans.length,
      missingLinks: g.unresolved.size,
      areas: Object.fromEntries([...g.areaCounts].sort((a, b) => b[1] - a[1])),
      topTags: tags.map(([tag, count]) => ({ tag, count })),
      hubs: hubs.map((n) => ({ title: n.title, id: n.id, links: n.degree })),
      topFolders: top.slice(0, 40).map((f) => ({ path: f, notes: d.totals.get(f) ?? 0 })),
      moreFolders: Math.max(0, top.length - 40),
      projects: this.sortedProjects(d)
        .slice(0, 25)
        .map((n) => {
          const b = this.projectBrief(d, n)
          return { title: b.title, id: b.id, status: b.status, progress: b.progress, folder: b.folder }
        }),
      projectCount: d.projects.length,
      recent: this.recentList(5, null, null).map((r) => ({ title: r.title, id: r.id, updated: r.updated })),
    }
  }

  /** Full-text search (title, aliases, headings, tags, body, path), optionally within a folder or tag. */
  async searchNotes(query: string, opts: { limit?: number; folder?: string; tag?: string } = {}) {
    const d = await this.state()
    const limit = Math.max(1, Math.min(50, opts.limit ?? 10))
    let within: Set<NoteId> | null = null
    let folder: string | null = null
    if (opts.folder?.trim()) {
      folder = this.resolveFolder(d, opts.folder)
      const f = folder
      within = new Set([...this.notes.values()].filter((n) => inFolder(n.meta.folder, f)).map((n) => n.meta.id))
    }
    if (opts.tag?.trim()) {
      const tag = normalizeTag(opts.tag)
      const pool = [...(within ?? this.notes.keys())]
      within = new Set(pool.filter((id) => this.notes.get(id)?.meta.tags.includes(tag)))
    }
    const q = query.trim()
    let hits = this.index.search(q, { limit: limit + 1, within })
    const words = q.split(/\s+/).filter((w) => w.length > 1)
    if (!hits.length && words.length > 1) {
      // Every word must match by default; fall back to any word, best combined score first.
      const score = new Map<NoteId, (typeof hits)[number]>()
      for (const w of words) {
        for (const h of this.index.search(w, { limit: 50, within })) {
          const prev = score.get(h.id)
          score.set(h.id, prev ? { ...prev, score: prev.score + h.score } : h)
        }
      }
      hits = [...score.values()].sort((a, b) => b.score - a.score).slice(0, limit + 1)
    }
    const truncated = hits.length > limit
    return {
      folder,
      hits: hits.slice(0, limit).flatMap((h) => {
        const n = this.notes.get(h.id)
        if (!n) return []
        return [{ id: h.id, title: h.title, path: n.meta.path, tags: n.meta.tags, snippet: h.snippet, score: Math.round(h.score * 10) / 10 }]
      }),
      truncated,
    }
  }

  /** ChatGPT connector search: ids, titles and file URLs. */
  async find(query: string, limit = 10): Promise<{ id: string; title: string; url: string }[]> {
    const { hits } = await this.searchNotes(query, { limit })
    return hits.map((h) => ({ id: h.id, title: h.title, url: this.url(h.path) }))
  }

  /** ChatGPT connector fetch: the note's full markdown plus string metadata. */
  async fetch(ref: string) {
    const d = await this.state()
    const n = this.resolve(d, ref)
    const g = this.graph
    const text = n.raw.length > MAX_TEXT ? `${n.raw.slice(0, MAX_TEXT)}\n\n[… truncated: ${n.raw.length - MAX_TEXT} more characters]` : n.raw
    const titles = (ids: Iterable<NoteId>) =>
      [...ids]
        .map((id) => this.notes.get(id)?.meta.title)
        .filter((t): t is string => !!t)
        .slice(0, 30)
        .join(', ')
    const metadata: Record<string, string> = { path: n.meta.path, type: n.meta.type, area: n.meta.area }
    if (n.meta.tags.length) metadata['tags'] = n.meta.tags.join(', ')
    if (n.meta.status) metadata['status'] = n.meta.status
    if (n.meta.created) metadata['created'] = n.meta.created
    if (n.meta.updated) metadata['updated'] = n.meta.updated
    const links = titles(g.outlinks.get(n.meta.id) ?? [])
    const backlinks = titles(g.backlinks.get(n.meta.id) ?? [])
    if (links) metadata['links'] = links
    if (backlinks) metadata['backlinks'] = backlinks
    return { id: n.meta.id, title: n.meta.title, text, url: this.url(n.meta.path), metadata }
  }

  /** A note in full: frontmatter, markdown, links, backlinks and tasks. */
  async readNote(ref: string) {
    const d = await this.state()
    const n = this.resolve(d, ref)
    const g = this.graph
    const links: NoteRef[] = []
    const missing: string[] = []
    const seen = new Set<string>()
    for (const l of n.links) {
      if (seen.has(l.to)) continue
      seen.add(l.to)
      const target = l.resolved ? this.notes.get(l.to) : undefined
      if (target) links.push(this.ref(target))
      else if (!l.resolved && l.to) missing.push(l.to.replace(/^ghost:/, ''))
    }
    const backlinks = [...(g.backlinks.get(n.meta.id) ?? [])].flatMap((id) => {
      const b = this.notes.get(id)
      return b ? [this.ref(b)] : []
    })
    const truncated = n.raw.length > MAX_TEXT
    return {
      ...this.ref(n),
      url: this.url(n.meta.path),
      type: n.meta.type,
      area: n.meta.area,
      tags: n.meta.tags,
      status: n.meta.status,
      created: n.meta.created,
      updated: n.meta.updated,
      aliases: n.meta.aliases,
      ...(isProjectNote(n) ? { project: { folder: d.homeOf.get(n.meta.id) ?? null } } : {}),
      frontmatter: n.frontmatter,
      links: links.slice(0, 100),
      missingLinks: missing.slice(0, 50),
      backlinks: backlinks.slice(0, 100),
      backlinkCount: backlinks.length,
      tasks: this.showTasks(n.meta.path, n.raw, MAX_NOTE_TASKS).map(taskInfo),
      content: truncated ? n.raw.slice(0, MAX_TEXT) : n.raw,
      ...(truncated ? { truncated: `${n.raw.length - MAX_TEXT} more characters not shown` } : {}),
    }
  }

  /** A folder as a tree: subfolders (planets, moons) with counts, plus the notes directly inside. */
  async listFolder(ref?: string, depth = 1) {
    const d = await this.state()
    const root = ref?.trim() ? this.resolveFolder(d, ref) : ''
    const maxDepth = Math.max(1, Math.min(4, Math.floor(depth)))
    let budget = MAX_TREE
    const make = (f: string): FolderNode => {
      const kids = d.children.get(f) ?? []
      const pid = d.projectAt.get(f)
      const node: FolderNode = {
        name: this.folderName(f),
        path: f,
        kind: this.folderKind(d, f),
        notes: d.notesIn.get(f)?.length ?? 0,
        total: d.totals.get(f) ?? 0,
        folders: kids.length,
      }
      const title = pid ? this.notes.get(pid)?.meta.title : undefined
      if (title) node.project = title
      return node
    }
    const top = make(root)
    // Breadth-first so a size limit trims the deepest levels first.
    const queue: { node: FolderNode; level: number }[] = [{ node: top, level: 0 }]
    for (let head = 0; head < queue.length; head++) {
      const { node, level } = queue[head]!
      const kids = d.children.get(node.path) ?? []
      if (level >= maxDepth || !kids.length) continue
      const take = kids.slice(0, Math.max(0, budget))
      budget -= take.length
      if (take.length) node.children = take.map((k) => make(k))
      if (kids.length > take.length) node.more = kids.length - take.length
      for (const c of node.children ?? []) queue.push({ node: c, level: level + 1 })
    }
    const ids = d.notesIn.get(root) ?? []
    return {
      folder: top,
      notes: ids.slice(0, 100).flatMap((id) => {
        const n = this.notes.get(id)
        return n ? [{ title: n.meta.title, id }] : []
      }),
      moreNotes: Math.max(0, ids.length - 100),
    }
  }

  /** Every project: status, home folder, progress, next open tasks (active first, then recently updated). */
  async listProjects(opts: { status?: string; limit?: number } = {}) {
    const d = await this.state()
    const want = opts.status?.trim().toLowerCase()
    const list = this.sortedProjects(d).filter((n) => !want || (n.meta.status ?? '').toLowerCase() === want)
    const limit = Math.max(1, Math.min(100, opts.limit ?? 50))
    return { projects: list.slice(0, limit).map((n) => this.projectBrief(d, n)), total: list.length }
  }

  /** One project in detail: summary, every task with its line, planets (subfolders of its home folder), notes inside. */
  async getProject(ref: string) {
    const d = await this.state()
    const n = this.resolveProject(d, ref)
    const brief = this.projectBrief(d, n)
    const home = brief.folder && this.folders.has(brief.folder) ? brief.folder : null
    const planets = home
      ? (d.children.get(home) ?? []).map((f) => {
          const pid = d.projectAt.get(f)
          return {
            name: lastSegment(f),
            path: f,
            notes: d.totals.get(f) ?? 0,
            folders: d.children.get(f)?.length ?? 0,
            ...(pid ? { project: this.notes.get(pid)?.meta.title ?? pid } : {}),
          }
        })
      : []
    const inside = home
      ? [...this.notes.values()]
          .filter((x) => x.meta.id !== n.meta.id && inFolder(x.meta.folder, home))
          .sort((a, b) => a.meta.path.localeCompare(b.meta.path))
      : []
    return {
      ...brief,
      summary: projectSummary(n),
      tasks: this.showTasks(n.meta.path, n.raw, MAX_PROJECT_TASKS).map(taskInfo),
      planets: planets.slice(0, 100),
      notes: inside.slice(0, 60).map((x) => this.ref(x)),
      moreNotes: Math.max(0, inside.length - 60),
    }
  }

  /** Notes connected to a note: its links, its backlinks, and notes sharing its vocabulary. */
  async related(ref: string, limit = 10) {
    const d = await this.state()
    const n = this.resolve(d, ref)
    const g = this.graph
    const refs = (ids: Iterable<NoteId>) =>
      [...ids].flatMap((id) => {
        const x = this.notes.get(id)
        return x ? [this.ref(x)] : []
      })
    const out = refs(g.outlinks.get(n.meta.id) ?? [])
    const inn = refs(g.backlinks.get(n.meta.id) ?? [])
    const linked = new Set([n.meta.id, ...out.map((r) => r.id), ...inn.map((r) => r.id)])
    const max = Math.max(1, Math.min(30, limit))
    const similar = this.index
      .related(n, max + linked.size)
      .filter((h) => !linked.has(h.id))
      .slice(0, max)
      .flatMap((h) => {
        const x = this.notes.get(h.id)
        return x ? [{ ...this.ref(x), snippet: h.snippet }] : []
      })
    return { note: this.ref(n), linksTo: out.slice(0, 50), linkedFrom: inn.slice(0, 50), similar }
  }

  /**
   * The daily brief of `date` (default today, this computer's time), as the
   * app's Today hub shows it: overdue tasks, tasks due or scheduled that day,
   * in its daily note or tagged #today, and the next task of each active
   * project with nothing above. The rows' lines are remembered as a listing
   * of their notes, so set_task_done with a row's path and line finds its
   * task even after the note changed.
   */
  async dailyBrief(date?: string) {
    await this.state()
    const brief = dailyBrief(this.notes.values(), { date: date ?? todayIso(), folders: this.folders })
    const rows = [...brief.overdue, ...brief.today, ...brief.next]
    const lines = new Map<NoteId, Set<number>>()
    for (const t of rows) {
      const set = lines.get(t.noteId)
      if (set) set.add(t.line)
      else lines.set(t.noteId, new Set([t.line]))
    }
    for (const [id, want] of lines) {
      const n = this.notes.get(id)
      if (!n) continue
      const all = tasksOf(n)
      this.remember(n.meta.path, n.raw, all.filter((t) => want.has(t.line)), all)
    }
    const row = (t: BriefTask): BriefRow => ({
      task: t.label,
      text: t.text,
      note: t.noteTitle,
      path: t.notePath,
      line: t.line,
      project: t.projectTitle,
      due: t.due,
      scheduled: t.scheduled,
      reason: t.reason,
    })
    return {
      date: brief.date,
      total: brief.total,
      overdue: brief.overdue.map(row),
      today: brief.today.map(row),
      next: brief.next.map(row),
    }
  }

  /** Recently changed notes, newest first. */
  async recent(opts: { limit?: number; days?: number; folder?: string } = {}) {
    const d = await this.state()
    const folder = opts.folder?.trim() ? this.resolveFolder(d, opts.folder) : null
    const limit = Math.max(1, Math.min(100, opts.limit ?? 15))
    const days = opts.days && opts.days > 0 ? opts.days : null
    return { notes: this.recentList(limit, days, folder), folder, days }
  }

  /* -------------------------------------------------------------- */
  /* Writing                                                        */
  /* -------------------------------------------------------------- */

  /** A new note (never overwrites: an existing name gets ` 2`, ` 3`). Default folder: the Inbox. */
  createNote(input: { title: string; folder?: string; content?: string; tags?: string[]; type?: NoteType }) {
    return this.exclusive(async () => {
      const d = await this.state()
      const title = input.title.replace(/\s+/g, ' ').trim()
      const base = noteBase(title)
      if (!title || !base) throw new Error('Give the note a title with at least one letter or number')
      const dir = input.folder?.trim() ? this.targetFolder(d, input.folder) : this.canonical(d, `${this.home}Inbox`)
      let body = input.content ?? ''
      if (brokenFrontmatter(body)) throw new Error('The frontmatter (--- block) at the start of content is not valid YAML; fix it or leave it out')
      const { frontmatter } = splitFrontmatter(blankNote(title, dir).content)
      let extra: Record<string, unknown> = {}
      const split = splitFrontmatter(body)
      if (split.hasFrontmatter) {
        extra = split.frontmatter
        body = split.body
      }
      const fm: Record<string, unknown> = { ...frontmatter, ...extra, title }
      if (input.tags) fm['tags'] = cleanTags(input.tags)
      else if (Object.hasOwn(extra, 'tags')) fm['tags'] = cleanTags(extra['tags'])
      if (input.type) fm['type'] = input.type
      else if (!Object.hasOwn(extra, 'type') && areaFromFolder(`${dir}/x.md`) === 'inbox') fm['type'] = 'inbox'
      const text = body.replace(/^\s*\n/, '').trimEnd()
      const content = joinFrontmatter(fm, /^#\s/.test(text) ? `${text}\n` : `# ${title}\n\n${text ? `${text}\n` : ''}`)
      const note = await this.addNote(d, dir, base, content)
      return { ...this.ref(note), folder: note.meta.folder }
    })
  }

  /** Quick capture: a new Inbox note from free text. */
  capture(input: { text: string; title?: string; tags?: string[] }) {
    return this.exclusive(async () => {
      const d = await this.state()
      if (!input.text.trim()) throw new Error('Nothing to capture: the text is empty')
      const made = inboxNote({ text: input.text, ...(input.title?.trim() ? { title: input.title } : {}), tags: cleanTags(input.tags ?? []) })
      const dir = this.canonical(d, `${this.home}Inbox`)
      const base = noteBase(basenameOf(made.path)) || 'Capture'
      const note = await this.addNote(d, dir, base, made.content)
      return this.ref(note)
    })
  }

  /** Append text at the end of a note, or under one of its headings (created when missing). */
  appendToNote(ref: string, text: string, heading?: string) {
    return this.exclusive(async () => {
      const d = await this.state()
      const n = this.resolve(d, ref)
      if (!text.trim()) throw new Error('Nothing to append: the text is empty')
      const raw = await this.current(n)
      const next = appendText(raw, text, heading)
      const note = await this.writeNote(n.meta.path, touchUpdated(next))
      return this.ref(note)
    })
  }

  /** Replace `oldText` (must occur exactly once) with `newText`. */
  editNote(ref: string, oldText: string, newText: string) {
    return this.exclusive(async () => {
      const d = await this.state()
      const n = this.resolve(d, ref)
      if (!oldText) throw new Error('old_text is empty: copy the exact text to replace from read_note')
      const raw = await this.current(n)
      let from = oldText
      let to = newText
      let hits = occurrences(raw, from)
      if (!hits.length && raw.includes('\r\n') && from.includes('\n')) {
        // The file uses CRLF; the AI quoted it with plain line breaks.
        from = from.replace(/\r?\n/g, '\r\n')
        to = to.replace(/\r?\n/g, '\r\n')
        hits = occurrences(raw, from)
      }
      if (!hits.length) {
        throw new Error(`old_text was not found in ${n.meta.path}. Read the note and copy the exact text, including spaces and line breaks.`)
      }
      if (hits.length > 1) {
        const times = hits.length >= MAX_OCCURRENCES ? `${MAX_OCCURRENCES} or more` : String(hits.length)
        throw new Error(`old_text occurs ${times} times in ${n.meta.path}; include more of the surrounding text so it matches exactly once.`)
      }
      const at = hits[0]!
      const next = raw.slice(0, at) + to + raw.slice(at + from.length)
      if (next === raw) return { ...this.ref(n), changed: false }
      const note = await this.writeNote(n.meta.path, touchUpdated(next))
      return { ...this.ref(note), changed: true }
    })
  }

  /** Set and/or remove frontmatter keys (a null value removes the key too). */
  updateFrontmatter(ref: string, set: Record<string, unknown> = {}, remove: string[] = []) {
    return this.exclusive(async () => {
      const d = await this.state()
      const n = this.resolve(d, ref)
      const raw = await this.current(n)
      if (brokenFrontmatter(raw)) {
        throw new Error(`The frontmatter of ${n.meta.path} is not valid YAML; fix it with edit_note first, so nothing in it is lost`)
      }
      const patch: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(set)) {
        const key = k.trim()
        if (!key || key === '__proto__') continue
        if (v === null) patch[key] = undefined
        else if (key === 'tags') patch[key] = cleanTags(v)
        // One string of aliases is split at commas only ("Portal game, PG"): words stay together.
        else if (key === 'aliases' && typeof v === 'string') patch[key] = v.split(',').map((a) => a.trim()).filter(Boolean)
        else patch[key] = v
      }
      for (const k of remove) {
        const key = k.trim()
        if (key && key !== '__proto__') patch[key] = undefined
      }
      if (!Object.keys(patch).length) throw new Error('Nothing to change: pass keys in set or remove')
      const { frontmatter } = splitFrontmatter(raw)
      if (Object.hasOwn(frontmatter, 'updated') && !Object.hasOwn(patch, 'updated')) patch['updated'] = todayIso()
      const next = patchFrontmatter(raw, patch)
      if (next === raw) return { ...this.ref(n), frontmatter: n.frontmatter }
      const note = await this.writeNote(n.meta.path, next)
      return { ...this.ref(note), frontmatter: note.frontmatter }
    })
  }

  /** Add `- [ ] text` under `## <section>` (default "To do"; created when missing). */
  addTask(ref: string, text: string, section = 'To do') {
    return this.exclusive(async () => {
      const d = await this.state()
      const n = this.resolve(d, ref, isProjectNote)
      const clean = cleanTaskText(text)
      if (!clean) throw new Error('The task text is empty')
      const sec = section.replace(/^#+\s*/, '').trim() || 'To do'
      const raw = await this.current(n)
      const next = addTask(raw, clean, sec)
      if (next === raw) throw new Error(`Could not add the task to ${n.meta.path}`)
      const note = await this.writeNote(n.meta.path, touchUpdated(next))
      const tasks = extractTasks(note.raw)
      const added = [...tasks].reverse().find((t) => !t.done && t.text === clean && nameKey(t.section) === nameKey(sec))
      // Tasks below the new line moved down one: hand back the current lines.
      const shown = tasks.slice(0, MAX_TASK_LIST)
      this.remember(note.meta.path, note.raw, added ? [...shown, added] : shown, tasks)
      return { note: this.ref(note), task: added ? taskInfo(added) : null, tasks: shown.map(taskInfo) }
    })
  }

  /** Mark a task done (`[x]` + `✅ date`) or open again. */
  setTaskDone(ref: string, which: TaskSelector, done = true) {
    return this.exclusive(async () => {
      const d = await this.state()
      const n = this.resolve(d, ref, isProjectNote)
      const raw = await this.current(n)
      const { task: t, stale } = this.pick(n, raw, which, (x) => x.done !== done)
      if (t.done === done) return { note: this.ref(n), task: taskInfo(t), changed: false, ...this.relist(n.meta.path, raw, raw, t, stale) }
      const next = setTaskDone(raw, t.line, done, todayIso())
      if (next === raw) throw new Error(`Line ${t.line} of ${n.meta.path} is not a task`)
      const note = await this.writeNote(n.meta.path, touchUpdated(next))
      const after = this.taskAfter(note, t)
      return { note: this.ref(note), task: after && taskInfo(after), changed: true, ...this.relist(note.meta.path, raw, note.raw, after, stale) }
    })
  }

  /** Reword a task; its checkbox and done date stay. */
  editTask(ref: string, which: TaskSelector, text: string) {
    return this.exclusive(async () => {
      const d = await this.state()
      const n = this.resolve(d, ref, isProjectNote)
      const clean = cleanTaskText(text)
      if (!clean) throw new Error('The new task text is empty')
      const raw = await this.current(n)
      const { task: t, stale } = this.pick(n, raw, which)
      const next = editTask(raw, t.line, clean)
      if (next === raw) return { note: this.ref(n), task: taskInfo(t), changed: false, ...this.relist(n.meta.path, raw, raw, t, stale) }
      const note = await this.writeNote(n.meta.path, touchUpdated(next))
      const after = this.taskAfter(note, t)
      return { note: this.ref(note), task: after && taskInfo(after), changed: true, ...this.relist(note.meta.path, raw, note.raw, after, stale) }
    })
  }

  /** Remove a task line (only that line). */
  deleteTask(ref: string, which: TaskSelector) {
    return this.exclusive(async () => {
      const d = await this.state()
      const n = this.resolve(d, ref, isProjectNote)
      const raw = await this.current(n)
      const { task: t } = this.pick(n, raw, which)
      const next = deleteTask(raw, t.line)
      if (next === raw) throw new Error(`Line ${t.line} of ${n.meta.path} is not a task`)
      const note = await this.writeNote(n.meta.path, touchUpdated(next))
      // Tasks below the deleted line moved up one: hand back the current lines.
      return { note: this.ref(note), deleted: taskInfo(t), tasks: this.showTasks(note.meta.path, note.raw, MAX_TASK_LIST).map(taskInfo) }
    })
  }

  /**
   * A new project. With `folder` naming its own folder (title omitted or
   * equal to the folder name) the folder becomes the project: a folder note
   * `<folder>/<name>.md`. Otherwise the note goes to `<home>Projects/`, bound
   * to `folder` when given, else to a new `Projects/<title>/` folder (unless
   * makeFolder is false) where its planets go.
   */
  createProject(input: { title?: string; folder?: string; summary?: string; tags?: string[]; tasks?: string[]; makeFolder?: boolean }) {
    return this.exclusive(async () => {
      const d = await this.state()
      const folder = input.folder?.trim() ? this.targetFolder(d, input.folder) : null
      if (folder !== null && this.vault.multi && !folder.includes('/')) throw new Error(`Pick a folder inside ${folder}, not the whole drive`)
      const title = (input.title ?? '').replace(/\s+/g, ' ').trim() || (folder ? lastSegment(folder) : '')
      if (!title || !noteBase(title)) throw new Error('Give the project a title (or a folder to turn into a project)')
      const clash = d.projects.find((p) => nameKey(p.meta.title) === nameKey(title))
      if (clash) throw new Error(`A project called "${clash.meta.title}" already exists (${clash.meta.path}); use update_project or add_task`)
      if (folder) {
        const owner = d.projectAt.get(folder)
        if (owner) throw new Error(`${folder} already belongs to the project "${this.notes.get(owner)?.meta.title ?? owner}"`)
      }
      const tags = cleanTags(input.tags ?? [])
      const tasks = (input.tasks ?? []).map(cleanTaskText).filter(Boolean)
      const summary = input.summary?.trim()
      let note: ParsedNote
      let home: string | null = folder
      if (folder && nameKey(lastSegment(folder)) === nameKey(title)) {
        const made = folderProjectNote(folder, { ...(summary ? { summary } : {}), tags })
        const taken = new Error(`${made.path} already exists; make it a project with update_frontmatter (set type: project)`)
        if (d.byId.has(idFromPath(made.path).toLowerCase())) throw taken
        let content = made.content
        if (tasks.length) {
          // Replace the template's placeholder task with the given ones.
          const placeholder = extractTasks(content)[0]
          if (placeholder) content = deleteTask(content, placeholder.line)
          for (const t of tasks) content = addTask(content, t, 'To do')
        }
        try {
          note = await this.createFile(made.path, content)
        } catch (err) {
          throw isExistsError(err) ? taken : err
        }
      } else {
        const dir = `${this.home}Projects`
        const made = projectNote({
          name: title,
          ...(summary ? { summary } : {}),
          tags,
          ...(tasks.length ? { tasks } : {}),
          dir,
          // Stored relative to the note's root, so adding or removing a drive keeps the binding.
          ...(folder ? { folder: portableFolderRef(`${dir}/${noteBase(title)}.md`, folder, this.roots) } : {}),
        })
        note = await this.addNote(d, this.canonical(d, folderOf(made.path)), noteBase(basenameOf(made.path)), made.content)
        // The planets' folder is named after the file the note got (`Projects/Lab 2/` for `Lab 2.md`).
        if (!folder && input.makeFolder !== false) home = defaultProjectFolder(note)
      }
      if (home) await this.makeFolder(home)
      const after = this.idx()
      return { project: this.ref(note), folder: after.homeOf.get(note.meta.id) ?? home }
    })
  }

  /** Rename, re-status, re-summarize, re-tag or re-home a project (the old title stays as an alias). */
  updateProject(ref: string, patch: ProjectPatch) {
    return this.exclusive(async () => {
      const d = await this.state()
      const n = this.resolveProject(d, ref)
      const p: ProjectPatch = { ...patch }
      // The new home folder as a vault path (to create); `folder:` stores it relative to the note's root.
      const home = typeof patch.folder === 'string' && patch.folder.trim() ? this.targetFolder(d, patch.folder) : null
      if (typeof patch.folder === 'string') p.folder = home === null ? null : portableFolderRef(n.meta.path, home, this.roots)
      const raw = await this.current(n)
      let next: string
      try {
        // The title the index resolves it by stays an alias even when the text alone can't tell it.
        next = setProjectFields(raw, p, { oldTitle: n.meta.title })
      } catch (err) {
        throw new Error(`Could not update ${n.meta.path}: ${errorText(err)}`)
      }
      if (home) await this.makeFolder(home)
      if (next === raw) return { project: this.projectBrief(this.idx(), n), changed: false }
      const note = await this.writeNote(n.meta.path, touchUpdated(next))
      return { project: this.projectBrief(this.idx(), note), changed: true }
    })
  }

  /**
   * Create a folder (and missing parents). With `project`, `path` is relative
   * to that project's home folder (a planet), which is created when missing.
   */
  createFolder(ref: string, project?: string) {
    return this.exclusive(async () => {
      const d = await this.state()
      let target: string
      let owner: NoteRef | null = null
      if (project?.trim()) {
        const n = this.resolveProject(d, project)
        owner = this.ref(n)
        const home = d.homeOf.get(n.meta.id) ?? defaultProjectFolder(n)
        const rel = this.relativeFolder(ref)
        target = this.canonical(d, rel ? `${home}/${rel}` : home)
      } else {
        target = this.targetFolder(d, ref)
      }
      if (!target || (this.vault.multi && !target.includes('/'))) throw new Error('Name the folder to create inside the vault')
      const created = await this.makeFolder(target)
      return { path: target, created, project: owner }
    })
  }

  /** Link `from` → `to` by appending `- Related: [[to]]` (no-op when already linked). */
  linkNotes(fromRef: string, toRef: string) {
    return this.exclusive(async () => {
      const d = await this.state()
      const a = this.resolve(d, fromRef)
      const b = this.resolve(d, toRef)
      if (a.meta.id === b.meta.id) throw new Error('A note cannot be linked to itself')
      if (this.graph.outlinks.get(a.meta.id)?.has(b.meta.id)) return { from: this.ref(a), to: this.ref(b), added: false }
      // `[[Title]]` only when that title (or alias) names this note alone: which of several
      // same-named notes a title resolves to depends on scan order, so those link by path.
      const unique = (d.byName.get(nameKey(b.meta.title)) ?? []).length === 1
      const plainTitle = unique && !/[[\]|#^]/.test(b.meta.title) && d.resolver.resolve(b.meta.title) === b.meta.id
      const link = plainTitle ? `[[${b.meta.title}]]` : `[[${b.meta.id}|${b.meta.title.replace(/[[\]|]/g, ' ').trim()}]]`
      // A file name with # ^ | [ ] (`Scene #3.md`) cannot be a link target: never write a link that leads nowhere.
      const tokens = tokenizeWikilinks(link)
      if (tokens.length !== 1 || tokens[0]?.heading !== undefined || d.resolver.resolve(tokens[0]?.target ?? '') !== b.meta.id) {
        throw new Error(`A [[wikilink]] cannot reach ${b.meta.path}: its file name contains # | [ or ]. Ask the user to rename the file, then link again.`)
      }
      const raw = await this.current(a)
      const note = await this.writeNote(a.meta.path, touchUpdated(appendText(raw, `- Related: ${link}`)))
      return { from: this.ref(note), to: this.ref(b), added: true, line: `- Related: ${link}` }
    })
  }

  /* -------------------------------------------------------------- */
  /* Internals                                                      */
  /* -------------------------------------------------------------- */

  /**
   * Scan, read and index the vault. A watching brain starts its watcher
   * before the scan: on a whole drive the scan and the read take minutes, and
   * fs.watch never reports what happened before it started. What changes
   * meanwhile is buffered and, once the scan is handed over (seed), classified
   * against it and applied on top of the load (applyChanges is idempotent).
   */
  private async load(): Promise<void> {
    const watch = this.opts.watch !== false
    const sink = (changes: VaultChangeDto[]): void => this.applyExternal(changes)
    let early: VaultWatcher | null = null
    try {
      let files: VaultFile[]
      let folders: string[]
      const pre = this.opts.preload
      if (pre) {
        files = pre.files.map((f) => ({ path: f.path, content: f.content, mtime: f.mtime }))
        folders = [...pre.folders]
      } else {
        if (watch) {
          early = new VaultWatcher(this.vault, null, sink, { images: false })
          this.watcher = early
          await early.start()
          if (this.closed) return
        }
        const scan = await this.vault.scan()
        if (this.closed) return
        files = await this.vault.readAll(scan.files)
        folders = scan.folders
      }
      if (this.closed) return
      const adapter = new SnapshotAdapter(this.vault, this.roots, files, folders, this.readOnly)
      const loaded = await loadVault(adapter, this.index)
      if (this.closed) return
      this.notes = loaded.notes
      this.graph = loaded.graph
      this.folders = loaded.folders
      this.derived = null
      this.loaded = true
      const known = { files: files.map((f) => f.path), folders }
      if (early) early.seed(known)
      else if (watch) {
        // A host's preload: watch from what the host read.
        this.watcher = new VaultWatcher(this.vault, known, sink, { images: false })
        await this.watcher.start()
      }
    } catch (err) {
      early?.stop()
      if (this.watcher === early) this.watcher = null
      throw err
    }
  }

  /** Loaded, current, with lookup tables. */
  private async state(): Promise<Derived> {
    if (this.closed) throw new Error('The vault link is closed')
    await this.loading
    if (this.closed) throw new Error('The vault link is closed')
    this.sync()
    return this.idx()
  }

  /** Apply queued changes: one incremental parse + one graph rebuild for the whole queue. */
  private sync(): void {
    if (!this.pending.length) return
    const changes = this.pending
    this.pending = []
    const next = applyChanges(this.notes, changes, this.index, { folders: this.folders })
    this.notes = next.notes
    this.graph = next.graph
    this.folders = next.folders
    this.derived = null
  }

  private idx(): Derived {
    return (this.derived ??= this.derive())
  }

  /**
   * children / foldersLower / foldersNamed for the current folder set. Built
   * once per set: applyChanges keeps the set's identity when a batch changes
   * notes only, and on a whole drive (hundreds of thousands of folders) these
   * tables are most of the work a tool call after an edit would redo.
   */
  private folderIdx(): FolderTables {
    if (this.folderTables?.of === this.folders) return this.folderTables
    const children = new Map<string, string[]>()
    const foldersLower = new Map<string, string[]>()
    const foldersNamed = new Map<string, string[]>()
    for (const f of this.folders) {
      push(children, folderOf(f), f)
      const lower = f.toLowerCase()
      push(foldersLower, lower, f)
      push(foldersNamed, lastSegment(lower), f)
    }
    for (const list of children.values()) list.sort((a, b) => a.localeCompare(b))
    this.folderTables = { of: this.folders, children, foldersLower, foldersNamed }
    return this.folderTables
  }

  private derive(): Derived {
    const byId = new Map<string, NoteId[]>()
    const byName = new Map<string, NoteId[]>()
    const byBase = new Map<string, NoteId[]>()
    const notesIn = new Map<string, NoteId[]>()
    const totals = new Map<string, number>()
    const projects: ParsedNote[] = []
    for (const n of this.notes.values()) {
      const id = n.meta.id
      push(byId, id.toLowerCase(), id)
      for (const k of new Set([n.meta.title, ...n.meta.aliases].map(nameKey).filter(Boolean))) push(byName, k, id)
      push(byBase, basenameOf(n.meta.path).toLowerCase(), id)
      push(notesIn, n.meta.folder, id)
      for (let f = n.meta.folder; ; f = folderOf(f)) {
        totals.set(f, (totals.get(f) ?? 0) + 1)
        if (f === '') break
      }
      if (isProjectNote(n)) projects.push(n)
    }
    for (const ids of notesIn.values()) {
      ids.sort((a, b) => (this.notes.get(a)?.meta.title ?? a).localeCompare(this.notes.get(b)?.meta.title ?? b))
    }
    const { children, foldersLower, foldersNamed } = this.folderIdx()
    // Bind projects to home folders like the graph does: an explicit `folder:`
    // beats a folder note, which beats a sibling folder; ties go to the first id.
    const homeOf = new Map<NoteId, string | null>()
    const ranked = projects
      .map((n) => {
        const folder = projectFolderOf(n, this.folders)
        const explicit = typeof n.frontmatter['folder'] === 'string' && normalizeFolderPath(n.frontmatter['folder']) !== ''
        homeOf.set(n.meta.id, folder)
        return { id: n.meta.id, folder, rank: explicit ? 0 : folder === n.meta.folder ? 1 : 2 }
      })
      .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    const projectAt = new Map<string, NoteId>()
    for (const r of ranked) if (r.folder && this.folders.has(r.folder) && !projectAt.has(r.folder)) projectAt.set(r.folder, r.id)
    return {
      byId,
      byName,
      byBase,
      notesIn,
      totals,
      children,
      foldersLower,
      foldersNamed,
      projects,
      homeOf,
      projectAt,
      resolver: new LinkResolver(this.notes.values()),
    }
  }

  private ref(n: ParsedNote): NoteRef {
    return { id: n.meta.id, title: n.meta.title, path: n.meta.path }
  }

  private folderName(f: string): string {
    if (f === '') return this.roots.length === 1 ? (this.roots[0]?.label ?? 'Vault') : 'Vault'
    if (this.vault.multi && !f.includes('/')) return this.roots.find((r) => r.mount === f)?.label ?? f
    return lastSegment(f)
  }

  private folderKind(d: Derived, f: string): FolderNode['kind'] {
    if (f === '') return 'root'
    if (this.vault.multi && !f.includes('/')) return 'mount'
    return d.projectAt.has(f) ? 'project' : 'folder'
  }

  /** Latest change time of a note: file mtime or frontmatter `updated`, whichever is later. */
  private timeOf(n: ParsedNote): number {
    const fm = n.meta.updated ? Date.parse(n.meta.updated) : NaN
    return Math.max(n.mtime ?? 0, Number.isNaN(fm) ? 0 : fm)
  }

  private recentList(limit: number, days: number | null, folder: string | null) {
    const cutoff = days ? Date.now() - days * 86_400_000 : -Infinity
    return [...this.notes.values()]
      .filter((n) => folder === null || inFolder(n.meta.folder, folder))
      .map((n) => ({ n, t: this.timeOf(n) }))
      .filter((x) => x.t > 0 && x.t >= cutoff)
      .sort((a, b) => b.t - a.t)
      .slice(0, limit)
      .map(({ n, t }) => ({ ...this.ref(n), updated: new Date(t).toISOString() }))
  }

  private sortedProjects(d: Derived): ParsedNote[] {
    const rank = (n: ParsedNote) => {
      const s = n.meta.status ?? ''
      return ACTIVE_STATUS.test(s) ? 0 : DONE_STATUS.test(s) ? 2 : 1
    }
    return [...d.projects].sort((a, b) => rank(a) - rank(b) || this.timeOf(b) - this.timeOf(a) || a.meta.title.localeCompare(b.meta.title))
  }

  private projectBrief(d: Derived, n: ParsedNote): ProjectBrief {
    const tasks = extractTasks(n.raw)
    const p = taskProgress(tasks)
    const folder = d.homeOf.get(n.meta.id) ?? projectFolderOf(n, this.folders)
    return {
      ...this.ref(n),
      status: n.meta.status,
      folder,
      folderExists: folder !== null && this.folders.has(folder),
      progress: `${p.done}/${p.total}`,
      next: tasks
        .filter((t) => !t.done)
        .slice(0, 3)
        .map((t) => t.text),
      summary: clip(projectSummary(n), 240),
      tags: n.meta.tags,
      updated: n.meta.updated,
    }
  }

  /** The task a write left at `before`'s place (same line, or found again by text). */
  private taskAfter(note: ParsedNote, before: TaskItem): TaskItem | null {
    const tasks = extractTasks(note.raw)
    return tasks.find((x) => x.line === before.line) ?? tasks.find((x) => x.text === before.text) ?? null
  }

  /**
   * A note by reference, in this order: file URL / absolute path, id or vault
   * path (with or without `.md`, any case, any mount in a multi-root vault),
   * title or alias, file name. Several matches are an error listing them,
   * unless exactly one satisfies `prefer`.
   */
  private resolve(d: Derived, ref: string, prefer?: (n: ParsedNote) => boolean): ParsedNote {
    let raw = ref.trim()
    const wiki = /^!?\[\[([^\]]+)\]\]$/.exec(raw)
    if (wiki) raw = parseWikilinkRaw(wiki[1] ?? '').target
    if (!raw) throw new Error('Name a note: its title, id or vault path')
    const pick = (ids: NoteId[] | undefined): ParsedNote | null => {
      const found = [...new Set(ids ?? [])].flatMap((i) => {
        const n = this.notes.get(i)
        return n ? [n] : []
      })
      if (!found.length) return null
      if (found.length === 1) return found[0]!
      const preferred = prefer ? found.filter(prefer) : []
      if (preferred.length === 1) return preferred[0]!
      const list = found
        .slice(0, 10)
        .map((n) => n.meta.path)
        .join(', ')
      throw new Error(`"${raw}" matches ${found.length} notes; pass one of these paths instead: ${list}`)
    }
    const abs = this.absoluteToVault(raw)
    if (abs !== null) {
      // Windows and macOS paths are case-insensitive: `d:\projects\portalz.md` is Projects/PORTALz.
      const n = this.notes.get(idFromPath(abs)) ?? pick(d.byId.get(idFromPath(abs).toLowerCase()))
      if (n) return n
    }
    const id = normalizePath(raw).replace(/\.md$/i, '')
    const exact = this.notes.get(id)
    if (exact) return exact
    const lower = id.toLowerCase()
    const mounted = this.vault.multi ? this.roots.flatMap((r) => d.byId.get(`${r.mount}/${lower}`.toLowerCase()) ?? []) : []
    const found =
      pick(d.byId.get(lower)) ??
      pick(mounted) ??
      pick(d.byName.get(nameKey(raw))) ??
      (raw.includes('/') || raw.includes('\\') ? null : pick(d.byBase.get(basenameOf(raw).toLowerCase())))
    if (found) return found
    const guesses = this.index.suggestTitles(raw, 5)
    const hint = guesses.length
      ? ` Did you mean: ${guesses.map((g) => `"${g.title}" (${this.notes.get(g.id)?.meta.path ?? g.id})`).join(', ')}?`
      : ' Try search_notes.'
    throw new Error(`No note matches "${raw}".${hint}`)
  }

  /** A project by title, alias, id, path, or its home folder. */
  private resolveProject(d: Derived, ref: string): ParsedNote {
    let note: ParsedNote | null = null
    try {
      note = this.resolve(d, ref, isProjectNote)
    } catch (err) {
      if (!errorText(err).startsWith('No note matches')) throw err
    }
    if (note && isProjectNote(note)) return note
    // A folder: the project whose home it is.
    let folder: string | null = null
    try {
      folder = this.resolveFolder(d, ref)
    } catch {
      /* not a folder either */
    }
    const bound = folder !== null ? d.projectAt.get(folder) : undefined
    const owner = bound ? this.notes.get(bound) : undefined
    if (owner) return owner
    if (note) {
      throw new Error(`"${note.meta.title}" (${note.meta.path}) is not a project. A project is a note with type: project, or a note in the Projects folder`)
    }
    const names = this.sortedProjects(d)
      .slice(0, 15)
      .map((p) => `"${p.meta.title}"`)
      .join(', ')
    throw new Error(`No project matches "${ref.trim()}". Projects: ${names || 'none yet (create one with create_project)'}`)
  }

  /** An existing folder by vault path (any case, any mount), root label, absolute path or unique name. '' = the vault root. */
  private resolveFolder(d: Derived, ref: string): string {
    const raw = ref.trim()
    if (raw === '' || raw === '/' || raw === '.' || raw === '\\') return ''
    const p = normalizeFolderPath(raw)
    // An exact vault path beats a root's label (a root folder "Art" may hold a folder "Art").
    if (p !== '' && this.folders.has(p)) return p
    const root = this.roots.find((r) => r.label.toLowerCase() === raw.toLowerCase() || r.path === raw)
    if (root) return root.mount
    const abs = this.absoluteToVault(raw)
    if (abs !== null && (abs === '' || this.folders.has(abs))) return abs
    if (p === '') return ''
    const unique = (list: string[]): string | null => {
      const set = [...new Set(list)]
      if (set.length === 1) return set[0]!
      if (set.length > 1) throw new Error(`"${raw}" matches ${set.length} folders; pass one of: ${set.slice(0, 10).join(', ')}`)
      return null
    }
    const lower = p.toLowerCase()
    const found =
      unique(d.foldersLower.get(lower) ?? []) ??
      (this.vault.multi ? unique(this.roots.flatMap((r) => d.foldersLower.get(`${r.mount}/${lower}`.toLowerCase()) ?? [])) : null) ??
      (p.includes('/') ? null : unique(d.foldersNamed.get(lower) ?? []))
    if (found !== null) return found
    throw new Error(`No folder "${raw}" in the vault. Use list_folder to see the folders.`)
  }

  /** A vault path from a file:// URL or an absolute path inside a root; null otherwise. */
  private absoluteToVault(raw: string): string | null {
    let abs: string | null = null
    if (/^file:/i.test(raw)) {
      try {
        abs = fileURLToPath(raw)
      } catch {
        return null
      }
    } else if (path.isAbsolute(raw) || (process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(raw))) {
      abs = raw
    }
    return abs === null ? null : this.vault.toVault(abs)
  }

  /** A relative folder path from an AI: posix, no `..`, no `.` segments. */
  private relativeFolder(ref: string): string {
    const segs = ref.trim().replace(/\\/g, '/').split('/').filter((s) => s && s !== '.')
    if (segs.some((s) => s === '..')) throw new Error(`Folder paths cannot go up with "..": ${ref}`)
    return segs.join('/')
  }

  /**
   * A folder to create or write into (it need not exist): an absolute path
   * inside a root, or a vault path; in a multi-root vault a path that does not
   * start with a mount goes under the home mount.
   */
  private targetFolder(d: Derived, ref: string): string {
    const raw = ref.trim()
    let p = this.absoluteToVault(raw)
    if (p === null) {
      const absolute = /^file:/i.test(raw) || path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)
      // A vault path with a stray leading `/` or `\` (`/Projects/Art`) is fine; any other absolute path is outside the vault.
      if (absolute && !(/^[\\/]/.test(raw) && this.isVaultTop(d, raw))) throw new Error(`"${raw}" is outside the vault`)
      p = this.relativeFolder(raw)
      if (this.vault.multi && p) {
        const [head = '', ...rest] = p.split('/')
        const root = this.roots.find((r) => r.mount.toLowerCase() === head.toLowerCase())
        p = root ? [root.mount, ...rest].join('/') : `${this.home}${p}`
      }
    }
    return this.canonical(d, p || this.home.replace(/\/$/, ''))
  }

  /** True when `/x/…` starts with a top-level vault folder or mount (a vault path with a stray `/`, unlike /etc). */
  private isVaultTop(d: Derived, raw: string): boolean {
    const first = (raw.replace(/^[\\/]+/, '').split(/[\\/]/)[0] ?? '').toLowerCase()
    if (!first) return false
    return this.roots.some((r) => r.mount.toLowerCase() === first) || (d.children.get('') ?? []).some((f) => f.toLowerCase() === first)
  }

  /**
   * Existing folders keep their spelling (`projects/portalz` → `Projects/PORTALz`);
   * refuses skipped folders and new folder names Windows cannot hold.
   */
  private canonical(d: Derived, p: string): string {
    let cur = ''
    for (const seg of p.split('/').filter(Boolean)) {
      if (/\.md$/i.test(seg)) throw new Error(`A folder name cannot end in .md: ${seg}`)
      const next = cur ? `${cur}/${seg}` : seg
      if (this.folders.has(next)) {
        cur = next
        continue
      }
      const ci = d.foldersLower.get(next.toLowerCase())
      if (ci?.length === 1) {
        cur = ci[0]!
        continue
      }
      const unsafe = unsafeFolderName(seg)
      if (unsafe) throw new Error(unsafe)
      cur = next
    }
    if (cur && (this.vault.isIgnored(cur) || isIgnoredPath(cur))) {
      throw new Error(`"${cur}" is inside a folder the vault skips (hidden, system, build or excluded folders)`)
    }
    return cur
  }

  /**
   * A new note `<dir>/<base>.md`, or `<base> 2.md`, `<base> 3.md`… Names the
   * index knows (in any case), Windows device names and skipped names are
   * passed over; FsVault.create then refuses anything on disk the index has
   * not seen (EEXIST: a note the watcher has not reported yet, repo
   * boilerplate the scan skips, a case variant) and the next name is tried.
   */
  private async addNote(d: Derived, dir: string, base: string, content: string): Promise<ParsedNote> {
    for (let n = 1; n <= 500; n++) {
      const file = `${n === 1 ? base : `${base} ${n}`}.md`
      const p = dir ? `${dir}/${file}` : file
      // `CON.md` on Windows is the console, not a file: take the next name.
      if (WIN_RESERVED.test(file) || isIgnoredPath(p) || this.vault.isIgnored(p)) continue
      if (d.byId.has(idFromPath(p).toLowerCase())) continue
      try {
        return await this.createFile(p, content)
      } catch (err) {
        if (!isExistsError(err)) throw err
      }
    }
    throw new Error(`No free file name for "${base}" in ${dir || 'the vault root'}`)
  }

  /** The note's first `max` tasks, remembered as a listing a reply shows (see TaskView). */
  private showTasks(notePath: string, raw: string, max: number): TaskItem[] {
    const tasks = extractTasks(raw)
    const shown = tasks.slice(0, max)
    this.remember(notePath, raw, shown, tasks)
    return shown
  }

  /**
   * Remember that a reply listed `shown` (tasks of `raw`) for the note. A
   * listing of the same text adds to the newest one; any other goes first,
   * and the older ones stay (up to VIEWS_PER_NOTE) for the lines it does not
   * show: a reply lists at most a few hundred tasks, add_task and delete_task
   * only the first MAX_TASK_LIST, while lines further down may have moved.
   */
  private remember(notePath: string, raw: string, shown: readonly TaskItem[], all?: TaskItem[]): void {
    if (!shown.length) return
    const hash = hashText(raw)
    const list = this.views.get(notePath) ?? []
    let view = list[0]
    if (!view || view.hash !== hash) {
      view = { hash, tasks: new Map() }
      list.unshift(view)
      if (list.length > VIEWS_PER_NOTE) list.length = VIEWS_PER_NOTE
    }
    for (const [line, t] of shownTasks(raw, all ?? extractTasks(raw), shown)) view.tasks.set(line, t)
    this.views.delete(notePath)
    this.views.set(notePath, list)
    if (this.views.size > MAX_VIEWS) {
      const oldest = this.views.keys().next()
      if (!oldest.done) this.views.delete(oldest.value)
    }
  }

  /**
   * The listing side of a task call that moves no line (a task ticked,
   * reopened or reworded; `before` → `after`). When the AI's lines still
   * count (not `stale`, and the write moved no task line), the listings carry
   * over to the new text and nothing is listed. Otherwise its line numbers
   * are stale, so the reply lists the current ones (`tasks`), which become
   * the newest listing. `task` is the task the reply names (with its line).
   */
  private relist(notePath: string, before: string, after: string, task: TaskItem | null, stale: boolean): { tasks?: TaskInfo[] } {
    const tasks = extractTasks(after)
    if (!stale && this.carryOver(notePath, before, after, tasks)) {
      if (task) this.remember(notePath, after, [task], tasks)
      return {}
    }
    const shown = tasks.slice(0, MAX_TASK_LIST)
    this.remember(notePath, after, task ? [...shown, task] : shown, tasks)
    return { tasks: shown.map(taskInfo) }
  }

  /**
   * Move the listings of `before` over to `after` (the note after a write
   * that should move no line), refreshed from it, and return true. Returns
   * false and changes nothing when task lines did move after all (the
   * `updated:` stamp rewrote a value that spanned several lines).
   */
  private carryOver(notePath: string, before: string, after: string, tasks: TaskItem[]): boolean {
    if (before === after) return true
    const was = extractTasks(before)
    if (was.length !== tasks.length || was.some((t, i) => tasks[i]?.line !== t.line)) return false
    const from = hashText(before)
    const to = hashText(after)
    for (const v of this.views.get(notePath) ?? []) {
      if (v.hash !== from) continue
      v.hash = to
      v.tasks = shownTasks(after, tasks, tasks.filter((t) => v.tasks.has(t.line)))
    }
    return true
  }

  /**
   * pickTask against the listings remembered for the note. `stale`: the AI's
   * line numbers may not count in `raw` (the note changed since its newest
   * listing, or the line had to be found again). An error that lists tasks
   * makes those lines (as they are now) the newest listing.
   */
  private pick(n: ParsedNote, raw: string, which: TaskSelector, prefer?: (t: TaskItem) => boolean): { task: TaskItem; stale: boolean } {
    const views = this.views.get(n.meta.path) ?? []
    const hash = views.length ? hashText(raw) : ''
    try {
      const { task, remapped } = pickTask(raw, which, n.meta.path, prefer, views, hash)
      return { task, stale: remapped || (views[0] !== undefined && views[0].hash !== hash) }
    } catch (err) {
      if (err instanceof TaskPickError) this.remember(n.meta.path, raw, err.shown)
      throw err
    }
  }

  /** The note's text on disk right now (the index can lag a moment behind an edit made in the app). */
  private async current(n: ParsedNote): Promise<string> {
    const raw = await this.vault.read(n.meta.path)
    if (raw === null) throw new Error(`${n.meta.path} is no longer on disk`)
    return raw
  }

  private assertWritable(): void {
    if (this.readOnly) throw new Error('The vault link is read-only')
    if (this.closed) throw new Error('The vault link is closed')
  }

  /** Writes only `.md` notes inside the visible vault, and only when writable. */
  private assertNotePath(p: string): void {
    this.assertWritable()
    if (!/\.md$/i.test(p)) throw new Error(`Only markdown notes (.md) can be written: ${p}`)
    if (isIgnoredPath(p) || this.vault.isIgnored(p)) throw new Error(`${p} is inside a folder the vault skips`)
  }

  /** Rewrite an existing note (atomic) and index it right away. */
  private async writeNote(p: string, content: string): Promise<ParsedNote> {
    this.assertNotePath(p)
    this.watcher?.noteSelfWrite(p, content)
    await this.vault.write(p, content)
    return this.indexed({ kind: 'change', path: p, content, mtime: Date.now() })
  }

  /** Create a note at exactly `p` (fails with EEXIST when anything is there, see FsVault.create) and index it. */
  private async createFile(p: string, content: string): Promise<ParsedNote> {
    this.assertNotePath(p)
    // Noted before the create, like writeNote: on disks without hard links FsVault.create fills
    // the file in place, and the watcher must not index it half-written. Harmless when the create
    // fails: echoes are only swallowed when the content matches ours, which an existing file's won't.
    this.watcher?.noteSelfWrite(p, content)
    await this.vault.create(p, content)
    return this.indexed({ kind: 'add', path: p, content, mtime: Date.now() })
  }

  private indexed(change: VaultChange): ParsedNote {
    this.pending.push(change)
    this.sync()
    const note = this.notes.get(idFromPath(change.path))
    if (!note) throw new Error(`Wrote ${change.path} but could not index it`)
    return note
  }

  /** mkdir -p inside the vault and index the folder; false when it already existed. */
  private async makeFolder(p: string): Promise<boolean> {
    this.assertWritable()
    const existed = this.folders.has(p) && (await this.vault.stat(p))?.isDir === true
    if (existed) return false
    await this.vault.mkdir(p)
    this.pending.push({ kind: 'addDir', path: p })
    this.sync()
    return true
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => undefined)
    return run
  }
}

/** Listing entries for `shown` (tasks of `raw`; `all` are all its tasks): each line's text and which of the task lines with that text it is. */
function shownTasks(raw: string, all: readonly TaskItem[], shown: readonly TaskItem[]): Map<number, ShownTask> {
  const out = new Map<number, ShownTask>()
  if (!shown.length) return out
  const want = new Set(shown.map((t) => t.line))
  const lines = raw.split('\n')
  const seen = new Map<string, number>()
  for (const t of all) {
    const line = stripCr(lines[t.line] ?? '')
    const nth = seen.get(line) ?? 0
    seen.set(line, nth + 1)
    if (want.has(t.line)) out.set(t.line, { line, nth, text: t.text })
  }
  return out
}

/**
 * `line` as it counts in `raw` (whose hash is `hash`) now. The line means
 * what the newest listing that showed a task there said; when the note
 * changed since that listing, that task is found again: the same line text
 * (the same occurrence of it), else the only task with its text (`at` null
 * when neither works). A line no listing showed stands when the newest
 * listing counts in this text, or there is none; else `at` is null.
 */
function remapLine(views: readonly TaskView[], hash: string, raw: string, tasks: TaskItem[], line: number): { at: number | null; was: ShownTask | null; remapped: boolean } {
  let from: TaskView | null = null
  let was: ShownTask | null = null
  for (const v of views) {
    was = v.tasks.get(line) ?? null
    if (was) {
      from = v
      break
    }
  }
  if (!from || !was) {
    const newest = views[0]
    return { at: !newest || newest.hash === hash ? line : null, was: null, remapped: false }
  }
  if (from.hash === hash) return { at: line, was, remapped: false }
  const lines = raw.split('\n')
  const text = was.line
  const same = tasks.filter((t) => stripCr(lines[t.line] ?? '') === text)
  const hit = same[was.nth] ?? (same.length === 1 ? same[0] : undefined)
  if (hit) return { at: hit.line, was, remapped: true }
  // Ticked off, reopened or re-indented meanwhile: the same task by its text.
  const key = nameKey(was.text)
  const byText = tasks.filter((t) => nameKey(t.text) === key)
  return { at: byText.length === 1 ? (byText[0]?.line ?? null) : null, was, remapped: true }
}

/**
 * The task a caller means: by line (0-based, as get_project / read_note list
 * them), by text (exact, else a unique substring, case-insensitive), or both
 * (the line wins when its text agrees). `prefer` breaks ties between text
 * matches. `views` are the listings the line may come from (newest first,
 * `hash` is raw's): when the note changed since the one that showed the line,
 * the line is mapped onto the note as it is now (`remapped`), and a line-only
 * call whose task can't be found again is refused (listing the current
 * lines) instead of acting on whatever task sits on that line now.
 */
function pickTask(
  raw: string,
  which: TaskSelector,
  notePath: string,
  prefer?: (t: TaskItem) => boolean,
  views: readonly TaskView[] = [],
  hash = '',
): { task: TaskItem; remapped: boolean } {
  const tasks = extractTasks(raw)
  const listed = tasks.slice(0, MAX_ERROR_TASKS)
  const list = () => listed.map((t) => `${t.line}: ${t.done ? '[x]' : '[ ]'} ${t.text}`).join('; ')
  if (!tasks.length) throw new Error(`${notePath} has no tasks`)
  const want = which.task !== undefined ? nameKey(cleanTaskText(which.task)) : ''
  if (which.line !== undefined) {
    const { at, was, remapped } = remapLine(views, hash, raw, tasks, which.line)
    const t = at === null ? undefined : tasks.find((x) => x.line === at)
    if (t && (!want || nameKey(t.text).includes(want))) return { task: t, remapped }
    if (!want) {
      if (at !== null && !remapped) throw new TaskPickError(`Line ${which.line} of ${notePath} is not a task. Tasks (line: text): ${list()}`, listed)
      const what = was ? `the task on line ${which.line} ("${clip(was.text, 80)}") is not there any more, or not only once` : `line ${which.line} was not a task`
      throw new TaskPickError(`${notePath} changed since its tasks were listed: ${what}. Nothing was changed. Tasks now (line: text): ${list()}. Pass task (its text) to be sure.`, listed)
    }
  }
  if (!want) throw new Error('Say which task: pass its line (from get_project or read_note) or its text')
  const exact = tasks.filter((t) => nameKey(t.text) === want)
  const matches = exact.length ? exact : tasks.filter((t) => nameKey(t.text).includes(want))
  if (matches.length === 1) return { task: matches[0]!, remapped: false }
  if (!matches.length) throw new TaskPickError(`No task matching "${which.task}" in ${notePath}. Tasks (line: text): ${list()}`, listed)
  const preferred = prefer ? matches.filter(prefer) : []
  if (preferred.length === 1) return { task: preferred[0]!, remapped: false }
  throw new TaskPickError(`"${which.task}" matches ${matches.length} tasks in ${notePath}; pass line instead: ${matches.map((t) => `${t.line}: ${t.text}`).join('; ')}`, matches)
}
