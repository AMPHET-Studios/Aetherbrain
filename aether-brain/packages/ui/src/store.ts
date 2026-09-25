import { create } from 'zustand'
import {
  AREA_FOLDER,
  SearchIndex,
  addTask as addTaskToNote,
  applyChanges,
  basenameOf,
  blankNote,
  dailyNote,
  ghostTitle,
  idFromPath,
  inboxNote,
  isGhostId,
  loadVault,
  neighborhood,
  normalizePath,
  projectNote,
  setTaskDone,
  todayIso,
  updateFrontmatter,
  type Area,
  type GraphData,
  type NoteId,
  type NoteType,
  type ParsedNote,
  type VaultAdapter,
  type VaultChange,
} from '@aether/core'
import { BrainController, type ColorMode, type LayoutMode } from '@aether/graph'

export type View = 'graph' | 'editor' | 'capture' | 'search' | 'review' | 'projects'

export interface Filters {
  areas: Set<Area>
  tags: Set<string>
  types: Set<NoteType>
  query: string
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error' | 'success'
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

export interface Settings {
  colorMode: ColorMode
  layoutMode: LayoutMode
  bloom: boolean
  hubLabels: boolean
  previewMode: 'split' | 'edit' | 'preview'
}

const SETTINGS_KEY = 'aether:settings'
const REVIEW_KEY = 'aether:review'

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

  select(id: NoteId | null, opts?: { fly?: boolean }): void
  hover(id: NoteId | null): void
  openNote(id: NoteId, opts?: { fly?: boolean; view?: View }): void
  closeEditor(): void
  goBack(): void
  goForward(): void
  cycleNeighbor(dir: 1 | -1): void

  setView(view: View): void
  setPalette(open: boolean): void
  setHelp(open: boolean): void

  setDraft(text: string): void
  saveDraft(): Promise<void>
  writeNote(path: string, content: string, opts?: { open?: boolean; fly?: boolean }): Promise<NoteId>
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
  toggleLayout(): void

  toast(text: string, kind?: Toast['kind']): void
  dismissToast(id: number): void
  reviewMark(id: NoteId, outcome: ReviewOutcome): Promise<void>
  setFps(fps: number): void

  /** Live progress while a vault loads (listing, reading, parsing, indexing). */
  loadProgress: { label: string; done: number; total: number } | null
  setLoadProgress(p: { label: string; done: number; total: number } | null): void

  /** Project selected on the Projects board (a note id). */
  projectId: NoteId | null
  selectProject(id: NoteId | null): void
  /** Tick/untick the task on a raw-file line; writes `[x] … ✅ date` into the note. */
  toggleTask(id: NoteId, line: number, done: boolean): Promise<void>
  /** Append a task under `## To do` (created if missing). */
  addTask(id: NoteId, text: string, section?: string): Promise<NoteId | null>
  createProject(name: string, summary?: string): Promise<NoteId | null>
}

let toastSeq = 1
let unwatch: (() => void) | null = null

