/**
 * The companion link: a small local HTTP server that a second renderer of the
 * brain (the Unreal Engine viewer in `unreal/`) reads the live scene from —
 * the nodes the brain window draws with their colours and sizes, its links,
 * where everything is right now — and asks the brain to select or open a node
 * through.
 *
 * Off until the user switches it on (`a` panel, or the palette). 127.0.0.1
 * only; every request carries the secret token (`Authorization: Bearer`),
 * compared in constant time; no CORS headers, so a web page can't read it.
 * It serves only what the brain window publishes (titles, colours, positions:
 * no note text) and takes only "select / open this node". While it runs, its
 * address and token are written to `companion.json` in the app's data folder
 * so the viewer finds them by itself; the file goes when it stops.
 *
 * The brain window publishes only while a viewer reads (`companion:want`),
 * so the link costs nothing when nobody looks.
 *
 * Pure Node (no electron import), unit-tested: main.ts hands in the brain window.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs, rmSync } from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { IPC, type CompanionBody, type CompanionGraphDto, type CompanionKind, type CompanionLimits, type CompanionNodeDto, type CompanionPatch, type CompanionStatus } from '../shared/ipc.js'

export const COMPANION_HOST = '127.0.0.1'
export const COMPANION_DEFAULT_PORT = 7459
/** A viewer that has not asked for anything this long (ms) has gone: the brain window stops publishing. */
export const CLIENT_IDLE_MS = 8000
/** How often the link checks for a viewer that went quiet (ms). */
export const IDLE_CHECK_MS = 2000
/** While a viewer reads but nothing was published this long (ms), the brain window is asked again (it may have reloaded). */
export const REPUBLISH_MS = 5000
/**
 * What the link takes from the brain window. The window cuts a big brain to a budget well below these
 * (renderer/companion-bound.ts), so they are a backstop: past them the scene is refused, and the panel says so.
 */
export const MAX_NODES = 50_000
export const MAX_EDGE_NUMBERS = 100_000
const MAX_RINGS = 2_000
const MAX_ID = 4096
const MAX_TITLE = 500
const MAX_BODY = 8192
/** First 4 bytes of /v1/positions: "AEP1". */
export const POSITIONS_MAGIC = 0x31504541
export const POSITIONS_HEADER = 16

const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/
const KINDS: ReadonlySet<CompanionKind> = new Set(['sun', 'star', 'planet', 'moon', 'ghost', 'picture', 'today'])
const BODIES: ReadonlySet<CompanionBody> = new Set(['galaxy', 'origin', 'star', 'planet', 'moon', 'ghost', 'hub'])
const LAYOUTS: ReadonlySet<string> = new Set(['constellation', 'orbit', 'system'])

/* ------------------------------------------------------------------ */
/* Settings and checks (pure)                                         */
/* ------------------------------------------------------------------ */

/** Persisted in settings.json under `companion`. */
export interface CompanionSettings {
  enabled: boolean
  port: number
  /** Secret every request must carry. */
  token: string
}

export function newCompanionToken(): string {
  return randomBytes(24).toString('base64url')
}

function isPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1024 && n <= 65535
}

/** Settings from disk with defaults filled in; a missing or malformed token gets a fresh one. */
export function companionSettings(raw: unknown): CompanionSettings {
  const r = isRecord(raw) ? raw : {}
  const token = r['token']
  return {
    enabled: r['enabled'] === true,
    port: isPort(r['port']) ? r['port'] : COMPANION_DEFAULT_PORT,
    token: typeof token === 'string' && TOKEN_RE.test(token) ? token : newCompanionToken(),
  }
}

/** Only the known, well-typed fields of a patch that crossed IPC. */
export function cleanCompanionPatch(raw: unknown): CompanionPatch {
  const r = isRecord(raw) ? raw : {}
  const out: CompanionPatch = {}
  if (typeof r['enabled'] === 'boolean') out.enabled = r['enabled']
  if (r['port'] !== undefined) out.port = Number(r['port'])
  if (r['regenerateToken'] === true) out.regenerateToken = true
  return out
}

