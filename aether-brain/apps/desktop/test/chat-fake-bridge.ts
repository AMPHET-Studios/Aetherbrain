/**
 * The chat panel module with a bridge that records what it is asked, in a fresh module state: for the tests of what the desktop's
 * renderer does with the chat (the day prompts, the nudges, the top bar's Chat button).
 */
import { vi } from 'vitest'
import type { OllamaCheckDto } from '../src/shared/chat'

/** `ollama`: what the bridge says when asked about Ollama (the default: not running). */
export async function panel(ollama: OllamaCheckDto = { url: 'http://127.0.0.1:11434', reachable: false, models: [], error: 'Nothing answered' }) {
  vi.resetModules()
  const calls = { send: [] as [string, string][], forget: [] as string[], configure: [] as { nudges?: boolean }[] }
  let feed: ((e: unknown) => void) | null = null
  let status = {
    provider: 'claude',
    claudeModel: 'claude-opus-5-5',
    claudeModels: [],
    hasKey: true,
    keyHint: '…WXYZ',
    keyStored: 'encrypted',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: '',
    saveChats: true,
    nudges: true,
    vaultOpen: true,
    ready: true,
    missing: null,
  }
  const bridge = {
    chatStatus: async () => status,
    chatConfigure: async (patch: { nudges?: boolean }) => {
      calls.configure.push(patch)
      status = { ...status, ...patch }
      return status
    },
    chatSend: async (conv: string, text: string) => {
      calls.send.push([conv, text])
      return { text: '', stop: 'end_turn', saved: null }
    },
    chatForget: async (conv: string) => void calls.forget.push(conv),
    chatStop: async () => undefined,
    chatOllama: async () => ollama,
    onChatEvent: (cb: (e: unknown) => void) => {
      feed = cb
      return () => undefined
    },
  }
  // A navigator too: the 3D stack's GPU check (detect-gpu) reads window.navigator the first time it loads, whichever test gets there first.
  vi.stubGlobal('window', { aether: bridge, navigator: { userAgent: 'node', platform: 'node', maxTouchPoints: 0 }, addEventListener: () => undefined, removeEventListener: () => undefined })
  const chat = await import('../src/renderer/components/ChatPanel')
  const ui = await import('@aether/ui')
  const commands = await import('../../../packages/ui/src/commands')
  chat.registerChat()
  /** The model finishes answering `conv` (the panel is busy until it does). */
  const finish = () => {
    const conv = calls.send.at(-1)![0]
    feed!({ conv, type: 'done', text: '', stop: 'end_turn' })
  }
  const nudges = await import('../src/renderer/nudges')
  const topbar = await import('../../../packages/ui/src/topbarButtons')
  return { chat, ui, commands, calls, finish, nudges, topbar }
}
