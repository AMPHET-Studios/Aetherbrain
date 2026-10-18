import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { nextDay, todayIso } from '@aether/core'
import { FsVault } from '../src/main/fsvault.js'
import { MAX_LINE_ARG, MAX_TEXT_ARG } from '../src/mcp/tools.js'
import {
  Brain,
  HOST_TOOLS,
  TOOLS,
  appendText,
  clientFromUserAgent,
  createMcpServer,
  parseArgs,
  startHttpLink,
  usableRoots,
  type ActivityEvent,
  type BrainOptions,
} from '../src/mcp/server.js'

/** The tools a server without the app's pictures and window lists (stdio, the standalone HTTP link, the bundle). */
const OFFERED = Object.keys(TOOLS).filter((n) => !(HOST_TOOLS as readonly string[]).includes(n))

const here = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(here, '../dist/mcp/aether-mcp.mjs')
const TOKEN = 'test-token-0123456789abcdef'
const TODAY = todayIso()

const PORTALZ = `---
title: PORTALz
type: project
tags: [portal]
created: 2026-09-01
updated: 2026-09-20
status: active
---
# PORTALz

> The portal game.

## To do

- [ ] Sculpt the hero monolith
- [x] Pick the palette ✅ 2026-09-20

## Notes

See [[Glyphs]].
`

const FILES: Record<string, string> = {
  'Home.md': '# Home\n\nStart at [[PORTALz]] and [[Value Study]].\n',
  'Projects/PORTALz.md': PORTALZ,
  'Projects/PORTALz/Art/Glyphs.md': '# Glyphs\n\nGlyph language for the gate.\n',
  'Projects/ConceptForge/ConceptForge.md': '---\ntype: project\nstatus: paused\n---\n# ConceptForge\n\n## To do\n\n- [ ] Grader rubric\n',
  'Resources/Value Study.md': '---\ntags: [drawing]\n---\n# Value Study\n\nThree values: light, mid, dark. Portal lighting.\n',
  'Resources/Ideas.md': '# Ideas\n\nResource ideas.\n',
  'Areas/Ideas.md': '# Ideas\n\nArea ideas.\n',
  'Inbox/Loose thought.md': '# Loose thought\n\nsomething\n',
  '.hidden/Secret.md': '# Secret\n',
  'node_modules/pkg/Readme.md': '# Readme\n',
}

let tmp: string
let root: string
let brain: Brain | null = null
let activity: ActivityEvent[] = []
const cleanups: (() => Promise<void>)[] = []

async function put(rel: string, content: string, base = root): Promise<void> {
  const full = path.join(base, ...rel.split('/'))
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}

const disk = (rel: string, base = root) => fs.readFile(path.join(base, ...rel.split('/')), 'utf8')
const isDir = (rel: string, base = root) =>
  fs.stat(path.join(base, ...rel.split('/'))).then(
    (s) => s.isDirectory(),
    () => false,
  )

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-mcp-'))
  root = path.join(tmp, 'vault')
  for (const [rel, content] of Object.entries(FILES)) await put(rel, content)
  await fs.mkdir(path.join(root, 'Projects', 'PORTALz', 'Design'), { recursive: true })
  activity = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cleanups.splice(0)) await c()
  brain?.close()
  brain = null
  await fs.rm(tmp, { recursive: true, force: true })
})

async function open(opts: Partial<BrainOptions> = {}): Promise<Brain> {
  brain = await Brain.open({ roots: [root], watch: false, ...opts })
  return brain
}

interface Result {
  content: { type: string; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

async function connect(b: Brain, readOnly = false): Promise<Client> {
  const server = createMcpServer(b, { readOnly, onActivity: (a) => activity.push(a) })
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

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result
}

/** The JSON after the human line of a tool result (loosely typed: tests poke at many shapes). */
function json(r: Result): any {
  const text = r.content[0]?.text ?? ''
  if (r.isError) throw new Error(`tool failed: ${text}`)
  return JSON.parse(text.slice(text.indexOf('\n') + 1))
}

function errorOf(r: Result): string {
  expect(r.isError).toBe(true)
  return r.content[0]?.text ?? ''
}

describe('tools/list', () => {
  it('offers every tool with titles, hints and "Use this when" descriptions', async () => {
    const client = await connect(await open())
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...OFFERED].sort())
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy()
      expect(t.description, t.name).toMatch(/^Use this when/)
      expect(t.inputSchema.type).toBe('object')
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe('boolean')
      expect(typeof t.annotations?.destructiveHint, t.name).toBe('boolean')
      // Every tool stays on this computer, except save_image: given a ChatGPT file it downloads it from ChatGPT's file hosts.
      expect(t.annotations?.openWorldHint, t.name).toBe(t.name === 'save_image')
      expect(t.annotations?.readOnlyHint, t.name).toBe(!TOOLS[t.name as keyof typeof TOOLS].write)
    }
    expect(tools.find((t) => t.name === 'search')?.outputSchema).toBeTruthy()
    expect(tools.find((t) => t.name === 'fetch')?.outputSchema).toBeTruthy()
    const instructions = client.getInstructions() ?? ''
    expect(instructions.slice(0, 512)).toMatch(/markdown[\s\S]*\[\[wikilinks\]\][\s\S]*PARA[\s\S]*## To do[\s\S]*✅[\s\S]*planets[\s\S]*D:\\/)
  })

  it('hides every write tool in read-only mode', async () => {
    const b = await open()
    const client = await connect(b, true)
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    const reads = Object.entries(TOOLS)
      .filter(([n, t]) => !t.write && OFFERED.includes(n))
      .map(([n]) => n)
      .sort()
    expect(names).toEqual(reads)
    expect(names).not.toContain('create_note')
    const r = await call(client, 'create_note', { title: 'Nope' })
    expect(r.isError).toBe(true)
    expect(existsSync(path.join(root, 'Inbox', 'Nope.md'))).toBe(false)
  })

  it('a read-only brain refuses writes even when the server offers them', async () => {
    const b = await open({ readOnly: true })
    await expect(b.createNote({ title: 'Nope' })).rejects.toThrow(/read-only/)
    const client = await connect(b, false)
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('capture')
  })
})

