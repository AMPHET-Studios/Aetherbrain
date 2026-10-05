import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react'

/** Something thrown (an Error, or whatever a library threw) as an Error. */
function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(typeof thrown === 'string' ? thrown : 'Something that is not an Error was thrown')
}

/** What the notice shows and copies: the message, where it was thrown, and which components were drawing. */
export function crashDetails(what: string, error: Error, componentStack: string | null): string {
  return [`Aether Brain: ${what} crashed`, `${error.name}: ${error.message}`, error.stack ?? '', componentStack ? `Components:${componentStack}` : ''].filter(Boolean).join('\n\n')
}

/**
 * The notice that stands in for a part of the app that crashed: what broke, the error to read or copy, and a
 * way out. Esc is the same as Close.
 */
export function CrashNotice({
  what,
  details,
  message,
  onClose,
  onRetry,
}: {
  what: string
  details: string
  message: string
  onClose?: (() => void) | undefined
  onRetry: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      ;(onClose ?? onRetry)()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose, onRetry])
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(details)
    } catch {
      // The details are on screen, selectable.
    }
  }
  return (
    <div className="pointer-events-auto fixed inset-0 z-[70] grid place-items-center bg-black/60 p-4" role="alertdialog" aria-label={`${what} crashed`}>
      <div className="panel rise flex max-h-full w-full max-w-[640px] flex-col gap-3 overflow-hidden p-5">
        <div className="text-[15px] font-semibold text-white">Something went wrong in {what}</div>
        <div className="select-text break-words text-[12.5px] leading-relaxed text-dim">
          Nothing was lost: your notes are the files on disk and this only stopped the screen from drawing. {message}
        </div>
        <details className="min-h-0 overflow-auto rounded-lg border border-[var(--panel-border)] bg-black/30 p-2 text-[11px] text-faint">
          <summary className="cursor-pointer text-dim">Details to copy for a bug report</summary>
          <pre className="mt-2 select-text whitespace-pre-wrap break-words font-mono">{details}</pre>
        </details>
        <div className="flex gap-2">
          {onClose && (
            <button type="button" className="hud-btn primary" onClick={onClose} autoFocus>
              Close <kbd>Esc</kbd>
            </button>
          )}
          <button type="button" className={onClose ? 'hud-btn' : 'hud-btn primary'} onClick={onRetry}>
            Try again
          </button>
          <button type="button" className="hud-btn" onClick={copy}>
            Copy details
          </button>
        </div>
      </div>
    </div>
  )
}

interface Props {
  /** What this part is, in words for the notice: "the Projects board". */
  what: string
  /** Leave the crashed part (a board closes, the view goes back to the graph); the notice goes with it. */
  onClose?: () => void
  /** Draw nothing (instead of the notice) when this part crashes: for the small pieces of chrome. */
  quiet?: boolean
  children: ReactNode
}

interface State {
  error: Error | null
  stack: string | null
}

/**
 * Keeps a part of the app that throws while drawing from taking the whole
 * window with it. React unmounts everything above an uncaught render error,
 * and what the user sees then is a blank window and no word of why.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, stack: null }

  static getDerivedStateFromError(thrown: unknown): Partial<State> {
    return { error: asError(thrown) }
  }

  override componentDidCatch(thrown: unknown, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? null })
    console.error(`[aether] ${this.props.what} crashed`, thrown, info.componentStack)
  }

  private retry = (): void => this.setState({ error: null, stack: null })

  private close = (): void => {
    this.props.onClose?.()
    this.retry()
  }

  override render(): ReactNode {
    const { error, stack } = this.state
    if (!error) return this.props.children
    if (this.props.quiet) return null
    return (
      <CrashNotice
        what={this.props.what}
        message={error.message}
        details={crashDetails(this.props.what, error, stack)}
        onClose={this.props.onClose ? this.close : undefined}
        onRetry={this.retry}
      />
    )
  }
}
