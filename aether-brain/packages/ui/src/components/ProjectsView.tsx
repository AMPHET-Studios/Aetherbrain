import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LinkResolver,
  asString,
  asStringArray,
  defaultProjectFolder,
  folderOf,
  normalizeTag,
  projectFolderOf,
  projectSummary,
  type NoteId,
  type ParsedNote,
  type TaskItem,
} from '@aether/core'
import { folderIndex, matchFolders } from '../folderSearch'
import { listProjects, moveTaskOnBoard, type ProjectRow } from '../projects'
import { useAether } from '../store'
import { cx, isControl, MOD, plural, relativeTime } from '../util'

/** What the status select offers (plus the project's own value when it is something else). */
const STATUSES = ['active', 'paused', 'done', 'someday']

type EditField = 'title' | 'summary' | 'tags'

/** An inline task edit under way: the task as it was when the edit started (the save is made against it). */
interface TaskEdit {
  /** The project note. */
  note: NoteId
  /** Row key of the task (see `taskKeys`). */
  key: string
  /** Its line in `raw`. */
  line: number
  /** The note's text when the edit started: the store finds the task in the file from it, wherever it moved. */
  raw: string
  /** The task's text then (a save of the same text writes nothing). */
  text: string
}

/**
 * A row key per task line that follows the task, not its line number: the
 * line's text and which occurrence of that text it is (file order, like the
 * store's line remapping). A line inserted above by another writer keeps
 * every key, so an inline edit stays on its own task.
 */
function taskKeys(raw: string, tasks: TaskItem[]): Map<number, string> {
  const lines = raw.split('\n')
  const seen = new Map<string, number>()
  const out = new Map<number, string>()
  for (const t of [...tasks].sort((a, b) => a.line - b.line)) {
    const text = lines[t.line] ?? ''
    const n = seen.get(text) ?? 0
    seen.set(text, n + 1)
    out.set(t.line, `${n}:${text}`)
  }
  return out
}

/**
 * The summary as written: the `>` lines right after the H1, markdown kept (so
 * an edit doesn't flatten its [[links]]); null when the note has none.
 */
function summaryQuote(note: ParsedNote): string | null {
  const lines = note.body.split(/\r?\n/)
  let i = lines.findIndex((l) => /^#\s+/.test(l)) + 1
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  const quote: string[] = []
  while (i < lines.length && /^\s{0,3}>/.test(lines[i] ?? '')) quote.push((lines[i++] ?? '').replace(/^\s{0,3}>\s?/, ''))
  return quote.length ? quote.join(' ').replace(/\s+/g, ' ').trim() : null
}

/** A text field that takes the keys (checkboxes, buttons and task rows don't). */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el?.tagName) return false
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type)
}

/**
 * Projects board: every project note (see `isProjectNote`) as a card with
 * progress; the selected project is editable in place — name, status, tags,
 * summary, its home folder (the star) and the folders inside it (planets),
 * and a to-do list whose ticks, edits, moves and deletes are written straight
 * back into the note's markdown. The file is the memory.
 */
