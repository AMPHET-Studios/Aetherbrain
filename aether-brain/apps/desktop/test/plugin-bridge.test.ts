import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { imageKindOf, MAX_ASSET_BYTES } from '../src/main/assets.js'
import { isImageName } from '../src/main/fsvault.js'
import { Brain, HOST_TOOLS, startHttpLink, type PictureHost, type ShowTarget } from '../src/mcp/server.js'

/**
 * The Claude plugin's bridge (plugin/aether-brain/bin/bridge.mjs): the MCP server Claude starts over stdio, which passes every
 * message on to the running app's AI link. A fake link tests its protocol; the real link (startHttpLink over a real brain) and
 * the real program over real stdio test that the two fit.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(here, '../../../plugin/aether-brain')
const BRIDGE = path.join(PLUGIN, 'bin', 'bridge.mjs')
const TOKEN = 'test-token-0123456789abcdef'

interface Link {
  ok: boolean
  port?: number
  token?: string
  why?: string
  file?: string
}
interface Bridge {
  handle(line: string): Promise<void>
  idle(): Promise<void>
  readonly online: boolean | null
  readonly lastDown: { why: string }
  check(): Promise<{ ok: boolean; why?: string; port?: number; text: string }>
  close(): void
}
interface BridgeOptions {
  settingsFile?: string
  fetch?: typeof fetch
  write?: (line: string) => void
  log?: (text: string) => void
  pollMs?: number
  version?: string
  platform?: string
}
interface BridgeModule {
  HOST: string
  STATUS_TOOL: string
  settingsPath(o?: { env?: Record<string, string | undefined>; platform?: string; home?: string }): string
  readLink(file: string): Promise<Link>
  explain(why: string, extra?: { file?: string; port?: number }): string
  isPictureName(name: string, platform?: string): boolean
  startsLikeAPicture(b: Uint8Array): boolean
  readPicture(raw: string, platform?: string): Promise<{ bytes: Uint8Array; name: string }>
  createBridge(opts?: BridgeOptions): Bridge
}
const bridgeModule = (await import(pathToFileURL(BRIDGE).href)) as BridgeModule
const { createBridge, readLink, readPicture, settingsPath, explain, isPictureName, startsLikeAPicture, STATUS_TOOL } = bridgeModule

const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
/** The first bytes of a PNG with its pixel size, then `pad` more bytes. */
function png(width = 2, height = 3, pad = 0): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 6, 0, 0, 0, ...new Array<number>(4 + pad).fill(0)])
}

let tmp: string
let settingsFile: string
const cleanups: (() => Promise<void> | void)[] = []

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-bridge-'))
  settingsFile = path.join(tmp, 'settings.json')
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cleanups.splice(0)) await c()
  await fs.rm(tmp, { recursive: true, force: true })
})

const writeSettings = (ai: Record<string, unknown> | null, extra: Record<string, unknown> = {}): Promise<void> =>
  fs.writeFile(settingsFile, JSON.stringify({ roots: ['/not/read'], ...extra, ...(ai ? { ai } : {}) }))
const LINK_ON = { enabled: true, port: 7457, token: TOKEN, readOnly: false }

/* ----------------------------------------------------------------------- */
/* Where the settings are, and what they say                                */
/* ----------------------------------------------------------------------- */

