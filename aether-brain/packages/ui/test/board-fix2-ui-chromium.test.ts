import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Browser, Page } from 'playwright-core'

/**
 * Round 2 of the reference board's review in real Chromium with the real styles: the text box of a note longer than the creation limit
 * (diff-core-1), the middle button that pans and must not paste (live-docked-2), the sampler's readback canvas (live-docked-m7).
 * Skipped without Chromium. One bundle is built for all of them.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const posix = (...p: string[]) => path.join(here, '..', ...p).replace(/\\/g, '/')
const BOARD_VIEW = posix('src', 'board', 'BoardView.tsx')
const ACTIVE = posix('src', 'board', 'active.ts')
const STYLES = posix('src', 'styles.css')
const CORE = posix('..', 'core', 'src', 'index.ts')
const GRAPH = posix('..', 'graph', 'src', 'index.ts')
const UI = posix('src', 'index.ts')
const TAILWIND = posix('..', '..', 'apps', 'web', 'node_modules', '@tailwindcss', 'vite', 'dist', 'index.mjs')

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

/** The real BoardView over a host written in the page. `H` is what the host was asked, `active()` the board registered in active.ts. */
const ENTRY = `
import { StrictMode, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { BoardView } from '${BOARD_VIEW}'
import { getActiveBoard } from '${ACTIVE}'
import '${STYLES}'

type Json = Record<string, any>
const w = window as any

// Every pixel readback the page makes, with the attributes of the context it was made on.
w.__readbacks = [] as { willReadFrequently: boolean }[]
const realGet = CanvasRenderingContext2D.prototype.getImageData
CanvasRenderingContext2D.prototype.getImageData = function (this: CanvasRenderingContext2D, ...args: [number, number, number, number]) {
  w.__readbacks.push({ willReadFrequently: !!(this as any).getContextAttributes().willReadFrequently })
  return realGet.apply(this, args as never)
}

let root: ReturnType<typeof createRoot> | null = null

w.mount = async (cfg: Json) => {
  const H: Json = {
    saves: [] as string[],
    toasts: [] as string[],
    copied: [] as string[],
    pastes: 0,
    raw: cfg.raw as string,
    external: new Set<() => void>(),
  }
  const host: Json = {
    path: 'Boards/Gate.md',
    title: 'Gate',
    async load() { return H.raw },
    async save(raw: string, expectedBase?: string) {
      if (expectedBase !== undefined && expectedBase !== H.raw) throw new Error('The board was changed outside the board view')
      H.saves.push(raw)
      H.raw = raw
    },
    onExternalChange(cb: () => void) { H.external.add(cb); return () => H.external.delete(cb) },
    pictures: {
      async preview() { return null },
      async original() { return null },
      async add() { return [] },
      async list() { return [] },
      exists: () => true,
    },
    toast: (text: string) => { H.toasts.push(text) },
    copyText: async (t: string) => { H.copied.push(t) },
  }
  w.H = H
  w.host = host
  document.addEventListener('paste', () => { H.pastes++ })
  const el = document.getElementById('root')!
  root = createRoot(el)
  root.render(h(StrictMode, null, h(BoardView, { host: host as never, className: 'absolute inset-0' })))
}
w.active = () => getActiveBoard()
w.items = () => (getActiveBoard()?.state().doc.items ?? []) as any[]
w.state = () => getActiveBoard()?.state()
`

