/**
 * The AI link: the in-app MCP server that lets Claude and ChatGPT search,
 * read and write the open vault over HTTP (127.0.0.1 only, secret token in
 * the URL), plus the ready-to-paste setups for clients that run the bundled
 * server themselves over stdio (Claude Desktop, Claude Code).
 *
 * Pure Node (no electron import) so it can be unit-tested; main.ts passes in
 * what it knows about the app (paths, executable, the open vault).
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { AiActivityDto, AiLinkPatch, AiLinkStatus, VaultChangeDto } from '../shared/ipc.js'

/* ------------------------------------------------------------------ */
/* Module API of the bundled server (dist/mcp/aether-mcp.mjs).        */
/* Declared here, not imported from src/mcp: main never compiles the  */
/* server, it loads the built bundle at runtime.                      */
/* ------------------------------------------------------------------ */

/** Files + folders the host already read, so the brain skips its own scan. */
export interface BrainPreload {
  files: { path: string; content: string; mtime: number }[]
  folders: string[]
}

interface BrainOptions {
  roots: string[]
  exclude?: string[]
  readOnly?: boolean
  /** Run its own recursive fs.watch (default true). The in-app link passes false and feeds changes itself. */
  watch?: boolean
  preload?: BrainPreload
  /** Folders (absolute paths) left out of the brain. */
  hidden?: string[]
  /** Folders (absolute paths) shown although they look like installs. */
  keep?: string[]
}

interface Brain {
  /** Apply file/folder changes observed elsewhere (the host's watcher). Idempotent. */
  applyExternal(changes: VaultChangeDto[]): void
  /** New folder rules for the same vault (see LinkVault). */
  setFolderRules?(rules: { hidden: string[]; keep: string[] }): void
  close(): void | Promise<void>
}

interface ActivityEvent {
  client: string
  tool: string
  summary: string
  path: string | null
  write: boolean
}

interface HttpLink {
  url: string
  port: number
  close(): Promise<void>
}

/** A picture, video or 3D model as find_pictures lists it (the bundle's `FoundPicture`). */
export interface FoundPicture {
  /** Vault path. */
  path: string
  kind: 'picture' | 'video' | 'model'
  bytes: number | null
  /** Last change, epoch ms. */
  modified: number | null
}

/** One picture looked at (the bundle's `LookedAt`): a PNG still and what the file itself is. */
export interface LookedAt {
  png: Uint8Array
  path: string
  kind: 'picture' | 'video' | 'model'
  bytes: number
  width: number | null
  height: number | null
}

/** What the app lends the link so its AI can see pictures (the bundle's `PictureHost`): only the app has the thumbnail helper. */
export interface PictureHost {
  find(query: string, opts: { folder?: string; limit: number }): Promise<{ pictures: FoundPicture[]; more: boolean }>
  look(path: string, px: number): Promise<LookedAt | null>
}

/** What show_in_brain asks the window to show (the bundle's `ShowTarget`). */
export interface ShowTarget {
  kind: 'note' | 'folder' | 'picture' | 'today'
  /** Vault path ('' for the Today hub). */
  path: string
  /** A note: open it in the editor as well. */
  open: boolean
}

/** The part of the bundle's exports the host uses. */
export interface McpModule {
  Brain: { open(opts: BrainOptions): Promise<Brain> }
  startHttpLink(opts: {
    brain: Brain
    host?: string
    port: number
    token: string
    readOnly: boolean
    onActivity?: (a: ActivityEvent) => void
    pictures?: PictureHost
    show?: (target: ShowTarget) => void | Promise<void>
  }): Promise<HttpLink>
}

/* ------------------------------------------------------------------ */
/* Settings and ready-to-paste client setups (pure helpers)           */
/* ------------------------------------------------------------------ */

/** Persisted in settings.json under `ai`. */
export interface AiLinkSettings {
  /** The user switched the HTTP link on. */
  enabled: boolean
  port: number
  /** Secret every HTTP request must carry. */
  token: string
  /** Offer read tools only. */
  readOnly: boolean
}

/** The link only ever listens on loopback; tunnels (cloudflared, ngrok) forward to it. */
export const AI_HOST = '127.0.0.1'
export const AI_DEFAULT_PORT = 7457

const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/

/** A fresh secret: 24 random bytes, base64url (32 characters, safe in a URL path). */
export function newToken(): string {
  return randomBytes(24).toString('base64url')
}

/** True for a port the link may listen on (unprivileged, whole number). */
export function isValidPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1024 && n <= 65535
}