describe('ChatGPT search / fetch', () => {
  it('search returns {results:[{id,title,url}]} as structured content and as JSON text', async () => {
    const client = await connect(await open())
    const r = await call(client, 'search', { query: 'glyph' })
    const results = (r.structuredContent as { results: { id: string; title: string; url: string }[] }).results
    expect(results.map((x) => x.id)).toContain('Projects/PORTALz/Art/Glyphs')
    for (const x of results) {
      expect(Object.keys(x).sort()).toEqual(['id', 'title', 'url'])
      expect(x.url).toMatch(/^file:\/\//)
    }
    expect(JSON.parse(r.content[0]!.text)).toEqual(r.structuredContent)
  })

  it('fetch returns {id,title,text,url,metadata}', async () => {
    const client = await connect(await open())
    const r = await call(client, 'fetch', { id: 'Projects/PORTALz' })
    const doc = r.structuredContent as { id: string; title: string; text: string; url: string; metadata: Record<string, string> }
    expect(doc.id).toBe('Projects/PORTALz')
    expect(doc.title).toBe('PORTALz')
    expect(doc.text).toBe(PORTALZ)
    expect(fileURLToPath(doc.url)).toBe(path.join(root, 'Projects', 'PORTALz.md'))
    expect(doc.metadata['path']).toBe('Projects/PORTALz.md')
    expect(doc.metadata['backlinks']).toContain('Home')
    expect(JSON.parse(r.content[0]!.text)).toEqual(doc)
    expect(activity.at(-1)).toMatchObject({ tool: 'fetch', path: 'Projects/PORTALz.md', write: false, client: 'vitest' })
  })
})

describe('reading', () => {
  it('read_note resolves by title, id, path, path without .md, wikilink and file URL', async () => {
    const client = await connect(await open())
    for (const ref of ['PORTALz', 'portalz', 'Projects/PORTALz', 'Projects/PORTALz.md', 'Projects\\PORTALz.md', '[[PORTALz]]', pathToFileURL(path.join(root, 'Projects', 'PORTALz.md')).href]) {
      const n = json(await call(client, 'read_note', { note: ref }))
      expect(n.id, ref).toBe('Projects/PORTALz')
    }
    const n = json(await call(client, 'read_note', { note: 'PORTALz' }))
    expect(n.content).toBe(PORTALZ)
    expect(n.frontmatter.status).toBe('active')
    expect(n.links.map((l: { id: string }) => l.id)).toEqual(['Projects/PORTALz/Art/Glyphs'])
    expect(n.backlinks.map((l: { id: string }) => l.id)).toEqual(['Home'])
    expect(n.tasks).toEqual([
      { line: 14, text: 'Sculpt the hero monolith', done: false, doneAt: null, section: 'To do' },
      { line: 15, text: 'Pick the palette', done: true, doneAt: '2026-09-20', section: 'To do' },
    ])
    expect(n.project.folder).toBe('Projects/PORTALz')
  })

  it('an ambiguous title is an error listing the candidates; a missing one suggests', async () => {
    const client = await connect(await open())
    const msg = errorOf(await call(client, 'read_note', { note: 'Ideas' }))
    expect(msg).toContain('Areas/Ideas.md')
    expect(msg).toContain('Resources/Ideas.md')
    expect(json(await call(client, 'read_note', { note: 'Areas/Ideas' })).path).toBe('Areas/Ideas.md')
    expect(errorOf(await call(client, 'read_note', { note: 'Portal' }))).toMatch(/No note matches "Portal"\. Did you mean: "PORTALz"/)
  })

  it('never sees ignored folders or anything outside the vault', async () => {
    await fs.writeFile(path.join(tmp, 'outside.md'), '# Outside\n')
    const client = await connect(await open())
    for (const note of ['.hidden/Secret', 'Secret', 'node_modules/pkg/Readme', '../outside', '../outside.md', path.join(tmp, 'outside.md'), '/etc/passwd']) {
      expect((await call(client, 'read_note', { note })).isError, note).toBe(true)
    }
    const top = json(await call(client, 'list_folder', {}))
    expect(top.folder.children.map((c: { name: string }) => c.name)).toEqual(['Areas', 'Inbox', 'Projects', 'Resources'])
  })

  it('a folder path beats the root label; a stray leading slash or backslash is still a vault path', async () => {
    // The root folder is called "vault" and holds a folder "vault".
    await fs.mkdir(path.join(root, 'vault', 'Inner'), { recursive: true })
    const client = await connect(await open())
    expect(json(await call(client, 'list_folder', { path: 'vault' })).folder).toMatchObject({ path: 'vault', folders: 1 })
    expect(json(await call(client, 'create_folder', { path: '\\Resources\\Lighting' })).path).toBe('Resources/Lighting')
    expect(json(await call(client, 'create_folder', { path: '/Resources/Shadows' })).path).toBe('Resources/Shadows')
  })

  it.runIf(process.platform === 'win32')('resolves an absolute Windows path written in another case', async () => {
    const client = await connect(await open())
    const note = path.join(root, 'Projects', 'PORTALz.md').toLowerCase()
    expect(json(await call(client, 'read_note', { note })).id).toBe('Projects/PORTALz')
  })

  it('list_folder shows planets with counts and marks project stars', async () => {
    const client = await connect(await open())
    const r = json(await call(client, 'list_folder', { path: 'Projects', depth: 2 }))
    const portalz = r.folder.children.find((c: { name: string }) => c.name === 'PORTALz')
    expect(portalz).toMatchObject({ kind: 'project', project: 'PORTALz', total: 1, folders: 2 })
    expect(portalz.children.map((c: { name: string; total: number }) => [c.name, c.total])).toEqual([
      ['Art', 1],
      ['Design', 0],
    ])
    expect(r.folder.children.find((c: { name: string }) => c.name === 'ConceptForge')).toMatchObject({ kind: 'project', project: 'ConceptForge' })
    expect(r.notes.map((n: { title: string }) => n.title)).toEqual(['PORTALz'])
    expect(json(await call(client, 'list_folder', { path: 'projects/portalz' })).folder.path).toBe('Projects/PORTALz')
    expect((await call(client, 'list_folder', { path: 'Nowhere' })).isError).toBe(true)
  })

  it('list_projects and get_project', async () => {
    const client = await connect(await open())
    const list = json(await call(client, 'list_projects'))
    expect(list.projects.map((p: { title: string }) => p.title)).toEqual(['PORTALz', 'ConceptForge'])
    expect(list.projects[0]).toMatchObject({ status: 'active', folder: 'Projects/PORTALz', folderExists: true, progress: '1/2', next: ['Sculpt the hero monolith'] })
    expect(json(await call(client, 'list_projects', { status: 'paused' })).projects.map((p: { title: string }) => p.title)).toEqual(['ConceptForge'])
    const p = json(await call(client, 'get_project', { project: 'PORTALz' }))
    expect(p.summary).toBe('The portal game.')
    expect(p.planets.map((x: { name: string }) => x.name)).toEqual(['Art', 'Design'])
    expect(p.notes.map((x: { id: string }) => x.id)).toEqual(['Projects/PORTALz/Art/Glyphs'])
    expect(p.tasks[1]).toMatchObject({ line: 15, done: true, doneAt: '2026-09-20' })
    // By its home folder, too.
    expect(json(await call(client, 'get_project', { project: 'Projects/ConceptForge' })).title).toBe('ConceptForge')
    expect(errorOf(await call(client, 'get_project', { project: 'Value Study' }))).toMatch(/is not a project/)
  })

  it('search_notes filters by folder and tag; related_notes and recent_notes answer', async () => {
    const client = await connect(await open())
    const all = json(await call(client, 'search_notes', { query: 'portal' }))
    expect(all.hits.length).toBeGreaterThan(1)
    const inProjects = json(await call(client, 'search_notes', { query: 'glyph', folder: 'Projects/PORTALz' }))
    expect(inProjects.hits.map((h: { path: string }) => h.path)).toEqual(['Projects/PORTALz/Art/Glyphs.md'])
    const tagged = json(await call(client, 'search_notes', { query: 'values', tag: 'drawing' }))
    expect(tagged.hits.map((h: { id: string }) => h.id)).toEqual(['Resources/Value Study'])
    // Every word must match, else any word does.
    expect(json(await call(client, 'search_notes', { query: 'zzqx glyph' })).hits.map((h: { id: string }) => h.id)).toContain('Projects/PORTALz/Art/Glyphs')
    const rel = json(await call(client, 'related_notes', { note: 'PORTALz' }))
    expect(rel.linksTo.map((x: { id: string }) => x.id)).toEqual(['Projects/PORTALz/Art/Glyphs'])
    expect(rel.linkedFrom.map((x: { id: string }) => x.id)).toEqual(['Home'])
    const recent = json(await call(client, 'recent_notes', { limit: 3 }))
    expect(recent.notes).toHaveLength(3)
    const overview = json(await call(client, 'vault_overview'))
    expect(overview).toMatchObject({ notes: 8, newNotesGoTo: 'Inbox', readOnly: false, projectCount: 2 })
  })
})

describe('writing notes', () => {
  it('create_note writes a new .md note and never overwrites', async () => {
    const client = await connect(await open())
    const a = json(await call(client, 'create_note', { title: 'Loose thought', content: 'A second one', tags: ['#Idea'] }))
    expect(a.path).toBe('Inbox/Loose thought 2.md')
    expect(await disk('Inbox/Loose thought.md')).toBe(FILES['Inbox/Loose thought.md'])
    const text = await disk('Inbox/Loose thought 2.md')
    expect(text).toMatch(/^---\ntitle: Loose thought\ntype: inbox\ntags: \[idea\]\n/)
    expect(text).toContain('# Loose thought\n\nA second one\n')
    const b = json(await call(client, 'create_note', { title: 'evil.txt', folder: 'Resources/Lighting', content: '# Custom heading\n\nbody' }))
    expect(b.path).toBe('Resources/Lighting/evil.txt.md')
    expect(await disk('Resources/Lighting/evil.txt.md')).toMatch(/---\n\n# Custom heading\n\nbody\n$/)
    expect(errorOf(await call(client, 'create_note', { title: 'x', folder: 'notes.md' }))).toMatch(/cannot end in \.md/)
    // Indexed right away.
    expect(json(await call(client, 'read_note', { note: 'evil.txt' })).path).toBe('Resources/Lighting/evil.txt.md')
    expect(activity.find((e) => e.tool === 'create_note')).toMatchObject({ write: true, path: 'Inbox/Loose thought 2.md', summary: 'created "Loose thought"' })
  })

  it('create_note refuses content whose frontmatter it would have to drop', async () => {
    const client = await connect(await open())
    const msg = errorOf(await call(client, 'create_note', { title: 'Broken', content: '---\ntitle: [oops\nkeep: me\n---\nbody' }))
    expect(msg).toMatch(/not valid YAML/)
    expect(existsSync(path.join(root, 'Inbox', 'Broken.md'))).toBe(false)
  })

  it('never makes a name Windows cannot hold', async () => {
    const client = await connect(await open())
    // CON.md would be the console device on Windows.
    expect(json(await call(client, 'create_note', { title: 'CON' })).path).toBe('Inbox/CON 2.md')
    expect(json(await call(client, 'capture', { text: 'aux' })).path).toBe('Inbox/aux 2.md')
    // A leading dot would hide the note from the vault.
    expect(json(await call(client, 'create_note', { title: '.env ideas' })).path).toBe('Inbox/env ideas.md')
    for (const bad of ['Aux', 'Art: Monsters', 'Sound.', 'what?', 'Projects/PORTALz/lpt1']) {
      expect(errorOf(await call(client, 'create_folder', { path: bad })), bad).toMatch(/folder name|device name/)
    }
    expect(errorOf(await call(client, 'create_folder', { project: 'PORTALz', path: 'nul.txt' }))).toMatch(/device name/)
    // Listed, not existsSync: on Windows `…\Aux` names the AUX device, which "exists".
    expect(await fs.readdir(root)).toEqual(expect.not.arrayContaining(['Aux', 'Sound.', 'Sound', 'Art: Monsters']))
  })

  it('new notes reuse the vault\'s own spelling of Inbox and Projects', async () => {
    const lower = path.join(tmp, 'lower')
    await put('inbox/Old.md', '# Old\n', lower)
    await put('projects/Gate.md', '---\ntype: project\n---\n# Gate\n', lower)
    brain = await Brain.open({ roots: [lower], watch: false })
    const client = await connect(brain)
    expect(json(await call(client, 'create_note', { title: 'New' })).path).toBe('inbox/New.md')
    expect(json(await call(client, 'capture', { text: 'Quick one' })).path).toBe('inbox/Quick one.md')
    expect(json(await call(client, 'create_project', { title: 'Lab', make_folder: false })).project.path).toBe('projects/Lab.md')
    expect(json(await call(client, 'list_folder', {})).folder.children.map((c: { path: string }) => c.path)).toEqual(['inbox', 'projects'])
  })

  it('update_frontmatter keeps CRLF line endings and a byte-order mark', async () => {
    await put('Resources/Win.md', '---\r\ntitle: Win\r\nstatus: a\r\n---\r\n# Win\r\n\r\ntext\r\n')
    await put('Resources/Bom.md', '﻿# Bom\n\ntext\n')
    const client = await connect(await open())
    json(await call(client, 'update_frontmatter', { note: 'Win', set: { status: 'b' } }))
    const win = await disk('Resources/Win.md')
    expect(win).toContain('status: b\r\n')
    expect(win.replace(/\r\n/g, '')).not.toContain('\n')
    json(await call(client, 'update_frontmatter', { note: 'Bom', set: { status: 'x' } }))
    const bom = await disk('Resources/Bom.md')
    expect(bom.startsWith('﻿---\nstatus: x\n---\n')).toBe(true)
    expect(bom).toContain('\n# Bom\n')
  })

  it('capture saves to the Inbox', async () => {
    const client = await connect(await open())
    const n = json(await call(client, 'capture', { text: 'Portal hum idea\nlow drone under the gate', tags: ['audio'] }))
    expect(n.path).toBe('Inbox/Portal hum idea.md')
    const text = await disk(n.path)
    expect(text).toContain('type: inbox')
    expect(text).toContain('low drone under the gate')
  })

  it('append_to_note adds at the end or under a heading', async () => {
    const client = await connect(await open())
    json(await call(client, 'append_to_note', { note: 'PORTALz', text: 'The gate hums at night.', heading: 'Notes' }))
    json(await call(client, 'append_to_note', { note: 'PORTALz', text: '- Sound: low drone', heading: 'Audio' }))
    const text = await disk('Projects/PORTALz.md')
    expect(text).toContain('## Notes\n\nSee [[Glyphs]].\n\nThe gate hums at night.\n\n## Audio\n\n- Sound: low drone\n')
    expect(text).toContain(`updated: ${TODAY}\n`)
  })

  it('edit_note replaces exactly one occurrence', async () => {
    await put('Resources/Twice.md', '# Twice\n\nx and x\n')
    const client = await connect(await open())
    const r = json(await call(client, 'edit_note', { note: 'Value Study', old_text: 'light, mid, dark', new_text: 'light and dark' }))
    expect(r.changed).toBe(true)
    expect(await disk('Resources/Value Study.md')).toBe('---\ntags: [drawing]\n---\n# Value Study\n\nThree values: light and dark. Portal lighting.\n')
    expect(errorOf(await call(client, 'edit_note', { note: 'Twice', old_text: 'x', new_text: 'y' }))).toMatch(/occurs 2 times/)
    expect(errorOf(await call(client, 'edit_note', { note: 'Twice', old_text: 'zzz', new_text: 'y' }))).toMatch(/not found/)
    expect(await disk('Resources/Twice.md')).toBe('# Twice\n\nx and x\n')
  })

  it('edit_note matches plain line breaks against a CRLF file', async () => {
    await put('Resources/Crlf.md', '# Crlf\r\n\r\nline one\r\nline two\r\n')
    const client = await connect(await open())
    json(await call(client, 'edit_note', { note: 'Crlf', old_text: 'line one\nline two', new_text: 'one\ntwo' }))
    expect(await disk('Resources/Crlf.md')).toBe('# Crlf\r\n\r\none\r\ntwo\r\n')
  })

  it('update_frontmatter sets and removes keys and refuses broken YAML', async () => {
    await put('Resources/Broken.md', '---\ntitle: [oops\n---\n# Broken\n')
    const client = await connect(await open())
    const r = json(await call(client, 'update_frontmatter', { note: 'Value Study', set: { status: 'evergreen', tags: 'drawing, Values' }, remove: ['nothing'] }))
    expect(r.frontmatter).toMatchObject({ status: 'evergreen', tags: ['drawing', 'values'] })
    json(await call(client, 'update_frontmatter', { note: 'Value Study', set: { status: null } }))
    expect(await disk('Resources/Value Study.md')).not.toContain('status')
    expect(errorOf(await call(client, 'update_frontmatter', { note: 'Broken', set: { status: 'x' } }))).toMatch(/not valid YAML/)
    expect(await disk('Resources/Broken.md')).toBe('---\ntitle: [oops\n---\n# Broken\n')
  })

  it('link_notes appends a Related link once', async () => {
    const client = await connect(await open())
    expect(json(await call(client, 'link_notes', { from: 'Loose thought', to: 'Value Study' })).added).toBe(true)
    expect(await disk('Inbox/Loose thought.md')).toBe('# Loose thought\n\nsomething\n\n- Related: [[Value Study]]\n')
    expect(json(await call(client, 'link_notes', { from: 'Loose thought', to: 'Value Study' })).added).toBe(false)
    // An ambiguous title links by path.
    json(await call(client, 'link_notes', { from: 'Loose thought', to: 'Areas/Ideas' }))
    expect(await disk('Inbox/Loose thought.md')).toContain('- Related: [[Value Study]]\n- Related: [[Areas/Ideas|Ideas]]\n')
  })

  it('link_notes refuses a link that could not reach its note', async () => {
    // Saved from Explorer: `#` in a file name starts a heading inside [[…]].
    await put('Resources/Scene #3.md', '# Scene #3\n')
    const client = await connect(await open())
    expect(errorOf(await call(client, 'link_notes', { from: 'Loose thought', to: 'Resources/Scene #3' }))).toMatch(/cannot reach Resources\/Scene #3\.md/)
    expect(await disk('Inbox/Loose thought.md')).toBe(FILES['Inbox/Loose thought.md'])
  })
})

describe('tasks and projects', () => {
  it('add_task then set_task_done writes "[x] … ✅ date"', async () => {
    const client = await connect(await open())
    const added = json(await call(client, 'add_task', { project: 'PORTALz', text: 'block out the gate chamber' }))
    // New tasks join the open ones, above the tasks already ticked off.
    expect(added.task).toMatchObject({ line: 15, text: 'block out the gate chamber', done: false })
    expect(await disk('Projects/PORTALz.md')).toContain('- [ ] Sculpt the hero monolith\n- [ ] block out the gate chamber\n- [x] Pick the palette ✅ 2026-09-20\n')
    const done = json(await call(client, 'set_task_done', { project: 'PORTALz', task: 'gate chamber' }))
    expect(done).toMatchObject({ changed: true, task: { done: true, doneAt: TODAY } })
    expect(await disk('Projects/PORTALz.md')).toContain(`- [x] block out the gate chamber ✅ ${TODAY}\n`)
    expect(json(await call(client, 'set_task_done', { project: 'PORTALz', line: 15 })).changed).toBe(false)
    // Reopen by line.
    json(await call(client, 'set_task_done', { project: 'PORTALz', line: 15, done: false }))
    expect(await disk('Projects/PORTALz.md')).toContain('- [ ] block out the gate chamber\n')
    expect(errorOf(await call(client, 'set_task_done', { project: 'PORTALz', line: 3 }))).toMatch(/not a task/)
    expect(activity.find((e) => e.tool === 'set_task_done')?.summary).toBe('completed "block out the gate chamber"')
  })

  it('edit_task keeps the checkbox and date; delete_task removes one line', async () => {
    const client = await connect(await open())
    json(await call(client, 'edit_task', { project: 'PORTALz', task: 'Pick the palette', text: 'Pick the dusk palette' }))
    expect(await disk('Projects/PORTALz.md')).toContain('- [x] Pick the dusk palette ✅ 2026-09-20\n')
    const r = json(await call(client, 'delete_task', { project: 'PORTALz', line: 14 }))
    expect(r.deleted.text).toBe('Sculpt the hero monolith')
    expect(await disk('Projects/PORTALz.md')).toContain('## To do\n\n- [x] Pick the dusk palette ✅ 2026-09-20\n\n## Notes')
  })

  it('add_task and delete_task hand back the moved task lines', async () => {
    await put('Projects/Five.md', '---\ntype: project\n---\n# Five\n\n## Now\n\n- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n- [ ] e\n\n## Later\n\n- [ ] l\n')
    const client = await connect(await open())
    const before = json(await call(client, 'get_project', { project: 'Five' })).tasks as { line: number; text: string }[]
    const lineOf = (tasks: { line: number; text: string }[], text: string) => tasks.find((t) => t.text === text)!.line
    // Delete b, then d: d's line from the first listing is stale; the reply has the new one.
    const r1 = json(await call(client, 'delete_task', { project: 'Five', line: lineOf(before, 'b') }))
    expect(lineOf(r1.tasks, 'd')).toBe(lineOf(before, 'd') - 1)
    const r2 = json(await call(client, 'delete_task', { project: 'Five', line: lineOf(r1.tasks, 'd') }))
    expect(r2.deleted.text).toBe('d')
    expect(await disk('Projects/Five.md')).toContain('- [ ] a\n- [ ] c\n- [ ] e\n')
    // A task added to an earlier section moves the later ones down.
    const r3 = json(await call(client, 'add_task', { project: 'Five', text: 'f', section: 'Now' }))
    expect(lineOf(r3.tasks, 'l')).toBe(lineOf(r2.tasks, 'l') + 1)
    // A stale line with the task's text still finds the right task.
    json(await call(client, 'set_task_done', { project: 'Five', line: lineOf(before, 'l'), task: 'l' }))
    expect(await disk('Projects/Five.md')).toContain(`- [x] l ✅ ${TODAY}\n`)
  })

  it('a line-only task call follows its task when the note changed since it was listed', async () => {
    await put('Projects/Gate.md', '---\ntype: project\n---\n# Gate\n\n## To do\n\n- [ ] one\n- [ ] two\n- [ ] three\n')
    const b = await open()
    const client = await connect(b)
    const lineOf = (tasks: { line: number; text: string }[], text: string) => tasks.find((t) => t.text === text)!.line
    const listed = json(await call(client, 'get_project', { project: 'Gate' })).tasks
    // Edited in another editor after the listing; the index has not seen it yet.
    await put('Projects/Gate.md', '---\ntype: project\n---\n# Gate\n\n## To do\n\n- [ ] zero\n- [ ] one\n- [ ] two\n- [ ] three\n')
    const r = json(await call(client, 'delete_task', { project: 'Gate', line: lineOf(listed, 'two') }))
    expect(r.deleted.text).toBe('two')
    expect(await disk('Projects/Gate.md')).toContain('- [ ] zero\n- [ ] one\n- [ ] three\n')
    // The reply's lines are the ones that count now.
    json(await call(client, 'set_task_done', { project: 'Gate', line: lineOf(r.tasks, 'three') }))
    expect(await disk('Projects/Gate.md')).toContain(`- [x] three ✅ ${TODAY}\n`)

    // Edited in the app, and the change already reached the index before the call.
    const again = json(await call(client, 'read_note', { note: 'Gate' })).tasks
    const edited = (await disk('Projects/Gate.md')).replace('- [ ] zero\n', '- [ ] minus one\n- [ ] zero\n')
    await put('Projects/Gate.md', edited)
    b.applyExternal([{ kind: 'change', path: 'Projects/Gate.md', content: edited, mtime: Date.now() }])
    const edit = await call(client, 'edit_task', { project: 'Gate', line: lineOf(again, 'one'), text: 'uno' })
    expect(edit.content[0]?.text).toMatch(/changed since its tasks were listed/)
    const e = json(edit)
    expect(e.task.text).toBe('uno')
    expect(await disk('Projects/Gate.md')).toContain('- [ ] minus one\n- [ ] zero\n- [ ] uno\n')
    // That reply listed the current lines, and those are the ones that count next.
    expect(e.tasks.map((t: { text: string }) => t.text)).toEqual(['minus one', 'zero', 'uno', 'three'])
    json(await call(client, 'set_task_done', { project: 'Gate', line: lineOf(e.tasks, 'uno') }))
    expect(await disk('Projects/Gate.md')).toContain(`- [x] uno ✅ ${TODAY}\n`)
    // Nothing changed in between: the reply stays short.
    expect(json(await call(client, 'set_task_done', { project: 'Gate', line: lineOf(e.tasks, 'zero') })).tasks).toBeUndefined()
  })

  it('refuses a line-only task call when the listed task is gone, and names the current lines', async () => {
    await put('Projects/Gate.md', '---\ntype: project\n---\n# Gate\n\n## To do\n\n- [ ] one\n- [ ] two\n')
    const client = await connect(await open())
    const listed = json(await call(client, 'get_project', { project: 'Gate' })).tasks as { line: number; text: string }[]
    const two = listed.find((t) => t.text === 'two')!.line
    const now = '---\ntype: project\n---\n# Gate\n\n## To do\n\n- [ ] zero\n- [ ] one\n- [ ] deux\n'
    await put('Projects/Gate.md', now)
    const msg = errorOf(await call(client, 'delete_task', { project: 'Gate', line: two }))
    expect(msg).toMatch(/changed since its tasks were listed: the task on line \d+ \("two"\)/)
    expect(msg).toContain(`${two}: [ ] one`)
    expect(await disk('Projects/Gate.md')).toBe(now)
    // The lines the refusal listed are the current ones.
    expect(json(await call(client, 'delete_task', { project: 'Gate', line: two })).deleted.text).toBe('one')
  })

  it('a line only a longer, earlier listing showed still finds its task after a shorter reply', async () => {
    // More tasks than add_task, delete_task and errors list: their replies show only the first ones.
    const many = Array.from({ length: 150 }, (_, i) => `- [ ] t${i}`).join('\n')
    await put('Projects/Big.md', `---\ntype: project\n---\n# Big\n\n## Now\n\n- [ ] first\n\n## To do\n\n${many}\n`)
    const client = await connect(await open())
    const lineOf = (tasks: { line: number; text: string }[], text: string) => tasks.find((t) => t.text === text)?.line
    const listed = json(await call(client, 'get_project', { project: 'Big' })).tasks
    // Added above the To do list: every t<i> moved down a line, and the reply lists only the first 100 tasks.
    const added = json(await call(client, 'add_task', { project: 'Big', text: 'second', section: 'Now' }))
    expect(lineOf(added.tasks, 't140')).toBeUndefined()
    json(await call(client, 'set_task_done', { project: 'Big', line: lineOf(listed, 't140') }))
    expect(await disk('Projects/Big.md')).toContain(`- [ ] t139\n- [x] t140 ✅ ${TODAY}\n- [ ] t141\n`)
    // Lines the short reply did show count as it showed them.
    json(await call(client, 'set_task_done', { project: 'Big', line: lineOf(added.tasks, 't5') }))
    expect(await disk('Projects/Big.md')).toContain(`- [ ] t4\n- [x] t5 ✅ ${TODAY}\n- [ ] t6\n`)
    // An error lists only some tasks; a line from the full listing still finds its task after another edit.
    const edited = (await disk('Projects/Big.md')).replace('- [ ] first\n', '- [ ] zeroth\n- [ ] first\n')
    await put('Projects/Big.md', edited)
    expect(errorOf(await call(client, 'set_task_done', { project: 'Big', task: 'no such task' }))).toMatch(/No task matching/)
    json(await call(client, 'set_task_done', { project: 'Big', line: lineOf(listed, 't120') }))
    expect(await disk('Projects/Big.md')).toContain(`- [ ] t119\n- [x] t120 ✅ ${TODAY}\n- [ ] t121\n`)
  })

  it('lists the lines again when stamping updated: moved them', async () => {
    // A block value: the stamp rewrites it onto one line, so every task moves up a line.
    await put('Projects/Stamp.md', '---\ntype: project\nupdated:\n- 2026-01-01\n---\n# Stamp\n\n## To do\n\n- [ ] a\n- [ ] b\n- [ ] c\n')
    const client = await connect(await open())
    const lineOf = (tasks: { line: number; text: string }[], text: string) => tasks.find((t) => t.text === text)!.line
    const listed = json(await call(client, 'get_project', { project: 'Stamp' })).tasks
    const r = json(await call(client, 'set_task_done', { project: 'Stamp', line: lineOf(listed, 'a') }))
    expect(await disk('Projects/Stamp.md')).toContain(`---\n# Stamp\n\n## To do\n\n- [x] a ✅ ${TODAY}\n- [ ] b\n- [ ] c\n`)
    expect(lineOf(r.tasks, 'b')).toBe(lineOf(listed, 'b') - 1)
    json(await call(client, 'set_task_done', { project: 'Stamp', line: lineOf(r.tasks, 'b') }))
    // A line from the listing before the move still means its task.
    json(await call(client, 'edit_task', { project: 'Stamp', line: lineOf(listed, 'c'), text: 'see' }))
    expect(await disk('Projects/Stamp.md')).toContain(`- [x] a ✅ ${TODAY}\n- [x] b ✅ ${TODAY}\n- [ ] see\n`)
  })

  it('update_project renames and keeps the old title as an alias', async () => {
    const client = await connect(await open())
    const r = json(await call(client, 'update_project', { project: 'PORTALz', title: 'PORTALz Reborn', status: 'paused', summary: 'Gates, reborn.' }))
    expect(r.project).toMatchObject({ title: 'PORTALz Reborn', status: 'paused', summary: 'Gates, reborn.' })
    const text = await disk('Projects/PORTALz.md')
    expect(text).toContain('title: PORTALz Reborn')
    expect(text).toMatch(/aliases:\n {2}- PORTALz\n|aliases: \[PORTALz\]/)
    expect(text).toContain('# PORTALz Reborn\n\n> Gates, reborn.\n')
    // The old name still resolves (links keep working).
    expect(json(await call(client, 'read_note', { note: 'PORTALz' })).id).toBe('Projects/PORTALz')
    expect(json(await call(client, 'get_project', { project: 'PORTALz Reborn' })).status).toBe('paused')
  })

  it('update_project reports frontmatter it cannot parse instead of rewriting it', async () => {
    await put('Projects/Bad.md', '---\ntitle: [x\n---\n# Bad\n')
    const client = await connect(await open())
    expect(errorOf(await call(client, 'update_project', { project: 'Projects/Bad', status: 'active' }))).toMatch(/Could not update Projects\/Bad\.md: .*not valid YAML/)
    expect(await disk('Projects/Bad.md')).toBe('---\ntitle: [x\n---\n# Bad\n')
  })

  it('create_folder makes a real planet folder inside a project', async () => {
    const client = await connect(await open())
    const r = json(await call(client, 'create_folder', { project: 'PORTALz', path: 'Sound' }))
    expect(r).toMatchObject({ path: 'Projects/PORTALz/Sound', created: true })
    expect(await isDir('Projects/PORTALz/Sound')).toBe(true)
    expect(json(await call(client, 'get_project', { project: 'PORTALz' })).planets.map((p: { name: string }) => p.name)).toEqual(['Art', 'Design', 'Sound'])
    expect(json(await call(client, 'create_folder', { project: 'PORTALz', path: 'Sound' })).created).toBe(false)
    // Plain paths keep the existing spelling of their parents.
    expect(json(await call(client, 'create_folder', { path: 'projects/conceptforge/Drills' })).path).toBe('Projects/ConceptForge/Drills')
    expect(await isDir('Projects/ConceptForge/Drills')).toBe(true)
    expect(activity.find((e) => e.tool === 'create_folder')).toMatchObject({ write: true, path: 'Projects/PORTALz/Sound' })
  })

  it('create_project makes the note, its home folder and its tasks; a folder can become a project', async () => {
    const client = await connect(await open())
    const r = json(await call(client, 'create_project', { title: 'Sound Lab', summary: 'Audio experiments', tasks: ['Record the hum'] }))
    expect(r).toMatchObject({ project: { path: 'Projects/Sound Lab.md' }, folder: 'Projects/Sound Lab' })
    expect(await isDir('Projects/Sound Lab')).toBe(true)
    const p = json(await call(client, 'get_project', { project: 'Sound Lab' }))
    expect(p).toMatchObject({ summary: 'Audio experiments', folder: 'Projects/Sound Lab', folderExists: true })
    expect(p.tasks.map((t: { text: string }) => t.text)).toEqual(['Record the hum'])
    expect(errorOf(await call(client, 'create_project', { title: 'sound lab' }))).toMatch(/already exists/)

    json(await call(client, 'create_folder', { path: 'Art/Monsters' }))
    const m = json(await call(client, 'create_project', { folder: 'Art/Monsters', tasks: ['Sketch the brute'] }))
    expect(m).toMatchObject({ project: { path: 'Art/Monsters/Monsters.md', title: 'Monsters' }, folder: 'Art/Monsters' })
    const mp = json(await call(client, 'get_project', { project: 'Monsters' }))
    expect(mp.tasks.map((t: { text: string }) => t.text)).toEqual(['Sketch the brute'])
  })
})

describe('daily brief', () => {
  const yesterday = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return todayIso(d)
  })()
  const tomorrow = nextDay(TODAY)

  beforeEach(async () => {
    await put('Projects/PORTALz/Design/Gate.md', `# Gate\n\n- [ ] Paint the gate 📅 ${yesterday}\n- [ ] Light pass ⏳ ${TODAY}\n- [x] Done already 📅 ${TODAY} ✅ ${TODAY}\n- [ ] Later 📅 ${tomorrow}\n`)
    await put(`Daily/${TODAY}.md`, `# ${TODAY}\n\n- [ ] Call the printer\n`)
    await put('Inbox/Errands.md', '# Errands\n\n- [ ] Buy ink #today\n- [ ] Some day\n')
    await put('Inbox/Invoices.md', `# Invoices\n\n- [ ] Send the invoice [due:: ${TODAY}]\n`)
    await put('Archive/Old.md', `# Old\n\n- [ ] Ancient 📅 ${yesterday}\n`)
    await put('Projects/Gate Kit.md', '---\ntype: project\nstatus: active\n---\n# Gate Kit\n\n## To do\n\n- [ ] Model the hinge\n- [ ] Rig it\n')
  })

  it("lists what is overdue, what is on for today and what is next, with each task's note, line and project", async () => {
    const client = await connect(await open())
    const r = await call(client, 'daily_brief')
    expect(r.content[0]!.text).toMatch(new RegExp(`^Today \\(${TODAY}\\): 1 overdue, 4 for the day, 1 next up\\. .*set_task_done`))
    const b = json(r)
    expect(b.date).toBe(TODAY)
    expect(b.total).toBe(6)
    expect(b.overdue).toEqual([
      {
        task: 'Paint the gate',
        text: `Paint the gate 📅 ${yesterday}`,
        note: 'Gate',
        path: 'Projects/PORTALz/Design/Gate.md',
        line: 2,
        project: 'PORTALz',
        due: yesterday,
        scheduled: null,
        reason: 'overdue',
      },
    ])
    expect(b.today.map((t: { task: string; reason: string }) => [t.task, t.reason])).toEqual([
      ['Send the invoice', 'due'],
      ['Light pass', 'scheduled'],
      ['Call the printer', 'daily'],
      ['Buy ink #today', 'flagged'],
    ])
    expect(b.today[2]).toMatchObject({ path: `Daily/${TODAY}.md`, project: null, line: 2 })
    // PORTALz has a task above already; the paused ConceptForge is not proposed; Archive never counts.
    expect(b.next).toEqual([expect.objectContaining({ task: 'Model the hinge', path: 'Projects/Gate Kit.md', project: 'Gate Kit', reason: 'next', line: 8 })])
    expect(JSON.stringify(b)).not.toMatch(/Ancient|Done already|Later|Some day/)
    expect(b.howToTick).toMatch(/set_task_done.*path.*line/)
    expect(activity.at(-1)).toMatchObject({ tool: 'daily_brief', summary: "looked at today's brief", path: null, write: false })
    expect(client.getInstructions()).toMatch(/daily_brief.*set_task_done/)
  })

  it("ticks a row off with set_task_done (the row's path and line), even after its note changed", async () => {
    const client = await connect(await open())
    const [row] = json(await call(client, 'daily_brief')).overdue
    // Edited in another app since the brief was listed: the task moved down a line.
    const before = await disk('Projects/PORTALz/Design/Gate.md')
    await put('Projects/PORTALz/Design/Gate.md', before.replace('# Gate\n', '# Gate\nPainted in Krita.\n'))
    const done = json(await call(client, 'set_task_done', { project: row.path, line: row.line }))
    expect(done).toMatchObject({ changed: true, task: { text: row.text, done: true, line: 3 } })
    expect(await disk('Projects/PORTALz/Design/Gate.md')).toContain(`- [x] Paint the gate 📅 ${yesterday} ✅ ${TODAY}\n`)
    const after = json(await call(client, 'daily_brief'))
    expect(after.overdue).toEqual([])
    expect(after.total).toBe(5)
  })

  it('answers for another day, and refuses a date that is not a real day', async () => {
    const client = await connect(await open())
    const r = await call(client, 'daily_brief', { date: tomorrow })
    expect(r.content[0]!.text).toMatch(new RegExp(`^The brief for ${tomorrow}: 2 overdue`))
    const b = json(r)
    expect(b.date).toBe(tomorrow)
    expect(b.today.map((t: { task: string; reason: string }) => [t.task, t.reason])).toContainEqual(['Later', 'due'])
    expect(activity.at(-1)?.summary).toBe(`looked at the brief for ${tomorrow}`)
    for (const date of ['2026-02-30', 'tomorrow', '2026-9-30', '']) {
      expect(errorOf(await call(client, 'daily_brief', { date })), date).toMatch(/YYYY-MM-DD/)
    }
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === 'daily_brief')?.inputSchema.properties?.['date']).toMatchObject({ type: 'string', pattern: expect.stringContaining('\\d{4}') })
  })

  it('does not point a read-only link at set_task_done', async () => {
    const client = await connect(await open(), true)
    const r = await call(client, 'daily_brief')
    expect(r.content[0]!.text).not.toMatch(/set_task_done/)
    expect(json(r).total).toBe(6)
  })

  it('says so when there is nothing to do', async () => {
    const empty = path.join(tmp, 'empty')
    await put('a.md', '# A\n\n- [x] All done ✅ 2026-01-01\n', empty)
    const client = await connect(await open({ roots: [empty] }))
    const r = await call(client, 'daily_brief')
    expect(r.content[0]!.text).toMatch(/nothing is overdue, due or planned/)
    expect(json(r)).toMatchObject({ total: 0, overdue: [], today: [], next: [] })
  })
})

