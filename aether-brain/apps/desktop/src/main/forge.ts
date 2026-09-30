/**
 * The Concept Forge link: the user's own drawing trainer (a single
 * `concept-forge.html` on their disk) opened in a window of its own, whose
 * "Save to Brain" button files a graded drawing into a project's Critique
 * planet. The Forge window never touches the vault: its requests (the project
 * list, a save) are checked here and relayed to the brain window, whose store
 * does the work and answers.
 *
 * No electron import at runtime (types only) so it can be unit-tested:
 * main.ts hands in the Electron modules. The checks are pure functions.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Dialog,
  Screen,
  Session,
  Shell,
  WebContents,
} from 'electron'
import { IPC, type ForgeProjectDto, type ForgeRequest, type ForgeSaveDto, type ForgeSaveResult, type ForgeStatus } from '../shared/ipc.js'
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
/** What the brain says when it is not there, is not ready, or does not answer. */
export const NO_BRAIN = 'Open your vault in Aether Brain first'
/** The only permissions the page gets: copy a drawing, go fullscreen, lock the pointer (pan / rotate tools). */
export const FORGE_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock'])

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
  if (u.protocol !== 'file:' || !file) return 'deny'
  const windows = platform === 'win32'
  let target: string
  try {
    target = fileURLToPath(u, { windows })
  } catch {
    return 'deny'
  }
  const p = windows ? path.win32 : path.posix
  const a = p.resolve(target)
  const b = p.resolve(file)
  // Windows and macOS file names are case-insensitive.
  return (platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase()) ? 'allow' : 'deny'
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
 * Numbered requests to the brain window and their answers. Each one gets
 * exactly one outcome: the brain's value, the brain's error message, or
 * NO_BRAIN when there is no brain window or it does not answer in time.
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
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(NO_BRAIN))
      }, this.timeoutMs)
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
  /** The file the window shows (navigation may not leave it). */
  private shown: string | null = null
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
      const gone = () => this.relay.rejectAll(NO_BRAIN)
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
    this.shown = file
    try {
      await w.loadFile(file)
    } catch (err) {
      // Closed while loading, or the page moved on by itself (ERR_ABORTED): nothing to report.
      if (w.isDestroyed() || (err instanceof Error && (err as Error & { code?: unknown }).code === 'ERR_ABORTED')) return
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
    wc.on('will-navigate', (e, url) => {
      const action = forgeNavigation(url, this.shown)
      if (action === 'allow') return
      e.preventDefault()
      if (action === 'external') void shell.openExternal(url)
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
    w.on('closed', () => {
      if (this.win === w) {
        this.win = null
        this.shown = null
      }
    })
    // The Forge window belongs to the brain: it closes with it (nothing could answer its saves).
    const brain = this.opts.brain()
    if (brain && !brain.isDestroyed() && !this.hooked.has(brain)) {
      this.hooked.add(brain)
      brain.once('closed', () => this.close())
    }
    return w
  }

  /** Permissions of the Forge session, set once: the three it needs, nothing else. */
  private prepareSession(): void {
    if (this.sessionReady) return
    this.sessionReady = true
    const ses = this.opts.electron.session.fromPartition(FORGE_PARTITION)
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(forgePermission(permission)))
    ses.setPermissionCheckHandler((_wc, permission) => forgePermission(permission))
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
