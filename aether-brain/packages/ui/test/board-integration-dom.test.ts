import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright-core'

/**
 * The Boards view in real Chromium with the real store, the real global keys and the real docked host over a vault in memory. The
 * board itself (BoardView, another module's) is a small stand-in that loads through its host, so what is tested is what this module
 * joins: the list and its lazy previews, opening, leaving and returning by key, the new-board form, the placeholder while the
 * floating window has the board, and the host's reaction to a note changed outside. Skipped when no Chromium is installed.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const posix = (...p: string[]) => path.join(here, '..', ...p).replace(/\\/g, '/')
const VIEW = posix('src', 'board', 'BoardsView.tsx')
const APP = posix('src', 'App.tsx')
const INSPECTOR = posix('src', 'components', 'Inspector.tsx')
const ACTIVE = posix('src', 'board', 'active.ts')
const STORE = posix('src', 'store.ts')
const KEYS = posix('src', 'hooks', 'useKeyboard.ts')
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

/** The board's stand-in: it loads through its host, reports outside changes, registers as the active board, and counts its life. */
const STUB = `
import { useEffect, useState } from 'react'
import { getActiveBoard, setActiveBoard } from '${ACTIVE}'
const w = window as unknown as Record<string, number>
export function BoardView({ host, className }: { host: { path: string; load(): Promise<string>; onExternalChange?(cb: () => void): () => void }; className?: string }) {
  const [text, setText] = useState('loading')
  useEffect(() => {
    let live = true
    w.mounted = (w.mounted ?? 0) + 1
    host.load().then((raw) => live && setText(raw.length + ' chars'), (e: Error) => live && setText('failed ' + e.message))
    const off = host.onExternalChange?.(() => live && setText((t) => t + ' +changed'))
    const mine = { path: host.path, exec: () => undefined, state: () => ({ selection: [] }) as never, flush: async () => ((w.flushed = (w.flushed ?? 0) + 1), true) }
    setActiveBoard(mine)
    return () => {
      live = false
      off?.()
      w.unmounted = (w.unmounted ?? 0) + 1
      if (getActiveBoard() === mine) setActiveBoard(null)
    }
  }, [host])
  return <div data-board-stub={host.path} className={className}>{text}</div>
}
`

const ENTRY = `
import { createElement as h, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryVaultAdapter, newBoardNote, parseBoard, addPicture, serializeBoard } from '@aether/core'
import { useAether } from '${STORE}'
import { useKeyboard } from '${KEYS}'
import { BoardsView } from '${VIEW}'
import { DropZone } from '${APP}'
import { Inspector } from '${INSPECTOR}'
import { setBoardWindowControl } from '${ACTIVE}'

// A valid 1 by 1 PNG, so previews really are pictures.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
function board(title: string, pics: string[], day: string) {
  const now = new Date(day + 'T10:00:00')
  let raw = newBoardNote(title, now)
  let { doc } = parseBoard(raw)
  pics.forEach((p, i) => { doc = addPicture(doc, { path: p, w: 400, h: 300, x: i * 450, y: 0 }).doc })
  return serializeBoard(doc, raw, now)
}
const files = Array.from({ length: 40 }, (_, i) => {
  const name = 'B' + String(i).padStart(2, '0')
  // B00 is the newest board, B39 the oldest.
  const day = new Date(Date.UTC(2026, 9, 1) - i * 86400000).toISOString().slice(0, 10)
  return { path: 'Boards/' + name + '.md', content: board(name, [0, 1, 2, 3].map((k) => 'Art/p' + ((i + k) % 8) + '.png'), day) }
})
files.push({ path: 'Inbox/Idea.md', content: '# Idea\\n' })
const assets = Array.from({ length: 8 }, (_, i) => ({ path: 'Art/p' + i + '.png', data: PNG }))
const vault = new MemoryVaultAdapter(files, { assets })
const w = window as unknown as Record<string, unknown>
w.vault = vault
w.app = { useAether, setBoardWindowControl }
function Harness() {
  useKeyboard()
  // After the key listener above is on (effects run in order): the page may be driven from here.
  useEffect(() => void (document.body.dataset['ready'] = '1'), [])
  return h('div', null, h(BoardsView), h(DropZone), h('div', { id: 'inspector' }, h(Inspector)))
}
w.ready = (async () => {
  await useAether.getState().openVault(vault)
  createRoot(document.getElementById('root')!).render(h(Harness))
})()
`

