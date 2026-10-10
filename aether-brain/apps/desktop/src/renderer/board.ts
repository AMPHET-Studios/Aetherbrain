/**
 * The reference board on the desktop, brain-window side: the palette commands and the key that pop the board open in the docked
 * view out into its own floating window (and bring it back), the window's always-on-top and opacity from the palette, and what the
 * docked Boards view needs to know about that window. The window is main's (src/main/board-window.ts); its page is board.html.
 *
 * What the docked view uses (it is wired to these by the view's author; every one is a no-op or `false` outside the desktop app):
 *   - boardPopOutAvailable()        true in the desktop app (the Electron bridge is there): show the pop-out button, or not.
 *   - useBoardWindow()              React hook: the window's state, a BoardStatusDto { open, path, alwaysOnTop, opacity, supportsOpacity }.
 *   - boardWindowState()            the same state, outside React (a closed, on-top, opaque window until main has spoken).
 *   - useBoardOut(path)             React hook: true while the window shows the board at `path` (draw the placeholder, not the board).
 *   - onBoardReturned(cb)           cb(path) when the window stops showing a board (closed, or moved on to another): reload that note,
 *                                   the window may have saved it since the docked view read it.
 *   - popOutBoard(path) / dockBoard()   what the host's `window.popOut` / `window.dock` call. Pop-out first awaits the flush below.
 *   - setBoardFlush(fn)             the docked view says how to save its pending change; pop-out awaits it (and stops if it fails), so
 *                                   the window opens on the latest text and the two never hold different boards.
 *
 * The palette acts on the board open in the docked view, `store.boardPath` (read defensively: it is the store's to add): "Board: Pop out
 * to its own window", "Board: Bring the board back from its window" (both also on the key `w`), "Board: Always on top" and "Board:
 * Window opacity…" (Windows and macOS only). Commands and key exist only when the Electron bridge does.
 *
 * `Board: Window opacity…` draws its own small dialog (below) instead of going through `store.requestForm`: that is a closed union
 * ('project' | 'note' | 'folder') whose consumers are the inspector and the Projects board, and any form request makes the store leave
 * the Projects view.
 */
import { useSyncExternalStore } from 'react'
import { registerCommands, registerHelpRows, registerKey, useAether } from '@aether/ui'
import type { BoardStatusDto } from '../shared/ipc'
import { errorText, samePath } from './panels'
import { ElectronVaultAdapter } from './vault/electron'

/** The dimmest the window goes, in percent (main clamps to the same 0.2: below it the window cannot be found again). */
export const OPACITY_MIN_PERCENT = 20

const bridge = ElectronVaultAdapter.bridge()

/* ------------------------------------------------------------------ */
/* What the floating window is doing                                  */
/* ------------------------------------------------------------------ */

const CLOSED: BoardStatusDto = { open: false, path: null, alwaysOnTop: true, opacity: 1, supportsOpacity: false }

let status: BoardStatusDto = CLOSED
const subs = new Set<() => void>()
const returned = new Set<(path: string) => void>()
let flush: (() => Promise<void> | void) | null = null

function sameStatus(a: BoardStatusDto, b: BoardStatusDto): boolean {
  return a.open === b.open && a.path === b.path && a.alwaysOnTop === b.alwaysOnTop && a.opacity === b.opacity && a.supportsOpacity === b.supportsOpacity
}

/** A new status from main: subscribers hear of it only when something in it differs (a snapshot must not change by itself). */
function setStatus(next: BoardStatusDto): void {
  if (sameStatus(status, next)) return
  status = next
  for (const cb of [...subs]) cb()
}

function subscribe(cb: () => void): () => void {
  subs.add(cb)
  return () => void subs.delete(cb)
}

/** The desktop app can pop a board out into a window of its own (false in a plain browser). */
export function boardPopOutAvailable(): boolean {
  return bridge !== null
}

/** The floating window's state as main last said it (closed, on top and opaque until it speaks). */
export function boardWindowState(): BoardStatusDto {
  return status
}

