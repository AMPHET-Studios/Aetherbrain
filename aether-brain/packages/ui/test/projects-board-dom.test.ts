import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright-core'

/**
 * The parts of the Projects board that live in effects and handlers (server markup never runs them), in real
 * Chromium with the real store and a vault in memory: the `m` key and the "Show more" button draw a page more
 * of the tasks, a focus that must land on a task past the drawn part draws the list down to it, and another
 * project starts again at the first page. Found missing by mutation testing: nothing failed when the `m`
 * handler, the draw-down or the page reset was removed. Skipped when no Chromium is installed.
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

const N = 1000
const FOLDERS = 300
const ENTRY = `
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryVaultAdapter } from '@aether/core'
import { useAether } from '${STORE}'
import { ProjectsView } from '${VIEW}'

const open = Array.from({ length: ${N} }, (_, i) => '- [ ] open ' + i).join('\\n')
const done = Array.from({ length: ${N} }, (_, i) => '- [x] done ' + i).join('\\n')
const big = '---\\ntype: project\\nstatus: active\\n---\\n# Big\\n\\n## To do\\n\\n' + open + '\\n\\n## Done\\n\\n' + done + '\\n'
const other = '---\\ntype: project\\nstatus: paused\\n---\\n# Other\\n\\n## To do\\n\\n- [ ] only task\\n'
const wide = '---\\ntype: project\\nstatus: done\\n---\\n# Wide\\n\\n- [ ] x\\n'
const dirs = Array.from({ length: ${FOLDERS} }, (_, i) => 'D/Projects/Wide/f' + String(i).padStart(3, '0'))
const w = window as unknown as { ready: Promise<void> }
w.ready = (async () => {
  await useAether.getState().openVault(new MemoryVaultAdapter([
    { path: 'D/Projects/Big.md', content: big },
    { path: 'D/Projects/Other.md', content: other },
    { path: 'D/Projects/Wide/Wide.md', content: wide },
  ], { folders: dirs }))
  useAether.getState().setView('projects')
  createRoot(document.getElementById('root')!).render(h(ProjectsView))
})()
`

describe('the Projects board in Chromium: paging and focus', () => {
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
      console.warn('projects board DOM test skipped, Chromium does not start:', err)
      return
    }
    // A bundle that fails to build is a failure, not a skip: the test must not go quiet.
    const { build } = await import('vite')
    dir = mkdtempSync(path.join(here, '..', '.board-'))
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
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** Waits (at most 10 s) until exactly `n` task rows are drawn. */
  const taskRows = (page: Page, n: number) => page.waitForFunction((want) => document.querySelectorAll('li[data-task]').length === want, n, { timeout: 10_000 })

  /** A page with the board open on "Big" (1,000 open and 1,000 done tasks), a real origin so localStorage works. */
  async function boardPage(): Promise<{ page: Page; errors: string[]; rows: () => Promise<{ open: number; done: number }> }> {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    // No layout worker in this page (the store starts one when it can; it is not what is tested).
    await page.addInitScript(() => {
      ;(window as unknown as { Worker?: unknown }).Worker = undefined
    })
    await page.route('http://aether.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>board</title><div id="root"></div>' }))
    await page.goto('http://aether.test/')
    await page.addScriptTag({ content: js })
    try {
      await page.evaluate(() => (window as unknown as { ready: Promise<void> }).ready)
      await page.locator('li[data-task]').first().waitFor({ timeout: 15_000 })
    } catch (err) {
      throw new Error(`the board never appeared; page errors: ${JSON.stringify(errors)}; ${(err as Error).message}`)
    }
    const rows = () =>
      page.evaluate(() => {
        const all = [...document.querySelectorAll<HTMLElement>('li[data-task]')]
        const done = all.filter((li) => li.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked).length
        return { open: all.length - done, done }
      })
    return { page, errors, rows }
  }

  it('draws a page more of the tasks with the m key and with the Show more button, in the open list and in the done list', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors, rows } = await boardPage()
    try {
      // 1. A page of the open list, the done list closed.
      expect(await rows()).toEqual({ open: 200, done: 0 })
      await expect(page.getByRole('button', { name: /Show 200 more · 800 left/ }).count()).resolves.toBe(1)
      // 2. m draws one more page (400), again (600).
      await page.keyboard.press('m')
      await taskRows(page, 400)
      await page.keyboard.press('m')
      await taskRows(page, 600)
      // 3. m typed into a text field is a letter, not a command.
      await page.getByLabel('New task').focus()
      await page.keyboard.type('m')
      expect(await page.getByLabel('New task').inputValue()).toBe('m')
      expect(await rows()).toEqual({ open: 600, done: 0 })
      await page.getByLabel('New task').fill('')
      await page.getByLabel('New task').blur()
      // 4. The button draws a page more too (800).
      await page.getByRole('button', { name: /Show 200 more · 400 left/ }).click()
      await taskRows(page, 800)
      // 5. x opens the done list (a first page of it); m then draws a page of both lists.
      await page.keyboard.press('x')
      await taskRows(page, 1000)
      expect(await rows()).toEqual({ open: 800, done: 200 })
      await page.keyboard.press('m')
      await taskRows(page, 1000 + 200 + 200)
      expect(await rows()).toEqual({ open: 1000, done: 400 })
      // 6. The done list's own button.
      await page.getByRole('button', { name: /Show 200 more · 600 left/ }).click()
      await taskRows(page, 1000 + 600)
      // 7. Nothing left to draw in the open list: m only draws the done list, and with everything drawn it does nothing.
      for (let i = 0; i < 4; i++) await page.keyboard.press('m')
      await taskRows(page, 2000)
      expect(await rows()).toEqual({ open: 1000, done: 1000 })
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('draws the list down to a task that must take the focus: a task moved past the last drawn row, open or done', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors, rows } = await boardPage()
    try {
      const focusedText = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest?.('li[data-task]')?.textContent ?? '')
      // The last drawn open task moves down one place: it lands on a row that is not drawn, and keeps the focus.
      await page.locator('li[data-task]').nth(199).focus()
      expect(await focusedText()).toContain('open 199')
      await page.keyboard.press('Alt+ArrowDown')
      await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.closest?.('li[data-task]')?.textContent?.includes('open 199') ?? false, undefined, { timeout: 10_000 })
      expect((await rows()).open).toBeGreaterThan(200)
      // The same in the done list.
      await page.keyboard.press('x')
      await page.waitForFunction(() => document.querySelectorAll('li[data-task]').length > 200 + 200, undefined, { timeout: 10_000 })
      const done = page.locator('li[data-task]').filter({ has: page.locator('input:checked') })
      expect(await done.count()).toBe(200)
      await done.nth(199).focus()
      expect(await focusedText()).toContain('done 199')
      await page.keyboard.press('Alt+ArrowDown')
      await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.closest?.('li[data-task]')?.textContent?.includes('done 199') ?? false, undefined, { timeout: 10_000 })
      expect((await rows()).done).toBeGreaterThan(200)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('after a delete or a tick on the last drawn task the focus goes to the NEXT task (drawn or not), so the next press never hits an earlier one', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await boardPage()
    try {
      const focusedHas = (needle: string) => page.waitForFunction((n) => ((document.activeElement as HTMLElement | null)?.closest?.('li[data-task]')?.textContent ?? '').includes(n), needle, { timeout: 10_000 })
      const rowCount = (needle: string) => page.evaluate((n) => [...document.querySelectorAll('li[data-task]')].filter((li) => (li.textContent ?? '').includes(n)).length, needle)
      await page.locator('li[data-task]').nth(199).focus()
      await page.keyboard.press('Delete')
      await focusedHas('open 200')
      // The second press deletes the task that now has the focus (open 200), not the one before it.
      await page.keyboard.press('Delete')
      await focusedHas('open 201')
      expect(await rowCount('open 198')).toBe(1)
      expect(await rowCount('open 199')).toBe(0)
      expect(await rowCount('open 200')).toBe(0)
      // Space (tick) on the last drawn row: the focus goes on to the next open task, not back.
      await page.locator('li[data-task]').nth(199).focus()
      const before = await page.evaluate(() => (document.activeElement as HTMLElement).textContent ?? '')
      await page.keyboard.press(' ')
      await page.waitForFunction((b) => { const t = (document.activeElement as HTMLElement | null)?.closest?.('li[data-task]')?.textContent ?? ''; return t !== '' && t !== b }, before, { timeout: 10_000 })
      const after = await page.evaluate(() => (document.activeElement as HTMLElement).closest('li[data-task]')?.textContent ?? '')
      expect(Number(/open (\d+)/.exec(after)?.[1])).toBeGreaterThan(Number(/open (\d+)/.exec(before)?.[1]))
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('the m key belongs to the board even with nothing left to draw, and a held m draws one page only', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors, rows } = await boardPage()
    try {
      const press = (repeat: boolean) =>
        page.evaluate((rep) => {
          const e = new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true, repeat: rep })
          window.dispatchEvent(e)
          return e.defaultPrevented
        }, repeat)
      // A held key: the first press draws a page, the repeats are taken (not passed on to the colour-mode key) and draw nothing.
      expect(await press(false)).toBe(true)
      await taskRows(page, 400)
      for (let i = 0; i < 20; i++) expect(await press(true)).toBe(true)
      await page.waitForTimeout(300)
      expect(await rows()).toEqual({ open: 400, done: 0 })
      // Everything drawn (1,000 open tasks, the done list closed): m is still the board's.
      for (let i = 0; i < 3; i++) await press(false)
      await taskRows(page, 1000)
      expect(await press(false)).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('starts again at the first page when another project is selected', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors, rows } = await boardPage()
    try {
      await page.keyboard.press('m')
      await page.keyboard.press('m')
      await taskRows(page, 600)
      // j: the next project ("Other", one task); k: back to "Big", whose lists are drawn from their first page again.
      await page.keyboard.press('j')
      await taskRows(page, 1)
      await page.keyboard.press('k')
      await page.waitForFunction(() => document.querySelectorAll('li[data-task]').length > 1, undefined, { timeout: 10_000 })
      expect(await rows()).toEqual({ open: 200, done: 0 })
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('draws a first few folder chips, a page more with the "more" chip, and starts again when another project is selected', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await boardPage()
    try {
      const chips = () => page.locator('button.chip').count()
      // Big, Other, Wide (the done project sorts last): j j selects the project whose folder holds 300 folders.
      await page.keyboard.press('j')
      await page.keyboard.press('j')
      await page.getByRole('button', { name: /^\+252 more$/ }).waitFor({ timeout: 10_000 })
      expect(await chips()).toBe(48 + 1)
      await page.getByRole('button', { name: /^\+252 more$/ }).click()
      await page.getByRole('button', { name: /^\+52 more$/ }).waitFor({ timeout: 10_000 })
      expect(await chips()).toBe(248 + 1)
      await page.getByRole('button', { name: /^\+52 more$/ }).click()
      await page.waitForFunction(() => document.querySelectorAll('button.chip').length === 300, undefined, { timeout: 10_000 })
      expect(await page.getByRole('button', { name: /more$/ }).count()).toBe(0)
      // Away and back: the first page again.
      await page.keyboard.press('k')
      await page.keyboard.press('j')
      await page.getByRole('button', { name: /^\+252 more$/ }).waitFor({ timeout: 10_000 })
      expect(await chips()).toBe(48 + 1)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)
})
