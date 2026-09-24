import { useEffect, useMemo } from 'react'
import { BrainScene } from '@aether/graph'
import { useAether } from './store'
import { useKeyboard } from './hooks/useKeyboard'
import { TopBar } from './components/TopBar'
import { Legend } from './components/Legend'
import { Inspector } from './components/Inspector'
import { Editor } from './components/Editor'
import { CommandPalette } from './components/CommandPalette'
import { Capture } from './components/Capture'
import { Review } from './components/Review'
import { Help } from './components/Help'
import { Toasts } from './components/Toasts'
import { Welcome, type VaultSource } from './components/Welcome'
import { cx } from './util'

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
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', () => document.hidden && flush())
    return () => window.removeEventListener('beforeunload', flush)
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
          {status === 'ready' && selectedId && (
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
      <Help />
      <Toasts />
      <Welcome sources={sources} />
    </div>
  )
}

function Hint() {
  const selectedId = useAether((s) => s.selectedId)
  const hovered = useAether((s) => s.hoveredId)
  const notes = useAether((s) => s.notes)
  const status = useAether((s) => s.status)
  if (status !== 'ready') return null
  const h = hovered && hovered !== selectedId ? notes.get(hovered)?.meta.title : null
  return (
    <div className="panel px-3 py-2 text-[11.5px] text-dim">
      {h ? (
        <span>
          <span className="text-ink">{h}</span> · click to select · double-click to open
        </span>
      ) : selectedId ? (
        <span>
          <kbd>e</kbd> open · <kbd>Tab</kbd> neighbors · <kbd>f</kbd> fly · <kbd>Esc</kbd> deselect
        </span>
      ) : (
        <span>
          drag to orbit · scroll to zoom · <kbd>?</kbd> keys · <kbd>/</kbd> search
        </span>
      )}
    </div>
  )
}
