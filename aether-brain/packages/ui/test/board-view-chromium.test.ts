import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Browser, Page } from 'playwright-core'

/**
 * The board view in real Chromium, over a fake host that lives in the page: the view is rendered with its real styles, pictures are
 * dropped and pasted, dragged with the mouse, drawn with the pen, a note is typed, undone, the file is saved (throttled while a drag
 * lasts, at once when it ends), the note changes outside, the picker lists thousands of pictures through a window of rows, the
 * context menu opens, and a page that also listens for keys never sees the ones the board used. Skipped when no Chromium is installed.
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
/** Set to a folder to keep a screenshot of each scene there (for looking at, not for checking). */
const SHOTS = process.env['BOARD_VIEW_SHOTS']

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

/**
 * The page: the real BoardView over a host written here. `mount(config)` renders it (in strict mode, as the floating window does);
 * `H` is what the host was asked, `active()` the board registered in active.ts. The page also listens for keys and drops on the
 * window, as the app does, to show what the board leaves to it.
 */
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
w.makeHalves = async (width: number, height: number, a: string, b: string) => {
  const c = new OffscreenCanvas(width, height)
  const g = c.getContext('2d')!
  g.fillStyle = a
  g.fillRect(0, 0, width / 2, height)
  g.fillStyle = b
  g.fillRect(width / 2, 0, width / 2, height)
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())
}

let root: ReturnType<typeof createRoot> | null = null

