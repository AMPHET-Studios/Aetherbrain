/**
 * The Concept Forge link: the user's own drawing trainer (a single
 * `concept-forge.html` on their disk) opened in a window of its own, whose
 * "Save to Brain" button files a graded drawing into a project's Critique
 * planet. The Forge window never touches the vault: its requests (the project
 * list, a save) are checked here and relayed to the brain window, whose store
 * does the work and answers, and its session serves it no file but the page.
 *
 * No electron import at runtime (types only) so it can be unit-tested:
 * main.ts hands in the Electron modules. The checks are pure functions.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Dialog,
  NativeImage,
  Screen,
  Session,
  Shell,
  WebContents,
} from 'electron'
import {
  IPC,
  type ForgeFrameDto,
  type ForgeProjectDto,
  type ForgeRequest,
  type ForgeSaveDto,
  type ForgeSaveResult,
  type ForgeStatus,
} from '../shared/ipc.js'
import { MAX_ASSET_BYTES } from './assets.js'
import { within } from './fsvault.js'

/** Its own persistent session: the page keeps its local storage, and the brain's network block does not apply. */
export const FORGE_PARTITION = 'persist:forge'
export const FORGE_TITLE = 'Concept Forge — Aether Brain'
/** How long the Forge window waits for the brain to answer one request. */
export const FORGE_TIMEOUT_MS = 30_000
export const MAX_FORGE_TITLE = 200
export const MAX_FORGE_PNG = MAX_ASSET_BYTES
export const MAX_GRADE_BYTES = 256 * 1024
/** What the Forge window hears when there is no brain window to ask (or it went away). */
export const NO_BRAIN = 'Open your vault in Aether Brain first'
/** The only permissions the page gets: copy a drawing, go fullscreen, lock the pointer (pan / rotate tools). */
export const FORGE_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock'])
/**
 * Sent with the page itself: the web, data: and blob: URLs, inline scripts and eval stay open to it (Deep
 * Critique, random references, dropped pictures), file: is shut. The session's file handler refuses every other
 * file:// request, but workers load and fetch through a loader of their own that no handler sees; this policy is
 * what keeps them, and the blob: workers it is inherited into, off the disk.
 */
export const FORGE_CSP = "default-src http: https: ws: wss: data: blob: 'unsafe-inline' 'unsafe-eval'"

/** The star screen gets a new frame at most this often (ms). */
export const FRAME_MS = 250
/** Frames for the star screen are at most this many pixels wide and high. */
export const FRAME_MAX = 1024
/** The hidden copy of the page paints this many frames a second while the star screen is in view. */
export const PREVIEW_FPS = 4
/** A hidden copy nobody looks at closes after this long (ms); coming back to the star sooner shows it at once. */
export const PREVIEW_IDLE_MS = 60_000
/** A capture of the Forge window that has not come back after this long (ms) is given up on: the next one goes. */
export const CAPTURE_TIMEOUT_MS = 2000
/**
 * While the Forge window has the focus (a pen on it), it is captured at most this often (ms): a 4K window's capture
 * and resize run in the main process, which also passes the pen's input on, and drawing must never lag for it.
 */
export const FOCUSED_CAPTURE_MS = 1000

const MAX_PROJECT_ID = 4096
const MAX_PROJECTS = 5000
/** Deeper than the page's own clone (6 levels) on purpose: main only refuses what cannot be plain JSON. */
const MAX_GRADE_DEPTH = 32
const MAX_GRADE_NODES = 100_000
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/* ------------------------------------------------------------------ */
/* Settings and checks (pure)                                         */
/* ------------------------------------------------------------------ */

/** Persisted in settings.json under `forge`. */
export interface ForgeSettings {
  /** Absolute path of the user's concept-forge.html. */
  file?: string
}

/** Settings from disk: the remembered file when it is an absolute path, nothing else. */
export function forgeSettings(raw: unknown): ForgeSettings {
  const file = isRecord(raw) ? raw['file'] : undefined
  return typeof file === 'string' && file.trim() && path.isAbsolute(file) ? { file } : {}
}

