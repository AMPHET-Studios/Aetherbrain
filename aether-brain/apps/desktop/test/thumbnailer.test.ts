import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { Browser } from 'playwright-core'
import { thumbTarget } from '../src/main/assets.js'
import {
  MAX_THUMB_PNG,
  THUMB_IPC,
  THUMB_PAGE,
  THUMB_PARTITION,
  ThumbQueue,
  ThumbUnavailable,
  Thumbnailer,
  type ThumbElectron,
  type ThumbHelper,
  type ThumbJob,
} from '../src/main/thumbnailer.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** PNG-looking answer bytes (the queue checks the signature only). */
const pngBytes = (tag: number) => new Uint8Array([...PNG_SIG, tag])
const job = (tag: number): ThumbJob => ({ bytes: new Uint8Array([tag]), type: 'image/png', width: 10, height: 10 })

/* ------------------------------------------------------------------ */
/* The queue, with fake helpers                                       */
/* ------------------------------------------------------------------ */

interface FakeHelper extends ThumbHelper {
  sent: { id: number; tag: number }[]
  destroyed: 'hung' | 'closed' | false
  failSend: boolean
}

function fakeHelpers() {
  const made: FakeHelper[] = []
  let nextId = 100
  const spawn = (): ThumbHelper => {
    const h: FakeHelper = {
      id: nextId++,
      sent: [],
      destroyed: false,
      failSend: false,
      send(id, j) {
        if (h.destroyed || h.failSend) throw new Error('Object has been destroyed')
        h.sent.push({ id, tag: j.bytes[0]! })
      },
      destroy(hung) {
        h.destroyed = hung ? 'hung' : 'closed'
      },
    }
    made.push(h)
    return h
  }
  return { spawn, made, last: () => made.at(-1)! }
}

/** Settled value of a promise, or 'pending'. */
async function state<T>(p: Promise<T>): Promise<T | 'pending' | { rejected: unknown }> {
  let out: T | 'pending' | { rejected: unknown } = 'pending'
  p.then(
    (v) => (out = v),
    (e: unknown) => (out = { rejected: e }),
  )
  await Promise.resolve()
  await Promise.resolve()
  return out
}

