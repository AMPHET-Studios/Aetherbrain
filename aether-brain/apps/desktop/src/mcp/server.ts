/**
 * Aether Brain MCP server: the bundle entry (dist/mcp/aether-mcp.mjs).
 *
 * As a module (Electron main imports it for the in-app AI link) it exports
 * the Brain, the tool server and the HTTP link. Executed directly it is a
 * CLI:
 *
 *   node aether-mcp.mjs --vault "D:\" --vault "F:\"          stdio (Claude Desktop, Claude Code)
 *   node aether-mcp.mjs "D:\" "F:\" --read-only=true         bare folders (how the .mcpb passes them)
 *   node aether-mcp.mjs "D:\" --exclude-list="Private, Taxes"  folder names to skip, comma-separated
 *   node aether-mcp.mjs --vault ~/Notes --http --port 7457   HTTP link for a tunnel (ChatGPT, claude.ai)
 *
 * In stdio mode stdout carries the protocol only; logs go to stderr.
 */
import { randomBytes } from 'node:crypto'
import { promises as fs, realpathSync, type Stats } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Brain } from './brain.js'
import { startHttpLink } from './http.js'
import { SERVER_VERSION, createMcpServer, type ActivityEvent } from './tools.js'

export { Brain, appendText } from './brain.js'
export type { BrainOptions, BrainPreload, FolderNode, NoteRef, ProjectBrief, TaskInfo, TaskSelector } from './brain.js'
export { INSTRUCTIONS, SERVER_VERSION, TOOLS, createMcpServer } from './tools.js'
export type { ActivityEvent, McpServerOptions, ToolName } from './tools.js'
export { MAX_BODY_BYTES, clientFromUserAgent, startHttpLink } from './http.js'
export { BrainTools, ChatThread, isLoopbackUrl, sessionBlock, timeLine } from './chat.js'
export type { ChatContext, ChatSettings, TurnOptions, TurnResult } from './chat.js'
export type { HttpLink, HttpLinkOptions } from './http.js'

export interface CliOptions {
  roots: string[]
  exclude: string[]
  hidden: string[]
  keep: string[]
  readOnly: boolean
  http: boolean
  port: number
  host: string
  token: string | null
  help: boolean
}

export const DEFAULT_PORT = 7457

const USAGE = `Aether Brain MCP server ${SERVER_VERSION}

Usage:
  aether-mcp.mjs --vault <folder> [--vault <folder> …] [options]
  aether-mcp.mjs <folder> [<folder> …] [options]

Options:
  --vault <folder>       A vault root (repeatable; several roots appear as D/, F/, …)
  --read-only[=true|false]  Offer read tools only
  --exclude <name>       Also skip folders with this name (repeatable; one exact name each)
  --exclude-list <names> Also skip these folder names, separated by commas
  --hide <folder>        Leave this one folder (an absolute path) out (repeatable)
  --keep <folder>        Show this folder although it looks like an installed game or program (repeatable)
                         (the extension's "Skip these folders")
  --http                 Serve the HTTP link instead of stdio (for tunnels: ChatGPT, claude.ai)
  --port <n>             HTTP port (default ${DEFAULT_PORT}; 0 = any free port)
  --host <address>       HTTP interface (default 127.0.0.1)
  --token <secret>       HTTP secret, 16+ URL-safe characters (default: a new random one)
  --help                 Show this help

AETHER_VAULT (folders separated by "${path.delimiter}") is used when no folder is given.
A folder that is missing at start (an unplugged drive) is skipped with a warning;
the server stops only when none of them is there.
`

function bool(value: string | undefined): boolean {
  if (value === undefined) return true
  return !/^(false|0|no|off|)$/i.test(value.trim())
}

/** A root as given: `D:` means the drive root (`D:\`), not the current folder on D. */
function rootPath(arg: string): string {
  const t = arg.trim()
  return path.resolve(/^[A-Za-z]:$/.test(t) ? `${t}\\` : t)
}