/** `forge:open` options as they crossed IPC. */
export function cleanOpenOptions(raw: unknown): { pick: boolean } {
  return { pick: isRecord(raw) && raw['pick'] === true }
}

export function forgePermission(permission: string): boolean {
  return FORGE_PERMISSIONS.has(permission)
}

/** True when `b` starts with the 8-byte PNG signature. */
export function isPng(b: Uint8Array): boolean {
  return b.length >= PNG_SIG.length && PNG_SIG.every((x, i) => b[i] === x)
}

export type ForgeNavigation = 'allow' | 'external' | 'deny'

/**
 * Where the Forge window may go: web links open in the default browser, the
 * page itself may reload (with any query or hash), anything else stays shut.
 */
export function forgeNavigation(url: string, file: string | null, platform: NodeJS.Platform = process.platform): ForgeNavigation {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'deny'
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return 'external'
  return isPageUrl(u, file, platform) ? 'allow' : 'deny'
}

/**
 * Whether the Forge session serves a file:// request: only when it names the page on show (any query or
 * hash). A page on file:// may otherwise fetch, embed or frame any file:// URL (Electron grants file pages
 * that), so every other file on the disk, the vault's notes and pictures included, is refused.
 */
export function forgeFileRequest(url: string, file: string | null, platform: NodeJS.Platform = process.platform): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  return isPageUrl(u, file, platform)
}

/** True when `u` is a file:// URL of `file` itself. */
function isPageUrl(u: URL, file: string | null, platform: NodeJS.Platform): boolean {
  if (u.protocol !== 'file:' || !file) return false
  const windows = platform === 'win32'
  let target: string
  try {
    // A `%` that starts no escape stays a `%` (Electron's loadFile leaves `100%/` so, and Chromium reads it so);
    // fileURLToPath would refuse the page's own URL.
    target = fileURLToPath(u.href.replace(/%(?![0-9a-f]{2})/gi, '%25'), { windows })
  } catch {
    return false
  }
  const p = windows ? path.win32 : path.posix
  const a = p.resolve(target)
  const b = p.resolve(file)
  // Windows and macOS file names are case-insensitive.
  return platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase()
}

/**
 * A save as the Forge window sent it, checked before it reaches the brain:
 * a project id, a title of at most 200 characters, PNG bytes of at most
 * 40 MB, a grade that is plain JSON of at most 256 KB (or none). Throws a
 * message the page can show; the brain checks the project itself.
 */
export function cleanSave(raw: unknown): ForgeSaveDto {
  if (!isRecord(raw)) throw new Error('Nothing to save')
  const projectId = raw['projectId']
  if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > MAX_PROJECT_ID) throw new Error('Pick a project to save to')
  const title = raw['title'] ?? ''
  if (typeof title !== 'string') throw new Error('The title must be text')
  if (title.length > MAX_FORGE_TITLE) throw new Error(`The title is longer than ${MAX_FORGE_TITLE} characters`)
  const png = bytesOf(raw['png'])
  if (!png) throw new Error('The drawing is missing (PNG bytes expected)')
  if (!png.length) throw new Error('The drawing is empty')
  if (png.length > MAX_FORGE_PNG) {
    throw new Error(`The drawing is too big: ${(png.length / 1024 / 1024).toFixed(1)} MB (at most ${MAX_FORGE_PNG / 1024 / 1024} MB)`)
  }
  if (!isPng(png)) throw new Error('The drawing is not a PNG')
  const practice = raw['practiceTomorrow']
  if (practice !== undefined && typeof practice !== 'boolean') throw new Error('practiceTomorrow is true or false')
  const grade = raw['grade'] ?? null
  if (grade !== null) checkGrade(grade)
  return { projectId, title, png, grade, practiceTomorrow: practice !== false }
}

