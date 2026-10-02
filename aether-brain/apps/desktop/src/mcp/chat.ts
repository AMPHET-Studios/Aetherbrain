/**
 * The brain's own chat: a conversation with Claude (the user's API key) or a
 * local Ollama model, held in the main process. The model works through the
 * same tools the AI link offers Claude Desktop (an in-process MCP client over
 * an in-memory transport), so it reads notes, remembers about the user,
 * records check-ins and changes notes exactly as the link does.
 *
 * Claude: streamed Messages API with a manual tool loop. The system prompt
 * (companion guide + playbook, cached) and the tool list stay byte-identical
 * for the whole conversation, and the history only grows: thinking blocks
 * stay valid (preserved thinking) and the prompt cache keeps hitting. What
 * changes during it (the time, what was just remembered) arrives as text in
 * the user's turns and as tool results.
 *
 * Ollama: its native /api/chat on this computer only (a loopback address),
 * with a shorter prompt and the tools a small model handles well.
 */
import Anthropic from '@anthropic-ai/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Brain } from './brain.js'
import { COMPANION_GUIDE, PLAYBOOK_BODY } from './companion.js'
import { SERVER_VERSION, createMcpServer, type ActivityEvent } from './tools.js'
import { DEFAULT_CLAUDE_MODEL, DEFAULT_OLLAMA_URL, type ChatEvent, type ChatProvider } from '../shared/chat.js'

export { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, DEFAULT_OLLAMA_URL } from '../shared/chat.js'
export type { ChatEvent, ChatProvider } from '../shared/chat.js'

export interface ChatSettings {
  provider: ChatProvider
  /** A Claude model id, or an Ollama model name. */
  model: string
  apiKey?: string
  ollamaUrl?: string
}

export interface TurnResult {
  /** The reply's text (all text blocks of the turn's last answer). */
  text: string
  /** Why it ended: `end_turn`, `refusal`, `max_tokens`, `stopped` (aborted), `tool_limit`, `error`. */
  stop: string
}

/** Tools the chat leaves out: the ChatGPT-connector pair (search_notes / read_note do it better) and save_chat (the chat saves itself). */
const SKIP_TOOLS = new Set(['search', 'fetch', 'save_chat'])
/** The tools a small local model gets. */
const OLLAMA_TOOLS = new Set([
  'about_me',
  'remember_about_me',
  'check_in',
  'my_trends',
  'wellbeing_playbook',
  'search_notes',
  'read_note',
  'daily_brief',
  'recent_notes',
  'list_projects',
  'get_project',
  'capture',
  'add_task',
  'set_task_done',
])
/** A tool result longer than this is cut (the model can ask for less). */
const MAX_RESULT_CHARS = 60_000
/** Tool rounds per user message before the turn stops. */
const MAX_ROUNDS = 12
const MAX_TOKENS = 32_000

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * The brain's tools through an in-process MCP client: listed once, called by
 * name. `onActivity` hears each call's one-line summary (`read "Gate"`).
 */
export class BrainTools {
  private constructor(
    private readonly client: Client,
    private readonly server: { close(): Promise<void> },
    readonly defs: ToolDef[],
    private readonly heard: { last: ActivityEvent | null },
  ) {}

