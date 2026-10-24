/**
 * The reference board's floating window: one window, opened on a board note, that stays on top of the user's painting program, can
 * be dimmed (Windows, macOS), and remembers where it was. It shows `board.html` (the board view only) with a preload of its own
 * (board-preload.cts: the board calls, the pictures, nothing else) in the default session as the brain window, so it has the brain
 * window's network block and permission refusals. It never opens a vault: it reads and saves the board it shows, and only that one,
 * through `board:read` / `board:save` (see board-save.ts; main refuses the page any other path, `pageRefusal`) and its pictures through
 * the picture calls; main answers it no other channel (BOARD_PAGE_CHANNELS, guardIpc). It has a menu of its own with two items and no
 * browser chords (reload, zoom, DevTools, full screen): a painting program's window is not a browser.
 *
 * The window belongs to the brain window: it closes with it, and tells it (`board:closed`, with the board's path) when it closes
 * or moves on to another board, so the docked view takes the board back. Both windows hear `board:state` whenever the window
 * opens, closes or changes its settings.
 *
 * Nothing the user did is lost to a close. A window's first `close` is held while its page is asked to save what it has not saved
 * (FlushGate: `board:flush`, answered with `board:flushed`, 1.5 s at most; a page that died or does not answer holds nothing), then
 * the close goes through. The same wait precedes moving the window to another board, a vault switch and quitting.
 *
 * No electron import at runtime (types only), like ForgeHost and Thumbnailer: main.ts hands in the Electron modules, and the checks
 * (settings, bounds, options, navigation) are pure functions.
 */
import type { BrowserWindow, BrowserWindowConstructorOptions, Dialog, Display, Menu, MenuItemConstructorOptions, Screen, Shell, WebContents } from 'electron'
import { IPC, type AssetListDto, type BoardConfigureDto, type BoardSaveResult, type BoardStatusDto, type VaultAssetDto, type VaultChangeDto } from '../shared/ipc.js'
import { MAX_BOARD_TEXT, boardNoteVerdict, checkBoard, readBoard, saveBoard, type BoardVault } from './board-save.js'
import { BOARD_WINDOW_NAME, CRASH_WINDOW_MS, crashMessage, shouldReload } from './crash.js'
import { forgeNavigation } from './forge.js'
import { isImageName, isMediaName, isModelName } from './fsvault.js'

export const BOARD_TITLE = 'Aether Brain — Board'
/** Smallest window: a board you cannot see is no board (at 320 x 240 the toolbar wrapped to three rows and left 72 px of canvas). */
export const BOARD_MIN_WIDTH = 480
export const BOARD_MIN_HEIGHT = 320
/** The size of the first window (a landscape sheet, like most pictures), before the user has resized it. */
export const BOARD_DEFAULT_WIDTH = 640
export const BOARD_DEFAULT_HEIGHT = 480
/** Largest size or distance taken from settings.json (a damaged or hand-edited file must not make a window of a million pixels). */
const BOARD_MAX_SIZE = 16_384
const BOARD_MAX_COORD = 100_000
/** The dimmest a window gets: below this it cannot be found again. */
export const BOARD_MIN_OPACITY = 0.2
/** The position and size are saved this long (ms) after the last move or resize. */
export const BOARD_SAVE_MS = 500
/** A window that has not said it is ready to show after this long (ms) is shown anyway (the brain window does the same). */
export const BOARD_REVEAL_MS = 1200
/** The longest a close, a quit or a move waits for a page to save what it has (ms). */
export const FLUSH_WAIT_MS = 1500
/** A page that navigated away is brought back at most this many times within NAV_FIX_WINDOW_MS (ms). */
const NAV_FIXES = 3
const NAV_FIX_WINDOW_MS = 10_000
/** Longest board path taken from the bridge. */
const MAX_PATH = 4096

/* ------------------------------------------------------------------ */
/* Settings, bounds, options (pure)                                   */
/* ------------------------------------------------------------------ */

/** Persisted in settings.json under `board`. */
export interface BoardSettings {
  /** Top-left corner of the window; absent until the window has been placed (then it opens centred). */
  x?: number
  y?: number
  width: number
  height: number
  alwaysOnTop: boolean
  /** 0.2 to 1. */
  opacity: number
}

