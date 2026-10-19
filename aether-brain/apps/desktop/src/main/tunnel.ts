/**
 * The tunnel button of the AI link panel. ChatGPT and claude.ai run in the cloud: they reach the AI link only through a tunnel that
 * gives it a public https address, and until now the user started one by hand in a terminal (cloudflared's quick tunnel, which
 * needs no account). This does it on a press:
 *  - it finds cloudflared on the PATH, or uses the copy this app downloaded once, on a press, into its own data folder: a pinned
 *    release with a pinned SHA-256, so a file that is not the one expected is thrown away, and the copy is hashed again before
 *    every start;
 *  - it starts it pointed at the link's port on 127.0.0.1 and nothing else, reads the https address it prints, and hands it over;
 *  - it stops it when asked, when the link goes off or moves, and when the app quits, and it finds and stops one a crashed app
 *    left behind (a pid file, and the program's name checked before anything is killed), because a tunnel nobody remembers is
 *    the link open to the internet.
 * Nothing is remembered: the tunnel is off every time the app starts, like the address a quick tunnel gets.
 *
 * Electron-free (main hands in a fetch, and what to tell the window), so it is tested with a fake process and a fake network.
 */
import { spawn as nodeSpawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { TunnelStatusDto } from '../shared/ipc.js'

/** The cloudflared release the app downloads. Moving to a newer one means new numbers here (GitHub shows each file's SHA-256). */
export const CLOUDFLARED_VERSION = '2026.10.1'

export interface CloudflaredAsset {
  /** The file's name on the release page. */
  file: string
  url: string
  /** Hex SHA-256 of the file. */
  sha256: string
  /** Its exact size in bytes. */
  bytes: number
}

const WINDOWS_X64: CloudflaredAsset = {
  file: 'cloudflared-windows-amd64.exe',
  url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`,
  sha256: '4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6',
  bytes: 55_325_120,
}

/** What to download on this system, or null where the app does not (macOS and Linux install cloudflared themselves: the button uses it). */
export function cloudflaredAsset(platform: NodeJS.Platform, arch: string): CloudflaredAsset | null {
  return platform === 'win32' && arch === 'x64' ? WINDOWS_X64 : null
}

/** A quick tunnel's address. The API host (`api.trycloudflare.com`) shows up in error lines and is never a tunnel. */
const TRY_URL = /https:\/\/([a-z0-9][a-z0-9-]*)\.trycloudflare\.com/gi

/** The tunnel's public address in a line of cloudflared's output, or null. */
export function tunnelUrlIn(text: string): string | null {
  for (const m of text.matchAll(TRY_URL)) {
    if (m[1]!.toLowerCase() !== 'api') return m[0].toLowerCase()
  }
  return null
}

/** The first file called `name` in the folders of a PATH. A folder that is not a whole path (an empty entry, `.`) is not looked in. */
export async function findOnPath(name: string, pathVar: string | undefined, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const p = platform === 'win32' ? path.win32 : path.posix
  for (const raw of (pathVar ?? '').split(platform === 'win32' ? ';' : ':')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!dir || !p.isAbsolute(dir)) continue
    const file = p.join(dir, name)
    try {
      if ((await fs.stat(file)).isFile()) return file
    } catch {
      /* not here */
    }
  }
  return null
}

/** What cloudflared is run with: the link's port on this computer only. No auto-update (a quick tunnel has nothing to update). */
export function tunnelCommand(program: string, port: number): { file: string; args: string[] } {
  return { file: program, args: ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`] }
}

/** The environment cloudflared gets: ours, without any `TUNNEL_*` setting (they would change what it runs). */
export function tunnelEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^TUNNEL_/i.test(k)) out[k] = v
  return out
}

/** The name of the program running as `pid`, or null (no such process, or the system would not say). */
export function processNameOf(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  return new Promise((resolve) => {
    const [file, args] = platform === 'win32' ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']] : ['ps', ['-p', String(pid), '-o', 'comm=']]
    execFile(file!, args as string[], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const line = stdout.split(/\r?\n/).find((l) => l.trim()) ?? ''
      const name = platform === 'win32' ? /^"([^"]+)"/.exec(line)?.[1] : path.basename(line.trim())
      resolve(name || null)
    })
  })
}

