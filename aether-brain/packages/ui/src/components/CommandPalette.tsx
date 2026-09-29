import { useEffect, useMemo, useRef, useState } from 'react'
import { AREA_LABELS, planetColor } from '@aether/graph'
import type { SearchHit } from '@aether/core'
import { findCommands, type Command } from '../commands'
import { useAether } from '../store'
import { cx, MOD } from '../util'

type Row =
  | { kind: 'note'; hit: SearchHit }
  | { kind: 'folder'; path: string; name: string }
  | { kind: 'command'; cmd: Command }
  | { kind: 'create'; title: string }

/**
 * Folders whose name (best) or path contains the query: exact name, then
 * name prefix, then name, then path; shorter paths first. At most `limit`.
 */
function matchFolders(folders: Set<string>, query: string, limit: number): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: { path: string; rank: number }[] = []
  for (const f of folders) {
    const lower = f.toLowerCase()
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    const rank = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : lower.includes(q) ? 3 : -1
    if (rank >= 0) out.push({ path: f, rank })
  }
  return out
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((x) => x.path)
}

/**
 * Search + command palette. Type to search notes (title, headings, tags,
 * body, path) and folders (name, path); prefix with `>` for commands. Enter
 * opens (a folder: selects it and flies there in the system layout),
 * Shift+Enter selects-and-flies without opening the editor.
 */