describe('ThumbQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts one helper lazily, sends nothing before it is ready, then runs at most two decodes at once', async () => {
    const f = fakeHelpers()
    const q = new ThumbQueue(f.spawn, { timeoutMs: 1000 })
    expect(f.made).toHaveLength(0)
    const jobs = [1, 2, 3, 4].map((t) => q.render(job(t)))
    expect(f.made).toHaveLength(1)
    const h = f.last()
    expect(h.sent).toEqual([])
    expect(q.queued).toBe(4)
    q.ready(h.id)
    expect(h.sent.map((s) => s.tag)).toEqual([1, 2])
    expect([q.inFlight, q.queued]).toEqual([2, 2])
    // One answer frees a slot for the next job, in order.
    expect(q.done(h.id, h.sent[1]!.id, pngBytes(2))).toBe(true)
    expect(await jobs[1]).toEqual(pngBytes(2))
    expect(h.sent.map((s) => s.tag)).toEqual([1, 2, 3])
    q.done(h.id, h.sent[0]!.id, pngBytes(1))
    q.done(h.id, h.sent[2]!.id, pngBytes(3))
    q.done(h.id, h.sent[3]!.id, pngBytes(4))
    expect(await Promise.all(jobs)).toEqual([1, 2, 3, 4].map(pngBytes))
    // The same helper keeps serving.
    const more = q.render(job(5))
    expect(f.made).toHaveLength(1)
    q.done(h.id, h.sent[4]!.id, pngBytes(5))
    expect(await more).toEqual(pngBytes(5))
  })

  it('takes answers only from the current helper, for jobs it has, and only PNG bytes of a sane size', async () => {
    const f = fakeHelpers()
    const q = new ThumbQueue(f.spawn, { timeoutMs: 1000, concurrency: 4 })
    const jobs = [1, 2, 3, 4].map((t) => q.render(job(t)))
    const h = f.last()
    // Another renderer (the brain window, the Forge page) cannot say it is ready or answer.
    q.ready(h.id + 1)
    expect(h.sent).toEqual([])
    q.ready(h.id)
    const [a, b, c, d] = h.sent.map((s) => s.id)
    expect(q.done(h.id + 1, a, pngBytes(9))).toBe(false)
    expect(await state(jobs[0]!)).toBe('pending')
    expect(q.done(h.id, 9999, pngBytes(9))).toBe(false)
    expect(q.done(h.id, String(a), pngBytes(9))).toBe(false)
    expect(q.done(h.id, a, pngBytes(1))).toBe(true)
    // Answered once only.
    expect(q.done(h.id, a, pngBytes(1))).toBe(false)
    q.done(h.id, b, new TextEncoder().encode('<svg onload=alert(1)>'))
    q.done(h.id, c, null)
    const huge = new Uint8Array(MAX_THUMB_PNG + 1)
    huge.set(PNG_SIG)
    q.done(h.id, d, huge)
    expect(await Promise.all(jobs)).toEqual([pngBytes(1), null, null, null])
  })

  it('gives a decode that takes too long no thumbnail, destroys the helper and starts the others over on a new one', async () => {
    const f = fakeHelpers()
    const q = new ThumbQueue(f.spawn, { timeoutMs: 1000 })
    const slow = q.render(job(1))
    const other = q.render(job(2))
    const waiting = q.render(job(3))
    const first = f.last()
    q.ready(first.id)
    vi.advanceTimersByTime(500)
    // Job 2 was sent at the same time: its answer comes in, job 3 takes its slot.
    q.done(first.id, first.sent[1]!.id, pngBytes(2))
    expect(await other).toEqual(pngBytes(2))
    vi.advanceTimersByTime(499)
    expect(await state(slow)).toBe('pending')
    vi.advanceTimersByTime(1)
    expect(await slow).toBeNull()
    expect(first.destroyed).toBe('hung')
    // Job 3 was in flight for 500 ms only: it goes to the next helper.
    expect(f.made).toHaveLength(2)
    const second = f.last()
    expect(q.helperId).toBe(second.id)
    // A late answer from the destroyed helper counts for nothing.
    expect(q.done(first.id, first.sent[2]!.id, pngBytes(3))).toBe(false)
    q.ready(second.id)
    expect(second.sent.map((s) => s.tag)).toEqual([3])
    q.done(second.id, second.sent[0]!.id, pngBytes(3))
    expect(await waiting).toEqual(pngBytes(3))
  })

  it('makes a new helper for the next job after a hung one was destroyed', async () => {
    const f = fakeHelpers()
    const q = new ThumbQueue(f.spawn, { timeoutMs: 1000 })
    const hung = q.render(job(1))
    q.ready(f.last().id)
    vi.advanceTimersByTime(1000)
    expect(await hung).toBeNull()
    expect(q.helperId).toBeNull()
    expect(f.made).toHaveLength(1)
    const next = q.render(job(2))
    expect(f.made).toHaveLength(2)
    const h = f.last()
    q.ready(h.id)
    q.done(h.id, h.sent[0]!.id, pngBytes(2))
    expect(await next).toEqual(pngBytes(2))
  })

  it('runs the jobs of a crashed helper again one at a time, so only the picture that crashes it gets none', async () => {
    const f = fakeHelpers()
    const q = new ThumbQueue(f.spawn, { timeoutMs: 1000 })
    const bad = q.render(job(1))
    const good = q.render(job(2))
    const later = q.render(job(3))
    const first = f.last()
    q.ready(first.id)
    q.gone(first.id)
    expect(first.destroyed).toBe('closed')
    const second = f.last()
    expect(second).not.toBe(first)
    q.ready(second.id)
    // The suspects run alone: job 1 first, nothing next to it.
    expect(second.sent.map((s) => s.tag)).toEqual([1])
    q.gone(second.id)
    expect(await bad).toBeNull()
    const third = f.last()
    q.ready(third.id)
    expect(third.sent.map((s) => s.tag)).toEqual([2])
    q.done(third.id, third.sent[0]!.id, pngBytes(2))
    expect(await good).toEqual(pngBytes(2))
    // Job 3 never ran in a crash: back to two at a time.
    expect(third.sent.map((s) => s.tag)).toEqual([2, 3])
    q.done(third.id, third.sent[1]!.id, pngBytes(3))
    expect(await later).toEqual(pngBytes(3))
  })

  it('treats a send to a window that is gone as a crash', async () => {
    const f = fakeHelpers()
    const q = new ThumbQueue(f.spawn, { timeoutMs: 1000 })
    const one = q.render(job(1))
    const first = f.last()
    first.failSend = true
    q.ready(first.id)
    const second = f.last()
    expect(second).not.toBe(first)
    q.ready(second.id)
    q.done(second.id, second.sent[0]!.id, pngBytes(1))
    expect(await one).toEqual(pngBytes(1))
  })

  it('fails the waiting jobs (not remembered) when a helper never gets ready or dies while starting', async () => {
    const f = fakeHelpers()
    const q = new ThumbQueue(f.spawn, { timeoutMs: 1000 })
    const a = q.render(job(1))
    const b = q.render(job(2))
    vi.advanceTimersByTime(1000)
    await expect(a).rejects.toBeInstanceOf(ThumbUnavailable)
    await expect(b).rejects.toThrow(/did not start/)
    expect(f.made[0]!.destroyed).toBe('hung')
    // The next job tries a new helper.
    const c = q.render(job(3))
    expect(f.made).toHaveLength(2)
    q.gone(f.last().id)
    await expect(c).rejects.toBeInstanceOf(ThumbUnavailable)
    // A helper that cannot even be created fails the job too.
    const broken = new ThumbQueue(() => {
      throw new Error('no windows')
    })
    await expect(broken.render(job(4))).rejects.toBeInstanceOf(ThumbUnavailable)
  })

  it('stops: destroys the helper and fails every job; a later job starts a new helper', async () => {
    const f = fakeHelpers()
    const q = new ThumbQueue(f.spawn, { timeoutMs: 1000 })
    const jobs = [1, 2, 3].map((t) => q.render(job(t)))
    q.ready(f.last().id)
    q.stop()
    for (const j of jobs) await expect(j).rejects.toBeInstanceOf(ThumbUnavailable)
    expect(f.last().destroyed).toBe('closed')
    expect([q.inFlight, q.queued, q.helperId]).toEqual([0, 0, null])
    // Nothing fires later.
    vi.advanceTimersByTime(5000)
    expect(f.made).toHaveLength(1)
    const again = q.render(job(4))
    expect(f.made).toHaveLength(2)
    q.ready(f.last().id)
    q.done(f.last().id, f.last().sent[0]!.id, pngBytes(4))
    expect(await again).toEqual(pngBytes(4))
  })

  it('ignores gone() and ready() from a helper it already replaced', async () => {
    const f = fakeHelpers()
    const q = new ThumbQueue(f.spawn, { timeoutMs: 1000 })
    const a = q.render(job(1))
    const first = f.last()
    q.ready(first.id)
    vi.advanceTimersByTime(1000)
    expect(await a).toBeNull()
    const b = q.render(job(2))
    const second = f.last()
    // The destroyed helper's own events arrive late.
    q.gone(first.id)
    q.ready(first.id)
    expect(q.helperId).toBe(second.id)
    expect(second.sent).toEqual([])
    q.ready(second.id)
    q.done(second.id, second.sent[0]!.id, pngBytes(2))
    expect(await b).toEqual(pngBytes(2))
  })
})

