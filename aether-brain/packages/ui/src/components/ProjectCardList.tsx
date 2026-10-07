import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { NoteId } from '@aether/core'
import type { ProjectRow } from '../projects'
import { cx, plural, relativeTime, truncate } from '../util'
import { DEFAULT_VIEWPORT_PX, rowWindow, scrollToReveal } from '../windowing'

/** Height of a project card and the gap under it, px. Fixed, so the list can be windowed. */
export const CARD_HEIGHT = 108
export const CARD_GAP = 6
const CARD_ROW = CARD_HEIGHT + CARD_GAP
/** The list's own padding, px (set inline: Tailwind's p-2 is 7 px under the app's 14 px root font): the first card starts this far down. */
const LIST_PAD = 8

/** Longest text a card draws for a title, the next task, a tag or a status. */
const CARD_TITLE_CHARS = 120
const CARD_NEXT_CHARS = 160
const CARD_TAG_CHARS = 24

/** Layout effects warn when drawn on a server (the tests draw views as markup). */
const useLayoutEffectSafe = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function StatusChip({ status }: { status: string | null }) {
  if (!status) return null
  const s = status.toLowerCase()
  const color = s === 'active' || s === 'in progress' ? 'text-untagged' : s === 'done' ? 'text-faint' : s === 'paused' ? 'text-inbox' : 'text-dim'
  return <span className={cx('shrink-0 rounded-full border border-[var(--panel-border)] px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider', color)}>{truncate(status, 24)}</span>
}

interface CardProps {
  row: ProjectRow
  active: boolean
  /** Subfolders of each folder, for the planet count. */
  subfolders: Map<string, string[]>
  onSelect: (id: NoteId) => void
  onOpen: (id: NoteId) => void
}

const ProjectCard = memo(function ProjectCard({ row: r, active, subfolders, onSelect, onOpen }: CardProps) {
  const m = r.note.meta
  const next = r.open[0]
  const planetCount = r.home ? (subfolders.get(r.home)?.length ?? 0) : 0
  return (
    <div style={{ height: CARD_ROW, paddingBottom: CARD_GAP }}>
      <button
        type="button"
        data-project-card={m.id}
        onClick={() => onSelect(m.id)}
        onDoubleClick={() => onOpen(m.id)}
        style={{ height: CARD_HEIGHT }}
        className={cx(
          'block w-full overflow-hidden rounded-xl border px-3 py-2.5 text-left transition',
          active ? 'border-projects/60 bg-projects/10' : 'border-transparent hover:border-[var(--panel-border)] hover:bg-white/5',
        )}
        aria-current={active ? 'true' : undefined}
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-white">{truncate(m.title, CARD_TITLE_CHARS)}</span>
          <StatusChip status={m.status} />
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent2" style={{ width: `${r.pct}%` }} />
          </div>
          <span className="min-w-16 shrink-0 whitespace-nowrap text-right text-[10.5px] tabular-nums text-dim">
            {r.done.length}/{r.tasks.length} · {r.pct}%
          </span>
        </div>
        <div className="mt-1 truncate text-[11.5px] text-dim">{next ? `next: ${truncate(next.text, CARD_NEXT_CHARS)}` : r.tasks.length ? 'all done ✓' : 'no tasks yet'}</div>
        <div className="mt-1 flex items-center gap-2 overflow-hidden whitespace-nowrap text-[10.5px] text-faint">
          <span>✎ {relativeTime(m.updated)}</span>
          {planetCount > 0 && <span title="Folders inside the project folder">● {plural(planetCount, 'planet')}</span>}
          {m.tags.slice(0, 3).map((t) => (
            <span key={t}>#{truncate(t, CARD_TAG_CHARS)}</span>
          ))}
        </div>
      </button>
    </div>
  )
})

/**
 * The project cards, drawn a window at a time. A vault can hold thousands of
 * projects (Find projects makes them by the folder); drawn whole, each card is
 * ~22 elements, and 20,000 of them are ~440,000 elements and gigabytes of
 * memory. Here only the cards in view (and a few beyond) exist; two spacers
 * keep the scroll bar honest. Moving the selection with the keys scrolls it
 * into view.
 */
export function ProjectCardList({
  rows,
  currentId,
  subfolders,
  onSelect,
  onOpen,
}: {
  rows: ProjectRow[]
  currentId: NoteId | null
  subfolders: Map<string, string[]>
  onSelect: (id: NoteId) => void
  onOpen: (id: NoteId) => void
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const [pane, setPane] = useState({ top: 0, height: DEFAULT_VIEWPORT_PX })
  const latest = useRef(rows)
  latest.current = rows

  // How tall the list is, now and when the window is resized.
  useLayoutEffectSafe(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      const height = el.clientHeight || DEFAULT_VIEWPORT_PX
      setPane((p) => (p.height === height ? p : { ...p, height }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [])

  // Scrolling moves the window (once per frame).
  const frame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  const onScroll = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const el = box.current
      if (el) setPane((p) => (p.top === el.scrollTop ? p : { ...p, top: el.scrollTop }))
    })
  }

  // The selected project comes into view: on opening, and as j / k move it.
  useEffect(() => {
    const el = box.current
    if (!el || currentId === null) return
    const i = latest.current.findIndex((r) => r.note.meta.id === currentId)
    if (i < 0) return
    const height = el.clientHeight || DEFAULT_VIEWPORT_PX
    const at = Math.max(0, el.scrollTop - LIST_PAD)
    const want = scrollToReveal(i, CARD_ROW, at, height)
    if (want === at) return
    el.scrollTop = want + LIST_PAD
    setPane((p) => ({ ...p, top: el.scrollTop }))
  }, [currentId])

  const win = rowWindow(rows.length, CARD_ROW, Math.max(0, pane.top - LIST_PAD), pane.height)
  return (
    <div ref={box} onScroll={onScroll} className="scroll flex-1" style={{ padding: LIST_PAD }} data-cards={rows.length}>
      {rows.length === 0 && (
        <div className="p-4 text-center text-[12.5px] text-dim">
          No projects yet. A project is a note directly in <code>Projects/</code>, a folder note like <code>Projects/X/X.md</code>, or any note with{' '}
          <code>type: project</code>.
        </div>
      )}
      <div style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
        {rows.slice(win.start, win.end).map((r) => (
          <ProjectCard key={r.note.meta.id} row={r} active={r.note.meta.id === currentId} subfolders={subfolders} onSelect={onSelect} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}
