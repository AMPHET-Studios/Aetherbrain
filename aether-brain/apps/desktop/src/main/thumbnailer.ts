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
 * A 3D model (a binary glTF) is sent whole, like a picture; the helper has no
 * GPU (`webgl: false`), so its preload draws it with a small software
 * rasterizer and sends back one PNG.
 *
 * ThumbQueue is the bookkeeping (a HelperQueue, see helper-queue.ts, tested
 * with a fake helper): at most two decodes at once, a timeout per decode (the
 * picture gets no thumbnail, the helper is destroyed, the next job starts a
 * new one), answers taken only from the helper itself, and after a crash the
 * jobs that were in flight run again one at a time, so the picture that
 * crashes it is the only one without a thumbnail. Thumbnailer is the Electron side: no electron import at
 * runtime (types only), main.ts hands in the modules.
 */
import { randomUUID } from 'node:crypto'
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from 'electron'
import { serveVideo, type ThumbTarget } from './assets.js'
import { HelperQueue, type QueueHelper } from './helper-queue.js'

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
  /** main → helper: (id, binary glTF bytes, side): a 3D model drawn lit from one side, a square of that side. */
  model: 'thumbs:model',
  /** main → helper: (id, a Photoshop document's header and merged picture, side): the flattened picture, fitted to the side. */
  psd: 'thumbs:psd',
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

/** One 3D model to draw: its whole file (a binary glTF, checked by `modelKindOf`) and the side of the square still. */
export interface ModelJob {
  model: Uint8Array
  px: number
}

/** One Photoshop document to flatten: its header and merged picture only (`readPsdComposite`) and the longest side of the still. */
export interface PsdJob {
  psd: Uint8Array
  px: number
}

export type ThumbJob = PictureJob | VideoJob | ModelJob | PsdJob

/**
 * A job that got no answer through no fault of its picture (the helper could
 * not start, or was stopped): not worth remembering, it may be asked again.
 */
export class ThumbUnavailable extends Error {
  override name = 'ThumbUnavailable'
}

/** One helper as the queue sees it (the hidden window in the app, a fake in tests). */
export type ThumbHelper = QueueHelper<ThumbJob>

export interface ThumbQueueOptions {
  timeoutMs?: number
  concurrency?: number
}

/** The helper's answer when it is PNG bytes of a sane size; anything else is no thumbnail. */
function pngOf(v: unknown): Uint8Array | null {
  if (!(v instanceof Uint8Array) || v.length < PNG_SIG.length || v.length > MAX_THUMB_PNG) return null
  return PNG_SIG.every((x, i) => v[i] === x) ? v : null
}

/**
 * Jobs for the helper (see helper-queue.ts): PNG bytes, null (the picture
 * cannot be decoded, took too long, or crashed the helper twice), or a
 * ThumbUnavailable rejection (no helper could answer).
 */
export class ThumbQueue extends HelperQueue<ThumbJob, Uint8Array> {
  constructor(spawn: () => ThumbHelper, opts: ThumbQueueOptions = {}) {
    super(spawn, pngOf, {
      name: 'thumbnail helper',
      unavailable: (message) => new ThumbUnavailable(message),
      stopped: 'Thumbnails stopped',
      timeoutMs: opts.timeoutMs ?? THUMB_JOB_TIMEOUT,
      concurrency: opts.concurrency ?? THUMB_CONCURRENCY,
    })
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

  /**
   * PNG bytes of a 3D model (`bytes`: a whole binary glTF, already checked by `modelKindOf`) drawn lit from one side as a square
   * of `px`, or null when it has nothing the helper can draw (compressed or empty geometry, a broken file, too much of it).
   * The bytes are sent over; the helper reads nothing else, and a model that breaks its drawing code takes only the helper down.
   */
  renderModel(bytes: Uint8Array, px: number): Promise<Uint8Array | null> {
    return this.queue.render({ model: bytes, px })
  }

  /**
   * PNG bytes of the flattened picture of a Photoshop document (`bytes`: its header and merged picture, from `readPsdComposite`), at most
   * `px` on its longer side, or null when the helper cannot read it. Nothing is decoded here.
   */
  renderPsd(bytes: Uint8Array, px: number): Promise<Uint8Array | null> {
    return this.queue.render({ psd: bytes, px })
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
      send: (jobId, job) => {
        if ('url' in job) wc.send(THUMB_IPC.video, jobId, job.url, job.px)
        else if ('model' in job) wc.send(THUMB_IPC.model, jobId, job.model, job.px)
        else if ('psd' in job) wc.send(THUMB_IPC.psd, jobId, job.psd, job.px)
        else wc.send(THUMB_IPC.job, jobId, job.bytes, job.type, job.width, job.height)
      },
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