/** A graph as the brain window sent it, checked and reduced to its known fields; throws on anything else. */
export function cleanGraph(raw: unknown): CompanionGraphDto {
  if (!isRecord(raw)) throw new Error('not a graph')
  const { version, vault, layout, nodes, edges, selected, limits } = raw
  if (!isCount(version)) throw new Error('bad version')
  if (typeof layout !== 'string' || !LAYOUTS.has(layout)) throw new Error('bad layout')
  if (!Array.isArray(nodes) || nodes.length > MAX_NODES) throw new Error('bad nodes')
  const n = nodes.length
  const out: CompanionNodeDto[] = new Array<CompanionNodeDto>(n)
  for (let i = 0; i < n; i++) {
    const x: unknown = nodes[i]
    if (!isRecord(x)) throw new Error(`bad node ${i}`)
    const { id, title, kind, color, radius, parent, body, urgency } = x
    if (typeof id !== 'string' || !id || id.length > MAX_ID) throw new Error(`bad node id ${i}`)
    if (typeof kind !== 'string' || !KINDS.has(kind as CompanionKind)) throw new Error(`bad node kind ${i}`)
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`bad node color ${i}`)
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0 || radius > 1000) throw new Error(`bad node radius ${i}`)
    if (!Number.isInteger(parent) || (parent as number) < -1 || (parent as number) >= n) throw new Error(`bad node parent ${i}`)
    out[i] = {
      id,
      title: typeof title === 'string' ? title.slice(0, MAX_TITLE) : id,
      kind: kind as CompanionKind,
      color: color.toLowerCase(),
      radius,
      parent: parent as number,
    }
    // The cosmology's fields are optional and never fail a scene: a bad one is left out.
    if (typeof body === 'string' && BODIES.has(body as CompanionBody)) out[i]!.body = body as CompanionBody
    if (typeof urgency === 'number' && Number.isFinite(urgency)) out[i]!.urgency = Math.round(Math.min(1, Math.max(0, urgency)) * 1000) / 1000
  }
  if (!Array.isArray(edges) || edges.length > MAX_EDGE_NUMBERS || edges.length % 2 !== 0) throw new Error('bad edges')
  for (const e of edges) if (!Number.isInteger(e) || (e as number) < 0 || (e as number) >= n) throw new Error('bad edge')
  if (!Number.isInteger(selected) || (selected as number) < -1 || (selected as number) >= n) throw new Error('bad selection')
  const dto: CompanionGraphDto = {
    version,
    vault: typeof vault === 'string' ? vault.slice(0, MAX_TITLE) : '',
    layout: layout as CompanionGraphDto['layout'],
    nodes: out,
    edges: edges as number[],
    selected: selected as number,
  }
  const lim = cleanLimits(limits)
  if (lim) dto.limits = lim
  return dto
}

/** How much of the brain the scene is (companion-bound.ts), or undefined when it is all of it or malformed. */
function cleanLimits(raw: unknown): CompanionLimits | undefined {
  if (!isRecord(raw)) return undefined
  const { nodes, ofNodes, links, ofLinks } = raw
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000
  return ok(nodes) && ok(ofNodes) && ok(links) && ok(ofLinks) ? { nodes, ofNodes, links, ofLinks } : undefined
}

/**
 * The body of /v1/positions: a 16-byte header (magic "AEP1", graph version,
 * node count, ring count; little-endian uint32), then xyz per node and 6
 * floats per orbit ring (parent index, radius, quaternion x y z w), float32
 * little-endian. Null when the counts don't fit the graph.
 */
export function positionsBody(version: number, nodes: number, positions: unknown, rings: unknown): Buffer | null {
  const p = floats(positions)
  const r = floats(rings) ?? new Float32Array(0)
  if (!p || p.length !== nodes * 3 || r.length % 6 !== 0 || r.length / 6 > MAX_RINGS) return null
  const ringCount = r.length / 6
  const buf = Buffer.alloc(POSITIONS_HEADER + (p.length + r.length) * 4)
  buf.writeUInt32LE(POSITIONS_MAGIC, 0)
  buf.writeUInt32LE(version >>> 0, 4)
  buf.writeUInt32LE(nodes, 8)
  buf.writeUInt32LE(ringCount, 12)
  let o = POSITIONS_HEADER
  for (let i = 0; i < p.length; i++, o += 4) buf.writeFloatLE(finite(p[i]), o)
  for (let i = 0; i < r.length; i++, o += 4) buf.writeFloatLE(finite(r[i]), o)
  return buf
}

