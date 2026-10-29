/**
 * Aether Brain — Electron main process.
 *
 * Responsibilities, and nothing more:
 *   - remember the vault roots (one folder, or several such as whole drives)
 *   - read, write, create, rename, delete markdown notes and create folders in them (FsVault, path-jailed)
 *   - list the pictures in them, make thumbnails, create new pictures (never replacing anything) and open one in the OS
 *   - watch them (VaultWatcher) and stream debounced change batches to the renderer and the AI link
 *   - run the AI link (the in-app MCP server on 127.0.0.1) when the user switches it on
 *   - open the user's Concept Forge page in a window of its own and relay its saves to the brain (ForgeHost)
 *   - show a reference board in a floating window of its own that stays on top of other programs (BoardWindowHost)
 *
 * No telemetry. The renderer is sandboxed with context isolation and makes no network requests.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, safeStorage, shell, nativeTheme, screen, session } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  IPC,
  type AssetListDto,
  type FolderListDto,
  type ProjectScanDto,
  type ReadAssetResult,
  type SkippedInstallDto,
  type TunnelStatusDto,
  type VaultChangeDto,
  type VaultFileDto,
  type InterruptedStartDto,
  type OpenVaultOptions,
  type VaultInfo,
  type VaultProgressDto,
} from '../shared/ipc.js'
import type { ChatPatch } from '../shared/chat.js'
import { FsVault, isAssetName, isModelName, isAudioName, isFbxName, isOpenableFileName, isPdfName, isPsdName, isVideoName, within } from './fsvault.js'
import { VaultWatcher } from './watcher.js'
import { findProjects } from './projects.js'
import { FilePager, type FilePage } from './pages.js'
import { StartupGuard, latestCrash } from './startup-guard.js'
import { BRAIN_WINDOW_NAME, MemoryTrail, type MemorySample, crashMessage, crashReport, crashReportName, describeTrail, shouldReload } from './crash.js'
import {
  FBX_HEAD_BYTES,
  GLB_HEAD_BYTES,
  MAX_AUDIO_BYTES,
  MAX_FBX_BYTES,
  MAX_MODEL_BYTES,
  MAX_PDF_BYTES,
  MAX_THUMB_FILE_BYTES,
  ThumbCache,
  VIDEO_HEAD_BYTES,
  VIDEO_MIME,
  assetBytes,
  assetPath,
  fbxKindOf,
  modelKindOf,
  PDF_HEAD_BYTES,
  pdfKindOf,
  readHead,
  readPsdComposite,
  readUpTo,
  thumbPx,
  thumbTarget,
  videoKindOf,
} from './assets.js'
import { PDF_SCHEME, THUMB_IPC, Thumbnailer, VIDEO_SCHEME } from './thumbnailer.js'
import { AiLinkHost, aiSettings, cleanPatch, type AiLinkSettings, type LinkVault } from './ai-link.js'
import { makePictureHost } from './ai-pictures.js'
import { TunnelHost } from './tunnel.js'
import { ForgeHost, forgeSettings, type ForgeSettings } from './forge.js'
import { BoardWindowHost, FlushGate, PictureLedger, boardHandlers, boardSettings, guardIpc, type BoardSettings } from './board-window.js'
import { readAssetBytes, readAssetChecked } from './read-asset.js'
import { CompanionHost, companionSettings, type CompanionSettings } from './companion.js'
import { ChatHost, chatSettings, type ChatSettingsStored } from './chat-host.js'
import { LibraryHost, librarySettings, type LibrarySettings } from './library-host.js'
import { VISION_IPC, VISION_SCHEME, VisionHelper } from './library/vision.js'
import { VisionModel } from './library/vision-model.js'
import type { LibraryModelAction, LibraryPatch } from '../shared/library.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The thumbnail helper's session serves videos on this scheme (see thumbnailer.ts): its media
// player streams them in ranges and draws a frame of them, so the scheme must be streamable and
// CORS-enabled. Schemes can only be registered before the app is ready.
// The librarian's vision helper loads its page, the ONNX runtime and the model files on its own
// scheme (see library/vision.ts): standard and secure, so it is an origin that can be cross-origin
// isolated (threads) and fetch from itself.
protocol.registerSchemesAsPrivileged([
  { scheme: VIDEO_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
  // The thumbnail helper draws a PDF with pdf.js, served to its page on this scheme (its three files only: see thumbnailer.ts).
  { scheme: PDF_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: VISION_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
])
const isDev = !!process.env['VITE_DEV_SERVER_URL']
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

interface Settings {
  /** Vault roots to reopen, in order (their order decides the mount names). */
  roots?: string[]
  /** v0.2: the one remembered vault folder (migrated into `roots`). */
  lastVault?: string
  /** Extra folder names skipped while scanning. */
  exclude?: string[]
  /** Folders (absolute paths) left out of the brain (⇧H on a folder; the vault folders panel lets them back in). */
  hidden?: string[]
  /** Folders (absolute paths) shown although they look like an installed game or program. */
  keep?: string[]
  ai?: Partial<AiLinkSettings>
  /** The Concept Forge link (the remembered concept-forge.html). */
  forge?: ForgeSettings
  /** The brain's chat (provider, models, the encrypted API key). */
  chat?: ChatSettingsStored
  /** The librarian: where pictures are sorted from and to. */
  library?: LibrarySettings
  /** The companion link (the Unreal viewer). */
  companion?: Partial<CompanionSettings>
  /** The reference board's floating window: where it was, how big, on top, how dim. */
  board?: BoardSettings
}

let settings: Settings = {}
let saving: Promise<void> = Promise.resolve()

const isString = (x: unknown): x is string => typeof x === 'string' && x.length > 0

/** settings.json, with a v0.2 `lastVault` folded into `roots`. */
async function loadSettings(): Promise<{ settings: Settings; migrated: boolean }> {
  let raw: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
  } catch {
    /* first run or unreadable: defaults */
  }
  const { lastVault, roots, exclude, hidden, keep, ...rest } = raw
  const out: Settings = { ...rest }
  const list = Array.isArray(roots) ? roots.filter(isString) : []
  if (!list.length && isString(lastVault)) list.push(lastVault)
  if (list.length) out.roots = list
  if (Array.isArray(exclude)) out.exclude = cleanNames(exclude)
  if (Array.isArray(hidden)) out.hidden = cleanFolders(hidden)
  if (Array.isArray(keep)) out.keep = cleanFolders(keep)
  return { settings: out, migrated: lastVault !== undefined }
}

/** Write the whole settings object (atomic, one write at a time). */
function saveSettings(): Promise<void> {
  const text = JSON.stringify(settings, null, 2)
  saving = saving
    .then(async () => {
      const file = settingsFile()
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await fs.writeFile(tmp, text)
      await fs.rename(tmp, file)
    })
    .catch((err: unknown) => console.warn('[aether] could not save settings', err))
  return saving
}

/** Folder names to skip: trimmed, no paths, no duplicates (case-insensitive). */
function cleanNames(names: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    const name = String(n).trim()
    if (!name || /[\\/]/.test(name) || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push(name)
  }
  return out
}

/** Absolute folder paths: no relative ones, no duplicates (rootKey). */
function cleanFolders(paths: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (!isString(p) || !path.isAbsolute(p)) continue
    const abs = path.resolve(p)
    if (seen.has(rootKey(abs))) continue
    seen.add(rootKey(abs))
    out.push(abs)
  }
  return out
}

/**
 * A root as typed on the command line or in AETHER_VAULT, made absolute. On
 * Windows, stray quotes go (a shortcut argument `"D:\"` reaches argv as `D:"`)
 * and a bare `D:` means the drive root, not the drive's current folder that
 * path.resolve would use (cmd.exe hands it down).
 */
function rootArg(raw: string): string | null {
  let s = raw.trim()
  if (process.platform === 'win32') {
    s = s.replace(/^"+|"+$/g, '')
    if (/^[A-Za-z]:$/.test(s)) s += '\\'
  }
  return s ? path.resolve(s) : null
}

/** Every non-flag CLI argument is a root: `aether-brain D:\ F:\`. */
function cliRoots(): string[] {
  const args = process.argv.slice(1).filter((a) => a && !a.startsWith('-'))
  // `electron [flags] <app> [roots]` (dev): the first non-flag argument is the app itself.
  if (process.defaultApp) args.shift()
  return args.map(rootArg).filter(isString)
}