  static async open(brain: Brain): Promise<BrainTools> {
    const heard: { last: ActivityEvent | null } = { last: null }
    const server = createMcpServer(brain, { readOnly: false, getClient: () => 'Brain chat', onActivity: (a) => (heard.last = a) })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'aether-brain-chat', version: SERVER_VERSION })
    await client.connect(clientSide)
    const listed = await client.listTools()
    const defs = listed.tools
      .filter((t) => !SKIP_TOOLS.has(t.name))
      .map((t) => ({ name: t.name, description: t.description ?? t.name, inputSchema: t.inputSchema as Record<string, unknown> }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return new BrainTools(client, server, defs, heard)
  }

  /** Run one tool: its text (cut at MAX_RESULT_CHARS), whether it failed, and the activity line it reported. */
  async call(name: string, args: unknown): Promise<{ text: string; isError: boolean; activity: ActivityEvent | null }> {
    this.heard.last = null
    if (!this.defs.some((d) => d.name === name)) return { text: `There is no tool "${name}".`, isError: true, activity: null }
    const input = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
    try {
      const res = await this.client.callTool({ name, arguments: input })
      const parts = Array.isArray(res.content) ? res.content : []
      let text = parts.map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : '')).join('\n')
      if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n… (cut: ask for less, e.g. a smaller limit or one section)`
      return { text: text || '(no output)', isError: res.isError === true, activity: this.heard.last }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true, activity: this.heard.last }
    }
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined)
    await this.server.close().catch(() => undefined)
  }
}

/** What the conversation knows about the person and the moment, fixed when it starts. */
export interface ChatContext {
  /** About me's text ('' when there is none). */
  aboutMe: string
  aboutMePath: string
  /** About me's sections that are still empty. */
  empty: string[]
  /** Check-in trends, as my_trends gives them (JSON-able). */
  checkIns: unknown
  /** Where new notes go and what the vault is. */
  vault: string
  /** When the conversation started, for the model. */
  started: Date
}

/** The session block: who they are and when, as the conversation starts. */
export function sessionBlock(ctx: ChatContext): string {
  const about = ctx.aboutMe.trim()
    ? `${ctx.aboutMe.trim()}${ctx.empty.length ? `\n\n(Not filled in yet: ${ctx.empty.join(', ')}.)` : ''}`
    : '(Nothing yet. Offer to get to know them, one question at a time, and remember what they agree to.)'
  return [
    `# About them (${ctx.aboutMePath}, as this conversation started)`,
    about,
    '# Check-ins (last two weeks, as this conversation started)',
    JSON.stringify(ctx.checkIns),
    '# This brain',
    ctx.vault,
    `# Now`,
    `The conversation started ${timeLine(ctx.started)}. Each message of theirs carries its local time.`,
  ].join('\n\n')
}

