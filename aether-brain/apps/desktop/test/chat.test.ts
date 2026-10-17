import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Brain } from '../src/mcp/server.js'
import { BrainTools, ChatThread, isLoopbackUrl, sessionBlock, type ChatContext } from '../src/mcp/chat.js'
import {
  ABOUT_ME_SECTIONS,
  checkInRow,
  checkInTrends,
  emptySections,
  factLine,
  localDay,
  parseCheckIns,
  type CheckInRow,
} from '../src/mcp/me.js'
import { COMPANION_GUIDE, PLAYBOOK_BODY } from '../src/mcp/companion.js'
import { ChatHost, chatSettings } from '../src/main/chat-host.js'
import type { ChatEvent, ChatEventDto } from '../src/shared/chat.js'

let tmp: string
let root: string
let brain: Brain | null = null
const toClose: { close(): Promise<void> }[] = []

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-chat-'))
  root = path.join(tmp, 'vault')
  await put('Projects/PORTALz.md', '---\ntype: project\nstatus: active\n---\n# PORTALz\n\n## To do\n\n- [ ] Sculpt the monolith\n')
  await put('Resources/Value Study.md', '# Value Study\n\nThree values: light, mid, dark.\n')
})
afterEach(async () => {
  for (const c of toClose.splice(0)) await c.close().catch(() => undefined)
  brain?.close()
  brain = null
  await fs.rm(tmp, { recursive: true, force: true })
})

async function put(rel: string, content: string): Promise<void> {
  const full = path.join(root, ...rel.split('/'))
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}
const read = (rel: string) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8')

async function open(): Promise<Brain> {
  brain = await Brain.open({ roots: [root], watch: false })
  return brain
}

/* ------------------------------------------------------------------ */
/* Me notes                                                           */
/* ------------------------------------------------------------------ */