export function ProjectsView() {
  const view = useAether((s) => s.view)
  const setView = useAether((s) => s.setView)
  const notes = useAether((s) => s.notes)
  const folders = useAether((s) => s.folders)
  const revision = useAether((s) => s.revision)
  const projectId = useAether((s) => s.projectId)
  const selectProject = useAether((s) => s.selectProject)
  const toggleTask = useAether((s) => s.toggleTask)
  const addTask = useAether((s) => s.addTask)
  const editTask = useAether((s) => s.editTask)
  const deleteTask = useAether((s) => s.deleteTask)
  const moveTask = useAether((s) => s.moveTask)
  const createProject = useAether((s) => s.createProject)
  const updateProject = useAether((s) => s.updateProject)
  const archiveProject = useAether((s) => s.archiveProject)
  const deleteProject = useAether((s) => s.deleteProject)
  const createFolder = useAether((s) => s.createFolder)
  const showFolder = useAether((s) => s.showFolder)
  const openNote = useAether((s) => s.openNote)
  const homePrefix = useAether((s) => s.homePrefix)
  const readOnly = useAether((s) => s.adapter?.readOnly ?? false)
  const canMkdir = useAether((s) => !!s.adapter?.createFolder)

  const [newTask, setNewTask] = useState('')
  const [creating, setCreating] = useState(false)
  /** Bumped per palette request so the name field mounts again and takes the focus. */
  const [asked, setAsked] = useState(0)
  const [newName, setNewName] = useState('')
  const [newSummary, setNewSummary] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [edit, setEdit] = useState<EditField | null>(null)
  const [picking, setPicking] = useState(false)
  const [newFolder, setNewFolder] = useState('')
  const [editing, setEditing] = useState<TaskEdit | null>(null)
  const [focusLine, setFocusLine] = useState<number | null>(null)
  const taskInput = useRef<HTMLInputElement | null>(null)
  const folderInput = useRef<HTMLInputElement | null>(null)
  const board = useRef<HTMLDivElement | null>(null)

  const rows = useMemo(() => listProjects(notes, folders), [notes, folders, revision])

  /**
   * Where a task's [[link]] leads. One index of every note for the whole board, built the first time a task
   * has a link and again only when the notes change. (A task row used to build its own: a long to-do list
   * in a big vault froze the window and filled the memory.)
   */
  const resolveLink = useMemo(() => {
    let index: LinkResolver | null = null
    return (target: string): NoteId | null => (index ??= new LinkResolver(notes.values())).resolve(target)
  }, [notes, revision])

  const current =rows.find((r) => r.note.meta.id === projectId) ?? rows[0] ?? null
  const currentId = current?.note.meta.id ?? null
  const keys = useMemo(() => (current ? taskKeys(current.note.raw, current.tasks) : new Map<number, string>()), [current])

  /** Direct subfolder counts, per folder. */
  const childCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of folders) {
      const p = folderOf(f)
      m.set(p, (m.get(p) ?? 0) + 1)
    }
    return m
  }, [folders])

  // The planets of the current project: subfolders of its home folder, with the notes under each.
  const home = current?.home ?? null
  const planets = useMemo(() => {
    if (!home) return { list: [] as { path: string; name: string; notes: number; sub: number }[], total: 0 }
    const list = [...folders].filter((f) => folderOf(f) === home).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    const counts = new Map(list.map((f) => [f, 0]))
    let total = 0
    for (const n of notes.values()) {
      const f = n.meta.folder
      if (f !== home && !f.startsWith(`${home}/`)) continue
      total++
      if (f === home) continue
      const top = `${home}/${f.slice(home.length + 1).split('/')[0] ?? ''}`
      const c = counts.get(top)
      if (c !== undefined) counts.set(top, c + 1)
    }
    return { list: list.map((f) => ({ path: f, name: f.slice(home.length + 1), notes: counts.get(f) ?? 0, sub: childCounts.get(f) ?? 0 })), total }
  }, [home, folders, notes, revision, childCounts])

  // Keep the store's selection valid so the graph highlights the right neuron.
  useEffect(() => {
    if (view !== 'projects') return
    if (current && current.note.meta.id !== projectId) selectProject(current.note.meta.id)
  }, [view, current?.note.meta.id, projectId, selectProject])

  // The palette's "New project…" opens the create form here.
  const formRequest = useAether((s) => s.formRequest)
  useEffect(() => {
    if (formRequest !== 'project' || view !== 'projects') return
    useAether.getState().requestForm(null)
    if (readOnly) return
    setCreating(true)
    setAsked((n) => n + 1)
  }, [formRequest, view, readOnly])

  // Another project: leave any half-done edit behind.
  useEffect(() => {
    setEdit(null)
    setPicking(false)
    setEditing(null)
  }, [currentId])

  // The task being edited was changed or removed by another writer (an AI, another app): stop, and say so.
  useEffect(() => {
    if (!editing || editing.note !== currentId || [...keys.values()].includes(editing.key)) return
    setEditing(null)
    useAether.getState().toast('The task you were editing changed on disk; edit it again', 'error')
  }, [keys, editing, currentId])

  // Put focus back on a task row after it was edited, moved or deleted (its line may have changed).
  useEffect(() => {
    if (focusLine === null) return
    board.current?.querySelector<HTMLElement>(`[data-task="${focusLine}"]`)?.focus()
    setFocusLine(null)
  }, [focusLine, current])

  const cycleStatus = () => {
    if (!current || readOnly) return
    const cur = (current.note.meta.status ?? '').toLowerCase()
    const next = STATUSES[(STATUSES.indexOf(cur) + 1) % STATUSES.length]!
    void updateProject(current.note.meta.id, { status: next })
  }

  useEffect(() => {
    if (view !== 'projects') return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return
      const st = useAether.getState()
      if (st.paletteOpen || st.helpOpen) return
      // A focused task row handles its own keys (Enter edits, ↑↓ move focus, Del deletes, Space ticks).
      const onRow = !!(e.target as HTMLElement | null)?.closest?.('[data-task]')
      if (onRow && ['Enter', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace', ' '].includes(e.key)) return
      const idx = current ? rows.findIndex((r) => r.note.meta.id === current.note.meta.id) : -1
      switch (e.key) {
        case 'N':
          if (readOnly) return
          setCreating(true)
          break
        case 'u':
          if (!useAether.getState().toastAction()) return
          break
        case 'j':
        case 'ArrowDown':
          if (!current) return
          selectProject(rows[Math.min(rows.length - 1, idx + 1)]?.note.meta.id ?? current.note.meta.id)
          break
        case 'k':
        case 'ArrowUp':
          if (!current) return
          selectProject(rows[Math.max(0, idx - 1)]?.note.meta.id ?? current.note.meta.id)
          break
        case 'o':
        case 'Enter':
          // Enter on a focused card, button or link activates that control (a card selects its project).
          if (!current || (e.key === 'Enter' && isControl(e.target))) return
          openNote(current.note.meta.id, { fly: true, view: 'editor' })
          break
        case 'n':
          if (!current) return
          taskInput.current?.focus()
          break
        case 'x':
          setShowDone((v) => !v)
          break
        case 'e':
          if (!current || readOnly) return
          setCreating(false)
          setEdit('title')
          break
        case 'f':
          if (!current || readOnly || !canMkdir) return
          setCreating(false)
          folderInput.current?.focus()
          break
        case 's':
          if (!current || readOnly) return
          cycleStatus()
          break
        default:
          return
      }
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [view, rows, current, selectProject, openNote, readOnly, canMkdir])

  if (view !== 'projects') return null

  const submitTask = async () => {
    if (!current || !newTask.trim()) return
    const text = newTask
    setNewTask('')
    await addTask(current.note.meta.id, text)
  }

  const submitProject = async () => {
    if (!newName.trim()) return
    const id = await createProject(newName, newSummary)
    setCreating(false)
    setNewName('')
    setNewSummary('')
    if (id) selectProject(id)
  }

  /** Fly to a folder in the system layout (the board steps aside). */
  const flyToFolder = (path: string) => {
    setView('graph')
    showFolder(path)
  }

  /**
   * Create `path` (or find it: `createFolder` keeps an existing spelling) and
   * make it the current project's home, linked with `folder:` when the name
   * rules don't bind it on their own. Returns the folder, or null.
   */
  const makeHome = async (path: string): Promise<string | null> => {
    if (!current) return null
    const id = current.note.meta.id
    const dir = folders.has(path) ? path : await createFolder(path)
    if (!dir) return null
    const s = useAether.getState()
    const note = s.notes.get(id)
    if (note && projectFolderOf(note, s.folders) !== dir) await updateProject(id, { folder: dir })
    return dir
  }

  /** A planet `<home>/<name>`; the home folder is created (and linked) first when the project has none yet. */
  const addPlanet = async () => {
    const name = newFolder.trim()
    if (!current || !name) return
    const dir = await makeHome(current.home ?? defaultProjectFolder(current.note))
    if (dir && (await createFolder(`${dir}/${name}`))) setNewFolder('')
  }

  return (
    <div ref={board} className="absolute inset-0 z-30 flex items-stretch justify-center bg-black/30 p-3 pt-16" onMouseDown={(e) => e.target === e.currentTarget && setView('graph')} role="dialog" aria-label="Projects">
      <div className="panel rise flex w-full max-w-[1180px] overflow-hidden">
        {/* Left: project cards */}
        <div className="flex w-[340px] shrink-0 flex-col border-r border-[var(--line)]">
          <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
            <span className="text-projects">◆</span>
            <span className="text-[13px] font-semibold text-white">Projects</span>
            <span className="text-[11.5px] text-faint">{plural(rows.length, 'board')}</span>
            <span className="flex-1" />
            <button type="button" className="hud-btn" onClick={() => setCreating(true)} disabled={readOnly} title="New project (⇧N)">
              + New
            </button>
          </div>
          <div className="scroll flex-1 p-2">
            {rows.length === 0 && (
              <div className="p-4 text-center text-[12.5px] text-dim">
                No projects yet. A project is a note directly in <code>Projects/</code>, a folder note like <code>Projects/X/X.md</code>, or any note with{' '}
                <code>type: project</code>.
              </div>
            )}
            {rows.map((r) => {
              const m = r.note.meta
              const active = current?.note.meta.id === m.id
              const next = r.open[0]
              const planetCount = r.home ? (childCounts.get(r.home) ?? 0) : 0
              return (
                <button
                  type="button"
                  key={m.id}
                  onClick={() => selectProject(m.id)}
                  onDoubleClick={() => openNote(m.id, { fly: true, view: 'editor' })}
                  className={cx(
                    'mb-1.5 block w-full rounded-xl border px-3 py-2.5 text-left transition',
                    active ? 'border-projects/60 bg-projects/10' : 'border-transparent hover:border-[var(--panel-border)] hover:bg-white/5',
                  )}
                  aria-current={active ? 'true' : undefined}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-white">{m.title}</span>
                    <StatusChip status={m.status} />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent2" style={{ width: `${r.pct}%` }} />
                    </div>
                    <span className="w-16 text-right text-[10.5px] tabular-nums text-dim">
                      {r.done.length}/{r.tasks.length} · {r.pct}%
                    </span>
                  </div>
                  <div className="mt-1 truncate text-[11.5px] text-dim">{next ? `next: ${next.text}` : r.tasks.length ? 'all done ✓' : 'no tasks yet'}</div>
                  <div className="mt-1 flex items-center gap-2 text-[10.5px] text-faint">
                    <span>✎ {relativeTime(m.updated)}</span>
                    {planetCount > 0 && <span title="Folders inside the project folder">● {plural(planetCount, 'planet')}</span>}
                    {m.tags.slice(0, 3).map((t) => (
                      <span key={t}>#{t}</span>
                    ))}
                  </div>
                </button>
              )
            })}
          </div>
          <div className="border-t border-[var(--line)] px-3 py-1.5 text-[11px] leading-relaxed text-faint">
            <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open · <kbd>e</kbd> rename · <kbd>s</kbd> status · <kbd>f</kbd> folder · <kbd>n</kbd> task · <kbd>⇧N</kbd> new
            project · <kbd>x</kbd> done list
          </div>
        </div>

        {/* Right: the selected project */}
        <div className="flex min-w-0 flex-1 flex-col">
          {creating ? (
            <form
              className="flex flex-col gap-3 p-5"
              onSubmit={(e) => {
                e.preventDefault()
                void submitProject()
              }}
            >
              <div className="text-[15px] font-semibold text-white">New project</div>
              <input
                key={asked}
                autoFocus
                className="input"
                placeholder={`Name (becomes ${homePrefix()}Projects/Name.md)`}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setCreating(false))}
                aria-label="Project name"
              />
              <input
                className="input"
                placeholder="One line: what done looks like (optional)"
                value={newSummary}
                onChange={(e) => setNewSummary(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setCreating(false))}
                aria-label="Project summary"
              />
              <div className="flex gap-2">
                <button type="submit" className="hud-btn primary" disabled={!newName.trim()}>
                  Create
                </button>
                <button type="button" className="hud-btn" onClick={() => setCreating(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : !current ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-[13px] text-dim">
              Create a project to start a to-do list. Tasks are markdown checkboxes in the note, so they survive anything.
            </div>
          ) : (
            <>
              <ProjectHeader
                key={current.note.meta.id}
                row={current}
                readOnly={readOnly}
                edit={edit}
                setEdit={setEdit}
                onOpen={() => openNote(current.note.meta.id, { fly: true, view: 'editor' })}
                onUpdate={(patch) => void updateProject(current.note.meta.id, patch)}
                onArchive={() => void archiveProject(current.note.meta.id)}
                onDelete={() => {
                  const extra = current.home ? ` Its folder ${current.home}/ stays on disk.` : ''
                  if (window.confirm(`Delete the project note "${current.note.meta.title}"? This removes ${current.note.meta.path} from the vault.${extra}`)) {
                    void deleteProject(current.note.meta.id)
                  }
                }}
              />

              <div className="scroll flex-1 px-5 py-3">
                <HomeFolder
                  row={current}
                  folders={folders}
                  readOnly={readOnly}
                  canCreate={!readOnly && canMkdir}
                  picking={picking}
                  setPicking={setPicking}
                  totalNotes={planets.total}
                  onShow={flyToFolder}
                  onCreate={(path) => void makeHome(path)}
                  onLink={(path) => void updateProject(current.note.meta.id, { folder: path })}
                />

                {current.home && planets.list.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {planets.list.map((p) => (
                      <button
                        type="button"
                        key={p.path}
                        className="chip"
                        onClick={() => flyToFolder(p.path)}
                        title={`${p.path} · ${plural(p.notes, 'note')}${p.sub ? ` · ${plural(p.sub, 'folder')}` : ''} — fly there`}
                      >
                        <span className="dot" style={{ background: 'var(--accent-2)', color: 'var(--accent-2)' }} />
                        {p.name}
                        <span className="opacity-60">{p.notes}</span>
                      </button>
                    ))}
                  </div>
                )}
                {!readOnly && canMkdir && (
                  <form
                    className="mb-5 flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void addPlanet()
                    }}
                  >
                    <input
                      ref={folderInput}
                      className="input !py-1.5 !text-[12.5px]"
                      placeholder={`Add folder (planet) inside ${current.home ?? defaultProjectFolder(current.note)}/ …`}
                      value={newFolder}
                      onChange={(e) => setNewFolder(e.target.value)}
                      onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setNewFolder(''), e.currentTarget.blur())}
                      aria-label="New folder name"
                    />
                    <button type="submit" className="hud-btn" disabled={!newFolder.trim()}>
                      + Folder <kbd>f</kbd>
                    </button>
                  </form>
                )}

                <div className="section-title mb-2">To do · {current.open.length}</div>
                {current.open.length === 0 && <div className="mb-3 text-[12.5px] text-dim">Nothing open. Add one below.</div>}
                <TaskList
                  tasks={current.open}
                  row={current}
                  keys={keys}
                  resolveLink={resolveLink}
                  readOnly={readOnly}
                  editing={editing}
                  setEditing={setEditing}
                  setFocusLine={setFocusLine}
                  onToggle={(t, done) => toggleTask(current.note.meta.id, t.line, done, current.note.raw)}
                  onEdit={(edit, text) => editTask(current.note.meta.id, edit.line, text, edit.raw)}
                  onDelete={(t) => deleteTask(current.note.meta.id, t.line, current.note.raw)}
                  onMove={(t, dir) => moveTask(current.note.meta.id, t.line, dir, current.note.raw)}
                />
                <button type="button" className="section-title mb-2 flex items-center gap-1 hover:text-ink" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
                  <span>{showDone ? '▾' : '▸'}</span> Done · {current.done.length}
                </button>
                {showDone && (
                  <TaskList
                    tasks={current.done}
                    row={current}
                    keys={keys}
                    resolveLink={resolveLink}
                    readOnly={readOnly}
                    editing={editing}
                    setEditing={setEditing}
                    setFocusLine={setFocusLine}
                    onToggle={(t, done) => toggleTask(current.note.meta.id, t.line, done, current.note.raw)}
                    onEdit={(edit, text) => editTask(current.note.meta.id, edit.line, text, edit.raw)}
                    onDelete={(t) => deleteTask(current.note.meta.id, t.line, current.note.raw)}
                    onMove={(t, dir) => moveTask(current.note.meta.id, t.line, dir, current.note.raw)}
                  />
                )}
              </div>

              <form
                className="flex items-center gap-2 border-t border-[var(--line)] px-4 py-2.5"
                onSubmit={(e) => {
                  e.preventDefault()
                  void submitTask()
                }}
              >
                <span className="text-faint">＋</span>
                <input
                  ref={taskInput}
                  className="input !py-1.5"
                  placeholder={readOnly ? 'Vault is read-only' : 'Add a task and press Enter… ([[links]] and #tags work)'}
                  value={newTask}
                  disabled={readOnly}
                  onChange={(e) => setNewTask(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), e.currentTarget.blur())}
                  aria-label="New task"
                />
                <button type="submit" className="hud-btn primary" disabled={!newTask.trim() || readOnly}>
                  Add
                </button>
                <span className="hidden text-[11px] text-faint lg:inline">
                  written to <code>## To do</code> · <kbd>{MOD}</kbd>+<kbd>K</kbd> search
                </span>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * A one-line text field for an inline edit: Enter (or leaving the field)
 * saves, Esc cancels. Esc never reaches the board, so it stays open.
 */
