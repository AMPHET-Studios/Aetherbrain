import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryVaultAdapter, buildGraph, parseNote, type VaultFile } from '@aether/core'
import { IPC, type CompanionGraphDto } from '../src/shared/ipc.js'
import {
  CLIENT_IDLE_MS,
  COMPANION_DEFAULT_PORT,
  CompanionHost,
  MAX_EDGE_NUMBERS,
  MAX_NODES,
  POSITIONS_HEADER,
  POSITIONS_MAGIC,
  REPUBLISH_MS,
  cleanCompanionPatch,
  cleanGraph,
  companionSettings,
  positionsBody,
  type CompanionHostOptions,
  type CompanionSettings,
} from '../src/main/companion.js'
import { companionBody, companionKind, companionScene } from '../src/renderer/companion-scene.js'

const TOKEN = 'tok_0123456789abcdefghijKLMN'

const graph = (over: Partial<CompanionGraphDto> = {}): CompanionGraphDto => ({
  version: 1,
  vault: 'Vault',
  layout: 'system',
  nodes: [
    { id: 'folder:', title: 'Vault', kind: 'sun', color: '#fff1d6', radius: 8, parent: -1 },
    { id: 'folder:Projects/Forge', title: 'Forge', kind: 'star', color: '#ffcf6b', radius: 5.5, parent: 0 },
    { id: 'Projects/Forge/Plan', title: 'Plan', kind: 'moon', color: '#ff5cc8', radius: 1.2, parent: 1 },
  ],
  edges: [2, 1],
  selected: -1,
  ...over,
})

