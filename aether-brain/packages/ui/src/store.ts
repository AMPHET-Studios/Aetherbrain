import { create } from 'zustand'
import {
  AREA_FOLDER,
  SearchIndex,
  addTask as addTaskToNote,
  applyChanges,
  areaFromFolder,
  asString,
  basenameOf,
  blankNote,
  buildGraph,
  dailyNote,
  deleteTask as deleteTaskInNote,
  editTask as editTaskInNote,
  extractTasks,
  folderKey,
  folderOf,
  folderPathOf,
  folderProjectNote,
  ghostTitle,
  homePrefix as homePrefixOf,
  idFromPath,
  inboxNote,
  isFolderId,
  isGhostId,
  isIgnoredPath,
  isProjectNote,
  loadVault,
  mountOf,
  moveTask as moveTaskInNote,
  neighborhood,
  normalizeFolderPath,
  normalizePath,
  projectFolderOf,
  projectNote,
  setProjectFields,
  setTaskDone,
  slugifyTitle,
  splitFrontmatter,
  todayIso,
  updateFrontmatter,
  type Area,
  type GraphData,
  type GraphOptionsFn,
  type NoteId,
  type NoteType,
  type ParsedNote,
  type ProjectPatch,
  type VaultAdapter,
  type VaultChange,
  type VaultRootInfo,
} from '@aether/core'
import { BrainController, type ColorMode, type LayoutMode } from '@aether/graph'
import { truncate } from './util'

export type View = 'graph' | 'editor' | 'capture' | 'search' | 'review' | 'projects'

export interface Filters {
  areas: Set<Area>
  tags: Set<string>
  types: Set<NoteType>
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

/** An inline form a command can ask for: a new project (the board), a note or a folder in the selected folder (the folder inspector). */
export type FormRequest = 'project' | 'note' | 'folder'

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
  /** Settings version; 2 = the solar-system layout became the default. */
  v: number
}

const SETTINGS_KEY = 'aether:settings'
const REVIEW_KEY = 'aether:review'
/** Expanded folders, per vault location. */
const EXPANDED_KEY = 'aether:expanded:'
const SETTINGS_VERSION = 2
const LAYOUTS: LayoutMode[] = ['constellation', 'orbit', 'system']
const LAYOUT_TOASTS: Record<LayoutMode, string> = {
  constellation: 'Constellation layout — clustered by area',
  orbit: 'Orbit layout — time as rings, newest at the core',
  system: 'System layout — folders are stars and planets, notes are moons',
}
const DEFAULT_SETTINGS: Settings = {
  colorMode: 'area',
  layoutMode: 'system',
  bloom: true,
  hubLabels: true,
  previewMode: 'split',
  folderDepth: 3,
  motion: true,
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
  if (stored && !(typeof stored.v === 'number' && stored.v >= SETTINGS_VERSION)) {
    s.layoutMode = 'system'
    s.v = SETTINGS_VERSION
    saveJson(SETTINGS_KEY, s)
  }
  return s
}

function loadExpanded(location: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY + location) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').map(normalizeFolderPath) : [])
  } catch {
    return new Set()
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
  clearFilters(): void
  setActiveTag(tag: string | null): void
  setSettings(patch: Partial<Settings>): void
  cycleColorMode(): void
  /** Cycle constellation → orbit → system. */
  toggleLayout(): void
  /** System layout: orbits moving / paused. */
  toggleMotion(): void

  /** Where new notes go: '' for one root, `<first mount>/` for several. */
  homePrefix(): string
  /** Expand / collapse a folder (its subfolders are always shown while expanded). */
  toggleFolder(path: string): void
  setFolderDepth(n: number): void
  /** Select a folder's node and fly to it, switching to the system layout (and expanding its parent) when needed. */
  showFolder(path: string): void
  /** Create a folder on disk (a new planet); returns its path, or null (with a toast) when it can't. */
  createFolder(path: string): Promise<string | null>
  /** Make a folder a project star by writing its folder note `<folder>/<name>.md`. */
  makeProject(folderPath: string): Promise<NoteId | null>
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
   * the file it rewrites (a pending draft is saved first).
   */
  toggleTask(id: NoteId, line: number, done: boolean, from?: string): Promise<void>
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
   * (folder notes keep their name). Returns the (possibly new) id; errors toast.
   */
  updateProject(id: NoteId, patch: ProjectPatch & { renameFile?: boolean }): Promise<NoteId>
  archiveProject(id: NoteId): Promise<void>
  /** Delete the project note (the UI confirms first). Its folder stays on disk. */
  deleteProject(id: NoteId): Promise<void>
}

