/**
 * The board's toolbar: the title and whether it is saved, undo and redo, the tools, the colour and size of what is drawn, and on the
 * right the Edit, Arrange and View menus, Add picture, Export, the window controls of the desktop app, and the cheatsheet. Every
 * command is reached by the menus built from BOARD_COMMANDS (menus.ts); the buttons only run commands.
 */
import { useEffect, useReducer, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import { cx, isMac } from '../../util'
import type { BoardTool } from '../api'
import { commandInfo } from '../commands'
import type { BoardSession } from './boardSession'
import { Icon, ToolIcon, type ButtonIconName } from './icons'
import { MenuPanel, useDismiss } from './Menu'
import { arrangeMenu, editMenu, exportMenu, menuContextOf, viewMenu, type MenuContext, type MenuEntry } from './menus'
import { formatKeys } from './session'
import { StylePanel } from './StylePanel'
import { useBoardState, useSessionVersion } from './useBoardSession'

export type ToolbarMenu = 'edit' | 'arrange' | 'view' | 'export' | 'style'

export interface ToolbarProps {
  session: BoardSession
  menu: ToolbarMenu | null
  onMenu(menu: ToolbarMenu | null): void
  onHelp(): void
  reducedMotion: boolean
}

/** What the host can do, as the menus need to know. */
export function capabilitiesOf(session: BoardSession): MenuContext['can'] {
  const { pictures, window: w } = session.host
  return {
    open: typeof pictures.open === 'function',
    reveal: typeof pictures.reveal === 'function',
    showInBrain: typeof pictures.showInBrain === 'function',
    window: !!w,
    floating: !!w?.floating,
    alwaysOnTop: !!w?.alwaysOnTop,
  }
}

const TOOL_GROUPS: BoardTool[][] = [['select', 'hand'], ['note'], ['pen', 'line', 'rect', 'ellipse', 'eraser'], ['sampler', 'crop']]

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-[var(--line)]" aria-hidden />
}

/** Keeps the focus where it is on a press: a toolbar button must not take the keys (Space pans, Enter opens) away from the board. */
const keepFocus = (e: ReactMouseEvent) => e.preventDefault()

function ToolButton({ session, tool, on }: { session: BoardSession; tool: BoardTool; on: boolean }) {
  const info = commandInfo(`tool.${tool}`)
  const keys = info.keys ? formatKeys(info.keys, isMac) : ''
  return (
    <button
      type="button"
      className="hud-btn !w-8 !justify-center !px-0"
      aria-pressed={on}
      aria-label={info.title}
      aria-keyshortcuts={keys || undefined}
      title={keys ? `${info.title} (${keys})` : info.title}
      onMouseDown={keepFocus}
      onClick={() => session.exec(`tool.${tool}`)}
    >
      <ToolIcon tool={tool} />
    </button>
  )
}

function IconButton({ icon, label, keys, disabled, onClick, pressed }: { icon: ButtonIconName; label: string; keys?: string | undefined; disabled?: boolean; onClick(): void; pressed?: boolean }) {
  const k = keys ? formatKeys(keys, isMac) : ''
  return (
    <button
      type="button"
      className="hud-btn !w-8 !justify-center !px-0"
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={k ? `${label} (${k})` : label}
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  )
}

/** The menu that is open: built from the controller's state as it is while the menu is up, and gone when it closes. */
function OpenMenu({ session, kind, onClose, align, reducedMotion }: { session: BoardSession; kind: Exclude<ToolbarMenu, 'style'>; onClose(): void; align: 'left' | 'right'; reducedMotion: boolean }) {
  const state = useBoardState(session, (s) => s)
  const ctx = menuContextOf(state, capabilitiesOf(session))
  const entries: MenuEntry[] = kind === 'edit' ? editMenu(ctx) : kind === 'arrange' ? arrangeMenu(ctx) : kind === 'view' ? viewMenu(ctx) : exportMenu(ctx)
  const label = { edit: 'Edit', arrange: 'Arrange', view: 'View', export: 'Export' }[kind]
  return (
    <MenuPanel
      entries={entries}
      label={label}
      reducedMotion={reducedMotion}
      className={cx('absolute top-full mt-1', align === 'right' ? 'right-0' : 'left-0')}
      onRun={(e) => e.kind === 'command' && session.exec(e.id)}
      onClose={onClose}
    />
  )
}