describe('companion checks', () => {
  it('fills settings in and keeps a good token', () => {
    const s = companionSettings({})
    expect(s).toMatchObject({ enabled: false, port: COMPANION_DEFAULT_PORT })
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(companionSettings({ enabled: true, port: 9000, token: TOKEN })).toEqual({ enabled: true, port: 9000, token: TOKEN })
    expect(companionSettings({ port: 80, token: 'short' }).port).toBe(COMPANION_DEFAULT_PORT)
    expect(cleanCompanionPatch({ enabled: true, port: '9001', regenerateToken: true, evil: 1 })).toEqual({ enabled: true, port: 9001, regenerateToken: true })
  })

  it('takes a well-formed graph and refuses anything else', () => {
    expect(cleanGraph(graph()).nodes).toHaveLength(3)
    // Upper-case colours are normalised; long titles cut; unknown fields dropped.
    const g = cleanGraph({ ...graph(), extra: 1, nodes: [{ id: 'a', title: 'x'.repeat(900), kind: 'moon', color: '#ABCDEF', radius: 1, parent: -1, more: 2 }], edges: [] })
    expect(g.nodes[0]).toEqual({ id: 'a', title: 'x'.repeat(500), kind: 'moon', color: '#abcdef', radius: 1, parent: -1 })
    for (const bad of [
      null,
      { ...graph(), layout: 'flat' },
      { ...graph(), version: -1 },
      { ...graph(), nodes: [{ ...graph().nodes[0], kind: 'comet' }] },
      { ...graph(), nodes: [{ ...graph().nodes[0], color: 'red' }] },
      { ...graph(), nodes: [{ ...graph().nodes[0], radius: Infinity }] },
      { ...graph(), nodes: [{ ...graph().nodes[0], parent: 3 }] },
      { ...graph(), edges: [0] },
      { ...graph(), edges: [0, 3] },
      { ...graph(), selected: 7 },
    ]) {
      expect(() => cleanGraph(bad)).toThrow()
    }
  })

  it('keeps the note about how much of the brain the scene is, when it is well-formed', () => {
    const limits = { nodes: 3, ofNodes: 90_000, links: 1, ofLinks: 250_000 }
    expect(cleanGraph({ ...graph(), limits, extra: 1 }).limits).toEqual(limits)
    expect(cleanGraph(graph()).limits).toBeUndefined()
    for (const bad of [null, 5, { nodes: 3 }, { ...limits, nodes: -1 }, { ...limits, ofNodes: 1.5 }, { ...limits, links: '1' }, { ...limits, ofLinks: 2e9 }]) {
      expect(cleanGraph({ ...graph(), limits: bad }).limits).toBeUndefined()
    }
  })

  it('refuses a scene past the backstop, which the window keeps its own budget well under', () => {
    const node = graph().nodes[0]!
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...node, id: `n${i}`, parent: -1 }))
    expect(cleanGraph({ ...graph(), nodes: many(MAX_NODES), edges: [] }).nodes).toHaveLength(MAX_NODES)
    expect(() => cleanGraph({ ...graph(), nodes: many(MAX_NODES + 1), edges: [] })).toThrow('bad nodes')
    expect(() => cleanGraph({ ...graph(), edges: new Array<number>(MAX_EDGE_NUMBERS + 2).fill(0) })).toThrow('bad edges')
    // Far above what the window's own budget (12,000 nodes, 8,000 links) can send.
    expect(MAX_NODES).toBeGreaterThan(12_000 * 3)
    expect(MAX_EDGE_NUMBERS).toBeGreaterThan(8_000 * 2 * 3)
  })

  it('packs positions and rings behind a header, and refuses counts that do not fit', () => {
    const body = positionsBody(7, 2, new Float32Array([1, 2, 3, 4, 5, 6]), new Float32Array([0, 30, 0, 0, 0, 1]))!
    expect(body.length).toBe(POSITIONS_HEADER + 12 * 4)
    expect(body.readUInt32LE(0)).toBe(POSITIONS_MAGIC)
    expect(body.toString('latin1', 0, 4)).toBe('AEP1')
    expect([body.readUInt32LE(4), body.readUInt32LE(8), body.readUInt32LE(12)]).toEqual([7, 2, 1])
    expect(body.readFloatLE(POSITIONS_HEADER + 5 * 4)).toBe(6)
    expect(body.readFloatLE(POSITIONS_HEADER + 7 * 4)).toBe(30)
    expect(positionsBody(7, 3, new Float32Array(6), null)).toBeNull()
    expect(positionsBody(7, 2, new Float32Array(6), new Float32Array(5))).toBeNull()
    expect(positionsBody(7, 1, new Float32Array([NaN, Infinity, 1]), null)?.readFloatLE(POSITIONS_HEADER)).toBe(0)
  })
})

