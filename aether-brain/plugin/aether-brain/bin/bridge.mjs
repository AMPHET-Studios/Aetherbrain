/**
 * Aether Brain bridge: the MCP server of the Claude plugin.
 *
 * Claude starts this file over stdio (see ../.mcp.json). It holds no notes of its own: it passes every message on to the AI link
 * of the running Aether Brain app (http://127.0.0.1:<port>/mcp/<token>, the port and the token read from the app's own
 * settings.json), so Claude gets the live brain: the notes the app shows, and the tools only the app can offer (find_pictures,
 * get_image, show_in_brain). The address is always 127.0.0.1: nothing leaves this computer.
 *
 * Three things it does by itself:
 *  - save_image with a `path`. The link refuses file paths (a caller that comes through a tunnel must not name files here), but
 *    this process runs on the user's computer, as the user, like the stdio server of Claude Desktop and Claude Code. It reads
 *    the picture with the stdio server's checks (a whole path, a picture's file name, never a network or device path, a link
 *    is judged where it leads, a real picture, at most 40 MB) and sends its bytes as `data`.
 *  - The app is not running, or its link is off. It answers on its own with what to do (instructions and a status tool) instead
 *    of failing, and sends tools/list_changed when the app comes up (or goes away) so Claude lists the real tools without a restart.
 *  - ping.
 *
 * Zero dependencies (Node 20 or newer). `node bridge.mjs --check` says whether the app can be reached.
 */
import { promises as fs, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** The link only ever listens here. */
export const HOST = '127.0.0.1'
/** The tool this bridge offers while the app cannot be reached, and answers whenever it is asked. */
export const STATUS_TOOL = 'aether_brain_status'

const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i
const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])\s*(\.|$)/i
/** The largest picture Aether Brain keeps (apps/desktop/src/main/assets.ts MAX_ASSET_BYTES). */
const MAX_PICTURE_BYTES = 40 * 1024 * 1024
/** A tool may take long (a video's still frame, a big picture): longer than any of them. */
const REQUEST_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 2_000
const PING = JSON.stringify({ jsonrpc: '2.0', id: 'aether-bridge-probe', method: 'ping' })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ */
/* Where the app keeps its settings, and what they say                 */
/* ------------------------------------------------------------------ */

/**
 * The app's settings.json. `AETHER_SETTINGS` names it (a file, or the folder that holds it: how a second copy of the app
 * with its own user-data folder is reached). Otherwise the app's usual place: %APPDATA%\Aether Brain on Windows,
 * ~/Library/Application Support/Aether Brain on macOS, ~/.config/Aether Brain on Linux.
 */