/** A rectangle on the screen: a display's work area, or a window. */
export interface Area {
  x: number
  y: number
  width: number
  height: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function size(v: unknown, min: number, fallback: number): number {
  return finite(v) ? Math.min(BOARD_MAX_SIZE, Math.max(min, Math.round(v))) : fallback
}

/** `v` as an opacity: 0.2 to 1, two decimals. NaN is no opacity at all (null). */
export function clampOpacity(v: unknown): number | null {
  if (typeof v !== 'number' || Number.isNaN(v)) return null
  return Math.round(Math.min(1, Math.max(BOARD_MIN_OPACITY, v)) * 100) / 100
}

/**
 * Settings from disk with defaults filled in and everything made sane: sizes between the smallest window and 16,384, a position
 * only when both coordinates are numbers (within 100,000 of the origin), opacity 0.2 to 1, always on top unless it says `false`.
 */
export function boardSettings(raw: unknown): BoardSettings {
  const r = isRecord(raw) ? raw : {}
  const out: BoardSettings = {
    width: size(r['width'], BOARD_MIN_WIDTH, BOARD_DEFAULT_WIDTH),
    height: size(r['height'], BOARD_MIN_HEIGHT, BOARD_DEFAULT_HEIGHT),
    alwaysOnTop: r['alwaysOnTop'] !== false,
    opacity: clampOpacity(r['opacity']) ?? 1,
  }
  const x = r['x']
  const y = r['y']
  if (finite(x) && finite(y) && Math.abs(x) <= BOARD_MAX_COORD && Math.abs(y) <= BOARD_MAX_COORD) {
    out.x = Math.round(x)
    out.y = Math.round(y)
  }
  return out
}

/** Window opacity works on Windows and macOS with a normal frame; elsewhere the compositor may ignore it, so it is not offered. */
export function supportsOpacity(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

const validArea = (a: Area): boolean => finite(a.x) && finite(a.y) && finite(a.width) && finite(a.height) && a.width > 0 && a.height > 0

/** The overlap of two rectangles, in pixels squared. */
function overlap(a: Area, b: Area): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Where the window goes: wholly inside the work area of one display, and at least 480 × 320. The display is the one the saved
 * window overlaps most; a window saved off every display (a monitor that is gone) is centred on the first one, and so is one
 * that was never placed. A saved size larger than the display is cut to it. `areas` lists the displays' work areas, the primary
 * first. With no display at all the saved numbers come back as they are.
 */
export function clampBoardBounds(saved: { x?: number; y?: number; width: number; height: number }, areas: readonly Area[]): Area {
  const list = areas.filter(validArea)
  const primary = list[0]
  const width = finite(saved.width) ? Math.max(BOARD_MIN_WIDTH, Math.round(saved.width)) : BOARD_DEFAULT_WIDTH
  const height = finite(saved.height) ? Math.max(BOARD_MIN_HEIGHT, Math.round(saved.height)) : BOARD_DEFAULT_HEIGHT
  if (!primary) return { x: saved.x ?? 0, y: saved.y ?? 0, width, height }
  const placed = finite(saved.x) && finite(saved.y)
  let area = primary
  let onScreen = false
  if (placed) {
    const rect = { x: saved.x as number, y: saved.y as number, width, height }
    let best = 0
    for (const a of list) {
      const o = overlap(rect, a)
      if (o > best) {
        best = o
        area = a
        onScreen = true
      }
    }
  }
  const w = Math.max(BOARD_MIN_WIDTH, Math.min(width, area.width))
  const h = Math.max(BOARD_MIN_HEIGHT, Math.min(height, area.height))
  if (!onScreen) {
    return { x: Math.round(area.x + (area.width - w) / 2), y: Math.round(area.y + (area.height - h) / 2), width: w, height: h }
  }
  // A window larger than the area (a tiny screen) is pinned to its top-left corner.
  const x = Math.max(area.x, Math.min(saved.x as number, area.x + area.width - w))
  const y = Math.max(area.y, Math.min(saved.y as number, area.y + area.height - h))
  return { x: Math.round(x), y: Math.round(y), width: w, height: h }
}

/**
 * The options of the window: placed by `clampBoardBounds`, a normal frame, on top and dimmed as the settings say (dimmed only where
 * the platform can), hidden until it is ready, and the brain window's web preferences but for the preload (the board's own): no
 * partition (the default session, so its network block and permission refusals apply), sandboxed and isolated, no Node.
 */
export function boardWindowOptions(
  settings: BoardSettings,
  platform: NodeJS.Platform,
  areas: readonly Area[],
  preload: string,
): BrowserWindowConstructorOptions {
  return {
    ...clampBoardBounds(settings, areas),
    minWidth: BOARD_MIN_WIDTH,
    minHeight: BOARD_MIN_HEIGHT,
    backgroundColor: '#04050d',
    title: BOARD_TITLE,
    show: false,
    // A small floating window gives its height to the board: the menu bar comes back with Alt.
    autoHideMenuBar: true,
    // The first click on a window behind the painting program is a click on the board, not only a focus.
    acceptFirstMouse: true,
    alwaysOnTop: settings.alwaysOnTop,
    ...(supportsOpacity(platform) ? { opacity: settings.opacity } : {}),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  }
}

/** The work areas of the displays, the primary first. */
export function workAreasOf(screen: Pick<Screen, 'getAllDisplays' | 'getPrimaryDisplay'>): Area[] {
  // A session with no monitor attached may have no primary display to name; the bounds then stay as saved (clampBoardBounds).
  const primary = screen.getPrimaryDisplay() as Display | undefined
  return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary?.id)].flatMap((d) => (d?.workArea ? [{ ...d.workArea }] : []))
}

/** The page in the dev server: `<dev server>/board.html?path=<board path>`. */
export function boardPageUrl(devUrl: string, boardPath: string): string {
  const url = new URL('board.html', devUrl.endsWith('/') ? devUrl : `${devUrl}/`)
  url.searchParams.set('path', boardPath)
  return url.href
}

/**
 * Whether the window may navigate to `url`: only to its own page (the dev server's origin, or the built board.html with any
 * query), nothing else. A picture dropped outside the board would otherwise open in the window and take the board away.
 */
export function boardNavigationAllowed(url: string, page: { devUrl: string | null | undefined; file: string }): boolean {
  if (page.devUrl) {
    try {
      const target = new URL(url)
      const dev = new URL(page.devUrl)
      // Same scheme as well as same origin: `blob:http://localhost:5174/..` carries the dev server's origin and is not its page, and
      // an opaque origin ("null": file:, data:) equals every other opaque origin.
      return dev.origin !== 'null' && target.protocol === dev.protocol && target.origin === dev.origin
    } catch {
      return false
    }
  }
  return forgeNavigation(url, page.file) === 'allow'
}

/** The board path of a `board:open` call as it crossed IPC; throws a message for anything else than a text `.md` path. */
export function cleanBoardPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_PATH || raw.includes('\0')) throw new Error('A board needs a vault path')
  if (!/\.md$/i.test(raw)) throw new Error(`Only markdown notes can be boards: ${raw.slice(0, 120)}`)
  return raw
}

/** The fields of a `board:configure` call that are well typed; opacity is dropped where the platform cannot dim a window. */
export function cleanConfigure(raw: unknown, platform: NodeJS.Platform): BoardConfigureDto {
  const r = isRecord(raw) ? raw : {}
  const out: BoardConfigureDto = {}
  if (typeof r['alwaysOnTop'] === 'boolean') out.alwaysOnTop = r['alwaysOnTop']
  const opacity = clampOpacity(r['opacity'])
  if (opacity !== null && supportsOpacity(platform)) out.opacity = opacity
  return out
}

