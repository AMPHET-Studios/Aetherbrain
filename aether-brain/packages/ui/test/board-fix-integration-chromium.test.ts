import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Browser, Page } from 'playwright-core'

/**
 * The whole app (AetherApp: top bar, the 3D view with its real WebGL canvas, the palette, the Boards view) in real Chromium on
 * software GL, with the real compiled stylesheet. Pinned here:
 *  - integration-3, live-docked-1, renderer-cache-m6: the 3D view is NOT drawn behind a full-window panel (the Boards view, the
 *    Projects board; counted in WebGL draw calls, not timed) and draws again when the panel goes; the panel over it is solid;
 *    the small dialogs (review) leave the scene running;
 *  - integration-m1: Shift+Enter in the palette steps out of the Boards view;
 *  - integration-m2: the top bar is one line, nothing cut, from 1100 px to 1920 px.
 * Skipped without Chromium, without a WebGL that works, or without the stylesheet's compiler (apps/web's dev dependency).
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const posix = (...p: string[]) => path.join(here, '..', ...p).replace(/\\/g, '/')
const APP = posix('src', 'App.tsx')
const STORE = posix('src', 'store.ts')
const CSS = posix('src', 'styles.css')
const CORE = posix('..', 'core', 'src', 'index.ts')
const GRAPH = posix('..', 'graph', 'src', 'index.ts')
const UI = posix('src', 'index.ts')
const TAILWIND = path.join(here, '..', '..', '..', 'apps', 'web', 'node_modules', '@tailwindcss', 'vite', 'dist', 'index.mjs')

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

const ENTRY = `
import '${CSS}'
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryVaultAdapter, newBoardNote } from '@aether/core'
import { useAether } from '${STORE}'
import { AetherApp } from '${APP}'

const files = [
  { path: 'Inbox/Idea.md', content: '# Idea\\n\\nA note about a gate. [[Gate]]\\n' },
  { path: 'Inbox/Gate.md', content: '# Gate\\n\\nThe gate.\\n' },
  { path: 'Boards/Reference.md', content: newBoardNote('Reference', new Date('2026-10-01T10:00:00')) },
]
const vault = new MemoryVaultAdapter(files, { name: 'A rather long vault name here' })
const w = window as unknown as Record<string, unknown>
w.app = { useAether }
w.ready = (async () => {
  createRoot(document.getElementById('root')!).render(h(AetherApp, { sources: [] }))
  await useAether.getState().openVault(vault)
})()
`

/** Counts every WebGL draw call of the page (the board and the panels are DOM and canvas 2D: any GL draw is the 3D view's). */
const COUNT_DRAWS = () => {
  const w = window as unknown as { __draws: number }
  w.__draws = 0
  const methods = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'] as const
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
    for (const m of methods) {
      const proto = C.prototype as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>
      const original = proto[m]
      if (!original) continue
      proto[m] = function (this: unknown, ...a: unknown[]) {
        w.__draws++
        return original.apply(this, a)
      }
    }
  }
}

