/**
 * Aether Brain — Electron main process.
 *
 * Responsibilities, and nothing more:
 *   - pick / remember a vault folder
 *   - read, write, rename, delete markdown files inside it (path-jailed)
 *   - watch it with chokidar and stream debounced change batches to the renderer
 *
 * No network. No telemetry. The renderer is sandboxed with context isolation.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme, session } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC, type VaultChangeDto, type VaultFileDto, type VaultInfo } from '../shared/ipc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !!process.env['VITE_DEV_SERVER_URL']
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

/** First non-flag CLI argument, if it is a directory: `aether-brain ~/notes`. */
function cliVault(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'))
  const candidate = args[0]
  return candidate ? path.resolve(candidate) : null
}

interface Settings {
  lastVault?: string
}

async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as Settings
  } catch {
    return {}
  }
}
async function writeSettings(patch: Settings): Promise<void> {
  const next = { ...(await readSettings()), ...patch }
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2))
}

/* ------------------------------------------------------------------ */
/* Vault                                                              */
/* ------------------------------------------------------------------ */

class Vault {
  root: string
  private watcher: FSWatcher | null = null
  private pending = new Map<string, VaultChangeDto>()
  private flushTimer: NodeJS.Timeout | null = null
  /** Content we just wrote, keyed by relative path, to swallow watcher echoes. */
  private selfWrites = new Map<string, { content: string; t: number }>()
  private sink: ((changes: VaultChangeDto[]) => void) | null = null

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  get info(): VaultInfo {
    return { root: this.root, name: path.basename(this.root) }
  }

  /** Vault-relative posix path → absolute path, refusing anything outside the root. */
  private abs(rel: string): string {
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '')
    const full = path.resolve(this.root, ...clean.split('/'))
    const jail = this.root.endsWith(path.sep) ? this.root : this.root + path.sep
    if (full !== this.root && !full.startsWith(jail)) throw new Error(`Path escapes vault: ${rel}`)
    return full
  }

  private rel(absPath: string): string {
    return path.relative(this.root, absPath).split(path.sep).join('/')
  }

  static isIgnored(rel: string): boolean {
    return rel.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules' || seg === '__MACOSX')
  }

  async list(): Promise<VaultFileDto[]> {
    const out: VaultFileDto[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        const rel = this.rel(full)
        if (Vault.isIgnored(rel)) continue
        if (e.isDirectory()) await walk(full)
        else if (e.isFile() && /\.md$/i.test(e.name)) {
          try {
            const [content, st] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)])
            out.push({ path: rel, content, mtime: st.mtimeMs })
          } catch {
            /* unreadable file: skip */
          }
        }
      }
    }
    await walk(this.root)
    return out
  }

  async read(rel: string): Promise<string | null> {
    try {
      return await fs.readFile(this.abs(rel), 'utf8')
    } catch {
      return null
    }
  }

  async write(rel: string, content: string): Promise<void> {
    const full = this.abs(rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    // Atomic-ish: write to a temp sibling then rename, so a crash never leaves
    // a half-written note. Editors like Obsidian tolerate this pattern.
    const tmp = `${full}.aether-tmp`
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, full)
    this.selfWrites.set(rel.replace(/\\/g, '/'), { content, t: Date.now() })
  }

  async remove(rel: string): Promise<void> {
    await fs.rm(this.abs(rel), { force: true })
    this.selfWrites.set(rel, { content: '\u0000deleted', t: Date.now() })
  }

  async rename(from: string, to: string): Promise<void> {
    const a = this.abs(from)
    const b = this.abs(to)
    await fs.mkdir(path.dirname(b), { recursive: true })
    await fs.rename(a, b)
    const content = await fs.readFile(b, 'utf8')
    this.selfWrites.set(from, { content: '\u0000deleted', t: Date.now() })
    this.selfWrites.set(to, { content, t: Date.now() })
  }

  startWatching(sink: (changes: VaultChangeDto[]) => void): void {
    this.stopWatching()
    this.sink = sink
    this.watcher = watch(this.root, {
      ignoreInitial: true,
      ignored: (p: string, stats?: import('node:fs').Stats) => {
        const rel = this.rel(p)
        if (!rel) return false
        if (Vault.isIgnored(rel)) return true
        if (stats?.isFile() && !/\.md$/i.test(p)) return true
        return false
      },
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      persistent: true,
    })
    const queue = (kind: VaultChangeDto['kind']) => (p: string) => {
      const rel = this.rel(p)
      if (!/\.md$/i.test(rel) || Vault.isIgnored(rel)) return
      this.pending.set(rel, { kind, path: rel })
      if (this.flushTimer) clearTimeout(this.flushTimer)
      this.flushTimer = setTimeout(() => void this.flush(), 250)
    }
    this.watcher.on('add', queue('add')).on('change', queue('change')).on('unlink', queue('unlink'))
    this.watcher.on('error', (err) => console.warn('[aether] watcher error', err))
  }

  private async flush(): Promise<void> {
    const batch = [...this.pending.values()]
    this.pending.clear()
    const out: VaultChangeDto[] = []
    const now = Date.now()
    for (const c of batch) {
      const self = this.selfWrites.get(c.path)
      if (c.kind === 'unlink') {
        if (self && self.content === '\u0000deleted' && now - self.t < 3000) continue
        out.push(c)
        continue
      }
      try {
        const full = this.abs(c.path)
        const [content, st] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)])
        if (self && self.content === content && now - self.t < 3000) continue
        out.push({ kind: c.kind, path: c.path, content, mtime: st.mtimeMs })
      } catch {
        out.push({ kind: 'unlink', path: c.path })
      }
    }
    for (const [k, v] of this.selfWrites) if (now - v.t > 5000) this.selfWrites.delete(k)
    if (out.length && this.sink) this.sink(out)
  }

  stopWatching(): void {
    void this.watcher?.close()
    this.watcher = null
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.pending.clear()
  }
}

