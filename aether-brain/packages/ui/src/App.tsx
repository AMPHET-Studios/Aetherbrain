import { useEffect, useMemo, useState } from 'react'
import { imagePathOf, isFolderId, isImageId, isModelPath, isTodayId, isVideoPath } from '@aether/core'
import { BrainScene } from '@aether/graph'
import { FULL_PANEL_VIEWS, useAether, type AetherState } from './store'
import { useKeyboard } from './hooks/useKeyboard'
import { TopBar } from './components/TopBar'
import { Legend } from './components/Legend'
import { Inspector } from './components/Inspector'
import { Editor } from './components/Editor'
import { CommandPalette } from './components/CommandPalette'
import { Capture } from './components/Capture'
import { Review } from './components/Review'
import { ProjectsView } from './components/ProjectsView'
import { BoardsView } from './board/BoardsView'
import { Help } from './components/Help'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Toasts } from './components/Toasts'
import { Welcome, type VaultSource } from './components/Welcome'
import { importChatFiles, isChatExportFile, isChatExportType } from './components/chats'
import { importPictureFiles } from './components/pictures'
import { cx } from './util'

/** Back to the plain graph: what closing a crashed board or editor does. */
const toGraph = () => useAether.getState().setView('graph')

/** How often the Today brief checks whether the day turned (a brief left open overnight). */
const BRIEF_REFRESH_MS = 60_000

export interface AetherAppProps {
  /** Ways to open a vault, rendered on the welcome screen. */
  sources: VaultSource[]
  /** Called when the user clicks the vault name in the top bar. */
  onPickVault?: (() => void) | undefined
  /** Auto-open this source id on mount. */
  autoOpen?: string | undefined
}

/**
 * The whole app: the 3D thought-space fills the window; HUD chrome floats
 * over it; the editor slides in beside it. Views are a tiny state machine in
 * the store (graph | editor | capture | search | review | projects | boards), not routes.
 */
