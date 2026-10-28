import { create } from 'zustand'
import {
  AREA_FOLDER,
  BIO_FOLDER,
  SearchIndex,
  TODAY_ID,
  addTask as addTaskToNote,
  applyChanges,
  applyChatUpdate,
  areaFromFolder,
  asString,
  basenameOf,
  blankNote,
  bodyOwners,
  bodyTiers,
  ActivityLog,
  bindProjects,
  buildGraph,
  computeActivity,
  remindersOf,
  critiqueBaseName,
  critiqueNote,
  dailyBrief,
  dailyNote,
  defaultProjectFolder,
  deleteTask as deleteTaskInNote,
  editTask as editTaskInNote,
  extractTasks,
  folderKey,
  folderUniverse,
  galaxiesInside,
  folderOf,
  folderPathOf,
  folderProjectNote,
  ghostTitle,
  homePrefix as homePrefixOf,
  idFromPath,
  imageFileName,
  imageKey,
  imagePathOf,
  inboxNote,
  isBoardNote,
  isExistsError,
  isFolderId,
  isGhostId,
  isIgnoredPath,
  isImageId,
  isImagePath,
  isModelPath,
  isProjectNote,
  isSunNode,
  isTodayId,
  isVirtualId,
  isVideoPath,
  folderBodies,
  legendBodiesIn,
  loadVault,
  mountOf,
  neighborhood,
  newBoardNote,
  nextDay,
  normalizeFolderPath,
  normalizeGrade,
  normalizePath,
  parseNote,
  parseWikilinkRaw,
  planBio,
  planChatImport,
  portableFolderRef,
  projectFolderOf,
  projectNote,
  scaleOf,
  setProjectFields,
  setTaskDone,
  slugifyTitle,
  sunCounts,
  underAny,
  splitFrontmatter,
  todayIso,
  updateFrontmatter,
  type ActivityKind,
  type Area,
  type BriefTask,
  type BuildGraphOptions,
  type ChatArchive,
  type ChatImportPlan,
  type GraphData,
  type GraphOptionsFn,
  type LegendBody,
  type NoteId,
  type NoteType,
  type ParsedNote,
  type ProjectPatch,
  type SunCounts,
  type SunLevel,
  type VaultAdapter,
  type VaultAsset,
  type VaultChange,
  type VaultRootInfo,
  type DailyBrief,
} from '@aether/core'
import {
  BrainController,
  PICTURE_SIZES,
  PICTURE_SIZE_NAMES,
  isPictureSize,
  type ColorMode,
  type LayoutMode,
  type PictureSize,
} from '@aether/graph'
import { getActiveBoard, getBoardWindowControl } from './board/active'
import {
  BOARDS_FOLDER,
  BOARD_BUDGET_TEXT,
  BoardChangedOutsideError,
  MAX_ADDED_AT_ONCE,
  addPicturesToBoardText,
  boardFolderFallback,
  boardFolderOf as boardFolderOfPath,
  boardTitleOfPath,
  fitPictureSize,
  isBoard,
  listBoards,
  pictureAspect,
  samePath,
  uniqueBoardStem,
  type AddedToBoard,
  type PictureToAdd,
} from './board/boardRegistry'
import { playBody, playSun, soundSupported } from './audio/sounds'
import { listProjects, moveTaskOnBoard } from './projects'
import { IGNORED_MARK_TEXT, plural, stillOf, truncate } from './util'

export type View = 'graph' | 'editor' | 'capture' | 'search' | 'review' | 'projects' | 'boards'

export interface Filters {
  areas: Set<Area>
  tags: Set<string>
  types: Set<NoteType>
  /** The legend's kinds of body (a galaxy, a star, a picture …): everything of a chosen kind lights up. */
  bodies: Set<LegendBody>
  query: string
}

/** A button on a toast, e.g. Undo. */
export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error' | 'success'
  action?: ToastAction
}

export interface ReviewEntry {
  /** ISO date the note is next due. */
  due: string
  /** Interval in days. */
  interval: number
  count: number
  last: string
}

export type ReviewOutcome = 'keep' | 'archive' | 'later' | 'processed'

/** An inline form a command can ask for: a new project (the Projects board), a note or a folder in the selected folder (the folder inspector), a new reference board (the Boards view). */
export type FormRequest = 'project' | 'note' | 'folder' | 'board'

export interface Settings {
  colorMode: ColorMode
  layoutMode: LayoutMode
  bloom: boolean
  hubLabels: boolean
  previewMode: 'split' | 'edit' | 'preview'
  /** System layout: deepest folder level shown without expanding (1–8). */
  folderDepth: number
  /** System layout: planets and moons orbit their parents. */
  motion: boolean
  /** System layout: calm orbits. Urgency speeds an orbit up less, never past a normal orbit (⇧O). */
  calm: boolean
  /** System layout: each shown folder's newest pictures orbit it as moons. */
  imageMoons: boolean
  /** Picture moons show their thumbnails. */
  thumbnails: boolean
  /** How big pictures are drawn: medium, large or extra large icons (`z`). The layout makes room for them. */
  pictureSize: PictureSize
  /** The glowing Today hub (daily brief) is in the graph. */
  todayHub: boolean
  /** System layout: a project star's pictures float around it in 3D when the camera comes close (Shift+G any time). */
  starGalleries: boolean
  /** System layout: suns open into planets, then moons (a click opens one). Off: every body shows, always. */
  suns: boolean
  /** A click on a star, a planet or a moon plays a note; opening a sun plays a run (Shift+M mutes). */
  sound: boolean
  /** System layout: stars that need attention throw corona ejections, the more urgent the bigger (Shift+F). */
  flares: boolean
  /** System layout: the reminders (dated tasks, notes tagged reminder) float by as asteroids (Shift+A). */
  asteroids: boolean
  /** Settings version; 2 = the solar-system layout became the default. */
  v: number
}

const SETTINGS_KEY = 'aether:settings'
const REVIEW_KEY = 'aether:review'
/** Expanded folders, per vault location. */
const EXPANDED_KEY = 'aether:expanded:'
/** How open each sun is, per vault location: the suns opened by hand and the level of the rest. */
const SUNS_KEY = 'aether:suns:'
/** The board last open, per vault location (the `8` key goes back to it). */
const LAST_BOARD_KEY = 'aether:board:'
/** How much each note is used (opens and saves, fading), per vault location: what a star's brightness is. Local to this computer; never in the vault. */
const ACTIVITY_KEY = 'aether:activity:'
const SETTINGS_VERSION = 2
/** Views drawn over the graph: flying to something there shows nothing until they close. */
export const COVERING_VIEWS: ReadonlySet<View> = new Set<View>(['projects', 'review', 'capture', 'search', 'boards'])
/**
 * The views that fill the window with a panel: the 3D view behind them is not drawn (`controller.setCovered`) and the panel is solid.
 * Review and quick capture are small dialogs over a scene that stays visible and alive.
 */
export const FULL_PANEL_VIEWS: ReadonlySet<View> = new Set<View>(['projects', 'boards'])
/** Previews read at once to learn the shapes of pictures going onto a board that is not open. */
const ASPECT_PARALLEL = 4
/**
 * The desktop adapter's `readAssetChecked` (renderer/vault/electron.ts): the picture, or why there is none. Not on the core
 * `VaultAdapter` (the web and memory vaults have no such verdict), so it is looked for on the adapter at the one place that reads whole
 * pictures for a board.
 */
type CheckedAssetReader = {
  readAssetChecked?(path: string): Promise<{ blob: Blob } | { blob: null; reason: 'missing' | 'too-large' | 'unreadable'; detail: string }>
}
/** What the vault says when it will not take pictures in a folder (the desktop's exclude list, an ignored folder name). */
const OUT_OF_VAULT = /excluded from the vault|skipped by the brain/i
/** Numbered names (` 2` … ` 1000`) tried for a new note or picture before giving up. */
const MAX_SUFFIX = 1000
/** Largest picture the app writes (an imported file, a Concept Forge drawing). */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024
/** New notes of a chat import written per held batch (one graph rebuild each). */
const NOTE_CHUNK = 100
/** Picture bytes of a chat import held in memory and written per batch. */
const PICTURE_CHUNK_BYTES = 64 * 1024 * 1024
const LAYOUTS: LayoutMode[] = ['constellation', 'orbit', 'system']
const LAYOUT_TOASTS: Record<LayoutMode, string> = {
  constellation: 'Constellation layout — clustered by area',
  orbit: 'Orbit layout — time as rings, newest at the core',
  system: 'System layout — drives are galaxies, folders are stars, planets and moons by depth, files are satellites',
}
const DEFAULT_SETTINGS: Settings = {
  colorMode: 'area',
  layoutMode: 'system',
  bloom: true,
  hubLabels: true,
  previewMode: 'split',
  folderDepth: 3,
  motion: true,
  calm: false,
  imageMoons: true,
  thumbnails: true,
  pictureSize: 'xl',
  todayHub: true,
  starGalleries: true,
  suns: true,
  sound: true,
  flares: true,
  asteroids: true,
  v: SETTINGS_VERSION,
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback
  } catch {
    return fallback
  }
}
function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode etc. */
  }
}

/** Whether this computer asks for less motion (the setting is only read in a browser window; anywhere else it is no). */
function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Folder depth the system layout accepts: an integer in 1–8. */
function clampDepth(n: number): number {
  return Math.min(8, Math.max(1, Math.round(Number.isFinite(n) ? n : 3)))
}

/**
 * Stored settings over the defaults. Settings written before v2 move to the
 * solar-system layout once (after that the user's choice sticks).
 */
function loadSettings(): Settings {
  let stored: Partial<Settings> | null = null
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Partial<Settings>
  } catch {
    /* no storage, or garbage in it */
  }
  const s: Settings = { ...DEFAULT_SETTINGS, ...stored }
  if (!LAYOUTS.includes(s.layoutMode)) s.layoutMode = 'system'
  s.folderDepth = clampDepth(s.folderDepth)
  s.motion = s.motion !== false
  s.calm = s.calm === true
  s.imageMoons = s.imageMoons !== false
  s.thumbnails = s.thumbnails !== false
  if (!isPictureSize(s.pictureSize)) s.pictureSize = DEFAULT_SETTINGS.pictureSize
  s.todayHub = s.todayHub !== false
  s.starGalleries = s.starGalleries !== false
  s.suns = s.suns !== false
  s.sound = s.sound !== false
  // Ejections are motion: a computer that asks for less of it starts without them (until the setting is changed by hand).
  s.flares = stored?.flares === undefined && prefersReducedMotion() ? false : s.flares !== false
  // Drifting rocks are motion too.
  s.asteroids = stored?.asteroids === undefined && prefersReducedMotion() ? false : s.asteroids !== false
  if (stored && !(typeof stored.v === 'number' && stored.v >= SETTINGS_VERSION)) {
    s.layoutMode = 'system'
    s.v = SETTINGS_VERSION
    saveJson(SETTINGS_KEY, s)
  }
  return s
}

const asSunLevel = (n: unknown): SunLevel => (n === 1 || n === 2 ? n : 0)

/** The sun levels saved for the vault at `location`: the default and the suns with a level of their own. */
function loadSuns(location: string): { def: SunLevel; own: Record<string, SunLevel> } {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SUNS_KEY + location) ?? 'null')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const p = parsed as { def?: unknown; own?: unknown }
      const own: Record<string, SunLevel> = {}
      if (p.own && typeof p.own === 'object' && !Array.isArray(p.own)) {
        for (const [id, level] of Object.entries(p.own as Record<string, unknown>)) own[id] = asSunLevel(level)
      }
      return { def: asSunLevel(p.def), own }
    }
  } catch {
    /* no storage, or garbage in it */
  }
  return { def: 0, own: {} }
}

/** What each sun holds, who owns each body and what each one needs, for a graph (computed once per graph, not once per call). */
const cosmosCache = new WeakMap<GraphData, { counts: Map<NoteId, SunCounts>; owners: Int32Array; tiers: Uint8Array }>()
function cosmosOf(graph: GraphData): { counts: Map<NoteId, SunCounts>; owners: Int32Array; tiers: Uint8Array } {
  let c = cosmosCache.get(graph)
  if (!c) {
    c = { counts: sunCounts(graph), owners: bodyOwners(graph), tiers: bodyTiers(graph) }
    cosmosCache.set(graph, c)
  }
  return c
}

/** The activity saved for the vault at `location` (an empty log when there is none, or storage is unusable or holds garbage). */
function loadActivity(location: string, now: number): ActivityLog {
  try {
    return ActivityLog.from(JSON.parse(localStorage.getItem(ACTIVITY_KEY + location) ?? 'null'), now)
  } catch {
    return new ActivityLog()
  }
}

function loadExpanded(location: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY + location) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').map(normalizeFolderPath) : [])
  } catch {
    return new Set()
  }
}

/** The board last open in the vault at `location` (a vault path), or null. */
function loadLastBoard(location: string): string | null {
  try {
    const path = localStorage.getItem(LAST_BOARD_KEY + location)
    return path && path.length <= 1000 ? path : null
  } catch {
    return null
  }
}

/** Remember the board last open in the vault at `location`. */
function saveLastBoard(location: string | undefined, path: string): void {
  if (location === undefined) return
  try {
    localStorage.setItem(LAST_BOARD_KEY + location, path)
  } catch {
    /* private mode etc. */
  }
}

/** The file name of a vault path (`Inbox/Idea.md` → `Idea.md`). */
function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A frontmatter block whose YAML did not parse: rewriting it would throw the user's text away. */
function hasBrokenFrontmatter(raw: string): boolean {
  const split = splitFrontmatter(raw)
  if (!split.hasFrontmatter || Object.keys(split.frontmatter).length > 0) return false
  return raw
    .slice(0, split.bodyOffset)
    .split(/\r?\n/)
    .slice(1)
    .some((l) => !/^\s*(#.*|---|\.\.\.)?\s*$/.test(l))
}

/**
 * Set frontmatter `updated:` to today by rewriting that one line; everything
 * else stays byte-identical (line numbers included). No-op when the note has
 * no top-level `updated` key or its frontmatter does not parse.
 */
function touchUpdated(raw: string, today = todayIso()): string {
  const split = splitFrontmatter(raw)
  if (!split.hasFrontmatter || !Object.hasOwn(split.frontmatter, 'updated')) return raw
  const head = raw.slice(0, split.bodyOffset)
  const next = head.replace(/^(updated:[ \t]*)[^\r\n]*/m, `$1${today}`)
  return next === head ? raw : next + raw.slice(split.bodyOffset)
}

/**
 * The line a task on `line` of `before` sits on in `after` (the same note once
 * a pending editor draft was saved): the same task line, the same occurrence
 * of it. null when that line is not a task or the draft removed or changed it.
 */
function remapTaskLine(before: string, after: string, line: number): number | null {
  if (before === after) return line
  const was = before.split('\n')
  const text = was[line]
  const tasks = extractTasks(before)
  if (text === undefined || !tasks.some((t) => t.line === line)) return null
  const nth = tasks.filter((t) => t.line < line && was[t.line] === text).length
  const now = after.split('\n')
  return extractTasks(after).filter((t) => now[t.line] === text)[nth]?.line ?? null
}

const BAD_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

/**
 * A folder path typed by the user, cleaned for every OS, or the reason it
 * can't be one. `existing` gives the vault's spelling of a folder that is
 * already there (case-insensitively) or null; those segments are kept as they
 * are on disk and only the new ones are checked.
 */
function cleanFolderPath(input: string, existing: (path: string) => string | null = () => null): { path: string } | { error: string } {
  const segs: string[] = []
  for (const raw of input.replace(/\\/g, '/').split('/')) {
    const seg = raw.trim()
    if (!seg) continue
    const known = existing([...segs, seg].join('/'))
    if (known !== null) {
      segs.splice(0, segs.length, ...known.split('/'))
      continue
    }
    if (seg === '.' || seg === '..') return { error: 'A folder name can’t be . or ..' }
    if (seg.startsWith('.')) return { error: 'Folders starting with a dot are hidden from the brain' }
    if (BAD_NAME_CHARS.test(seg)) return { error: 'Folder names can’t contain < > : " | ? *' }
    if (RESERVED_NAME.test(seg)) return { error: `“${seg}” is a reserved name on Windows` }
    // Windows drops trailing dots and spaces; do it up front so the name round-trips.
    const clean = seg.replace(/[. ]+$/, '')
    if (!clean) return { error: 'Give the folder a name' }
    segs.push(clean)
  }
  if (segs.length === 0) return { error: 'Give the folder a name' }
  const path = segs.join('/')
  if (isIgnoredPath(`${path}/x.md`)) return { error: `${path} would be skipped by the brain (ignored folder name)` }
  return { path }
}

/** Lowercased folder path → the vault's spelling (the first seen), per folder Set: sets are copy-on-write, so one index serves until the folders change. */
const folderCase = new WeakMap<Set<string>, Map<string, string>>()

function folderCaseIndex(folders: Set<string>): Map<string, string> {
  let index = folderCase.get(folders)
  if (!index) {
    index = new Map()
    for (const f of folders) {
      const lower = f.toLowerCase()
      if (!index.has(lower)) index.set(lower, f)
    }
    folderCase.set(folders, index)
  }
  return index
}

/**
 * Where the Bio star's folder is, as the vault spells it: `Bio` under the vault's home (`D/Bio` with several roots), or the
 * spelling an existing folder has (`bio` on Windows is the same folder). When there is none it is the plain name: the graph
 * only marks a folder that exists, and `makeBio` makes it under that name.
 */
function bioFolderIn(folders: Set<string>, home: string): string {
  const want = `${home}${BIO_FOLDER}`
  if (folders.has(want)) return want
  const known = folderCaseIndex(folders).get(want.toLowerCase())
  return known !== undefined && known.length === want.length ? known : want
}

/** What a brief row shows or acts on, as one comparable string. */
function briefRowKey(t: BriefTask): string {
  return [t.noteId, t.line, t.text, t.reason, t.noteTitle, t.notePath, t.projectId, t.projectTitle, t.section].join('\u0000')
}

/** True when two briefs list the same tasks the same way (the store keeps the old object, so nothing redraws). */
function sameBrief(a: DailyBrief, b: DailyBrief): boolean {
  if (a.date !== b.date || a.total !== b.total || a.noteIds.length !== b.noteIds.length) return false
  if (a.noteIds.some((id, i) => id !== b.noteIds[i])) return false
  for (const section of ['overdue', 'today', 'next'] as const) {
    const x = a[section]
    const y = b[section]
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (briefRowKey(x[i]!) !== briefRowKey(y[i]!)) return false
  }
  return true
}

const IMAGE_NAME = /^(.*?)(\.(?:png|jpe?g|webp|gif|bmp|avif))$/i

/**
 * The file name a picture is saved under: its own name made safe on every OS
 * and inside `![[embeds]]` (no `[ ] # ^ |`, nothing Windows refuses, no
 * reserved device names, no leading dot that would hide it). null when the
 * name has no picture extension.
 */
function cleanImageName(raw: string): string | null {
  const file = raw.replace(/\\/g, '/').split('/').pop() ?? ''
  const m = IMAGE_NAME.exec(file.trim())
  if (!m) return null
  const stem = slugifyTitle((m[1] ?? '').replace(/[\u0000-\u001f]/g, ' '))
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim()
  if (!stem) return null
  // `CON.backup.png` is as reserved as `con.png` on Windows: only a prefix frees the name.
  return `${RESERVED_NAME.test(stem) ? `_${stem}` : stem}${m[2] ?? '.png'}`
}

/**
 * Bytes as a Uint8Array of this realm, or null. Data relayed through
 * Electron's context bridge or posted from another window may be a typed
 * array of another realm (so `instanceof` fails) or a plain ArrayBuffer.
 */
function asBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  if (Object.prototype.toString.call(v) === '[object ArrayBuffer]') return new Uint8Array(v as ArrayBuffer)
  return null
}

/** PNG signature (`\x89PNG`): Concept Forge sends PNGs, and the file is saved as one. */
function isPng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
}

