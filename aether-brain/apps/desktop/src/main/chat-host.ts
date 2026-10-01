/**
 * The brain's chat, main side: its settings (the API key kept encrypted with
 * the system's keychain, never sent to the renderer), the conversations held
 * in memory, and each turn run by the chat engine of the MCP bundle
 * (src/mcp/chat.ts) over the AI link's brain. Pure of Electron: main passes
 * the keychain, the brain and the event sink in.
 *
 * Sending: Claude gets the conversation and what its tools read from the
 * vault (api.anthropic.com, the user's own key); Ollama runs on this computer.
 * Nothing is sent before the user sets a key or a local model and writes.
 */
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, DEFAULT_OLLAMA_URL, type ChatEventDto, type ChatPatch, type ChatProvider, type ChatReplyDto, type ChatStatusDto } from '../shared/chat.js'

/** Persisted in settings.json under `chat`. */
export interface ChatSettingsStored {
  provider: ChatProvider
  claudeModel: string
  ollamaUrl: string
  ollamaModel: string
  saveChats: boolean
  /** The API key, encrypted by the system's keychain (base64). */
  key?: string
}

/** Settings as stored, repaired (unknown fields dropped, bad values defaulted). */
export function chatSettings(raw: unknown): ChatSettingsStored {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d)
  const out: ChatSettingsStored = {
    provider: r['provider'] === 'ollama' ? 'ollama' : 'claude',
    claudeModel: CLAUDE_MODELS.some((m) => m.id === r['claudeModel']) ? (r['claudeModel'] as string) : DEFAULT_CLAUDE_MODEL,
    ollamaUrl: str(r['ollamaUrl'], DEFAULT_OLLAMA_URL),
    ollamaModel: typeof r['ollamaModel'] === 'string' ? r['ollamaModel'].trim().slice(0, 200) : '',
    saveChats: r['saveChats'] !== false,
  }
  if (typeof r['key'] === 'string' && r['key']) out.key = r['key']
  return out
}

/** True for an address on this computer. */
function loopback(url: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^\[|\]$/g, '')
    return (u.protocol === 'http:' || u.protocol === 'https:') && (host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host))
  } catch {
    return false
  }
}

/* The parts of the MCP bundle the chat uses (it is imported at runtime; see ai-link.ts). */
interface ChatBrain {
  readonly roots: { path: string; mount: string; label: string }[]
  readonly home: string
  readonly readOnly: boolean
  aboutMe(): Promise<{ path: string; exists: boolean; text: string; empty: string[]; checkIns: unknown }>
  ensureMe(): Promise<string[]>
  saveBrainChat(input: {
    title: string
    assistant: string
    model: string
    messages: { role: 'user' | 'assistant'; text: string; time: string }[]
    path?: string | null
  }): Promise<{ path: string; title: string }>
}
interface ChatTools {
  close(): Promise<void>
}
interface EngineSettings {
  provider: ChatProvider
  model: string
  apiKey?: string
  ollamaUrl?: string
}
interface ChatThread {
  readonly transcript: { role: 'user' | 'assistant'; text: string; time: string }[]
  continues(settings: EngineSettings): boolean
  send(text: string, settings: EngineSettings, tools: ChatTools, opts: { onEvent: (e: object) => void; signal?: AbortSignal }): Promise<{ text: string; stop: string }>
}
interface ChatModule {
  BrainTools: { open(brain: unknown): Promise<ChatTools> }
  ChatThread: new (ctx: { aboutMe: string; aboutMePath: string; empty: string[]; checkIns: unknown; vault: string; started: Date }) => ChatThread
}

export interface ChatHostOptions {
  settings: ChatSettingsStored
  save: (s: ChatSettingsStored) => void | Promise<void>
  /** The open brain and the MCP bundle (the AI link's; opened when needed). */
  brain: () => Promise<{ brain: unknown; mod: unknown }>
  /** A vault is open. */
  vaultOpen: () => boolean
  /** The chat is configured: keep the brain open with the vault. */
  wantBrain: (on: boolean) => void
  emit: (e: ChatEventDto) => void
  /** The system keychain (Electron safeStorage); strings in and out, base64 for the encrypted side. */
  keychain: { available(): boolean; encrypt(text: string): string; decrypt(base64: string): string }
}

interface Conversation {
  thread: ChatThread
  brain: unknown
  note: { path: string; title: string } | null
  ctrl: AbortController | null
}

const CONV_ID = /^[A-Za-z0-9_-]{6,80}$/
const MAX_MESSAGE = 20_000

export class ChatHost {
  private settings: ChatSettingsStored
  /** The key when it could not be stored encrypted (gone when the app quits), or decrypted once. */
  private key: string | null = null
  private keySession = false
  private convs = new Map<string, Conversation>()
  private tools: { brain: unknown; tools: Promise<ChatTools> } | null = null

