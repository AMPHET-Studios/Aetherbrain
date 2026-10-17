/**
 * The brain's chat as main, the renderer and the chat engine (src/mcp/chat.ts)
 * see it: the models it offers, its settings and what a turn streams.
 */

/** The Claude models the chat offers (exact model ids). */
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'understands you best' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'faster, half the price' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'fastest, cheapest' },
] as const

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

export type ChatProvider = 'claude' | 'ollama'

/** What a turn reports while it runs. */
export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; phase: 'start' | 'done' | 'error'; summary?: string; path?: string | null; write?: boolean }
  | { type: 'notice'; text: string }

/**
 * One event of a conversation (`conv`), as main sends it to the brain window.
 * `done` comes last, after every other event of the turn, on the same
 * channel: the window finishes the answer on it (the reply to chatSend can
 * overtake events, which travel separately).
 */
export type ChatEventDto = { conv: string } & (ChatEvent | { type: 'saved'; path: string; title: string } | { type: 'done'; text: string; stop: string })

/** The chat's settings and readiness, for the chat panel. */
export interface ChatStatusDto {
  provider: ChatProvider
  claudeModel: string
  claudeModels: { id: string; label: string; note: string }[]
  /** An API key is set (never sent to the renderer; `keyHint` shows its last four characters). */
  hasKey: boolean
  keyHint: string | null
  /** Where the key lives: encrypted with the system's keychain, or only until the app quits. */
  keyStored: 'encrypted' | 'session' | null
  ollamaUrl: string
  ollamaModel: string
  /** Keep each conversation as a note in Me/Chats. */
  saveChats: boolean
  /** A quiet card offers to plan the day (morning), check in on it (afternoon) and wrap it up (evening). */
  nudges: boolean
  /** A vault is open (the chat works through it). */
  vaultOpen: boolean
  /** Everything needed to chat is there. */
  ready: boolean
  /** What is missing when not ready. */
  missing: string | null
}

export interface ChatPatch {
  provider?: ChatProvider
  claudeModel?: string
  /** A new key; null removes the stored one. */
  apiKey?: string | null
  ollamaUrl?: string
  ollamaModel?: string
  saveChats?: boolean
  nudges?: boolean
}

/** How a turn ended. */
export interface ChatReplyDto {
  text: string
  /** `end_turn`, `refusal`, `max_tokens`, `stopped`, `tool_limit`, … */
  stop: string
  /** The note the conversation is kept in, when it was saved. */
  saved: { path: string; title: string } | null
}
