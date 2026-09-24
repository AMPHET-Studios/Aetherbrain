import { useAether } from '../store'
import { cx } from '../util'

export function Toasts() {
  const toasts = useAether((s) => s.toasts)
  const dismiss = useAether((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
      {toasts.map((t) => (
        <button
          type="button"
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={cx(
            'panel rise pointer-events-auto max-w-[70vw] px-4 py-2 text-[12.5px]',
            t.kind === 'error' ? 'border-danger/50 text-danger' : t.kind === 'success' ? 'border-untagged/40 text-ink' : 'text-ink',
          )}
        >
          {t.text}
        </button>
      ))}
    </div>
  )
}
