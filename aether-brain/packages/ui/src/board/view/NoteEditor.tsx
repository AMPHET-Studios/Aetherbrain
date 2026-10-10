/**
 * The text box over the note being edited, placed and sized like the note on the canvas (the note's own position, size, turn and
 * colours, at the zoom of the board), so that typing looks like typing on the board. Ctrl / ⌘ + Enter or leaving the box commits,
 * Esc cancels. The session reads its text through `registerEditor`, so a press on the canvas or a command commits it first.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { BOARD_LIMITS, NOTE_LINE_HEIGHT_EM, NOTE_PADDING_EM, boardToScreen, noteBox, textColourOn, type NoteItem, type TextMetrics } from '@aether/core'
import type { BoardSession } from './boardSession'
import { noteFont } from '../renderer'
import { isComposing } from './dom'
import { useBoardState } from './useBoardSession'

const HEX6 = /^[0-9a-fA-F]{6}$/

interface Placed {
  note: NoteItem
  view: { x: number; y: number; zoom: number }
  viewport: { w: number; h: number }
}

function samePlaced(a: Placed | null, b: Placed | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.note === b.note && a.view.x === b.view.x && a.view.y === b.view.y && a.view.zoom === b.view.zoom && a.viewport.w === b.viewport.w && a.viewport.h === b.viewport.h
}

export function NoteEditor({ session, metrics }: { session: BoardSession; metrics: TextMetrics }) {
  const placed = useBoardState(
    session,
    (s): Placed | null => {
      if (s.editingNote === null) return null
      const note = s.doc.items.find((it) => it.id === s.editingNote)
      return note && note.kind === 'note' ? { note, view: s.doc.view, viewport: s.viewport } : null
    },
    samePlaced,
  )
  if (!placed) return null
  return <Editor key={placed.note.id} session={session} metrics={metrics} placed={placed} />
}

function Editor({ session, metrics, placed }: { session: BoardSession; metrics: TextMetrics; placed: Placed }) {
  const { note, view, viewport } = placed
  const ta = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.value = note.text
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
    // The session reads the text through this: a press on the canvas, a command or the view closing commits it first.
    return session.registerEditor(note.id, () => el.value)
    // Only when this note's box appears: typing must not reset it.
  }, [session, note.id])

  // The box grows with the text: the note on the canvas follows once the text is committed.
  const fit = () => {
    const el = ta.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }
  useEffect(fit)

  const zoom = view.zoom
  const box = noteBox(note, metrics)
  const centre = boardToScreen(view, viewport, { x: note.x, y: note.y })
  const w = box.w * zoom
  const h = box.h * zoom
  const pad = NOTE_PADDING_EM * note.size * zoom
  const color = HEX6.test(note.color) ? note.color : note.fill && HEX6.test(note.fill) ? textColourOn(note.fill) : 'ffffff'

  const commit = () => {
    if (done.current) return
    done.current = true
    session.controller.commitNoteText(note.id, ta.current?.value ?? note.text)
  }
  const cancel = () => {
    if (done.current) return
    done.current = true
    session.controller.cancelNoteEdit()
  }

  return (
    <textarea
      ref={ta}
      aria-label="Note text"
      data-board-overlay
      maxLength={BOARD_LIMITS.noteChars}
      spellCheck={false}
      rows={1}
      onInput={() => {
        fit()
        // The typed text goes to the saver as it is typed: a window closed with the box still open must not take it along.
        session.draftNote(note.id)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        // Typing stays here: the board's keys and the app's must not fire.
        e.stopPropagation()
        // Esc and Enter belong to an input method that is composing (a candidate list closes with Esc, a word is chosen with Enter).
        if (isComposing(e)) return
        if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          commit()
        }
      }}
      className="absolute z-20 block resize-none overflow-hidden rounded-[0.3em] border-0 bg-transparent p-0 outline outline-1 outline-offset-2 outline-[#4da3ff]"
      style={{
        left: centre.x - w / 2,
        top: centre.y - h / 2,
        width: w,
        minHeight: h,
        padding: pad,
        boxSizing: 'border-box',
        font: noteFont(note.size * zoom),
        lineHeight: NOTE_LINE_HEIGHT_EM,
        color: `#${color}`,
        background: note.fill && HEX6.test(note.fill) ? `#${note.fill}` : 'rgba(10,13,32,0.35)',
        transform: note.rotation ? `rotate(${note.rotation}deg)` : undefined,
        transformOrigin: 'center',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        caretColor: `#${color}`,
      }}
    />
  )
}
