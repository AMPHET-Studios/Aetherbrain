import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { BrainTools } from '../src/mcp/chat.js'
import {
  Brain,
  HOST_TOOLS,
  INSTRUCTIONS,
  PICTURES_INSTRUCTIONS,
  SHOW_INSTRUCTIONS,
  TOOLS,
  createMcpServer,
  startHttpLink,
  type ActivityEvent,
  type FoundPicture,
  type LookedAt,
  type McpServerOptions,
  type PictureHost,
  type ShowTarget,
} from '../src/mcp/server.js'

/**
 * The tools only the running app can offer: find_pictures and get_image (the app's thumbnail helper makes the still), and
 * show_in_brain (the app's window flies there). A server without those hosts does not list them; with them an AI can look at
 * the user's pictures and point at things in the 3D view. The hosts here are stand-ins; the real ones are tested in
 * ai-pictures.test.ts and ai-fly.test.ts.
 */

const TOKEN = 'test-token-0123456789abcdef'

const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
/** The first bytes of a PNG with its pixel size: all the brain looks at. */
function png(width = 2, height = 3): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0])
}
/** What the stand-in thumbnail helper "draws": recognisable bytes, not a real picture. */
const STILL = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 250, 251, 252])

let tmp: string
let root: string
let brain: Brain | null = null
let activity: ActivityEvent[] = []
const cleanups: (() => Promise<void>)[] = []

async function put(rel: string, content: string | Uint8Array): Promise<void> {
  const full = path.join(root, ...rel.split('/'))
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-host-'))
  root = path.join(tmp, 'vault')
  await put('Inbox/Loose thought.md', '# Loose thought\n\nsomething\n')
  await put('Projects/PORTALz.md', '---\ntype: project\n---\n# PORTALz\n\n## To do\n\n- [ ] Sculpt the gate\n')
  await put('Projects/PORTALz/Art/Gate concept.md', '# Gate concept\n\nThe first pass.\n\n![[Projects/PORTALz/Art/gate.png]]\n')
  await put('Projects/PORTALz/Art/gate.png', png(640, 480))
  await put('Projects/PORTALz/Refs/clip.mp4', 'not a real video')
  await put('Resources/Notes on rust.md', '# Notes on rust\n\nSee [[Projects/PORTALz/Art/gate.png]] for the look.\n')
  activity = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cleanups.splice(0)) await c()
  brain?.close()
  brain = null
  await fs.rm(tmp, { recursive: true, force: true })
})

async function open(opts: { readOnly?: boolean } = {}): Promise<Brain> {
  brain = await Brain.open({ roots: [root], watch: false, ...(opts.readOnly ? { readOnly: true } : {}) })
  return brain
}

