/**
 * The picture picker: the vault's pictures in a list to search, choose from (Shift for a run, Ctrl / ⌘ to add one) and put on the
 * board. The list is windowed (never more than PICKER_MAX_ROWS rows in the page, however many pictures the vault has), thumbnails
 * are loaded only for the rows in view, and pictures already on the board are marked. All arithmetic is in picker-model.ts.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { cx, isMac, plural } from '../../util'
import { scrollToReveal } from '../../windowing'
import type { BoardHost } from '../api'
import { isComposing, trapTab } from './dom'
import { Icon } from './icons'
import {
  EMPTY_PICKER_SELECTION,
  PICKER_ROW_PX,
  PICKER_SEARCH_MS,
  clickRow,
  filterEntries,
  moveCursor,
  pickerWindow,
  selectAllRows,
  toEntries,
  toggleRow,
  type PickerEntry,
  type PickerSelection,
} from './picker-model'
import { MAX_PICKER_ADD } from './session'
import { useThumbs } from './useThumbs'

export interface PickerProps {
  host: BoardHost
  /** Paths already on the board (marked in the list). */
  onBoard: ReadonlySet<string>
  /** Add these pictures (in the order of the list) to the board. */
  onAdd(paths: string[]): void
  onClose(): void
  reducedMotion: boolean
}

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; entries: PickerEntry[]; cut: number }