/**
 * Parse CLI arguments. Bare arguments are roots (the .mcpb passes one per
 * chosen folder); empty values and unexpanded `${…}` placeholders are skipped.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const out: CliOptions = { roots: [], exclude: [], hidden: [], keep: [], readOnly: false, http: false, port: DEFAULT_PORT, host: '127.0.0.1', token: null, help: false }
  const usable = (v: string | undefined): v is string => v !== undefined && v.trim() !== '' && !v.includes('${')
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = eq > 0 ? arg.slice(0, eq) : arg
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined
    const value = (): string => {
      const v = inline ?? argv[++i]
      if (v === undefined) throw new Error(`${flag} needs a value`)
      return v
    }
    switch (flag) {
      case '--vault':
      case '--root': {
        const v = value()
        if (usable(v)) out.roots.push(rootPath(v))
        break
      }
      case '--exclude': {
        // One name, exactly (a folder name may contain a comma): how the app's copied configs pass them.
        const v = value()
        if (usable(v)) out.exclude.push(v.trim())
        break
      }
      case '--exclude-list': {
        // Several names in one value, comma-separated: the .mcpb's "Skip these folders" text field.
        const v = value()
        if (usable(v)) out.exclude.push(...v.split(',').map((s) => s.trim()).filter(Boolean))
        break
      }
      case '--hide': {
        // One folder left out of the brain (an absolute path), as the app's copied configs pass them.
        const v = value()
        if (usable(v)) out.hidden.push(v.trim())
        break
      }
      case '--keep': {
        // One folder shown although it looks like an installed game or program.
        const v = value()
        if (usable(v)) out.keep.push(v.trim())
        break
      }
      case '--read-only':
      case '--readonly':
        out.readOnly = bool(inline)
        break
      case '--http':
        out.http = bool(inline)
        break
      case '--port': {
        const n = Number(value())
        if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('--port must be a whole number from 0 to 65535')
        out.port = n
        break
      }
      case '--host':
        out.host = value().trim()
        break
      case '--token':
        out.token = value().trim()
        break
      case '--help':
      case '-h':
        out.help = true
        break
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option ${flag} (see --help)`)
        if (usable(arg)) out.roots.push(rootPath(arg))
    }
  }
  if (!out.roots.length && env['AETHER_VAULT']) {
    out.roots = env['AETHER_VAULT'].split(path.delimiter).filter(usable).map(rootPath)
  }
  return out
}

/** How long a root may take to answer at start before it counts as missing (a sleeping disk spins up in seconds). */
const ROOT_TIMEOUT_MS = 20_000

function log(line: string): void {
  process.stderr.write(`${line}\n`)
}