/** Settings from disk with defaults filled in; a missing or malformed token gets a fresh one. */
export function aiSettings(raw: unknown): AiLinkSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const token = r['token']
  return {
    enabled: r['enabled'] === true,
    port: isValidPort(r['port']) ? r['port'] : AI_DEFAULT_PORT,
    token: typeof token === 'string' && TOKEN_RE.test(token) ? token : newToken(),
    readOnly: r['readOnly'] === true,
  }
}

/** Only the known, well-typed fields of a patch that crossed IPC. */
export function cleanPatch(raw: unknown): AiLinkPatch {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out: AiLinkPatch = {}
  if (typeof r['enabled'] === 'boolean') out.enabled = r['enabled']
  if (typeof r['readOnly'] === 'boolean') out.readOnly = r['readOnly']
  if (r['port'] !== undefined) out.port = Number(r['port'])
  if (r['regenerateToken'] === true) out.regenerateToken = true
  return out
}

/** The full local MCP URL, token included. */
export function linkUrl(host: string, port: number, token: string): string {
  return `http://${host}:${port}/mcp/${token}`
}

/** How a client starts the bundled server over stdio with this app's own executable. */
export interface ServerLaunch {
  /** Executable run with ELECTRON_RUN_AS_NODE=1 (this app). */
  command: string
  /** Absolute path of aether-mcp.mjs. */
  serverScript: string
  /** Absolute vault roots, in order (mount names depend on it). */
  roots: string[]
  /** Extra folder names skipped while scanning. */
  exclude?: string[]
  /** Folders (absolute paths) left out of the brain. */
  hidden?: string[]
  /** Folders (absolute paths) shown although they look like installs. */
  keep?: string[]
  readOnly: boolean
}

/** Server arguments: the script, `--vault` per root, `--exclude` per name, `--hide` / `--keep` per folder, `--read-only`. */
export function serverArgs(l: ServerLaunch): string[] {
  return [
    l.serverScript,
    ...l.roots.flatMap((r) => ['--vault', r]),
    ...(l.exclude ?? []).flatMap((n) => ['--exclude', n]),
    ...(l.hidden ?? []).flatMap((f) => ['--hide', f]),
    ...(l.keep ?? []).flatMap((f) => ['--keep', f]),
    ...(l.readOnly ? ['--read-only'] : []),
  ]
}

/** Ready-to-paste claude_desktop_config.json content (an `mcpServers` entry named aether-brain). */
export function claudeDesktopConfig(l: ServerLaunch): string {
  const entry = { command: l.command, args: serverArgs(l), env: { ELECTRON_RUN_AS_NODE: '1' } }
  return JSON.stringify({ mcpServers: { 'aether-brain': entry } }, null, 2)
}

/**
 * One argument as a literal for the terminal the command is meant for, with
 * nothing inside expanded (a root can be any folder name: `D:\$Notes`,
 * `Art$(…)`, a backtick).
 *
 * Windows: a PowerShell single-quoted string. `$`, `$(…)`, backticks and `%`
 * stay text; a single quote is doubled, including the typographic ‘ ’ ‚ ‛
 * PowerShell also treats as quotes. PowerShell passes the value on to the
 * program as one argument (a drive root `D:\` stays `D:\`). The command is
 * for PowerShell, not cmd.exe.
 *
 * Elsewhere (sh, bash, zsh): a POSIX single-quoted string (no `$`, backtick
 * or `!` expansion), `'` written as `'\''`.
 */