describe('the board view in Chromium: round 2 of the review', () => {
  let browser: Browser | null = null
  let js = ''
  let css = ''
  let dir = ''

  beforeAll(async () => {
    const exe = findChromium()
    if (!exe) return
    const { chromium } = await import('playwright-core')
    try {
      browser = await chromium.launch({ executablePath: exe })
    } catch (err) {
      console.warn('board round 2 Chromium test skipped, Chromium does not start:', err)
      return
    }
    const { build } = await import('vite')
    const tailwind = (await import(pathToFileURL(TAILWIND).href)).default as () => never
    dir = mkdtempSync(path.join(here, '..', '.board-fix2-ui-'))
    const entry = path.join(dir, 'entry.tsx')
    writeFileSync(entry, ENTRY)
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      root: path.join(here, '..'),
      plugins: [tailwind()],
      define: { 'process.env.NODE_ENV': '"development"' },
      resolve: {
        alias: [
          { find: /^@aether\/core$/, replacement: CORE },
          { find: /^@aether\/graph$/, replacement: GRAPH },
          { find: /^@aether\/ui$/, replacement: UI },
        ],
        dedupe: ['react', 'react-dom'],
      },
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'BoardFix2Ui', fileName: 'b' } },
    })
    const bundle = Array.isArray(out) ? out[0]! : out
    if ('output' in bundle) {
      const chunk = bundle.output.find((o) => o.type === 'chunk')
      js = chunk && chunk.type === 'chunk' ? chunk.code : ''
      const sheet = bundle.output.find((o) => o.type === 'asset' && o.fileName.endsWith('.css'))
      css = sheet && sheet.type === 'asset' ? String(sheet.source) : ''
    }
  }, 240_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const rawBoard = (notes: [string, number, number][] = []) => {
    const lines = ['---', 'title: Gate', 'type: board', 'created: "2026-10-09"', 'updated: "2026-10-09"', '---', '# Gate', '', 'Reference board.', '', '## Board', '']
    lines.push('- view x=0 y=0 zoom=1 bg=14161d gray=0 smooth=1 captions=0 grid=0')
    for (const [t, x, y] of notes) lines.push(`- note x=${x} y=${y} w=200 size=18 color=ffffff fill= r=0 » ${t}`)
    return lines.join('\n') + '\n'
  }
  const textOf = (n: number): string => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')

  interface Scene {
    page: Page
    errors: string[]
    items(): Promise<any[]>
    state<T = any>(expr: string): Promise<T>
    H<T = unknown>(expr: string): Promise<T>
    at(x: number, y: number): Promise<{ x: number; y: number }>
    close(): Promise<void>
  }

  async function scene(config: Record<string, unknown>): Promise<Scene> {
    const page = await browser!.newPage({ viewport: { width: 1180, height: 760 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    await page.route('http://board.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><title>board</title></head><body><div id="root" style="position:fixed;inset:0"></div></body></html>' }),
    )
    await page.goto('http://board.test/')
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await page.evaluate((c) => (window as any).mount(c), config)
    await page.waitForSelector('canvas', { timeout: 10_000 })
    return {
      page,
      errors,
      items: () => page.evaluate(() => (window as any).items()),
      state: (expr) => page.evaluate((e) => new Function('s', 'return (' + e + ')')((window as any).state()), expr) as never,
      H: (expr) => page.evaluate((e) => new Function('H', 'return (' + e + ')')((window as any).H), expr) as never,
      async at(x, y) {
        const b = (await page.locator('canvas').boundingBox())!
        return { x: b.x + b.width / 2 + x, y: b.y + b.height / 2 + y }
      },
      close: () => page.close(),
    }
  }

  /* ------------------------------------------------------------- diff-core-1 --- */

  it('the text box of a 9,000 character note holds it whole, cannot be typed longer, can be shortened, and leaving it loses nothing', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const text = textOf(9000)
    const s = await scene({ raw: rawBoard([[text, 0, 0]]) })
    try {
      expect(await s.H<string>('H.raw')).toContain(text)
      const c = await s.at(0, 0)
      await s.page.mouse.dblclick(c.x, c.y)
      const box = s.page.getByRole('textbox', { name: 'Note text' })
      await box.waitFor()
      // The whole text is in the box, and the box is as long as the note was: no longer.
      expect(await box.inputValue()).toBe(text)
      expect(await box.evaluate((el: HTMLTextAreaElement) => el.maxLength)).toBe(9000)
      await s.page.keyboard.type('xyz')
      expect(await box.inputValue()).toBe(text)
      // One letter typed in place of one deleted is all 9,000 characters again.
      await s.page.keyboard.press('Backspace')
      await s.page.keyboard.type('Z')
      expect((await box.inputValue()).length).toBe(9000)
      // Click away on empty canvas: the note is committed, and the file holds every character.
      const away = await s.at(-400, 250)
      await s.page.mouse.click(away.x, away.y)
      await box.waitFor({ state: 'detached' })
      await expect.poll(async () => ((await s.H<string[]>('H.saves')).at(-1) ?? '').includes(text.slice(0, -1) + 'Z'), { timeout: 6000 }).toBe(true)
      const notes = (await s.items()).filter((i) => i.kind === 'note')
      expect(notes).toHaveLength(1)
      expect(notes[0].text).toHaveLength(9000)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('opening a long note and clicking away changes nothing: no save, no undo step', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const text = textOf(6000)
    const s = await scene({ raw: rawBoard([[text, 0, 0]]) })
    try {
      const c = await s.at(0, 0)
      await s.page.mouse.dblclick(c.x, c.y)
      const box = s.page.getByRole('textbox', { name: 'Note text' })
      await box.waitFor()
      const away = await s.at(-400, 250)
      await s.page.mouse.click(away.x, away.y)
      await box.waitFor({ state: 'detached' })
      await s.page.waitForTimeout(1500)
      expect(await s.H<string[]>('H.saves')).toEqual([])
      expect(await s.state('s.canUndo')).toBe(false)
      expect(((await s.items()).find((i) => i.kind === 'note') ?? {}).text).toBe(text)
    } finally {
      await s.close()
    }
  }, 60_000)

  it('a new note still stops at 4,000 characters', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      await s.page.keyboard.press('t')
      const c = await s.at(0, 0)
      await s.page.mouse.click(c.x, c.y)
      const box = s.page.getByRole('textbox', { name: 'Note text' })
      await box.waitFor()
      expect(await box.evaluate((el: HTMLTextAreaElement) => el.maxLength)).toBe(4000)
    } finally {
      await s.close()
    }
  }, 60_000)

  /* ------------------------------------------------------------ live-docked-2 --- */

  it('the middle button pans and does not paste (Linux Chromium pastes the primary selection on its release)', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['hello', 0, 0]]) })
    try {
      const before = await s.state<{ x: number; y: number }>('s.doc.view')
      const start = await s.at(-300, 200)
      for (let i = 0; i < 3; i++) {
        await s.page.mouse.move(start.x, start.y)
        await s.page.mouse.down({ button: 'middle' })
        await s.page.mouse.move(start.x + 60, start.y + 20, { steps: 4 })
        await s.page.mouse.up({ button: 'middle' })
      }
      // The pan worked ...
      const after = await s.state<{ x: number; y: number }>('s.doc.view')
      expect(after.x).not.toBe(before.x)
      // ... and nothing was pasted: no paste event reached the page, so no note was added and no toast said anything.
      expect(await s.H<number>('H.pastes')).toBe(0)
      expect((await s.items()).filter((i) => i.kind === 'note')).toHaveLength(1)
      expect(await s.H<string[]>('H.toasts')).toEqual([])
      // A paste that is asked for still works: Ctrl+V with text on the clipboard makes a note.
      await s.page.evaluate(() => {
        const dt = new DataTransfer()
        dt.setData('text/plain', 'pasted on purpose')
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      })
      await expect.poll(async () => (await s.items()).filter((i) => i.kind === 'note').length).toBe(2)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  /* ------------------------------------------------------------ live-docked-m7 --- */

  it('the sampler reads its pixel on a canvas made for reading, not on the drawing canvas', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      await s.page.keyboard.press('i')
      for (let i = 0; i < 6; i++) {
        const p = await s.at(-200 + i * 40, 100)
        await s.page.mouse.move(p.x, p.y)
      }
      const p = await s.at(-100, 100)
      await s.page.mouse.click(p.x, p.y)
      // The colour read is the board's background, and it was copied.
      await expect.poll(async () => s.H<string[]>('H.copied'), { timeout: 6000 }).toEqual(['#14161d'])
      const reads = await s.page.evaluate(() => (window as any).__readbacks as { willReadFrequently: boolean }[])
      expect(reads.length).toBeGreaterThan(0)
      expect(reads.every((r) => r.willReadFrequently)).toBe(true)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)
})
