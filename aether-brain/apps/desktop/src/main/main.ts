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
 *
 * No telemetry. The renderer is sandboxed with context isolation and makes no network requests.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell, nativeTheme, screen, session } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  IPC,
  type AssetListDto,
  type FolderListDto,
  type VaultChangeDto,
  type VaultFileDto,
  type VaultInfo,
  type VaultProgressDto,
} from '../shared/ipc.js'
import { FsVault, isVideoName, within } from './fsvault.js'
import { VaultWatcher } from './watcher.js'
import {
  MAX_THUMB_FILE_BYTES,
  ThumbCache,
  VIDEO_HEAD_BYTES,
  VIDEO_MIME,
  assetBytes,
  assetPath,
  readHead,
  readUpTo,
  thumbPx,
  thumbTarget,
  videoKindOf,
} from './assets.js'
import { THUMB_IPC, Thumbnailer, VIDEO_SCHEME } from './thumbnailer.js'
import { AiLinkHost, aiSettings, cleanPatch, type AiLinkSettings } from './ai-link.js'
import { ForgeHost, forgeSettings, type ForgeSettings } from './forge.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The thumbnail helper's session serves videos on this scheme (see thumbnailer.ts): its media
// player streams them in ranges and draws a frame of them, so the scheme must be streamable and
// CORS-enabled. Schemes can only be registered before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: VIDEO_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
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
  ai?: Partial<AiLinkSettings>
  /** The Concept Forge link (the remembered concept-forge.html). */
  forge?: ForgeSettings
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
  const { lastVault, roots, exclude, ...rest } = raw
  const out: Settings = { ...rest }
  const list = Array.isArray(roots) ? roots.filter(isString) : []
  if (!list.length && isString(lastVault)) list.push(lastVault)
  if (list.length) out.roots = list
  if (Array.isArray(exclude)) out.exclude = cleanNames(exclude)
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

/** Changes for the AI link's brain: held during a read, else applied now. */
function toAi(changes: VaultChangeDto[]): void {
  if (aiHeld) aiHeld.push(changes)
  else ai?.applyExternal(changes)
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
  }
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
async function openVault(input: string[]): Promise<VaultInfo> {
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
  const next = new FsVault(ok, { exclude: settings.exclude ?? [] })
  generation++
  watcher?.stop()
  watcher = null
  aiHeld = null
  thumbs.clear()
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
async function listFiles(): Promise<VaultFileDto[]> {
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
      w.seed({ files: scan.files.map((f) => f.path), folders: scan.folders, images: scan.assets.map((a) => a.path), imagesCapped: scan.assetsTruncated })
    }
    const found = scan.files.length
    const files = await v.readAll(scan.files, (done) => progress({ phase: 'reading', files: done, found, dirs: scan.dirs, done: false }))
    progress({ phase: 'done', files: files.length, found, dirs: scan.dirs, done: true })
    if (latest()) void ai?.setVault({ roots: v.roots.map((r) => r.abs), exclude: [...v.exclude] }, { files, folders: scan.folders })
    return files
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
  // Our own writes are swallowed by the watcher, so the AI link hears about them here.
  toAi([{ kind: existed ? 'change' : 'add', path: rel, content: text, mtime: Date.now() }])
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
  toAi([{ kind: 'add', path: rel, content: text, mtime: Date.now() }])
}

async function deleteNote(p: unknown): Promise<void> {
  const v = requireVault()
  const rel = notePath(p)
  watcher?.noteSelfWrite(rel, null)
  await v.remove(rel)
  toAi([{ kind: 'unlink', path: rel }])
}

async function renameNote(from: unknown, to: unknown): Promise<void> {
  const v = requireVault()
  const a = notePath(from)
  const b = notePath(to)
  const content = await v.read(a)
  watcher?.noteSelfWrite(a, null)
  if (content !== null) watcher?.noteSelfWrite(b, content)
  await v.rename(a, b)
  const changes: VaultChangeDto[] = [{ kind: 'unlink', path: a }]
  if (content !== null) changes.push({ kind: 'add', path: b, content, mtime: Date.now() })
  toAi(changes)
}

async function createFolder(p: unknown): Promise<void> {
  const v = requireVault()
  const rel = String(p)
  await v.mkdir(rel)
  // The watcher reports the new folder to the renderer; the AI link hears about it right away.
  const canonical = v.toVault(v.abs(rel))
  if (canonical) toAi([{ kind: 'addDir', path: canonical }])
}