/**
 * The few Tailwind classes the list's layout rests on, so that it has a height and scrolls as it does in the app (the page loads no
 * stylesheet: compiling Tailwind is not what is tested).
 */
const LAYOUT_CSS = `
html,body{margin:0;overflow:hidden}
.absolute{position:absolute}.relative{position:relative}.inset-0{inset:0}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1 1 0%}
.min-h-0{min-height:0}.min-w-0{min-width:0}.overflow-hidden{overflow:hidden}.scroll{overflow:auto}.w-full{width:100%}.h-full{height:100%}
.items-stretch{align-items:stretch}.justify-center{justify-content:center}.grid{display:grid}.gap-3{gap:12px}.p-4{padding:16px}.p-3{padding:12px}.pt-16{padding-top:64px}
.max-w-\\[1180px\\]{max-width:1180px}.aspect-\\[16\\/10\\]{aspect-ratio:16/10}.object-cover{object-fit:cover}.text-left{text-align:left}
.grid-cols-\\[repeat\\(auto-fill\\,minmax\\(230px\\,1fr\\)\\)\\]{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
.grid-cols-1{grid-template-columns:1fr}.grid-cols-2{grid-template-columns:1fr 1fr}.grid-rows-1{grid-template-rows:1fr}.grid-rows-2{grid-template-rows:1fr 1fr}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.group{position:relative}.panel{display:flex}
`