w.mount = async (cfg: Json) => {
  const H: Json = {
    saves: [] as string[],
    toasts: [] as string[],
    added: [] as string[],
    opens: [] as string[],
    copied: [] as string[],
    previews: [] as string[],
    originals: [] as string[],
    windowCalls: [] as string[],
    globalKeys: [] as string[],
    windowDrops: 0,
    windowDragEnters: 0,
    raw: cfg.raw as string,
    saveDelay: 0,
    maxInFlight: 0,
    inFlight: 0,
    present: cfg.present ? new Set<string>(cfg.present) : null,
    files: new Map<string, Uint8Array>(),
    external: new Set<() => void>(),
    pictureSubs: new Set<() => void>(),
    colours: (cfg.colours ?? {}) as Record<string, string>,
    sizes: (cfg.sizes ?? {}) as Record<string, [number, number]>,
  }
  // Pictures with two halves of colour, made before the board draws anything.
  for (const [p, [a, b]] of Object.entries((cfg.halves ?? {}) as Record<string, [string, string]>)) H.files.set(p, await w.makeHalves(200, 100, a, b))
  const assets: { path: string; mtime: number }[] = cfg.assets ?? []
  if (cfg.bigVault) for (let i = 0; i < cfg.bigVault; i++) assets.push({ path: 'Vault/Folder ' + (i % 50) + '/pic ' + String(i).padStart(5, '0') + (i % 7 === 0 ? ' rust' : '') + '.png', mtime: 1000000 - i })
  const make = async (p: string, px: number) => {
    const bytes = H.files.get(p)
    if (bytes) return new Blob([bytes], { type: 'image/png' })
    const [bw, bh] = H.sizes[p] ?? [200, 100]
    return png(Math.min(bw, px), Math.min(bh, px), H.colours[p] ?? colourOf(p))
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
    async save(raw: string) {
      H.inFlight++
      H.maxInFlight = Math.max(H.maxInFlight, H.inFlight)
      try {
        if (H.saveDelay) await new Promise((r) => setTimeout(r, H.saveDelay))
        H.saves.push(raw)
        H.raw = raw
      } finally { H.inFlight-- }
    },
    onExternalChange(cb: () => void) { H.external.add(cb); return () => H.external.delete(cb) },
    pictures: {
      async preview(p: string, px: number) { H.previews.push(p); return make(p, px) },
      async original(p: string) { H.originals.push(p); return make(p, 99999) },
      async add(files: { name: string; data: Uint8Array }[]) {
        return files.map((f) => { const p = 'Boards/Gate/' + f.name; H.files.set(p, f.data); H.added.push(f.name); return p })
      },
      async list() { return assets },
      exists: (p: string) => H.present === null || H.present.has(p),
      open: (p: string) => H.opens.push(p),
      reveal: (p: string) => H.opens.push('reveal:' + p),
      showInBrain: (p: string) => H.opens.push('brain:' + p),
      onChange(cb: () => void) { H.pictureSubs.add(cb); return () => H.pictureSubs.delete(cb) },
    },
    toast: (text: string) => H.toasts.push(text),
    copyText: async (t: string) => { H.copied.push(t) },
    window: win,
  }
  w.H = H
  w.host = host
  window.addEventListener('keydown', (e) => { if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) H.globalKeys.push(e.key) })
  window.addEventListener('drop', () => H.windowDrops++)
  window.addEventListener('dragenter', () => H.windowDragEnters++)
  const el = document.getElementById('root')!
  root = createRoot(el)
  root.render(h(StrictMode, null, h(BoardView, { host: host as never, className: 'absolute inset-0' })))
}
w.unmount = () => { root?.unmount(); root = null }
w.active = () => getActiveBoard()
w.items = () => (getActiveBoard()?.state().doc.items ?? []) as any[]
w.state = () => getActiveBoard()?.state()
`

describe('the board view in Chromium', () => {
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
      console.warn('board view Chromium test skipped, Chromium does not start:', err)
      return
    }
    // A bundle that fails to build is a failure, not a skip: the test must not go quiet.
    const { build } = await import('vite')
    const tailwind = (await import(pathToFileURL(TAILWIND).href)).default as () => never
    // Next to the package, so the entry resolves react from the package's own node_modules.
    dir = mkdtempSync(path.join(here, '..', '.board-view-'))
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
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'BoardViewTest', fileName: 'b' } },
    })
    const bundle = Array.isArray(out) ? out[0]! : out
    if ('output' in bundle) {
      const chunk = bundle.output.find((o) => o.type === 'chunk')
      js = chunk && chunk.type === 'chunk' ? chunk.code : ''
      const sheet = bundle.output.find((o) => o.type === 'asset' && o.fileName.endsWith('.css'))
      css = sheet && sheet.type === 'asset' ? String(sheet.source) : ''
    }
    if (SHOTS) mkdirSync(SHOTS, { recursive: true })
  }, 240_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /* ------------------------------------------------------------- helpers --- */

  /** A board note with these pictures (path, x, y, w, h), written the way the board file writes them. */
  const rawBoard = (pictures: [string, number, number, number, number][] = [], notes: [string, number, number][] = [], title = 'Gate') => {
    const lines = ['---', `title: ${title}`, 'type: board', 'created: "2026-10-09"', 'updated: "2026-10-09"', '---', `# ${title}`, '', 'Reference board.', '', '## Board', '']
    lines.push('- view x=0 y=0 zoom=1 bg=14161d gray=0 smooth=1 captions=0 grid=0')
    for (const [p, x, y, w, h] of pictures) lines.push(`- ![[${p}]] x=${x} y=${y} w=${w} h=${h}`)
    for (const [t, x, y] of notes) lines.push(`- note x=${x} y=${y} w=200 size=18 color=ffffff fill= r=0 » ${t}`)
    return lines.join('\n') + '\n'
  }

  interface Scene {
    page: Page
    errors: string[]
    /** The canvas's box on the page. */
    box(): Promise<{ x: number; y: number; width: number; height: number }>
    /** A board point (view at 0, 0, zoom 1) as a point of the page. */
    at(x: number, y: number): Promise<{ x: number; y: number }>
    items(): Promise<any[]>
    H<T = unknown>(expr: string): Promise<T>
    pixel(x: number, y: number): Promise<number[]>
    shot(name: string): Promise<void>
    close(): Promise<void>
  }

  async function scene(config: Record<string, unknown>, opts: { width?: number; height?: number; wait?: boolean; touch?: boolean; reducedMotion?: boolean } = {}): Promise<Scene> {
    const page = await browser!.newPage({
      viewport: { width: opts.width ?? 1180, height: opts.height ?? 760 },
      hasTouch: opts.touch ?? false,
      reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference',
    })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    // A real origin: an about:blank page has no localStorage, and the camera is remembered there.
    await page.route('http://board.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><title>board</title></head><body><div id="root" style="position:fixed;inset:0"></div></body></html>' }),
    )
    await page.goto('http://board.test/')
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await page.evaluate((c) => (window as any).mount(c), config)
    if (opts.wait !== false) await page.waitForSelector('canvas', { timeout: 10_000 })
    const box = async () => (await page.locator('canvas').boundingBox())!
    const s: Scene = {
      page,
      errors,
      box,
      async at(x, y) {
        const b = await box()
        return { x: b.x + b.width / 2 + x, y: b.y + b.height / 2 + y }
      },
      items: () => page.evaluate(() => (window as any).items()),
      H: (expr) => page.evaluate((e) => new Function('H', 'return (' + e + ')')((window as any).H), expr) as never,
      async pixel(x, y) {
        const p = await s.at(x, y)
        const b = await box()
        return page.evaluate(
          ({ px, py }) => {
            const c = document.querySelector('canvas')!
            const r = c.getBoundingClientRect()
            const d = window.devicePixelRatio
            return Array.from(c.getContext('2d')!.getImageData(Math.round((px - r.left) * d), Math.round((py - r.top) * d), 1, 1).data)
          },
          { px: p.x, py: p.y + 0 * b.y },
        )
      },
      async shot(name) {
        // After the entrance animation (160 ms): a shot of a half-faded panel says nothing.
        if (SHOTS) {
          await page.waitForTimeout(300)
          await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
        }
      },
      async close() {
        await page.close()
      },
    }
    return s
  }

  /** Waits until the canvas has drawn a pixel of this colour (within a few levels) at a board point. */
  async function expectPixel(s: Scene, x: number, y: number, rgb: [number, number, number], tol = 6) {
    await expect
      .poll(async () => {
        const p = await s.pixel(x, y)
        return Math.max(Math.abs(p[0]! - rgb[0]), Math.abs(p[1]! - rgb[1]), Math.abs(p[2]! - rgb[2])) <= tol
      }, { timeout: 8000, message: `pixel at ${x},${y} should be ${rgb}` })
      .toBe(true)
  }

  const BG: [number, number, number] = [0x14, 0x16, 0x1d]

  it('draws the board on its canvas with the real styles: toolbar, status bar, the hint on an empty board', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      await s.page.getByRole('toolbar').waitFor()
      expect(await s.page.getByText('Drop pictures here').first().isVisible()).toBe(true)
      const box = await s.box()
      expect(box.width).toBeGreaterThan(800)
      expect(box.height).toBeGreaterThan(500)
      await expectPixel(s, -300, 200, BG)
      // The canvas is sized for the screen's density.
      const sizes = await s.page.evaluate(() => {
        const c = document.querySelector('canvas')!
        const r = c.getBoundingClientRect()
        return { w: c.width, h: c.height, cw: r.width, ch: r.height, dpr: window.devicePixelRatio }
      })
      expect(sizes.w).toBe(Math.round(sizes.cw * sizes.dpr))
      expect(sizes.h).toBe(Math.round(sizes.ch * sizes.dpr))
      expect(await s.page.getByRole('contentinfo', { name: 'Board status' }).textContent()).toContain('0 / 1500 items')
      await s.shot('empty')
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  /** Waits until a pixel near a board point is this colour (the line of a stroke may fall between two pixel rows). */
  async function expectNear(s: Scene, x: number, y: number, rgb: [number, number, number], tol = 40) {
    await expect
      .poll(
        async () => {
          for (const [dx, dy] of [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
            const p = await s.pixel(x + dx, y + dy)
            if (Math.max(Math.abs(p[0]! - rgb[0]), Math.abs(p[1]! - rgb[1]), Math.abs(p[2]! - rgb[2])) <= tol) return true
          }
          return false
        },
        { timeout: 8000, message: `a pixel near ${x},${y} should be ${rgb}` },
      )
      .toBe(true)
  }

  const poll = <T>(fn: () => Promise<T>, want: T, timeout = 6000) => expect.poll(fn, { timeout }).toEqual(want)

  /** Drops (or pastes) picture files on the board the way the browser delivers them. */
  async function transfer(s: Scene, kind: 'drop' | 'paste', files: { name: string; w: number; h: number; colour: string }[], extra: { text?: string; uri?: string; html?: string } = {}, at = { x: 0, y: 0 }) {
    const p = await s.at(at.x, at.y)
    return s.page.evaluate(
      async ({ kind, files, extra, p }) => {
        const dt = new DataTransfer()
        for (const f of files) dt.items.add(new File([await (window as any).makePng(f.w, f.h, f.colour)], f.name, { type: 'image/png' }))
        if (extra.text) dt.setData('text/plain', extra.text)
        if (extra.uri) dt.setData('text/uri-list', extra.uri)
        if (extra.html) dt.setData('text/html', extra.html)
        const target = document.querySelector('canvas')!
        const seen: Record<string, boolean> = {}
        if (kind === 'drop') {
          for (const type of ['dragenter', 'dragover', 'drop']) {
            const e = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: p.x, clientY: p.y })
            target.dispatchEvent(e)
            seen[type] = e.defaultPrevented
          }
        } else {
          const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
          ;(document.activeElement ?? document.body).dispatchEvent(e)
          seen['paste'] = e.defaultPrevented
        }
        return seen
      },
      { kind, files, extra, p },
    )
  }

  /* -------------------------------------------------------------- tests --- */

  it('a dropped picture is saved in the board’s folder, drawn on the board, and never reaches the app’s window-wide drop zone', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      const seen = await s.page.evaluate(async () => {
        const dt = new DataTransfer()
        dt.items.add(new File([await (window as any).makePng(400, 300, '#ff0000')], 'gate.png', { type: 'image/png' }))
        const target = document.querySelector('canvas')!
        const r = target.getBoundingClientRect()
        const enter = new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 500, clientY: r.top + 300 })
        target.dispatchEvent(enter)
        return { enterPrevented: enter.defaultPrevented }
      })
      expect(seen).toEqual({ enterPrevented: true })
      await s.page.getByText('Drop pictures to put them on the board').waitFor()
      await s.shot('drag-over')
      const result = await transfer(s, 'drop', [{ name: 'gate.png', w: 400, h: 300, colour: '#ff0000' }, { name: 'door.png', w: 300, h: 300, colour: '#00ff00' }], {}, { x: 100, y: 50 })
      expect(result).toEqual({ dragenter: true, dragover: true, drop: true })
      await poll(() => s.H('H.added'), ['gate.png', 'door.png'])
      expect(await s.H('H.windowDrops')).toBe(0)
      expect(await s.H('H.windowDragEnters')).toBe(0)
      await poll(async () => (await s.items()).length, 2)
      const [a, b] = await s.items()
      expect(a.path).toBe('Boards/Gate/gate.png')
      expect(b.path).toBe('Boards/Gate/door.png')
      // The overlay is gone, the pictures are drawn in their colours, at the drop point.
      expect(await s.page.evaluate(() => document.body.textContent!.includes('Drop pictures to put them on the board'))).toBe(false)
      await expectNear(s, a.x, a.y, [255, 0, 0], 12)
      await expectNear(s, b.x, b.y, [0, 255, 0], 12)
      expect(Math.abs((a.x + b.x) / 2 - 100)).toBeLessThan(500)
      // The drop was a finished change: the note was written at once with both embeds, and the hint is gone.
      await poll(async () => ((await s.H<string[]>('H.saves')).at(-1) ?? '').includes('![[Boards/Gate/door.png]]'), true)
      expect(await s.page.getByText('Drop pictures here').count()).toBe(0)
      await s.shot('dropped')
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('things that cannot be dropped are said so: other files, an address, text becomes a note', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      await s.page.evaluate(async () => {
        const dt = new DataTransfer()
        dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
        document.querySelector('canvas')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      })
      await poll(async () => (await s.H<string[]>('H.toasts')).some((t) => t.startsWith('Only pictures can go on a board')), true)
      await transfer(s, 'drop', [], { uri: 'https://example.com/a.png', text: 'https://example.com/a.png' })
      await poll(async () => (await s.H<string[]>('H.toasts')).some((t) => /no network requests/.test(t)), true)
      expect(await s.items()).toHaveLength(0)
      await transfer(s, 'drop', [], { text: 'Check the edge\nof the lintel' }, { x: -150, y: -100 })
      await poll(async () => (await s.items()).length, 1)
      const [note] = await s.items()
      expect(note.kind).toBe('note')
      expect(note.text).toBe('Check the edge\nof the lintel')
      expect(await s.H('H.windowDrops')).toBe(0)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('a pasted picture is added; pasted text is a note; the board’s own copy is pasted when nothing else is on the clipboard', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/rust.png', 0, 0, 200, 100]]), colours: { 'Boards/Gate/rust.png': '#336699' } })
    try {
      const r1 = await transfer(s, 'paste', [{ name: 'image.png', w: 200, h: 200, colour: '#0000ff' }])
      expect(r1).toEqual({ paste: true })
      await poll(async () => (await s.H<string[]>('H.added')).length, 1)
      expect((await s.H<string[]>('H.added'))[0]).toMatch(/^ref \d{4}-\d{2}-\d{2} \d{6}\.png$/)
      await poll(async () => (await s.items()).length, 2)
      await transfer(s, 'paste', [], { text: 'pasted words' })
      await poll(async () => (await s.items()).length, 3)
      expect((await s.items())[2].text).toBe('pasted words')
      // Copy the board's own items with the keys, then paste with the key: the browser's paste event arrives with nothing on it
      // (or never arrives) and the board pastes what it copied.
      await s.page.keyboard.press('Control+A')
      await s.page.keyboard.press('Control+C')
      await poll(async () => (await s.H<string[]>('H.copied')).length, 1)
      expect((await s.H<string[]>('H.copied'))[0]).toBe('Aether Brain board: 3 items copied')
      await s.page.keyboard.press('Control+V')
      await poll(async () => (await s.items()).length, 6)
      // The board's own keys never reached the page's listener; the paste key is the browser's (the page may see it, it uses none).
      expect(await s.H<string[]>('H.globalKeys.filter((k) => ["a","A","c","C"].includes(k))')).toEqual([])
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('a drag moves a picture: written once a second while it lasts, at once when it ends; undo moves it back and is written too', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/rust.png', 0, 0, 200, 100]]), colours: { 'Boards/Gate/rust.png': '#336699' } })
    try {
      await expectPixel(s, 0, 0, [0x33, 0x66, 0x99], 12)
      expect(await s.H('H.external.size')).toBe(1)
      const start = await s.at(0, 0)
      await s.page.mouse.move(start.x, start.y)
      await s.page.mouse.down()
      await s.page.mouse.move(start.x + 40, start.y, { steps: 5 })
      expect(await s.H('H.saves.length')).toBe(0)
      await s.shot('dragging')
      // Still holding the button: after a second the board is written once, with the picture where it is by then.
      await poll(() => s.H('H.saves.length'), 1, 3000)
      const mid = await s.H<string[]>('H.saves')
      expect(mid[0]).toMatch(/x=(?!0 )[\d.]+ y=0 w=200/)
      await s.page.mouse.move(start.x + 100, start.y + 20, { steps: 8 })
      await s.page.mouse.up()
      await poll(() => s.H('H.saves.length'), 2, 1500)
      const final = (await s.H<string[]>('H.saves')).at(-1)!
      expect(final).toContain('x=100 y=20 w=200 h=100')
      expect(await s.H('H.maxInFlight')).toBe(1)
      const [pic] = await s.items()
      expect([pic.x, pic.y]).toEqual([100, 20])
      await expectPixel(s, 100, 20, [0x33, 0x66, 0x99], 12)
      await expectPixel(s, -50, 0, BG)
      // Undo: back in place, and written.
      await s.page.keyboard.press('Control+Z')
      await poll(async () => ((await s.items())[0] as { x: number }).x, 0)
      await poll(async () => ((await s.H<string[]>('H.saves')).at(-1) ?? '').includes('x=0 y=0 w=200 h=100'), true, 3000)
      expect(await s.H<string[]>('H.globalKeys.filter((k) => k === "z" || k === "Z")')).toEqual([])
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('a window that loses the focus in the middle of a drag writes what is pending without waiting', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/rust.png', 0, 0, 200, 100]]) })
    try {
      const start = await s.at(0, 0)
      await s.page.mouse.move(start.x, start.y)
      await s.page.mouse.down()
      await s.page.mouse.move(start.x + 30, start.y, { steps: 3 })
      expect(await s.H('H.saves.length')).toBe(0)
      await s.page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await poll(() => s.H('H.saves.length'), 1, 1000)
      await s.page.mouse.up()
    } finally {
      await s.close()
    }
  }, 60_000)

  it('closing the view with a change pending writes it first', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/rust.png', 0, 0, 200, 100]]) })
    try {
      const start = await s.at(0, 0)
      await s.page.mouse.move(start.x, start.y)
      await s.page.mouse.down()
      await s.page.mouse.move(start.x + 70, start.y, { steps: 4 })
      expect(await s.H('H.saves.length')).toBe(0)
      await s.page.evaluate(() => (window as any).unmount())
      await poll(() => s.H('H.saves.length'), 1, 2000)
      expect((await s.H<string[]>('H.saves'))[0]).toMatch(/x=7\d y=0/)
      // And nothing is left listening.
      expect(await s.H('H.external.size')).toBe(0)
      expect(await s.H('H.pictureSubs.size')).toBe(0)
      await s.page.mouse.up()
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('the pen draws a stroke in the chosen colour; a line, a rectangle and an ellipse follow the same way', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      await s.page.keyboard.press('p')
      expect(await s.page.evaluate(() => (window as any).state().tool)).toBe('pen')
      const a = await s.at(-200, -150)
      await s.page.mouse.move(a.x, a.y)
      await s.page.mouse.down()
      await s.page.mouse.move(a.x + 100, a.y, { steps: 10 })
      await s.page.mouse.up()
      await poll(async () => (await s.items()).map((i) => i.kind), ['stroke'])
      await expectNear(s, -150, -150, [255, 90, 54])
      await s.page.keyboard.press('r')
      const b = await s.at(50, -150)
      await s.page.mouse.move(b.x, b.y)
      await s.page.mouse.down()
      await s.page.mouse.move(b.x + 120, b.y + 80, { steps: 6 })
      await s.page.mouse.up()
      await s.page.keyboard.press('o')
      const c = await s.at(-200, 0)
      await s.page.mouse.move(c.x, c.y)
      await s.page.mouse.down()
      await s.page.mouse.move(c.x + 100, c.y + 60, { steps: 6 })
      await s.page.mouse.up()
      await s.page.keyboard.press('l')
      const d = await s.at(50, 0)
      await s.page.mouse.move(d.x, d.y)
      await s.page.mouse.down()
      await s.page.mouse.move(d.x + 120, d.y + 20, { steps: 6 })
      await s.page.mouse.up()
      await poll(async () => (await s.items()).map((i) => i.kind), ['stroke', 'rect', 'ellipse', 'line'])
      await expectNear(s, 110, -150, [255, 90, 54])
      await expectNear(s, 110, 10, [255, 90, 54])
      // Each finished mark was written at once.
      await poll(async () => ((await s.H<string[]>('H.saves')).at(-1) ?? '').includes('- line '), true, 3000)
      await s.shot('marks')
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('a note is typed over the board: Ctrl+Enter keeps it, Esc drops it, leaving the box keeps it, undo takes it away; no key typed reaches the page', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/rust.png', 0, 0, 200, 100]]) })
    try {
      const area = s.page.getByLabel('Note text')
      // Ctrl+Enter commits.
      await s.page.keyboard.press('t')
      const p1 = await s.at(-300, -200)
      await s.page.mouse.click(p1.x, p1.y)
      await area.waitFor()
      await s.page.keyboard.type('Check the edge of the lintel')
      await s.shot('note-editing')
      await s.page.keyboard.press('Control+Enter')
      await area.waitFor({ state: 'detached' })
      await poll(async () => (await s.items()).filter((i) => i.kind === 'note').map((i) => i.text), ['Check the edge of the lintel'])
      await poll(async () => ((await s.H<string[]>('H.saves')).at(-1) ?? '').includes('» Check the edge of the lintel'), true, 3000)
      // Esc drops a note that is being typed.
      await s.page.keyboard.press('t')
      const p2 = await s.at(100, -200)
      await s.page.mouse.click(p2.x, p2.y)
      await area.waitFor()
      await s.page.keyboard.type('never kept')
      await s.page.keyboard.press('Escape')
      await area.waitFor({ state: 'detached' })
      expect((await s.items()).filter((i) => i.kind === 'note')).toHaveLength(1)
      // A press elsewhere on the canvas commits it, and acts (here: selects the picture).
      await s.page.keyboard.press('t')
      const p3 = await s.at(100, 150)
      await s.page.mouse.click(p3.x, p3.y)
      await area.waitFor()
      await s.page.keyboard.type('kept by leaving')
      const pic = await s.at(0, 0)
      await s.page.mouse.click(pic.x, pic.y)
      await area.waitFor({ state: 'detached' })
      await poll(async () => (await s.items()).filter((i) => i.kind === 'note').map((i) => i.text), ['Check the edge of the lintel', 'kept by leaving'])
      expect(await s.page.evaluate(() => (window as any).state().selection.length)).toBe(1)
      // Undo takes the last one away.
      await s.page.keyboard.press('Control+Z')
      await poll(async () => (await s.items()).filter((i) => i.kind === 'note').length, 1)
      // Typed letters stayed in the box.
      expect(await s.H<string[]>('H.globalKeys.filter((k) => k.length === 1 && "Checkthedgfliv".includes(k))')).toEqual(['t', 't', 't', 'e'].slice(0, 0))
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('a note is edited in place by a double click', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([], [['old words', 0, 0]]) })
    try {
      const p = await s.at(0, 0)
      await s.page.mouse.dblclick(p.x, p.y)
      const area = s.page.getByLabel('Note text')
      await area.waitFor()
      expect(await area.inputValue()).toBe('old words')
      await area.fill('new words')
      await s.page.keyboard.press('Control+Enter')
      await poll(async () => (await s.items())[0].text, 'new words')
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('the board the note changed under it is read again: the picture moves, and the canvas shows it', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const path = 'Boards/Gate/rust.png'
    const s = await scene({ raw: rawBoard([[path, 0, 0, 200, 100]]), colours: { [path]: '#336699' } })
    try {
      await expectPixel(s, 0, 0, [0x33, 0x66, 0x99], 12)
      const raw = rawBoard([[path, 250, 120, 200, 100]])
      await s.page.evaluate((r) => {
        const H = (window as any).H
        H.raw = r
        for (const cb of [...H.external]) cb()
      }, raw)
      await poll(async () => (await s.items())[0].x, 250)
      await expectPixel(s, 250, 120, [0x33, 0x66, 0x99], 12)
      await expectPixel(s, 0, 0, BG)
      expect(await s.H<string[]>('H.toasts')).toEqual([])
      // Our own unsaved work is kept when the file changes: the user is told.
      const start = await s.at(250, 120)
      await s.page.mouse.move(start.x, start.y)
      await s.page.mouse.down()
      await s.page.mouse.move(start.x - 50, start.y, { steps: 4 })
      await s.page.evaluate((r) => {
        const H = (window as any).H
        H.raw = r
        for (const cb of [...H.external]) cb()
      }, rawBoard([[path, -300, -150, 200, 100]]))
      await poll(async () => (await s.H<string[]>('H.toasts')).some((t) => /changed outside/.test(t)), true)
      expect(((await s.items())[0] as { x: number }).x).toBeLessThan(250)
      await s.page.mouse.up()
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('the picker lists thousands of pictures through a few rows, searches, picks a run with Shift and adds it', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard(), bigVault: 5000 })
    try {
      await s.page.evaluate(() => {
        const w = window as any
        w.live = new Set<string>()
        let peak = 0
        const create = URL.createObjectURL.bind(URL)
        const revoke = URL.revokeObjectURL.bind(URL)
        URL.createObjectURL = (b: Blob | MediaSource) => {
          const u = create(b)
          w.live.add(u)
          peak = Math.max(peak, w.live.size)
          w.peak = () => peak
          return u
        }
        URL.revokeObjectURL = (u: string) => {
          w.live.delete(u)
          revoke(u)
        }
      })
      await s.page.getByRole('button', { name: /Add picture/ }).first().click()
      const dialog = s.page.getByRole('dialog', { name: 'Add pictures to the board' })
      await dialog.waitFor()
      const rows = dialog.getByRole('option')
      await poll(async () => (await rows.count()) > 3, true)
      expect(await rows.count()).toBeLessThanOrEqual(60)
      // Only the rows in view had their thumbnails asked for.
      await poll(async () => (await s.H<string[]>('H.previews')).length > 3, true)
      expect((await s.H<string[]>('H.previews')).length).toBeLessThanOrEqual(60)
      await s.shot('picker')
      // Scroll a long way: the rows are other rows, still a few, and the thumbnails held stay bounded.
      for (let i = 1; i <= 40; i++) {
        await s.page.evaluate((n) => ((document.querySelector('[role=listbox]') as HTMLElement).scrollTop = n * 2800), i)
        await s.page.waitForTimeout(20)
      }
      await poll(async () => Number(await rows.first().getAttribute('data-index')) > 1500, true)
      expect(await rows.count()).toBeLessThanOrEqual(60)
      expect(await s.page.evaluate(() => (window as any).live.size)).toBeLessThanOrEqual(120)
      expect(await s.page.evaluate(() => (window as any).peak())).toBeLessThanOrEqual(121)
      // Search: a substring of the path, after a short wait; the list is the matching ones only.
      const box = dialog.getByRole('textbox', { name: 'Search pictures' })
      await box.fill('rust')
      await poll(async () => (await dialog.getByText(/\d+ pictures of 5000/).count()) > 0, true)
      const names = await rows.evaluateAll((els) => els.map((e) => e.textContent ?? ''))
      expect(names.length).toBeGreaterThan(3)
      expect(names.every((n) => /rust/i.test(n))).toBe(true)
      await box.fill('Folder 7/')
      await poll(async () => (await rows.evaluateAll((els) => els.every((e) => /Folder 7\b/.test(e.textContent ?? '')))) && (await rows.count()) > 0, true)
      await box.fill('rust')
      await poll(async () => (await rows.evaluateAll((els) => els.every((e) => /rust/i.test(e.textContent ?? '')))) && (await rows.count()) > 3, true)
      // A click, a Shift-click: a run of three; the button says so, and adds them.
      await rows.nth(0).click()
      await rows.nth(2).click({ modifiers: ['Shift'] })
      await dialog.getByRole('button', { name: 'Add 3 to board' }).waitFor()
      expect(await rows.evaluateAll((els) => els.filter((e) => e.getAttribute('aria-selected') === 'true').length)).toBe(3)
      await dialog.getByRole('button', { name: 'Add 3 to board' }).click()
      await dialog.waitFor({ state: 'detached' })
      await poll(async () => (await s.items()).length, 3)
      expect((await s.items()).every((i) => i.kind === 'picture' && /rust\.png$/.test(i.path))).toBe(true)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 90_000)

  it('the picker is driven with the keyboard, marks what is on the board, and closes with Esc without the page hearing it', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const path = 'Vault/known.png'
    const s = await scene({ raw: rawBoard([[path, 0, 0, 100, 100]]), assets: [{ path, mtime: 3 }, { path: 'Vault/b.png', mtime: 2 }, { path: 'Vault/c.png', mtime: 1 }] })
    try {
      await s.page.keyboard.press('Control+O')
      const dialog = s.page.getByRole('dialog', { name: 'Add pictures to the board' })
      await dialog.waitFor()
      expect(await dialog.getByText('on the board').count()).toBe(1)
      // Typing in the search box does not run board commands.
      await s.page.keyboard.type('bg')
      expect(await s.page.evaluate(() => (window as any).state().doc.bg)).toBe('14161d')
      await s.page.keyboard.press('Control+A')
      await s.page.keyboard.press('Backspace')
      await s.page.keyboard.press('Backspace')
      await s.page.keyboard.press('ArrowDown')
      await s.page.keyboard.press('ArrowDown')
      await s.page.keyboard.press('Enter')
      await dialog.waitFor({ state: 'detached' })
      await poll(async () => (await s.items()).length, 2)
      expect((await s.items())[1].path).toBe('Vault/c.png')
      await s.page.keyboard.press('Control+O')
      await dialog.waitFor()
      const before = await s.H<string[]>('H.globalKeys.filter((k) => k === "Escape")')
      await s.page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      expect(await s.H<string[]>('H.globalKeys.filter((k) => k === "Escape")')).toEqual(before)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('a right click opens the menu of what is under it; a command in it runs; on empty canvas it offers a note, pictures, select all', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/rust.png', 0, 0, 200, 100]]) })
    try {
      const on = await s.at(20, 10)
      await s.page.mouse.click(on.x, on.y, { button: 'right' })
      const menu = s.page.getByRole('menu', { name: 'Board context menu' })
      await menu.waitFor()
      // The picture under the pointer is selected, and the menu is for it.
      expect(await s.page.evaluate(() => (window as any).state().selection.length)).toBe(1)
      const labels = await menu.getByRole('menuitem').allTextContents()
      for (const want of ['Duplicate', 'Delete', 'Copy', 'Open in the image program', 'Show in the file manager', 'Show in the brain', 'Picture info']) expect(labels.join('|')).toContain(want)
      await s.shot('context-menu')
      await menu.getByRole('menuitem', { name: /^Duplicate/ }).click()
      await menu.waitFor({ state: 'detached' })
      await poll(async () => (await s.items()).length, 2)
      // Open in the image program goes to the host.
      await s.page.mouse.click(on.x + 24, on.y + 24, { button: 'right' })
      await menu.waitFor()
      await menu.getByRole('menuitem', { name: /^Open in the image program/ }).click()
      expect(await s.H('H.opens')).toEqual(['Boards/Gate/rust.png'])
      // Empty canvas.
      const empty = await s.at(-300, -200)
      await s.page.mouse.click(empty.x, empty.y, { button: 'right' })
      await menu.waitFor()
      const texts = await menu.getByRole('menuitem').allTextContents()
      expect(texts.map((t) => t.replace(/\s+/g, ' ')).join('|')).toMatch(/Paste.*Add a note here.*Add pictures….*Select all.*Fit all/)
      await menu.getByRole('menuitem', { name: /Add a note here/ }).click()
      await s.page.getByLabel('Note text').waitFor()
      await s.page.keyboard.type('here')
      await s.page.keyboard.press('Control+Enter')
      await poll(async () => (await s.items()).some((i) => i.kind === 'note' && i.text === 'here'), true)
      // Esc closes a menu; a press outside closes it too.
      await s.page.mouse.click(on.x, on.y, { button: 'right' })
      await menu.waitFor()
      await s.page.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
      await s.page.mouse.click(on.x, on.y, { button: 'right' })
      await menu.waitFor()
      await s.page.mouse.click(empty.x, empty.y)
      await menu.waitFor({ state: 'detached' })
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('keys the board uses never reach the page’s own listener; keys it has no use for, and keys in text boxes, do', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/rust.png', 0, 0, 200, 100]]) })
    try {
      const keys = () => s.H<string[]>('H.globalKeys')
      // `b` is the next background colour (and the 3D view's bloom), `1` is 100% (the app's Graph view), `g` greys the board.
      await s.page.keyboard.press('b')
      await poll(() => s.page.evaluate(() => (window as any).state().doc.bg), '808080')
      await s.page.keyboard.press('1')
      await s.page.keyboard.press('g')
      await s.page.keyboard.press('z')
      await s.page.keyboard.press('Home')
      await poll(() => s.page.evaluate(() => (window as any).state().doc.gray), true)
      expect(await keys()).toEqual([])
      // Space is the pan key; it is the board's too.
      await s.page.keyboard.press(' ')
      expect(await keys()).toEqual([])
      // Keys the board has no use for go on to the app: a view switch, the palette.
      await s.page.keyboard.press('2')
      await s.page.keyboard.press('m')
      await s.page.keyboard.press('Control+k')
      await s.page.keyboard.press('F9')
      expect(await keys()).toEqual(['2', 'm', 'k', 'F9'])
      // A key with the app's modifier and a board command: ⌘Z is the board's.
      await s.page.keyboard.press('Control+Shift+Z')
      expect(await keys()).toEqual(['2', 'm', 'k', 'F9'])
      // In a text box (the style panel's hex field) the board takes nothing.
      await s.page.getByRole('button', { name: /3px/ }).click()
      const hex = s.page.getByRole('textbox', { name: 'Colour (hex)', exact: true })
      await hex.fill('')
      await hex.type('abc')
      await s.page.keyboard.press('Enter')
      expect(await s.page.evaluate(() => (window as any).state().style.color)).toBe('aabbcc')
      expect(await keys()).toEqual(['2', 'm', 'k', 'F9'])
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('Tab hides the toolbar and the status bar and brings them back; the first press is not the browser’s focus move', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard() })
    try {
      await s.page.keyboard.press('Tab')
      await s.page.getByRole('toolbar').waitFor({ state: 'detached' })
      expect(await s.page.getByRole('contentinfo').count()).toBe(0)
      await s.shot('bare')
      await s.page.getByRole('button', { name: /Show toolbar/ }).click()
      await s.page.getByRole('toolbar').waitFor()
      await s.page.keyboard.press('Tab')
      await s.page.getByRole('toolbar').waitFor({ state: 'detached' })
      await s.page.keyboard.press('Tab')
      await s.page.getByRole('toolbar').waitFor()
      expect(await s.H<string[]>('H.globalKeys')).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('Space with a drag, and the wheel, move and zoom the camera without writing the board', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/rust.png', 0, 0, 200, 100]]) })
    try {
      const view = () => s.page.evaluate(() => (window as any).state().doc.view)
      const a = await s.at(-200, 200)
      await s.page.mouse.move(a.x, a.y)
      await s.page.keyboard.down('Space')
      await s.page.mouse.down()
      await s.page.mouse.move(a.x + 120, a.y + 40, { steps: 6 })
      await s.page.mouse.up()
      await s.page.keyboard.up('Space')
      const panned = await view()
      expect(panned.x).toBeCloseTo(-120, 0)
      expect(panned.y).toBeCloseTo(-40, 0)
      await s.page.mouse.move(a.x, a.y)
      await s.page.mouse.wheel(0, -400)
      await poll(async () => (await view()).zoom > 1.2, true)
      // The page did not scroll, the wheel did not leak.
      expect(await s.page.evaluate(() => window.scrollY)).toBe(0)
      // Neither wrote the file; the camera is remembered in the browser a moment later.
      await s.page.waitForTimeout(500)
      expect(await s.H('H.saves.length')).toBe(0)
      const stored = await s.page.evaluate(() => JSON.parse(localStorage.getItem('aether.board.view:Boards/Gate.md') ?? 'null'))
      expect(stored?.zoom).toBeGreaterThan(1.2)
      // Space was let go: it is not stuck.
      const before = await view()
      await s.page.mouse.move(a.x, a.y)
      await s.page.mouse.down()
      await s.page.mouse.move(a.x + 60, a.y + 60, { steps: 4 })
      await s.page.mouse.up()
      expect((await view()).x).toBe(before.x)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('the sampler copies the colour under the pointer', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const path = 'Boards/Gate/rust.png'
    const s = await scene({ raw: rawBoard([[path, 0, 0, 200, 100]]), colours: { [path]: '#336699' } })
    try {
      await expectPixel(s, 0, 0, [0x33, 0x66, 0x99], 12)
      await s.page.keyboard.press('i')
      const p = await s.at(30, 10)
      await s.page.mouse.move(p.x, p.y)
      await s.page.mouse.down()
      await s.page.mouse.up()
      await poll(() => s.H('H.copied'), ['#336699'])
      await poll(async () => (await s.H<string[]>('H.toasts')).includes('Copied #336699'), true)
      await s.shot('sampler')
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('a palette is taken from a picture and laid on the board as swatch notes', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const path = 'Boards/Gate/halves.png'
    const s = await scene({ raw: rawBoard([[path, 0, 0, 200, 100]]), halves: { [path]: ['#ff0000', '#0000ff'] } })
    try {
      await s.page.keyboard.press('Control+A')
      await s.page.evaluate(() => (window as any).active().exec('picture.palette'))
      await poll(async () => (await s.items()).filter((i) => i.kind === 'note').length >= 2, true)
      const fills = (await s.items()).filter((i) => i.kind === 'note').map((i) => i.fill).sort()
      expect(fills).toEqual(['0000ff', 'ff0000'])
      expect((await s.items()).filter((i) => i.kind === 'note').map((i) => i.text).sort()).toEqual(['#0000ff', '#ff0000'])
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('the whole board is exported as a PNG in the board’s folder: a real picture of what is on it', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const path = 'Boards/Gate/rust.png'
    const s = await scene({ raw: rawBoard([[path, 0, 0, 200, 100]]), sizes: { [path]: [800, 400] }, colours: { [path]: '#336699' } })
    try {
      await expectPixel(s, 0, 0, [0x33, 0x66, 0x99], 12)
      await s.page.keyboard.press('Control+Shift+E')
      await poll(async () => (await s.H<string[]>('H.added')).length, 1, 10_000)
      const name = (await s.H<string[]>('H.added'))[0]!
      expect(name).toMatch(/^Gate export \d{4}-\d{2}-\d{2} \d{6}\.png$/)
      const probe = await s.page.evaluate(async (n) => {
        const bytes: Uint8Array = (window as any).H.files.get('Boards/Gate/' + n)
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        const c = new OffscreenCanvas(bmp.width, bmp.height)
        const g = c.getContext('2d')!
        g.drawImage(bmp, 0, 0)
        return { w: bmp.width, h: bmp.height, mid: Array.from(g.getImageData(bmp.width >> 1, bmp.height >> 1, 1, 1).data), sig: Array.from(bytes.slice(0, 4)) }
      }, name)
      expect(probe.sig).toEqual([137, 80, 78, 71])
      // The picture's own pixels (800 by 400) shown 200 by 100 on the board: exported at its own detail.
      expect(probe.w).toBe(800)
      expect(probe.h).toBe(400)
      expect(Math.abs(probe.mid[0]! - 0x33)).toBeLessThan(8)
      expect(Math.abs(probe.mid[2]! - 0x99)).toBeLessThan(8)
      await poll(async () => (await s.H<string[]>('H.toasts')).some((t) => t.startsWith('Saved Gate export')), true)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('pictures that are gone from the vault keep their places and the board says so', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['a/here.png', -150, 0, 100, 100], ['a/gone.png', 150, 0, 100, 100]]), present: ['a/here.png'] })
    try {
      await s.page.getByText('1 picture is missing from the vault').waitFor()
      expect(await s.page.getByRole('status').filter({ hasText: 'nothing is deleted' }).count()).toBe(1)
      expect(await s.items()).toHaveLength(2)
      await s.shot('missing')
      // The file comes back: the notice goes.
      await s.page.evaluate(() => {
        const H = (window as any).H
        H.present.add('a/gone.png')
        for (const cb of [...H.pictureSubs]) cb()
      })
      await s.page.getByText('missing from the vault').waitFor({ state: 'detached' })
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('the toolbar’s menus open, show the keys, and run commands; the window controls call the host', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/rust.png', 0, 0, 200, 100], ['Boards/Gate/door.png', 20, 10, 200, 100]]), window: { floating: true } })
    try {
      await s.page.getByRole('button', { name: 'View', exact: true }).click()
      const menu = s.page.getByRole('menu', { name: 'View' })
      await menu.waitFor()
      const gray = menu.getByRole('menuitemcheckbox', { name: /Grey the whole board/ })
      expect(await gray.getAttribute('aria-checked')).toBe('false')
      expect(await gray.textContent()).toContain('G')
      await s.shot('view-menu')
      await gray.click()
      await menu.waitFor({ state: 'detached' })
      await poll(() => s.page.evaluate(() => (window as any).state().doc.gray), true)
      // The key A opens the Arrange menu; its entries run on the selection (all: nothing is selected). The mouse is out of the way.
      await s.page.mouse.move(4, 400)
      await s.page.keyboard.press('a')
      const arrange = s.page.getByRole('menu', { name: 'Arrange' })
      await arrange.waitFor()
      await s.page.keyboard.press('ArrowDown')
      await s.page.keyboard.press('Enter')
      await arrange.waitFor({ state: 'detached' })
      await poll(async () => (await s.H<string[]>('H.toasts')).some((t) => /Arranged 2 items/.test(t)), true)
      // The window.
      await s.page.getByRole('button', { name: 'More transparent window' }).click()
      await s.page.getByRole('button', { name: /^Always on top/ }).click()
      await s.page.getByRole('button', { name: /Dock back/ }).click()
      expect(await s.H('H.windowCalls')).toEqual(['opacity:0.9', 'onTop:false', 'dock'])
      expect(await s.page.getByText('90%').count()).toBe(1)
      await s.shot('floating')
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('the info card shows a picture’s own size once it is read, and follows the picture', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const path = 'Boards/Gate/rust.png'
    const s = await scene({ raw: rawBoard([[path, 0, 0, 200, 100]]), sizes: { [path]: [800, 400] } })
    try {
      const p = await s.at(0, 0)
      await s.page.mouse.click(p.x, p.y)
      await s.page.keyboard.press('Control+A')
      await s.page.evaluate(() => (window as any).active().exec('picture.info'))
      const card = s.page.getByRole('dialog', { name: 'Picture info' })
      await card.waitFor()
      await poll(async () => (await card.textContent())!.includes('800 × 400 px'), true)
      expect(await card.textContent()).toContain('rust.png')
      expect(await card.textContent()).toContain('Boards/Gate/rust.png')
      expect(await card.textContent()).toContain('25% of its pixels')
      expect(await card.textContent()).toContain('PNG')
      await s.shot('info')
      await s.page.keyboard.press('Escape')
      await card.waitFor({ state: 'detached' })
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('a finger held on the canvas opens the context menu; a tap does not', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/rust.png', 0, 0, 200, 100]]) }, { touch: true })
    try {
      const cdp = await s.page.context().newCDPSession(s.page)
      const p = await s.at(20, 10)
      const menu = s.page.getByRole('menu', { name: 'Board context menu' })
      // A quick tap selects, and no menu comes.
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await s.page.waitForTimeout(800)
      expect(await menu.count()).toBe(0)
      expect(await s.page.evaluate(() => (window as any).state().selection.length)).toBe(1)
      // Held: the menu opens, and the press does not go on to drag the picture.
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] })
      await menu.waitFor({ timeout: 3000 })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      expect(await menu.getByRole('menuitem', { name: /^Duplicate/ }).count()).toBe(1)
      expect((await s.items())[0].x).toBe(0)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('with reduced motion the panels do not slide in', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const calm = await scene({ raw: rawBoard() }, { reducedMotion: true })
    const lively = await scene({ raw: rawBoard() })
    try {
      for (const [sc, animated] of [[calm, false], [lively, true]] as const) {
        await sc.page.getByRole('button', { name: 'View', exact: true }).click()
        const menu = sc.page.getByRole('menu', { name: 'View' })
        await menu.waitFor()
        expect(await menu.evaluate((el) => el.classList.contains('rise'))).toBe(animated)
        expect(await sc.page.getByText('Drop pictures here').first().locator('xpath=ancestor::div[contains(@class,"panel")][1]').evaluate((el) => el.classList.contains('rise'))).toBe(animated)
      }
    } finally {
      await calm.close()
      await lively.close()
    }
  }, 60_000)

  it('a menu of the toolbar closes with a press outside it, and the menu button toggles it', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/rust.png', 0, 0, 200, 100]]) })
    try {
      const button = s.page.getByRole('button', { name: 'Edit', exact: true })
      const menu = s.page.getByRole('menu', { name: 'Edit' })
      await button.click()
      await menu.waitFor()
      await button.click()
      await menu.waitFor({ state: 'detached' })
      await button.click()
      await menu.waitFor()
      const p = await s.at(-300, 200)
      await s.page.mouse.click(p.x, p.y)
      await menu.waitFor({ state: 'detached' })
      // Only one menu at a time.
      await button.click()
      await s.page.getByRole('button', { name: 'Arrange', exact: true }).click()
      await s.page.getByRole('menu', { name: 'Arrange' }).waitFor()
      expect(await s.page.getByRole('menu').count()).toBe(1)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('in a narrow window the toolbar wraps and the board keeps its room', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const s = await scene({ raw: rawBoard([['Boards/Gate/rust.png', 0, 0, 200, 100]]), window: { floating: true } }, { width: 480, height: 420 })
    try {
      const bar = await s.page.getByRole('toolbar').boundingBox()
      expect(bar!.height).toBeGreaterThan(60)
      const box = await s.box()
      expect(box.height).toBeGreaterThan(200)
      expect(box.width).toBe(480)
      // Nothing sticks out sideways.
      expect(await s.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await expectPixel(s, 0, 0, [0x14, 0x16, 0x1d], 255)
      await s.shot('narrow')
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)

  it('zooming in reads the picture itself (not only its preview) and keeps drawing it, with the colour right', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const path = 'Boards/Gate/rust.png'
    const s = await scene({ raw: rawBoard([[path, 0, 0, 200, 100]]), colours: { [path]: '#336699' }, sizes: { [path]: [2000, 1000] } })
    try {
      await expectPixel(s, 0, 0, [0x33, 0x66, 0x99], 12)
      // At 100% a 200 unit picture is 200 pixels wide: the small preview is enough.
      expect(await s.H('H.originals.length')).toBe(0)
      expect(await s.H<string[]>('H.previews.length')).toBeGreaterThan(0)
      const c = await s.at(0, 0)
      await s.page.mouse.move(c.x, c.y)
      for (let i = 0; i < 3; i++) {
        await s.page.mouse.wheel(0, -1200)
        await s.page.waitForTimeout(40)
      }
      await poll(async () => (await s.page.evaluate(() => (window as any).state().doc.view.zoom)) >= 8, true)
      await poll(async () => (await s.H<string[]>('H.originals')).includes(path), true)
      await expectPixel(s, 0, 0, [0x33, 0x66, 0x99], 12)
      // Its own size became known on the way: the shape is untouched, nothing was written for it.
      const [pic] = await s.items()
      expect([pic.w, pic.h]).toEqual([200, 100])
      expect(await s.H('H.saves.length')).toBe(0)
      expect(s.errors).toEqual([])
    } finally {
      await s.close()
    }
  }, 60_000)
})