describe('the scene the brain window publishes', () => {
  it('gives each node its kind, colour, radius and parent, and the links as index pairs', async () => {
    const files: VaultFile[] = [
      { path: 'Projects/Forge.md', content: '---\nstatus: active\n---\n# Forge\n\n[[Plan]]\n', mtime: 1 },
      { path: 'Projects/Forge/Plan.md', content: '# Plan\n', mtime: 2 },
      { path: 'Inbox/Idea.md', content: '# Idea\n\n[[Nowhere]]\n', mtime: 3 },
    ]
    const notes = new Map(files.map((f) => [f.path.replace(/\.md$/, ''), parseNote(f)]))
    const g = buildGraph(notes, { folders: { all: ['Projects', 'Projects/Forge', 'Inbox'], multiRoot: false, rootTitle: 'Vault' } })
    const dto = companionScene(g, { version: 3, vault: 'Vault', layout: 'system', colorMode: 'area', activeTag: null, selectedId: 'Projects/Forge/Plan' })
    expect(dto.version).toBe(3)
    expect(dto.nodes).toHaveLength(g.nodes.length)
    const at = (id: string) => dto.nodes.findIndex((n) => n.id === id)
    const star = dto.nodes[at('folder:Projects/Forge')]
    // The original names are unchanged for the viewers built to them: a project folder is a 'star', another folder a 'planet'.
    expect(star).toMatchObject({ kind: 'star', body: 'star', color: '#ffcf6b' })
    expect(star?.radius).toBeGreaterThan(4)
    expect(dto.nodes[at('folder:Inbox')]).toMatchObject({ kind: 'planet', body: 'star' })
    // The vault of one folder is a galaxy.
    expect(dto.nodes[at('folder:')]).toMatchObject({ kind: 'sun', body: 'galaxy', radius: 16 })
    // Everything carries its urgency (0 here: the graph was built without it).
    for (const n of dto.nodes) expect(n.urgency).toBe(0)
    expect(dto.nodes[at('ghost:nowhere')]?.kind ?? dto.nodes.find((n) => n.kind === 'ghost')?.kind).toBe('ghost')
    expect(dto.nodes[at('Projects/Forge/Plan')]?.parent).toBe(at('folder:Projects/Forge'))
    expect(dto.selected).toBe(at('Projects/Forge/Plan'))
    expect(dto.edges.length % 2).toBe(0)
    expect(dto.edges.length / 2).toBe(g.edges.length)
    for (const n of dto.nodes) expect(n.color).toMatch(/^#[0-9a-f]{6}$/)
    // What it sends passes main's checks as is.
    expect(() => cleanGraph(dto)).not.toThrow()
    expect(companionKind({ kind: 'today' } as never)).toBe('today')
    expect(companionKind({ kind: 'image' } as never)).toBe('picture')
  })

  it('keeps the original names in kind and gives the cosmology its own: body', () => {
    const folder = (role: string, extra: object = {}) => ({ kind: 'folder', ghost: false, folder: { role, ...extra } }) as never
    const note = (wordCount: number) => ({ kind: 'note', ghost: false, wordCount }) as never
    // kind: as it always was (a viewer built to it draws what it drew).
    expect(companionKind(folder('mount'))).toBe('sun')
    expect(companionKind(folder('root'))).toBe('sun')
    expect(companionKind(folder('project'))).toBe('star')
    expect(companionKind(folder('folder'))).toBe('planet')
    expect(companionKind(note(120))).toBe('moon')
    expect(companionKind(note(9000))).toBe('moon')
    // body: galaxy for a drive or a one-folder vault, origin for the root of several drives, every folder a star.
    expect(companionBody(folder('mount'))).toBe('galaxy')
    expect(companionBody(folder('root', { galaxy: true }))).toBe('galaxy')
    expect(companionBody(folder('root'))).toBe('origin')
    expect(companionBody(folder('project'))).toBe('star')
    expect(companionBody(folder('folder'))).toBe('star')
    expect(companionBody(note(120))).toBe('moon')
    expect(companionBody(note(9000))).toBe('planet')
    expect(companionBody({ kind: 'ghost', ghost: true, wordCount: 0 } as never)).toBe('ghost')
    expect(companionBody({ kind: 'today', ghost: false, wordCount: 0 } as never)).toBe('hub')
  })

  it('sends a reference board with pictures orbiting it as a star (a sun of its own), and a plain board as the moon it is', () => {
    const board = (pictures?: number) => ({ kind: 'note', type: 'board', ghost: false, wordCount: 20, ...(pictures ? { board: { pictures } } : {}) }) as never
    // A viewer that draws every 'star' bright and named draws a board sun right; the cosmology calls it a star too.
    expect(companionKind(board(13))).toBe('star')
    expect(companionBody(board(13))).toBe('star')
    // A board nothing orbits is a note.
    expect(companionKind(board())).toBe('moon')
    expect(companionBody(board())).toBe('moon')
  })

  it('sends the Bio star as a star too, in its blue and bigger than the project star beside it', () => {
    const files: VaultFile[] = [
      { path: 'Projects/Forge.md', content: '---\nstatus: active\n---\n# Forge\n', mtime: 1 },
      { path: 'Projects/Forge/Plan.md', content: '# Plan\n', mtime: 2 },
      { path: 'Bio/Food.md', content: '# Food\n', mtime: 3 },
    ]
    const notes = new Map(files.map((f) => [f.path.replace(/\.md$/, ''), parseNote(f)]))
    const g = buildGraph(notes, { folders: { all: ['Projects', 'Projects/Forge', 'Bio'], multiRoot: false, rootTitle: 'Vault', bio: 'Bio' } })
    const dto = companionScene(g, { version: 1, vault: 'Vault', layout: 'system', colorMode: 'area', activeTag: null, selectedId: null })
    const at = (id: string) => dto.nodes.find((n) => n.id === id)!
    // A plain folder is a 'planet' for the viewers built to the old names; the Bio star is a star, with the colour and size the brain draws.
    expect(at('folder:Bio')).toMatchObject({ kind: 'star', body: 'star', color: '#2563ff' })
    expect(at('folder:Bio').radius).toBeGreaterThan(at('folder:Projects/Forge').radius)
    expect(at('folder:Bio').radius).toBeGreaterThan(9.4)
    expect(() => cleanGraph(dto)).not.toThrow()
    expect(companionKind({ kind: 'folder', ghost: false, folder: { role: 'folder', bio: true } } as never)).toBe('star')
    expect(companionKind({ kind: 'folder', ghost: false, folder: { role: 'folder' } } as never)).toBe('planet')
  })

  it('publishes the urgency of what is due: a note, and the folder star above it', () => {
    const files: VaultFile[] = [
      { path: 'Work/Gate/Plan.md', content: '# Plan\n\n- [ ] Ship the gate 📅 2026-09-29\n', mtime: 1 },
      { path: 'Work/Gate/Notes.md', content: '# Notes\n\nNothing open.\n', mtime: 2 },
      { path: 'Home/Idle.md', content: '# Idle\n\n- [ ] Someday maybe\n', mtime: 3 },
    ]
    const notes = new Map(files.map((f) => [f.path.replace(/\.md$/, ''), parseNote(f)]))
    const g = buildGraph(notes, {
      folders: { all: ['Work', 'Work/Gate', 'Home'], multiRoot: false, rootTitle: 'Vault' },
      urgency: { date: '2026-09-30' },
    })
    const dto = companionScene(g, { version: 1, vault: 'Vault', layout: 'system', colorMode: 'area', activeTag: null, selectedId: null })
    const u = (id: string) => dto.nodes.find((n) => n.id === id)?.urgency
    expect(u('Work/Gate/Plan')).toBeGreaterThanOrEqual(0.9)
    expect(u('Work/Gate/Notes')).toBe(0)
    // The system of the overdue note burns; the folder of one idle someday task barely glows.
    expect(u('folder:Work/Gate')).toBeGreaterThanOrEqual(0.9)
    expect(u('folder:Work')).toBeGreaterThanOrEqual(0.9)
    expect(u('folder:Home')).toBeLessThan(0.1)
  })

  it('lets body and urgency through the link, and leaves out a bad one instead of failing the scene', () => {
    const node = (extra: object) => ({ id: 'a', title: 'A', kind: 'moon', color: '#aabbcc', radius: 1, parent: -1, ...extra })
    const clean = (extra: object) => cleanGraph({ version: 1, vault: 'V', layout: 'system', nodes: [node(extra)], edges: [], selected: -1 }).nodes[0]!
    expect(clean({ body: 'planet', urgency: 0.4567 })).toMatchObject({ body: 'planet', urgency: 0.457 })
    // Out of range is pulled in; nothing else about the node changes.
    expect(clean({ urgency: 7 }).urgency).toBe(1)
    expect(clean({ urgency: -1 }).urgency).toBe(0)
    // A name nobody knows, or not a number: left out, the scene still goes.
    expect(clean({ body: 'comet' })).not.toHaveProperty('body')
    expect(clean({ urgency: 'hot' })).not.toHaveProperty('urgency')
    expect(clean({ urgency: Number.NaN })).not.toHaveProperty('urgency')
    // An older build sends neither.
    expect(clean({})).not.toHaveProperty('body')
    expect(clean({})).not.toHaveProperty('urgency')
  })
})

describe('the companion link server', () => {
  let dir: string
  let file: string
  let saved: CompanionSettings[]
  let brain: { id: number; sent: unknown[][]; destroyed: boolean; send(c: string, ...a: unknown[]): void; isDestroyed(): boolean }
  let clock: number
  let hosts: CompanionHost[]

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-companion-'))
    file = path.join(dir, 'companion.json')
    saved = []
    clock = 1_000_000
    hosts = []
    brain = {
      id: 42,
      sent: [],
      destroyed: false,
      send(c, ...a) {
        this.sent.push([c, ...a])
      },
      isDestroyed() {
        return this.destroyed
      },
    }
  })

  afterEach(async () => {
    for (const h of hosts) await h.stop()
    await fs.rm(dir, { recursive: true, force: true })
  })

  const host = (over: Partial<CompanionSettings> = {}, more: Partial<CompanionHostOptions> = {}) => {
    const h = new CompanionHost({
      settings: { enabled: true, port: 0, token: TOKEN, ...over } as CompanionSettings,
      save: async (s) => void saved.push(s),
      brain: () => brain,
      connectionFile: file,
      version: '0.8.0',
      now: () => clock,
      ...more,
    })
    hosts.push(h)
    return h
  }
  /** port 0 is refused by settings: start on a free port through configure. */
  const started = async (more: Partial<CompanionHostOptions> = {}) => {
    const h = host({ enabled: false }, more)
    const st = await h.configure({ enabled: true, port: 0 }).catch(() => null)
    if (st) return h
    // Pick a free port the way the OS does.
    const net = await import('node:net')
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port
        s.close(() => resolve(p))
      })
    })
    await h.configure({ enabled: true, port })
    return h
  }
  const url = (h: CompanionHost, p: string) => `http://127.0.0.1:${h.status().port}${p}`
  const auth = { Authorization: `Bearer ${TOKEN}` }
  const wants = () => brain.sent.filter((m) => m[0] === IPC.companionWant).map((m) => m[1])

  it('starts when switched on, writes companion.json, and takes it away when it stops', async () => {
    const h = await started()
    const st = h.status()
    expect(st).toMatchObject({ enabled: true, running: true, connected: false, error: null, file })
    const info = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    expect(info).toEqual({ app: 'Aether Brain', url: `http://127.0.0.1:${st.port}`, token: TOKEN, version: '0.8.0' })
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o077).toBe(0)
    expect(saved.at(-1)).toMatchObject({ enabled: true })
    await h.configure({ enabled: false })
    expect(h.status().running).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  it('answers only with the token, on 127.0.0.1, with no CORS', async () => {
    const h = await started()
    expect((await fetch(url(h, '/v1/hello'))).status).toBe(401)
    expect((await fetch(url(h, '/v1/hello'), { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await fetch(url(h, '/v1/hello'), { headers: { Authorization: `Bearer ${TOKEN}x` } })).status).toBe(401)
    const ok = await fetch(url(h, '/v1/hello'), { headers: auth })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBeNull()
    expect(await ok.json()).toEqual({ app: 'Aether Brain', version: '0.8.0', vault: null, graph: null })
    expect((await fetch(url(h, '/v1/nothing'), { headers: auth })).status).toBe(404)
    expect((await fetch(url(h, '/v1/graph'), { method: 'POST', headers: auth })).status).toBe(405)
  })

  it('asks the brain window to publish while a viewer reads, and stops when it goes quiet', async () => {
    const h = await started()
    expect(wants()).toEqual([])
    expect((await fetch(url(h, '/v1/graph'), { headers: auth })).status).toBe(503)
    expect(wants()).toEqual([true])
    expect(h.status().connected).toBe(true)
    // Published: served with an ETag, 304 when unchanged.
    expect(h.publishGraph(42, graph())).toBe(true)
    const r = await fetch(url(h, '/v1/graph'), { headers: auth })
    expect(r.status).toBe(200)
    const tag = r.headers.get('etag')!
    expect(((await r.json()) as CompanionGraphDto).nodes[1]?.title).toBe('Forge')
    expect((await fetch(url(h, '/v1/graph'), { headers: { ...auth, 'If-None-Match': tag } })).status).toBe(304)
    // A reload of the brain window (nothing published for a while): asked again.
    clock += REPUBLISH_MS + 1
    await fetch(url(h, '/v1/hello'), { headers: auth })
    expect(wants()).toEqual([true, true])
    // Quiet: told to stop, and what it had is dropped.
    clock += CLIENT_IDLE_MS + 1
    ;(h as unknown as { checkIdle(): void }).checkIdle()
    expect(wants()).toEqual([true, true, false])
    expect(h.status().connected).toBe(false)
    expect((await fetch(url(h, '/v1/graph'), { headers: auth })).status).toBe(503)
    expect(wants()).toEqual([true, true, false, true])
  })

  it('tells the window to run at full speed while a viewer reads, and to ease off when it goes quiet', async () => {
    const calls: boolean[] = []
    const h = await started({ onWanted: (on) => void calls.push(on) })
    expect(calls).toEqual([])
    await fetch(url(h, '/v1/hello'), { headers: auth })
    expect(calls).toEqual([true])
    // Asking again is not a new wish.
    await fetch(url(h, '/v1/hello'), { headers: auth })
    expect(calls).toEqual([true])
    expect(h.isWanted()).toBe(true)
    // A window that went quiet and is asked again may be a new one that never heard: the hook is told again.
    clock += REPUBLISH_MS + 1
    await fetch(url(h, '/v1/hello'), { headers: auth })
    expect(calls).toEqual([true, true])
    clock += CLIENT_IDLE_MS + 1
    ;(h as unknown as { checkIdle(): void }).checkIdle()
    expect(calls).toEqual([true, true, false])
    expect(h.isWanted()).toBe(false)
    // A hook that throws does not stop the link.
    const h2 = await started({
      onWanted: () => {
        throw new Error('window gone')
      },
    })
    expect((await fetch(url(h2, '/v1/hello'), { headers: auth })).status).toBe(200)
    expect(wants().filter((w) => w === true).length).toBeGreaterThanOrEqual(2)
  })

  it('says when a scene is refused and when the viewer is shown only a part of a big brain', async () => {
    const h = await started()
    await fetch(url(h, '/v1/hello'), { headers: auth })
    expect(h.status().warning).toBeNull()
    expect(h.status().showing).toBeNull()
    expect(h.publishGraph(42, { ...graph(), layout: 'flat' })).toBe(false)
    expect(h.status().warning).toMatch(/can't take/)
    // The next good scene clears it; a part of the brain is said so.
    const limits = { nodes: 3, ofNodes: 61_000, links: 1, ofLinks: 120_000 }
    expect(h.publishGraph(42, { ...graph(), limits })).toBe(true)
    expect(h.status().warning).toBeNull()
    expect(h.status().showing).toEqual(limits)
    const served = (await (await fetch(url(h, '/v1/graph'), { headers: auth })).json()) as CompanionGraphDto
    expect(served.limits).toEqual(limits)
    // A scene from anyone else is ignored without a word.
    expect(h.publishGraph(7, { ...graph(), layout: 'flat' })).toBe(false)
    expect(h.status().warning).toBeNull()
    // Nobody reads any more: nothing is held, nothing is said.
    clock += CLIENT_IDLE_MS + 1
    ;(h as unknown as { checkIdle(): void }).checkIdle()
    expect(h.status().showing).toBeNull()
  })

  it('serves positions of the current graph only, as binary with a header', async () => {
    const h = await started()
    await fetch(url(h, '/v1/hello'), { headers: auth })
    expect(h.publishPositions(42, 1, new Float32Array(9), null)).toBe(false) // no graph yet
    h.publishGraph(42, graph())
    expect(h.publishPositions(42, 2, new Float32Array(9), null)).toBe(false) // another graph's
    expect(h.publishPositions(42, 1, new Float32Array(6), null)).toBe(false) // wrong count
    expect(h.publishPositions(7, 1, new Float32Array(9), null)).toBe(false) // not the brain window
    expect(h.publishGraph(7, graph({ version: 9 }))).toBe(false)
    expect(h.publishPositions(42, 1, new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), new Float32Array([1, 40, 0, 0, 0, 1]))).toBe(true)
    const r = await fetch(url(h, '/v1/positions'), { headers: auth })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/octet-stream')
    const b = Buffer.from(await r.arrayBuffer())
    expect([b.readUInt32LE(0), b.readUInt32LE(4), b.readUInt32LE(8), b.readUInt32LE(12)]).toEqual([POSITIONS_MAGIC, 1, 3, 1])
    expect(b.readFloatLE(POSITIONS_HEADER + 8 * 4)).toBe(9)
    const tag = r.headers.get('etag')!
    expect((await fetch(url(h, '/v1/positions'), { headers: { ...auth, 'If-None-Match': tag } })).status).toBe(304)
    h.publishPositions(42, 1, new Float32Array(9), null)
    expect((await fetch(url(h, '/v1/positions'), { headers: { ...auth, 'If-None-Match': tag } })).status).toBe(200)
    // A new graph drops positions of the old one.
    h.publishGraph(42, graph({ version: 2 }))
    expect((await fetch(url(h, '/v1/positions'), { headers: auth })).status).toBe(503)
  })

  it('relays a select or an open of a node in the scene to the brain window', async () => {
    const h = await started()
    await fetch(url(h, '/v1/hello'), { headers: auth })
    h.publishGraph(42, graph())
    const post = (body: string) => fetch(url(h, '/v1/select'), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body })
    expect((await post(JSON.stringify({ id: 'folder:Projects/Forge' }))).status).toBe(204)
    expect((await post(JSON.stringify({ id: 'Projects/Forge/Plan', open: true }))).status).toBe(204)
    const selects = brain.sent.filter((m) => m[0] === IPC.companionSelect).map((m) => m[1])
    expect(selects).toEqual([
      { id: 'folder:Projects/Forge', open: false },
      { id: 'Projects/Forge/Plan', open: true },
    ])
    expect((await post(JSON.stringify({ id: 'Not/In/The/Scene' }))).status).toBe(404)
    expect((await post('{nope')).status).toBe(400)
    expect((await post(JSON.stringify({ id: 'x'.repeat(10_000) }))).status).toBe(413)
    brain.destroyed = true
    expect((await post(JSON.stringify({ id: 'folder:Projects/Forge' }))).status).toBe(409)
  })

  it('says when the port is taken, and restarts on a new token', async () => {
    const a = await started()
    const port = a.status().port
    const b = host({ enabled: false })
    const st = await b.configure({ enabled: true, port })
    expect(st.running).toBe(false)
    expect(st.error).toMatch(/taken/)
    await a.configure({ regenerateToken: true })
    const info = JSON.parse(await fs.readFile(file, 'utf8')) as { token: string }
    expect(info.token).not.toBe(TOKEN)
    expect((await fetch(url(a, '/v1/hello'), { headers: auth })).status).toBe(401)
    expect((await fetch(url(a, '/v1/hello'), { headers: { Authorization: `Bearer ${info.token}` } })).status).toBe(200)
    await expect(a.configure({ port: 80 })).rejects.toThrow(/1024/)
  })

  it('quits at once, companion.json and all', async () => {
    const h = await started()
    expect(existsSync(file)).toBe(true)
    h.quit()
    expect(existsSync(file)).toBe(false)
    expect(h.status().running).toBe(false)
  })
})

