import { useEffect, useMemo, useState } from 'react'
import { findUnlinkedMentions, ghostTitle, isFolderId, isGhostId, type GraphNode, type NoteId } from '@aether/core'
import { AREA_LABELS, STAR_COLOR, SUN_COLOR, planetColor } from '@aether/graph'
import { useAether } from '../store'
import { cx, plural, relativeTime, MOD } from '../util'

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
        const ghost = isGhostId(id)
        const n = notes.get(id)
        return (
          <div key={id} className="group flex items-center gap-2 py-0.5">
            <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', ghost ? 'bg-danger' : `bg-${n?.meta.area ?? 'untagged'}`)} />
            <button
              type="button"
              className={cx('min-w-0 flex-1 truncate text-left text-[12.5px]', ghost ? 'text-danger/80 italic' : 'text-dim hover:text-ink')}
              onClick={() => onSelect(id, { fly: true })}
              onDoubleClick={() => onOpen(id, { fly: true })}
              title={ghost ? 'Missing note — select to create' : 'Click: select · double-click: open'}
            >
              {ghost ? `+ ${ghostTitle(id)}` : (n?.meta.title ?? id)}
            </button>
            {!ghost && (
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
    for (const n of graph?.nodes ?? []) {
      if (n.parent !== node.id) continue
      if (n.kind === 'folder') planets.push(n)
      else if (n.kind === 'note') moons.push(n)
    }
    planets.sort((a, b) => (b.folder?.totalNotes ?? 0) - (a.folder?.totalNotes ?? 0) || a.title.localeCompare(b.title))
    moons.sort((a, b) => a.title.localeCompare(b.title))
    return { planets, moons }
  }, [graph, node.id])

  const readOnly = !adapter || adapter.readOnly
  // The vault root of a multi-root vault is not a folder on disk; a drive can't be a project.
  const onDisk = !(info.role === 'root' && roots.length > 1)
  const canMkdir = !!adapter?.createFolder

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
              title={projectNote ? `Open the board of ${projectNote.meta.title}` : 'Open the project board'}
            >
              ★ Project board
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
          <div className="mt-2 flex gap-1.5">
            <button type="button" className="hud-btn" aria-pressed={adding === 'note'} onClick={() => setAdding(adding === 'note' ? null : 'note')}>
              + Note here
            </button>
            <button type="button" className="hud-btn" aria-pressed={adding === 'folder'} onClick={() => setAdding(adding === 'folder' ? null : 'folder')} disabled={!canMkdir}>
              + Folder here
            </button>
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
        {children.planets.length === 0 && children.moons.length === 0 && <div className="text-[12px] text-faint">Empty so far. Add a note or a folder above.</div>}
      </div>
    </aside>
  )
}