export interface AetherState {
  adapter: VaultAdapter | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  notes: Map<NoteId, ParsedNote>
  graph: GraphData | null
  search: SearchIndex
  controller: BrainController
  /** Bumped when notes/graph change so selectors can memoize cheaply. */
  revision: number
  /** Roots on disk (`adapter.roots`); more than one = a multi-root vault (drives such as D:\ and F:\). */
  roots: VaultRootInfo[]
  /** Every folder in the vault (vault paths, root '' excluded). */
  folders: Set<string>
  /** System layout: folders whose direct children are always shown (persisted per vault location). */
  expandedFolders: Set<string>

  view: View
  selectedId: NoteId | null
  hoveredId: NoteId | null
  editorId: NoteId | null
  draft: string | null
  dirty: boolean
  history: NoteId[]
  historyIndex: number
  paletteOpen: boolean
  helpOpen: boolean
  filters: Filters
  settings: Settings
  activeTag: string | null
  toasts: Toast[]
  review: Record<NoteId, ReviewEntry>
  fps: number

  openVault(adapter: VaultAdapter): Promise<void>
  reload(): Promise<void>
  applyExternal(changes: VaultChange[]): void

  /** Select a note, ghost or folder node (null clears). */
  select(id: NoteId | null, opts?: { fly?: boolean }): void
  hover(id: NoteId | null): void
  /** Notes open in the editor; ghosts get created; folders expand/collapse and get selected. */
  openNote(id: NoteId, opts?: { fly?: boolean; view?: View }): void
  closeEditor(): void
  goBack(): void
  goForward(): void
  /** Walk the selection's link neighbors (a folder: its parent and children). */
  cycleNeighbor(dir: 1 | -1): void

  setView(view: View): void
  setPalette(open: boolean): void
  setHelp(open: boolean): void

  setDraft(text: string): void
  saveDraft(): Promise<void>
  /**
   * Create a new note at `path` (create-only: when anything is there on disk
   * or in the store, in any letter case, it becomes `<name> 2.md`, ` 3` …);
   * returns the id written. Never replaces a file.
   */
  writeNote(path: string, content: string, opts?: { open?: boolean; fly?: boolean }): Promise<NoteId>
  /** A new blank note `<folder>/<title>.md` (never overwrites: suffixed on a clash), opened in the editor. */
  createNote(folder: string, title: string): Promise<NoteId | null>
  deleteNote(id: NoteId): Promise<void>
  renameNote(id: NoteId, toPath: string): Promise<NoteId>
  moveToArea(id: NoteId, area: Exclude<Area, 'untagged'>): Promise<NoteId>
  patchFrontmatter(id: NoteId, patch: Record<string, unknown>): Promise<void>
  createGhost(id: NoteId): Promise<void>
  capture(text: string, tags?: string[]): Promise<NoteId>
  openDaily(): Promise<void>
  appendLink(fromId: NoteId, toId: NoteId): Promise<void>

  setFilters(patch: Partial<Filters>): void
  toggleArea(area: Area): void
  toggleTag(tag: string): void
  /** Light up (or stop lighting up) every body of one of the legend's kinds. */
  toggleBody(body: LegendBody): void
  clearFilters(): void
  setActiveTag(tag: string | null): void
  setSettings(patch: Partial<Settings>): void
  /** Pictures: medium → large → extra large icons → medium (`z`). */
  cyclePictureSize(): void
  cycleColorMode(): void
  /** Cycle constellation → orbit → system. */
  toggleLayout(): void
  /** System layout: orbits moving / paused. */
  toggleMotion(): void
  /** System layout: calm orbits on / off (⇧O). */
  toggleCalm(): void
  /** Corona ejections from stars that need attention on / off (⇧F). */
  toggleFlares(): void
  /** The asteroids (reminders that float by) on / off (⇧A). */
  toggleAsteroids(): void
  /**
   * Suns open into planets, then moons. The level of each sun the user opened or closed by hand (the rest are at `sunDefault`):
   * 0 closed, 1 its planets, 2 its planets and its moons.
   */
  sunOwn: Record<NoteId, SunLevel>
  sunDefault: SunLevel
  /** How open a sun is now. */
  sunLevelOf(id: NoteId): SunLevel
  setSunLevel(id: NoteId, level: SunLevel): void
  /** Step a sun through its levels (closed → planets → planets and moons → closed; a level with nothing in it is skipped). */
  cycleSun(id: NoteId, direction?: 1 | -1): void
  /** The user chose a level for a sun (the sun bar): it sets it and plays the run, rising when it opens further, falling when it closes. */
  chooseSun(id: NoteId, level: SunLevel): void
  /** Open or close every sun at once. */
  setAllSuns(level: SunLevel): void
  /** Open every sun, or close every one when any is open (⇧S). */
  toggleAllSuns(): void
  /** Suns open and close on / off (settings.suns). */
  toggleSuns(): void
  /** What the sun holds: planets, moons and what is always shown. */
  sunCountsOf(id: NoteId): SunCounts
  /** A click on a body in the 3D view: its sound, and a closed sun opens. */
  pickBody(id: NoteId): void
  /** Notes sound on / off (⇧M). */
  toggleSound(): void

  /** Where new notes go: '' for one root, `<first mount>/` for several. */
  homePrefix(): string
  /** Expand / collapse a folder (its subfolders are always shown while expanded). */
  toggleFolder(path: string): void
  setFolderDepth(n: number): void
  /**
   * Select a folder's node and fly to it, switching to the system layout (and
   * expanding its parent) when needed, and leaving a view that covers the
   * graph (the board, review, capture).
   */
  showFolder(path: string, opts?: { keepView?: boolean }): void
  /** Create a folder on disk (a new planet); returns its path, or null (with a toast) when it can't. */
  createFolder(path: string): Promise<string | null>
  /**
   * Make a folder a project star by writing its folder note `<folder>/<name>.md`.
   * `quiet` (several at once): no success toast, the board's project stays,
   * and a failure goes to `onError` instead of a toast.
   */
  makeProject(folderPath: string, opts?: { quiet?: boolean; onError?: (message: string) => void }): Promise<NoteId | null>
  /**
   * Forget which notes and folders you use: every star's brightness goes back to calm. The log lives only on this computer; this empties it
   * (and its saved copy) for the vault that is open.
   */
  forgetActivity(): void
  /**
   * Mark a folder as a galaxy (`scale: galaxy` in its project note) or as a plain star again (the key goes). A folder that is not a
   * project yet becomes one first (`makeProject`). The line goes into the project note the graph itself binds to the folder
   * (`bindProjects`). Resolves with whether the note now says what was asked (also when it already did); a refusal (read-only, a
   * drive, Archive, broken frontmatter, a write that did not land) is a toast. Whether the mark COUNTS (how deep galaxies nest, how
   * many there can be) is the graph's to say: the toast says so when it does not, and the inspector keeps saying it.
   */
  setFolderScale(folderPath: string, scale: 'galaxy' | 'star'): Promise<boolean>
  /**
   * Make several folders stars at once (Find projects): one graph rebuild per
   * chunk and one toast. Resolves with how many became stars (already ones
   * count) and the first failure, if any.
   */
  makeProjects(folderPaths: readonly string[]): Promise<{ made: number; failed: number; error: string | null }>
  /**
   * Make the Bio star: the folder `Bio` at the vault's home with a page each for sleep, food, meds, exercise, drugs and mental
   * health (`planBio`). Only the missing pages are written, never over anything, and the camera flies to the star. Resolves
   * with how many pages it wrote (0: they were all there, or it could not).
   */
  makeBio(): Promise<number>
  /** Fly to the Bio star (⇧I); when the vault has none yet, a toast offers to make it. */
  goToBio(): void
  /** Show a file or folder in the OS file manager (desktop). */
  reveal(path: string): Promise<void>
  /** A form a command asked for; the component that owns it opens it and clears this (`window.prompt` does not exist in Electron). */
  formRequest: FormRequest | null
  /** Open an inline form from a command: 'project' opens the board's new-project form, 'note' / 'folder' the folder inspector's; null clears. */
  requestForm(form: FormRequest | null): void

  toast(text: string, kind?: Toast['kind'], action?: ToastAction): void
  dismissToast(id: number): void
  /** Run a toast's action (the newest one that has an action when no id is given). */
  toastAction(id?: number): boolean
  reviewMark(id: NoteId, outcome: ReviewOutcome): Promise<void>
  setFps(fps: number): void

  /** Live progress while a vault loads (listing, reading, parsing, indexing). */
  loadProgress: { label: string; done: number; total: number } | null
  setLoadProgress(p: { label: string; done: number; total: number } | null): void

  /** Project selected on the Projects board (a note id). */
  projectId: NoteId | null
  selectProject(id: NoteId | null): void
  /**
   * Tick/untick the task on a raw-file line; writes `[x] … ✅ date` into the note.
   * Task lines count in `from`, the text the caller showed (the editor's draft,
   * a board card), else in the saved note; the store finds that task again in
   * the file it rewrites (a pending draft is saved first), so the line it
   * ticks can differ from `line`. Resolves to that line and the note's text
   * after, for an Undo that reopens the same task (`toggleTask(id, line,
   * !done, after)`); null when nothing was written (a failure is toasted).
   */
  toggleTask(id: NoteId, line: number, done: boolean, from?: string): Promise<{ line: number; after: string } | null>
  /** Append a task under `## To do` (created if missing). */
  addTask(id: NoteId, text: string, section?: string): Promise<NoteId | null>
  /** Replace a task's text (`line` and `from` as for `toggleTask`). */
  editTask(id: NoteId, line: number, text: string, from?: string): Promise<void>
  /** Remove a task line; the toast offers Undo (`line` and `from` as for `toggleTask`). */
  deleteTask(id: NoteId, line: number, from?: string): Promise<void>
  /** Move a task up / down within its section (`line` and `from` as for `toggleTask`). */
  moveTask(id: NoteId, line: number, dir: -1 | 1, from?: string): Promise<void>
  createProject(name: string, summary?: string): Promise<NoteId | null>
  /**
   * Rewrite a project's title / status / summary / tags / folder. With
   * `renameFile`, a new title also moves `Projects/Old.md` to `Projects/New.md`
   * (folder notes keep their name, and so does a note other notes link to by
   * its path). The old title and file name stay as aliases so `[[links]]`
   * keep resolving; `folder:` is written relative to the note's drive.
   * Returns the (possibly new) id; errors toast.
   */
  updateProject(id: NoteId, patch: ProjectPatch & { renameFile?: boolean }): Promise<NoteId>
  archiveProject(id: NoteId): Promise<void>
  /** Delete the project note (the UI confirms first). Its folder stays on disk. */
  deleteProject(id: NoteId): Promise<void>

  /* ---- v0.4: pictures, the Today hub, the Concept Forge link ---- */

  /** Every image file of the vault (vault path → asset). */
  assets: Map<string, VaultAsset>
  /** Today's brief (recomputed with every graph rebuild), null before a vault is ready. */
  brief: DailyBrief | null
  /** Recompute the brief; rebuilds the graph when the day changed (App calls it every minute and on focus). */
  refreshBrief(): void
  /** Turn the Today hub on if needed, select it and fly to it (its brief shows in the Inspector). */
  showToday(): void
  /** Select a node and fly to it without opening it, leaving any view that covers the graph (the palette's Shift+Enter). */
  showNode(id: NoteId): void
  /** Open a picture in the OS default app (desktop), else explain why not. */
  openImage(path: string): Promise<void>
  /**
   * Save picture files into the vault, create-only (`name 2.png` when taken).
   * Target: `folder`, else the selected folder, else the selected project's
   * Critique planet, else `<home>Inbox`. Returns the vault paths written.
   * `quiet` (a board adding its own pictures): the first new picture is not
   * selected, there is no "Added" toast, and files refused or too big are the
   * caller's to report (a vault that cannot save pictures is still said).
   */
  importImages(files: { name: string; data: Uint8Array }[], folder?: string, opts?: { quiet?: boolean }): Promise<string[]>
  /**
   * The folder `importImages` would save into right now (`folder`, the
   * selection, else `<home>Inbox`), spelled as on disk; null without a vault.
   * For the drop overlay's "Drop pictures into …".
   */
  importTarget(folder?: string): string | null
  /**
   * A preview of a picture at most `size` px on its longer side, from the
   * vault adapter (a video: one still frame of it); null when the adapter
   * has none, it is empty or it fails. Never rejects.
   */
  preview(path: string, size: number): Promise<Blob | null>
  /** Projects a Concept Forge drawing can be saved to (active first). */
  forgeProjects(): ForgeProject[]
  /** File a graded drawing (PNG + critique note) into a project's Critique planet. Rejects with a readable message. */
  saveCritique(input: CritiqueSave): Promise<CritiqueSaved>
  /**
   * Where imported AI chats go: `<home>Resources/AI Chats` when the vault has
   * a Resources folder, else `<home>AI Chats` (spelled as on disk).
   */
  chatImportBase(): string
  /**
   * Import Claude and ChatGPT chats read from their data exports: plan
   * against the vault (`planChatImport`), ask `confirm` with the plan, then
   * create every new note and picture (never over anything), rewrite the
   * transcript of each chat that grew, and apply it all as one batch. Null
   * when there is nothing to do, it was cancelled or it can't be done (the
   * reason is toasted).
   */
  importChats(input: ChatImportInput): Promise<ChatImportResult | null>

  /* ---- v0.6: star galleries ---- */

  /**
   * The project star (its folder's vault path) whose gallery the graph is
   * built with: every picture under it floats around it in 3D (system layout
   * only). Not persisted: the camera opens and folds galleries.
   */
  gallery: string | null
  /** Show the gallery of this star (a folder id), or none (null): rebuilds the graph when its cards change. */
  setGallery(star: NoteId | null): void
  /**
   * Shift+G: fold the open gallery, else open the gallery of the selected
   * star (or of the star the selection belongs to, else the star the camera
   * is closest to) and fly there.
   */
  toggleGallery(): void
  /** Shift+H: leave a folder out of the brain (nothing on disk changes); the toast offers Undo. */
  hideFolder(path: string): Promise<void>
  /** Let a folder left out with hideFolder back in. */
  unhideFolder(path: string): Promise<void>

  /* ---- reference boards (docs/REFERENCE-BOARD.md) ---- */

  /** The board open in the Boards view (its note's vault path), or null for the list of boards. Kept when the view is left, so `8` comes back to it. */
  boardPath: string | null
  /** The board last open (also remembered per vault): `8` from the list goes back to it. */
  lastBoardPath: string | null
  /** Every board of the vault (notes with `type: board`), the most recently updated first. */
  boards(): ParsedNote[]
  /**
   * `8` and `⇧ B`: from another view, the Boards view on the board last open (else the list); inside it, the list of boards, and from
   * the list the board last open again.
   */
  openBoards(): void
  /** Open a board in the Boards view. Refuses (with a toast) a path that is not a board note of the vault. */
  openBoard(path: string): void
  /** Back to the list of boards (the board's own changes are saved by the view as it goes). */
  closeBoard(): void
  /**
   * Make a board: `<home>Boards/<Title>.md` through the create-only note path, its title and file name unique (`Title 2`, `Title 3` ...),
   * and open it (`open: false` leaves the view alone, for a caller that goes on to add pictures). Resolves with the path, or null (with
   * a toast) when it could not be made.
   */
  newBoard(title?: string, opts?: { open?: boolean }): Promise<string | null>
  /**
   * Put pictures of the vault on a board (`boardPath`, else the board open or last open) without opening it: the note is rewritten
   * through the exclusive queue, the new pictures packed to the right of what is there. A board that is open in the view saves first
   * and then reloads by itself. Resolves with how many were added (a picture already on the board is not added twice).
   */
  addPicturesToBoard(picturePaths: readonly string[], boardPath?: string): Promise<number>
  /** The folder a board's own pictures go in (dropped or pasted ones): next to the note, named like it. */
  boardFolderOf(boardPath: string): string
  /**
   * The board note's text as it is on disk now (a pending editor draft is saved first, changes the watcher has not reported yet are
   * applied), or null with a toast when it is not a board or is gone. `quiet` (a reload of a board that is already open, whose view
   * says what became of it): null without that toast. The docked host's `load`.
   */
  readBoard(path: string, opts?: { quiet?: boolean }): Promise<string | null>
  /**
   * Write a board note. `expected` is the text the board was read from (or last saved as): when the file now holds anything else the
   * save is refused with a `BoardChangedOutsideError` and nothing is written; null skips that check. Rejects with a readable message
   * when the note is gone, the vault read-only, the text not a board, or the editor holds unsaved edits of the note. Starts from the
   * file on disk and runs after any other rewrite of the note. The docked host's `save`; it never toasts (the view does).
   */
  saveBoard(path: string, text: string, expected: string | null): Promise<void>
  /**
   * A picture of the vault whole (at most 64 MB), for the board at full size; null when it cannot be read. An adapter that says why
   * there is none (the desktop's: 'missing', 'too-large' for a file over 64 MB or a header that claims over 150 megapixels,
   * 'unreadable') makes this reject with an Error carrying that `reason`, which the picture cache keeps for the placeholder; any other
   * adapter (web, memory), and a failed read, give null.
   */
  readPicture(path: string): Promise<Blob | null>
  /**
   * Save pictures into a board's own folder, create-only, one graph rebuild for the batch, nothing selected and no success toast.
   * Resolves with the vault path of each file in the order given, null for one that was refused or could not be written. A folder the
   * vault leaves out is replaced by `<folder> pictures` for this and the next calls.
   */
  importBoardPictures(boardPath: string, files: { name: string; data: Uint8Array }[]): Promise<(string | null)[]>
  /** Leave the Boards view, select a picture's node in the brain and fly to it. */
  showPicture(path: string): void
}

/**
 * Pictures under a folder, subfolders included, except those in `leaves`: the galaxies inside it (`galaxiesIn`), which take their
 * pictures with them, so the count is the gallery's own.
 */
export function picturesUnder(assets: Map<string, VaultAsset>, folder: string, leaves: readonly string[] = []): number {
  const inside = `${normalizeFolderPath(folder)}/`
  let n = 0
  for (const path of assets.keys()) if (path.startsWith(inside) && (leaves.length === 0 || !underAny(path, leaves))) n++
  return n
}

/** The folders of the galaxies inside `folder` that count in `graph` (marked folders that are galaxies), by path. */
export function galaxiesIn(graph: GraphData | null, folder: string): string[] {
  if (!graph) return []
  const marked: string[] = []
  for (const n of graph.nodes) if (n.folder?.galaxyLevel !== undefined) marked.push(n.folder.path)
  return galaxiesInside(marked, normalizeFolderPath(folder))
}

/**
 * The project star a node belongs to (its folder id): the star itself, a
 * gallery card's star, else the nearest project star up its parents (a
 * project's note orbits its star). Null when there is none.
 */
