/**
 * The reference board's view: the React shell that turns a BoardHost into the screen. It is the same component in the docked app
 * and in the floating window; all it knows of its surroundings is the host. The engine (load, save, pictures, events) is the session
 * (view/boardSession.ts), the drawing is the canvas (view/BoardCanvas.tsx), and everything around the canvas is a small component of
 * view/. This file puts them together and owns the input that spans them: the keyboard (taken while the board is up, so the app's
 * own keys never also fire), drops, pastes, the context menu, and the overlays. Design: docs/design/reference-board.md.
 *
 * The host must stay the same for the life of the view (give the view a `key` when the board changes): the session is made once.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { boardPictures, hitTest, type Vec2 } from '@aether/core'
import { cx, isControl, isMac } from '../util'
import type { BoardHost } from './api'
import { getActiveBoard, setActiveBoard, type ActiveBoard } from './active'
import { BoardCanvas } from './view/BoardCanvas'
import { ContextMenu, type ContextMenuAt } from './view/ContextMenu'
import { MODAL_SELECTOR, dragCarriesContent, focusInto, isTypingTarget, keyInOf, snapshotTransfer } from './view/dom'
import { HelpPanel } from './view/HelpPanel'
import { Icon } from './view/icons'
import { InfoCard } from './view/InfoCard'
import { NoteEditor } from './view/NoteEditor'
import { Picker } from './view/Picker'
import { StatusBar } from './view/StatusBar'
import { Toolbar, type ToolbarMenu } from './view/Toolbar'
import type { BoardSession, SessionUi } from './view/boardSession'
import { useBoardSession, useBoardState, useReducedMotion, useSessionVersion } from './view/useBoardSession'

export interface BoardViewProps {
  host: BoardHost
  className?: string
  /**
   * The note's text, when the caller already has it: the board then opens on the first render (no loading screen) and the view can be
   * rendered on a server. Left out, the view asks the host to `load()`.
   */
  initialRaw?: string
}

export function BoardView({ host, className, initialRaw }: BoardViewProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<ToolbarMenu | null>(null)
  const [picker, setPicker] = useState(false)
  const [help, setHelp] = useState(false)
  const [info, setInfo] = useState<number | null>(null)
  const [hideUi, setHideUi] = useState(false)
  const reduced = useReducedMotion()

  // What the engine asks of this side. Setters only: the object is the same for the life of the view.
  const ui = useMemo<SessionUi>(
    () => ({
      openPicker: () => {
        setMenu(null)
        setPicker(true)
      },
      showInfo: (id) => setInfo(id),
      toggleHideUi: () => setHideUi((h) => !h),
      openMenu: (m) => {
        setHideUi(false)
        setMenu(m)
      },
    }),
    [],
  )
  const { session, phase, error } = useBoardSession(host, ui, initialRaw !== undefined ? { initialRaw } : {})

  // The outer box is the caller's (it positions the view: `absolute inset-0` in the docked app, the whole window in the floating one);
  // the inner box is the board's own layout and the anchor of its overlays. The root takes the keyboard and shows no focus ring.
  return (
    <div ref={rootRef} tabIndex={0} role="group" data-board-root aria-label={`Reference board: ${host.title}`} className={cx('h-full min-h-0 w-full overflow-hidden outline-none', className)}>
      <div className="relative flex h-full min-h-0 w-full select-none flex-col bg-[var(--bg-deep)] text-ink">
        {phase === 'ready' ? (
          <ReadyView session={session} rootRef={rootRef} reduced={reduced} menu={menu} setMenu={setMenu} picker={picker} setPicker={setPicker} help={help} setHelp={setHelp} info={info} setInfo={setInfo} hideUi={hideUi} setHideUi={setHideUi} />
        ) : phase === 'failed' ? (
          <div className="grid h-full place-items-center p-6">
            <div className="panel flex max-w-[520px] flex-col gap-3 p-5 text-[13px] leading-relaxed" role="alert">
              <div className="text-[15px] font-semibold text-white">This board did not open</div>
              <div className="text-dim">{error}</div>
              <div className="flex gap-2">
                <button type="button" className="hud-btn primary" onClick={() => void session.retryLoad()}>
                  Try again
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid h-full place-items-center text-[13px] text-dim" role="status">
            Opening the board…
          </div>
        )}
      </div>
    </div>
  )
}