/**
 * The window's own menu (Windows and Linux; on macOS the application menu serves every window): Close with Ctrl+W, which goes through
 * the close handshake like any close, and the Edit roles (a note box undoes, cuts, copies and pastes). Nothing else: Electron's default
 * menu carries Reload (Ctrl+R, Ctrl+Shift+R), Toggle Developer Tools (Ctrl+Shift+I), Full Screen (F11) and the page zoom (Ctrl +, Ctrl -),
 * which in a small always-on-top window over a painting program reload the board under the user's hands, zoom the whole page, or
 * cover the screen. The board has its own keys for its own zoom (`+`, `-`, `1`).
 */
export function boardMenuTemplate(close: () => void): MenuItemConstructorOptions[] {
  return [
    { label: 'Window', submenu: [{ label: 'Close', accelerator: 'CmdOrCtrl+W', click: close }] },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
  ]
}

/** A key press that would zoom the page (Ctrl or Cmd with +, -, = or 0): the page is never zoomed, it draws its own board at its own scale. */
export function isPageZoomChord(input: { type?: string; key?: string; control?: boolean; meta?: boolean; alt?: boolean }): boolean {
  return input.type === 'keyDown' && (input.control === true || input.meta === true) && input.alt !== true && ['+', '-', '=', '_', '0'].includes(input.key ?? '')
}

/* ------------------------------------------------------------------ */
/* Who may call what                                                  */
/* ------------------------------------------------------------------ */

/**
 * The only channels main answers to the board window's page: the board note (read, save, assets), the window's own settings and
 * close, the pictures (previews, whole pictures, new pictures, open and show in the folder), the clipboard, and the answer to a flush.
 * Everything else (the vault's notes, folders and roots, the chat, the librarian, the AI link, the Forge, opening another board)
 * is refused to that window whatever its preload exposes: a page that was taken over by a picture that breaks the decoder
 * can still send any channel name by hand, and this list is what stops it. board-preload.cts exposes exactly these (a test pins
 * the two lists together). The list says which calls; `BoardWindowHost.pageRefusal` says what they may name (the board the window
 * shows for `board:read` and `board:save`, a picture or that board for `vault:reveal`).
 */
export const BOARD_PAGE_CHANNELS: ReadonlySet<string> = new Set<string>([
  IPC.boardClose,
  IPC.boardStatus,
  IPC.boardConfigure,
  IPC.boardSave,
  IPC.boardRead,
  IPC.boardAssets,
  IPC.boardFlushed,
  IPC.thumb,
  IPC.modelProxy,
  IPC.readAsset,
  IPC.readAssetChecked,
  IPC.createAsset,
  IPC.openAsset,
  IPC.reveal,
  IPC.copy,
])

/** Whether a message on `channel` from a page may be answered: the brain window (and every other sender) keeps everything, the board window gets its own list. */
export function channelAllowed(fromBoardWindow: boolean, channel: string): boolean {
  return !fromBoardWindow || BOARD_PAGE_CHANNELS.has(channel)
}

/** What guardIpc needs of Electron's `ipcMain` and of the sender of a message. */
export interface IpcLike {
  handle(channel: string, listener: (event: { sender: WebContents }, ...args: unknown[]) => unknown): void
  on(channel: string, listener: (event: { sender: WebContents }, ...args: unknown[]) => void): void
}

/**
 * `ipcMain` with the check in front of every handler: a message from the board window's page (`isBoardPage`) on a channel outside
 * BOARD_PAGE_CHANNELS is refused (a `handle` call rejects with the reason, a `send` is dropped) before the handler runs. So is one
 * on a channel inside it whose arguments `refuse` (BoardWindowHost.pageRefusal) turns down: it answers the reason, or null. Only the
 * board window's page is judged; every other sender keeps everything. main.ts registers every channel through this and through
 * nothing else.
 */
export function guardIpc(
  ipc: IpcLike,
  isBoardPage: (sender: WebContents) => boolean,
  refuse?: (channel: string, args: readonly unknown[]) => string | null,
): IpcLike {
  return {
    handle(channel, listener) {
      ipc.handle(channel, (e, ...args) => {
        const page = isBoardPage(e.sender)
        if (!channelAllowed(page, channel)) throw new Error(`The board window may not use ${channel}`)
        const why = page ? (refuse?.(channel, args) ?? null) : null
        if (why !== null) throw new Error(why)
        return listener(e, ...args)
      })
    },
    on(channel, listener) {
      ipc.on(channel, (e, ...args) => {
        const page = isBoardPage(e.sender)
        if (channelAllowed(page, channel) && !(page && (refuse?.(channel, args) ?? null) !== null)) listener(e, ...args)
      })
    },
  }
}

/* ------------------------------------------------------------------ */
/* Saving before a window goes                                        */
/* ------------------------------------------------------------------ */

/** What the gate needs of a window's page (an Electron WebContents has all of it; `isCrashed` and `isLoading` may be absent). */
export interface FlushPage {
  readonly id: number
  isDestroyed(): boolean
  isCrashed?(): boolean
  isLoading?(): boolean
  send(channel: string, ...args: unknown[]): void
  once(event: 'destroyed' | 'render-process-gone', listener: () => void): unknown
  off?(event: 'destroyed' | 'render-process-gone', listener: () => void): unknown
}

/** What the gate needs of a window. */
export interface GatedWindow {
  isDestroyed(): boolean
  readonly webContents: FlushPage
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
  close(): void
}

/**
 * The close handshake. A page that has something it has not saved (a note being typed commits only when its box loses the focus) cannot
 * be trusted to finish a save while it is torn down: the write is a message to main and its answer, and a page that is gone sends
 * nothing more. So a window's first `close` is held (`guardClose`): main sends the page `board:flush` with a token, the page saves
 * (`await getActiveBoard()?.flush()`) and answers `board:flushed` with the token, and only then is the close let through. It waits
 * `ms` (1.5 s) at most, and not at all for a page that is gone, crashed or still loading, so a broken page never holds a window
 * or the app.
 */
export class FlushGate {
  private seq = 0
  private waiting = new Map<number, { page: number; done: (ok: boolean) => void }>()
  /** Closes pass until this time (ms): the app is quitting and has just had every page save. */
  private openUntil = 0