/** AETHER_VAULT, split on the platform's path list separator (`;` on Windows, `:` elsewhere). */
function envRoots(): string[] {
  return (process.env['AETHER_VAULT'] ?? '')
    .split(path.delimiter)
    .map(rootArg)
    .filter(isString)
}

/* ------------------------------------------------------------------ */
/* Vault                                                              */
/* ------------------------------------------------------------------ */

let vault: FsVault | null = null
/** An open that crashed the page leaves a note here (startup-guard.ts): the next start does not reopen those folders by itself. */
let guard: StartupGuard | null = null
/** Pictures and videos are left out of the vault for this session (the user chose to open without them after a crash). */
let picturesOff = false
let watcher: VaultWatcher | null = null
/** Bumped by every open and every read, so a slow scan never installs a stale watcher. */
let generation = 0
/** Set once a vault opened in this run; from then on the remembered roots win over CLI / AETHER_VAULT. */
let opened = false
/**
 * Changes for the AI link held while a read is in progress (the watcher starts
 * before the scan); handed over after the snapshot, in order.
 */
let aiHeld: VaultChangeDto[][] | null = null
let win: BrowserWindow | null = null
let ai: AiLinkHost | null = null
/** The tunnel that gives the AI link a public address for ChatGPT and claude.ai (off until the user presses Start). */
let tunnel: TunnelHost | null = null
let chat: ChatHost | null = null
let library: LibraryHost | null = null
let vision: VisionHelper | null = null
let board: BoardWindowHost | null = null
/** Pictures created or removed since the last scan, which `listAssets` does not have (the floating board window needs them). */
const pictureLedger = new PictureLedger()
/** The same for pictures, videos and 3D models together: what the AI link's find_pictures lists (the board's ledger is pictures only). */
const assetLedger = new PictureLedger(isAssetName)
/**
 * The save-before-close handshake of every window that can hold an unsaved board (the board window, the brain window with a docked
 * board) and of the app quitting: a window's first close, and the quit, wait for its page to say it saved (board-window.ts).
 */
const flushGate = new FlushGate()
/**
 * ipcMain with the sender check in front of every handler: the board window's page is answered the board's channels and no other
 * (BOARD_PAGE_CHANNELS), whatever it sends, and on those only for what it may name: the board it shows (`board:read`, `board:save`),
 * a picture or that board to show in the file manager (`vault:reveal`). Every channel is registered through this.
 */
const ipc = guardIpc(
  ipcMain,
  (wc) => board?.isBoardPage(wc) ?? false,
  (channel, args) => board?.pageRefusal(channel, args) ?? null,
)

/** Changes for the AI link's brain: held during a read, else applied now. */
function toAi(changes: VaultChangeDto[]): void {
  if (aiHeld) aiHeld.push(changes)
  else ai?.applyExternal(changes)
}

/**
 * Our own note writes are swallowed by the watcher (`noteSelfWrite`), so the ones who would have heard of them from it hear here: the
 * AI link, and the floating board window, which follows the board it shows (an edit made in the editor, a rename, a delete) and
 * would otherwise write over it with a stale text.
 */
function afterOwnWrite(changes: VaultChangeDto[]): void {
  toAi(changes)
  board?.forward(changes)
}

/** Comparable form of an absolute path (Windows paths are case-insensitive). */
const rootKey = (p: string): string => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))

function uniqueRoots(input: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of input.filter(isString).map((x) => path.resolve(x))) {
    if (seen.has(rootKey(r))) continue
    seen.add(rootKey(r))
    out.push(r)
  }
  return out
}

async function isDir(p: string): Promise<boolean> {
  const check = fs.stat(p).then(
    (st) => st.isDirectory(),
    () => false,
  )
  return within(check, 5000, false)
}

