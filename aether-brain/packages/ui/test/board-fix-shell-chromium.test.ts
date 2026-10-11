import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright-core'

/**
 * The fixes of the board view's shell, in real Chromium with the real styles: a note typed in the real text box reaches the file
 * without leaving it, the picker and the colour panel hold the keyboard, Enter and Space on the picker's buttons, the toolbar's Tab and
 * Space, the colour typed digit by digit, a picture that claims a gigabyte (renderer memory is measured from the process table), the
 * canvas at a fractional display scale, a pointer capture that is lost, a narrow window, menus that give the focus back. Skipped
 * without Chromium. One bundle is built for all of them.
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

/** The real BoardView over a host written in the page; the host refuses a save made from a note that is no longer on disk, as the real ones do. */
const ENTRY = `
import { StrictMode, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { BoardView } from '${BOARD_VIEW}'
import { getActiveBoard } from '${ACTIVE}'
import '${STYLES}'

type Json = Record<string, any>
const w = window as any

function colourOf(path: string): string {
  let n = 0
  for (const c of path) n = (n * 31 + c.charCodeAt(0)) >>> 0
  return 'hsl(' + (n % 360) + ' 70% 50%)'
}
async function png(width: number, height: number, fill: string): Promise<Blob> {
  const c = new OffscreenCanvas(width, height)
  const g = c.getContext('2d')!
  g.fillStyle = fill
  g.fillRect(0, 0, width, height)
  return c.convertToBlob({ type: 'image/png' })
}
w.makePng = async (width: number, height: number, fill: string) => new Uint8Array(await (await png(width, height, fill)).arrayBuffer())

// Every decode the page makes, by the size of the blob: the picture that claims a gigabyte must never be one of them.
w.__decodes = [] as number[]
const realCib = window.createImageBitmap.bind(window)
;(window as any).createImageBitmap = (...args: any[]) => {
  const src = args[0]
  if (src && typeof src.size === 'number') w.__decodes.push(src.size)
  return (realCib as any)(...args)
}

let root: ReturnType<typeof createRoot> | null = null

w.mount = async (cfg: Json) => {
  const H: Json = {
    saves: [] as string[],
    toasts: [] as { text: string; action?: string }[],
    toastActions: [] as (() => void)[],
    added: [] as string[],
    opens: [] as string[],
    copied: [] as string[],
    windowCalls: [] as string[],
    globalKeys: [] as string[],
    pastes: 0,
    raw: cfg.raw as string,
    files: new Map<string, Uint8Array>(),
    external: new Set<() => void>(),
    pictureSubs: new Set<() => void>(),
  }
  const assets: { path: string; mtime: number }[] = cfg.assets ?? []
  const small = await w.makePng(64, 48, '#336699')
  // A picture of the vault is drawn in a colour of its name; one that was dropped is shown as a small stand-in (the preview the
  // helper window would make), so that only the header read of the dropped file can be what costs anything.
  const make = async (p: string, px: number) => {
    if (!H.files.has(p)) return png(Math.min(200, px), Math.min(100, px), colourOf(p))
    return new Blob([small], { type: 'image/png' })
  }
  const win = cfg.window
    ? { floating: !!cfg.window.floating, alwaysOnTop: true, opacity: 1, supportsOpacity: true,
        popOut() { H.windowCalls.push('popOut') }, dock() { H.windowCalls.push('dock') },
        setAlwaysOnTop(on: boolean) { H.windowCalls.push('onTop:' + on); this.alwaysOnTop = on },
        setOpacity(o: number) { H.windowCalls.push('opacity:' + o); this.opacity = o } }
    : undefined
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
      async preview(p: string, px: number) { return make(p, px) },
      async original(p: string) { return make(p, 99999) },
      async add(files: { name: string; data: Uint8Array }[]) {
        return files.map((f) => { const p = 'Boards/Gate/' + f.name; H.files.set(p, f.data); H.added.push(f.name); return p })
      },
      async list() { return assets },
      exists: () => true,
      open: (p: string) => H.opens.push(p),
      reveal: (p: string) => H.opens.push('reveal:' + p),
      showInBrain: (p: string) => H.opens.push('brain:' + p),
      onChange(cb: () => void) { H.pictureSubs.add(cb); return () => H.pictureSubs.delete(cb) },
    },
    toast: (text: string, _tone?: string, action?: { label: string; run(): void }) => { H.toasts.push({ text, action: action?.label }); if (action) H.toastActions.push(action.run) },
    copyText: async (t: string) => { H.copied.push(t) },
    window: win,
  }
  w.H = H
  w.host = host
  window.addEventListener('keydown', (e) => { if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) H.globalKeys.push(e.key) })
  document.addEventListener('paste', () => { H.pastes++ })
  const el = document.getElementById('root')!
  root = createRoot(el)
  root.render(h(StrictMode, null, h(BoardView, { host: host as never, className: 'absolute inset-0' })))
}
w.unmount = () => { root?.unmount(); root = null }
w.active = () => getActiveBoard()
w.items = () => (getActiveBoard()?.state().doc.items ?? []) as any[]
w.state = () => getActiveBoard()?.state()
`

