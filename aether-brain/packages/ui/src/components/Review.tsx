import { useEffect, useMemo, useState } from 'react'
import { todayIso, type NoteId, type ParsedNote } from '@aether/core'
import { AREA_LABELS } from '@aether/graph'
import { useAether, type ReviewEntry } from '../store'
import { MarkdownPreview } from './MarkdownPreview'
import { cx, daysSince, plural } from '../util'

type Reason = 'inbox' | 'orphan' | 'due' | 'stale' | 'ghost'

interface Item {
  id: NoteId
  note: ParsedNote
  reason: Reason
  detail: string
}

const STALE_DAYS = 90

const REASON_LABEL: Record<Reason, string> = {
  inbox: 'Process inbox',
  orphan: 'Connect an orphan',
  due: 'Spaced review',
  stale: 'Resurfaced',
  ghost: 'Missing neuron',
}

/**
 * Review: the "second brain" loop. Queue = unprocessed inbox → orphans that
 * need a synapse → notes due for spaced review → stale notes. Each card has
 * one-key actions; the interval doubles every time you keep a note.
 */
export function Review() {
  const view = useAether((s) => s.view)
  const setView = useAether((s) => s.setView)
  const notes = useAether((s) => s.notes)
  const graph = useAether((s) => s.graph)
  const revision = useAether((s) => s.revision)
  const review = useAether((s) => s.review)
  const search = useAether((s) => s.search)
  const reviewMark = useAether((s) => s.reviewMark)
  const moveToArea = useAether((s) => s.moveToArea)
  const openNote = useAether((s) => s.openNote)
  const select = useAether((s) => s.select)
  const appendLink = useAether((s) => s.appendLink)
  const [index, setIndex] = useState(0)

  const queue = useMemo<Item[]>(() => {
    if (!graph) return []
    const today = todayIso()
    const out: Item[] = []
    const seen = new Set<NoteId>()
    const push = (id: NoteId, reason: Reason, detail: string) => {
      const note = notes.get(id)
      if (!note || seen.has(id)) return
      seen.add(id)
      out.push({ id, note, reason, detail })
    }
    for (const n of notes.values()) if (n.meta.area === 'inbox') push(n.meta.id, 'inbox', `captured ${daysSince(n.meta.created) ?? '?'}d ago`)
    for (const id of graph.orphans) {
      const n = notes.get(id)
      if (n && n.meta.area !== 'archive') push(id, 'orphan', 'no links in or out')
    }
    for (const [id, e] of Object.entries(review) as [NoteId, ReviewEntry][]) {
      if (e.due <= today) push(id, 'due', `interval ${e.interval}d · reviewed ${e.count}×`)
    }
    const stale = [...notes.values()]
      .filter((n) => n.meta.area !== 'archive' && n.meta.area !== 'inbox' && (daysSince(n.meta.updated) ?? 0) > STALE_DAYS && !review[n.meta.id])
      .sort((a, b) => (a.meta.updated ?? '').localeCompare(b.meta.updated ?? ''))
      .slice(0, 12)
    for (const n of stale) push(n.meta.id, 'stale', `untouched for ${daysSince(n.meta.updated)}d`)
    return out
  }, [notes, graph, review, revision])

  const item = queue[Math.min(index, Math.max(0, queue.length - 1))] ?? null
  const related = useMemo(() => (item ? search.related(item.note, 5) : []), [item, search])

  useEffect(() => {
    if (view === 'review' && item) select(item.id, { fly: true })
  }, [item?.id, view])

  useEffect(() => {
    if (view !== 'review') return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (!item) return
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          setIndex((i) => Math.min(queue.length - 1, i + 1))
          break
        case 'k':
        case 'ArrowUp':
          setIndex((i) => Math.max(0, i - 1))
          break
        case 'o':
        case 'Enter':
          openNote(item.id, { fly: true })
          setView('editor')
          break
        case '1':
          void act('keep')
          break
        case '2':
          void act('later')
          break
        case '3':
          void act('archive')
          break
        case 'p':
          void moveToArea(item.id, 'projects')
          break
        case 'a':
          void moveToArea(item.id, 'areas')
          break
        case 's':
          void moveToArea(item.id, 'resources')
          break
        default:
          return
      }
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  })

  if (view !== 'review') return null

  const act = async (outcome: 'keep' | 'later' | 'archive') => {
    if (!item) return
    await reviewMark(item.id, outcome)
    setIndex((i) => Math.min(i, Math.max(0, queue.length - 2)))
  }

  return (
    <div className="absolute inset-0 z-30 flex items-stretch justify-end bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && setView('graph')} role="dialog" aria-label="Review">
      <div className="panel rise m-3 flex w-[720px] max-w-[95vw] flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-2.5">
          <span className="text-accent2">↻</span>
          <span className="text-[13px] font-semibold text-white">Review</span>
          <span className="text-[12px] text-dim">
            {queue.length ? `${index + 1} / ${plural(queue.length, 'item')}` : 'queue empty'}
          </span>
          <span className="flex-1" />
          <button type="button" className="hud-btn" onClick={() => setView('graph')}>
            Done <kbd>Esc</kbd>
          </button>
        </div>

        {!item ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
            <div className="text-2xl">✦</div>
            <div className="text-[15px] font-semibold text-white">Inbox zero, no orphans, nothing due.</div>
            <div className="max-w-sm text-[13px] text-dim">Capture something new, or wander the graph — notes resurface here after {STALE_DAYS} days untouched.</div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-[var(--line)] bg-black/20 px-4 py-2 text-[11.5px]">
              <span className={cx('section-title', item.reason === 'inbox' ? 'text-inbox' : item.reason === 'orphan' ? 'text-danger' : 'text-accent2')}>{REASON_LABEL[item.reason]}</span>
              <span className="text-dim">· {item.detail}</span>
              <span className="flex-1" />
              <span className="text-faint">
                {AREA_LABELS[item.note.meta.area]} · {item.note.meta.type} · {item.note.meta.wordCount}w
              </span>
            </div>
            <div className="flex min-h-0 flex-1">
              <div className="scroll min-w-0 flex-1">
                <MarkdownPreview source={item.note.raw} selfId={item.id} />
              </div>
              <aside className="scroll w-56 shrink-0 border-l border-[var(--line)] p-3">
                <div className="section-title mb-1.5">Suggested synapses</div>
                {related.length === 0 && <div className="text-[12px] text-faint">No similar notes found.</div>}
                {related.map((r) => (
                  <div key={r.id} className="mb-2">
                    <button type="button" className="block truncate text-left text-[12.5px] text-ink hover:text-accent2" onClick={() => select(r.id, { fly: true })}>
                      {r.title}
                    </button>
                    <button type="button" className="text-[11px] text-accent2 hover:underline" onClick={() => void appendLink(item.id, r.id)}>
                      + link from this note
                    </button>
                  </div>
                ))}
              </aside>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--line)] px-3 py-2">
              {item.reason === 'inbox' ? (
                <>
                  <button type="button" className="hud-btn" onClick={() => void moveToArea(item.id, 'projects')}>
                    → Projects <kbd>p</kbd>
                  </button>
                  <button type="button" className="hud-btn" onClick={() => void moveToArea(item.id, 'areas')}>
                    → Areas <kbd>a</kbd>
                  </button>
                  <button type="button" className="hud-btn" onClick={() => void moveToArea(item.id, 'resources')}>
                    → Resources <kbd>s</kbd>
                  </button>
                  <button type="button" className="hud-btn" onClick={() => void act('archive')}>
                    → Archive <kbd>3</kbd>
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="hud-btn primary" onClick={() => void act('keep')}>
                    ✓ Still true <kbd className="!text-white/80">1</kbd>
                  </button>
                  <button type="button" className="hud-btn" onClick={() => void act('later')}>
                    ↷ Tomorrow <kbd>2</kbd>
                  </button>
                  <button type="button" className="hud-btn" onClick={() => void act('archive')}>
                    ⌫ Archive <kbd>3</kbd>
                  </button>
                </>
              )}
              <span className="flex-1" />
              <button type="button" className="hud-btn" onClick={() => (openNote(item.id, { fly: true }), setView('editor'))}>
                Edit <kbd>o</kbd>
              </button>
              <button type="button" className="hud-btn" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>
                <kbd>k</kbd> prev
              </button>
              <button type="button" className="hud-btn" onClick={() => setIndex((i) => Math.min(queue.length - 1, i + 1))} disabled={index >= queue.length - 1}>
                next <kbd>j</kbd>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