describe('the app in Chromium (pause behind full-window panels, palette, top bar)', () => {
  let browser: Browser | null = null
  let js = ''
  let css = ''
  let dir = ''

  beforeAll(async () => {
    const exe = findChromium()
    if (!exe) return
    const { chromium } = await import('playwright-core')
    try {
      browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
    } catch (err) {
      console.warn('app Chromium test skipped, Chromium does not start:', err)
      return
    }
    let tailwind: (() => unknown) | null = null
    try {
      const mod = (await import(pathToFileURL(TAILWIND).href)) as { default: () => unknown }
      tailwind = mod.default
    } catch (err) {
      console.warn('app Chromium test skipped, the stylesheet compiler is not installed (apps/web):', err)
      await browser.close()
      browser = null
      return
    }
    // A bundle that fails to build is a failure, not a skip: the test must not go quiet.
    const { build } = await import('vite')
    dir = mkdtempSync(path.join(here, '..', '.app-pause-'))
    const entry = path.join(dir, 'entry.tsx')
    writeFileSync(entry, ENTRY)
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      root: path.join(here, '..'),
      plugins: [tailwind() as never],
      resolve: {
        alias: [
          { find: /^@aether\/core$/, replacement: CORE },
          { find: /^@aether\/graph$/, replacement: GRAPH },
          { find: /^@aether\/ui$/, replacement: UI },
        ],
        dedupe: ['three', 'react', 'react-dom', '@react-three/fiber', 'zustand'],
      },
      define: { 'process.env.NODE_ENV': '"development"' },
      // The stylesheet for the Chromium that runs the test (the default target would leave only -webkit-backdrop-filter, which this Chromium does not read).
      build: { write: false, minify: false, cssTarget: 'chrome130', lib: { entry, formats: ['iife'], name: 'AppPause', fileName: 'b' } },
    })
    const first = Array.isArray(out) ? out[0]! : out
    const outputs = 'output' in first ? first.output : []
    for (const o of outputs) {
      if (o.type === 'chunk' && o.isEntry) js = o.code
      else if (o.type === 'asset' && o.fileName.endsWith('.css')) css += typeof o.source === 'string' ? o.source : Buffer.from(o.source).toString('utf8')
    }
  }, 300_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function appPage(width = 1280, height = 800): Promise<{ page: Page; errors: string[] }> {
    const page = await browser!.newPage({ viewport: { width, height } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript(() => {
      ;(window as unknown as { Worker?: unknown }).Worker = undefined
    })
    await page.addInitScript(COUNT_DRAWS)
    await page.route('http://aether.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>app</title><div id="root" style="position:fixed;inset:0"></div>' }))
    await page.goto('http://aether.test/')
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await page.evaluate(() => (window as unknown as { ready: Promise<void> }).ready)
    await page.waitForSelector('header[role=banner]')
    return { page, errors }
  }

  const view = (page: Page) => page.evaluate(() => (window as unknown as { app: { useAether: { getState(): { view: string } } } }).app.useAether.getState().view)
  const draws = (page: Page) => page.evaluate(() => (window as unknown as { __draws: number }).__draws)
  /** Waits until the 3D view has drawn something more (it is running). */
  const drawsMore = async (page: Page) => {
    const before = await draws(page)
    await page.waitForFunction((n) => (window as unknown as { __draws: number }).__draws > n, before, { timeout: 60_000 })
  }
  /**
   * True when no draw call happens for `ms`, once the frame that was in flight when the panel opened has landed: the count must first
   * stand still for a second (at most 15 s: a scene that is still drawing never gets there and is reported as drawing).
   */
  const silent = async (page: Page, ms = 2500) => {
    let last = await draws(page)
    let still = 0
    for (let i = 0; i < 30 && still < 2; i++) {
      await page.waitForTimeout(500)
      const now = await draws(page)
      still = now === last ? still + 1 : 0
      last = now
    }
    if (still < 2) return false
    await page.waitForTimeout(ms)
    return (await draws(page)) === last
  }

  it('stops drawing behind the Boards view and the Projects board, and draws again when they close', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await appPage()
    try {
      // Without a WebGL that works there is nothing to count.
      await page.waitForFunction(() => (window as unknown as { __draws: number }).__draws > 0, undefined, { timeout: 60_000 }).catch(() => undefined)
      if ((await draws(page)) === 0) return ctx.skip()
      await drawsMore(page)

      await page.keyboard.press('8')
      expect(await view(page)).toBe('boards')
      expect(await silent(page)).toBe(true)
      // The list, then a board opened from it: still nothing drawn.
      await page.getByRole('button', { name: 'Open the board Reference' }).click()
      expect(await silent(page, 1500)).toBe(true)
      await page.keyboard.press('Escape')
      expect(await view(page)).toBe('graph')
      await drawsMore(page)

      await page.keyboard.press('6')
      expect(await view(page)).toBe('projects')
      expect(await silent(page)).toBe(true)
      await page.keyboard.press('Escape')
      expect(await view(page)).toBe('graph')
      await drawsMore(page)

      // Straight from one full-window panel to the other, and back out through the store: never a frame in between, always one after.
      await page.keyboard.press('8')
      await page.evaluate(() => (window as unknown as { app: { useAether: { getState(): { setView(v: string): void } } } }).app.useAether.getState().setView('projects'))
      expect(await silent(page, 1500)).toBe(true)
      await page.evaluate(() => (window as unknown as { app: { useAether: { getState(): { setView(v: string): void } } } }).app.useAether.getState().setView('graph'))
      await drawsMore(page)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 300_000)

  it('leaves the scene running behind the small dialogs (review and quick capture are not full-window panels)', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page } = await appPage()
    try {
      await page.waitForFunction(() => (window as unknown as { __draws: number }).__draws > 0, undefined, { timeout: 60_000 }).catch(() => undefined)
      if ((await draws(page)) === 0) return ctx.skip()
      await page.keyboard.press('5')
      expect(await view(page)).toBe('review')
      await drawsMore(page)
      await page.keyboard.press('Escape')
      await page.keyboard.press('3')
      expect(await view(page)).toBe('capture')
      await drawsMore(page)
    } finally {
      await page.close()
    }
  }, 300_000)

  it('gives the full-window panels a solid background, and leaves the other panels translucent', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page } = await appPage()
    try {
      const panelStyle = (sel: string) =>
        page.locator(sel).first().evaluate((el) => {
          const s = getComputedStyle(el)
          return { background: s.backgroundColor, filter: s.backdropFilter }
        })
      // The top bar is a plain panel: translucent (var(--panel)), and it stays so under every view.
      expect((await panelStyle('header[role=banner]')).background).toBe('rgba(10, 13, 32, 0.78)')
      await page.keyboard.press('8')
      await page.waitForSelector('[aria-label="Boards"] .panel')
      const list = await panelStyle('[aria-label="Boards"] .panel')
      expect(list.background).toBe('rgb(13, 16, 38)')
      expect(list.filter).toBe('none')
      await page.getByRole('button', { name: 'Open the board Reference' }).click()
      await page.waitForSelector('[aria-label^="Board "] .panel')
      expect((await panelStyle('[aria-label^="Board "] .panel')).background).toBe('rgb(13, 16, 38)')
      await page.keyboard.press('Escape')
      await page.keyboard.press('6')
      await page.waitForSelector('[role=dialog] .panel')
      expect((await panelStyle('[role=dialog] .panel')).background).toBe('rgb(13, 16, 38)')
      expect((await panelStyle('header[role=banner]')).background).toBe('rgba(10, 13, 32, 0.78)')
      // The small dialogs keep the live scene visible through them: no solid panel there.
      await page.keyboard.press('Escape')
      await page.keyboard.press('5')
      await page.waitForSelector('[role=dialog] .panel')
      expect((await panelStyle('[role=dialog] .panel')).background).toBe('rgba(10, 13, 32, 0.78)')
    } finally {
      await page.close()
    }
  }, 300_000)

  it('Shift+Enter on a note in the palette steps out of the Boards view and selects the note', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page } = await appPage()
    try {
      await page.keyboard.press('8')
      expect(await view(page)).toBe('boards')
      await page.keyboard.press('Control+k')
      await page.getByPlaceholder(/Search neurons/).fill('Idea')
      await page.waitForSelector('[data-row="0"]')
      await page.keyboard.press('Shift+Enter')
      await page.waitForFunction(() => (window as unknown as { app: { useAether: { getState(): { view: string } } } }).app.useAether.getState().view === 'graph')
      expect(await page.evaluate(() => (window as unknown as { app: { useAether: { getState(): { selectedId: string | null; paletteOpen: boolean } } } }).app.useAether.getState())).toMatchObject({
        selectedId: 'Inbox/Idea',
        paletteOpen: false,
      })
    } finally {
      await page.close()
    }
  }, 300_000)

  it('keeps the top bar on one line, with nothing cut off, from 1100 px to 1920 px', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page } = await appPage(1920, 800)
    try {
      const measure = () =>
        page.evaluate(() => {
          const h = document.querySelector('header[role=banner]') as HTMLElement
          const bar = h.getBoundingClientRect()
          let right = 0
          for (const el of h.querySelectorAll('button, nav, span')) {
            const r = el.getBoundingClientRect()
            if (r.width > 0) right = Math.max(right, r.right)
          }
          const brand = [...h.querySelectorAll('span')].find((s) => s.textContent === 'Aether Brain')
          return { height: bar.height, barRight: bar.right, right, scroll: h.scrollWidth - h.clientWidth, brandHeight: brand ? brand.getBoundingClientRect().height : 0, vw: innerWidth }
        })
      const wide = await measure()
      const rows: string[] = []
      for (const width of [1920, 1750, 1749, 1610, 1609, 1500, 1366, 1360, 1359, 1280, 1200, 1199, 1100]) {
        await page.setViewportSize({ width, height: 800 })
        await page.waitForTimeout(120)
        const m = await measure()
        // One line: the bar is as tall as it is on the widest window, and the brand's name (when shown) is one line too.
        if (Math.abs(m.height - wide.height) > 1) rows.push(`${width}px: the bar is ${m.height}px tall (${wide.height} when wide)`)
        if (m.brandHeight > 24) rows.push(`${width}px: the brand wraps (${m.brandHeight}px)`)
        // Nothing past the bar's edge, and the bar inside the window.
        if (m.right > m.barRight) rows.push(`${width}px: content ends at ${m.right}, past the bar at ${m.barRight}`)
        if (m.scroll > 0) rows.push(`${width}px: the bar scrolls by ${m.scroll}px`)
        if (m.barRight > m.vw) rows.push(`${width}px: the bar ends at ${m.barRight}, past the window`)
      }
      expect(rows).toEqual([])
      // The names of the tabs are what stays: all seven, at the narrowest window too.
      const tabs = await page.evaluate(() =>
        [...document.querySelectorAll('nav[aria-label=Views] button')].map((b) => ({ text: (b.firstChild?.textContent ?? '').trim(), width: b.getBoundingClientRect().width })),
      )
      expect(tabs.map((t) => t.text)).toEqual(['Graph', 'Editor', 'Capture', 'Search', 'Review', 'Projects', 'Boards'])
      expect(tabs.every((t) => t.width > 30)).toBe(true)
    } finally {
      await page.close()
    }
  }, 300_000)
})
