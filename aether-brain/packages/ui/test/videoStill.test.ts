import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { Browser } from 'playwright-core'

/**
 * The browser adapters' video still (`videoStill` in src/util.ts), run in real
 * Chromium on a small WebM whose first frame is black and the rest red | blue:
 * the still is sought past the first frame, fitted to the size, never played.
 * Skipped when no Chromium is installed.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const CLIP = path.join(here, '..', '..', '..', 'apps', 'desktop', 'test', 'fixtures', 'clip.webm')

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

describe('videoStill in Chromium', () => {
  let browser: Browser | null = null
  let js = ''

  beforeAll(async () => {
    const src = await fs.readFile(path.join(here, '..', 'src', 'util.ts'), 'utf8')
    // util.ts imports nothing: as a plain script its functions are in scope of the code run after it.
    js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export /gm, '')
    try {
      const { chromium } = await import('playwright-core')
      browser = await chromium.launch({ executablePath: findChromium() })
    } catch {
      browser = null
    }
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('takes a coloured still past the black first frame, fitted and never enlarged; nothing from garbage; a picture passes through', async (ctx) => {
    if (!browser) return ctx.skip()
    const clip = Array.from(new Uint8Array(await fs.readFile(CLIP)))
    const page = await browser.newPage()
    try {
      await page.setContent('<!doctype html><title>still</title>')
      const out = await page.evaluate(
        async ({ js, clip }) => {
          let played = 0
          HTMLMediaElement.prototype.play = function () {
            played++
            return Promise.resolve()
          }
          const { videoStill, stillOf } = new Function(`${js}; return { videoStill, stillOf }`)() as {
            videoStill(b: Blob, size: number): Promise<Blob | null>
            stillOf(b: Blob | null, size: number): Promise<Blob | null>
          }
          const look = async (b: Blob | null) => {
            if (!b) return null
            const bmp = await createImageBitmap(b)
            const c = new OffscreenCanvas(bmp.width, bmp.height)
            const g = c.getContext('2d')!
            g.drawImage(bmp, 0, 0)
            const at = (x: number, y: number) => {
              const [r, , bl] = g.getImageData(x, y, 1, 1).data
              return (r ?? 0) > 128 && (bl ?? 0) < 128 ? 'red' : (bl ?? 0) > 128 && (r ?? 0) < 128 ? 'blue' : 'other'
            }
            return { type: b.type, width: bmp.width, height: bmp.height, left: at(4, 4), right: at(bmp.width - 5, 4) }
          }
          const video = new Blob([new Uint8Array(clip)], { type: 'video/webm' })
          const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
          return {
            small: await look(await videoStill(video, 64)),
            big: await look(await videoStill(video, 1024)),
            viaStillOf: await look(await stillOf(video, 64)),
            garbage: await videoStill(new Blob([new Uint8Array([1, 2, 3, 4, 5, 6])], { type: 'video/webm' }), 64),
            picture: (await stillOf(png, 64)) === png,
            played,
            videos: document.querySelectorAll('video').length,
          }
        },
        { js, clip },
      )
      const halves = { type: 'image/png', left: 'red', right: 'blue' }
      expect(out.small).toEqual({ ...halves, width: 64, height: 36 })
      expect(out.big).toEqual({ ...halves, width: 160, height: 90 })
      expect(out.viaStillOf).toEqual({ ...halves, width: 64, height: 36 })
      expect(out.garbage).toBeNull()
      expect(out.picture).toBe(true)
      expect([out.played, out.videos]).toEqual([0, 0])
    } finally {
      await page.close()
    }
  }, 60_000)
})
