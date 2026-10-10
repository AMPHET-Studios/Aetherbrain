/**
 * The board's cheatsheet: every key and gesture of the board, from the same table the keys are read from (BOARD_COMMANDS), so the
 * sheet cannot say one thing and the board do another. Opened from the toolbar's ? button; Esc or a click outside closes it.
 */
import { useEffect, useRef } from 'react'
import { cx, isMac } from '../../util'
import { boardHelpRows } from '../commands'
import { formatKeys } from './session'
import { Icon } from './icons'

export function HelpPanel({ onClose, reducedMotion }: { onClose(): void; reducedMotion: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  const rows = boardHelpRows()
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/45 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-label="Board shortcuts"
        tabIndex={-1}
        data-board-overlay
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
        className={cx('panel scroll flex max-h-full w-full max-w-[760px] flex-col gap-2 overflow-y-auto p-4 outline-none', !reducedMotion && 'rise')}
      >
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-[15px] font-semibold text-white">Board shortcuts</h2>
          <button type="button" className="hud-btn !h-7 !w-7 !justify-center !px-0" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <p className="text-[12px] leading-relaxed text-dim">
          Keys work when no text box has the focus. Every one of them is also in a menu of the toolbar. Drop pictures anywhere on the board, or paste with {isMac ? '⌘' : 'Ctrl'} V.
        </p>
        <ul className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
          {rows.map((r, i) => (
            <li key={i} className="flex items-center justify-between gap-3 py-[3px] text-[12.5px]">
              <span className="truncate text-ink">{r.label}</span>
              <kbd className="shrink-0">{formatKeys(r.keys, isMac)}</kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