  constructor(private readonly opts: ChatHostOptions) {
    this.settings = { ...opts.settings }
    if (this.configured()) opts.wantBrain(true)
  }

  status(): ChatStatusDto {
    const s = this.settings
    const key = this.currentKey()
    const vaultOpen = this.opts.vaultOpen()
    let missing: string | null = null
    if (!vaultOpen) missing = 'Open a vault first'
    else if (s.provider === 'claude' && !key) missing = 'Add your Anthropic API key in the chat settings'
    else if (s.provider === 'ollama' && !s.ollamaModel) missing = 'Choose an Ollama model in the chat settings'
    else if (s.provider === 'ollama' && !loopback(s.ollamaUrl)) missing = 'Ollama must run on this computer (http://127.0.0.1:11434)'
    return {
      provider: s.provider,
      claudeModel: s.claudeModel,
      claudeModels: CLAUDE_MODELS.map((m) => ({ ...m })),
      hasKey: !!key,
      keyHint: key ? `…${key.slice(-4)}` : null,
      keyStored: key ? (this.keySession ? 'session' : 'encrypted') : null,
      ollamaUrl: s.ollamaUrl,
      ollamaModel: s.ollamaModel,
      saveChats: s.saveChats,
      vaultOpen,
      ready: missing === null,
      missing,
    }
  }

  async configure(patch: ChatPatch): Promise<ChatStatusDto> {
    const next: ChatSettingsStored = { ...this.settings }
    if (patch.provider === 'claude' || patch.provider === 'ollama') next.provider = patch.provider
    if (typeof patch.claudeModel === 'string' && CLAUDE_MODELS.some((m) => m.id === patch.claudeModel)) next.claudeModel = patch.claudeModel
    if (typeof patch.ollamaUrl === 'string') {
      const url = patch.ollamaUrl.trim() || DEFAULT_OLLAMA_URL
      if (!loopback(url)) throw new Error('Ollama must run on this computer: use an address like http://127.0.0.1:11434')
      next.ollamaUrl = url
    }
    if (typeof patch.ollamaModel === 'string') next.ollamaModel = patch.ollamaModel.trim().slice(0, 200)
    if (typeof patch.saveChats === 'boolean') next.saveChats = patch.saveChats
    if (patch.apiKey === null) {
      delete next.key
      this.key = null
      this.keySession = false
    } else if (typeof patch.apiKey === 'string') {
      const key = patch.apiKey.trim()
      if (key.length < 20 || key.length > 400 || /\s/.test(key)) throw new Error("That doesn't look like an Anthropic API key (it starts with sk-ant-)")
      this.key = key
      if (this.opts.keychain.available()) {
        next.key = this.opts.keychain.encrypt(key)
        this.keySession = false
      } else {
        // No keychain to protect it: kept until the app quits, never written down.
        delete next.key
        this.keySession = true
      }
    }
    this.settings = next
    await this.opts.save({ ...next })
    if (this.configured()) this.opts.wantBrain(true)
    return this.status()
  }

  /** Answer `text` in conversation `conv` (made on its first message). Events stream through `emit`. */
  async send(conv: unknown, text: unknown): Promise<ChatReplyDto> {
    if (typeof conv !== 'string' || !CONV_ID.test(conv)) throw new Error('Not a conversation id')
    const message = typeof text === 'string' ? text.trim() : ''
    if (!message) throw new Error('Nothing to send')
    if (message.length > MAX_MESSAGE) throw new Error(`That message is too long (at most ${MAX_MESSAGE.toLocaleString('en-US')} characters)`)
    const st = this.status()
    if (!st.ready) throw new Error(st.missing ?? 'The chat is not ready')
    const engine = this.engineSettings()
    let c = this.convs.get(conv)
    if (c?.ctrl) throw new Error('Still answering the last message')
    const { brain: rawBrain, mod } = await this.opts.brain()
    const brain = rawBrain as ChatBrain
    const m = mod as ChatModule
    if (typeof m.ChatThread !== 'function' || typeof m.BrainTools?.open !== 'function') throw new Error('The chat engine is missing from the AI link bundle; reinstall the app')
    // Another vault since: a new conversation (it knows the person as of now).
    if (c && (c.brain !== rawBrain || !c.thread.continues(engine))) c = undefined
    if (!c) {
      if (!brain.readOnly) await brain.ensureMe().catch(() => [])
      const me = await brain.aboutMe()
      const vault = describeVault(brain)
      c = { thread: new m.ChatThread({ aboutMe: me.text, aboutMePath: me.path, empty: me.empty, checkIns: me.checkIns, vault, started: new Date() }), brain: rawBrain, note: null, ctrl: null }
      this.convs.set(conv, c)
    }
    const tools = await this.toolsFor(rawBrain, m)
    const ctrl = new AbortController()
    c.ctrl = ctrl
    try {
      let r: { text: string; stop: string }
      try {
        r = await c.thread.send(message, engine, tools, { onEvent: (e) => this.opts.emit({ ...(e as ChatEventDto), conv }), signal: ctrl.signal })
      } catch (err) {
        this.opts.emit({ conv, type: 'done', text: '', stop: 'error' })
        throw new Error(friendlyError(err))
      }
      let saved: ChatReplyDto['saved'] = null
      if (this.settings.saveChats && !brain.readOnly && c.thread.transcript.some((x) => x.role === 'assistant')) {
        try {
          saved = await brain.saveBrainChat({
            title: titleOf(c.thread.transcript),
            assistant: assistantName(engine),
            model: engine.model,
            messages: c.thread.transcript,
            path: c.note?.path ?? null,
          })
          c.note = saved
          this.opts.emit({ conv, type: 'saved', path: saved.path, title: saved.title })
        } catch (err) {
          this.opts.emit({ conv, type: 'notice', text: `Could not keep this chat as a note: ${err instanceof Error ? err.message : String(err)}` })
        }
      }
      this.opts.emit({ conv, type: 'done', text: r.text, stop: r.stop })
      return { text: r.text, stop: r.stop, saved }
    } finally {
      c.ctrl = null
    }
  }