export function quoteArg(arg: string, platform: string = process.platform): string {
  if (platform === 'win32') return `'${arg.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * Ready-to-run `claude mcp add` command for Claude Code: user scope (every
 * project sees the brain), the env var after the name and before `--` so it
 * is never read as the name, everything after `--` passed to the server.
 * On Windows it is a PowerShell command (see quoteArg): label it so where it is shown.
 */
export function claudeCodeCommand(l: ServerLaunch, platform: string = process.platform): string {
  const q = (s: string) => quoteArg(s, platform)
  const args = serverArgs(l).map((a, i) => (i > 0 && SERVER_FLAGS.has(a) ? a : q(a)))
  return ['claude mcp add aether-brain --scope user -e ELECTRON_RUN_AS_NODE=1 --', q(l.command), ...args].join(' ')
}

/** Flags serverArgs() emits; everything else in the command line is a quoted value. */
const SERVER_FLAGS = new Set(['--vault', '--exclude', '--hide', '--keep', '--read-only'])

/** Error from a missing bundle file (so the status can say what to do). */
class MissingBundle extends Error {}

/** One line the user can act on, for a failed start. */
export function describeStartError(err: unknown, port: number): string {
  if (err instanceof MissingBundle) return err.message
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'EADDRINUSE') return `Port ${port} is already in use (another app, or another Aether Brain). Pick a different port.`
  if (code === 'EACCES') return `Not allowed to listen on port ${port}. Pick a different port.`
  const msg = err instanceof Error ? err.message : String(err)
  return `The AI link could not start: ${msg}`
}

/* ------------------------------------------------------------------ */
/* Host                                                               */
/* ------------------------------------------------------------------ */

/** The vault the link serves: roots in order + user excludes, and the folder rules (applied live, see setFolderRules). */
export interface LinkVault {
  roots: string[]
  exclude: string[]
  hidden?: string[]
  keep?: string[]
}

export interface AiLinkHostOptions {
  settings: AiLinkSettings
  /** Persist changed settings (token, port, switches). */
  save: (s: AiLinkSettings) => void | Promise<void>
  /** Forward one AI tool call to the renderer. */
  onActivity: (a: AiActivityDto) => void
  /** The vault main has open right now (for the client setups in the status), or null. */
  currentVault: () => LinkVault | null
  /** Absolute path of the bundle this process imports. */
  bundlePath: string
  /** Absolute path of the script written into client configs (asar-unpacked when packaged). */
  serverScript: string
  /** This app's executable (runs the script with ELECTRON_RUN_AS_NODE=1). */
  execPath: string
  /** Running from the Portable exe (its path changes every launch). */
  portable: boolean
  platform?: string
  /** How the bundle is loaded (tests inject a fake). Default: dynamic import of `bundlePath`. */
  load?: (bundlePath: string) => Promise<McpModule>
  /** The app's pictures, lent to the link: with it the AI can find and look at pictures (find_pictures, get_image). */
  pictures?: PictureHost
  /** Show something in the app's window: with it the AI can point the 3D view at things (show_in_brain). */
  show?: (target: ShowTarget) => void | Promise<void>
}

const vaultKey = (v: LinkVault | null): string => (v ? JSON.stringify([v.roots, v.exclude]) : '')

/**
 * Owns the HTTP link's lifecycle. The link runs while it is enabled and a
 * vault is open; it restarts when the vault or the link settings change and
 * stops on quit. The brain (index + notes) is opened once per vault with what
 * main already read, and kept current with main's watcher batches, so the
 * AI sees edits made in the app and on disk. Failures (port taken, bundle
 * missing) land in `status().error`; nothing here throws into main except
 * invalid settings from `configure`.
 */
export class AiLinkHost {
  private settings: AiLinkSettings
  private readonly opts: AiLinkHostOptions
  /** The vault the link should serve (null: none open or not read yet). */
  private target: LinkVault | null = null
  private preload: { key: string; data: BrainPreload } | null = null
  private brain: Brain | null = null
  private brainKey = ''
  /** Vault whose brain is being opened right now ('' when none). */
  private openingKey = ''
  /** Watcher batches that arrived before the brain for `key` was open. */
  private backlog: { key: string; batches: VaultChangeDto[][] } | null = null
  private link: HttpLink | null = null
  private linkKey = ''
  private error: string | null = null
  private mod: Promise<McpModule> | null = null
  private queue: Promise<void> = Promise.resolve()
  private stopped = false
  /** The brain's chat uses the brain too: it stays open while the vault is, link on or off. */
  private chatWanted = false

  constructor(opts: AiLinkHostOptions) {
    this.opts = opts
    this.settings = { ...opts.settings }
  }

  /** Everything the renderer's AI link panel shows. */
  status(): AiLinkStatus {
    const s = this.settings
    const port = this.link?.port ?? s.port
    const v = this.opts.currentVault()
    const launch: ServerLaunch = {
      command: this.opts.execPath,
      serverScript: this.opts.serverScript,
      roots: v?.roots ?? [],
      exclude: v?.exclude ?? [],
      hidden: v?.hidden ?? [],
      keep: v?.keep ?? [],
      readOnly: s.readOnly,
    }
    return {
      enabled: s.enabled,
      running: this.link !== null,
      host: AI_HOST,
      port,
      token: s.token,
      readOnly: s.readOnly,
      url: linkUrl(AI_HOST, port, s.token),
      error: this.error,
      claudeDesktopConfig: claudeDesktopConfig(launch),
      claudeCodeCommand: claudeCodeCommand(launch, this.opts.platform),
      serverScript: this.opts.serverScript,
      portable: this.opts.portable,
    }
  }

  /**
   * The vault the link serves, with what main already read (so the brain
   * skips its own scan). null closes the brain. Resolves once the link
   * reflects it.
   */
  setVault(vault: LinkVault | null, preload?: BrainPreload | null): Promise<AiLinkStatus> {
    this.target = vault ? { roots: [...vault.roots], exclude: [...vault.exclude], hidden: [...(vault.hidden ?? [])], keep: [...(vault.keep ?? [])] } : null
    this.prepare(preload ?? null)
    return this.enqueue(() => this.sync())
  }

  /**
   * New folder rules for the same vault: the open brain takes them at once
   * (no reopen; what they leave out comes as unlinks from main's watcher).
   * Other roots or excludes are a new vault: setVault.
   */
  setFolderRules(vault: LinkVault): void {
    if (!this.target || vaultKey(this.target) !== vaultKey(vault)) return
    this.target = { ...this.target, hidden: [...(vault.hidden ?? [])], keep: [...(vault.keep ?? [])] }
    try {
      this.brain?.setFolderRules?.({ hidden: this.target.hidden ?? [], keep: this.target.keep ?? [] })
    } catch (err) {
      console.warn('[aether] AI link could not apply folder rules', err)
    }
  }

  /** Changes seen by main's watcher or made by the app itself. Never throws. */
  applyExternal(changes: VaultChangeDto[]): void {
    if (!changes.length) return
    const key = vaultKey(this.target)
    try {
      if (this.brain && this.brainKey === key) this.brain.applyExternal(changes)
      else if (this.backlog && this.backlog.key === key) this.backlog.batches.push(changes)
    } catch (err) {
      console.warn('[aether] AI link could not apply changes', err)
    }
  }

  /** Change the link settings (persisted), then start / stop / restart to match. Throws on an invalid port. */
  async configure(patch: AiLinkPatch): Promise<AiLinkStatus> {
    const next = { ...this.settings }
    if (patch.port !== undefined) {
      if (!isValidPort(patch.port)) throw new Error('The port must be a whole number from 1024 to 65535.')
      next.port = patch.port
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    if (patch.readOnly !== undefined) next.readOnly = patch.readOnly
    if (patch.regenerateToken) next.token = newToken()
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings)
    this.settings = next
    if (changed) await this.opts.save({ ...next })
    // Switched on while a vault is open: no preload is kept around, so the brain scans for itself.
    this.prepare(null)
    // Also a retry after an error when nothing changed.
    return this.enqueue(() => this.sync())
  }

  /** Close the link and the brain for good (app quit). */
  stop(): Promise<void> {
    this.stopped = true
    this.preload = null
    this.backlog = null
    return this.enqueue(async () => {
      await this.closeLink()
      this.closeBrain()
    }).then(() => undefined)
  }

  private wanted(): boolean {
    return !this.stopped && (this.settings.enabled || this.chatWanted) && this.target !== null
  }

  /**
   * The brain's chat will use the brain: keep it open with the vault (and
   * keep the next vault read as its preload), whether the HTTP link is on
   * or not.
   */
  wantBrain(on: boolean): Promise<AiLinkStatus> {
    this.chatWanted = on
    return this.enqueue(() => this.sync())
  }

  /**
   * The open brain and the bundle, for the brain's chat; opens the brain
   * when needed (a whole drive takes a moment). Throws when no vault is open
   * or the brain could not be opened.
   */
  async useBrain(): Promise<{ brain: Brain; mod: McpModule }> {
    this.chatWanted = true
    await this.enqueue(() => this.sync())
    const brain = this.brain
    if (!brain) throw new Error(this.target ? (this.error ?? 'The brain could not be opened') : 'Open a vault first')
    return { brain, mod: await this.module() }
  }

  /**
   * Before a sync: when a brain will be opened for the target vault, keep the
   * preload for it and start buffering watcher batches (they are replayed
   * after the preload, in order). A brain that exists or is opening for the
   * same vault keeps being fed instead, so batches never go out of order.
   */
  private prepare(preload: BrainPreload | null): void {
    const key = vaultKey(this.target)
    if (!this.wanted()) {
      this.preload = null
      this.backlog = null
    } else if (this.brainKey !== key && this.openingKey !== key && (preload || this.backlog?.key !== key)) {
      // A newer snapshot (or a first one) for this vault: batches before it are already in it.
      this.preload = preload ? { key, data: preload } : null
      this.backlog = { key, batches: [] }
    }
  }

  /** Lifecycle steps run one at a time, in order. */
  private enqueue(step: () => Promise<void>): Promise<AiLinkStatus> {
    const run = this.queue.then(step, step)
    this.queue = run.catch(() => undefined)
    return run.then(() => this.status())
  }

  /** Bring the brain and the HTTP link in line with the settings and the target vault. */
  private async sync(): Promise<void> {
    const key = vaultKey(this.target)
    if (this.brain && (!this.wanted() || this.brainKey !== key)) {
      await this.closeLink()
      this.closeBrain()
    }
    if (!this.wanted()) {
      await this.closeLink()
      this.error = null
      return
    }
    const { port, token, readOnly } = this.settings
    try {
      const mod = await this.module()
      if (!this.brain) {
        const target = this.target!
        const preload = this.preload?.key === key ? this.preload.data : null
        this.preload = null
        if (this.backlog?.key !== key) this.backlog = { key, batches: [] }
        this.openingKey = key
        let brain: Brain
        try {
          brain = await mod.Brain.open({
            roots: target.roots,
            exclude: target.exclude,
            hidden: target.hidden ?? [],
            keep: target.keep ?? [],
            watch: false,
            ...(preload ? { preload } : {}),
          })
        } finally {
          this.openingKey = ''
        }
        if (vaultKey(this.target) !== key || !this.wanted()) {
          // The vault changed (or the link was switched off) while it opened: the next sync takes over.
          void Promise.resolve(brain.close()).catch(() => undefined)
          return
        }
        this.brain = brain
        this.brainKey = key
        const backlog = this.backlog?.key === key ? this.backlog.batches : []
        this.backlog = null
        for (const batch of backlog) brain.applyExternal(batch)
      }
      // Open for the chat only: no HTTP link.
      if (!this.settings.enabled) {
        await this.closeLink()
        this.error = null
        return
      }
      const lkey = JSON.stringify([port, token, readOnly])
      if (this.link && this.linkKey !== lkey) await this.closeLink()
      if (!this.link) {
        this.link = await mod.startHttpLink({
          brain: this.brain,
          host: AI_HOST,
          port,
          token,
          readOnly,
          onActivity: (a) => this.activity(a),
          ...(this.opts.pictures ? { pictures: this.opts.pictures } : {}),
          ...(this.opts.show ? { show: this.opts.show } : {}),
        })
        this.linkKey = lkey
      }
      this.error = null
    } catch (err) {
      this.error = describeStartError(err, port)
      console.warn('[aether] AI link:', this.error)
      await this.closeLink()
      // No brain: stop buffering. A retry scans afresh (or gets a new preload from the next vault read).
      if (!this.brain) {
        this.preload = null
        this.backlog = null
      }
    }
  }

  private activity(a: ActivityEvent): void {
    try {
      this.opts.onActivity({
        client: String(a.client ?? ''),
        tool: String(a.tool ?? ''),
        summary: String(a.summary ?? ''),
        path: typeof a.path === 'string' ? a.path : null,
        write: a.write === true,
      })
    } catch (err) {
      console.warn('[aether] AI activity could not be forwarded', err)
    }
  }

  private async closeLink(): Promise<void> {
    const link = this.link
    this.link = null
    this.linkKey = ''
    if (!link) return
    try {
      await link.close()
    } catch (err) {
      console.warn('[aether] AI link did not close cleanly', err)
    }
  }

  private closeBrain(): void {
    const brain = this.brain
    this.brain = null
    this.brainKey = ''
    if (!brain) return
    try {
      void Promise.resolve(brain.close()).catch((err: unknown) => console.warn('[aether] AI brain did not close cleanly', err))
    } catch (err) {
      console.warn('[aether] AI brain did not close cleanly', err)
    }
  }

  /** The bundle, imported once; a failed import is retried on the next start. */
  private module(): Promise<McpModule> {
    if (!this.mod) {
      const bundle = this.opts.bundlePath
      const load = this.opts.load ?? importBundle
      this.mod = load(bundle).catch((err: unknown) => {
        this.mod = null
        throw err
      })
    }
    return this.mod
  }
}

/** Dynamic import of the built server bundle, with a clear error when it is missing or not the expected module. */
async function importBundle(bundlePath: string): Promise<McpModule> {
  try {
    await fs.access(bundlePath)
  } catch {
    throw new MissingBundle(`The AI link server is missing (${bundlePath}). Run "pnpm build:mcp" in apps/desktop, or reinstall the app.`)
  }
  const mod = (await import(pathToFileURL(bundlePath).href)) as Partial<McpModule>
  if (typeof mod.Brain?.open !== 'function' || typeof mod.startHttpLink !== 'function') {
    throw new Error(`${bundlePath} does not export Brain and startHttpLink`)
  }
  return mod as McpModule
}