/* ------------------------------------------------------------------ */
/* The helper window, with fake Electron modules                      */
/* ------------------------------------------------------------------ */

function fakeElectron() {
  const windows: FakeWindow[] = []
  let nextId = 1
  class FakeContents extends EventEmitter {
    id = nextId++
    sent: unknown[][] = []
    crashed = false
    openHandler: ((d: { url: string }) => { action: string }) | null = null
    send(...args: unknown[]) {
      this.sent.push(args)
    }
    setWindowOpenHandler(fn: (d: { url: string }) => { action: string }) {
      this.openHandler = fn
    }
    forcefullyCrashRenderer() {
      this.crashed = true
      this.emit('render-process-gone', {}, { reason: 'killed' })
    }
  }
  class FakeWindow {
    webContents = new FakeContents()
    destroyed = false
    loaded: string[] = []
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      windows.push(this)
    }
    loadURL(url: string) {
      this.loaded.push(url)
      return Promise.resolve()
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
      this.webContents.emit('destroyed')
    }
  }
  const ses = {
    partitions: [] as string[],
    beforeRequest: null as null | ((d: { url: string }, cb: (r: { cancel: boolean }) => void) => void),
    permission: null as null | ((wc: unknown, p: string, cb: (ok: boolean) => void) => void),
    check: null as null | ((wc: unknown, p: string) => boolean),
  }
  const session = {
    fromPartition(partition: string) {
      ses.partitions.push(partition)
      return {
        webRequest: { onBeforeRequest: (fn: typeof ses.beforeRequest) => (ses.beforeRequest = fn) },
        setPermissionRequestHandler: (fn: typeof ses.permission) => (ses.permission = fn),
        setPermissionCheckHandler: (fn: typeof ses.check) => (ses.check = fn),
      }
    },
  }
  const electron = { BrowserWindow: FakeWindow, session } as unknown as ThumbElectron
  return { electron, windows, ses }
}

