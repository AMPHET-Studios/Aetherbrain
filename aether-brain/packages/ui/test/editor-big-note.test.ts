import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright-core'

/**
 * The editor in real Chromium, with the real store: a very long note (an imported chat of megabytes) opens read-only,
 * as its bounded preview, with no text box (the text box of a 16 MB chat took 9 GB and the window died); an ordinary
 * note opens in the text box with all of its text. Skipped only when no Chromium is installed.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const posix = (...p: string[]) => path.join(here, '..', ...p).replace(/\\/g, '/')
const VIEW = posix('src', 'components', 'Editor.tsx')
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

const MB = 1.5
const ENTRY = `
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryVaultAdapter } from '@aether/core'
import { useAether } from '${STORE}'
import { Editor } from '${VIEW}'

const words = 'ancient portal monolith rainforest ruin machine drone pet weapon armor signal vault cosmos orbit light stone glyph engine moss river fern'.split(' ')
function chat(mb: number) {
  const out = ['---\\ntitle: Big chat\\ntags: [ai-chat]\\n---\\n# Big chat\\n\\n## Transcript\\n']
  let len = 0, m = 0
  while (len < mb * 1024 * 1024) {
    let t = '\\n### ' + (m % 2 ? 'Claude' : 'You') + '\\n'
    for (let j = 0; j < 6; j++) {
      let p = ''
      for (let k = 0; k < 70; k++) p += words[(m * 7 + j * 3 + k) % words.length] + ' '
      t += '> ' + p + '\\n>\\n'
    }
    out.push(t); len += t.length; m++
  }
  return out.join('')
}
const w = window as unknown as { ready: Promise<void>; useAether: typeof useAether; open: (id: string) => void }
w.useAether = useAether
w.open = (id) => useAether.getState().openNote(id, { fly: false })
const small = '# Small note\\n\\n' + Array.from({ length: 400 }, (_, i) => 'line ' + i + ' of an ordinary note').join('\\n') + '\\n'
w.ready = (async () => {
  await useAether.getState().openVault(new MemoryVaultAdapter([
    { path: 'D/Big chat.md', content: chat(${MB}) },
    { path: 'D/Small.md', content: small },
  ], { folders: [] }))
  createRoot(document.getElementById('root')!).render(h(Editor))
})()
`

describe('the editor in Chromium: a very long note is read, not edited', () => {
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
      console.warn('editor test skipped, Chromium does not start:', err)
      return
    }
    // A bundle that fails to build is a failure, not a skip: the test must not go quiet.
    const { build } = await import('vite')
    dir = mkdtempSync(path.join(here, '..', '.editor-'))
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
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'EditorTest', fileName: 'e' } },
    })
    const bundle = Array.isArray(out) ? out[0]! : out
    const chunk = 'output' in bundle ? bundle.output.find((o) => o.type === 'chunk') : undefined
    js = chunk && chunk.type === 'chunk' ? chunk.code : ''
    if (!js) throw new Error('the editor bundle is empty')
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function editorPage(): Promise<{ page: Page; errors: string[] }> {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript(() => {
      ;(window as unknown as { Worker?: unknown }).Worker = undefined
    })
    await page.route('http://aether.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>editor</title><div id="root"></div>' }))
    await page.goto('http://aether.test/')
    await page.addScriptTag({ content: js })
    try {
      await page.evaluate(() => (window as unknown as { ready: Promise<void> }).ready)
    } catch (err) {
      throw new Error(`the editor bundle failed; page errors: ${JSON.stringify(errors)}; ${(err as Error).message}`)
    }
    return { page, errors }
  }
  const state = (page: Page) =>
    page.evaluate(() => {
      const s = (window as unknown as { useAether: { getState(): { dirty: boolean; draft: string | null; notes: Map<string, { raw: string }> } } }).useAether.getState()
      return {
        elements: document.getElementById('root')!.getElementsByTagName('*').length,
        textareas: document.querySelectorAll('textarea').length,
        textareaChars: (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value.length ?? 0,
        banner: document.querySelector('[role="status"]')?.textContent ?? '',
        previewChars: (document.querySelector('.md')?.textContent ?? '').length,
        dirty: s.dirty,
        rawChars: s.notes.get('D/Big chat')?.raw.length ?? 0,
        modeButton: !!Array.from(document.querySelectorAll('button')).find((b) => /Split|Edit|Preview/.test(b.textContent ?? '')),
        header: document.body.innerText.includes('read-only'),
      }
    })

  it('opens a 1.5 MB chat as its preview: no text box, a notice, a bounded page, nothing written', async (ctx) => {
    if (!browser) return ctx.skip()
    const { page, errors } = await editorPage()
    try {
      await page.evaluate(() => (window as unknown as { open: (id: string) => void }).open('D/Big chat'))
      await page.locator('.md').first().waitFor({ timeout: 30_000 })
      // Let an autosave have had its chance (900 ms): there must be nothing to save.
      await page.waitForTimeout(1500)
      const s = await state(page)
      expect(s.rawChars).toBeGreaterThan(1_500_000)
      expect(s.textareas).toBe(0)
      expect(s.banner).toContain('shown here to read, not to')
      expect(s.banner).toContain('400,000')
      expect(s.header).toBe(true)
      expect(s.modeButton).toBe(false)
      expect(s.previewChars).toBeLessThan(65_000)
      expect(s.elements).toBeLessThan(5_000)
      expect(s.dirty).toBe(false)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 180_000)

  it('opens an ordinary note in the text box with all its text, and no notice', async (ctx) => {
    if (!browser) return ctx.skip()
    const { page, errors } = await editorPage()
    try {
      await page.evaluate(() => (window as unknown as { open: (id: string) => void }).open('D/Small'))
      await page.locator('textarea').waitFor({ timeout: 30_000 })
      const s = await state(page)
      expect(s.textareas).toBe(1)
      expect(s.textareaChars).toBeGreaterThan(8_000)
      expect(s.banner).toBe('')
      expect(s.modeButton).toBe(true)
      // Going from the long note to the ordinary one brings the text box back.
      await page.evaluate(() => (window as unknown as { open: (id: string) => void }).open('D/Big chat'))
      await page.waitForFunction(() => document.querySelectorAll('textarea').length === 0, null, { timeout: 30_000 })
      await page.evaluate(() => (window as unknown as { open: (id: string) => void }).open('D/Small'))
      await page.locator('textarea').waitFor({ timeout: 30_000 })
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 180_000)
})
