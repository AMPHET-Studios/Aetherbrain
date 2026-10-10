/**
 * The context menu (right click, long press on a touch screen): on a picture, note or mark, or on the selection it belongs to, what
 * can be done with it (copy, duplicate, delete, group, lock, order, flip, rotate, grey, crop, open, reveal, show in the brain, info);
 * on empty canvas, what can be put there (paste, a note here, pictures, select all, fit all). Entries are the commands' own.
 */
import { useRef } from 'react'
import type { Vec2 } from '@aether/core'
import type { BoardSession } from './boardSession'
import { MenuPanel, useClampedPosition, useDismiss } from './Menu'
import { contextMenu, menuContextOf } from './menus'
import { capabilitiesOf } from './Toolbar'
import { useBoardState } from './useBoardSession'

export interface ContextMenuAt {
  /** Where the pointer was, in the canvas's CSS pixels. */
  x: number
  y: number
  /** The same place on the board. */
  board: Vec2
  /** What was under it. */
  target: 'item' | 'canvas'
}

export function ContextMenu({
  session,
  at,
  bounds,
  onClose,
  reducedMotion,
}: {
  session: BoardSession
  at: ContextMenuAt
  bounds: { w: number; h: number }
  onClose(): void
  reducedMotion: boolean
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const pos = useClampedPosition(wrap, at.x, at.y, bounds)
  useDismiss(wrap, onClose)
  const state = useBoardState(session, (s) => s)
  const ctx = menuContextOf(state, capabilitiesOf(session))
  const single = state.selection.length === 1 ? state.doc.items.find((it) => it.id === state.selection[0]) : undefined
  const entries = contextMenu(ctx, at.target, single?.kind === 'note')
  return (
    <div ref={wrap} className="absolute z-40" style={{ left: pos.left, top: pos.top }}>
      <MenuPanel
        entries={entries}
        label="Board context menu"
        reducedMotion={reducedMotion}
        onClose={onClose}
        onRun={(e) => {
          if (e.kind === 'command') session.exec(e.id)
          else if (e.action === 'add-note-here') {
            session.commitEditing()
            session.controller.addNoteAt(at.board)
          }
        }}
      />
    </div>
  )
}
