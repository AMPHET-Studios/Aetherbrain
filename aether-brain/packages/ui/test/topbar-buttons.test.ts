import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter } from '@aether/core'

/**
 * Buttons the host app adds to the top bar (the desktop's 💬 Chat): the web app adds none, a button shows its icon, its word (which
 * gives way on a narrow window) and its key (which shows on a wide one), and a button that can be pressed shows whether it is.
 */

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v))
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Fresh modules (an empty registry), and the top bar as markup from the store's live state. */
async function fresh() {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  const { useAether } = await import('../src/store')
  const registry = await import('../src/topbarButtons')
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const bar = async (): Promise<string> => {
    const { TopBar } = await import('../src/components/TopBar')
    Object.assign(useAether.getInitialState(), useAether.getState())
    return renderToStaticMarkup(createElement(TopBar, {}))
  }
  await useAether.getState().openVault(new MemoryVaultAdapter([{ path: 'Notes/a.md', content: '# a\n' }]))
  return { registry, bar }
}

/** The markup of the one button called `label` (its aria-label), or ''. */
const buttonOf = (markup: string, label: string): string => markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>.*?</button>`))?.[0] ?? ''

describe('the top bar’s host buttons', () => {
  it('has none until the host adds one: the web app adds none', async () => {
    const { registry, bar } = await fresh()
    expect(registry.topBarButtons()).toEqual([])
    const markup = await bar()
    expect(markup).not.toContain('💬')
    // The views, the Today chip and the rest are there as before.
    expect(markup).toContain('Graph')
    expect(markup).toContain('Boards')
  })

  it('draws a registered button with its icon, its word, its key and its tooltip, after the Today chip and before the search', async () => {
    const { registry, bar } = await fresh()
    registry.registerTopBarButton({ id: 'chat', icon: '💬', word: 'Chat', title: 'Chat with your brain (q)', key: 'q', run: () => undefined })
    const markup = await bar()
    const chat = buttonOf(markup, 'Chat')
    expect(chat).toContain('💬')
    expect(chat).toContain('title="Chat with your brain (q)"')
    expect(chat).toContain('<kbd class="topbar-wide">q</kbd>')
    // The word is the part that gives way on a narrow window; the icon stays.
    expect(chat).toContain('<span class="topbar-roomy">Chat</span>')
    expect(markup.indexOf('Today')).toBeLessThan(markup.indexOf('💬'))
    expect(markup.indexOf('💬')).toBeLessThan(markup.indexOf('⌕ Search'))
  })

  it('shows whether a pressable button is pressed, and not at all for a plain one', async () => {
    const { registry, bar } = await fresh()
    let open = false
    const listeners = new Set<() => void>()
    registry.registerTopBarButton({
      id: 'chat',
      icon: '💬',
      word: 'Chat',
      title: 'Chat',
      run: () => {
        open = !open
        for (const l of listeners) l()
      },
      pressed: () => open,
      subscribe: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    })
    registry.registerTopBarButton({ id: 'docs', icon: '📘', word: 'Docs', title: 'Docs', run: () => undefined })
    expect(buttonOf(await bar(), 'Chat')).toContain('aria-pressed="false"')
    registry.topBarButtons().find((b) => b.id === 'chat')!.run()
    expect(buttonOf(await bar(), 'Chat')).toContain('aria-pressed="true"')
    expect(buttonOf(await bar(), 'Docs')).not.toContain('aria-pressed')
  })

  it('replaces a button with the same id and keeps the order of the others', async () => {
    const { registry } = await fresh()
    const make = (id: string, word: string) => ({ id, icon: '•', word, title: word, run: () => undefined })
    registry.registerTopBarButton(make('a', 'First'))
    registry.registerTopBarButton(make('b', 'Second'))
    registry.registerTopBarButton(make('a', 'First, again'))
    expect(registry.topBarButtons().map((b) => b.word)).toEqual(['First, again', 'Second'])
  })
})