async function reveal(p: unknown): Promise<void> {
  const v = requireVault()
  const rel = String(p)
  if (!(await v.stat(rel))) throw new Error(`Not in the vault: ${rel}`)
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
})
/**
 * Longest wait for one thumbnail: a share that stopped answering must not hold
 * the renderer's few requests in flight forever (it gets null, a plain moon).
 */
const THUMB_TIMEOUT = 20_000
/** A video's still that came back empty after this long timed out in the helper (it waits 15 s). */
const VIDEO_GAVE_UP_MS = 14_000

/** Every picture the last scan found, with mtime and size where a stat got to them in time. */
async function listAssets(): Promise<AssetListDto> {
  const v = requireVault()
  const scan = v.lastScan
  if (!scan) return { assets: [], truncated: false }
  return { assets: await v.statAssets(scan.assets), truncated: scan.assetsTruncated }
}

/**
 * PNG bytes of a picture at most `size` px on its longer side, or null when
 * it is not a picture of the vault, too big, or cannot be decoded. A video's
 * thumbnail is one still frame of it (any size of file: it is streamed to
 * the helper, never read whole).
 */
async function thumbnail(p: unknown, size: unknown): Promise<Uint8Array | null> {
  const v = requireVault()
  const px = thumbPx(size)
  const abs = await v.assetAbs(String(p))
  if (!abs) return null
  const st = await fs.stat(abs).catch(() => null)
  const video = isVideoName(path.basename(abs))
  if (!st?.isFile() || st.size === 0 || (!video && st.size > MAX_THUMB_FILE_BYTES)) return null
  const key = ThumbCache.key(abs, st.mtimeMs, st.size, px)
  const hit = thumbs.get(key)
  if (hit !== undefined) return hit
  let job = thumbsInFlight.get(key)
  if (!job) {
    job = (video ? renderVideoThumb(abs, px) : renderThumb(abs, px))
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
  const changes: VaultChangeDto[] = madeFolder ? [{ kind: 'addDir', path: parent }] : []
  changes.push({ kind: 'add', path: canonical, mtime: Date.now(), size: bytes.length })
  toAi(changes)
}

/**
 * Open a picture or video of the vault in the OS default app (a video plays
 * there, never in the brain). Pictures and videos only: shell.openPath would
 * run a program just the same. A video must also start like one.
 */
async function openAsset(p: unknown): Promise<void> {
  const v = requireVault()
  const rel = String(p)
  const abs = await v.assetAbs(rel)
  if (!abs) throw new Error(`Not a picture in the vault: ${rel}`)
  if (isVideoName(path.basename(abs)) && !videoKindOf(await readHead(abs, VIDEO_HEAD_BYTES))) throw new Error(`Not a video: ${rel}`)
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
    currentVault: () => (vault ? { roots: vault.roots.map((r) => r.abs), exclude: [...vault.exclude] } : null),
    // Packaged: import the real unpacked file, the one the client configs point at.
    bundlePath: app.isPackaged ? serverScript : devBundle,
    serverScript,
    execPath: process.execPath,
    portable: !!process.env['PORTABLE_EXECUTABLE_DIR'],
  })
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

/** The brain window opens the Forge window; the Forge window's requests go through the host to the brain window's store. */
function registerForgeIpc(forge: ForgeHost): void {
  ipcMain.handle(IPC.forgeOpen, (_e, opts: unknown) => forge.open(opts))
  ipcMain.handle(IPC.forgeStatus, () => forge.status())
  ipcMain.handle(IPC.forgeProjects, (e) => forge.projects(e.sender))
  ipcMain.handle(IPC.forgeSave, (e, dto: unknown) => forge.save(e.sender, dto))
  ipcMain.handle(IPC.forgeReply, (e, id: unknown, ok: unknown, value: unknown) => forge.reply(e.sender, id, ok, value))
}

/* ------------------------------------------------------------------ */
/* IPC                                                                */
/* ------------------------------------------------------------------ */