let toastSeq = 1
let unwatch: (() => void) | null = null

export const useAether = create<AetherState>()((set, get) => {
  const controller = new BrainController()
  const settings = loadSettings()
  controller.colorMode = settings.colorMode
  controller.layoutMode = settings.layoutMode
  controller.bloom = settings.bloom
  controller.hubLabels = settings.hubLabels
  controller.motion = settings.motion

  controller.events = {
    onSelect: (id) => get().select(id),
    onOpen: (id) => get().openNote(id, { fly: true }),
    onHover: (id) => set({ hoveredId: id }),
  }

  /** Folder nodes (the system layout) only in 'system' mode. */
  const graphOptions: GraphOptionsFn = (folders) => {
    const { settings, adapter, roots, expandedFolders } = get()
    if (settings.layoutMode !== 'system') return {}
    const mountLabels: Record<string, string> = {}
    for (const r of roots) if (r.mount) mountLabels[r.mount] = r.label
    return {
      folders: {
        all: folders,
        rootTitle: adapter?.name ?? 'Vault',
        mountLabels,
        maxDepth: settings.folderDepth,
        expanded: expandedFolders,
        multiRoot: roots.length > 1,
      },
    }
  }

  const nodeOf = (graph: GraphData | null, id: NoteId | null) => (graph && id !== null ? graph.nodes[graph.index.get(id) ?? -1] : undefined)

  const syncHighlight = () => {
    const { filters, graph, search, notes } = get()
    if (!graph) return
    const anyFilter = filters.areas.size > 0 || filters.tags.size > 0 || filters.types.size > 0 || filters.query.trim().length > 0
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
    for (const n of notes.values()) {
      const m = n.meta
      if (ids && !ids.has(m.id)) continue
      if (filters.areas.size && !filters.areas.has(m.area)) continue
      if (filters.types.size && !filters.types.has(m.type)) continue
      if (filters.tags.size && ![...filters.tags].every((t) => m.tags.includes(t))) continue
      out.add(m.id)
    }
    // System layout: keep the folders that hold a match lit, so the structure still reads.
    if (graph.folderSelection) {
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

  const setLoaded = (notes: Map<NoteId, ParsedNote>, graph: GraphData, folders: Set<string>) => {
    const before = get().graph
    set((s) => ({ notes, graph, folders, revision: s.revision + 1 }))
    controller.setGraph(graph)
    syncHighlight()
    pruneSelection(graph, before)
    const { editorId, dirty } = get()
    if (editorId && !notes.has(editorId)) {
      if (!dirty) set({ editorId: null, draft: null })
    } else if (editorId && !dirty) {
      set({ draft: notes.get(editorId)?.raw ?? null })
    }
  }

  /** Rebuild the graph from the notes we have (layout mode, folder depth or expanded folders changed). */
  const rebuildGraph = () => {
    const { notes, folders, settings, status, graph: before } = get()
    if (status !== 'ready') {
      controller.setLayoutMode(settings.layoutMode)
      return
    }
    const graph = buildGraph(notes, graphOptions(folders, notes))
    set((s) => ({ graph, revision: s.revision + 1 }))
    controller.setLayoutMode(settings.layoutMode, graph)
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
    const lower = path.toLowerCase()
    for (const f of folders) if (f.length === path.length && f.toLowerCase() === lower) return f
    return null
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

  /** The id of the note at `id` under any spelling (case-insensitive), or null. */
  const existingId = (id: NoteId): NoteId | null => {
    const { notes } = get()
    if (notes.has(id)) return id
    const lower = id.toLowerCase()
    for (const k of notes.keys()) if (k.length === id.length && k.toLowerCase() === lower) return k
    return null
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

  /** `path`, or `path` with ` 2`, ` 3` … before `.md` while a note with that id exists (case-insensitive, like Windows). */
  const freePath = (path: string): string => {
    const taken = new Set([...get().notes.keys()].map((k) => k.toLowerCase()))
    let out = path
    for (let i = 2; taken.has(idFromPath(out).toLowerCase()); i++) out = path.replace(/\.md$/i, ` ${i}.md`)
    return out
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
    return (newId: NoteId, content: string) => {
      set((now) => ({
        projectId: project ? newId : now.projectId,
        history: now.history.map((h) => (h === id ? newId : h)),
        ...(open ? { editorId: newId, draft: content, dirty: false } : {}),
      }))
      if (selected) get().select(newId)
    }
  }

  /**
   * Rewrite one note through `edit` (tasks, project fields); `updated` is
   * stamped in place. `line` (a task line, -1 for none) counts lines in
   * `from` — the text the caller showed — else in the note as the store holds
   * it. A pending editor draft of the note is saved first and `line` is
   * followed into the file (`edit` gets the line to use). Returns the text
   * before and after and the line used, or null when nothing changed or it
   * failed (toasted as "Could not <what>").
   */
  const rewriteNote = async (
    id: NoteId,
    edit: (raw: string, line: number) => string,
    what: string,
    line = -1,
    from?: string,
  ): Promise<{ before: string; after: string; path: string; line: number } | null> => {
    const { adapter } = get()
    const shown = from ?? get().notes.get(id)?.raw
    if (!adapter || shown === undefined || !get().notes.has(id)) return null
    if (!(await flushDraft(id, what))) return null
    const note = get().notes.get(id)
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
    if (get().editorId === id) set({ draft: content, dirty: false })
    get().applyExternal([{ kind: 'change', path: note.meta.path, content, mtime: Date.now() }])
    return { before: note.raw, after: content, path: note.meta.path, line: at }
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
    filters: { areas: new Set(), tags: new Set(), types: new Set(), query: '' },
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

    async openVault(adapter) {
      unwatch?.()
      unwatch = null
      set({
        adapter,
        roots: adapter.roots ?? [],
        folders: new Set(),
        expandedFolders: loadExpanded(adapter.location),
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
      })
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
        set({ search, status: 'ready', loadProgress: null })
        setLoaded(loaded.notes, loaded.graph, loaded.folders)
        unwatch = adapter.watch((changes) => get().applyExternal(changes))
      } catch (err) {
        set({ status: 'error', error: errText(err) })
      }
    },

    async reload() {
      const { adapter } = get()
      if (adapter) await get().openVault(adapter)
    },

    applyExternal(changes) {
      const { notes, search, folders, editorId, dirty } = get()
      const next = applyChanges(notes, changes, search, { folders, graph: graphOptions })
      if (editorId && dirty && next.touched.includes(editorId)) {
        get().toast('This note changed on disk while you were editing. Your draft is kept; save to overwrite.', 'info')
      }
      setLoaded(next.notes, next.graph, next.folders)
    },

    select(id, opts) {
      set({ selectedId: id })
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
      const note = notes.get(id)
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
      controller.setSelected(id)
      if (opts?.fly !== false) controller.flyTo(id)
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
      const note = get().notes.get(id)
      if (note) {
        set({ editorId: id, draft: note.raw, dirty: false, selectedId: id })
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
      const note = get().notes.get(id)
      if (note) {
        set({ editorId: id, draft: note.raw, dirty: false, selectedId: id })
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
        // A folder's neighbors are structural: its parent, then its planets and moons.
        const parent = nodeOf(graph, selectedId)?.parent ?? null
        ring = [...(parent !== null ? [parent] : []), ...graph.nodes.filter((n) => n.parent === selectedId).map((n) => n.id)]
      } else {
        ring = [...neighborhood(graph, selectedId, 1)].filter((id) => id !== selectedId).sort()
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
        get().applyExternal([{ kind: 'change', path: note.meta.path, content, mtime: Date.now() }])
      } catch (err) {
        get().toast(`Save failed: ${errText(err)}`, 'error')
      }
    },

    async writeNote(path, content, opts) {
      const { adapter } = get()
      if (!adapter) throw new Error('No vault open')
      const p = normalizePath(path)
      await adapter.write(p, content)
      get().applyExternal([{ kind: 'add', path: p, content, mtime: Date.now() }])
      const id = idFromPath(p)
      if (opts?.open) get().openNote(id, { fly: opts.fly ?? true })
      else if (opts?.fly) get().select(id, { fly: true })
      return id
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
      const path = freePath(`${mount ? `${mount}/` : ''}${n.path}`)
      try {
        const id = await get().writeNote(path, n.content, { open: true })
        get().toast(`Created "${name}" in ${dir || 'the vault root'}`, 'success')
        return id
      } catch (err) {
        get().toast(`Could not create the note: ${errText(err)}`, 'error')
        return null
      }
    },

    async deleteNote(id) {
      const { adapter, notes } = get()
      const note = notes.get(id)
      if (!adapter || !note) return
      await adapter.remove(note.meta.path)
      // Close the editor on it; an overlay (the Projects board deleting its project) stays open.
      if (get().editorId === id) set({ editorId: null, draft: null, dirty: false, ...(get().view === 'editor' ? { view: 'graph' as const } : {}) })
      get().applyExternal([{ kind: 'unlink', path: note.meta.path }])
      get().toast(`Deleted ${note.meta.title}`, 'info')
    },

    async renameNote(id, toPath) {
      const { adapter } = get()
      if (!adapter || !get().notes.has(id)) throw new Error('No such note')
      if (!(await flushDraft(id, 'rename the note'))) return id
      const note = get().notes.get(id)
      if (!note) throw new Error('No such note')
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
    },

    async moveToArea(id, area) {
      if (!get().notes.has(id)) throw new Error('No such note')
      // The move starts from the saved file: an unsaved draft goes first (or the move waits).
      if (!(await flushDraft(id, 'move the note'))) return id
      const { notes, roots } = get()
      const note = notes.get(id)
      if (!note) throw new Error('No such note')
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
    },

    async patchFrontmatter(id, patch) {
      const { adapter } = get()
      if (!adapter || !get().notes.has(id)) return
      // Patch what the user typed, not the file under it (a draft saved later would undo the patch).
      if (!(await flushDraft(id, 'update the note'))) return
      const note = get().notes.get(id)
      if (!note) return
      if (hasBrokenFrontmatter(note.raw)) {
        get().toast(`The frontmatter of ${note.meta.title} is not valid YAML; fix it in the editor first`, 'error')
        return
      }
      const content = updateFrontmatter(note.raw, { ...patch, updated: todayIso() })
      await adapter.write(note.meta.path, content)
      if (get().editorId === id && !get().dirty) set({ draft: content })
      get().applyExternal([{ kind: 'change', path: note.meta.path, content, mtime: Date.now() }])
    },

    async createGhost(id) {
      const title = ghostTitle(id)
      const n = blankNote(title, 'Inbox')
      const dir = canonicalFolder(`${get().homePrefix()}Inbox`)
      try {
        await get().writeNote(freePath(`${dir}/${fileNameOf(n.path)}`), n.content, { open: true })
      } catch (err) {
        get().toast(`Could not create "${title}": ${errText(err)}`, 'error')
        return
      }
      get().toast(`Created "${title}" in ${dir}`, 'success')
    },

    async capture(text, tags) {
      const n = inboxNote({ text, ...(tags ? { tags } : {}) })
      // Never clobber: suffix if a capture with the same title exists.
      const path = freePath(`${canonicalFolder(`${get().homePrefix()}Inbox`)}/${fileNameOf(n.path)}`)
      const id = await get().writeNote(path, n.content, { fly: true })
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
      try {
        await get().writeNote(`${dir}/${fileNameOf(d.path)}`, d.content, { open: true })
      } catch (err) {
        get().toast(`Could not create today's note: ${errText(err)}`, 'error')
      }
    },

    async appendLink(fromId, toId) {
      const { adapter, notes } = get()
      const from = notes.get(fromId)
      const to = notes.get(toId)
      if (!adapter || !from || !to) return
      const content = `${from.raw.replace(/\s+$/, '')}\n\n- Related: [[${to.meta.title}]]\n`
      await adapter.write(from.meta.path, content)
      if (get().editorId === fromId) set({ draft: content, dirty: false })
      get().applyExternal([{ kind: 'change', path: from.meta.path, content, mtime: Date.now() }])
      get().toast(`Linked ${from.meta.title} → ${to.meta.title}`, 'success')
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
    clearFilters() {
      set({ filters: { areas: new Set(), tags: new Set(), types: new Set(), query: '' } })
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
      set({ settings: next })
      saveJson(SETTINGS_KEY, next)
      controller.setColorMode(next.colorMode)
      controller.setBloom(next.bloom)
      controller.setHubLabels(next.hubLabels)
      controller.setMotion(next.motion)
      // Only system graphs carry folder nodes: crossing system ↔ others, or a new depth, rebuilds.
      const crossed = (prev.layoutMode === 'system') !== (next.layoutMode === 'system')
      const depth = next.layoutMode === 'system' && prev.folderDepth !== next.folderDepth
      if (crossed || depth) rebuildGraph()
      else if (prev.layoutMode !== next.layoutMode) controller.setLayoutMode(next.layoutMode)
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

    showFolder(path) {
      const p = normalizeFolderPath(path)
      const id = folderKey(p)
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
      if (get().settings.layoutMode === 'system') get().showFolder(p)
      return p
    },

    async makeProject(folderPath) {
      const { adapter, notes, folders, roots } = get()
      if (!adapter) return null
      if (adapter.readOnly) {
        get().toast('This vault is read-only', 'error')
        return null
      }
      const dir = canonicalFolder(folderPath)
      if (!dir || (roots.length > 1 && !dir.includes('/'))) {
        get().toast('Pick a folder inside the vault, not the vault or a drive itself', 'error')
        return null
      }
      if (areaFromFolder(`${dir}/x.md`) === 'archive') {
        get().toast('Archived folders are not projects; move it out of Archive first', 'error')
        return null
      }
      const existing = [...notes.values()].find((n) => isProjectNote(n) && projectFolderOf(n, folders) === dir)
      if (existing) {
        set({ projectId: existing.meta.id })
        get().toast(`${dir} is already the project ${existing.meta.title}`)
        return existing.meta.id
      }
      const p = folderProjectNote(dir)
      // Its folder note under any spelling (`Drawing/drawing.md`): a second file would replace it on Windows.
      const id = existingId(idFromPath(p.path)) ?? idFromPath(p.path)
      const folderNote = notes.get(id)
      try {
        if (folderNote) {
          // The folder already has its folder note: it becomes the star.
          if (hasBrokenFrontmatter(folderNote.raw)) {
            get().toast(`The frontmatter of ${folderNote.meta.path} is not valid YAML; fix it first`, 'error')
            return null
          }
          await get().patchFrontmatter(id, { type: 'project', ...(folderNote.meta.status ? {} : { status: 'active' }) })
        } else {
          await get().writeNote(p.path, p.content)
        }
      } catch (err) {
        get().toast(`Could not make ${dir} a project: ${errText(err)}`, 'error')
        return null
      }
      set({ projectId: id })
      get().toast(`★ ${p.title} is a project now`, 'success')
      return id
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
      const view = form === 'project' ? 'projects' : form && get().view === 'projects' ? 'graph' : get().view
      set({ formRequest: form, view })
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
      set({ projectId: id })
      if (id) get().select(id, { fly: true })
    },

    async toggleTask(id, line, done, from) {
      await rewriteNote(id, (raw, at) => setTaskDone(raw, at, done), 'update the task', line, from)
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
      await rewriteNote(id, (raw, at) => moveTaskInNote(raw, at, dir, { sameState: true }).raw, 'move the task', line, from)
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
        id = await get().writeNote(p.path, p.content, { fly: true })
      } catch (err) {
        get().toast(`Could not create the project: ${errText(err)}`, 'error')
        return null
      }
      set({ projectId: id })
      get().toast(`Created project "${trimmed}"`, 'success')
      return id
    },

    async updateProject(id, patch) {
      const { adapter } = get()
      if (!adapter) return id
      if (adapter.readOnly) {
        get().toast('This vault is read-only', 'error')
        return id
      }
      if (!(await flushDraft(id, 'update the project'))) return id
      const note = get().notes.get(id)
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
          if ([...get().notes.keys()].some((k) => k !== id && k.toLowerCase() === lower)) {
            get().toast(`${candidate} already exists; the file keeps its name`)
          } else {
            to = candidate
            // A sibling folder (Projects/Old/) is bound by name: keep it bound under the new name.
            const home = projectFolderOf(note, get().folders)
            if (fields.folder === undefined && home && !asString(note.frontmatter['folder'])) fields.folder = home
          }
        }
      }
      let content: string
      try {
        content = setProjectFields(note.raw, fields)
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
          if (get().editorId === id) set({ draft: content, dirty: false })
        }
        return id
      }
      const mtime = Date.now()
      if (to === note.meta.path) {
        get().applyExternal([{ kind: 'change', path: to, content, mtime }])
        if (get().editorId === id) set({ draft: content, dirty: false })
        return id
      }
      get().applyExternal([
        { kind: 'unlink', path: note.meta.path },
        { kind: 'add', path: to, content, mtime },
      ])
      const newId = idFromPath(to)
      follow(newId, content)
      return newId
    },

    async archiveProject(id) {
      const note = get().notes.get(id)
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
      const note = get().notes.get(id)
      if (!note) return
      try {
        await get().deleteNote(id)
      } catch (err) {
        get().toast(`Could not delete ${note.meta.title}: ${errText(err)}`, 'error')
        return
      }
      if (get().projectId === id) set({ projectId: null })
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