interface Result {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
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
const textOf = (r: Result): string => {
  const first = r.content[0]
  return first?.type === 'text' ? first.text : ''
}
/** The JSON after the human line of a tool result. */
function json(r: Result): any {
  if (r.isError) throw new Error(`tool failed: ${textOf(r)}`)
  return JSON.parse(textOf(r).slice(textOf(r).indexOf('\n') + 1))
}
const errorOf = (r: Result): string => {
  expect(r.isError).toBe(true)
  return textOf(r)
}

/** A stand-in for the app's pictures that remembers every question it was asked. */
function fakePictures(over: Partial<PictureHost> = {}, known: Record<string, Partial<LookedAt>> = {}) {
  const finds: { query: string; folder?: string; limit: number }[] = []
  const looks: { path: string; px: number }[] = []
  const all: FoundPicture[] = [
    { path: 'Projects/PORTALz/Art/gate.png', kind: 'picture', bytes: 4096, modified: 1700000000000 },
    { path: 'Projects/PORTALz/Refs/clip.mp4', kind: 'video', bytes: 16, modified: 1700000001000 },
    { path: 'Resources/rust/gate.png', kind: 'picture', bytes: 2048, modified: 1700000002000 },
  ]
  const host: PictureHost = {
    async find(query, o) {
      finds.push({ query, ...(o.folder !== undefined ? { folder: o.folder } : {}), limit: o.limit })
      const words = query.toLowerCase().split(/\s+/).filter(Boolean)
      const hits = all.filter((p) => (!o.folder || p.path.startsWith(`${o.folder}/`)) && words.every((w) => p.path.toLowerCase().includes(w)))
      return { pictures: hits.slice(0, o.limit), more: hits.length > o.limit }
    },
    async look(p, px) {
      looks.push({ path: p, px })
      const hit = all.find((x) => x.path === p)
      if (!hit) return null
      return { png: STILL, path: hit.path, kind: hit.kind, bytes: hit.bytes ?? 0, width: hit.kind === 'picture' ? 640 : null, height: hit.kind === 'picture' ? 480 : null, ...known[p] }
    },
    ...over,
  }
  return { host, finds, looks }
}

const toolNames = async (client: Client): Promise<string[]> => (await client.listTools()).tools.map((t) => t.name).sort()

describe('which tools exist', () => {
  it('names the tools only the app can offer, and lists none of them without the app', async () => {
    expect([...HOST_TOOLS].sort()).toEqual(['find_pictures', 'get_image', 'show_in_brain'])
    const client = await connect(await open())
    const names = await toolNames(client)
    for (const n of HOST_TOOLS) expect(names, n).not.toContain(n)
    expect(names.filter((n) => !(HOST_TOOLS as readonly string[]).includes(n))).toEqual(Object.keys(TOOLS).filter((n) => !(HOST_TOOLS as readonly string[]).includes(n)).sort())
    expect(client.getInstructions()).toBe(INSTRUCTIONS)
  })

  it('lists the picture tools with the app’s pictures, show_in_brain with its window, and says so in the instructions', async () => {
    const b = await open()
    const withPictures = await connect(b, { pictures: fakePictures().host })
    expect((await toolNames(withPictures)).filter((n) => (HOST_TOOLS as readonly string[]).includes(n))).toEqual(['find_pictures', 'get_image'])
    expect(withPictures.getInstructions()).toBe(`${INSTRUCTIONS}\n${PICTURES_INSTRUCTIONS}`)

    const withWindow = await connect(b, { show: () => undefined })
    expect((await toolNames(withWindow)).filter((n) => (HOST_TOOLS as readonly string[]).includes(n))).toEqual(['show_in_brain'])
    expect(withWindow.getInstructions()).toBe(`${INSTRUCTIONS}\n${SHOW_INSTRUCTIONS}`)

    const both = await connect(b, { pictures: fakePictures().host, show: () => undefined })
    expect((await toolNames(both)).filter((n) => (HOST_TOOLS as readonly string[]).includes(n))).toEqual(['find_pictures', 'get_image', 'show_in_brain'])
    expect(both.getInstructions()).toBe(`${INSTRUCTIONS}\n${PICTURES_INSTRUCTIONS}\n${SHOW_INSTRUCTIONS}`)
  })

  it('describes them the way the others are: titled, "Use this when…", read-only hints, nothing leaves this computer', async () => {
    const client = await connect(await open(), { pictures: fakePictures().host, show: () => undefined })
    const tools = (await client.listTools()).tools.filter((t) => (HOST_TOOLS as readonly string[]).includes(t.name))
    expect(tools).toHaveLength(3)
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy()
      expect(t.description, t.name).toMatch(/^Use this when/)
      expect(t.annotations?.readOnlyHint, t.name).toBe(true)
      expect(t.annotations?.destructiveHint, t.name).toBe(false)
      expect(t.annotations?.openWorldHint, t.name).toBe(false)
      expect(TOOLS[t.name as keyof typeof TOOLS].write, t.name).toBe(false)
    }
  })

  it('keeps them on a read-only link: looking and pointing change nothing in the vault', async () => {
    const client = await connect(await open({ readOnly: true }), { readOnly: true, pictures: fakePictures().host, show: () => undefined })
    const names = await toolNames(client)
    for (const n of HOST_TOOLS) expect(names, n).toContain(n)
    expect(names).not.toContain('create_note')
    expect(names).not.toContain('save_image')
    expect(client.getInstructions()).toContain('This link is read-only')
    expect(client.getInstructions()).toContain('find_pictures')
  })

  it('leaves them out of the in-app chat, which has neither the helper’s pictures nor a way to hand an image to its model', async () => {
    const tools = await BrainTools.open(await open())
    cleanups.push(() => tools.close())
    for (const n of HOST_TOOLS) expect(tools.defs.map((d) => d.name), n).not.toContain(n)
  })
})