  /** Stop the answer being written in `conv`. */
  stop(conv: unknown): void {
    if (typeof conv === 'string') this.convs.get(conv)?.ctrl?.abort()
  }

  /** Let go of a conversation (a new chat); its note stays. */
  forget(conv: unknown): void {
    if (typeof conv !== 'string') return
    this.convs.get(conv)?.ctrl?.abort()
    this.convs.delete(conv)
  }

  async close(): Promise<void> {
    for (const c of this.convs.values()) c.ctrl?.abort()
    this.convs.clear()
    const t = this.tools
    this.tools = null
    if (t) await (await t.tools.catch(() => null))?.close().catch(() => undefined)
  }

  private configured(): boolean {
    const s = this.settings
    return s.provider === 'claude' ? !!this.currentKey() : !!s.ollamaModel
  }

  private currentKey(): string | null {
    if (this.key) return this.key
    if (!this.settings.key) return null
    try {
      this.key = this.opts.keychain.decrypt(this.settings.key)
      return this.key
    } catch {
      // Encrypted on another machine or account: it has to be entered again.
      return null
    }
  }

  private engineSettings(): EngineSettings {
    const s = this.settings
    if (s.provider === 'ollama') return { provider: 'ollama', model: s.ollamaModel, ollamaUrl: s.ollamaUrl }
    const key = this.currentKey()
    return { provider: 'claude', model: s.claudeModel, ...(key ? { apiKey: key } : {}) }
  }

  /** The brain's tools for `brain`, opened once per brain (the old ones close when the vault changes). */
  private toolsFor(brain: unknown, m: ChatModule): Promise<ChatTools> {
    const old = this.tools
    if (old && old.brain === brain) return old.tools
    if (old) void old.tools.then((t) => t.close()).catch(() => undefined)
    const tools = m.BrainTools.open(brain)
    this.tools = { brain, tools }
    tools.catch(() => {
      if (this.tools?.tools === tools) this.tools = null
    })
    return tools
  }
}

/** The vault as the chat's prompt describes it. */
function describeVault(b: ChatBrain): string {
  const roots = b.roots.map((r) => r.label).join(' + ')
  const home = b.home || ''
  return [
    `Folders: ${roots}. New notes go to ${home}Inbox unless a folder is given.`,
    `The person's own notes live in ${home}Me: About me, Check-ins, Wellbeing playbook, and these chats (Me/Chats).`,
    b.readOnly ? 'This brain is read-only right now: nothing can be written.' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** A conversation's title: its first words. */
function titleOf(transcript: { role: string; text: string }[]): string {
  const first = transcript.find((m) => m.role === 'user')?.text ?? 'Brain chat'
  const words = first.replace(/[\r\n#[\]|*_`>]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ')
  return (words.length > 60 ? `${words.slice(0, 59)}…` : words) || 'Brain chat'
}

function assistantName(s: EngineSettings): string {
  if (s.provider === 'ollama') return `${s.model} (local)`
  return CLAUDE_MODELS.find((m) => m.id === s.model)?.label ?? 'Claude'
}

/** One line for an API or network error (the SDK's errors carry an HTTP status). */
function friendlyError(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status
  const msg = err instanceof Error ? err.message : String(err)
  if (status === 401) return 'Anthropic refused the API key: check it in the chat settings'
  if (status === 403) return "That API key isn't allowed to use this model"
  if (status === 429) return 'Too many requests for now (rate limit); try again in a minute'
  if (status === 529 || status === 503) return 'Claude is busy right now; try again in a moment'
  if (typeof status === 'number' && status >= 500) return `Claude had a problem (${status}); try again`
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(msg)) return `Can't reach the model: ${msg}`
  return msg
}