function registerIpc(): void {
  ipcMain.handle(IPC.pick, async (): Promise<VaultInfo | null> => {
    const dir = await chooseFolder(
      'Choose your vault folder',
      'Pick a folder of markdown notes. Aether Brain reads and writes .md files in place.',
    )
    return dir ? openVault([dir]) : null
  })
  ipcMain.handle(IPC.open, (_e, roots: unknown) => openVault(Array.isArray(roots) ? roots.map(String) : [String(roots)]))
  // At launch `aether-brain D:\ F:\` or AETHER_VAULT wins over the remembered roots. Once a vault
  // is open the remembered set is the truth: roots added or removed since then (the vault folders
  // panel lists remembered roots it could not open) and a reloaded window keep them.
  ipcMain.handle(IPC.last, (): string[] | null => {
    if (!opened) {
      const cli = cliRoots()
      if (cli.length) return cli
      const env = envRoots()
      if (env.length) return env
    }
    return settings.roots?.length ? [...settings.roots] : null
  })
  ipcMain.handle(IPC.info, (): VaultInfo | null => (vault ? vaultInfo(vault) : null))
  ipcMain.handle(IPC.addRoot, async (): Promise<VaultInfo | null> => {
    const dir = await chooseFolder('Add a folder to the vault', 'Its folders become planets in the brain, next to the ones already there.')
    return dir ? addRootPath(dir) : null
  })
  ipcMain.handle(IPC.addRootPath, (_e, p: unknown) => addRootPath(p))
  ipcMain.handle(IPC.removeRoot, (_e, p: unknown) => removeRoot(p))
  ipcMain.handle(IPC.setExclude, (_e, names: unknown) => setExclude(names))
  ipcMain.handle(IPC.drives, () => listDrives())
  ipcMain.handle(IPC.list, () => listFiles())
  ipcMain.handle(IPC.folders, (): FolderListDto => {
    const scan = requireVault().lastScan
    return { folders: scan ? [...scan.folders] : [], truncated: scan?.truncated ?? false }
  })
  ipcMain.handle(IPC.read, (_e, p: unknown) => readNote(p))
  ipcMain.handle(IPC.write, (_e, p: unknown, content: unknown) => writeNote(p, content))
  ipcMain.handle(IPC.create, (_e, p: unknown, content: unknown) => createNote(p, content))
  ipcMain.handle(IPC.delete, (_e, p: unknown) => deleteNote(p))
  ipcMain.handle(IPC.rename, (_e, a: unknown, b: unknown) => renameNote(a, b))
  ipcMain.handle(IPC.mkdir, (_e, p: unknown) => createFolder(p))
  ipcMain.handle(IPC.reveal, (_e, p: unknown) => reveal(p))
  ipcMain.handle(IPC.assets, () => listAssets())
  ipcMain.handle(IPC.thumb, (_e, p: unknown, size: unknown) => within(thumbnail(p, size), THUMB_TIMEOUT, null))
  // From the thumbnail helper only: the thumbnailer ignores every other sender.
  ipcMain.on(THUMB_IPC.ready, (e) => thumbnailer.ready(e.sender))
  ipcMain.on(THUMB_IPC.done, (e, id: unknown, png: unknown) => thumbnailer.done(e.sender, id, png))
  ipcMain.handle(IPC.createAsset, (_e, p: unknown, data: unknown) => createAsset(p, data))
  ipcMain.handle(IPC.openAsset, (_e, p: unknown) => openAsset(p))
  ipcMain.handle(IPC.aiStatus, () => requireAi().status())
  ipcMain.handle(IPC.aiConfigure, (_e, patch: unknown) => requireAi().configure(cleanPatch(patch)))
  ipcMain.handle(IPC.copy, (_e, text: unknown) => clipboard.writeText(String(text)))
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
  const reveal = () => {
    if (win && !win.isVisible()) win.show()
  }
  win.once('ready-to-show', reveal)
  setTimeout(reveal, 1200)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
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
  win.on('closed', () => {
    win = null
    // Nothing asks for thumbnails without the brain window, and a hidden helper left open
    // would keep 'window-all-closed' from ever firing (the app would not quit).
    thumbnailer.stop()
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
app.on('before-quit', () => {
  watcher?.stop()
  watcher = null
  thumbnailer.stop()
  void ai?.stop()
})

void app.whenReady().then(async () => {
  // Belt and braces: no permission prompts, no outbound requests from the renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  if (!isDev) {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }))
  }
  const loaded = await loadSettings()
  settings = loaded.settings
  if (loaded.migrated) void saveSettings()
  ai = createAiLink()
  registerIpc()
  createWindow()
  registerForgeIpc(createForge())
  started = true
})