describe('save_chat', () => {
  const messages = [
    { role: 'user', text: 'How should the gate glow? - [ ] not a task #nottag' },
    { role: 'assistant', text: 'Rim light, then bloom.\n\n- [ ] also not a task\n\nLike [[Glyphs]].' },
  ]

  it('saves the conversation as a chat note: summary on top (live), transcript below (inert)', async () => {
    const client = await connect(await open())
    const r = await call(client, 'save_chat', { source: 'claude', title: 'Gate glow', summary: 'Rim light wins.\n\n- [ ] Try bloom on [[PORTALz]]', messages })
    const n = json(r)
    const rel = `Resources/AI Chats/Claude/${TODAY} Gate glow.md`
    expect(n).toMatchObject({ path: rel, title: `${TODAY} Gate glow`, updated: false })
    const text = await disk(rel)
    expect(text).toMatch(/^---\ntitle: \d{4}-\d{2}-\d{2} Gate glow\ntags: \[ai-chat, claude\]/)
    expect(text).toContain('## Summary\n\nRim light wins.')
    expect(text).toContain('## Transcript\n\n*2 messages')
    expect(text).toContain('### You\n\n> How should the gate glow? - [ ] not a task \\#nottag')
    expect(text).toContain('> - \\[ ] also not a task')
    expect(text).toContain('> Like \\[\\[Glyphs\\]\\].')
    // Only the summary's task and link count.
    const note = json(await call(client, 'read_note', { note: rel }))
    expect(note.tasks.map((t: { text: string }) => t.text)).toEqual(['Try bloom on [[PORTALz]]'])
    expect(note.links.map((l: { title: string }) => l.title)).toEqual(['PORTALz'])
    expect(activity.find((x) => x.tool === 'save_chat')).toMatchObject({ summary: `saved the chat "${TODAY} Gate glow"`, path: rel, write: true })
    expect(client.getInstructions()).toMatch(/save_chat/)
  })

  it("files into a project's AI Chats planet, and ChatGPT's chats under ChatGPT", async () => {
    const client = await connect(await open())
    const a = json(await call(client, 'save_chat', { source: 'claude', title: 'Hero monolith', project: 'PORTALz', messages }))
    expect(a.path).toBe(`Projects/PORTALz/AI Chats/${TODAY} Hero monolith.md`)
    expect(await disk(a.path)).toContain('Project: [[PORTALz]]')
    const b = json(await call(client, 'save_chat', { title: 'Hero monolith', source: 'chatgpt', messages }))
    // Another chat of the same name gets its own title (links find notes by title).
    expect(b.path).toBe(`Resources/AI Chats/ChatGPT/${TODAY} Hero monolith 2.md`)
    expect(await disk(b.path)).toContain('### ChatGPT')
  })

  it("with the chat's web address, saving again updates the same note and keeps what was written above the transcript", async () => {
    const client = await connect(await open())
    const url = 'https://claude.ai/chat/0f3c2b1a-aaaa-bbbb-cccc-1234567890ab'
    const first = json(await call(client, 'save_chat', { source: 'claude', title: 'Gate glow', url, messages }))
    const before = await disk(first.path)
    expect(before).toContain(`Source: <${url}>`)
    await put(first.path, before.replace('## Transcript', 'My own note.\n\n## Transcript'))
    const more = [...messages, { role: 'user', text: 'And the fog?' }]
    const second = json(await call(client, 'save_chat', { source: 'claude', title: 'Renamed', url, messages: more }))
    expect(second).toMatchObject({ path: first.path, updated: true })
    const after = await disk(first.path)
    expect(after).toContain('My own note.')
    expect(after).toContain('And the fog?')
    expect(after).toContain('*3 messages')
    expect(activity.at(-1)?.summary).toMatch(/^updated the chat/)
  })

  it('refuses a wrong address, an empty chat and one too long for a call', async () => {
    const client = await connect(await open())
    expect(errorOf(await call(client, 'save_chat', { source: 'claude', title: 'x', url: 'https://evil.example/c/1', messages }))).toMatch(/web address/)
    expect(errorOf(await call(client, 'save_chat', { source: 'claude', title: 'x', messages: [] }))).toMatch(/Nothing to save/)
    const big = Array.from({ length: 12 }, () => ({ role: 'user', text: 'x'.repeat(190_000) }))
    expect(errorOf(await call(client, 'save_chat', { source: 'claude', title: 'x', messages: big }))).toMatch(/too long/)
    expect(existsSync(path.join(root, 'Resources', 'AI Chats'))).toBe(false)
  })

  it('asks an unknown client which assistant it is', async () => {
    const client = await connect(await open())
    expect(errorOf(await call(client, 'save_chat', { title: 'x', messages }))).toMatch(/source "claude" or "chatgpt"/)
    const { tools } = await client.listTools()
    // It can rewrite a chat note: clients that ask before destructive tools ask for this one.
    expect(tools.find((t) => t.name === 'save_chat')?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false })
  })

  it('a chat quoting another chat\'s address never gets overwritten by it', async () => {
    const client = await connect(await open())
    const urlA = 'https://claude.ai/chat/aaaaaaaa-0000-0000-0000-000000000001'
    const urlB = 'https://claude.ai/chat/bbbbbbbb-0000-0000-0000-000000000002'
    const a = json(await call(client, 'save_chat', { source: 'claude', title: 'Chat A', url: urlA, summary: `See Source: <${urlB}>`, messages: [{ role: 'user', text: `Look:\n\nSource: <${urlB}>\n\n\`\`\`md\nSource: <${urlB}>\n\`\`\`` }] }))
    const before = await disk(a.path)
    const b = json(await call(client, 'save_chat', { source: 'claude', title: 'Chat B', url: urlB, messages }))
    expect(b).toMatchObject({ updated: false })
    expect(b.path).not.toBe(a.path)
    expect(await disk(a.path)).toBe(before)
  })

  it("updating keeps a longer transcript, replaces the summary, and never touches a note that isn't a chat note", async () => {
    const client = await connect(await open())
    const url = 'https://chatgpt.com/c/6650aa11-bb22-cc33'
    const first = json(await call(client, 'save_chat', { source: 'chatgpt', title: 'Fog', url, summary: 'Old summary', messages: [...messages, { role: 'user', text: 'third' }] }))
    // An AI's follow-up appended after the transcript survives the next save.
    await call(client, 'append_to_note', { note: first.path, text: '## Follow-up\n\n- [ ] try fog cards' })
    const r = json(await call(client, 'save_chat', { source: 'chatgpt', title: 'Fog', url: 'https://chat.openai.com/c/6650aa11-bb22-cc33', summary: 'New summary', messages: [] }))
    expect(r).toMatchObject({ path: first.path, updated: true, transcript: 'kept' })
    const text = await disk(first.path)
    expect(text).toContain('## Summary\n\nNew summary')
    expect(text).not.toContain('Old summary')
    expect(text).toContain('*3 messages')
    expect(text).toContain('- [ ] try fog cards')
    // Fewer messages than the note holds: the transcript stays.
    json(await call(client, 'save_chat', { source: 'chatgpt', title: 'Fog', url, messages: [{ role: 'user', text: 'short' }] }))
    expect(await disk(first.path)).toContain('*3 messages')
    // A user's note that carries a chat address in its header is not a chat note: a new note is made.
    const meeting = 'Areas/Meeting.md'
    const mine = '# Meeting\n\nSource: <https://claude.ai/chat/cccccccc-0000-0000-0000-000000000003>\n\n## Transcript\n\nmy notes\n\n## My follow-ups\n\n- [ ] call Sam\n'
    await put(meeting, mine)
    const b = await open()
    const client2 = await connect(b)
    const r2 = json(await call(client2, 'save_chat', { source: 'claude', title: 'Meeting chat', url: 'https://claude.ai/chat/cccccccc-0000-0000-0000-000000000003', messages }))
    expect(r2.path).not.toBe(meeting)
    expect(await disk(meeting)).toBe(mine)
  })

  it('a crafted chat cannot stall the link: runs of * and unclosed comments cost milliseconds, and stay inert', async () => {
    const client = await connect(await open())
    const t = Date.now()
    const r = json(await call(client, 'save_chat', { source: 'claude', title: 'Stress', messages: [{ role: 'user', text: '*a'.repeat(20000) }, { role: 'assistant', text: `${'<!--\n'.repeat(60)}- [ ] LIVE TASK 📅 ${TODAY}\n` }] }))
    expect(Date.now() - t).toBeLessThan(5000)
    const note = json(await call(client, 'read_note', { note: r.path }))
    expect(note.tasks).toEqual([])
    expect(JSON.stringify(json(await call(client, 'daily_brief')))).not.toContain('LIVE TASK')
  })

  it('says when a message was cut, and names a new chat so no note already answers to that name', async () => {
    const client = await connect(await open())
    await put('Areas/Aliased.md', `---\naliases: [${TODAY} Gate glow]\n---\n# Aliased\n`)
    await put(`Areas/${TODAY} Fog.md`, '# Something else\n')
    const b = await open()
    const client2 = await connect(b)
    const a = json(await call(client2, 'save_chat', { source: 'claude', title: 'Gate glow', messages: [{ role: 'user', text: 'x'.repeat(150_000) }] }))
    expect(a.title).toBe(`${TODAY} Gate glow 2`)
    expect(a.cut).toBe(1)
    const r = await call(client2, 'save_chat', { source: 'claude', title: 'Fog', messages })
    expect(json(r).title).toBe(`${TODAY} Fog 2`)
    void client
  })
})

