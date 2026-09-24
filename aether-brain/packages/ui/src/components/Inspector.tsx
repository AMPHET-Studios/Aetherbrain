import { useMemo } from 'react'
import { findUnlinkedMentions, ghostTitle, isGhostId, type NoteId } from '@aether/core'
import { AREA_LABELS } from '@aether/graph'
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