describe('settings', () => {
  it('finds the app’s settings where the app keeps them, on each system', () => {
    expect(settingsPath({ env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, platform: 'win32', home: 'C:\\Users\\me' })).toBe('C:\\Users\\me\\AppData\\Roaming\\Aether Brain\\settings.json')
    expect(settingsPath({ env: {}, platform: 'win32', home: 'C:\\Users\\me' })).toBe('C:\\Users\\me\\AppData\\Roaming\\Aether Brain\\settings.json')
    expect(settingsPath({ env: {}, platform: 'darwin', home: '/Users/me' })).toBe('/Users/me/Library/Application Support/Aether Brain/settings.json')
    expect(settingsPath({ env: {}, platform: 'linux', home: '/home/me' })).toBe('/home/me/.config/Aether Brain/settings.json')
    expect(settingsPath({ env: { XDG_CONFIG_HOME: '/data/cfg' }, platform: 'linux', home: '/home/me' })).toBe('/data/cfg/Aether Brain/settings.json')
  })

  it('takes AETHER_SETTINGS as a file, or as the folder that holds it', () => {
    expect(settingsPath({ env: { AETHER_SETTINGS: '/x/ud/settings.json' }, platform: 'linux', home: '/h' })).toBe('/x/ud/settings.json')
    expect(settingsPath({ env: { AETHER_SETTINGS: '/x/ud' }, platform: 'linux', home: '/h' })).toBe('/x/ud/settings.json')
    expect(settingsPath({ env: { AETHER_SETTINGS: 'C:\\ud' }, platform: 'win32', home: 'C:\\h' })).toBe('C:\\ud\\settings.json')
    expect(settingsPath({ env: { AETHER_SETTINGS: '   ' }, platform: 'linux', home: '/h' })).toBe('/h/.config/Aether Brain/settings.json')
  })

  it('reads the port and the key of a link that is switched on, and says why when it cannot', async () => {
    expect(await readLink(settingsFile)).toEqual({ ok: false, why: 'missing', file: settingsFile })
    await writeSettings(LINK_ON)
    expect(await readLink(settingsFile)).toEqual({ ok: true, port: 7457, token: TOKEN })
    await writeSettings({ ...LINK_ON, enabled: false })
    expect(await readLink(settingsFile)).toEqual({ ok: false, why: 'off' })
    await writeSettings(null)
    expect(await readLink(settingsFile)).toEqual({ ok: false, why: 'off' })
    await fs.writeFile(settingsFile, '{ not json')
    expect(await readLink(settingsFile)).toEqual({ ok: false, why: 'bad', file: settingsFile })
  })

  it('refuses a port or a key it would not send a request with', async () => {
    for (const ai of [
      { ...LINK_ON, port: 80 },
      { ...LINK_ON, port: 70000 },
      { ...LINK_ON, port: '7457' },
      { ...LINK_ON, port: 7457.5 },
      { ...LINK_ON, token: 'short' },
      { ...LINK_ON, token: `${TOKEN}/../../x` },
      { ...LINK_ON, token: 12345678901234567890 },
      { enabled: true },
    ]) {
      await writeSettings(ai)
      expect(await readLink(settingsFile), JSON.stringify(ai)).toMatchObject({ ok: false, why: 'bad' })
    }
  })

  it('reads settings written with a byte order mark', async () => {
    await fs.writeFile(settingsFile, `\uFEFF${JSON.stringify({ ai: LINK_ON })}`)
    expect(await readLink(settingsFile)).toMatchObject({ ok: true, port: 7457 })
  })

  it('tells the user what to do in each case, and never has the key in it', () => {
    for (const why of ['missing', 'off', 'bad', 'denied', 'down']) {
      const text = explain(why, { file: '/x/settings.json', port: 7457 })
      expect(text, why).toMatch(/Aether Brain/)
      expect(text, why).not.toContain(TOKEN)
    }
    expect(explain('off')).toMatch(/press a and switch Link on/)
    expect(explain('down', { port: 7457 })).toMatch(/Open the app.*port 7457|port 7457.*Open the app/)
    expect(explain('missing', { file: '/x/settings.json' })).toContain('/x/settings.json')
  })
})

/* ----------------------------------------------------------------------- */
/* A picture on this computer                                               */
/* ----------------------------------------------------------------------- */