export function useBoardWindow(): BoardStatusDto {
  return useSyncExternalStore(subscribe, boardWindowState, boardWindowState)
}

const platform = bridge?.platform ?? ''
/** Whether the window shows the board at `path` (paths compared the way the OS compares them). */
function isOut(s: BoardStatusDto, path: string | null | undefined): boolean {
  return !!path && s.open && s.path !== null && samePath(s.path, path, platform)
}

/** True while the floating window shows the board at `path`: the docked view then draws its placeholder. */
export function useBoardOut(path: string | null | undefined): boolean {
  return isOut(useBoardWindow(), path)
}

/** `cb(path)` whenever the window stops showing a board. Returns the unsubscribe. */
export function onBoardReturned(cb: (path: string) => void): () => void {
  returned.add(cb)
  return () => void returned.delete(cb)
}

/** The docked view's way to save what it has not saved yet; null when it has none. Returns the unregister function. */
export function setBoardFlush(fn: (() => Promise<void> | void) | null): () => void {
  flush = fn
  return () => {
    if (flush === fn) flush = null
  }
}

const toast = (text: string, kind: 'info' | 'success' | 'error' = 'info'): void => useAether.getState().toast(text, kind)

/**
 * Open the board at `path` in the floating window (after the docked view has saved), or move the window to it. True when the window
 * is showing it; a failure is toasted and leaves the docked view as it was.
 */
export async function popOutBoard(path: string): Promise<boolean> {
  if (!bridge) return false
  try {
    await flush?.()
  } catch (err) {
    toast(`Board window: the board could not be saved first, so it was not moved (${errorText(err)})`, 'error')
    return false
  }
  try {
    const next = await bridge.boardOpen(path)
    setStatus(next)
    return isOut(next, path)
  } catch (err) {
    toast(`Board window: ${errorText(err)}`, 'error')
    return false
  }
}

/** Close the floating window; the docked view takes its board back (`onBoardReturned`). */
export async function dockBoard(): Promise<void> {
  if (!bridge || !status.open) return
  try {
    await bridge.boardClose()
  } catch (err) {
    toast(`Board window: ${errorText(err)}`, 'error')
  }
}

/** The board open in the docked view: the store's `boardPath`, which another module adds. */
function dockedBoard(): string | null {
  const path = (useAether.getState() as { boardPath?: string | null }).boardPath
  return typeof path === 'string' && path ? path : null
}

async function toggleOnTop(): Promise<void> {
  if (!bridge) return
  try {
    const next = await bridge.boardConfigure({ alwaysOnTop: !status.alwaysOnTop })
    setStatus(next)
    toast(`Board window ${next.alwaysOnTop ? 'stays on top of other windows' : 'no longer stays on top'}`)
  } catch (err) {
    toast(`Board window: ${errorText(err)}`, 'error')
  }
}

/* ------------------------------------------------------------------ */
/* Window opacity…                                                    */
/* ------------------------------------------------------------------ */

/** "70", "70 %" or "70%" as 0.7; null for anything else, and for a number outside 20 to 100. Whole percents. */
export function parseOpacityPercent(text: string): number | null {
  const m = /^\s*(\d{1,3}(?:\.\d+)?)\s*%?\s*$/.exec(text)
  if (!m) return null
  const percent = Number(m[1])
  return percent >= OPACITY_MIN_PERCENT && percent <= 100 ? Math.round(percent) / 100 : null
}

async function applyOpacity(opacity: number): Promise<void> {
  if (!bridge) return
  try {
    const next = await bridge.boardConfigure({ opacity })
    setStatus(next)
    toast(`Board window opacity ${Math.round(next.opacity * 100)}%`)
  } catch (err) {
    toast(`Board window: ${errorText(err)}`, 'error')
  }
}

let form: { root: HTMLElement; input: HTMLInputElement } | null = null

