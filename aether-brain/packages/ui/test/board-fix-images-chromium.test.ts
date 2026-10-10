import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright-core'

/**
 * Review fixes renderer-cache-1 and renderer-cache-4 in real Chromium (skipped without one): the real renderer, picture cache and
 * loader on a real canvas, with real 4000 x 3000 JPEGs and the engine's own `createImageBitmap`.
 * - The picture cache's budget (128 megapixels) bounds what is DECODED, counted by every bitmap made and not yet closed (not by the
 *   cache's books): 300 pictures piled on one centre at zoom 1, 40 at zoom 4, detail crops; no picture goes blank on the way; an
 *   ordinary 300-picture board still pans in a few milliseconds a frame.
 * - A grey board draws in milliseconds, not seconds (the filter is clipped to each picture), with the same edges to within a few
 *   levels (abutting turned pictures), on screen and in an export.
 * Before the fixes, measured the same way: 300 piled at zoom 1 held 235.9 megapixels, 40 piled at zoom 4 held 480, 20 detail crops 240;
 * 300 grey pictures took 1.6 s a frame on a 1200 x 800 canvas, 18.8 s to export at 4096.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const posix = (...p: string[]) => path.join(here, '..', ...p).replace(/\\/g, '/')
const BUDGET_MPX = 128

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
import * as R from '${posix('src', 'board', 'renderer.ts')}'
import { ImageCache } from '${posix('src', 'board', 'imageCache.ts')}'
import { createImageLoader } from '${posix('src', 'board', 'imageLoader.ts')}'
import * as C from '@aether/core'
;(window as unknown as { T: unknown }).T = { R, ImageCache, createImageLoader, C }
`

/** Page-side helpers (plain JavaScript). */
const PAGE = `
window.Z = (() => {
  const { R, ImageCache, createImageLoader, C } = window.T
  // Every ImageBitmap made and not yet closed, by pixels: the cache's own books are not trusted.
  let live = 0
  let peakLive = 0
  const realCreate = window.createImageBitmap.bind(window)
  window.createImageBitmap = async (...a) => {
    const b = await realCreate(...a)
    const px = b.width * b.height
    live += px
    peakLive = Math.max(peakLive, live)
    const close = b.close.bind(b)
    let closed = false
    b.close = () => {
      if (!closed) {
        closed = true
        live -= px
      }
      close()
    }
    return b
  }
  const jpeg = async (w, h) => {
    const c = new OffscreenCanvas(w, h)
    const g = c.getContext('2d')
    const grad = g.createLinearGradient(0, 0, w, h)
    grad.addColorStop(0, '#d33')
    grad.addColorStop(0.5, '#3d3')
    grad.addColorStop(1, '#33d')
    g.fillStyle = grad
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#fff'
    for (let i = 0; i < 40; i++) g.fillRect((i * 97) % w, (i * 61) % h, w / 50, h / 50)
    return c.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
  }
  const VP = { w: 1280, h: 800 }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const pic = (i, o) => ({ id: i + 1, group: 0, locked: false, kind: 'picture', path: 'p' + i + '.jpg', x: 0, y: 0, w: 448, h: 336, rotation: 0, crop: { l: 0, t: 0, r: 1, b: 1 }, flipH: false, flipV: false, gray: false, opacity: 1, caption: '', ...o })

  /** A board of n pictures of one 4000 x 3000 JPEG (and its two previews), a cache over them, and the frame loop of the session. */
  async function board(kind, n, zoom, share) {
    const original = await jpeg(4000, 3000)
    const previews = {}
    for (const t of [256, 1024]) previews[t] = await jpeg(t, Math.round((t * 3000) / 4000))
    const host = { preview: async (p, t) => previews[t], original: async () => original, exists: () => true }
    const cache = new ImageCache({ load: createImageLoader(host), onLoaded: () => {} })
    const items = []
    for (let i = 0; i < n; i++) {
      if (kind === 'pile') items.push(pic(i))
      else if (kind === 'fit') items.push(pic(i, { x: ((i % 20) - 9.5) * 110, y: (Math.floor(i / 20) - 7) * 85, w: 100, h: 75 }))
      else if (kind === 'crops') items.push(pic(i, { x: ((i % 5) - 2) * 130, y: (Math.floor(i / 5) - 2) * 100, w: 110 / share, h: 82 / share, crop: { l: 0.45, t: 0.45, r: 0.45 + share, b: 0.45 + share } }))
    }
    const doc = { ...C.emptyBoard('t'), bg: '14161d', items, nextId: 99999 }
    let view = { x: 0, y: 0, zoom }
    const canvas = document.createElement('canvas')
    canvas.width = VP.w
    canvas.height = VP.h
    const g = canvas.getContext('2d', { alpha: false })
    // The same calls to the cache, drawn into a 16 x 16 canvas (300 big overlapping pictures cost 0.7 s a frame in software raster).
    const tiny = document.createElement('canvas')
    tiny.width = tiny.height = 16
    const gt = tiny.getContext('2d')
    let blank = 0
    const frame = (full) => {
      const t0 = performance.now()
      cache.setVisible(R.visiblePictures(doc, view, VP, C.estimateTextMetrics))
      blank = 0
      const seen = new Set()
      R.drawBoard(full ? g : gt, {
        doc, view, viewport: VP, dpr: 1, state: R.EMPTY_DRAW_STATE, metrics: C.estimateTextMetrics,
        images: { get: (p, w, s) => { const r = cache.get(p, w, s); if (!r.bitmap && !seen.has(p)) { seen.add(p); blank++ } return r } },
      })
      return performance.now() - t0
    }
    const settle = async () => {
      let quiet = 0
      const t0 = performance.now()
      while (quiet < 10 && performance.now() - t0 < 60000) {
        frame(false)
        await sleep(15)
        const s = cache.stats()
        quiet = s.loading === 0 && s.queued === 0 ? quiet + 1 : 0
      }
    }
    const stats = () => ({ cacheMpx: cache.stats().pixels / 1e6, liveMpx: live / 1e6, peakLiveMpx: peakLive / 1e6, bitmaps: cache.stats().bitmaps, failed: cache.stats().failed })
    return {
      settle, stats,
      frame,
      setZoom: (z) => { view = { ...view, zoom: z } },
      blank: () => blank,
      /** Zooms through the given levels (a frame every 30 ms, 25 frames each) and reports the worst blank count and the peak. */
      async sweep(levels) {
        let worstBlank = 0
        for (const z of levels) {
          view = { ...view, zoom: z }
          for (let i = 0; i < 25; i++) {
            frame(false)
            worstBlank = Math.max(worstBlank, blank)
            await sleep(30)
          }
        }
        return worstBlank
      },
      async pan() {
        const times = []
        const x0 = view.x
        for (let i = 0; i < 30; i++) {
          view = { ...view, x: x0 + (i * 3) / view.zoom }
          times.push(frame(true))
          await sleep(4)
        }
        view = { ...view, x: x0 }
        times.sort((a, b) => a - b)
        return { p50: times[15], max: times[29] }
      },
      dispose: () => cache.dispose(),
    }
  }
  const boards = new Map()
  return {
    /**
     * A picture that cannot be shown, drawn as a missing file, a picture with too many pixels and an unreadable one (and, for contrast,
     * one still loading), and the same picture through the real loader and cache: a header that claims 30,000 x 30,000 pixels.
     */
    async placeholders() {
      const doc = { ...C.emptyBoard('t'), bg: '14161d', items: [pic(0, { x: 0, y: 0, w: 300, h: 200, path: 'Boards/x/huge.png' })], nextId: 99 }
      const draw = (get) => {
        const c = document.createElement('canvas')
        c.width = 400
        c.height = 300
        const g = c.getContext('2d', { willReadFrequently: true })
        R.drawBoard(g, { doc, view: { x: 0, y: 0, zoom: 1 }, viewport: { w: 400, h: 300 }, dpr: 1, state: R.EMPTY_DRAW_STATE, metrics: C.estimateTextMetrics, images: { get } })
        return g.getImageData(0, 0, 400, 300).data
      }
      const forced = (reason) => draw(() => ({ bitmap: null, natural: null, failed: true, reason }))
      const head = new Uint8Array(33)
      head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
      new DataView(head.buffer).setUint32(16, 30000)
      new DataView(head.buffer).setUint32(20, 30000)
      let decodes = 0
      const realCreate = window.createImageBitmap
      window.createImageBitmap = async (...a) => { decodes++; return realCreate(...a) }
      const host = { preview: async () => null, original: async () => new Blob([head]), exists: () => true }
      const cache = new ImageCache({ load: createImageLoader(host), onLoaded: () => {} })
      cache.setVisible(['Boards/x/huge.png'])
      cache.get('Boards/x/huge.png', 300, 300)
      await sleep(80)
      const slot = cache.get('Boards/x/huge.png', 300, 300)
      const real = draw((p, w, s) => cache.get(p, w, s))
      window.createImageBitmap = realCreate
      const missing = forced('missing')
      const large = forced('too-large')
      const unreadable = forced('unreadable')
      const loading = draw(() => ({ bitmap: null, natural: null, failed: false }))
      const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++; return n }
      cache.dispose()
      return {
        missingVsLarge: diff(missing, large), largeVsUnreadable: diff(large, unreadable), missingVsUnreadable: diff(missing, unreadable),
        loadingVsLarge: diff(loading, large), realVsLarge: diff(real, large), realVsMissing: diff(real, missing),
        reason: slot.reason, failed: slot.failed, natural: slot.natural, decodes,
      }
    },
    /** A lone arrow (0, 0) to (200, 0), 10 wide, exported at scale 2: the size, and the pixels in the head's wings. */
    async arrowExport() {
      const line = { id: 1, group: 0, locked: false, kind: 'line', x1: 0, y1: 0, x2: 200, y2: 0, color: 'ff0000', width: 10, arrow: true }
      const doc = { ...C.emptyBoard('t'), bg: '000000', items: [line], nextId: 99 }
      const r = await R.exportBoard(doc, null, 2, { get: async () => null }, (w, h) => new OffscreenCanvas(w, h), C.estimateTextMetrics, {})
      const g = r.canvas.getContext('2d')
      const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data)
      return { w: r.width, h: r.height, wingLow: px(345, 68), wingHigh: px(345, 12), shaft: px(110, 40), outside: px(340, 110) }
    },
    async open(name, kind, n, zoom, share) {
      boards.set(name, await board(kind, n, zoom, share))
    },
    call: async (name, fn, ...a) => boards.get(name)[fn](...a),
    // ---- grey ----
    grey: (() => {
      const bitmapOf = (w, h) => {
        const c = new OffscreenCanvas(w, h)
        const g = c.getContext('2d')
        const grad = g.createLinearGradient(0, 0, w, h)
        grad.addColorStop(0, '#f33')
        grad.addColorStop(1, '#33f')
        g.fillStyle = grad
        g.fillRect(0, 0, w, h)
        return createImageBitmap(c)
      }
      const draw = (g, doc, bmp, vp, dpr) =>
        R.drawBoard(g, { doc, view: { x: 0, y: 0, zoom: 1 }, viewport: vp, dpr, state: R.EMPTY_DRAW_STATE, metrics: C.estimateTextMetrics, images: { get: () => ({ bitmap: bmp, natural: null, failed: false }) } })
      return {
        /** 300 grey pictures, fit to a 1200 x 800 window: the time of one frame, grey and in colour. */
        async frameTimes() {
          const bmp = await bitmapOf(200, 150)
          const items = []
          for (let i = 0; i < 300; i++) items.push(pic(i, { x: ((i % 22) - 10.5) * 100, y: (Math.floor(i / 22) - 6.5) * 80, w: 80, h: 60, path: 'g' }))
          const time = (gray) => {
            const c = document.createElement('canvas')
            c.width = 1200
            c.height = 800
            const g = c.getContext('2d', { alpha: false })
            const doc = { ...C.emptyBoard('t'), gray, items, nextId: 99999 }
            const out = []
            for (let k = 0; k < 3; k++) {
              const t0 = performance.now()
              draw(g, doc, bmp, { w: 1200, h: 800 }, 1)
              g.getImageData(0, 0, 1, 1)
              out.push(performance.now() - t0)
            }
            return out.sort((a, b) => a - b)[1]
          }
          return { colour: time(false), grey: time(true) }
        },
        /** The export of the same grey board, 300 pictures at 2048 px. */
        async exportTime() {
          const bmp = await bitmapOf(200, 150)
          const items = []
          for (let i = 0; i < 300; i++) items.push(pic(i, { x: ((i % 22) - 10.5) * 100, y: (Math.floor(i / 22) - 6.5) * 80, w: 80, h: 60, path: 'g' }))
          const doc = { ...C.emptyBoard('t'), gray: true, items, nextId: 99999 }
          const t0 = performance.now()
          const r = await R.exportBoard(doc, null, 1, { get: async () => bmp, release: () => {} }, (w, h) => new OffscreenCanvas(w, h), C.estimateTextMetrics, { maxSide: 2048 })
          // An offscreen canvas only records its drawing: reading a pixel back makes it paint (as turning it into a PNG does).
          r.canvas.getContext('2d').getImageData(0, 0, 1, 1)
          return { ms: performance.now() - t0, w: r.width, h: r.height }
        },
        /**
         * Abutting grey pictures at fractional places, turned 0.4 rad, with the picture's clip (as drawn) and with no clip at all (the
         * clip call made a no-op): how many bytes differ and by how much.
         */
        async edges() {
          const bmp = await bitmapOf(120, 90)
          const items = [
            pic(0, { x: -30.3, y: 2.7, w: 100.6, h: 80.4, rotation: 22.9, gray: true, path: 'g' }),
            pic(1, { x: 70.9, y: 3.1, w: 100.6, h: 80.4, rotation: 22.9, gray: true, path: 'g' }),
            pic(2, { x: 20.2, y: 60.8, w: 100.6, h: 80.4, rotation: 0, gray: true, path: 'g', opacity: 0.6 }),
            pic(3, { x: -90.5, y: -70.5, w: 60, h: 40, rotation: 90, flipH: true, gray: true, path: 'g' }),
          ]
          const doc = { ...C.emptyBoard('t'), bg: '202020', items, nextId: 99999 }
          const render = (noClip) => {
            const c = document.createElement('canvas')
            c.width = 800
            c.height = 600
            const g = c.getContext('2d', { alpha: false, willReadFrequently: true })
            if (noClip) g.clip = () => {}
            draw(g, doc, bmp, { w: 400, h: 300 }, 2)
            return g.getImageData(0, 0, 800, 600).data
          }
          const a = render(false)
          const b = render(true)
          let differ = 0
          let max = 0
          for (let i = 0; i < a.length; i++) {
            const d = Math.abs(a[i] - b[i])
            if (d > 0) differ++
            if (d > max) max = d
          }
          return { differ, max, bytes: a.length }
        },
      }
    })(),
  }
})()
`

