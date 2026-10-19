import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AssetResolver } from '@aether/core'
import { BrainTools } from '../src/mcp/chat.js'
import {
  DOWNLOAD_TIMEOUT_MS,
  MAX_PICTURE_DATA_CHARS,
  OPENAI_FILE_HOSTS,
  PICTURES_FOLDER,
  decodePictureData,
  fetchPictureFile,
  fileHostsFromEnv,
  isAllowedFileHost,
  pictureStem,
  pictureTitle,
  readLocalPicture,
} from '../src/mcp/pictures.js'
import { Brain, MAX_BODY_BYTES, TOOLS, createMcpServer, startHttpLink, type ActivityEvent, type McpServerOptions } from '../src/mcp/server.js'
import { lf } from './lf'

/**
 * save_image: an AI sends a picture (and the idea that goes with it) to the brain. Three sources (a file on this computer, a
 * ChatGPT attachment, base64), one rule for what gets written (a real picture, never over anything), and the refusals that keep
 * the link from being a way to reach files or addresses it should not.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(here, '../dist/mcp/aether-mcp.mjs')
const TOKEN = 'test-token-0123456789abcdef'

/** The first bytes of a PNG with its pixel size: all the brain looks at. */
function png(width = 2, height = 3, pad = 0): Uint8Array {
  const b = Buffer.alloc(33 + pad)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return new Uint8Array(b)
}
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01])
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')

let tmp: string
let root: string
let brain: Brain | null = null
let activity: ActivityEvent[] = []
const cleanups: (() => Promise<void>)[] = []

async function put(rel: string, content: string | Uint8Array, base = root): Promise<void> {
  const full = path.join(base, ...rel.split('/'))
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}
const exists = (rel: string, base = root): boolean => existsSync(path.join(base, ...rel.split('/')))
const diskBytes = (rel: string, base = root): Promise<Buffer> => fs.readFile(path.join(base, ...rel.split('/')))
const diskText = (rel: string, base = root): Promise<string> => fs.readFile(path.join(base, ...rel.split('/')), 'utf8')

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-pic-'))
  root = path.join(tmp, 'vault')
  await put('Inbox/Loose thought.md', '# Loose thought\n\nsomething\n')
  await put('Projects/PORTALz/Art/Glyphs.md', '# Glyphs\n')
  await put('.hidden/Secret.md', '# Secret\n')
  activity = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cleanups.splice(0)) await c()
  brain?.close()
  brain = null
  await fs.rm(tmp, { recursive: true, force: true })
})

async function open(opts: { readOnly?: boolean; roots?: string[] } = {}): Promise<Brain> {
  brain = await Brain.open({ roots: opts.roots ?? [root], watch: false, ...(opts.readOnly ? { readOnly: true } : {}) })
  return brain
}

interface Result {
  content: { type: string; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

async function connect(b: Brain, o: Partial<McpServerOptions> = {}): Promise<Client> {
  const server = createMcpServer(b, { readOnly: false, onActivity: (a) => activity.push(a), ...o })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'vitest', version: '1.0.0' })
  await client.connect(clientSide)
  cleanups.push(async () => {
    await client.close()
    await server.close()
  })
  return client
}
const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> => (await client.callTool({ name, arguments: args })) as Result
/** The JSON after the human line of a tool result. */
function json(r: Result): any {
  const text = r.content[0]?.text ?? ''
  if (r.isError) throw new Error(`tool failed: ${text}`)
  return JSON.parse(text.slice(text.indexOf('\n') + 1))
}
const errorOf = (r: Result): string => {
  expect(r.isError).toBe(true)
  return r.content[0]?.text ?? ''
}

/** A `fetch` that answers from `route` and remembers every request. */
function fakeFetch(route: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    return route(url, init ?? {})
  }) as typeof fetch
  return { fetch: f, calls }
}
const ok = (bytes: Uint8Array, headers: Record<string, string> = {}): Response => new Response(bytes as BodyInit, { status: 200, headers })

/* ----------------------------------------------------------------------- */
/* Names and base64                                                         */
/* ----------------------------------------------------------------------- */

describe('picture names', () => {
  const now = new Date(2026, 9, 18, 9, 30)

  it('keeps the name a picture came with, without folders or a picture extension', () => {
    expect(pictureStem('gate-concept.png')).toBe('gate-concept')
    expect(pictureStem('C:\\Users\\me\\Downloads\\Gate Art.PNG')).toBe('Gate Art')
    expect(pictureStem('/tmp/x/ring.jpeg')).toBe('ring')
    // Only a picture extension comes off: a dot in the name is the name's.
    expect(pictureStem('v1.2 sketch')).toBe('v1.2 sketch')
  })

  it('turns what Windows refuses in a name into spaces, drops trailing dots and cuts it at 80 characters', () => {
    expect(pictureStem('a:b*c?.png')).toBe('a b c')
    expect(pictureStem('what is this... .png')).toBe('what is this')
    expect(pictureStem('x'.repeat(200) + '.png')).toHaveLength(80)
    expect(pictureStem('Ünïcode 門.png')).toBe('Ünïcode 門')
  })

  it('names a picture with no name after the day', () => {
    expect(pictureStem(undefined, now)).toBe('Picture 2026-10-18')
    expect(pictureStem('', now)).toBe('Picture 2026-10-18')
    expect(pictureStem('???.png', now)).toBe('Picture 2026-10-18')
  })

  it('titles a note from the picture’s name', () => {
    expect(pictureTitle('gate_concept-art')).toBe('gate concept art')
    expect(pictureTitle('Gate Art 2')).toBe('Gate Art 2')
  })
})