/* ------------------------------------------------------------------ */
/* App                                                                */
/* ------------------------------------------------------------------ */

let vault: Vault | null = null
let win: BrowserWindow | null = null

function requireVault(): Vault {
  if (!vault) throw new Error('No vault open')
  return vault
}

async function openVault(root: string): Promise<VaultInfo> {
  vault?.stopWatching()
  vault = new Vault(root)
  await fs.access(vault.root)
  vault.startWatching((changes) => win?.webContents.send(IPC.changes, changes))
  await writeSettings({ lastVault: vault.root })
  return vault.info
}

function registerIpc(): void {
  ipcMain.handle(IPC.pick, async (): Promise<VaultInfo | null> => {
    const res = await dialog.showOpenDialog({
      title: 'Choose your vault folder',
      message: 'Pick a folder of markdown notes. Aether Brain reads and writes .md files in place.',
      properties: ['openDirectory', 'createDirectory'],
    })
    const dir = res.filePaths[0]
    if (res.canceled || !dir) return null
    return openVault(dir)
  })
  ipcMain.handle(IPC.open, (_e, root: string) => openVault(String(root)))
  // `aether-brain /path/to/vault` or AETHER_VAULT=/path wins over the remembered vault.
  ipcMain.handle(IPC.last, async () => cliVault() ?? process.env['AETHER_VAULT'] ?? (await readSettings()).lastVault ?? null)
  ipcMain.handle(IPC.list, () => requireVault().list())
  ipcMain.handle(IPC.read, (_e, p: string) => requireVault().read(String(p)))
  ipcMain.handle(IPC.write, (_e, p: string, content: string) => requireVault().write(String(p), String(content)))
  ipcMain.handle(IPC.delete, (_e, p: string) => requireVault().remove(String(p)))
  ipcMain.handle(IPC.rename, (_e, a: string, b: string) => requireVault().rename(String(a), String(b)))
  ipcMain.handle(IPC.reveal, (_e, p: string) => {
    const v = requireVault()
    shell.showItemInFolder(path.resolve(v.root, ...String(p).split('/')))
  })
}

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
  win.once('ready-to-show', () => win?.show())
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
  win.on('closed', () => (win = null))
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

void app.whenReady().then(() => {
  // Belt and braces: no permission prompts, no outbound requests from the renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  if (!isDev) {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }))
  }
  registerIpc()
  createWindow()
})