describe('the picture cache and the grey filter in Chromium', () => {
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
      console.warn('board images Chromium test skipped, Chromium does not start:', err)
      return
    }
    // A bundle that fails to build is a failure, not a skip: the test must not go quiet.
    const { build } = await import('vite')
    dir = mkdtempSync(path.join(os.tmpdir(), 'board-images-'))
    const entry = path.join(dir, 'entry.ts')
    writeFileSync(entry, ENTRY)
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      root: path.join(here, '..'),
      resolve: { alias: [{ find: /^@aether\/core$/, replacement: posix('..', 'core', 'src', 'index.ts') }] },
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'BoardImages', fileName: 'b' } },
    })
    const bundle = Array.isArray(out) ? out[0]! : out
    const chunk = 'output' in bundle ? bundle.output.find((o) => o.type === 'chunk') : undefined
    js = chunk && chunk.type === 'chunk' ? chunk.code : ''
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function pageWithBoard(): Promise<{ page: Page; errors: string[] }> {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.setContent('<!doctype html><title>images</title>')
    await page.addScriptTag({ content: js })
    await page.addScriptTag({ content: PAGE })
    return { page, errors }
  }

  interface Stats {
    cacheMpx: number
    liveMpx: number
    peakLiveMpx: number
    bitmaps: number
    failed: number
  }

  /** Opens a board, settles it, and reports the stats, the blanks of the last frame and (optionally) what a zoom sweep shows. */
  async function measure(page: Page, kind: string, n: number, zoom: number, share: number, sweep?: number[]) {
    return page.evaluate(
      async ([kind, n, zoom, share, sweep]) => {
        const Z = (window as unknown as { Z: { open(...a: unknown[]): Promise<void>; call(name: string, fn: string, ...a: unknown[]): Promise<any> } }).Z
        await Z.open('b', kind, n, zoom, share)
        await Z.call('b', 'settle')
        await Z.call('b', 'frame', false)
        const settled: Stats = await Z.call('b', 'stats')
        const blank: number = await Z.call('b', 'blank')
        let swept: { worstBlank: number; stats: Stats } | null = null
        if (sweep) {
          const worstBlank: number = await Z.call('b', 'sweep', sweep)
          await Z.call('b', 'settle')
          swept = { worstBlank, stats: await Z.call('b', 'stats') }
        }
        await Z.call('b', 'dispose')
        return { settled, blank, swept }
      },
      [kind, n, zoom, share, sweep ?? null] as [string, number, number, number, number[] | null],
    )
  }

  it('holds 300 pictures piled on one centre at zoom 1 within 1.25 times the budget (it held 235.9 megapixels), none blank, also zooming out and in', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithBoard()
    try {
      const r = await measure(page, 'pile', 300, 1, 0.1, [0.5, 0.25, 0.5, 1])
      expect(r.settled.peakLiveMpx).toBeLessThanOrEqual(BUDGET_MPX * 1.25)
      expect(r.settled.liveMpx).toBeLessThanOrEqual(BUDGET_MPX)
      // The cache's books and the bitmaps really open agree.
      expect(Math.abs(r.settled.cacheMpx - r.settled.liveMpx)).toBeLessThan(0.5)
      expect(r.blank).toBe(0)
      expect(r.settled.failed).toBe(0)
      expect(r.swept!.worstBlank).toBe(0)
      expect(r.swept!.stats.peakLiveMpx).toBeLessThanOrEqual(BUDGET_MPX * 1.25)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('holds 40 pictures piled at zoom 4 (the picture itself, 480 megapixels before) within 1.25 times the budget, none blank, also zooming out and in', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithBoard()
    try {
      const r = await measure(page, 'pile', 40, 4, 0.1, [2, 1, 2, 4])
      expect(r.settled.peakLiveMpx).toBeLessThanOrEqual(BUDGET_MPX * 1.25)
      expect(r.blank).toBe(0)
      expect(r.swept!.worstBlank).toBe(0)
      expect(r.swept!.stats.peakLiveMpx).toBeLessThanOrEqual(BUDGET_MPX * 1.25)
      expect(r.swept!.stats.liveMpx).toBeLessThanOrEqual(BUDGET_MPX)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('holds 20 pictures cropped to a 10% detail shown 110 px wide at the 1024 tier (240 megapixels before, 16 now)', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithBoard()
    try {
      const r = await measure(page, 'crops', 20, 1, 0.1)
      expect(r.settled.peakLiveMpx).toBeLessThan(20)
      expect(r.settled.bitmaps).toBe(20)
      expect(r.blank).toBe(0)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('keeps an ordinary 300-picture board (fit to the window) as cheap as before: 14.7 megapixels, a frame of a few milliseconds while panning', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithBoard()
    try {
      const r = await page.evaluate(async () => {
        const Z = (window as unknown as { Z: { open(...a: unknown[]): Promise<void>; call(name: string, fn: string, ...a: unknown[]): Promise<any> } }).Z
        await Z.open('b', 'fit', 300, 0.55, 0.1)
        await Z.call('b', 'settle')
        const pan = await Z.call('b', 'pan')
        return { stats: await Z.call('b', 'stats'), pan }
      })
      expect(r.stats.peakLiveMpx).toBeLessThan(16)
      expect(r.stats.bitmaps).toBe(300)
      // 9 ms measured here; a busy machine gets a lot of room.
      expect(r.pan.p50).toBeLessThan(100)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('draws 300 grey pictures in milliseconds, not seconds: the filter is clipped to each picture (1.6 s a frame before)', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithBoard()
    try {
      const t = await page.evaluate(() => (window as unknown as { Z: { grey: { frameTimes(): Promise<{ colour: number; grey: number }> } } }).Z.grey.frameTimes())
      expect(t.grey).toBeLessThan(500)
      expect(t.grey).toBeLessThan(40 * Math.max(t.colour, 5))
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('exports a grey board of 300 pictures in well under a second at 2048 px (5 s before)', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithBoard()
    try {
      const t = await page.evaluate(() => (window as unknown as { Z: { grey: { exportTime(): Promise<{ ms: number; w: number; h: number }> } } }).Z.grey.exportTime())
      expect(t.w).toBeGreaterThan(1000)
      expect(t.ms).toBeLessThan(1500)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)

  it('exports an arrow with its head: the wings are inside the picture, not cut off (a 420 x 80 canvas, not 420 x 20)', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithBoard()
    try {
      const r = await page.evaluate(() => (window as unknown as { Z: { arrowExport(): Promise<{ w: number; h: number; wingLow: number[]; wingHigh: number[]; shaft: number[]; outside: number[] }> } }).Z.arrowExport())
      expect([r.w, r.h]).toEqual([420, 80])
      for (const p of [r.wingLow, r.wingHigh, r.shaft]) {
        expect(p[0]).toBeGreaterThan(240)
        expect(p[1]).toBeLessThan(20)
      }
      // Below the canvas there is nothing (the read is of a place outside it).
      expect(r.outside).toEqual([0, 0, 0, 0])
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)

  it('draws a missing file, a picture too large to show and an unreadable one differently, and the real loader and cache give the too-large look for a 30,000 x 30,000 header without decoding anything', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithBoard()
    try {
      const r = await page.evaluate(() => (window as unknown as { Z: { placeholders(): Promise<Record<string, unknown>> } }).Z.placeholders())
      for (const k of ['missingVsLarge', 'largeVsUnreadable', 'missingVsUnreadable', 'loadingVsLarge'] as const) expect(r[k] as number, k).toBeGreaterThan(150)
      expect(r['reason']).toBe('too-large')
      expect(r['failed']).toBe(true)
      expect(r['natural']).toEqual({ w: 30000, h: 30000 })
      expect(r['decodes']).toBe(0)
      // The picture drawn from the real cache is, pixel for pixel, the too-large placeholder, and not the missing one.
      expect(r['realVsLarge']).toBe(0)
      expect(r['realVsMissing'] as number).toBeGreaterThan(150)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)

  it('leaves the edges of grey pictures as an unclipped draw has them, to within a few levels on a few bytes (abutting, turned, flipped, translucent)', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithBoard()
    try {
      const e = await page.evaluate(() => (window as unknown as { Z: { grey: { edges(): Promise<{ differ: number; max: number; bytes: number }> } } }).Z.grey.edges())
      // An exact clip (no outset) changed 591 bytes by up to 94 levels in the review's test: the clip's anti-aliasing multiplies with
      // the picture's own and leaves seams. A clip outset by a device pixel is the picture's own edge.
      expect(e.max).toBeLessThanOrEqual(8)
      expect(e.differ).toBeLessThanOrEqual(64)
      expect(e.bytes).toBe(800 * 600 * 4)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)
})