  constructor(
    private readonly ms: number = FLUSH_WAIT_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Whether a page can be asked to save at all. */
  askable(page: FlushPage): boolean {
    try {
      return !page.isDestroyed() && !(page.isCrashed?.() ?? false) && !(page.isLoading?.() ?? false)
    } catch {
      return false
    }
  }

  /** Ask `page` to save; resolves true when it said it had, false when it could not be asked, died, or did not answer in time. */
  ask(page: FlushPage): Promise<boolean> {
    if (!this.askable(page)) return Promise.resolve(false)
    const token = ++this.seq
    return new Promise<boolean>((resolve) => {
      const gone = (): void => finish(false)
      const timer = setTimeout(() => finish(false), this.ms)
      const finish = (ok: boolean): void => {
        clearTimeout(timer)
        this.waiting.delete(token)
        try {
          page.off?.('destroyed', gone)
          page.off?.('render-process-gone', gone)
        } catch {
          /* the page is gone */
        }
        resolve(ok)
      }
      this.waiting.set(token, { page: page.id, done: finish })
      try {
        page.once('destroyed', gone)
        page.once('render-process-gone', gone)
        page.send(IPC.boardFlush, token)
      } catch {
        finish(false)
      }
    })
  }

  /** `board:flushed`: the page `senderId` saved. A token that is not waiting, or that another page was asked, does nothing. */
  ack(senderId: number, token: unknown): void {
    const wait = typeof token === 'number' ? this.waiting.get(token) : undefined
    if (wait && wait.page === senderId) wait.done(true)
  }

  /** Let closes through for the next few seconds (every page was just asked to save, because the app is quitting). */
  openFor(ms: number): void {
    this.openUntil = this.clock() + ms
  }

  private open(): boolean {
    return this.clock() < this.openUntil
  }

  /**
   * Hold the first `close` of `win` until its page has saved; the close that follows goes through. A second close while it waits
   * changes nothing. `before` runs on every close event (the board window keeps its place there).
   */
  guardClose(win: GatedWindow, before?: () => void): void {
    let waiting = false
    // Set when the page has saved and the window is closed again: that close (and only that one) goes through.
    let released = false
    win.on('close', (e) => {
      before?.()
      if (released) {
        released = false
        return
      }
      if (this.open() || !this.askable(win.webContents)) return
      e.preventDefault()
      if (waiting) return
      waiting = true
      void this.ask(win.webContents).then(() => {
        waiting = false
        released = true
        if (!win.isDestroyed()) win.close()
      })
    })
  }
}

/* ------------------------------------------------------------------ */
/* Pictures since the last scan (pure)                                */
/* ------------------------------------------------------------------ */

/** Pictures the ledger keeps at most (the scan's own cap): past it the list says it is partial. */
export const LEDGER_MAX = 200_000

/**
 * The vault's pictures as they are now, for the floating window. `listAssets` is the last scan's snapshot (a picture dropped into
 * a board a minute ago is not in it, and the board would draw it as missing): this keeps what the watcher reported since (and what
 * the app created), on top of the scan's list. Cleared when a scan finishes, because the new list contains all of it.
 *
 * `wanted` says which file names are its business: pictures (the board's), or with `isAssetName` pictures, videos and 3D models too
 * (the AI link's find_pictures lists all three).
 */
export class PictureLedger {
  /** Path → the picture as last reported, or null for one that was removed. */
  private delta = new Map<string, VaultAssetDto | null>()
  /** Changes were dropped for lack of room: the list is partial. */
  overflowed = false

  constructor(private readonly wanted: (name: string) => boolean = isImageName) {}

  clear(): void {
    this.delta.clear()
    this.overflowed = false
  }

  /** Remember the picture changes among `changes` (notes and folders are not its business; videos only when `wanted` takes them). */
  apply(changes: readonly VaultChangeDto[]): void {
    for (const c of changes) {
      if (c.kind === 'addDir' || c.kind === 'unlinkDir' || !this.wanted(c.path.slice(c.path.lastIndexOf('/') + 1))) continue
      if (c.kind === 'unlink') this.put(c.path, null)
      else this.put(c.path, { path: c.path, ...(c.mtime !== undefined ? { mtime: c.mtime } : {}), ...(c.size !== undefined ? { size: c.size } : {}) })
    }
  }

  /** A picture the app just created. */
  add(path: string, info: { mtime?: number; size?: number } = {}): void {
    this.put(path, { path, ...info })
  }

  private put(path: string, value: VaultAssetDto | null): void {
    if (!this.delta.has(path) && this.delta.size >= LEDGER_MAX) {
      this.overflowed = true
      return
    }
    this.delta.set(path, value)
  }

