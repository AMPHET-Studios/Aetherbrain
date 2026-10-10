import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { basenameOf, idFromPath, type ParsedNote } from '@aether/core'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { useAether } from '../store'
import { cx, isTyping, plural, relativeTime, truncate } from '../util'
import { getActiveBoard, getBoardWindowControl, subscribeBoardWindowControl, type BoardWindowControl, type BoardWindowStatus } from './active'
import { BoardView } from './BoardView'
import { PreviewUrls, listBoards, samePath, summarizeBoard, type BoardSummary } from './boardRegistry'
import { createDockedBoardHost } from './dockedHost'

/*
 * The Boards view: the list of the vault's boards (cards with a collage of their pictures, a "New board" card) and, once one is
 * opened, the board itself over the docked host. A wrapper that draws nothing and does no work while the view is closed (the
 * Projects board's pattern); a list drawn a page at a time with its pictures loaded only for the cards in view; nothing here
 * holds a picture longer than a card is on screen (and a few more, for a quick scroll back).
 */

/** Cards drawn at first, and added by each "Show more". */
export const CARDS_FIRST = 24
export const CARDS_MORE = 24
/** The most cards ever drawn: past it the search box is how to reach a board (the rest are in the vault). */
export const CARDS_MAX = 1000
/** Longest title drawn on a card. */
const MAX_TITLE_CHARS = 120

/* -------------------------------------------------------------- wrapper --- */

/** What was typed on the list lives here, so closing the view keeps a half-typed board name and the search. */
function useDrafts() {
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [query, setQuery] = useState('')
  return { creating, setCreating, newTitle, setNewTitle, query, setQuery }
}
type Drafts = ReturnType<typeof useDrafts>

export function BoardsView() {
  // Nothing of the view exists, and none of its work is done, while it is closed.
  const open = useAether((s) => s.view === 'boards')
  const drafts = useDrafts()
  return open ? <BoardsBody drafts={drafts} /> : null
}

function BoardsBody({ drafts }: { drafts: Drafts }) {
  const boardPath = useAether((s) => s.boardPath)
  return boardPath ? <OpenBoard path={boardPath} /> : <BoardList drafts={drafts} />
}

/* ------------------------------------------------------------- the window --- */

/** The floating window's control (null on the web) and its state, followed as they change. */
function useWindowControl(): { control: BoardWindowControl | null; status: BoardWindowStatus | null } {
  const control = useSyncExternalStore(subscribeBoardWindowControl, getBoardWindowControl, getBoardWindowControl)
  const subscribe = useCallback((cb: () => void) => (control ? control.subscribe(cb) : () => undefined), [control])
  // React needs the same object for the same state (a snapshot that is new on every read loops forever): a control that makes a new
  // object each time it is asked still gets one object per state here.
  const last = useRef<BoardWindowStatus | null>(null)
  const read = useCallback((): BoardWindowStatus | null => {
    if (!control?.available) return null
    const next = control.status()
    const was = last.current
    if (was && was.open === next.open && was.path === next.path && was.alwaysOnTop === next.alwaysOnTop && was.opacity === next.opacity && was.supportsOpacity === next.supportsOpacity) return was
    last.current = next
    return next
  }, [control])
  const status = useSyncExternalStore(subscribe, read, read)
  return { control: control?.available ? control : null, status }
}

/* ---------------------------------------------------------------- icons --- */

/** The mark of a board: a frame with pictures in it. */
function BoardGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <rect x="6.5" y="7.5" width="6" height="5" rx="1" />
      <rect x="14" y="7.5" width="3.5" height="3" rx="0.8" />
      <rect x="14" y="12.5" width="3.5" height="4" rx="0.8" />
      <rect x="6.5" y="14" width="6" height="2.5" rx="0.8" />
    </svg>
  )
}

/* ----------------------------------------------------------- the list --- */

/** True while `ref` is on screen (or near it); true from the start where the page cannot tell. */
function useInView(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const watcher = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setSeen(e.isIntersecting)
      },
      { rootMargin: '240px' },
    )
    watcher.observe(el)
    return () => watcher.disconnect()
  }, [ref])
  return seen
}

