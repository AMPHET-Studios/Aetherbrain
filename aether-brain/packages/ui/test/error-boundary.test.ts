import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser } from 'playwright-core'

/**
 * A part of the app that throws while drawing must leave a notice and the rest of the window, never a blank
 * window (React unmounts everything above an uncaught render error). Run in real Chromium on the real
 * component, bundled with Vite; skipped when no Chromium is installed.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const BOUNDARY = path.join(here, '..', 'src', 'components', 'ErrorBoundary.tsx').replace(/\\/g, '/')

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

/** A page: a sibling that must survive, a board that throws, a quiet piece of chrome that throws, a button to throw again. */
const ENTRY = `
import { StrictMode, createElement as h, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '${BOUNDARY}'

const w = window as unknown as { closes: number }
w.closes = 0
function Bad(): never {
  throw new Error('boom: a task had no text')
}
function Page() {
  const [board, setBoard] = useState(true)
  return h(
    'div',
    null,
    h('p', { id: 'sibling' }, 'still here'),
    h('button', { id: 'open', onClick: () => setBoard(true) }, 'open'),
    h(ErrorBoundary, { what: 'the Projects board', onClose: () => { w.closes++; setBoard(false) } }, board ? h(Bad) : h('span', { id: 'fine' }, 'board closed')),
    h(ErrorBoundary, { what: 'the hint', quiet: true }, h(Bad)),
  )
}
createRoot(document.getElementById('root')!).render(h(StrictMode, null, h(Page)))
`

describe('ErrorBoundary in Chromium', () => {
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
      console.warn('error boundary test skipped, Chromium does not start:', err)
      return
    }
    // A bundle that fails to build is a failure, not a skip: the test must not go quiet.
    const { build } = await import('vite')
    // Next to the package, so the entry resolves react from the package's own node_modules.
    dir = mkdtempSync(path.join(here, '..', '.boundary-'))
    const entry = path.join(dir, 'entry.tsx')
    writeFileSync(entry, ENTRY)
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      root: path.join(here, '..'),
      define: { 'process.env.NODE_ENV': '"development"' },
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'Boundary', fileName: 'b' } },
    })
    const bundle = Array.isArray(out) ? out[0] : out
    const chunk = 'output' in bundle ? bundle.output.find((o) => o.type === 'chunk') : undefined
    js = chunk && chunk.type === 'chunk' ? chunk.code : ''
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('shows the error where the crash was, keeps everything around it, and closes on Close, Esc and Try again', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    try {
      await page.setContent('<!doctype html><title>boundary</title><div id="root"></div>')
      await page.addScriptTag({ content: js })
      const dialog = page.getByRole('alertdialog', { name: 'the Projects board crashed' })
      await dialog.waitFor({ timeout: 10_000 })
      // The notice names the part and the error; the page around it is still there; the quiet piece drew nothing.
      expect(await dialog.textContent()).toContain('Something went wrong in the Projects board')
      expect(await dialog.textContent()).toContain('boom: a task had no text')
      expect(await dialog.textContent()).toContain('Nothing was lost')
      expect(await page.locator('#sibling').textContent()).toBe('still here')
      expect(await page.getByRole('alertdialog').count()).toBe(1)
      // Details (the stack and the components that were drawing) are there to copy.
      const details = await dialog.locator('pre').textContent()
      expect(details).toContain('Aether Brain: the Projects board crashed')
      expect(details).toContain('Error: boom: a task had no text')
      expect(details).toMatch(/Components:[\s\S]*Bad/)
      // Try again draws the board again: it still throws, so the notice comes back (and nothing blanks).
      await dialog.getByRole('button', { name: 'Try again' }).click()
      await dialog.waitFor({ timeout: 5_000 })
      expect(await page.locator('#sibling').textContent()).toBe('still here')
      // Close tells the app to leave the board, and the notice goes with it.
      await dialog.getByRole('button', { name: /^Close/ }).click()
      await page.locator('#fine').waitFor({ timeout: 5_000 })
      expect(await page.evaluate(() => (window as unknown as { closes: number }).closes)).toBe(1)
      expect(await page.getByRole('alertdialog').count()).toBe(0)
      // Esc is Close.
      await page.locator('#open').click()
      await dialog.waitFor({ timeout: 5_000 })
      await page.keyboard.press('Escape')
      await page.locator('#fine').waitFor({ timeout: 5_000 })
      expect(await page.evaluate(() => (window as unknown as { closes: number }).closes)).toBe(2)
      expect(await page.locator('#sibling').textContent()).toBe('still here')
      // React reports a caught render error to the page as well; nothing else went wrong.
      expect(errors.filter((e) => !e.includes('boom: a task had no text'))).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)
})