export function settingsPath({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const given = (env.AETHER_SETTINGS ?? '').trim()
  if (given) return /\.json$/i.test(given) ? given : p.join(given, 'settings.json')
  const base =
    platform === 'win32'
      ? env.APPDATA || p.join(home, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? p.join(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME || p.join(home, '.config')
  return p.join(base, 'Aether Brain', 'settings.json')
}

/**
 * The link as the app's settings say: `{ ok: true, port, token }`, or `{ ok: false, why }` where why is `missing` (no settings
 * file: the app was never opened), `off` (the user did not switch the link on) or `bad` (damaged settings).
 */
export async function readLink(file) {
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return { ok: false, why: 'missing', file }
  }
  let ai
  try {
    ai = JSON.parse(raw.replace(/^\uFEFF/, '')).ai
  } catch {
    return { ok: false, why: 'bad', file }
  }
  if (!ai || ai.enabled !== true) return { ok: false, why: 'off' }
  const { port, token } = ai
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof token !== 'string' || !TOKEN_RE.test(token)) return { ok: false, why: 'bad', file }
  return { ok: true, port, token }
}

/** What to tell the user (and Claude) when the app cannot be reached. Never holds the token. */
export function explain(why, extra = {}) {
  switch (why) {
    case 'missing':
      return `Aether Brain has not been opened on this computer yet (no settings file${extra.file ? ` at ${extra.file}` : ''}). Install it, open it, press a and switch Link on.`
    case 'off':
      return "Aether Brain's AI link is switched off. Open Aether Brain, press a and switch Link on. It works as soon as you do; nothing needs restarting."
    case 'bad':
      return "Aether Brain's AI link settings are damaged. In the app press a and switch Link off and on again."
    case 'denied':
      return 'Aether Brain refused the key of its AI link. In the app press a, check that Link is on, and try again.'
    default:
      return `Aether Brain is not running${extra.port ? ` (nothing answers on port ${extra.port})` : ''}. Open the app; the tools come back by themselves.`
  }
}

/* ------------------------------------------------------------------ */
/* A picture on this computer, for save_image with a path              */
/* ------------------------------------------------------------------ */

/** True for a picture's file name Aether Brain shows (the same rule as the app: no `~$` owner files, on Windows no device names or streams). */
export function isPictureName(name, platform = process.platform) {
  if (!IMAGE_RE.test(name) || name.startsWith('~$')) return false
  return platform !== 'win32' || (!name.includes(':') && !WIN_DEVICE.test(name))
}

/** A path that leaves this computer or names a device: `\\server\share`, `//server/share`, `\\?\C:\…`, `\\.\pipe\…`. */
const leavesComputer = (p) => /^(\\\\|\/\/)/.test(p)

/** True when the bytes start like a PNG, JPEG, GIF, WebP, BMP or AVIF (the app's own list, checked again by the app). */
export function startsLikeAPicture(b) {
  const at = (i, ...bytes) => bytes.every((v, k) => b[i + k] === v)
  const text = (i, s) => at(i, ...[...s].map((c) => c.charCodeAt(0)))
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return true
  if (at(0, 0xff, 0xd8, 0xff)) return true
  if (text(0, 'GIF87a') || text(0, 'GIF89a')) return true
  if (text(0, 'RIFF') && text(8, 'WEBP')) return true
  if (text(0, 'BM') && b.length >= 26) return true
  return text(4, 'ftyp') && (text(8, 'avif') || text(8, 'avis'))
}

/**
 * The bytes of the picture file at `raw`, and its name, with the checks of the stdio server: a whole path (not relative), not a
 * network or device path (Windows would send the user's credentials to it), the name of a picture, followed to where a link
 * really leads before that is judged, a plain file, at most 40 MB, and bytes that start like a picture. Throws an Error whose
 * message says what is wrong.
 */
export async function readPicture(raw, platform = process.platform) {
  const p = String(raw).trim()
  if (!p) throw new Error('path is empty')
  if (leavesComputer(p)) throw new Error('A network or device path (\\\\server\\share, \\\\?\\ …) is not allowed: use a picture file on this computer')
  if (!path.isAbsolute(p)) throw new Error('path must be the whole path of the file, e.g. C:\\Users\\me\\Downloads\\gate.png')
  const name = path.basename(p)
  if (!isPictureName(name, platform)) throw new Error(`Only pictures (png, jpg, jpeg, webp, gif, bmp, avif) can be saved: ${name}`)
  let real
  try {
    real = await fs.realpath(p)
  } catch {
    throw new Error(`No such file: ${name}`)
  }
  if (leavesComputer(real)) throw new Error('That file is on the network (it is a link to a network path): copy it to this computer first')
  if (!isPictureName(path.basename(real), platform)) throw new Error(`${name} is a link to something that is not a picture`)
  const st = await fs.stat(real)
  if (!st.isFile()) throw new Error(`${name} is not a file`)
  if (st.size > MAX_PICTURE_BYTES) throw new Error(`The picture is too big: ${(st.size / 1024 / 1024).toFixed(1)} MB (at most ${MAX_PICTURE_BYTES / 1024 / 1024} MB)`)
  const handle = await fs.open(real, 'r')
  let bytes
  try {
    // One byte more than the cap: a file that grew since the stat is still refused.
    const buf = Buffer.alloc(Math.min(st.size, MAX_PICTURE_BYTES) + 1)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    if (bytesRead > MAX_PICTURE_BYTES) throw new Error(`The picture is too big (at most ${MAX_PICTURE_BYTES / 1024 / 1024} MB)`)
    bytes = buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  if (!bytes.length) throw new Error('The picture is empty')
  if (!startsLikeAPicture(bytes)) throw new Error(`${name} is not a picture: its bytes are not a PNG, JPEG, GIF, WebP, BMP or AVIF image`)
  return { bytes, name }
}

/* ------------------------------------------------------------------ */
/* JSON-RPC pieces                                                     */
/* ------------------------------------------------------------------ */

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value })
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
const toolText = (id, text, isError = false) => result(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })

/** The tool the bridge lists while the app cannot be reached (so Claude has something to ask, and to tell the user). */
const STATUS_TOOL_INFO = {
  name: STATUS_TOOL,
  title: 'Is Aether Brain running?',
  description: "Use this when Aether Brain's tools are missing or a call failed: says whether the Aether Brain app is running with its AI link on, and what the user has to do if not.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Is Aether Brain running?', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}

/** The messages in an HTTP answer: one JSON body (or an array of them), or the events of a stream. */
async function messagesOf(res) {
  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  const text = await res.text()
  if (!text.trim()) return []
  if (type.includes('text/event-stream')) {
    const out = []
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n')
      if (!data.trim()) continue
      try {
        out.push(JSON.parse(data))
      } catch {
        /* an event that is not JSON-RPC */
      }
    }
    return out
  }
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value : [value]
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/* The bridge                                                          */
/* ------------------------------------------------------------------ */

/**
 * A bridge between one MCP client (lines of JSON-RPC given to `handle`, answers handed to `write`) and the app's link.
 * Everything outside is injectable so it can be tested: `fetch`, `settingsFile`, `write`, `log`, `pollMs`.
 */
export function createBridge(opts = {}) {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const doFetch = opts.fetch ?? globalThis.fetch
  const settingsFile = opts.settingsFile ?? settingsPath({ env, platform, ...(opts.home ? { home: opts.home } : {}) })
  const write = opts.write ?? ((line) => process.stdout.write(line))
  const log = opts.log ?? ((text) => process.stderr.write(`[aether-brain bridge] ${text}\n`))
  const pollMs = opts.pollMs ?? 3000
  const version = opts.version ?? 'dev'

  /** null before the first contact; then whether the app answered last. */
  let online = null
  /** The client said notifications/initialized: only then may a tools/list_changed be sent. */
  let ready = false
  /** Who the client says it is, for the app's activity line ("Claude read …"). */
  let clientName = 'mcp-client'
  let poll = null
  let closed = false
  /** What the last failed contact said, for the status tool. */
  let lastDown = { why: 'down' }
  const pending = new Set()

  const send = (message) => {
    if (closed) return
    write(`${JSON.stringify(message)}\n`)
  }

  const stopPolling = () => {
    if (poll) clearInterval(poll)
    poll = null
  }

  /** The app answered. */
  const up = () => {
    stopPolling()
    if (online === true) return
    const was = online
    online = true
    if (was === false) log('Aether Brain is reachable')
    if (was === false && ready) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }

  /** The app could not be reached (`down` says why); a probe watches for it to come back. */
  const down = (why) => {
    lastDown = why
    const was = online
    online = false
    if (was === true) {
      log(`Aether Brain is not reachable (${why.why})`)
      if (ready) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }
    if (!poll && !closed) {
      poll = setInterval(() => void probe(), pollMs)
      poll.unref?.()
    }
  }

  const headers = () => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'user-agent': `${clientName} via aether-brain-bridge/${version}`,
  })

  /** One POST to the link. Resolves `{ kind: 'down', why }` when the app cannot be reached, else `{ kind: 'answered', status, messages }`. */
  async function post(body, timeoutMs, again = true) {
    const link = await readLink(settingsFile)
    if (!link.ok) {
      const why = { why: link.why, ...(link.file ? { file: link.file } : {}) }
      down(why)
      return { kind: 'down', why }
    }
    let res
    try {
      res = await doFetch(`http://${HOST}:${link.port}/mcp/${link.token}`, { method: 'POST', headers: headers(), body, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return { kind: 'slow' }
      const why = { why: 'down', port: link.port }
      down(why)
      return { kind: 'down', why }
    }
    if (res.status === 401) {
      await res.arrayBuffer().catch(() => undefined)
      // The app may be changing its key right now: look at its settings once more before giving up.
      if (again) {
        await sleep(250)
        return post(body, timeoutMs, false)
      }
      const why = { why: 'denied' }
      down(why)
      return { kind: 'down', why }
    }
    let messages
    try {
      messages = await messagesOf(res)
    } catch {
      // The body stopped coming (the time ran out, or the app went away while it was being sent).
      return { kind: 'slow' }
    }
    up()
    return { kind: 'answered', status: res.status, messages }
  }

  /** While the app is out of reach: look again (a successful look is what `up` hears). */
  async function probe() {
    if (closed) return
    await post(PING, PROBE_TIMEOUT_MS, false).catch(() => undefined)
  }

  /** save_image with a path: the picture's bytes go as data (the link takes no paths). */
  async function withPictureData(msg) {
    const args = msg.params?.arguments
    if (!args || typeof args.path !== 'string' || !args.path.trim()) return msg
    const { path: filePath, ...rest } = args
    const { bytes, name } = await readPicture(filePath, platform)
    const label = typeof rest.name === 'string' && rest.name.trim() ? rest.name : name
    return { ...msg, params: { ...msg.params, arguments: { ...rest, name: label, data: Buffer.from(bytes).toString('base64') } } }
  }

  /** What to answer a request with while the app cannot be reached. */
  function offline(msg, why) {
    const text = explain(why.why, why)
    switch (msg.method) {
      case 'initialize':
        return result(msg.id, {
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'aether-brain', title: 'Aether Brain', version },
          instructions: `Aether Brain's tools are not available yet. ${text} Call ${STATUS_TOOL} to check again; once the app is open with its AI link on, the real tools appear by themselves.`,
        })
      case 'tools/list':
        return result(msg.id, { tools: [STATUS_TOOL_INFO] })
      case 'tools/call':
        return toolText(msg.id, `Aether Brain is not available: ${text}`, true)
      default:
        return failure(msg.id, -32601, 'Method not found')
    }
  }

  async function status(msg) {
    const r = await post(PING, PROBE_TIMEOUT_MS, false)
    if (r.kind === 'answered') return toolText(msg.id, 'Aether Brain is running and its AI link answers. All its tools are available.')
    if (r.kind === 'slow') return toolText(msg.id, 'Aether Brain is running but did not answer in time. Try again in a moment.')
    return toolText(msg.id, explain(r.why.why, r.why))
  }

  async function handleOne(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return
    const isRequest = msg.id !== undefined && msg.id !== null
    if (msg.method === 'initialize') {
      const name = msg.params?.clientInfo?.name
      if (typeof name === 'string' && /^[\w.\- ]{1,60}$/.test(name)) clientName = name.replace(/\s+/g, '-')
    }
    if (msg.method === 'notifications/initialized') ready = true
    if (isRequest && msg.method === 'ping') return send(result(msg.id, {}))
    if (isRequest && msg.method === 'tools/call' && msg.params?.name === STATUS_TOOL) return send(await status(msg))

    let wire = msg
    if (isRequest && msg.method === 'tools/call' && msg.params?.name === 'save_image') {
      try {
        wire = await withPictureData(msg)
      } catch (err) {
        return send(toolText(msg.id, err instanceof Error ? err.message : String(err), true))
      }
    }

    const r = await post(JSON.stringify(wire), REQUEST_TIMEOUT_MS)
    if (r.kind === 'down') {
      if (isRequest) send(offline(msg, r.why))
      return
    }
    if (r.kind === 'slow') {
      if (isRequest) send(failure(msg.id, -32603, 'Aether Brain did not answer in time'))
      return
    }
    if (!isRequest) return
    let answered = false
    for (const m of r.messages) {
      if (!m || typeof m !== 'object') continue
      let out = m
      // An HTTP-level error carries no request id (the link could not read one): give it the request's own.
      if (out.id === null && out.error) out = { ...out, id: msg.id }
      if (out.id === msg.id && (out.result !== undefined || out.error !== undefined)) {
        answered = true
        // Whatever the app is, the client may be told later that its tools changed.
        if (msg.method === 'initialize' && out.result?.capabilities) {
          out = { ...out, result: { ...out.result, capabilities: { ...out.result.capabilities, tools: { ...out.result.capabilities.tools, listChanged: true } } } }
        }
      }
      send(out)
    }
    if (!answered) send(failure(msg.id, -32603, `Aether Brain answered HTTP ${r.status} without a reply`))
  }

  /** One line from the client. */
  function handle(line) {
    const text = String(line).trim()
    if (!text) return Promise.resolve()
    let value
    try {
      value = JSON.parse(text)
    } catch {
      send(failure(null, -32700, 'Parse error'))
      return Promise.resolve()
    }
    const job = Promise.all((Array.isArray(value) ? value : [value]).map((m) => handleOne(m).catch((err) => log(`a message failed: ${err instanceof Error ? err.message : err}`)))).then(() => undefined)
    pending.add(job)
    void job.finally(() => pending.delete(job))
    return job
  }

  return {
    handle,
    /** Resolves when every message handled so far has been answered. */
    async idle() {
      while (pending.size) await Promise.all([...pending])
    },
    /** True when the app answered last (null before the first contact). */
    get online() {
      return online
    },
    /** Why the app was last unreachable. */
    get lastDown() {
      return lastDown
    },
    /** One look at the app now: `{ ok: true, port }` or `{ ok: false, why, text }`. */
    async check() {
      const link = await readLink(settingsFile)
      if (!link.ok) return { ok: false, why: link.why, text: explain(link.why, link) }
      const r = await post(PING, PROBE_TIMEOUT_MS, false)
      if (r.kind === 'answered') return { ok: true, port: link.port, text: `Aether Brain is running and its AI link answers (port ${link.port}).` }
      if (r.kind === 'slow') return { ok: false, why: 'slow', text: `Aether Brain is running (port ${link.port}) but did not answer in time.` }
      return { ok: false, why: r.why.why, text: explain(r.why.why, r.why) }
    },
    close() {
      closed = true
      stopPolling()
    },
  }
}

/* ------------------------------------------------------------------ */
/* Running it                                                          */
/* ------------------------------------------------------------------ */

async function pluginVersion() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json')
    const v = JSON.parse(await fs.readFile(file, 'utf8')).version
    return typeof v === 'string' ? v : 'dev'
  } catch {
    return 'dev'
  }
}

async function main() {
  const version = await pluginVersion()
  const args = process.argv.slice(2)
  if (args.includes('--version')) {
    process.stdout.write(`${version}\n`)
    return
  }
  if (args.includes('--check')) {
    const bridge = createBridge({ version })
    const r = await bridge.check()
    bridge.close()
    process.stdout.write(`${r.text}\n`)
    process.exitCode = r.ok ? 0 : 1
    return
  }
  // The client may close its end at any time.
  process.stdout.on('error', () => undefined)
  const bridge = createBridge({ version })
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', (line) => void bridge.handle(line))
  lines.on('close', () => {
    void bridge.idle().then(() => bridge.close())
  })
}

/** True when this file was started as the program (not imported by a test). */
function startedAsProgram() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (startedAsProgram()) {
  main().catch((err) => {
    process.stderr.write(`[aether-brain bridge] ${err instanceof Error ? err.message : err}\n`)
    process.exitCode = 1
  })
}