interface ReadyProps {
  session: BoardSession
  rootRef: RefObject<HTMLDivElement | null>
  reduced: boolean
  menu: ToolbarMenu | null
  setMenu(m: ToolbarMenu | null): void
  picker: boolean
  setPicker(v: boolean): void
  help: boolean
  setHelp(v: boolean): void
  info: number | null
  setInfo(v: number | null): void
  hideUi: boolean
  setHideUi(v: boolean | ((h: boolean) => boolean)): void
}

function ReadyView({ session, rootRef, reduced, menu, setMenu, picker, setPicker, help, setHelp, info, setInfo, hideUi, setHideUi }: ReadyProps) {
  const host = session.host
  const areaRef = useRef<HTMLDivElement>(null)
  const pointer = useRef<Vec2 | null>(null)
  const [context, setContext] = useState<ContextMenuAt | null>(null)
  const [dragging, setDragging] = useState(false)
  const metrics = session.env.metrics

  // The latest state of the overlays, for the listeners that live as long as the view.
  const open = useRef({ info, help, picker, menu, context })
  open.current = { info, help, picker, menu, context }

  /* ---- the registry: the palette and the pop-out code reach this board through it ---- */
  useEffect(() => {
    const mine: ActiveBoard = {
      path: host.path,
      exec: (id, arg) => session.exec(id, arg),
      state: () => session.controller.state,
      // True only when everything is on disk: a note being typed is committed and written, and a save that failed says false.
      flush: () => session.flush(),
    }
    setActiveBoard(mine)
    return () => {
      if (getActiveBoard() === mine) setActiveBoard(null)
    }
  }, [session, host.path])

  /* ---- a note being typed is kept when the view goes away: this cleanup runs before the text box's own ---- */
  useLayoutEffect(() => () => session.commitEditing(), [session])

  /* ---- the board takes the keyboard when it opens, and gets it back when an overlay or the note box lets go ---- */
  useEffect(() => {
    const active = document.activeElement
    if (!active || active === document.body) rootRef.current?.focus({ preventScroll: true })
  }, [rootRef])
  const editing = useBoardState(session, (s) => s.editingNote !== null)
  const overlayOpen = picker || help || menu !== null || context !== null
  useEffect(() => {
    if (editing || overlayOpen) return
    const active = document.activeElement
    if (!active || active === document.body) rootRef.current?.focus({ preventScroll: true })
  }, [editing, overlayOpen, rootRef])

  /* ---- saving when the user leaves ---- */
  useEffect(() => {
    // A window that loses the focus writes what is pending. The note being typed is not ended by it (the text box commits itself when
    // the focus really leaves it), but its text is already on its way to the saver as it is typed.
    const onBlur = () => {
      session.controller.blur()
      void session.save()
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') void session.flush()
    }
    const onPageHide = () => void session.flush()
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [session])

  /* ---- the keyboard: taken in the capture phase of the window, so that the app's global keys never also fire ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      const target = e.target
      // Text fields keep their keys; so do the board's own overlays (menus, picker, panels) and dialogs of the app around it.
      if (isTypingTarget(target)) return
      if (target instanceof Element) {
        if (target.closest('[data-board-overlay]')) return
        const root = rootRef.current
        if (root && !root.contains(target) && target.closest('[role="dialog"], [role="alertdialog"]')) return
      }
      // A modal overlay (the picker, the cheatsheet, the colour panel) holds the keyboard. With the focus anywhere else - on the board
      // after a click on the overlay's dead space, on a toolbar button behind it - the board's keys must not run (Delete would empty
      // the board under the picker): Esc closes the overlay, Tab brings the focus back into it, everything else waits.
      const modal = rootRef.current?.querySelector<HTMLElement>(MODAL_SELECTOR)
      if (modal && !(target instanceof Node && modal.contains(target))) {
        if (e.type === 'keydown' && e.key === 'Escape') {
          const o = open.current
          if (o.help) setHelp(false)
          else if (o.picker) setPicker(false)
          else setMenu(null)
          e.preventDefault()
          e.stopPropagation()
        } else if (e.type === 'keydown' && e.key === 'Tab') {
          e.preventDefault()
          e.stopPropagation()
          focusInto(modal)
        }
        return
      }
      if (session.controller.state.editingNote !== null) return
      // Enter and Space belong to a button that has the focus (Space acts when it is released, so the release is left alone too).
      if ((e.key === ' ' || e.key === 'Enter') && isControl(target)) return
      if (e.type === 'keydown') {
        if (e.key === 'Escape' && open.current.info !== null) {
          setInfo(null)
          e.preventDefault()
          e.stopPropagation()
          return
        }
        // Tab hides the toolbar from the board; from a button of the bars, and with Shift, it is the browser's focus move.
        if (e.key === 'Tab' && (e.shiftKey || (target instanceof Element && target.closest('[role="toolbar"], footer')))) return
        // The floating window has no app around it to answer the cheatsheet key.
        if (e.key === '?' && host.window?.floating) {
          setHelp(true)
          e.preventDefault()
          e.stopPropagation()
          return
        }
      }
      if (session.key(keyInOf(e))) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
    }
  }, [session, rootRef, host, setInfo, setHelp, setPicker, setMenu])

  /* ---- paste: a picture on the clipboard, text, or (when there is neither) the board's own copy ---- */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.target instanceof Element && e.target.closest('[data-board-overlay]')) return
      const snap = snapshotTransfer(e.clipboardData)
      e.preventDefault()
      void session.handlePaste(snap, pointer.current ? session.toBoard(pointer.current) : null)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [session])

  /* ---- drops: taken here, so that the app's window-wide drop zone does not also import the files into the vault ---- */
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let depth = 0
    const take = (e: DragEvent): boolean => {
      if (!dragCarriesContent(e.dataTransfer)) return false
      e.preventDefault()
      e.stopPropagation()
      return true
    }
    const enter = (e: DragEvent) => {
      if (take(e) && depth++ === 0) setDragging(true)
    }
    const over = (e: DragEvent) => {
      if (take(e) && e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const leave = (e: DragEvent) => {
      if (!take(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!take(e)) return
      depth = 0
      setDragging(false)
      const snap = snapshotTransfer(e.dataTransfer)
      const r = areaRef.current?.getBoundingClientRect()
      const at = r ? session.toBoard({ x: e.clientX - r.left, y: e.clientY - r.top }) : null
      void session.handleTransfer(snap, at)
    }
    root.addEventListener('dragenter', enter)
    root.addEventListener('dragover', over)
    root.addEventListener('dragleave', leave)
    root.addEventListener('drop', drop)
    return () => {
      root.removeEventListener('dragenter', enter)
      root.removeEventListener('dragover', over)
      root.removeEventListener('dragleave', leave)
      root.removeEventListener('drop', drop)
    }
  }, [session, rootRef])

  /* ---- the context menu ---- */
  const openContext = (at: Vec2) => {
    session.commitEditing()
    setMenu(null)
    const st = session.controller.state
    const board = session.toBoard(at)
    const hit = hitTest(st.doc, board, 6 / st.doc.view.zoom, metrics)
    setContext({ x: at.x, y: at.y, board, target: hit ? 'item' : 'canvas' })
  }

  const area = areaRef.current?.getBoundingClientRect()
  const bounds = { w: area?.width ?? 800, h: area?.height ?? 600 }

  const onBoard = useMemo(() => (picker ? new Set(boardPictures(session.controller.state.doc)) : new Set<string>()), [picker, session])
  const closePicker = () => setPicker(false)

  return (
    <>
      {!hideUi && <Toolbar session={session} menu={menu} onMenu={setMenu} onHelp={() => setHelp(true)} reducedMotion={reduced} />}
      <MissingNotice session={session} reduced={reduced} />
      <div ref={areaRef} className="relative min-h-0 flex-1">
        <BoardCanvas
          session={session}
          focusTarget={rootRef}
          onPointer={(p) => {
            pointer.current = p
          }}
          onContextMenu={openContext}
        />
        <NoteEditor session={session} metrics={metrics} />
        <EmptyHint session={session} reduced={reduced} />
        {info !== null && <InfoCard session={session} id={info} onClose={() => setInfo(null)} reducedMotion={reduced} />}
        {context && <ContextMenu session={session} at={context} bounds={bounds} reducedMotion={reduced} onClose={() => setContext(null)} />}
        {dragging && <DropOverlay />}
        {hideUi && (
          <button
            type="button"
            className="hud-btn absolute right-2 top-2 z-30 opacity-40 hover:opacity-100 focus-visible:opacity-100"
            title="Show the toolbar (Tab)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setHideUi(false)}
          >
            <Icon name="eyeOff" size={14} /> Show toolbar <kbd>Tab</kbd>
          </button>
        )}
      </div>
      {!hideUi && <StatusBar session={session} />}
      {picker && (
        <Picker
          host={host}
          onBoard={onBoard}
          reducedMotion={reduced}
          onClose={closePicker}
          onAdd={(paths) => {
            closePicker()
            void session.addVaultPictures(paths, null)
          }}
        />
      )}
      {help && <HelpPanel reducedMotion={reduced} onClose={() => setHelp(false)} />}
    </>
  )
}