describe('create-only notes', () => {
  it('a new note never lands on a file the index has not seen, in any letter case', async () => {
    const client = await connect(await open())
    // Written by another app after the load and not reported yet; on Windows and macOS
    // `Buy milk.md` would be this very file.
    await put('Inbox/buy milk.md', '# buy milk\n\nfrom the phone\n')
    expect(json(await call(client, 'capture', { text: 'Buy milk' })).path).toBe('Inbox/Buy milk 2.md')
    expect(json(await call(client, 'create_note', { title: 'BUY MILK' })).path).toBe('Inbox/BUY MILK 3.md')
    expect(await disk('Inbox/buy milk.md')).toBe('# buy milk\n\nfrom the phone\n')
    expect((await fs.readdir(path.join(root, 'Inbox'))).sort()).toEqual(['BUY MILK 3.md', 'Buy milk 2.md', 'Loose thought.md', 'buy milk.md'])
  })

  it('never replaces repo boilerplate the scan skips, whatever its case', async () => {
    await put('Code/Game/CHANGELOG.md', '# Changelog\n\n## 1.0\n- important history\n')
    const client = await connect(await open())
    const r = json(await call(client, 'create_note', { title: 'Changelog', folder: 'Code/Game' }))
    expect(r.path).toBe('Code/Game/Changelog 2.md')
    expect(await disk('Code/Game/CHANGELOG.md')).toBe('# Changelog\n\n## 1.0\n- important history\n')
    expect((await fs.readdir(path.join(root, 'Code', 'Game'))).sort()).toEqual(['CHANGELOG.md', 'Changelog 2.md'])
  })

  it('create_project refuses a folder note that exists on disk but not in the index', async () => {
    const client = await connect(await open())
    await put('Art/Monsters/monsters.md', '# monsters\n\nmine\n')
    expect(errorOf(await call(client, 'create_project', { folder: 'Art/Monsters' }))).toMatch(/Art\/Monsters\/Monsters\.md already exists/)
    expect(await fs.readdir(path.join(root, 'Art', 'Monsters'))).toEqual(['monsters.md'])
    expect(await disk('Art/Monsters/monsters.md')).toBe('# monsters\n\nmine\n')
    // A new project note takes the next free name; its planets' folder follows it.
    await put('Projects/lab.md', '# lab\n')
    const lab = json(await call(client, 'create_project', { title: 'Lab' }))
    expect(lab).toMatchObject({ project: { path: 'Projects/Lab 2.md' }, folder: 'Projects/Lab 2' })
    expect(await disk('Projects/lab.md')).toBe('# lab\n')
  })
})