export function CommandPalette() {
  const open = useAether((s) => s.paletteOpen)
  const setPalette = useAether((s) => s.setPalette)
  const search = useAether((s) => s.search)
  const notes = useAether((s) => s.notes)
  const revision = useAether((s) => s.revision)
  const openNote = useAether((s) => s.openNote)
  const select = useAether((s) => s.select)
  const setFilters = useAether((s) => s.setFilters)
  const folders = useAether((s) => s.folders)
  const showFolder = useAether((s) => s.showFolder)
  const createNote = useAether((s) => s.createNote)
  const [q, setQ] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setIndex(0)
      requestAnimationFrame(() => input.current?.focus())
    }
  }, [open])

  const rows = useMemo<Row[]>(() => {
    const s = useAether.getState()
    if (q.startsWith('>')) return findCommands(q.slice(1), s).map((cmd) => ({ kind: 'command', cmd }))
    const out: Row[] = []
    if (q.trim()) {
      // The best few notes, then matching folders (planets), then the rest of the notes.
      const hits = search.search(q, { limit: 14 })
      for (const hit of hits.slice(0, 3)) out.push({ kind: 'note', hit })
      for (const path of matchFolders(folders, q, 6)) out.push({ kind: 'folder', path, name: path.slice(path.lastIndexOf('/') + 1) })
      for (const hit of hits.slice(3)) out.push({ kind: 'note', hit })
      const exact = [...notes.values()].some((n) => n.meta.title.toLowerCase() === q.trim().toLowerCase())
      if (!exact) out.push({ kind: 'create', title: q.trim() })
      for (const cmd of findCommands(q, s).slice(0, 4)) out.push({ kind: 'command', cmd })
    } else {
      // Empty query: recent notes + top commands.
      const recent = [...notes.values()]
        .sort((a, b) => (b.meta.updated ?? '').localeCompare(a.meta.updated ?? ''))
        .slice(0, 8)
      for (const n of recent) out.push({ kind: 'note', hit: { id: n.meta.id, title: n.meta.title, score: 0, match: [], snippet: n.plain.slice(0, 120) } })
      for (const cmd of findCommands('', s).slice(0, 6)) out.push({ kind: 'command', cmd })
    }
    return out
  }, [q, search, notes, folders, revision])

  useEffect(() => setIndex(0), [rows.length, q])
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!open) return null

  const run = async (row: Row, alt = false) => {
    if (row.kind === 'note') {
      setPalette(false)
      if (alt) select(row.hit.id, { fly: true })
      else openNote(row.hit.id, { fly: true })
    } else if (row.kind === 'folder') {
      setPalette(false)
      showFolder(row.path)
    } else if (row.kind === 'command') {
      setPalette(false)
      await row.cmd.run(useAether.getState())
    } else {
      setPalette(false)
      await createNote(`${useAether.getState().homePrefix()}Inbox`, row.title)
    }
  }

  return (
    <div
      className="absolute inset-0 z-40 flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && setPalette(false)}
      role="dialog"
      aria-label="Search and commands"
    >
      <div className="panel rise w-[640px] max-w-[92vw] overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3">
          <span className="text-dim">⌕</span>
          <input
            ref={input}
            autoFocus
            className="flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-faint"
            placeholder="Search neurons… or type > for commands"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setIndex((i) => Math.min(rows.length - 1, i + 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)))
              else if (e.key === 'Enter' && rows[index]) (e.preventDefault(), void run(rows[index]!, e.shiftKey))
              else if (e.key === 'Tab') (e.preventDefault(), setQ((v) => (v.startsWith('>') ? v.slice(1) : `>${v}`)))
              else if (e.key === 'Escape') (e.preventDefault(), setPalette(false))
              else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && q.trim()) {
                e.preventDefault()
                setFilters({ query: q.trim() })
                setPalette(false)
              }
            }}
            aria-activedescendant={rows[index] ? `row-${index}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>
        <div ref={list} className="scroll max-h-[52vh] py-1" role="listbox">
          {rows.length === 0 && <div className="px-4 py-6 text-center text-sm text-faint">Nothing matches.</div>}
          {rows.map((row, i) => (
            <button
              type="button"
              key={row.kind === 'note' ? row.hit.id : row.kind === 'folder' ? `folder:${row.path}` : row.kind === 'command' ? row.cmd.id : 'create'}
              id={`row-${i}`}
              data-row={i}
              role="option"
              aria-selected={i === index}
              className={cx(
                'flex w-full items-start gap-3 px-4 py-2 text-left',
                i === index ? 'bg-accent/20' : 'hover:bg-white/5',
              )}
              onMouseEnter={() => setIndex(i)}
              onClick={(e) => void run(row, e.shiftKey)}
            >
              {row.kind === 'note' && <NoteRow hit={row.hit} />}
              {row.kind === 'folder' && (
                <>
                  <span className="mt-0.5 w-5 text-center" style={{ color: planetColor(row.path) }}>
                    ●
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-ink">{row.name}</span>
                    <span className="block truncate font-mono text-[11px] text-dim">{row.path}/</span>
                  </span>
                  <span className="shrink-0 text-[10.5px] text-faint">folder</span>
                </>
              )}
              {row.kind === 'command' && (
                <>
                  <span className="mt-0.5 w-5 text-center text-faint">›</span>
                  <span className="flex-1 text-[13.5px] text-ink">{row.cmd.title}</span>
                  {row.cmd.keys && <span className="text-[11px] text-faint">{row.cmd.keys}</span>}
                </>
              )}
              {row.kind === 'create' && (
                <>
                  <span className="mt-0.5 w-5 text-center text-untagged">+</span>
                  <span className="flex-1 text-[13.5px] text-ink">
                    Create neuron <span className="font-semibold">"{row.title}"</span> in Inbox
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-[var(--line)] px-4 py-1.5 text-[11px] text-faint">
          <span>
            <kbd>↑↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>⇧Enter</kbd> fly only
          </span>
          <span>
            <kbd>{MOD}Enter</kbd> filter graph
          </span>
          <span>
            <kbd>Tab</kbd> commands
          </span>
        </div>
      </div>
    </div>
  )
}

function NoteRow({ hit }: { hit: SearchHit }) {
  const meta = useAether((s) => s.notes.get(hit.id)?.meta)
  return (
    <>
      <span className={cx('mt-1 h-2.5 w-2.5 shrink-0 rounded-full', meta ? `bg-${meta.area}` : 'bg-faint')} style={{ boxShadow: '0 0 8px currentColor' }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-ink">{hit.title}</span>
        <span className="block truncate text-[11.5px] text-dim">{hit.snippet}</span>
      </span>
      <span className="shrink-0 text-right text-[10.5px] text-faint">
        {meta ? AREA_LABELS[meta.area] : ''}
        {meta?.tags.length ? <span className="block">#{meta.tags.slice(0, 2).join(' #')}</span> : null}
      </span>
    </>
  )
}