/** Some of the board's pictures are gone from the vault: they keep their places (drawn as dashed frames) and nothing is removed. */
function MissingNotice({ session, reduced }: { session: BoardSession; reduced: boolean }) {
  useSessionVersion(session)
  const missing = useBoardState(
    session,
    () => session.missingPictures(),
    (a, b) => a.count === b.count && a.sample.join('|') === b.sample.join('|'),
  )
  const [dismissed, setDismissed] = useState(0)
  // A notice that was closed comes back when more pictures go missing.
  if (missing.count === 0 || dismissed >= missing.count) return null
  const names = missing.sample.join(', ') + (missing.count > missing.sample.length ? ' …' : '')
  return (
    <div className={cx('flex items-center gap-3 border-b border-[rgba(255,62,108,0.3)] bg-[rgba(255,62,108,0.1)] px-3 py-1.5 text-[12px]', !reduced && 'rise')} role="status">
      <span className="min-w-0 flex-1 truncate text-ink" title={names}>
        <strong className="font-semibold">{missing.count === 1 ? '1 picture is' : `${missing.count} pictures are`} missing from the vault</strong>
        <span className="text-dim"> ({names}). They keep their places on the board as dashed frames and come back when the files do; nothing is deleted.</span>
      </span>
      <button type="button" className="hud-btn !h-6 !w-6 !justify-center !px-0" aria-label="Dismiss this notice" onClick={() => setDismissed(missing.count)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

/** The hint of an empty board; it goes as soon as there is an item. */
function EmptyHint({ session, reduced }: { session: BoardSession; reduced: boolean }) {
  const empty = useBoardState(session, (s) => s.doc.items.length === 0 && s.draft === null && s.editingNote === null)
  if (!empty) return null
  const mod = isMac ? '⌘' : 'Ctrl'
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
      <div className={cx('panel flex max-w-[420px] flex-col items-center gap-2 px-8 py-6 text-center', !reduced && 'rise')}>
        <span className="text-[30px] leading-none text-image" aria-hidden>
          <Icon name="picture" size={34} />
        </span>
        <span className="text-[15px] font-semibold text-white">Drop pictures here</span>
        <span className="text-[12.5px] leading-relaxed text-dim">
          Paste with {mod} V, or press <strong className="text-ink">Add picture</strong> to choose from the vault. Press <kbd>T</kbd> for a note, <kbd>P</kbd> to draw.
        </span>
        <button type="button" className="hud-btn primary pointer-events-auto mt-1" onMouseDown={(e) => e.preventDefault()} onClick={() => session.exec('picture.add')}>
          <Icon name="picture" /> Add picture
        </button>
      </div>
    </div>
  )
}

function DropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center bg-black/40 p-4" aria-live="polite">
      <div className="panel drop-frame flex flex-col items-center gap-1.5 px-10 py-7 text-center">
        <span className="text-[15px] font-semibold text-white">Drop pictures to put them on the board</span>
        <span className="text-[12px] text-dim">png · jpg · webp · gif · bmp · avif — they are saved in the board&apos;s folder</span>
      </div>
    </div>
  )
}
