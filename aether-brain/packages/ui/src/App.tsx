import { useEffect, useMemo, useState } from 'react'
import { isFolderId, isImageId, isTodayId } from '@aether/core'
import { BrainScene } from '@aether/graph'
import { useAether, type AetherState } from './store'
import { useKeyboard } from './hooks/useKeyboard'
import { TopBar } from './components/TopBar'
import { Legend } from './components/Legend'
import { Inspector } from './components/Inspector'
import { Editor } from './components/Editor'
import { CommandPalette } from './components/CommandPalette'
import { Capture } from './components/Capture'
import { Review } from './components/Review'
import { ProjectsView } from './components/ProjectsView'
import { Help } from './components/Help'
import { Toasts } from './components/Toasts'
import { Welcome, type VaultSource } from './components/Welcome'
import { importPictureFiles } from './components/pictures'
import { cx } from './util'

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
 * the store (graph | editor | capture | search | review), not routes.
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
  const scene = useMemo(() => <BrainScene controller={controller} />, [controller])

  // Push the camera's focal point right while the editor covers the left half,
  // so the selected neuron and its neighborhood stay visible beside the text.
  useEffect(() => {
    controller.setViewShift(showEditor ? 0.3 : 0)
  }, [controller, showEditor])

  return (
    <div className="relative h-full w-full overflow-hidden bg-cosmos text-ink" data-view={view}>
      {scene}

      {/* HUD */}
      <div className="pointer-events-none absolute inset-0 flex flex-col p-3">
        <div className="pointer-events-auto">
          <TopBar onPickVault={onPickVault} />
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
            {showEditor && <Editor />}
          </div>
          <div className="min-w-0 flex-1" />
          {/* Right: inspector */}
          {status === 'ready' && selectedId && view !== 'projects' && (
            <div className="pointer-events-auto flex max-h-full items-start">
              <Inspector />
            </div>
          )}
        </div>
        <div className="pointer-events-auto mt-3 flex items-end justify-between gap-3">
          {status === 'ready' ? <Legend /> : <span />}
          <Hint />
        </div>
      </div>

      <CommandPalette />
      <Capture />
      <Review />
      <ProjectsView />
      <Help />
      <Toasts />
      <Welcome sources={sources} />
      <DropZone />
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
          <kbd>e</kbd> open in your image app · <kbd>Tab</kbd> neighbors · <kbd>f</kbd> fly · <kbd>Esc</kbd> deselect
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

/** Why dropped pictures can't be saved right now, or null when they can. */
function dropBlocker(s: AetherState): string | null {
  if (s.status !== 'ready' || !s.adapter) return 'Open a vault first to add pictures'
  if (s.adapter.readOnly) return 'This vault is read-only'
  if (!s.adapter.createAsset) return 'This vault can’t save pictures'
  return null
}

/** True when a drag carries files (not text or a link dragged inside the page). */
function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
}

/**
 * Picture files dropped anywhere on the window go into the vault
 * (`importImages`): into the selected folder, a selected project's Critique
 * planet, else Inbox; the overlay says which while the files hover. Every
 * file drag is taken, so a dropped file never navigates the window away.
 */
function DropZone() {
  /** What the overlay says; null while no files are dragged over the window. */
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

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
    const describe = () => {
      const s = useAether.getState()
      const blocker = dropBlocker(s)
      if (blocker) return { text: blocker, ok: false }
      const target = s.importTarget()
      return { text: `Drop pictures into ${target ? `${target}/` : 'the vault'}`, ok: true }
    }
    const enter = (e: DragEvent) => {
      if (inside || !hasFiles(e)) return
      e.preventDefault()
      if (depth++ === 0) setMessage(describe())
    }
    const over = (e: DragEvent) => {
      if (inside || !hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = dropBlocker(useAether.getState()) ? 'none' : 'copy'
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
      const blocker = dropBlocker(s)
      if (blocker) {
        s.toast(blocker, 'error')
        return
      }
      void importPictureFiles(Array.from(e.dataTransfer?.files ?? []))
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
          🖼
        </span>
        <span className={cx('text-[15px] font-semibold', message.ok ? 'text-white' : 'text-danger')}>{message.text}</span>
        {message.ok && <span className="text-[12px] text-dim">png · jpg · webp · gif · bmp · avif — never replaces a file (a taken name gets “ 2”)</span>}
      </div>
    </div>
  )
}
