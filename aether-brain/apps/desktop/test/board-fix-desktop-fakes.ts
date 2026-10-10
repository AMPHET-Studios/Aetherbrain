/**
 * Fake windows for the board window's tests that are about its close and its page (board-fix-desktop-*.test.ts). A page here answers
 * `board:flush` the way a real one does when told to (through the gate, with the token), and `close()` honours `preventDefault()`
 * the way Electron's does.
 */
import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import { BoardWindowHost, FlushGate, type BoardElectron, type BoardSettings } from '../src/main/board-window.js'
import { IPC } from '../src/shared/ipc.js'

let nextId = 500

export class FakePage extends EventEmitter {
  readonly id = nextId++
  sent: [string, unknown[]][] = []
  destroyed = false
  crashed = false
  /** A loaded page (the handshake only waits for one). */
  loading = false
  reloads = 0
  /** The page zoom (Electron: 1 is 100%), and the pinch limits last asked for. */
  zoom = 1
  zoomLimits: [number, number] | null = null
  openHandler: ((d: { url: string }) => { action: string }) | null = null
  /** What the page does when main asks it to save: called with the token. Default: nothing (a page that never answers). */
  onFlush: ((token: number) => void) | null = null
  send(channel: string, ...args: unknown[]): void {
    this.sent.push([channel, args])
    if (channel === IPC.boardFlush) this.onFlush?.(args[0] as number)
  }
  setWindowOpenHandler(fn: (d: { url: string }) => { action: string }): void {
    this.openHandler = fn
  }
  reload(): void {
    this.reloads++
  }
  getZoomFactor(): number {
    return this.zoom
  }
  setZoomFactor(f: number): void {
    this.zoom = f
  }
  setVisualZoomLevelLimits(min: number, max: number): Promise<void> {
    this.zoomLimits = [min, max]
    return Promise.resolve()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isCrashed(): boolean {
    return this.crashed
  }
  isLoading(): boolean {
    return this.loading
  }
  on_(channel: string): unknown[][] {
    return this.sent.filter(([c]) => c === channel).map(([, a]) => a)
  }
}

export class FakeWin extends EventEmitter {
  static made: FakeWin[] = []
  readonly webContents = new FakePage()
  loaded: { url?: string; file?: string; query?: Record<string, string> }[] = []
  gone = false
  visible = false
  closeCalls = 0
  closeEvents = 0
  bounds = { x: 100, y: 80, width: 800, height: 600 }
  onTop: [boolean, string | undefined][] = []
  allWorkspaces: [boolean, unknown][] = []
  loadError: (Error & { code?: string }) | null = null
  /** What `setMenu` was given (Electron: the window's own menu, Windows and Linux). */
  menus: unknown[] = []
  constructor(readonly options: Record<string, unknown> = {}) {
    super()
  }
  isDestroyed(): boolean {
    return this.gone
  }
  isMinimized(): boolean {
    return false
  }
  isVisible(): boolean {
    return this.visible
  }
  restore(): void {}
  focus(): void {}
  setMenu(menu: unknown): void {
    this.menus.push(menu)
  }
  show(): void {
    this.visible = true
  }
  setAlwaysOnTop(flag: boolean, level?: string): void {
    this.onTop.push([flag, level])
  }
  setVisibleOnAllWorkspaces(on: boolean, options?: unknown): void {
    this.allWorkspaces.push([on, options])
  }
  setOpacity(): void {}
  getNormalBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.bounds }
  }
  /** Electron: 'close' first (a listener may prevent it), then the window is destroyed and 'closed' follows. */
  close(): void {
    if (this.gone) return
    this.closeCalls++
    let prevented = false
    this.closeEvents++
    this.emit('close', { preventDefault: () => void (prevented = true) })
    if (!prevented) this.destroy()
  }
  destroy(): void {
    if (this.gone) return
    this.gone = true
    this.webContents.destroyed = true
    this.webContents.emit('destroyed')
    this.emit('closed')
  }
  loadURL(url: string): Promise<void> {
    this.loaded.push({ url })
    return this.loadError ? Promise.reject(this.loadError) : Promise.resolve()
  }
  loadFile(file: string, opts?: { query?: Record<string, string> }): Promise<void> {
    this.loaded.push({ file, ...(opts?.query ? { query: opts.query } : {}) })
    return this.loadError ? Promise.reject(this.loadError) : Promise.resolve()
  }
}

export const BOARD = 'Boards/Gate.md'
export const OTHER = 'Boards/Rust.md'
export const PAGE = '/app/dist/renderer/board.html'

export interface Rig {
  host: BoardWindowHost
  gate: FlushGate
  brain: FakeWin
  shell: { openExternal: ReturnType<typeof vi.fn> }
  dialog: { showMessageBox: ReturnType<typeof vi.fn> }
  /** The settings saved so far (position, size ...). */
  saved: BoardSettings[]
  /** The latest board window. */
  win: FakeWin
  /** Make every board window's page answer `board:flush` after `ms` (0: at once, inside the send), or never (null). */
  answers(ms: number | null): void
}

/** A host over fake windows. `answer`: how the board page behaves when asked to save (default: it answers at once). */
export function rig(opts: { platform?: NodeJS.Platform; answer?: number | null; devUrl?: string | null; settings?: Partial<BoardSettings>; menu?: boolean } = {}): Rig {
  FakeWin.made = []
  const brain = new FakeWin()
  const gate = new FlushGate()
  let answer: number | null = opts.answer === undefined ? 0 : opts.answer
  const saved: BoardSettings[] = []
  const shell = { openExternal: vi.fn(async () => undefined) }
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })) }
  const display = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
  const electron = {
    BrowserWindow: class extends FakeWin {
      constructor(o: Record<string, unknown>) {
        super(o)
        FakeWin.made.push(this)
        this.webContents.onFlush = (token) => {
          if (answer === null) return
          if (answer === 0) gate.ack(this.webContents.id, token)
          else setTimeout(() => gate.ack(this.webContents.id, token), answer)
        }
      }
    },
    screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display },
    shell,
    dialog,
    // Electron's Menu in miniature: the menu is the template it was built from.
    ...(opts.menu === false ? {} : { Menu: { buildFromTemplate: (template: unknown) => ({ template }) } }),
  } as unknown as BoardElectron
  const host = new BoardWindowHost({
    electron,
    settings: { width: 640, height: 480, alwaysOnTop: true, opacity: 1, ...opts.settings } as BoardSettings,
    save: (s) => void saved.push(s),
    brain: () => brain as never,
    preload: '/app/dist/preload/board-preload.cjs',
    devUrl: opts.devUrl ?? null,
    pageFile: PAGE,
    platform: opts.platform ?? 'win32',
    gate,
  })
  return {
    host,
    gate,
    saved,
    brain,
    shell,
    dialog,
    get win(): FakeWin {
      const w = FakeWin.made.at(-1)
      if (!w) throw new Error('no board window was made')
      return w
    },
    answers: (ms) => void (answer = ms),
  }
}
