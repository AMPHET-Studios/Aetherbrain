/**
 * The AI link over HTTP: stateless Streamable HTTP for ChatGPT and claude.ai
 * (reached through a tunnel such as cloudflared or ngrok).
 *
 * Listens on 127.0.0.1 by default. There is no Host allow-list (a tunnel
 * forwards its public host name); instead every request must carry the
 * secret token, in the path (`/mcp/<token>`) or as `Authorization: Bearer
 * <token>` on `/mcp`, compared in constant time. Each POST gets a fresh
 * McpServer + transport (single-use), closed when the response closes.
 */
import { timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Brain } from './brain.js'
import { createMcpServer, type ActivityEvent, type PictureHost, type ShowTarget } from './tools.js'

export interface HttpLink {
  /** Full local URL including the token path, e.g. http://127.0.0.1:7457/mcp/<token>. */
  url: string
  /** The port actually listened on (useful with port 0). */
  port: number
  close(): Promise<void>
}

export interface HttpLinkOptions {
  brain: Brain
  /** Interface to listen on (default 127.0.0.1). */
  host?: string
  /** 0 picks a free port. */
  port: number
  /** Secret every request must carry: 16–256 URL-safe characters. */
  token: string
  readOnly: boolean
  onActivity?: (a: ActivityEvent) => void
  /** The app's pictures: with it the link lists find_pictures and get_image. Only the running app has them. */
  pictures?: PictureHost
  /** The app's window: with it the link lists show_in_brain. */
  show?: (target: ShowTarget) => void | Promise<void>
}

/**
 * Request body cap (64 MiB): a whole picture of 40 MB as base64 text is 53 MiB (`MAX_PICTURE_DATA_CHARS`), which is what the
 * plugin's bridge sends for a screenshot it read from disk. Only a request that carries the token is ever read, so this is the
 * most an authenticated caller can make the app hold at once, not a way for a stranger to fill its memory.
 */
export const MAX_BODY_BYTES = 64 * 1024 * 1024

const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/

/** Who is calling, from the User-Agent (stateless requests carry no MCP handshake). */
export function clientFromUserAgent(ua: string | undefined): string {
  const s = (ua ?? '').toLowerCase()
  if (s.includes('openai') || s.includes('chatgpt')) return 'ChatGPT'
  if (s.includes('claude') || s.includes('anthropic')) return 'Claude'
  return 'AI client'
}

/** A JSON-RPC error reply (the shape MCP clients understand), with no request id. */
function fail(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}

function bearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  return m ? (m[1] ?? null) : null
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/** Start the HTTP link. Rejects when the port is taken (EADDRINUSE) or the token is unusable. */
export async function startHttpLink(opts: HttpLinkOptions): Promise<HttpLink> {
  if (!TOKEN_RE.test(opts.token)) throw new Error('The AI link token must be 16–256 characters of A–Z, a–z, 0–9, "-" or "_"')
  const host = opts.host ?? '127.0.0.1'
  const expected = Buffer.from(opts.token, 'utf8')

  const tokenOk = (given: string | null): boolean => {
    if (given === null) return false
    const got = Buffer.from(given, 'utf8')
    // timingSafeEqual needs equal lengths; compare against itself so a wrong length costs the same.
    if (got.length !== expected.length) {
      timingSafeEqual(expected, expected)
      return false
    }
    return timingSafeEqual(got, expected)
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://link.local').pathname
    } catch {
      // A request target that is not a URL path (`//`): nothing lives there.
      return fail(res, 404, -32601, 'Not found')
    }
    const segs = pathname.split('/').filter(Boolean)
    if (segs[0] !== 'mcp' || segs.length > 2) return fail(res, 404, -32601, 'Not found')
    const given = segs.length === 2 ? decode(segs[1] ?? '') : bearer(req.headers.authorization)
    if (!tokenOk(given)) return fail(res, 401, -32001, 'Unauthorized: the link URL or token is wrong')
    if (req.method !== 'POST') {
      return fail(res, 405, -32000, 'Method not allowed: this link is stateless, send JSON-RPC with POST', { Allow: 'POST' })
    }
    const client = clientFromUserAgent(req.headers['user-agent'])
    const server = createMcpServer(opts.brain, {
      readOnly: opts.readOnly,
      ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
      ...(opts.pictures ? { pictures: opts.pictures } : {}),
      ...(opts.show ? { show: opts.show } : {}),
      getClient: () => client,
    })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    })
    res.on('close', () => {
      void transport.close().catch(() => undefined)
      void server.close().catch(() => undefined)
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }

  const srv = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.warn('[aether] AI link request failed', err)
      fail(res, 500, -32603, 'Internal error')
    })
  })

  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(opts.port, host, () => {
      srv.off('error', reject)
      resolve()
    })
  })
  srv.on('error', (err) => console.warn('[aether] AI link server error', err))
  const port = (srv.address() as AddressInfo).port
  const shown = host.includes(':') ? `[${host}]` : host

  return {
    url: `http://${shown}:${port}/mcp/${opts.token}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        srv.close(() => resolve())
        srv.closeAllConnections()
      }),
  }
}
