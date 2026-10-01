/**
 * Picture thumbnails, made off the main process. Decoding in main
 * (nativeImage) runs on the browser's UI thread, so every 8k concept-art PNG
 * missing from Windows' thumbnail cache froze the whole app for hundreds of
 * ms. Here a hidden helper renderer does it: main reads the file and sends
 * its bytes; the helper decodes them with Chromium's own decoders, scaled
 * while decoding (createImageBitmap), and sends back PNG bytes.
 *
 * The helper is locked down: sandboxed, context-isolated, an empty page, and
 * an in-memory session of its own that refuses every request (web, file,
 * anything) and every permission. The bytes come from main; it reads nothing.
 * A video is too big to send whole: main hands the helper a one-job address
 * (`aether-video://clip/<token>`) that its session serves from that one file,
 * in the ranges the helper's media player asks for, and only while the job
 * runs. The helper takes one still frame of it and never plays it.
 *
 * ThumbQueue is the bookkeeping, pure (tested with a fake helper): at most
 * two decodes at once, a timeout per decode (the picture gets no thumbnail,
 * the helper is destroyed, the next job starts a new one), answers taken only
 * from the helper itself, and after a crash the jobs that were in flight run
 * again one at a time, so the picture that crashes it is the only one without
 * a thumbnail. Thumbnailer is the Electron side: no electron import at
 * runtime (types only), main.ts hands in the modules.
 */
import { randomUUID } from 'node:crypto'
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron'
import { serveVideo, type ThumbTarget } from './assets.js'

/** IPC between main and the helper (thumb-preload.cts keeps a copy: a sandboxed preload cannot import this file). */
export const THUMB_IPC = {
  /** helper → main: listening for jobs. */
  ready: 'thumbs:ready',
  /** main → helper: (id, bytes, type, width, height). */
  job: 'thumbs:job',
  /** helper → main: (id, PNG bytes or null). */
  done: 'thumbs:done',
  /** main → helper: (id, video address, longest side): a still frame of a video, fitted to the size. */
  video: 'thumbs:video',
} as const

/**
 * The scheme the helper's session serves videos on (registered as privileged
 * in main.ts before the app is ready: streamable, CORS-enabled).
 */
export const VIDEO_SCHEME = 'aether-video'
/** Addresses of videos handed to the helper: `aether-video://clip/<token>`. */
export const VIDEO_URL_PREFIX = `${VIDEO_SCHEME}://clip/`

/** The helper's session: in memory only (no `persist:`), so nothing of it is written to disk. */
export const THUMB_PARTITION = 'aether-thumbs'
/** The helper's page: empty, the work is all in its preload. The one URL its session lets load. */
export const THUMB_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>Aether Brain thumbnails</title>')}`
/** Longest one decode may take, and the helper to start. */
export const THUMB_JOB_TIMEOUT = 20_000
/** Decodes running in the helper at once. */
export const THUMB_CONCURRENCY = 2
/** Largest answer taken from the helper: a 1024 px PNG is a few MB at most. */
export const MAX_THUMB_PNG = 16 * 1024 * 1024

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** One picture to decode: its whole file and what to make of it. */
export interface PictureJob extends ThumbTarget {
  bytes: Uint8Array
}

/** One video to take a still frame of: where the helper's session serves it, and the longest side of the still. */
export interface VideoJob {
  url: string
  px: number
}

export type ThumbJob = PictureJob | VideoJob

/**
 * A job that got no answer through no fault of its picture (the helper could
 * not start, or was stopped): not worth remembering, it may be asked again.
 */
export class ThumbUnavailable extends Error {
  override name = 'ThumbUnavailable'
}

/** One helper as the queue sees it (the hidden window in the app, a fake in tests). */
export interface ThumbHelper {
  /** Its webContents id: an answer from anyone else is ignored. */
  readonly id: number
  send(id: number, job: ThumbJob): void
  /** Close it for good; `hung`: it stopped answering, end its process instead of asking it to close. */
  destroy(hung: boolean): void
}

export interface ThumbQueueOptions {
  timeoutMs?: number
  concurrency?: number
}

interface Waiting {
  job: ThumbJob
  resolve(png: Uint8Array | null): void
  reject(err: Error): void
  /** In flight when a helper crashed: from then on it runs alone, and gets no thumbnail if a helper crashes again. */
  suspect: boolean
}

interface Running {
  w: Waiting
  timer: ReturnType<typeof setTimeout>
}

/** The helper's answer when it is PNG bytes of a sane size; anything else is no thumbnail. */
function pngOf(v: unknown): Uint8Array | null {
  if (!(v instanceof Uint8Array) || v.length < PNG_SIG.length || v.length > MAX_THUMB_PNG) return null
  return PNG_SIG.every((x, i) => v[i] === x) ? v : null
}

/**
 * Jobs for the helper: started lazily, `concurrency` in flight, the rest
 * waiting in order. Every job gets exactly one outcome: PNG bytes, null (the
 * picture cannot be decoded, took too long, or crashed the helper twice), or
 * a ThumbUnavailable rejection (no helper could answer).
 */
