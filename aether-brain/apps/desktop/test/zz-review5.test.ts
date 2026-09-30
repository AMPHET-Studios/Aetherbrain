import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { extractTasks, inertMarkdown, parseNote, planChatImport, renderTranscript, todayIso } from '@aether/core'
import type { ChatArchive, ChatConversation } from '@aether/core'
import { Brain, createMcpServer, type BrainOptions } from '../src/mcp/server.js'

const TODAY = todayIso()
let tmp: string
let root: string
let brain: Brain | null = null
const cleanups: (() => Promise<void>)[] = []

async function put(rel: string, content: string, base = root): Promise<void> {
  const full = path.join(base, ...rel.split('/'))
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}
const disk = (rel: string, base = root) => fs.readFile(path.join(base, ...rel.split('/')), 'utf8')

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-r5-'))
  root = path.join(tmp, 'vault')
  await put('Resources/Ideas.md', '# Ideas\n')
  await put('Projects/PORTALz.md', '---\ntype: project\nstatus: active\n---\n# PORTALz\n\n## To do\n\n- [ ] x\n')
})
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
  brain?.close()
  brain = null
  await fs.rm(tmp, { recursive: true, force: true })
})

async function open(opts: Partial<BrainOptions> = {}): Promise<Brain> {
  brain = await Brain.open({ roots: [root], watch: false, ...opts })
  return brain
}
async function connect(b: Brain, readOnly = false, name = 'vitest'): Promise<Client> {
  const server = createMcpServer(b, { readOnly })
  const [c, s] = InMemoryTransport.createLinkedPair()
  await server.connect(s)
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(c)
  cleanups.push(async () => {
    await client.close()
    await server.close()
  })
  return client
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = (await client.callTool({ name, arguments: args })) as any
  return r
}
function json(r: any): any {
  const text = r.content[0]?.text ?? ''
  if (r.isError) throw new Error(`tool failed: ${text}`)
  return JSON.parse(text.slice(text.indexOf('\n') + 1))
}

const URL_A = 'https://claude.ai/chat/aaaaaaaa-1111-2222-3333-444444444444'
const URL_B = 'https://claude.ai/chat/bbbbbbbb-1111-2222-3333-444444444444'