/** Throws unless `grade` is plain JSON data (objects, arrays, strings, finite numbers, booleans, null) of at most 256 KB. */
function checkGrade(grade: unknown): void {
  let nodes = 0
  const ancestors = new Set<object>()
  const plain = (v: unknown, depth: number): boolean => {
    if (++nodes > MAX_GRADE_NODES) return false
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
    if (typeof v === 'number') return Number.isFinite(v)
    if (typeof v !== 'object' || depth > MAX_GRADE_DEPTH || ancestors.has(v)) return false
    const proto: unknown = Object.getPrototypeOf(v)
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return false
    ancestors.add(v)
    const ok = Object.values(v).every((x) => plain(x, depth + 1))
    ancestors.delete(v)
    return ok
  }
  if (!plain(grade, 0)) throw new Error('The grade is not plain JSON data')
  if (Buffer.byteLength(JSON.stringify(grade)) > MAX_GRADE_BYTES) throw new Error(`The grade is larger than ${MAX_GRADE_BYTES / 1024} KB`)
}

/** The project list as the brain sent it, reduced to well-typed rows. */
export function cleanProjects(raw: unknown): ForgeProjectDto[] {
  if (!Array.isArray(raw)) throw new Error('Aether Brain sent no project list')
  const out: ForgeProjectDto[] = []
  for (const p of raw.slice(0, MAX_PROJECTS)) {
    if (!isRecord(p)) continue
    const { id, title, status, home, critique } = p
    if (typeof id !== 'string' || !id || typeof title !== 'string' || typeof critique !== 'string') continue
    out.push({ id, title, status: typeof status === 'string' ? status : null, home: typeof home === 'string' ? home : null, critique })
  }
  return out
}

/** The brain's answer to a save, or a clear error when it is not one. */
export function cleanSaved(raw: unknown): ForgeSaveResult {
  if (isRecord(raw)) {
    const { noteId, notePath, imagePath, project } = raw
    if (typeof noteId === 'string' && typeof notePath === 'string' && typeof imagePath === 'string' && typeof project === 'string') {
      return { noteId, notePath, imagePath, project }
    }
  }
  throw new Error('Aether Brain sent an unexpected answer')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Bytes that crossed IPC (a Uint8Array, another view, or an ArrayBuffer), or null. */
function bytesOf(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  return null
}

/** The size of a star-screen frame of a page width × height: at most `max` px each way, the same shape; 0 × 0 for nothing. */
export function frameSize(width: number, height: number, max = FRAME_MAX): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return { width: 0, height: 0 }
  const scale = Math.min(1, max / width, max / height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/**
 * A frame of `image` (a paint or a capture of the page) for the star screen:
 * scaled down to frameSize, as raw pixels in Chromium's own byte order
 * (B, G, R, A). Null for an empty picture. Nothing is decoded: the picture is
 * already pixels.
 */
export function frameOf(image: NativeImage, max = FRAME_MAX): ForgeFrameDto | null {
  if (image.isEmpty()) return null
  const size = image.getSize()
  const want = frameSize(size.width, size.height, max)
  if (!want.width || !want.height) return null
  // Always through resize, even at full size: its result has exactly one 1x picture, whatever the display's scale.
  const scaled = image.resize({ width: want.width, height: want.height, quality: 'good' })
  const { width, height } = scaled.getSize()
  const data = scaled.toBitmap()
  if (!width || !height || data.length !== width * height * 4) return null
  return { data, width, height, bgra: true }
}

/* ------------------------------------------------------------------ */
/* Relay: Forge window → main → brain window → main → Forge window    */
/* ------------------------------------------------------------------ */

/** Where relayed requests go (the brain window's webContents; a fake in tests). */
export interface RelayTarget {
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
}

interface Waiting {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

type RelayRequest = { kind: 'projects' } | { kind: 'save'; save: ForgeSaveDto }

/**
 * What a request the brain got but did not answer in time says. The brain may
 * still finish a save after that, so it must not invite another one (that
 * files the drawing twice, as `… 2`): it says where to look first.
 */
export function unanswered(kind: ForgeRequest['kind'], timeoutMs: number): string {
  const s = Math.ceil(timeoutMs / 1000)
  return kind === 'save'
    ? `Aether Brain hasn't answered in ${s} s; the drawing may still have been saved — check the project's Critique planet before saving again`
    : `Aether Brain didn't answer in ${s} s; try again`
}

/**
 * Numbered requests to the brain window and their answers. Each one gets
 * exactly one outcome: the brain's value, the brain's error message, NO_BRAIN
 * when there is no brain window to send it to (or it goes away), or
 * `unanswered` when the brain got it but did not answer in time.
 */
export class ForgeRelay {
  private seq = 0
  private waiting = new Map<number, Waiting>()

  constructor(
    private target: () => RelayTarget | null,
    readonly timeoutMs = FORGE_TIMEOUT_MS,
  ) {}

  /** Requests still waiting for an answer. */
  get pending(): number {
    return this.waiting.size
  }

  request(req: RelayRequest): Promise<unknown> {
    const t = this.target()
    if (!t || t.isDestroyed()) return Promise.reject(new Error(NO_BRAIN))
    const id = ++this.seq
    const msg: ForgeRequest = req.kind === 'save' ? { id, kind: 'save', save: req.save } : { id, kind: 'projects' }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, false, unanswered(req.kind, this.timeoutMs)), this.timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      try {
        t.send(IPC.forgeRequest, msg)
      } catch {
        // The window went away between the check and the send.
        this.settle(id, false, NO_BRAIN)
      }
    })
  }

  /** An answer from the brain window: (id, true, value) or (id, false, message). False for an id nobody waits for. */
  reply(id: unknown, ok: unknown, value: unknown): boolean {
    return typeof id === 'number' && this.settle(id, ok === true, value)
  }

  /** Fail everything still waiting (the brain window is gone). */
  rejectAll(message: string): void {
    for (const id of [...this.waiting.keys()]) this.settle(id, false, message)
  }

  private settle(id: number, ok: boolean, value: unknown): boolean {
    const w = this.waiting.get(id)
    if (!w) return false
    this.waiting.delete(id)
    clearTimeout(w.timer)
    if (ok) w.resolve(value)
    else w.reject(new Error(typeof value === 'string' && value.trim() ? value : 'Aether Brain could not do that'))
    return true
  }
}