function closeForm(): void {
  form?.root.remove()
  form = null
}

/** A small dialog over the app asking for a percentage; Enter applies, Esc and a click outside cancel. */
function openForm(): void {
  if (form) {
    form.input.focus()
    return
  }
  const root = document.createElement('div')
  root.className = 'fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[12vh]'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Board window opacity')
  const panel = document.createElement('div')
  panel.className = 'panel rise flex w-[360px] max-w-[92vw] flex-col gap-2 p-4 text-[13px]'
  const label = document.createElement('label')
  label.className = 'text-ink'
  const question = `Board window opacity, in percent (${OPACITY_MIN_PERCENT} to 100)`
  label.textContent = question
  const input = document.createElement('input')
  input.type = 'text'
  input.inputMode = 'numeric'
  input.className = 'rounded border border-[var(--line)] bg-black/30 px-2 py-1.5 text-ink outline-none'
  input.value = String(Math.round(status.opacity * 100))
  input.setAttribute('aria-label', question)
  const hint = document.createElement('div')
  hint.className = 'min-h-[1.2em] text-[12px] text-dim'
  hint.textContent = '100 is solid. A dimmer board lets the program under it show through.'
  panel.append(label, input, hint)
  root.append(panel)
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) closeForm()
  })
  input.addEventListener('keydown', (e) => {
    // Typing stays here: the app's own keys (and Esc closing views behind) must not also fire.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      closeForm()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opacity = parseOpacityPercent(input.value)
      if (opacity === null) {
        hint.textContent = `Enter a number from ${OPACITY_MIN_PERCENT} to 100.`
        hint.className = 'min-h-[1.2em] text-[12px] text-danger'
        return
      }
      closeForm()
      void applyOpacity(opacity)
    }
  })
  document.body.append(root)
  form = { root, input }
  // After the palette that ran the command has closed and given the focus up.
  setTimeout(() => {
    input.focus()
    input.select()
  }, 0)
}

/* ------------------------------------------------------------------ */
/* Palette, key, cheatsheet                                           */
/* ------------------------------------------------------------------ */

/** `w`: bring the window's board back, else pop the docked one out. */
function toggleWindow(): void {
  const docked = dockedBoard()
  if (status.open) void dockBoard()
  else if (docked) void popOutBoard(docked)
  else toast('Open a board first (8), then w pops it out into its own window')
}

if (bridge) {
  bridge.onBoardState(setStatus)
  bridge.onBoardClosed((path) => {
    // One view's failure must not keep the others from taking their board back.
    for (const cb of [...returned]) {
      try {
        cb(path)
      } catch (err) {
        console.warn('[aether] board returned handler failed', err)
      }
    }
  })
  bridge.boardStatus().then(setStatus, () => undefined)
  registerKey('w', toggleWindow)
  registerCommands([
    {
      id: 'board-window-pop-out',
      title: 'Board: Pop out to its own window',
      hint: 'stays on top of other windows',
      keys: 'w',
      group: 'view',
      when: () => {
        const path = dockedBoard()
        return path !== null && !isOut(status, path)
      },
      run: () => {
        const path = dockedBoard()
        return path ? void popOutBoard(path) : undefined
      },
    },
    {
      id: 'board-window-dock',
      title: 'Board: Bring the board back from its window',
      keys: 'w',
      group: 'view',
      when: () => status.open,
      run: () => dockBoard(),
    },
    {
      id: 'board-window-on-top',
      title: 'Board: Always on top',
      hint: 'on or off for the board window',
      group: 'view',
      run: () => toggleOnTop(),
    },
    {
      id: 'board-window-opacity',
      title: 'Board: Window opacity…',
      hint: 'Windows and macOS',
      group: 'view',
      // Linux compositors may ignore it, so main does not offer it there.
      when: () => status.supportsOpacity,
      run: () => openForm(),
    },
  ])
  registerHelpRows('Desktop', [['w', 'Board: pop the open board out into its own window, or bring it back']])
}