export class ThumbQueue {
  readonly timeoutMs: number
  readonly concurrency: number
  private helper: ThumbHelper | null = null
  /** The current helper said it is ready. */
  private listening = false
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private waiting: Waiting[] = []
  private running = new Map<number, Running>()
  private seq = 0

  /** `spawn` starts a helper; the app then calls ready() once it listens and gone() when it crashes or is destroyed. */
  constructor(
    private spawn: () => ThumbHelper,
    opts: ThumbQueueOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? THUMB_JOB_TIMEOUT
    this.concurrency = opts.concurrency ?? THUMB_CONCURRENCY
  }

  /** Jobs waiting for a slot. */
  get queued(): number {
    return this.waiting.length
  }

  /** Jobs being decoded. */
  get inFlight(): number {
    return this.running.size
  }

  /** The current helper's id, or null when there is none. */
  get helperId(): number | null {
    return this.helper?.id ?? null
  }

  render(job: ThumbJob): Promise<Uint8Array | null> {
    return new Promise<Uint8Array | null>((resolve, reject) => {
      this.waiting.push({ job, resolve, reject, suspect: false })
      this.pump()
    })
  }

  /** `thumbs:ready` from `sender`: the current helper listens now. */
  ready(sender: number): void {
    if (!this.helper || sender !== this.helper.id || this.listening) return
    this.listening = true
    this.clearStart()
    this.pump()
  }

  /** `thumbs:done` from `sender`. False when it is not the current helper answering a job it has. */
  done(sender: number, id: unknown, png: unknown): boolean {
    if (!this.helper || sender !== this.helper.id || typeof id !== 'number') return false
    const r = this.running.get(id)
    if (!r) return false
    this.running.delete(id)
    clearTimeout(r.timer)
    r.w.resolve(pngOf(png))
    this.pump()
    return true
  }

  /** The helper with this id crashed or was destroyed (from outside: the queue ignores its own destroys). */
  gone(helperId: number): void {
    if (!this.helper || this.helper.id !== helperId) return
    const started = this.listening
    this.drop(false)
    if (!started) {
      // It died before it could take a job: nothing ran, so nothing is to blame.
      this.failWaiting('The thumbnail helper stopped while starting')
      return
    }
    const again: Waiting[] = []
    for (const r of this.takeRunning()) {
      // It ran alone and a helper crashed again: this picture is the cause.
      if (r.w.suspect) r.w.resolve(null)
      else again.push({ ...r.w, suspect: true })
    }
    this.waiting.unshift(...again)
    this.pump()
  }

  /** Destroy the helper and fail every job (the brain window closed, the app quits). The next job starts a new helper. */
  stop(): void {
    for (const r of this.takeRunning()) r.w.reject(new ThumbUnavailable('Thumbnails stopped'))
    this.drop(false)
    this.failWaiting('Thumbnails stopped')
  }

  private pump(): void {
    if (!this.waiting.length) return
    if (!this.helper) {
      this.start()
      return
    }
    while (this.helper && this.listening && this.waiting.length && this.running.size < this.concurrency) {
      const next = this.waiting[0]!
      // A suspect runs alone, so that a crash names its picture.
      if (this.running.size && (next.suspect || [...this.running.values()].some((r) => r.w.suspect))) return
      this.waiting.shift()
      this.dispatch(this.helper, next)
    }
  }

  private start(): void {
    let h: ThumbHelper
    try {
      h = this.spawn()
    } catch {
      this.failWaiting('Could not start the thumbnail helper')
      return
    }
    this.helper = h
    this.listening = false
    this.startTimer = setTimeout(() => {
      this.startTimer = null
      if (this.helper !== h || this.listening) return
      this.drop(true)
      this.failWaiting('The thumbnail helper did not start')
    }, this.timeoutMs)
  }

  private dispatch(helper: ThumbHelper, w: Waiting): void {
    const id = ++this.seq
    const timer = setTimeout(() => this.timeout(id), this.timeoutMs)
    this.running.set(id, { w, timer })
    try {
      helper.send(id, w.job)
    } catch {
      // Its window went away under us: as good as a crash.
      this.gone(helper.id)
    }
  }

  /** A decode took too long: no thumbnail for that picture, and a new helper for the others. */
  private timeout(id: number): void {
    const r = this.running.get(id)
    if (!r) return
    this.running.delete(id)
    r.w.resolve(null)
    // The others in flight were not late (yet): they start over on the next helper.
    this.waiting.unshift(...this.takeRunning().map((x) => x.w))
    this.drop(true)
    this.pump()
  }

  /** Every running job, their timers cleared, in the order they were sent. */
  private takeRunning(): Running[] {
    const out = [...this.running.values()]
    for (const r of out) clearTimeout(r.timer)
    this.running.clear()
    return out
  }