/* ------------------------------------------------------------------ */
/* Host: the file, the window, its session, the relay                 */
/* ------------------------------------------------------------------ */

/** The Electron modules the host uses (main.ts passes the real ones). */
export interface ForgeElectron {
  BrowserWindow: new (options: BrowserWindowConstructorOptions) => BrowserWindow
  dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBoxSync'>
  shell: Pick<Shell, 'openExternal'>
  session: { fromPartition(partition: string): Session }
  screen: Pick<Screen, 'getPrimaryDisplay'>
}

export interface ForgeHostOptions {
  electron: ForgeElectron
  settings: ForgeSettings
  save(settings: ForgeSettings): Promise<void>
  /** The brain window, whose store serves the Forge window's requests; null when closed. */
  brain(): BrowserWindow | null
  /** Absolute path of the built forge-preload.cjs. */
  preload: string
  /** App version, for `window.aetherForge.version`. */
  version: string
  timeoutMs?: number
}

export class ForgeHost {
  private settings: ForgeSettings
  private win: BrowserWindow | null = null
  /** The file the window shows: navigation may not leave it, and it is (with the hidden copy's) the one file the Forge session serves. */
  private shown: string | null = null
  /** The brain window's star screen is in view (`forge:screen`). */
  private screenOn = false
  /** The hidden copy of the page that paints the star screen while the Forge window is closed (offscreen, muted, no input). */
  private preview: BrowserWindow | null = null
  /** The file the hidden copy shows. */
  private previewShown: string | null = null
  private previewIdle: ReturnType<typeof setTimeout> | null = null
  /** The hidden copy's newest paint, not sent yet. */
  private painted: NativeImage | null = null
  private frameTimer: ReturnType<typeof setInterval> | null = null
  /** When the capture in flight started (0: none). */
  private capturingSince = 0
  /** When the last capture started. */
  private lastCapture = 0
  /** Content size of the Forge window when it last closed: the hidden copy lays the page out the same way. */
  private lastSize: { width: number; height: number } | null = null
  private opening: Promise<ForgeStatus> | null = null
  private sessionReady = false
  /** Brain windows / webContents already hooked (closing one closes the Forge window, a gone one fails its requests). */
  private hooked = new WeakSet<object>()
  readonly relay: ForgeRelay

