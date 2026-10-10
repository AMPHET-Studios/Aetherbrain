/**
 * The reference board's floating window: one window, opened on a board note, that stays on top of the user's painting program, can
 * be dimmed (Windows, macOS), and remembers where it was. It shows the same app (`board.html`, the board view only) with the same
 * preload and the default session as the brain window, so it has the brain window's security: no network in production, every
 * permission refused. It never opens a vault: it reads and saves the one board note through `board:read` / `board:save` (see
 * board-save.ts) and its pictures through the bridge's picture calls.
 *
 * The window belongs to the brain window: it closes with it, and tells it (`board:closed`, with the board's path) when it closes
 * or moves on to another board, so the docked view takes the board back. Both windows hear `board:state` whenever the window
 * opens, closes or changes its settings.
 *
 * No electron import at runtime (types only), like ForgeHost and Thumbnailer: main.ts hands in the Electron modules, and the checks
 * (settings, bounds, options, navigation) are pure functions.
 */
import type { BrowserWindow, BrowserWindowConstructorOptions, Dialog, Display, Screen, Shell, WebContents } from 'electron'
import { IPC, type AssetListDto, type BoardConfigureDto, type BoardSaveResult, type BoardStatusDto, type VaultAssetDto, type VaultChangeDto } from '../shared/ipc.js'
import { checkBoard, readBoard, saveBoard, type BoardVault } from './board-save.js'
import { CRASH_WINDOW_MS, crashMessage, shouldReload } from './crash.js'
import { forgeNavigation } from './forge.js'
import { isImageName } from './fsvault.js'

export const BOARD_TITLE = 'Aether Brain — Board'
/** Smallest window: a board you cannot see is no board. */
export const BOARD_MIN_WIDTH = 320
export const BOARD_MIN_HEIGHT = 240
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
 * Where the window goes: wholly inside the work area of one display, and at least 320 × 240. The display is the one the saved
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
 * the platform can), hidden until it is ready, and the brain window's web preferences: the same preload, no partition (the default
 * session, so its network block and permission refusals apply), sandboxed and isolated, no Node.
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

/* ------------------------------------------------------------------ */
/* Pictures since the last scan (pure)                                */
/* ------------------------------------------------------------------ */

/** Pictures the ledger keeps at most (the scan's own cap): past it the list says it is partial. */
export const LEDGER_MAX = 200_000

/**
 * The vault's pictures as they are now, for the floating window. `listAssets` is the last scan's snapshot (a picture dropped into
 * a board a minute ago is not in it, and the board would draw it as missing): this keeps what the watcher reported since (and what
 * the app created), on top of the scan's list. Cleared when a scan finishes, because the new list contains all of it.
 */
export class PictureLedger {
  /** Path → the picture as last reported, or null for one that was removed. */
  private delta = new Map<string, VaultAssetDto | null>()
  /** Changes were dropped for lack of room: the list is partial. */
  overflowed = false

  clear(): void {
    this.delta.clear()
    this.overflowed = false
  }

