import { useAether } from '../store'
import { cx } from '../util'

export function Toasts() {
  const toasts = useAether((s) => s.toasts)
  const dismiss = useAether((s) => s.dismissToast)
  const toastAction = useAether((s) => s.toastAction)
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            'panel rise pointer-events-auto flex max-w-[70vw] items-center gap-3 px-4 py-2 text-[12.5px]',
            t.kind === 'error' ? 'border-danger/50 text-danger' : t.kind === 'success' ? 'border-untagged/40 text-ink' : 'text-ink',
          )}
        >
          <button type="button" className="text-left" onClick={() => dismiss(t.id)} title="Dismiss">
            {t.text}
          </button>
          {t.action && (
            <button type="button" className="hud-btn !h-6 !px-2 text-accent2" onClick={() => toastAction(t.id)}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
