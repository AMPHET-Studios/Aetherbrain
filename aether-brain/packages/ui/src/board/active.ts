/**
 * Two small registries that join the pieces of the board without importing each other:
 *  - the ACTIVE BOARD: the mounted board view announces itself, so the palette (commands.ts), the docked host and the pop-out code can
 *    run a board command, read its state or flush its save without a reference to the React tree;
 *  - the BOARD WINDOW CONTROL: the desktop app (apps/desktop/src/renderer/board.ts) announces how the floating window is driven, so the
 *    docked boards view in packages/ui can offer "pop out" and show "this board is open in its window" without importing the desktop app.
 * Plain module state with subscriptions; nothing here touches the DOM.
 */
import type { BoardCommandId, BoardUiState } from './api'

export interface ActiveBoard {
  /** The board's note path. */
  path: string
  exec(id: BoardCommandId, arg?: unknown): void
  state(): BoardUiState
  /**
   * Write any change not yet saved (a note being typed included). Never rejects. Resolves true when everything is on disk, false when
   * something could not be saved (the caller must then not move or close the board without telling the user).
   */
  flush(): Promise<boolean>
}

let active: ActiveBoard | null = null
const activeSubs = new Set<() => void>()

export function setActiveBoard(board: ActiveBoard | null): void {
  active = board
  for (const cb of [...activeSubs]) cb()
}

export function getActiveBoard(): ActiveBoard | null {
  return active
}

export function subscribeActiveBoard(cb: () => void): () => void {
  activeSubs.add(cb)
  return () => activeSubs.delete(cb)
}

/** What the desktop app tells the docked boards view about the floating window. */
export interface BoardWindowStatus {
  open: boolean
  /** The board shown in the window, or null. */
  path: string | null
  alwaysOnTop: boolean
  /** 0.2 to 1. */
  opacity: number
  supportsOpacity: boolean
}

export interface BoardWindowControl {
  /** The floating window exists on this platform (always true on the desktop). */
  available: boolean
  status(): BoardWindowStatus
  subscribe(cb: () => void): () => void
  /** Open this board in the floating window; resolves false when it was refused (not a board, no vault ...). */
  popOut(path: string): Promise<boolean>
  /** Close the floating window and give its board back. */
  dock(): Promise<void>
  setAlwaysOnTop(on: boolean): Promise<void>
  setOpacity(opacity: number): Promise<void>
  /** Called with the path of a board whose window just closed (reload it from disk). Returns the unsubscribe. */
  onReturned(cb: (path: string) => void): () => void
  /**
   * The docked view registers how to flush its pending save, which popOut awaits first. A result of false (or a throw) means the board
   * could not be saved: popOut then refuses. Returns the unregister function.
   */
  setFlush(fn: (() => Promise<boolean | void> | boolean | void) | null): () => void
}

let windowControl: BoardWindowControl | null = null
const windowSubs = new Set<() => void>()

export function setBoardWindowControl(control: BoardWindowControl | null): void {
  windowControl = control
  for (const cb of [...windowSubs]) cb()
}

export function getBoardWindowControl(): BoardWindowControl | null {
  return windowControl
}

export function subscribeBoardWindowControl(cb: () => void): () => void {
  windowSubs.add(cb)
  return () => windowSubs.delete(cb)
}