describe('reading a picture for save_image', () => {
  async function put(rel: string, bytes: Uint8Array | string): Promise<string> {
    const full = path.join(tmp, ...rel.split('/'))
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, bytes)
    return full
  }

  it('reads a real picture file, with the name it came with', async () => {
    const file = await put('Downloads/Gate Art.PNG', png(8, 9))
    const r = await readPicture(file)
    expect(r.name).toBe('Gate Art.PNG')
    expect([...r.bytes]).toEqual([...png(8, 9)])
  })

  it('refuses what the stdio server refuses', async () => {
    const real = await put('Downloads/gate.png', png())
    await expect(readPicture('')).rejects.toThrow('path is empty')
    await expect(readPicture('gate.png')).rejects.toThrow(/whole path/)
    await expect(readPicture('..\\gate.png')).rejects.toThrow(/whole path/)
    await expect(readPicture('\\\\server\\share\\gate.png')).rejects.toThrow(/network or device path/)
    await expect(readPicture('//server/share/gate.png')).rejects.toThrow(/network or device path/)
    await expect(readPicture('\\\\?\\C:\\gate.png')).rejects.toThrow(/network or device path/)
    await expect(readPicture(path.join(tmp, 'notes.txt'))).rejects.toThrow(/Only pictures/)
    await expect(readPicture(path.join(tmp, 'Downloads', 'gone.png'))).rejects.toThrow('No such file: gone.png')
    await expect(readPicture(path.join(tmp, 'Downloads', 'drawing.svg'))).rejects.toThrow(/Only pictures/)
    expect(real).toBeTruthy()
  })

  it('refuses a folder with a picture’s name, an empty file, and a file that is no picture', async () => {
    await fs.mkdir(path.join(tmp, 'folder.png'))
    await expect(readPicture(path.join(tmp, 'folder.png'))).rejects.toThrow('folder.png is not a file')
    const empty = await put('empty.png', '')
    await expect(readPicture(empty)).rejects.toThrow('The picture is empty')
    const text = await put('secrets.png', 'password = hunter2\n'.repeat(10))
    await expect(readPicture(text)).rejects.toThrow('secrets.png is not a picture')
  })

  it('refuses a picture past 40 MB, and takes one of exactly 40 MB', async () => {
    const big = path.join(tmp, 'big.png')
    const handle = await fs.open(big, 'w')
    await handle.write(png(), 0, 33, 0)
    await handle.truncate(40 * 1024 * 1024 + 1)
    await handle.close()
    await expect(readPicture(big)).rejects.toThrow(/too big: 40\.0 MB \(at most 40 MB\)/)
    await fs.truncate(big, 40 * 1024 * 1024)
    expect((await readPicture(big)).bytes.length).toBe(40 * 1024 * 1024)
    expect(MAX_ASSET_BYTES).toBe(40 * 1024 * 1024)
  })

  it('follows a link to where it really leads before judging it', async () => {
    const target = await put('Real/notes.txt', 'not a picture')
    const link = path.join(tmp, 'looks-like.png')
    try {
      await fs.symlink(target, link)
    } catch {
      return // creating a link needs a privilege some Windows accounts do not have: nothing to test here
    }
    await expect(readPicture(link)).rejects.toThrow('looks-like.png is a link to something that is not a picture')
    const good = await put('Real/gate.png', png())
    const viaLink = path.join(tmp, 'alias.png')
    await fs.symlink(good, viaLink)
    expect((await readPicture(viaLink)).name).toBe('alias.png')
  })

  it('judges what a link leads to, whatever the system lets this test make (a link to the network, a link to a text file)', async () => {
    const file = await put('Downloads/alias.png', png())
    const real = vi.spyOn(fs, 'realpath')
    real.mockResolvedValueOnce('\\\\server\\share\\x.png')
    await expect(readPicture(file)).rejects.toThrow(/on the network/)
    real.mockResolvedValueOnce(path.join(tmp, 'notes.txt'))
    await expect(readPicture(file)).rejects.toThrow('alias.png is a link to something that is not a picture')
    // And a link that leads to a real picture is read from where it leads.
    const target = await put('Real/gate.png', png(7, 7))
    real.mockResolvedValueOnce(target)
    expect([...(await readPicture(file)).bytes]).toEqual([...png(7, 7)])
  })

  it('judges names and bytes the way the app does', () => {
    const names = ['gate.png', 'GATE.JPG', 'a.jpeg', 'a.webp', 'a.gif', 'a.bmp', 'a.avif', 'a.svg', 'a.png.txt', 'png', '.png', '~$a.png', 'nul.png', 'CON.jpg', 'com1.png', 'a:b.png', 'tool.exe:x.png', 'lpt3 .png', 'my con.png']
    for (const platform of ['win32', 'linux', 'darwin']) {
      for (const name of names) expect(isPictureName(name, platform), `${platform} ${name}`).toBe(isImageName(name, platform))
    }
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])
    const gif = Uint8Array.from([...Buffer.from('GIF89a'), 1, 0, 1, 0])
    const webp = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')])
    const bmp = new Uint8Array(40)
    bmp.set(Buffer.from('BM'))
    const avif = Uint8Array.from([0, 0, 0, 28, ...Buffer.from('ftypavif')])
    const samples = [png(), jpeg, gif, webp, bmp, avif, Uint8Array.from(Buffer.from('BM')), Uint8Array.from(Buffer.from('hello, I am a text file')), new Uint8Array(0), Uint8Array.from([0x4d, 0x5a, 0x90, 0]), Uint8Array.from([0xff, 0xd8])]
    for (const s of samples) expect(startsLikeAPicture(s), [...s.subarray(0, 12)].join(',')).toBe(imageKindOf(s) !== null)
  })
})

/* ----------------------------------------------------------------------- */
/* The protocol, against a fake link                                        */
/* ----------------------------------------------------------------------- */