describe('Me notes (pure)', () => {
  it('writes and reads back check-in rows, pipes and all', () => {
    const at = new Date(2026, 9, 1, 21, 30)
    const row = checkInRow({ mood: 7, sleep: 6.5, energy: 6, stress: 4, meds: true, family: 'dinner | games', win: 'inked the gate', worry: 'deadline' }, at)
    expect(row).toBe('| 2026-10-01 | 21:30 | 7 | 6.5 | 6 | 4 | yes | dinner \\| games | inked the gate | deadline |  |')
    const back = parseCheckIns(`# Check-ins\n\n| Date | Time | Mood |\n| --- | --- | --- |\n${row}\n| 2026-10-02 | 08:00 | 5 |  |  |  | no |  |  |  |  |\n`)
    expect(back).toEqual([
      { date: '2026-10-01', time: '21:30', mood: 7, sleep: 6.5, energy: 6, stress: 4, meds: true, family: 'dinner | games', win: 'inked the gate', worry: 'deadline' },
      { date: '2026-10-02', time: '08:00', mood: 5, meds: false },
    ])
  })

  it('notices sleep, mood and stress shifts against the weeks before, as facts', () => {
    const rows: CheckInRow[] = []
    // Two weeks: the earlier one 7.5 h / mood 7 / stress 3, the last one 5 h / mood 4 / stress 6, meds missed twice.
    for (let d = 1; d <= 14; d++) {
      const recent = d > 7
      rows.push({ date: `2026-10-${String(d).padStart(2, '0')}`, time: '21:00', mood: recent ? 4 : 7, sleep: recent ? 5 : 7.5, stress: recent ? 6 : 3, meds: !(recent && d % 3 === 0) })
    }
    const t = checkInTrends(rows, '2026-10-14', 14)
    expect([t.count, t.recent.sleep, t.before?.sleep, t.recent.mood, t.before?.mood, t.meds]).toEqual([14, 5, 7.5, 4, 7, { taken: 5, missed: 2 }])
    expect(t.notices).toEqual([
      "Sleep has averaged 5 h over the last week's check-ins.",
      'Sleep is down from about 7.5 h to 5 h.',
      'Mood is down from about 7 to 4.',
      'Stress is up from about 3 to 6.',
      'Medication was marked not taken on 2 days this week.',
    ])
    // Steady weeks: nothing to say. A long silence: said.
    const steady = rows.map((r) => ({ ...r, mood: 7, sleep: 7.5, stress: 3, meds: true }))
    expect(checkInTrends(steady, '2026-10-14', 14).notices).toEqual([])
    expect(checkInTrends(steady, '2026-10-20', 14).notices).toEqual(['The last check-in was 6 days ago.'])
  })

  it('keeps a remembered fact one dated line that is never a task or heading; knows the empty sections', () => {
    expect(factLine('  Sketches best\nin the morning  ', '2026-10-01')).toBe('- Sketches best in the morning _(2026-10-01)_')
    expect(factLine('[ ] call mum', '2026-10-01')).toBe('- \\[ ] call mum _(2026-10-01)_')
    expect(factLine('# loud', '2026-10-01')).toBe('- \\# loud _(2026-10-01)_')
    const raw = `# About me\n\n## Who I am\n\n- An artist _(2026-10-01)_\n\n## Strengths\n\n## Goals\n`
    expect(emptySections(raw)).toEqual(Object.values(ABOUT_ME_SECTIONS).filter((h) => h !== 'Who I am'))
  })

  it('ships a companion guide that names no person, pastes no phone numbers, and still stays with someone in danger', () => {
    expect(COMPANION_GUIDE).not.toMatch(/\b(he|him|his|she|her)\b/i)
    // A coach, not a switchboard: no hotline numbers in the instructions or in the playbook note.
    const PHONE = /\b911\b|\b9-8-8\b|\b8-1-1\b|\b\d{3}-\d{4}\b|\b\d{3}-\d{3}-\d{4}\b|\b1-800/
    expect(COMPANION_GUIDE).not.toMatch(PHONE)
    expect(PLAYBOOK_BODY).not.toMatch(PHONE)
    // What stays: it does not drop someone who says they may be unsafe.
    expect(COMPANION_GUIDE).toMatch(/## If they might hurt themselves or someone else/)
    expect(COMPANION_GUIDE).toMatch(/Stay with them\./)
    expect(COMPANION_GUIDE).toMatch(/emergency services/)
    // What it is for: the day, mood-aware motivation, and no arguing with unusual beliefs.
    expect(COMPANION_GUIDE).toMatch(/## The day/)
    expect(COMPANION_GUIDE).toMatch(/motivation is not pushing/i)
    expect(COMPANION_GUIDE).toMatch(/don't argue, don't agree/)
    expect(COMPANION_GUIDE).toMatch(/Never advise starting, stopping, skipping or changing the dose/)
    expect(PLAYBOOK_BODY).toMatch(/^# Wellbeing playbook/)
    expect(PLAYBOOK_BODY).toMatch(/## Sources/)
  })
})

describe('Brain: Me', () => {
  it('makes About me and the playbook once, remembers facts in their sections, and reads them back', async () => {
    const b = await open()
    expect((await b.aboutMe()).exists).toBe(false)
    expect(await b.ensureMe()).toEqual(['Me/About me.md', 'Me/Wellbeing playbook.md'])
    expect(await b.ensureMe()).toEqual([])
    const r = await b.rememberAboutMe('style', 'Warm and lively, with tables', new Date(2026, 9, 1, 9, 0))
    expect(r).toMatchObject({ path: 'Me/About me.md', section: 'How I like to be talked to' })
    await b.rememberAboutMe('work', 'Concept artist building the PORTALz game', new Date(2026, 9, 1, 9, 5))
    const raw = await read('Me/About me.md')
    expect(raw).toMatch(/## How I like to be talked to\n\n- Warm and lively, with tables _\(2026-10-01\)_\n\n## What matters to me/)
    expect(raw).toMatch(/## Work and art\n\n- Concept artist building the PORTALz game _\(2026-10-01\)_/)
    const me = await b.aboutMe()
    expect(me.exists).toBe(true)
    expect(me.text).toContain('Warm and lively')
    expect(me.empty).not.toContain('Work and art')
    expect(me.empty).toContain('Goals')
    await expect(b.rememberAboutMe('nope' as never, 'x')).rejects.toThrow(/Unknown area/)
    // The playbook: the user's copy, or one section of it.
    const pb = await b.playbook('sleep')
    expect(pb.path).toBe('Me/Wellbeing playbook.md')
    expect(pb.text).toMatch(/### Sleep/)
    const whole = await b.playbook()
    expect(whole.text).toMatch(/^> ## If things get hard$/m)
    expect(whole.text).toMatch(/Who I want next to me/)
  })

  it('files check-ins by month, one row each, and returns the trends', async () => {
    const b = await open()
    await b.checkIn({ mood: 6, sleep: 7 }, new Date(2026, 9, 1, 21, 0))
    const r = await b.checkIn({ mood: 4, sleep: 5, meds: false, worry: 'deadline | money' }, new Date(2026, 9, 2, 22, 15))
    expect(r.path).toBe('Me/Check-ins/Check-ins 2026-10.md')
    const raw = await read('Me/Check-ins/Check-ins 2026-10.md')
    expect(raw.match(/^\| 2026-10-0\d/gm)).toHaveLength(2)
    expect(raw).toContain('| 2026-10-02 | 22:15 | 4 | 5 |  |  | no |  |  | deadline \\| money |  |')
    expect(r.trends.count).toBe(2)
    const t = await b.trends(14, new Date(2026, 9, 3, 9, 0))
    expect([t.count, t.recent.mood, t.last]).toEqual([2, 5, '2026-10-02'])
    // Another month gets its own note.
    await b.checkIn({ mood: 8 }, new Date(2026, 10, 1, 9, 0))
    expect(await read('Me/Check-ins/Check-ins 2026-11.md')).toMatch(/\| 2026-11-01 \| 09:00 \| 8 \|/)
  })

  it('keeps a brain chat as an inert note and rewrites only its transcript when it grows', async () => {
    const b = await open()
    const t = (m: number) => new Date(2026, 9, 1, 14, m).toISOString()
    const messages: { role: 'user' | 'assistant'; text: string; time: string }[] = [
      { role: 'user', text: 'Plan my week around [[PORTALz]] #art', time: t(0) },
      { role: 'assistant', text: 'Here is a plan:\n\n- [ ] Sculpt Monday\n\n## Big heading', time: t(1) },
    ]
    const first = await b.saveBrainChat({ title: 'Plan my week', assistant: 'Claude Opus 5.5', model: 'claude-opus-5-5', messages })
    expect(first.path).toBe('Me/Chats/2026-10-01 Plan my week.md')
    const raw = await read(first.path)
    expect(raw).toMatch(/tags: \[ai-chat, brain-chat\]/)
    expect(raw).toMatch(/^Chat in the brain with Claude Opus 5.5$/m)
    expect(raw).toMatch(/^### Claude Opus 5.5/m)
    // Inert: the chat's own link, tag, task and heading are quoted, never the note's.
    const note = (await b.readNote(first.path)) as { links: unknown[]; tasks: unknown[]; tags?: string[] }
    expect(note.links).toEqual([])
    expect(note.tasks).toEqual([])
    // The user adds a line above; the transcript grows; only it is rewritten.
    await fs.writeFile(path.join(root, ...first.path.split('/')), raw.replace('## Transcript', 'My own note.\n\n## Transcript'))
    b.applyExternal([{ kind: 'change', path: first.path, content: await read(first.path).then((x) => x), mtime: Date.now() }])
    const again = await b.saveBrainChat({ title: 'Plan my week', assistant: 'Claude Opus 5.5', model: 'claude-opus-5-5', messages: [...messages, { role: 'user', text: 'Thanks!', time: t(2) }], path: first.path })
    expect(again.path).toBe(first.path)
    const after = await read(first.path)
    expect(after).toContain('My own note.')
    expect(after).toContain('Thanks!')
  })
})

/* ------------------------------------------------------------------ */
/* The chat engine                                                    */
/* ------------------------------------------------------------------ */

const CTX: ChatContext = { aboutMe: '', aboutMePath: 'Me/About me.md', empty: ['Who I am'], checkIns: { count: 0 }, vault: 'Folders: vault.', started: new Date(2026, 9, 1, 14, 0) }

/** A streamed Messages API answer (SSE) with these content blocks. */
function sse(blocks: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown })[], stop: string): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  let out = ev('message_start', {
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  })
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      for (const part of b.text.match(/.{1,6}/gs) ?? []) out += ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } })
    } else {
      out += ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      out += ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
    }
    out += ev('content_block_stop', { type: 'content_block_stop', index })
  })
  out += ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } })
  out += ev('message_stop', { type: 'message_stop' })
  return out
}