export type TunnelFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>

export interface TunnelHostOptions {
  /** The app's folder for it: the downloaded cloudflared and the pid file live here. */
  dir: string
  /** `fetch` for the download (a session of its own, so the system proxy applies and the app's own session may keep refusing the web). */
  fetch: TunnelFetch
  /** Tell the window the state changed. */
  emit: (s: TunnelStatusDto) => void
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  /** How a process is started (tests pass a fake). */
  spawn?: typeof nodeSpawn
  /** The release to download for a system (tests pass a small file with its own numbers). */
  assetFor?: (platform: NodeJS.Platform, arch: string) => CloudflaredAsset | null
  /** What is run for a program and a port (tests run a stand-in). */
  command?: (program: string, port: number) => { file: string; args: string[] }
  /** The name of a running program by pid (tests answer for themselves). */
  processName?: (pid: number) => Promise<string | null>
  /** How long a start may take before it is called failed (default 30 s). */
  startTimeoutMs?: number
  /** How long a download may take altogether (default 10 min). */
  downloadTimeoutMs?: number
}

const PID_FILE = 'tunnel.pid'
/** Output lines kept to say what went wrong. */
const KEEP_LINES = 12

export class TunnelHost {
  private child: ChildProcess | null = null
  /** A start that is under way (it looks for the program and checks it before it runs it). */
  private starting: Promise<TunnelStatusDto> | null = null
  private state: TunnelStatusDto['state'] = 'off'
  private url: string | null = null
  private error: string | null = null
  private program: TunnelStatusDto['program'] = null
  private fetching: { done: number; total: number } | null = null
  /** The user (or the app) asked for the stop: the process ending is not an error. */
  private stopping = false
  private timer: NodeJS.Timeout | null = null
  private lines: string[] = []
  private partial = ''
  private lastProgress = 0
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly env: NodeJS.ProcessEnv

  constructor(private readonly opts: TunnelHostOptions) {
    this.platform = opts.platform ?? process.platform
    this.arch = opts.arch ?? process.arch
    this.env = opts.env ?? process.env
  }

  private asset(): CloudflaredAsset | null {
    return (this.opts.assetFor ?? cloudflaredAsset)(this.platform, this.arch)
  }