function MenuButton({
  session,
  kind,
  icon,
  label,
  title,
  open,
  onToggle,
  align = 'right',
  reducedMotion,
  keys,
  labelClass = '@max-[860px]:hidden',
}: {
  session: BoardSession
  kind: Exclude<ToolbarMenu, 'style'>
  icon: ButtonIconName
  label: string
  title: string
  open: boolean
  onToggle(open: boolean): void
  align?: 'left' | 'right'
  reducedMotion: boolean
  keys?: string | undefined
  /** When the text beside the icon gives way to the icon alone (the toolbar's own width decides). */
  labelClass?: string
}) {
  const wrap = useRef<HTMLDivElement>(null)
  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        className="hud-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={open}
        title={keys ? `${title} (${formatKeys(keys, isMac)})` : title}
        onMouseDown={keepFocus}
        onClick={() => onToggle(!open)}
      >
        <Icon name={icon} />
        <span className={labelClass}>{label}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open && <OutsideClose target={wrap} onClose={() => onToggle(false)} />}
      {open && <OpenMenu session={session} kind={kind} align={align} reducedMotion={reducedMotion} onClose={() => onToggle(false)} />}
    </div>
  )
}

/** Closes a menu on a press outside its button and panel. */
function OutsideClose({ target, onClose }: { target: RefObject<HTMLElement | null>; onClose(): void }) {
  useDismiss(target, onClose)
  return null
}

function SaveIndicator({ session }: { session: BoardSession }) {
  useSessionVersion(session)
  const state = session.saveState
  const look = {
    saved: { dot: 'bg-untagged', text: 'text-faint', label: 'Saved', title: 'The board is saved in its note' },
    saving: { dot: 'bg-accent2 pulse', text: 'text-dim', label: 'Saving…', title: 'Writing the board to its note' },
    unsaved: { dot: 'bg-inbox', text: 'text-inbox', label: 'Unsaved', title: 'Changes not written yet: press to save now' },
    failed: { dot: 'bg-danger', text: 'text-danger', label: 'Not saved', title: 'The last save failed; it is tried again. Press to try now' },
  }[state]
  return (
    <button
      type="button"
      className={cx('hud-btn !h-6 !gap-1.5 !px-2 text-[11.5px]', look.text)}
      title={look.title}
      onMouseDown={keepFocus}
      onClick={() => void session.flush()}
      aria-live="polite"
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', look.dot)} aria-hidden />
      <span className="@max-[760px]:sr-only">{look.label}</span>
    </button>
  )
}

function WindowControls({ session }: { session: BoardSession }) {
  const w = session.host.window
  const [, bump] = useReducer((n: number) => n + 1, 0)
  // The host changes its window's numbers on its own after a change was made; look again shortly after, and when the window is back.
  useEffect(() => {
    window.addEventListener('focus', bump)
    return () => window.removeEventListener('focus', bump)
  }, [])
  if (!w) return null
  const act = (fn: () => void) => () => {
    fn()
    bump()
    setTimeout(bump, 300)
  }
  const percent = Math.round(w.opacity * 100)
  const step = (d: number) => w.setOpacity(Math.min(1, Math.max(0.2, Math.round((w.opacity + d) * 10) / 10)))
  if (!w.floating) {
    return (
      <button type="button" className="hud-btn" aria-label="Pop out into its own window" title="Pop out into its own window that stays on top (w)" onMouseDown={keepFocus} onClick={() => session.exec('window.popOut')}>
        <Icon name="window" />
        <span className="@max-[1250px]:hidden">Pop out</span>
      </button>
    )
  }
  return (
    <div className="flex items-center gap-0.5">
      <button type="button" className="hud-btn" aria-label="Dock back into the app" title="Bring the board back into the app" onMouseDown={keepFocus} onClick={() => session.exec('window.dock')}>
        <Icon name="dock" />
        <span className="@max-[1250px]:hidden">Dock</span>
      </button>
      <IconButton icon="pin" label={w.alwaysOnTop ? 'Always on top: on' : 'Always on top: off'} pressed={w.alwaysOnTop} onClick={act(() => session.exec('window.onTop'))} />
      {w.supportsOpacity && (
        <div className="flex items-center" role="group" aria-label="Window opacity">
          <IconButton icon="minus" label="More transparent window" disabled={w.opacity <= 0.2} onClick={act(() => step(-0.1))} />
          <span className="w-9 text-center text-[11.5px] tabular-nums text-dim" title="Window opacity">
            {percent}%
          </span>
          <IconButton icon="plus" label="More opaque window" disabled={w.opacity >= 1} onClick={act(() => step(0.1))} />
        </div>
      )}
    </div>
  )
}

