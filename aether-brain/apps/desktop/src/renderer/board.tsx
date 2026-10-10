/**
 * The reference board's floating window (board.html): the board view alone, full window, over a host made of bridge calls
 * (board-host.ts). It is not the brain: it never imports main.tsx or the store's boot, never opens a vault, never lists notes
 * (that would restart main's watcher), and registers no panels. Its bridge is the board preload's (BoardBridge: the board, the
 * pictures, nothing else). The board to show is `?path=` (a vault path, set by main).
 *
 * Three things main needs of this page besides the board: `board:flush` (main is about to close the window, the app, or move it
 * to another board: save what is not saved, then answer `boardFlushed`), `board:gone` (the note was deleted, renamed away or edited
 * so that it is no board: a banner that stays), and the key `w` (bring the board back to the app, as the brain window's `w` does).
 */
import { StrictMode, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
// The pieces themselves, not '@aether/ui': its index is the whole brain (store, 3D scene, editor), and importing it would load and
// keep ~2 MB of script in a window that sits over the user's painting program and only ever draws a board.
import { BoardView } from '../../../../packages/ui/src/board/BoardView'
import { getActiveBoard } from '../../../../packages/ui/src/board/active'
import type { BoardHost, BoardTone } from '../../../../packages/ui/src/board/api'
import { ErrorBoundary } from '../../../../packages/ui/src/components/ErrorBoundary'
import '@aether/ui/styles.css'
import type { BoardBridge, BoardStatusDto } from '../shared/ipc'
import { createFloatingBoardHost } from './board-host'
import { isBringBackKey } from './board-keys'

/* ------------------------------------------------------------------ */
/* Toasts: the host's way to say something in this window             */
/* ------------------------------------------------------------------ */

interface ToastItem {
  id: number
  text: string
  tone: BoardTone
  action?: { label: string; run(): void }
}

let toasts: ToastItem[] = []
let toastSeq = 0
const toastSubs = new Set<() => void>()

function setToasts(next: ToastItem[]): void {
  toasts = next
  for (const cb of toastSubs) cb()
}

const toast: BoardHost['toast'] = (text, tone = 'info', action) => {
  const id = ++toastSeq
  setToasts([...toasts.slice(-3), { id, text, tone, ...(action ? { action } : {}) }])
  // A toast with a button stays longer: there is something to press.
  setTimeout(() => setToasts(toasts.filter((t) => t.id !== id)), action ? 8000 : 4000)
}

/* ------------------------------------------------------------------ */
/* The note is gone: a banner that stays                              */
/* ------------------------------------------------------------------ */

let goneText: string | null = null
const goneSubs = new Set<() => void>()

function setGone(why: string | null): void {
  goneText = why
  for (const cb of goneSubs) cb()
}

function GoneBanner({ onClose }: { onClose(): void }) {
  const why = useSyncExternalStore(
    (cb) => {
      goneSubs.add(cb)
      return () => void goneSubs.delete(cb)
    },
    () => goneText,
  )
  if (why === null) return null
  return (
    <div className="panel pointer-events-auto absolute left-3 right-3 top-3 z-[45] flex items-center gap-3 px-3 py-2 text-[12px] text-danger" role="alert">
      <span className="break-words">{why}</span>
      <button type="button" className="hud-btn shrink-0" onClick={onClose}>
        Bring it back
      </button>
    </div>
  )
}

/** The key `w`, as in the brain window: bring the board back. A text box, an open menu or a dialog keeps its own keys. */
function bringBackOnW(bridge: BoardBridge): void {
  window.addEventListener('keydown', (e) => {
    if (!isBringBackKey(e, document.querySelector('[data-board-overlay], [role="dialog"]') !== null)) return
    e.preventDefault()
    const board = getActiveBoard()
    if (board) board.exec('window.dock')
    else void bridge.boardClose().catch(() => undefined)
  })
}

function Toasts() {
  const list = useSyncExternalStore(
    (cb) => {
      toastSubs.add(cb)
      return () => void toastSubs.delete(cb)
    },
    () => toasts,
  )
  if (!list.length) return null
  return (
    <div className="pointer-events-none fixed bottom-3 left-1/2 z-[40] flex -translate-x-1/2 flex-col items-center gap-2" role="status">
      {list.map((t) => (
        <div
          key={t.id}
          className={`panel rise pointer-events-auto flex max-w-[90vw] items-center gap-3 px-3 py-1.5 text-[12px] ${t.tone === 'error' ? 'text-danger' : 'text-ink'}`}
        >
          <span className="break-words">{t.text}</span>
          {t.action && (
            <button type="button" className="hud-btn" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */

function Notice({ children }: { children: ReactNode }) {
  return <div className="grid h-full place-items-center p-6 text-center text-[13px] leading-relaxed text-dim">{children}</div>
}

async function boot(): Promise<void> {
  const root = createRoot(document.getElementById('root')!)
  // The board preload's bridge, a part of the brain window's (the type says what is really there).
  const bridge = window.aether as BoardBridge | undefined
  if (!bridge) {
    root.render(<Notice>The board window needs the Aether Brain desktop app: this page was opened outside it.</Notice>)
    return
  }
  const path = new URLSearchParams(window.location.search).get('path')
  if (!path) {
    root.render(<Notice>No board was named. Open a board from the Boards view in Aether Brain and pop it out.</Notice>)
    return
  }
  // Main asks this page to save before it closes the window (or the app, or moves the window to another board): everything not
  // saved is written, a note being typed included, and only then is the ask answered. Registered before anything else, so that no
  // close finds a page that has nothing to say; a failed save does not hold the close (the board keeps a copy of what it could not write).
  bridge.onBoardFlush((token) => {
    void (async () => {
      try {
        await getActiveBoard()?.flush()
      } catch {
        /* the close goes on */
      } finally {
        bridge.boardFlushed(token)
      }
    })()
  })
  bridge.onBoardGone(setGone)
  bringBackOnW(bridge)
  // The window controls are right from the first draw when the status is known; without it they fill in a moment later.
  const status: BoardStatusDto | undefined = await bridge.boardStatus().catch(() => undefined)
  const host = createFloatingBoardHost(bridge, path, { toast, ...(status ? { status } : {}) })
  root.render(
    <StrictMode>
      <ErrorBoundary what="the board" onClose={() => void bridge.boardClose().catch(() => undefined)}>
        <div className="relative h-full w-full">
          <BoardView host={host} className="h-full w-full" />
          <GoneBanner onClose={() => void bridge.boardClose().catch(() => undefined)} />
          <Toasts />
        </div>
      </ErrorBoundary>
    </StrictMode>,
  )
}

void boot()