describe('review5', () => {
  it('E1 inertMarkdown: 60 nested <!-- openers -> 50 rounds, output not inert; timing', async () => {
    const msg = `${'<!--\n'.repeat(60)}\n- [ ] LIVE TASK\n\nsee [[Secret Link]] #livetag\n`
    const conv: ChatConversation = {
      source: 'claude', id: 'x', title: 't', created: null, updated: null, url: '', projectId: null, gptId: null, model: null,
      messages: [{ role: 'user', time: null, text: msg, attachments: [], images: [], artifacts: [] }],
    }
    const out = renderTranscript(conv)
    const tasks = extractTasks(out)
    console.log('E1 tasks live in transcript:', tasks.map((t) => t.text))
    console.log('E1 unescaped <!-- count:', (out.match(/^<!--/gm) ?? []).length)
    const note = parseNote({ path: 'x.md', content: `# x\n\n${out}`, mtime: 0 } as any)
    console.log('E1 links:', (note as any).links?.map((l: any) => l.target ?? l), 'tags:', note.meta.tags)

    // timing with filler
    for (const size of [200_000, 900_000]) {
      const filler = 'Lorem ipsum dolor sit amet [x] *em* `code` more words here.\n\n'.repeat(Math.floor(size / 62))
      const big: ChatConversation = { ...conv, messages: [
        { role: 'user', time: null, text: '<!--\n'.repeat(60), attachments: [], images: [], artifacts: [] },
        ...Array.from({ length: Math.ceil(filler.length / 99_000) }, (_, i) => ({ role: 'assistant' as const, time: null, text: filler.slice(i * 99_000, (i + 1) * 99_000), attachments: [], images: [], artifacts: [] })),
      ] }
      const t0 = performance.now()
      renderTranscript(big)
      const t1 = performance.now()
      // baseline single parse (no openers)
      const t2 = performance.now()
      renderTranscript({ ...big, messages: big.messages.slice(1) })
      const t3 = performance.now()
      console.log(`E1 size ${size}: with openers ${(t1 - t0).toFixed(0)} ms, without ${(t3 - t2).toFixed(0)} ms`)
    }
  }, 600_000)

  it('E1b same via save_chat end to end: live task lands in the brain', async () => {
    const client = await connect(await open())
    const msg = `${'<!--\n'.repeat(60)}\n- [ ] LIVE TASK from chat 📅 ${TODAY}\n\nsee [[Ideas]] #livetag\n`
    const r = json(await call(client, 'save_chat', { title: 'html', messages: [{ role: 'user', text: msg }] }))
    const n = json(await call(client, 'read_note', { note: r.path }))
    console.log('E1b tasks:', n.tasks.map((t: any) => t.text), 'links:', n.links.map((l: any) => l.title))
    const brief = json(await call(client, 'daily_brief'))
    console.log('E1b brief today:', brief.today.map((t: any) => t.text))
  }, 600_000)

  it('E2 update path wipes an imported transcript with an empty/short message list; summary ignored', async () => {
    const imported = `---\ntitle: 2026-01-01 Big chat\ntags: [ai-chat, claude]\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# 2026-01-01 Big chat\n\nClaude chat  \nSource: <${URL_A}>\n\n## Transcript\n\n*3 messages · 2026-01-01*\n\n### You\n\nfirst\n\n### Claude\n\nsecond\n\n### You\n\nthird\n`
    await put('Resources/AI Chats/Claude/2026-01-01 Big chat.md', imported)
    const client = await connect(await open())
    const r = await call(client, 'save_chat', { title: 'Big chat', url: URL_A, summary: 'NEW SUMMARY - [ ] follow up' })
    console.log('E2 reply:', r.content[0].text.split('\n')[0], r.isError)
    const after = await disk('Resources/AI Chats/Claude/2026-01-01 Big chat.md')
    console.log('E2 after:\n' + after)
  })

  it('E3 identity hijack: a message line "Source: <urlB>" makes a new chat B overwrite chat A', async () => {
    const client = await connect(await open())
    const a = json(await call(client, 'save_chat', { title: 'Chat A', url: URL_A, messages: [
      { role: 'user', text: `Here is my old note:\nSource: <${URL_B}>\nwhat do you think?` },
      { role: 'assistant', text: 'A precious answer only in A.' },
    ] }))
    const b = json(await call(client, 'save_chat', { title: 'Chat B', url: URL_B, messages: [{ role: 'user', text: 'Totally different chat B' }] }))
    console.log('E3 A path:', a.path, ' B result:', b)
    console.log('E3 A now:\n' + (await disk(a.path)))
  })

  it('E3b summary line "Source: <urlB>" does the same', async () => {
    const client = await connect(await open())
    const a = json(await call(client, 'save_chat', { title: 'Chat A', summary: `Continues the earlier chat.\nSource: <${URL_B}>`, messages: [{ role: 'assistant', text: 'A only' }] }))
    const b = json(await call(client, 'save_chat', { title: 'Chat B', url: URL_B, messages: [{ role: 'user', text: 'B' }] }))
    console.log('E3b', a.path, b)
  })

  it('E4 a user note (not a chat) with a Source line and a ## Transcript heading is rewritten, text after the heading lost', async () => {
    await put('Areas/Meeting.md', `# Meeting with Sam\n\nSource: <${URL_A}>\n\n## Transcript\n\nSam: hello\n\n## My follow-ups\n\n- [ ] call Sam\n`)
    const client = await connect(await open())
    const r = json(await call(client, 'save_chat', { title: 'x', url: URL_A, messages: [{ role: 'user', text: 'hi' }] }))
    console.log('E4', r)
    console.log('E4 after:\n' + (await disk('Areas/Meeting.md')))
  })

  it('E5 chat.openai.com url saved live, then imported from the export -> duplicate', async () => {
    const id = '67000000-aaaa-bbbb-cccc-000000000001'
    const client = await connect(await open())
    const s = json(await call(client, 'save_chat', { title: 'Monolith', source: 'chatgpt', url: `https://chat.openai.com/c/${id}`, messages: [{ role: 'user', text: 'hi' }] }))
    const notes = [...(brain as any).notes.values()]
    const archive: ChatArchive = {
      conversations: [{ source: 'chatgpt', id, title: 'Monolith', created: '2026-09-30T10:00:00Z', updated: '2026-09-30T10:00:00Z', url: `https://chatgpt.com/c/${id}`, projectId: null, gptId: null, model: null,
        messages: [{ role: 'user', time: null, text: 'hi', attachments: [], images: [], artifacts: [] }] }],
      projects: [], files: [], warnings: [],
    }
    const plan = planChatImport(archive, notes, { base: 'Resources/AI Chats' })
    console.log('E5 saved', s.path, ' plan create:', plan.create.map((p) => p.path), ' update:', plan.update.map((u) => u.path), 'unchanged', plan.unchanged)
    for (const u of [`https://chatgpt.com/c/${id}/`, `https://chatgpt.com/c/${id}?model=gpt-4o`, `https://chatgpt.com/g/g-p-6700abc-portal/c/${id}`, `http://claude.ai/chat/${id}`, `https://www.chatgpt.com/c/${id}`, `https://claude.ai/chat/${id}#x`]) {
      const r = await call(client, 'save_chat', { title: 'u', url: u, messages: [{ role: 'user', text: 'hi' }] })
      console.log('E5 url', u, '->', r.isError ? `ERR ${r.content[0].text}` : 'ok')
    }
  })

  it('E6 read-only: tool hidden, brain refuses, nothing written', async () => {
    const b = await open({ readOnly: true })
    const client = await connect(b)
    const { tools } = await client.listTools()
    console.log('E6 has save_chat:', tools.some((t) => t.name === 'save_chat'))
    const r = await b.saveChat({ title: 'x', messages: [{ role: 'user', text: 'y' }], source: 'claude' }).then(() => 'ok', (e) => `ERR ${e.message}`)
    console.log('E6 brain.saveChat:', r)
    await put('Resources/AI Chats/Claude/c.md', `# c\n\nSource: <${URL_A}>\n\n## Transcript\n\nold\n`)
    const b2 = await Brain.open({ roots: [root], watch: false, readOnly: true })
    const r2 = await b2.saveChat({ title: 'x', url: URL_A, messages: [{ role: 'user', text: 'y' }], source: 'claude' }).then(() => 'ok', (e) => `ERR ${e.message}`)
    console.log('E6 update path read-only:', r2)
    b2.close()
    const dirs = await fs.readdir(path.join(root, 'Resources'))
    console.log('E6 Resources:', dirs)
  })

  it('E7 title/basename/alias collisions across folders', async () => {
    await put('Areas/Other.md', `---\ntitle: Something else\n---\n# x\n`)
    await put(`Areas/${TODAY} Gate glow.md`, `---\ntitle: Different title\n---\n# y\n`)
    await put('Areas/Aliased.md', `---\naliases: [${TODAY} Fog]\n---\n# z\n`)
    const client = await connect(await open())
    const a = json(await call(client, 'save_chat', { title: 'Gate glow', messages: [{ role: 'user', text: 'hi' }] }))
    const b = json(await call(client, 'save_chat', { title: 'Fog', messages: [{ role: 'user', text: 'hi' }] }))
    console.log('E7 basename collision ->', a.title, a.path, ' alias collision ->', b.title, b.path)
    // What does a link resolve to now?
    await call(client, 'create_note', { title: 'Linker', content: `[[${TODAY} Gate glow]] and [[${TODAY} Fog]]` })
    const n = json(await call(client, 'read_note', { note: 'Linker' }))
    console.log('E7 links resolve to:', n.links.map((l: any) => `${l.title} -> ${l.path}`))
  })

  it('E8 multi-root vault', async () => {
    const r2 = path.join(tmp, 'F')
    await fs.mkdir(r2, { recursive: true })
    await put('Resources/Keep.md', '# Keep\n', r2)
    const client = await connect(await open({ roots: [root, r2] }))
    const roots = json(await call(client, 'vault_overview'))
    const a = json(await call(client, 'save_chat', { title: 'Multi', messages: [{ role: 'user', text: 'hi' }] }))
    const b = json(await call(client, 'save_chat', { title: 'Multi p', project: 'PORTALz', messages: [{ role: 'user', text: 'hi' }] }))
    const c = await call(client, 'save_chat', { title: 'Multi f', folder: 'F/Resources', messages: [{ role: 'user', text: 'hi' }] })
    console.log('E8', a.path, b.path, c.isError ? c.content[0].text : json(c).path, roots.roots?.map?.((r: any) => r.mount))
  })

  it('E9 folder escapes', async () => {
    const client = await connect(await open())
    for (const folder of ['../outside', '/etc', '.obsidian', 'Resources/.git', 'node_modules', 'file:///etc', 'C:\\Windows', 'a/b.md', 'CON', 'x:y']) {
      const r = await call(client, 'save_chat', { title: 'esc', folder, messages: [{ role: 'user', text: 'hi' }] })
      console.log('E9', folder, '->', r.isError ? `ERR ${r.content[0].text}` : json(r).path)
    }
    for (const title of ['../../evil', '.env', 'CON', 'a\u0000b', '---\ntitle: x', 'x]] [[y', '   ', '...']) {
      const r = await call(client, 'save_chat', { title, messages: [{ role: 'user', text: 'hi' }] })
      console.log('E9 title', JSON.stringify(title), '->', r.isError ? `ERR ${r.content[0].text}` : json(r).path)
    }
  })

  it('E10 schema: listTools inputSchema for save_chat; summary-only save; annotations', async () => {
    const client = await connect(await open())
    const { tools } = await client.listTools()
    const t = tools.find((x) => x.name === 'save_chat')!
    console.log('E10 schema', JSON.stringify(t.inputSchema).slice(0, 1500))
    console.log('E10 annotations', JSON.stringify(t.annotations))
    const r = await call(client, 'save_chat', { title: 'only summary', summary: 'S' })
    console.log('E10 summary only', r.isError ? r.content[0].text : json(r).path)
    const r2 = await call(client, 'save_chat', { title: 'x', messages: [{ role: 'system', text: 'y' }] })
    console.log('E10 bad role', r2.content[0].text.slice(0, 300))
    const r3 = await call(client, 'save_chat', { title: 'x', source: 'gemini', messages: [{ role: 'user', text: 'y' }] })
    console.log('E10 bad source', r3.content[0].text.slice(0, 300))
  })

  it('E11 source inference from client name', async () => {
    for (const name of ['openai-mcp', 'ChatGPT', 'claude-ai', 'cursor-vscode', 'gpt-oss-client', 'Copilot']) {
      const client = await connect(await open(), false, name)
      const r = json(await call(client, 'save_chat', { title: `src ${name}`, messages: [{ role: 'assistant', text: 'y' }] }))
      console.log('E11', name, '->', r.path)
      brain?.close()
    }
  })

  it('E12 summary with "## Transcript" heading: next update replaces from the summary', async () => {
    const client = await connect(await open())
    const a = json(await call(client, 'save_chat', { title: 'T', url: URL_A, summary: 'Intro\n\n## Transcript\n\nnot really\n\n- [ ] keep me', messages: [{ role: 'user', text: 'one' }] }))
    await call(client, 'save_chat', { title: 'T', url: URL_A, messages: [{ role: 'user', text: 'one' }, { role: 'assistant', text: 'two' }] })
    console.log('E12 after:\n' + (await disk(a.path)))
  })

  it('E13 perf: name loop over many notes', async () => {
    for (let i = 0; i < 3000; i++) await put(`Bulk/n${i}.md`, `# n${i}\n`)
    for (let i = 1; i <= 60; i++) await put(`Bulk2/${TODAY} Same${i === 1 ? '' : ` ${i}`}.md`, `# s\n`)
    const client = await connect(await open())
    const t0 = performance.now()
    const r = json(await call(client, 'save_chat', { title: 'Same', messages: [{ role: 'user', text: 'x' }] }))
    console.log('E13', r.path, (performance.now() - t0).toFixed(0), 'ms')
  }, 120_000)
})