/** The collage's picture URLs while the card is in view; none (and nothing held) once it is not. */
function useCollage(previews: PreviewUrls, paths: readonly string[], active: boolean): (string | null)[] {
  const [urls, setUrls] = useState<(string | null)[]>([])
  const key = paths.join('\n')
  useEffect(() => {
    if (!active || paths.length === 0) {
      setUrls([])
      return
    }
    let live = true
    const got: (string | null)[] = paths.map(() => null)
    for (const [i, p] of paths.entries()) {
      void previews.acquire(p).then((url) => {
        if (!live || url === null) return
        got[i] = url
        setUrls([...got])
      })
    }
    return () => {
      live = false
      for (const p of paths) previews.release(p)
    }
    // `key` stands for `paths`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previews, key, active])
  return urls
}

function Collage({ urls, count }: { urls: (string | null)[]; count: number }) {
  const shown = urls.filter((u): u is string => u !== null)
  if (shown.length === 0) {
    return (
      <div className="grid h-full w-full place-items-center bg-[linear-gradient(135deg,rgba(143,124,255,0.10),rgba(77,226,255,0.05))]">
        <BoardGlyph className="text-[34px] text-faint" />
        <span className="sr-only">{count === 0 ? 'Empty board' : 'Loading pictures'}</span>
      </div>
    )
  }
  const cols = shown.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
  const rows = shown.length <= 2 ? 'grid-rows-1' : 'grid-rows-2'
  return (
    <div className={cx('grid h-full w-full gap-px bg-black/50', cols, rows)}>
      {shown.map((u) => (
        <img key={u} src={u} alt="" className="h-full w-full min-h-0 min-w-0 object-cover" draggable={false} decoding="async" />
      ))}
    </div>
  )
}

const BoardCard = memo(function BoardCard({ note, previews, canPopOut, onOpen, onEdit, onPopOut }: {
  note: ParsedNote
  previews: PreviewUrls
  canPopOut: boolean
  onOpen: (path: string) => void
  onEdit: (id: string) => void
  onPopOut: (path: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref)
  // Parsed once per version of the note's text (and only for the cards drawn).
  const summary: BoardSummary = useMemo(() => summarizeBoard(note.meta.path, note.raw), [note.meta.path, note.raw])
  const urls = useCollage(previews, summary.first, inView)
  const title = truncate(note.meta.title, MAX_TITLE_CHARS)
  const facts = [plural(summary.pictures, 'picture'), summary.notes > 0 ? plural(summary.notes, 'note') : '', summary.marks > 0 ? plural(summary.marks, 'mark') : ''].filter(Boolean)
  return (
    <div ref={ref} className="group relative flex flex-col overflow-hidden rounded-xl border border-[var(--panel-border)] bg-[rgba(140,160,255,0.04)] transition-colors hover:border-[rgba(143,124,255,0.5)] hover:bg-[rgba(140,160,255,0.08)]">
      <button type="button" className="flex flex-col text-left" onClick={() => onOpen(note.meta.path)} title={`Open ${title}`} aria-label={`Open the board ${title}`}>
        <div className="aspect-[16/10] w-full overflow-hidden border-b border-[var(--line)] bg-black/40">
          <Collage urls={urls} count={summary.pictures} />
        </div>
        <div className="min-w-0 px-3 pb-2.5 pt-2">
          <div className="truncate text-[13.5px] font-semibold text-white">{title}</div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-dim">
            <span>{facts.join(' · ')}</span>
            {note.meta.updated && <span className="text-faint">{relativeTime(note.meta.updated)}</span>}
          </div>
        </div>
      </button>
      <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {canPopOut && (
          <button type="button" className="hud-btn !h-6 !bg-black/60 !px-1.5 !text-[11px]" onClick={() => onPopOut(note.meta.path)} title="Open in its own window, on top of other windows" aria-label={`Open ${title} in its own window`}>
            ⧉
          </button>
        )}
        <button type="button" className="hud-btn !h-6 !bg-black/60 !px-1.5 !text-[11px]" onClick={() => onEdit(note.meta.id)} title="Edit the note's text (the lines under “Board” are the board)" aria-label={`Edit the note ${title}`}>
          ✎
        </button>
      </div>
    </div>
  )
})

/** The names a search box matches: the title and the file name. */
const matches = (note: ParsedNote, q: string): boolean => note.meta.title.toLowerCase().includes(q) || note.meta.path.toLowerCase().includes(q)

function BoardList({ drafts }: { drafts: Drafts }) {
  const { creating, setCreating, newTitle, setNewTitle, query, setQuery } = drafts
  const notes = useAether((s) => s.notes)
  const readOnly = useAether((s) => !s.adapter || s.adapter.readOnly)
  const formRequest = useAether((s) => s.formRequest)
  const requestForm = useAether((s) => s.requestForm)
  const setView = useAether((s) => s.setView)
  const { control } = useWindowControl()
  const boards = useMemo(() => listBoards(notes), [notes])
  const q = query.trim().toLowerCase()
  const found = useMemo(() => (q ? boards.filter((b) => matches(b, q)) : boards), [boards, q])
  const [shown, setShown] = useState(CARDS_FIRST)
  const cap = Math.min(CARDS_MAX, found.length)
  const drawn = Math.min(shown, cap)
  // Previews are made here and given up with the list (the cards hold them only while they are on screen).
  const previews = useMemo(() => new PreviewUrls((p, px) => useAether.getState().preview(p, px)), [])
  useEffect(() => () => previews.dispose(), [previews])
  useEffect(() => setShown(CARDS_FIRST), [q])

  // A command asked for the new-board form (Boards: new board).
  useEffect(() => {
    if (formRequest !== 'board') return
    requestForm(null)
    if (readOnly) useAether.getState().toast('This vault is read-only', 'error')
    else setCreating(true)
  }, [formRequest, readOnly, requestForm, setCreating])

  // n opens the new-board form; the other keys are the page's (Tab walks the cards, Enter opens one, Esc closes the view).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTyping(e)) return
      if (useAether.getState().paletteOpen || useAether.getState().helpOpen) return
      e.preventDefault()
      e.stopPropagation()
      if (!readOnly) setCreating(true)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [readOnly, setCreating])

  const [busy, setBusy] = useState(false)
  const create = async () => {
    if (busy) return
    setBusy(true)
    try {
      const path = await useAether.getState().newBoard(newTitle)
      if (path) {
        setCreating(false)
        setNewTitle('')
      }
    } finally {
      setBusy(false)
    }
  }

  const open = useCallback((path: string) => useAether.getState().openBoard(path), [])
  const edit = useCallback((id: string) => useAether.getState().openNote(id, { fly: false, view: 'editor' }), [])
  const popOut = useCallback((path: string) => void getBoardWindowControl()?.popOut(path), [])
  const none = boards.length === 0

  return (
    <div className="absolute inset-0 z-30 flex items-stretch justify-center bg-black/30 p-3 pt-16" onMouseDown={(e) => e.target === e.currentTarget && setView('graph')} role="dialog" aria-label="Boards">
      <div className="panel panel-solid rise flex w-full max-w-[1180px] flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
          <BoardGlyph className="text-[18px] text-accent2" />
          <span className="text-[13px] font-semibold text-white">Boards</span>
          <span className="text-[11.5px] text-faint">{plural(boards.length, 'board')}</span>
          <span className="flex-1" />
          {!none && (
            <input
              type="search"
              className="input !w-56 !py-1 !text-[12.5px]"
              placeholder="Find a board"
              aria-label="Find a board"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                e.stopPropagation()
                if (query) setQuery('')
                else e.currentTarget.blur()
              }}
            />
          )}
          <button type="button" className="hud-btn primary" onClick={() => setCreating(true)} disabled={readOnly} title="Make a new board (n)">
            ＋ New board <kbd className="!text-white/80">n</kbd>
          </button>
          <button type="button" className="hud-btn" onClick={() => setView('graph')} title="Close (Esc)">
            ✕
          </button>
        </div>

        {creating && (
          <form
            className="flex items-center gap-2 border-b border-[var(--line)] bg-[rgba(143,124,255,0.06)] px-4 py-2.5"
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <input
              className="input !py-1.5"
              autoFocus
              placeholder="Name the board, e.g. Gate reference"
              aria-label="Name of the new board"
              maxLength={120}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setCreating(false))}
            />
            <button type="submit" className="hud-btn primary" disabled={busy}>
              Make the board
            </button>
            <button type="button" className="hud-btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </form>
        )}

        {none ? (
          <EmptyBoards readOnly={readOnly} onNew={() => setCreating(true)} />
        ) : (
          <div className="scroll min-h-0 flex-1 p-4">
            {found.length === 0 ? (
              <div className="py-16 text-center text-[13px] text-dim">
                No board matches “{truncate(query.trim(), 60)}”.{' '}
                <button type="button" className="text-accent2 hover:underline" onClick={() => setQuery('')}>
                  Show all
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
                {!q && !creating && !readOnly && (
                  <button
                    type="button"
                    className="flex min-h-[170px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[rgba(140,160,255,0.3)] text-dim transition-colors hover:border-[rgba(143,124,255,0.7)] hover:text-white"
                    onClick={() => setCreating(true)}
                  >
                    <span className="text-[28px] leading-none">＋</span>
                    <span className="text-[12.5px] font-medium">New board</span>
                  </button>
                )}
                {found.slice(0, drawn).map((n) => (
                  <BoardCard key={n.meta.path} note={n} previews={previews} canPopOut={!!control} onOpen={open} onEdit={edit} onPopOut={popOut} />
                ))}
              </div>
            )}
            {found.length > drawn && (
              <div className="mt-4 flex items-center justify-center gap-3 text-[12px] text-faint">
                {drawn < cap ? (
                  <button type="button" className="hud-btn" onClick={() => setShown((n) => Math.min(CARDS_MAX, n + CARDS_MORE))}>
                    Show {Math.min(CARDS_MORE, cap - drawn)} more
                  </button>
                ) : (
                  <span>The first {CARDS_MAX.toLocaleString('en-US')} boards are shown: search to find the others.</span>
                )}
                <span>{plural(found.length - drawn, 'board')} not shown</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyBoards({ readOnly, onNew }: { readOnly: boolean; onNew: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-14 text-center">
      <BoardGlyph className="text-[46px] text-accent2" />
      <div className="text-[17px] font-semibold text-white">Keep your references in one place</div>
      <p className="max-w-[480px] text-[13px] leading-relaxed text-dim">
        A board is an open canvas for pictures, notes and sketches. Drop in images, paste screenshots, arrange them, grey them for value studies, pick colours, and
        keep the board in a window that floats over your painting program.
      </p>
      <p className="max-w-[480px] text-[12px] leading-relaxed text-faint">
        A board is an ordinary note in your vault (<span className="font-mono">Boards/…md</span>), so nothing is locked in: it is searchable, linked to its pictures, and
        yours to keep.
      </p>
      <button type="button" className="hud-btn primary mt-1" onClick={onNew} disabled={readOnly}>
        ＋ New board <kbd className="!text-white/80">n</kbd>
      </button>
      <p className="text-[11.5px] text-faint">
        Then drop pictures on it, paste with <kbd>Ctrl V</kbd>, or use <span className="text-dim">Add to board</span> in a picture’s inspector.
      </p>
    </div>
  )
}

/* -------------------------------------------------------- one open board --- */

/** Bumped when the floating window gives this board back, so the view loads the note again. */
function useReturned(control: BoardWindowControl | null, path: string): number {
  const [n, setN] = useState(0)
  useEffect(() => control?.onReturned((back) => samePath(back, path) && setN((x) => x + 1)), [control, path])
  return n
}

function OpenBoard({ path }: { path: string }) {
  const id = idFromPath(path)
  const found = useAether((s) => s.notes.get(id))
  const closeBoard = useAether((s) => s.closeBoard)
  const setView = useAether((s) => s.setView)
  const { control, status } = useWindowControl()
  const out = !!control && !!status && status.open && status.path !== null && samePath(status.path, path)
  const returned = useReturned(control, path)

  // popOut saves what the view holds before the window opens on the note.
  useEffect(() => control?.setFlush(() => getActiveBoard()?.flush()), [control])

  // The note went (deleted or moved by a sync tool, git, another program): the board is NOT closed - whatever it holds and has not
  // saved is the only copy - it stays up, says so once, and its saves are refused (with "Copy board text" to keep it). The title and
  // the path are the ones the note had.
  const was = useRef({ title: basenameOf(path), path })
  if (found) was.current = { title: found.meta.title, path: found.meta.path }
  const gone = !found
  useEffect(() => {
    if (!gone) return
    useAether.getState().toast(`The note of the board “${truncate(was.current.title, 60)}” was deleted or moved outside the app. The board is kept here.`, 'error')
  }, [gone])
  const note = { meta: was.current }

  return (
    <div className="absolute inset-0 z-30 flex items-stretch bg-black/30 p-3 pt-16" role="dialog" aria-label={`Board ${truncate(note.meta.title, MAX_TITLE_CHARS)}`}>
      <div className="panel panel-solid rise flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-1.5">
          <button type="button" className="hud-btn !h-7" onClick={closeBoard} title="All boards (8)">
            ← Boards <kbd>8</kbd>
          </button>
          <span className="text-faint" aria-hidden>
            ›
          </span>
          <BoardGlyph className="shrink-0 text-[15px] text-accent2" />
          <span className="min-w-0 truncate text-[13px] font-semibold text-white">{truncate(note.meta.title, MAX_TITLE_CHARS)}</span>
          <span className="hidden min-w-0 truncate font-mono text-[10.5px] text-faint md:inline">{truncate(note.meta.path, 160)}</span>
          <span className="flex-1" />
          <button type="button" className="hud-btn !h-7" onClick={() => setView('graph')} title="Close the Boards view (Esc)">
            ✕ <kbd>Esc</kbd>
          </button>
        </div>
        {gone && (
          <div className="border-b border-[var(--line)] bg-[rgba(255,62,108,0.1)] px-4 py-1.5 text-[12px] text-danger" role="status">
            This board’s note was deleted or moved outside the app. It stays open here, but changes cannot be saved until the note is back (a refused save offers “Copy board text”).
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {out && control && status ? (
            <PoppedOut control={control} status={status} title={note.meta.title} />
          ) : (
            <ErrorBoundary what="the board" onClose={closeBoard}>
              <BoardSurface key={`${path}\n${returned}`} path={path} />
            </ErrorBoundary>
          )}
        </div>
      </div>
    </div>
  )
}

/** The board over its docked host; the host lives as long as this mounts (a new one for a board that comes back from its window). */
function BoardSurface({ path }: { path: string }) {
  const [host] = useState(() => createDockedBoardHost(path))
  useEffect(() => () => host.dispose(), [host])
  return <BoardView host={host} className="absolute inset-0" />
}

/* --------------------------------------------- the board is in its window --- */

const OPACITY_STEP = 0.1

function PoppedOut({ control, status, title }: { control: BoardWindowControl; status: BoardWindowStatus; title: string }) {
  const percent = Math.round(status.opacity * 100)
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex max-w-[460px] flex-col items-center gap-3 rounded-xl border border-[var(--panel-border)] bg-[rgba(140,160,255,0.05)] px-8 py-8 text-center">
        <span className="text-[34px] leading-none text-accent2" aria-hidden>
          ⧉
        </span>
        <div className="text-[16px] font-semibold text-white">This board is open in its window</div>
        <p className="text-[12.5px] leading-relaxed text-dim">
          <span className="text-ink">{truncate(title, 80)}</span> is on top of your other windows. It saves as you work. Bring it back to see it here again.
        </p>
        <button type="button" className="hud-btn primary" onClick={() => void control.dock()} autoFocus>
          Bring it back
        </button>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2 text-[12px]">
          <button type="button" className="hud-btn" aria-pressed={status.alwaysOnTop} onClick={() => void control.setAlwaysOnTop(!status.alwaysOnTop)} title="Keep the window above other windows">
            {status.alwaysOnTop ? 'Stays on top' : 'Not on top'}
          </button>
          {status.supportsOpacity && (
            <span className="inline-flex items-center gap-1 text-dim" role="group" aria-label="Window opacity">
              <button type="button" className="hud-btn !px-2" onClick={() => void control.setOpacity(Math.max(0.2, status.opacity - OPACITY_STEP))} disabled={status.opacity <= 0.2} aria-label="More see-through">
                −
              </button>
              <span className="w-12 text-center tabular-nums text-ink">{percent}%</span>
              <button type="button" className="hud-btn !px-2" onClick={() => void control.setOpacity(Math.min(1, status.opacity + OPACITY_STEP))} disabled={status.opacity >= 1} aria-label="More solid">
                +
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