describe('data (base64)', () => {
  it('reads bare base64, a data: address, whitespace and the URL-safe alphabet', () => {
    const bytes = png(40, 30, 200)
    const plain = b64(bytes)
    expect([...decodePictureData(plain)]).toEqual([...bytes])
    expect([...decodePictureData(`data:image/png;base64,${plain}`)]).toEqual([...bytes])
    expect([...decodePictureData(`  ${plain.slice(0, 20)}\n${plain.slice(20)}\r\n`)]).toEqual([...bytes])
    const urlSafe = Uint8Array.from([0xfb, 0xff, 0xfe, 0xfb, 0xef, 0xbf])
    expect(b64(urlSafe)).toMatch(/[+/]/)
    expect([...decodePictureData(b64(urlSafe).replace(/\+/g, '-').replace(/\//g, '_'))]).toEqual([...urlSafe])
  })

  it('refuses what is not base64, an empty value and a data: address that is not base64', () => {
    expect(() => decodePictureData('this is not base64!')).toThrow(/not base64/)
    expect(() => decodePictureData('')).toThrow(/empty/)
    expect(() => decodePictureData('   ')).toThrow(/empty/)
    expect(() => decodePictureData('data:image/png,%89PNG')).toThrow(/must be base64/)
    expect(() => decodePictureData('data:image/png;base64,')).toThrow(/empty/)
  })

  it('refuses more than a picture can be, and says what to use instead', () => {
    expect(() => decodePictureData('A'.repeat(MAX_PICTURE_DATA_CHARS + 4))).toThrow(/too long.*file or path/)
    // The cap is a whole 40 MB picture as base64, and the link's request cap leaves room for it and the rest of a request.
    expect(MAX_PICTURE_DATA_CHARS).toBeGreaterThanOrEqual(Math.ceil((40 * 1024 * 1024 * 4) / 3))
    expect(MAX_PICTURE_DATA_CHARS + 1_000_000).toBeLessThan(MAX_BODY_BYTES)
  })

  it('reads a big picture without making copies of its text: bare, with a data: address, and URL-safe', () => {
    const big = png(5, 5, 6_000_000)
    const text = b64(big)
    expect(text.length).toBeGreaterThan(8_000_000)
    expect(decodePictureData(text).length).toBe(big.length)
    expect(decodePictureData(`data:image/png;base64,${text}`).length).toBe(big.length)
    // A stray character deep inside a long text is still found.
    expect(() => decodePictureData(`${text.slice(0, 7_000_000)}!${text.slice(7_000_000)}`)).toThrow(/not base64/)
    expect(() => decodePictureData('====')).toThrow(/not base64/)
    expect(() => decodePictureData('AAAA===')).toThrow(/not base64/)
  })
})

/* ----------------------------------------------------------------------- */
/* Files on this computer                                                   */
/* ----------------------------------------------------------------------- */

describe('a picture file on this computer', () => {
  it('reads a real picture by its whole path', async () => {
    await put('downloads/gate.png', png(8, 8, 100), tmp)
    const r = await readLocalPicture(path.join(tmp, 'downloads', 'gate.png'))
    expect(r.name).toBe('gate.png')
    expect(r.bytes.length).toBe(133)
  })

  it('refuses a relative path, an empty one and a name that is not a picture’s', async () => {
    await expect(readLocalPicture('downloads/gate.png')).rejects.toThrow(/whole path/)
    await expect(readLocalPicture('   ')).rejects.toThrow(/empty/)
    await put('notes.txt', 'hello', tmp)
    await expect(readLocalPicture(path.join(tmp, 'notes.txt'))).rejects.toThrow(/Only pictures/)
    await put('run.exe', png(), tmp)
    await expect(readLocalPicture(path.join(tmp, 'run.exe'))).rejects.toThrow(/Only pictures/)
  })

  it('refuses a network or device path before touching it (Windows would send credentials to a share)', async () => {
    for (const p of ['\\\\server\\share\\a.png', '//server/share/a.png', '\\\\?\\C:\\a.png', '\\\\.\\pipe\\x.png', '\\\\localhost\\c$\\a.png']) {
      await expect(readLocalPicture(p), p).rejects.toThrow(/network or device path/)
    }
  })

  it('refuses a missing file, a folder called like a picture, and a file over the cap', async () => {
    await expect(readLocalPicture(path.join(tmp, 'nope.png'))).rejects.toThrow(/No such file/)
    await fs.mkdir(path.join(tmp, 'dir.png'))
    await expect(readLocalPicture(path.join(tmp, 'dir.png'))).rejects.toThrow(/not a file/)
    await put('big.png', png(2, 2, 5_000), tmp)
    await expect(readLocalPicture(path.join(tmp, 'big.png'), 1_000)).rejects.toThrow(/too big/)
  })

  it('follows a link to where it really points before judging it', async (ctx) => {
    await put('real.txt', 'text, not a picture', tmp)
    await put('fine.png', png(), tmp)
    try {
      await fs.symlink(path.join(tmp, 'real.txt'), path.join(tmp, 'looks-like.png'), 'file')
      await fs.symlink(path.join(tmp, 'fine.png'), path.join(tmp, 'link.png'), 'file')
    } catch {
      // Windows makes a symbolic link only for a user with the right (Developer Mode): nothing to test then.
      ctx.skip()
      return
    }
    await expect(readLocalPicture(path.join(tmp, 'looks-like.png'))).rejects.toThrow(/link to something that is not a picture/)
    expect((await readLocalPicture(path.join(tmp, 'link.png'))).bytes.length).toBe(33)
  })
})

/* ----------------------------------------------------------------------- */
/* ChatGPT files                                                            */
/* ----------------------------------------------------------------------- */

describe('which hosts a ChatGPT file may come from', () => {
  it('accepts ChatGPT’s own hosts and their subdomains, in any case', () => {
    for (const h of ['files.oaiusercontent.com', 'FILES.OAIUSERCONTENT.COM', 'oaiusercontent.com', 'x.y.openai.com', 'chatgpt.com', 'files.oaiusercontent.com.']) {
      expect(isAllowedFileHost(h, OPENAI_FILE_HOSTS), h).toBe(true)
    }
  })

  it('refuses look-alikes, other hosts and every address', () => {
    for (const h of ['evil-oaiusercontent.com', 'oaiusercontent.com.evil.com', 'openai.com.evil.com', 'notopenai.com', 'example.com', 'localhost', '127.0.0.1', '10.0.0.5', '169.254.169.254', '[::1]', '::1', '']) {
      expect(isAllowedFileHost(h, OPENAI_FILE_HOSTS), h).toBe(false)
    }
  })

  it('never takes an address as a host, even one somebody put on the list by mistake', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '[::1]', '::1', '169.254.169.254']) expect(isAllowedFileHost(h, [h, '10.1.2.3', '127.0.0.1']), h).toBe(false)
  })

  it('takes more hosts from AETHER_FILE_HOSTS, names only', () => {
    expect(fileHostsFromEnv({ AETHER_FILE_HOSTS: 'files.example.com, cdn.example.org' })).toEqual(['files.example.com', 'cdn.example.org'])
    expect(fileHostsFromEnv({ AETHER_FILE_HOSTS: '.Example.com. https://x.com/a *.evil.com 127.0.0.1 localhost a:8080' })).toEqual(['example.com'])
    expect(fileHostsFromEnv({})).toEqual([])
    expect(fileHostsFromEnv({ AETHER_FILE_HOSTS: Array.from({ length: 40 }, (_, i) => `h${i}.example.com`).join(',') })).toHaveLength(20)
  })
})

describe('downloading a ChatGPT file', () => {
  const URL_OK = 'https://files.oaiusercontent.com/file-abc123?sig=secret'

  it('downloads from a ChatGPT file host, without credentials, and reports the name ChatGPT gave', async () => {
    const f = fakeFetch(() => ok(png(5, 6), { 'content-type': 'image/png' }))
    const r = await fetchPictureFile({ download_url: URL_OK, file_id: 'file-abc123', file_name: 'gate.png', mime_type: 'image/png' }, { fetch: f.fetch })
    expect(r.name).toBe('gate.png')
    expect(r.bytes.length).toBe(33)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.url).toBe(URL_OK)
    // No cookies, no authorization, and redirects are followed here, not by fetch.
    expect(f.calls[0]!.init.redirect).toBe('manual')
    expect(Object.keys(f.calls[0]!.init.headers as Record<string, string>).map((k) => k.toLowerCase())).toEqual(['accept'])
  })

  it('takes the name from the address when ChatGPT gave none, and none when that is no picture’s', async () => {
    const f = fakeFetch(() => ok(png()))
    expect((await fetchPictureFile({ download_url: 'https://files.oaiusercontent.com/a/ring%20study.webp?x=1', file_id: 'f' }, { fetch: f.fetch })).name).toBe('ring study.webp')
    expect((await fetchPictureFile({ download_url: 'https://files.oaiusercontent.com/file-abc', file_id: 'f' }, { fetch: f.fetch })).name).toBe('')
  })

  it('refuses http, a port, a user name, an address and any other host — before a single request is made', async () => {
    const f = fakeFetch(() => ok(png()))
    const refused = async (url: string, why: RegExp) => {
      await expect(fetchPictureFile({ download_url: url, file_id: 'f' }, { fetch: f.fetch }), url).rejects.toThrow(why)
    }
    await refused('http://files.oaiusercontent.com/a.png', /Only https/)
    await refused('https://files.oaiusercontent.com:8443/a.png', /standard https port/)
    await refused('https://user:pw@files.oaiusercontent.com/a.png', /user name or password/)
    await refused('https://127.0.0.1/a.png', /does not download from/)
    await refused('https://[::1]/a.png', /does not download from/)
    await refused('https://evil.example.com/?notes=all-your-notes', /evil\.example\.com.*does not download from/)
    await refused('https://oaiusercontent.com.evil.com/a.png', /does not download from/)
    await refused('not a url', /not a web address/)
    await refused('file:///C:/Users/me/a.png', /Only https/)
    expect(f.calls).toEqual([])
  })

  it('names the host it refused and how a person can allow another one, and never prints the whole address', async () => {
    const f = fakeFetch(() => ok(png()))
    await expect(fetchPictureFile({ download_url: 'https://cdn.example.org/a.png?sig=SECRET', file_id: 'f' }, { fetch: f.fetch })).rejects.toThrow(/cdn\.example\.org[\s\S]*AETHER_FILE_HOSTS/)
    await expect(fetchPictureFile({ download_url: 'https://cdn.example.org/a.png?sig=SECRET', file_id: 'f' }, { fetch: f.fetch })).rejects.not.toThrow(/SECRET/)
    // Allowed by the person running the link: it works.
    const r = await fetchPictureFile({ download_url: 'https://cdn.example.org/a.png', file_id: 'f' }, { fetch: f.fetch, hosts: ['example.org'] })
    expect(r.bytes.length).toBe(33)
  })

  it('follows a redirect to an allowed host, and refuses one to any other host', async () => {
    const f = fakeFetch((url) =>
      url.includes('/start')
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.oaiusercontent.com/real.png' } })
        : url.includes('/leak')
          ? new Response(null, { status: 302, headers: { location: 'https://evil.example.com/?x=1' } })
          : ok(png()),
    )
    const r = await fetchPictureFile({ download_url: 'https://files.oaiusercontent.com/start', file_id: 'f' }, { fetch: f.fetch })
    expect(r.name).toBe('real.png')
    expect(f.calls.map((c) => c.url)).toEqual(['https://files.oaiusercontent.com/start', 'https://cdn.oaiusercontent.com/real.png'])
    await expect(fetchPictureFile({ download_url: 'https://files.oaiusercontent.com/leak', file_id: 'f' }, { fetch: f.fetch })).rejects.toThrow(/evil\.example\.com.*does not download from/)
    await expect(
      fetchPictureFile({ download_url: 'https://files.oaiusercontent.com/start', file_id: 'f' }, { fetch: fakeFetch(() => new Response(null, { status: 302, headers: { location: 'http://files.oaiusercontent.com/x' } })).fetch }),
    ).rejects.toThrow(/Only https/)
  })

  it('stops after a few redirects', async () => {
    const f = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://files.oaiusercontent.com/again' } }))
    await expect(fetchPictureFile({ download_url: 'https://files.oaiusercontent.com/a', file_id: 'f' }, { fetch: f.fetch })).rejects.toThrow(/too many times/)
    expect(f.calls.length).toBe(4)
  })

  it('says when the link has expired or the host answers with an error', async () => {
    const f = fakeFetch(() => new Response('gone', { status: 403 }))
    await expect(fetchPictureFile({ download_url: URL_OK, file_id: 'f' }, { fetch: f.fetch })).rejects.toThrow(/answered 403.*expires/)
  })

  it('refuses a picture over the cap by its announced size and by what actually arrives', async () => {
    const announced = fakeFetch(() => ok(png(), { 'content-length': String(500 * 1024 * 1024) }))
    await expect(fetchPictureFile({ download_url: URL_OK, file_id: 'f' }, { fetch: announced.fetch })).rejects.toThrow(/too big: 500\.0 MB/)
    // No size announced: the body is cut off when it passes the cap.
    const silent = fakeFetch(() => ok(new Uint8Array(5_000)))
    await expect(fetchPictureFile({ download_url: URL_OK, file_id: 'f' }, { fetch: silent.fetch, maxBytes: 1_000 })).rejects.toThrow(/too big/)
  })

  it('gives up when the download takes too long', async () => {
    const hang = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    await expect(fetchPictureFile({ download_url: URL_OK, file_id: 'f' }, { fetch: hang.fetch, timeoutMs: 30 })).rejects.toThrow(/took too long/)
    expect(DOWNLOAD_TIMEOUT_MS).toBe(60_000)
  })

  it('reports a failed connection without the address', async () => {
    const down = fakeFetch(() => {
      throw new TypeError('fetch failed')
    })
    await expect(fetchPictureFile({ download_url: URL_OK, file_id: 'f' }, { fetch: down.fetch })).rejects.toThrow(/download failed: fetch failed/)
  })
})