describe('find_pictures', () => {
  it('asks the app for the words, inside a folder, and lists what it answers', async () => {
    const fake = fakePictures()
    const client = await connect(await open(), { pictures: fake.host })
    const r = await call(client, 'find_pictures', { query: '  gate  ', folder: 'Art' })
    // The folder is the vault's own spelling of it, found by name.
    expect(fake.finds).toEqual([{ query: 'gate', folder: 'Projects/PORTALz/Art', limit: 20 }])
    expect(textOf(r).split('\n')[0]).toBe('1 picture.')
    expect(json(r)).toEqual({ pictures: [{ path: 'Projects/PORTALz/Art/gate.png', kind: 'picture', bytes: 4096, modified: 1700000000000 }], more: false })
    expect(activity.at(-1)).toMatchObject({ tool: 'find_pictures', summary: 'looked for pictures "gate"', path: 'Projects/PORTALz/Art', write: false })
  })

  it('lists a whole vault when given no words and no folder, and says when there are more than the limit', async () => {
    const fake = fakePictures()
    const client = await connect(await open(), { pictures: fake.host })
    const r = await call(client, 'find_pictures', { limit: 2 })
    expect(fake.finds).toEqual([{ query: '', limit: 2 }])
    expect(textOf(r).split('\n')[0]).toBe('2 pictures (more exist: narrow the words or the folder).')
    expect(json(r).more).toBe(true)
    expect(json(r).pictures).toHaveLength(2)
    expect(activity.at(-1)).toMatchObject({ summary: 'looked for pictures', path: null })
  })

  it('says plainly when nothing matches', async () => {
    const client = await connect(await open(), { pictures: fakePictures().host })
    const r = await call(client, 'find_pictures', { query: 'dragon' })
    expect(textOf(r).split('\n')[0]).toBe('No pictures match.')
    expect(json(r)).toEqual({ pictures: [], more: false })
  })

  it('refuses a folder that is not there without asking the app, and a limit that is not sensible', async () => {
    const fake = fakePictures()
    const client = await connect(await open(), { pictures: fake.host })
    expect(errorOf(await call(client, 'find_pictures', { folder: 'Nowhere' }))).toMatch(/No folder "Nowhere"/)
    expect(errorOf(await call(client, 'find_pictures', { limit: 101 }))).toMatch(/limit/i)
    expect(errorOf(await call(client, 'find_pictures', { limit: 0 }))).toMatch(/limit/i)
    expect(fake.finds).toEqual([])
  })
})

