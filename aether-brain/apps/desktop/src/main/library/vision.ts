/**
 * The librarian's eyes: a hidden helper renderer that looks at one picture at
 * a time and says its colours (always) and, once the vision model is on disk,
 * how well it matches each of the librarian's descriptions (CLIP zero-shot:
 * types, genres, subjects). Main never decodes a picture: it reads the file
 * and sends the bytes, like it does for thumbnails.
 *
 * The helper is locked down like the thumbnail helper: sandboxed,
 * context-isolated, an in-memory session of its own that refuses every
 * request but its own scheme (`aether-vision://app/`, served here: the built
 * page, the ONNX runtime and the model files from the app's data folder) and
 * every permission. It has no network at all, so the model runs offline by
 * construction. Its pages are cross-origin isolated (COOP/COEP), which lets
 * the ONNX runtime use several threads.
 *
 * The bookkeeping is a HelperQueue (crash isolation, timeouts, answers only
 * from the current helper). No electron import at runtime: main.ts hands in
 * the modules.
 */
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron'
import { HelperQueue, type QueueHelper } from '../helper-queue.js'
import type { ColourStats } from './classify.js'
import { VISION_MODEL_ID, type VisionModel } from './vision-model.js'

/** IPC between main and the helper (vision-preload.cts keeps a copy: a sandboxed preload cannot import this file). */
export const VISION_IPC = {
  /** helper → main: listening for jobs. */
  ready: 'vision:ready',
  /** main → helper: (id, bytes, type, width, height, sets). */
  job: 'vision:job',
  /** helper → main: (id, answer). */
  done: 'vision:done',
} as const

/** The helper's own scheme (registered as privileged in main.ts before the app is ready). */
export const VISION_SCHEME = 'aether-vision'
export const VISION_ORIGIN = `${VISION_SCHEME}://app/`
/** Where the helper finds the model files (transformers.js `localModelPath`). */
export const VISION_MODELS_URL = `${VISION_ORIGIN}models/`
export const VISION_PAGE = `${VISION_ORIGIN}index.html?model=${encodeURIComponent(VISION_MODEL_ID)}`
/** The helper's session: in memory only, nothing of it is written to disk. */
export const VISION_PARTITION = 'aether-vision'
/** Longest one look may take: the first one of a run loads the model (seconds; longer on a slow disk). */
export const VISION_JOB_TIMEOUT = 120_000
/** Longest the helper may take to load its page. */
export const VISION_START_TIMEOUT = 30_000
/** Pictures in the helper at once: one decodes while the other is looked at. */
export const VISION_CONCURRENCY = 2

/** Descriptions to compare one picture with, by set (`type`, `genre:art` …). */
export type LabelSets = Record<string, readonly string[]>

export interface VisionJob {
  bytes: Uint8Array
  /** Media type of the bytes. */
  type: string
  /** Size the header says (lets the helper decode it already scaled), when known. */
  width: number | null
  height: number | null
  /** Null: colours only (no model). */
  sets: LabelSets | null
}

export interface VisionAnswer {
  colours: ColourStats
  /** Per set, a probability per description (they sum to 1); null without the model. */
  probs: Record<string, number[]> | null
  /** Why the model could not look, when it could not (it failed to load). */
  modelError: string | null
}

/** A look that got no answer through no fault of its picture (the helper could not start, or was stopped). */
export class VisionUnavailable extends Error {
  override name = 'VisionUnavailable'
}

const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi

/** The helper's answer when it is one; anything else is no answer (the picture could not be decoded). */
export function visionAnswerOf(v: unknown): VisionAnswer | null {
  if (!v || typeof v !== 'object') return null
  const a = v as Record<string, unknown>
  const c = a['colours'] as Record<string, unknown> | null | undefined
  if (!c || typeof c !== 'object') return null
  if (!finite(c['lum'], 0, 1) || !finite(c['sat'], 0, 1) || !finite(c['warm'], -1, 1) || !finite(c['contrast'], 0, 1)) return null
  const colours: ColourStats = { lum: c['lum'], sat: c['sat'], warm: c['warm'], contrast: c['contrast'] }
  let probs: Record<string, number[]> | null = null
  const p = a['probs']
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    probs = {}
    for (const [k, list] of Object.entries(p as Record<string, unknown>)) {
      if (!Array.isArray(list) || list.length > 256 || !list.every((x) => finite(x, 0, 1))) return null
      probs[k] = list as number[]
    }
  }
  const e = a['modelError']
  return { colours, probs, modelError: typeof e === 'string' && e ? e.slice(0, 500) : null }
}

/** Media types the helper's scheme serves, by extension. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
}

/** Every answer of the helper's scheme: same-origin only, cross-origin isolated (threads for the ONNX runtime). */
const ISOLATED = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
}

/** The Electron modules the helper uses (main.ts passes the real ones). */
export interface VisionElectron {
  BrowserWindow: new (options: BrowserWindowConstructorOptions) => BrowserWindow
  session: { fromPartition(partition: string): Session }
}