function InlineInput({
  initial,
  onSave,
  onCancel,
  label,
  placeholder,
  className,
}: {
  initial: string
  onSave: (value: string) => void
  onCancel: () => void
  label: string
  placeholder?: string
  className?: string
}) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    if (save) onSave(value)
    else onCancel()
  }
  return (
    <input
      autoFocus
      className={cx('input', className)}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}

/** Name, status, tags and summary of a project, each editable in place, plus its actions. */
function ProjectHeader({
  row,
  readOnly,
  edit,
  setEdit,
  onOpen,
  onUpdate,
  onArchive,
  onDelete,
}: {
  row: ProjectRow
  readOnly: boolean
  edit: EditField | null
  setEdit: (f: EditField | null) => void
  onOpen: () => void
  onUpdate: (patch: { title?: string; status?: string | null; summary?: string | null; tags?: string[]; renameFile?: boolean }) => void
  onArchive: () => void
  onDelete: () => void
}) {
  const m = row.note.meta
  const summary = useMemo(() => projectSummary(row.note), [row.note])
  const summarySource = useMemo(() => summaryQuote(row.note) ?? summary, [row.note, summary])
  const tags = useMemo(() => asStringArray(row.note.frontmatter['tags']).map(normalizeTag).filter(Boolean), [row.note])
  const status = m.status
  const options = status && !STATUSES.includes(status.toLowerCase()) ? [...STATUSES, status] : STATUSES
  return (
    <div className="border-b border-[var(--line)] px-5 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {edit === 'title' ? (
            <InlineInput
              initial={m.title}
              label="Project name"
              className="!py-1 !text-[17px] font-semibold"
              onSave={(v) => {
                setEdit(null)
                if (v.trim() && v.trim() !== m.title) onUpdate({ title: v, renameFile: true })
              }}
              onCancel={() => setEdit(null)}
            />
          ) : (
            <button
              type="button"
              className="block max-w-full truncate text-left text-[18px] font-semibold text-white hover:text-accent2 disabled:hover:text-white"
              onClick={() => setEdit('title')}
              disabled={readOnly}
              title="Rename the project (e) — the file follows unless it is the folder's own note"
            >
              {m.title}
            </button>
          )}
          <div className="mt-0.5 font-mono text-[10.5px] text-faint">{m.path}</div>
        </div>
        <select
          className="input !w-auto !py-1 !pr-2 !pl-2 !text-[11.5px] font-semibold uppercase tracking-wider"
          value={status?.toLowerCase() && STATUSES.includes(status.toLowerCase()) ? status.toLowerCase() : (status ?? '')}
          disabled={readOnly}
          onChange={(e) => onUpdate({ status: e.target.value || null })}
          aria-label="Status (s cycles)"
          title="Status (s cycles)"
        >
          {!status && <option value="">— status</option>}
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <button type="button" className="hud-btn" onClick={onOpen}>
          Open note <kbd>Enter</kbd>
        </button>
      </div>

      {edit === 'summary' ? (
        <InlineInput
          initial={summarySource}
          label="Project summary"
          placeholder="One line: what this project is and what done looks like"
          className="mt-2 !py-1.5 !text-[12.5px]"
          onSave={(v) => {
            setEdit(null)
            if (v.replace(/\s+/g, ' ').trim() !== summarySource) onUpdate({ summary: v })
          }}
          onCancel={() => setEdit(null)}
        />
      ) : (
        <button
          type="button"
          className="mt-2 line-clamp-2 block w-full text-left text-[12.5px] leading-relaxed text-dim hover:text-ink disabled:hover:text-dim"
          onClick={() => setEdit('summary')}
          disabled={readOnly}
          title="Edit the summary (the > line under the title)"
        >
          {summary || <span className="text-faint">{readOnly ? 'No summary' : '+ Add a one-line summary'}</span>}
        </button>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {edit === 'tags' ? (
          <InlineInput
            initial={tags.join(', ')}
            label="Project tags"
            placeholder="tags, separated by commas"
            className="!py-1 !text-[12px]"
            onSave={(v) => {
              setEdit(null)
              const next = v
                .split(/[,\s]+/)
                .map(normalizeTag)
                .filter(Boolean)
              if (next.join(',') !== tags.join(',')) onUpdate({ tags: next })
            }}
            onCancel={() => setEdit(null)}
          />
        ) : (
          <>
            {tags.map((t) => (
              <span key={t} className="chip !cursor-default">
                #{t}
              </span>
            ))}
            {!readOnly && (
              <button type="button" className="text-[11px] text-faint hover:text-accent2" onClick={() => setEdit('tags')}>
                {tags.length ? '✎ tags' : '+ tags'}
              </button>
            )}
          </>
        )}
        <span className="flex-1" />
        <button type="button" className="hud-btn !h-7" onClick={onArchive} disabled={readOnly} title="Move the project note to Archive/">
          Archive
        </button>
        <button type="button" className="hud-btn !h-7 hover:!text-danger" onClick={onDelete} disabled={readOnly} title="Delete the project note (asks first)">
          Delete…
        </button>
      </div>
    </div>
  )
}