interface Sent {
  url: string
  headers: Record<string, string>
  body: any
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const rpc = (id: unknown, result: unknown = {}) => ({ jsonrpc: '2.0', id, result })
const line = (message: unknown): string => JSON.stringify(message)

/** A bridge over a fake link that answers `route` and remembers what it was sent; `out` is what the bridge wrote to Claude. */
async function setup(opts: { ai?: Record<string, unknown> | null; route?: (body: any, n: number) => Response | Promise<Response>; pollMs?: number; platform?: string } = {}) {
  if (opts.ai !== null) await writeSettings(opts.ai ?? LINK_ON)
  const sent: Sent[] = []
  const out: any[] = []
  const logs: string[] = []
  let route = opts.route ?? ((body: any) => json(rpc(body.id)))
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? 'null'))
    sent.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body })
    return route(body, sent.length)
  }) as typeof fetch
  const bridge = createBridge({
    settingsFile,
    fetch: fake,
    write: (l) => out.push(JSON.parse(l)),
    log: (t) => logs.push(t),
    pollMs: opts.pollMs ?? 60_000,
    version: '9.9.9',
    ...(opts.platform ? { platform: opts.platform } : {}),
  })
  cleanups.push(() => bridge.close())
  return { bridge, sent, out, logs, setRoute: (r: typeof route) => (route = r) }
}