export function AetherApp({ sources, onPickVault, autoOpen }: AetherAppProps) {
  useKeyboard()
  const controller = useAether((s) => s.controller)
  const status = useAether((s) => s.status)
  const view = useAether((s) => s.view)
  const editorId = useAether((s) => s.editorId)
  const selectedId = useAether((s) => s.selectedId)
  const setFps = useAether((s) => s.setFps)

  useEffect(() => {
    if (!autoOpen) return
    const src = sources.find((s) => s.id === autoOpen)
    if (src && useAether.getState().status === 'idle') void src.open()
  }, [autoOpen, sources])

  // Flush unsaved edits when the window closes.
  useEffect(() => {
    const flush = () => void useAether.getState().saveDraft()
    const hidden = () => document.hidden && flush()
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', hidden)
    }
  }, [])

  // The Today brief follows the calendar: a new day (checked every minute, and whenever the window comes back) rebuilds it.
  useEffect(() => {
    const refresh = () => useAether.getState().refreshBrief()
    const timer = setInterval(refresh, BRIEF_REFRESH_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  // FPS meter (rAF-based, independent of the R3F loop).
  useEffect(() => {
    let frames = 0
    let last = performance.now()
    let raf = 0
    const tick = () => {
      frames++
      const now = performance.now()
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)))
        frames = 0
        last = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [setFps])

  const showEditor = view === 'editor' && !!editorId
  const scene = useMemo(
    () => (
      <ErrorBoundary what="the 3D view">
        <BrainScene controller={controller} />
      </ErrorBoundary>
    ),
    [controller],
  )

  // Push the camera's focal point right while the editor covers the left half,
  // so the selected neuron and its neighborhood stay visible beside the text.
  useEffect(() => {
    controller.setViewShift(showEditor ? 0.3 : 0)
  }, [controller, showEditor])

  // A full-window panel (the Boards view, the Projects board) hides the 3D view: stop drawing it while the panel is up. Driven by the
  // view alone, so a panel that crashes (the error boundary unmounts it), closes or gives way to a jump to a note always lets go.
  const coveredByPanel = FULL_PANEL_VIEWS.has(view)
  useEffect(() => {
    controller.setCovered(coveredByPanel)
    return () => controller.setCovered(false)
  }, [controller, coveredByPanel])

  return (
    <div className="relative h-full w-full overflow-hidden bg-cosmos text-ink" data-view={view}>
      {scene}

      {/* HUD */}
      <div className="pointer-events-none absolute inset-0 flex flex-col p-3">
        <div className="pointer-events-auto">
          <ErrorBoundary what="the top bar">
            <TopBar onPickVault={onPickVault} />
          </ErrorBoundary>
        </div>
        <div className="flex min-h-0 flex-1 items-stretch gap-3 pt-3">
          {/* Left: editor panel */}
          <div
            className={cx(
              'pointer-events-auto panel min-w-0 overflow-hidden transition-[width,opacity] duration-200',
              showEditor ? 'w-[58%] max-w-[980px] opacity-100' : 'w-0 opacity-0',
            )}
            aria-hidden={!showEditor}
          >
            {showEditor && (
              <ErrorBoundary what="the editor" onClose={toGraph}>
                <Editor />
              </ErrorBoundary>
            )}
          </div>
          <div className="min-w-0 flex-1" />
          {/* Right: inspector */}
          {status === 'ready' && selectedId && view !== 'projects' && view !== 'boards' && (
            <div className="pointer-events-auto flex max-h-full items-start">
              <ErrorBoundary what="the inspector" onClose={() => useAether.getState().select(null)}>
                <Inspector />
              </ErrorBoundary>
            </div>
          )}
        </div>
        <div className="pointer-events-auto mt-3 flex items-end justify-between gap-3">
          <ErrorBoundary what="the legend" quiet>
            {status === 'ready' ? <Legend /> : <span />}
          </ErrorBoundary>
          <ErrorBoundary what="the hint" quiet>
            <Hint />
          </ErrorBoundary>
        </div>
      </div>

      <ErrorBoundary what="the search" onClose={() => useAether.getState().setPalette(false)}>
        <CommandPalette />
      </ErrorBoundary>
      <ErrorBoundary what="quick capture" onClose={toGraph}>
        <Capture />
      </ErrorBoundary>
      <ErrorBoundary what="the review" onClose={toGraph}>
        <Review />
      </ErrorBoundary>
      <ErrorBoundary what="the Projects board" onClose={toGraph}>
        <ProjectsView />
      </ErrorBoundary>
      <ErrorBoundary what="the Boards view" onClose={toGraph}>
        <BoardsView />
      </ErrorBoundary>
      <ErrorBoundary what="the shortcuts list" onClose={() => useAether.getState().setHelp(false)}>
        <Help />
      </ErrorBoundary>
      <ErrorBoundary what="the messages" quiet>
        <Toasts />
      </ErrorBoundary>
      <ErrorBoundary what="the welcome screen">
        <Welcome sources={sources} />
      </ErrorBoundary>
      <ErrorBoundary what="the drop zone" quiet>
        <DropZone />
      </ErrorBoundary>
    </div>
  )
}

function Hint() {
  const selectedId = useAether((s) => s.selectedId)
  const hovered = useAether((s) => s.hoveredId)
  const notes = useAether((s) => s.notes)
  const graph = useAether((s) => s.graph)
  const status = useAether((s) => s.status)
  if (status !== 'ready') return null
  const node = hovered && hovered !== selectedId ? graph?.nodes[graph.index.get(hovered) ?? -1] : undefined
  const h = node ? (node.kind === 'note' ? (notes.get(node.id)?.meta.title ?? node.title) : node.title) : null
  return (
    <div className="panel px-3 py-2 text-[11.5px] text-dim">
      {h && node?.kind === 'folder' ? (
        <span>
          <span className="text-ink">
            {node.folder?.role === 'project' ? '★ ' : ''}
            {h}
          </span>{' '}
          · {node.folder?.totalNotes ?? 0} notes · click to select · double-click to expand
        </span>
      ) : node?.kind === 'today' ? (
        <span>
          <span className="text-ink">☀ Today</span> · {node.today?.total ?? 0} to do
          {node.today?.overdue ? ` · ${node.today.overdue} late` : ''} · click for the brief
        </span>
      ) : h && node?.kind === 'image' ? (
        <span>
          <span className="text-ink">🖼 {h}</span> · click to select · double-click to open
        </span>
      ) : h ? (
        <span>
          <span className="text-ink">{h}</span> · click to select · double-click to {node?.kind === 'ghost' ? 'create' : 'open'}
        </span>
      ) : selectedId && isFolderId(selectedId) ? (
        <span>
          <kbd>x</kbd> expand · <kbd>Tab</kbd> planets · <kbd>f</kbd> fly · <kbd>[</kbd> <kbd>]</kbd> depth · <kbd>Esc</kbd> deselect
        </span>
      ) : selectedId && isTodayId(selectedId) ? (
        <span>
          <kbd>Tab</kbd> tasks · <kbd>Space</kbd> tick the focused task · <kbd>u</kbd> undo · <kbd>y</kbd> Today · <kbd>Esc</kbd> deselect
        </span>
      ) : selectedId && isImageId(selectedId) ? (
        <span>
          <kbd>e</kbd>{' '}
          {isVideoPath(imagePathOf(selectedId)) ? 'play in your video player' : isModelPath(imagePathOf(selectedId)) ? 'open in your 3D app' : 'open in your image app'} · <kbd>Tab</kbd> neighbors · <kbd>f</kbd> fly · <kbd>Esc</kbd> deselect
        </span>
      ) : selectedId ? (
        <span>
          <kbd>e</kbd> open · <kbd>Tab</kbd> neighbors · <kbd>f</kbd> fly · <kbd>Esc</kbd> deselect
        </span>
      ) : (
        <span>
          drag to orbit · scroll to zoom · <kbd>y</kbd> today · <kbd>?</kbd> keys · <kbd>/</kbd> search
        </span>
      )}
    </div>
  )
}

/** Why dropped pictures (or, with `chats`, AI chat exports) can't be saved right now, or null when they can. */
function dropBlocker(s: AetherState, chats = false): string | null {
  if (s.status !== 'ready' || !s.adapter) return chats ? 'Open a vault first to import your chats' : 'Open a vault first to add pictures'
  if (s.adapter.readOnly) return 'This vault is read-only'
  if (!chats && !s.adapter.createAsset) return 'This vault can’t save pictures'
  return null
}

/**
 * A board open in the Boards view takes the files dropped on it itself (into its own folder, at the drop point); the window's drop
 * zone then neither shows its overlay nor imports them, but still holds the drop so a file dropped beside the board never navigates
 * the window to it.
 */
function boardTakesDrops(s: AetherState): boolean {
  return s.view === 'boards' && s.boardPath !== null
}

/** True when a drag carries files (not text or a link dragged inside the page). */
function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
}

