import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter } from '@aether/core'

/**
 * format-4 in the preview: the text of a board note (or an imported chat) is written escaped so that it is never a link or a tag.
 * GFM's late autolink pass cut a text node into pieces with no position, and from those the preview made a live wikilink out of an
 * escaped `\[\[x\]\]` that sat next to an address; MarkdownPreview now uses the shared remarkNoLateAutolinks, as parseMarkdown does.
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

async function preview(source: string): Promise<string> {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  const { useAether } = await import('../src/store')
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  await useAether.getState().openVault(new MemoryVaultAdapter([{ path: 'Notes/Real.md', content: '# Real\n' }]))
  Object.assign(useAether.getInitialState(), useAether.getState())
  const { MarkdownPreview } = await import('../src/components/MarkdownPreview')
  return renderToStaticMarkup(createElement(MarkdownPreview, { source, selfId: null }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the note preview and GFM\'s late autolinks', () => {
  it('an escaped [[link]] next to an address linked late is text, not a wikilink', async () => {
    for (const text of ['\\[\\[Secret\\]\\] \\#tag ",www.example.com"', '\\[\\[Secret\\]\\] ),www.a.example', '\\[\\[Secret\\]\\] [http://x.example']) {
      const out = await preview(`# Board\n\n- note ${text}\n`)
      expect(out, text).not.toContain('data-target="Secret"')
      expect(out, text).not.toContain('wikilink')
    }
  }, 60_000)

  it('a real wikilink and an address the tokenizer links are still links', async () => {
    const out = await preview('See [[Real]] and www.example.com and <https://auto.example>.\n')
    expect(out).toContain('data-target="Real"')
    expect(out).toContain('href="http://www.example.com"')
    expect(out).toContain('href="https://auto.example"')
  }, 60_000)
})