  /** Where the app keeps its own copy. */
  private get ownFile(): string {
    return path.join(this.opts.dir, this.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  }

  private dto(): TunnelStatusDto {
    const asset = this.asset()
    return {
      state: this.state,
      url: this.url,
      error: this.error,
      program: this.program,
      download: asset ? { file: asset.file, mb: Math.round((asset.bytes / 1_048_576) * 10) / 10, from: `Cloudflare's release ${CLOUDFLARED_VERSION} on GitHub` } : null,
      downloading: this.fetching ? { ...this.fetching } : null,
    }
  }

  private emit(): void {
    try {
      this.opts.emit(this.dto())
    } catch {
      /* a listener that fails never stops the tunnel */
    }
  }

  /** The program that would run: one on the PATH, else the app's own copy when it is the size of the release (hashed at start). */
  private async findProgram(): Promise<{ file: string; kind: 'path' | 'app' } | null> {
    const onPath = await findOnPath(this.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared', this.env['PATH'] ?? this.env['Path'], this.platform)
    if (onPath) return { file: onPath, kind: 'path' }
    const asset = this.asset()
    if (asset) {
      const st = await fs.stat(this.ownFile).catch(() => null)
      if (st?.isFile() && st.size === asset.bytes) return { file: this.ownFile, kind: 'app' }
    }
    return null
  }

  async status(): Promise<TunnelStatusDto> {
    this.program = (await this.findProgram())?.kind ?? null
    return this.dto()
  }

  /** Download cloudflared once, into the app's folder: a pinned file, checked against its SHA-256, thrown away if it is not that file. */
  async download(): Promise<TunnelStatusDto> {
    const asset = this.asset()
    if (!asset) throw new Error('This app does not download cloudflared for this system. Install it (for example `brew install cloudflared`) and the button will use it.')
    if (this.fetching) return this.dto()
    // The slot is taken before anything is awaited: a second press while the first looks around is the same download.
    this.fetching = { done: 0, total: asset.bytes }
    const part = `${this.ownFile}.part`
    try {
      if (await this.findProgram()) {
        // Already here: nothing to download (the slot is given back before the answer is made).
        this.fetching = null
        return await this.status()
      }
      this.error = null
      this.emit()
      await fs.mkdir(this.opts.dir, { recursive: true })
      const res = await this.opts.fetch(asset.url, { signal: AbortSignal.timeout(this.opts.downloadTimeoutMs ?? 600_000) })
      if (!res.ok || !res.body) throw new Error(`Could not download cloudflared (HTTP ${res.status}).`)
      // A server that says it is sending another size is not sending this file.
      const length = Number(res.headers.get('content-length') ?? NaN)
      if (Number.isFinite(length) && length !== asset.bytes) throw new Error('The file offered is not the size of the cloudflared release, so it was not downloaded.')
      const hash = createHash('sha256')
      let got = 0
      const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)
      source.on('data', (chunk: Buffer) => {
        got += chunk.length
        if (got > asset.bytes) {
          source.destroy(new Error('The download is bigger than the cloudflared release, so it was stopped.'))
          return
        }
        hash.update(chunk)
        this.fetching = { done: got, total: asset.bytes }
        const now = Date.now()
        if (now - this.lastProgress >= 150) {
          this.lastProgress = now
          this.emit()
        }
      })
      await pipeline(source, createWriteStream(part))
      if (got !== asset.bytes) throw new Error(`The download stopped early (${got} of ${asset.bytes} bytes).`)
      if (hash.digest('hex') !== asset.sha256) throw new Error('The file that arrived is not the cloudflared release (its SHA-256 differs), so it was thrown away.')
      await fs.rename(part, this.ownFile)
      if (this.platform !== 'win32') await fs.chmod(this.ownFile, 0o755)
    } catch (err) {
      await fs.rm(part, { force: true }).catch(() => undefined)
      this.error = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      this.fetching = null
      this.program = (await this.findProgram())?.kind ?? null
      this.emit()
    }
    return this.dto()
  }

  /** The app's own copy must still be the downloaded file: it sits in a folder other programs can write to. */
  private async verifyOwn(file: string): Promise<void> {
    const asset = this.asset()
    if (!asset) return
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
    if (hash.digest('hex') !== asset.sha256) {
      await fs.rm(file, { force: true }).catch(() => undefined)
      this.program = null
      throw new Error('The cloudflared this app downloaded is not the release any more (its SHA-256 differs), so it was removed. Download it again.')
    }
  }

  /**
   * Start the tunnel to the link on `port` (the link must be listening). Resolves once the process is running; the address comes
   * with the next state. A second press while the first is still starting is the same start.
   */
  start(port: number): Promise<TunnelStatusDto> {
    if (this.starting) return this.starting
    const run = this.begin(port).finally(() => {
      this.starting = null
    })
    this.starting = run
    return run
  }

  private async begin(port: number): Promise<TunnelStatusDto> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('The AI link has no usable port to put a tunnel on.')
    if (this.child) return this.dto()
    if (this.fetching) throw new Error('cloudflared is still downloading.')
    const found = await this.findProgram()
    if (!found) {
      this.program = null
      throw new Error(
        this.asset()
          ? 'cloudflared is not on this computer yet: download it first.'
          : 'cloudflared is not on this computer. Install it (for example `brew install cloudflared`) and press Start again.',
      )
    }
    if (found.kind === 'app') await this.verifyOwn(found.file)
    this.program = found.kind
    this.state = 'starting'
    this.url = null
    this.error = null
    this.lines = []
    this.partial = ''
    this.stopping = false
    const { file, args } = (this.opts.command ?? tunnelCommand)(found.file, port)
    let child: ChildProcess
    try {
      child = (this.opts.spawn ?? nodeSpawn)(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: tunnelEnv(this.env) })
    } catch (err) {
      this.ended(`cloudflared could not start: ${err instanceof Error ? err.message : String(err)}`, null)
      throw new Error(this.error ?? 'cloudflared could not start.')
    }
    this.child = child
    // Every listener goes on before anything is awaited: a process that cannot start says so on the next tick, and an 'error' nobody hears crashes the app.
    const onData = (chunk: Buffer | string): void => this.heard(child, String(chunk))
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', (err) => this.ended(`cloudflared could not start: ${err.message}`, child))
    child.once('exit', (code, signal) => this.ended(`cloudflared stopped${code !== null ? ` (exit code ${code})` : signal ? ` (${signal})` : ''}`, child))
    if (child.pid) void this.writePid(child.pid)
    this.timer = setTimeout(() => {
      if (this.child === child && this.state === 'starting') {
        this.ended('The tunnel did not come up in time. Is this computer online?', child)
        child.kill()
      }
    }, this.opts.startTimeoutMs ?? 30_000)
    this.timer.unref?.()
    this.emit()
    return this.dto()
  }

  /** Stop the tunnel. The process is told to end before this returns, so a quitting app leaves nothing running. */
  async stop(): Promise<TunnelStatusDto> {
    const child = this.child
    if (!child) {
      this.error = null
      return this.dto()
    }
    this.stopping = true
    await new Promise<void>((resolve) => {
      const giveUp = setTimeout(resolve, 3000)
      child.once('exit', () => {
        clearTimeout(giveUp)
        resolve()
      })
      child.kill()
    })
    // One that did not answer in time is forgotten anyway: it was told to go.
    if (this.child === child) this.ended('', child)
    return this.dto()
  }

  /** Stop a tunnel an earlier run left behind (the app was killed): the pid file names it, and only a cloudflared is ever stopped. */
  async reap(): Promise<void> {
    const file = path.join(this.opts.dir, PID_FILE)
    let pid = NaN
    try {
      pid = Number((await fs.readFile(file, 'utf8')).trim())
    } catch {
      return
    }
    await fs.rm(file, { force: true }).catch(() => undefined)
    if (!Number.isInteger(pid) || pid <= 1) return
    const name = await (this.opts.processName ?? ((p: number) => processNameOf(p, this.platform)))(pid)
    if (name && /^cloudflared(\.exe)?$/i.test(name)) {
      try {
        process.kill(pid)
      } catch {
        /* already gone */
      }
    }
  }

  private async writePid(pid: number): Promise<void> {
    try {
      await fs.mkdir(this.opts.dir, { recursive: true })
      await fs.writeFile(path.join(this.opts.dir, PID_FILE), String(pid))
    } catch {
      /* the tunnel runs without a record: only a crashed app would leave it unfound */
    }
  }

  /** Output of the process: kept (the last lines say what went wrong) and read for the address. */
  private heard(child: ChildProcess, text: string): void {
    if (this.child !== child) return
    const all = this.partial + text
    const parts = all.split(/\r?\n/)
    this.partial = parts.pop() ?? ''
    for (const line of parts) {
      if (line.trim()) this.lines.push(line.trim())
      if (this.lines.length > KEEP_LINES) this.lines.shift()
      if (this.state === 'starting') {
        const url = tunnelUrlIn(line)
        if (url) {
          if (this.timer) clearTimeout(this.timer)
          this.timer = null
          this.state = 'on'
          this.url = url
          this.emit()
        }
      }
    }
  }

  /** The process is gone (it ended, could not start, or was stopped): back to off, with a reason unless it was asked to go. */
  private ended(message: string, child: ChildProcess | null): void {
    if (child && this.child !== child) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const asked = this.stopping
    this.child = null
    this.stopping = false
    this.state = 'off'
    this.url = null
    // Say why, with the last thing it said (cloudflared explains itself: no network, a refused request).
    const said = this.lines.filter((l) => !/^[|+\-\s]*$/.test(l)).slice(-2).join(' / ')
    this.error = asked ? null : `${message}${said ? `: ${said}` : ''}`
    void fs.rm(path.join(this.opts.dir, PID_FILE), { force: true }).catch(() => undefined)
    this.emit()
  }
}
