/**
 * The brain's chat (`q`): a panel docked over the left of the 3D brain, open
 * while you fly around. Answers stream in as live markdown ([[links]] fly to
 * their notes); the tools the model used show as chips under its answer.
 * Settings: Claude with your own API key, or a local Ollama model.
 * The conversation lives in main (src/main/chat-host.ts); this module keeps
 * what the panel shows, in a tiny store outside React.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { todayIso } from '@aether/core'
import { MarkdownPreview, registerCommands, registerHelpRows, registerKey, useAether } from '@aether/ui'
import type { ChatEventDto, ChatStatusDto } from '../../shared/ipc'
import { ElectronVaultAdapter } from '../vault/electron'
import { DAY_PROMPTS, answerNudge, type NudgeKind } from '../nudges'
import { errorText, flyToPath, openPanel } from '../panels'

interface ToolStep {
  id: string
  name: string
  phase: 'start' | 'done' | 'error'
  summary?: string
  path?: string | null
}

interface Msg {
  role: 'user' | 'assistant' | 'notice'
  text: string
  steps: ToolStep[]
  /** Still being written. */
  live?: boolean
}

interface ChatState {
  open: boolean
  conv: string
  /** The local day (YYYY-MM-DD) the conversation's first message was sent, null while it is empty. */
  convDay: string | null
  messages: Msg[]
  busy: boolean
  status: ChatStatusDto | null
  settings: boolean
  error: string | null
  saved: { path: string; title: string } | null
}