  constructor(private opts: ForgeHostOptions) {
    this.settings = forgeSettings(opts.settings)
    this.relay = new ForgeRelay(() => this.brainContents(), opts.timeoutMs)
  }

  status(): ForgeStatus {
    return { file: this.settings.file ?? null, open: this.isOpen() }
  }

  /**
   * Open (or focus) the Forge window. Asks for concept-forge.html the first
   * time, with `pick`, or when the remembered file is gone; a cancelled pick
   * leaves everything as it was. One open at a time (a second `g` joins it).
   */
  open(raw?: unknown): Promise<ForgeStatus> {
    this.opening ??= this.doOpen(cleanOpenOptions(raw)).finally(() => (this.opening = null))
    return this.opening
  }

  /** `forge:win:projects`: the project list, for the Forge window only. */
  async projects(sender: WebContents): Promise<ForgeProjectDto[]> {
    this.requireForge(sender)
    return cleanProjects(await this.relay.request({ kind: 'projects' }))
  }

  /** `forge:win:save`: a checked save, for the Forge window only. */
  async save(sender: WebContents, raw: unknown): Promise<ForgeSaveResult> {
    this.requireForge(sender)
    const save = cleanSave(raw)
    return cleanSaved(await this.relay.request({ kind: 'save', save }))
  }

  /** `forge:reply`: the brain window's answer (anyone else is ignored). */
  reply(sender: WebContents, id: unknown, ok: unknown, value: unknown): void {
    const brain = this.brainContents()
    if (brain && sender.id === brain.id) this.relay.reply(id, ok, value)
  }