/** fs.stat, or null when it fails or does not answer in `ms` (an offline network share can hang for minutes). */
async function statWithin(p: string, ms: number): Promise<Stats | null> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
    timer.unref()
  })
  try {
    return await Promise.race([fs.stat(p).catch(() => null), late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The roots that are folders right now, in order. A missing one (an unplugged
 * F:\, a network share that is down) is skipped with a warning, so the other
 * drives stay reachable: Claude Desktop starts the server once per session
 * and would otherwise lose the whole link. Throws only when none is left.
 */
export async function usableRoots(roots: string[], warn: (line: string) => void = log, timeoutMs = ROOT_TIMEOUT_MS): Promise<string[]> {
  const ok: string[] = []
  const problems: string[] = []
  const stats = await Promise.all(roots.map((r) => statWithin(r, timeoutMs)))
  for (const [i, r] of roots.entries()) {
    const st = stats[i]
    const problem = !st ? `Vault folder not found: ${r}` : !st.isDirectory() ? `Not a folder: ${r}` : null
    if (problem) problems.push(problem)
    else ok.push(r)
  }
  if (!ok.length) throw new Error(problems.join('; '))
  for (const p of problems) warn(`[aether] ${p} (skipped; the other folders are served)`)
  return ok
}

function logActivity(a: ActivityEvent): void {
  log(`[aether] ${a.client} · ${a.tool}: ${a.summary}`)
}

/** stdout belongs to the protocol in stdio mode: anything a dependency logs goes to stderr. */
function quietStdout(): void {
  const toErr = (...args: unknown[]): void => console.error(...args)
  console.log = toErr
  console.info = toErr
  console.debug = toErr
}

/**
 * The CLI: serve the vault over stdio (default) or HTTP (`--http`). Resolves
 * once serving; the process then runs until stdin closes (stdio) or a signal.
 */
export async function runStdio(argv: string[]): Promise<void> {
  const cli = parseArgs(argv)
  if (cli.help) {
    process.stderr.write(USAGE)
    return
  }
  if (!cli.roots.length) throw new Error('No vault folder given. Pass --vault <folder> (repeatable) or folders as arguments; see --help.')
  if (!cli.http) quietStdout()
  const found = await usableRoots(cli.roots)
  // Load in the background: the MCP handshake must not wait for a whole drive to be scanned.
  const brain = Brain.start({ roots: found, exclude: cli.exclude, hidden: cli.hidden, keep: cli.keep, readOnly: cli.readOnly, watch: true })
  const roots = brain.roots.map((r) => r.label).join(' + ')
  brain.ready().then(
    () => {
      const s = brain.stats()
      log(`[aether] ${roots}: ${s.notes} notes in ${s.folders} folders${cli.readOnly ? ' (read-only)' : ''}`)
    },
    (err: unknown) => log(`[aether] could not read ${roots}: ${err instanceof Error ? err.message : String(err)}`),
  )

  let stopping = false
  const stop = (close: () => Promise<void>): void => {
    if (stopping) return
    stopping = true
    brain.close()
    void close()
      .catch(() => undefined)
      .finally(() => process.exit(0))
  }

  if (cli.http) {
    const token = cli.token ?? randomBytes(24).toString('base64url')
    const link = await startHttpLink({ brain, host: cli.host, port: cli.port, token, readOnly: cli.readOnly, onActivity: logActivity })
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => stop(() => link.close()))
    log(`Aether Brain AI link (${cli.readOnly ? 'read-only' : 'read + write'}) for ${roots}`)
    log(`  Local URL: ${link.url}`)
    log(`  For ChatGPT or claude.ai, open a tunnel, e.g.  cloudflared tunnel --url http://127.0.0.1:${link.port}`)
    log(`  and use  https://<tunnel host>/mcp/${token}  as the connector URL. The token is a password.`)
    log('  Press Ctrl+C to stop.')
    return
  }

  // stdio: the client (Claude Desktop, Claude Code) runs on this computer, so save_image may read a picture file it names.
  const server = createMcpServer(brain, { readOnly: cli.readOnly, onActivity: logActivity, localFiles: true })
  const transport = new StdioServerTransport()
  const shutdown = (): void => stop(() => server.close())
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, shutdown)
  await server.connect(transport)
  log(`[aether] MCP server ${SERVER_VERSION} on stdio for ${roots}`)
}

/** True when this file is the program being run (not imported by the app). */
function isMain(): boolean {
  // Inside Electron's main or renderer process this file is a module of the app, whatever
  // argv holds. (Electron run as Node, ELECTRON_RUN_AS_NODE=1, has no process.type.)
  const type = (process as NodeJS.Process & { type?: string }).type
  if (type === 'browser' || type === 'renderer') return false
  const entry = process.argv[1]
  if (!entry) return false
  const canonical = (p: string): string => {
    let r = path.resolve(p)
    try {
      r = realpathSync(r)
    } catch {
      /* keep the resolved path */
    }
    return r.toLowerCase()
  }
  try {
    return canonical(entry) === canonical(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  runStdio(process.argv.slice(2)).catch((err: unknown) => {
    log(`[aether] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
