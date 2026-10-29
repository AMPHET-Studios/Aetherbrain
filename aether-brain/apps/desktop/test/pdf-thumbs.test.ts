import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { FsVault, isAssetName, isPdfName } from '../src/main/fsvault.js'
import { MAX_PDF_BYTES, PDF_HEAD_BYTES, pdfKindOf } from '../src/main/assets.js'
import { PDF_FILES, PDF_SCHEME, PDF_URL_PREFIX, THUMB_IPC, ThumbQueue, Thumbnailer, type ThumbElectron, type ThumbHelper, type ThumbJob } from '../src/main/thumbnailer.js'
import { previewKindOf } from '@aether/core'

/**
 * PDFs (docs/COSMOLOGY.md, *Every file is a satellite*): a `.pdf` shows its first page. Main checks the file starts like a PDF and sends the
 * bytes; the helper's page runs pdf.js on them (src/pdf-host/host.mjs, served by the helper session's `aether-pdf` scheme, three files and
 * nothing else); the helper's preload carries the bytes over and the pixels back. pdf.js itself is exercised in the real app and
 * in Chromium, not here: these tests pin everything around it.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const PRELOAD = path.join(here, '..', 'src', 'preload', 'thumb-preload.cts')
const enc = new TextEncoder()

describe('telling a PDF', () => {
  it('wants %PDF- near the start, even after a few bytes of junk', () => {
    expect(pdfKindOf(enc.encode('%PDF-1.7\n1 0 obj'))).toBe(true)
    expect(pdfKindOf(enc.encode('\n\n   %PDF-1.4'))).toBe(true)
    expect(pdfKindOf(enc.encode('<html>%PDF</html>'))).toBe(false)
    expect(pdfKindOf(enc.encode('not a pdf'))).toBe(false)
    expect(pdfKindOf(new Uint8Array(0))).toBe(false)
    // Past the first 1,024 bytes it is too late to count.
    const late = new Uint8Array(PDF_HEAD_BYTES + 20)
    late.set(enc.encode('%PDF-1.7'), PDF_HEAD_BYTES + 5)
    expect(pdfKindOf(late)).toBe(false)
    expect(MAX_PDF_BYTES).toBe(64 * 1024 * 1024)
  })

  it('names a .pdf a document to preview, not a picture, and opens it only through previewAbs', async () => {
    expect(isPdfName('Form.PDF')).toBe(true)
    expect(isPdfName('form.pdf.txt')).toBe(false)
    expect(isAssetName('form.pdf')).toBe(false)
    expect(previewKindOf('Docs/form.PDF')).toBe('pdf')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-pdf-door-'))
    try {
      await fs.mkdir(path.join(dir, 'Docs'))
      await fs.writeFile(path.join(dir, 'Docs', 'form.pdf'), enc.encode('%PDF-1.4'))
      const vault = new FsVault([dir])
      expect(await vault.previewAbs('Docs/form.pdf')).not.toBeNull()
      expect(await vault.assetAbs('Docs/form.pdf')).toBeNull()
      expect(await vault.modelAbs('Docs/form.pdf')).toBeNull()
      expect(await vault.previewAbs('../outside.pdf')).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the helper queue for a PDF', () => {
  it('hands the PDF job to the helper as it is and gives back the PNG it answers', async () => {
    const sent: { id: number; job: ThumbJob }[] = []
    const helper: ThumbHelper = { id: 1, send: (id, job) => void sent.push({ id, job }), destroy: () => undefined }
    const q = new ThumbQueue(() => helper, { timeoutMs: 1000 })
    const bytes = enc.encode('%PDF-1.4')
    const out = q.render({ pdf: bytes, px: 256 })
    q.ready(1)
    expect(sent[0]!.job).toEqual({ pdf: bytes, px: 256 })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3])
    q.done(1, sent[0]!.id, png)
    expect(await out).toEqual(png)
    expect(THUMB_IPC.pdf).toBe('thumbs:pdf')
  })
})

describe('what the helper session serves for the PDF page', () => {
  async function thumbnailer(dir?: string) {
    const electron = { BrowserWindow: class {}, session: { fromPartition: () => ({}) } } as unknown as ThumbElectron
    return new Thumbnailer({ electron, preload: 'x', ...(dir ? { pdfDir: dir } : {}) })
  }

  it('hands out its three files, as scripts any origin may load, and nothing else', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-pdfjs-'))
    try {
      for (const name of [...PDF_FILES, 'secret.txt']) await fs.writeFile(path.join(dir, name), `// ${name}`)
      const t = await thumbnailer(dir)
      for (const name of PDF_FILES) {
        const res = await t.servePdf(PDF_URL_PREFIX + name)
        expect(res.status, name).toBe(200)
        expect(await res.text()).toBe(`// ${name}`)
        expect(res.headers.get('content-type')).toBe('text/javascript')
        expect(res.headers.get('access-control-allow-origin')).toBe('*')
      }
      // A query string does not make another file; anything not on the list, and anything outside the folder, is not there.
      expect((await t.servePdf(PDF_URL_PREFIX + 'host.mjs?x=1')).status).toBe(200)
      for (const bad of ['secret.txt', '../secret.txt', '..%2Fsecret.txt', 'sub/host.mjs', '', 'host.mjs/', 'HOST.MJS']) {
        expect((await t.servePdf(PDF_URL_PREFIX + bad)).status, bad).toBe(404)
      }
      expect((await t.servePdf('aether-video://clip/host.mjs')).status).toBe(404)
      expect((await t.servePdf('https://example.com/host.mjs')).status).toBe(404)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('serves nothing when it was given no folder, or the folder has not got the file', async () => {
    expect((await (await thumbnailer()).servePdf(PDF_URL_PREFIX + 'host.mjs')).status).toBe(404)
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-pdfjs-empty-'))
    try {
      expect((await (await thumbnailer(empty)).servePdf(PDF_URL_PREFIX + 'host.mjs')).status).toBe(404)
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
    expect(PDF_SCHEME).toBe('aether-pdf')
  })
})

describe('the helper page for a PDF', () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

  /** The preload with a stand-in page: a window that records messages, and a page module that answers the way host.mjs does. */
  async function helper(opts: { loads?: boolean; page?: { width: number; height: number } | null } = {}) {
    const loads = opts.loads ?? true
    const listeners: ((e: { source: unknown; data: unknown }) => void)[] = []
    const posted: { message: Record<string, unknown>; transfer?: unknown[] }[] = []
    const scripts: Record<string, unknown>[] = []
    const win: Record<string, unknown> = {}
    const deliver = (data: unknown) => setTimeout(() => listeners.slice().forEach((l) => l({ source: win, data })), 0)
    Object.assign(win, {
      addEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => {
        if (type === 'message') listeners.push(fn)
      },
      removeEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => {
        const i = listeners.indexOf(fn)
        if (type === 'message' && i >= 0) listeners.splice(i, 1)
      },
      postMessage: (message: Record<string, unknown>, _origin: string, transfer?: unknown[]) => {
        posted.push({ message, transfer })
        if (message['aether'] !== 'pdf') return
        const page = opts.page === undefined ? { width: 3, height: 2 } : opts.page
        deliver(
          page
            ? { aether: 'pdf-done', id: message['id'], width: page.width, height: page.height, buffer: new ArrayBuffer(page.width * page.height * 4) }
            : { aether: 'pdf-done', id: message['id'], buffer: null },
        )
      },
    })
    const puts: { width: number; height: number }[] = []
    const globals = {
      window: win,
      ImageData: class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
      document: {
        documentElement: {
          appendChild: (script: Record<string, unknown>) => {
            scripts.push(script)
            if (loads) deliver({ aether: 'pdf-ready' })
            else (script['onerror'] as () => void)()
          },
        },
        createElement: (tag: string) => {
          if (tag === 'script') return {}
          return {
            width: 0,
            height: 0,
            getContext: () => ({ putImageData: (img: { width: number; height: number }) => void puts.push(img) }),
            toDataURL(type: string) {
              return 'data:' + type + ';base64,' + Buffer.from([...PNG, this.width, this.height]).toString('base64')
            },
          }
        },
      },
    }
    const src = await fs.readFile(PRELOAD, 'utf8')
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const sent: unknown[][] = []
    const on = new Map<string, (e: unknown, ...args: unknown[]) => void>()
    const electron = { ipcRenderer: { send: (...a: unknown[]) => void sent.push(a), on: (c: string, fn: (e: unknown, ...a: unknown[]) => void) => void on.set(c, fn) } }
    const module = { exports: {} as Record<string, unknown> }
    new Function('require', 'module', 'exports', ...Object.keys(globals), js)(() => electron, module, module.exports, ...Object.values(globals))
    const run = async (...args: unknown[]) => {
      const before = sent.length
      on.get(THUMB_IPC.pdf)!({}, ...args)
      for (let i = 0; i < 300 && sent.length === before; i++) await new Promise((r) => setTimeout(r, 5))
      return sent.at(-1)!
    }
    return { run, posted, scripts, puts }
  }

  it('loads the page module once, posts the PDF over with its bytes transferred, and answers the PNG of the pixels that come back', async () => {
    const h = await helper()
    const pdf = enc.encode('%PDF-1.4 some bytes')
    expect(await h.run(1, pdf, 64)).toEqual([THUMB_IPC.done, 1, new Uint8Array([...PNG, 3, 2])])
    expect(await h.run(2, pdf, 64)).toEqual([THUMB_IPC.done, 2, new Uint8Array([...PNG, 3, 2])])
    expect(h.scripts).toHaveLength(1)
    expect(h.scripts[0]).toMatchObject({ type: 'module', src: PDF_URL_PREFIX + 'host.mjs' })
    const jobs = h.posted.filter((p) => p.message['aether'] === 'pdf')
    expect(jobs).toHaveLength(2)
    expect(jobs[0]!.message).toMatchObject({ aether: 'pdf', id: 1, px: 64 })
    // The bytes go over as a copy that is transferred, not shared with anything the caller holds.
    expect(jobs[0]!.transfer).toHaveLength(1)
    expect(jobs[0]!.transfer![0]).toBe(jobs[0]!.message['bytes'])
    expect(jobs[0]!.message['bytes']).not.toBe(pdf.buffer)
    expect(new Uint8Array(jobs[0]!.message['bytes'] as ArrayBuffer)).toEqual(pdf)
    expect(h.puts[0]).toMatchObject({ width: 3, height: 2 })
  })

  it('answers null when the page module cannot load, when the page cannot be drawn, and for arguments that are no job', async () => {
    const noHost = await helper({ loads: false })
    expect((await noHost.run(1, enc.encode('%PDF-'), 64))[2]).toBeNull()
    const noPage = await helper({ page: null })
    expect((await noPage.run(1, enc.encode('%PDF-'), 64))[2]).toBeNull()
    const h = await helper()
    for (const [i, bad] of ([
      ['not bytes', 64],
      [enc.encode('%PDF-'), 0],
      [enc.encode('%PDF-'), 5000],
      [enc.encode('%PDF-'), '64'],
    ] as const).entries()) {
      expect((await h.run(10 + i, ...bad))[2], String(i)).toBeNull()
    }
    expect(h.scripts).toHaveLength(0)
  })

  it('refuses pixels whose size does not fit their numbers', async () => {
    const h = await helper({ page: { width: 0, height: 5 } })
    expect((await h.run(1, enc.encode('%PDF-'), 64))[2]).toBeNull()
  })
})