export function starOf(graph: GraphData | null, id: NoteId | null): NoteId | null {
  if (!graph || id === null) return null
  let node = graph.nodes[graph.index.get(id) ?? -1]
  if (node?.image?.gallery) return node.image.gallery.star
  for (let steps = 0; node && steps < 64; steps++) {
    if (node.folder?.role === 'project') return node.id
    node = node.parent === null ? undefined : graph.nodes[graph.index.get(node.parent) ?? -1]
  }
  return null
}

/** An export read by the UI (see `importChats`). */
export interface ChatImportInput {
  archive: ChatArchive
  /** The export's picture files (paths in the plan's `from`) and how to read one. */
  pictures?: { files: string[]; read(path: string): Promise<Uint8Array> }
  /** Asked before anything is written; false cancels. */
  confirm?: (plan: ChatImportPlan, base: string) => boolean | Promise<boolean>
}

export interface ChatImportResult {
  base: string
  created: number
  updated: number
  unchanged: number
  pictures: number
  /** Files that could not be written, with the reason. */
  failed: string[]
  /** The first chat written or updated (what Show flies to), or null. */
  first: NoteId | null
  /** True when another vault was opened while it ran (the rest was not written). */
  stopped: boolean
}

/** A project a graded drawing can go to (the Forge window's picker). */
export interface ForgeProject {
  id: NoteId
  title: string
  status: string | null
  /** Home folder, or null when the project has none yet (created on save). */
  home: string | null
  /** Folder the critique lands in (its Critique planet; created on save when missing). */
  critique: string
}

/** One graded drawing (see `AetherState.saveCritique`). */
export interface CritiqueSave {
  projectId: NoteId
  title: string
  /** PNG bytes. */
  png: Uint8Array
  /** The grader's raw grade object (read with `normalizeGrade`), or null. */
  grade?: unknown
  /** First fix due tomorrow (default true). */
  practiceTomorrow?: boolean
}

export interface CritiqueSaved {
  noteId: NoteId
  notePath: string
  imagePath: string
  /** Project title. */
  project: string
}

let toastSeq = 1
let unwatch: (() => void) | null = null

/** "12 pictures", "9 pictures and 3 videos", or "480 of 900 pictures" when the gallery is capped. */
function galleryCount(cards: number, total: number, videos = 0): string {
  if (cards < total) return `${cards.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} pictures`
  const pics = cards - videos
  if (videos === 0) return `${cards} picture${cards === 1 ? '' : 's'}`
  if (pics === 0) return `${videos} video${videos === 1 ? '' : 's'}`
  return `${pics} picture${pics === 1 ? '' : 's'} and ${videos} video${videos === 1 ? '' : 's'}`
}

