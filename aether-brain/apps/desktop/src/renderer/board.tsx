/**
 * The reference board's floating window (board.html): the board view alone, full window, over a host made of bridge calls
 * (board-host.ts). It is not the brain: it never imports main.tsx or the store's boot, never opens a vault, never lists notes
 * (that would restart main's watcher), and registers no panels or keys. The board to show is `?path=` (a vault path, set by main).
 */
import { StrictMode, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BoardView, ErrorBoundary, type BoardHost, type BoardTone } from '@aether/ui'
import '@aether/ui/styles.css'
import type { BoardStatusDto } from '../shared/ipc'
import { createFloatingBoardHost } from './board-host'

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
  const bridge = window.aether
  if (!bridge) {
    root.render(<Notice>The board window needs the Aether Brain desktop app: this page was opened outside it.</Notice>)
    return
  }
  const path = new URLSearchParams(window.location.search).get('path')
  if (!path) {
    root.render(<Notice>No board was named. Open a board from the Boards view in Aether Brain and pop it out.</Notice>)
    return
  }
  // The window controls are right from the first draw when the status is known; without it they fill in a moment later.
  const status: BoardStatusDto | undefined = await bridge.boardStatus().catch(() => undefined)
  const host = createFloatingBoardHost(bridge, path, { toast, ...(status ? { status } : {}) })
  root.render(
    <StrictMode>
      <ErrorBoundary what="the board" onClose={() => void bridge.boardClose().catch(() => undefined)}>
        <div className="relative h-full w-full">
          <BoardView host={host} className="h-full w-full" />
          <Toasts />
        </div>
      </ErrorBoundary>
    </StrictMode>,
  )
}

void boot()
