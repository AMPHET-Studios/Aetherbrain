import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright-core'

/**
 * The board renderer on a real canvas in real Chromium: a known board is drawn with generated bitmaps and the colours of known pixels
 * are read back (a flipped picture's colour on the right side, a grey picture grey, a turned picture's corner outside and its middle
 * inside, crisp or smoothed pixels, marks, handles, guides, the loupe, text inside its box, density 2), `exportBoard` is run on an
 * OffscreenCanvas, and the recording fake's matrix rules are compared with the browser's own. Skipped when no Chromium is installed.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const posix = (...p: string[]) => path.join(here, '..', ...p).replace(/\\/g, '/')
const RENDERER = posix('src', 'board', 'renderer.ts')
const RECORDING = posix('test', 'helpers', 'recordingContext.ts')
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

const ENTRY = `
import * as R from '${RENDERER}'
import { RecordingContext } from '${RECORDING}'
import * as C from '@aether/core'
;(window as unknown as { T: unknown }).T = { R, RecordingContext, C }
`

/** Page-side helpers (plain JavaScript): bitmaps, a canvas to draw a board on, pixel reads. */
const HELPERS = `
window.H = (() => {
  const T = window.T
  const px = (g, x, y, d = 1) => Array.from(g.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data)
  async function bmp(w, h, paint) {
    const c = new OffscreenCanvas(w, h)
    paint(c.getContext('2d'), w, h)
    return createImageBitmap(c)
  }
  const solid = (w, h, colour) => bmp(w, h, (g) => { g.fillStyle = colour; g.fillRect(0, 0, w, h) })
  /** Left half one colour, right half another. */
  const halves = (w, h, a, b) => bmp(w, h, (g) => { g.fillStyle = a; g.fillRect(0, 0, w / 2, h); g.fillStyle = b; g.fillRect(w / 2, 0, w / 2, h) })
  /** Top half one colour, bottom half another. */
  const stacked = (w, h, a, b) => bmp(w, h, (g) => { g.fillStyle = a; g.fillRect(0, 0, w, h / 2); g.fillStyle = b; g.fillRect(0, h / 2, w, h / 2) })
  let id = 1
  const common = () => ({ id: id++, group: 0, locked: false })
  const pic = (o) => ({ ...common(), kind: 'picture', path: 'a.png', x: 0, y: 0, w: 80, h: 60, rotation: 0, crop: { l: 0, t: 0, r: 1, b: 1 }, flipH: false, flipV: false, gray: false, opacity: 1, caption: '', ...o })
  const note = (o) => ({ ...common(), kind: 'note', text: 'hello', x: 0, y: 0, w: 140, size: 20, rotation: 0, color: 'ffffff', fill: '', ...o })
  const stroke = (o) => ({ ...common(), kind: 'stroke', points: [0, 0, 10, 0], color: 'ff0000', width: 10, ...o })
  const line = (o) => ({ ...common(), kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0, color: 'ffffff', width: 4, arrow: false, ...o })
  const rect = (o) => ({ ...common(), kind: 'rect', x1: 0, y1: 0, x2: 10, y2: 10, color: 'ffffff', width: 4, fill: '', ...o })
  const ellipse = (o) => ({ ...common(), kind: 'ellipse', x1: 0, y1: 0, x2: 10, y2: 10, color: 'ffffff', width: 4, fill: '', ...o })
  const doc = (items, o = {}) => ({ ...T.C.emptyBoard('t'), bg: '202020', items, nextId: 9999, ...o })
  const images = (map) => ({ get: (p) => ({ bitmap: map[p] ?? null, natural: null, failed: !map[p] }) })
  /** Draws on a fresh canvas of 400x300 CSS pixels at density d and returns its context. */
  function board(d, docv, map, over = {}) {
    const c = document.createElement('canvas')
    c.width = 400 * d
    c.height = 300 * d
    const g = c.getContext('2d', { willReadFrequently: true })
    T.R.drawBoard(g, {
      doc: docv,
      view: { x: 0, y: 0, zoom: 1 },
      viewport: { w: 400, h: 300 },
      dpr: d,
      state: T.R.EMPTY_DRAW_STATE,
      images: images(map),
      metrics: T.C.estimateTextMetrics,
      ...over,
    })
    return g
  }
  return { px, bmp, solid, halves, stacked, pic, note, stroke, line, rect, ellipse, doc, images, board, T }
})()
`