  /** Forget the current helper and destroy it; its own gone() then no longer matches and is ignored. */
  private drop(hung: boolean): void {
    const h = this.helper
    this.helper = null
    this.listening = false
    this.clearStart()
    try {
      h?.destroy(hung)
    } catch {
      /* already gone */
    }
  }

  private clearStart(): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
  }

  private failWaiting(message: string): void {
    const all = this.waiting
    this.waiting = []
    for (const w of all) w.reject(new ThumbUnavailable(message))
  }
}

/* ------------------------------------------------------------------ */
/* The helper window                                                  */
/* ------------------------------------------------------------------ */

/** The Electron modules the thumbnailer uses (main.ts passes the real ones). */
export interface ThumbElectron {
  BrowserWindow: new (options: BrowserWindowConstructorOptions) => BrowserWindow
  session: { fromPartition(partition: string): Session }
}

export interface ThumbnailerOptions {
  electron: ThumbElectron
  /** Absolute path of the built thumb-preload.cjs. */
  preload: string
  timeoutMs?: number
}

/** Something that sent an IPC message (Electron's `event.sender`). */
interface Sender {
  id: number
}

export class Thumbnailer {
  private readonly queue: ThumbQueue
  private sessionReady = false
  /** Videos handed to the helper for a job running now: token → the file, its media type, and what ends its streams. */
  private readonly videos = new Map<string, { abs: string; mime: string; end: AbortController }>()

  constructor(private opts: ThumbnailerOptions) {
    this.queue = new ThumbQueue(() => this.spawn(), opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs })
  }

  /**
   * PNG bytes of the job's picture scaled to its size, or null when it cannot
   * be decoded in time. Rejects with ThumbUnavailable when no helper answered.
   */
  render(job: ThumbJob): Promise<Uint8Array | null> {
    return this.queue.render(job)
  }

  /**
   * PNG bytes of one still frame of the video at `abs` (served to the helper
   * as `mime`), at most `px` on its longer side; the helper may read the file
   * only until the job ends.
   */
  async renderVideo(abs: string, mime: string, px: number): Promise<Uint8Array | null> {
    const token = randomUUID()
    const end = new AbortController()
    this.videos.set(token, { abs, mime, end })
    try {
      return await this.queue.render({ url: VIDEO_URL_PREFIX + token, px })
    } finally {
      this.videos.delete(token)
      // Streams still open (a helper that gave up on a share that stopped answering) end with the job.
      end.abort()
    }
  }

  /** One request of the helper's session for a video address: the file of a job running now, else 404. */
  serve(url: string, range: string | null): Promise<Response> {
    const video = url.startsWith(VIDEO_URL_PREFIX) ? this.videos.get(url.slice(VIDEO_URL_PREFIX.length)) : undefined
    if (!video) return Promise.resolve(new Response(null, { status: 404 }))
    return serveVideo(video.abs, video.mime, range, video.end.signal)
  }

  /** `thumbs:ready`: only the current helper counts. */
  ready(sender: Sender): void {
    this.queue.ready(sender.id)
  }

  /** `thumbs:done`: only the current helper's answers count. */
  done(sender: Sender, id: unknown, png: unknown): void {
    this.queue.done(sender.id, id, png)
  }

  /** Destroy the helper (the brain window closed, the app quits); a later job starts a new one. */
  stop(): void {
    this.queue.stop()
  }

  private spawn(): ThumbHelper {
    const { BrowserWindow: Win } = this.opts.electron
    this.prepareSession()
    const w = new Win({
      show: false,
      width: 64,
      height: 64,
      skipTaskbar: true,
      focusable: false,
      paintWhenInitiallyHidden: false,
      title: 'Aether Brain thumbnails',
      webPreferences: {
        preload: this.opts.preload,
        partition: THUMB_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Hidden for good: it must not be throttled like a background tab.
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
    w.loadURL(THUMB_PAGE).catch(gone)
    return {
      id,
      send: (jobId, job) =>
        'url' in job ? wc.send(THUMB_IPC.video, jobId, job.url, job.px) : wc.send(THUMB_IPC.job, jobId, job.bytes, job.type, job.width, job.height),
      destroy: (hung) => {
        if (w.isDestroyed()) return
        // A renderer stuck in a decode may never finish closing: end its process first.
        if (hung) wc.forcefullyCrashRenderer()
        w.destroy()
      },
    }
  }

  /**
   * The helper's session, set up once: it loads its empty page and the videos
   * of the jobs running now (served by `serve`), nothing else, and gets no
   * permission.
   */
  private prepareSession(): void {
    if (this.sessionReady) return
    this.sessionReady = true
    const ses = this.opts.electron.session.fromPartition(THUMB_PARTITION)
    ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: details.url !== THUMB_PAGE && !details.url.startsWith(VIDEO_URL_PREFIX) }))
    ses.protocol.handle(VIDEO_SCHEME, (req) => this.serve(req.url, req.headers.get('range')))
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
  }
}