  /** Remember the picture changes among `changes` (notes, folders and videos are not its business). */
  apply(changes: readonly VaultChangeDto[]): void {
    for (const c of changes) {
      if (c.kind === 'addDir' || c.kind === 'unlinkDir' || !isImageName(c.path.slice(c.path.lastIndexOf('/') + 1))) continue
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
      if (!isImageName(a.path.slice(a.path.lastIndexOf('/') + 1))) continue
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
  close(): void
  status(): BoardStatusDto
  configure(patch: unknown): BoardStatusDto
  save(path: unknown, text: unknown): Promise<BoardSaveResult>
  read(path: unknown): Promise<string | null>
  assets(): AssetListDto
}

/**
 * The handlers of `board:open`, `:close`, `:status`, `:configure`, `:save`, `:read` and `:assets`, as plain functions (main.ts only
 * wires them to the channels, so what they accept is tested without Electron). They are given no file watcher on purpose: a save
 * must be reported by it like any outside edit, and nothing here can tell it otherwise. The floating page has the whole bridge but
 * writes one thing, an existing board note (board-save.ts); it opens boards, never notes.
 */
export function boardHandlers(ctx: BoardIpcContext): BoardHandlers {
  return {
    async open(raw) {
      const path = cleanBoardPath(raw)
      // The window is made only for a board note that is there: it would otherwise be an empty page with a path.
      const found = await checkBoard(path, ctx.vault())
      if (!found.ok) throw new Error(found.reason)
      return ctx.host.open(path)
    },
    close: () => ctx.host.close(),
    status: () => ctx.host.status(),
    configure: (patch) => ctx.host.configure(patch),
    save: (path, text) => saveBoard({ path, text }, ctx.vault()),
    read: (path) => readBoard(path, ctx.vault()),
    // The last scan's list plus what changed since: `listAssets` is the scan's snapshot, and a picture dropped into a board a minute
    // ago would be drawn in the window as a missing one. No stat: the board needs names, and the list can be 200,000 long.
    assets() {
      const scan = ctx.scan()
      return { assets: ctx.ledger.list(scan?.assets ?? []), truncated: (scan?.assetsTruncated ?? false) || ctx.ledger.overflowed }
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
}

export interface BoardHostOptions {
  electron: BoardElectron
  settings: BoardSettings
  /** Persist the settings (position, size, on top, opacity); called after changes, not on every move. */
  save(settings: BoardSettings): Promise<void> | void
  /** The brain window, which the board window belongs to; null when closed. */
  brain(): BrowserWindow | null
  /** Absolute path of the built preload.cjs: the brain window's own. */
  preload: string
  /** The Vite dev server's address in development (VITE_DEV_SERVER_URL), else null. */
  devUrl?: string | null
  /** Absolute path of the built board.html (dist/renderer/board.html), loaded when there is no dev server. */
  pageFile: string
  platform?: NodeJS.Platform
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
  /** Brain windows already hooked (closing one closes this window). */
  private hooked = new WeakSet<object>()
  private readonly platform: NodeJS.Platform

  constructor(private opts: BoardHostOptions) {
    this.settings = boardSettings(opts.settings)
    this.persisted = JSON.stringify(this.settings)
    this.platform = opts.platform ?? process.platform
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

  /** `board:close`. */
  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close()
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
      for (const c of changes) if (c.kind !== 'addDir' && c.kind !== 'unlinkDir' && same(c.path)) out.push(c)
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
    this.shown = path
    // The window moves on from the old board: the docked view takes it back before this one is drawn.
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
    const { BrowserWindow: Win, shell, screen, dialog } = this.opts.electron
    const w = new Win(boardWindowOptions(this.settings, this.platform, workAreasOf(screen), this.opts.preload))
    this.win = w
    const reveal = () => {
      if (!w.isDestroyed() && !w.isVisible()) w.show()
    }
    w.once('ready-to-show', reveal)
    const revealTimer = setTimeout(reveal, BOARD_REVEAL_MS)
    const wc = w.webContents
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    // The window never needs to leave its page.
    wc.on('will-navigate', (e) => {
      if (!boardNavigationAllowed(e.url, { devUrl: this.opts.devUrl, file: this.opts.pageFile })) e.preventDefault()
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
      const text = crashMessage(details.reason, reload)
      const box = { type: 'error' as const, title: BOARD_TITLE, message: text.message, detail: text.detail }
      void (w.isDestroyed() ? dialog.showMessageBox(box) : dialog.showMessageBox(w, box))
        .catch(() => undefined)
        .then(() => {
          if (!reload && !w.isDestroyed()) w.close()
        })
    })
    w.on('move', () => this.scheduleSave())
    w.on('resize', () => this.scheduleSave())
    w.on('close', () => {
      this.captureBounds(w)
      this.persist()
    })
    w.on('closed', () => {
      clearTimeout(revealTimer)
      if (this.win !== w) return
      const path = this.shown
      this.win = null
      this.shown = null
      if (path !== null) this.toBrain(IPC.boardClosed, path)
      this.broadcast()
    })
    return w
  }

  private applyOnTop(w: BrowserWindow): void {
    const on = this.settings.alwaysOnTop
    // 'floating': above ordinary windows (and below the dock / task bar), the level a reference window wants.
    w.setAlwaysOnTop(on, on ? 'floating' : undefined)
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