describe('Thumbnailer (the helper window)', () => {
  it('opens a hidden, sandboxed, isolated helper in its own session that loads its empty page and nothing else', async () => {
    const e = fakeElectron()
    const t = new Thumbnailer({ electron: e.electron, preload: '/app/dist/preload/thumb-preload.cjs' })
    const out = t.render(job(7))
    expect(e.windows).toHaveLength(1)
    const w = e.windows[0]!
    expect(w.options.show).toBe(false)
    expect(w.options.webPreferences).toMatchObject({
      preload: '/app/dist/preload/thumb-preload.cjs',
      partition: THUMB_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    })
    expect(THUMB_PARTITION.startsWith('persist:')).toBe(false)
    expect(w.loaded).toEqual([THUMB_PAGE])
    // Every request but its own page is refused, every permission denied, no popups, no navigation.
    const cancel = (url: string) => {
      let r: boolean | undefined
      e.ses.beforeRequest!({ url }, (x) => (r = x.cancel))
      return r
    }
    expect(e.ses.partitions).toEqual([THUMB_PARTITION])
    expect(cancel(THUMB_PAGE)).toBe(false)
    for (const url of ['https://example.com/', 'http://127.0.0.1:7457/', 'file:///etc/passwd', 'ws://127.0.0.1/', 'data:text/html,<p>other</p>']) {
      expect(cancel(url), url).toBe(true)
    }
    let granted: boolean | undefined
    e.ses.permission!(null, 'media', (ok) => (granted = ok))
    expect(granted).toBe(false)
    expect(e.ses.check!(null, 'clipboard-read')).toBe(false)
    expect(w.webContents.openHandler!({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    const nav = { prevented: false, preventDefault() {
      this.prevented = true
    } }
    w.webContents.emit('will-navigate', nav)
    expect(nav.prevented).toBe(true)
    // Ready from the helper, the job goes out with its size, the answer comes back.
    t.ready({ id: w.webContents.id + 50 })
    expect(w.webContents.sent).toEqual([])
    t.ready(w.webContents)
    const [channel, id, bytes, type, width, height] = w.webContents.sent[0]!
    expect([channel, bytes, type, width, height]).toEqual([THUMB_IPC.job, new Uint8Array([7]), 'image/png', 10, 10])
    t.done({ id: w.webContents.id + 50 }, id, pngBytes(1))
    t.done(w.webContents, id, pngBytes(7))
    expect(await out).toEqual(pngBytes(7))
  })

  it('ends a hung helper process on a timeout and opens a new one for the next job', async () => {
    vi.useFakeTimers()
    try {
      const e = fakeElectron()
      const t = new Thumbnailer({ electron: e.electron, preload: '/p.cjs', timeoutMs: 1000 })
      const hung = t.render(job(1))
      const first = e.windows[0]!
      t.ready(first.webContents)
      vi.advanceTimersByTime(1000)
      expect(await hung).toBeNull()
      expect(first.webContents.crashed).toBe(true)
      expect(first.destroyed).toBe(true)
      const next = t.render(job(2))
      expect(e.windows).toHaveLength(2)
      const second = e.windows[1]!
      t.ready(second.webContents)
      t.done(second.webContents, second.webContents.sent[0]![1], pngBytes(2))
      expect(await next).toEqual(pngBytes(2))
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries after the helper process crashes, and stop() closes it', async () => {
    const e = fakeElectron()
    const t = new Thumbnailer({ electron: e.electron, preload: '/p.cjs' })
    const a = t.render(job(1))
    const first = e.windows[0]!
    t.ready(first.webContents)
    first.webContents.emit('render-process-gone', {}, { reason: 'oom' })
    expect(first.destroyed).toBe(true)
    const second = e.windows[1]!
    t.ready(second.webContents)
    t.done(second.webContents, second.webContents.sent[0]![1], pngBytes(1))
    expect(await a).toEqual(pngBytes(1))
    const b = t.render(job(2))
    t.stop()
    await expect(b).rejects.toBeInstanceOf(ThumbUnavailable)
    // A healthy helper is closed, not crashed.
    expect(second.destroyed).toBe(true)
    expect(second.webContents.crashed).toBe(false)
    expect(e.windows).toHaveLength(2)
  })
})

/* ------------------------------------------------------------------ */
/* The helper's preload                                               */
/* ------------------------------------------------------------------ */

const PRELOAD = path.join(here, '..', 'src', 'preload', 'thumb-preload.cts')

async function preloadJs(): Promise<string> {
  const src = await fs.readFile(PRELOAD, 'utf8')
  return ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
}

describe('main process', () => {
  it('decodes no picture itself: thumbnails go to the helper, whose preload is built next to the others', async () => {
    const main = await fs.readFile(path.join(here, '..', 'src', 'main', 'main.ts'), 'utf8')
    // nativeImage decodes on the browser's UI thread (Windows' thumbnailer too, for a picture not in its cache).
    expect(main).not.toMatch(/\bnativeImage\s*[.,}]|createThumbnailFromPath\(|createFromPath\(|createFromBuffer\(/)
    expect(main).toMatch(/thumbnailer\.render\(/)
    expect(main).toMatch(/'thumb-preload\.cjs'/)
    expect(statSync(PRELOAD).isFile()).toBe(true)
  })
})

describe('thumb-preload', () => {
  it('keeps its IPC channel map in sync with THUMB_IPC', async () => {
    const src = await fs.readFile(PRELOAD, 'utf8')
    const block = /const IPC = \{([\s\S]*?)\} as const/.exec(src)?.[1] ?? ''
    expect(Object.fromEntries([...block.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]))).toEqual({ ...THUMB_IPC })
  })

  it('says it is ready, decodes a job scaled to its size into PNG bytes, and answers null when it cannot', async () => {
    const sent: unknown[][] = []
    const listeners = new Map<string, (e: unknown, ...args: unknown[]) => void>()
    const electron = {
      ipcRenderer: {
        send: (...args: unknown[]) => void sent.push(args),
        on: (channel: string, fn: (e: unknown, ...args: unknown[]) => void) => void listeners.set(channel, fn),
      },
    }
    const decoded: { type: string; size: number; options: unknown }[] = []
    const globals = {
      Blob,
      createImageBitmap: async (blob: Blob, options: { resizeWidth: number; resizeHeight: number }) => {
        decoded.push({ type: blob.type, size: blob.size, options })
        if (blob.size === 1) throw new DOMException('The source image could not be decoded.', 'InvalidStateError')
        return { width: options.resizeWidth, height: options.resizeHeight, close: vi.fn() }
      },
      OffscreenCanvas: class {
        constructor(
          readonly width: number,
          readonly height: number,
        ) {}
        getContext() {
          return { drawImage: vi.fn() }
        }
        convertToBlob(opts: { type: string }) {
          return Promise.resolve(new Blob([new Uint8Array([...PNG_SIG, this.width, this.height])], { type: opts.type }))
        }
      },
    }
    const require = (id: string): unknown => {
      if (id === 'electron') return electron
      throw new Error(`the sandboxed preload cannot require ${id}`)
    }
    const module = { exports: {} }
    new Function('require', 'module', 'exports', ...Object.keys(globals), await preloadJs())(require, module, module.exports, ...Object.values(globals))
    expect(sent).toEqual([[THUMB_IPC.ready]])
    const run = async (...args: unknown[]) => {
      const before = sent.length
      listeners.get(THUMB_IPC.job)!({}, ...args)
      await vi.waitFor(() => expect(sent.length).toBe(before + 1))
      return sent.at(-1)!
    }
    const out = await run(1, new Uint8Array([1, 2, 3]), 'image/jpeg', 96, 128)
    expect(out).toEqual([THUMB_IPC.done, 1, new Uint8Array([...PNG_SIG, 96, 128])])
    expect(decoded[0]).toEqual({ type: 'image/jpeg', size: 3, options: { resizeWidth: 96, resizeHeight: 128, resizeQuality: 'high' } })
    // Bytes the decoder refuses: null, and the helper carries on.
    expect(await run(2, new Uint8Array([0]), 'image/png', 10, 10)).toEqual([THUMB_IPC.done, 2, null])
    // Arguments that are not a job are never decoded.
    const count = decoded.length
    for (const bad of [
      [3, 'not bytes', 'image/png', 10, 10],
      [4, new Uint8Array([1, 2]), 42, 10, 10],
      [5, new Uint8Array([1, 2]), 'image/png', 0, 10],
      [6, new Uint8Array([1, 2]), 'image/png', 10, 5000],
      [7, new Uint8Array([1, 2]), 'image/png', 10.5, 10],
    ]) {
      expect((await run(...bad))[2]).toBeNull()
    }
    expect(decoded).toHaveLength(count)
  })
})

/* ------------------------------------------------------------------ */
/* The preload's decode in real Chromium                              */
/* ------------------------------------------------------------------ */

/** Chromium from Playwright's browser folder (PLAYWRIGHT_BROWSERS_PATH, else /opt/pw-browsers), if there is one. */
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

/** A GIF with a two-colour palette (left half red, right half blue), LZW-coded with a clear code before every pixel. */
function gif(w: number, h: number): Uint8Array {
  const out = [...'GIF89a'].map((c) => c.charCodeAt(0))
  out.push(w & 255, w >> 8, h & 255, h >> 8, 0x80, 0, 0, 255, 0, 0, 0, 0, 255)
  out.push(0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 2)
  // Minimum code size 2: clear = 4, end = 5, 3-bit codes while the table stays this small.
  const codes: number[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) codes.push(4, x < w / 2 ? 0 : 1)
  codes.push(5)
  const data: number[] = []
  let acc = 0
  let bits = 0
  for (const c of codes) {
    acc |= c << bits
    bits += 3
    while (bits >= 8) {
      data.push(acc & 255)
      acc >>= 8
      bits -= 8
    }
  }
  if (bits) data.push(acc & 255)
  for (let i = 0; i < data.length; i += 255) out.push(Math.min(255, data.length - i), ...data.slice(i, i + 255))
  out.push(0, 0x3b)
  return new Uint8Array(out)
}

/** A 24-bit BMP, left half red, right half blue. */
function bmp(w: number, h: number): Uint8Array {
  const row = Math.ceil((w * 3) / 4) * 4
  const size = 54 + row * h
  const b = new Uint8Array(size)
  const v = new DataView(b.buffer)
  b[0] = 0x42
  b[1] = 0x4d
  v.setUint32(2, size, true)
  v.setUint32(10, 54, true)
  v.setUint32(14, 40, true)
  v.setInt32(18, w, true)
  v.setInt32(22, h, true)
  v.setUint16(26, 1, true)
  v.setUint16(28, 24, true)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = 54 + y * row + x * 3
      if (x < w / 2) b[at + 2] = 255
      else b[at] = 255
    }
  }
  return b
}

/** EXIF APP1 with orientation `o` (big endian), for a JPEG made by the browser. */
function withOrientation(jpeg: Uint8Array, o: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0, 0, 0]
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body, ...jpeg.subarray(2)])
}

describe('thumb-preload decoding in Chromium', () => {
  let browser: Browser | null = null
  let js = ''

  beforeAll(async () => {
    js = await preloadJs()
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

  /**
   * Runs the preload in a page with a stand-in `electron` module, feeds it one
   * job per picture (the size from thumbTarget, as main computes it) and
   * returns what it answered: the PNG's size and a few pixels, or null.
   */
  async function decode(pictures: { name: string; bytes: number[]; type: string; width: number; height: number }[]) {
    const page = await browser!.newPage()
    try {
      await page.setContent('<!doctype html><title>helper</title>')
      return await page.evaluate(
        async ({ js, pictures, channels }) => {
          const sent: unknown[][] = []
          const listeners: Record<string, (e: unknown, ...args: unknown[]) => void> = {}
          const electron = {
            ipcRenderer: {
              send: (...args: unknown[]) => void sent.push(args),
              on: (channel: string, fn: (e: unknown, ...args: unknown[]) => void) => void (listeners[channel] = fn),
            },
          }
          const module = { exports: {} }
          new Function('require', 'module', 'exports', js)(() => electron, module, module.exports)
          const out: Record<string, unknown> = { ready: sent[0]?.[0] === channels.ready }
          for (const [i, p] of pictures.entries()) {
            listeners[channels.job]!({}, i, new Uint8Array(p.bytes), p.type, p.width, p.height)
            const deadline = Date.now() + 10_000
            while (!sent.some((s) => s[0] === channels.done && s[1] === i) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
            const answer = sent.find((s) => s[0] === channels.done && s[1] === i)
            const png = answer?.[2] as Uint8Array | null | undefined
            if (!png) {
              out[p.name] = answer ? png : 'no answer'
              continue
            }
            const bmp = await createImageBitmap(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
            const c = new OffscreenCanvas(bmp.width, bmp.height)
            const g = c.getContext('2d')!
            g.drawImage(bmp, 0, 0)
            const at = (x: number, y: number) => {
              const [r, , b] = g.getImageData(x, y, 1, 1).data
              return (r ?? 0) > 128 ? 'red' : (b ?? 0) > 128 ? 'blue' : 'other'
            }
            out[p.name] = {
              png: Array.from(png.slice(0, 4)).join(),
              width: bmp.width,
              height: bmp.height,
              topLeft: at(1, 1),
              topRight: at(bmp.width - 2, 1),
              bottomLeft: at(1, bmp.height - 2),
            }
          }
          return out
        },
        { js, pictures, channels: THUMB_IPC },
      )
    } finally {
      await page.close()
    }
  }

  /** Pictures the browser encodes itself: 400 × 200, left half red, right half blue. */
  async function encoded(): Promise<Record<'png' | 'jpeg' | 'webp' | 'big', number[]>> {
    const page = await browser!.newPage()
    try {
      return await page.evaluate(async () => {
        const make = async (w: number, h: number, type: string) => {
          const c = new OffscreenCanvas(w, h)
          const g = c.getContext('2d')!
          g.fillStyle = '#f00'
          g.fillRect(0, 0, w / 2, h)
          g.fillStyle = '#00f'
          g.fillRect(w / 2, 0, w / 2, h)
          return Array.from(new Uint8Array(await (await c.convertToBlob({ type, quality: 0.95 })).arrayBuffer()))
        }
        return {
          png: await make(400, 200, 'image/png'),
          jpeg: await make(400, 200, 'image/jpeg'),
          webp: await make(400, 200, 'image/webp'),
          big: await make(6000, 4000, 'image/png'),
        }
      })
    } finally {
      await page.close()
    }
  }

  it('decodes PNG, JPEG, WebP, GIF and BMP into PNG thumbnails fitted to the size, and nothing from garbage', async (ctx) => {
    if (!browser) return ctx.skip()
    const made = await encoded()
    const job = (name: string, bytes: Uint8Array | number[], px: number) => {
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      const t = thumbTarget(b, px)
      if (!t) throw new Error(`no thumbnail target for ${name}`)
      return { name, bytes: Array.from(b), ...t }
    }
    const out = await decode([
      job('png', made.png, 128),
      job('jpeg', made.jpeg, 128),
      job('webp', made.webp, 128),
      job('gif', gif(400, 200), 128),
      job('bmp', bmp(400, 200), 128),
      job('png512', made.png, 512),
      job('big', made.big, 512),
      // Stored 400 × 200 and shown turned a quarter clockwise (EXIF 6): 64 × 128, red on top.
      job('turned', withOrientation(new Uint8Array(made.jpeg), 6), 128),
      { name: 'garbage', bytes: [...Array(64).keys()], type: 'image/png', width: 10, height: 10 },
      { name: 'truncated', bytes: made.png.slice(0, 200), type: 'image/png', width: 128, height: 64 },
    ])
    expect(out['ready']).toBe(true)
    const halves = { png: '137,80,78,71', topLeft: 'red', topRight: 'blue', bottomLeft: 'red' }
    for (const name of ['png', 'jpeg', 'webp', 'gif', 'bmp']) expect(out[name], name).toEqual({ ...halves, width: 128, height: 64 })
    // Smaller than asked: never enlarged.
    expect(out['png512']).toEqual({ ...halves, width: 400, height: 200 })
    expect(out['big']).toEqual({ ...halves, width: 512, height: 341 })
    expect(out['turned']).toEqual({ png: '137,80,78,71', width: 64, height: 128, topLeft: 'red', topRight: 'red', bottomLeft: 'blue' })
    expect(out['garbage']).toBeNull()
    expect(out['truncated']).toBeNull()
  }, 60_000)
})