/** What the viewer reads to find the link (companion.json). */
export function connectionInfo(port: number, token: string, version: string): Record<string, unknown> {
  return { app: 'Aether Brain', url: `http://${COMPANION_HOST}:${port}`, token, version }
}

function finite(v: number | undefined): number {
  return v !== undefined && Number.isFinite(v) ? v : 0
}

function floats(v: unknown): Float32Array | null {
  if (v instanceof Float32Array) return v
  if (Array.isArray(v) && v.every((x) => typeof x === 'number')) return Float32Array.from(v as number[])
  return null
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/* ------------------------------------------------------------------ */
/* Host                                                               */
/* ------------------------------------------------------------------ */

/** The brain window's webContents (a fake in tests). */
export interface CompanionTarget {
  readonly id: number
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
}

export interface CompanionHostOptions {
  settings: CompanionSettings
  save(settings: CompanionSettings): Promise<void>
  /** The brain window's webContents, or null. */
  brain(): CompanionTarget | null
  /** Absolute path of companion.json (the app's data folder). */
  connectionFile: string
  /** App version, for /v1/hello and companion.json. */
  version: string
  /** The link starts or stops wanting the scene (a viewer reads, or went quiet): the window must not slow itself down while it is read. */
  onWanted?(on: boolean): void
  /** Clock (ms), for tests. */
  now?: () => number
}

interface Scene {
  graph: CompanionGraphDto
  json: string
  ids: Map<string, number>
}

export class CompanionHost {
  private settings: CompanionSettings
  private server: http.Server | null = null
  private port: number | null = null
  private error: string | null = null
  /** Why the last scene from the brain window was refused, or null. */
  private rejected: string | null = null
  private starting: Promise<void> | null = null
  private scene: Scene | null = null
  private positions: Buffer | null = null
  private positionsSeq = 0
  private lastSeen = 0
  private lastPublish = 0
  private wanted = false
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(private opts: CompanionHostOptions) {
    this.settings = companionSettings(opts.settings)
    this.now = opts.now ?? Date.now
  }

  status(): CompanionStatus {
    return {
      enabled: this.settings.enabled,
      running: this.server !== null,
      port: this.port ?? this.settings.port,
      connected: this.server !== null && this.lastSeen > 0 && this.now() - this.lastSeen < CLIENT_IDLE_MS,
      error: this.error,
      file: this.opts.connectionFile,
      warning: this.rejected,
      showing: this.scene?.graph.limits ?? null,
    }
  }

  /** The address viewers use, with the token (for the panel's Copy button). */
  connection(): Record<string, unknown> {
    return connectionInfo(this.port ?? this.settings.port, this.settings.token, this.opts.version)
  }

  /** Start when switched on (app start). */
  async start(): Promise<void> {
    if (!this.settings.enabled || this.server) return
    this.starting ??= this.listen().finally(() => (this.starting = null))
    await this.starting
  }

  async configure(raw: unknown): Promise<CompanionStatus> {
    const patch = cleanCompanionPatch(raw)
    const next = { ...this.settings }
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    if (patch.port !== undefined) {
      if (!isPort(patch.port)) throw new Error('The port must be a whole number from 1024 to 65535')
      next.port = patch.port
    }
    if (patch.regenerateToken) next.token = newCompanionToken()
    const restart = next.port !== this.settings.port || next.token !== this.settings.token
    this.settings = next
    await this.opts.save({ ...next })
    if (!next.enabled || restart) await this.stop()
    if (next.enabled) await this.start()
    return this.status()
  }

  /** Stop listening, forget the viewer, delete companion.json. */
  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined)
    const srv = this.server
    this.server = null
    this.port = null
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
    this.setWanted(false)
    this.lastSeen = 0
    if (srv) {
      await new Promise<void>((resolve) => {
        srv.close(() => resolve())
        srv.closeAllConnections()
      })
    }
    await fs.rm(this.opts.connectionFile, { force: true }).catch(() => undefined)
  }

  /** On quit: stop at once (the process is about to end, so companion.json goes synchronously). */
  quit(): void {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
    this.server?.close()
    this.server?.closeAllConnections()
    this.server = null
    try {
      rmSync(this.opts.connectionFile, { force: true })
    } catch {
      // Left behind: the viewer finds nothing listening and says so.
    }
  }

  /** `companion:graph` from the brain window: the scene it draws. Anyone else, or anything malformed, is ignored. */
  publishGraph(senderId: number, raw: unknown): boolean {
    if (!this.fromBrain(senderId)) return false
    let graph: CompanionGraphDto
    try {
      graph = cleanGraph(raw)
    } catch (err) {
      this.rejected = `The Unreal app was sent a scene it can't take (${err instanceof Error ? err.message : 'malformed'}); a viewer shows nothing new until the next scene is good.`
      return false
    }
    this.rejected = null
    const ids = new Map<string, number>()
    graph.nodes.forEach((n, i) => ids.set(n.id, i))
    this.scene = { graph, json: JSON.stringify(graph), ids }
    // Positions of another node set no longer fit.
    if (this.positions && this.positions.readUInt32LE(4) !== graph.version >>> 0) this.positions = null
    this.lastPublish = this.now()
    return true
  }

  /** `companion:positions` from the brain window: xyz per node (and the orbit rings) of graph `version`. */
  publishPositions(senderId: number, version: unknown, positions: unknown, rings: unknown): boolean {
    const scene = this.scene
    if (!this.fromBrain(senderId) || !scene || version !== scene.graph.version) return false
    const body = positionsBody(scene.graph.version, scene.graph.nodes.length, positions, rings)
    if (!body) return false
    this.positions = body
    this.positionsSeq++
    this.lastPublish = this.now()
    return true
  }

  private fromBrain(senderId: number): boolean {
    const b = this.opts.brain()
    return !!b && !b.isDestroyed() && b.id === senderId
  }

  private send(channel: string, ...args: unknown[]): boolean {
    const b = this.opts.brain()
    if (!b || b.isDestroyed()) return false
    try {
      b.send(channel, ...args)
      return true
    } catch {
      return false
    }
  }

  private setWanted(on: boolean): void {
    if (on === this.wanted) return
    this.wanted = on
    if (!on) {
      // Stale the moment nobody keeps it fresh.
      this.scene = null
      this.positions = null
      this.rejected = null
    }
    this.send(IPC.companionWant, on)
    this.applyWanted(on)
  }

  /** Tell the app a viewer is (or is no longer) reading: a failing hook must not stop the link. */
  private applyWanted(on: boolean): void {
    try {
      this.opts.onWanted?.(on)
    } catch {
      // Nothing to do: the link works without it.
    }
  }

  /** A viewer is reading now. */
  isWanted(): boolean {
    return this.wanted
  }

  /** A viewer asked for something: the brain window publishes (again, if it went quiet: a reload). */
  private seen(): void {
    const now = this.now()
    this.lastSeen = now
    if (!this.wanted) {
      this.lastPublish = now
      this.setWanted(true)
    } else if (now - this.lastPublish > REPUBLISH_MS) {
      this.lastPublish = now
      this.send(IPC.companionWant, true)
      // The window may be a new one (closed and opened again) that never heard a viewer was reading.
      this.applyWanted(true)
    }
  }

  private checkIdle(): void {
    if (this.wanted && this.now() - this.lastSeen > CLIENT_IDLE_MS) this.setWanted(false)
  }

  private async listen(): Promise<void> {
    const expected = Buffer.from(this.settings.token, 'utf8')
    const tokenOk = (header: string | undefined): boolean => {
      const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
      const got = Buffer.from(m?.[1] ?? '', 'utf8')
      if (got.length !== expected.length) {
        timingSafeEqual(expected, expected)
        return false
      }
      return timingSafeEqual(got, expected)
    }
    const srv = http.createServer((req, res) => {
      this.handle(req, res, tokenOk).catch(() => reply(res, 500, { error: 'Internal error' }))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject)
        srv.listen(this.settings.port, COMPANION_HOST, () => {
          srv.off('error', reject)
          resolve()
        })
      })
    } catch (err) {
      const code = (err as { code?: unknown }).code
      this.error = code === 'EADDRINUSE' ? `Port ${this.settings.port} is taken by another program: pick another one` : `Could not start: ${String(err)}`
      return
    }
    srv.on('error', () => undefined)
    this.error = null
    this.server = srv
    this.port = (srv.address() as AddressInfo).port
    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_MS)
    this.idleTimer.unref?.()
    try {
      await fs.mkdir(path.dirname(this.opts.connectionFile), { recursive: true })
      await fs.writeFile(this.opts.connectionFile, JSON.stringify(this.connection(), null, 2), { mode: 0o600 })
    } catch (err) {
      this.error = `Running, but companion.json could not be written (${String(err)}): enter the address and token in the viewer`
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse, tokenOk: (h: string | undefined) => boolean): Promise<void> {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://companion.local').pathname
    } catch {
      return reply(res, 404, { error: 'Not found' })
    }
    const route = ROUTES[pathname]
    if (!route) return reply(res, 404, { error: 'Not found' })
    if (!tokenOk(req.headers.authorization)) return reply(res, 401, { error: 'Unauthorized: the token is wrong (see companion.json)' })
    if (req.method !== route) return reply(res, 405, { error: `Use ${route}` }, { Allow: route })
    this.seen()
    const scene = this.scene
    switch (pathname) {
      case '/v1/hello':
        return reply(res, 200, { app: 'Aether Brain', version: this.opts.version, vault: scene?.graph.vault ?? null, graph: scene?.graph.version ?? null })
      case '/v1/graph': {
        if (!scene) return reply(res, 503, { error: 'Nothing to show yet: open your vault in Aether Brain' }, { 'Retry-After': '1' })
        const tag = `"g${scene.graph.version}"`
        if (req.headers['if-none-match'] === tag) return notModified(res, tag)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: tag, 'Cache-Control': 'no-store' })
        res.end(scene.json)
        return
      }
      case '/v1/positions': {
        const body = this.positions
        if (!scene || !body) return reply(res, 503, { error: 'No positions yet' }, { 'Retry-After': '1' })
        const tag = `"p${this.positionsSeq}"`
        if (req.headers['if-none-match'] === tag) return notModified(res, tag)
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', ETag: tag, 'Cache-Control': 'no-store', 'Content-Length': body.length })
        res.end(body)
        return
      }
      case '/v1/select': {
        const body = await readBody(req)
        if (body === null) return reply(res, 413, { error: 'Too large' })
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          return reply(res, 400, { error: 'Send JSON: {"id": "...", "open": false}' })
        }
        const id = isRecord(parsed) ? parsed['id'] : undefined
        const open = isRecord(parsed) && parsed['open'] === true
        if (typeof id !== 'string' || !id || id.length > MAX_ID) return reply(res, 400, { error: 'id must be a node id' })
        if (!scene?.ids.has(id)) return reply(res, 404, { error: 'No such node in the brain right now' })
        if (!this.send(IPC.companionSelect, { id, open })) return reply(res, 409, { error: 'The brain window is closed' })
        res.writeHead(204)
        res.end()
        return
      }
    }
  }
}

const ROUTES: Record<string, 'GET' | 'POST'> = {
  '/v1/hello': 'GET',
  '/v1/graph': 'GET',
  '/v1/positions': 'GET',
  '/v1/select': 'POST',
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

function notModified(res: ServerResponse, tag: string): void {
  res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-store' })
  res.end()
}

/** The request body as text, or null past MAX_BODY bytes. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (d: Buffer) => {
      size += d.length
      // Past the cap: keep reading (the answer goes out once the body is in), keep nothing.
      if (size <= MAX_BODY) parts.push(d)
    })
    req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}