/** True when a drag carries a zip or JSON file (a Claude / ChatGPT export); names are only known at the drop. */
function draggingChats(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === 'file' && isChatExportType(i.type))
}

/**
 * Picture files dropped anywhere on the window go into the vault
 * (`importImages`): into the selected folder, a selected project's Critique
 * planet, else Inbox; the overlay says which while the files hover. Every
 * file drag is taken, so a dropped file never navigates the window away.
 */
export function DropZone() {
  /** What the overlay says; null while no files are dragged over the window. */
  const [message, setMessage] = useState<{ text: string; ok: boolean; chats: boolean } | null>(null)

  useEffect(() => {
    // dragenter / dragleave fire for every element crossed: count them to know when the drag left the window.
    let depth = 0
    // A drag that started in the page (a picture in a preview carries "Files" in Chromium) is no import.
    let inside = false
    const start = () => {
      inside = true
    }
    const end = () => {
      inside = false
    }
    const describe = (chats: boolean) => {
      const s = useAether.getState()
      const blocker = dropBlocker(s, chats)
      if (blocker) return { text: blocker, ok: false, chats }
      if (chats) {
        const base = s.chatImportBase()
        return { text: `Drop your Claude / ChatGPT export to import the chats into ${base ? `${base}/` : 'the vault'}`, ok: true, chats }
      }
      const target = s.importTarget()
      return { text: `Drop pictures into ${target ? `${target}/` : 'the vault'}`, ok: true, chats }
    }
    const enter = (e: DragEvent) => {
      if (inside || !hasFiles(e)) return
      e.preventDefault()
      if (boardTakesDrops(useAether.getState())) return
      if (depth++ === 0) setMessage(describe(draggingChats(e)))
    }
    const over = (e: DragEvent) => {
      if (inside || !hasFiles(e)) return
      e.preventDefault()
      if (boardTakesDrops(useAether.getState())) {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
        return
      }
      if (e.dataTransfer) e.dataTransfer.dropEffect = dropBlocker(useAether.getState(), draggingChats(e)) ? 'none' : 'copy'
    }
    const leave = (e: DragEvent) => {
      if (inside || !hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setMessage(null)
    }
    const drop = (e: DragEvent) => {
      if (inside || !hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setMessage(null)
      const s = useAether.getState()
      if (boardTakesDrops(s)) return
      const files = Array.from(e.dataTransfer?.files ?? [])
      // Chat exports (.zip, .json) are imported as chats; everything else is taken as pictures.
      const chats = files.filter((f) => isChatExportFile(f.name))
      const rest = files.filter((f) => !isChatExportFile(f.name))
      if (chats.length) {
        const blocker = dropBlocker(s, true)
        if (blocker) s.toast(blocker, 'error')
        else void importChatFiles(chats)
      }
      if (rest.length) {
        const blocker = dropBlocker(s)
        if (blocker) s.toast(blocker, 'error')
        else void importPictureFiles(rest)
      }
    }
    window.addEventListener('dragstart', start)
    window.addEventListener('dragend', end)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragstart', start)
      window.removeEventListener('dragend', end)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  if (!message) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-[60] grid place-items-center bg-black/45 p-6" aria-live="polite">
      <div className={cx('panel drop-frame rise flex flex-col items-center gap-2 px-10 py-8 text-center', !message.ok && 'blocked')}>
        <span className="text-[34px] leading-none" aria-hidden>
          {message.chats ? '💬' : '🖼'}
        </span>
        <span className={cx('text-[15px] font-semibold', message.ok ? 'text-white' : 'text-danger')}>{message.text}</span>
        {message.ok && (
          <span className="text-[12px] text-dim">
            {message.chats
              ? 'the .zip from Claude or ChatGPT, or its conversations.json — plain markdown notes, nothing overwritten'
              : 'png · jpg · webp · gif · bmp · avif — never replaces a file (a taken name gets “ 2”)'}
          </span>
        )}
      </div>
    </div>
  )
}