describe('get_image', () => {
  it('returns the picture itself after a line saying what it is, at the size asked for', async () => {
    const fake = fakePictures()
    const client = await connect(await open(), { pictures: fake.host })
    const r = await call(client, 'get_image', { picture: 'Projects/PORTALz/Art/gate.png' })
    expect(fake.looks).toEqual([{ path: 'Projects/PORTALz/Art/gate.png', px: 768 }])
    // The text comes first, so a client that cannot pass images on still has the answer.
    expect(r.content.map((c) => c.type)).toEqual(['text', 'image'])
    expect(textOf(r).split('\n')[0]).toBe(
      'Projects/PORTALz/Art/gate.png: a picture, 640×480, 4 KB, shown scaled to at most 768 px. Notes that show it: "Gate concept", "Notes on rust".',
    )
    const image = r.content[1]
    expect(image).toEqual({ type: 'image', data: Buffer.from(STILL).toString('base64'), mimeType: 'image/png' })
    expect(json(r)).toMatchObject({ path: 'Projects/PORTALz/Art/gate.png', kind: 'picture', bytes: 4096, width: 640, height: 480, scaledTo: 768 })
    expect(json(r).notes.map((n: { title: string }) => n.title).sort()).toEqual(['Gate concept', 'Notes on rust'])
    expect(activity.at(-1)).toMatchObject({ tool: 'get_image', summary: 'looked at "gate.png"', path: 'Projects/PORTALz/Art/gate.png', write: false })
  })

  it('passes the size asked for on, and refuses one outside 64 to 1024', async () => {
    const fake = fakePictures()
    const client = await connect(await open(), { pictures: fake.host })
    await call(client, 'get_image', { picture: 'Projects/PORTALz/Art/gate.png', max_px: 300 })
    await call(client, 'get_image', { picture: 'Projects/PORTALz/Art/gate.png', max_px: 1024 })
    expect(fake.looks.map((l) => l.px)).toEqual([300, 1024])
    expect(errorOf(await call(client, 'get_image', { picture: 'Projects/PORTALz/Art/gate.png', max_px: 63 }))).toMatch(/max_px/)
    expect(errorOf(await call(client, 'get_image', { picture: 'Projects/PORTALz/Art/gate.png', max_px: 1025 }))).toMatch(/max_px/)
    expect(fake.looks).toHaveLength(2)
  })

  it('finds a picture by its file name when only one has it, and says which when several do', async () => {
    const fake = fakePictures()
    const client = await connect(await open(), { pictures: fake.host })
    const one = await call(client, 'get_image', { picture: 'clip.mp4' })
    expect(fake.looks.map((l) => l.path)).toEqual(['clip.mp4', 'Projects/PORTALz/Refs/clip.mp4'])
    expect(textOf(one).split('\n')[0]).toBe("Projects/PORTALz/Refs/clip.mp4: a video's still frame, size unknown, 16 B, shown scaled to at most 768 px.")
    expect(one.content.map((c) => c.type)).toEqual(['text', 'image'])

    fake.looks.length = 0
    const many = errorOf(await call(client, 'get_image', { picture: 'gate.png' }))
    expect(many).toBe('"gate.png" matches 2 pictures; pass the vault path of one: Projects/PORTALz/Art/gate.png, Resources/rust/gate.png')
    // The ambiguous name was looked up as a path (it is none), and then nothing was looked at.
    expect(fake.looks.map((l) => l.path)).toEqual(['gate.png'])
  })

  it('says so when no picture has that name, and when the app cannot draw the one that does', async () => {
    const client = await connect(await open(), { pictures: fakePictures().host })
    expect(errorOf(await call(client, 'get_image', { picture: 'dragon.png' }))).toBe('No picture matches "dragon.png". Use find_pictures to see the pictures.')
    const fake = fakePictures({ look: async () => null })
    const stuck = await connect(await open(), { pictures: fake.host })
    expect(errorOf(await call(stuck, 'get_image', { picture: 'Projects/PORTALz/Art/gate.png' }))).toMatch(/could not be shown \(too big, damaged, or not one the brain can draw\)/)
  })

  it('tells a model’s still from a picture', async () => {
    const fake = fakePictures({}, { 'Projects/PORTALz/Refs/clip.mp4': { kind: 'model', width: null, height: null } })
    const client = await connect(await open(), { pictures: fake.host })
    const r = await call(client, 'get_image', { picture: 'Projects/PORTALz/Refs/clip.mp4', max_px: 200 })
    expect(textOf(r).split('\n')[0]).toBe("Projects/PORTALz/Refs/clip.mp4: a 3D model's still, size unknown, 16 B, shown scaled to at most 200 px.")
  })
})