  /** Close the Forge window (the page may still ask to keep unsaved work). */
  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close()
  }

  /**
   * `forge:screen`, from the brain window only: its Concept Forge star's
   * screen came into view (true) or folded away (false). While it is in view,
   * frames of the page go to the brain window every FRAME_MS: captures of the
   * Forge window when it is open, else paints of a hidden copy of the page.
   */
  screen(sender: WebContents, on: unknown): void {
    const brain = this.brainContents()
    if (!brain || sender.id !== brain.id) throw new Error('Only the brain window can do that')
    this.hookBrain()
    this.screenOn = on === true
    this.syncScreen()
  }

  /** The star screen is in view and gets frames (for tests and status). */
  get screenLive(): boolean {
    return this.screenOn && this.frameTimer !== null
  }

  /** The hidden copy of the page is there (painting or resting). */
  get previewOpen(): boolean {
    return !!this.preview && !this.preview.isDestroyed()
  }

  private isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  private requireForge(sender: WebContents): void {
    if (!this.win || this.win.isDestroyed() || sender.id !== this.win.webContents.id) throw new Error('Only the Concept Forge window can do that')
  }

  private brainContents(): WebContents | null {
    const b = this.opts.brain()
    if (!b || b.isDestroyed()) return null
    const wc = b.webContents
    if (!this.hooked.has(wc)) {
      this.hooked.add(wc)
      const gone = () => {
        this.relay.rejectAll(NO_BRAIN)
        this.stopScreen()
      }
      wc.once('destroyed', gone)
      wc.on('render-process-gone', gone)
    }
    return wc
  }

  private async doOpen(opts: { pick: boolean }): Promise<ForgeStatus> {
    let file = this.settings.file ?? null
    const gone = file !== null && !(await isFile(file))
    if (opts.pick || file === null || gone) {
      const picked = await this.pickFile(file, gone)
      if (!picked) return this.status()
      file = picked
      if (file !== this.settings.file) {
        this.settings = { ...this.settings, file }
        await this.opts.save({ ...this.settings })
      }
    }
    await this.show(file)
    return this.status()
  }

  private async pickFile(previous: string | null, gone: boolean): Promise<string | null> {
    const options: Electron.OpenDialogOptions = {
      title: gone ? 'concept-forge.html moved — where is it now?' : 'Choose your Concept Forge page',
      message: 'Pick concept-forge.html. Aether Brain opens it in its own window and adds a Save to Brain button.',
      buttonLabel: 'Open in Aether Brain',
      properties: ['openFile'],
      filters: [{ name: 'Concept Forge page (HTML)', extensions: ['html', 'htm'] }],
      ...(previous ? { defaultPath: path.dirname(previous) } : {}),
    }
    const brain = this.opts.brain()
    const { dialog } = this.opts.electron
    const res = brain && !brain.isDestroyed() ? await dialog.showOpenDialog(brain, options) : await dialog.showOpenDialog(options)
    const file = res.filePaths[0]
    if (res.canceled || !file) return null
    if (!/\.html?$/i.test(file)) throw new Error(`Concept Forge is an .html page: ${file}`)
    return path.resolve(file)
  }

  /** Create or focus the one Forge window and show `file` in it. */
  private async show(file: string): Promise<void> {
    let w = this.win
    if (!w || w.isDestroyed()) {
      w = this.createWindow()
      this.shown = null
    } else {
      if (w.isMinimized()) w.restore()
      w.focus()
    }
    if (this.shown === file) return
    const previous = this.shown
    this.shown = file
    try {
      await w.loadFile(file)
    } catch (err) {
      if (w.isDestroyed()) return
      if (err instanceof Error && (err as Error & { code?: unknown }).code === 'ERR_ABORTED') {
        // The page moved on by itself (it stays on `file`), or it asked about unsaved changes and the answer
        // was Stay: the previous page is still there, and its reloads and hash changes must keep working.
        if (this.shown === file && forgeNavigation(w.webContents.getURL(), previous) === 'allow') this.shown = previous
        return
      }
      if (this.shown === file) this.shown = null
      throw new Error(`Could not open ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private createWindow(): BrowserWindow {
    const { BrowserWindow: Win, shell, screen } = this.opts.electron
    this.prepareSession()
    // 1600 × 1000, or the work area when the screen is smaller (a laptop).
    const area = screen.getPrimaryDisplay().workAreaSize
    const w = new Win({
      width: Math.min(1600, area.width),
      height: Math.min(1000, area.height),
      minWidth: 640,
      minHeight: 480,
      backgroundColor: '#04050d',
      title: FORGE_TITLE,
      show: false,
      webPreferences: {
        preload: this.opts.preload,
        partition: FORGE_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        additionalArguments: [`--aether-forge-version=${this.opts.version}`],
      },
    })
    this.win = w
    const reveal = () => {
      if (!w.isDestroyed() && !w.isVisible()) w.show()
    }
    w.once('ready-to-show', reveal)
    setTimeout(reveal, 1500)
    // The title says which window this is, whatever the page calls itself.
    w.on('page-title-updated', (e) => e.preventDefault())
    const wc = w.webContents
    wc.setWindowOpenHandler(({ url }) => {
      if (forgeNavigation(url, null) === 'external') void shell.openExternal(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (e) => {
      const action = forgeNavigation(e.url, this.shown)
      if (action === 'allow') return
      e.preventDefault()
      if (action === 'external') void shell.openExternal(e.url)
    })
    // A page that asks before unloading (unsaved drawing) would otherwise keep the window from closing, silently.
    wc.on('will-prevent-unload', (e) => {
      const choice = this.opts.electron.dialog.showMessageBoxSync(w, {
        type: 'question',
        buttons: ['Leave', 'Stay'],
        defaultId: 1,
        cancelId: 1,
        title: 'Leave Concept Forge?',
        message: 'Leave Concept Forge?',
        detail: 'The page says there may be unsaved changes.',
      })
      if (choice === 0) e.preventDefault()
    })
    w.on('close', () => {
      const [width, height] = w.getContentSize()
      if (width && height) this.lastSize = { width, height }
    })
    w.on('closed', () => {
      if (this.win === w) {
        this.win = null
        this.shown = null
        // The star screen goes back to the hidden copy.
        this.syncScreen()
      }
    })
    this.hookBrain()
    // The star screen now shows this window: the hidden copy is not needed.
    this.syncScreen()
    return w
  }

  /** The Forge windows belong to the brain window: they close with it (nothing could answer their saves, nobody sees the screen). */
  private hookBrain(): void {
    const brain = this.opts.brain()
    if (!brain || brain.isDestroyed() || this.hooked.has(brain)) return
    this.hooked.add(brain)
    brain.once('closed', () => {
      this.stopScreen()
      this.close()
    })
  }

  /* ---- the star screen ---- */

  /** Start, switch or stop the frames for what is true now: screen in view or not, Forge window open or not. */
  private syncScreen(): void {
    if (!this.screenOn || !this.brainContents()) {
      this.screenOn = false
      this.stopFrames()
      this.restPreview()
      return
    }
    if (this.isOpen()) {
      this.closePreview()
    } else {
      const file = this.settings.file ?? null
      if (!file) {
        // No page chosen yet: the screen says to press g.
        this.stopFrames()
        this.closePreview()
        return
      }
      this.wakePreview(file)
    }
    this.frameTimer ??= setInterval(() => this.tick(), FRAME_MS)
  }

  private stopScreen(): void {
    this.screenOn = false
    this.stopFrames()
    this.closePreview()
  }

  private stopFrames(): void {
    if (this.frameTimer) clearInterval(this.frameTimer)
    this.frameTimer = null
    this.painted = null
  }

  /** One frame: a capture of the Forge window when it is open, else the hidden copy's newest paint. */
  private tick(): void {
    const brain = this.opts.brain()
    if (!this.screenOn || !brain || brain.isDestroyed()) {
      this.syncScreen()
      return
    }
    // Nobody can see the screen of a minimized brain window.
    if (brain.isMinimized()) return
    const w = this.win
    if (w && !w.isDestroyed()) {
      // Not shown yet (still loading): nothing to capture, and a capture of a hidden page may never come back.
      if (!w.isVisible()) return
      const now = Date.now()
      if (this.capturingSince && now - this.capturingSince < CAPTURE_TIMEOUT_MS) return
      if (w.isFocused() && now - this.lastCapture < FOCUSED_CAPTURE_MS) return
      const started = now
      this.capturingSince = started
      this.lastCapture = started
      const done = () => {
        if (this.capturingSince === started) this.capturingSince = 0
      }
      // stayHidden: a Forge window behind others or minimized is captured without telling the page it is shown.
      w.webContents.capturePage(undefined, { stayHidden: true }).then(
        (image) => {
          done()
          this.sendFrame(image)
        },
        done,
      )
      return
    }
    const image = this.painted
    this.painted = null
    if (image) this.sendFrame(image)
  }

  private sendFrame(image: NativeImage): void {
    const brain = this.screenOn ? this.brainContents() : null
    if (!brain) return
    const frame = frameOf(image)
    if (!frame) return
    try {
      brain.send(IPC.forgeFrame, frame)
    } catch {
      // The brain window went away mid-send: its 'destroyed' hook stops the screen.
    }
  }

  /** The hidden copy of `file`, painting: made (or reloaded when the file changed) as needed. */
  private wakePreview(file: string): void {
    if (this.previewIdle) clearTimeout(this.previewIdle)
    this.previewIdle = null
    let w = this.preview
    if (!w || w.isDestroyed()) {
      w = this.createPreview()
      this.previewShown = null
    }
    const wc = w.webContents
    if (this.previewShown !== file) {
      this.previewShown = file
      const loading = w
      loading.loadFile(file).catch((err: unknown) => {
        // A page that moved on by itself is fine; one that cannot load (moved, deleted) is not shown at all.
        if ((err as { code?: unknown } | null)?.code === 'ERR_ABORTED') return
        if (this.preview === loading) this.closePreview()
      })
    }
    if (!wc.isPainting()) wc.startPainting()
    wc.invalidate()
  }

  /** The screen folded away: the hidden copy stops painting, and closes if nobody comes back within PREVIEW_IDLE_MS. */
  private restPreview(): void {
    const w = this.preview
    if (!w || w.isDestroyed()) return
    if (w.webContents.isPainting()) w.webContents.stopPainting()
    this.previewIdle ??= setTimeout(() => {
      this.previewIdle = null
      if (!this.screenOn) this.closePreview()
    }, PREVIEW_IDLE_MS)
  }

  private closePreview(): void {
    if (this.previewIdle) clearTimeout(this.previewIdle)
    this.previewIdle = null
    const w = this.preview
    this.preview = null
    this.previewShown = null
    this.painted = null
    // destroy, not close: a hidden copy never asks "leave?".
    if (w && !w.isDestroyed()) w.destroy()
  }

  /**
   * The hidden copy: the same page, preload and session as the Forge window, laid out at the same size, but
   * offscreen (never shown, takes no input), muted, painting PREVIEW_FPS frames a second, and it goes nowhere.
   */
  private createPreview(): BrowserWindow {
    const { BrowserWindow: Win, screen } = this.opts.electron
    this.prepareSession()
    const area = screen.getPrimaryDisplay().workAreaSize
    const size = this.lastSize ?? { width: Math.min(1600, area.width), height: Math.min(1000, area.height) }
    const w = new Win({
      width: size.width,
      height: size.height,
      useContentSize: true,
      show: false,
      backgroundColor: '#04050d',
      title: FORGE_TITLE,
      webPreferences: {
        preload: this.opts.preload,
        partition: FORGE_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        offscreen: true,
        additionalArguments: [`--aether-forge-version=${this.opts.version}`],
      },
    })
    this.preview = w
    const wc = w.webContents
    wc.setAudioMuted(true)
    wc.setFrameRate(PREVIEW_FPS)
    wc.on('paint', (_e, _dirty, image) => {
      if (this.preview === w) this.painted = image
    })
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (e) => {
      if (forgeNavigation(e.url, this.previewShown) !== 'allow') e.preventDefault()
    })
    // Nobody is there to answer a "leave?" question: the answer is Leave.
    wc.on('will-prevent-unload', (e) => e.preventDefault())
    wc.on('render-process-gone', () => {
      if (this.preview === w) this.closePreview()
    })
    w.on('closed', () => {
      if (this.preview !== w) return
      this.preview = null
      this.previewShown = null
      this.painted = null
    })
    return w
  }

  /**
   * The Forge session, set up once: the three permissions it needs, nothing else, and its own file://
   * handler, which serves the page on show and nothing else (the brain window's session keeps the default).
   */
  private prepareSession(): void {
    if (this.sessionReady) return
    this.sessionReady = true
    const ses = this.opts.electron.session.fromPartition(FORGE_PARTITION)
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(forgePermission(permission)))
    ses.setPermissionCheckHandler((_wc, permission) => forgePermission(permission))
    ses.protocol.handle('file', (req) => this.serveFile(ses, req.url))
  }

  /** One file:// request of the Forge session: the page on show (or the hidden copy's), read from disk and sent with FORGE_CSP, or a network error. */
  private async serveFile(ses: Session, url: string): Promise<Response> {
    const file = [this.shown, this.previewShown].find((f) => f !== null && forgeFileRequest(url, f))
    if (!file) return Response.error()
    try {
      // The file itself, not the URL asked for: whatever the URL spells, only the chosen page is ever read.
      const res = await ses.fetch(pathToFileURL(file).href, { bypassCustomProtocolHandlers: true })
      const headers = new Headers(res.headers)
      headers.set('Content-Security-Policy', FORGE_CSP)
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    } catch {
      // Moved or deleted while open: the window shows a load error, and the next `g` asks where it went.
      return Response.error()
    }
  }
}

/** True when `p` is a file right now (a gone network drive answers false within 5 s). */
async function isFile(p: string): Promise<boolean> {
  const check = fs.stat(p).then(
    (st) => st.isFile(),
    () => false,
  )
  return within(check, 5000, false)
}