type Px = number[]

describe('the board renderer in Chromium', () => {
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
      console.warn('board renderer Chromium test skipped, Chromium does not start:', err)
      return
    }
    // A bundle that fails to build is a failure, not a skip: the test must not go quiet.
    const { build } = await import('vite')
    dir = mkdtempSync(path.join(os.tmpdir(), 'board-renderer-'))
    const entry = path.join(dir, 'entry.ts')
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
      },
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'BoardRenderer', fileName: 'b' } },
    })
    const bundle = Array.isArray(out) ? out[0]! : out
    const chunk = 'output' in bundle ? bundle.output.find((o) => o.type === 'chunk') : undefined
    js = chunk && chunk.type === 'chunk' ? chunk.code : ''
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  async function pageWithRenderer(): Promise<{ page: Page; errors: string[] }> {
    const page = await browser!.newPage({ viewport: { width: 500, height: 400 } })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.setContent('<!doctype html><title>board</title>')
    await page.addScriptTag({ content: js })
    await page.addScriptTag({ content: HELPERS })
    return { page, errors }
  }

  const near = (got: Px, want: Px, tol = 3): void => {
    for (let i = 0; i < 3; i++) expect(Math.abs(got[i]! - want[i]!), `${JSON.stringify(got)} vs ${JSON.stringify(want)}`).toBeLessThanOrEqual(tol)
  }
  const BG: Px = [32, 32, 32]

  it('draws pictures with their colours where they belong: flips, grey, opacity, turns, crop', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithRenderer()
    try {
      const sample = (d: number) =>
        page.evaluate(async (d) => {
          const H = (window as unknown as { H: Record<string, (...a: unknown[]) => any> }).H as any
          const map = {
            red: await H.solid(40, 30, '#ff0000'),
            green: await H.solid(40, 30, '#00ff00'),
            yellow: await H.solid(40, 40, '#ffff00'),
            bg: await H.halves(40, 20, '#0000ff', '#00ff00'),
            rb: await H.halves(40, 20, '#ff0000', '#0000ff'),
            ud: await H.stacked(20, 40, '#ffff00', '#00ffff'),
          }
          const items = [
            H.pic({ path: 'red', x: -120, y: -80 }), //                                 plain red at screen (80, 70)
            H.pic({ path: 'bg', x: 0, y: -80, w: 80, h: 40, flipH: true }), //          flipped: green left, blue right
            H.pic({ path: 'bg', x: 0, y: -20, w: 80, h: 40 }), //                        not flipped: blue left, green right
            H.pic({ path: 'red', x: 120, y: -80, gray: true }), //                       grey
            H.pic({ path: 'green', x: 120, y: -20, w: 80, h: 40, opacity: 0.5 }), //     half green over the background
            H.pic({ path: 'rb', x: -120, y: 60, w: 80, h: 40, rotation: 90 }), //        red half goes to the top
            H.pic({ path: 'yellow', x: 0, y: 80, w: 60, h: 60, rotation: 45 }), //       a diamond
            H.pic({ path: 'rb', x: 120, y: 80, w: 80, h: 40, crop: { l: 0.5, t: 0, r: 1, b: 1 } }), // only the blue half, 40 wide
            H.pic({ path: 'ud', x: -150, y: -20, w: 30, h: 60, flipV: true }), //        top is cyan
          ]
          const g = H.board(d, H.doc(items), map)
          const at = (x: number, y: number) => H.px(g, x, y, d)
          return {
            red: at(80, 70),
            flippedLeft: at(180, 70),
            flippedRight: at(220, 70),
            plainLeft: at(180, 130),
            plainRight: at(220, 130),
            gray: at(320, 70),
            half: at(320, 130),
            turnedTop: at(80, 190),
            turnedBottom: at(80, 230),
            turnedLeftOfBox: at(50, 210),
            diamondCentre: at(200, 230),
            diamondEdge: at(236, 230),
            diamondCorner: at(230, 260),
            cropMiddle: at(320, 230),
            cropLeft: at(306, 230),
            cropLeftOutside: at(296, 230),
            upsideDownTop: at(50, 115),
            upsideDownBottom: at(50, 145),
            bgPoint: at(10, 10),
          }
        }, d)
      const s1 = await sample(1)
      near(s1.red, [255, 0, 0])
      near(s1.flippedLeft, [0, 255, 0])
      near(s1.flippedRight, [0, 0, 255])
      near(s1.plainLeft, [0, 0, 255])
      near(s1.plainRight, [0, 255, 0])
      // grayscale(1) of pure red is 0.2126 × 255 on every channel.
      near(s1.gray, [54, 54, 54], 3)
      near(s1.half, [16, 144, 16], 3)
      near(s1.turnedTop, [255, 0, 0])
      near(s1.turnedBottom, [0, 0, 255])
      near(s1.turnedLeftOfBox, BG)
      near(s1.diamondCentre, [255, 255, 0])
      near(s1.diamondEdge, [255, 255, 0])
      near(s1.diamondCorner, BG)
      near(s1.cropMiddle, [0, 0, 255])
      near(s1.cropLeft, [0, 0, 255])
      near(s1.cropLeftOutside, BG)
      near(s1.upsideDownTop, [0, 255, 255])
      near(s1.upsideDownBottom, [255, 255, 0])
      near(s1.bgPoint, BG)
      // The same board on a density-2 canvas is the same picture at twice the pixels.
      const s2 = await sample(2)
      for (const key of Object.keys(s1) as (keyof typeof s1)[]) near(s2[key], s1[key], 4)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)

  it('draws crisp pixels when smoothing is off and blended ones when it is on', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithRenderer()
    try {
      const r = await page.evaluate(async () => {
        const H = (window as unknown as { H: any }).H
        const map = { two: await H.halves(2, 1, '#ff0000', '#0000ff') }
        const items = [H.pic({ path: 'two', x: 0, y: 0, w: 100, h: 50 })]
        const crisp = H.board(1, H.doc(items, { smooth: false }), map)
        const soft = H.board(1, H.doc(items, { smooth: true }), map)
        const at = (g: any, x: number) => H.px(g, x, 150)
        return { crispL: at(crisp, 199), crispR: at(crisp, 200), softL: at(soft, 199), softR: at(soft, 200), softMid: at(soft, 195) }
      })
      near(r.crispL, [255, 0, 0], 0)
      near(r.crispR, [0, 0, 255], 0)
      // Smoothed, the colours run into each other across the edge: red and blue both show up in the pixel next to it.
      expect(r.softL[0]! > 20 && r.softL[2]! > 20, JSON.stringify(r.softL)).toBe(true)
      expect(r.softR[0]! > 20 && r.softR[2]! > 20, JSON.stringify(r.softR)).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)

  it('draws marks: round caps, a rectangle with fill and outline, an ellipse, an arrow with a head', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithRenderer()
    try {
      const r = await page.evaluate(() => {
        const H = (window as unknown as { H: any }).H
        const items = [
          H.stroke({ points: [-150, 0, -100, 0, -50, 0], width: 10, color: 'ff0000' }), //                 screen (50..150, 150)
          H.rect({ x1: 40, y1: -60, x2: 140, y2: 0, width: 4, color: 'ffffff', fill: '0000ff' }), //         screen (240..340, 90..150)
          H.ellipse({ x1: -100, y1: 40, x2: -20, y2: 100, width: 2, color: 'ffffff', fill: '00ff00' }), //   centre (140, 220), 40 x 30
          H.line({ x1: 60, y1: 70, x2: 160, y2: 70, width: 6, color: 'ffff00', arrow: true }), //           screen (260..360, 220)
          H.line({ x1: -150, y1: -100, x2: -50, y2: -100, width: 0, color: 'ff00ff' }), //                  a hairline
        ]
        const g = H.board(1, H.doc(items), {})
        const at = (x: number, y: number) => H.px(g, x, y)
        return {
          strokeMiddle: at(100, 150),
          strokeAbove: at(100, 141),
          strokeBelow: at(100, 159),
          capInside: at(46, 150),
          capCorner: at(45, 145),
          fill: at(290, 120),
          outlineTop: at(290, 90),
          insideEdge: at(290, 95),
          outsideEdge: at(290, 80),
          ellipseCentre: at(140, 220),
          ellipseInside: at(176, 220),
          ellipseOutsideCorner: at(178, 248),
          shaft: at(290, 220),
          head: at(338, 229),
          pastTip: at(364, 220),
          hairline: at(100, 50),
        }
      })
      near(r.strokeMiddle, [255, 0, 0])
      near(r.strokeAbove, BG)
      near(r.strokeBelow, BG)
      near(r.capInside, [255, 0, 0])
      near(r.capCorner, BG)
      near(r.fill, [0, 0, 255])
      near(r.outlineTop, [255, 255, 255], 4)
      near(r.insideEdge, [0, 0, 255])
      near(r.outsideEdge, BG)
      near(r.ellipseCentre, [0, 255, 0])
      near(r.ellipseInside, [0, 255, 0])
      near(r.ellipseOutsideCorner, BG)
      near(r.shaft, [255, 255, 0])
      // 9 px off the shaft's axis the shaft (3 px a side) is long gone: only the head covers this pixel.
      near(r.head, [255, 255, 0])
      near(r.pastTip, BG)
      // A line of width 0 is still seen: one device pixel of its colour (maybe spread over two rows).
      expect(r.hairline[0]! > 100 && r.hairline[2]! > 100, JSON.stringify(r.hairline)).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)

  it('draws the editing aids: handles of 8 px at any zoom, a guide, the marquee, the loupe, a grid, a missing picture', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithRenderer()
    try {
      const r = await page.evaluate(async () => {
        const H = (window as unknown as { H: any }).H
        const { R, C } = H.T
        const square = (zoom: number) => {
          const h = 60 / zoom
          const b = 40 / zoom
          return {
            corners: [{ x: -h, y: -b }, { x: h, y: -b }, { x: h, y: b }, { x: -h, y: b }],
            rotateHandle: { x: 0, y: -b - R.ROTATE_STALK_PX / zoom },
            rotation: 0,
          }
        }
        const handleWidth = (zoom: number) => {
          const g = H.board(1, H.doc([]), {}, { view: { x: 0, y: 0, zoom }, state: { ...R.EMPTY_DRAW_STATE, box: square(zoom) } })
          // The top-left handle is centred at (140, 110): count white pixels along the row through its middle.
          let n = 0
          for (let x = 120; x < 160; x++) {
            const p = H.px(g, x, 110)
            if (p[0] > 250 && p[1] > 250 && p[2] > 250) n++
          }
          return { n, outside: H.px(g, 130, 110), inside: H.px(g, 140, 110), knob: H.px(g, 200, 86), stalk: H.px(g, 200, 98) }
        }
        const noGrid = H.board(1, H.doc([]), {})
        const grid = H.board(1, H.doc([], { grid: 50 }), {})
        const aids = H.board(1, H.doc([]), {}, {
          state: { ...R.EMPTY_DRAW_STATE, guides: { v: [70], h: [] }, marquee: { x: -150, y: -120, w: 60, h: 40 }, sample: { x: 300, y: 60, hex: 'ff8040' } },
        })
        const missing = H.board(1, H.doc([H.pic({ path: 'gone.png', x: 0, y: 0, w: 120, h: 90 })]), {})
        const loading = H.board(1, H.doc([H.pic({ path: 'wait.png', x: 0, y: 0, w: 120, h: 90 })]), {}, { images: { get: () => ({ bitmap: null, natural: null, failed: false }) } })
        let dashedHits = 0
        // Along the dashed outline of the missing picture (top edge, y = 105) some pixels are lit and some are not.
        for (let x = 142; x < 258; x++) {
          const p = H.px(missing, x, 105)
          if (p[0] > 70) dashedHits++
        }
        return {
          w1: handleWidth(1),
          w2: handleWidth(2),
          w05: handleWidth(0.5),
          gridOff: H.px(noGrid, 150, 20),
          gridOn: H.px(grid, 150, 20),
          gridBetween: H.px(grid, 180, 20),
          guide: H.px(aids, 270, 20),
          beside: H.px(aids, 280, 20),
          marquee: H.px(aids, 80, 50),
          ring: H.px(aids, 319, 60),
          ringHole: H.px(aids, 300, 60),
          ringOutside: H.px(aids, 330, 60),
          label: H.px(aids, 300, 92),
          dashedHits,
          missingFill: H.px(missing, 170, 150),
          loadingFill: H.px(loading, 150, 120),
        }
      })
      // 8 white pixels (the accent border is inside the 8) minus the border: the row crosses [136, 144) with a 1 px accent ring at each end.
      for (const w of [r.w1, r.w2, r.w05]) {
        expect(w.n).toBeGreaterThanOrEqual(5)
        expect(w.n).toBeLessThanOrEqual(8)
        near(w.outside, BG)
        near(w.inside, [255, 255, 255], 2)
        // The rotate knob and its stalk are 24 CSS px above the top edge's middle, whatever the zoom.
        expect(w.knob[0]! > 200, `knob ${JSON.stringify(w.knob)}`).toBe(true)
      }
      expect(r.w1.n).toBe(r.w2.n)
      expect(r.w1.n).toBe(r.w05.n)
      near(r.gridOff, BG, 0)
      expect(Math.abs(r.gridOn[0]! - 32) + Math.abs(r.gridOn[1]! - 32)).toBeGreaterThan(0)
      near(r.gridBetween, BG, 0)
      expect(r.guide[0]! > 200 && r.guide[1]! < 100 && r.guide[2]! > 150, `guide ${JSON.stringify(r.guide)}`).toBe(true)
      near(r.beside, BG, 0)
      // Bluish tint over the dark background.
      expect(r.marquee[2]! - r.marquee[0]!).toBeGreaterThan(15)
      near(r.ring, [255, 128, 64], 2)
      near(r.ringHole, BG, 0)
      near(r.ringOutside, BG, 0)
      expect(r.label[0]! > 200, `label ${JSON.stringify(r.label)}`).toBe(true)
      expect(r.dashedHits).toBeGreaterThan(20)
      expect(r.dashedHits).toBeLessThan(110)
      near(r.missingFill, [36, 26, 31], 12)
      near(r.loadingFill, [27, 30, 41], 6)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)

  it('draws a note with the text wrapped as the real font measures it, inside its box', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithRenderer()
    try {
      const r = await page.evaluate(() => {
        const H = (window as unknown as { H: any }).H
        const { R } = H.T
        const measureCtx = document.createElement('canvas').getContext('2d')!
        const metrics = R.canvasTextMetrics(measureCtx)
        const n = H.note({ text: 'Hello brave new world of reference boards', x: 0, y: 0, w: 140, size: 20, fill: '334455' })
        const layout = metrics.layout(n.text, n.size, n.w - 2 * 10)
        const g = H.board(1, H.doc([n]), {}, { metrics })
        const boxH = layout.height + 20
        const left = 200 - 70
        const top = 150 - boxH / 2
        // Ink: pixels that are nearly white inside the box.
        const ink = (x0: number, y0: number, x1: number, y1: number) => {
          const data = g.getImageData(Math.floor(x0), Math.floor(y0), Math.ceil(x1 - x0), Math.ceil(y1 - y0))
          let n = 0
          let minX = Infinity
          let maxX = -Infinity
          for (let y = 0; y < data.height; y++) {
            for (let x = 0; x < data.width; x++) {
              const o = (y * data.width + x) * 4
              if (data.data[o]! > 200 && data.data[o + 1]! > 200 && data.data[o + 2]! > 200) {
                n++
                minX = Math.min(minX, x + Math.floor(x0))
                maxX = Math.max(maxX, x + Math.floor(x0))
              }
            }
          }
          return { n, minX, maxX }
        }
        const bands = layout.lines.map((_: string, i: number) => ink(left, top + 10 + i * 25, left + 140, top + 10 + (i + 1) * 25))
        // Real widths at the drawn size, by the same font.
        measureCtx.font = R.noteFont(100)
        const widths = layout.lines.map((l: string) => (measureCtx.measureText(l).width * 20) / 100)
        return {
          lines: layout.lines,
          layoutWidth: layout.width,
          boxH,
          bands,
          widths,
          above: ink(left, top, left + 140, top + 10),
          below: ink(left, top + 10 + layout.lines.length * 25, left + 140, top + boxH),
          right: ink(left + 140, top, left + 170, top + boxH),
          fillAt: H.px(g, left + 3, top + boxH / 2),
          fillAbove: H.px(g, left + 70, top - 3),
        }
      })
      expect(r.lines.length).toBeGreaterThanOrEqual(3)
      // Each line is real ink in its own band, the margins have none, and nothing spills out of the box.
      for (const [i, b] of r.bands.entries()) expect(b.n, `line ${i} ${JSON.stringify(r.lines[i])}`).toBeGreaterThan(5)
      expect(r.above.n).toBe(0)
      expect(r.below.n).toBe(0)
      expect(r.right.n).toBe(0)
      near(r.fillAt, [51, 68, 85], 2)
      near(r.fillAbove, BG, 0)
      // The ink of the widest line stops where the layout says its line ends (and starts at the margin).
      const widest = Math.max(...r.widths)
      expect(Math.abs(widest - r.layoutWidth)).toBeLessThan(1e-6)
      for (const [i, b] of r.bands.entries()) {
        expect(b.minX, `line ${i} starts`).toBeGreaterThanOrEqual(200 - 70 + 10 - 3)
        expect(b.maxX, `line ${i} ends`).toBeLessThanOrEqual(200 - 70 + 10 + (r.widths[i] as number) + 3)
        expect(b.maxX, `line ${i} stays inside the margin`).toBeLessThanOrEqual(200 - 70 + 140 - 10 + 3)
      }
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)

  it('wraps greedily by real widths: every line fits, and what comes next would not have', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithRenderer()
    try {
      const r = await page.evaluate(() => {
        const H = (window as unknown as { H: any }).H
        const { R } = H.T
        const g = document.createElement('canvas').getContext('2d')!
        const metrics = R.canvasTextMetrics(g)
        const text = 'The quick brown fox jumps over the lazy dog, then thinks about Supercalifragilisticexpialidocious things'
        const problems: string[] = []
        const counts: number[] = []
        for (const [size, width] of [[12, 90], [20, 140], [48, 300], [7, 40], [30, 25]] as const) {
          const l = metrics.layout(text, size, width)
          counts.push(l.lines.length)
          g.font = R.noteFont(100)
          const w = (s: string) => (g.measureText(s).width * size) / 100
          let pos = 0
          for (let i = 0; i < l.lines.length; i++) {
            const line: string = l.lines[i]
            if (!text.startsWith(line, pos)) problems.push(`size ${size}: line ${i} ${JSON.stringify(line)} is not the text at ${pos}`)
            pos += line.length
            // A line fits, unless it is one glyph that cannot be cut any further.
            if (w(line) > width + 1e-9 && Array.from(line).length > 1) problems.push(`size ${size}: ${JSON.stringify(line)} is wider than ${width}`)
            if (i === l.lines.length - 1) break
            let candidate: string
            if (text[pos] === ' ') {
              // Broken at a space: the whole next word did not fit after it.
              pos++
              const rest = text.slice(pos)
              const word = rest.split(' ')[0]!
              candidate = line + ' ' + word
            } else {
              // Broken inside a word: one more glyph did not fit.
              candidate = line + Array.from(text.slice(pos))[0]
            }
            if (w(candidate) <= width + 1e-9) problems.push(`size ${size}: ${JSON.stringify(line)} could have taken more: ${JSON.stringify(candidate)}`)
          }
          if (pos !== text.length) problems.push(`size ${size}: the lines end at ${pos} of ${text.length}`)
        }
        return { problems, counts }
      })
      expect(r.problems).toEqual([])
      expect(r.counts.every((n) => n > 1)).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)

  it('exports a board to a canvas of the expected size, pixels in place, background or not, bitmaps closed', async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithRenderer()
    try {
      const r = await page.evaluate(async () => {
        const H = (window as unknown as { H: any }).H
        const { R } = H.T
        const opened: ImageBitmap[] = []
        const sources: Record<string, [number, number, string, string?]> = {
          red: [40, 30, '#ff0000'],
          bg: [40, 20, '#0000ff', '#00ff00'],
        }
        const images = {
          async get(p: string) {
            const s = sources[p]
            if (!s) return null
            const b = s[3] ? await H.halves(s[0], s[1], s[2], s[3]) : await H.solid(s[0], s[1], s[2])
            opened.push(b)
            return b
          },
        }
        const makeCanvas = (w: number, h: number) => new OffscreenCanvas(w, h)
        const a = H.pic({ path: 'red', x: 100, y: 50, w: 200, h: 100 })
        const b = H.pic({ path: 'bg', x: 400, y: 50, w: 80, h: 40, flipH: true })
        const far = H.pic({ path: 'red', x: 9000, y: 9000, w: 10, h: 10 })
        const doc = H.doc([a, b, far], { bg: '102030' })
        const metrics = H.T.C.estimateTextMetrics

        // Just a and b: x from 0 to 440, y from 0 to 100; scale 2 and a margin of 10 px.
        const sel = await R.exportBoard(doc, [a.id, b.id], 2, images, makeCanvas, metrics, { margin: 10 })
        const read = (res: any, x: number, y: number): number[] => Array.from(res.canvas.getContext('2d').getImageData(x, y, 1, 1).data)
        const out = {
          size: [sel.width, sel.height, sel.scale],
          canvasSize: [sel.canvas.width, sel.canvas.height],
          red: read(sel, 10 + 2 * 100, 10 + 2 * 50),
          flippedLeft: read(sel, 10 + 2 * 380, 10 + 2 * 50),
          flippedRight: read(sel, 10 + 2 * 420, 10 + 2 * 50),
          margin: read(sel, 3, 3),
          gap: read(sel, 10 + 2 * 340, 10 + 2 * 90),
          closed: opened.map((o) => o.width),
        }
        // Whole board, scale reduced to fit 100 px; no background: the margin and gaps are transparent.
        opened.length = 0
        const small = await R.exportBoard(doc, null, 1, images, makeCanvas, metrics, { maxSide: 100, background: false })
        const clear = {
          size: [small.width, small.height],
          scale: small.scale,
          corner: Array.from(small.canvas.getContext('2d').getImageData(0, small.height - 1, 1, 1).data),
          topLeft: Array.from(small.canvas.getContext('2d').getImageData(1, 1, 1, 1).data),
        }
        const none = await R.exportBoard(H.doc([]), null, 1, images, makeCanvas, metrics)
        const missing = await R.exportBoard(H.doc([H.pic({ path: 'nope', w: 60, h: 40 })]), null, 1, images, makeCanvas, metrics)
        return { out, clear, none, missingSize: missing && [missing.width, missing.height] }
      })
      expect(r.out.size).toEqual([2 * 440 + 20, 2 * 100 + 20, 2])
      expect(r.out.canvasSize).toEqual([900, 220])
      near(r.out.red, [255, 0, 0])
      // The flipped picture: its blue half is on the right now.
      near(r.out.flippedLeft, [0, 255, 0])
      near(r.out.flippedRight, [0, 0, 255])
      near(r.out.margin, [16, 32, 48])
      near(r.out.gap, [16, 32, 48])
      // Every full-size bitmap the export took was given back (closed: width 0).
      expect(r.out.closed).toEqual([0, 0])
      expect(r.clear.size[0]).toBeLessThanOrEqual(100)
      expect(r.clear.size[1]).toBeLessThanOrEqual(100)
      expect(Math.max(...r.clear.size)).toBe(100)
      expect(r.clear.scale).toBeLessThan(0.02)
      expect(r.clear.corner[3]).toBe(0)
      expect(r.none).toBeNull()
      expect(r.missingSize).toEqual([60, 40])
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)

  it("the recording fake's matrix rules are the browser's: random save, restore, translate, rotate, scale, transform and setTransform", async (ctx) => {
    if (!browser || !js) return ctx.skip()
    const { page, errors } = await pageWithRenderer()
    try {
      const r = await page.evaluate(() => {
        const H = (window as unknown as { H: any }).H
        const { RecordingContext } = H.T
        let seed = 12345
        const rnd = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0
          return seed / 4294967296
        }
        let worst = 0
        for (let run = 0; run < 300; run++) {
          const real = document.createElement('canvas').getContext('2d')!
          const fake = new RecordingContext()
          let depth = 0
          for (let step = 0; step < 25; step++) {
            const op = Math.floor(rnd() * 8)
            const a = (rnd() - 0.5) * 6
            const b = (rnd() - 0.5) * 6
            const c = (rnd() - 0.5) * 6
            const d = (rnd() - 0.5) * 6
            const e = (rnd() - 0.5) * 200
            const f = (rnd() - 0.5) * 200
            if (op === 0) { real.translate(e, f); fake.translate(e, f) }
            else if (op === 1) { real.rotate(a); fake.rotate(a) }
            else if (op === 2) { real.scale(a, b); fake.scale(a, b) }
            else if (op === 3) { real.transform(a, b, c, d, e, f); fake.transform(a, b, c, d, e, f) }
            else if (op === 4) { real.setTransform(a, b, c, d, e, f); fake.setTransform(a, b, c, d, e, f) }
            else if (op === 5) { real.save(); fake.save(); depth++ }
            else if (op === 6 && depth > 0) { real.restore(); fake.restore(); depth-- }
            else { real.resetTransform(); fake.resetTransform() }
            const m = real.getTransform()
            const want = [m.a, m.b, m.c, m.d, m.e, m.f]
            for (let i = 0; i < 6; i++) {
              const scale = Math.max(1, Math.abs(want[i]!))
              worst = Math.max(worst, Math.abs(want[i]! - fake.matrix[i]!) / scale)
            }
          }
        }
        return worst
      })
      // Skia keeps the matrix in single precision, the fake in doubles: they agree to float rounding. A wrong order of multiplication,
      // a rotation the wrong way or a restore that forgets the matrix is off by whole units.
      expect(r).toBeLessThan(1e-3)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)
})