const newId = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(36).slice(2)}`)

let state: ChatState = { open: false, conv: newId(), convDay: null, messages: [], busy: false, status: null, settings: false, error: null, saved: null }
const subs = new Set<() => void>()
function set(patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  for (const cb of subs) cb()
}
function useChat(): ChatState {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => state,
  )
}

const bridge = ElectronVaultAdapter.bridge()

async function refreshStatus(): Promise<ChatStatusDto | null> {
  if (!bridge) return null
  try {
    const status = await bridge.chatStatus()
    set((s) => ({ status, settings: s.settings || (!status.ready && status.vaultOpen) }))
    return status
  } catch (err) {
    set({ error: errorText(err) })
    return null
  }
}

/** Open (or close) the chat; opening closes the desktop panels and focuses the message box. */
export function toggleChat(force?: boolean): void {
  const open = force ?? !state.open
  if (open) {
    openPanel(null)
    const s = useAether.getState()
    if (s.paletteOpen) s.setPalette(false)
    void refreshStatus()
  }
  set({ open })
}

/** A new conversation (the last one stays as its note). */
export function newChat(): void {
  if (bridge) void bridge.chatForget(state.conv).catch(() => undefined)
  set({ conv: newId(), convDay: null, messages: [], busy: false, error: null, saved: null })
}

/** Whether the chat has the person's attention: it is open, or still answering (nudges wait for it to be neither). */
export function useChatOccupied(): boolean {
  const s = useChat()
  return s.open || s.busy
}

/**
 * Plan the day (morning), check in on it (afternoon) or wrap it up (evening): the palette, the starters and the nudge cards all
 * come here. It goes on in today's conversation, so the evening knows the morning's plan, and starts a new one when the open
 * conversation is from another day.
 */
export function sendDayPrompt(kind: NudgeKind): void {
  answerNudge(kind, 'start')
  toggleChat(true)
  if (state.messages.length && state.convDay !== todayIso()) newChat()
  void sendChat(DAY_PROMPTS[kind])
}

/** Nudges on or off (the opposite of now when `on` is not given): kept with the chat's settings in main. */
export async function setNudges(on?: boolean): Promise<void> {
  if (!bridge) return
  try {
    const status = state.status ?? (await bridge.chatStatus())
    const next = await bridge.chatConfigure({ nudges: on ?? !status.nudges })
    set({ status: next })
    useAether.getState().toast(next.nudges ? 'Nudges on: a quiet card in the morning, afternoon and evening' : 'Nudges off')
  } catch (err) {
    set({ error: errorText(err) })
  }
}

/** Send `text` in the open conversation. */
export async function sendChat(text: string): Promise<void> {
  const message = text.trim()
  if (!message || !bridge || state.busy) return
  const status = state.status ?? (await refreshStatus())
  if (!status?.ready) {
    set({ settings: true, error: status?.missing ?? 'The chat is not ready' })
    return
  }
  const conv = state.conv
  set((s) => ({ busy: true, error: null, convDay: s.convDay ?? todayIso(), messages: [...s.messages, { role: 'user', text: message, steps: [] }, { role: 'assistant', text: '', steps: [], live: true }] }))
  try {
    // The answer is finished by the turn's `done` event (it comes after every other event of the turn).
    await bridge.chatSend(conv, message)
  } catch (err) {
    if (state.conv !== conv) return
    set((s) => ({ busy: false, messages: [...s.messages.filter((m) => !(m.live && !m.text && !m.steps.length)).map((m) => ({ ...m, live: false })), { role: 'notice', text: errorText(err), steps: [] }] }))
  }
}

function onEvent(e: ChatEventDto): void {
  if (e.conv !== state.conv) return
  if (e.type === 'saved') {
    set({ saved: { path: e.path, title: e.title } })
    return
  }
  if (e.type === 'done') {
    set((s) => ({ busy: false, messages: s.messages.filter((m) => !(m.live && !m.text && !m.steps.length)).map((m) => (m.live ? { ...m, live: false } : m)) }))
    return
  }
  if (e.type === 'notice') {
    set((s) => ({ messages: [...s.messages, { role: 'notice', text: e.text, steps: [] }] }))
    return
  }
  set((s) => {
    const messages = [...s.messages]
    let i = messages.length - 1
    while (i >= 0 && !(messages[i]!.role === 'assistant' && messages[i]!.live)) i--
    if (i < 0) {
      messages.push({ role: 'assistant', text: '', steps: [], live: true })
      i = messages.length - 1
    }
    const m = { ...messages[i]! }
    if (e.type === 'text') m.text += e.delta
    else {
      const step: ToolStep = { id: e.id, name: e.name, phase: e.phase, ...(e.summary ? { summary: e.summary } : {}), ...(e.path !== undefined ? { path: e.path } : {}) }
      const at = m.steps.findIndex((x) => x.id === e.id)
      m.steps = at >= 0 ? m.steps.map((x, j) => (j === at ? step : x)) : [...m.steps, step]
    }
    messages[i] = m
    return { messages }
  })
}

/** `day`: one of the day's three prompts (it goes through `sendDayPrompt`, so the morning card knows it is done). */
const STARTERS: { label: string; text: string; day?: NudgeKind }[] = [
  { label: 'Get to know me', text: "Let's get to know each other. Ask me one thing at a time." },
  { label: 'Plan my day', text: DAY_PROMPTS.morning, day: 'morning' },
  { label: 'Check in', text: "Let's do a quick check-in." },
  { label: "What's on today?", text: "What's on for me today?" },
  { label: 'How have I been?', text: 'How have I been doing lately?' },
]

const TOOL_ICON: Record<string, string> = {
  about_me: '🪪',
  remember_about_me: '💾',
  check_in: '📝',
  my_trends: '📈',
  wellbeing_playbook: '📘',
  search_notes: '🔎',
  read_note: '📖',
  daily_brief: '☀',
  recent_notes: '🕘',
  list_projects: '★',
  get_project: '★',
}

/** The chat panel (rendered by the desktop app; nothing when closed). */
export function ChatPanel() {
  const s = useChat()
  const [draft, setDraft] = useState('')
  const box = useRef<HTMLTextAreaElement | null>(null)
  const end = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (s.open && !s.settings) box.current?.focus()
  }, [s.open, s.settings])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [s.messages])

  if (!s.open) return null
  const status = s.status
  const model = status ? (status.provider === 'claude' ? (status.claudeModels.find((m) => m.id === status.claudeModel)?.label ?? 'Claude') : `${status.ollamaModel || 'Ollama'} · local`) : ''

  const submit = () => {
    const text = draft
    if (!text.trim() || s.busy) return
    setDraft('')
    void sendChat(text)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (draft) setDraft('')
      else toggleChat(false)
    }
  }

  return (
    <aside aria-label="Brain chat" className="panel rise fixed bottom-3 left-3 top-[60px] z-[40] flex w-[min(440px,calc(100vw-24px))] flex-col !bg-[rgba(8,10,26,0.96)]">
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
        <span className="text-[14.5px] font-semibold text-white">💬 Brain chat</span>
        {model && <span className="min-w-0 truncate text-[11.5px] text-dim">{model}</span>}
        <span className="flex-1" />
        <button type="button" className="hud-btn" onClick={newChat} disabled={s.busy} title="Start a new conversation (this one stays as a note)">
          New
        </button>
        <button type="button" className="hud-btn" aria-pressed={s.settings} onClick={() => set({ settings: !s.settings })} title="Chat settings">
          ⚙
        </button>
        <button type="button" className="hud-btn" onClick={() => toggleChat(false)} title="Close (Esc in an empty message box, or q)">
          ✕
        </button>
      </div>

      {s.settings ? (
        <ChatSettings status={status} />
      ) : (
        <div className="scroll min-h-0 flex-1 px-4 py-3" aria-live="polite">
          {s.messages.length === 0 && (
            <div className="mb-3 text-[13px] leading-relaxed text-dim">
              <p className="mb-2 text-white">Hi! I live in your brain: I can read your notes, help you plan, check in on how you are, and remember what you want me to know about you.</p>
              <p className="mb-3">What I learn goes into your own notes in Me/ (About me, Check-ins), and you can change anything there.</p>
              <div className="flex flex-wrap gap-1.5">
                {STARTERS.map((x) => (
                  <button key={x.label} type="button" className="hud-btn" disabled={s.busy} onClick={() => (x.day ? sendDayPrompt(x.day) : void sendChat(x.text))}>
                    {x.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {s.messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="mb-3 ml-10 whitespace-pre-wrap rounded-xl bg-accent/20 px-3 py-2 text-[13.5px] text-white">
                {m.text}
              </div>
            ) : m.role === 'notice' ? (
              <div key={i} className="mb-3 rounded-lg border border-[var(--line)] bg-black/30 px-3 py-2 text-[12.5px] text-dim" role="status">
                {m.text}
              </div>
            ) : (
              <div key={i} className="mb-3">
                {m.steps.length > 0 && (
                  <div className="mb-1.5 flex flex-wrap gap-1">
                    {m.steps.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={`rounded-md border border-[var(--line)] px-1.5 py-0.5 text-[11px] ${t.phase === 'error' ? 'text-danger' : 'text-dim'} ${t.path ? 'hover:border-accent/60' : 'cursor-default'}`}
                        onClick={() => t.path && flyToPath(t.path)}
                        title={t.path ? `${t.summary ?? t.name} · fly there` : (t.summary ?? t.name)}
                      >
                        {TOOL_ICON[t.name] ?? '⚙'} {t.phase === 'start' ? `${t.name.replace(/_/g, ' ')}…` : (t.summary ?? t.name)}
                      </button>
                    ))}
                  </div>
                )}
                {m.text ? (
                  <MarkdownPreview source={m.text} className="md !p-0 text-[13.5px]" />
                ) : (
                  m.live && <span className="text-[12.5px] text-faint">thinking…</span>
                )}
              </div>
            ),
          )}
          {s.saved && (
            <button type="button" className="mb-2 text-[11.5px] text-faint hover:text-dim" onClick={() => flyToPath(s.saved!.path)} title="Fly to the note this chat is kept in">
              Kept as {s.saved.path}
            </button>
          )}
          <div ref={end} />
        </div>
      )}

      {s.error && !s.settings && (
        <div className="mx-4 mb-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-[12px] text-danger" role="alert">
          {s.error}
        </div>
      )}
      {!s.settings && (
        <div className="flex items-end gap-2 border-t border-[var(--line)] px-3 py-2.5">
          <textarea
            ref={box}
            className="input min-h-[40px] flex-1 resize-none !py-2 !text-[13.5px]"
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder={status && !status.ready ? (status.missing ?? '') : 'Talk to your brain…  (Enter sends, Shift+Enter new line)'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            aria-label="Message"
          />
          {s.busy ? (
            <button type="button" className="hud-btn" onClick={() => bridge && void bridge.chatStop(s.conv)}>
              Stop
            </button>
          ) : (
            <button type="button" className="hud-btn primary" onClick={submit} disabled={!draft.trim()}>
              Send
            </button>
          )}
        </div>
      )}
    </aside>
  )
}

function ChatSettings({ status }: { status: ChatStatusDto | null }) {
  const [key, setKey] = useState('')
  const [url, setUrl] = useState(status?.ollamaUrl ?? '')
  const [ollamaModel, setOllamaModel] = useState(status?.ollamaModel ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setUrl(status?.ollamaUrl ?? '')
    setOllamaModel(status?.ollamaModel ?? '')
  }, [status?.ollamaUrl, status?.ollamaModel])
  if (!bridge || !status) return <div className="px-4 py-3 text-[12.5px] text-dim">Loading…</div>

  const configure = async (patch: Parameters<NonNullable<typeof bridge>['chatConfigure']>[0]) => {
    setBusy(true)
    setError(null)
    try {
      const next = await bridge.chatConfigure(patch)
      set({ status: next, error: null })
      return next
    } catch (err) {
      setError(errorText(err))
      return null
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scroll min-h-0 flex-1 px-4 py-3 text-[12.5px]">
      {error && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-danger" role="alert">
          {error}
        </div>
      )}
      {!status.vaultOpen && <p className="mb-3 text-dim">Open a vault first: the chat works through your notes.</p>}
      <div className="section-title mb-1.5">Who answers</div>
      <div className="mb-3 flex gap-1.5">
        <button type="button" className={`hud-btn ${status.provider === 'claude' ? 'primary' : ''}`} disabled={busy} onClick={() => void configure({ provider: 'claude' })}>
          Claude
        </button>
        <button type="button" className={`hud-btn ${status.provider === 'ollama' ? 'primary' : ''}`} disabled={busy} onClick={() => void configure({ provider: 'ollama' })}>
          Ollama (on this computer)
        </button>
      </div>

      {status.provider === 'claude' ? (
        <>
          <div className="section-title mb-1.5">Model</div>
          <div className="mb-3 flex flex-col gap-1">
            {status.claudeModels.map((m) => (
              <label key={m.id} className="flex cursor-pointer items-center gap-2 text-white">
                <input type="radio" name="claude-model" checked={status.claudeModel === m.id} disabled={busy} onChange={() => void configure({ claudeModel: m.id })} />
                {m.label} <span className="text-faint">· {m.note}</span>
              </label>
            ))}
          </div>
          <div className="section-title mb-1.5">Anthropic API key</div>
          {status.hasKey ? (
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-white">{status.keyHint}</span>
              <span className="text-faint">{status.keyStored === 'encrypted' ? 'stored encrypted by your system' : 'kept until the app quits (no system keychain)'}</span>
              <span className="flex-1" />
              <button type="button" className="hud-btn" disabled={busy} onClick={() => void configure({ apiKey: null })}>
                Remove
              </button>
            </div>
          ) : (
            <form
              className="mb-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void configure({ apiKey: key }).then((next) => {
                  if (next) {
                    setKey('')
                    if (next.ready) set({ settings: false })
                  }
                })
              }}
            >
              <input className="input flex-1 !py-1.5 !text-[12.5px]" type="password" autoComplete="off" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Anthropic API key" />
              <button type="submit" className="hud-btn primary" disabled={busy || !key.trim()}>
                Save
              </button>
            </form>
          )}
          <p className="mb-3 leading-relaxed text-faint">
            Make one at console.anthropic.com → API keys (you pay per use). With Claude, your messages and the notes it reads are sent to Anthropic to answer; the key never leaves main.
          </p>
        </>
      ) : (
        <form
          className="mb-3"
          onSubmit={(e) => {
            e.preventDefault()
            void configure({ ollamaUrl: url, ollamaModel }).then((next) => next?.ready && set({ settings: false }))
          }}
        >
          <div className="section-title mb-1.5">Ollama</div>
          <label className="mb-1.5 block text-dim">
            Address
            <input className="input mt-1 !py-1.5 !text-[12.5px]" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Ollama address" />
          </label>
          <label className="mb-2 block text-dim">
            Model (one you pulled, e.g. llama3.1 or qwen2.5)
            <input className="input mt-1 !py-1.5 !text-[12.5px]" value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} placeholder="llama3.1" aria-label="Ollama model" />
          </label>
          <button type="submit" className="hud-btn primary" disabled={busy}>
            Save
          </button>
          <p className="mt-2 leading-relaxed text-faint">Nothing leaves this computer. Smaller local models understand you less well than Claude.</p>
        </form>
      )}

      <label className="mb-3 flex cursor-pointer items-center gap-2 text-white">
        <input type="checkbox" checked={status.saveChats} disabled={busy} onChange={(e) => void configure({ saveChats: e.target.checked })} />
        Keep each chat as a note in Me/Chats
      </label>
      <label className="mb-3 flex cursor-pointer items-center gap-2 text-white">
        <input type="checkbox" checked={status.nudges} disabled={busy} onChange={(e) => void configure({ nudges: e.target.checked })} />
        <span>
          A quiet card offers to plan my day <span className="text-faint">· morning, afternoon, evening; no sound</span>
        </span>
      </label>
      {status.ready && (
        <button type="button" className="hud-btn primary" onClick={() => set({ settings: false })}>
          Back to the chat
        </button>
      )}
    </div>
  )
}

/** Key, palette commands, cheatsheet rows and the event feed (desktop only). */
export function registerChat(): void {
  if (!bridge) return
  bridge.onChatEvent(onEvent)
  registerKey('q', () => toggleChat())
  registerCommands([
    { id: 'chat', title: 'Chat with your brain', keys: 'q', group: 'navigate', run: () => toggleChat(true) },
    {
      id: 'chat-new',
      title: 'New brain chat',
      group: 'navigate',
      run: () => {
        newChat()
        toggleChat(true)
      },
    },
    {
      id: 'chat-check-in',
      title: 'Check in with your brain (mood, sleep, energy…)',
      group: 'navigate',
      run: () => {
        toggleChat(true)
        void sendChat("Let's do a quick check-in.")
      },
    },
    { id: 'chat-plan-day', title: 'Plan my day with your brain', hint: 'pick what matters today, start the first thing', group: 'navigate', run: () => sendDayPrompt('morning') },
    { id: 'chat-check-day', title: 'Check in on my day with your brain', hint: "what's done, re-plan the rest, no guilt", group: 'navigate', run: () => sendDayPrompt('afternoon') },
    { id: 'chat-wrap-day', title: 'Wrap up my day with your brain', hint: 'one win, one thing to carry over, a clear stop', group: 'navigate', run: () => sendDayPrompt('evening') },
    { id: 'nudges', title: 'Nudges: the quiet day-planning cards on / off', hint: 'a card in the morning, afternoon and evening; no sound', group: 'view', run: () => void setNudges() },
  ])
  registerHelpRows('Desktop', [
    ['q', 'Chat with your brain: it reads your notes, checks in, remembers what you tell it to'],
    ['/ plan my day', 'Plan the day with the chat (also: check in on it, wrap it up). A quiet card offers each in turn; turn it off in the chat’s ⚙'],
  ])
}