/* ----------------------------------------------------------------------- */
/* Brain.savePicture                                                        */
/* ----------------------------------------------------------------------- */

describe('Brain.savePicture', () => {
  it('writes the picture to Inbox/Pictures under the name it came with and says what it is', async () => {
    const b = await open()
    const r = await b.savePicture({ bytes: png(640, 480, 50), name: 'gate-concept.png' })
    expect(r.picture).toEqual({ path: 'Inbox/Pictures/gate-concept.png', name: 'gate-concept.png', bytes: 83, kind: 'png', width: 640, height: 480 })
    expect(r.embed).toBe('![[Inbox/Pictures/gate-concept.png]]')
    expect(r.note).toBeNull()
    expect([...(await diskBytes('Inbox/Pictures/gate-concept.png'))]).toEqual([...png(640, 480, 50)])
    // The folder it made is known to the brain right away.
    expect((await b.listFolder('Inbox', 1)).folder.folders).toBeGreaterThanOrEqual(1)
  })

  it('gives the extension the bytes really have, whatever the name says', async () => {
    const b = await open()
    expect((await b.savePicture({ bytes: JPEG, name: 'looks-like-a.png' })).picture.path).toBe('Inbox/Pictures/looks-like-a.jpg')
    expect((await b.savePicture({ bytes: Uint8Array.from(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1')), name: 'spin' })).picture.path).toBe('Inbox/Pictures/spin.gif')
  })

  it('takes the next name instead of replacing a picture, in any letter case', async () => {
    await put('Inbox/Pictures/gate.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))
    const before = await diskBytes('Inbox/Pictures/gate.png')
    const b = await open()
    const first = await b.savePicture({ bytes: png(1, 1), name: 'gate.png' })
    const second = await b.savePicture({ bytes: png(2, 2), name: 'GATE.PNG' })
    expect(first.picture.path).toBe('Inbox/Pictures/gate 2.png')
    expect(second.picture.path).toBe('Inbox/Pictures/GATE 3.png')
    expect([...(await diskBytes('Inbox/Pictures/gate.png'))]).toEqual([...before])
  })

  it('names a Windows device name another way and a nameless picture after the day', async () => {
    const b = await open()
    expect((await b.savePicture({ bytes: png(), name: 'CON.png' })).picture.name).toBe('CON 2.png')
    expect((await b.savePicture({ bytes: png() })).picture.name).toMatch(/^Picture \d{4}-\d{2}-\d{2}\.png$/)
  })

  it('refuses what is not a picture, an empty file and a picture over 40 MB, and leaves nothing behind', async () => {
    const b = await open()
    await expect(b.savePicture({ bytes: new TextEncoder().encode('just some text, not a picture at all'), name: 'x.png' })).rejects.toThrow(/Not a picture/)
    await expect(b.savePicture({ bytes: new Uint8Array(0), name: 'x.png' })).rejects.toThrow(/empty/)
    await expect(b.savePicture({ bytes: png(2, 2, 41 * 1024 * 1024), name: 'huge.png' })).rejects.toThrow(/too big/)
    expect(exists('Inbox/Pictures')).toBe(false)
  })

  it('keeps it in the folder asked for (with its note beside it), never outside the vault or in a skipped folder', async () => {
    const b = await open()
    const r = await b.savePicture({ bytes: png(), name: 'glyph.png', folder: 'Projects/PORTALz/Art', title: 'Glyph study' })
    expect(r.picture.path).toBe('Projects/PORTALz/Art/glyph.png')
    expect(r.note?.path).toBe('Projects/PORTALz/Art/Glyph study.md')
    await expect(b.savePicture({ bytes: png(), folder: '../elsewhere' })).rejects.toThrow(/cannot go up/)
    await expect(b.savePicture({ bytes: png(), folder: path.join(tmp, 'elsewhere') })).rejects.toThrow(/outside the vault/)
    await expect(b.savePicture({ bytes: png(), folder: '.hidden' })).rejects.toThrow(/skips/)
    await expect(b.savePicture({ bytes: png(), folder: 'node_modules/pkg' })).rejects.toThrow(/skips/)
    expect(exists('elsewhere', tmp)).toBe(false)
    expect(exists('.hidden/Picture.png')).toBe(false)
  })

  it('makes an Inbox note that shows the picture, with the idea under it', async () => {
    const b = await open()
    const r = await b.savePicture({ bytes: png(), name: 'gate_hum.png', title: 'A gate that hums', text: 'It hums lower the closer you get.\n\n- [ ] try it', tags: ['Portal Game', 'concept'] })
    expect(r.note).toMatchObject({ path: 'Inbox/A gate that hums.md', title: 'A gate that hums' })
    const note = await diskText('Inbox/A gate that hums.md')
    expect(note).toMatch(/^---\n[\s\S]*?type: inbox[\s\S]*?\n---\n/)
    expect(note).toContain('# A gate that hums\n\n![[Inbox/Pictures/gate_hum.png]]\n\nIt hums lower the closer you get.')
    // Tags are cleaned as capture cleans them (lowercased, a "#" taken off).
    expect(note).toMatch(/tags: \[portal game, concept\]/)
    // The embed names the picture by its whole vault path, which resolves to exactly that picture.
    expect(new AssetResolver(['Inbox/Pictures/gate_hum.png', 'Elsewhere/gate_hum.png']).resolve('Inbox/Pictures/gate_hum.png', 'Inbox')).toBe('Inbox/Pictures/gate_hum.png')
    // And the idea's note is in the brain like any other.
    expect((await b.readNote('A gate that hums')).path).toBe('Inbox/A gate that hums.md')
  })

  it('titles the note after the picture when only text is given, and never makes a note for a picture alone', async () => {
    const b = await open()
    const r = await b.savePicture({ bytes: png(), name: 'ring-study.png', text: 'Value study of the ring.' })
    expect(r.note?.title).toBe('ring study')
    expect(await diskText('Inbox/ring study.md')).toContain('![[Inbox/Pictures/ring-study.png]]\n\nValue study of the ring.')
    const alone = await b.savePicture({ bytes: png(), name: 'plain.png' })
    expect(alone.note).toBeNull()
    expect(exists('Inbox/plain.md')).toBe(false)
  })

  it('does not replace a note that is already there: the next name is taken', async () => {
    const b = await open()
    await b.savePicture({ bytes: png(), name: 'a.png', title: 'Loose thought' })
    expect(await diskText('Inbox/Loose thought.md')).toBe('# Loose thought\n\nsomething\n')
    expect(exists('Inbox/Loose thought 2.md')).toBe(true)
  })

  it('refuses in a read-only vault and creates nothing', async () => {
    const b = await open({ readOnly: true })
    await expect(b.savePicture({ bytes: png(), name: 'x.png' })).rejects.toThrow(/read-only/)
    expect(exists('Inbox/Pictures')).toBe(false)
  })

  it('goes under the first drive of a vault with several roots', async () => {
    const other = path.join(tmp, 'other')
    await put('Inbox/Note.md', '# Note\n', other)
    const b = await open({ roots: [root, other] })
    const r = await b.savePicture({ bytes: png(), name: 'gate.png', title: 'Gate' })
    expect(r.picture.path).toBe('vault/Inbox/Pictures/gate.png')
    expect(r.note?.path).toBe('vault/Inbox/Gate.md')
    expect(exists('Inbox/Pictures/gate.png', root)).toBe(true)
    expect(exists('Inbox/Pictures', other)).toBe(false)
  })

  it('serializes saves, so two at once get two names', async () => {
    const b = await open()
    const [x, y] = await Promise.all([b.savePicture({ bytes: png(1, 1), name: 'same.png' }), b.savePicture({ bytes: png(2, 2), name: 'same.png' })])
    expect([x.picture.name, y.picture.name].sort()).toEqual(['same 2.png', 'same.png'])
  })
})

/* ----------------------------------------------------------------------- */
/* The tool                                                                 */
/* ----------------------------------------------------------------------- */

describe('save_image', () => {
  it('is a write tool that says it reaches out, and tells ChatGPT that file is a file', async () => {
    const client = await connect(await open())
    const tool = (await client.listTools()).tools.find((t) => t.name === 'save_image')!
    expect(tool.title).toBe('Save a picture')
    expect(tool.description).toMatch(/^Use this when/)
    expect(TOOLS.save_image.write).toBe(true)
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true })
    // OpenAI's contract for a file parameter: listed in _meta, an object with download_url and file_id required.
    expect(tool._meta).toEqual({ 'openai/fileParams': ['file'] })
    const props = tool.inputSchema.properties as Record<string, any>
    expect(Object.keys(props.file.properties).sort()).toEqual(['download_url', 'file_id', 'file_name', 'mime_type'])
    expect(props.file.required.sort()).toEqual(['download_url', 'file_id'])
    expect(tool.inputSchema.required ?? []).toEqual([])
  })

  it('is not offered in a read-only link, and not to the in-app chat', async () => {
    const b = await open()
    const ro = await connect(b, { readOnly: true })
    expect((await ro.listTools()).tools.map((t) => t.name)).not.toContain('save_image')
    const chat = await BrainTools.open(b)
    cleanups.push(() => chat.close())
    expect(chat.defs.map((d) => d.name)).not.toContain('save_image')
    expect(chat.defs.map((d) => d.name)).toContain('capture')
  })

  it('wants exactly one source', async () => {
    const client = await connect(await open(), { localFiles: true })
    expect(errorOf(await call(client, 'save_image', {}))).toMatch(/exactly one of file/)
    expect(errorOf(await call(client, 'save_image', { data: b64(png()), path: path.join(tmp, 'a.png') }))).toMatch(/exactly one of file/)
    expect(errorOf(await call(client, 'save_image', { data: b64(png()), file: { download_url: 'https://files.oaiusercontent.com/a', file_id: 'f' } }))).toMatch(/exactly one of file/)
    expect(exists('Inbox/Pictures')).toBe(false)
  })

  it('saves a picture sent as data, and makes the note when given a title', async () => {
    const client = await connect(await open())
    const r = await call(client, 'save_image', { data: `data:image/png;base64,${b64(png(32, 16))}`, name: 'icon.png', title: 'Tiny icon', text: 'For the toolbar.' })
    const out = json(r)
    expect(out.picture).toMatchObject({ path: 'Inbox/Pictures/icon.png', kind: 'png', width: 32, height: 16 })
    expect(out.note.path).toBe('Inbox/Tiny icon.md')
    expect(r.content[0]!.text).toMatch(/^Saved the picture to Inbox\/Pictures\/icon\.png and the note Inbox\/Tiny icon\.md, which shows it\. To show it in another note, write !\[\[Inbox\/Pictures\/icon\.png\]\]\./)
    expect(activity.at(-1)).toMatchObject({ tool: 'save_image', write: true, path: 'Inbox/Pictures/icon.png', summary: 'saved the picture "icon.png"' })
    expect(await diskText('Inbox/Tiny icon.md')).toContain('![[Inbox/Pictures/icon.png]]')
  })

  it('refuses bad data and a picture that is not one, with the reason', async () => {
    const client = await connect(await open())
    expect(errorOf(await call(client, 'save_image', { data: 'not base64 at all!!' }))).toMatch(/not base64/)
    expect(errorOf(await call(client, 'save_image', { data: b64(new TextEncoder().encode('plain text, long enough to look like a file')) }))).toMatch(/Not a picture/)
    expect(errorOf(await call(client, 'save_image', { data: 'A'.repeat(MAX_PICTURE_DATA_CHARS + 5_000) }))).toBeTruthy()
    expect(exists('Inbox/Pictures')).toBe(false)
  })

  it('reads a file on this computer only when the client runs here (stdio), and tells the others why not', async () => {
    await put('downloads/gate.png', png(9, 9), tmp)
    const file = path.join(tmp, 'downloads', 'gate.png')
    const remote = await connect(await open())
    expect(errorOf(await call(remote, 'save_image', { path: file }))).toMatch(/Claude Desktop or Claude Code runs this server/)
    expect(exists('Inbox/Pictures')).toBe(false)
    const local = await connect(await open(), { localFiles: true })
    const r = await call(local, 'save_image', { path: file, title: 'From my downloads' })
    expect(json(r).picture).toMatchObject({ path: 'Inbox/Pictures/gate.png', width: 9, height: 9 })
    // Even here a network path and a file that is no picture are refused.
    expect(errorOf(await call(local, 'save_image', { path: '\\\\server\\share\\a.png' }))).toMatch(/network or device path/)
    await put('downloads/notes.png', 'this is text in a picture file name', tmp)
    expect(errorOf(await call(local, 'save_image', { path: path.join(tmp, 'downloads', 'notes.png') }))).toMatch(/Not a picture/)
  })

  it('downloads a ChatGPT file from ChatGPT’s hosts and saves it under the name ChatGPT gave', async () => {
    const f = fakeFetch(() => ok(png(7, 7)))
    const client = await connect(await open(), { fetch: f.fetch })
    const r = await call(client, 'save_image', { file: { download_url: 'https://files.oaiusercontent.com/file-1?sig=a', file_id: 'file-1', file_name: 'dragon.png', mime_type: 'image/png' }, text: 'Dragon idea' })
    expect(json(r).picture).toMatchObject({ path: 'Inbox/Pictures/dragon.png', width: 7 })
    expect(f.calls).toHaveLength(1)
    // Any other host is refused without a request, and the answer names it.
    const bad = errorOf(await call(client, 'save_image', { file: { download_url: 'https://evil.example.com/steal?n=1', file_id: 'f' } }))
    expect(bad).toMatch(/evil\.example\.com/)
    expect(f.calls).toHaveLength(1)
  })

  it('lets the person running the link allow another host (fileHosts)', async () => {
    const f = fakeFetch(() => ok(png()))
    const client = await connect(await open(), { fetch: f.fetch, fileHosts: ['cdn.example.org'] })
    expect(json(await call(client, 'save_image', { file: { download_url: 'https://img.cdn.example.org/a.png', file_id: 'f' } })).picture.name).toBe('a.png')
  })

  it('never replaces a picture: saved twice it is two files', async () => {
    const client = await connect(await open())
    await call(client, 'save_image', { data: b64(png(1, 1)), name: 'same.png' })
    const second = json(await call(client, 'save_image', { data: b64(png(2, 2)), name: 'same.png' }))
    expect(second.picture.name).toBe('same 2.png')
    expect(await diskBytes('Inbox/Pictures/same.png')).toHaveLength(33)
  })

  it('is told to the AI first thing, in the instructions', async () => {
    const client = await connect(await open())
    const text = client.getInstructions() ?? ''
    expect(text).toMatch(/save_image: file for a ChatGPT attachment, path for a picture file on their computer \(Claude Desktop and Claude Code\), data \(base64\) only for small pictures/)
    expect(text.slice(0, 512)).not.toContain('save_image')
  })
})

describe('the guide to the AI link', () => {
  const guide = lf(readFileSync(path.resolve(here, '../../../docs/AI-LINK.md'), 'utf8'))

  it('says how each AI sends a picture, where it lands and which hosts a ChatGPT file may come from', () => {
    expect(guide).toContain('## Sending pictures and ideas')
    expect(guide).toContain('[Sending pictures and ideas](#sending-pictures-and-ideas)')
    expect(guide).toContain(`**${PICTURES_FOLDER}**`)
    for (const host of OPENAI_FILE_HOSTS) expect(guide, host).toContain(`\`${host}\``)
    expect(guide).toContain('`AETHER_FILE_HOSTS`')
    for (const source of ['`path`', '`file`', '`data`']) expect(guide, source).toContain(source)
    expect(guide).toContain('Claude Code')
    expect(guide).toMatch(/\| `save_image` \| Save a picture/)
  })

  it('no longer says an AI cannot create pictures, and keeps saying it cannot create programs or replace one', () => {
    expect(guide).not.toContain("It can't create images")
    expect(guide).toContain('**create anything except `.md` notes, folders and pictures.** It can\'t create scripts or programs.')
    expect(guide).toContain('it never replaces a picture that is there')
  })

  it('says in both places a person reads about it that one picture file may come from outside the folders chosen', () => {
    expect(guide).toContain('**reach outside the folders you chose,** with one exception: when you ask Claude Desktop, Claude Code or the Claude plugin to save a picture')
    const manifest = readFileSync(path.resolve(here, '../scripts/pack-mcpb.mjs'), 'utf8')
    expect(manifest).toContain('with one exception: when you ask Claude to save a picture, it may copy a picture file you name from anywhere on this computer into your Inbox')
    expect(manifest).toContain('only .md notes, folders and pictures are ever created')
    expect(manifest).not.toContain('only .md notes and folders are ever created')
  })

  it('tells the person who runs the link that path is for Claude on this computer only, and why file is host-limited', () => {
    expect(guide).toContain('`path` works only for Claude Desktop, Claude Code and the Claude plugin')
    expect(guide).toContain('the link a tunnel reaches (ChatGPT, claude.ai) refuses it')
    expect(guide).toContain("`file` downloads only from ChatGPT's file hosts")
  })
})

/* ----------------------------------------------------------------------- */
/* The HTTP link and the bundle                                             */
/* ----------------------------------------------------------------------- */

describe('save_image over the HTTP link (ChatGPT, claude.ai)', () => {
  it('saves a picture sent as data, and refuses a local path from a caller that is not here', async () => {
    const b = await open()
    await put('downloads/gate.png', png(), tmp)
    const link = await startHttpLink({ brain: b, port: 0, token: TOKEN, readOnly: false, onActivity: (a) => activity.push(a) })
    cleanups.push(() => link.close())
    const client = new Client({ name: 'http-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(link.url), { requestInit: { headers: { 'User-Agent': 'openai-mcp/1.0.0' } } }))
    cleanups.push(() => client.close())
    const tool = (await client.listTools()).tools.find((t) => t.name === 'save_image')!
    expect(tool._meta).toEqual({ 'openai/fileParams': ['file'] })
    const r = (await client.callTool({ name: 'save_image', arguments: { data: b64(png(4, 4, 600_000)), name: 'big-ish.png' } })) as Result
    expect(json(r).picture).toMatchObject({ path: 'Inbox/Pictures/big-ish.png', bytes: 600_033 })
    expect(activity.at(-1)).toMatchObject({ client: 'ChatGPT', tool: 'save_image', write: true })
    const local = (await client.callTool({ name: 'save_image', arguments: { path: path.join(tmp, 'downloads', 'gate.png') } })) as Result
    expect(errorOf(local)).toMatch(/Claude Desktop or Claude Code runs this server/)
  })

  it('carries a picture of many megabytes in one request (the plugin’s bridge sends a screenshot it read from disk)', async () => {
    const b = await open()
    const link = await startHttpLink({ brain: b, port: 0, token: TOKEN, readOnly: false })
    cleanups.push(() => link.close())
    const client = new Client({ name: 'http-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(link.url)))
    cleanups.push(() => client.close())
    // 12 MB: sixteen times the old cap of one request (1 MiB), a request of 16 MB of text.
    const raw = 12 * 1024 * 1024
    const r = (await client.callTool({ name: 'save_image', arguments: { data: b64(png(3, 3, raw - 33)), name: 'screenshot.png' } })) as Result
    expect(json(r).picture).toMatchObject({ path: 'Inbox/Pictures/screenshot.png', bytes: raw })
    expect((await fs.stat(path.join(root, 'Inbox', 'Pictures', 'screenshot.png'))).size).toBe(raw)
  })

  it('still refuses a body past its cap, and answers a wrong token before reading any of it', async () => {
    const b = await open()
    const link = await startHttpLink({ brain: b, port: 0, token: TOKEN, readOnly: false })
    cleanups.push(() => link.close())
    const base = link.url.replace(/\/mcp\/.*/, '')
    const big = 'x'.repeat(MAX_BODY_BYTES + 1_000)
    const post = (url: string, body: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body })
    const tooBig = await post(link.url, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: big } }))
    expect(tooBig.status).toBeGreaterThanOrEqual(400)
    const stranger = await post(`${base}/mcp/not-the-token-0123456789`, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    expect(stranger.status).toBe(401)
  })
})

describe.skipIf(!existsSync(BUNDLE))('save_image in the built server (dist/mcp/aether-mcp.mjs, stdio)', () => {
  it('is in the built bundle and reads a file on this computer for a client that runs here', async () => {
    // Read as the bundle's own source of truth: a stale bundle (built before the tool) would not have it.
    expect(lf(readFileSync(BUNDLE, 'utf8'))).toContain('save_image')
    await put('downloads/gate.png', png(11, 13), tmp)
    const transport = new StdioClientTransport({ command: process.execPath, args: [BUNDLE, '--read-only=false', root], stderr: 'pipe' })
    const client = new Client({ name: 'bundle-test', version: '1.0.0' })
    await client.connect(transport)
    cleanups.push(() => client.close())
    const tool = (await client.listTools()).tools.find((t) => t.name === 'save_image')!
    expect(tool._meta).toEqual({ 'openai/fileParams': ['file'] })
    const r = (await client.callTool({ name: 'save_image', arguments: { path: path.join(tmp, 'downloads', 'gate.png'), title: 'From Claude Code', text: 'A screenshot I made.' } })) as Result
    expect(json(r).picture).toMatchObject({ path: 'Inbox/Pictures/gate.png', width: 11, height: 13 })
    expect([...(await diskBytes('Inbox/Pictures/gate.png'))]).toEqual([...png(11, 13)])
    expect(await diskText('Inbox/From Claude Code.md')).toContain('![[Inbox/Pictures/gate.png]]\n\nA screenshot I made.')
    // The same bundle, asked for a network path, refuses.
    expect(errorOf((await client.callTool({ name: 'save_image', arguments: { path: '\\\\server\\share\\x.png' } })) as Result)).toMatch(/network or device path/)
  })
})
