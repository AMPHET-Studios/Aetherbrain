import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright-core'

/**
 * The note preview in real Chromium, with the real store and a 3 MB imported-chat note in memory: only the first
 * part is drawn (drawing all of a 16 MB chat took 10 GB and the window died), "Show more" adds a part at a time up
 * to a ceiling, the notice says so, a task tick still lands on its own line, and a short note shows no notice.
 * Skipped only when no Chromium is installed.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const posix = (...p: string[]) => path.join(here, '..', ...p).replace(/\\/g, '/')
const VIEW = posix('src', 'components', 'MarkdownPreview.tsx')
const STORE = posix('src', 'store.ts')
const CORE = posix('..', 'core', 'src', 'index.ts')
const GRAPH = posix('..', 'graph', 'src', 'index.ts')
const UI = posix('src', 'index.ts')

function findChromium(): string | undefined {
  const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false
  const bases = [process.env['PLAYWRIGHT_BROWSERS_PATH'], '/opt/pw-browsers'].filter((b): b is string => !!b && b !== '0')
  for (const base of bases) {
    if (isFile(path.join(base, 'chromium'))) return path.join(base, 'chromium')
    let dirs: string[] = []
    try {
      dirs = readdirSync(base).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()
    } catch {
      continue
    }
    for (const d of dirs) {
      for (const rel of ['chrome-linux/chrome', 'chrome-win/chrome.exe', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        if (isFile(path.join(base, d, rel))) return path.join(base, d, rel)
      }
    }
  }
  return undefined
}

const MB = 3
const ENTRY = `
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryVaultAdapter } from '@aether/core'
import { useAether } from '${STORE}'
import { MarkdownPreview } from '${VIEW}'

const words = 'ancient portal monolith rainforest ruin machine drone pet weapon armor signal vault cosmos orbit light stone glyph engine moss river fern'.split(' ')
function chat(mb: number) {
  const out = ['---\\ntitle: Big chat\\ntags: [ai-chat]\\n---\\n# Big chat\\n\\n- [ ] early task\\n\\n## Transcript\\n']
  let len = 0, m = 0
  while (len < mb * 1024 * 1024) {
    let t = '\\n### ' + (m % 2 ? 'Claude' : 'You') + '\\n'
    for (let j = 0; j < 6; j++) {
      let p = ''
      for (let k = 0; k < 70; k++) p += words[(m * 7 + j * 3 + k) % words.length] + ' '
      t += '> ' + p + '\\n>\\n'
    }
    if (m % 3 === 0) t += '> \`\`\`js\\n> const a = [1, 2, 3].map((x) => x * 2)\\n> \`\`\`\\n>\\n'
    out.push(t); len += t.length; m++
  }
  return out.join('')
}
const w = window as unknown as { ready: Promise<void>; useAether: typeof useAether; show: (id: string) => void }
w.useAether = useAether
function Page() {
  const notes = useAether((s) => s.notes)
  const [id, setId] = (window as unknown as { React: typeof import('react') }).React.useState('D/Big chat')
  w.show = setId
  const n = notes.get(id)
  return n ? h(MarkdownPreview, { source: n.raw, selfId: n.meta.id }) : null
}
w.ready = (async () => {
  ;(window as unknown as { React: unknown }).React = await import('react')
  await useAether.getState().openVault(new MemoryVaultAdapter([
    { path: 'D/Big chat.md', content: chat(${MB}) },
    { path: 'D/Small.md', content: '# Small\\n\\nhello [[Big chat]]\\n\\n- [ ] small task\\n' },
  ], { folders: [] }))
  createRoot(document.getElementById('root')!).render(h(Page))
})()
`

describe('the note preview in Chromium: bounded drawing of a long note', () => {
  let browser: Browser | null = null
  let js = ''
  let dir = ''

  beforeAll(async () => {
    const exe = findChromium()
    if (!exe) return
    const { chromium } = await import('playwright-core')
    try {
      browser = await chromium.launch({ executablePath: exe })
    } catch (err) {
      console.warn('preview test skipped, Chromium does not start:', err)
      return
    }
    // A bundle that fails to build is a failure, not a skip: the test must not go quiet.
    const { build } = await import('vite')
    dir = mkdtempSync(path.join(here, '..', '.preview-'))
    const entry = path.join(dir, 'entry.tsx')
    writeFileSync(entry, ENTRY)
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      root: path.join(here, '..'),
      resolve: {
        alias: [
          { find: /^@aether\/core$/, replacement: CORE },
          { find: /^@aether\/graph$/, replacement: GRAPH },
          { find: /^@aether\/ui$/, replacement: UI },
        ],
        dedupe: ['three', 'react', 'react-dom', 'zustand'],
      },
      define: { 'process.env.NODE_ENV': '"development"' },
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'Preview', fileName: 'p' } },
    })
    const bundle = Array.isArray(out) ? out[0]! : out
    const chunk = 'output' in bundle ? bundle.output.find((o) => o.type === 'chunk') : undefined
    js = chunk && chunk.type === 'chunk' ? chunk.code : ''
    if (!js) throw new Error('the preview bundle is empty')
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function previewPage(): Promise<{ page: Page; errors: string[] }> {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript(() => {
      ;(window as unknown as { Worker?: unknown }).Worker = undefined
    })
    await page.route('http://aether.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>preview</title><div id="root"></div>' }))
    await page.goto('http://aether.test/')
    await page.addScriptTag({ content: js })
    try {
      await page.evaluate(() => (window as unknown as { ready: Promise<void> }).ready)
      await page.locator('.md').first().waitFor({ timeout: 30_000 })
    } catch (err) {
      throw new Error(`the preview never appeared; page errors: ${JSON.stringify(errors)}; ${(err as Error).message}`)
    }
    return { page, errors }
  }
  const drawn = (page: Page) => page.evaluate(() => ({ elements: document.querySelectorAll('.md *').length, chars: (document.querySelector('.md')?.textContent ?? '').length }))

  it('draws the first part, adds a part per Show more, stops at the ceiling and says so', async (ctx) => {
    if (!browser) return ctx.skip()
    const { page, errors } = await previewPage()
    try {
      const total = await page.evaluate(() => (window as unknown as { useAether: { getState(): { notes: Map<string, { raw: string }> } } }).useAether.getState().notes.get('D/Big chat')!.raw.length)
      expect(total).toBeGreaterThan(MB * 1024 * 1024)
      let d = await drawn(page)
      // The first 60,000 characters (a little less: the cut is at a paragraph), a few hundred elements, not tens of thousands.
      expect(d.chars).toBeLessThan(62_000)
      expect(d.chars).toBeGreaterThan(40_000)
      expect(d.elements).toBeLessThan(4_000)
      // Of the note's text without its frontmatter (a few dozen characters shorter than the file).
      expect(await page.getByRole('note').textContent()).toMatch(/Showing the first [\d,]+ of 3,1\d\d,\d{3} characters/)
      expect(total).toBeGreaterThan(3_000_000)
      // Each press adds a part, to 300,000 at most.
      for (let i = 0; i < 4; i++) await page.getByRole('button', { name: /^Show .* more$/ }).click()
      d = await drawn(page)
      expect(d.chars).toBeGreaterThan(240_000)
      expect(d.chars).toBeLessThan(310_000)
      expect(await page.getByRole('button', { name: /^Show .* more$/ }).count()).toBe(0)
      expect(await page.getByRole('note').textContent()).toContain('That is as much as the preview draws')
      // More presses are not possible, and the page never grew past the ceiling (a 3 MB note whole is ten times that).
      expect(d.elements).toBeLessThan(30_000)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 180_000)

  it('shows no notice for a short note, and each note starts again at its first part', async (ctx) => {
    if (!browser) return ctx.skip()
    const { page, errors } = await previewPage()
    try {
      // Open more of the long note, then go to a short one: all of it, no notice.
      await page.getByRole('button', { name: /^Show .* more$/ }).click()
      expect((await drawn(page)).chars).toBeGreaterThan(100_000)
      await page.evaluate(() => (window as unknown as { show: (id: string) => void }).show('D/Small'))
      await page.getByText('small task').waitFor({ timeout: 10_000 })
      expect(await page.getByRole('note').count()).toBe(0)
      // Back to the long one: the first part again, not the part that was open.
      await page.evaluate(() => (window as unknown as { show: (id: string) => void }).show('D/Big chat'))
      await page.getByRole('note').waitFor({ timeout: 10_000 })
      expect((await drawn(page)).chars).toBeLessThan(62_000)
      // The long note's early task is in the first part, drawn as a list item.
      expect(await page.locator('.md li.task-list-item').count()).toBeGreaterThan(0)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 180_000)
})