describe('show_in_brain', () => {
  function windowSpy() {
    const shown: ShowTarget[] = []
    return { shown, show: (t: ShowTarget) => void shown.push(t) }
  }

  it('flies to a note by its title, and opens it in the editor only when asked to', async () => {
    const w = windowSpy()
    const client = await connect(await open(), { show: w.show })
    const r = await call(client, 'show_in_brain', { target: 'Gate concept' })
    expect(w.shown).toEqual([{ kind: 'note', path: 'Projects/PORTALz/Art/Gate concept.md', open: false }])
    expect(textOf(r).split('\n')[0]).toMatch(/^Asked the Aether Brain window to show "Gate concept": the 3D view flies there and selects it\./)
    expect(json(r)).toEqual({ kind: 'note', path: 'Projects/PORTALz/Art/Gate concept.md', open: false })
    await call(client, 'show_in_brain', { target: 'PORTALz', open: true })
    expect(w.shown.at(-1)).toEqual({ kind: 'note', path: 'Projects/PORTALz.md', open: true })
    expect(textOf(await call(client, 'show_in_brain', { target: 'PORTALz', open: true }))).toContain('and open it in the editor')
    expect(activity.at(0)).toMatchObject({ tool: 'show_in_brain', summary: 'showed "Gate concept"', path: 'Projects/PORTALz/Art/Gate concept.md', write: false })
  })

  it('flies to a folder’s star by its path or its name, and never opens a folder', async () => {
    const w = windowSpy()
    const client = await connect(await open(), { show: w.show })
    await call(client, 'show_in_brain', { target: 'Projects/PORTALz/Art' })
    await call(client, 'show_in_brain', { target: 'refs', open: true })
    expect(w.shown).toEqual([
      { kind: 'folder', path: 'Projects/PORTALz/Art', open: false },
      { kind: 'folder', path: 'Projects/PORTALz/Refs', open: false },
    ])
  })

  it('flies to a picture by its vault path, as the vault names it', async () => {
    const w = windowSpy()
    const client = await connect(await open(), { show: w.show })
    await call(client, 'show_in_brain', { target: 'Projects/PORTALz/Art/gate.png', open: true })
    await call(client, 'show_in_brain', { target: 'projects/portalz/art/GATE.png' })
    expect(w.shown[0]).toEqual({ kind: 'picture', path: 'Projects/PORTALz/Art/gate.png', open: false })
    expect(w.shown[1]?.kind).toBe('picture')
  })

  it('flies to the Today hub', async () => {
    const w = windowSpy()
    const client = await connect(await open(), { show: w.show })
    const r = await call(client, 'show_in_brain', { target: ' Today ' })
    expect(w.shown).toEqual([{ kind: 'today', path: '', open: false }])
    expect(textOf(r)).toContain('show the Today hub')
    expect(activity.at(-1)).toMatchObject({ summary: 'showed the Today hub', path: null })
  })

  it('shows nothing that is not in the vault, and says why', async () => {
    const w = windowSpy()
    const client = await connect(await open(), { show: w.show })
    expect(errorOf(await call(client, 'show_in_brain', { target: 'Nowhere at all' }))).toMatch(/No note matches/)
    expect(errorOf(await call(client, 'show_in_brain', { target: 'Art/missing.png' }))).toBe('No picture "Art/missing.png" in the vault. Use find_pictures to see the pictures.')
    expect(errorOf(await call(client, 'show_in_brain', { target: '   ' }))).toMatch(/Name what to show|at least 1/)
    expect(w.shown).toEqual([])
  })

  it('does not reach outside the vault for a picture, whatever the path says', async () => {
    await fs.writeFile(path.join(tmp, 'outside.png'), png())
    const w = windowSpy()
    const client = await connect(await open(), { show: w.show })
    expect(errorOf(await call(client, 'show_in_brain', { target: '../outside.png' }))).toMatch(/No picture/)
    expect(errorOf(await call(client, 'show_in_brain', { target: path.join(tmp, 'outside.png') }))).toMatch(/No picture/)
    expect(w.shown).toEqual([])
  })

  it('reports it when the window is not there to show it', async () => {
    const client = await connect(await open(), {
      show: () => {
        throw new Error('The Aether Brain window is not open. Ask the user to open the app, then try again.')
      },
    })
    const r = await call(client, 'show_in_brain', { target: 'PORTALz' })
    expect(errorOf(r)).toBe('The Aether Brain window is not open. Ask the user to open the app, then try again.')
    expect(activity.at(-1)?.summary).toMatch(/^show_in_brain failed: The Aether Brain window is not open/)
  })
})

describe('over the HTTP link (the plugin’s bridge and a tunnel both come in this way)', () => {
  async function link(o: Partial<Parameters<typeof startHttpLink>[0]> = {}): Promise<Client> {
    const b = await open()
    const l = await startHttpLink({ brain: b, port: 0, token: TOKEN, readOnly: false, ...o })
    cleanups.push(() => l.close())
    const client = new Client({ name: 'http-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(l.url)))
    cleanups.push(() => client.close())
    return client
  }

  it('lists and runs the app’s tools when the link was started with the app’s hosts', async () => {
    const w: ShowTarget[] = []
    const client = await link({ pictures: fakePictures().host, show: (t) => void w.push(t) })
    const names = await toolNames(client)
    for (const n of HOST_TOOLS) expect(names, n).toContain(n)
    const r = await call(client, 'get_image', { picture: 'Projects/PORTALz/Art/gate.png', max_px: 256 })
    expect(r.content.map((c) => c.type)).toEqual(['text', 'image'])
    expect(r.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png', data: Buffer.from(STILL).toString('base64') })
    await call(client, 'show_in_brain', { target: 'today' })
    expect(w).toEqual([{ kind: 'today', path: '', open: false }])
  })

  it('does not list them for a link started without the app’s hosts (the standalone server)', async () => {
    const client = await link()
    const names = await toolNames(client)
    for (const n of HOST_TOOLS) expect(names, n).not.toContain(n)
    expect(errorOf(await call(client, 'get_image', { picture: 'x.png' }))).toMatch(/not found|Unknown|disabled/i)
  })
})
