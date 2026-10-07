import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser } from 'playwright-core'

/**
 * The project card list in real Chromium, with 20,000 projects: only the cards in view exist, the scroll bar
 * still stands for all of them, a scroll draws the cards under it, and moving the selection (as j and k do)
 * brings its card into view. Skipped when no Chromium is installed.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const LIST = path.join(here, '..', 'src', 'components', 'ProjectCardList.tsx').replace(/\\/g, '/')

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

const COUNT = 20000
const ENTRY = `
import { createElement as h, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProjectCardList } from '${LIST}'

const w = window as unknown as { setCurrent: (id: string) => void; selected: string[]; opened: string[] }
w.selected = []
w.opened = []
const rows = Array.from({ length: ${COUNT} }, (_, i) => ({
  note: { meta: { id: 'p' + i, title: 'Project ' + i, status: 'active', updated: '2026-10-05', tags: ['a', 'b', 'c', 'd'] } },
  tasks: [{ text: 'next ' + i }, { text: 'done' }],
  open: [{ text: 'next ' + i }],
  done: [{ text: 'done' }],
  pct: 50,
  home: null,
})) as never[]
const subfolders = new Map<string, string[]>()
function Page() {
  const [current, setCurrent] = useState('p0')
  w.setCurrent = setCurrent
  return h(
    'div',
    { id: 'frame', style: { width: 340, height: 600, display: 'flex', flexDirection: 'column' } },
    h(ProjectCardList, {
      rows,
      currentId: current,
      subfolders,
      onSelect: (id: string) => { w.selected.push(id); setCurrent(id) },
      onOpen: (id: string) => { w.opened.push(id) },
    }),
  )
}
createRoot(document.getElementById('root')!).render(h(Page))
`

const STYLE = '.scroll{overflow-y:auto}.flex-1{flex:1 1 0%;min-height:0}.p-2{padding:8px}button{display:block;font:inherit;text-align:left}*{box-sizing:border-box}'

describe('ProjectCardList in Chromium', () => {
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
      console.warn('project card list test skipped, Chromium does not start:', err)
      return
    }
    // A bundle that fails to build is a failure, not a skip: the test must not go quiet.
    const { build } = await import('vite')
    dir = mkdtempSync(path.join(here, '..', '.cards-'))
    const entry = path.join(dir, 'entry.tsx')
    writeFileSync(entry, ENTRY)
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      root: path.join(here, '..'),
      define: { 'process.env.NODE_ENV': '"development"' },
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'Cards', fileName: 'c' } },
    })
    const bundle = Array.isArray(out) ? out[0] : out
    const chunk = 'output' in bundle ? bundle.output.find((o) => o.type === 'chunk') : undefined
    js = chunk && chunk.type === 'chunk' ? chunk.code : ''
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('draws a few of 20,000 cards, follows the scroll, keeps the scroll bar honest and reveals the selection', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const page = await browser.newPage({ viewport: { width: 500, height: 700 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    try {
      await page.setContent(`<!doctype html><title>cards</title><style>${STYLE}</style><div id="root"></div>`)
      await page.addScriptTag({ content: js })
      try {
        await page.locator('[data-project-card="p0"]').waitFor({ timeout: 10_000 })
      } catch (err) {
        throw new Error(`the first card never appeared; page errors: ${JSON.stringify(errors)}; ${(err as Error).message}`)
      }
      const frame = () =>
        page.evaluate(() => {
          const list = document.querySelector('[data-cards]') as HTMLElement
          const box = list.getBoundingClientRect()
          const cards = [...document.querySelectorAll<HTMLElement>('[data-project-card]')]
          const ids = cards.map((c) => c.dataset['projectCard']!)
          const visible = (id: string) => {
            const r = document.querySelector(`[data-project-card="${id}"]`)?.getBoundingClientRect()
            return !!r && r.top >= box.top - 1 && r.bottom <= box.bottom + 1
          }
          return { count: cards.length, first: ids[0], last: ids[ids.length - 1], scrollHeight: list.scrollHeight, scrollTop: list.scrollTop, visible: Object.fromEntries(ids.map((i) => [i, visible(i)])) }
        })
      const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

      // 1. Opened: the first cards only, and the scroll height is that of all 20,000 (114 px each plus the list's padding).
      let f = await frame()
      expect(f.count).toBeGreaterThan(4)
      expect(f.count).toBeLessThanOrEqual(30)
      expect(f.first).toBe('p0')
      expect(Math.abs(f.scrollHeight - (20000 * 114 + 16))).toBeLessThanOrEqual(2)

      // 2. Scrolled to the end: the last cards, still only a few of them.
      await page.evaluate(() => { const l = document.querySelector('[data-cards]') as HTMLElement; l.scrollTop = l.scrollHeight })
      await settle()
      f = await frame()
      expect(f.count).toBeLessThanOrEqual(30)
      expect(f.last).toBe('p19999')

      // 3. Scrolled to the middle by hand: the cards under the view, none of the others.
      await page.evaluate(() => { const l = document.querySelector('[data-cards]') as HTMLElement; l.scrollTop = 8 + 114 * 7000 })
      await settle()
      f = await frame()
      expect(f.count).toBeLessThanOrEqual(30)
      expect(Number(f.first!.slice(1))).toBeLessThanOrEqual(7000)
      expect(Number(f.last!.slice(1))).toBeGreaterThanOrEqual(7004)
      expect(f.visible['p7000']).toBe(true)

      // 4. The selection moves far (a click on a link, the palette): its card comes into view.
      await page.evaluate(() => (window as unknown as { setCurrent: (id: string) => void }).setCurrent('p12000'))
      await settle()
      f = await frame()
      expect(f.visible['p12000']).toBe(true)
      expect(f.count).toBeLessThanOrEqual(30)

      // 5. Walking down with the keys, one card at a time: every step is in view, and the scroll moves only when it must.
      let moved = 0
      let last = f.scrollTop
      for (let i = 12001; i < 12040; i++) {
        await page.evaluate((id) => (window as unknown as { setCurrent: (id: string) => void }).setCurrent(id), `p${i}`)
        await settle()
        f = await frame()
        expect(f.visible[`p${i}`]).toBe(true)
        if (f.scrollTop !== last) moved++
        last = f.scrollTop
      }
      // From the bottom edge every step off it scrolls by one card; the selection never leaves the view.
      expect(moved).toBe(39)
      // Moving back to a card that is already in view leaves the scroll alone.
      const before = f.scrollTop
      await page.evaluate(() => (window as unknown as { setCurrent: (id: string) => void }).setCurrent('p12037'))
      await settle()
      f = await frame()
      expect(f.scrollTop).toBe(before)
      expect(f.visible['p12037']).toBe(true)

      // 6. And back up to the very first project.
      await page.evaluate(() => (window as unknown as { setCurrent: (id: string) => void }).setCurrent('p0'))
      await settle()
      f = await frame()
      expect(f.visible['p0']).toBe(true)
      expect(f.first).toBe('p0')

      // 7. A click selects, a double click opens.
      await page.locator('[data-project-card="p3"]').click()
      await page.locator('[data-project-card="p3"]').dblclick()
      const seen = await page.evaluate(() => ({ selected: (window as unknown as { selected: string[] }).selected, opened: (window as unknown as { opened: string[] }).opened }))
      expect(seen.selected).toContain('p3')
      expect(seen.opened).toEqual(['p3'])
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)
})