function toRenderer(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function requireVault(): FsVault {
  if (!vault) throw new Error('No vault open')
  return vault
}

function vaultInfo(v: FsVault): VaultInfo {
  return {
    root: v.roots[0]!.abs,
    // One root: its folder name (or `D:\`); several: `D:\ + F:\`.
    name: v.roots.map((r) => r.label).join(' + '),
    roots: v.roots.map((r) => ({ path: r.abs, mount: r.mount, label: r.label })),
    exclude: [...v.exclude],
    hidden: [...v.hidden],
    keep: [...v.keep],
  }
}

/** What the AI link serves: the vault's roots and its folder rules. */
function linkVault(v: FsVault): LinkVault {
  return { roots: v.roots.map((r) => r.abs), exclude: [...v.exclude], hidden: [...v.hidden], keep: [...v.keep] }
}

/** Roots the vault is made of, including remembered ones that are unreachable right now (an unplugged drive). */
function rememberedRoots(): string[] {
  if (!vault) return []
  return settings.roots?.length ? [...settings.roots] : vault.roots.map((r) => r.abs)
}

/**
 * Open one or more folders as the vault. Folders that cannot be reached are
 * skipped (they stay remembered, so an unplugged drive comes back next time);
 * it fails only when none can be opened. Reading happens in listFiles.
 */
async function openVault(input: string[], opts?: OpenVaultOptions): Promise<VaultInfo> {
  const wanted = uniqueRoots(input)
  if (!wanted.length) throw new Error('No folder to open')
  const ok = (await Promise.all(wanted.map(async (r) => ((await isDir(r)) ? r : null)))).filter(isString)
  if (!ok.length) {
    throw new Error(
      wanted.length === 1
        ? `Cannot open ${wanted[0]}: the folder is missing or not reachable.`
        : `None of these folders can be opened: ${wanted.join(', ')}`,
    )
  }
  // `opts` says how to open: an open that was cut short may be tried again without pictures and videos, and a re-open for another
  // reason (folder rules, another folder) keeps what the session was told.
  if (opts) picturesOff = opts.pictures === false
  // From here a page that dies leaves the note that this open did not get through (the page settles it once it has been up a while).
  guard?.begin(wanted)
  const next = new FsVault(ok, {
    exclude: settings.exclude ?? [],
    hidden: settings.hidden ?? [],
    keep: settings.keep ?? [],
    ...(picturesOff ? { maxAssets: 0 } : {}),
  })
  // A floating board belongs to the vault it was opened in: another set of roots changes every vault path (a second root puts a
  // mount in front of them), so its page would read and save paths that are no longer the board's. Folder rules do not (same roots).
  // The window is closed (its page saves first) BEFORE the vault is swapped: that save goes to the vault it was made in.
  if (!vault || vault.roots.length !== ok.length || vault.roots.some((r, i) => rootKey(r.abs) !== rootKey(ok[i]!))) await board?.close()
  generation++
  watcher?.stop()
  watcher = null
  aiHeld = null
  thumbs.clear()
  pictureLedger.clear()
  assetLedger.clear()
  vault = next
  opened = true
  settings.roots = wanted
  await saveSettings()
  // The AI link picks the vault up again once it has been read (listFiles).
  void ai?.setVault(null)
  return vaultInfo(next)
}

/**
 * Scan + read every note with progress events. The watcher (re)starts before
 * the scan and buffers what it sees until the scan is done (seed), so a note
 * or folder created in an already-walked folder while a whole drive is
 * scanned is reported too, as is an edit made while the notes are read (the
 * renderer keeps those until its load is done; the AI link gets them after
 * the snapshot).
 */
/** What of the last list has not gone to the renderer yet (a page at a time: see pages.ts). */
const filePager = new FilePager()

async function listFiles(): Promise<FilePage> {
  const v = requireVault()
  const gen = ++generation
  const latest = () => gen === generation && v === vault
  const progress = (p: VaultProgressDto) => {
    if (gen === generation) toRenderer(IPC.progress, p)
  }
  // A fresh hold: the snapshot below supersedes anything an earlier read's watcher reported.
  aiHeld = []
  try {
    progress({ phase: 'scanning', files: 0, found: 0, dirs: 0, done: false })
    const w = await startWatcher(v)
    const scan = await v
      .scan((p) => progress({ phase: 'scanning', files: 0, found: p.found, dirs: p.dirs, done: false }))
      .catch((err: unknown) => {
        // Nothing to compare its events against: stop it.
        if (watcher === w) {
          w.stop()
          watcher = null
        }
        throw err
      })
    if (latest()) {
      // The new list has every picture the old changes were about; what the watcher reports from here on is new.
      pictureLedger.clear()
      assetLedger.clear()
      w.seed({ files: scan.files.map((f) => f.path), folders: scan.folders, images: scan.assets.map((a) => a.path), imagesCapped: scan.assetsTruncated })
    }
    const found = scan.files.length
    const files = await v.readAll(scan.files, (done) => progress({ phase: 'reading', files: done, found, dirs: scan.dirs, done: false }))
    progress({ phase: 'done', files: files.length, found, dirs: scan.dirs, done: true })
    if (latest()) void ai?.setVault(linkVault(v), { files, folders: scan.folders })
    return filePager.start(files)
  } finally {
    // setVault above already set the link's target, so these land after the snapshot.
    if (latest()) {
      const held = aiHeld ?? []
      aiHeld = null
      for (const changes of held) ai?.applyExternal(changes)
    }
  }
}

/** A new watcher for `v`, watching (once this resolves) but holding its events until seed() (the scan). */
async function startWatcher(v: FsVault): Promise<VaultWatcher> {
  watcher?.stop()
  const w = new VaultWatcher(v, null, (changes) => {
    toRenderer(IPC.changes, changes)
    toAi(changes)
    // The floating board window gets the pictures (no note text) and the board it shows, to keep both right.
    pictureLedger.apply(changes)
    assetLedger.apply(changes)
    board?.forward(changes)
  })
  watcher = w
  await w.start()
  return w
}

/** The renderer only ever reads notes; anything else in the roots (whole drives) stays out of reach. */
async function readNote(p: unknown): Promise<string | null> {
  const v = requireVault()
  const rel = String(p)
  return /\.md$/i.test(rel) ? v.read(rel) : null
}

/** The renderer only ever writes markdown notes; refuse anything else (the roots can be whole drives). */
function notePath(p: unknown): string {
  const s = String(p)
  if (!/\.md$/i.test(s)) throw new Error(`Only markdown notes can be written: ${s}`)
  return s
}

async function writeNote(p: unknown, content: unknown): Promise<void> {
  const v = requireVault()
  const rel = notePath(p)
  const text = String(content)
  const existed = (await v.stat(rel)) !== null
  watcher?.noteSelfWrite(rel, text)
  await v.write(rel, text)
  afterOwnWrite([{ kind: existed ? 'change' : 'add', path: rel, content: text, mtime: Date.now() }])
}

/**
 * A new note: never replaces anything at the path (a note the renderer has
 * not loaded, ignored boilerplate, a case variant). Rejects with a message
 * containing EEXIST; the renderer then tries the next free name.
 */
async function createNote(p: unknown, content: unknown): Promise<void> {
  const v = requireVault()
  const rel = notePath(p)
  const text = String(content)
  watcher?.noteSelfWrite(rel, text)
  try {
    await v.create(rel, text)
  } catch (err) {
    // Whatever is there is not ours: report its changes as usual.
    watcher?.forgetSelfWrite(rel, text)
    throw err
  }
  afterOwnWrite([{ kind: 'add', path: rel, content: text, mtime: Date.now() }])
}

async function deleteNote(p: unknown): Promise<void> {
  const v = requireVault()
  const rel = notePath(p)
  watcher?.noteSelfWrite(rel, null)
  await v.remove(rel)
  afterOwnWrite([{ kind: 'unlink', path: rel }])
}

async function renameNote(from: unknown, to: unknown): Promise<void> {
  const v = requireVault()
  const a = notePath(from)
  const b = notePath(to)
  // The floating window shows this note: its page saves what it has to the note under its old name first.
  await board?.beforeMove(a)
  const content = await v.read(a)
  watcher?.noteSelfWrite(a, null)
  if (content !== null) watcher?.noteSelfWrite(b, content)
  await v.rename(a, b)
  // ... and then follows the note to its new name (before it is told of the change, so that the unlink is not "the board is gone").
  void board?.followMove(a, b)
  const changes: VaultChangeDto[] = [{ kind: 'unlink', path: a }]
  if (content !== null) changes.push({ kind: 'add', path: b, content, mtime: Date.now() })
  afterOwnWrite(changes)
}

async function createFolder(p: unknown): Promise<void> {
  const v = requireVault()
  const rel = String(p)
  await v.mkdir(rel)
  // The watcher reports the new folder to the renderer; the AI link hears about it right away.
  const canonical = v.toVault(v.abs(rel))
  if (canonical) toAi([{ kind: 'addDir', path: canonical }])
}

async function reveal(p: unknown, fromBoardPage = false): Promise<void> {
  const v = requireVault()
  const rel = String(p)
  const st = await v.stat(rel)
  if (!st) throw new Error(`Not in the vault: ${rel}`)
  // The board window's page (its names are judged in the guard) shows a picture, a video or its board: a folder that happens to be
  // called like a picture is none of them.
  if (fromBoardPage && !st.isFile) throw new Error(`Not a file in the vault: ${rel}`)
  shell.showItemInFolder(v.abs(rel))
}

/* ------------------------------------------------------------------ */
/* Pictures                                                           */
/* ------------------------------------------------------------------ */

/** Thumbnails already made, and the ones being made (two requests for the same one share the work). */
const thumbs = new ThumbCache()
const thumbsInFlight = new Map<string, Promise<Uint8Array | null>>()
/** Decodes pictures in a hidden helper renderer, never in this process (see thumbnailer.ts). */
const thumbnailer = new Thumbnailer({
  electron: { BrowserWindow, session },
  preload: path.join(__dirname, '..', 'preload', 'thumb-preload.cjs'),
  // pdf.js and its page module, copied there by scripts/copy-pdfjs.mjs when main is built.
  pdfDir: path.join(__dirname, '..', 'pdfjs'),
})
/**
 * Longest wait for one thumbnail: a share that stopped answering must not hold
 * the renderer's few requests in flight forever (it gets null, a plain moon).
 */
const THUMB_TIMEOUT = 20_000
/** Longest wait for a whole picture (up to 64 MB) from a share that may have stopped answering. */
const READ_ASSET_TIMEOUT = 60_000
/** A video's still that came back empty after this long timed out in the helper (it waits 15 s). */
const VIDEO_GAVE_UP_MS = 14_000

/** Every picture the last scan found, with mtime and size where a stat got to them in time. */
async function listAssets(): Promise<AssetListDto> {
  const v = requireVault()
  const scan = v.lastScan
  if (!scan) return { assets: [], truncated: false }
  return { assets: await v.statAssets(scan.assets), truncated: scan.assetsTruncated, files: await v.statAssets(scan.otherFiles ?? [], 1200) }
}

/**
 * PNG bytes of a picture at most `size` px on its longer side, or null when
 * it is not a picture of the vault, too big, or cannot be decoded. A video's
 * thumbnail is one still frame of it (any size of file: it is streamed to
 * the helper, never read whole). A 3D model's is a square still the helper
 * draws from the file's bytes.
 */
async function thumbnail(p: unknown, size: unknown): Promise<Uint8Array | null> {
  const v = requireVault()
  const px = thumbPx(size)
  const rel = String(p)
  // A model comes in by its own door (`modelAbs`): the one pictures and boards use never opens one.
  const abs = (await v.assetAbs(rel)) ?? (await v.modelAbs(rel)) ?? (await v.previewAbs(rel))
  if (!abs) return null
  const st = await fs.stat(abs).catch(() => null)
  const video = isVideoName(path.basename(abs))
  const model = isModelName(path.basename(abs))
  // A Photoshop document is read for its merged picture only, however many layers it holds (`readPsdComposite` has its own limit).
  const psd = isPsdName(path.basename(abs))
  const pdf = isPdfName(path.basename(abs))
  const fbx = isFbxName(path.basename(abs))
  const audio = isAudioName(path.basename(abs))
  if (!st?.isFile() || st.size === 0 || (!video && !psd && !pdf && !audio && st.size > MAX_THUMB_FILE_BYTES)) return null
  const key = ThumbCache.key(abs, st.mtimeMs, st.size, px)
  const hit = thumbs.get(key)
  if (hit !== undefined) return hit
  let job = thumbsInFlight.get(key)
  if (!job) {
    job = (video ? renderVideoThumb(abs, px) : model ? renderModelThumb(abs, px) : psd ? renderPsdThumb(abs, px) : pdf ? renderPdfThumb(abs, px) : fbx ? renderFbxThumb(abs, px) : audio ? renderAudioThumb(abs, px) : renderThumb(abs, px))
      .then(
        (png) => {
          // A picture that cannot be decoded is an answer too (null, cached for this version of the
          // file): the renderer shows a plain moon, and asks again once the file changes.
          thumbs.set(key, png)
          return png
        },
        // No answer this time (the file could not be read, the helper was stopped): not remembered.
        () => null,
      )
      .finally(() => thumbsInFlight.delete(key))
    thumbsInFlight.set(key, job)
  }
  return job
}

/**
 * Reads the picture here (asynchronously, never more than 64 MB) and has the
 * thumbnail helper decode it, fitted to `px` from the size its header claims:
 * decoding in this process would block the whole app (nativeImage decodes on
 * the UI thread, Windows' thumbnailer too for a picture not in its cache).
 */
async function renderThumb(abs: string, px: number): Promise<Uint8Array | null> {
  const bytes = await readUpTo(abs, MAX_THUMB_FILE_BYTES)
  if (!bytes) return null
  const target = thumbTarget(bytes, px)
  return target ? thumbnailer.render({ bytes, ...target }) : null
}

/**
 * A 3D model's still, drawn by the thumbnail helper: main reads the file here
 * (asynchronously, never more than 64 MB), checks that it starts like a binary
 * glTF and sends the bytes; it parses and draws nothing itself. A file that
 * is not one gets no thumbnail (a plain moon).
 */
async function renderModelThumb(abs: string, px: number): Promise<Uint8Array | null> {
  const bytes = await readUpTo(abs, MAX_MODEL_BYTES)
  if (!bytes || !modelKindOf(bytes)) return null
  return thumbnailer.renderModel(bytes, px)
}

/**
 * The flattened picture of a Photoshop document, drawn by the thumbnail helper: main reads only the header and the merged picture (the
 * layers, usually most of the file, are never read) and sends those bytes; it decodes nothing itself.
 */
async function renderPsdThumb(abs: string, px: number): Promise<Uint8Array | null> {
  const bytes = await readPsdComposite(abs)
  return bytes ? thumbnailer.renderPsd(bytes, px) : null
}

/**
 * A song's waveform, drawn by the thumbnail helper: main reads the file here (asynchronously, at most `MAX_AUDIO_BYTES`) and sends the
 * bytes; the helper decodes them with Chromium's own decoder and draws the peaks. A file Chromium cannot decode gets no picture.
 */
async function renderAudioThumb(abs: string, px: number): Promise<Uint8Array | null> {
  const bytes = await readUpTo(abs, MAX_AUDIO_BYTES)
  return bytes ? thumbnailer.renderAudio(bytes, px) : null
}

/**
 * An FBX model's still, drawn by the thumbnail helper like a glb: main reads the file here (asynchronously, at most `MAX_FBX_BYTES`), checks
 * that it starts like a binary FBX and sends the bytes; it parses and draws nothing itself.
 */
async function renderFbxThumb(abs: string, px: number): Promise<Uint8Array | null> {
  const bytes = await readUpTo(abs, MAX_FBX_BYTES)
  if (!bytes || !fbxKindOf(bytes.subarray(0, FBX_HEAD_BYTES))) return null
  return thumbnailer.renderFbx(bytes, px)
}

/**
 * The first page of a PDF, drawn by the thumbnail helper's page with pdf.js: main reads the file here (asynchronously, at most
 * `MAX_PDF_BYTES`), checks that it holds `%PDF-` near its start and sends the bytes; it parses nothing itself.
 */
async function renderPdfThumb(abs: string, px: number): Promise<Uint8Array | null> {
  const bytes = await readUpTo(abs, MAX_PDF_BYTES)
  if (!bytes || !pdfKindOf(bytes.subarray(0, PDF_HEAD_BYTES))) return null
  return thumbnailer.renderPdf(bytes, px)
}

/**
 * A still frame of a video, made by the thumbnail helper from the file served
 * to it (main reads nothing but its first bytes, to check it is a video).
 */
async function renderVideoThumb(abs: string, px: number): Promise<Uint8Array | null> {
  const kind = videoKindOf(await readHead(abs, VIDEO_HEAD_BYTES))
  // Chromium has no MPEG-TS decoder: no still (the OS player still plays it).
  if (!kind || kind === 'mpegts') return null
  const started = Date.now()
  const png = await thumbnailer.renderVideo(abs, VIDEO_MIME[kind], px)
  // No still because the helper gave up waiting (a share that stopped answering): asked again later, not remembered.
  if (!png && Date.now() - started >= VIDEO_GAVE_UP_MS) throw new Error('The video did not answer in time')
  return png
}

/**
 * A new picture (a dropped file, a Concept Forge drawing): a picture path,
 * bytes that really are a picture, at most 40 MB, created without ever
 * replacing anything (EEXIST, like notes). The watcher reports it to the
 * renderer; the AI link hears about it (and a folder made for it) right away.
 */
async function createAsset(p: unknown, data: unknown): Promise<void> {
  const v = requireVault()
  const rel = assetPath(p)
  const bytes = assetBytes(data)
  const canonical = v.toVault(v.abs(rel))
  if (canonical === null) throw new Error(`Not in the vault: ${rel}`)
  const parent = canonical.includes('/') ? canonical.slice(0, canonical.lastIndexOf('/')) : ''
  const madeFolder = parent !== '' && (await v.stat(parent)) === null
  await v.createBinary(rel, bytes)
  pictureLedger.add(canonical, { mtime: Date.now(), size: bytes.length })
  assetLedger.add(canonical, { mtime: Date.now(), size: bytes.length })
  const changes: VaultChangeDto[] = madeFolder ? [{ kind: 'addDir', path: parent }] : []
  changes.push({ kind: 'add', path: canonical, mtime: Date.now(), size: bytes.length })
  toAi(changes)
}

/**
 * Open a picture, video or 3D model of the vault in the OS default app (a
 * video plays there, never in the brain; a model opens in the 3D app). Those
 * only: shell.openPath would run a program just the same. A video or a model
 * must also start like one.
 */
async function openAsset(p: unknown): Promise<void> {
  const v = requireVault()
  const rel = String(p)
  const abs = (await v.assetAbs(rel)) ?? (await v.modelAbs(rel))
  if (!abs) {
    // Any other file (an mp3, a pdf, a zip): opened only when it is a kind the OS opens safely, else shown in its folder.
    const file = await v.fileAbs(rel)
    if (!file) throw new Error(`Not a file in the vault: ${rel}`)
    if (!isOpenableFileName(path.basename(file))) {
      shell.showItemInFolder(file)
      return
    }
    const failed = await shell.openPath(file)
    if (failed) throw new Error(`Could not open ${rel}: ${failed}`)
    return
  }
  if (isVideoName(path.basename(abs)) && !videoKindOf(await readHead(abs, VIDEO_HEAD_BYTES))) throw new Error(`Not a video: ${rel}`)
  if (isModelName(path.basename(abs))) {
    const st = await fs.stat(abs)
    if (!modelKindOf(await readHead(abs, GLB_HEAD_BYTES), st.size)) throw new Error(`Not a model: ${rel}`)
  }
  const err = await shell.openPath(abs)
  if (err) throw new Error(`Could not open ${rel}: ${err}`)
}

/** OS folder picker; null when cancelled. */
async function chooseFolder(title: string, message: string): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = { title, message, properties: ['openDirectory', 'createDirectory'] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  const dir = res.filePaths[0]
  return res.canceled || !dir ? null : dir
}

/** Add a folder (or a whole drive) as another root and reopen; opens it alone when no vault is open. */
async function addRootPath(p: unknown): Promise<VaultInfo> {
  const abs = path.resolve(String(p))
  if (!(await isDir(abs))) throw new Error(`Cannot add ${abs}: the folder is missing or not reachable.`)
  const base = rememberedRoots()
  if (vault && base.some((r) => rootKey(r) === rootKey(abs))) return vaultInfo(vault)
  return openVault([...base, abs])
}

async function removeRoot(p: unknown): Promise<VaultInfo> {
  const v = requireVault()
  const key = rootKey(String(p))
  const remembered = rememberedRoots()
  const rest = remembered.filter((r) => rootKey(r) !== key)
  if (!v.roots.some((r) => rootKey(r.abs) === key)) {
    if (rest.length === remembered.length) throw new Error(`Not a folder of this vault: ${String(p)}`)
    // Remembered but not reachable (a drive that is gone): forget it, nothing to reopen.
    settings.roots = rest
    await saveSettings()
    return vaultInfo(v)
  }
  if (v.roots.length <= 1) throw new Error('A vault needs at least one folder. Add another one before removing this.')
  return openVault(rest)
}

async function setExclude(names: unknown): Promise<VaultInfo> {
  requireVault()
  settings.exclude = cleanNames(Array.isArray(names) ? names : [])
  await saveSettings()
  return openVault(rememberedRoots())
}

/**
 * Leave one folder (a vault path) out of the brain: remembered by its
 * absolute path, applied at once without a rescan (the watcher unlinks what
 * was known under it). Nothing on disk changes. A root is removed in the
 * vault folders panel instead.
 */
async function hideFolder(p: unknown): Promise<VaultInfo> {
  const v = requireVault()
  const abs = v.abs(String(p))
  if (v.roots.some((r) => rootKey(r.abs) === rootKey(abs))) {
    throw new Error('That is a whole vault folder: remove it in the vault folders panel (v) instead')
  }
  return setFolderRules({ hidden: [...(settings.hidden ?? []), abs] })
}

/** Let a folder (a vault path) left out with hideFolder back in. */
function unhideFolder(p: unknown): Promise<VaultInfo> {
  const v = requireVault()
  const key = rootKey(v.abs(String(p)))
  return setFolderRules({ hidden: (settings.hidden ?? []).filter((h) => rootKey(h) !== key) })
}

/**
 * New folder rules (absolute paths): folders left out, installs kept.
 * Applied live: every folder whose rule changed is looked at again by the
 * watcher (unlinked when now skipped, walked and reported when now shown).
 */
async function setFolderRules(rules: { hidden?: unknown; keep?: unknown }): Promise<VaultInfo> {
  const v = requireVault()
  const before = { hidden: settings.hidden ?? [], keep: settings.keep ?? [] }
  if (rules.hidden !== undefined) settings.hidden = cleanFolders(Array.isArray(rules.hidden) ? rules.hidden : [])
  if (rules.keep !== undefined) settings.keep = cleanFolders(Array.isArray(rules.keep) ? rules.keep : [])
  await saveSettings()
  v.hidden = settings.hidden ?? []
  v.keep = settings.keep ?? []
  const keys = (l: string[]) => new Set(l.map(rootKey))
  const minus = (a: string[], b: string[]) => {
    const kb = keys(b)
    return a.filter((x) => !kb.has(rootKey(x)))
  }
  const hiddenNow = settings.hidden ?? []
  const keepNow = settings.keep ?? []
  // [folder, recheck]: a folder no longer kept is looked into again (is it still an install?).
  const look: [string, boolean][] = [
    ...minus(before.hidden, hiddenNow).map((x): [string, boolean] => [x, false]),
    ...minus(hiddenNow, before.hidden).map((x): [string, boolean] => [x, false]),
    ...minus(keepNow, before.keep).map((x): [string, boolean] => [x, false]),
    ...minus(before.keep, keepNow).map((x): [string, boolean] => [x, true]),
  ]
  for (const [abs, recheck] of look) {
    const vp = v.toVault(abs)
    if (vp) watcher?.refresh(vp, { recheck })
  }
  ai?.setFolderRules(linkVault(v))
  return vaultInfo(v)
}

/** Install folders the scans and the watcher left out so far, as absolute paths. */
/** The Find projects run going on (a newer run, a stop or another vault ends it). */
let findRun = 0

/** The vault's project folders among the folders of its last scan (one listing each; nothing written). */
async function findProjectFolders(): Promise<ProjectScanDto> {
  const v = requireVault()
  const run = ++findRun
  const scan = v.lastScan
  const ended = () => run !== findRun || vault !== v
  const res = await findProjects(v, scan ? [...scan.folders] : [], {
    cancelled: ended,
    onProgress: (done, total) => {
      if (!ended()) toRenderer(IPC.findProgress, { done, total })
    },
  })
  return { ...res, truncated: res.truncated || (scan?.truncated ?? false), cancelled: ended() }
}

function skippedInstalls(): SkippedInstallDto[] {
  const v = vault
  if (!v) return []
  const out: SkippedInstallDto[] = []
  for (const i of v.installs()) {
    try {
      out.push({ path: v.abs(i.path), kind: i.kind })
    } catch {
      /* a root that is gone */
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** Drive roots on Windows (`C:\`, `D:\`, …) that answer within a moment; empty elsewhere. */
async function listDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const probe = async (l: string): Promise<string | null> => {
    const root = `${l}:\\`
    const ok = await within(
      fs.access(root).then(
        () => true,
        () => false,
      ),
      1500,
      false,
    )
    return ok ? root : null
  }
  return (await Promise.all(letters.map(probe))).filter(isString)
}

/* ------------------------------------------------------------------ */
/* AI link                                                            */
/* ------------------------------------------------------------------ */

function createAiLink(): AiLinkHost {
  // Built by `pnpm build:mcp` next to dist/main; asar-unpacked in the packaged app so
  // Claude Desktop can run the same file with this executable (ELECTRON_RUN_AS_NODE=1).
  const devBundle = path.join(__dirname, '..', 'mcp', 'aether-mcp.mjs')
  const serverScript = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'mcp', 'aether-mcp.mjs')
    : devBundle
  const initial = aiSettings(settings.ai)
  if (JSON.stringify(initial) !== JSON.stringify(settings.ai)) {
    // First run (or a damaged entry): persist the generated token so URLs stay stable.
    settings.ai = initial
    void saveSettings()
  }
  return new AiLinkHost({
    settings: initial,
    save: (s) => {
      settings.ai = s
      return saveSettings()
    },
    onActivity: (a) => toRenderer(IPC.aiActivity, a),
    currentVault: () => (vault ? linkVault(vault) : null),
    // Packaged: import the real unpacked file, the one the client configs point at.
    bundlePath: app.isPackaged ? serverScript : devBundle,
    serverScript,
    execPath: process.execPath,
    portable: !!process.env['PORTABLE_EXECUTABLE_DIR'],
    // What only the running app can offer the AI: the pictures (through the helper that decodes them) and the window.
    pictures: makePictureHost({
      // The last scan with what the watcher reported since: a picture an AI sent a moment ago is found at once.
      paths: () => {
        const scan = vault?.lastScan
        return scan ? assetLedger.list(scan.assets).map((a) => a.path) : null
      },
      stat: (paths) => {
        const v = requireVault()
        return v.statAssets(paths.map((p) => ({ path: p, abs: v.abs(p) })))
      },
      open: async (p) => {
        const v = vault
        if (!v) return null
        const abs = (await v.assetAbs(p)) ?? (await v.modelAbs(p))
        return abs ? { abs, path: v.toVault(abs) ?? p } : null
      },
      thumbnail: (p, px) => within(thumbnail(p, px), THUMB_TIMEOUT, null),
    }),
    show: (target) => {
      if (!win || win.isDestroyed()) throw new Error('The Aether Brain window is not open. Ask the user to open the app, then try again.')
      toRenderer(IPC.aiShow, target)
    },
  })
}

/**
 * cloudflared is downloaded through a session of its own (in memory), as the vision model is: the app's own session refuses the web,
 * and the system proxy applies to this one.
 */
const TUNNEL_DOWNLOAD_PARTITION = 'aether-tunnel-download'

function createTunnel(): TunnelHost {
  return new TunnelHost({
    dir: path.join(app.getPath('userData'), 'tunnel'),
    fetch: (url, init) => session.fromPartition(TUNNEL_DOWNLOAD_PARTITION).fetch(url, init),
    emit: (s) => toRenderer(IPC.tunnelState, s),
  })
}

function requireTunnel(): TunnelHost {
  if (!tunnel) throw new Error('The tunnel is not ready yet')
  return tunnel
}

/**
 * Start the tunnel: it needs the AI link listening, so a press on Start switches the link on first when it is off (the user asked
 * for ChatGPT to reach the brain, which is what the link is for).
 */
async function startTunnel(): Promise<TunnelStatusDto> {
  const link = requireAi()
  let st = link.status()
  if (!st.enabled || !st.running) st = await link.configure({ enabled: true })
  if (!st.running) throw new Error(st.error ?? 'The AI link did not start. Open a vault folder first.')
  return requireTunnel().start(st.port)
}

/* ------------------------------------------------------------------ */
/* The brain's chat                                                   */
/* ------------------------------------------------------------------ */

function createChat(): ChatHost {
  const initial = chatSettings(settings.chat)
  return new ChatHost({
    settings: initial,
    save: (s) => {
      settings.chat = s
      return saveSettings()
    },
    brain: () => requireAi().useBrain(),
    vaultOpen: () => vault !== null,
    wantBrain: (on) => void ai?.wantBrain(on),
    emit: (e) => toRenderer(IPC.chatEvent, e),
    keychain: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
    },
  })
}

function requireChat(): ChatHost {
  if (!chat) throw new Error('The chat is not ready yet')
  return chat
}

/* ------------------------------------------------------------------ */
/* The librarian                                                      */
/* ------------------------------------------------------------------ */

/** The model is downloaded through a session of its own (in memory): the app's own session refuses the web. */
const VISION_DOWNLOAD_PARTITION = 'aether-vision-download'

/** Where pictures are sorted from and to until the user picks: `D:\` → `F:\MASTERIMAGES` on Windows. */
function libraryDefaults(): { source: string; dest: string } {
  if (process.platform === 'win32') return { source: 'D:\\', dest: 'F:\\MASTERIMAGES' }
  return { source: path.join(os.homedir(), 'Pictures'), dest: path.join(os.homedir(), 'MASTERIMAGES') }
}

/** The vault path of an absolute path the brain shows (inside a root, not in a skipped folder), else null. */
function shownVaultPath(abs: string): string | null {
  if (!vault) return null
  const vp = vault.toVault(abs)
  return vp !== null && !vault.isIgnored(vp) ? vp : null
}

function createLibrary(): LibraryHost {
  const userData = app.getPath('userData')
  const model = new VisionModel(
    path.join(userData, 'vision-models'),
    (url, init) => session.fromPartition(VISION_DOWNLOAD_PARTITION).fetch(url, init),
    process.env['AETHER_VISION_MODEL_URL'] || undefined,
  )
  const helper = new VisionHelper({
    electron: { BrowserWindow, session },
    preload: path.join(__dirname, '..', 'preload', 'vision-preload.cjs'),
    appDir: path.join(__dirname, '..', 'vision'),
    model,
  })
  vision = helper
  return new LibraryHost({
    initial: librarySettings(settings.library),
    defaults: libraryDefaults(),
    save: (s) => {
      settings.library = s
      void saveSettings()
    },
    emit: (e) => toRenderer(IPC.libraryEvent, e),
    eyes: () => helper,
    restEyes: () => helper.stop(),
    model,
    cacheFile: path.join(userData, 'library-looks.json'),
    toVault: shownVaultPath,
    thumb: (abs, px) => renderThumb(abs, px),
  })
}

function requireLibrary(): LibraryHost {
  if (!library) throw new Error('The librarian is not ready yet')
  return library
}

function requireAi(): AiLinkHost {
  if (!ai) throw new Error('The AI link is not ready yet')
  return ai
}

/* ------------------------------------------------------------------ */
/* Concept Forge link                                                 */
/* ------------------------------------------------------------------ */

function createForge(): ForgeHost {
  return new ForgeHost({
    electron: { BrowserWindow, dialog, shell, session, screen },
    settings: forgeSettings(settings.forge),
    save: (s) => {
      settings.forge = s
      return saveSettings()
    },
    brain: () => win,
    preload: path.join(__dirname, '..', 'preload', 'forge-preload.cjs'),
    version: app.getVersion(),
  })
}

function createBoardWindow(): BoardWindowHost {
  return new BoardWindowHost({
    electron: { BrowserWindow, screen, shell, dialog, Menu },
    settings: boardSettings(settings.board),
    save: (s) => {
      settings.board = s
      return saveSettings()
    },
    brain: () => win,
    // The board page's own preload (the board calls, the pictures, nothing else); the default session, no partition.
    preload: path.join(__dirname, '..', 'preload', 'board-preload.cjs'),
    devUrl: process.env['VITE_DEV_SERVER_URL'] ?? null,
    pageFile: path.join(__dirname, '..', 'renderer', 'board.html'),
    gate: flushGate,
  })
}

/**
 * Either window opens, closes and sets up the floating board window; its page reads and saves the board it shows (only a board
 * note that is already there, see board-save.ts; the guard refuses it any other path) and learns of the vault's pictures from here,
 * since it is not the brain window.
 * The handlers are plain functions (boardHandlers): this only wires them to their channels. `board:open` is the brain window's
 * alone (the guard refuses it to the board page), and the answer to a flush is the page's.
 */
function registerBoardIpc(host: BoardWindowHost): void {
  const h = boardHandlers({ host, vault: () => vault, scan: () => vault?.lastScan ?? null, ledger: pictureLedger })
  ipc.handle(IPC.boardOpen, (_e, p: unknown) => h.open(p))
  ipc.handle(IPC.boardClose, () => h.close())
  ipc.handle(IPC.boardStatus, () => h.status())
  ipc.handle(IPC.boardConfigure, (_e, patch: unknown) => h.configure(patch))
  ipc.handle(IPC.boardSave, (_e, p: unknown, text: unknown, base: unknown) => h.save(p, text, base))
  ipc.on(IPC.boardFlushed, (e, token: unknown) => flushGate.ack(e.sender.id, token))
  ipc.handle(IPC.boardRead, (_e, p: unknown) => h.read(p))
  ipc.handle(IPC.boardAssets, () => h.assets())
}

/**
 * The brain window opens the Forge window; the Forge window's requests go through the host to the brain window's
 * store; the brain window's Concept Forge star gets frames of the page while its screen is in view.
 */
function registerForgeIpc(forge: ForgeHost): void {
  ipc.handle(IPC.forgeOpen, (_e, opts: unknown) => forge.open(opts))
  ipc.handle(IPC.forgeStatus, () => forge.status())
  ipc.handle(IPC.forgeProjects, (e) => forge.projects(e.sender))
  ipc.handle(IPC.forgeSave, (e, dto: unknown) => forge.save(e.sender, dto))
  ipc.handle(IPC.forgeReply, (e, id: unknown, ok: unknown, value: unknown) => forge.reply(e.sender, id, ok, value))
  ipc.handle(IPC.forgeScreen, (e, on: unknown) => forge.screen(e.sender, on))
}

/* ------------------------------------------------------------------ */
/* Companion link (the Unreal viewer)                                 */
/* ------------------------------------------------------------------ */

let companion: CompanionHost | null = null

function createCompanion(): CompanionHost {
  const initial = companionSettings(settings.companion)
  if (JSON.stringify(initial) !== JSON.stringify(settings.companion)) {
    // First run (or a damaged entry): keep the generated token, so a viewer set up by hand keeps working.
    settings.companion = initial
    void saveSettings()
  }
  return new CompanionHost({
    settings: initial,
    save: (s) => {
      settings.companion = s
      return saveSettings()
    },
    brain: () => (win && !win.isDestroyed() ? win.webContents : null),
    connectionFile: path.join(app.getPath('userData'), 'companion.json'),
    version: app.getVersion(),
    // A window covered by the Unreal app is "in the background": Chromium would slow its timers to once a second
    // and then once a minute, and the scene would stop reaching the viewer. While one reads, it runs at full speed.
    onWanted: (on) => {
      if (win && !win.isDestroyed()) win.webContents.setBackgroundThrottling(!on)
    },
  })
}

/** The brain window publishes the scene; viewers read it over HTTP; the panel switches it. */
function registerCompanionIpc(host: CompanionHost): void {
  ipc.handle(IPC.companionStatus, () => host.status())
  ipc.handle(IPC.companionConfigure, (_e, patch: unknown) => host.configure(patch))
  ipc.on(IPC.companionGraph, (e, graph: unknown) => void host.publishGraph(e.sender.id, graph))
  ipc.on(IPC.companionPositions, (e, version: unknown, positions: unknown, rings: unknown) => void host.publishPositions(e.sender.id, version, positions, rings))
}

/* ------------------------------------------------------------------ */
/* IPC                                                                */
/* ------------------------------------------------------------------ */

/** What the page is told when the last open did not get through: the folders, and what the newest crash report since says. */
function interruptedStart(): InterruptedStartDto | null {
  const a = guard?.interrupted()
  if (!a) return null
  const crash = latestCrash(path.join(app.getPath('userData'), 'crash-reports'), a.at)
  const samples = (crash?.memory ?? []).filter(
    (m): m is MemorySample => !!m && typeof m === 'object' && typeof (m as MemorySample).pageMB === 'number' && typeof (m as MemorySample).t === 'number',
  )
  return { roots: a.roots, at: a.at, died: a.died, report: crash?.file ?? null, memory: describeTrail(samples), vault: crash?.vault ?? null }
}

/** The vault in numbers, for a crash report: what was being held when the page died. */
function vaultCounts(): Record<string, number | string> | undefined {
  if (!vault) return undefined
  const scan = vault.lastScan
  return {
    roots: vault.roots.length,
    notes: scan?.files.length ?? 0,
    folders: scan?.folders.length ?? 0,
    pictures: scan?.assets.length ?? 0,
    foldersScanned: scan?.dirs ?? 0,
    scanStoppedEarly: scan?.truncated ? 'yes' : 'no',
    picturesCut: scan?.assetsTruncated ? 'yes' : 'no',
    picturesOff: picturesOff ? 'yes' : 'no',
  }
}

function registerIpc(): void {
  ipc.handle(IPC.pick, async (): Promise<VaultInfo | null> => {
    const dir = await chooseFolder(
      'Choose your vault folder',
      'Pick a folder of markdown notes. Aether Brain reads and writes .md files in place.',
    )
    return dir ? openVault([dir], { pictures: true }) : null
  })
  ipc.handle(IPC.open, (_e, roots: unknown, opts: unknown) =>
    openVault(
      Array.isArray(roots) ? roots.map(String) : [String(roots)],
      // An open asked for by the page says how it wants pictures (none given: as usual); the opens main makes itself keep the session's.
      { pictures: opts && typeof opts === 'object' ? (opts as OpenVaultOptions).pictures !== false : true },
    ),
  )
  // The page asks once as it starts: did the last open get through? If not, it does not reopen the folders by itself (startup-guard.ts).
  ipc.handle(IPC.interrupted, (): InterruptedStartDto | null => interruptedStart())
  // Only the brain window can say its vault got through.
  ipc.on(IPC.settled, (e) => {
    if (win && !win.isDestroyed() && e.sender === win.webContents) guard?.settle()
  })
  // At launch `aether-brain D:\ F:\` or AETHER_VAULT wins over the remembered roots. Once a vault
  // is open the remembered set is the truth: roots added or removed since then (the vault folders
  // panel lists remembered roots it could not open) and a reloaded window keep them.
  ipc.handle(IPC.last, (): string[] | null => {
    if (!opened) {
      const cli = cliRoots()
      if (cli.length) return cli
      const env = envRoots()
      if (env.length) return env
    }
    return settings.roots?.length ? [...settings.roots] : null
  })
  ipc.handle(IPC.info, (): VaultInfo | null => (vault ? vaultInfo(vault) : null))
  ipc.handle(IPC.addRoot, async (): Promise<VaultInfo | null> => {
    const dir = await chooseFolder('Add a folder to the vault', 'Its folders become planets in the brain, next to the ones already there.')
    return dir ? addRootPath(dir) : null
  })
  ipc.handle(IPC.addRootPath, (_e, p: unknown) => addRootPath(p))
  ipc.handle(IPC.removeRoot, (_e, p: unknown) => removeRoot(p))
  ipc.handle(IPC.setExclude, (_e, names: unknown) => setExclude(names))
  ipc.handle(IPC.hideFolder, (_e, p: unknown) => hideFolder(p))
  ipc.handle(IPC.unhideFolder, (_e, p: unknown) => unhideFolder(p))
  ipc.handle(IPC.setFolderRules, (_e, rules: unknown) =>
    setFolderRules(rules && typeof rules === 'object' ? (rules as { hidden?: unknown; keep?: unknown }) : {}),
  )
  ipc.handle(IPC.skippedInstalls, () => skippedInstalls())
  ipc.handle(IPC.findProjects, () => findProjectFolders())
  ipc.handle(IPC.findProjectsStop, () => void findRun++)
  ipc.handle(IPC.drives, () => listDrives())
  ipc.handle(IPC.list, () => listFiles())
  ipc.handle(IPC.listMore, (_e, token: unknown) => filePager.more(Number(token)))
  ipc.handle(IPC.folders, (): FolderListDto => {
    const scan = requireVault().lastScan
    return { folders: scan ? [...scan.folders] : [], truncated: scan?.truncated ?? false }
  })
  ipc.handle(IPC.read, (_e, p: unknown) => readNote(p))
  ipc.handle(IPC.write, (_e, p: unknown, content: unknown) => writeNote(p, content))
  ipc.handle(IPC.create, (_e, p: unknown, content: unknown) => createNote(p, content))
  ipc.handle(IPC.delete, (_e, p: unknown) => deleteNote(p))
  ipc.handle(IPC.rename, (_e, a: unknown, b: unknown) => renameNote(a, b))
  ipc.handle(IPC.mkdir, (_e, p: unknown) => createFolder(p))
  ipc.handle(IPC.reveal, (e, p: unknown) => reveal(p, board?.isBoardPage(e.sender) ?? false))
  ipc.handle(IPC.assets, () => listAssets())
  ipc.handle(IPC.thumb, (_e, p: unknown, size: unknown) => within(thumbnail(p, size), THUMB_TIMEOUT, null))
  // From the thumbnail helper only: the thumbnailer ignores every other sender.
  ipc.on(THUMB_IPC.ready, (e) => thumbnailer.ready(e.sender))
  ipc.on(THUMB_IPC.done, (e, id: unknown, png: unknown) => thumbnailer.done(e.sender, id, png))
  ipc.handle(IPC.createAsset, (_e, p: unknown, data: unknown) => createAsset(p, data))
  ipc.handle(IPC.openAsset, (_e, p: unknown) => openAsset(p))
  // A whole picture for the reference board to decode (never decoded here); null for anything but a picture of the open vault.
  ipc.handle(IPC.readAsset, (_e, p: unknown) => (vault && typeof p === 'string' ? within(readAssetBytes(vault, p), READ_ASSET_TIMEOUT, null) : null))
  // The same, with the reason when there are no bytes (missing, too large, unreadable) so that the board can say why.
  ipc.handle(IPC.readAssetChecked, (_e, p: unknown): Promise<ReadAssetResult> | ReadAssetResult =>
    vault && typeof p === 'string'
      ? within<ReadAssetResult>(readAssetChecked(vault, p), READ_ASSET_TIMEOUT, { ok: false, reason: 'unreadable', detail: 'The picture did not answer in time' })
      : { ok: false, reason: 'missing', detail: 'No vault is open' },
  )
  ipc.handle(IPC.chatStatus, () => requireChat().status())
  ipc.handle(IPC.chatConfigure, (_e, patch: unknown) => requireChat().configure(patch && typeof patch === 'object' ? (patch as ChatPatch) : {}))
  ipc.handle(IPC.chatOllama, () => requireChat().ollamaCheck())
  ipc.handle(IPC.chatSend, (_e, conv: unknown, text: unknown) => requireChat().send(conv, text))
  ipc.handle(IPC.chatStop, (_e, conv: unknown) => requireChat().stop(conv))
  ipc.handle(IPC.chatForget, (_e, conv: unknown) => requireChat().forget(conv))
  ipc.handle(IPC.libraryStatus, () => requireLibrary().status())
  ipc.handle(IPC.libraryConfigure, (_e, patch: unknown) => requireLibrary().configure(patch && typeof patch === 'object' ? (patch as LibraryPatch) : {}))
  ipc.handle(IPC.libraryPick, async (_e, which: unknown) => {
    const lib = requireLibrary()
    const dest = which === 'dest'
    const dir = await chooseFolder(
      dest ? 'Where should the library go?' : 'Which folder or drive should the librarian sort?',
      dest ? 'Pictures are copied into this folder, sorted by type, genre and year.' : 'Every picture in it is copied (never moved or changed).',
    )
    return dir ? lib.configure(dest ? { dest: dir } : { source: dir }) : lib.status()
  })
  ipc.handle(IPC.libraryAnalyze, () => requireLibrary().analyze())
  ipc.handle(IPC.libraryCopy, () => requireLibrary().copy())
  ipc.handle(IPC.libraryStop, () => requireLibrary().stop())
  ipc.handle(IPC.libraryModel, (_e, action: unknown) =>
    requireLibrary().model(action === 'cancel' || action === 'remove' ? (action as LibraryModelAction) : 'download'),
  )
  ipc.handle(IPC.libraryThumb, (_e, id: unknown) => within(requireLibrary().thumb(id), THUMB_TIMEOUT, null))
  // From the vision helper only: the helper ignores every other sender.
  ipc.on(VISION_IPC.ready, (e) => vision?.ready(e.sender))
  ipc.on(VISION_IPC.done, (e, id: unknown, answer: unknown) => vision?.done(e.sender, id, answer))
  ipc.handle(IPC.aiStatus, () => requireAi().status())
  ipc.handle(IPC.aiConfigure, async (_e, patch: unknown) => {
    const clean = cleanPatch(patch)
    const st = await requireAi().configure(clean)
    // The tunnel carries the link's port: with the link off or moved it has nothing to carry (and a new link must not be reachable by an old tunnel).
    if (clean.enabled === false || clean.port !== undefined) void tunnel?.stop()
    return st
  })
  ipc.handle(IPC.tunnelStatus, () => requireTunnel().status())
  ipc.handle(IPC.tunnelDownload, () => requireTunnel().download())
  ipc.handle(IPC.tunnelStart, () => startTunnel())
  ipc.handle(IPC.tunnelStop, () => requireTunnel().stop())
  ipc.handle(IPC.copy, (_e, text: unknown) => clipboard.writeText(String(text)))
}

/* ------------------------------------------------------------------ */
/* Window                                                             */
/* ------------------------------------------------------------------ */

function createWindow(): void {
  nativeTheme.themeSource = 'dark'
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#04050d',
    title: 'Aether Brain',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })
  // A window opened while a viewer is reading must not be slowed down for being covered by it either.
  if (companion?.isWanted()) win.webContents.setBackgroundThrottling(false)
  const reveal = () => {
    if (win && !win.isVisible()) win.show()
  }
  win.once('ready-to-show', reveal)
  setTimeout(reveal, 1200)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // A page that died leaves a dark empty window: say why, and open it again (unless it keeps dying). The memory of its page is looked
  // at every two seconds meanwhile, so that the message can say how much it was using and a report is left that says how it got there.
  const crashes: number[] = []
  const trail = new MemoryTrail()
  const look = () => {
    const page = win && !win.isDestroyed() ? win.webContents.getOSProcessId() : 0
    if (!page) return
    let pageMB = 0
    let mainMB = 0
    let gpuMB = 0
    for (const m of app.getAppMetrics()) {
      const mb = m.memory.workingSetSize / 1024
      if (m.pid === page) pageMB = mb
      else if (m.type === 'Browser') mainMB = mb
      else if (m.type === 'GPU') gpuMB = mb
    }
    if (pageMB > 0) trail.add({ t: Date.now(), pageMB, mainMB, gpuMB })
  }
  const watch = setInterval(look, 2000)
  win.once('closed', () => clearInterval(watch))
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    const now = Date.now()
    crashes.push(now)
    const reload = shouldReload(crashes, now)
    const memory = describeTrail(trail.samples)
    // An open that was still pending did not get through: the reloaded page will not reopen those folders by itself.
    guard?.died()
    const counts = vaultCounts()
    const report = crashReport(
      { reason: details.reason, exitCode: details.exitCode, window: BRAIN_WINDOW_NAME, version: app.getVersion(), platform: `${process.platform} ${os.release()}, ${Math.round(os.totalmem() / 1048576)} MB`, now, ...(counts ? { vault: counts } : {}) },
      trail.samples,
    )
    trail.clear()
    if (reload) win?.webContents.reload()
    // The report is written before the message is shown (a few KB; a failure to write it changes nothing else).
    const dir = path.join(app.getPath('userData'), 'crash-reports')
    const file = path.join(dir, crashReportName(now))
    void fs
      .mkdir(dir, { recursive: true })
      .then(() => fs.writeFile(file, JSON.stringify(report, null, 2)))
      .then(() => file)
      .catch(() => '')
      .then((saved) => {
        const text = crashMessage(details.reason, reload, BRAIN_WINDOW_NAME, { memory, report: saved })
        const box = { type: 'error' as const, title: 'Aether Brain', message: text.message, detail: text.detail }
        void (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box))
      })
  })
  // The renderer never needs to navigate away from the app.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env['VITE_DEV_SERVER_URL'] ?? 'file://')) e.preventDefault()
  })
  const devUrl = process.env['VITE_DEV_SERVER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  }
  // A board open in the brain window (docked) saves what it has before the window goes (the page answers `board:flush`).
  flushGate.guardClose(win)
  win.on('closed', () => {
    win = null
    // Nothing asks for thumbnails without the brain window, and a hidden helper left open
    // would keep 'window-all-closed' from ever firing (the app would not quit).
    thumbnailer.stop()
    library?.close()
    vision?.stop()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
/** Set once settings are loaded and IPC is registered (macOS can fire `activate` before that). */
let started = false
app.on('activate', () => {
  if (started && BrowserWindow.getAllWindows().length === 0) createWindow()
})
/** Set once every page has been asked to save for this quit: the quit then goes on, and the closes it makes pass through. */
let quitSaved = false
app.on('before-quit', (e) => {
  if (!quitSaved) {
    // The pages that can hold an unsaved board save first (1.5 s at most; a page that is gone, crashed or still loading is not
    // waited for, so a broken page never keeps the app from quitting).
    const brainPage = win && !win.isDestroyed() ? win.webContents : null
    const asked: Promise<unknown>[] = []
    if (board?.shownPath()) asked.push(board.flushPage())
    if (brainPage && flushGate.askable(brainPage)) asked.push(flushGate.ask(brainPage))
    if (asked.length) {
      e.preventDefault()
      quitSaved = true
      void Promise.allSettled(asked).then(() => {
        // Every page has saved: the closes this quit makes go through without asking again.
        flushGate.openFor(5000)
        app.quit()
        // A quit that something else cancelled (a page that kept its window) asks again next time.
        setTimeout(() => (quitSaved = false), 6000).unref()
      })
      return
    }
  }
  // Quitting by itself: an open cut short by the user is forgotten (one cut short by a dead page stays, see startup-guard.ts).
  guard?.cleanExit()
  watcher?.stop()
  watcher = null
  thumbnailer.stop()
  library?.close()
  vision?.stop()
  board?.flush()
  void chat?.close()
  // The tunnel is told to end here, before the app is: a cloudflared left running would keep the next link on this port reachable.
  void tunnel?.stop()
  void ai?.stop()
  companion?.quit()
})

void app.whenReady().then(async () => {
  // Belt and braces: no permission prompts, no outbound requests from the renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  if (!isDev) {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }))
  }
  const loaded = await loadSettings()
  settings = loaded.settings
  guard = new StartupGuard(path.join(app.getPath('userData'), 'startup.json'))
  if (loaded.migrated) void saveSettings()
  ai = createAiLink()
  tunnel = createTunnel()
  // A tunnel an earlier run left behind (the app was killed) is stopped before anything else can start a link on its port.
  void tunnel.reap()
  chat = createChat()
  library = createLibrary()
  registerIpc()
  createWindow()
  registerForgeIpc(createForge())
  board = createBoardWindow()
  registerBoardIpc(board)
  companion = createCompanion()
  registerCompanionIpc(companion)
  void companion.start()
  started = true
})