/** The bytes of a PNG: signature, header, one data chunk (already deflated rows), end. */
function pngOf(width: number, height: number, idat: Buffer): Buffer {
  const crc = (buf: Buffer): number => {
    let crcv = 0xffffffff
    for (let n = 0; n < buf.length; n++) {
      let c = (crcv ^ buf[n]!) & 0xff
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcv = (crcv >>> 8) ^ c
    }
    return (crcv ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

/** A w x h 8-bit RGB PNG of one flat colour (a real, decodable picture; its pixels cost w * h * 4 bytes once decoded). */
function flatPng(width: number, height: number): Buffer {
  const row = Buffer.alloc(1 + width * 3, 0x7f)
  row[0] = 0
  const raw = Buffer.alloc(row.length * height)
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length)
  return pngOf(width, height, zlib.deflateSync(raw, { level: 1 }))
}

/**
 * The same, made row by row through a deflate stream: a 16000 x 16000 picture is 768 MB of rows and a few hundred KB of file, and the
 * rows are never all in memory at once (the file is the kind of thing a user can drop, and the decoder would need a gigabyte).
 */
async function streamedFlatPng(width: number, height: number): Promise<Buffer> {
  const deflate = zlib.createDeflate({ level: 1 })
  const parts: Buffer[] = []
  deflate.on('data', (d: Buffer) => parts.push(d))
  const ended = new Promise<void>((resolve) => deflate.once('end', () => resolve()))
  const row = Buffer.alloc(1 + width * 3, 0x7f)
  row[0] = 0
  for (let y = 0; y < height; y++) if (!deflate.write(row)) await new Promise<void>((resolve) => deflate.once('drain', () => resolve()))
  deflate.end()
  await ended
  return pngOf(width, height, Buffer.concat(parts))
}

/** The first bytes of a PNG that claims 16000 x 16000 and is not a picture at all: reading its header is all that can be done with it. */
function lyingPng(width: number, height: number): Buffer {
  const b = Buffer.alloc(40)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b)
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  b[24] = 8
  b[25] = 2
  return b
}

describe('the board view in Chromium: the fixes of the shell', () => {
  let browser: Browser | null = null
  let exe: string | undefined
  let chromiumLib: typeof import('playwright-core') | null = null
  let js = ''
  let css = ''
  let dir = ''
  const extraDirs: string[] = []

  beforeAll(async () => {
    exe = findChromium()
    if (!exe) return
    chromiumLib = await import('playwright-core')
    try {
      browser = await chromiumLib.chromium.launch({ executablePath: exe })
    } catch (err) {
      console.warn('board shell Chromium test skipped, Chromium does not start:', err)
      return
    }
    const { build } = await import('vite')
    const tailwind = (await import(pathToFileURL(TAILWIND).href)).default as () => never
    dir = mkdtempSync(path.join(here, '..', '.board-fix-shell-'))
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
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'BoardFixShell', fileName: 'b' } },
    })
    const bundle = Array.isArray(out) ? out[0]! : out
    if ('output' in bundle) {
      const chunk = bundle.output.find((o) => o.type === 'chunk')
      js = chunk && chunk.type === 'chunk' ? chunk.code : ''
      const sheet = bundle.output.find((o) => o.type === 'asset' && o.fileName.endsWith('.css'))
      css = sheet && sheet.type === 'asset' ? String(sheet.source) : ''
    }
    // For looking at a scene by hand: BOARD_FIX_BUNDLE=<folder> keeps the page's script and styles there.
    const keep = process.env['BOARD_FIX_BUNDLE']
    if (keep) {
      writeFileSync(path.join(keep, 'bundle.js'), js)
      writeFileSync(path.join(keep, 'bundle.css'), css)
    }
  }, 240_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
    for (const d of extraDirs) rmSync(d, { recursive: true, force: true })
  })

  const rawBoard = (pictures: [string, number, number, number, number][] = [], notes: [string, number, number][] = []) => {
    const lines = ['---', 'title: Gate', 'type: board', 'created: "2026-10-09"', 'updated: "2026-10-09"', '---', '# Gate', '', 'Reference board.', '', '## Board', '']
    lines.push('- view x=0 y=0 zoom=1 bg=14161d gray=0 smooth=1 captions=0 grid=0')
    for (const [p, x, y, w, h] of pictures) lines.push(`- ![[${p}]] x=${x} y=${y} w=${w} h=${h}`)
    for (const [t, x, y] of notes) lines.push(`- note x=${x} y=${y} w=200 size=18 color=ffffff fill= r=0 » ${t}`)
    return lines.join('\n') + '\n'
  }
  const three = () => rawBoard([['Boards/Gate/a.png', -300, 0, 200, 100], ['Boards/Gate/b.png', 0, 0, 200, 100], ['Boards/Gate/c.png', 300, 0, 200, 100]])

  interface Scene {
    page: Page
    errors: string[]
    items(): Promise<any[]>
    state<T = any>(expr: string): Promise<T>
    H<T = unknown>(expr: string): Promise<T>
    at(x: number, y: number): Promise<{ x: number; y: number }>
    close(): Promise<void>
  }

  async function open(page: Page, config: Record<string, unknown>, wait = true): Promise<Scene> {
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
    if (wait) await page.waitForSelector('canvas', { timeout: 10_000 })
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

  async function scene(config: Record<string, unknown>, opts: { width?: number; height?: number; reducedMotion?: boolean } = {}): Promise<Scene> {
    const page = await browser!.newPage({
      viewport: { width: opts.width ?? 1180, height: opts.height ?? 760 },
      reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference',
    })
    return open(page, config)
  }

  const poll = <T>(fn: () => Promise<T>, want: T, timeout = 6000) => expect.poll(fn, { timeout }).toEqual(want)

  /* ------------------------------------------------------- the note being typed --- */

  it('a note typed in the real text box is in the file about a second later, without leaving the box, and the indicator says so meanwhile', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      await s.page.keyboard.press('t')
      const c = await s.at(0, 0)
      await s.page.mouse.click(c.x, c.y)
      const box = s.page.getByRole('textbox', { name: 'Note text' })
      await box.waitFor()
      await s.page.keyboard.type('typed note text that must survive')
      expect(await box.inputValue()).toBe('typed note text that must survive')
      const indicator = s.page.getByRole('button', { name: /Unsaved|Saving|Saved/ })
      await expect.poll(async () => (await indicator.first().getAttribute('title')) ?? '').toMatch(/not written yet/)
      // Never blurred, never committed: the box is open and there is no undo step, yet the text is on disk.
      await poll(async () => ((await s.H<string[]>('H.saves')).at(-1) ?? '').includes('» typed note text that must survive'), true, 4000)
      expect(await s.state('s.editingNote !== null')).toBe(true)
      expect(await s.state('s.canUndo')).toBe(false)
      await expect.poll(async () => (await indicator.first().getAttribute('title')) ?? '').toMatch(/saved in its note/)
      // And a flush (the window closing) commits it and says everything is on disk.
      expect(await s.page.evaluate(() => (window as any).active().flush())).toBe(true)
      expect(await s.state('s.editingNote')).toBeNull()
      expect(await s.H<string>('H.raw')).toContain('» typed note text that must survive')
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('Esc and Enter belong to an input method that is composing in the note box: the note is not cancelled or committed', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      await s.page.keyboard.press('t')
      const c = await s.at(0, 0)
      await s.page.mouse.click(c.x, c.y)
      const box = s.page.getByRole('textbox', { name: 'Note text' })
      await box.waitFor()
      await s.page.keyboard.type('にほん')
      await box.evaluate((el) => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }))
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }))
      })
      expect(await box.inputValue()).toBe('にほん')
      expect(await s.state('s.editingNote !== null')).toBe(true)
      // The same keys, outside a composition, still do their work.
      await s.page.keyboard.press('Escape')
      await box.waitFor({ state: 'detached' })
    } finally {
      await s.close()
    }
  }, 60_000)

  /* ---------------------------------------------------------- modal overlays --- */

  async function picker(s: Scene) {
    await s.page.keyboard.press('Control+A')
    expect(await s.state('s.selection.length')).toBe(3)
    await s.page.keyboard.press('Control+O')
    const dialog = s.page.getByRole('dialog', { name: 'Add pictures to the board' })
    await dialog.waitFor()
    return dialog
  }
  const assets = [
    { path: 'Vault/x.png', mtime: 3 },
    { path: 'Vault/y.png', mtime: 2 },
  ]

  it('a click on the picker’s dead space keeps the keyboard in the picker: Esc closes it, Delete and Enter do nothing to the board', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: three(), assets })
    try {
      const dialog = await picker(s)
      await dialog.getByText(/pictures? · Shift-click/).click()
      expect(await s.page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('dialog')
      await s.page.keyboard.press('Delete')
      await s.page.keyboard.press('Control+A')
      await dialog.waitFor()
      expect((await s.items()).length).toBe(3)
      expect(await s.H('H.opens')).toEqual([])
      await s.page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      expect(await s.state('s.selection.length')).toBe(3)
      expect((await s.items()).length).toBe(3)
      // The header's padding is dead space too.
      await s.page.keyboard.press('Control+O')
      await dialog.waitFor()
      const box = (await dialog.boundingBox())!
      await s.page.mouse.click(box.x + 4, box.y + 4)
      await s.page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      expect(await s.state('s.selection.length')).toBe(3)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('with the focus on the board behind the picker, the board’s keys wait: Esc closes the picker, Delete and Ctrl+A do nothing, Tab brings the focus back in', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: three(), assets })
    try {
      const dialog = await picker(s)
      // The focus is on the board (where a click outside any control leaves it).
      await s.page.evaluate(() => (document.querySelector('[data-board-root]') as HTMLElement).focus())
      expect(await s.page.evaluate(() => document.activeElement?.hasAttribute('data-board-root'))).toBe(true)
      await s.page.keyboard.press('Delete')
      await s.page.keyboard.press('Control+A')
      await s.page.keyboard.press('Enter')
      await s.page.keyboard.press('g')
      expect((await s.items()).length).toBe(3)
      expect(await s.H('H.opens')).toEqual([])
      expect(await s.state('s.doc.gray')).toBe(false)
      await s.page.keyboard.press('Tab')
      expect(await s.page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label'))).toBe('Search pictures')
      await s.page.evaluate(() => (document.querySelector('[data-board-root]') as HTMLElement).focus())
      await s.page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      expect(await s.state('s.selection.length')).toBe(3)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('Tab goes round inside the picker; Enter on Cancel cancels, Space on Close closes (neither adds a picture)', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: three(), assets })
    try {
      const dialog = await picker(s)
      const labelOf = () => s.page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? (document.activeElement as HTMLElement | null)?.textContent ?? '')
      const seen = new Set<string>()
      for (let i = 0; i < 12; i++) {
        await s.page.keyboard.press('Tab')
        expect(await s.page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
        seen.add(await labelOf())
      }
      expect([...seen].some((l) => /Cancel/.test(l))).toBe(true)
      await s.page.keyboard.press('Shift+Tab')
      expect(await s.page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
      await dialog.getByRole('button', { name: /Cancel/ }).focus()
      await s.page.keyboard.press('Enter')
      await dialog.waitFor({ state: 'detached' })
      expect((await s.items()).length).toBe(3)
      await s.page.keyboard.press('Control+O')
      await dialog.waitFor()
      await dialog.getByRole('button', { name: 'Close' }).focus()
      await s.page.keyboard.press('Space')
      await dialog.waitFor({ state: 'detached' })
      expect((await s.items()).length).toBe(3)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('the colour panel holds the keyboard too: opened with the mouse, Esc closes it and keeps the selection; a click on its text does not hand the keys to the board', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: three() })
    try {
      await s.page.keyboard.press('Control+A')
      await s.page.getByTitle('Colour, line width and note size').click()
      const panel = s.page.getByRole('dialog', { name: 'Colour and size' })
      await panel.waitFor()
      await panel.getByText('Line width').click()
      await s.page.keyboard.press('Delete')
      expect((await s.items()).length).toBe(3)
      await s.page.keyboard.press('Escape')
      await panel.waitFor({ state: 'detached' })
      expect(await s.state('s.selection.length')).toBe(3)
      // Opened again, and the focus pulled out to the board behind it: Esc still closes the panel.
      await s.page.getByTitle('Colour, line width and note size').click()
      await panel.waitFor()
      await s.page.evaluate(() => (document.querySelector('[data-board-root]') as HTMLElement).focus())
      await s.page.keyboard.press('Delete')
      expect((await s.items()).length).toBe(3)
      await s.page.keyboard.press('Escape')
      await panel.waitFor({ state: 'detached' })
      expect(await s.state('s.selection.length')).toBe(3)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('a colour is typed digit by digit: the field is not rewritten at the third digit', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      await s.page.getByTitle('Colour, line width and note size').click()
      const hex = s.page.getByRole('textbox', { name: 'Colour (hex)', exact: true })
      await hex.fill('')
      await hex.pressSequentially('123456', { delay: 20 })
      expect(await hex.inputValue()).toBe('123456')
      expect(await s.state('s.style.color')).toBe('123456')
      // The short form is taken when the field is left.
      await hex.fill('')
      await hex.pressSequentially('f80', { delay: 20 })
      expect(await hex.inputValue()).toBe('f80')
      await s.page.keyboard.press('Enter')
      expect(await s.state('s.style.color')).toBe('ff8800')
    } finally {
      await s.close()
    }
  }, 60_000)

  it('the toolbar is reachable from the keyboard: Tab moves between its buttons, Space on a button presses it, Tab on the board still hides the bars', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      const pen = s.page.getByRole('button', { name: /^Pen/ })
      await pen.focus()
      await s.page.keyboard.press('Space')
      expect(await s.state('s.tool')).toBe('pen')
      const before = await s.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
      await s.page.keyboard.press('Tab')
      const after = await s.page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent)
      expect(after).not.toBe(before)
      await s.page.getByRole('toolbar').waitFor()
      expect(await s.page.evaluate(() => !!document.activeElement?.closest('[role="toolbar"]'))).toBe(true)
      // Shift+Tab from the board is the browser's, not the hide key; Tab from the board hides.
      await s.page.evaluate(() => (document.querySelector('[data-board-root]') as HTMLElement).focus())
      await s.page.keyboard.press('Tab')
      await s.page.getByRole('toolbar').waitFor({ state: 'detached' })
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('a menu hands the focus back to the button that opened it, and the board root is a labelled group', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      expect(await s.page.getByRole('group', { name: /Reference board: Gate/ }).count()).toBeGreaterThan(0)
      const edit = s.page.getByRole('button', { name: 'Edit', exact: true })
      await edit.focus()
      await s.page.keyboard.press('Enter')
      const menu = s.page.getByRole('menu', { name: 'Edit' })
      await menu.waitFor()
      await s.page.keyboard.press('ArrowDown')
      expect(await menu.getAttribute('aria-activedescendant')).toBeTruthy()
      await s.page.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
      expect(await s.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Edit')
    } finally {
      await s.close()
    }
  }, 60_000)

  it('Edit > Paste is always offered; with nothing copied on the board it says how to paste from the clipboard', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      await s.page.getByRole('button', { name: 'Edit', exact: true }).click()
      const paste = s.page.getByRole('menuitem', { name: /^Paste/ })
      expect(await paste.isDisabled()).toBe(false)
      await paste.click()
      await expect.poll(async () => (await s.H<{ text: string }[]>('H.toasts')).at(-1)?.text ?? '').toMatch(/system clipboard, press Ctrl V/)
    } finally {
      await s.close()
    }
  }, 60_000)

  it('holding Ctrl+V pastes once: the repeats of the key never become paste events', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/a.png', 0, 0, 200, 100]]) })
    try {
      await s.page.evaluate(() => (document.querySelector('[data-board-root]') as HTMLElement).focus())
      await s.page.keyboard.down('Control')
      for (let i = 0; i < 4; i++) await s.page.keyboard.down('v')
      await s.page.keyboard.up('v')
      await s.page.keyboard.up('Control')
      await s.page.waitForTimeout(300)
      expect(await s.H<number>('H.pastes')).toBeLessThanOrEqual(1)
    } finally {
      await s.close()
    }
  }, 60_000)

  /* ----------------------------------------------------------------- the canvas --- */

  it('a pointer capture that is lost lets the gesture go; a normal release does not; a lost 2D context is cancelled so it can be restored', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/a.png', 0, 0, 200, 100]]) })
    try {
      const start = await s.at(0, 0)
      await s.page.mouse.move(start.x, start.y)
      await s.page.mouse.down()
      await s.page.mouse.move(start.x + 40, start.y, { steps: 4 })
      expect(((await s.items())[0] as { x: number }).x).toBeGreaterThan(0)
      await s.page.evaluate(() => {
        document.querySelector('canvas')!.releasePointerCapture(1)
      })
      // The browser tells of the lost capture before the next pointer event.
      await s.page.mouse.move(start.x + 41, start.y)
      await poll(async () => ((await s.items())[0] as { x: number }).x, 0)
      await s.page.mouse.up()
      // A drag that ends the normal way is committed (the capture lost after the release is no loss).
      await s.page.mouse.move(start.x, start.y)
      await s.page.mouse.down()
      await s.page.mouse.move(start.x + 40, start.y, { steps: 4 })
      await s.page.mouse.up()
      await poll(async () => ((await s.items())[0] as { x: number }).x, 40)
      const cancelled = await s.page.evaluate(() => {
        const c = document.querySelector('canvas')!
        const e = new Event('contextlost', { cancelable: true })
        c.dispatchEvent(e)
        return e.defaultPrevented
      })
      expect(cancelled).toBe(true)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('the canvas ignores the transform of the panel round it: its size is the layout size', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    await page.route('http://board.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><title>board</title></head><body><div id="root" style="position:fixed;inset:0;transform:scale(0.9);transform-origin:0 0"></div></body></html>' }),
    )
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    try {
      await page.goto('http://board.test/')
      await page.addStyleTag({ content: css })
      await page.addScriptTag({ content: js })
      await page.evaluate((c) => (window as any).mount(c), { raw: rawBoard() })
      await page.waitForSelector('canvas')
      const sizes = await page.evaluate(() => {
        const wrap = document.querySelector('canvas')!.parentElement!
        const st = (window as any).state()
        return { layoutW: wrap.clientWidth, layoutH: wrap.clientHeight, rectW: wrap.getBoundingClientRect().width, viewW: st.viewport.w, viewH: st.viewport.h }
      })
      expect(sizes.rectW).toBeLessThan(sizes.layoutW - 20)
      expect(Math.abs(sizes.viewW - sizes.layoutW)).toBeLessThan(1)
      expect(Math.abs(sizes.viewH - sizes.layoutH)).toBeLessThan(1)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)

  it('at a fractional display scale the canvas has a whole number of device pixels, pinned to its box, wherever the box sits', async (ctx) => {
    if (!browser || !js || !exe || !chromiumLib) return ctx.skip()
    const ud = mkdtempSync(path.join(os.tmpdir(), 'board-dpr-'))
    extraDirs.push(ud)
    const context = await chromiumLib.chromium.launchPersistentContext(ud, { executablePath: exe, viewport: null, args: ['--force-device-scale-factor=1.5', '--window-size=1100,800'] })
    try {
      const page = await context.newPage()
      const s = await open(page, { raw: rawBoard([['Boards/Gate/a.png', 0, 0, 200, 100]]) })
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1.5)
      const bad: string[] = []
      for (const [w, h] of [[1000.3, 700.7], [1001.6, 703.2], [1003.9, 701.5], [999.4, 698.8], [1002.2, 705.3], [997.7, 699.9]] as const) {
        await page.evaluate(([bw, bh]) => {
          const root = document.getElementById('root')!
          root.style.inset = 'auto'
          root.style.left = '3.3px'
          root.style.top = '1.7px'
          root.style.width = bw + 'px'
          root.style.height = bh + 'px'
        }, [w, h] as const)
        await page.waitForTimeout(250)
        const m = await page.evaluate(() => {
          const c = document.querySelector('canvas')!
          const r = c.getBoundingClientRect()
          const d = window.devicePixelRatio
          const snapped = (a: number, b: number) => Math.round(b * d) - Math.round(a * d)
          return { w: c.width, h: c.height, sw: snapped(r.left, r.right), sh: snapped(r.top, r.bottom), css: c.style.width + ' ' + c.style.height }
        })
        if (m.w !== m.sw || m.h !== m.sh) bad.push(`${w}x${h}: bitmap ${m.w}x${m.h} but the box snaps to ${m.sw}x${m.sh} (${m.css})`)
      }
      expect(bad).toEqual([])
      expect(s.errors).toEqual([])
    } finally {
      await context.close()
    }
  }, 90_000)

  /* ------------------------------------------------------------ narrow windows --- */

  it('in a 480 x 320 window the toolbar tucks its rarer tools away, the board keeps room, and the status bar wraps instead of cutting a message', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() }, { width: 480, height: 320 })
    try {
      const box = (await s.page.locator('canvas').boundingBox())!
      const bar = (await s.page.getByRole('toolbar').boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(150)
      expect(bar.height).toBeLessThanOrEqual(110)
      // The tools that are gone from the bar are in "More tools", and the keys still work.
      expect(await s.page.getByRole('button', { name: /^Rectangle/ }).count()).toBe(0)
      await s.page.getByRole('button', { name: 'More tools' }).click()
      const menu = s.page.getByRole('menu', { name: 'More tools' })
      await menu.getByRole('menuitem', { name: /Rectangle/i }).click()
      expect(await s.state('s.tool')).toBe('rect')
      await s.page.keyboard.press('v')
      expect(await s.state('s.tool')).toBe('select')
      // A long message wraps: nothing of it is clipped by the bar.
      await s.page.evaluate(() => (window as any).active().exec('edit.paste'))
      const message = s.page.locator('footer[aria-label="Board status"] [role="status"]')
      await message.waitFor()
      const fit = await message.evaluate((el) => ({ over: el.scrollWidth - el.clientWidth, text: el.textContent ?? '', right: el.getBoundingClientRect().right }))
      expect(fit.over).toBeLessThanOrEqual(1)
      expect(fit.text).toMatch(/press Ctrl V\.$/)
      expect(fit.right).toBeLessThanOrEqual(481)
      // At a wide window the same tools are all on the bar and "More tools" is hidden.
      await s.page.setViewportSize({ width: 1180, height: 760 })
      await expect.poll(() => s.page.getByRole('button', { name: /^Rectangle/ }).count()).toBe(1)
      expect(await s.page.getByRole('button', { name: 'More tools' }).count()).toBe(0)
    } finally {
      await s.close()
    }
  }, 60_000)

  it('with reduced motion the saving dot sits still', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() }, { reducedMotion: true })
    try {
      const name = await s.page.evaluate(() => {
        const d = document.createElement('span')
        d.className = 'pulse'
        document.body.appendChild(d)
        return getComputedStyle(d).animationName
      })
      expect(name).toBe('none')
    } finally {
      await s.close()
    }
  }, 60_000)

  /* ------------------------------------------------------------------- memory --- */

  /** The biggest resident size (MB) among the renderer processes of the browser started with this user-data-dir. */
  function rendererMb(ud: string): number {
    const out = execSync('ps -eo pid,ppid,rss,args --no-headers', { maxBuffer: 1 << 26 }).toString().split('\n').filter(Boolean)
    const rows = out.flatMap((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
      return m ? [{ pid: +m[1]!, ppid: +m[2]!, rss: +m[3]! / 1024, args: m[4]! }] : []
    })
    const main = rows.find((r) => r.args.includes('--user-data-dir=' + ud) && !r.args.includes('--type='))
    if (!main) return 0
    const kids = new Map<number, typeof rows>()
    for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r])
    let best = 0
    const walk = (p: number): void => {
      for (const k of kids.get(p) ?? []) {
        if (/--type=renderer/.test(k.args)) best = Math.max(best, k.rss)
        walk(k.pid)
      }
    }
    walk(main.pid)
    return best
  }

  it('dropping an 8000 x 8000 picture (64 megapixels, a quarter gigabyte decoded) does not grow the renderer: its size is read from the header', async (ctx) => {
    if (!browser || !js || !exe || !chromiumLib) return ctx.skip()
    const file = path.join(os.tmpdir(), `board-fix-8k-${process.pid}.png`)
    writeFileSync(file, flatPng(8000, 8000))
    extraDirs.push(file)
    const ud = mkdtempSync(path.join(os.tmpdir(), 'board-mem-'))
    extraDirs.push(ud)
    const context = await chromiumLib.chromium.launchPersistentContext(ud, { executablePath: exe, viewport: { width: 1180, height: 760 } })
    try {
      const page = await context.newPage()
      const s = await open(page, { raw: rawBoard() })
      const b64 = (await import('node:fs')).readFileSync(file).toString('base64')
      await page.waitForTimeout(800)
      const before = rendererMb(ud)
      let peak = before
      const sampler = (async () => {
        for (let i = 0; i < 80; i++) {
          peak = Math.max(peak, rendererMb(ud))
          await new Promise((r) => setTimeout(r, 40))
        }
      })()
      await page.evaluate(async (data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
        const dt = new DataTransfer()
        for (let i = 0; i < 4; i++) dt.items.add(new File([bytes], 'huge ' + i + '.png', { type: 'image/png' }))
        document.querySelector('[data-board-root]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 500, clientY: 400 }))
      }, b64)
      await poll(async () => (await s.items()).length, 4, 20_000)
      await sampler
      // Four such pictures decoded at once would be a gigabyte: the header read costs nothing.
      expect(peak - before).toBeLessThan(150)
      // None of the dropped files was ever handed to the decoder.
      const decodes = await page.evaluate(() => (window as any).__decodes as number[])
      expect(decodes.filter((n) => n > 50_000)).toEqual([])
      expect(s.errors).toEqual([])
    } finally {
      await context.close()
    }
  }, 120_000)

  it('a real 16000 x 16000 PNG (a few hundred KB, a gigabyte decoded) dropped on the board: refused with the reason, and the renderer does not grow', async (ctx) => {
    if (!browser || !js || !exe || !chromiumLib) return ctx.skip()
    const png = await streamedFlatPng(16000, 16000)
    // A real picture, small as a file: it is the pixels that cost.
    expect(png.length).toBeLessThan(5 * 1024 * 1024)
    const ud = mkdtempSync(path.join(os.tmpdir(), 'board-mem-'))
    extraDirs.push(ud)
    const context = await chromiumLib.chromium.launchPersistentContext(ud, { executablePath: exe, viewport: { width: 1180, height: 760 } })
    try {
      const page = await context.newPage()
      const s = await open(page, { raw: rawBoard() })
      await page.waitForTimeout(800)
      const before = rendererMb(ud)
      let peak = before
      let sampling = true
      const sampler = (async () => {
        while (sampling) {
          peak = Math.max(peak, rendererMb(ud))
          await new Promise((r) => setTimeout(r, 40))
        }
      })()
      await page.evaluate(async (data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
        const dt = new DataTransfer()
        for (let i = 0; i < 2; i++) dt.items.add(new File([bytes], 'wall ' + i + '.png', { type: 'image/png' }))
        document.querySelector('[data-board-root]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 500, clientY: 400 }))
      }, png.toString('base64'))
      await expect.poll(async () => (await s.H<{ text: string }[]>('H.toasts')).map((t) => t.text).join('|')).toMatch(/2 pictures are over 150 megapixels/)
      await page.waitForTimeout(600)
      sampling = false
      await sampler
      // Decoded, one of them is a gigabyte (two at once, two): the header read costs nothing.
      expect(peak - before).toBeLessThan(150)
      expect(await s.H('H.added')).toEqual([])
      expect((await s.items()).length).toBe(0)
      expect((await page.evaluate(() => (window as any).__decodes as number[])).filter((n) => n > 50_000)).toEqual([])
      expect(s.errors).toEqual([])
    } finally {
      await context.close()
    }
  }, 180_000)

  it('a picture whose header claims 16000 x 16000 is refused with the reason, and nothing of it is decoded or read', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      const b64 = lyingPng(16000, 16000).toString('base64')
      await s.page.evaluate(async (data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
        const dt = new DataTransfer()
        dt.items.add(new File([bytes], 'wall.png', { type: 'image/png' }))
        document.querySelector('[data-board-root]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 500, clientY: 400 }))
      }, b64)
      await expect.poll(async () => (await s.H<{ text: string }[]>('H.toasts')).map((t) => t.text).join('|')).toMatch(/wall\.png is over 150 megapixels/)
      expect(await s.H('H.added')).toEqual([])
      expect((await s.items()).length).toBe(0)
      expect(await s.page.evaluate(() => (window as any).__decodes as number[])).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)
})

// Keep the type import used when the browser is missing.
export type { BrowserContext }
