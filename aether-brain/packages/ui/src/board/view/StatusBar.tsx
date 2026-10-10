/**
 * The strip under the canvas: the zoom, what is selected, how full the board is, and on the right what the tool in hand does, or the
 * last thing the board said, or what it is busy with. Each part reads only the slice of the state it shows.
 */
import type { ReactNode } from 'react'
import { BOARD_LIMITS } from '@aether/core'
import { cx, isMac } from '../../util'
import type { BoardSession } from './boardSession'
import { budgetTone, formatChars, formatZoom, summarizeSelection, toolHint } from './session'
import { useBoardState, useSessionVersion } from './useBoardSession'

function Cell({ children, title, onClick, tone }: { children: ReactNode; title?: string; onClick?: () => void; tone?: 'warn' | 'danger' }) {
  const cls = cx('whitespace-nowrap tabular-nums', tone === 'warn' && 'text-inbox', tone === 'danger' && 'text-danger')
  if (!onClick) {
    return (
      <span className={cls} title={title}>
        {children}
      </span>
    )
  }
  return (
    <button type="button" className={cx(cls, 'rounded px-1 hover:bg-[rgba(140,160,255,0.1)] hover:text-ink')} title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  )
}

export function StatusBar({ session }: { session: BoardSession }) {
  useSessionVersion(session)
  const zoom = useBoardState(session, (s) => s.doc.view.zoom)
  const selection = useBoardState(session, (s) => summarizeSelection(s.doc, s.selection).text)
  const counts = useBoardState(
    session,
    (s) => {
      let pictures = 0
      for (const it of s.doc.items) if (it.kind === 'picture') pictures++
      return { pictures, items: s.doc.items.length }
    },
    (a, b) => a.pictures === b.pictures && a.items === b.items,
  )
  const hint = useBoardState(session, (s) => toolHint(s, s.doc.items.length, isMac))
  const size = useBoardState(
    session,
    (s) => ({ chars: s.chars, limit: s.charsLimit }),
    (a, b) => a.chars === b.chars && a.limit === b.limit,
  )
  const full = counts.items >= BOARD_LIMITS.items
  const nearly = counts.items >= BOARD_LIMITS.items * 0.9
  const fill = budgetTone(size.chars, size.limit)
  const message = session.lastMessage
  const activity = session.activity
  return (
    <footer className="flex min-h-[26px] flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-[var(--panel-border)] bg-[rgba(10,13,32,0.94)] px-3 py-1 text-[11.5px] text-dim" aria-label="Board status">
      <Cell title="Zoom (click for 100%)" onClick={() => session.exec('view.zoom100')}>
        {formatZoom(zoom)}
      </Cell>
      <Cell>{selection}</Cell>
      <Cell title={`Pictures on the board, and all items (pictures, notes and marks) of the ${BOARD_LIMITS.items} a board holds`} tone={full ? 'danger' : nearly ? 'warn' : undefined}>
        {counts.pictures} {counts.pictures === 1 ? 'picture' : 'pictures'} · {counts.items} / {BOARD_LIMITS.items} items
      </Cell>
      <Cell
        title={`How much of the note the board's items take: ${size.chars.toLocaleString('en-US')} of the ${size.limit.toLocaleString('en-US')} characters a board holds. Past that, nothing can be added until something is removed.`}
        tone={fill === 'full' ? 'danger' : fill === 'warn' ? 'warn' : undefined}
      >
        {formatChars(size.chars)} of {formatChars(size.limit)} characters
      </Cell>
      <span className="min-w-2 flex-1" />
      {/* A message wraps (and the bar with it) rather than being cut: it may be the only word the user gets about a failure. */}
      {activity ? (
        <span className="min-w-0 max-w-full break-words text-accent2 [overflow-wrap:anywhere]" role="status">
          {activity}
        </span>
      ) : message ? (
        <span className={cx('min-w-0 max-w-full [overflow-wrap:anywhere]', message.tone === 'error' ? 'text-danger' : message.tone === 'success' ? 'text-untagged' : 'text-dim')} role="status" title={message.text}>
          {message.text}
        </span>
      ) : (
        <span className="min-w-0 max-w-full truncate text-faint">{hint}</span>
      )}
    </footer>
  )
}
