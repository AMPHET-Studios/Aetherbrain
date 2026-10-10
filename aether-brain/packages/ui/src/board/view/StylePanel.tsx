/**
 * What the next mark and note are made with, as a small panel under the toolbar's colour button: the colour (a few presets and a hex
 * field), the width, an arrow head for lines, the fill of rectangles and ellipses, and the size, colour and background of notes.
 * Every change goes to `controller.setStyle`, which also restyles the selected items that have the property (one undo step).
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { BoardStyle } from '../api'
import { cx } from '../../util'
import { trapTab } from './dom'
import { POPUP_BG, useDismiss } from './Menu'
import { parseHexInput } from './session'
import { Icon } from './icons'

export const COLOUR_PRESETS = ['ff5a36', 'ffb454', 'ffe14d', '9dffb3', '4de2ff', '4d7cff', '8f7cff', 'ff5c8a', 'ffffff', '8a8f9c', '000000'] as const
export const WIDTH_PRESETS = [1, 2, 3, 5, 8, 14] as const
export const NOTE_SIZE_PRESETS = [12, 14, 18, 24, 36, 56] as const

function Swatch({ hex, selected, onPick, label }: { hex: string; selected: boolean; onPick(hex: string): void; label?: string }) {
  const none = hex === ''
  return (
    <button
      type="button"
      aria-label={label ?? (none ? 'none' : `#${hex}`)}
      aria-pressed={selected}
      title={label ?? (none ? 'None' : `#${hex}`)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(hex)}
      className={cx(
        'relative h-[20px] w-[20px] shrink-0 rounded-full border border-[rgba(255,255,255,0.28)]',
        selected && 'outline outline-2 outline-offset-1 outline-accent2',
      )}
      style={none ? { background: 'repeating-linear-gradient(135deg, transparent 0 5px, rgba(255,62,108,0.85) 5px 6px)' } : { background: `#${hex}` }}
    />
  )
}

function ColourRow({
  label,
  value,
  allowNone,
  noneLabel,
  onChange,
}: {
  label: string
  value: string
  allowNone?: boolean
  noneLabel?: string
  onChange(hex: string): void
}) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = (raw: string) => {
    const hex = parseHexInput(raw)
    if (hex) onChange(hex)
    else setText(value)
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="section-title">{label}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {allowNone && <Swatch hex="" selected={value === ''} onPick={onChange} label={noneLabel ?? 'None'} />}
        {COLOUR_PRESETS.map((hex) => (
          <Swatch key={hex} hex={hex} selected={value === hex} onPick={onChange} />
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-faint">#</span>
        <input
          aria-label={`${label} (hex)`}
          value={text}
          maxLength={7}
          spellCheck={false}
          placeholder="rrggbb"
          onChange={(e) => {
            setText(e.target.value)
            // A colour is taken as it is typed only when it is whole: "f80" is a colour too, but on the way to "f80000" it would
            // rewrite the field under the user's fingers. The short form is taken on Enter or when the field is left.
            if (!/^#?[0-9a-fA-F]{6}$/.test(e.target.value.trim())) return
            const hex = parseHexInput(e.target.value)
            if (hex && hex !== value) onChange(hex)
          }}
          onBlur={() => commit(text)}
          onKeyDown={(e) => {
            // Typing stays here: neither the board's keys nor the app's may fire.
            e.stopPropagation()
            if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
          className="input !w-[92px] !rounded-md !px-2 !py-[3px] font-mono text-[12px]"
        />
        <span className="text-[11px] text-faint">{value === '' ? noneLabel?.toLowerCase() : ''}</span>
      </div>
    </div>
  )
}

function Chips({ values, current, unit, onPick, label }: { values: readonly number[]; current: number; unit: string; onPick(v: number): void; label: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="section-title">{label}</div>
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={Math.abs(current - v) < 0.01}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(v)}
            className={cx('chip !h-[24px] !px-2.5', Math.abs(current - v) < 0.01 && 'active')}
          >
            {unit === 'line' ? (
              <span className="block w-[22px] rounded-full bg-current" style={{ height: Math.min(v, 8) }} aria-hidden />
            ) : null}
            <span className="tabular-nums">{v}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function StylePanel({
  style,
  onChange,
  onClose,
  anchor,
  reducedMotion,
}: {
  style: BoardStyle
  onChange(patch: Partial<BoardStyle>): void
  onClose(): void
  anchor: RefObject<HTMLElement | null>
  reducedMotion: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose, anchor)
  // The panel holds the keyboard while it is open (a press on its text, or none at all, must not leave the keys with the board).
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Colour and size"
      tabIndex={-1}
      data-board-overlay
      onKeyDown={(e) => {
        e.stopPropagation()
        trapTab(e, ref.current)
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
      className={cx('panel scroll absolute left-0 top-full z-40 mt-1 flex max-h-[min(78vh,640px)] w-[292px] flex-col gap-3.5 overflow-y-auto p-3 text-[12.5px] outline-none', !reducedMotion && 'rise')}
      style={{ background: POPUP_BG }}
    >
      <ColourRow label="Colour" value={style.color} onChange={(color) => onChange({ color })} />
      <Chips label="Line width" values={WIDTH_PRESETS} current={style.width} unit="line" onPick={(width) => onChange({ width })} />
      <label className="flex cursor-pointer items-center gap-2 text-dim">
        <input type="checkbox" checked={style.arrow} onChange={(e) => onChange({ arrow: e.target.checked })} className="accent-[var(--accent)]" />
        Arrow head on lines
      </label>
      <ColourRow label="Fill of rectangles and ellipses" value={style.fill} allowNone noneLabel="No fill" onChange={(fill) => onChange({ fill })} />
      <div className="h-px bg-[var(--line)]" />
      <Chips label="Note text size" values={NOTE_SIZE_PRESETS} current={style.noteSize} unit="px" onPick={(noteSize) => onChange({ noteSize })} />
      <ColourRow label="Note text colour" value={style.noteColor} allowNone noneLabel="Automatic" onChange={(noteColor) => onChange({ noteColor })} />
      <ColourRow label="Note background" value={style.noteFill} allowNone noneLabel="None" onChange={(noteFill) => onChange({ noteFill })} />
      <button type="button" className="hud-btn self-end" onClick={onClose} onMouseDown={(e) => e.preventDefault()}>
        <Icon name="check" size={14} /> Done
      </button>
    </div>
  )
}
