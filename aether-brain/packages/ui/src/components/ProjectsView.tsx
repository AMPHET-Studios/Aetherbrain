import { useEffect, useMemo, useRef, useState } from 'react'
import { LinkResolver, extractTasks, taskProgress, type NoteId, type ParsedNote, type TaskItem } from '@aether/core'
import { useAether } from '../store'
import { cx, MOD, plural, relativeTime } from '../util'

interface ProjectRow {
  note: ParsedNote
  tasks: TaskItem[]
  open: TaskItem[]
  done: TaskItem[]
  pct: number
}

const STATUS_ORDER: Record<string, number> = { active: 0, 'in progress': 0, budding: 1, seedling: 1, paused: 2, done: 3 }

/**
 * Projects board: every project note (type: project or in Projects/) as a
 * card with progress, and a to-do panel whose ticks and additions are written
 * straight back into the note's markdown — the file is the memory.
 */
export function ProjectsView() {
  const view = useAether((s) => s.view)
  const setView = useAether((s) => s.setView)
  const notes = useAether((s) => s.notes)
  const revision = useAether((s) => s.revision)
  const projectId = useAether((s) => s.projectId)
  const selectProject = useAether((s) => s.selectProject)
  const toggleTask = useAether((s) => s.toggleTask)
  const addTask = useAether((s) => s.addTask)
  const createProject = useAether((s) => s.createProject)
  const openNote = useAether((s) => s.openNote)
  const readOnly = useAether((s) => s.adapter?.readOnly ?? false)

  const [newTask, setNewTask] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSummary, setNewSummary] = useState('')
  const [showDone, setShowDone] = useState(false)
  const taskInput = useRef<HTMLInputElement | null>(null)

  const rows = useMemo<ProjectRow[]>(() => {
    const out: ProjectRow[] = []
    for (const n of notes.values()) {
      const m = n.meta
      if (m.area === 'archive') continue
      if (m.type !== 'project' && m.area !== 'projects') continue
      const tasks = extractTasks(n.raw)
      out.push({
        note: n,
        tasks,
        open: tasks.filter((t) => !t.done),
        done: tasks.filter((t) => t.done).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')),
        pct: taskProgress(tasks).pct,
      })
    }
    return out.sort((a, b) => {
      const sa = STATUS_ORDER[(a.note.meta.status ?? '').toLowerCase()] ?? 1
      const sb = STATUS_ORDER[(b.note.meta.status ?? '').toLowerCase()] ?? 1
      if (sa !== sb) return sa - sb
      return (b.note.meta.updated ?? '').localeCompare(a.note.meta.updated ?? '')
    })
  }, [notes, revision])

  const current = rows.find((r) => r.note.meta.id === projectId) ?? rows[0] ?? null

  // Keep the store's selection valid so the graph highlights the right neuron.
  useEffect(() => {
    if (view !== 'projects') return
    if (current && current.note.meta.id !== projectId) selectProject(current.note.meta.id)
  }, [view, current?.note.meta.id, projectId, selectProject])

  useEffect(() => {
    if (view !== 'projects') return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      if (typing) return
      if (!current) return
      const idx = rows.findIndex((r) => r.note.meta.id === current.note.meta.id)
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          selectProject(rows[Math.min(rows.length - 1, idx + 1)]?.note.meta.id ?? current.note.meta.id)
          break
        case 'k':
        case 'ArrowUp':
          selectProject(rows[Math.max(0, idx - 1)]?.note.meta.id ?? current.note.meta.id)
          break
        case 'o':
        case 'Enter':
          openNote(current.note.meta.id, { fly: true, view: 'editor' })
          break
        case 'n':
          taskInput.current?.focus()
          break
        case 'N':
          setCreating(true)
          break
        case 'x':
          setShowDone((v) => !v)
          break
        default:
          return
      }
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [view, rows, current, selectProject, openNote])

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

  return (
    <div className="absolute inset-0 z-30 flex items-stretch justify-center bg-black/30 p-3 pt-16" onMouseDown={(e) => e.target === e.currentTarget && setView('graph')} role="dialog" aria-label="Projects">
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
                No projects yet. A project is any note in <code>Projects/</code> or with <code>type: project</code>.
              </div>
            )}
            {rows.map((r) => {
              const m = r.note.meta
              const active = current?.note.meta.id === m.id
              const next = r.open[0]
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
                    {m.tags.slice(0, 3).map((t) => (
                      <span key={t}>#{t}</span>
                    ))}
                  </div>
                </button>
              )
            })}
          </div>
          <div className="border-t border-[var(--line)] px-3 py-1.5 text-[11px] text-faint">
            <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open · <kbd>n</kbd> new task · <kbd>⇧N</kbd> new project · <kbd>x</kbd> done list
          </div>
        </div>

        {/* Right: to-do panel */}
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
              <input autoFocus className="input" placeholder="Name (becomes Projects/Name.md)" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setCreating(false))} aria-label="Project name" />
              <input className="input" placeholder="One line: what done looks like (optional)" value={newSummary} onChange={(e) => setNewSummary(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setCreating(false))} aria-label="Project summary" />
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
              <div className="border-b border-[var(--line)] px-5 py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <button type="button" className="block max-w-full truncate text-left text-[18px] font-semibold text-white hover:text-accent2" onClick={() => openNote(current.note.meta.id, { fly: true, view: 'editor' })} title="Open in editor (Enter)">
                      {current.note.meta.title}
                    </button>
                    <div className="mt-0.5 font-mono text-[10.5px] text-faint">{current.note.meta.path}</div>
                  </div>
                  <StatusChip status={current.note.meta.status} />
                  <button type="button" className="hud-btn" onClick={() => openNote(current.note.meta.id, { fly: true, view: 'editor' })}>
                    Open note <kbd>Enter</kbd>
                  </button>
                </div>
                <Summary note={current.note} />
              </div>

              <div className="scroll flex-1 px-5 py-3">
                <div className="section-title mb-2">
                  To do · {current.open.length}
                </div>
                {current.open.length === 0 && <div className="mb-3 text-[12.5px] text-dim">Nothing open. Add one below.</div>}
                <ul className="mb-4">
                  {current.open.map((t) => (
                    <TaskRow key={t.line} task={t} readOnly={readOnly} onToggle={(done) => void toggleTask(current.note.meta.id, t.line, done)} />
                  ))}
                </ul>
                <button type="button" className="section-title mb-2 flex items-center gap-1 hover:text-ink" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
                  <span>{showDone ? '▾' : '▸'}</span> Done · {current.done.length}
                </button>
                {showDone && (
                  <ul className="mb-4">
                    {current.done.map((t) => (
                      <TaskRow key={t.line} task={t} readOnly={readOnly} onToggle={(done) => void toggleTask(current.note.meta.id, t.line, done)} />
                    ))}
                  </ul>
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

const INLINE_RE = /(!?\[\[[^\]]+?\]\])|((?:^|(?<=\s))#[\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu

/** Task text with clickable [[wikilinks]] and #tags; everything else verbatim. */
function TaskText({ text, done }: { text: string; done: boolean }) {
  const notes = useAether((s) => s.notes)
  const revision = useAether((s) => s.revision)
  const openNote = useAether((s) => s.openNote)
  const createGhost = useAether((s) => s.createGhost)
  const toggleTag = useAether((s) => s.toggleTag)
  const resolver = useMemo(() => new LinkResolver(notes.values()), [notes, revision])
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
        const id = resolver.resolve(target)
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
  }, [text, resolver, openNote, createGhost, toggleTag])
  return <span className={cx('md !max-w-none !p-0 text-[13.5px] leading-snug', done ? 'text-faint line-through' : 'text-ink')}>{parts}</span>
}