export const useAether = create<AetherState>()((set, get) => {
  const controller = new BrainController()
  const settings = loadJson<Settings>(SETTINGS_KEY, {
    colorMode: 'area',
    layoutMode: 'constellation',
    bloom: true,
    hubLabels: true,
    previewMode: 'split',
  })
  controller.colorMode = settings.colorMode
  controller.layoutMode = settings.layoutMode
  controller.bloom = settings.bloom
  controller.hubLabels = settings.hubLabels

  controller.events = {
    onSelect: (id) => get().select(id),
    onOpen: (id) => get().openNote(id, { fly: true }),
    onHover: (id) => set({ hoveredId: id }),
  }

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
    controller.setHighlight(out)
  }

  const setLoaded = (notes: Map<NoteId, ParsedNote>, graph: GraphData) => {
    set((s) => ({ notes, graph, revision: s.revision + 1 }))
    controller.setGraph(graph)
    syncHighlight()
    const { editorId, dirty, selectedId } = get()
    if (selectedId && !graph.index.has(selectedId)) set({ selectedId: null })
    if (editorId && !notes.has(editorId)) {
      if (!dirty) set({ editorId: null, draft: null })
    } else if (editorId && !dirty) {
      set({ draft: notes.get(editorId)?.raw ?? null })
    }
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

    async openVault(adapter) {
      unwatch?.()
      unwatch = null
      set({ adapter, status: 'loading', error: null, selectedId: null, editorId: null, draft: null, dirty: false, loadProgress: null })
      try {
        const search = new SearchIndex()
        const loaded = await loadVault(adapter, search, (p) => {
          if (p.phase === 'listing') return // the adapter reports its own listing progress
          set({ loadProgress: { label: p.phase === 'parsing' ? 'Parsing notes' : 'Building the graph', done: p.done, total: p.total } })
        })
        set({ search, status: 'ready', loadProgress: null })
        setLoaded(loaded.notes, loaded.graph)
        unwatch = adapter.watch((changes) => get().applyExternal(changes))
      } catch (err) {
        set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
      }
    },

    async reload() {
      const { adapter } = get()
      if (adapter) await get().openVault(adapter)
    },

    applyExternal(changes) {
      const { notes, search, editorId, dirty } = get()
      const next = applyChanges(notes, changes, search)
      if (editorId && dirty && next.touched.includes(editorId)) {
        get().toast('This note changed on disk while you were editing. Your draft is kept; save to overwrite.', 'info')
      }
      setLoaded(next.notes, next.graph)
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
        const hubs = graph.nodes.filter((n) => !n.ghost).sort((a, b) => b.degree - a.degree)
        const first = hubs[0]
        if (first) get().select(first.id, { fly: true })
        return
      }
      const ring = [...neighborhood(graph, selectedId, 1)].filter((id) => id !== selectedId).sort()
      if (ring.length === 0) return
      const cur = get().hoveredId && ring.includes(get().hoveredId!) ? ring.indexOf(get().hoveredId!) : -1
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
      let content = draft
      // Touch `updated` if the note tracks it.
      if (Object.prototype.hasOwnProperty.call(note.frontmatter, 'updated')) {
        content = updateFrontmatter(content, { updated: todayIso() })
      }
      try {
        await adapter.write(note.meta.path, content)
        set({ dirty: false, draft: content })
        get().applyExternal([{ kind: 'change', path: note.meta.path, content, mtime: Date.now() }])
      } catch (err) {
        get().toast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
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

    async deleteNote(id) {
      const { adapter, notes } = get()
      const note = notes.get(id)
      if (!adapter || !note) return
      await adapter.remove(note.meta.path)
      if (get().editorId === id) set({ editorId: null, draft: null, dirty: false, view: 'graph' })
      get().applyExternal([{ kind: 'unlink', path: note.meta.path }])
      get().toast(`Deleted ${note.meta.title}`, 'info')
    },

    async renameNote(id, toPath) {
      const { adapter, notes } = get()
      const note = notes.get(id)
      if (!adapter || !note) throw new Error('No such note')
      const to = normalizePath(toPath.endsWith('.md') ? toPath : `${toPath}.md`)
      if (to === note.meta.path) return id
      await adapter.rename(note.meta.path, to)
      const newId = idFromPath(to)
      const wasOpen = get().editorId === id
      get().applyExternal([
        { kind: 'unlink', path: note.meta.path },
        { kind: 'add', path: to, content: note.raw, mtime: Date.now() },
      ])
      if (wasOpen) set({ editorId: newId, draft: get().notes.get(newId)?.raw ?? note.raw, dirty: false })
      if (get().selectedId === id) get().select(newId)
      return newId
    },

    async moveToArea(id, area) {
      const { notes } = get()
      const note = notes.get(id)
      if (!note) throw new Error('No such note')
      const folder = AREA_FOLDER[area]
      const typeByArea: Partial<Record<Area, NoteType>> = { inbox: 'inbox', projects: 'project', areas: 'area', resources: 'resource' }
      let content = note.raw
      const patch: Record<string, unknown> = { updated: todayIso() }
      if (note.meta.status === 'unprocessed') patch['status'] = area === 'archive' ? 'done' : 'active'
      const t = typeByArea[area]
      if (note.meta.type === 'inbox' && t) patch['type'] = t
      content = updateFrontmatter(content, patch)
      const { adapter } = get()
      if (!adapter) throw new Error('No vault open')
      const to = `${folder}/${basenameOf(note.meta.path)}.md`
      if (to !== note.meta.path) {
        await adapter.rename(note.meta.path, to)
      }
      await adapter.write(to, content)
      const changes: VaultChange[] = to !== note.meta.path ? [{ kind: 'unlink', path: note.meta.path }] : []
      changes.push({ kind: 'add', path: to, content, mtime: Date.now() })
      const newId = idFromPath(to)
      const wasOpen = get().editorId === id
      get().applyExternal(changes)
      if (wasOpen) set({ editorId: newId, draft: content, dirty: false })
      if (get().selectedId === id) get().select(newId)
      get().toast(`Moved to ${folder}`, 'success')
      return newId
    },

    async patchFrontmatter(id, patch) {
      const { adapter, notes } = get()
      const note = notes.get(id)
      if (!adapter || !note) return
      const content = updateFrontmatter(note.raw, { ...patch, updated: todayIso() })
      await adapter.write(note.meta.path, content)
      if (get().editorId === id && !get().dirty) set({ draft: content })
      get().applyExternal([{ kind: 'change', path: note.meta.path, content, mtime: Date.now() }])
    },

    async createGhost(id) {
      const title = ghostTitle(id)
      const n = blankNote(title, 'Inbox')
      await get().writeNote(n.path, n.content, { open: true })
      get().toast(`Created "${title}" in Inbox`, 'success')
    },

    async capture(text, tags) {
      const n = inboxNote({ text, ...(tags ? { tags } : {}) })
      let path = n.path
      // Never clobber: suffix if a capture with the same title exists.
      let i = 2
      while (get().notes.has(idFromPath(path))) path = n.path.replace(/\.md$/, ` ${i++}.md`)
      const id = await get().writeNote(path, n.content, { fly: true })
      get().toast(`Captured "${n.title}" → Inbox`, 'success')
      return id
    },

    async openDaily() {
      const day = todayIso()
      const id = `Daily/${day}`
      if (get().notes.has(id)) {
        get().openNote(id, { fly: true })
        return
      }
      const prev = [...get().notes.keys()]
        .filter((k) => k.startsWith('Daily/') && k < id)
        .sort()
        .pop()
      const d = dailyNote(day, prev ? basenameOf(prev) : null)
      await get().writeNote(d.path, d.content, { open: true })
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
      const next = { ...get().settings, ...patch }
      set({ settings: next })
      saveJson(SETTINGS_KEY, next)
      controller.setColorMode(next.colorMode)
      controller.setLayoutMode(next.layoutMode)
      controller.setBloom(next.bloom)
      controller.setHubLabels(next.hubLabels)
    },
    cycleColorMode() {
      const order: ColorMode[] = ['area', 'type', 'tag', 'age']
      const cur = get().settings.colorMode
      const next = order[(order.indexOf(cur) + 1) % order.length]!
      get().setSettings({ colorMode: next })
      get().toast(`Color by ${next}`)
    },
    toggleLayout() {
      const next: LayoutMode = get().settings.layoutMode === 'constellation' ? 'orbit' : 'constellation'
      get().setSettings({ layoutMode: next })
      get().toast(next === 'orbit' ? 'Orbit layout — time as rings, newest at the core' : 'Constellation layout — clustered by area')
    },

    toast(text, kind = 'info') {
      const id = toastSeq++
      set((s) => ({ toasts: [...s.toasts, { id, text, kind }].slice(-4) }))
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 3200)
    },
    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
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

    async toggleTask(id, line, done) {
      const { adapter, editorId, dirty } = get()
      if (!adapter) return
      // A pending editor draft for this note is flushed first so line numbers agree.
      if (editorId === id && dirty) await get().saveDraft()
      const note = get().notes.get(id)
      if (!note) return
      let content = setTaskDone(note.raw, line, done)
      if (content === note.raw) return
      if (Object.prototype.hasOwnProperty.call(note.frontmatter, 'updated')) content = updateFrontmatter(content, { updated: todayIso() })
      try {
        await adapter.write(note.meta.path, content)
        if (get().editorId === id) set({ draft: content, dirty: false })
        get().applyExternal([{ kind: 'change', path: note.meta.path, content, mtime: Date.now() }])
      } catch (err) {
        get().toast(`Could not update task: ${err instanceof Error ? err.message : String(err)}`, 'error')
      }
    },

    async addTask(id, text, section = 'To do') {
      const { adapter, editorId, dirty } = get()
      if (!adapter || !text.trim()) return null
      if (editorId === id && dirty) await get().saveDraft()
      const note = get().notes.get(id)
      if (!note) return null
      let content = addTaskToNote(note.raw, text, section)
      if (content === note.raw) return null
      if (Object.prototype.hasOwnProperty.call(note.frontmatter, 'updated')) content = updateFrontmatter(content, { updated: todayIso() })
      try {
        await adapter.write(note.meta.path, content)
        if (get().editorId === id) set({ draft: content, dirty: false })
        get().applyExternal([{ kind: 'change', path: note.meta.path, content, mtime: Date.now() }])
        return id
      } catch (err) {
        get().toast(`Could not add task: ${err instanceof Error ? err.message : String(err)}`, 'error')
        return null
      }
    },

    async createProject(name, summary) {
      const trimmed = name.trim()
      if (!trimmed) return null
      const p = projectNote(summary ? { name: trimmed, summary } : { name: trimmed })
      if (get().notes.has(idFromPath(p.path))) {
        get().toast(`A project called "${trimmed}" already exists`, 'error')
        return idFromPath(p.path)
      }
      const id = await get().writeNote(p.path, p.content, { fly: true })
      set({ projectId: id })
      get().toast(`Created project "${trimmed}"`, 'success')
      return id
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