/** The project's home folder (its star in the system layout): show, create, change or unlink it. */
function HomeFolder({
  row,
  folders,
  readOnly,
  canCreate,
  picking,
  setPicking,
  totalNotes,
  onShow,
  onCreate,
  onLink,
}: {
  row: ProjectRow
  folders: Set<string>
  readOnly: boolean
  canCreate: boolean
  picking: boolean
  setPicking: (v: boolean) => void
  totalNotes: number
  onShow: (path: string) => void
  onCreate: (path: string) => void
  onLink: (path: string | null) => void
}) {
  const home = row.home
  const exists = home !== null && folders.has(home)
  const explicit = !!asString(row.note.frontmatter['folder'])
  const fallback = defaultProjectFolder(row.note)
  return (
    <div className="mb-3">
      <div className="section-title mb-1.5">Home folder · the star</div>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        {home ? (
          <>
            <span className="text-[#ffcf6b]">★</span>
            <code className="min-w-0 truncate text-ink" title={explicit ? 'Linked with folder: in the frontmatter' : 'Found by name'}>
              {home}/
            </code>
            {exists ? (
              <span className="text-[11.5px] text-faint">{plural(totalNotes, 'note')}</span>
            ) : (
              <span className="text-[11.5px] text-inbox">not on disk yet</span>
            )}
            <span className="flex-1" />
            {exists ? (
              <button type="button" className="hud-btn !h-7" onClick={() => onShow(home)} title="Fly to the star in the system layout">
                Show in space
              </button>
            ) : (
              <button type="button" className="hud-btn !h-7" onClick={() => onCreate(home)} disabled={!canCreate}>
                Create it
              </button>
            )}
            <button type="button" className="hud-btn !h-7" onClick={() => setPicking(!picking)} disabled={readOnly} aria-expanded={picking}>
              Change…
            </button>
            {explicit && (
              <button type="button" className="hud-btn !h-7" onClick={() => onLink(null)} disabled={readOnly} title="Remove folder: from the frontmatter">
                Unlink
              </button>
            )}
          </>
        ) : (
          <>
            <span className="text-dim">None yet — the project's files can live in a folder of their own.</span>
            <span className="flex-1" />
            <button type="button" className="hud-btn !h-7" onClick={() => onCreate(fallback)} disabled={!canCreate} title={`Create ${fallback}/`}>
              Create folder
            </button>
            <button type="button" className="hud-btn !h-7" onClick={() => setPicking(!picking)} disabled={readOnly} aria-expanded={picking}>
              Link existing…
            </button>
          </>
        )}
      </div>
      {picking && (
        <FolderPicker
          folders={folders}
          near={row.note.meta.folder}
          onPick={(p) => {
            setPicking(false)
            onLink(p)
          }}
          onCancel={() => setPicking(false)}
        />
      )}
    </div>
  )
}