/** `Wednesday, 1 October 2026, 14:05 (America/Vancouver)` */
export function timeLine(d: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const day = d.toLocaleDateString('en-CA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${day}, ${time}${zone ? ` (${zone})` : ''}`
}

/** True for an address on this computer (Ollama must never be a remote server). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const host = u.hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
  } catch {
    return false
  }
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: { function: { name: string; arguments: unknown } }[]
  tool_name?: string
}

/** Extra things a turn can be given (tests pass a fake fetch). */
export interface TurnOptions {
  onEvent: (e: ChatEvent) => void
  signal?: AbortSignal
  fetch?: typeof fetch
  now?: Date
}

/**
 * One conversation. Its history (the provider's own message format) only
 * grows; `transcript` is the plain text of both sides, for saving it as a note.
 */
export class ChatThread {
  readonly transcript: { role: 'user' | 'assistant'; text: string; time: string }[] = []
  private claude: Anthropic.Beta.BetaMessageParam[] = []
  private ollama: OllamaMessage[] = []
  private system: string | null = null
  /** The provider and model this conversation started with (a switch starts a new one). */
  private started: { provider: ChatProvider; model: string } | null = null
  private ollamaTools = true

  constructor(private readonly context: ChatContext) {}

  /** True when `settings` can continue this conversation (same provider and model). */
  continues(settings: ChatSettings): boolean {
    return !this.started || (this.started.provider === settings.provider && this.started.model === settings.model)
  }

  async send(text: string, settings: ChatSettings, tools: BrainTools, opts: TurnOptions): Promise<TurnResult> {
    if (!this.continues(settings)) throw new Error('This conversation started with another model: start a new chat to switch')
    this.started ??= { provider: settings.provider, model: settings.model }
    const now = opts.now ?? new Date()
    this.transcript.push({ role: 'user', text, time: now.toISOString() })
    const result = settings.provider === 'claude' ? await this.sendClaude(text, settings, tools, opts, now) : await this.sendOllama(text, settings, tools, opts, now)
    if (result.text.trim()) this.transcript.push({ role: 'assistant', text: result.text, time: new Date().toISOString() })
    return result
  }

  /* ------------------------------ Claude ------------------------------ */

  private async sendClaude(text: string, settings: ChatSettings, tools: BrainTools, opts: TurnOptions, now: Date): Promise<TurnResult> {
    if (!settings.apiKey) throw new Error('Add your Anthropic API key in the chat settings first')
    const client = new Anthropic({ apiKey: settings.apiKey, maxRetries: 2, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
    const model = settings.model || DEFAULT_CLAUDE_MODEL
    // Claude Opus 5.5 / Sonnet 5.5: adaptive thinking (the default), effort, and the server-side fallback on a decline.
    const current = model === 'claude-opus-5-5' || model === 'claude-sonnet-5-5'
    this.system ??= sessionBlock(this.context)
    const system: Anthropic.Beta.BetaTextBlockParam[] = [
      { type: 'text', text: `${COMPANION_GUIDE}\n\n---\n\n${PLAYBOOK_BODY}`, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: this.system },
    ]
    const toolList: Anthropic.Beta.BetaTool[] = tools.defs.map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: d.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    }))
    this.claude.push({ role: 'user', content: [{ type: 'text', text: `(${timeLine(now)})\n\n${text}` }] })
    let reply = ''
    let jsonRetries = 0
    for (let round = 0; ; round++) {
      if (round >= MAX_ROUNDS) {
        opts.onEvent({ type: 'notice', text: `Stopped after ${MAX_ROUNDS} tool rounds; ask again to go on.` })
        return { text: reply, stop: 'tool_limit' }
      }
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: MAX_TOKENS,
          system,
          tools: toolList,
          messages: this.claude,
          cache_control: { type: 'ephemeral' },
          ...(current ? { output_config: { effort: 'medium' as const }, fallbacks: 'default' as const, betas: ['server-side-fallback-2026-07-01'] } : {}),
        },
        opts.signal ? { signal: opts.signal } : undefined,
      )
      let roundText = ''
      stream.on('text', (delta) => {
        roundText += delta
        opts.onEvent({ type: 'text', delta })
      })
      let message: Anthropic.Beta.BetaMessage
      try {
        message = await stream.finalMessage()
        jsonRetries = 0
      } catch (err) {
        if (opts.signal?.aborted || err instanceof Anthropic.APIUserAbortError) {
          // The partial answer is not kept: the next message starts from the history as it was.
          return { text: reply + roundText, stop: 'stopped' }
        }
        // A tool input that could not be parsed at all: the turn is asked again (twice at most).
        if (!(err instanceof Anthropic.APIError) && jsonRetries++ < 2) {
          if (roundText) opts.onEvent({ type: 'text', delta: '\n\n' })
          continue
        }
        throw err
      }
      reply = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (message.stop_reason === 'refusal') {
        opts.onEvent({ type: 'notice', text: "Claude can't help with that one. If you're in danger or thinking about ending your life, call 911 or call or text 9-8-8 now." })
        return { text: '', stop: 'refusal' }
      }
      const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      if (message.stop_reason === 'max_tokens' && uses.length) {
        opts.onEvent({ type: 'notice', text: 'The answer got too long and was cut; ask for less at once.' })
        return { text: reply, stop: 'max_tokens' }
      }
      // The whole answer goes back as it came (thinking and fallback blocks included).
      this.claude.push({ role: 'assistant', content: message.content })
      if (message.stop_reason === 'pause_turn') continue
      if (!uses.length) return { text: reply, stop: message.stop_reason ?? 'end_turn' }
      if (roundText) opts.onEvent({ type: 'text', delta: '\n\n' })
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
      for (const use of uses) {
        opts.onEvent({ type: 'tool', id: use.id, name: use.name, phase: 'start' })
        const r = await tools.call(use.name, use.input)
        opts.onEvent({
          type: 'tool',
          id: use.id,
          name: use.name,
          phase: r.isError ? 'error' : 'done',
          summary: r.isError ? r.text.slice(0, 200) : (r.activity?.summary ?? use.name),
          path: r.activity?.path ?? null,
          write: r.activity?.write ?? false,
        })
        results.push({ type: 'tool_result', tool_use_id: use.id, content: r.text, ...(r.isError ? { is_error: true } : {}) })
      }
      this.claude.push({ role: 'user', content: results })
      if (opts.signal?.aborted) return { text: reply, stop: 'stopped' }
    }
  }

  /* ------------------------------ Ollama ------------------------------ */

  private async sendOllama(text: string, settings: ChatSettings, tools: BrainTools, opts: TurnOptions, now: Date): Promise<TurnResult> {
    const base = (settings.ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '')
    if (!isLoopbackUrl(base)) throw new Error('Ollama must run on this computer (an address like http://127.0.0.1:11434)')
    if (!settings.model) throw new Error('Choose an Ollama model in the chat settings (e.g. llama3.1)')
    const doFetch = opts.fetch ?? fetch
    if (!this.ollama.length) {
      this.system ??= sessionBlock(this.context)
      this.ollama.push({ role: 'system', content: `${COMPANION_GUIDE}\n\n---\n\n${this.system}` })
    }
    this.ollama.push({ role: 'user', content: `(${timeLine(now)})\n\n${text}` })
    const defs = tools.defs.filter((d) => OLLAMA_TOOLS.has(d.name))
    let reply = ''
    for (let round = 0; ; round++) {
      if (round >= MAX_ROUNDS) {
        opts.onEvent({ type: 'notice', text: `Stopped after ${MAX_ROUNDS} tool rounds; ask again to go on.` })
        return { text: reply, stop: 'tool_limit' }
      }
      const body = {
        model: settings.model,
        messages: this.ollama,
        stream: true,
        options: { num_ctx: 16_384 },
        ...(this.ollamaTools ? { tools: defs.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.inputSchema } })) } : {}),
      }
      let res: Response
      try {
        res = await doFetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(opts.signal ? { signal: opts.signal } : {}) })
      } catch (err) {
        if (opts.signal?.aborted) return { text: reply, stop: 'stopped' }
        throw new Error(`Ollama is not answering at ${base}: is it running? (${err instanceof Error ? err.message : String(err)})`)
      }
      if (!res.ok) {
        const msg = await res.text().catch(() => '')
        // A model without tool support: go on without tools (it still gets About me in its prompt).
        if (this.ollamaTools && /does not support tools/i.test(msg)) {
          this.ollamaTools = false
          opts.onEvent({ type: 'notice', text: `${settings.model} can't use the brain's tools; it answers from what it knows about you. A model like llama3.1 or qwen2.5 can.` })
          continue
        }
        throw new Error(`Ollama: ${msg.slice(0, 300) || res.statusText}`)
      }
      let roundText = ''
      const calls: { function: { name: string; arguments: unknown } }[] = []
      try {
        for await (const chunk of ndjson(res)) {
          const m = (chunk as { message?: OllamaMessage }).message
          if (m?.content) {
            roundText += m.content
            opts.onEvent({ type: 'text', delta: m.content })
          }
          if (m?.tool_calls?.length) calls.push(...m.tool_calls)
          const err = (chunk as { error?: string }).error
          if (err) throw new Error(`Ollama: ${err}`)
        }
      } catch (err) {
        if (opts.signal?.aborted) return { text: reply + roundText, stop: 'stopped' }
        throw err
      }
      reply = roundText
      this.ollama.push({ role: 'assistant', content: roundText, ...(calls.length ? { tool_calls: calls } : {}) })
      if (!calls.length) return { text: reply, stop: 'end_turn' }
      if (roundText) opts.onEvent({ type: 'text', delta: '\n\n' })
      for (const [i, c] of calls.entries()) {
        const id = `ollama-${round}-${i}`
        const name = c.function?.name ?? ''
        let args: unknown = c.function?.arguments
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args)
          } catch {
            args = {}
          }
        }
        opts.onEvent({ type: 'tool', id, name, phase: 'start' })
        const r = defs.some((d) => d.name === name) ? await tools.call(name, args) : { text: `There is no tool "${name}".`, isError: true, activity: null }
        opts.onEvent({ type: 'tool', id, name, phase: r.isError ? 'error' : 'done', summary: r.isError ? r.text.slice(0, 200) : (r.activity?.summary ?? name), path: r.activity?.path ?? null, write: r.activity?.write ?? false })
        this.ollama.push({ role: 'tool', content: r.text, tool_name: name })
      }
      if (opts.signal?.aborted) return { text: reply, stop: 'stopped' }
    }
  }
}

/** The JSON objects of a newline-delimited JSON body. */
async function* ndjson(res: Response): AsyncGenerator<unknown> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (value) buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) yield JSON.parse(line)
    }
    if (done) break
  }
  if (buf.trim()) yield JSON.parse(buf)
}