/** A fetch that answers each request with the next canned body, and keeps the requests. */
function fakeFetch(bodies: string[], type = 'text/event-stream') {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    requests.push({ url: String(url), body, headers: new Headers(init?.headers) })
    const next = bodies.shift()
    if (next === undefined) throw new Error('no more canned answers')
    return new Response(next, { status: 200, headers: { 'content-type': type, 'request-id': 'req_1' } })
  }) as typeof fetch
  return { fn, requests }
}

describe('BrainTools', () => {
  it('offers the brain tools without the connector pair and save_chat, and runs them', async () => {
    const b = await open()
    const tools = await BrainTools.open(b)
    toClose.push(tools)
    const names = tools.defs.map((d) => d.name)
    for (const n of ['about_me', 'remember_about_me', 'check_in', 'my_trends', 'wellbeing_playbook', 'search_notes', 'read_note', 'add_task']) expect(names).toContain(n)
    for (const n of ['search', 'fetch', 'save_chat']) expect(names).not.toContain(n)
    expect(names).toEqual([...names].sort())
    const r = await tools.call('remember_about_me', { area: 'goals', fact: 'Finish the PORTALz vertical slice' })
    expect(r.isError).toBe(false)
    expect(r.activity).toMatchObject({ tool: 'remember_about_me', path: 'Me/About me.md', write: true })
    expect(await read('Me/About me.md')).toContain('Finish the PORTALz vertical slice')
    expect((await tools.call('remember_about_me', { area: 'nowhere', fact: 'x' })).isError).toBe(true)
    expect((await tools.call('no_such_tool', {})).isError).toBe(true)
  })
})