describe('the brain window side', () => {
  afterEach(() => void vi.unstubAllGlobals())

  it('publishes only while a viewer reads, and a viewer can open notes but never write one', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, String(v)),
      removeItem: (k: string) => void stored.delete(k),
      clear: () => stored.clear(),
    })
    const { useAether } = await import('@aether/ui')
    let wantTo: ((on: boolean) => void) | null = null
    let selectTo: ((r: { id: string; open: boolean }) => void) | null = null
    const graphs: CompanionGraphDto[] = []
    const aether = {
      onCompanionWant: (fn: typeof wantTo) => {
        wantTo = fn
        return () => undefined
      },
      onCompanionSelect: (fn: typeof selectTo) => {
        selectTo = fn
        return () => undefined
      },
      companionGraph: (g: CompanionGraphDto) => void graphs.push(g),
      companionPositions: vi.fn(),
      companionStatus: vi.fn(),
      companionConfigure: vi.fn(),
      onForgeRequest: () => () => undefined,
      platform: 'linux',
    }
    vi.stubGlobal('window', { addEventListener: vi.fn(), aether })
    await import('../src/renderer/companion.js')
    const vault = new MemoryVaultAdapter([
      { path: 'Projects/Forge.md', content: '---\nstatus: active\n---\n# Forge\n\n[[Not Written Yet]]\n', mtime: 1 },
      { path: 'Projects/Forge/Plan.md', content: '# Plan\n', mtime: 2 },
    ])
    await useAether.getState().openVault(vault)
    // Nobody reads: nothing is published.
    await new Promise((r) => setTimeout(r, 150))
    expect(graphs).toHaveLength(0)
    wantTo!(true)
    expect(graphs.length).toBeGreaterThan(0)
    const g = graphs.at(-1)!
    expect(g.nodes.some((n) => n.id === 'Projects/Forge/Plan')).toBe(true)
    const ghost = g.nodes.find((n) => n.kind === 'ghost')!
    expect(ghost).toBeTruthy()
    // Opening a ghost would create its note: the viewer only selects it.
    const before = (await vault.list()).length
    selectTo!({ id: ghost.id, open: true })
    await new Promise((r) => setTimeout(r, 50))
    expect((await vault.list()).length).toBe(before)
    expect(useAether.getState().selectedId).toBe(ghost.id)
    // A real note opens in the editor; an unknown id does nothing.
    selectTo!({ id: 'Projects/Forge/Plan', open: true })
    expect(useAether.getState().editorId).toBe('Projects/Forge/Plan')
    selectTo!({ id: 'Nope', open: false })
    expect(useAether.getState().selectedId).toBe('Projects/Forge/Plan')
    // The selection goes out with the next scene; opening the note also brightened its stars (a quarter of a second later), which is one more.
    await new Promise((r) => setTimeout(r, 450))
    const last = graphs.at(-1)!
    expect(last.nodes[last.selected]?.id).toBe('Projects/Forge/Plan')
    // What opening it did is in the scene: the star of the note is brighter than a star nobody has used (activity is how much it is used).
    const star = last.nodes.find((n) => n.id === 'folder:Projects/Forge')
    expect(star?.activity ?? 0).toBeGreaterThan(0)
    // The link nudging a window that is already publishing (a layout that stands still sends no frames) must not
    // hand the viewer the whole scene again under a new version.
    const published = graphs.length
    wantTo!(true)
    wantTo!(true)
    await new Promise((r) => setTimeout(r, 150))
    expect(graphs.length).toBe(published)
    wantTo!(false)
    const n = graphs.length
    useAether.getState().select(null)
    await new Promise((r) => setTimeout(r, 250))
    expect(graphs.length).toBe(n)
  })
})