describe('AI text is scanned in linear time', () => {
  const N = 100_000
  const spaces = ' '.repeat(N)

  it('long whitespace runs in appended text, headings, task text and frontmatter stay fast', async () => {
    const b = await open()
    const t0 = performance.now()
    // What append_to_note, link_notes and create_note run on AI text.
    expect(appendText('# A\n', `# a${spaces}x`)).toBe(`# A\n\n# a${spaces}x\n`)
    expect(appendText(`# A\n\n## Notes${spaces}x\n`, 'more', 'Notes')).toContain('## Notes\n\nmore\n')
    expect(appendText('# A\n', `text${spaces}`)).toBe('# A\n\ntext\n')
    await b.appendToNote('Loose thought', `# a${spaces}x`)
    await b.addTask('PORTALz', `long${spaces}x`)
    await expect(b.createNote({ title: 'Broken', content: `---\n${spaces}x\n---\nbody` })).rejects.toThrow(/not valid YAML/)
    await b.createNote({ title: 'Spacey', content: `body${spaces}` })
    // A long `updated:` value, then an edit that stamps it.
    await put('Resources/Stamp.md', `---\nupdated: a${spaces}x\n---\n# Stamp\n`)
    b.applyExternal([{ kind: 'add', path: 'Resources/Stamp.md', content: await disk('Resources/Stamp.md'), mtime: Date.now() }])
    await b.appendToNote('Stamp', 'more')
    await b.listProjects()
    await b.getProject('PORTALz')
    await b.readNote('Loose thought')
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(await disk('Resources/Stamp.md')).toBe(`---\nupdated: ${TODAY}\n---\n# Stamp\n\nmore\n`)
    expect(await disk('Inbox/Spacey.md')).toMatch(/# Spacey\n\nbody\n$/)
  }, 20_000)

  it('updated: keeps its spacing and comment; a value that is not one plain line is rewritten', async () => {
    await put('Resources/A.md', '---\nupdated: "2026-01-02"  # stamped\n---\n# A\n')
    await put('Resources/B.md', '---\nupdated: 2026-01-02 # stamped\r\ntitle: B\r\n---\r\n# B\r\n')
    await put('Resources/C.md', '---\nupdated: [2026-01-02]\n---\n# C\n')
    // Values on the lines below the key: stamping only the key line would break the YAML
    // (D, E: the other keys are lost) or glue the old value on (F).
    await put('Resources/D.md', '---\nupdated:\n- 2026-01-02\ntype: project\n---\n# D\n')
    await put('Resources/E.md', '---\nupdated:\n  - 2026-01-02\ntags: [x]\n---\n# E\n')
    await put('Resources/F.md', '---\nupdated: 2026-01-02\n  and more\n---\n# F\n')
    const client = await connect(await open())
    for (const note of ['A', 'B', 'C', 'D', 'E', 'F']) json(await call(client, 'append_to_note', { note, text: 'x' }))
    expect(await disk('Resources/A.md')).toMatch(new RegExp(`^---\\nupdated: ${TODAY}  # stamped\\n---\\n`))
    expect(await disk('Resources/B.md')).toMatch(new RegExp(`^---\\nupdated: ${TODAY} # stamped\\r\\ntitle: B\\r\\n---`))
    expect(await disk('Resources/C.md')).toMatch(new RegExp(`updated: ['"]?${TODAY}['"]?\\n`))
    const props = async (note: string) => json(await call(client, 'read_note', { note })).frontmatter
    expect(await props('D')).toEqual({ updated: TODAY, type: 'project' })
    expect(await props('E')).toEqual({ updated: TODAY, tags: ['x'] })
    expect(await props('F')).toEqual({ updated: TODAY })
  })

  it('caps the size of text arguments', async () => {
    const client = await connect(await open())
    expect((await call(client, 'create_note', { title: 'Huge', content: 'x'.repeat(MAX_TEXT_ARG + 1) })).isError).toBe(true)
    expect((await call(client, 'append_to_note', { note: 'Home', text: 'x'.repeat(MAX_TEXT_ARG + 1) })).isError).toBe(true)
    expect((await call(client, 'edit_note', { note: 'Home', old_text: 'Start', new_text: 'x'.repeat(MAX_TEXT_ARG + 1) })).isError).toBe(true)
    expect((await call(client, 'add_task', { project: 'PORTALz', text: 'x'.repeat(MAX_LINE_ARG + 1) })).isError).toBe(true)
    expect((await call(client, 'update_frontmatter', { note: 'Home', set: { big: 'x'.repeat(MAX_TEXT_ARG + 1) } })).isError).toBe(true)
    expect(existsSync(path.join(root, 'Inbox', 'Huge.md'))).toBe(false)
    expect(await disk('Home.md')).toBe(FILES['Home.md'])
    expect(await disk('Projects/PORTALz.md')).toBe(PORTALZ)
    // Right at the cap is fine.
    expect(json(await call(client, 'create_note', { title: 'Big', content: 'x'.repeat(MAX_TEXT_ARG) })).path).toBe('Inbox/Big.md')
  })

  it('edit_note counts overlapping matches only as far as it needs to', async () => {
    await put('Resources/Aaa.md', `# Aaa\n\n${'a'.repeat(200_000)}\n`)
    const client = await connect(await open())
    const t0 = performance.now()
    expect(errorOf(await call(client, 'edit_note', { note: 'Aaa', old_text: 'a'.repeat(100_000), new_text: 'b' }))).toMatch(/occurs 50 or more times/)
    expect(performance.now() - t0).toBeLessThan(3000)
  })
})

describe('the jail', () => {
  it('rejects path escapes and skipped folders', async () => {
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(outside)
    const client = await connect(await open())
    const attempts: [string, Record<string, unknown>][] = [
      ['create_folder', { path: '../outside/x' }],
      ['create_folder', { path: '.hidden/x' }],
      ['create_folder', { path: 'node_modules/x' }],
      ['create_folder', { path: outside }],
      ['create_note', { title: 'x', folder: '../outside' }],
      ['create_note', { title: 'x', folder: '/etc' }],
      ['create_note', { title: 'x', folder: 'Build' }],
      ['append_to_note', { note: 'file:///etc/passwd', text: 'x' }],
      ['create_folder', { project: 'PORTALz', path: '../../..' }],
    ]
    for (const [name, args] of attempts) expect((await call(client, name, args)).isError, `${name} ${JSON.stringify(args)}`).toBe(true)
    expect(await fs.readdir(outside)).toEqual([])
    expect(existsSync(path.join(root, '.hidden', 'x'))).toBe(false)
    expect(existsSync(path.join(root, 'Build'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('never writes through a symlink that leaves the vault', async () => {
    const outside = path.join(tmp, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(root, 'Escape'))
    const client = await connect(await open())
    expect((await call(client, 'create_note', { title: 'x', folder: 'Escape' })).isError).toBe(true)
    expect((await call(client, 'create_folder', { path: 'Escape/inner' })).isError).toBe(true)
    expect(await fs.readdir(outside)).toEqual([])
  })
})

describe('multi-root', () => {
  it('mounts each root as a top folder and writes new notes under the first', async () => {
    const alpha = path.join(tmp, 'Alpha')
    const beta = path.join(tmp, 'Beta')
    await put('Notes/Far note.md', '# Far note\n\nOn the second drive.\n', beta)
    await put('Projects/Gate.md', '---\ntype: project\n---\n# Gate\n\n## To do\n\n- [ ] Open it\n', alpha)
    brain = await Brain.open({ roots: [alpha, beta], watch: false })
    expect(brain.home).toBe('Alpha/')
    const client = await connect(brain)
    const top = json(await call(client, 'list_folder', {}))
    expect(top.folder.children.map((c: { path: string; kind: string }) => [c.path, c.kind])).toEqual([
      ['Alpha', 'mount'],
      ['Beta', 'mount'],
    ])
    expect(json(await call(client, 'create_note', { title: 'Multi' })).path).toBe('Alpha/Inbox/Multi.md')
    expect(await disk('Inbox/Multi.md', alpha)).toContain('# Multi')
    expect(json(await call(client, 'read_note', { note: 'Beta/Notes/Far note.md' })).title).toBe('Far note')
    expect(json(await call(client, 'read_note', { note: 'Notes/Far note' })).id).toBe('Beta/Notes/Far note')
    expect(json(await call(client, 'create_folder', { path: 'Art' })).path).toBe('Alpha/Art')
    expect(json(await call(client, 'create_folder', { path: 'beta/Art' })).path).toBe('Beta/Art')
    expect(await isDir('Art', beta)).toBe(true)
    expect(json(await call(client, 'list_projects')).projects[0]).toMatchObject({ id: 'Alpha/Projects/Gate' })
    expect((await call(client, 'create_folder', { path: 'Alpha' })).isError).toBe(true)
  })

  it('writes a project folder relative to its drive, so it still binds with the drive alone', async () => {
    const alpha = path.join(tmp, 'Alpha')
    const beta = path.join(tmp, 'Beta')
    await put('Projects/Gate.md', '---\ntype: project\n---\n# Gate\n', alpha)
    await put('Notes/x.md', '# x\n', beta)
    brain = await Brain.open({ roots: [alpha, beta], watch: false })
    const client = await connect(brain)
    expect(json(await call(client, 'update_project', { project: 'Gate', folder: 'Art/Gate' })).project).toMatchObject({ folder: 'Alpha/Art/Gate', folderExists: true })
    expect(json(await call(client, 'create_project', { title: 'Far', folder: 'Beta/Notes' })).folder).toBe('Beta/Notes')
    expect(await disk('Projects/Gate.md', alpha)).toContain('folder: Art/Gate\n')
    expect(await disk('Projects/Far.md', alpha)).toContain('folder: Beta/Notes\n')
    brain.close()
    // Beta unplugged: Alpha alone is a single-root vault without the `Alpha/` prefix.
    brain = await Brain.open({ roots: [alpha], watch: false })
    const solo = await connect(brain)
    expect(json(await call(solo, 'get_project', { project: 'Gate' })).folder).toBe('Art/Gate')
    expect(json(await call(solo, 'get_project', { project: 'Gate' })).folderExists).toBe(true)
  })
})

describe('keeping current', () => {
  it('applyExternal feeds host changes in lazily and idempotently', async () => {
    const b = await open()
    const client = await connect(b)
    const change = { kind: 'add' as const, path: 'Inbox/From the app.md', content: '# From the app\n\nzebra crossing\n', mtime: Date.now() }
    b.applyExternal([change])
    b.applyExternal([change])
    expect(json(await call(client, 'search_notes', { query: 'zebra' })).hits.map((h: { id: string }) => h.id)).toEqual(['Inbox/From the app'])
    b.applyExternal([{ kind: 'unlink', path: 'Inbox/From the app.md' }, { kind: 'addDir', path: 'Resources/New' }])
    expect(json(await call(client, 'search_notes', { query: 'zebra' })).hits).toEqual([])
    expect(json(await call(client, 'list_folder', { path: 'Resources' })).folder.children.map((c: { name: string }) => c.name)).toContain('New')
  })

  it('a watching brain sees edits made on disk', async () => {
    const b = await open({ watch: true })
    const client = await connect(b)
    await new Promise((r) => setTimeout(r, 100))
    await put('Inbox/Dropped in.md', '# Dropped in\n\nquokka\n')
    const start = Date.now()
    let ids: string[] = []
    while (Date.now() - start < 5000) {
      ids = json(await call(client, 'search_notes', { query: 'quokka' })).hits.map((h: { id: string }) => h.id)
      if (ids.length) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(ids).toEqual(['Inbox/Dropped in'])
  })

  it('a watching brain indexes what changes on disk while it is still loading', async () => {
    const readAll = FsVault.prototype.readAll
    // Between the scan and the end of the load (minutes on a whole drive): a note
    // edited after it was read, and a note created after its folder was scanned.
    vi.spyOn(FsVault.prototype, 'readAll').mockImplementation(async function (this: FsVault, ...args: Parameters<FsVault['readAll']>) {
      const files = await readAll.apply(this, args)
      await put('Projects/PORTALz.md', PORTALZ.replace('## To do\n\n', '## To do\n\n- [ ] Added during the load\n'))
      await put('Projects/New during load.md', '# New during load\n\nwombat\n')
      return files
    })
    const b = await open({ watch: true })
    const client = await connect(b)
    const start = Date.now()
    let tasks: string[] = []
    let hits: string[] = []
    while (Date.now() - start < 5000) {
      tasks = json(await call(client, 'get_project', { project: 'PORTALz' })).tasks.map((t: { text: string }) => t.text)
      hits = json(await call(client, 'search_notes', { query: 'wombat' })).hits.map((h: { id: string }) => h.id)
      if (tasks.includes('Added during the load') && hits.length) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(tasks).toContain('Added during the load')
    expect(hits).toEqual(['Projects/New during load'])
  }, 10_000)

  it('ignores picture changes from the host, but not a folder whose name looks like a picture', async () => {
    const b = await open()
    const client = await connect(b)
    const derived = () => (b as unknown as { idx(): unknown }).idx()
    json(await call(client, 'vault_overview'))
    const before = derived()
    const t = Date.now()
    b.applyExternal([
      { kind: 'add', path: 'Renders/Frames/f001.png', mtime: t, size: 10 },
      { kind: 'change', path: 'Projects/PORTALz/Art/gate.JPG', mtime: t, size: 20 },
      { kind: 'unlink', path: 'Resources/old.webp' },
    ])
    json(await call(client, 'vault_overview'))
    // Nothing was applied: the index is the one from before (a folder of renders never rebuilds it).
    expect(derived()).toBe(before)
    expect(errorOf(await call(client, 'list_folder', { path: 'Renders' }))).toMatch(/Renders/)
    b.applyExternal([{ kind: 'addDir', path: 'Resources/Refs.png' }])
    expect(json(await call(client, 'list_folder', { path: 'Resources' })).folder.children.map((c: { name: string }) => c.name)).toContain('Refs.png')
  })

  it('a note edit reuses the folder tables; a folder change rebuilds them', async () => {
    const b = await open()
    const client = await connect(b)
    // What a tool call derives, seen from inside (on a whole drive the folder tables are the expensive part).
    const tables = () => (b as unknown as { idx(): { children: unknown; foldersLower: unknown } }).idx()
    json(await call(client, 'vault_overview'))
    const before = tables()
    b.applyExternal([{ kind: 'change', path: 'Home.md', content: '# Home\n\nchanged\n', mtime: Date.now() }])
    json(await call(client, 'append_to_note', { note: 'Loose thought', text: 'more' }))
    const after = tables()
    expect(after).not.toBe(before)
    expect(after.children).toBe(before.children)
    expect(after.foldersLower).toBe(before.foldersLower)
    json(await call(client, 'create_folder', { path: 'Resources/Fresh' }))
    expect(tables().children).not.toBe(before.children)
    expect(json(await call(client, 'list_folder', { path: 'Fresh' })).folder.path).toBe('Resources/Fresh')
  })

  it('serializes parallel writes to one note', async () => {
    const client = await connect(await open())
    await Promise.all(['one', 'two', 'three', 'four'].map((t) => call(client, 'add_task', { project: 'PORTALz', text: `Parallel ${t}` })))
    const tasks = json(await call(client, 'get_project', { project: 'PORTALz' })).tasks.map((t: { text: string }) => t.text)
    for (const t of ['one', 'two', 'three', 'four']) expect(tasks).toContain(`Parallel ${t}`)
  })
})

describe('HTTP link', () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '1' } } }
  const post = (url: string, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(init),
    })

  it('requires the token, answers stateless POSTs and refuses GET', async () => {
    const b = await open()
    const link = await startHttpLink({ brain: b, port: 0, token: TOKEN, readOnly: false, onActivity: (a) => activity.push(a) })
    cleanups.push(() => link.close())
    expect(link.port).toBeGreaterThan(0)
    expect(link.url).toBe(`http://127.0.0.1:${link.port}/mcp/${TOKEN}`)
    const base = `http://127.0.0.1:${link.port}`

    const denied = await post(`${base}/mcp`)
    expect(denied.status).toBe(401)
    expect(await denied.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 } })
    expect((await post(`${base}/mcp/${TOKEN.slice(0, -1)}x`)).status).toBe(401)
    expect((await post(`${base}/mcp/short`)).status).toBe(401)
    expect((await post(`${base}/mcp`, { authorization: 'Bearer nope' })).status).toBe(401)
    expect((await post(`${base}/other`)).status).toBe(404)
    expect((await post(`${base}/.well-known/oauth-protected-resource`)).status).toBe(404)
    const get = await fetch(link.url)
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    expect((await fetch(link.url, { method: 'DELETE' })).status).toBe(405)

    const ok = await post(link.url)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ result: { serverInfo: { name: 'aether-brain' } } })
    expect((await post(`${base}/mcp`, { authorization: `Bearer ${TOKEN}` })).status).toBe(200)
  })

  it('serves a real MCP client (tools, writes, activity with the client name)', async () => {
    const b = await open()
    const link = await startHttpLink({ brain: b, port: 0, token: TOKEN, readOnly: false, onActivity: (a) => activity.push(a) })
    cleanups.push(() => link.close())
    const transport = new StreamableHTTPClientTransport(new URL(link.url), { requestInit: { headers: { 'User-Agent': 'openai-mcp/1.0.0' } } })
    const client = new Client({ name: 'http-test', version: '1.0.0' })
    await client.connect(transport)
    cleanups.push(() => client.close())
    expect((await client.listTools()).tools).toHaveLength(OFFERED.length)
    const r = (await client.callTool({ name: 'search', arguments: { query: 'glyph' } })) as Result
    expect((r.structuredContent as { results: unknown[] }).results.length).toBeGreaterThan(0)
    const c = (await client.callTool({ name: 'capture', arguments: { text: 'Via HTTP' } })) as Result
    expect(json(c).path).toBe('Inbox/Via HTTP.md')
    expect(activity.map((a) => [a.client, a.tool])).toEqual([
      ['ChatGPT', 'search'],
      ['ChatGPT', 'capture'],
    ])
  })

  it('offers read tools only in read-only mode and refuses bad tokens and taken ports', async () => {
    const b = await open()
    const link = await startHttpLink({ brain: b, port: 0, token: TOKEN, readOnly: true })
    cleanups.push(() => link.close())
    const client = new Client({ name: 'ro', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(link.url)))
    cleanups.push(() => client.close())
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('create_note')
    await expect(startHttpLink({ brain: b, port: 0, token: 'short', readOnly: true })).rejects.toThrow(/token/)
    await expect(startHttpLink({ brain: b, port: link.port, token: TOKEN, readOnly: true })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('answers a request target that is not a path with 404', async () => {
    const link = await startHttpLink({ brain: await open(), port: 0, token: TOKEN, readOnly: false })
    cleanups.push(() => link.close())
    const status = await new Promise<string>((resolve, reject) => {
      const s = net.connect(link.port, '127.0.0.1', () => s.write('POST // HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'))
      let data = ''
      s.on('data', (c) => (data += c))
      s.on('end', () => resolve(data.split('\r\n')[0] ?? ''))
      s.on('error', reject)
    })
    expect(status).toBe('HTTP/1.1 404 Not Found')
  })

  it('names clients from the User-Agent', () => {
    expect(clientFromUserAgent('openai-mcp/1.0.0')).toBe('ChatGPT')
    expect(clientFromUserAgent('Claude-User/1.0')).toBe('Claude')
    expect(clientFromUserAgent('python-httpx/0.27')).toBe('AI client')
    expect(clientFromUserAgent(undefined)).toBe('AI client')
  })
})

describe('CLI arguments', () => {
  it('takes --vault, bare folders (as the .mcpb passes them), --read-only=… and --exclude', () => {
    const cli = parseArgs(['--vault', '/a', '--vault=/b', '/c', '--read-only=false', '--exclude', 'Backups', '--exclude=Renders'], {})
    expect(cli.roots).toEqual([path.resolve('/a'), path.resolve('/b'), path.resolve('/c')])
    expect(cli).toMatchObject({ readOnly: false, exclude: ['Backups', 'Renders'], http: false, port: 7457, host: '127.0.0.1', token: null })
    expect(parseArgs(['--read-only=true', '/a'], {}).readOnly).toBe(true)
    expect(parseArgs(['--read-only', '/a'], {}).readOnly).toBe(true)
    expect(parseArgs(['--read-only=', '/a'], {}).readOnly).toBe(false)
  })

  it('takes --hide and --keep, one folder each', () => {
    const cli = parseArgs(['--vault', '/a', '--hide', '/a/Weird, stuff', '--keep=/a/Games/Mod', '--hide', ''], {})
    expect([cli.hidden, cli.keep]).toEqual([['/a/Weird, stuff'], ['/a/Games/Mod']])
  })

  it('skips empty values and unexpanded placeholders, falls back to AETHER_VAULT', () => {
    expect(parseArgs(['--read-only=${user_config.read_only}', '${user_config.vaults}', ''], {}).roots).toEqual([])
    expect(parseArgs([], { AETHER_VAULT: ['/x', '/y'].join(path.delimiter) }).roots).toEqual([path.resolve('/x'), path.resolve('/y')])
  })

  it('--exclude takes one exact name; --exclude-list takes comma-separated names (the extension setting)', () => {
    expect(parseArgs(['/a', '--exclude', 'Taxes, 2024', '--exclude-list=Private, Salary ,,', '--exclude-list', 'Old'], {}).exclude).toEqual(['Taxes, 2024', 'Private', 'Salary', 'Old'])
    // Left empty, or not expanded by the client.
    expect(parseArgs(['/a', '--exclude-list=', '--exclude-list=${user_config.exclude}'], {}).exclude).toEqual([])
  })

  it('skips a root that is missing (an unplugged drive) and fails only when none is left', async () => {
    const warnings: string[] = []
    const missing = path.join(tmp, 'F-drive')
    await fs.writeFile(path.join(tmp, 'file.md'), '# not a folder\n')
    expect(await usableRoots([root, missing, path.join(tmp, 'file.md')], (l) => warnings.push(l))).toEqual([root])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/Vault folder not found: .*F-drive \(skipped/)
    expect(warnings[1]).toMatch(/Not a folder: .*file\.md/)
    await expect(usableRoots([missing], () => undefined)).rejects.toThrow(/Vault folder not found/)
  })

  it('parses HTTP options and rejects unknown flags', () => {
    expect(parseArgs(['/a', '--http', '--port', '0', '--token', TOKEN, '--host', '::1'], {})).toMatchObject({ http: true, port: 0, token: TOKEN, host: '::1' })
    expect(() => parseArgs(['--bogus'], {})).toThrow(/Unknown option --bogus/)
    expect(() => parseArgs(['--port', 'x'], {})).toThrow(/--port/)
  })
})

describe('appendText', () => {
  it('appends after a blank line, keeps lists tight and CRLF files CRLF', () => {
    expect(appendText('# A\n\ntext\n', 'more')).toBe('# A\n\ntext\n\nmore\n')
    expect(appendText('# A\n\n- one\n', '- two')).toBe('# A\n\n- one\n- two\n')
    expect(appendText('# A', 'more')).toBe('# A\n\nmore')
    expect(appendText('', 'first')).toBe('first\n')
    expect(appendText('# A\r\n\r\ntext\r\n', 'more\nlines')).toBe('# A\r\n\r\ntext\r\n\r\nmore\r\nlines\r\n')
  })

  it('appends to the end of a section, before the next heading of the same level', () => {
    const raw = '# A\n\n## One\n\nfirst\n\n### Sub\n\nsub text\n## Two\n\nsecond\n'
    expect(appendText(raw, 'added', 'one')).toBe('# A\n\n## One\n\nfirst\n\n### Sub\n\nsub text\n\nadded\n\n## Two\n\nsecond\n')
    expect(appendText(raw, 'new', '## Three')).toBe(`${raw}\n## Three\n\nnew\n`)
    expect(appendText('```\n## Fake\n```\n', 'x', 'Fake')).toBe('```\n## Fake\n```\n\n## Fake\n\nx\n')
    // A YAML comment in the frontmatter is not a heading.
    expect(appendText('---\n# Log\ntitle: A\n---\n# A\n', 'entry', 'Log')).toBe('---\n# Log\ntitle: A\n---\n# A\n\n## Log\n\nentry\n')
  })
})

describe.skipIf(!existsSync(BUNDLE))('bundle (dist/mcp/aether-mcp.mjs)', () => {
  it('runs from a folder without node_modules over stdio', async () => {
    const copy = path.join(tmp, 'ext', 'server', 'aether-mcp.mjs')
    await fs.mkdir(path.dirname(copy), { recursive: true })
    await fs.copyFile(BUNDLE, copy)
    const transport = new StdioClientTransport({ command: process.execPath, args: [copy, '--read-only=false', root], cwd: path.dirname(copy), stderr: 'pipe' })
    const client = new Client({ name: 'bundle-test', version: '1.0.0' })
    await client.connect(transport)
    cleanups.push(() => client.close())
    expect(client.getServerVersion()?.name).toBe('aether-brain')
    expect((await client.listTools()).tools).toHaveLength(OFFERED.length)
    const r = (await client.callTool({ name: 'search', arguments: { query: 'glyph' } })) as Result
    expect((r.structuredContent as { results: { id: string }[] }).results.map((x) => x.id)).toContain('Projects/PORTALz/Art/Glyphs')
    const c = (await client.callTool({ name: 'add_task', arguments: { project: 'PORTALz', text: 'From the bundle' } })) as Result
    expect(c.isError).toBeFalsy()
    expect(await disk('Projects/PORTALz.md')).toContain('- [ ] From the bundle\n')
  })

  it('serves the drives that are there and skips the folders the extension lists', async () => {
    await put('Private/Salary.md', '# Salary\n\nsalary figures\n')
    await put('Resources/Pay.md', '# Pay\n\nsalary talk\n')
    const missing = path.join(tmp, 'Unplugged')
    // As Claude Desktop expands the extension's args: read_only, exclude, then one argument per folder.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLE, '--read-only=false', '--exclude-list=Private, Taxes', root, missing],
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (c) => (stderr += c))
    const client = new Client({ name: 'bundle-test', version: '1.0.0' })
    await client.connect(transport)
    cleanups.push(() => client.close())
    const r = (await client.callTool({ name: 'search_notes', arguments: { query: 'salary' } })) as Result
    expect(json(r).hits.map((h: { id: string }) => h.id)).toEqual(['Resources/Pay'])
    expect(((await client.callTool({ name: 'read_note', arguments: { note: 'Private/Salary' } })) as Result).isError).toBe(true)
    expect(stderr).toMatch(/Vault folder not found: .*Unplugged \(skipped/)
  })

  it('packs an .mcpb whose manifest passes "Skip these folders" to the server', async () => {
    const out = path.join(tmp, 'mcpb')
    const pack = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path.resolve(here, '../scripts/pack-mcpb.mjs'), '--out', out], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (c) => (stderr += c))
      child.on('close', (code) => resolve({ code, stderr }))
    })
    expect(pack).toEqual({ code: 0, stderr: '' })
    const [name] = await fs.readdir(out)
    const zip = await fs.readFile(path.join(out, name!))
    // The first entry is manifest.json (local header: method at 8, sizes at 18, name and extra lengths at 26 and 28).
    const method = zip.readUInt16LE(8)
    const size = zip.readUInt32LE(18)
    const start = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28)
    expect(zip.subarray(30, 30 + zip.readUInt16LE(26)).toString()).toBe('manifest.json')
    const body = zip.subarray(start, start + size)
    const manifest = JSON.parse((method === 8 ? inflateRawSync(body) : body).toString('utf8'))
    // The tools the extension's server really has: not the ones that need the running app (its pictures, its window).
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual([...OFFERED].sort())
    expect(manifest.user_config.exclude).toMatchObject({ type: 'string', title: 'Skip these folders', required: false })
    expect(manifest.server.mcp_config.args).toContain('--exclude-list=${user_config.exclude}')
    expect(manifest.server.mcp_config.args.at(-1)).toBe('${user_config.vaults}')
    const cli = parseArgs(manifest.server.mcp_config.args.slice(1).map((a: string) => a.replace('${user_config.exclude}', 'Private, Taxes').replace('${user_config.read_only}', 'false').replace('${user_config.vaults}', root)), {})
    expect(cli).toMatchObject({ roots: [root], exclude: ['Private', 'Taxes'], readOnly: false })
  })

  it('stays a module inside an Electron app process, whatever argv says', async () => {
    const run = (type: string | null) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        // argv[1] names the bundle, as when a program is started with it.
        const code = `${type ? `process.type = ${JSON.stringify(type)}; ` : ''}process.argv[1] = ${JSON.stringify(BUNDLE)}; await import(${JSON.stringify(pathToFileURL(BUNDLE).href)})`
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, AETHER_VAULT: '' } })
        let stderr = ''
        child.stderr.on('data', (c) => (stderr += c))
        child.on('close', (exit) => resolve({ code: exit, stderr }))
      })
    // As a program without a vault the command line starts and complains.
    const cli = await run(null)
    expect(cli.code).toBe(1)
    expect(cli.stderr).toMatch(/No vault folder given/)
    // Imported by Electron's main process it never starts serving.
    expect(await run('browser')).toEqual({ code: 0, stderr: '' })
  })
})