export interface VisionHelperOptions {
  electron: VisionElectron
  /** Absolute path of the built vision-preload.cjs. */
  preload: string
  /** The built helper page's folder (dist/vision: index.html, its script, ort/). */
  appDir: string
  model: VisionModel
  timeoutMs?: number
}

interface Sender {
  id: number
}

export class VisionHelper {
  private readonly queue: HelperQueue<VisionJob, VisionAnswer>
  private sessionReady = false

  constructor(private opts: VisionHelperOptions) {
    this.queue = new HelperQueue<VisionJob, VisionAnswer>(() => this.spawn(), visionAnswerOf, {
      name: 'vision helper',
      unavailable: (message) => new VisionUnavailable(message),
      stopped: 'The librarian stopped looking',
      timeoutMs: opts.timeoutMs ?? VISION_JOB_TIMEOUT,
      startTimeoutMs: VISION_START_TIMEOUT,
      concurrency: VISION_CONCURRENCY,
    })
  }

  /**
   * What the helper sees in one picture, or null when it cannot be decoded in
   * time. Probabilities come back only for the sets asked, each as long as
   * its set. Rejects with VisionUnavailable when no helper answered.
   */
  async look(job: VisionJob): Promise<VisionAnswer | null> {
    const answer = await this.queue.render(job)
    if (!answer || !answer.probs || !job.sets) return answer ? { ...answer, probs: null } : null
    const probs: Record<string, number[]> = {}
    for (const [k, labels] of Object.entries(job.sets)) {
      const p = answer.probs[k]
      if (!p || p.length !== labels.length) return { ...answer, probs: null, modelError: answer.modelError ?? 'The model answered for other descriptions' }
      probs[k] = p
    }
    return { ...answer, probs }
  }

  ready(sender: Sender): void {
    this.queue.ready(sender.id)
  }

  done(sender: Sender, id: unknown, answer: unknown): void {
    this.queue.done(sender.id, id, answer)
  }

  /** Destroy the helper (the librarian finished or the app quits); the next look starts a new one. */
  stop(): void {
    this.queue.stop()
  }

  /**
   * One request of the helper's session: a file of the built page under
   * `aether-vision://app/`, or a model file under `…/models/<model id>/`;
   * anything else 404.
   */
  async serve(url: string, method = 'GET'): Promise<Response> {
    const notFound = () => new Response(null, { status: 404, headers: ISOLATED })
    if (!url.startsWith(VISION_ORIGIN)) return notFound()
    let rel: string
    try {
      rel = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''))
    } catch {
      return notFound()
    }
    if (!rel || rel.split('/').some((s) => s === '..' || s === '.' || s === '')) return notFound()
    let abs: string | null
    const modelPrefix = `models/${VISION_MODEL_ID}/`
    if (rel.startsWith('models/')) {
      abs = rel.startsWith(modelPrefix) ? this.opts.model.fileOf(rel.slice(modelPrefix.length)) : null
    } else {
      const root = path.resolve(this.opts.appDir)
      const p = path.resolve(root, ...rel.split('/'))
      abs = p.startsWith(root + path.sep) ? p : null
    }
    if (!abs) return notFound()
    const st = await fs.stat(abs).catch(() => null)
    if (!st?.isFile()) return notFound()
    const headers = { ...ISOLATED, 'Content-Type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': String(st.size), 'Cache-Control': 'no-store' }
    if (method === 'HEAD') return new Response(null, { status: 200, headers })
    const body = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream<Uint8Array>
    return new Response(body, { status: 200, headers })
  }

  private spawn(): QueueHelper<VisionJob> {
    const { BrowserWindow: Win } = this.opts.electron
    this.prepareSession()
    const w = new Win({
      show: false,
      width: 64,
      height: 64,
      skipTaskbar: true,
      focusable: false,
      paintWhenInitiallyHidden: false,
      title: 'Aether Brain librarian',
      webPreferences: {
        preload: this.opts.preload,
        partition: VISION_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        webgl: false,
      },
    })
    const wc = w.webContents
    const id = wc.id
    const gone = () => this.queue.gone(id)
    wc.on('render-process-gone', gone)
    wc.once('destroyed', gone)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (e) => e.preventDefault())
    // No WebRTC either (its UDP never passes through the session's request filter).
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    w.loadURL(VISION_PAGE).catch(gone)
    return {
      id,
      send: (jobId, job) => wc.send(VISION_IPC.job, jobId, job.bytes, job.type, job.width, job.height, job.sets),
      destroy: (hung) => {
        if (w.isDestroyed()) return
        if (hung) wc.forcefullyCrashRenderer()
        w.destroy()
      },
    }
  }

  /** The helper's session, set up once: its own scheme and local blobs, nothing else, no permission. */
  private prepareSession(): void {
    if (this.sessionReady) return
    this.sessionReady = true
    const ses = this.opts.electron.session.fromPartition(VISION_PARTITION)
    ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !(details.url.startsWith(VISION_ORIGIN) || details.url.startsWith('blob:')) }))
    // Belt and braces: anything that got past the filter would go to a proxy that is not there.
    void ses.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '' })
    ses.protocol.handle(VISION_SCHEME, (req) => this.serve(req.url, req.method))
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
  }
}
