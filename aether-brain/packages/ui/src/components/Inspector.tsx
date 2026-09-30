import { useEffect, useMemo, useRef, useState } from 'react'
import {
  TODAY_ID,
  findUnlinkedMentions,
  folderOf,
  folderPathOf,
  ghostTitle,
  imageFileName,
  imagePathOf,
  isFolderId,
  isGhostId,
  isImageId,
  isTodayId,
  type BriefTask,
  type DailyBrief,
  type GraphNode,
  type NoteId,
} from '@aether/core'
import { AREA_LABELS, IMAGE_COLOR, STAR_COLOR, SUN_COLOR, TODAY_COLOR, planetColor } from '@aether/graph'
import { useAether } from '../store'
import { cx, plural, relativeTime, truncate, MOD } from '../util'
import { copyEmbed, formatBytes, importPicturesFromDialog } from './pictures'

/**
 * Right-hand inspector for the selected neuron: metadata, outgoing synapses,
 * backlinks, unlinked mentions, and quick actions. Everything here is a
 * keyboard-reachable button.
 */
export function Inspector() {
  const selectedId = useAether((s) => s.selectedId)
  const note = useAether((s) => (s.selectedId ? (s.notes.get(s.selectedId) ?? null) : null))
  const graph = useAether((s) => s.graph)
  const notes = useAether((s) => s.notes)
  const revision = useAether((s) => s.revision)
  const openNote = useAether((s) => s.openNote)
  const select = useAether((s) => s.select)
  const createGhost = useAether((s) => s.createGhost)
  const appendLink = useAether((s) => s.appendLink)
  const toggleTag = useAether((s) => s.toggleTag)
  const setActiveTag = useAether((s) => s.setActiveTag)
  const activeTag = useAether((s) => s.activeTag)
  const controller = useAether((s) => s.controller)

  const mentions = useMemo(
    () => (selectedId && graph && note ? findUnlinkedMentions(notes, graph, selectedId) : []),
    [selectedId, graph, notes, note, revision],
  )

  if (!selectedId || !graph) return null

  if (isFolderId(selectedId)) {
    const node = graph.nodes[graph.index.get(selectedId) ?? -1]
    return node?.folder ? <FolderInspector key={selectedId} node={node} /> : null
  }

  if (isTodayId(selectedId)) return <TodayInspector />

  if (isImageId(selectedId)) return <ImageInspector key={selectedId} id={selectedId} />

  if (isGhostId(selectedId)) {
    const refs = [...(graph.backlinks.get(selectedId) ?? [])]
    return (
      <aside className="panel rise flex w-80 flex-col gap-3 p-4" aria-label="Inspector">
        <div>
          <div className="section-title text-danger">Missing neuron</div>
          <div className="mt-1 text-[16px] font-semibold text-white">{ghostTitle(selectedId)}</div>
          <p className="mt-1 text-[12.5px] text-dim">
            {plural(refs.length, 'note')} link here, but no file exists yet. Creating it turns a dangling synapse into a real connection.
          </p>
        </div>
        <button type="button" className="hud-btn primary justify-center" onClick={() => void createGhost(selectedId)}>
          + Create "{ghostTitle(selectedId)}" in Inbox
        </button>
        <LinkList title="Referenced from" ids={refs} onOpen={openNote} onSelect={select} />
      </aside>
    )
  }

  if (!note) return null
  const m = note.meta
  const out = [...(graph.outlinks.get(selectedId) ?? [])]
  const inn = [...(graph.backlinks.get(selectedId) ?? [])]

  return (
    <aside className="panel rise flex max-h-full w-80 flex-col overflow-hidden" aria-label="Inspector">
      <div className="p-4 pb-3">
        <div className={cx('section-title', `area-${m.area}`)}>
          {AREA_LABELS[m.area]} · {m.type}
          {m.status ? ` · ${m.status}` : ''}
        </div>
        <button
          type="button"
          className="mt-1 block w-full text-left text-[17px] font-semibold leading-tight text-white hover:text-accent2"
          onClick={() => openNote(selectedId, { fly: true })}
          title={`Open (${MOD}+Enter / e)`}
        >
          {m.title}
        </button>
        <div className="mt-1 font-mono text-[10.5px] text-faint">{m.path}</div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-dim">
          <span title="Words">{m.wordCount} words</span>
          <span title="Links out">↗ {out.length}</span>
          <span title="Backlinks">↙ {inn.length}</span>
          <span title="Created">✦ {relativeTime(m.created)}</span>
          <span title="Updated">✎ {relativeTime(m.updated)}</span>
        </div>
        {m.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.tags.map((t) => (
              <button
                type="button"
                key={t}
                className={cx('chip', activeTag === t && 'active')}
                onClick={(e) => (e.shiftKey ? toggleTag(t) : setActiveTag(activeTag === t ? null : t))}
                title="Click: show tag field · Shift+click: filter"
              >
                #{t}
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <button type="button" className="hud-btn primary flex-1 justify-center" onClick={() => openNote(selectedId, { fly: true })}>
            Open <kbd className="ml-1 !text-white/80">e</kbd>
          </button>
          <button type="button" className="hud-btn" onClick={() => controller.flyTo(selectedId)} title="Fly to (f)">
            ✈
          </button>
          <button type="button" className="hud-btn" onClick={() => select(null)} title="Deselect (Esc)">
            ✕
          </button>
        </div>
      </div>

      <div className="scroll flex-1 border-t border-[var(--line)] px-4 py-3">
        {m.headings.length > 1 && (
          <Section title="Outline">
            {m.headings
              .filter((h) => h.depth > 1)
              .slice(0, 12)
              .map((h, i) => (
                <div key={i} className="truncate text-[12px] text-dim" style={{ paddingLeft: (h.depth - 2) * 10 }}>
                  {h.text}
                </div>
              ))}
          </Section>
        )}
        <LinkList title="Synapses out" ids={out} onOpen={openNote} onSelect={select} />
        <LinkList title="Backlinks" ids={inn} onOpen={openNote} onSelect={select} />
        {mentions.length > 0 && (
          <Section title={`Unlinked mentions · ${mentions.length}`}>
            {mentions.slice(0, 8).map((x) => (
              <div key={x.id} className="mb-2 rounded-lg border border-[var(--line)] bg-black/20 p-2">
                <button type="button" className="block truncate text-left text-[12.5px] font-medium text-ink hover:text-accent2" onClick={() => select(x.id, { fly: true })}>
                  {notes.get(x.id)?.meta.title ?? x.id}
                </button>
                <div className="mt-0.5 line-clamp-2 text-[11px] text-dim">{x.excerpt}</div>
                <button type="button" className="mt-1 text-[11px] text-accent2 hover:underline" onClick={() => void appendLink(x.id, selectedId)}>
                  + link it
                </button>
              </div>
            ))}
          </Section>
        )}
      </div>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="section-title mb-1.5">{title}</div>
      {children}
    </div>
  )
}

function LinkList({
  title,
  ids,
  onOpen,
  onSelect,
}: {
  title: string
  ids: NoteId[]
  onOpen: (id: NoteId, o?: { fly?: boolean }) => void
  onSelect: (id: NoteId, o?: { fly?: boolean }) => void
}) {
  const notes = useAether((s) => s.notes)
  if (ids.length === 0) return null
  return (
    <Section title={`${title} · ${ids.length}`}>
      {ids.map((id) => {
        const row = linkRow(id, notes.get(id)?.meta)
        return (
          <div key={id} className="group flex items-center gap-2 py-0.5">
            <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', row.dotClass)} style={row.dot ? { background: row.dot } : undefined} />
            <button
              type="button"
              className={cx('min-w-0 flex-1 truncate text-left text-[12.5px]', row.kind === 'ghost' ? 'text-danger/80 italic' : 'text-dim hover:text-ink')}
              onClick={() => onSelect(id, { fly: true })}
              onDoubleClick={() => onOpen(id, { fly: true })}
              title={row.hint}
            >
              {row.label}
            </button>
            {(row.kind === 'note' || row.kind === 'image') && (
              <button type="button" className="text-[11px] text-faint opacity-0 group-hover:opacity-100 hover:text-accent2" onClick={() => onOpen(id, { fly: true })}>
                open
              </button>
            )}
          </div>
        )
      })}
    </Section>
  )
}

/** How a link list shows an id: notes by title, and the ids that are no notes by what they are (exported for tests). */
export function linkRow(
  id: NoteId,
  meta: { title: string; area: string } | undefined,
): { kind: 'note' | 'ghost' | 'image' | 'today' | 'folder'; label: string; hint: string; dot?: string; dotClass?: string } {
  if (isGhostId(id)) return { kind: 'ghost', label: `+ ${ghostTitle(id)}`, hint: 'Missing note — select to create', dotClass: 'bg-danger' }
  if (isImageId(id)) {
    return { kind: 'image', label: `🖼 ${imageFileName(imagePathOf(id))}`, hint: 'Click: select · double-click: open in your image app', dot: IMAGE_COLOR }
  }
  if (isTodayId(id)) return { kind: 'today', label: '☀ Today', hint: "Click: select the daily brief", dot: TODAY_COLOR }
  if (isFolderId(id)) {
    const path = folderPathOf(id)
    return { kind: 'folder', label: `● ${path.slice(path.lastIndexOf('/') + 1) || 'Vault'}`, hint: 'Click: select · double-click: expand', dot: planetColor(path) }
  }
  return { kind: 'note', label: meta?.title ?? id, hint: 'Click: select · double-click: open', dotClass: `bg-${meta?.area ?? 'untagged'}` }
}

const ROLE_LABEL = { root: 'Vault', mount: 'Drive · root folder', project: '★ Project star', folder: 'Folder' } as const

/**
 * Inspector for a folder node of the system layout: where it is, what is in
 * it (planets with their note counts, moons), and folder actions — a note or
 * a folder inside it, make it a project, expand / collapse, reveal on disk.
 */
function FolderInspector({ node }: { node: GraphNode }) {
  const info = node.folder!
  const graph = useAether((s) => s.graph)
  const adapter = useAether((s) => s.adapter)
  const roots = useAether((s) => s.roots)
  const notes = useAether((s) => s.notes)
  const expanded = useAether((s) => s.expandedFolders.has(info.path))
  const select = useAether((s) => s.select)
  const openNote = useAether((s) => s.openNote)
  const toggleFolder = useAether((s) => s.toggleFolder)
  const createFolder = useAether((s) => s.createFolder)
  const createNote = useAether((s) => s.createNote)
  const makeProject = useAether((s) => s.makeProject)
  const selectProject = useAether((s) => s.selectProject)
  const setView = useAether((s) => s.setView)
  const reveal = useAether((s) => s.reveal)
  const controller = useAether((s) => s.controller)
  const [adding, setAdding] = useState<'note' | 'folder' | null>(null)
  const [name, setName] = useState('')
  /** Bumped per palette request so the field mounts again and takes the focus. */
  const [asked, setAsked] = useState(0)

  const children = useMemo(() => {
    const planets: GraphNode[] = []
    const moons: GraphNode[] = []
    const pictures: GraphNode[] = []
    for (const n of graph?.nodes ?? []) {
      if (n.parent !== node.id) continue
      if (n.kind === 'folder') planets.push(n)
      else if (n.kind === 'note') moons.push(n)
      else if (n.kind === 'image') pictures.push(n)
    }
    planets.sort((a, b) => (b.folder?.totalNotes ?? 0) - (a.folder?.totalNotes ?? 0) || a.title.localeCompare(b.title))
    moons.sort((a, b) => a.title.localeCompare(b.title))
    // Newest first, like the moons the graph picks.
    pictures.sort((a, b) => (b.image?.mtime ?? 0) - (a.image?.mtime ?? 0) || a.title.localeCompare(b.title))
    return { planets, moons, pictures }
  }, [graph, node.id])

  const readOnly = !adapter || adapter.readOnly
  // The vault root of a multi-root vault is not a folder on disk; a drive can't be a project.
  const onDisk = !(info.role === 'root' && roots.length > 1)
  const canMkdir = !!adapter?.createFolder
  const canImport = !!adapter?.createAsset

  // The palette's "New note / New folder in the selected folder…" open the inline form below.
  const formRequest = useAether((s) => s.formRequest)
  useEffect(() => {
    if (formRequest !== 'note' && formRequest !== 'folder') return
    useAether.getState().requestForm(null)
    if (readOnly || (formRequest === 'folder' && !canMkdir)) return
    if (!onDisk) {
      useAether.getState().toast('Pick a drive, or a folder inside one, for that')
      return
    }
    setAdding(formRequest)
    setName('')
    setAsked((n) => n + 1)
  }, [formRequest, readOnly, onDisk, canMkdir])
  const role = info.role === 'folder' && info.inProject ? 'Planet of a project' : ROLE_LABEL[info.role]
  const color = info.role === 'project' ? STAR_COLOR : info.role === 'folder' ? planetColor(info.path) : SUN_COLOR
  const projectNote = info.projectId ? notes.get(info.projectId) : undefined
  const where = info.role === 'root' ? (adapter?.location ?? '') : `${info.path}/`

  const submit = async () => {
    const value = name.trim()
    if (!value || !adding) return
    const done = adding === 'note' ? await createNote(info.path, value) : await createFolder(info.path ? `${info.path}/${value}` : value)
    if (done) {
      setAdding(null)
      setName('')
    }
  }

  return (
    <aside className="panel rise flex max-h-full w-80 flex-col overflow-hidden" aria-label="Folder inspector">
      <div className="p-4 pb-3">
        <div className="section-title flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
          {role}
        </div>
        <button
          type="button"
          className="mt-1 block w-full truncate text-left text-[17px] font-semibold leading-tight text-white hover:text-accent2"
          onClick={() => controller.flyTo(node.id)}
          title="Fly to it (f)"
        >
          {node.title}
        </button>
        <div className="mt-1 truncate font-mono text-[10.5px] text-faint" title={where}>
          {where}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-dim">
          <span title="Notes directly in this folder">· {plural(info.notes, 'moon')}</span>
          <span title="Notes anywhere under this folder">{plural(info.totalNotes, 'note')} in all</span>
          <span title="Subfolders on disk">● {plural(info.childFolders, 'folder')}</span>
          {info.hiddenFolders > 0 && <span className="text-inbox">+{info.hiddenFolders} hidden</span>}
          {info.images > 0 && (
            <span title="Pictures directly in this folder · how many orbit it as moons (the newest)">
              🖼 {plural(info.images, 'picture')} · {info.shownImages} shown
            </span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(info.hiddenFolders > 0 || expanded) && (
            <button type="button" className="hud-btn primary" onClick={() => toggleFolder(info.path)} title="Expand / collapse (x)">
              {expanded ? 'Collapse' : `Expand +${info.hiddenFolders}`} <kbd className="!text-white/80">x</kbd>
            </button>
          )}
          {info.projectId ? (
            <button
              type="button"
              className="hud-btn"
              onClick={() => {
                selectProject(info.projectId)
                setView('projects')
              }}
              title={projectNote ? `Open the board of ${projectNote.meta.title} (p)` : 'Open the project board (p)'}
            >
              ★ Project board <kbd>p</kbd>
            </button>
          ) : (
            info.role === 'folder' && (
              <button type="button" className="hud-btn" disabled={readOnly} onClick={() => void makeProject(info.path)} title={`Writes ${info.path}/${node.title}.md — the folder becomes a star`}>
                ★ Make project
              </button>
            )
          )}
          {adapter?.reveal && onDisk && (
            <button type="button" className="hud-btn" onClick={() => void reveal(info.path)} title="Show in the file manager">
              Reveal
            </button>
          )}
          <button type="button" className="hud-btn" onClick={() => select(null)} title="Deselect (Esc)">
            ✕
          </button>
        </div>
        {!readOnly && onDisk && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className="hud-btn" aria-pressed={adding === 'note'} onClick={() => setAdding(adding === 'note' ? null : 'note')}>
              + Note here
            </button>
            <button type="button" className="hud-btn" aria-pressed={adding === 'folder'} onClick={() => setAdding(adding === 'folder' ? null : 'folder')} disabled={!canMkdir}>
              + Folder here
            </button>
            {canImport && (
              <button type="button" className="hud-btn" onClick={() => importPicturesFromDialog(info.path)} title={`Copy picture files into ${info.path || 'the vault'}/ (or drop them on the window)`}>
                🖼 Import pictures…
              </button>
            )}
          </div>
        )}
        {adding && (
          <form
            className="mt-2 flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <input
              key={asked}
              autoFocus
              className="input !py-1.5 !text-[12.5px]"
              placeholder={adding === 'note' ? 'Title of the new note' : 'Name of the new folder'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setAdding(null))}
              aria-label={adding === 'note' ? 'New note title' : 'New folder name'}
            />
            <button type="submit" className="hud-btn primary" disabled={!name.trim()}>
              Add
            </button>
          </form>
        )}
      </div>

      <div className="scroll flex-1 border-t border-[var(--line)] px-4 py-3">
        {children.planets.length > 0 && (
          <Section title={`Planets · ${children.planets.length}`}>
            {children.planets.map((p) => (
              <div key={p.id} className="flex items-center gap-2 py-0.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: p.folder?.role === 'project' ? STAR_COLOR : planetColor(p.folder?.path ?? '') }} />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-[12.5px] text-dim hover:text-ink"
                  onClick={() => select(p.id, { fly: true })}
                  onDoubleClick={() => openNote(p.id, { fly: true })}
                  title="Click: select · double-click: expand"
                >
                  {p.folder?.role === 'project' ? '★ ' : ''}
                  {p.title}
                </button>
                <span className="shrink-0 text-[10.5px] tabular-nums text-faint">
                  {p.folder?.totalNotes ?? 0}
                  {p.folder?.hiddenFolders ? ` · +${p.folder.hiddenFolders}` : ''}
                </span>
              </div>
            ))}
          </Section>
        )}
        {children.moons.length > 0 && <LinkList title="Moons" ids={children.moons.map((n) => n.id)} onOpen={openNote} onSelect={select} />}
        {children.pictures.length > 0 && <LinkList title="Pictures" ids={children.pictures.map((n) => n.id)} onOpen={openNote} onSelect={select} />}
        {children.planets.length === 0 && children.moons.length === 0 && children.pictures.length === 0 && (
          <div className="text-[12px] text-faint">Empty so far. Add a note or a folder above.</div>
        )}
      </div>
    </aside>
  )
}

const BRIEF_SECTIONS = [
  { key: 'overdue', title: 'Overdue' },
  { key: 'today', title: 'Today' },
  { key: 'next', title: 'Next up' },
] as const satisfies readonly { key: keyof Pick<DailyBrief, 'overdue' | 'today' | 'next'>; title: string }[]

/**
 * Move keyboard focus into the Today brief: the first task's tick box (with
 * `last`, the last row's last button). False when no brief with tasks is showing.
 * The global keys call it for `Tab` / `Enter` while the hub is selected.
 */
export function focusBrief(last: boolean): boolean {
  if (typeof document === 'undefined') return false
  // The first enabled button of a row: its tick box, or (read-only vault) its project / note button.
  const ticks = document.querySelectorAll<HTMLElement>('[data-brief] [data-brief-col]:not([disabled])')
  const el = last ? ticks[ticks.length - 1] : ticks[0]
  if (!el) return false
  el.focus()
  return true
}

/** A day as people say it: `Wednesday, 30 September` (in the user's locale). */
function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}

/** A date near `today` in a few words: `today`, `tomorrow`, `3 days late`, `Oct 4`. */
function nearDate(iso: string, today: string): string {
  const days = Math.round((Date.parse(`${iso}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86400000)
  if (!Number.isFinite(days)) return iso
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  if (days < 0) return `${-days} days late`
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The chip that says why a task is on the brief and when it is due (exported for tests). */
export function briefChip(t: BriefTask, today: string): { text: string; tone: 'late' | 'today' | 'plain'; title: string } | null {
  switch (t.reason) {
    case 'overdue':
      return { text: `📅 ${nearDate(t.due ?? today, today)}`, tone: 'late', title: `Was due ${t.due}` }
    case 'due':
      return { text: '📅 due today', tone: 'today', title: `Due ${t.due}` }
    case 'scheduled':
      return { text: `⏳ ${t.scheduled === today ? 'today' : `since ${nearDate(t.scheduled ?? today, today)}`}`, tone: 'today', title: `Scheduled ${t.scheduled}` }
    case 'daily':
      return { text: 'daily note', tone: 'today', title: "In today's daily note" }
    case 'flagged':
      return { text: '#today', tone: 'today', title: 'Flagged #today' }
    case 'next':
      return t.due ? { text: `📅 ${nearDate(t.due, today)}`, tone: 'plain', title: `Due ${t.due}` } : null
  }
}

const briefKey = (t: BriefTask) => `${t.section}\u0000${t.noteId}\u0000${t.line}`

/**
 * The Today hub's inspector: the daily brief, today's to-dos from every note
 * in three sections (overdue, today, next up). Ticking a task writes it done
 * in its own note (the toast can undo it); a row's project chip selects the
 * project's star, its note title opens the note. Every row is real buttons:
 * `Tab` walks them, `↑` `↓` jump rows, `Space` ticks.
 */
function TodayInspector() {
  const brief = useAether((s) => s.brief)
  const graph = useAether((s) => s.graph)
  const readOnly = useAether((s) => !s.adapter || s.adapter.readOnly)
  const select = useAether((s) => s.select)
  const openNote = useAether((s) => s.openNote)
  const toggleTask = useAether((s) => s.toggleTask)
  const toast = useAether((s) => s.toast)
  const hover = useAether((s) => s.hover)
  const controller = useAether((s) => s.controller)
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  /** Row whose tick box takes the focus once the brief redraws (the ticked row is gone by then). */
  const [refocus, setRefocus] = useState<number | null>(null)
  const panel = useRef<HTMLElement | null>(null)
  /** The note a focused row lit up in the graph (hover), cleared when the brief closes. */
  const lit = useRef<NoteId | null>(null)
  useEffect(
    () => () => {
      if (lit.current !== null && useAether.getState().hoveredId === lit.current) useAether.getState().hover(null)
    },
    [],
  )

  // Project note → the ★ star of its home folder, when the graph shows one.
  const stars = useMemo(() => {
    const out = new Map<NoteId, NoteId>()
    for (const n of graph?.nodes ?? []) if (n.kind === 'folder' && n.folder?.projectId) out.set(n.folder.projectId, n.id)
    return out
  }, [graph])

  useEffect(() => {
    if (refocus === null) return
    setRefocus(null)
    const ticks = panel.current?.querySelectorAll<HTMLElement>('[data-brief-tick]')
    if (ticks?.length) ticks[Math.min(refocus, ticks.length - 1)]?.focus()
    else panel.current?.querySelector<HTMLElement>('[data-brief-home]')?.focus()
  }, [brief, refocus])

  if (!brief) return null
  // Position of every row in the whole list: a ticked row's successor takes its place (and the focus).
  const position = new Map(BRIEF_SECTIONS.flatMap((sec) => brief[sec.key]).map((t, i) => [t, i]))

  const tick = async (t: BriefTask, index: number, hadFocus: boolean) => {
    const key = briefKey(t)
    if (readOnly || pending.has(key)) return
    setPending((p) => new Set(p).add(key))
    const before = useAether.getState().notes.get(t.noteId)?.raw
    try {
      await toggleTask(t.noteId, t.line, true)
    } finally {
      setPending((p) => {
        const next = new Set(p)
        next.delete(key)
        return next
      })
      // The busy tick box lost the focus: give it back to this place in the list.
      if (hadFocus) setRefocus(index)
    }
    // Unchanged: the store did not write it and has said why.
    const after = useAether.getState().notes.get(t.noteId)?.raw
    if (after === undefined || after === before) return
    // The tick rewrites that one line in place, so the task is on the same line of `after`.
    toast(`Ticked “${truncate(t.label, 48)}”`, 'success', { label: 'Undo', run: () => void toggleTask(t.noteId, t.line, false, after) })
  }

  /** Project chip: the project's star when the graph shows it, else the project note. */
  const showProject = (projectId: NoteId) => select(stars.get(projectId) ?? projectId, { fly: true })

  return (
    <aside
      ref={panel}
      className="panel rise flex max-h-full w-80 flex-col overflow-hidden"
      aria-label="Today — daily brief"
      data-brief
      onKeyDown={(e) => {
        // Inside the brief, Tab walks its buttons (and wraps) instead of cycling graph neighbors.
        if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return
        e.stopPropagation()
        const all = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')]
        const at = all.indexOf(document.activeElement as HTMLElement)
        const to = e.shiftKey ? (at <= 0 ? all.length - 1 : -1) : at === all.length - 1 ? 0 : -1
        if (to >= 0) {
          e.preventDefault()
          all[to]?.focus()
        }
      }}
    >
      <div className="p-4 pb-3">
        <div className="section-title flex items-center gap-1.5" style={{ color: TODAY_COLOR }}>
          <span aria-hidden>☀</span> Today · daily brief
        </div>
        <button
          type="button"
          data-brief-home
          className="mt-1 block w-full truncate text-left text-[17px] font-semibold leading-tight text-white hover:text-accent2"
          onClick={() => controller.flyTo(TODAY_ID)}
          title="Fly to the hub (f)"
        >
          {longDate(brief.date)}
        </button>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-dim">
          {brief.overdue.length > 0 && <span className="text-danger">{brief.overdue.length} overdue</span>}
          <span>{brief.today.length} today</span>
          <span>{brief.next.length} next up</span>
          <span className="text-faint">· {plural(brief.noteIds.length, 'note')}</span>
        </div>
        <div className="mt-3 flex gap-2">
          <button type="button" className="hud-btn" onClick={() => controller.flyTo(TODAY_ID)} title="Fly to (f)">
            ✈
          </button>
          <button type="button" className="hud-btn" onClick={() => select(null)} title="Deselect (Esc)">
            ✕
          </button>
        </div>
      </div>

      <div className="scroll flex-1 border-t border-[var(--line)] px-4 py-3">
        {brief.total === 0 ? (
          <div className="text-[12.5px] text-dim">
            <div className="mb-1 text-[14px] font-semibold text-ink">All clear for today ✓</div>
            Nothing is due, scheduled or flagged. To put a task here, give it a date or a tag in any note:
            <ul className="mt-2 flex flex-col gap-1 font-mono text-[11.5px] text-faint">
              <li>- [ ] Ink the gate 📅 {brief.date}</li>
              <li>- [ ] Value pass ⏳ {brief.date}</li>
              <li>- [ ] Buy paper #today</li>
            </ul>
            <div className="mt-2">
              or write it in today's daily note (<kbd>d</kbd>). Active projects show their next task here too.
            </div>
          </div>
        ) : (
          BRIEF_SECTIONS.map((sec) => {
            const tasks = brief[sec.key]
            if (!tasks.length) return null
            return (
              <Section key={sec.key} title={`${sec.title} · ${tasks.length}`}>
                <ul>
                  {tasks.map((t) => {
                    const index = position.get(t) ?? 0
                    const chip = briefChip(t, brief.date)
                    const busy = pending.has(briefKey(t))
                    return (
                      <li
                        key={briefKey(t)}
                        className="flex items-start gap-2 rounded-lg py-1"
                        onFocus={() => {
                          lit.current = t.noteId
                          hover(t.noteId)
                        }}
                        onBlur={() => {
                          if (useAether.getState().hoveredId === t.noteId) hover(null)
                          lit.current = null
                        }}
                        onKeyDown={(e) => {
                          // ↑ ↓ jump to the same button of the row above / below (not the camera).
                          if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.ctrlKey || e.metaKey) return
                          e.preventDefault()
                          e.stopPropagation()
                          const col = (e.target as HTMLElement).dataset['briefCol'] ?? 'tick'
                          const all = panel.current?.querySelectorAll<HTMLElement>(`[data-brief-col="${col}"]`)
                          const list = [...(all ?? [])]
                          list[list.indexOf(e.target as HTMLElement) + (e.key === 'ArrowUp' ? -1 : 1)]?.focus()
                        }}
                      >
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={false}
                          data-brief-tick
                          data-brief-col="tick"
                          disabled={readOnly || busy}
                          className="mt-[1px] grid h-4 w-4 shrink-0 place-items-center rounded border border-[var(--panel-border)] bg-black/30 text-[10px] text-transparent hover:border-[var(--today)] hover:text-[var(--today)] disabled:cursor-default disabled:opacity-40"
                          onClick={(e) => void tick(t, index, document.activeElement === e.currentTarget)}
                          aria-label={`Tick “${t.label}” (${t.noteTitle})`}
                          title={readOnly ? 'Read-only vault' : 'Tick — saved as [x] ✅ date in its note (Space)'}
                        >
                          ✓
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="break-words text-[12.5px] leading-snug text-ink">{t.label}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {t.projectId && t.projectTitle && (
                              <button
                                type="button"
                                data-brief-col="project"
                                className="chip !h-5 !px-1.5 !text-[10.5px]"
                                onClick={() => showProject(t.projectId!)}
                                title={stars.has(t.projectId) ? `Select the ${t.projectTitle} star` : `Select ${t.projectTitle}`}
                              >
                                <span style={{ color: STAR_COLOR }}>★</span>
                                {truncate(t.projectTitle, 24)}
                              </button>
                            )}
                            {chip && (
                              <span
                                className={cx('chip !h-5 !cursor-default !px-1.5 !text-[10.5px]', chip.tone === 'late' && '!border-danger/50 !text-danger')}
                                style={chip.tone === 'today' ? { color: TODAY_COLOR } : undefined}
                                title={chip.title}
                              >
                                {chip.text}
                              </span>
                            )}
                            <button
                              type="button"
                              data-brief-col="note"
                              className="min-w-0 max-w-full truncate text-left text-[11px] text-faint hover:text-accent2"
                              onClick={() => openNote(t.noteId, { fly: true })}
                              title={`Open ${t.notePath}`}
                            >
                              ↗ {t.noteId === t.projectId ? 'open note' : t.noteTitle}
                            </button>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </Section>
            )
          })
        )}
      </div>
    </aside>
  )
}

/** Preview size asked of the adapter (px, longer side): sharp at the inspector's width on a 2× screen. */
const PREVIEW_SIZE = 512

type Preview = { url: string | null; state: 'loading' | 'ready' | 'none' }

/**
 * A picture's preview as an object URL, revoked when the picture changes or
 * the inspector closes. The one place a component asks the adapter itself:
 * the store keeps no previews (`stamp` changes when the file does).
 */
function usePreview(path: string, stamp: string): Preview {
  const adapter = useAether((s) => s.adapter)
  const preview = useAether((s) => s.preview)
  const [state, setState] = useState<Preview>({ url: null, state: 'loading' })
  useEffect(() => {
    if (!adapter?.thumbnail) {
      setState({ url: null, state: 'none' })
      return
    }
    let live = true
    let url: string | null = null
    setState({ url: null, state: 'loading' })
    void preview(path, PREVIEW_SIZE).then((blob) => {
      if (!live) return
      if (!blob) return setState({ url: null, state: 'none' })
      url = URL.createObjectURL(blob)
      setState({ url, state: 'ready' })
    })
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [adapter, preview, path, stamp])
  return state
}

/**
 * Inspector for a picture: a preview, where it lives, its size and date, the
 * notes that embed it, and Open (the OS image app, `e`), Reveal and Copy
 * embed (`![[name.png]]`, to paste into a note).
 */
function ImageInspector({ id }: { id: NoteId }) {
  const path = imagePathOf(id)
  const info = useAether((s) => s.graph?.nodes[s.graph.index.get(id) ?? -1]?.image)
  const asset = useAether((s) => s.assets.get(path))
  const embeddedIn = useAether((s) => s.graph?.backlinks.get(id))
  const canReveal = useAether((s) => !!s.adapter?.reveal)
  const select = useAether((s) => s.select)
  const openNote = useAether((s) => s.openNote)
  const openImage = useAether((s) => s.openImage)
  const showFolder = useAether((s) => s.showFolder)
  const reveal = useAether((s) => s.reveal)
  const controller = useAether((s) => s.controller)
  const mtime = info?.mtime ?? asset?.mtime ?? null
  const size = info?.size ?? asset?.size ?? null
  const preview = usePreview(path, `${mtime ?? ''}:${size ?? ''}`)
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [preview.url])

  // Deleted or moved on disk while selected: nothing left to show.
  if (!info && !asset) return null
  const name = imageFileName(path)
  const folder = folderOf(path)
  const refs = [...(embeddedIn ?? [])].sort()

  return (
    <aside className="panel rise flex max-h-full w-80 flex-col overflow-hidden" aria-label="Picture inspector">
      <div className="p-4 pb-3">
        <div className="section-title flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: IMAGE_COLOR, boxShadow: `0 0 8px ${IMAGE_COLOR}` }} />
          Picture
        </div>
        <button
          type="button"
          className="mt-1 block w-full truncate text-left text-[17px] font-semibold leading-tight text-white hover:text-accent2"
          onClick={() => controller.flyTo(id)}
          title="Fly to it (f)"
        >
          {name}
        </button>
        <button
          type="button"
          className="mt-1 block max-w-full truncate text-left font-mono text-[10.5px] text-faint hover:text-accent2"
          onClick={() => showFolder(folder)}
          title="Show its folder (planet)"
        >
          {folder ? `${folder}/` : '/'}
        </button>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-dim">
          {size !== null && <span title="File size">{formatBytes(size)}</span>}
          {mtime !== null && Number.isFinite(mtime) && <span title="Modified">✎ {relativeTime(new Date(mtime).toISOString())}</span>}
          <span title="Notes that embed or link it">↙ {refs.length}</span>
        </div>
      </div>

      <div className="mx-4 mb-3 grid h-44 place-items-center overflow-hidden rounded-lg border border-[var(--line)] bg-black/40">
        {preview.url && !broken ? (
          <img src={preview.url} alt={name} className="max-h-full max-w-full object-contain" draggable={false} onError={() => setBroken(true)} />
        ) : (
          <span className="text-[11.5px] text-faint">{preview.state === 'loading' ? 'Loading preview…' : 'No preview'}</span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 px-4 pb-3">
        <button type="button" className="hud-btn primary" onClick={() => void openImage(path)} title="Open in your image app (e · Enter)">
          Open <kbd className="!text-white/80">e</kbd>
        </button>
        {canReveal && (
          <button type="button" className="hud-btn" onClick={() => void reveal(path)} title="Show in the file manager">
            Reveal
          </button>
        )}
        <button type="button" className="hud-btn" onClick={() => void copyEmbed(path)} title={`Copy ![[${name}]] to paste into a note`}>
          Copy embed
        </button>
        <button type="button" className="hud-btn" onClick={() => controller.flyTo(id)} title="Fly to (f)">
          ✈
        </button>
        <button type="button" className="hud-btn" onClick={() => select(null)} title="Deselect (Esc)">
          ✕
        </button>
      </div>

      <div className="scroll flex-1 border-t border-[var(--line)] px-4 py-3">
        {refs.length > 0 ? (
          <LinkList title="Embedded in" ids={refs} onOpen={openNote} onSelect={select} />
        ) : (
          <div className="text-[12px] text-faint">No note embeds it yet. Copy embed, then paste it into a note to link the two.</div>
        )}
      </div>
    </aside>
  )
}