export function Toolbar({ session, menu, onMenu, onHelp, reducedMotion }: ToolbarProps) {
  const tool = useBoardState(session, (s) => s.tool)
  const undo = useBoardState(session, (s) => [s.canUndo, s.undoLabel] as const, (a, b) => a[0] === b[0] && a[1] === b[1])
  const redo = useBoardState(session, (s) => [s.canRedo, s.redoLabel] as const, (a, b) => a[0] === b[0] && a[1] === b[1])
  const style = useBoardState(session, (s) => s.style)
  // The board's own title (the note's), which the host's may not have learned yet; the host's until the note says one.
  const title = useBoardState(session, (s) => s.doc.title.trim()) || session.host.title
  const styleWrap = useRef<HTMLDivElement>(null)
  const undoInfo = commandInfo('edit.undo')
  const redoInfo = commandInfo('edit.redo')
  const toggle = (kind: ToolbarMenu) => (open: boolean) => onMenu(open ? kind : null)
  const mac = isMac
  const dot = style.color

  return (
    <header className="@container relative z-30 flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-[var(--panel-border)] bg-[rgba(10,13,32,0.94)] px-2 py-1.5" role="toolbar" aria-label="Board tools">
      <div className="mr-1 flex min-w-0 items-center gap-1">
        <span className="max-w-[200px] truncate px-1 text-[13px] font-semibold tracking-wide text-white @max-[760px]:max-w-[110px]" title={title}>
          {title}
        </span>
        <SaveIndicator session={session} />
      </div>

      <IconButton icon="undo" label={undo[1] ? `Undo ${undo[1]}` : undoInfo.title} keys={undoInfo.keys?.split(' / ')[0]} disabled={!undo[0]} onClick={() => session.exec('edit.undo')} />
      <IconButton icon="redo" label={redo[1] ? `Redo ${redo[1]}` : redoInfo.title} keys={redoInfo.keys?.split(' / ')[0]} disabled={!redo[0]} onClick={() => session.exec('edit.redo')} />
      <Divider />

      <div className="flex items-center gap-0.5" role="group" aria-label="Tools">
        {TOOL_GROUPS.map((group, i) => (
          <span key={i} className="flex items-center gap-0.5">
            {i > 0 && <Divider />}
            {group.map((t) => (
              <ToolButton key={t} session={session} tool={t} on={tool === t} />
            ))}
          </span>
        ))}
      </div>
      <Divider />

      <div className="relative" ref={styleWrap}>
        <button
          type="button"
          className="hud-btn !gap-2"
          aria-haspopup="dialog"
          aria-expanded={menu === 'style'}
          aria-pressed={menu === 'style'}
          title="Colour, line width and note size"
          onMouseDown={keepFocus}
          onClick={() => onMenu(menu === 'style' ? null : 'style')}
        >
          <span className="h-4 w-4 rounded-full border border-[rgba(255,255,255,0.35)]" style={{ background: `#${dot}` }} aria-hidden />
          <span className="tabular-nums">{+style.width.toFixed(1)}px</span>
          <span className="text-faint @max-[1250px]:hidden">·</span>
          <span className="tabular-nums @max-[1250px]:hidden" title="Note text size">
            Aa {style.noteSize}
          </span>
          <Icon name="chevron" size={12} />
        </button>
        {menu === 'style' && (
          <StylePanel style={style} reducedMotion={reducedMotion} anchor={styleWrap} onClose={() => onMenu(null)} onChange={(patch) => session.controller.setStyle(patch)} />
        )}
      </div>

      <span className="min-w-2 flex-1" />

      <MenuButton session={session} kind="edit" icon="edit" label="Edit" title="Edit, order, transform, picture" open={menu === 'edit'} onToggle={toggle('edit')} reducedMotion={reducedMotion} />
      <MenuButton session={session} kind="arrange" icon="arrange" label="Arrange" title="Arrange, sort, align, size" keys={commandInfo('arrange.menu').keys} open={menu === 'arrange'} onToggle={toggle('arrange')} reducedMotion={reducedMotion} />
      <MenuButton session={session} kind="view" icon="view" label="View" title="Fit, zoom, background, grey, smoothing, captions, grid" open={menu === 'view'} onToggle={toggle('view')} reducedMotion={reducedMotion} />
      <button type="button" className="hud-btn" aria-label="Add picture" title={`Add pictures from the vault (${mac ? '⌘' : 'Ctrl'} O)`} onMouseDown={keepFocus} onClick={() => session.exec('picture.add')}>
        <Icon name="picture" />
        <span className="@max-[1250px]:hidden">Add picture</span>
        <Icon name="plus" size={12} />
      </button>
      <MenuButton session={session} kind="export" icon="export" label="Export" title="Export the selection or the board as a picture" open={menu === 'export'} onToggle={toggle('export')} reducedMotion={reducedMotion} labelClass="@max-[1250px]:hidden" />
      <WindowControls session={session} />
      <IconButton icon="help" label="Board shortcuts" onClick={onHelp} />
    </header>
  )
}