/** Search the vault's folders; Enter links the highlighted one. */
function FolderPicker({ folders, near, onPick, onCancel }: { folders: Set<string>; near: string; onPick: (path: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState('')
  const [index, setIndex] = useState(0)
  // Lower-cased once per folder Set, not per keystroke (a whole drive has hundreds of thousands).
  const folderList = useMemo(() => folderIndex(folders), [folders])
  // Nothing typed yet: the folders next to the project note.
  const nearby = useMemo(() => {
    const out: string[] = []
    for (const f of folders) if (folderOf(f) === near) out.push(f)
    return out.sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 12)
  }, [folders, near])
  const matches = useMemo(() => (q.trim() ? matchFolders(folderList, q, 12) : nearby), [q, folderList, nearby])
  useEffect(() => setIndex(0), [q])
  return (
    <div className="mt-2 rounded-xl border border-[var(--panel-border)] bg-black/20 p-2">
      <input
        autoFocus
        className="input !py-1.5 !text-[12.5px]"
        placeholder="Search folders by name or path…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setIndex((i) => Math.min(matches.length - 1, i + 1)))
          else if (e.key === 'ArrowUp') (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)))
          else if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            const pick = matches[index]
            if (pick) onPick(pick)
          } else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), onCancel())
        }}
        aria-label="Find a folder"
        aria-activedescendant={matches[index] ? `folder-pick-${index}` : undefined}
      />
      <div className="scroll mt-1 max-h-48" role="listbox">
        {matches.length === 0 && <div className="px-2 py-2 text-[12px] text-faint">{q.trim() ? 'No folder matches.' : 'Type to search every folder.'}</div>}
        {matches.map((p, i) => (
          <button
            type="button"
            key={p}
            id={`folder-pick-${i}`}
            role="option"
            aria-selected={i === index}
            className={cx('block w-full truncate rounded-md px-2 py-1 text-left font-mono text-[11.5px]', i === index ? 'bg-accent/20 text-ink' : 'text-dim hover:bg-white/5')}
            onMouseEnter={() => setIndex(i)}
            onClick={() => onPick(p)}
          >
            {p}/
          </button>
        ))}
      </div>
    </div>
  )
}

