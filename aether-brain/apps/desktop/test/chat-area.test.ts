import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatHost, chatSettings } from '../src/main/chat-host'
import type { OllamaCheckDto } from '../src/shared/chat'
import { panel } from './chat-fake-bridge'
import { lf } from './lf'

/**
 * The chat area: a 💬 Chat button in the top bar that is always there, and a settings screen that says what the AI behind it needs
 * (the app has the chat; the model is one you connect) and what Ollama on this computer has (docs/BRAIN-CHAT.md).
 */

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const doc = (p: string) => lf(readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8'))

describe('the Chat button in the top bar', () => {
  it('is registered by the desktop, opens and closes the chat, and shows pressed while it is open', async () => {
    const { topbar } = await panel()
    const button = topbar.topBarButtons().find((b) => b.id === 'chat')
    expect(button).toBeDefined()
    expect(button!.title).toBe('Chat with your brain (q)')
    expect(button!.key).toBe('q')
    expect(button!.icon).toBe('💬')
    expect(button!.pressed!()).toBe(false)

    let heard = 0
    const stop = button!.subscribe!(() => void heard++)
    button!.run()
    expect(button!.pressed!()).toBe(true)
    expect(heard).toBeGreaterThan(0)
    button!.run()
    expect(button!.pressed!()).toBe(false)
    // Nobody is told once it stops listening.
    stop()
    const before = heard
    button!.run()
    expect(heard).toBe(before)
  })

  it('is on the one list of buttons once, however many times the chat is registered', async () => {
    const { chat, topbar } = await panel()
    chat.registerChat()
    chat.registerChat()
    expect(topbar.topBarButtons().filter((b) => b.id === 'chat')).toHaveLength(1)
  })
})

describe('what the Ollama block of the settings says', () => {
  const view = async (props: { found: OllamaCheckDto | null; model?: string; checking?: boolean }): Promise<string> => {
    vi.resetModules()
    const { OllamaStatusView } = await import('../src/renderer/components/ChatPanel')
    const noop = () => undefined
    const html = renderToStaticMarkup(createElement(OllamaStatusView, { found: props.found, model: props.model ?? '', checking: props.checking ?? false, onPick: noop, onCheck: noop }))
    // As text (&#x27; is an apostrophe).
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/&#x27;/g, "'")
  }
  const url = 'http://127.0.0.1:11434'

  it('is looking, until it has an answer', async () => {
    const text = await view({ found: null })
    expect(text).toContain('Looking for Ollama on this computer')
    expect(text).toContain('Check again')
  })

  it('says Ollama is not running, and how to get it and a model', async () => {
    const text = await view({ found: { url, reachable: false, models: [], error: 'Nothing answered' } })
    expect(text).toContain('Ollama is not running here (nothing answered).')
    expect(text).toContain('Install it from ollama.com')
    expect(text).toContain('ollama pull qwen3:8b')
    expect(text).toContain('about 5 GB')
  })

  it('says a running Ollama has no model yet, and what to run', async () => {
    const text = await view({ found: { url, reachable: true, models: [], error: null } })
    expect(text).toContain('Ollama is running on this computer.')
    expect(text).toContain('It has no model yet')
    expect(text).toContain('ollama pull qwen3:8b')
  })

  it('lists the models it has as buttons, the one in use pressed', async () => {
    vi.resetModules()
    const { OllamaStatusView } = await import('../src/renderer/components/ChatPanel')
    const noop = () => undefined
    const html = renderToStaticMarkup(
      createElement(OllamaStatusView, { found: { url, reachable: true, models: ['llama3.1:8b', 'qwen3:8b'], error: null }, model: 'qwen3:8b', checking: false, onPick: noop, onCheck: noop }),
    )
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>qwen3:8b<\/button>/)
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>llama3\.1:8b<\/button>/)
    expect(html).toContain('click one to use it')
  })

  it('does not let Check again be pressed while it is looking', async () => {
    vi.resetModules()
    const { OllamaStatusView } = await import('../src/renderer/components/ChatPanel')
    const noop = () => undefined
    const html = renderToStaticMarkup(createElement(OllamaStatusView, { found: null, model: '', checking: true, onPick: noop, onCheck: noop }))
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Looking…<\/button>/)
  })
})

describe('asking Ollama on this computer (main)', () => {
  function host(settings: Record<string, unknown>, fetch: typeof globalThis.fetch) {
    return new ChatHost({
      settings: chatSettings(settings),
      save: () => undefined,
      brain: async () => ({ brain: {}, mod: {} }),
      vaultOpen: () => true,
      wantBrain: () => undefined,
      emit: () => undefined,
      keychain: { available: () => true, encrypt: (t) => t, decrypt: (b) => b },
      fetch,
    })
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('lists the models it has, sorted, from the address in the settings and nowhere else', async () => {
    const asked: string[] = []
    const fetch = async (u: string | URL | Request) => {
      asked.push(String(u))
      return json({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.1:8b' }, { name: 7 }, null, { name: '' }, 'nope'] })
    }
    const found = await host({ ollamaUrl: 'http://127.0.0.1:11434///' }, fetch as typeof globalThis.fetch).ollamaCheck()
    expect(asked).toEqual(['http://127.0.0.1:11434/api/tags'])
    expect(found).toEqual({ url: 'http://127.0.0.1:11434///', reachable: true, models: ['llama3.1:8b', 'qwen3:8b'], error: null })
  })

  it('says so when it answers with a failure, with nothing, or with something that is not a list', async () => {
    const failing = await host({}, (async () => json({ error: 'busy' }, 503)) as typeof globalThis.fetch).ollamaCheck()
    expect(failing).toMatchObject({ reachable: false, models: [], error: 'It answered 503' })
    const silent = await host({}, (async () => {
      throw new TypeError('fetch failed')
    }) as typeof globalThis.fetch).ollamaCheck()
    expect(silent).toMatchObject({ reachable: false, models: [], error: 'Nothing answered' })
    const odd = await host({}, (async () => json({ models: 'many' })) as typeof globalThis.fetch).ollamaCheck()
    expect(odd).toMatchObject({ reachable: true, models: [], error: null })
  })

  it('never asks an address that is not this computer, whatever the settings file says', async () => {
    const fetch = vi.fn(async () => json({ models: [{ name: 'x' }] }))
    const found = await host({ ollamaUrl: 'http://example.com:11434' }, fetch as unknown as typeof globalThis.fetch).ollamaCheck()
    expect(fetch).not.toHaveBeenCalled()
    expect(found).toMatchObject({ reachable: false, models: [], error: 'Ollama must run on this computer' })
  })
})

describe('the documents', () => {
  it('tell where the chat is and what the AI behind it needs', () => {
    const chat = doc('docs/BRAIN-CHAT.md')
    expect(chat).toContain('Click the 💬 Chat button in the top bar, or press `q`')
    expect(chat).toContain('the AI that answers is not inside it: nothing is bundled')
    expect(chat).toContain('`ollama pull qwen3:8b`')
    expect(chat).toContain('the 💬 Chat button in the top bar does the same')
    expect(doc('README.md')).toContain('Click 💬 Chat in the top bar (or press `q`)')
  })
})