function TaskRow({ task, readOnly, onToggle }: { task: TaskItem; readOnly: boolean; onToggle: (done: boolean) => void }) {
  return (
    <li className="group flex items-start gap-2.5 py-1" style={{ paddingLeft: task.indent * 6 }}>
      <input
        type="checkbox"
        className="mt-[3px] h-4 w-4 shrink-0 cursor-pointer accent-[var(--accent)]"
        checked={task.done}
        disabled={readOnly}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={task.text}
      />
      <span className="min-w-0 flex-1">
        <TaskText text={task.text} done={task.done} />
      </span>
      {task.section && task.section.toLowerCase() !== 'to do' && <span className="shrink-0 text-[10px] text-faint">{task.section}</span>}
      {task.doneAt && (
        <span className="shrink-0 text-[10.5px] tabular-nums text-faint" title={`Done ${task.doneAt}`}>
          ✅ {task.doneAt}
        </span>
      )}
    </li>
  )
}

function StatusChip({ status }: { status: string | null }) {
  if (!status) return null
  const s = status.toLowerCase()
  const color = s === 'active' || s === 'in progress' ? 'text-untagged' : s === 'done' ? 'text-faint' : s === 'paused' ? 'text-inbox' : 'text-dim'
  return <span className={cx('shrink-0 rounded-full border border-[var(--panel-border)] px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider', color)}>{status}</span>
}

/** The note's blockquote or first paragraph, as the card's one-line brief. */
function Summary({ note }: { note: ParsedNote }) {
  const text = useMemo(() => {
    const body = note.body.replace(/^#.*$/m, '')
    const quote = /^>\s*(.+)$/m.exec(body)
    const para = quote?.[1] ?? body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#') && !p.startsWith('-') && !p.startsWith('|'))
    return (para ?? '').replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => b ?? a).replace(/[*_`]/g, '')
  }, [note])
  if (!text) return null
  return <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-dim">{text}</p>
}