describe('passing messages on', () => {
  it('sends a request to the link on this computer with the key from the settings, and writes the answer back untouched', async () => {
    const { bridge, sent, out } = await setup({ route: (b) => json(rpc(b.id, { tools: [{ name: 'search_notes' }] })) })
    await bridge.handle(line({ jsonrpc: '2.0', id: 7, method: 'tools/list' }))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe(`http://127.0.0.1:7457/mcp/${TOKEN}`)
    expect(sent[0]!.headers['content-type']).toBe('application/json')
    expect(sent[0]!.headers['accept']).toBe('application/json, text/event-stream')
    expect(sent[0]!.body).toEqual({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
    expect(out).toEqual([rpc(7, { tools: [{ name: 'search_notes' }] })])
    expect(bridge.online).toBe(true)
  })

  it('follows the app when its port or key change, without a restart', async () => {
    const { bridge, sent } = await setup()
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    await writeSettings({ enabled: true, port: 7460, token: 'another-key-0123456789abcdef', readOnly: true })
    await bridge.handle(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    expect(sent.map((s) => s.url)).toEqual([`http://127.0.0.1:7457/mcp/${TOKEN}`, 'http://127.0.0.1:7460/mcp/another-key-0123456789abcdef'])
  })

  it('tells the app who is calling, so its activity line can say "Claude"', async () => {
    const { bridge, sent } = await setup()
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.1' }, capabilities: {} } }))
    await bridge.handle(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    expect(sent.map((s) => s.headers['user-agent'])).toEqual(['claude-code via aether-brain-bridge/9.9.9', 'claude-code via aether-brain-bridge/9.9.9'])
  })

  it('does not take a client name that could break a header', async () => {
    const { bridge, sent } = await setup()
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'x\r\nInjected: 1' } } }))
    await bridge.handle(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    expect(sent[1]!.headers['user-agent']).toBe('mcp-client via aether-brain-bridge/9.9.9')
  })

  it('answers ping itself', async () => {
    const { bridge, sent, out } = await setup()
    await bridge.handle(line({ jsonrpc: '2.0', id: 'p', method: 'ping' }))
    expect(out).toEqual([rpc('p', {})])
    expect(sent).toHaveLength(0)
  })

  it('passes a notification on and writes nothing for the 202 that answers it', async () => {
    const { bridge, sent, out } = await setup({ route: () => new Response(null, { status: 202 }) })
    await bridge.handle(line({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    expect(sent[0]!.body).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(out).toEqual([])
  })

  it('reads an answer that comes as a stream of events', async () => {
    const { bridge, out } = await setup({
      route: (b) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\nevent: message\ndata: ${JSON.stringify(rpc(b.id, { ok: true }))}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    await bridge.handle(line({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x' } }))
    expect(out).toEqual([{ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }, rpc(3, { ok: true })])
  })

  it('gives an HTTP error the id of the request it answers, so the client is not left waiting', async () => {
    const { bridge, out } = await setup({ route: () => json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, 405) })
    await bridge.handle(line({ jsonrpc: '2.0', id: 11, method: 'tools/list' }))
    expect(out).toEqual([{ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: 11 }])
  })

  it('does not leave a request without an answer when the app sends none', async () => {
    const { bridge, out } = await setup({ route: () => new Response(null, { status: 202 }) })
    await bridge.handle(line({ jsonrpc: '2.0', id: 12, method: 'tools/list' }))
    expect(out).toEqual([{ jsonrpc: '2.0', id: 12, error: { code: -32603, message: 'Aether Brain answered HTTP 202 without a reply' } }])
  })

  it('handles a batch, answering each', async () => {
    const { bridge, out } = await setup()
    await bridge.handle(line([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]))
    expect(out.map((m) => m.id).sort()).toEqual([1, 2])
  })

  it('answers a line that is not JSON with a parse error, and ignores a blank one and a client’s reply', async () => {
    const { bridge, out } = await setup()
    await bridge.handle('{ nope')
    await bridge.handle('   ')
    await bridge.handle(line({ jsonrpc: '2.0', id: 5, result: {} }))
    expect(out).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }])
  })

  it('makes sure the client is told the tools may change', async () => {
    const { bridge, out } = await setup({ route: (b) => json(rpc(b.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'aether-brain' } })) })
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }))
    expect(out[0].result.capabilities.tools.listChanged).toBe(true)
    expect(out[0].result.serverInfo.name).toBe('aether-brain')
  })

  it('never puts the key where Claude or a log can read it', async () => {
    const { bridge, out, logs } = await setup({ route: () => json({ jsonrpc: '2.0', error: { code: -1, message: 'x' }, id: null }, 500) })
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    await writeSettings({ ...LINK_ON, enabled: false })
    await bridge.handle(line({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_notes' } }))
    expect(JSON.stringify(out) + logs.join('\n')).not.toContain(TOKEN)
  })
})

describe('save_image with a path (the link takes no paths: the bridge reads the file)', () => {
  const callOf = (args: Record<string, unknown>, id = 1) => line({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'save_image', arguments: args } })

  it('sends the picture’s bytes as data, with the file’s name, and nothing else changed', async () => {
    const file = path.join(tmp, 'Gate Art.png')
    await fs.writeFile(file, png(5, 6, 100))
    const { bridge, sent } = await setup()
    await bridge.handle(callOf({ path: file, title: 'Gate', text: 'The first pass.', tags: ['portal'] }))
    expect(sent).toHaveLength(1)
    const args = sent[0]!.body.params.arguments
    expect(args).toEqual({ name: 'Gate Art.png', data: Buffer.from(png(5, 6, 100)).toString('base64'), title: 'Gate', text: 'The first pass.', tags: ['portal'] })
    expect(args.path).toBeUndefined()
    expect(sent[0]!.body.params.name).toBe('save_image')
  })

  it('keeps a name the AI chose', async () => {
    const file = path.join(tmp, 'Screenshot 2026-10-18.png')
    await fs.writeFile(file, png())
    const { bridge, sent } = await setup()
    await bridge.handle(callOf({ path: file, name: 'gate-concept.png' }))
    expect(sent[0]!.body.params.arguments.name).toBe('gate-concept.png')
  })

  it('answers a file it must refuse as the tool would, without asking the app', async () => {
    const { bridge, sent, out } = await setup()
    await bridge.handle(callOf({ path: '\\\\server\\share\\gate.png' }, 1))
    await bridge.handle(callOf({ path: 'gate.png' }, 2))
    await bridge.handle(callOf({ path: path.join(tmp, 'notes.txt') }, 3))
    expect(sent).toHaveLength(0)
    expect(out.map((m) => [m.id, m.result.isError])).toEqual([[1, true], [2, true], [3, true]])
    expect(out[0].result.content[0].text).toMatch(/network or device path/)
    expect(out[1].result.content[0].text).toMatch(/whole path/)
  })

  it('leaves everything else alone: data and file go through as they are, and so does a path of another tool', async () => {
    const { bridge, sent } = await setup()
    await bridge.handle(callOf({ data: 'aGVsbG8=', name: 'x.png' }, 1))
    await bridge.handle(callOf({ file: { download_url: 'https://files.oaiusercontent.com/x', file_id: 'f' } }, 2))
    await bridge.handle(line({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_note', arguments: { path: 'C:\\secret.txt' } } }))
    await bridge.handle(callOf({ path: '' }, 4))
    expect(sent.map((s) => s.body.params.arguments)).toEqual([
      { data: 'aGVsbG8=', name: 'x.png' },
      { file: { download_url: 'https://files.oaiusercontent.com/x', file_id: 'f' } },
      { path: 'C:\\secret.txt' },
      { path: '' },
    ])
  })
})

describe('when the app cannot be reached', () => {
  const init = line({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'claude-code' }, capabilities: {} } })

  it('starts anyway, says what to do, and lists a status tool, so Claude can tell the user', async () => {
    const { bridge, sent, out } = await setup({ ai: { ...LINK_ON, enabled: false } })
    await bridge.handle(init)
    await bridge.handle(line({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    await bridge.handle(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    expect(sent).toHaveLength(0)
    expect(out[0].result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'aether-brain', version: '9.9.9' } })
    expect(out[0].result.instructions).toMatch(/switched off.*press a and switch Link on/)
    expect(out[0].result.instructions).toContain(STATUS_TOOL)
    expect(out[1].result.tools.map((t: { name: string }) => t.name)).toEqual([STATUS_TOOL])
    expect(out[1].result.tools[0]).toMatchObject({ annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } })
    expect(out[1].result.tools[0].description).toMatch(/^Use this when/)
    expect(bridge.online).toBe(false)
  })

  it('answers a tool call with the reason, as an error Claude can read', async () => {
    const { bridge, out } = await setup({ ai: null })
    await bridge.handle(line({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'gate' } } }))
    expect(out[0].result.isError).toBe(true)
    expect(out[0].result.content[0].text).toMatch(/Aether Brain is not available: Aether Brain has not been opened on this computer yet/)
    expect(out[0].result.content[0].text).toContain(settingsFile)
  })

  it('says which port nothing answers on when the link is on but the app is gone', async () => {
    const { bridge, out } = await setup({
      route: () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      },
    })
    await bridge.handle(line({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search_notes' } }))
    expect(out[0].result.content[0].text).toMatch(/Aether Brain is not running \(nothing answers on port 7457\)/)
    expect(bridge.lastDown).toMatchObject({ why: 'down', port: 7457 })
  })

  it('answers the status tool whether or not it is up', async () => {
    const { bridge, out, setRoute } = await setup({ route: () => { throw new TypeError('fetch failed') } })
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: STATUS_TOOL } }))
    expect(out[0].result.isError).toBeUndefined()
    expect(out[0].result.content[0].text).toMatch(/not running/)
    setRoute((b) => json(rpc(b.id)))
    await bridge.handle(line({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: STATUS_TOOL } }))
    expect(out[1].result.content[0].text).toBe('Aether Brain is running and its AI link answers. All its tools are available.')
  })

  it('has no other methods to offer, and drops notifications without a word', async () => {
    const { bridge, out } = await setup({ ai: null })
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'resources/list' }))
    await bridge.handle(line({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }))
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }])
  })

  it('treats a refused key as "denied" after looking at the settings once more', async () => {
    const { bridge, sent, out, setRoute } = await setup({ route: () => json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }, 401) })
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_notes' } }))
    expect(sent).toHaveLength(2)
    expect(out[0].result.content[0].text).toMatch(/refused the key/)
    setRoute((b) => json(rpc(b.id)))
  })

  it('picks up a key the app changed a moment ago', async () => {
    const { bridge, sent, out } = await setup({
      route: (b, n) => {
        if (n === 1) {
          // The app saved its new key just after the bridge read the old one.
          void writeSettings({ ...LINK_ON, token: 'brand-new-key-0123456789abcdef' })
          return json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }, 401)
        }
        return json(rpc(b.id, { ok: true }))
      },
    })
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_notes' } }))
    expect(sent.map((s) => s.url.split('/').pop())).toEqual([TOKEN, 'brand-new-key-0123456789abcdef'])
    expect(out).toEqual([rpc(1, { ok: true })])
  })

  it('says the app is slow, not gone, when it does not answer in time', async () => {
    const { bridge, out } = await setup({
      route: () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      },
    })
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_image' } }))
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Aether Brain did not answer in time' } }])
    expect(bridge.online).toBe(null)
  })

  it('says tools/list_changed when the app comes up, but only once the client is ready for it', async () => {
    const { bridge, out, setRoute } = await setup({ ai: { ...LINK_ON, enabled: false }, pollMs: 15 })
    await bridge.handle(init)
    // Before the client said it is ready, a change is not announced.
    await writeSettings(LINK_ON)
    await vi.waitFor(() => expect(bridge.online).toBe(true))
    expect(out.filter((m) => m.method)).toEqual([])
    // Down again, ready now, and then up: announced.
    await writeSettings({ ...LINK_ON, enabled: false })
    await bridge.handle(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    expect(bridge.online).toBe(false)
    await bridge.handle(line({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    setRoute((b) => json(rpc(b.id)))
    await writeSettings(LINK_ON)
    await vi.waitFor(() => expect(out.some((m) => m.method === 'notifications/tools/list_changed')).toBe(true))
    expect(bridge.online).toBe(true)
    expect(out.filter((m) => m.method === 'notifications/tools/list_changed')).toHaveLength(1)
  })

  it('says it again when the app goes away, so Claude lists the status tool instead of tools that no longer answer', async () => {
    const { bridge, out } = await setup({ pollMs: 15 })
    await bridge.handle(init)
    await bridge.handle(line({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    await bridge.handle(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    expect(bridge.online).toBe(true)
    await writeSettings({ ...LINK_ON, enabled: false })
    await bridge.handle(line({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_notes' } }))
    expect(out.filter((m) => m.method === 'notifications/tools/list_changed')).toHaveLength(1)
    // And the call that found it out is answered, not left waiting.
    expect(out.find((m) => m.id === 3).result).toMatchObject({ isError: true })
  })

  it('stops looking when it is closed', async () => {
    const { bridge, sent } = await setup({ ai: { ...LINK_ON, enabled: false }, pollMs: 10 })
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    bridge.close()
    await writeSettings(LINK_ON)
    await new Promise((r) => setTimeout(r, 80))
    expect(sent).toHaveLength(0)
  })

  it('check() says what a person needs to know', async () => {
    const off = await setup({ ai: { ...LINK_ON, enabled: false } })
    expect(await off.bridge.check()).toMatchObject({ ok: false, why: 'off' })
    const on = await setup()
    expect(await on.bridge.check()).toEqual({ ok: true, port: 7457, text: 'Aether Brain is running and its AI link answers (port 7457).' })
  })
})

/* ----------------------------------------------------------------------- */
/* Against the real link, and as the real program                           */
/* ----------------------------------------------------------------------- */

describe('with the real link', () => {
  let root: string
  let brain: Brain | null = null

  beforeEach(async () => {
    root = path.join(tmp, 'vault')
    await fs.mkdir(path.join(root, 'Inbox'), { recursive: true })
    await fs.writeFile(path.join(root, 'Inbox', 'Loose thought.md'), '# Loose thought\n\nsomething\n')
  })
  afterEach(() => {
    brain?.close()
    brain = null
  })

  const STILL = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 250, 251, 252])
  function hosts() {
    const shown: ShowTarget[] = []
    const pictures: PictureHost = {
      find: async () => ({ pictures: [{ path: 'Inbox/Pictures/gate.png', kind: 'picture', bytes: 99, modified: 1 }], more: false }),
      look: async (p, px) => (p === 'Inbox/Pictures/gate.png' ? { png: STILL, path: p, kind: 'picture', bytes: 99, width: 640, height: 480 } : (void px, null)),
    }
    return { shown, pictures, show: (t: ShowTarget) => void shown.push(t) }
  }

  async function live(withHosts = true) {
    brain = await Brain.open({ roots: [root], watch: false })
    const h = hosts()
    const link = await startHttpLink({ brain, port: 0, token: TOKEN, readOnly: false, ...(withHosts ? { pictures: h.pictures, show: h.show } : {}) })
    cleanups.push(() => link.close())
    await writeSettings({ enabled: true, port: link.port, token: TOKEN, readOnly: false })
    return { link, h }
  }

  it('talks to the real link in process: lists the app’s tools, looks at a picture and sends one from disk', async () => {
    const { h } = await live()
    const out: any[] = []
    const bridge = createBridge({ settingsFile, write: (l) => out.push(JSON.parse(l)), log: () => undefined, pollMs: 60_000 })
    cleanups.push(() => bridge.close())
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } } }))
    expect(out[0].result.serverInfo.name).toBe('aether-brain')
    expect(out[0].result.capabilities.tools.listChanged).toBe(true)
    expect(out[0].result.instructions).toContain('find_pictures')
    await bridge.handle(line({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    await bridge.handle(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    const names = out[1].result.tools.map((t: { name: string }) => t.name)
    for (const n of HOST_TOOLS) expect(names).toContain(n)
    expect(names).not.toContain(STATUS_TOOL)

    await bridge.handle(line({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_image', arguments: { picture: 'Inbox/Pictures/gate.png', max_px: 256 } } }))
    expect(out[2].result.content.map((c: { type: string }) => c.type)).toEqual(['text', 'image'])
    expect(out[2].result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png', data: Buffer.from(STILL).toString('base64') })

    await bridge.handle(line({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'show_in_brain', arguments: { target: 'today' } } }))
    expect(h.shown).toEqual([{ kind: 'today', path: '', open: false }])

    // A screenshot on disk, several megabytes: read by the bridge, sent as data, kept byte for byte.
    const shot = path.join(tmp, 'Screenshot.png')
    const bytes = png(1920, 1080, 6 * 1024 * 1024)
    await fs.writeFile(shot, bytes)
    await bridge.handle(line({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'save_image', arguments: { path: shot, title: 'Gate shot', text: 'From Claude.' } } }))
    expect(out[4].result.isError).toBeUndefined()
    expect(out[4].result.content[0].text).toMatch(/Saved the picture to Inbox\/Pictures\/Screenshot\.png and the note Inbox\/Gate shot\.md/)
    const saved = await fs.readFile(path.join(root, 'Inbox', 'Pictures', 'Screenshot.png'))
    expect(saved.length).toBe(bytes.length)
    expect(Buffer.compare(saved, Buffer.from(bytes))).toBe(0)
    // The link still refuses a path from anyone who reaches it directly.
    const direct = await fetch(`http://127.0.0.1:${(await readLink(settingsFile)).port}/mcp/${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'save_image', arguments: { path: shot } } }),
    })
    expect(JSON.stringify(await direct.json())).toMatch(/path only works when Claude Desktop or Claude Code runs this server/)
  })

  it('is the standalone server’s tool set when the link has no app behind it', async () => {
    await live(false)
    const out: any[] = []
    const bridge = createBridge({ settingsFile, write: (l) => out.push(JSON.parse(l)), log: () => undefined, pollMs: 60_000 })
    cleanups.push(() => bridge.close())
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    const names = out[0].result.tools.map((t: { name: string }) => t.name)
    for (const n of HOST_TOOLS) expect(names).not.toContain(n)
    expect(names).toContain('save_image')
  })

  it('becomes offline when the link closes, and online again when it is back', async () => {
    const { link } = await live()
    const out: any[] = []
    const bridge = createBridge({ settingsFile, write: (l) => out.push(JSON.parse(l)), log: () => undefined, pollMs: 25 })
    cleanups.push(() => bridge.close())
    await bridge.handle(line({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    await bridge.handle(line({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    expect(bridge.online).toBe(true)
    await link.close()
    await bridge.handle(line({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_notes', arguments: { query: 'thought' } } }))
    expect(out.find((m) => m.id === 2).result.content[0].text).toMatch(/Aether Brain is not running/)
    expect(bridge.online).toBe(false)
    const again = await startHttpLink({ brain: brain!, port: 0, token: TOKEN, readOnly: false })
    cleanups.push(() => again.close())
    await writeSettings({ enabled: true, port: again.port, token: TOKEN, readOnly: false })
    await vi.waitFor(() => expect(bridge.online).toBe(true), { timeout: 3000 })
    expect(out.filter((m) => m.method === 'notifications/tools/list_changed')).toHaveLength(2)
  })
})

describe('as a program over stdio', () => {
  it('reports its version and its reach from the command line, and exits with the answer', async () => {
    const run = (args: string[], env: Record<string, string>) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [BRIDGE, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c) => (stdout += c))
        child.stderr.on('data', (c) => (stderr += c))
        child.on('close', (code) => resolve({ code, stdout, stderr }))
      })
    const version = JSON.parse(await fs.readFile(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version
    expect(await run(['--version'], {})).toEqual({ code: 0, stdout: `${version}\n`, stderr: '' })
    await writeSettings({ ...LINK_ON, enabled: false })
    const off = await run(['--check'], { AETHER_SETTINGS: settingsFile })
    expect(off.code).toBe(1)
    expect(off.stdout).toMatch(/switched off/)
    expect(off.stdout + off.stderr).not.toContain(TOKEN)
  })

  it('serves Claude over stdio: the real tools while the app is up, a status tool until then, and the real ones again when it comes up', async () => {
    const root = path.join(tmp, 'vault')
    await fs.mkdir(path.join(root, 'Inbox'), { recursive: true })
    await fs.writeFile(path.join(root, 'Inbox', 'Loose thought.md'), '# Loose thought\n\nsomething\n')
    await writeSettings({ ...LINK_ON, enabled: false })
    const transport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE], env: { ...(process.env as Record<string, string>), AETHER_SETTINGS: settingsFile }, stderr: 'pipe' })
    const client = new Client({ name: 'claude-code', version: '1.0.0' })
    let changed = 0
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => void changed++)
    await client.connect(transport)
    cleanups.push(() => client.close())
    expect(client.getServerVersion()?.name).toBe('aether-brain')
    expect(client.getInstructions()).toMatch(/switched off/)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([STATUS_TOOL])
    const status = (await client.callTool({ name: STATUS_TOOL })) as { content: { text: string }[] }
    expect(status.content[0]!.text).toMatch(/switched off/)

    const brain = await Brain.open({ roots: [root], watch: false })
    cleanups.push(() => brain.close())
    const link = await startHttpLink({ brain, port: 0, token: TOKEN, readOnly: false })
    cleanups.push(() => link.close())
    await writeSettings({ enabled: true, port: link.port, token: TOKEN, readOnly: false })
    // The bridge looks every few seconds: the client hears that its tools changed, and lists the real ones.
    await vi.waitFor(() => expect(changed).toBeGreaterThan(0), { timeout: 12_000, interval: 200 })
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('search_notes')
    expect(names).not.toContain(STATUS_TOOL)
    const found = (await client.callTool({ name: 'search_notes', arguments: { query: 'thought' } })) as { content: { text: string }[] }
    expect(found.content[0]!.text).toContain('Loose thought')
  }, 30_000)
})
