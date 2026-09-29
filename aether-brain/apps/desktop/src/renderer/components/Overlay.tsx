import { useRef, type ReactNode } from 'react'
import { openPanel, useOverlayKeys } from '../panels'

/**
 * The frame both desktop panels share: a dimmed backdrop (click closes), a
 * HUD panel with a title row and a scrolling body, and the overlay keyboard
 * (Esc closes, Tab stays inside, the app's shortcuts wait behind it).
 */
export function Overlay({
  title,
  hint,
  keys,
  width = 'w-[720px]',
  children,
}: {
  title: string
  hint: string
  /** Single keys handled while open (the panel's own key closes it). */
  keys: Record<string, () => void>
  width?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useOverlayKeys(ref, keys)
  return (
    // z-[45]: above the app's views and palette, below its toasts (z-50), so AI activity and errors stay readable.
    <div className="fixed inset-0 z-[45] flex items-start justify-center bg-black/50 pt-[7vh]" onMouseDown={(e) => e.target === e.currentTarget && openPanel(null)}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`panel rise flex max-h-[86vh] max-w-[94vw] flex-col ${width}`}>
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-5 py-3">
          <span className="text-[15px] font-semibold text-white">{title}</span>
          <span className="min-w-0 truncate text-[12px] text-dim">{hint}</span>
          <span className="flex-1" />
          <button type="button" className="hud-btn" onClick={() => openPanel(null)}>
            Close <kbd>Esc</kbd>
          </button>
        </div>
        <div className="scroll min-h-0 flex-1 px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

/** A titled block inside an overlay. */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="section-title">{title}</span>
        {aside && <span className="text-[11.5px] text-faint">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

/** Error line in the danger style (nothing when empty). */
export function ErrorLine({ text }: { text: string | null | undefined }) {
  if (!text) return null
  return (
    <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger" role="alert">
      {text}
    </div>
  )
}