  /** The scan's pictures with the removed ones taken out, the changed ones as last reported, and the new ones added. */
  list(scan: readonly { path: string }[]): VaultAssetDto[] {
    const out: VaultAssetDto[] = []
    const seen = new Set<string>()
    for (const a of scan) {
      if (!this.wanted(a.path.slice(a.path.lastIndexOf('/') + 1))) continue
      const d = this.delta.get(a.path)
      if (d === null) continue
      out.push(d ?? { path: a.path })
      seen.add(a.path)
    }
    for (const [p, d] of this.delta) if (d && !seen.has(p)) out.push(d)
    return out
  }
}

/** The picture additions, changes and removals among `changes`, without content: what the floating window is sent. */
export function pictureChanges(changes: readonly VaultChangeDto[]): VaultChangeDto[] {
  const out: VaultChangeDto[] = []
  for (const c of changes) {
    if (c.kind === 'addDir' || c.kind === 'unlinkDir' || !isImageName(c.path.slice(c.path.lastIndexOf('/') + 1))) continue
    out.push({ kind: c.kind, path: c.path, ...(c.mtime !== undefined ? { mtime: c.mtime } : {}), ...(c.size !== undefined ? { size: c.size } : {}) })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* IPC handlers                                                       */
/* ------------------------------------------------------------------ */

/** What the board's IPC handlers need of the app (main.ts hands in its vault, last scan and ledger; tests hand in fakes). */
export interface BoardIpcContext {
  host: Pick<BoardWindowHost, 'open' | 'close' | 'status' | 'configure'>
  /** The open vault, or null before one is opened. */
  vault(): BoardVault | null
  /** The pictures of the last scan (names only), or null before one. */
  scan(): { assets: readonly { path: string }[]; assetsTruncated: boolean } | null
  ledger: PictureLedger
}

/** The handler behind each `board:*` channel. Every argument arrives as `unknown`: it came over IPC and is checked here. */
export interface BoardHandlers {
  open(path: unknown): Promise<BoardStatusDto>
  /** Resolves once the window is gone (its page has saved first). */
  close(): Promise<void>
  status(): BoardStatusDto
  configure(patch: unknown): BoardStatusDto
  save(path: unknown, text: unknown, expectedBase?: unknown): Promise<BoardSaveResult>
  read(path: unknown): Promise<string | null>
  assets(): AssetListDto
}

/**
 * The handlers of `board:open`, `:close`, `:status`, `:configure`, `:save`, `:read` and `:assets`, as plain functions (main.ts only
 * wires them to the channels, so what they accept is tested without Electron). They are given no file watcher on purpose: a save
 * must be reported by it like any outside edit, and nothing here can tell it otherwise. The floating page's one write to a note is
 * `save`, over an existing board note (board-save.ts); it opens boards, never notes.
 */
export function boardHandlers(ctx: BoardIpcContext): BoardHandlers {
  return {
    async open(raw) {
      const path = cleanBoardPath(raw)
      // The window is made only for a board note that is there and short enough to be read in it: it would otherwise be an empty
      // page with a path, or a window with an error and one button.
      const found = await checkBoard(path, ctx.vault())
      if (!found.ok) throw new Error(found.reason)
      return ctx.host.open(path)
    },
    close: () => ctx.host.close(),
    status: () => ctx.host.status(),
    configure: (patch) => ctx.host.configure(patch),
    save: (path, text, expectedBase) => saveBoard({ path, text, ...(expectedBase !== undefined ? { expectedBase } : {}) }, ctx.vault()),
    read: (path) => readBoard(path, ctx.vault()),
    // The last scan's list plus what changed since: `listAssets` is the scan's snapshot, and a picture dropped into a board a minute
    // ago would be drawn in the window as a missing one. No stat: the board needs names, and the list can be 200,000 long. While
    // there is no finished scan (a vault just reopened rescans for minutes) the list is not known: it says it is partial, and the
    // window then draws no picture as missing.
    assets() {
      const scan = ctx.scan()
      return { assets: ctx.ledger.list(scan?.assets ?? []), truncated: scan === null || scan.assetsTruncated || ctx.ledger.overflowed }
    },
  }
}

/* ------------------------------------------------------------------ */
/* Host                                                               */
/* ------------------------------------------------------------------ */

/** The Electron modules the host uses (main.ts passes the real ones). */
export interface BoardElectron {
  BrowserWindow: new (options: BrowserWindowConstructorOptions) => BrowserWindow
  screen: Pick<Screen, 'getAllDisplays' | 'getPrimaryDisplay'>
  shell: Pick<Shell, 'openExternal'>
  dialog: Pick<Dialog, 'showMessageBox'>
  /** Makes the window's own menu (Windows, Linux); without it the window keeps Electron's default one. */
  Menu?: Pick<typeof Menu, 'buildFromTemplate'>
}

export interface BoardHostOptions {
  electron: BoardElectron
  settings: BoardSettings
  /** Persist the settings (position, size, on top, opacity); called after changes, not on every move. */
  save(settings: BoardSettings): Promise<void> | void
  /** The brain window, which the board window belongs to; null when closed. */
  brain(): BrowserWindow | null
  /** Absolute path of the built board-preload.cjs: the board page's own bridge (not the brain window's). */
  preload: string
  /** The Vite dev server's address in development (VITE_DEV_SERVER_URL), else null. */
  devUrl?: string | null
  /** Absolute path of the built board.html (dist/renderer/board.html), loaded when there is no dev server. */
  pageFile: string
  platform?: NodeJS.Platform
  /** The close handshake, shared with main.ts (which also guards the brain window and the quit with it); the host makes its own when none is given. */
  gate?: FlushGate
}

export class BoardWindowHost {
  private settings: BoardSettings
  private win: BrowserWindow | null = null
  /** The board on show: the vault path of its note. */
  private shown: string | null = null
  /** The settings last handed to `save`, as text (an unchanged window is not written again). */
  private persisted: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  /** Opens run one after the other, so a second call never races the window the first is still making. */
  private queue: Promise<unknown> = Promise.resolve()
  private crashes: number[] = []
  /** When the page was last brought back after a navigation away (see `did-navigate`). */
  private navFixes: number[] = []
  /** Brain windows already hooked (closing one closes this window). */
  private hooked = new WeakSet<object>()
  private readonly platform: NodeJS.Platform
  readonly gate: FlushGate
  /** The ids of the board windows' pages (a message from one of them is judged against BOARD_PAGE_CHANNELS). Ids are never reused. */
  private pageIds = new Set<number>()
  /** The window shows over full-screen apps (macOS: setVisibleOnAllWorkspaces is set only when this changes, it hides the window for a moment). */
  private overFullScreen = false
  /**
   * The banner the page shows, as far as main knows it: a notice `forward` raised because the note is gone or no longer reads as a board
   * ('note': it is taken back when the note reads as a board again), or the one for a rename the window could not follow ('lost': it
   * stays, the page shows a path that is no longer the board's). The page's banner is lost with the page, so a new board resets it.
   */
  private notice: 'note' | 'lost' | null = null
  /** The window whose close is under way (the handshake holds it while its page saves): a board opened meanwhile waits for it to go. */
  private closing: BrowserWindow | null = null

  constructor(private opts: BoardHostOptions) {
    this.settings = boardSettings(opts.settings)
    this.persisted = JSON.stringify(this.settings)
    this.platform = opts.platform ?? process.platform
    this.gate = opts.gate ?? new FlushGate()
  }

  /** Whether `wc` is the page of a board window (main.ts judges every message against it). */
  isBoardPage(wc: { id: number }): boolean {
    return this.pageIds.has(wc.id)
  }

  /**
   * Why a call from the board window's page, on a channel it may use, must be refused for what it names, or null when it may go on.
   * The page reads and saves the board the window shows and no other board note of the vault (`board:read`, `board:save`), and shows a
   * picture or a video, or that board, in the file manager (`vault:reveal`), never a note or a folder: a page that a broken decoder
   * took over would otherwise read and overwrite every board of the vault and learn which notes and folders exist. guardIpc applies
   * it to the board page's messages; the brain window is not judged (it has the whole vault already).
   */
  pageRefusal(channel: string, args: readonly unknown[]): string | null {
    const first = args[0]
    switch (channel) {
      case IPC.boardRead:
      case IPC.boardSave:
        return this.showsPath(first) ? null : 'The board window reads and saves only the board it shows'
      case IPC.reveal:
        return this.showsPath(first) || (typeof first === 'string' && isMediaName(first.slice(first.lastIndexOf('/') + 1)))
          ? null
          : 'The board window can show only pictures, videos and its own board in the file manager'
      case IPC.openAsset:
        // A board never opens a 3D model in the 3D app: that is the brain's, on its request.
        return typeof first === 'string' && isModelName(first.slice(first.lastIndexOf('/') + 1)) ? 'The board window opens pictures and videos only' : null
      case IPC.modelProxy:
        // A model on a board is turned by the page from the proxy main gives it (a bounded stand-in of up to 24,000 triangles): never the file.
        return typeof first === 'string' && isModelName(first.slice(first.lastIndexOf('/') + 1)) ? null : 'The board window can ask the proxy of a 3D model only'
      default:
        return null
    }
  }

  /** Whether `path` is the vault path of the note the window shows (the platform's way of comparing: not case-blind on Linux). */
  showsPath(path: unknown): boolean {
    return typeof path === 'string' && this.isShown(path)
  }

  status(): BoardStatusDto {
    const open = this.isOpen()
    const dims = supportsOpacity(this.platform)
    return {
      open,
      path: open ? this.shown : null,
      alwaysOnTop: this.settings.alwaysOnTop,
      opacity: dims ? this.settings.opacity : 1,
      supportsOpacity: dims,
    }
  }

  /**
   * `board:open`: show the board at `raw` in the window, which is made on the first call and reused after (it moves to the new
   * board; the old one is handed back to the brain window with `board:closed`). Whether the note is a board is for the caller.
   */
  async open(raw: unknown): Promise<BoardStatusDto> {
    const path = cleanBoardPath(raw)
    return this.serial(() => this.show(path))
  }

  /**
   * `board:close`: close the window. Its page is asked to save first (FlushGate), so this resolves once the window is gone and
   * whatever the user did in it is in the note (the window hands the board back to the docked view only then).
   */
  close(): Promise<void> {
    const w = this.live()
    if (!w) return Promise.resolve()
    return new Promise<void>((resolve) => {
      // A close that something else keeps from happening must not leave the caller waiting for ever.
      const timer = setTimeout(resolve, FLUSH_WAIT_MS * 2)
      w.once('closed', () => {
        clearTimeout(timer)
        resolve()
      })
      w.close()
    })
  }

  /** Ask the window's page to save what it has not saved, and wait for its answer (the app is quitting; main.ts then lets the closes of the quit through, `FlushGate.openFor`). */
  async flushPage(): Promise<void> {
    const w = this.live()
    if (w) await this.gate.ask(w.webContents)
  }

  /** The vault path of the note the window shows, or null. */
  shownPath(): string | null {
    return this.live() ? this.shown : null
  }

  private isShown(path: string): boolean {
    const shown = this.live() ? this.shown : null
    if (shown === null) return false
    return this.platform === 'linux' ? path === shown : path.toLowerCase() === shown.toLowerCase()
  }

  /** The note the window shows is about to be renamed away: its page saves first (to the note as it is called now). */
  async beforeMove(from: string): Promise<void> {
    const w = this.live()
    if (w && this.isShown(from)) await this.gate.ask(w.webContents)
  }

  /** The note the window shows was renamed to `to`: the window follows it (the page is loaded again on the new name). */
  async followMove(from: string, to: string): Promise<void> {
    const w = this.live()
    if (!w || !this.isShown(from)) return
    this.shown = to
    // The page is loaded again on the new name, and a banner it had goes with it.
    this.notice = null
    try {
      await this.load(w, to)
    } catch {
      this.notice = 'lost'
      this.tellGone(w, `The note was renamed to ${to}, and the window could not follow it. Close this window and open the board again.`)
      return
    }
    this.broadcast()
  }

  /** `board:gone` to the page: the banner's text, or null to take it down. */
  private tellGone(w: BrowserWindow, why: string | null): void {
    try {
      if (!w.isDestroyed()) w.webContents.send(IPC.boardGone, why)
    } catch {
      /* the board window went away mid-send */
    }
  }

  /** The note is gone or is no board: the banner says so (and keeps the rename notice, which says more). */
  private raiseNotice(w: BrowserWindow, why: string): void {
    if (this.notice === 'lost') return
    this.notice = 'note'
    this.tellGone(w, why)
  }

  /** The note reads as a board again: the banner `raiseNotice` put up comes down. Sent only when there is one. */
  private clearNotice(w: BrowserWindow): void {
    if (this.notice !== 'note') return
    this.notice = null
    this.tellGone(w, null)
  }

  /** `board:configure`: new settings (from either window), applied to the window if it is open and remembered. Returns the status. */
  configure(raw: unknown): BoardStatusDto {
    const patch = cleanConfigure(raw, this.platform)
    const w = this.live()
    let changed = false
    if (patch.alwaysOnTop !== undefined) {
      if (patch.alwaysOnTop !== this.settings.alwaysOnTop) changed = true
      this.settings.alwaysOnTop = patch.alwaysOnTop
      if (w) this.applyOnTop(w)
    }
    if (patch.opacity !== undefined) {
      if (patch.opacity !== this.settings.opacity) changed = true
      this.settings.opacity = patch.opacity
      if (w) w.setOpacity(patch.opacity)
    }
    if (changed) {
      this.scheduleSave()
      this.broadcast()
    }
    return this.status()
  }

  /**
   * Hand the board window what it follows of the vault's changes (it is not the brain window and gets no `onChanges` of its own):
   * the pictures that came, went or changed, without any note text, and the changes of the board it shows, content included, so it
   * hears of an edit made elsewhere.
   */
  forward(changes: readonly VaultChangeDto[]): void {
    const w = this.live()
    if (!w) return
    const out = pictureChanges(changes)
    const shown = this.shown
    if (shown !== null) {
      const same = (p: string) => (this.platform === 'linux' ? p === shown : p.toLowerCase() === shown.toLowerCase())
      for (const c of changes) {
        if (c.kind === 'addDir' || c.kind === 'unlinkDir' || !same(c.path)) continue
        out.push(c)
        // The note is gone, or is no longer one the window could save to: say so (a toast of a few seconds is not enough), and take it
        // back when the note is a board again (a sync tool or an editor that writes in place, a delete and a re-create, a draft typed
        // through `type: boa`). In order, so that a delete and its re-create in one batch end with no banner. A note over the window's
        // limit is no note it can save to, so it does not take the banner down.
        if (c.kind === 'unlink') this.raiseNotice(w, 'The note of this board was deleted or moved away, so nothing done in this window is saved any more. Bring the board back to leave it.')
        else if (c.content !== undefined) {
          if (boardNoteVerdict(c.content) !== 'yes') {
            this.raiseNotice(w, 'This note was edited so that it no longer reads as a board (type: board in its frontmatter), so the window can no longer save to it.')
          } else if (c.content.length <= MAX_BOARD_TEXT) this.clearNotice(w)
        }
      }
    }
    if (!out.length) return
    try {
      w.webContents.send(IPC.changes, out)
    } catch {
      /* the board window went away mid-send */
    }
  }

  /** Save the position and size now, if they changed (the app is quitting). */
  flush(): void {
    const w = this.live()
    if (w) this.captureBounds(w)
    this.persist()
  }

  private isOpen(): boolean {
    return this.live() !== null
  }

  private live(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async show(path: string): Promise<BoardStatusDto> {
    this.hookBrain()
    // A window on its way out (its page is saving what it has) is not reused: loading a page into it fails with a Chromium error,
    // so the board waits for the window to go and gets a new one.
    await this.untilClosed()
    let w = this.live()
    if (!w) {
      w = this.createWindow()
      this.shown = null
    } else {
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }
    if (this.shown === path) {
      this.broadcast()
      return this.status()
    }
    const previous = this.shown
    // The window moves on from the old board: its page saves what it has first, and the docked view takes the board back before
    // this one is drawn.
    if (previous !== null) await this.gate.ask(w.webContents)
    if (w.isDestroyed()) throw new Error('The board window was closed')
    this.shown = path
    this.notice = null
    if (previous !== null) this.toBrain(IPC.boardClosed, previous)
    try {
      await this.load(w, path)
    } catch (err) {
      // A page that cannot load is no board window: end it (the brain window hears that the board is not out).
      if (!w.isDestroyed()) w.destroy()
      throw new Error(`Could not open the board window: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.broadcast()
    return this.status()
  }

  /** Resolves once the window whose close is under way is gone; a close that something kept from happening is given up on after twice the flush wait. */
  private async untilClosed(): Promise<void> {
    const w = this.closing
    if (!w || w.isDestroyed()) return
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        w.removeListener('closed', done)
        resolve()
      }
      const timer = setTimeout(done, FLUSH_WAIT_MS * 2)
      w.on('closed', done)
    })
    // Still there: the close did not go through, and the window is as it was.
    if (this.closing === w && !w.isDestroyed()) this.closing = null
  }

  private async load(w: BrowserWindow, path: string): Promise<void> {
    try {
      if (this.opts.devUrl) await w.loadURL(boardPageUrl(this.opts.devUrl, path))
      else await w.loadFile(this.opts.pageFile, { query: { path } })
    } catch (err) {
      // Replaced by a newer navigation (or the page moved on by itself): the window shows something else, which is not a failure.
      if ((err as { code?: unknown } | null)?.code === 'ERR_ABORTED') return
      throw err
    }
  }

  private createWindow(): BrowserWindow {
    const { BrowserWindow: Win, screen, dialog } = this.opts.electron
    const w = new Win(boardWindowOptions(this.settings, this.platform, workAreasOf(screen), this.opts.preload))
    this.win = w
    this.overFullScreen = false
    this.keepOverFullScreen(w, this.settings.alwaysOnTop)
    const reveal = () => {
      if (!w.isDestroyed() && !w.isVisible()) w.show()
    }
    w.once('ready-to-show', reveal)
    const revealTimer = setTimeout(reveal, BOARD_REVEAL_MS)
    const wc = w.webContents
    const pageId = wc.id
    this.pageIds.add(pageId)
    wc.once('destroyed', () => this.pageIds.delete(pageId))
    this.lockBrowserChords(w)
    // The page has no links and opens nothing: a window it asks for is denied, and no address goes to the browser.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    // The window never needs to leave its page: any navigation away is stopped, and one that got through (about:blank, set by
    // script, raises no `will-navigate`) brings the board page back.
    const away = (url: string): boolean => !boardNavigationAllowed(url, { devUrl: this.opts.devUrl, file: this.opts.pageFile })
    wc.on('will-navigate', (e) => {
      if (away(e.url)) e.preventDefault()
    })
    wc.on('will-frame-navigate', (e) => {
      if (away(e.url)) e.preventDefault()
    })
    wc.on('did-navigate', (_e, url) => {
      if (this.win !== w || w.isDestroyed() || this.shown === null || !away(url)) return
      // A few times and no more: a page address this check cannot recognise (an odd install path) must not make the window load
      // itself for ever.
      const now = Date.now()
      this.navFixes = this.navFixes.filter((t) => now - t < NAV_FIX_WINDOW_MS)
      if (this.navFixes.length >= NAV_FIXES) return
      this.navFixes.push(now)
      void this.load(w, this.shown).catch(() => undefined)
    })
    // A page that asks before unloading would keep the window from closing, silently; a board saves as it goes.
    wc.on('will-prevent-unload', (e) => e.preventDefault())
    // A page that died leaves a dark empty window: say why, and open it again (unless it keeps dying, then close it).
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return
      const now = Date.now()
      // Only the recent ones count (and are kept): a window that dies once a day does not pile up a list.
      this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS)
      this.crashes.push(now)
      const reload = shouldReload(this.crashes, now)
      if (reload) wc.reload()
      const text = crashMessage(details.reason, reload, BOARD_WINDOW_NAME)
      const box = { type: 'error' as const, title: BOARD_TITLE, message: text.message, detail: text.detail }
      void (w.isDestroyed() ? dialog.showMessageBox(box) : dialog.showMessageBox(w, box))
        .catch(() => undefined)
        .then(() => {
          if (!reload && !w.isDestroyed()) w.close()
        })
    })
    w.on('move', () => this.scheduleSave())
    w.on('resize', () => this.scheduleSave())
    // Where the window was is remembered on every close event; the first close is held until the page has saved (FlushGate).
    this.gate.guardClose(w, () => {
      this.closing = w
      this.captureBounds(w)
      this.persist()
    })
    w.on('closed', () => {
      clearTimeout(revealTimer)
      if (this.closing === w) this.closing = null
      if (this.win !== w) return
      const path = this.shown
      this.win = null
      this.shown = null
      if (path !== null) this.toBrain(IPC.boardClosed, path)
      this.broadcast()
    })
    return w
  }

  /**
   * The window is not a browser: its own menu (Windows, Linux; macOS has the application menu) in place of Electron's default one, and
   * a page that stays at 100% (no zoom chord, no wheel or pinch zoom; a zoom carried over from the brain window's page is put back).
   */
  private lockBrowserChords(w: BrowserWindow): void {
    const { Menu } = this.opts.electron
    if (this.platform !== 'darwin' && Menu && typeof w.setMenu === 'function') {
      try {
        w.setMenu(Menu.buildFromTemplate(boardMenuTemplate(() => w.close())))
      } catch {
        /* a menu that cannot be made leaves the default one */
      }
    }
    const wc = w.webContents
    const reset = (): void => {
      try {
        if (!wc.isDestroyed() && wc.getZoomFactor() !== 1) wc.setZoomFactor(1)
      } catch {
        /* a page that is gone, or a webContents without zoom */
      }
    }
    try {
      void Promise.resolve(wc.setVisualZoomLevelLimits(1, 1)).catch(() => undefined)
    } catch {
      /* the same */
    }
    wc.on('zoom-changed', reset)
    wc.on('did-finish-load', reset)
    // macOS keeps the application menu, whose zoom items would reach this window: the chord is stopped before the menu sees it.
    wc.on('before-input-event', (e, input) => {
      if (isPageZoomChord(input)) e.preventDefault()
    })
  }

  private applyOnTop(w: BrowserWindow): void {
    const on = this.settings.alwaysOnTop
    // 'floating': above ordinary windows (and below the dock / task bar), the level a reference window wants.
    w.setAlwaysOnTop(on, on ? 'floating' : undefined)
    this.keepOverFullScreen(w, on)
  }

  /**
   * macOS: a window on top of the others still stays on the desktop it was made in; over a full-screen painting program it needs to
   * be visible on every Space, full-screen ones included. Set only when it changes (it hides the window and the Dock for a moment),
   * and never anywhere else or where the method is missing.
   */
  private keepOverFullScreen(w: BrowserWindow, on: boolean): void {
    if (this.platform !== 'darwin' || on === this.overFullScreen || typeof w.setVisibleOnAllWorkspaces !== 'function') return
    this.overFullScreen = on
    try {
      w.setVisibleOnAllWorkspaces(on, on ? { visibleOnFullScreen: true } : undefined)
    } catch {
      /* a platform that cannot: the window is on top all the same */
    }
  }

  /** The window's position and size as it would reopen (the normal state: a maximized or minimized window keeps its restored bounds). */
  private captureBounds(w: BrowserWindow): void {
    if (w.isDestroyed()) return
    const b = w.getNormalBounds()
    this.settings = boardSettings({ ...this.settings, x: b.x, y: b.y, width: b.width, height: b.height })
  }

  /** Save the settings 500 ms after the last move, resize or change. */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      const w = this.live()
      if (w) this.captureBounds(w)
      this.persist()
    }, BOARD_SAVE_MS)
  }

  private persist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    const text = JSON.stringify(this.settings)
    if (text === this.persisted) return
    this.persisted = text
    try {
      void Promise.resolve(this.opts.save({ ...this.settings })).catch(() => undefined)
    } catch {
      /* a save that throws is a save that failed: the window carries on */
    }
  }

  private brainContents(): WebContents | null {
    const b = this.opts.brain()
    return b && !b.isDestroyed() ? b.webContents : null
  }

  private toBrain(channel: string, payload: unknown): void {
    const wc = this.brainContents()
    if (!wc || wc.isDestroyed()) return
    try {
      wc.send(channel, payload)
    } catch {
      /* the brain window went away mid-send */
    }
  }

  /** `board:state` to the brain window and the board window. */
  private broadcast(): void {
    const status = this.status()
    this.toBrain(IPC.boardState, status)
    const w = this.live()
    if (!w) return
    try {
      w.webContents.send(IPC.boardState, status)
    } catch {
      /* the board window went away mid-send */
    }
  }

  /** The board window belongs to the brain window: it closes with it (nothing could take a board back, and the app must quit). */
  private hookBrain(): void {
    const brain = this.opts.brain()
    if (!brain || brain.isDestroyed() || this.hooked.has(brain)) return
    this.hooked.add(brain)
    brain.once('closed', () => this.close())
  }
}
