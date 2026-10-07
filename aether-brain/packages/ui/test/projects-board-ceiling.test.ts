import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright-core'

/**
 * Two more things of the Projects board that only run in a browser, with the real store and a vault in memory:
 * "Show more" and the m key stop at a ceiling (a 100,000-task list is never drawn whole, however often it is
 * asked for), and what was typed on the board survives closing it. Skipped only when no Chromium is installed.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const posix = (...p: string[]) => path.join(here, '..', ...p).replace(/\\/g, '/')
const VIEW = posix('src', 'components', 'ProjectsView.tsx')
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

const OPEN = 2600
const FOLDERS = 2300
const ENTRY = `
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryVaultAdapter } from '@aether/core'
import { useAether } from '${STORE}'
import { ProjectsView } from '${VIEW}'

const open = Array.from({ length: ${OPEN} }, (_, i) => '- [ ] open ' + i).join('\\n')
const big = '---\\ntype: project\\nstatus: active\\n---\\n# Big\\n\\n## To do\\n\\n' + open + '\\n'
const wide = '---\\ntype: project\\nstatus: paused\\n---\\n# Wide\\n\\n- [ ] x\\n'
const dirs = Array.from({ length: ${FOLDERS} }, (_, i) => 'D/Projects/Wide/f' + String(i).padStart(4, '0'))
const w = window as unknown as { ready: Promise<void>; useAether: typeof useAether }
w.useAether = useAether
w.ready = (async () => {
  await useAether.getState().openVault(new MemoryVaultAdapter([
    { path: 'D/Projects/Big.md', content: big },
    { path: 'D/Projects/Wide/Wide.md', content: wide },
  ], { folders: dirs }))
  useAether.getState().setView('projects')
  createRoot(document.getElementById('root')!).render(h(ProjectsView))
})()
`

describe('the Projects board in Chromium: ceilings and drafts', () => {
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
      console.warn('projects board ceiling test skipped, Chromium does not start:', err)
      return
    }
    // A bundle that fails to build is a failure, not a skip: the test must not go quiet.
    const { build } = await import('vite')
    dir = mkdtempSync(path.join(here, '..', '.ceiling-'))
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
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'Board', fileName: 'b' } },
    })
    const bundle = Array.isArray(out) ? out[0]! : out
    const chunk = 'output' in bundle ? bundle.output.find((o) => o.type === 'chunk') : undefined
    js = chunk && chunk.type === 'chunk' ? chunk.code : ''
    if (!js) throw new Error('the board bundle is empty')
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function boardPage(): Promise<{ page: Page; errors: string[] }> {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript(() => {
      ;(window as unknown as { Worker?: unknown }).Worker = undefined
    })
    await page.route('http://aether.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>board</title><div id="root"></div>' }))
    await page.goto('http://aether.test/')
    await page.addScriptTag({ content: js })
    try {
      await page.evaluate(() => (window as unknown as { ready: Promise<void> }).ready)
      await page.locator('[data-project-card]').first().waitFor({ timeout: 15_000 })
    } catch (err) {
      throw new Error(`the board never appeared; page errors: ${JSON.stringify(errors)}; ${(err as Error).message}`)
    }
    return { page, errors }
  }
  const rows = (page: Page) => page.evaluate(() => document.querySelectorAll('li[data-task]').length)
  const chips = (page: Page) => page.evaluate(() => document.querySelectorAll('button.chip').length)
  const selectProject = (page: Page, id: string) => page.evaluate((i) => (window as unknown as { useAether: { getState(): { selectProject(id: string): void } } }).useAether.getState().selectProject(i), id)

  it('stops "Show more" and the m key at the ceiling, with a note about the rest, and never draws the whole list', async (ctx) => {
    if (!browser) return ctx.skip()
    const { page, errors } = await boardPage()
    try {
      await selectProject(page, 'D/Projects/Big')
      await page.waitForFunction(() => document.querySelectorAll('li[data-task]').length === 200, null, { timeout: 10_000 })
      // The first page, then pages by the button.
      await page.getByRole('button', { name: /Show 200 more/ }).click()
      await page.waitForFunction(() => document.querySelectorAll('li[data-task]').length === 400, null, { timeout: 10_000 })
      // Then by the key, one press at a time, until the ceiling (2,000 of 2,600).
      for (let i = 0; i < 12; i++) {
        await page.locator('body').click({ position: { x: 5, y: 5 } })
        await page.keyboard.press('m')
        await page.waitForTimeout(40)
      }
      await page.waitForFunction(() => document.querySelectorAll('li[data-task]').length === 2000, null, { timeout: 10_000 })
      expect(await rows(page)).toBe(2000)
      // At the ceiling there is no button any more, and the board says where the rest is.
      expect(await page.getByRole('button', { name: /Show .* more/ }).count()).toBe(0)
      expect(await page.getByText(/The first 2,000 are drawn; 600 more are in the note/).count()).toBe(1)
      // More presses change nothing.
      await page.keyboard.press('m')
      await page.waitForTimeout(150)
      expect(await rows(page)).toBe(2000)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('stops the folder chips at the ceiling too', async (ctx) => {
    if (!browser) return ctx.skip()
    const { page, errors } = await boardPage()
    try {
      await selectProject(page, 'D/Projects/Wide/Wide')
      await page.waitForFunction(() => document.querySelectorAll('button.chip').length === 49, null, { timeout: 10_000 })
      // 48 chips and "+2252 more": 48 + 200 x 10 = 2,048, so ten clicks reach the ceiling of 2,000 and the last page is shorter.
      for (let i = 0; i < 12; i++) {
        const more = page.getByRole('button', { name: /^\+\d+ more$/ })
        if ((await more.count()) === 0) break
        await more.click()
      }
      await page.waitForFunction(() => document.querySelectorAll('button.chip').length === 2000, null, { timeout: 10_000 })
      expect(await chips(page)).toBe(2000)
      expect(await page.getByText(/\+300 more: open the folder in space/).count()).toBe(1)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('keeps what was typed and opened on the board when it is closed and opened again', async (ctx) => {
    if (!browser) return ctx.skip()
    const { page, errors } = await boardPage()
    try {
      await selectProject(page, 'D/Projects/Big')
      await page.getByLabel('New task').fill('a half-written task')
      // The board is closed (the store's view), nothing of it is in the page, then it is opened again.
      await page.evaluate(() => (window as unknown as { useAether: { getState(): { setView(v: string): void } } }).useAether.getState().setView('graph'))
      await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Projects"]'), null, { timeout: 5_000 })
      expect(await page.locator('[data-project-card]').count()).toBe(0)
      expect(await page.locator('li[data-task]').count()).toBe(0)
      await page.evaluate(() => (window as unknown as { useAether: { getState(): { setView(v: string): void } } }).useAether.getState().setView('projects'))
      await page.getByLabel('New task').waitFor({ timeout: 10_000 })
      expect(await page.getByLabel('New task').inputValue()).toBe('a half-written task')
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)
})