/** Task rows; each is focusable and keeps its keys (Enter edit, Alt ↑↓ move, Del delete, Space tick, ↑↓ focus). */
function TaskList({
  tasks,
  row,
  keys,
  resolveLink,
  readOnly,
  editing,
  setEditing,
  setFocusLine,
  onToggle,
  onEdit,
  onDelete,
  onMove,
}: {
  tasks: TaskItem[]
  row: ProjectRow
  /** Row keys by task line (see `taskKeys`). */
  keys: Map<number, string>
  resolveLink: (target: string) => NoteId | null
  readOnly: boolean
  editing: TaskEdit | null
  setEditing: (edit: TaskEdit | null) => void
  setFocusLine: (line: number | null) => void
  onToggle: (t: TaskItem, done: boolean) => Promise<unknown>
  /** Save an inline edit: against the note as it was when the edit started. */
  onEdit: (edit: TaskEdit, text: string) => Promise<void>
  onDelete: (t: TaskItem) => Promise<void>
  onMove: (t: TaskItem, dir: -1 | 1) => Promise<void>
}) {
  if (tasks.length === 0) return null
  /** The row to focus after `t` leaves this list (the next one, else the previous), as a line after `shift` lines went at `t`. */
  const neighborLine = (t: TaskItem, shift: number): number | null => {
    const i = tasks.indexOf(t)
    const n = tasks[i + 1] ?? tasks[i - 1]
    if (!n) return null
    return n.line > t.line ? n.line - shift : n.line
  }
  return (
    <ul className="mb-4">
      {tasks.map((t) => {
        const key = keys.get(t.line) ?? `line:${t.line}`
        return (
          <TaskRow
            key={key}
            task={t}
            resolveLink={resolveLink}
            readOnly={readOnly}
            editing={editing?.key === key}
            onStartEdit={() => setEditing({ note: row.note.meta.id, key, line: t.line, raw: row.note.raw, text: t.text })}
            onSaveEdit={async (text) => {
              const edit = editing?.key === key ? editing : null
              setEditing(null)
              if (edit && text.trim() && text.trim() !== edit.text) await onEdit(edit, text)
              setFocusLine(t.line)
            }}
            onCancelEdit={() => {
              setEditing(null)
              setFocusLine(t.line)
            }}
            onToggle={async (done) => {
              const next = neighborLine(t, 0)
              await onToggle(t, done)
              if (next !== null) setFocusLine(next)
            }}
            onDelete={async () => {
              const next = neighborLine(t, 1)
              await onDelete(t)
              if (next !== null) setFocusLine(next)
            }}
            onMove={async (dir) => {
              // Where the task lands: the store moves it the same way (open and done tasks apart).
              const to = moveTaskOnBoard(row.note.raw, t.line, dir).line
              await onMove(t, dir)
              setFocusLine(to)
            }}
          />
        )
      })}
    </ul>
  )
}