describe('ChatThread with Claude', () => {
  it('streams text, runs the tools the model asks for, and keeps the prompt and history append-only', async () => {
    const b = await open()
    const tools = await BrainTools.open(b)
    toClose.push(tools)
    const { fn, requests } = fakeFetch([
      sse([{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'toolu_1', name: 'search_notes', input: { query: 'values' } }], 'tool_use'),
      sse([{ type: 'text', text: 'Your [[Value Study]] says three values.' }], 'end_turn'),
      sse([{ type: 'text', text: 'You are welcome!' }], 'end_turn'),
    ])
    const thread = new ChatThread(CTX)
    const events: ChatEvent[] = []
    const settings = { provider: 'claude' as const, model: 'claude-opus-5-5', apiKey: 'sk-ant-test-0123456789abcdef' }
    const r = await thread.send('What do my notes say about values?', settings, tools, { onEvent: (e) => events.push(e), fetch: fn, now: new Date(2026, 9, 1, 14, 5) })
    expect(r).toEqual({ text: 'Your [[Value Study]] says three values.', stop: 'end_turn' })
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Let me look.\n\nYour [[Value Study]] says three values.')
    const toolEvents = events.filter((e) => e.type === 'tool')
    expect(toolEvents.map((e) => (e as { phase: string }).phase)).toEqual(['start', 'done'])
    expect(toolEvents[1]).toMatchObject({ name: 'search_notes', summary: 'searched "values"' })

    // The request: current model features, cached companion prompt, the session block, tools with eager input streaming.
    const [first, second] = requests
    expect(first!.url).toMatch(/\/v1\/messages/)
    expect(first!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
    expect(first!.headers.get('x-api-key')).toBe(settings.apiKey)
    expect(first!.body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', output_config: { effort: 'medium' }, stream: true, cache_control: { type: 'ephemeral' } })
    expect(first!.body['thinking']).toBeUndefined()
    const system = first!.body['system'] as { text: string; cache_control?: unknown }[]
    expect(system[0]!.text.startsWith(COMPANION_GUIDE)).toBe(true)
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(system[1]!.text).toBe(sessionBlock(CTX))
    expect((first!.body['tools'] as { eager_input_streaming?: boolean }[]).every((t) => t.eager_input_streaming === true)).toBe(true)
    // The tool round: same system and tools, the history only grew (assistant turn, then the tool result).
    expect(second!.body['system']).toEqual(first!.body['system'])
    expect(second!.body['tools']).toEqual(first!.body['tools'])
    const m1 = first!.body['messages'] as { role: string; content: unknown }[]
    const m2 = second!.body['messages'] as { role: string; content: { type: string; tool_use_id?: string; content?: string }[] }[]
    expect(m2.slice(0, m1.length)).toEqual(m1)
    expect(m2.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect((m1[0]!.content as { text: string }[])[0]!.text).toMatch(/^\(Thursday, (October 1|1 October),? 2026, 14:05.*\)\n\nWhat do my notes say about values\?$/)
    expect(m2[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
    expect(m2[2]!.content[0]!.content).toContain('Value Study')

    // A second message continues the same conversation, still append-only.
    await thread.send('Thanks', settings, tools, { onEvent: () => undefined, fetch: fn })
    const third = requests[2]!
    expect(third.body['system']).toEqual(first!.body['system'])
    const m3 = third.body['messages'] as unknown[]
    expect(m3.slice(0, m2.length)).toEqual(m2)
    expect(m3).toHaveLength(m2.length + 2)
    expect(thread.transcript.map((m) => [m.role, m.text])).toEqual([
      ['user', 'What do my notes say about values?'],
      ['assistant', 'Your [[Value Study]] says three values.'],
      ['user', 'Thanks'],
      ['assistant', 'You are welcome!'],
    ])
    expect(thread.continues({ ...settings, model: 'claude-sonnet-5-5' })).toBe(false)
  })

  it('says so on a refusal and keeps no partial answer; Haiku gets no effort or fallbacks', async () => {
    const b = await open()
    const tools = await BrainTools.open(b)
    toClose.push(tools)
    const { fn, requests } = fakeFetch([sse([], 'refusal')])
    const thread = new ChatThread(CTX)
    const events: ChatEvent[] = []
    const r = await thread.send('…', { provider: 'claude', model: 'claude-haiku-4-5', apiKey: 'sk-ant-test-0123456789abcdef' }, tools, { onEvent: (e) => events.push(e), fetch: fn })
    expect(r.stop).toBe('refusal')
    expect(events.some((e) => e.type === 'notice' && /not safe right now/.test(e.text) && !/\d-\d-\d|911/.test(e.text))).toBe(true)
    expect(requests[0]!.body['fallbacks']).toBeUndefined()
    expect(requests[0]!.body['output_config']).toBeUndefined()
    expect(thread.transcript.map((m) => m.role)).toEqual(['user'])
  })
})

describe('ChatThread with Ollama', () => {
  it('talks only to this computer, runs its tool calls, and goes on without tools when the model has none', async () => {
    const b = await open()
    const tools = await BrainTools.open(b)
    toClose.push(tools)
    const nd = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
    const { fn, requests } = fakeFetch(
      [
        nd({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'check_in', arguments: { mood: 6, sleep: 7 } } }] }, done: false }, { done: true }),
        nd({ message: { role: 'assistant', content: 'Saved your ' }, done: false }, { message: { role: 'assistant', content: 'check-in.' }, done: true }),
      ],
      'application/x-ndjson',
    )
    const thread = new ChatThread(CTX)
    const events: ChatEvent[] = []
    const r = await thread.send('Mood 6, slept 7 hours', { provider: 'ollama', model: 'llama3.1', ollamaUrl: 'http://127.0.0.1:11434' }, tools, { onEvent: (e) => events.push(e), fetch: fn })
    expect(r).toEqual({ text: 'Saved your check-in.', stop: 'end_turn' })
    expect(requests[0]!.url).toBe('http://127.0.0.1:11434/api/chat')
    const toolNames = (requests[0]!.body['tools'] as { function: { name: string } }[]).map((t) => t.function.name)
    expect(toolNames).toContain('check_in')
    expect(toolNames).not.toContain('create_project')
    const msgs = requests[1]!.body['messages'] as { role: string; content: string }[]
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(msgs[0]!.content.startsWith(COMPANION_GUIDE)).toBe(true)
    const month = localDay(new Date()).slice(0, 7)
    expect(await read(`Me/Check-ins/Check-ins ${month}.md`)).toMatch(/\| 6 \| 7 \|/)

    await expect(new ChatThread(CTX).send('hi', { provider: 'ollama', model: 'llama3.1', ollamaUrl: 'http://192.168.1.20:11434' }, tools, { onEvent: () => undefined, fetch: fn })).rejects.toThrow(/this computer/)
    expect(['http://localhost:11434', 'http://127.0.0.1:1', 'http://[::1]:11434'].every(isLoopbackUrl)).toBe(true)
    expect(['http://example.com', 'http://10.0.0.2:11434', 'file:///x', 'nope'].some(isLoopbackUrl)).toBe(false)

    // A model without tool support: the request is made again without tools.
    const noTools = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (body['tools']) return new Response('{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}', { status: 400 })
      return new Response(nd({ message: { role: 'assistant', content: 'Hello!' }, done: true }), { status: 200 })
    }) as typeof fetch
    const plain: ChatEvent[] = []
    expect((await new ChatThread(CTX).send('hi', { provider: 'ollama', model: 'gemma:2b' }, tools, { onEvent: (e) => plain.push(e), fetch: noTools })).text).toBe('Hello!')
    expect(plain.some((e) => e.type === 'notice' && /can't use the brain's tools/.test(e.text))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* The chat host (main)                                               */
/* ------------------------------------------------------------------ */

describe('ChatHost', () => {
  function host(opts: { keychain?: boolean; vaultOpen?: boolean; brain?: unknown; mod?: unknown } = {}) {
    const saved: unknown[] = []
    const events: ChatEventDto[] = []
    const wanted: boolean[] = []
    const h = new ChatHost({
      settings: chatSettings({}),
      save: (s) => void saved.push(s),
      brain: async () => ({ brain: opts.brain ?? {}, mod: opts.mod ?? {} }),
      vaultOpen: () => opts.vaultOpen ?? true,
      wantBrain: (on) => void wanted.push(on),
      emit: (e) => void events.push(e),
      keychain: {
        available: () => opts.keychain ?? true,
        encrypt: (t) => Buffer.from(`enc:${t}`).toString('base64'),
        decrypt: (b) => Buffer.from(b, 'base64').toString().replace(/^enc:/, ''),
      },
    })
    return { h, saved, events, wanted }
  }

  it('repairs settings, says what is missing, and keeps the key encrypted (only its last four characters reach the renderer)', async () => {
    expect(chatSettings({ provider: 'x', claudeModel: 'gpt-4', ollamaUrl: '', saveChats: 'no' })).toEqual({ provider: 'claude', claudeModel: 'claude-opus-5-5', ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: '', saveChats: true, nudges: true })
    const { h, saved, wanted } = host()
    expect(h.status()).toMatchObject({ ready: false, hasKey: false, missing: expect.stringMatching(/API key/) })
    await expect(h.configure({ apiKey: 'short' })).rejects.toThrow(/sk-ant-/)
    const st = await h.configure({ apiKey: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-WXYZ' })
    expect(st).toMatchObject({ ready: true, hasKey: true, keyHint: '…WXYZ', keyStored: 'encrypted' })
    expect(JSON.stringify(st)).not.toContain('abcdefghij')
    const stored = saved.at(-1) as { key?: string }
    expect(stored.key && Buffer.from(stored.key, 'base64').toString()).toBe('enc:sk-ant-api03-abcdefghijklmnopqrstuvwxyz-WXYZ')
    expect(wanted).toContain(true)
    // A new host reads the encrypted key back.
    const again = new ChatHost({ settings: chatSettings(stored), save: () => undefined, brain: async () => ({ brain: {}, mod: {} }), vaultOpen: () => true, wantBrain: () => undefined, emit: () => undefined, keychain: { available: () => true, encrypt: (t) => t, decrypt: (b) => Buffer.from(b, 'base64').toString().replace(/^enc:/, '') } })
    expect(again.status()).toMatchObject({ hasKey: true, keyHint: '…WXYZ' })
    expect((await h.configure({ apiKey: null })).hasKey).toBe(false)
    // No keychain: kept for the session only, never written down.
    const plain = host({ keychain: false })
    expect(await plain.h.configure({ apiKey: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-WXYZ' })).toMatchObject({ keyStored: 'session' })
    expect((plain.saved.at(-1) as { key?: string }).key).toBeUndefined()
    // Ollama: this computer only.
    await expect(h.configure({ provider: 'ollama', ollamaUrl: 'http://example.com:11434' })).rejects.toThrow(/this computer/)
    expect(await h.configure({ provider: 'ollama', ollamaModel: 'llama3.1' })).toMatchObject({ ready: true, provider: 'ollama' })
    expect(host({ vaultOpen: false }).h.status().missing).toMatch(/vault/)
  })
  it('keeps the nudges switch: on until turned off, repaired, saved, and told to the renderer', async () => {
    // On for settings written before it, and for anything that is not a plain false.
    for (const raw of [{}, { nudges: true }, { nudges: 'no' }, { nudges: 0 }, { nudges: null }]) expect(chatSettings(raw).nudges, JSON.stringify(raw)).toBe(true)
    expect(chatSettings({ nudges: false }).nudges).toBe(false)
    const { h, saved } = host()
    expect(h.status().nudges).toBe(true)
    expect((await h.configure({ nudges: false })).nudges).toBe(false)
    expect((saved.at(-1) as { nudges?: boolean }).nudges).toBe(false)
    // Only a real boolean changes it.
    expect((await h.configure({ nudges: 'yes' as unknown as boolean })).nudges).toBe(false)
    expect((await h.configure({ nudges: true })).nudges).toBe(true)
    // The switch is about the cards, not about whether the chat works.
    expect(h.status()).toMatchObject({ ready: false, missing: expect.stringMatching(/API key/) })
  })

  it('runs a turn through the engine, streams its events with the conversation id, and keeps the chat as a note', async () => {
    const b = await open()
    const { h, events } = host({ brain: b, mod: { BrainTools, ChatThread: FakeThread } })
    await h.configure({ apiKey: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-WXYZ' })
    await expect(h.send('bad id!', 'hi')).rejects.toThrow(/conversation/)
    await expect(h.send('conv-123456', '   ')).rejects.toThrow(/Nothing/)
    const r = await h.send('conv-123456', 'Hello brain')
    expect(r).toMatchObject({ text: 'echo: Hello brain', stop: 'end_turn', saved: { path: expect.stringMatching(/^Me\/Chats\/\d{4}-\d{2}-\d{2} Hello brain\.md$/) } })
    expect(events[0]).toEqual({ conv: 'conv-123456', type: 'text', delta: 'echo: Hello brain' })
    expect(events.some((e) => e.type === 'saved')).toBe(true)
    // Me notes were made when the conversation started; the thread got the About me context.
    expect(await read('Me/About me.md')).toMatch(/# About me/)
    expect(FakeThread.last?.ctx.aboutMePath).toBe('Me/About me.md')
    // The same conversation goes on in the same note.
    const r2 = await h.send('conv-123456', 'Again')
    expect(r2.saved?.path).toBe(r.saved?.path)
    await h.close()
  })
})

/** A ChatThread stand-in: echoes, with the shape the host expects. */
class FakeThread {
  static last: FakeThread | null = null
  readonly transcript: { role: 'user' | 'assistant'; text: string; time: string }[] = []
  constructor(readonly ctx: ChatContext) {
    FakeThread.last = this
  }
  continues(): boolean {
    return true
  }
  async send(text: string, _s: unknown, _t: unknown, opts: { onEvent: (e: ChatEvent) => void }): Promise<{ text: string; stop: string }> {
    const reply = `echo: ${text}`
    opts.onEvent({ type: 'text', delta: reply })
    this.transcript.push({ role: 'user', text, time: new Date().toISOString() }, { role: 'assistant', text: reply, time: new Date().toISOString() })
    return { text: reply, stop: 'end_turn' }
  }
}