export function Picker({ host, onBoard, onAdd, onClose, reducedMotion }: PickerProps) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [sel, setSel] = useState<PickerSelection>(EMPTY_PICKER_SELECTION)
  const [cursor, setCursor] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportPx, setViewportPx] = useState(360)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    host.pictures.list().then(
      (assets) => alive && setLoad({ state: 'ready', ...toEntries(assets) }),
      (err: unknown) => alive && setLoad({ state: 'error', message: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      alive = false
    }
  }, [host])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), PICKER_SEARCH_MS)
    return () => clearTimeout(t)
  }, [query])

  const entries = load.state === 'ready' ? load.entries : []
  const rows = useMemo(() => filterEntries(entries, debounced), [entries, debounced])

  // A new search starts at the top.
  useEffect(() => {
    setScrollTop(0)
    setCursor(0)
    if (list.current) list.current.scrollTop = 0
  }, [debounced])

  useEffect(() => {
    const el = list.current
    if (!el) return
    const measure = () => setViewportPx(el.clientHeight || 360)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [load.state])

  useEffect(() => {
    input.current?.focus({ preventScroll: true })
  }, [])

  const win = pickerWindow(rows.length, scrollTop, viewportPx)
  const shown = rows.slice(win.start, win.end)
  const urlOf = useThumbs(
    host.pictures,
    shown.map((e) => e.path),
  )

  const reveal = (index: number) => {
    const el = list.current
    if (!el) return
    const top = scrollToReveal(index, PICKER_ROW_PX, el.scrollTop, el.clientHeight)
    if (top !== el.scrollTop) el.scrollTop = top
  }

  const chosen = sel.paths.size
  const add = () => {
    let paths = rows.filter((r) => sel.paths.has(r.path)).map((r) => r.path)
    // Chosen before the search narrowed the list: they still count, after the ones in view.
    if (paths.length < chosen) {
      const seen = new Set(paths)
      for (const p of sel.paths) if (!seen.has(p)) paths.push(p)
    }
    if (paths.length === 0 && rows[cursor]) paths = [rows[cursor]!.path]
    if (paths.length > 0) onAdd(paths)
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // Nothing typed here reaches the board's or the app's own keys.
    e.stopPropagation()
    // Tab goes round inside the picker, not out onto the toolbar behind it.
    trapTab(e, panel.current)
    // Esc and Enter belong to an input method that is composing text.
    if (isComposing(e)) return
    // Enter and Space on a button are the button's (Cancel and Close close, Add adds), not the list's.
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.closest('button')) return
    const inInput = e.target === input.current
    const mod = e.ctrlKey || e.metaKey
    const step = (d: number) => {
      const next = moveCursor(cursor, rows.length, d)
      setCursor(next)
      reveal(next)
      if (e.shiftKey) setSel((s) => clickRow(s.anchor === null ? { ...s, anchor: cursor } : s, rows, next, { shift: true, ctrl: false }))
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        onClose()
        return
      case 'ArrowDown':
        e.preventDefault()
        step(1)
        return
      case 'ArrowUp':
        e.preventDefault()
        step(-1)
        return
      case 'PageDown':
        e.preventDefault()
        step(Math.max(1, Math.floor(viewportPx / PICKER_ROW_PX) - 1))
        return
      case 'PageUp':
        e.preventDefault()
        step(-Math.max(1, Math.floor(viewportPx / PICKER_ROW_PX) - 1))
        return
      case 'Enter':
        e.preventDefault()
        add()
        return
    }
    if (inInput) return
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const next = e.key === 'Home' ? 0 : Math.max(0, rows.length - 1)
      setCursor(next)
      reveal(next)
    } else if (e.key === ' ') {
      e.preventDefault()
      setSel((s) => toggleRow(s, rows, cursor))
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSel(selectAllRows(rows))
    }
  }

  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/45 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Add pictures to the board"
        tabIndex={-1}
        data-board-overlay
        onKeyDown={onKeyDown}
        className={cx('panel flex h-[min(620px,100%)] w-[min(700px,100%)] flex-col overflow-hidden outline-none', !reducedMotion && 'rise')}
      >
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2.5">
          <Icon name="search" />
          <input
            ref={input}
            type="text"
            className="input !border-0 !bg-transparent !px-1 !py-1 !shadow-none"
            placeholder="Search the vault's pictures by name or folder"
            aria-label="Search pictures"
            data-board-focus
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="hud-btn !h-7 !w-7 !justify-center !px-0" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>

        <div
          ref={list}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Pictures"
          tabIndex={0}
          className="scroll relative min-h-0 flex-1 outline-none"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          {load.state === 'loading' && <Message>Looking through the vault…</Message>}
          {load.state === 'error' && <Message tone="error">The pictures could not be listed: {load.message}</Message>}
          {load.state === 'ready' && rows.length === 0 && (
            <Message>{entries.length === 0 ? 'The vault has no pictures yet. Drop some on the board to add them.' : `No picture matches “${debounced.trim()}”.`}</Message>
          )}
          {rows.length > 0 && (
            <div style={{ paddingTop: win.padTop, paddingBottom: win.padBottom }}>
              {shown.map((e, k) => {
                const index = win.start + k
                const picked = sel.paths.has(e.path)
                const url = urlOf(e.path)
                return (
                  <div
                    key={e.path}
                    role="option"
                    aria-selected={picked}
                    data-index={index}
                    onClick={(ev) => {
                      setCursor(index)
                      setSel((s) => clickRow(s, rows, index, { shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey }))
                    }}
                    onDoubleClick={() => onAdd([e.path])}
                    className={cx(
                      'flex cursor-pointer items-center gap-3 px-3',
                      picked ? 'bg-[rgba(143,124,255,0.2)]' : 'hover:bg-[rgba(140,160,255,0.07)]',
                      index === cursor && 'shadow-[inset_2px_0_0_var(--accent-2)]',
                    )}
                    style={{ height: PICKER_ROW_PX }}
                  >
                    <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md border border-[var(--line)] bg-[rgba(4,5,13,0.7)]">
                      {url ? <img src={url} alt="" draggable={false} className="max-h-full max-w-full object-contain" /> : <span className="text-[10px] text-faint">{url === null ? '—' : ''}</span>}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{e.name}</span>
                      <span className="block truncate text-[11px] text-faint">{e.dir || 'vault'}</span>
                    </span>
                    {onBoard.has(e.path) && <span className="chip !h-5 shrink-0">on the board</span>}
                    <span
                      className={cx('grid h-4 w-4 shrink-0 place-items-center rounded-full border', picked ? 'border-accent bg-accent text-white' : 'border-[rgba(140,160,255,0.3)]')}
                      aria-hidden
                    >
                      {picked && <Icon name="check" size={11} />}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--line)] px-3 py-2.5 text-[12px] text-dim">
          <span className="min-w-0 flex-1 truncate">
            {load.state === 'ready'
              ? `${plural(rows.length, 'picture')}${debounced.trim() ? ` of ${entries.length}` : ''}${load.cut > 0 ? ` (the newest ${entries.length}; search narrows them)` : ''} · Shift-click a run, ${isMac ? '⌘' : 'Ctrl'}-click to add one`
              : ''}
            {sel.capped ? ` · at most ${MAX_PICKER_ADD} at a time` : ''}
          </span>
          <button type="button" className="hud-btn" onClick={onClose}>
            Cancel <kbd>Esc</kbd>
          </button>
          <button type="button" className="hud-btn primary" disabled={chosen === 0 && rows.length === 0} onClick={add}>
            {chosen > 0 ? `Add ${chosen} to board` : 'Add to board'} <kbd>Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

function Message({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return <div className={cx('grid h-full min-h-[160px] place-items-center p-6 text-center text-[13px]', tone === 'error' ? 'text-danger' : 'text-dim')}>{children}</div>
}