function TaskRow({
  task,
  resolveLink,
  readOnly,
  editing,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onToggle,
  onDelete,
  onMove,
}: {
  task: TaskItem
  resolveLink: (target: string) => NoteId | null
  readOnly: boolean
  editing: boolean
  onStartEdit: () => void
  onSaveEdit: (text: string) => void
  onCancelEdit: () => void
  onToggle: (done: boolean) => void
  onDelete: () => void
  onMove: (dir: -1 | 1) => void
}) {
  return (
    <li
      tabIndex={editing ? -1 : 0}
      data-task={task.line}
      className="group flex items-start gap-2.5 rounded-lg py-1 pr-1 focus:bg-white/5 focus:outline-none"
      style={{ paddingLeft: task.indent * 6 + 4 }}
      onDoubleClick={(e) => {
        if (readOnly || editing || (e.target as HTMLElement).closest('a, button, input')) return
        onStartEdit()
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        let handled = true
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          if (!readOnly) onMove(e.key === 'ArrowUp' ? -1 : 1)
        } else if (e.altKey || e.ctrlKey || e.metaKey) {
          handled = false
        } else if (e.key === 'Enter') {
          if (!readOnly) onStartEdit()
        } else if (e.key === ' ') {
          if (!readOnly) onToggle(!task.done)
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          if (!readOnly) onDelete()
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const rows = [...(e.currentTarget.closest('[role="dialog"]')?.querySelectorAll<HTMLElement>('[data-task]') ?? [])]
          rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowUp' ? -1 : 1)]?.focus()
        } else handled = false
        if (handled) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
      <input
        type="checkbox"
        tabIndex={-1}
        className="mt-[3px] h-4 w-4 shrink-0 cursor-pointer accent-[var(--accent)]"
        checked={task.done}
        disabled={readOnly}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={task.text}
      />
      {editing ? (
        <span className="min-w-0 flex-1">
          <InlineInput initial={task.text} label="Edit task" className="!py-1 !text-[13px]" onSave={onSaveEdit} onCancel={onCancelEdit} />
        </span>
      ) : (
        <span className="min-w-0 flex-1">
          <TaskText text={task.text} done={task.done} resolveLink={resolveLink} />
        </span>
      )}
      {task.section && task.section.toLowerCase() !== 'to do' && <span className="shrink-0 text-[10px] text-faint">{task.section}</span>}
      {task.doneAt && (
        <span className="shrink-0 text-[10.5px] tabular-nums text-faint" title={`Done ${task.doneAt}`}>
          ✅ {task.doneAt}
        </span>
      )}
      {!readOnly && !editing && (
        <span className="flex shrink-0 items-center opacity-0 transition group-hover:opacity-100 group-focus:opacity-100">
          <RowButton label="Move up (Alt ↑)" onClick={() => onMove(-1)}>
            ▲
          </RowButton>
          <RowButton label="Move down (Alt ↓)" onClick={() => onMove(1)}>
            ▼
          </RowButton>
          <RowButton label="Edit (Enter · double-click)" onClick={onStartEdit}>
            ✎
          </RowButton>
          <RowButton label="Delete (Del) — the toast can undo" onClick={onDelete} danger>
            ✕
          </RowButton>
        </span>
      )}
    </li>
  )
}

/** A small icon button on a task row (the row's own keys do the same, so it stays out of the Tab order). */
function RowButton({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className={cx('grid h-6 w-6 place-items-center rounded-md text-[11px] text-faint hover:bg-white/10', danger ? 'hover:text-danger' : 'hover:text-ink')}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  )
}

const INLINE_RE = /(!?\[\[[^\]]+?\]\])|((?:^|(?<=\s))#[\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu

/** Task text with clickable [[wikilinks]] and #tags; everything else verbatim. */
function TaskText({ text, done, resolveLink }: { text: string; done: boolean; resolveLink: (target: string) => NoteId | null }) {
  const openNote = useAether((s) => s.openNote)
  const createGhost = useAether((s) => s.createGhost)
  const toggleTag = useAether((s) => s.toggleTag)
  const parts = useMemo(() => {
    const out: React.ReactNode[] = []
    let last = 0
    let k = 0
    for (const m of text.matchAll(INLINE_RE)) {
      const i = m.index ?? 0
      if (i > last) out.push(text.slice(last, i))
      const tok = m[0]
      if (tok.startsWith('#')) {
        const tag = tok.slice(1).toLowerCase()
        out.push(
          <a key={k++} href="#" className="tag" onClick={(e) => (e.preventDefault(), e.stopPropagation(), toggleTag(tag))}>
            {tok}
          </a>,
        )
      } else {
        const inner = tok.replace(/^!?\[\[|\]\]$/g, '')
        const [left = '', alias] = inner.split('|')
        const target = (left.split('#')[0] ?? '').trim()
        const id = resolveLink(target)
        out.push(
          <a
            key={k++}
            href="#"
            className={cx('wikilink', !id && 'wikilink-ghost')}
            title={id ?? `Create "${target}"`}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (id) openNote(id, { fly: true, view: 'editor' })
              else void createGhost(`ghost:${target}`)
            }}
          >
            {alias?.trim() || target}
          </a>,
        )
      }
      last = i + tok.length
    }
    if (last < text.length) out.push(text.slice(last))
    return out
  }, [text, resolveLink, openNote, createGhost, toggleTag])
  return <span className={cx('md !max-w-none !p-0 text-[13.5px] leading-snug', done ? 'text-faint line-through' : 'text-ink')}>{parts}</span>
}

function StatusChip({ status }: { status: string | null }) {
  if (!status) return null
  const s = status.toLowerCase()
  const color = s === 'active' || s === 'in progress' ? 'text-untagged' : s === 'done' ? 'text-faint' : s === 'paused' ? 'text-inbox' : 'text-dim'
  return <span className={cx('shrink-0 rounded-full border border-[var(--panel-border)] px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider', color)}>{status}</span>
}