export const useAether = create<AetherState>()((set, get) => {
  const controller = new BrainController()
  const settings = loadSettings()
  controller.colorMode = settings.colorMode
  controller.layoutMode = settings.layoutMode
  controller.bloom = settings.bloom
  controller.hubLabels = settings.hubLabels
  controller.motion = settings.motion
  controller.calm = settings.calm
  controller.suns = settings.suns
  controller.flares = settings.flares
  controller.asteroids = settings.asteroids
  controller.showThumbnails = settings.thumbnails
  controller.galleries = settings.starGalleries
  controller.pictureSize = settings.pictureSize

  controller.events = {
    onSelect: (id) => get().select(id),
    onPick: (id) => get().pickBody(id),
    onOpen: (id) => get().openNote(id, { fly: true }),
    onHover: (id) => set({ hoveredId: id }),
    onGallery: (star) => get().setGallery(star),
    // A failed layout leaves every body at the origin (one clump, no orbits): say so, with the reason, so it can be sent on.
    onLayoutError: (message) => get().toast(`The layout stopped: ${message}. Bodies stay piled up until it runs again.`, 'error'),
  }
  /** The first gallery of a session says how it works (later ones open quietly). */
  let galleryHinted = false

  /**
   * Selecting a body a closed sun is holding back (a search, a link, a jump from the keyboard) opens the suns it hangs in, as far
   * as it needs: its sun at the level of its tier, that sun's sun at the level of its own, and so on up to a galaxy.
   */
  const openSunsFor = (id: NoteId): void => {
    const { graph, settings } = get()
    if (!graph || !settings.suns || settings.layoutMode !== 'system') return
    const i = graph.index.get(id)
    if (i === undefined) return
    const { owners, tiers } = cosmosOf(graph)
    let cur = i
    for (let hop = 0; hop < 16; hop++) {
      const o = owners[cur]!
      if (o < 0) break
      const need = tiers[cur]! as SunLevel
      const sun = graph.nodes[o]!.id
      if (need > get().sunLevelOf(sun)) get().setSunLevel(sun, need)
      cur = o
    }
  }

  /**
   * Video stills and model stills already asked for, by path, size and file
   * version (newest last): taking one decodes the video or draws the model, so
   * the scene, the inspector and a note's embeds share it. Pictures go
   * straight through. Emptied for another vault.
   */
  const stills = new Map<string, Promise<Blob | null>>()
  const STILLS_MAX = 64
  const stillFor = (path: string, size: number, fetch: () => Promise<Blob | null>): Promise<Blob | null> => {
    const take = () => fetch().then((blob) => stillOf(blob, size))
    if (!isVideoPath(path) && !isModelPath(path)) return take()
    const a = get().assets.get(path)
    const key = `${path}\n${size}\n${a?.mtime ?? ''}\n${a?.size ?? ''}`
    let p = stills.get(key)
    if (p) stills.delete(key)
    else {
      const made = take().catch(() => null)
      // No still this time (the browser could not decode it in time): asked again later, not kept.
      void made.then((blob) => blob === null && stills.get(key) === made && stills.delete(key))
      p = made
    }
    stills.set(key, p)
    for (const old of stills.keys()) {
      if (stills.size <= STILLS_MAX) break
      stills.delete(old)
    }
    return p
  }
  /** A rebuild for a gallery alone keeps today's brief (no note changed): set around that rebuild. */
  let keepBrief = false

  /** The brief the latest graph-options call computed: the store takes it together with the graph built from it. */
  let builtBrief: DailyBrief | null = null

  /**
   * Options for every graph build. Today's brief is computed here, so once
   * per rebuild (every note or folder change) and never out of step with the
   * hub's beams; the Today hub when `settings.todayHub`. Pictures: embedded
   * ones in every layout, moons only in the system layout, which alone has
   * folder nodes.
   */
  /** Every other file worth a moon (an mp3, a pdf, a zip), as the last scan found them: not state, nothing shows them but the graph. */
  let vaultFiles = new Map<string, VaultAsset>()
  const graphOptions: GraphOptionsFn = (folders, notes, assets, files) => {
    const { settings, adapter, roots, expandedFolders, brief: shown } = get()
    const date = todayIso()
    const fresh = keepBrief && shown?.date === date ? shown : dailyBrief(notes.values(), { date, folders })
    // Nothing on it changed: keep the object, so the Inspector and the top bar don't redraw.
    const brief = shown && sameBrief(shown, fresh) ? shown : fresh
    builtBrief = brief
    const system = settings.layoutMode === 'system'
    const opts: BuildGraphOptions = {
      images: { all: assets, moons: system && settings.imageMoons, files: files ?? vaultFiles, gallery: system ? get().gallery : null },
      // Orbit speed: how soon each thing needs you, from its open tasks. (A star's brightness is how much you use it: `computeActivity`.)
      urgency: { date },
    }
    if (settings.todayHub) opts.today = { brief }
    if (!system) return opts
    const mountLabels: Record<string, string> = {}
    for (const r of roots) if (r.mount) mountLabels[r.mount] = r.label
    opts.folders = {
      all: folders,
      rootTitle: adapter?.name ?? 'Vault',
      mountLabels,
      maxDepth: settings.folderDepth,
      expanded: expandedFolders,
      multiRoot: roots.length > 1,
      // The Bio star, when the vault has its folder: the one big, bright, blue star.
      bio: bioFolderIn(folders, homePrefixOf(roots)),
      // No Bio folder yet: a dormant blue star stands where it will be, so it can be seen and made with one click (a vault that can't be written to has nothing to make it with).
      bioPlaceholder: !!adapter && !adapter.readOnly,
    }
    return opts
  }

  const nodeOf = (graph: GraphData | null, id: NoteId | null) => (graph && id !== null ? graph.nodes[graph.index.get(id) ?? -1] : undefined)

  const syncHighlight = () => {
    const { filters, graph, search, notes } = get()
    if (!graph) return
    const anyFilter = filters.areas.size > 0 || filters.tags.size > 0 || filters.types.size > 0 || filters.bodies.size > 0 || filters.query.trim().length > 0
    if (!anyFilter) {
      controller.setHighlight(null)
      return
    }
    let ids: Set<NoteId> | null = null
    const q = filters.query.trim()
    if (q === 'is:orphan') ids = new Set(graph.orphans)
    else if (q === 'is:stale') {
      const cutoff = Date.now() - 90 * 86400000
      ids = new Set([...notes.values()].filter((n) => (n.meta.updated ? Date.parse(n.meta.updated) : 0) < cutoff).map((n) => n.meta.id))
    } else if (q) {
      ids = new Set(search.search(q, { limit: 500 }).map((h) => h.id))
    }
    const out = new Set<NoteId>()
    /** A note passes the area, type, tag and search filters. */
    const passes = (m: ParsedNote['meta']): boolean =>
      !(ids && !ids.has(m.id)) && !(filters.areas.size && !filters.areas.has(m.area)) && !(filters.types.size && !filters.types.has(m.type)) && !(filters.tags.size && ![...filters.tags].every((t) => m.tags.includes(t)))
    if (filters.bodies.size) {
      // The legend's kinds light up every node of the kind (a folder, a picture, a board, a note), whatever it is. The other filters,
      // when they are on too, still have to be passed: by notes, which are the only nodes with an area, a type or tags.
      const others = filters.areas.size > 0 || filters.tags.size > 0 || filters.types.size > 0 || ids !== null
      const folderKinds = folderBodies(graph)
      for (let i = 0; i < graph.nodes.length; i++) {
        const node = graph.nodes[i]!
        if (!legendBodiesIn(graph, i, folderKinds).some((b) => filters.bodies.has(b))) continue
        if (others) {
          const note = notes.get(node.id)
          if (!note || !passes(note.meta)) continue
        }
        out.add(node.id)
      }
    } else {
      for (const n of notes.values()) if (passes(n.meta)) out.add(n.meta.id)
    }
    // System layout: keep the folders that hold a match lit, so the structure still reads (not for the legend's kinds: lighting a
    // folder for every picture in it would light the whole sky).
    if (graph.folderSelection && !filters.bodies.size) {
      for (const id of [...out]) {
        let p = nodeOf(graph, id)?.parent ?? null
        while (p !== null && !out.has(p)) {
          out.add(p)
          p = nodeOf(graph, p)?.parent ?? null
        }
      }
    }
    controller.setHighlight(out)
  }

  /** Drop a selection / hover that is no longer in the graph (a folder left behind when leaving the system layout). */
  const pruneSelection = (graph: GraphData, before: GraphData | null) => {
    const { selectedId, hoveredId } = get()
    if (selectedId && !graph.index.has(selectedId)) {
      // A project star becomes its project note again.
      const project = nodeOf(before, selectedId)?.folder?.projectId ?? null
      if (project && graph.index.has(project)) get().select(project)
      else set({ selectedId: null })
    }
    if (hoveredId && !graph.index.has(hoveredId)) set({ hoveredId: null })
  }

  /**
   * How much each note is used, for the vault that is open (docs/COSMOLOGY.md, "A star's brightness is how much you use it"). Opening a note
   * and saving a change to it are what count. It stays on this computer, beside the other view settings, and `forgetActivity` clears it.
   */
  let activity = new ActivityLog()
  let activityRefresh: ReturnType<typeof setTimeout> | null = null
  let activitySave: ReturnType<typeof setTimeout> | null = null
  /** Work out every star's brightness for the graph that is showing and hand it to the scene (which recolours at once). */
  /** The reminders that float by as asteroids: dated tasks that are late or due soon, and notes tagged `reminder`. */
  const refreshReminders = () => {
    const { notes, status } = get()
    controller.setReminders(status === 'ready' ? remindersOf(notes, todayIso()) : [])
  }
  const refreshActivity = () => {
    const { graph, status } = get()
    controller.setActivity(graph && status === 'ready' ? computeActivity(graph, activity, Date.now()) : null)
  }
  const saveActivity = () => {
    activitySave = null
    const { adapter } = get()
    if (adapter) saveJson(ACTIVITY_KEY + adapter.location, activity.toJSON())
  }
  /** A note was opened or saved: count it, brighten its stars a moment later (a burst of interactions is one refresh), save a little after. */
  const interacted = (id: NoteId, kind: ActivityKind) => {
    if (isVirtualId(id) || !activity.record(id, kind, Date.now())) return
    activityRefresh ??= setTimeout(() => {
      activityRefresh = null
      refreshActivity()
    }, 250)
    activitySave ??= setTimeout(saveActivity, 3000)
  }
  // The window is going away (closed, or hidden): what was done in the last few seconds is saved now, not lost.
  const flushActivity = () => {
    if (!activitySave) return
    clearTimeout(activitySave)
    saveActivity()
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', flushActivity)
    if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', () => document.visibilityState === 'hidden' && flushActivity())
  }

  const setLoaded = (notes: Map<NoteId, ParsedNote>, graph: GraphData, folders: Set<string>, assets: Map<string, VaultAsset>) => {
    const before = get().graph
    set((s) => ({ notes, graph, folders, assets, brief: builtBrief, revision: s.revision + 1 }))
    controller.setGraph(graph)
    refreshActivity()
    refreshReminders()
    syncHighlight()
    pruneSelection(graph, before)
    const { editorId, dirty } = get()
    if (editorId && !notes.has(editorId)) {
      if (!dirty) set({ editorId: null, draft: null })
    } else if (editorId && !dirty) {
      set({ draft: notes.get(editorId)?.raw ?? null })
    }
  }

  /** Rebuild the graph from the notes we have (layout mode, folder depth, expanded folders, a setting or the day changed). */
  const rebuildGraph = () => {
    const { notes, folders, assets, settings, status, graph: before } = get()
    if (status !== 'ready') {
      controller.setLayoutMode(settings.layoutMode)
      return
    }
    const graph = buildGraph(notes, graphOptions(folders, notes, assets))
    set((s) => ({ graph, brief: builtBrief, revision: s.revision + 1 }))
    controller.setLayoutMode(settings.layoutMode, graph)
    refreshActivity()
    refreshReminders()
    syncHighlight()
    pruneSelection(graph, before)
  }

  let cancelSettledFly: (() => void) | null = null
  /** Fly to a node again once the layout settles (new or moved nodes reach their orbit after a transition). */
  const flyWhenSettled = (id: NoteId) => {
    cancelSettledFly?.()
    const stop = () => {
      off()
      clearTimeout(timer)
      if (cancelSettledFly === stop) cancelSettledFly = null
    }
    const off = controller.engine.onTick((eng) => {
      if (!eng.settled) return
      stop()
      if (get().selectedId === id) controller.flyTo(id)
    })
    const timer = setTimeout(stop, 6000)
    cancelSettledFly = stop
  }

  const saveExpanded = (expanded: Set<string>) => {
    const { adapter } = get()
    if (adapter) saveJson(EXPANDED_KEY + adapter.location, [...expanded])
  }

  /**
   * The vault's own spelling of an existing folder, compared case-insensitively
   * (exact match first), or null. On Windows and macOS `D/inbox` and `D/Inbox`
   * are one folder; writing under the other spelling would show it twice.
   */
  const folderSpelling = (path: string): string | null => {
    const { folders } = get()
    if (folders.has(path)) return path
    const known = folderCaseIndex(folders).get(path.toLowerCase())
    return known !== undefined && known.length === path.length ? known : null
  }

  /** `path` with every leading folder that exists spelled the vault's way (`Inbox` → `inbox` when that is on disk). */
  const canonicalFolder = (path: string): string => {
    const p = normalizeFolderPath(path)
    if (!p || get().folders.has(p)) return p
    let out = ''
    for (const seg of p.split('/')) {
      const next = out ? `${out}/${seg}` : seg
      out = folderSpelling(next) ?? next
    }
    return out
  }

  /** The board note at `path` (any spelling of its letter case) when the vault has one, else null. */
  const liveBoard = (path: string): ParsedNote | null => {
    const id = existingId(idFromPath(path))
    const note = id !== null && !isVirtualId(id) ? get().notes.get(id) : undefined
    return note && isBoard(note) ? note : null
  }

  /** The id of the note at `id` under any spelling (case-insensitive), or null. */
  const existingId = (id: NoteId): NoteId | null => {
    const { notes } = get()
    if (notes.has(id)) return id
    const lower = id.toLowerCase()
    for (const k of notes.keys()) if (k.length === id.length && k.toLowerCase() === lower) return k
    return null
  }

  /** Select a node and fly to it, leaving a view that covers the graph; flies again once the layout settles (a new node). */
  const showNode = (id: NoteId) => {
    if (COVERING_VIEWS.has(get().view)) set({ view: 'graph' })
    get().select(id, { fly: true })
    flyWhenSettled(id)
  }

  /**
   * Select a picture and fly to it. A picture that is not in the graph is a
   * moon to be: image moons on, the system layout, its folder shown.
   */
  const showImage = (path: string) => {
    const id = imageKey(path)
    if (!get().graph?.index.has(id)) {
      if (!get().settings.imageMoons) get().setSettings({ imageMoons: true })
      get().showFolder(folderOf(path))
    }
    if (get().graph?.index.has(id)) showNode(id)
  }

  /**
   * Changes held back while a multi-file write runs (`batched`): adapters
   * report each new file synchronously, and applying each one would rebuild
   * the whole graph once per picture of a drop. The writes' own changes and
   * the adapter's echoes are applied together, once, when the batch ends.
   */
  let holding = 0
  let held: VaultChange[] = []
  /** An import of AI chats is under way (one at a time: two would plan the same notes twice). */
  let chatImportRunning = false
  const batched = async <T>(fn: () => Promise<T>): Promise<T> => {
    holding++
    try {
      return await fn()
    } finally {
      holding--
      if (holding === 0 && held.length) {
        const changes = held
        held = []
        get().applyExternal(changes)
      }
    }
  }

  /** Create a folder (and its parents) unless the vault has it; applied at once (the adapter's addDir echo changes nothing). */
  const ensureFolder = async (path: string): Promise<void> => {
    const { adapter } = get()
    if (!path || get().folders.has(path) || !adapter?.createFolder) return
    await adapter.createFolder(path)
    get().applyExternal([{ kind: 'addDir', path }])
  }

  /** Lowercased paths of every picture the vault has (names a new picture must pass over). */
  const takenImages = (): Set<string> => {
    const out = new Set<string>()
    for (const p of get().assets.keys()) out.add(p.toLowerCase())
    return out
  }

  /**
   * Write a NEW picture `<dir>/<stem><ext>`, never replacing anything: a name
   * in `taken` (lowercased paths; the path written is added) or refused by
   * `skip` is passed over, and so is one the adapter refuses with EEXIST
   * (another letter case on disk, a file not reported yet), for
   * `<stem> 2<ext>`, ` 3` … Returns the path written.
   */
  const createAssetNew = async (
    dir: string,
    stem: string,
    ext: string,
    data: Uint8Array,
    taken: Set<string>,
    skip: (path: string) => boolean = () => false,
  ): Promise<string> => {
    const { adapter } = get()
    if (!adapter?.createAsset) throw new Error('This vault can’t save pictures')
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const path = `${dir ? `${dir}/` : ''}${n === 1 ? stem : `${stem} ${n}`}${ext}`
      if (taken.has(path.toLowerCase()) || skip(path)) continue
      try {
        await adapter.createAsset(path, data)
        taken.add(path.toLowerCase())
        return path
      } catch (err) {
        if (!isExistsError(err)) throw err
      }
    }
    throw new Error(`${stem}${ext} and the next ${MAX_SUFFIX - 1} numbered names are all taken`)
  }

  /** Report pictures just written as added (their watcher echo later changes nothing that matters). */
  const applyImageAdds = (added: { path: string; size: number }[]) => {
    const mtime = Date.now()
    const changes: VaultChange[] = added.filter((a) => !get().assets.has(a.path)).map((a) => ({ kind: 'add', path: a.path, mtime, size: a.size }))
    if (changes.length) get().applyExternal(changes)
  }

  /**
   * Where a project's critiques go: the child folder of its home named
   * `critique` in any letter case, else `<home>/Critique`. Home is its bound
   * folder, else the one a new project folder would get; `home` is null when
   * that folder is not on disk yet (it is created on the first save).
   */
  const critiqueTarget = (note: ParsedNote): { home: string | null; dir: string } => {
    const home = projectHomeOf(note)
    const dir = folderSpelling(`${home}/Critique`) ?? `${home}/Critique`
    return { home: get().folders.has(home) ? home : null, dir }
  }

  /** A project's home folder: its bound folder, else the one a new project folder would get (spelled as on disk). */
  const projectHomeOf = (note: ParsedNote): string => {
    const { folders, roots } = get()
    let home = projectFolderOf(note, folders) ?? defaultProjectFolder(note)
    // A `folder:` for a folder not made yet is written relative to the note's own drive.
    if (roots.length > 1 && !roots.some((r) => r.mount === mountOf(home, roots))) home = `${mountOf(note.meta.path, roots)}/${home}`
    return canonicalFolder(home)
  }

  /**
   * The writing half of `importChats`. Changes are held (`batched`) only
   * around short runs of writes, never across a whole import: while they are
   * held the store's copy of a note is not the disk's, so a long hold would
   * let edits made meanwhile start from old text. Folders and new notes go in
   * chunks (one rebuild each); pictures are read with nothing held, then
   * written in chunks; transcripts of grown chats go through `rewriteNote`
   * (draft saved first, the file on disk as the starting point). Stops when
   * another vault is opened.
   */
  const writeChatImport = async (plan: ChatImportPlan, input: ChatImportInput, base: string, adapter: VaultAdapter): Promise<ChatImportResult> => {
    const result: ChatImportResult = { base, created: 0, updated: 0, unchanged: plan.unchanged, pictures: 0, failed: [], first: null, stopped: false }
    const current = () => {
      if (get().adapter === adapter) return true
      result.stopped = true
      return false
    }
    // Every folder spelled the vault's way, and one spelling per folder within this import too
    // (a Claude/ folder on disk as claude/ is the same folder; so are two projects "Art" and "art").
    const spelled = new Map<string, string>()
    const spell = (dir: string): string => {
      let out = ''
      for (const seg of normalizeFolderPath(dir).split('/').filter(Boolean)) {
        const next = out ? `${out}/${seg}` : seg
        out = spelled.get(next.toLowerCase()) ?? folderSpelling(next) ?? next
        spelled.set(out.toLowerCase(), out)
      }
      return out
    }
    const place = (path: string): string => {
      const dir = spell(folderOf(path))
      return `${dir ? `${dir}/` : ''}${path.slice(path.lastIndexOf('/') + 1)}`
    }

    // Folders and notes, a chunk at a time.
    const taken = new Set([...get().notes.keys()].map((k) => k.toLowerCase()))
    const folders = plan.folders.map(spell)
    // Not spread: a planned note renders its text when first read, and that is done a chunk at a time below.
    const notes = plan.create.map((n) => ({ note: n, path: place(n.path) }))
    await batched(async () => {
      const changes: VaultChange[] = []
      for (const dir of folders) {
        if (!dir || get().folders.has(dir) || !adapter.createFolder || !current()) continue
        try {
          await adapter.createFolder(dir)
          changes.push({ kind: 'addDir', path: dir })
        } catch (err) {
          result.failed.push(`${dir}: ${errText(err)}`)
        }
      }
      if (changes.length) get().applyExternal(changes)
    })
    for (let i = 0; i < notes.length && current(); i += NOTE_CHUNK) {
      // Render the chunk first, with nothing held, letting the page breathe between notes (a parse each).
      const chunk: { path: string; kind: string; text: string }[] = []
      let slice = performance.now()
      for (const { note, path } of notes.slice(i, i + NOTE_CHUNK)) {
        try {
          chunk.push({ path, kind: note.kind, text: note.content })
        } catch (err) {
          result.failed.push(`${path}: ${errText(err)}`)
        }
        if (performance.now() - slice > 40) {
          await new Promise((r) => setTimeout(r, 0))
          slice = performance.now()
        }
      }
      if (!current()) break
      await batched(async () => {
        const changes: VaultChange[] = []
        const mtime = Date.now()
        for (const note of chunk) {
          if (!current()) break
          try {
            const done = await createNew(note.path, note.text, { taken })
            if (done) {
              changes.push({ kind: 'add', path: done.path, content: done.content, mtime })
              result.created++
              if (note.kind === 'chat') result.first ??= idFromPath(done.path)
            }
          } catch (err) {
            result.failed.push(`${note.path}: ${errText(err)}`)
          }
        }
        if (changes.length) get().applyExternal(changes)
      })
    }

    // Pictures: read with nothing held, written a chunk at a time under the exact
    // name the chat's note embeds (one already there is taken as that picture).
    if (plan.pictures.length && input.pictures && adapter.createAsset) {
      const read = input.pictures.read
      const create = adapter.createAsset.bind(adapter)
      let chunk: { path: string; data: Uint8Array }[] = []
      let bytes = 0
      const flush = async () => {
        const batch = chunk
        chunk = []
        bytes = 0
        if (!batch.length || !current()) return
        await batched(async () => {
          const changes: VaultChange[] = []
          const mtime = Date.now()
          for (const pic of batch) {
            try {
              await create(pic.path, pic.data)
              changes.push({ kind: 'add', path: pic.path, mtime, size: pic.data.byteLength })
              result.pictures++
            } catch (err) {
              if (!isExistsError(err)) result.failed.push(`${pic.path.slice(pic.path.lastIndexOf('/') + 1)}: ${errText(err)}`)
            }
          }
          if (changes.length) get().applyExternal(changes)
        })
      }
      for (const pic of plan.pictures) {
        if (!current()) break
        const path = place(pic.path)
        try {
          const data = await read(pic.from)
          if (data.byteLength > MAX_IMAGE_BYTES) throw new Error('larger than 40 MB')
          if (bytes > 0 && bytes + data.byteLength > PICTURE_CHUNK_BYTES) await flush()
          chunk.push({ path, data })
          bytes += data.byteLength
        } catch (err) {
          result.failed.push(`${path.slice(path.lastIndexOf('/') + 1)}: ${errText(err)}`)
        }
      }
      await flush()
    }

    for (const u of plan.update) {
      if (!current()) break
      // The new section is rendered before the note's queue is entered (a parse; nothing held meanwhile).
      let section: string
      try {
        section = u.section
      } catch (err) {
        result.failed.push(`${u.path}: ${errText(err)}`)
        continue
      }
      const done = await rewriteNote(u.noteId, (raw) => applyChatUpdate(raw, { heading: u.heading, section, updated: u.updated }) ?? raw, `update ${basenameOf(u.path)}`)
      if (done) {
        result.updated++
        result.first ??= u.noteId
      }
    }
    return result
  }

  /** The project a selection stands for: a project note, or the note of a project star. */
  const selectedProjectNote = (): ParsedNote | null => {
    const { selectedId, graph, notes } = get()
    if (selectedId === null) return null
    const id = isFolderId(selectedId) ? (nodeOf(graph, selectedId)?.folder?.projectId ?? null) : isVirtualId(selectedId) ? null : selectedId
    const note = id !== null ? notes.get(id) : undefined
    return note && isProjectNote(note) ? note : null
  }

  /** True for a folder a file can be written in: in a vault of several roots, inside one of them. */
  const insideRoot = (path: string): boolean => {
    const { roots } = get()
    return roots.length < 2 || roots.some((r) => r.mount === mountOf(path, roots))
  }

  /**
   * Save a dirty editor draft of `id` before a rewrite of that note starts
   * from the saved file. False (with a toast) when the draft is still unsaved
   * afterwards — the write failed, or more was typed: the rewrite must not
   * go ahead, it would replace the draft.
   */
  const flushDraft = async (id: NoteId, what: string): Promise<boolean> => {
    if (get().editorId !== id || !get().dirty) return true
    await get().saveDraft()
    if (get().editorId !== id || !get().dirty) return true
    get().toast(`Could not ${what}: the note has unsaved edits in the editor (save them first)`, 'error')
    return false
  }

  /**
   * Create a NEW note file; returns the path and text written. Nothing is
   * ever replaced: a name the store already has (in any letter case) or one
   * the brain skips (`CHANGELOG.md` would never show) is passed over, and
   * the adapter's `create` refuses a path where anything exists on disk (a
   * note the watcher has not reported yet, an ignored file, another letter
   * case on Windows and macOS), so the next name — ` 2`, ` 3` … before `.md`
   * — is tried. An adapter without `create` gets a read check first.
   * `content` may depend on the path finally used. With `suffix: false` only
   * `path` itself is tried: null when it is taken.
   */
  const createNew = async (
    path: string,
    content: string | ((path: string) => string),
    opts: { suffix?: boolean; taken?: Set<string> } = {},
  ): Promise<{ path: string; content: string } | null> => {
    const { adapter } = get()
    if (!adapter) throw new Error('No vault open')
    const base = normalizePath(path)
    // Lowercased ids of the notes there are; a caller making many notes passes one set (each id made is added).
    const taken = opts.taken ?? new Set([...get().notes.keys()].map((k) => k.toLowerCase()))
    const tries = opts.suffix === false ? 1 : MAX_SUFFIX
    for (let n = 1; n <= tries; n++) {
      const p = n === 1 ? base : base.replace(/(\.md)?$/i, ` ${n}.md`)
      if (taken.has(idFromPath(p).toLowerCase())) continue
      if (isIgnoredPath(p)) {
        // An ignored file name (`CHANGELOG.md`) gets a number; an ignored folder never shows anything.
        if (n > 1) throw new Error(`${folderOf(base) || 'That folder'} is skipped by the brain (ignored folder name)`)
        continue
      }
      const text = typeof content === 'string' ? content : content(p)
      try {
        if (adapter.create) await adapter.create(p, text)
        else if ((await adapter.read(p)) !== null) continue
        else await adapter.write(p, text)
        taken.add(idFromPath(p).toLowerCase())
        return { path: p, content: text }
      } catch (err) {
        if (!isExistsError(err)) throw err
      }
    }
    if (opts.suffix === false) return null
    throw new Error(`${base} and the next ${MAX_SUFFIX - 1} numbered names are all taken`)
  }

  /** Create a new note (see `createNew`: suffixed, never overwriting), show it, and return its id. */
  const addNote = async (path: string, content: string | ((path: string) => string), opts?: { open?: boolean; fly?: boolean }): Promise<NoteId> => {
    const made = await createNew(path, content)
    if (!made) throw new Error(`${path} is taken`)
    get().applyExternal([{ kind: 'add', path: made.path, content: made.content, mtime: Date.now() }])
    const id = idFromPath(made.path)
    if (opts?.open) get().openNote(id, { fly: opts.fly ?? true })
    else if (opts?.fly) get().select(id, { fly: true })
    return id
  }

  /** ` as <file name>` when a new note had to take another file name than the one asked for, else ''. */
  const numberedAs = (asked: string, id: NoteId): string => (idFromPath(asked).toLowerCase() === id.toLowerCase() ? '' : ` as ${fileNameOf(id)}.md`)

  /** Per-note queue of store rewrites (keyed by note id, case-insensitive). */
  const queues = new Map<string, Promise<unknown>>()

  /**
   * Run `task` once every earlier store rewrite of the same note has settled:
   * two quick edits (two ticks, a tick and a rename) never start from the
   * same text, so the second can't erase the first.
   */
  const exclusive = <T>(id: NoteId, task: () => Promise<T>): Promise<T> => {
    const key = id.toLowerCase()
    const run = (queues.get(key) ?? Promise.resolve()).then(task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    queues.set(key, tail)
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
    return run
  }

  /**
   * The note as it is on disk right now. A change the watcher has not
   * reported yet (an AI edit through the link, another app, a slow drive) is
   * applied first, so a rewrite never starts from a stale copy and erases
   * it. null (toasted as "Could not <what>") when the note or its file is
   * gone: an edit queued behind a rename or a delete of the note (the caller
   * still showed the old id) says so instead of vanishing. `quiet`: for a
   * caller that tells the user itself, null and no toast.
   */
  const freshNote = async (id: NoteId, what: string, quiet = false): Promise<ParsedNote | null> => {
    const { adapter } = get()
    const note = get().notes.get(id)
    if (!adapter) return null
    if (!note) {
      if (!quiet) get().toast(`Could not ${what}: the note was moved or deleted`, 'error')
      return null
    }
    let disk: string | null
    try {
      disk = await adapter.read(note.meta.path)
    } catch {
      disk = null
    }
    if (disk === null) {
      if (!quiet) get().toast(`Could not ${what}: ${note.meta.path} is no longer on disk`, 'error')
      return null
    }
    if (disk !== note.raw) {
      get().applyExternal([{ kind: 'change', path: note.meta.path, content: disk, mtime: Date.now() }])
      // Held while a batch of writes runs: the store still has the old text, so answer with the disk's.
      if (holding > 0) return parseNote({ path: note.meta.path, content: disk, mtime: Date.now() })
    }
    return get().notes.get(id) ?? null
  }

  /**
   * How many notes link to `id` by a path or a file name (`[[Projects/Gate]]`,
   * `[[Gate.md]]`, and on a drive vault `[[Projects/Gate]]` for
   * `D/Projects/Gate`, which resolves by file name): links a rename of the
   * file would break, since only a bare name is ever looked up as an alias.
   */
  const pathLinksTo = (id: NoteId): number => {
    const { notes, graph } = get()
    let count = 0
    // Each graph build resolves every link in place (`to`, `resolved`); no graph yet: look at every note.
    for (const src of graph ? (graph.backlinks.get(id) ?? []) : notes.keys()) {
      const n = notes.get(src)
      if (!n || src === id) continue
      const hit = n.links.some((l) => {
        if (!l.resolved || l.to !== id) return false
        const target = parseWikilinkRaw(l.raw).target
        return /[\\/]/.test(target) || /\.md$/i.test(target)
      })
      if (hit) count++
    }
    return count
  }

  /**
   * Remember where a note is in use (editor, selection, board) before it moves;
   * call the result with its new id once the move was applied (applying it
   * drops the old id from the editor and the selection).
   */
  const trackRename = (id: NoteId) => {
    const s = get()
    const open = s.editorId === id
    const selected = s.selectedId === id
    const project = s.projectId === id
    const from = s.notes.get(id)?.meta.path
    const board = from !== undefined && s.boardPath !== null && samePath(s.boardPath, from)
    const lastBoard = from !== undefined && s.lastBoardPath !== null && samePath(s.lastBoardPath, from)
    return (newId: NoteId, content: string) => {
      const to = get().notes.get(newId)?.meta.path ?? `${newId}.md`
      set((now) => ({
        projectId: project ? newId : now.projectId,
        // A board moved or renamed while it is open stays open.
        ...(board ? { boardPath: to } : {}),
        ...(lastBoard ? { lastBoardPath: to } : {}),
        history: now.history.map((h) => (h === id ? newId : h)),
        ...(open ? { editorId: newId, draft: content, dirty: false } : {}),
      }))
      // The key that 8 reads after a restart follows the board to its new name.
      if (board || lastBoard) saveLastBoard(get().adapter?.location, to)
      if (selected) get().select(newId)
    }
  }

  /**
   * Rewrite one note through `edit` (tasks, links); `updated` is stamped in
   * place. `line` (a task line, -1 for none) counts lines in `from` — the
   * text the caller showed — else in the note as the store held it when
   * called. Rewrites of one note run one at a time; each saves a pending
   * editor draft of the note first, starts from the file as it is on disk
   * (see `freshNote`), and follows `line` into it (`edit` gets the line to
   * use). Returns the text before and after and the line used, or null when
   * nothing changed or it failed (toasted as "Could not <what>").
   */
  const rewriteNote = (
    id: NoteId,
    edit: (raw: string, line: number) => string,
    what: string,
    line = -1,
    from?: string,
  ): Promise<{ before: string; after: string; path: string; line: number } | null> => {
    // A folder, ghost, picture or the Today hub is no note (a file could still carry such a name).
    if (isVirtualId(id)) return Promise.resolve(null)
    // What the caller showed, taken now: queued behind other edits, the note may change before this runs.
    const shown = from ?? get().notes.get(id)?.raw
    return exclusive(id, async () => {
      const { adapter } = get()
      // No such note when called: nothing to do. Gone since (renamed, deleted): freshNote says so.
      if (!adapter || shown === undefined) return null
      if (!(await flushDraft(id, what))) return null
      const note = await freshNote(id, what)
      if (!note) return null
      const at = line < 0 ? line : remapTaskLine(shown, note.raw, line)
      if (at === null) {
        get().toast(`Could not ${what}: that task has changed since it was shown`, 'error')
        return null
      }
      let content: string
      try {
        content = edit(note.raw, at)
      } catch (err) {
        get().toast(`Could not ${what}: ${errText(err)}`, 'error')
        return null
      }
      if (content === note.raw) return null
      content = touchUpdated(content)
      try {
        await adapter.write(note.meta.path, content)
      } catch (err) {
        get().toast(`Could not ${what}: ${errText(err)}`, 'error')
        return null
      }
      interacted(id, 'save')
      // A draft typed while the write was under way is kept (applyExternal says the file changed).
      if (get().editorId === id && !get().dirty) set({ draft: content })
      get().applyExternal([{ kind: 'change', path: note.meta.path, content, mtime: Date.now() }])
      return { before: note.raw, after: content, path: note.meta.path, line: at }
    })
  }

  /** `moveToArea` inside the note's queue (see `exclusive`). */
  const moveNoteToArea = async (id: NoteId, area: Exclude<Area, 'untagged'>): Promise<NoteId> => {
    if (isVirtualId(id) || !get().notes.has(id)) throw new Error('No such note')
    // The move starts from the saved file: an unsaved draft goes first (or the move waits).
    if (!(await flushDraft(id, 'move the note'))) return id
    // …and from the file as it is on disk now (an edit not reported yet is kept).
    const note = await freshNote(id, 'move the note')
    if (!note) return id
    const { roots } = get()
    const typeByArea: Partial<Record<Area, NoteType>> = { inbox: 'inbox', projects: 'project', areas: 'area', resources: 'resource' }
    let content = note.raw
    // A frontmatter that doesn't parse is moved as is rather than rewritten (and lost).
    if (!hasBrokenFrontmatter(note.raw)) {
      const patch: Record<string, unknown> = { updated: todayIso() }
      if (note.meta.status === 'unprocessed') patch['status'] = area === 'archive' ? 'done' : 'active'
      const t = typeByArea[area]
      if (note.meta.type === 'inbox' && t) patch['type'] = t
      content = updateFrontmatter(content, patch)
    }
    const { adapter } = get()
    if (!adapter) throw new Error('No vault open')
    // A note moves within its own root (D/Inbox/x.md → D/Archive/x.md), into the area folder as it is spelled there.
    const mount = mountOf(note.meta.path, roots)
    const folder = canonicalFolder(`${mount ? `${mount}/` : ''}${AREA_FOLDER[area]}`)
    const to = `${folder}/${basenameOf(note.meta.path)}.md`
    const clash = to !== note.meta.path ? existingId(idFromPath(to)) : null
    if (clash !== null && clash !== id) {
      get().toast(`${to} already exists; ${note.meta.title} stays where it is`, 'error')
      return id
    }
    const follow = trackRename(id)
    if (to !== note.meta.path) {
      await adapter.rename(note.meta.path, to)
    }
    await adapter.write(to, content)
    const changes: VaultChange[] = to !== note.meta.path ? [{ kind: 'unlink', path: note.meta.path }] : []
    changes.push({ kind: 'add', path: to, content, mtime: Date.now() })
    const newId = idFromPath(to)
    get().applyExternal(changes)
    if (newId !== id) follow(newId, content)
    else if (get().editorId === id) set({ draft: content, dirty: false })
    get().toast(`Moved to ${folder}`, 'success')
    return newId
  }

  /** `updateProject` inside the note's queue (see `exclusive`). */
  const rewriteProject = async (id: NoteId, patch: ProjectPatch & { renameFile?: boolean }): Promise<NoteId> => {
    const { adapter } = get()
    if (!adapter || isVirtualId(id)) return id
    if (adapter.readOnly) {
      get().toast('This vault is read-only', 'error')
      return id
    }
    if (!(await flushDraft(id, 'update the project'))) return id
    // Start from the file as it is now: a task an AI just added must survive a rename.
    const note = await freshNote(id, 'update the project')
    if (!note) return id
    const { renameFile, ...fields } = patch
    if (fields.title !== undefined) {
      const title = fields.title.replace(/\s+/g, ' ').trim()
      if (!title) {
        get().toast('A project needs a name', 'error')
        return id
      }
      fields.title = title
    }
    // Projects/Old.md → Projects/New.md when the name changes (a folder note keeps its folder's name).
    let to = note.meta.path
    if (renameFile && fields.title && fields.title !== note.meta.title) {
      const base = basenameOf(note.meta.path)
      const folder = note.meta.folder
      const folderNote = !!folder && folder.slice(folder.lastIndexOf('/') + 1).toLowerCase() === base.toLowerCase()
      const slug = slugifyTitle(fields.title)
      if (!folderNote && slug && slug !== base) {
        const candidate = `${folder ? `${folder}/` : ''}${slug}.md`
        const lower = idFromPath(candidate).toLowerCase()
        // Only the letter case changes: every link still resolves (paths and names match case-insensitively).
        const byPath = lower === id.toLowerCase() ? 0 : pathLinksTo(id)
        if ([...get().notes.keys()].some((k) => k !== id && k.toLowerCase() === lower)) {
          get().toast(`${candidate} already exists; the file keeps its name`)
        } else if (byPath > 0) {
          // [[Projects/Old]] can't be kept by an alias: renaming the file would break it.
          get().toast(`${plural(byPath, 'note links', 'notes link')} to ${note.meta.path} by its path; the file keeps its name`)
        } else {
          to = candidate
          // A sibling folder (Projects/Old/) is bound by name: keep it bound under the new name.
          const home = projectFolderOf(note, get().folders)
          if (fields.folder === undefined && home && !asString(note.frontmatter['folder'])) fields.folder = home
        }
      }
    }
    // `folder:` is written relative to the note's own drive, so adding or removing a drive keeps it bound.
    if (typeof fields.folder === 'string' && fields.folder.trim()) fields.folder = portableFolderRef(to, fields.folder, get().roots)
    let content: string
    try {
      // Every name the note answered to keeps resolving: its title as the app read it (a file name,
      // a setext heading) and, when the file is renamed, its old file name.
      content = setProjectFields(note.raw, fields, {
        oldTitle: note.meta.title,
        ...(to !== note.meta.path ? { keepAliases: [basenameOf(note.meta.path)] } : {}),
      })
    } catch (err) {
      get().toast(`Could not update ${note.meta.title}: ${errText(err)}`, 'error')
      return id
    }
    if (content === note.raw && to === note.meta.path) return id
    if (content !== note.raw) content = touchUpdated(content)
    const follow = trackRename(id)
    let wrote = false
    try {
      if (content !== note.raw) {
        await adapter.write(note.meta.path, content)
        wrote = true
      }
      if (to !== note.meta.path) await adapter.rename(note.meta.path, to)
    } catch (err) {
      get().toast(`Could not update ${note.meta.title}: ${errText(err)}`, 'error')
      if (wrote) {
        get().applyExternal([{ kind: 'change', path: note.meta.path, content, mtime: Date.now() }])
        if (get().editorId === id && !get().dirty) set({ draft: content })
      }
      return id
    }
    const mtime = Date.now()
    if (to === note.meta.path) {
      get().applyExternal([{ kind: 'change', path: to, content, mtime }])
      if (get().editorId === id && !get().dirty) set({ draft: content })
      return id
    }
    get().applyExternal([
      { kind: 'unlink', path: note.meta.path },
      { kind: 'add', path: to, content, mtime },
    ])
    const newId = idFromPath(to)
    follow(newId, content)
    return newId
  }

  /**
   * `saveCritique` without its error toast: the drawing as a create-only PNG
   * in the project's Critique planet (folders made when missing), then its
   * critique note next to it under the same name (a name is used only when
   * both files are free), both applied at once.
   */
  /**
   * The writing half of `importImages`: make the target folder when needed,
   * then each picture create-only. Null (with a toast) when the folder can't
   * be made. Runs inside `batched`, so the whole drop is one rebuild.
   * `results` lines up with `pictures`: where each was written, null for one
   * that failed. With `failures` given nothing is toasted: what went wrong is
   * put there instead (`index` is the picture's place in `pictures`, -1 for
   * the folder), for a caller that reports it its own way.
   */
  const writePictures = async (
    target: string,
    pictures: { name: string; data: Uint8Array }[],
    failures?: { index: number; message: string }[],
  ): Promise<{ dir: string; results: ({ path: string; size: number } | null)[] } | null> => {
    const say = (index: number, message: string) => (failures ? failures.push({ index, message }) : void get().toast(message, 'error'))
    let dir = target
    if (dir && !get().folders.has(dir)) {
      // A folder to make first (Inbox, a Critique planet): only under a name every OS takes.
      const clean = cleanFolderPath(dir, folderSpelling)
      if ('error' in clean) {
        say(-1, clean.error)
        return null
      }
      dir = clean.path
      try {
        await ensureFolder(dir)
      } catch (err) {
        say(-1, `Could not create ${dir}: ${errText(err)}`)
        return null
      }
    }
    const taken = takenImages()
    const results: ({ path: string; size: number } | null)[] = []
    const failed: string[] = []
    for (const [k, p] of pictures.entries()) {
      const m = IMAGE_NAME.exec(p.name)
      try {
        results.push({ path: await createAssetNew(dir, m?.[1] ?? p.name, m?.[2] ?? '', p.data, taken), size: p.data.byteLength })
      } catch (err) {
        results.push(null)
        failed.push(`${p.name}: ${errText(err)}`)
        failures?.push({ index: k, message: errText(err) })
      }
    }
    applyImageAdds(results.filter((r): r is { path: string; size: number } => r !== null))
    if (failed.length && !failures) get().toast(`Could not save ${failed[0]}${failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''}`, 'error')
    return { dir, results }
  }

  /**
   * Check and save picture files (the body of `importImages`, shared with a board adding its own). `paths` lines up with `files`: the
   * vault path each was saved under, null for one refused (not a picture, over 40 MB) or that could not be written, with the reason
   * in `failures` (`index` is the file's place in `files`, -1 for the folder). `quiet` toasts nothing about the files themselves.
   * Null when nothing could be tried: no vault ready, read-only, no picture support (toasted), or the folder can't be made.
   */
  const savePictures = async (
    files: { name: string; data: Uint8Array }[],
    folder: string | undefined,
    quiet: boolean,
  ): Promise<{ dir: string; paths: (string | null)[]; failures: { index: number; message: string }[] } | null> => {
    const { adapter, status } = get()
    if (!adapter || status !== 'ready') return null
    if (adapter.readOnly) {
      get().toast('This vault is read-only', 'error')
      return null
    }
    if (!adapter.createAsset) {
      get().toast('This vault can’t save pictures', 'error')
      return null
    }
    const paths: (string | null)[] = files.map(() => null)
    const failures: { index: number; message: string }[] = []
    const pictures: { name: string; data: Uint8Array }[] = []
    /** Where each of `pictures` came from in `files`. */
    const origin: number[] = []
    const refused: string[] = []
    const tooBig: string[] = []
    files.forEach((f, i) => {
      const name = cleanImageName(String(f.name))
      const data = asBytes(f.data)
      if (name === null || data === null) {
        refused.push(String(f.name))
        failures.push({ index: i, message: `${truncate(String(f.name), 48)} is not a picture` })
      } else if (data.byteLength > MAX_IMAGE_BYTES) {
        tooBig.push(name)
        failures.push({ index: i, message: `${truncate(name, 48)} is over 40 MB` })
      } else {
        pictures.push({ name, data })
        origin.push(i)
      }
    })
    if (!quiet) {
      if (refused.length) {
        const what = refused.length === 1 ? `${truncate(refused[0] ?? '', 48)} is not a picture` : `${refused.length} files are not pictures`
        get().toast(`${what} (png, jpg, webp, gif, bmp, avif)`, 'error')
      }
      if (tooBig.length) get().toast(`${tooBig.length === 1 ? truncate(tooBig[0] ?? '', 48) : plural(tooBig.length, 'picture')} over 40 MB, not added`, 'error')
    }
    if (!pictures.length) return { dir: '', paths, failures }
    const target = get().importTarget(folder)
    if (target === null) return null
    const written: { index: number; message: string }[] = []
    const done = await batched(() => writePictures(target, pictures, quiet ? written : undefined))
    // The reasons of a quiet save are the caller's; map them from the pictures to the files.
    for (const f of written) failures.push({ index: f.index < 0 ? -1 : (origin[f.index] ?? -1), message: f.message })
    // A folder that cannot be made: a quiet caller learns why from `failures`; the rest is toasted already.
    if (!done) return quiet ? { dir: target, paths, failures } : null
    done.results.forEach((r, k) => {
      paths[origin[k]!] = r?.path ?? null
    })
    return { dir: done.dir, paths, failures }
  }

  /** Board folders the vault refused (a name left out of it): the folder used instead, by board path in lower case. */
  const boardPictureFolders = new Map<string, string>()

  const fileCritique = (input: CritiqueSave): Promise<CritiqueSaved> => batched(() => writeCritique(input))

  const writeCritique = async (input: CritiqueSave): Promise<CritiqueSaved> => {
    const { adapter, status } = get()
    if (adapter && status === 'loading') throw new Error('The vault is still loading; try again in a moment')
    if (!adapter || status !== 'ready') throw new Error('Open your vault in Aether Brain first')
    if (adapter.readOnly) throw new Error('This vault is read-only')
    if (!adapter.createAsset) throw new Error('This vault can’t save pictures')
    const { projectId, grade, practiceTomorrow } = input
    const note = typeof projectId === 'string' && !isVirtualId(projectId) ? get().notes.get(projectId) : undefined
    if (!note || !isProjectNote(note)) throw new Error('That project is no longer in the vault (renamed or deleted?); pick it again')
    const png = asBytes(input.png)
    if (!png || png.byteLength === 0) throw new Error('The drawing is empty')
    if (png.byteLength > MAX_IMAGE_BYTES) throw new Error('The drawing is larger than 40 MB')
    if (!isPng(png)) throw new Error('The drawing is not a PNG')
    const today = todayIso()
    const g = normalizeGrade(grade)
    const title = (typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '') || g.drill || 'Drawing'
    const clean = cleanFolderPath(critiqueTarget(note).dir, folderSpelling)
    if ('error' in clean) throw new Error(clean.error)
    const dir = clean.path
    await ensureFolder(dir)
    const noteIdOf = (pngPath: string) => pngPath.replace(/\.png$/i, '')
    const imagePath = await createAssetNew(dir, critiqueBaseName(title, today), '.png', png, takenImages(), (p) => existingId(noteIdOf(p)) !== null)
    const content = critiqueNote(
      { title, project: note.meta.title, drill: g.drill, grade: g.grade, score: g.score, scores: g.scores, fixes: g.fixes, strengths: g.strengths, deep: g.deep },
      imageFileName(imagePath),
      { date: today, practiceDue: practiceTomorrow === false ? null : nextDay(today) },
    )
    let made: { path: string; content: string } | null = null
    try {
      made = await createNew(`${noteIdOf(imagePath)}.md`, content)
    } finally {
      // The picture is on disk whatever happened to the note: show it (one rebuild for both).
      const mtime = Date.now()
      const changes: VaultChange[] = []
      if (!get().assets.has(imagePath)) changes.push({ kind: 'add', path: imagePath, mtime, size: png.byteLength })
      if (made) changes.push({ kind: 'add', path: made.path, content: made.content, mtime })
      if (changes.length) get().applyExternal(changes)
    }
    if (!made) throw new Error(`${noteIdOf(imagePath)}.md is taken`)
    const noteId = idFromPath(made.path)
    const planet = dir.slice(dir.lastIndexOf('/') + 1)
    get().toast(`Critique saved to ${note.meta.title} ▸ ${planet}`, 'success', { label: 'Show', run: () => showNode(noteId) })
    return { noteId, notePath: made.path, imagePath, project: note.meta.title }
  }

  return {
    adapter: null,
    status: 'idle',
    error: null,
    notes: new Map(),
    graph: null,
    search: new SearchIndex(),
    controller,
    revision: 0,
    roots: [],
    folders: new Set(),
    expandedFolders: new Set(),
    sunOwn: {},
    sunDefault: 0,
    view: 'graph',
    selectedId: null,
    hoveredId: null,
    editorId: null,
    draft: null,
    dirty: false,
    history: [],
    historyIndex: -1,
    paletteOpen: false,
    helpOpen: false,
    filters: { areas: new Set(), tags: new Set(), types: new Set(), bodies: new Set(), query: '' },
    settings,
    activeTag: null,
    toasts: [],
    review: loadJson<Record<NoteId, ReviewEntry>>(REVIEW_KEY, {}),
    fps: 0,
    loadProgress: null,
    setLoadProgress(p) {
      if (get().status === 'loading') set({ loadProgress: p })
    },
    projectId: null,
    formRequest: null,
    boardPath: null,
    lastBoardPath: null,

    async openVault(adapter) {
      unwatch?.()
      unwatch = null
      // Changes a batch held for the previous vault are not this one's.
      held = []
      // The previous vault's pictures are not this one's, nor are its galleries.
      controller.thumbnails = null
      controller.resetGallery()
      stills.clear()
      const suns = loadSuns(adapter.location)
      controller.setSunLevels(suns.def, new Map(Object.entries(suns.own)))
      // The previous vault's use is not this one's: save it where it was, and read this one's.
      if (activitySave) {
        clearTimeout(activitySave)
        saveActivity()
      }
      if (activityRefresh) clearTimeout(activityRefresh)
      activityRefresh = null
      activity = loadActivity(adapter.location, Date.now())
      controller.setActivity(null)
      set({
        adapter,
        roots: adapter.roots ?? [],
        folders: new Set(),
        assets: new Map(),
        brief: null,
        expandedFolders: loadExpanded(adapter.location),
        sunOwn: suns.own,
        sunDefault: suns.def,
        status: 'loading',
        error: null,
        selectedId: null,
        hoveredId: null,
        editorId: null,
        draft: null,
        dirty: false,
        loadProgress: null,
        projectId: null,
        formRequest: null,
        gallery: null,
        // A board is a note of the vault that was open: the next one has its own (the last one used is remembered per vault).
        boardPath: null,
        lastBoardPath: loadLastBoard(adapter.location),
      })
      boardPictureFolders.clear()
      try {
        const search = new SearchIndex()
        const loaded = await loadVault(
          adapter,
          search,
          (p) => {
            if (p.phase === 'listing') return // the adapter reports its own listing progress
            set({ loadProgress: { label: p.phase === 'parsing' ? 'Parsing notes' : 'Building the graph', done: p.done, total: p.total } })
          },
          graphOptions,
        )
        const thumbnail = adapter.thumbnail?.bind(adapter)
        // A video comes from the browser adapters as itself: the scene gets one still frame of it.
        controller.thumbnails = thumbnail ? (path, size) => stillFor(path, size, () => thumbnail(path, size)) : null
        set({ search, status: 'ready', loadProgress: null })
        vaultFiles = loaded.files
        setLoaded(loaded.notes, loaded.graph, loaded.folders, loaded.assets)
        unwatch = adapter.watch((changes) => get().applyExternal(changes))
        // Too many changes arrived while a big vault loaded: some are lost, only a rescan catches up.
        if (adapter.overflowed) get().toast('Many files changed while the vault loaded; rescan to catch up', 'info', { label: 'Rescan', run: () => void get().reload() })
      } catch (err) {
        set({ status: 'error', error: errText(err) })
      }
    },

    async reload() {
      const { adapter } = get()
      if (adapter) await get().openVault(adapter)
    },

    applyExternal(changes) {
      if (holding > 0) {
        held.push(...changes)
        return
      }
      const { notes, search, folders, assets, editorId, dirty } = get()
      const next = applyChanges(notes, changes, search, { folders, assets, graph: graphOptions })
      if (editorId && dirty && next.touched.includes(editorId)) {
        get().toast('This note changed on disk while you were editing. Your draft is kept; save to overwrite.', 'info')
      }
      setLoaded(next.notes, next.graph, next.folders, next.assets)
    },

    select(id, opts) {
      set({ selectedId: id })
      if (id) openSunsFor(id)
      controller.setSelected(id)
      if (id && opts?.fly) controller.flyTo(id)
    },

    hover(id) {
      set({ hoveredId: id })
      controller.setHovered(id)
    },

    openNote(id, opts) {
      const { notes, history, historyIndex, dirty, editorId } = get()
      if (isGhostId(id)) {
        void get().createGhost(id)
        return
      }
      if (isFolderId(id)) {
        // A folder has nothing to edit: open = expand/collapse (when there is something to show) + select.
        const path = folderPathOf(id)
        const info = nodeOf(get().graph, id)?.folder
        if (get().expandedFolders.has(path) || (info?.hiddenFolders ?? 0) > 0) get().toggleFolder(path)
        get().select(id, { fly: opts?.fly !== false })
        return
      }
      // A picture opens in the OS image app; the Today hub has nothing to edit (the Inspector shows its brief).
      if (isImageId(id) || isTodayId(id)) {
        if (get().selectedId !== id) get().select(id, { fly: opts?.fly !== false })
        if (isImageId(id)) void get().openImage(imagePathOf(id))
        return
      }
      const note = isVirtualId(id) ? undefined : notes.get(id)
      if (!note) return
      if (dirty && editorId && editorId !== id) void get().saveDraft()
      const h = history.slice(0, historyIndex + 1)
      if (h[h.length - 1] !== id) h.push(id)
      set({
        editorId: id,
        draft: note.raw,
        dirty: false,
        selectedId: id,
        history: h.slice(-50),
        historyIndex: Math.min(h.length, 50) - 1,
        view: opts?.view ?? (get().view === 'review' ? 'review' : 'editor'),
      })
      openSunsFor(id)
      controller.setSelected(id)
      if (opts?.fly !== false) controller.flyTo(id)
      interacted(id, 'open')
    },

    closeEditor() {
      const { dirty } = get()
      if (dirty) void get().saveDraft()
      set({ editorId: null, draft: null, dirty: false, view: 'graph' })
    },

    goBack() {
      const { history, historyIndex } = get()
      if (historyIndex <= 0) return
      const id = history[historyIndex - 1]
      if (!id) return
      set({ historyIndex: historyIndex - 1 })
      const note = isVirtualId(id) ? undefined : get().notes.get(id)
      if (note) {
        set({ editorId: id, draft: note.raw, dirty: false, selectedId: id })
        openSunsFor(id)
        controller.setSelected(id)
        controller.flyTo(id)
      }
    },

    goForward() {
      const { history, historyIndex } = get()
      if (historyIndex >= history.length - 1) return
      const id = history[historyIndex + 1]
      if (!id) return
      set({ historyIndex: historyIndex + 1 })
      const note = isVirtualId(id) ? undefined : get().notes.get(id)
      if (note) {
        set({ editorId: id, draft: note.raw, dirty: false, selectedId: id })
        openSunsFor(id)
        controller.setSelected(id)
        controller.flyTo(id)
      }
    },

    cycleNeighbor(dir) {
      const { graph, selectedId } = get()
      if (!graph) return
      if (!selectedId) {
        const hubs = graph.nodes.filter((n) => n.kind === 'note').sort((a, b) => b.degree - a.degree)
        const first = hubs[0]
        if (first) get().select(first.id, { fly: true })
        return
      }
      let ring: NoteId[]
      if (isFolderId(selectedId)) {
        // A folder's neighbors are structural: its parent, then its planets and moons, then the cards
        // of its open gallery (Shift+Tab reaches them first).
        const parent = nodeOf(graph, selectedId)?.parent ?? null
        const kids = graph.nodes.filter((n) => n.parent === selectedId)
        const cards = kids.filter((n) => n.image?.gallery?.only)
        ring = [...(parent !== null ? [parent] : []), ...kids.filter((n) => !n.image?.gallery?.only).map((n) => n.id), ...cards.map((n) => n.id)]
      } else {
        // The Today hub's neighbors are the notes of its beams; a picture's, the notes embedding it.
        ring = [...neighborhood(graph, selectedId, 1)].filter((id) => id !== selectedId).sort()
        // A picture moon nothing embeds still has its planet.
        const parent = isImageId(selectedId) ? (nodeOf(graph, selectedId)?.parent ?? null) : null
        if (parent !== null && !ring.includes(parent)) ring.push(parent)
      }
      if (ring.length === 0) return
      const hovered = get().hoveredId
      const cur = hovered !== null ? ring.indexOf(hovered) : -1
      const next = ring[(cur + dir + ring.length) % ring.length]!
      set({ hoveredId: next })
      controller.setHovered(next)
      controller.flyTo(next)
    },

    setView(view) {
      set({ view, paletteOpen: view === 'search' ? true : get().paletteOpen })
    },
    setPalette(open) {
      set({ paletteOpen: open, view: open ? get().view : get().view === 'search' ? 'graph' : get().view })
    },
    setHelp(open) {
      set({ helpOpen: open })
    },

    setDraft(text) {
      const { notes, editorId } = get()
      const orig = editorId ? notes.get(editorId)?.raw : null
      set({ draft: text, dirty: text !== orig })
    },

    async saveDraft() {
      const { adapter, editorId, draft, notes, dirty } = get()
      if (!adapter || !editorId || draft === null || !dirty) return
      const note = notes.get(editorId)
      if (!note) return
      // Touch `updated` if the note tracks it (in place: a half-typed, broken frontmatter is never rewritten).
      const content = touchUpdated(draft)
      try {
        await adapter.write(note.meta.path, content)
        set({ dirty: false, draft: content })
        interacted(editorId, 'save')
        get().applyExternal([{ kind: 'change', path: note.meta.path, content, mtime: Date.now() }])
      } catch (err) {
        get().toast(`Save failed: ${errText(err)}`, 'error')
      }
    },

    writeNote(path, content, opts) {
      return addNote(path, content, opts)
    },

    async createNote(folder, title) {
      const { adapter, roots } = get()
      const name = title.replace(/\s+/g, ' ').trim()
      if (!adapter || !name) return null
      if (adapter.readOnly) {
        get().toast('This vault is read-only', 'error')
        return null
      }
      const dir = canonicalFolder(folder)
      if (roots.length > 1 && !dir) {
        get().toast('Pick a folder inside one of the roots for the new note', 'error')
        return null
      }
      // The note's type follows its folder inside the root (`D/Inbox` → an inbox note, like `Inbox`).
      const mount = mountOf(dir, roots)
      const n = blankNote(name, mount ? dir.slice(mount.length + 1) : dir)
      const path = `${mount ? `${mount}/` : ''}${n.path}`
      try {
        const id = await addNote(path, n.content, { open: true })
        get().toast(`Created "${name}" in ${dir || 'the vault root'}${numberedAs(path, id)}`, 'success')
        return id
      } catch (err) {
        get().toast(`Could not create the note: ${errText(err)}`, 'error')
        return null
      }
    },

    deleteNote(id) {
      // After any rewrite of the note under way: its write landing later would bring the file back.
      return exclusive(id, async () => {
        const { adapter, notes } = get()
        const note = isVirtualId(id) ? undefined : notes.get(id)
        if (!adapter || !note) return
        await adapter.remove(note.meta.path)
        // Close the editor on it; an overlay (the Projects board deleting its project) stays open.
        if (get().editorId === id) set({ editorId: null, draft: null, dirty: false, ...(get().view === 'editor' ? { view: 'graph' as const } : {}) })
        get().applyExternal([{ kind: 'unlink', path: note.meta.path }])
        get().toast(`Deleted ${note.meta.title}`, 'info')
      })
    },

    renameNote(id, toPath) {
      return exclusive(id, async () => {
        const { adapter } = get()
        if (!adapter || isVirtualId(id) || !get().notes.has(id)) throw new Error('No such note')
        if (!(await flushDraft(id, 'rename the note'))) return id
        // The file as it is now, so the renamed note shows what is on disk.
        const note = await freshNote(id, 'rename the note')
        if (!note) return id
        const to = normalizePath(toPath.endsWith('.md') ? toPath : `${toPath}.md`)
        if (to === note.meta.path) return id
        // Before the adapter call: an in-memory vault reports the move synchronously.
        const follow = trackRename(id)
        await adapter.rename(note.meta.path, to)
        const newId = idFromPath(to)
        get().applyExternal([
          { kind: 'unlink', path: note.meta.path },
          { kind: 'add', path: to, content: note.raw, mtime: Date.now() },
        ])
        follow(newId, get().notes.get(newId)?.raw ?? note.raw)
        return newId
      })
    },

    moveToArea(id, area) {
      return exclusive(id, () => moveNoteToArea(id, area))
    },

    patchFrontmatter(id, patch) {
      return exclusive(id, async () => {
        const { adapter } = get()
        if (!adapter || isVirtualId(id) || !get().notes.has(id)) return
        // Patch what the user typed, not the file under it (a draft saved later would undo the patch).
        if (!(await flushDraft(id, 'update the note'))) return
        const note = await freshNote(id, 'update the note')
        if (!note) return
        if (hasBrokenFrontmatter(note.raw)) {
          get().toast(`The frontmatter of ${note.meta.title} is not valid YAML; fix it in the editor first`, 'error')
          return
        }
        const content = updateFrontmatter(note.raw, { ...patch, updated: todayIso() })
        await adapter.write(note.meta.path, content)
        interacted(id, 'save')
        if (get().editorId === id && !get().dirty) set({ draft: content })
        get().applyExternal([{ kind: 'change', path: note.meta.path, content, mtime: Date.now() }])
      })
    },
    async createGhost(id) {
      if (!isGhostId(id)) return
      const title = ghostTitle(id)
      const n = blankNote(title, 'Inbox')
      const dir = canonicalFolder(`${get().homePrefix()}Inbox`)
      const path = `${dir}/${fileNameOf(n.path)}`
      let made: NoteId
      try {
        made = await addNote(path, n.content, { open: true })
      } catch (err) {
        get().toast(`Could not create "${title}": ${errText(err)}`, 'error')
        return
      }
      get().toast(`Created "${title}" in ${dir}${numberedAs(path, made)}`, 'success')
    },

    async capture(text, tags) {
      const n = inboxNote({ text, ...(tags ? { tags } : {}) })
      // Never clobber: numbered when a capture with the same title exists (in the store or on disk).
      const id = await addNote(`${canonicalFolder(`${get().homePrefix()}Inbox`)}/${fileNameOf(n.path)}`, n.content, { fly: true })
      get().toast(`Captured "${n.title}" → Inbox`, 'success')
      return id
    },

    async openDaily() {
      const day = todayIso()
      const dir = canonicalFolder(`${get().homePrefix()}Daily`)
      // Today's note under any spelling: on Windows a second `Daily/…` would overwrite `daily/…`.
      const existing = existingId(`${dir}/${day}`)
      if (existing) {
        get().openNote(existing, { fly: true })
        return
      }
      const prev = [...get().notes.keys()]
        .filter((k) => k.startsWith(`${dir}/`) && basenameOf(k) < day)
        .sort()
        .pop()
      const d = dailyNote(day, prev ? basenameOf(prev) : null)
      const path = `${dir}/${fileNameOf(d.path)}`
      try {
        let made = await createNew(path, d.content, { suffix: false })
        if (!made) {
          // Today's note is on disk already (written elsewhere, not reported yet): open that one.
          const disk = await get().adapter?.read(path)
          if (disk === null || disk === undefined) throw new Error(`${path} is taken`)
          made = { path, content: disk }
        }
        get().applyExternal([{ kind: 'add', path: made.path, content: made.content, mtime: Date.now() }])
        get().openNote(idFromPath(made.path), { fly: true })
      } catch (err) {
        get().toast(`Could not create today's note: ${errText(err)}`, 'error')
      }
    },

    async appendLink(fromId, toId) {
      const to = isVirtualId(toId) ? undefined : get().notes.get(toId)
      if (!to || !get().notes.has(fromId)) return
      const res = await rewriteNote(fromId, (raw) => `${raw.replace(/\s+$/, '')}\n\n- Related: [[${to.meta.title}]]\n`, 'link the notes')
      if (res) get().toast(`Linked ${get().notes.get(fromId)?.meta.title ?? fromId} → ${to.meta.title}`, 'success')
    },

    setFilters(patch) {
      set((s) => ({ filters: { ...s.filters, ...patch } }))
      syncHighlight()
    },
    toggleArea(area) {
      const areas = new Set(get().filters.areas)
      if (areas.has(area)) areas.delete(area)
      else areas.add(area)
      get().setFilters({ areas })
    },
    toggleTag(tag) {
      const tags = new Set(get().filters.tags)
      if (tags.has(tag)) tags.delete(tag)
      else tags.add(tag)
      get().setFilters({ tags })
    },
    toggleBody(body) {
      const bodies = new Set(get().filters.bodies)
      if (bodies.has(body)) bodies.delete(body)
      else bodies.add(body)
      get().setFilters({ bodies })
    },
    clearFilters() {
      set({ filters: { areas: new Set(), tags: new Set(), types: new Set(), bodies: new Set(), query: '' } })
      syncHighlight()
    },
    setActiveTag(tag) {
      set({ activeTag: tag })
      controller.setActiveTag(tag)
      if (tag) get().setSettings({ colorMode: 'tag' })
    },
    setSettings(patch) {
      const prev = get().settings
      const next = { ...prev, ...patch }
      next.folderDepth = clampDepth(next.folderDepth)
      if (!isPictureSize(next.pictureSize)) next.pictureSize = prev.pictureSize
      set({ settings: next })
      saveJson(SETTINGS_KEY, next)
      controller.setColorMode(next.colorMode)
      controller.setBloom(next.bloom)
      controller.setHubLabels(next.hubLabels)
      controller.setMotion(next.motion)
      controller.setCalm(next.calm)
      controller.setSuns(next.suns)
      controller.setFlares(next.flares)
      controller.setAsteroids(next.asteroids)
      controller.showThumbnails = next.thumbnails
      controller.galleries = next.starGalleries
      controller.pictureSize = next.pictureSize
      // Only system graphs carry folder nodes and picture moons: crossing system ↔ others, a new
      // depth or moons on/off there rebuilds; so does the Today hub coming or going (every layout),
      // and a new picture size (the layout spaces orbits by it).
      const system = next.layoutMode === 'system'
      const crossed = (prev.layoutMode === 'system') !== system
      const depth = system && prev.folderDepth !== next.folderDepth
      const moons = system && prev.imageMoons !== next.imageMoons
      const hub = prev.todayHub !== next.todayHub
      const pictures = prev.pictureSize !== next.pictureSize
      if (crossed || depth || moons || hub || pictures) rebuildGraph()
      if (pictures && get().status === 'ready') {
        // Every orbit moves: keep the selection in view (it is where the user was looking), else see everything.
        const sel = get().selectedId
        if (sel && get().graph?.index.has(sel)) flyWhenSettled(sel)
        else controller.refitWhenSettled()
      }
      else if (prev.layoutMode !== next.layoutMode) controller.setLayoutMode(next.layoutMode)
    },
    cyclePictureSize() {
      const cur = get().settings.pictureSize
      const next = PICTURE_SIZES[(PICTURE_SIZES.indexOf(cur) + 1) % PICTURE_SIZES.length]!
      get().setSettings({ pictureSize: next })
      get().toast(`Pictures: ${PICTURE_SIZE_NAMES[next].toLowerCase()} (z)`)
    },
    cycleColorMode() {
      const order: ColorMode[] = ['area', 'type', 'tag', 'age']
      const cur = get().settings.colorMode
      const next = order[(order.indexOf(cur) + 1) % order.length]!
      get().setSettings({ colorMode: next })
      get().toast(`Color by ${next}`)
    },
    toggleLayout() {
      const cur = get().settings.layoutMode
      const next = LAYOUTS[(LAYOUTS.indexOf(cur) + 1) % LAYOUTS.length]!
      get().setSettings({ layoutMode: next })
      get().toast(LAYOUT_TOASTS[next])
    },
    toggleMotion() {
      const motion = !get().settings.motion
      get().setSettings({ motion })
      get().toast(motion ? 'Orbits moving' : 'Orbits paused')
    },
    toggleCalm() {
      const calm = !get().settings.calm
      get().setSettings({ calm })
      get().toast(calm ? 'Calm orbits: none runs faster than a normal orbit' : 'Orbits at their urgent speed')
    },

    sunLevelOf(id) {
      return get().sunOwn[id] ?? get().sunDefault
    },
    setSunLevel(id, level) {
      const { sunOwn, sunDefault, adapter } = get()
      const own = { ...sunOwn }
      if (level === sunDefault) delete own[id]
      else own[id] = level
      set({ sunOwn: own })
      controller.setSunLevel(id, level)
      if (adapter) saveJson(SUNS_KEY + adapter.location, { def: sunDefault, own })
    },
    sunCountsOf(id) {
      const g = get().graph
      return (g && cosmosOf(g).counts.get(id)) ?? { planets: 0, systems: 0, moons: 0 }
    },
    cycleSun(id, direction = 1) {
      const node = nodeOf(get().graph, id)
      if (!node || !isSunNode(node)) return
      const counts = get().sunCountsOf(id)
      // The levels with something to show: closed always, planets (and sub-folders) when it has some, moons when it has some.
      const levels: SunLevel[] = [0]
      if (counts.planets + counts.systems > 0) levels.push(1)
      if (counts.moons > 0) levels.push(2)
      if (levels.length === 1) {
        get().toast(`${node.title} has nothing to open`)
        return
      }
      const at = levels.indexOf(get().sunLevelOf(id))
      const next = levels[(Math.max(0, at) + direction + levels.length) % levels.length]!
      const before = get().sunLevelOf(id)
      get().setSunLevel(id, next)
      if (get().settings.sound) playSun(next, before)
    },
    chooseSun(id, level) {
      const before = get().sunLevelOf(id)
      get().setSunLevel(id, level)
      if (get().settings.sound) playSun(level, before)
    },
    setAllSuns(level) {
      const { adapter } = get()
      set({ sunOwn: {}, sunDefault: level })
      controller.setSunLevels(level, null)
      if (adapter) saveJson(SUNS_KEY + adapter.location, { def: level, own: {} })
      get().toast(level === 0 ? 'Every sun closed' : level === 1 ? 'Every sun open: folders' : 'Every sun open: folders and files')
    },
    toggleAllSuns() {
      const { sunDefault, sunOwn } = get()
      const anyOpen = sunDefault > 0 || Object.values(sunOwn).some((l) => l > 0)
      get().setAllSuns(anyOpen ? 0 : 2)
    },
    toggleSuns() {
      const suns = !get().settings.suns
      get().setSettings({ suns })
      get().toast(suns ? 'Suns open and close: click one to see its folders, then its files' : 'Every body shows, always')
    },
    pickBody(id) {
      const g = get().graph
      const node = nodeOf(g, id)
      if (!node) return
      if (get().settings.sound) playBody(node)
      // A click opens a closed sun, at the first level that has something to show.
      if (get().settings.layoutMode !== 'system' || !get().settings.suns || !isSunNode(node)) return
      if (get().sunLevelOf(id) !== 0) return
      const c = get().sunCountsOf(id)
      const level: SunLevel = c.planets + c.systems > 0 ? 1 : c.moons > 0 ? 2 : 0
      if (level === 0) return
      get().setSunLevel(id, level)
      get().select(id, { fly: true })
      if (get().settings.sound) playSun(level, 0)
    },
    toggleFlares() {
      const flares = !get().settings.flares
      get().setSettings({ flares })
      get().toast(flares ? 'Solar flares on: a star that needs attention throws plasma, the more urgent the bigger' : 'Solar flares off')
    },
    toggleAsteroids() {
      const asteroids = !get().settings.asteroids
      get().setSettings({ asteroids })
      get().toast(asteroids ? 'Asteroids on: your reminders float by (hover one to read it, click it to open its note)' : 'Asteroids off')
    },
    toggleSound() {
      const sound = !get().settings.sound
      get().setSettings({ sound })
      get().toast(sound ? (soundSupported() ? 'Sound on' : 'Sound on (this computer has no audio to play it)') : 'Sound off')
    },

    homePrefix() {
      return homePrefixOf(get().roots)
    },

    toggleFolder(path) {
      const p = normalizeFolderPath(path)
      const expanded = new Set(get().expandedFolders)
      if (expanded.has(p)) expanded.delete(p)
      else {
        const node = nodeOf(get().graph, folderKey(p))
        if (node?.folder && node.folder.hiddenFolders === 0) {
          get().toast(node.folder.childFolders ? `Every folder inside ${node.title} is already shown` : `${node.title} has no subfolders`)
          return
        }
        expanded.add(p)
      }
      set({ expandedFolders: expanded })
      saveExpanded(expanded)
      if (get().settings.layoutMode === 'system') rebuildGraph()
    },

    setFolderDepth(n) {
      const depth = clampDepth(n)
      if (depth !== get().settings.folderDepth) get().setSettings({ folderDepth: depth })
      get().toast(`Folder depth ${depth}${get().settings.layoutMode === 'system' ? '' : ' (applies to the system layout, t)'}`)
    },

    showFolder(path, opts) {
      const p = normalizeFolderPath(path)
      const id = folderKey(p)
      // The board, review and capture cover the graph (and the folder inspector): step out of
      // them — unless the caller works from that view (adding a planet on the board).
      if (!opts?.keepView && COVERING_VIEWS.has(get().view)) set({ view: 'graph' })
      if (get().settings.layoutMode !== 'system') {
        get().setSettings({ layoutMode: 'system' })
        get().toast(LAYOUT_TOASTS.system)
      }
      // A folder below the depth limit shows once its parent is expanded (its ancestors come along).
      const graph = get().graph
      if (graph && !graph.index.has(id) && p !== '') {
        const expanded = new Set(get().expandedFolders).add(folderOf(p))
        set({ expandedFolders: expanded })
        saveExpanded(expanded)
        rebuildGraph()
      }
      get().select(id, { fly: true })
      flyWhenSettled(id)
    },

    async createFolder(path) {
      const { adapter, roots } = get()
      if (!adapter) return null
      if (adapter.readOnly) {
        get().toast('This vault is read-only', 'error')
        return null
      }
      if (!adapter.createFolder) {
        get().toast('This vault can’t create folders', 'error')
        return null
      }
      // Folders already there keep their spelling (on Windows `portal game` is `Portal Game`).
      const clean = cleanFolderPath(path, folderSpelling)
      if ('error' in clean) {
        get().toast(clean.error, 'error')
        return null
      }
      const p = clean.path
      if (roots.length > 1 && (!p.includes('/') || !roots.some((r) => r.mount === mountOf(p, roots)))) {
        get().toast('New folders go inside one of the vault’s roots', 'error')
        return null
      }
      if (get().folders.has(p)) {
        get().toast(`${p} already exists`)
      } else {
        try {
          await adapter.createFolder(p)
        } catch (err) {
          get().toast(`Could not create ${p}: ${errText(err)}`, 'error')
          return null
        }
        // The adapter emits addDir too; applying it here makes the planet appear now (idempotent).
        get().applyExternal([{ kind: 'addDir', path: p }])
        get().toast(`New folder ${p}`, 'success')
      }
      // Stay where the user is (the Projects board adds planets one after another).
      if (get().settings.layoutMode === 'system') get().showFolder(p, { keepView: true })
      return p
    },

    async makeProject(folderPath, opts) {
      const { adapter, notes, folders, roots } = get()
      if (!adapter) return null
      const quiet = opts?.quiet ?? false
      const fail = (message: string): null => {
        if (opts?.onError) opts.onError(message)
        else get().toast(message, 'error')
        return null
      }
      if (adapter.readOnly) return fail('This vault is read-only')
      const dir = canonicalFolder(folderPath)
      if (!dir || (roots.length > 1 && !dir.includes('/'))) return fail('Pick a folder inside the vault, not the vault or a drive itself')
      if (areaFromFolder(`${dir}/x.md`) === 'archive') return fail('Archived folders are not projects; move it out of Archive first')
      // The note the graph itself binds to the folder (one rule for all: `bindProjects`), not merely the first that names it.
      const bound = bindProjects(notes, [...notes.keys()].sort(), folderUniverse(folders, [...notes.values()].map((n) => n.meta.folder)).all).projectAt.get(dir)
      const existing = bound ? notes.get(bound) : undefined
      if (existing) {
        if (!quiet) {
          set({ projectId: existing.meta.id })
          get().toast(`${dir} is already the project ${existing.meta.title}`)
        }
        return existing.meta.id
      }
      const p = folderProjectNote(dir)
      // Its folder note under any spelling (`Drawing/drawing.md`): a second file would replace it on Windows.
      let id = existingId(idFromPath(p.path)) ?? idFromPath(p.path)
      const folderNote = notes.get(id)
      try {
        if (folderNote) {
          // The folder already has its folder note: it becomes the star.
          if (hasBrokenFrontmatter(folderNote.raw)) return fail(`The frontmatter of ${folderNote.meta.path} is not valid YAML; fix it first`)
          await get().patchFrontmatter(id, { type: 'project', ...(folderNote.meta.status ? {} : { status: 'active' }) })
        } else {
          // Something already at that path on disk (a file the brain skips, one not reported yet) is
          // never replaced: the note takes a numbered name and names its folder in `folder:`.
          id = await addNote(p.path, (path) =>
            path === normalizePath(p.path) ? p.content : projectNote({ name: p.title, dir, folder: portableFolderRef(path, dir, roots) }).content,
          )
        }
      } catch (err) {
        return fail(`Could not make ${dir} a project: ${errText(err)}`)
      }
      if (!quiet) {
        set({ projectId: id })
        get().toast(`★ ${p.title} is a project now${numberedAs(p.path, id)}`, 'success')
      }
      return id
    },

    forgetActivity() {
      activity.clear()
      if (activitySave) clearTimeout(activitySave)
      saveActivity()
      refreshActivity()
      get().toast('Forgot which folders you use: every star is calm again', 'success')
    },

    async setFolderScale(folderPath, scale) {
      const { adapter } = get()
      if (!adapter) return false
      if (adapter.readOnly) {
        get().toast('This vault is read-only', 'error')
        return false
      }
      // A galaxy is a project with a mark: a folder that is no project yet becomes one first (this refuses a drive, Archive and a bad note).
      const id = await get().makeProject(folderPath, { quiet: true })
      const note = id ? get().notes.get(id) : undefined
      if (!id || !note) return false
      const name = note.meta.title
      if (scaleOf(note.frontmatter) === scale) {
        get().toast(scale === 'galaxy' ? `${name} is a galaxy already` : `${name} is a star already`)
        return true
      }
      if (hasBrokenFrontmatter(note.raw)) {
        get().toast(`The frontmatter of ${note.meta.path} is not valid YAML; fix it first`, 'error')
        return false
      }
      try {
        // Plain markdown: one key of the project note, put back or taken away; nothing else of the note changes.
        await get().patchFrontmatter(id, { scale: scale === 'galaxy' ? 'galaxy' : undefined })
      } catch (err) {
        get().toast(`Could not mark ${name}: ${errText(err)}`, 'error')
        return false
      }
      // patchFrontmatter says its refusals itself (the note changed on disk, its frontmatter broke) and does not throw: look, do not assume.
      const written = get().notes.get(id)
      if (!written || scaleOf(written.frontmatter) !== scale) return false
      if (scale === 'star') {
        get().toast(`★ ${name} is a star again`, 'success')
        return true
      }
      // The line is written; whether it counts is the graph's to say (how deep galaxies nest, how many there can be).
      const g = get().graph
      const info = g?.nodes[g.index.get(folderKey(canonicalFolder(folderPath))) ?? -1]?.folder
      if (info?.markIgnored && info.markIgnored !== 'drive') get().toast(`${name}: ${IGNORED_MARK_TEXT[info.markIgnored]}`, 'info')
      else get().toast(`✦ ${name} is a galaxy now`, 'success')
      return true
    },

    async makeProjects(folderPaths) {
      const { adapter } = get()
      const paths = [...new Set(folderPaths.map((f) => canonicalFolder(f)).filter((f): f is string => !!f))]
      if (!adapter || !paths.length) return { made: 0, failed: 0, error: null }
      if (adapter.readOnly) {
        get().toast('This vault is read-only', 'error')
        return { made: 0, failed: paths.length, error: 'This vault is read-only' }
      }
      let made = 0
      let failed = 0
      let error: string | null = null
      const onError = (message: string) => {
        failed++
        error ??= message
      }
      // Held per chunk: one graph rebuild for every NOTE_CHUNK new stars, not one each.
      for (let i = 0; i < paths.length; i += NOTE_CHUNK) {
        await batched(async () => {
          for (const p of paths.slice(i, i + NOTE_CHUNK)) {
            if (await get().makeProject(p, { quiet: true, onError })) made++
          }
        })
      }
      const stars = `${made} ${made === 1 ? 'folder is a star' : 'folders are stars'} now`
      if (failed) get().toast(`★ ${stars}; ${failed} could not be: ${error}`, made ? 'info' : 'error')
      else get().toast(`★ ${stars}`, 'success', { label: 'Projects board', run: () => get().setView('projects') })
      return { made, failed, error }
    },

    async makeBio() {
      const { adapter, status } = get()
      if (!adapter || status !== 'ready') {
        get().toast('Open a vault first to make the Bio star', 'error')
        return 0
      }
      if (adapter.readOnly) {
        get().toast('This vault is read-only', 'error')
        return 0
      }
      // The vault's own spelling of the folder when it is there already (`bio` on Windows is `Bio`).
      const dir = canonicalFolder(`${get().homePrefix()}${BIO_FOLDER}`)
      const plan = planBio(dir, get().notes.keys())
      let wrote = 0
      try {
        const taken = new Set([...get().notes.keys()].map((k) => k.toLowerCase()))
        await batched(async () => {
          for (const page of plan.create) {
            // Never numbered and never over anything: a page the disk already has (one the brain has not seen yet) is left alone.
            const made = await createNew(page.path, page.content, { suffix: false, taken })
            if (!made) continue
            wrote++
            // Held with the adapter's own reports and applied together when the batch ends: one rebuild for all the pages.
            get().applyExternal([{ kind: 'add', path: made.path, content: made.content, mtime: Date.now() }])
          }
        })
      } catch (err) {
        get().toast(`Could not finish the Bio star: ${errText(err)}`, 'error')
        return wrote
      }
      const there = plan.present.length + (plan.create.length - wrote)
      get().toast(
        wrote === 0
          ? 'The Bio star is complete: every page is there'
          : there === 0
            ? `✚ Bio star made: ${wrote} pages in ${dir}`
            : `✚ Bio star: added ${wrote} ${wrote === 1 ? 'page' : 'pages'} (${there} ${there === 1 ? 'was' : 'were'} already there)`,
        wrote === 0 ? 'info' : 'success',
      )
      get().showFolder(dir)
      return wrote
    },

    goToBio() {
      const { adapter, folders } = get()
      const dir = canonicalFolder(`${get().homePrefix()}${BIO_FOLDER}`)
      if (folders.has(dir) || [...get().notes.keys()].some((k) => k.startsWith(`${dir}/`)) || get().graph?.index.has(folderKey(dir))) {
        get().showFolder(dir)
        return
      }
      get().toast(
        'No Bio star yet',
        'info',
        adapter && !adapter.readOnly && get().status === 'ready' ? { label: 'Make it', run: () => void get().makeBio() } : undefined,
      )
    },

    async hideFolder(path) {
      const { adapter } = get()
      if (!adapter?.hideFolder) {
        get().toast('Leaving folders out works in the desktop app', 'info')
        return
      }
      const name = path.split('/').pop() || path
      if (!path || (get().roots.length > 1 && !path.includes('/'))) {
        get().toast(path ? `${name} is a whole folder of this vault: remove it in Vault folders (v) instead` : 'The top folder of the vault cannot be left out', 'error')
        return
      }
      try {
        await adapter.hideFolder(path)
        // The folder goes through the change feed; nothing under it stays selected.
        const sel = get().selectedId
        const selPath = sel && isFolderId(sel) ? folderPathOf(sel) : sel && isImageId(sel) ? imagePathOf(sel) : sel ? get().notes.get(sel)?.meta.path : undefined
        if (selPath !== undefined && (selPath === path || selPath.startsWith(`${path}/`))) get().select(null)
        get().toast(`Left ${name} out of the brain (nothing on disk changed)`, 'success', { label: 'Undo', run: () => void get().unhideFolder(path) })
      } catch (err) {
        get().toast(`Could not leave ${name} out: ${errText(err)}`, 'error')
      }
    },

    async unhideFolder(path) {
      const { adapter } = get()
      if (!adapter?.unhideFolder) return
      const name = path.split('/').pop() || path
      try {
        await adapter.unhideFolder(path)
        get().toast(`${name} is back in the brain`, 'success')
      } catch (err) {
        get().toast(`Could not bring ${name} back: ${errText(err)}`, 'error')
      }
    },

    async reveal(path) {
      const { adapter } = get()
      if (!adapter?.reveal) return
      try {
        await adapter.reveal(path)
      } catch (err) {
        get().toast(`Could not show it in the file manager: ${errText(err)}`, 'error')
      }
    },

    requestForm(form) {
      // The board hides the inspector: a folder form needs the graph view.
      // The Boards view is its own page: the new-board form is on its list.
      const view =
        form === 'project' ? 'projects' : form === 'board' ? 'boards' : form && (get().view === 'projects' || get().view === 'boards') ? 'graph' : get().view
      set({ formRequest: form, view, ...(form === 'board' ? { boardPath: null } : {}) })
    },

    toast(text, kind = 'info', action) {
      const id = toastSeq++
      set((s) => ({ toasts: [...s.toasts, action ? { id, text, kind, action } : { id, text, kind }].slice(-4) }))
      setTimeout(() => get().dismissToast(id), action ? 8000 : kind === 'error' ? 7000 : 3200)
    },
    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    },
    toastAction(id) {
      const { toasts } = get()
      const t = id === undefined ? [...toasts].reverse().find((x) => x.action) : toasts.find((x) => x.id === id)
      if (!t?.action) return false
      get().dismissToast(t.id)
      t.action.run()
      return true
    },

    async reviewMark(id, outcome) {
      if (isVirtualId(id)) return
      const today = todayIso()
      const prev = get().review[id]
      let entry: ReviewEntry
      if (outcome === 'keep') {
        const interval = prev ? Math.min(180, Math.round(prev.interval * 2.2)) : 3
        entry = { due: addDays(today, interval), interval, count: (prev?.count ?? 0) + 1, last: today }
      } else if (outcome === 'later') {
        entry = { due: addDays(today, 1), interval: 1, count: prev?.count ?? 0, last: today }
      } else {
        entry = { due: addDays(today, 365), interval: 365, count: (prev?.count ?? 0) + 1, last: today }
      }
      const review = { ...get().review, [id]: entry }
      set({ review })
      saveJson(REVIEW_KEY, review)
      if (outcome === 'archive') await get().moveToArea(id, 'archive')
      if (outcome === 'keep' && get().notes.get(id)?.frontmatter['updated'] !== undefined) {
        await get().patchFrontmatter(id, {})
      }
    },

    setFps(fps) {
      set({ fps })
    },

    selectProject(id) {
      if (id !== null && isVirtualId(id)) return
      set({ projectId: id })
      if (id) get().select(id, { fly: true })
    },

    async toggleTask(id, line, done, from) {
      const res = await rewriteNote(id, (raw, at) => setTaskDone(raw, at, done), 'update the task', line, from)
      return res && { line: res.line, after: res.after }
    },

    async addTask(id, text, section = 'To do') {
      if (!text.trim()) return null
      const res = await rewriteNote(id, (raw) => addTaskToNote(raw, text, section), 'add the task')
      return res ? id : null
    },

    async editTask(id, line, text, from) {
      await rewriteNote(id, (raw, at) => editTaskInNote(raw, at, text), 'edit the task', line, from)
    },

    async deleteTask(id, line, from) {
      const res = await rewriteNote(id, (raw, at) => deleteTaskInNote(raw, at), 'delete the task', line, from)
      if (!res) return
      const text = extractTasks(res.before).find((t) => t.line === res.line)?.text ?? ''
      // Undo restores the note only while it is exactly as the delete left it.
      const undo = async () => {
        let stale = !get().notes.has(id)
        if (!stale) {
          await rewriteNote(
            id,
            (raw) => {
              if (raw === res.after) return res.before
              stale = true
              return raw
            },
            'restore the task',
          )
        }
        if (stale) get().toast('Can’t undo: the note changed since', 'error')
      }
      get().toast(`Deleted “${truncate(text, 48)}”`, 'info', { label: 'Undo', run: () => void undo() })
    },

    async moveTask(id, line, dir, from) {
      // The board lists open and done tasks apart, so a move passes over the other list's tasks.
      await rewriteNote(id, (raw, at) => moveTaskOnBoard(raw, at, dir).raw, 'move the task', line, from)
    },

    async createProject(name, summary) {
      const trimmed = name.trim()
      const { adapter } = get()
      if (!trimmed || !adapter) return null
      if (adapter.readOnly) {
        get().toast('This vault is read-only', 'error')
        return null
      }
      const dir = canonicalFolder(`${get().homePrefix()}Projects`)
      const p = projectNote(summary ? { name: trimmed, summary, dir } : { name: trimmed, dir })
      // Case-insensitive: on Windows `portal game.md` would replace `Portal Game.md`.
      const existing = existingId(idFromPath(p.path))
      if (existing) {
        get().toast(`A project called "${trimmed}" already exists`, 'error')
        return existing
      }
      let id: NoteId
      try {
        id = await addNote(p.path, p.content, { fly: true })
      } catch (err) {
        get().toast(`Could not create the project: ${errText(err)}`, 'error')
        return null
      }
      set({ projectId: id })
      get().toast(`Created project "${trimmed}"${numberedAs(p.path, id)}`, 'success')
      return id
    },

    updateProject(id, patch) {
      return exclusive(id, () => rewriteProject(id, patch))
    },

    async archiveProject(id) {
      const note = isVirtualId(id) ? undefined : get().notes.get(id)
      if (!note) return
      let archived: NoteId
      try {
        archived = await get().moveToArea(id, 'archive')
      } catch (err) {
        get().toast(`Could not archive ${note.meta.title}: ${errText(err)}`, 'error')
        return
      }
      const { projectId } = get()
      if (projectId === id || projectId === archived) set({ projectId: null })
    },

    async deleteProject(id) {
      const note = isVirtualId(id) ? undefined : get().notes.get(id)
      if (!note) return
      try {
        await get().deleteNote(id)
      } catch (err) {
        get().toast(`Could not delete ${note.meta.title}: ${errText(err)}`, 'error')
        return
      }
      if (get().projectId === id) set({ projectId: null })
    },

    assets: new Map(),
    brief: null,
    gallery: null,

    setGallery(star) {
      const path = star !== null && isFolderId(star) ? folderPathOf(star) : null
      if (path === get().gallery) return
      const shown = get().graph?.gallery ?? null
      set({ gallery: path })
      if (get().status !== 'ready' || get().settings.layoutMode !== 'system') return
      // A star without pictures has no cards: nothing to rebuild for (unless a gallery is drawn now).
      const cards = path !== null && picturesUnder(get().assets, path, galaxiesIn(get().graph, path)) > 0
      if (!cards && !shown) return
      keepBrief = true
      try {
        rebuildGraph()
      } catch (err) {
        // The graph stays as it was; so does the gallery the store builds it with.
        set({ gallery: shown?.path ?? null })
        get().toast(`Could not show the gallery: ${errText(err)}`, 'error')
        return
      } finally {
        keepBrief = false
      }
      const open = get().graph?.gallery
      if (open && !galleryHinted) {
        galleryHinted = true
        const title = nodeOf(get().graph, open.star)?.title ?? open.path
        get().toast(`★ ${title}: ${galleryCount(open.cards, open.total, open.videos)} in 3D around the star · Shift+G folds them`)
      }
    },

    toggleGallery() {
      const { graph, settings, selectedId, assets, view } = get()
      if (get().status !== 'ready') return
      if (settings.layoutMode !== 'system') {
        get().toast('Star galleries live in the system layout: press t to get there')
        return
      }
      // The open gallery folds, unless another star is selected: that one opens instead.
      const selected = starOf(graph, selectedId)
      const open = controller.gallery
      if (open !== null && (selected === null || selected === open)) {
        controller.closeGallery()
        return
      }
      const star = selected ?? controller.nearestStar()
      if (!star) {
        get().toast('Select a project star (★) first, or fly close to one')
        return
      }
      const title = nodeOf(graph, star)?.title ?? folderPathOf(star)
      const total = picturesUnder(assets, folderPathOf(star), galaxiesIn(graph, folderPathOf(star)))
      if (total === 0) {
        get().toast(`No pictures under ★ ${title} yet: drop some on the window`)
        return
      }
      galleryHinted = true
      if (COVERING_VIEWS.has(view)) set({ view: 'graph' })
      controller.openGallery(star)
      get().select(star, { fly: true })
      // Once the cards have flown out, frame the whole gallery.
      flyWhenSettled(star)
      const shown = get().graph?.gallery
      get().toast(`★ ${title}: ${galleryCount(shown?.cards ?? total, total, shown?.videos ?? 0)} in 3D · Shift+G folds them`)
    },

    refreshBrief() {
      const { status, brief } = get()
      // Every note or folder change rebuilds the brief already: only a new day can make it stale.
      if (status !== 'ready' || brief?.date === todayIso()) return
      rebuildGraph()
    },

    showNode(id) {
      showNode(id)
    },

    showToday() {
      if (get().status !== 'ready') return
      if (!get().settings.todayHub) {
        get().setSettings({ todayHub: true })
        get().toast('Today hub on')
      }
      showNode(TODAY_ID)
    },

    async openImage(path) {
      const { adapter } = get()
      if (!adapter) return
      if (!adapter.openAsset) {
        get().toast(
          isVideoPath(path)
            ? 'Videos play in your video player from the desktop app'
            : isModelPath(path)
              ? 'Models open in your 3D app from the desktop app'
              : 'Pictures open in your image app from the desktop app',
          'info',
        )
        return
      }
      try {
        await adapter.openAsset(path)
      } catch (err) {
        get().toast(`Could not open ${imageFileName(path)}: ${errText(err)}`, 'error')
      }
    },

    async preview(path, size) {
      const thumbnail = get().adapter?.thumbnail
      if (!thumbnail) return null
      try {
        const adapter = get().adapter
        return await stillFor(path, size, () => thumbnail.call(adapter, path, size))
      } catch {
        return null
      }
    },

    importTarget(folder) {
      if (!get().adapter) return null
      if (folder !== undefined) {
        const dir = canonicalFolder(folder)
        if (insideRoot(dir)) return dir
      } else {
        const { selectedId, graph } = get()
        // A folder takes them itself; a project star (or its note) sends them to its Critique planet.
        if (selectedId !== null && isFolderId(selectedId) && !nodeOf(graph, selectedId)?.folder?.projectId) {
          const dir = folderPathOf(selectedId)
          if (insideRoot(dir)) return dir
        }
        const project = selectedProjectNote()
        if (project) return critiqueTarget(project).dir
      }
      return canonicalFolder(`${get().homePrefix()}Inbox`)
    },

    async importImages(files, folder, opts) {
      const quiet = opts?.quiet === true
      const saved = await savePictures(files, folder, quiet)
      if (!saved) return []
      const written = saved.paths.filter((p): p is string => p !== null)
      const first = written[0]
      if (first === undefined) return []
      if (quiet) return written
      if (get().graph?.index.has(imageKey(first))) get().select(imageKey(first))
      const what = written.length === 1 ? imageFileName(first) : plural(written.length, 'picture')
      get().toast(`Added ${what} to ${saved.dir || 'the vault'}`, 'success', { label: 'Show', run: () => showImage(first) })
      return written
    },

    forgeProjects() {
      const { notes, folders } = get()
      // The board's order: active first, then the most recently updated, done ones last (archived notes are no projects).
      return listProjects(notes, folders).map(({ note }) => {
        const { home, dir } = critiqueTarget(note)
        return { id: note.meta.id, title: note.meta.title, status: note.meta.status, home, critique: dir }
      })
    },

    async saveCritique(input) {
      try {
        return await fileCritique(input)
      } catch (err) {
        // The Forge window shows the message too; the brain says so where the vault is.
        const message = errText(err)
        get().toast(`Could not save the critique: ${message}`, 'error')
        throw err instanceof Error ? err : new Error(message)
      }
    },

    chatImportBase() {
      const home = get().homePrefix()
      const resources = folderSpelling(`${home}Resources`)
      return canonicalFolder(resources ? `${resources}/AI Chats` : `${home}AI Chats`)
    },

    async importChats(input) {
      const { adapter, status } = get()
      if (!adapter || status !== 'ready') {
        get().toast(adapter && status === 'loading' ? 'The vault is still loading; try again in a moment' : 'Open your vault first', 'error')
        return null
      }
      if (adapter.readOnly) {
        get().toast('This vault is read-only', 'error')
        return null
      }
      if (chatImportRunning) {
        get().toast('An import of AI chats is already running; wait for it to finish', 'error')
        return null
      }
      const { archive } = input
      if (!archive.conversations.length && !archive.projects.length) {
        get().toast('No Claude or ChatGPT chats found in that file (use the data export zip, or its conversations.json)', 'error')
        return null
      }
      chatImportRunning = true
      try {
        const base = get().chatImportBase()
        const projects = [...get().notes.values()]
          .filter((n) => n.meta.area !== 'archive' && isProjectNote(n))
          .map((n) => ({ title: n.meta.title, home: projectHomeOf(n) }))
        const plan = planChatImport(archive, get().notes.values(), {
          base,
          projects,
          pictureFiles: adapter.createAsset ? (input.pictures?.files ?? []) : [],
          existingPictures: get().assets.keys(),
        })
        if (!plan.create.length && !plan.update.length && !plan.pictures.length) {
          get().toast(plan.unchanged ? `Nothing new: ${plural(plan.unchanged, 'chat')} already in your brain` : 'Nothing new: everything in that export is already in your brain')
          return null
        }
        if (input.confirm && !(await input.confirm(plan, base))) return null
        if (get().adapter !== adapter) return null
        const total = plan.create.length + plan.pictures.length + plan.update.length
        if (total > 20) get().toast(`Importing ${total.toLocaleString('en-US')} files…`)
        const result = await writeChatImport(plan, input, base, adapter)
        if (result.stopped) {
          get().toast('Another vault was opened, so the import of AI chats stopped; import again in that vault to finish', 'error')
          return result
        }
        const what = [
          result.created ? plural(result.created, 'note') : '',
          result.pictures ? plural(result.pictures, 'picture') : '',
          result.updated ? `${result.updated.toLocaleString('en-US')} updated` : '',
        ].filter(Boolean)
        if (what.length) {
          const home = plan.create.every((p) => p.path === base || p.path.startsWith(`${base}/`))
          const show = () => {
            if (get().folders.has(base) && home) {
              get().showFolder(base)
              if (get().graph?.index.has(folderKey(base))) showNode(folderKey(base))
            } else if (result.first && get().notes.has(result.first)) showNode(result.first)
          }
          const where = home ? base || 'the vault root' : `${base || 'the vault root'} and project planets`
          get().toast(`AI chats imported: ${what.join(', ')} → ${where}`, 'success', { label: 'Show', run: show })
        }
        if (result.failed.length) {
          get().toast(`Could not write ${truncate(result.failed[0] ?? '', 80)}${result.failed.length > 1 ? ` (and ${result.failed.length - 1} more)` : ''}`, 'error')
        }
        return result
      } finally {
        chatImportRunning = false
      }
    },

    /* ---- reference boards ---- */

    boards() {
      return listBoards(get().notes)
    },

    openBoards() {
      const { view, boardPath, lastBoardPath } = get()
      if (view === 'boards') {
        // Already there: from a board to the list, from the list back to the board last open.
        if (boardPath !== null) get().closeBoard()
        else if (lastBoardPath !== null && liveBoard(lastBoardPath)) get().openBoard(lastBoardPath)
        return
      }
      const path = boardPath ?? lastBoardPath
      set({ boardPath: path !== null && liveBoard(path) ? path : null, view: 'boards', formRequest: null })
    },

    openBoard(path) {
      const note = liveBoard(path)
      if (!note) {
        get().toast(`${path} is not a board of this vault`, 'error')
        return
      }
      set({ boardPath: note.meta.path, lastBoardPath: note.meta.path, view: 'boards', formRequest: null })
      saveLastBoard(get().adapter?.location, note.meta.path)
    },

    closeBoard() {
      const { boardPath } = get()
      set(boardPath === null ? {} : { boardPath: null, lastBoardPath: boardPath })
    },

    async newBoard(title, opts) {
      const { adapter, status } = get()
      if (!adapter || status !== 'ready') {
        get().toast('Open a vault first to make a board', 'error')
        return null
      }
      if (adapter.readOnly) {
        get().toast('This vault is read-only', 'error')
        return null
      }
      const dir = canonicalFolder(`${get().homePrefix()}${BOARDS_FOLDER}`)
      // A board's title and file name are one name, and no other note has it (links and the picker find boards by title).
      const names = new Set<string>()
      for (const n of get().notes.values()) {
        names.add(n.meta.title.toLowerCase())
        names.add(basenameOf(n.meta.path).toLowerCase())
        for (const a of n.meta.aliases) names.add(a.toLowerCase())
      }
      const stem = uniqueBoardStem(title ?? '', (lower) => names.has(lower))
      try {
        const made = await createNew(`${dir ? `${dir}/` : ''}${stem}.md`, (p) => newBoardNote(boardTitleOfPath(p), new Date()))
        if (!made) throw new Error(`${stem} is taken`)
        get().applyExternal([{ kind: 'add', path: made.path, content: made.content, mtime: Date.now() }])
        if (opts?.open !== false) {
          get().openBoard(made.path)
          get().toast(`Board “${boardTitleOfPath(made.path)}” made in ${dir || 'the vault'}`, 'success')
        }
        return made.path
      } catch (err) {
        get().toast(`Could not make the board: ${errText(err)}`, 'error')
        return null
      }
    },

    async addPicturesToBoard(picturePaths, boardPath) {
      const target = boardPath ?? get().boardPath ?? get().lastBoardPath
      if (target === null) {
        get().toast('Open or make a board first (8), then add pictures to it', 'error')
        return 0
      }
      const note = liveBoard(target)
      if (!note) {
        get().toast(`${target} is not a board of this vault`, 'error')
        return 0
      }
      if (get().adapter?.readOnly) {
        get().toast('This vault is read-only', 'error')
        return 0
      }
      // A board in the floating window is that window's: it is not told of a rewrite made here, and its next save would be refused.
      const win = getBoardWindowControl()
      const out = win?.available ? win.status() : null
      if (out?.open && out.path !== null && samePath(out.path, note.meta.path)) {
        get().toast(`${note.meta.title} is open in its own window: bring it back to the app first, or add pictures in the window (the + button)`, 'error')
        return 0
      }
      const known = new Set<string>()
      const wanted: string[] = []
      for (const p of picturePaths) {
        if (known.has(p) || !isImagePath(p) || !get().assets.has(p)) continue
        known.add(p)
        wanted.push(p)
        if (wanted.length >= MAX_ADDED_AT_ONCE) break
      }
      if (wanted.length === 0) {
        get().toast(picturePaths.length > 0 ? 'Only pictures of the vault can go on a board' : 'Select a picture first', 'error')
        return 0
      }
      // A board open in the view saves what it holds first, so this edit starts from what the view shows (and the view reloads after).
      const open = getActiveBoard()
      const inView = !!open && samePath(open.path, note.meta.path)
      // The view's unsaved changes are written first, or this rewrite would meet them as an outside change and the next save of the view
      // would take the pictures off again: when they cannot be written, nothing is added.
      if (inView && !(await open.flush())) {
        get().toast(`${note.meta.title} could not be saved first, so the pictures were not added. Save the board (see its message), then add them again.`, 'error')
        return 0
      }
      // Their shapes, read from small previews a few at a time (the desktop makes each in a helper window).
      const aspects: (number | null)[] = wanted.map(() => null)
      let nextShape = 0
      await Promise.all(
        Array.from({ length: Math.min(ASPECT_PARALLEL, wanted.length) }, async () => {
          while (nextShape < wanted.length) {
            const i = nextShape++
            aspects[i] = await pictureAspect(get().preview, wanted[i]!)
          }
        }),
      )
      const sizes: PictureToAdd[] = wanted.map((path, i) => ({ path, ...fitPictureSize(aspects[i] ?? null) }))
      let result: AddedToBoard | null = null
      const done = await rewriteNote(
        note.meta.id,
        (raw) => {
          result = addPicturesToBoardText(raw, sizes)
          return result.text
        },
        'add the pictures to the board',
      )
      const r = result as AddedToBoard | null
      // The edit never ran: rewriteNote said why.
      if (!r) return 0
      const title = note.meta.title
      if (r.added === 0) {
        if (r.over > 0) get().toast(`${title} is full: ${BOARD_BUDGET_TEXT}`, 'error')
        else if (r.full > 0) get().toast(`${title} is full: a board holds at most 1,500 items`, 'error')
        else if (r.skipped > 0) get().toast(`${r.skipped === 1 ? 'That picture is' : 'Those pictures are'} already on ${title}`)
        return 0
      }
      if (!done) return 0
      const what = r.added === 1 ? imageFileName(r.paths[0] ?? '') : plural(r.added, 'picture')
      const notes = [r.skipped ? `${r.skipped} already there` : '', r.full + r.over ? `${r.full + r.over} did not fit` : ''].filter(Boolean)
      const show = inView ? undefined : { label: 'Open', run: () => get().openBoard(note.meta.path) }
      // Some were left out for the size budget: said as the error it is, with the budget.
      if (r.over > 0) get().toast(`${title} is full: added ${what} (${notes.join(', ')}); ${BOARD_BUDGET_TEXT}`, 'error', show)
      else get().toast(`Added ${what} to ${title}${notes.length ? ` (${notes.join(', ')})` : ''}`, 'success', show)
      return r.added
    },

    boardFolderOf(boardPath) {
      return boardFolderOfPath(boardPath)
    },

    async readBoard(path, opts) {
      const quiet = opts?.quiet === true
      const id = existingId(idFromPath(path))
      if (id === null || isVirtualId(id)) {
        if (!quiet) get().toast(`Could not open the board: ${path} is not in the vault`, 'error')
        return null
      }
      return exclusive(id, async () => {
        if (!(await flushDraft(id, 'open the board'))) return null
        const note = await freshNote(id, 'open the board', quiet)
        if (!note) return null
        if (!isBoard(note)) {
          if (!quiet) get().toast(`${note.meta.title} is not a board (its frontmatter has no type: board)`, 'error')
          return null
        }
        return note.raw
      })
    },

    async saveBoard(path, text, expected) {
      const { adapter } = get()
      const id = existingId(idFromPath(path))
      if (!adapter || id === null || isVirtualId(id)) throw new Error(`The board note ${path} is gone from the vault: nothing was saved`)
      if (adapter.readOnly) throw new Error('This vault is read-only: the board was not saved')
      if (!isBoardNote(text)) throw new Error('The text to save is not a board (its frontmatter has no type: board): nothing was saved')
      return exclusive(id, async () => {
        const note = get().notes.get(id)
        if (!note) throw new Error(`The board note ${path} was moved or deleted: nothing was saved`)
        // A draft of the note typed in the editor is the user's; the board never writes over it.
        if (get().editorId === id && get().dirty) throw new Error('The board note has unsaved edits in the editor: save them (or close the editor) and reload the board')
        let disk: string | null
        try {
          disk = await adapter.read(note.meta.path)
        } catch {
          disk = null
        }
        if (disk === null) throw new Error(`The board note ${note.meta.path} is no longer on disk: nothing was saved`)
        if (disk !== text) {
          if (expected !== null && disk !== expected) throw new BoardChangedOutsideError()
          // A save that did not read the note first (expected null) still never turns an ordinary note into a board.
          if (!isBoardNote(disk)) throw new Error(`${note.meta.title} is not a board (its frontmatter has no type: board): nothing was saved`)
          await adapter.write(note.meta.path, text)
        }
        if (get().editorId === id && !get().dirty) set({ draft: text })
        // Also when the file already held this text: the store catches up with the disk.
        if (get().notes.get(id)?.raw !== text) get().applyExternal([{ kind: 'change', path: note.meta.path, content: text, mtime: Date.now() }])
      })
    },

    async readPicture(path) {
      const { adapter } = get()
      if (!adapter?.readAsset) return null
      // The desktop adapter says why there is no picture: a verdict about the file ('too-large') is not "can't be read".
      const checked = adapter as typeof adapter & CheckedAssetReader
      if (checked.readAssetChecked && isImagePath(path)) {
        let res: Awaited<ReturnType<NonNullable<CheckedAssetReader['readAssetChecked']>>>
        try {
          res = await checked.readAssetChecked(path)
        } catch {
          return null
        }
        if (res.blob !== null) return res.blob
        throw Object.assign(new Error(res.detail), { reason: res.reason })
      }
      try {
        return await adapter.readAsset(path)
      } catch {
        return null
      }
    },

    async importBoardPictures(boardPath, files) {
      const key = boardPath.toLowerCase()
      const home = boardFolderOfPath(boardPath)
      const first = boardPictureFolders.get(key) ?? home
      const saved = await savePictures(files, first, true)
      if (!saved) return files.map(() => null)
      const { paths } = saved
      /** What went wrong in the end: the first pass's failures, less those a second try put right. */
      let failures = saved.failures
      // The vault will not take the board's folder (a name the user left out of it): once, a folder beside it, from then on too.
      if (first === home) {
        const retry = files.map((_, i) => i).filter((i) => paths[i] === null && failures.some((f) => (f.index === i || f.index === -1) && OUT_OF_VAULT.test(f.message)))
        if (retry.length > 0) {
          const fallback = boardFolderFallback(home)
          boardPictureFolders.set(key, fallback)
          const again = await savePictures(
            retry.map((i) => files[i]!),
            fallback,
            true,
          )
          if (again) {
            retry.forEach((i, k) => {
              paths[i] = again.paths[k] ?? null
            })
            const tried = new Set(retry)
            failures = [
              ...failures.filter((f) => f.index !== -1 && !tried.has(f.index)),
              ...again.failures.map((f) => ({ index: f.index < 0 ? -1 : (retry[f.index] ?? -1), message: f.message })),
            ]
          }
        }
      }
      // A write that failed for its own reason (a full disk, a locked file) is said once, here: the caller only learns "not added".
      // Files that were not pictures, or too big, the caller already knows about.
      const real = failures.filter((f) => !/is not a picture|is over 40 MB/.test(f.message))
      if (real.length > 0 && paths.some((p) => p === null)) get().toast(`Could not add ${plural(real.length, 'picture')} to the board: ${truncate(real[0]?.message ?? '', 120)}`, 'error')
      return paths
    },

    showPicture(path) {
      showImage(path)
    },
  }
})

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return todayIso(d)
}

/** Selector helpers */
export const selectNote = (id: NoteId | null) => (s: AetherState) => (id ? (s.notes.get(id) ?? null) : null)
