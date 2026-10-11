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
import { companionKind, companionScene, folderCovers, sceneSignature } from '../src/renderer/companion-scene.js'
import { MAX_THUMBS_AT_ONCE } from '../src/main/companion.js'
import { FolderCovers } from '../src/main/folder-cover.js'
import type { ScanResult } from '../src/main/fsvault.js'

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

  it('keeps a folder\'s cover and picture count when they are well-formed, and drops them quietly when not', () => {
    const folder = { id: 'folder:Art', title: 'Art', kind: 'planet' as const, color: '#aabbcc', radius: 3, parent: -1 }
    const good = cleanGraph({ ...graph(), nodes: [{ ...folder, cover: 'image:Art/gate.png', pictures: 12, extra: 1 }], edges: [] })
    expect(good.nodes[0]).toEqual({ ...folder, cover: 'image:Art/gate.png', pictures: 12 })
    for (const bad of [{ cover: 'Art/gate.png' }, { cover: '../../etc/passwd' }, { cover: 5 }, { cover: 'image:' + 'x'.repeat(5000) }, { pictures: 0 }, { pictures: -3 }, { pictures: 1.5 }, { pictures: '9' }, { pictures: 2e9 }]) {
      const n = cleanGraph({ ...graph(), nodes: [{ ...folder, ...bad }], edges: [] }).nodes[0]!
      expect(n).toEqual(folder)
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
    expect(star).toMatchObject({ kind: 'star', color: '#ffcf6b', radius: 5.5 })
    expect(dto.nodes[at('folder:')]?.kind).toBe('sun')
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
})

describe('the picture that stands for a folder', () => {
  const node = (id: string, parent: string | null, image?: { path: string; mtime: number | null; video?: boolean }, folder = false) =>
    ({
      id,
      title: id,
      area: 'inbox',
      type: 'note',
      tags: [],
      kind: image ? 'image' : 'folder',
      ghost: false,
      parent,
      ...(image ? { image: { size: null, embeddedBy: 0, ...image } } : {}),
      ...(folder ? { folder: { path: id.slice(7), role: 'folder', depth: 1, projectId: null, inProject: false, childFolders: 0, hiddenFolders: 0, notes: 0, totalNotes: 0, images: 3, shownImages: 3 } } : {}),
      inDegree: 0,
      outDegree: 0,
      degree: 0,
      created: null,
      updated: null,
      wordCount: 0,
    }) as never

  it('is the newest still picture drawn for the folder, a video only when there is nothing else', () => {
    const g = {
      nodes: [
        node('folder:Art', null, undefined, true),
        node('image:Art/old.png', 'folder:Art', { path: 'Art/old.png', mtime: 100 }),
        node('image:Art/new.png', 'folder:Art', { path: 'Art/new.png', mtime: 900 }),
        node('image:Art/clip.mp4', 'folder:Art', { path: 'Art/clip.mp4', mtime: 5000, video: true }),
        node('folder:Film', null, undefined, true),
        node('image:Film/a.mp4', 'folder:Film', { path: 'Film/a.mp4', mtime: 10, video: true }),
        node('image:Film/b.mp4', 'folder:Film', { path: 'Film/b.mp4', mtime: 30, video: true }),
        node('folder:Empty', null, undefined, true),
      ],
      edges: [],
      index: new Map(),
    }
    const covers = folderCovers(g as never)
    expect(covers.get('folder:Art')).toBe('image:Art/new.png')
    expect(covers.get('folder:Film')).toBe('image:Film/b.mp4')
    expect(covers.has('folder:Empty')).toBe(false)
  })

  it('goes into the published scene next to the picture count, and changes the scene\'s signature when it changes', () => {
    const base = {
      nodes: [node('folder:Art', null, undefined, true), node('image:Art/a.png', 'folder:Art', { path: 'Art/a.png', mtime: 5 })],
      edges: [],
      index: new Map([['folder:Art', 0], ['image:Art/a.png', 1]]),
    }
    const opts = { version: 1, vault: 'V', layout: 'system' as const, colorMode: 'area' as const, activeTag: null, selectedId: null }
    const dto = companionScene(base as never, opts)
    expect(dto.nodes[0]).toMatchObject({ id: 'folder:Art', pictures: 3, cover: 'image:Art/a.png' })
    expect(dto.nodes[1]?.cover).toBeUndefined()
    expect(dto.nodes[1]?.pictures).toBeUndefined()
    expect(() => cleanGraph(dto)).not.toThrow()
    const other = companionScene({ ...base, nodes: [base.nodes[0], node('image:Art/b.png', 'folder:Art', { path: 'Art/b.png', mtime: 9 })] } as never, opts)
    expect(sceneSignature(other)).not.toBe(sceneSignature(dto))
  })

  it('is found by name in a scan, for folders whose pictures are not drawn: the last name, a still before a video', () => {
    const scan = {
      assets: [
        { path: 'Art/2024-01-01.png', abs: '/v/Art/2024-01-01.png' },
        { path: 'Art/2024-03-09.png', abs: '/v/Art/2024-03-09.png' },
        { path: 'Art/zzz.mp4', abs: '/v/Art/zzz.mp4' },
        { path: 'Art/Deep/one.jpg', abs: '/v/Art/Deep/one.jpg' },
        { path: 'Film/a.webm', abs: '/v/Film/a.webm' },
        { path: 'Film/b.webm', abs: '/v/Film/b.webm' },
        { path: 'top.png', abs: '/v/top.png' },
      ],
    } as unknown as ScanResult
    const c = new FolderCovers()
    expect(c.coverFor(scan, 'Art')).toBe('Art/2024-03-09.png')
    expect(c.coverFor(scan, 'Art/')).toBe('Art/2024-03-09.png')
    expect(c.coverFor(scan, 'Art\\Deep')).toBe('Art/Deep/one.jpg')
    expect(c.coverFor(scan, 'Film')).toBe('Film/b.webm')
    expect(c.coverFor(scan, '')).toBe('top.png')
    expect(c.coverFor(scan, 'Nowhere')).toBeNull()
    expect(c.size(scan)).toBe(4)
    // A new scan is indexed again.
    const next = { assets: [{ path: 'Art/x.png', abs: '/v/Art/x.png' }] } as unknown as ScanResult
    expect(c.coverFor(next, 'Art')).toBe('Art/x.png')
    expect(c.coverFor(next, 'Film')).toBeNull()
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

  describe('/v1/thumb', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const artGraph = () =>
      graph({
        nodes: [
          { id: 'folder:', title: 'Vault', kind: 'sun', color: '#fff1d6', radius: 8, parent: -1 },
          { id: 'folder:Art', title: 'Art', kind: 'planet', color: '#ffcf6b', radius: 3, parent: 0, pictures: 4, cover: 'image:Art/gate.png' },
          { id: 'folder:Misc', title: 'Misc', kind: 'planet', color: '#ffcf6b', radius: 3, parent: 0, pictures: 2 },
          { id: 'folder:Bare', title: 'Bare', kind: 'planet', color: '#ffcf6b', radius: 3, parent: 0 },
          { id: 'image:Art/gate.png', title: 'gate', kind: 'picture', color: '#ffffff', radius: 1, parent: 1 },
          { id: 'Notes/Plan', title: 'Plan', kind: 'moon', color: '#ff5cc8', radius: 1.2, parent: 0 },
        ],
        edges: [],
      })
    const get = (h: CompanionHost, q: string, headers: Record<string, string> = auth) => fetch(url(h, `/v1/thumb${q}`), { headers })
    let calls: { path: string; px: number }[]

    beforeEach(() => {
      calls = []
    })

    const withThumbs = async (more: Partial<CompanionHostOptions> = {}) => {
      const h = await started({
        thumb: async (p, px) => {
          calls.push({ path: p, px })
          return p.includes('broken') ? null : png
        },
        folderCover: (f) => (f === 'Misc' ? 'Misc/last.jpg' : f === 'Broken' ? 'Misc/broken.png' : null),
        ...more,
      })
      await fetch(url(h, '/v1/hello'), { headers: auth })
      h.publishGraph(42, artGraph())
      return h
    }

    it('serves the picture of a picture node, a folder\'s cover, and a folder\'s own pick, as PNG', async () => {
      const h = await withThumbs()
      const direct = await get(h, '?id=' + encodeURIComponent('image:Art/gate.png') + '&size=800')
      expect(direct.status).toBe(200)
      expect(direct.headers.get('content-type')).toBe('image/png')
      expect(direct.headers.get('cache-control')).toMatch(/private/)
      expect([...new Uint8Array(await direct.arrayBuffer())]).toEqual([...png])
      // The folder asks for its cover; the one without a cover asks the vault.
      expect((await get(h, '?id=' + encodeURIComponent('folder:Art') + '&size=1024')).status).toBe(200)
      expect((await get(h, '?id=' + encodeURIComponent('folder:Misc'))).status).toBe(200)
      expect(calls).toEqual([
        { path: 'Art/gate.png', px: 800 },
        { path: 'Art/gate.png', px: 1024 },
        { path: 'Misc/last.jpg', px: 512 },
      ])
    })

    it('clamps the size and falls back to the default for nonsense', async () => {
      const h = await withThumbs()
      const id = encodeURIComponent('image:Art/gate.png')
      for (const q of ['&size=5', '&size=99999', '&size=abc', '&size=-40', '']) await get(h, `?id=${id}${q}`)
      expect(calls.map((c) => c.px)).toEqual([64, 1024, 512, 64, 512])
    })

    it('asks for the token, and for a GET', async () => {
      const h = await withThumbs()
      const id = encodeURIComponent('image:Art/gate.png')
      expect((await fetch(url(h, `/v1/thumb?id=${id}`))).status).toBe(401)
      expect((await fetch(url(h, `/v1/thumb?id=${id}`), { method: 'POST', headers: auth })).status).toBe(405)
      expect(calls).toEqual([])
    })

    it('serves only what the scene names: no arbitrary path, no note, no folder that is not in it', async () => {
      const h = await withThumbs()
      for (const id of ['image:../../etc/passwd.png', 'image:Art/other.png', 'Art/gate.png', 'C:\\Windows\\win.png', 'Notes/Plan', 'folder:Nowhere', 'folder:../..', '']) {
        const r = await get(h, '?id=' + encodeURIComponent(id))
        expect([400, 404]).toContain(r.status)
      }
      // A folder with no cover and no pick from the vault, and one whose pick cannot be decoded.
      expect((await get(h, '?id=' + encodeURIComponent('folder:Bare'))).status).toBe(404)
      expect((await get(h, '?id=' + encodeURIComponent('folder:Misc'))).status).toBe(200)
      expect(calls.map((c) => c.path)).toEqual(['Misc/last.jpg'])
      // A very long id is refused before anything is looked up.
      expect((await get(h, '?id=' + 'x'.repeat(9000))).status).toBe(400)
    })

    it('says 404 for a picture that cannot be read, 503 before a scene, 501 without a thumbnailer', async () => {
      const h = await started({ thumb: async () => null })
      await fetch(url(h, '/v1/hello'), { headers: auth })
      expect((await get(h, '?id=image:x.png')).status).toBe(503)
      h.publishGraph(42, artGraph())
      expect((await get(h, '?id=' + encodeURIComponent('image:Art/gate.png'))).status).toBe(404)
      const none = await started()
      await fetch(url(none, '/v1/hello'), { headers: auth })
      none.publishGraph(42, artGraph())
      expect((await get(none, '?id=' + encodeURIComponent('image:Art/gate.png'))).status).toBe(501)
      // A thumbnailer that throws is a 404, not a hung request or a dead link.
      const bad = await started({
        thumb: async () => {
          throw new Error('helper died')
        },
        folderCover: () => {
          throw new Error('scan gone')
        },
      })
      await fetch(url(bad, '/v1/hello'), { headers: auth })
      bad.publishGraph(42, artGraph())
      expect((await get(bad, '?id=' + encodeURIComponent('image:Art/gate.png'))).status).toBe(404)
      expect((await get(bad, '?id=' + encodeURIComponent('folder:Misc'))).status).toBe(404)
      expect((await fetch(url(bad, '/v1/hello'), { headers: auth })).status).toBe(200)
    })

    it('makes only a few at once and tells the rest to come back, then lets them in as the first finish', async () => {
      const release: (() => void)[] = []
      const h = await withThumbs({
        thumb: (p) => {
          calls.push({ path: p, px: 0 })
          return new Promise((resolve) => release.push(() => resolve(png)))
        },
      })
      const id = encodeURIComponent('image:Art/gate.png')
      const pending = Array.from({ length: MAX_THUMBS_AT_ONCE }, () => get(h, `?id=${id}`))
      // Wait until all of them reached the thumbnailer.
      for (let i = 0; i < 200 && release.length < MAX_THUMBS_AT_ONCE; i++) await new Promise((r) => setTimeout(r, 5))
      expect(release).toHaveLength(MAX_THUMBS_AT_ONCE)
      const extra = await get(h, `?id=${id}`)
      expect(extra.status).toBe(429)
      expect(extra.headers.get('retry-after')).toBe('1')
      release.forEach((r) => r())
      expect((await Promise.all(pending)).map((r) => r.status)).toEqual(Array(MAX_THUMBS_AT_ONCE).fill(200))
      release.length = 0
      const later = get(h, `?id=${id}`)
      for (let i = 0; i < 200 && release.length < 1; i++) await new Promise((r) => setTimeout(r, 5))
      release.forEach((r) => r())
      expect((await later).status).toBe(200)
    })
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
    // The selection goes out with the next scene.
    await new Promise((r) => setTimeout(r, 250))
    const last = graphs.at(-1)!
    expect(last.nodes[last.selected]?.id).toBe('Projects/Forge/Plan')
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
