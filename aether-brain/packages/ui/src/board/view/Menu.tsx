/**
 * The board's drop-down panel: a list of commands with their keys, used by the toolbar's menus and by the context menu. It takes the
 * keyboard while it is open (Up / Down / Home / End, Enter, Esc) and gives it back when it closes; a click outside closes it.
 * Entries come from menus.ts, so the titles, keys and enabled states are the commands' own.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { cx, isMac } from '../../util'
import { formatKeys } from './session'
import type { MenuEntry } from './menus'
import { Icon } from './icons'

/** Closes a popup on a press outside it (and outside `ignore`, the button that opened it, which toggles it itself) or when the window loses focus. */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void, ignore?: RefObject<HTMLElement | null>): void {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (ref.current?.contains(t) || ignore?.current?.contains(t)) return
      close.current()
    }
    const blur = () => close.current()
    document.addEventListener('pointerdown', down, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      window.removeEventListener('blur', blur)
    }
  }, [ref, ignore])
}

/** The glass of a pop-up over the board: darker than the app's own panels, so that its text reads over any picture under it. */
export const POPUP_BG = 'rgba(13, 16, 38, 0.95)'

export interface MenuPanelProps {
  entries: MenuEntry[]
  /** The user chose an entry that is enabled. The menu closes itself afterwards. */
  onRun(entry: Extract<MenuEntry, { kind: 'command' | 'action' }>): void
  onClose(): void
  label: string
  className?: string
  style?: CSSProperties
  reducedMotion?: boolean
}

function runnable(e: MenuEntry): e is Extract<MenuEntry, { kind: 'command' | 'action' }> {
  return (e.kind === 'command' || e.kind === 'action') && !e.disabled
}

export function MenuPanel({ entries, onRun, onClose, label, className, style, reducedMotion }: MenuPanelProps) {
  const ref = useRef<HTMLDivElement>(null)
  const firstRunnable = entries.findIndex(runnable)
  const [active, setActive] = useState(-1)
  const anyChecks = entries.some((e) => e.kind === 'command' && e.checked !== undefined)
  const uid = useId()

  // The menu takes the keyboard when it opens and hands it back to what had it (the button that opened it) when it closes.
  const [before] = useState(() => (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null))
  useEffect(() => {
    const el = ref.current
    el?.focus({ preventScroll: true })
    return () => {
      const now = document.activeElement
      if (before && before !== document.body && before.isConnected && (!now || now === document.body || (el && el.contains(now)))) before.focus({ preventScroll: true })
    }
  }, [before])

  const move = (from: number, dir: 1 | -1): number => {
    let i = from
    for (let n = 0; n < entries.length; n++) {
      i = (i + dir + entries.length) % entries.length
      if (runnable(entries[i]!)) return i
    }
    return from
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    let handled = true
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') setActive((a) => move(a < 0 ? -1 : a, 1))
    else if (e.key === 'ArrowUp') setActive((a) => move(a < 0 ? 0 : a, -1))
    else if (e.key === 'Home') setActive(firstRunnable)
    else if (e.key === 'End') {
      let last = -1
      entries.forEach((en, i) => runnable(en) && (last = i))
      setActive(last)
    } else if (e.key === 'Enter' || e.key === ' ') {
      const en = entries[active]
      if (en && runnable(en)) {
        onRun(en)
        onClose()
      }
    } else handled = false
    // The app's own keys must not also fire behind an open menu.
    e.stopPropagation()
    if (handled) e.preventDefault()
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      aria-activedescendant={active >= 0 ? `${uid}-${active}` : undefined}
      tabIndex={-1}
      data-board-overlay
      onKeyDown={onKeyDown}
      className={cx(
        'panel scroll z-40 max-h-[min(72vh,560px)] min-w-[250px] max-w-[92vw] overflow-y-auto p-1 text-[12.5px] outline-none',
        !reducedMotion && 'rise',
        className,
      )}
      style={{ background: POPUP_BG, ...style }}
    >
      {entries.map((e, i) => {
        if (e.kind === 'separator') return <div key={i} role="separator" className="my-1 h-px bg-[var(--line)]" />
        if (e.kind === 'heading') {
          return (
            <div key={i} className="section-title px-2.5 pb-1 pt-2">
              {e.label}
            </div>
          )
        }
        const checked = e.kind === 'command' ? e.checked : undefined
        const keys = e.kind === 'command' ? e.keys : undefined
        const note = e.kind === 'command' ? e.note : undefined
        return (
          <button
            key={i}
            id={`${uid}-${i}`}
            type="button"
            role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={checked}
            aria-disabled={e.disabled}
            tabIndex={-1}
            disabled={e.disabled}
            data-active={i === active || undefined}
            // Keep the focus where it is: a press on an item must not blur the panel before the click lands.
            onMouseDown={(ev) => ev.preventDefault()}
            onMouseEnter={() => runnable(e) && setActive(i)}
            onClick={() => {
              if (!runnable(e)) return
              onRun(e)
              onClose()
            }}
            className={cx(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-[5px] text-left',
              e.disabled ? 'cursor-default text-faint' : 'text-ink hover:bg-[rgba(140,160,255,0.12)]',
              i === active && !e.disabled && 'bg-[rgba(140,160,255,0.12)]',
            )}
          >
            {anyChecks && (
              <span className="grid w-4 place-items-center text-accent2" aria-hidden>
                {checked ? <Icon name="check" size={14} /> : null}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{e.label}</span>
            {note && <span className="max-w-[90px] truncate text-[11px] text-faint">{note}</span>}
            {keys && <kbd>{formatKeys(keys, isMac)}</kbd>}
          </button>
        )
      })}
    </div>
  )
}

/** Where a context menu opens: at the pointer, moved back inside `bounds` when it would run out. Measured once the panel exists. */
export function useClampedPosition(ref: RefObject<HTMLElement | null>, x: number, y: number, bounds: { w: number; h: number }): { left: number; top: number } {
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.max(4, Math.min(x, bounds.w - w - 4))
    const top = Math.max(4, Math.min(y, bounds.h - h - 4))
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }))
  }, [ref, x, y, bounds.w, bounds.h])
  return pos
}