describe('the Boards view in Chromium', () => {
  let browser: Browser | null = null
  /** The bundle with the board's stand-in, and the one with the real board view. */
  let js = ''
  let jsReal = ''
  let dir = ''

  beforeAll(async () => {
    const exe = findChromium()
    if (!exe) return
    const { chromium } = await import('playwright-core')
    try {
      browser = await chromium.launch({ executablePath: exe })
    } catch (err) {
      console.warn('boards view DOM test skipped, Chromium does not start:', err)
      return
    }
    // A bundle that fails to build is a failure, not a skip: the test must not go quiet.
    const { build } = await import('vite')
    dir = mkdtempSync(path.join(here, '..', '.boards-'))
    const entry = path.join(dir, 'entry.tsx')
    const stub = path.join(dir, 'BoardViewStub.tsx')
    writeFileSync(entry, ENTRY)
    writeFileSync(stub, STUB)
    const bundle = async (stubbed: boolean): Promise<string> => {
      const out = await build({
        configFile: false,
        logLevel: 'silent',
        root: path.join(here, '..'),
        resolve: {
          alias: [
            { find: /^@aether\/core$/, replacement: CORE },
            { find: /^@aether\/graph$/, replacement: GRAPH },
            { find: /^@aether\/ui$/, replacement: UI },
            // BoardsView's `./BoardView` is the stand-in; the rest of the UI package never imports it by this name.
            ...(stubbed ? [{ find: /^\.\/BoardView$/, replacement: stub.replace(/\\/g, '/') }] : []),
          ],
          dedupe: ['three', 'react', 'react-dom', 'zustand'],
        },
        define: { 'process.env.NODE_ENV': '"development"' },
        build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'Boards', fileName: 'b' } },
      })
      const first = Array.isArray(out) ? out[0]! : out
      const chunk = 'output' in first ? first.output.find((o) => o.type === 'chunk') : undefined
      return chunk && chunk.type === 'chunk' ? chunk.code : ''
    }
    js = await bundle(true)
    jsReal = await bundle(false)
  }, 240_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function appPage(real = false): Promise<{ page: Page; errors: string[] }> {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript(() => {
      ;(window as unknown as { Worker?: unknown }).Worker = undefined
    })
    await page.route('http://aether.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>boards</title><div id="root" style="position:relative;width:100vw;height:100vh"></div>' }))
    await page.goto('http://aether.test/')
    await page.addStyleTag({ content: LAYOUT_CSS })
    await page.addScriptTag({ content: real ? jsReal : js })
    await page.evaluate(() => (window as unknown as { ready: Promise<void> }).ready)
    await page.waitForFunction(() => document.body.dataset['ready'] === '1')
    return { page, errors }
  }

  const state = (page: Page) =>
    page.evaluate(() => {
      const s = (window as unknown as { app: { useAether: { getState(): { view: string; boardPath: string | null } } } }).app.useAether.getState()
      return { view: s.view, boardPath: s.boardPath }
    })
  const cards = (page: Page) => page.locator('[aria-label^="Open the board "]')
  const stub = (page: Page) => page.locator('[data-board-stub]')

  it('draws a page of cards, loads the pictures of the ones in view only, and gives them up as they scroll away', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await appPage()
    try {
      await page.keyboard.press('8')
      await cards(page).first().waitFor()
      expect(await state(page)).toEqual({ view: 'boards', boardPath: null })
      expect(await cards(page).count()).toBe(24)
      // The newest board first, each card with its pictures once they are fetched.
      await expect(cards(page).first().getAttribute('aria-label')).resolves.toBe('Open the board B00')
      await page.waitForFunction(() => document.querySelectorAll('img').length > 8, undefined, { timeout: 10_000 })
      // 24 cards of 4 pictures are 96 images: only the cards on screen (and a margin) have theirs.
      const atTop = await page.locator('img').count()
      expect(atTop).toBeGreaterThan(8)
      expect(atTop).toBeLessThan(80)
      // Every <img> of a card shows a real object URL.
      expect(await page.locator('img').evaluateAll((els) => els.every((e) => (e as HTMLImageElement).src.startsWith('blob:')))).toBe(true)
      // Scrolled to the bottom, the first card has let go of its pictures and the last one has them.
      await page.locator('.scroll').first().evaluate((el) => void (el.scrollTop = el.scrollHeight))
      await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Open the board "]')[23]?.parentElement?.querySelector('img') != null, undefined, { timeout: 10_000 })
      await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Open the board "]')[0]?.parentElement?.querySelector('img') == null, undefined, { timeout: 10_000 })
      // The rest of the boards come on request, a page at a time.
      await page.getByRole('button', { name: /Show 16 more/ }).click()
      await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Open the board "]').length === 40, undefined, { timeout: 10_000 })
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('opens a board with a click, goes up with 8 and the button, leaves with Esc and comes back with 8', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await appPage()
    try {
      await page.keyboard.press('8')
      await cards(page).first().waitFor()
      await cards(page).nth(1).click()
      await stub(page).waitFor()
      expect(await stub(page).getAttribute('data-board-stub')).toBe('Boards/B01.md')
      // The stand-in loaded through the docked host: the note's text is in.
      await page.waitForFunction(() => /\d+ chars/.test(document.querySelector('[data-board-stub]')?.textContent ?? ''), undefined, { timeout: 10_000 })
      expect(await state(page)).toEqual({ view: 'boards', boardPath: 'Boards/B01.md' })
      // 8 is "up": the list; again: the board.
      await page.keyboard.press('8')
      await cards(page).first().waitFor()
      expect(await stub(page).count()).toBe(0)
      await page.keyboard.press('8')
      await stub(page).waitFor()
      // The breadcrumb's button does the same.
      await page.getByRole('button', { name: /^← Boards/ }).click()
      await cards(page).first().waitFor()
      await cards(page).nth(1).click()
      await stub(page).waitFor()
      // Esc closes the view and keeps the board; the stand-in is gone with its host.
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('[data-board-stub]') == null && document.querySelector('[role=dialog][aria-label^="Board"]') == null)
      expect(await state(page)).toEqual({ view: 'graph', boardPath: 'Boards/B01.md' })
      await page.keyboard.press('8')
      await stub(page).waitFor()
      expect(await stub(page).getAttribute('data-board-stub')).toBe('Boards/B01.md')
      // Every mount was matched by an unmount, bar the one on screen.
      const counts = await page.evaluate(() => ({ mounted: (window as unknown as Record<string, number>).mounted, unmounted: (window as unknown as Record<string, number>).unmounted }))
      expect(counts.mounted - counts.unmounted).toBe(1)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('makes a board from the list: n opens the form, Esc in it closes only the form, Enter makes the board and opens it', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await appPage()
    try {
      await page.keyboard.press('8')
      await cards(page).first().waitFor()
      await page.keyboard.press('n')
      const input = page.getByLabel('Name of the new board')
      await input.waitFor()
      expect(await input.evaluate((el) => el === document.activeElement)).toBe(true)
      // Letters typed into the field are letters (n is not a command there).
      await input.fill('Castle ruins')
      await page.keyboard.press('Escape')
      await input.waitFor({ state: 'detached' })
      expect(await state(page)).toEqual({ view: 'boards', boardPath: null })
      // What was typed is kept when the form is opened again.
      await page.keyboard.press('n')
      await input.waitFor()
      expect(await input.inputValue()).toBe('Castle ruins')
      await page.keyboard.press('Enter')
      await stub(page).waitFor()
      expect(await stub(page).getAttribute('data-board-stub')).toBe('Boards/Castle ruins.md')
      expect(await page.evaluate(() => (window as unknown as { vault: { snapshot(): Map<string, unknown> } }).vault.snapshot().has('Boards/Castle ruins.md'))).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('finds a board by what is typed in the search box', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await appPage()
    try {
      await page.keyboard.press('8')
      await cards(page).first().waitFor()
      await page.getByLabel('Find a board').fill('b3')
      await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Open the board "]').length === 10, undefined, { timeout: 10_000 })
      await page.getByLabel('Find a board').fill('zzz')
      await page.getByText(/No board matches/).waitFor()
      await page.getByRole('button', { name: 'Show all' }).click()
      await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Open the board "]').length === 24)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('shows a placeholder while the floating window has the board and loads it again when it comes back', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await appPage()
    try {
      await page.evaluate(() => {
        const w = window as unknown as Record<string, any>
        let status = { open: true, path: 'Boards/B02.md', alwaysOnTop: true, opacity: 0.8, supportsOpacity: true }
        const subs = new Set<() => void>()
        const returned = new Set<(p: string) => void>()
        w.calls = []
        w.say = (next: Partial<typeof status>) => {
          status = { ...status, ...next }
          subs.forEach((cb) => cb())
        }
        w.giveBack = (p: string) => returned.forEach((cb) => cb(p))
        w.app.setBoardWindowControl({
          available: true,
          status: () => status,
          subscribe: (cb: () => void) => (subs.add(cb), () => subs.delete(cb)),
          popOut: async () => true,
          dock: async () => void w.calls.push('dock'),
          setAlwaysOnTop: async (on: boolean) => void w.calls.push('onTop ' + on),
          setOpacity: async (o: number) => void w.calls.push('opacity ' + o.toFixed(1)),
          onReturned: (cb: (p: string) => void) => (returned.add(cb), () => returned.delete(cb)),
          setFlush: () => () => undefined,
        })
        w.app.useAether.getState().openBoard('Boards/B02.md')
      })
      await page.getByText('This board is open in its window').waitFor()
      expect(await stub(page).count()).toBe(0)
      await expect(page.getByText('80%').count()).resolves.toBe(1)
      await page.getByRole('button', { name: 'More see-through' }).click()
      await page.getByRole('button', { name: 'Not on top' }).count().then((n) => expect(n).toBe(0))
      await page.getByRole('button', { name: 'Stays on top' }).click()
      const calls = () => page.evaluate(() => (window as unknown as { calls: string[] }).calls)
      expect(await calls()).toEqual(['opacity 0.7', 'onTop false'])
      // The window gives the board back: the placeholder goes and the board loads.
      await page.getByRole('button', { name: 'Bring it back' }).click()
      expect(await calls()).toEqual(['opacity 0.7', 'onTop false', 'dock'])
      await page.evaluate(() => (window as unknown as { say(s: unknown): void }).say({ open: false, path: null }))
      await stub(page).waitFor()
      await page.waitForFunction(() => /\d+ chars/.test(document.querySelector('[data-board-stub]')?.textContent ?? ''), undefined, { timeout: 10_000 })
      const mounted = await page.evaluate(() => (window as unknown as Record<string, number>).mounted)
      // The window's last save may have landed after the view read the note: the control's word that it returned loads it again.
      await page.evaluate(() => (window as unknown as { giveBack(p: string): void }).giveBack('boards/b02.md'))
      await page.waitForFunction((m) => (window as unknown as Record<string, number>).mounted === m + 1, mounted, { timeout: 10_000 })
      // …but a different board coming back is not this one's business.
      await page.evaluate(() => (window as unknown as { giveBack(p: string): void }).giveBack('Boards/B05.md'))
      await page.waitForTimeout(150)
      expect(await page.evaluate(() => (window as unknown as Record<string, number>).mounted)).toBe(mounted + 1)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('tells a board that its note changed outside, and has the view save before a window opens', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await appPage()
    try {
      await page.evaluate(() => {
        const w = window as unknown as Record<string, any>
        // The desktop's control: pop-out waits for the flush the view registered.
        let flush: null | (() => Promise<void> | void) = null
        w.control = {
          available: true,
          status: () => ({ open: false, path: null, alwaysOnTop: true, opacity: 1, supportsOpacity: false }),
          subscribe: () => () => undefined,
          popOut: async () => (await flush?.(), true),
          dock: async () => undefined,
          setAlwaysOnTop: async () => undefined,
          setOpacity: async () => undefined,
          onReturned: () => () => undefined,
          setFlush: (fn: () => Promise<void> | void) => ((flush = fn), () => void (flush === fn && (flush = null))),
        }
        w.app.setBoardWindowControl(w.control)
        w.app.useAether.getState().openBoard('Boards/B03.md')
      })
      await stub(page).waitFor()
      await page.waitForFunction(() => /\d+ chars/.test(document.querySelector('[data-board-stub]')?.textContent ?? ''), undefined, { timeout: 10_000 })
      // Somebody else edits the note: the view hears of it once.
      await page.evaluate(async () => {
        const w = window as unknown as { vault: { read(p: string): Promise<string>; write(p: string, c: string): Promise<void> } }
        await w.vault.write('Boards/B03.md', (await w.vault.read('Boards/B03.md')) + '\nAn AI wrote this.\n')
      })
      await page.waitForFunction(() => /\+changed/.test(document.querySelector('[data-board-stub]')?.textContent ?? ''), undefined, { timeout: 10_000 })
      expect(await stub(page).textContent()).toMatch(/\d+ chars \+changed$/)
      // Popping the board out runs the view's flush first: the active board's.
      expect(await page.evaluate(() => (window as unknown as Record<string, number | undefined>).flushed ?? 0)).toBe(0)
      await page.evaluate(() => (window as unknown as { control: { popOut(p: string): Promise<boolean> } }).control.popOut('Boards/B03.md'))
      expect(await page.evaluate(() => (window as unknown as Record<string, number>).flushed)).toBe(1)
      // With the view closed there is no flush to wait for, and no board left to flush.
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('[data-board-stub]') == null)
      await page.evaluate(() => (window as unknown as { control: { popOut(p: string): Promise<boolean> } }).control.popOut('Boards/B03.md'))
      expect(await page.evaluate(() => (window as unknown as Record<string, number>).flushed)).toBe(1)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('keeps a board open when its note is deleted outside, says so once, and takes the note back when it returns', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await appPage()
    try {
      await page.keyboard.press('8')
      await cards(page).first().waitFor()
      await cards(page).nth(1).click()
      await stub(page).waitFor()
      await page.waitForFunction(() => /\d+ chars/.test(document.querySelector('[data-board-stub]')?.textContent ?? ''), undefined, { timeout: 10_000 })
      const toasts = () => page.evaluate(() => (window as unknown as { app: { useAether: { getState(): { toasts: { text: string }[] } } } }).app.useAether.getState().toasts.map((t) => t.text))
      const raw = await page.evaluate(async () => (await (window as unknown as { vault: { read(p: string): Promise<string | null> } }).vault.read('Boards/B01.md'))!)
      // A sync tool deletes the file: the board is not dropped to the list, it stays with a notice and one message.
      await page.evaluate(async () => (window as unknown as { vault: { remove(p: string): Promise<void> } }).vault.remove('Boards/B01.md'))
      await page.getByRole('status').filter({ hasText: 'deleted or moved outside the app' }).waitFor()
      await page.waitForTimeout(300)
      expect(await stub(page).count()).toBe(1)
      expect(await stub(page).getAttribute('data-board-stub')).toBe('Boards/B01.md')
      expect(await state(page)).toEqual({ view: 'boards', boardPath: 'Boards/B01.md' })
      expect((await toasts()).filter((t) => /B01/.test(t) && /deleted or moved outside the app/.test(t))).toHaveLength(1)
      // The title and path in the header are the ones the note had.
      await expect(page.getByRole('dialog', { name: 'Board B01' }).count()).resolves.toBe(1)
      // The file comes back: the notice goes, and the board hears of the note again.
      await page.evaluate(async (text) => (window as unknown as { vault: { write(p: string, c: string): Promise<void> } }).vault.write('Boards/B01.md', text), raw)
      await page.getByRole('status').filter({ hasText: 'deleted or moved outside the app' }).waitFor({ state: 'detached' })
      expect(await stub(page).count()).toBe(1)
      expect(await state(page)).toEqual({ view: 'boards', boardPath: 'Boards/B01.md' })
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('leaves dropped files to an open board: the window’s drop zone shows nothing and imports nothing there, but still holds the drop', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await appPage()
    try {
      const drag = (type: string) =>
        page.evaluate((t) => {
          const dt = new DataTransfer()
          dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], 'dropped.png', { type: 'image/png' }))
          const e = new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt })
          window.dispatchEvent(e)
          return e.defaultPrevented
        }, type)
      const overlay = () => page.locator('[aria-live=polite]').count()
      const assets = () => page.evaluate(async () => (await (window as unknown as { vault: { listAssets(): Promise<{ path: string }[]> } }).vault.listAssets()).map((a) => a.path).filter((p) => p.includes('dropped')))
      // With the list showing, a dropped file goes to the vault as ever: the overlay says where.
      await page.keyboard.press('8')
      await cards(page).first().waitFor()
      expect(await drag('dragenter')).toBe(true)
      await page.waitForFunction(() => document.querySelector('[aria-live=polite]')?.textContent?.includes('Drop pictures into') ?? false)
      await drag('dragleave')
      await page.waitForFunction(() => document.querySelector('[aria-live=polite]') == null)
      // With a board open it is the board's: no overlay, nothing imported, and the drop is still prevented (the window must not navigate to the file).
      await cards(page).nth(1).click()
      await stub(page).waitFor()
      expect(await drag('dragenter')).toBe(true)
      expect(await drag('dragover')).toBe(true)
      expect(await overlay()).toBe(0)
      expect(await drag('drop')).toBe(true)
      await page.waitForTimeout(300)
      expect(await assets()).toEqual([])
      expect(await overlay()).toBe(0)
      // Back on the list the zone imports again.
      await page.keyboard.press('8')
      await cards(page).first().waitFor()
      expect(await drag('drop')).toBe(true)
      await page.waitForFunction(async () => ((await (window as unknown as { vault: { listAssets(): Promise<{ path: string }[]> } }).vault.listAssets()).some((a) => a.path.includes('dropped'))), undefined, { timeout: 10_000 })
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('puts the selected picture on a board from the inspector’s menu, or on a new one, without opening the view', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await appPage()
    try {
      const note = (p: string) => page.evaluate(async (path) => (await (window as unknown as { vault: { read(p: string): Promise<string | null> } }).vault.read(path)) ?? '', p)
      const store = () => page.evaluate(() => { const s = (window as unknown as { app: { useAether: { getState(): { view: string; boardPath: string | null; toasts: { text: string; action?: { label: string } }[] } } } }).app.useAether.getState(); return { view: s.view, boardPath: s.boardPath, toast: s.toasts.at(-1) ?? null } })
      await page.evaluate(() => { const a = (window as unknown as { app: { useAether: { getState(): { select(id: string): void } } } }).app; a.useAether.getState().select('image:Art/p0.png') })
      await page.getByRole('button', { name: 'Add to board ▾' }).click()
      await page.getByRole('menu', { name: 'Add to board' }).waitFor()
      // The newest boards are offered: B00 … B07.
      expect(await page.getByRole('menuitem').count()).toBe(9)
      await page.getByRole('menuitem', { name: /^B02/ }).click()
      await page.waitForFunction(async () => ((await (window as unknown as { vault: { read(p: string): Promise<string | null> } }).vault.read('Boards/B02.md')) ?? '').includes('Art/p0.png'), undefined, { timeout: 10_000 })
      expect((await note('Boards/B02.md')).match(/!\[\[Art\/p0\.png\]\]/g)).toHaveLength(1)
      // The menu closed, the view did not open, and the toast offers the board.
      expect(await page.getByRole('menu', { name: 'Add to board' }).count()).toBe(0)
      const after = await store()
      expect(after.view).toBe('graph')
      expect(after.toast).toMatchObject({ text: 'Added p0.png to B02', action: { label: 'Open' } })
      // A new board named after the picture.
      await page.getByRole('button', { name: 'Add to board ▾' }).click()
      await page.getByRole('menuitem', { name: /New board/ }).click()
      await page.waitForFunction(async () => ((await (window as unknown as { vault: { read(p: string): Promise<string | null> } }).vault.read('Boards/p0 reference.md')) ?? '').includes('Art/p0.png'), undefined, { timeout: 10_000 })
      expect((await store()).view).toBe('graph')
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('with the real board view: a drawn shape is saved by the docked host, the 3D view’s letters stay out, Esc leaves and 8 returns, an outside edit is reloaded', async (ctx) => {
    if (!browser || !jsReal) return ctx.skip()
    const { page, errors } = await appPage(true)
    try {
      const store = () => page.evaluate(() => (window as unknown as { app: { useAether: { getState(): Record<string, unknown> } } }).app.useAether.getState())
      const status = () => page.locator('footer[aria-label="Board status"]').textContent()
      const items = async () => Number(/(\d+) \/ 1500 items/.exec((await status()) ?? '')?.[1])
      await page.keyboard.press('8')
      await cards(page).first().waitFor()
      await cards(page).nth(1).click()
      await page.waitForSelector('[data-board-root]', { timeout: 15_000 })
      await page.waitForFunction(() => /4 pictures/.test(document.querySelector('footer[aria-label="Board status"]')?.textContent ?? ''), undefined, { timeout: 15_000 })
      expect(await page.locator('canvas').count()).toBe(1)
      // The board has the keyboard: the 3D view's letters change nothing there.
      const settings = JSON.stringify((await store())['settings'])
      for (const key of ['m', 'z', 'y', 'x', 'o', 'l', 'r']) await page.keyboard.press(key)
      expect(JSON.stringify((await store())['settings'])).toBe(settings)
      expect((await store())['view']).toBe('boards')
      // The rectangle tool is on (r): a drag draws one, and the host writes it into the note.
      const box = (await page.locator('canvas').boundingBox())!
      await page.mouse.move(box.x + 200, box.y + 200)
      await page.mouse.down()
      await page.mouse.move(box.x + 300, box.y + 260, { steps: 4 })
      await page.mouse.up()
      await page.waitForFunction(async () => ((await (window as unknown as { vault: { read(p: string): Promise<string> } }).vault.read('Boards/B01.md')) ?? '').includes('- rect'), undefined, { timeout: 10_000 })
      expect(await items()).toBe(5)
      // Esc: the rectangle tool, then (nothing left to undo) the view.
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => (window as unknown as { app: { useAether: { getState(): { view: string } } } }).app.useAether.getState().view === 'graph')
      expect((await store())['boardPath']).toBe('Boards/B01.md')
      // 8 brings the board back as it was saved.
      await page.keyboard.press('8')
      await page.waitForFunction(() => /5 \/ 1500 items/.test(document.querySelector('footer[aria-label="Board status"]')?.textContent ?? ''), undefined, { timeout: 15_000 })
      // Somebody else adds a note to the file: the open board reloads and shows it.
      await page.evaluate(async () => {
        const v = (window as unknown as { vault: { read(p: string): Promise<string>; write(p: string, c: string): Promise<void> } }).vault
        const raw = await v.read('Boards/B01.md')
        await v.write('Boards/B01.md', raw.replace(/\n$/, '') + '\n- note x=0 y=0 w=200 size=18 color=ffffff fill= r=0 » from outside\n')
      })
      await page.waitForFunction(() => /6 \/ 1500 items/.test(document.querySelector('footer[aria-label="Board status"]')?.textContent ?? ''), undefined, { timeout: 15_000 })
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)
})
