/**
 * Fakes for the board view's tests: a clock whose timers only run when the test moves it, a host that writes down everything it is
 * asked and can be made slow or broken, the browser's side of the session (sizes by name, pixels by bitmap), and a picture cache
 * that tells what it was told. Not a test file itself.
 */
import {
  addPicture,
  addNote,
  emptyBoard,
  estimateTextMetrics,
  newBoardNote,
  serializeBoard,
  type BoardDoc,
  type VaultAsset,
} from '@aether/core'
import type { BoardHost, BoardPictureHost, BoardTone, BoardWindowHost } from '../../src/board/api'
import { ImageCache, type ImageCacheOptions } from '../../src/board/imageCache'
import type { ExportCanvas } from '../../src/board/renderer'
import { BoardSession, type SessionEnv, type SessionUi } from '../../src/board/view/boardSession'
import type { Timers } from '../../src/board/view/session'
import { RecordingContext } from './recordingContext'

/* ------------------------------------------------------------------ the clock --- */

export class FakeTimers implements Timers {
  t = 1_000_000
  private seq = 0
  private readonly list = new Map<number, { at: number; fn: () => void }>()

  now(): number {
    return this.t
  }

  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.list.set(id, { at: this.t + Math.max(0, ms), fn })
    return id
  }

  clear(handle: unknown): void {
    this.list.delete(handle as number)
  }

  /** Timers waiting. */
  get pending(): number {
    return this.list.size
  }

  /** The waits of the timers waiting, soonest first. */
  get waits(): number[] {
    return [...this.list.values()].map((v) => v.at - this.t).sort((a, b) => a - b)
  }

  /** Moves the clock and runs the timers that fall due on the way, in order (what they start runs between them). */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    for (;;) {
      await settle()
      let next: [number, { at: number; fn: () => void }] | undefined
      for (const e of this.list) if (e[1].at <= end && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) next = e
      if (!next) break
      this.list.delete(next[0])
      this.t = Math.max(this.t, next[1].at)
      next[1].fn()
    }
    this.t = end
    await settle()
  }
}

/** Lets every promise that can run, run. */
export async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await new Promise<void>((r) => setImmediate(r))
  }
}

/* ------------------------------------------------------------------- storage --- */

export class MemoryStorage {
  map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v))
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
}

/* ----------------------------------------------------------------------- host --- */

export class FakeWindow implements BoardWindowHost {
  floating = false
  alwaysOnTop = true
  opacity = 1
  supportsOpacity = true
  calls: string[] = []
  popOut(): void {
    this.calls.push('popOut')
  }
  dock(): void {
    this.calls.push('dock')
  }
  setAlwaysOnTop(on: boolean): void {
    this.calls.push(`onTop:${on}`)
    this.alwaysOnTop = on
  }
  setOpacity(o: number): void {
    this.calls.push(`opacity:${o}`)
    this.opacity = o
  }
}

export class FakeHost implements BoardHost {
  path = 'Boards/Gate.md'
  title = 'Gate'
  raw: string
  loads = 0
  loadError: Error | null = null
  /** Set to make a load wait for the promise it returns (a slow disk). */
  loadGate: (() => Promise<void>) | null = null
  saves: string[] = []
  /** The `expectedBase` each save came with. */
  bases: (string | undefined)[] = []
  /** Set: a save whose `expectedBase` is not the text on disk is refused, as the real hosts do. */
  strict = false
  /** Set to make a save take as long as the promise it returns. */
  saveGate: (() => Promise<void>) | null = null
  saveError: Error | null = null
  inFlight = 0
  maxInFlight = 0
  toasts: { text: string; tone: BoardTone | undefined; action?: { label: string; run(): void } | undefined }[] = []
  copied: string[] = []
  copyError: Error | null = null
  externalSubs = new Set<() => void>()
  pictureSubs = new Set<() => void>()
  assets: VaultAsset[] = []
  /** The pictures the vault has; null: all of them. */
  present: Set<string> | null = null
  added: { name: string; bytes: number }[][] = []
  addRefuse = new Set<string>()
  addError: Error | null = null
  previews: string[] = []
  originals: string[] = []
  opens: string[] = []
  reveals: string[] = []
  brains: string[] = []
  window: FakeWindow | undefined = undefined
  pictures: BoardPictureHost
  private counter = 0

  constructor(raw: string, extras: { open?: boolean; reveal?: boolean; showInBrain?: boolean; window?: boolean } = {}) {
    this.raw = raw
    const host = this
    const pictures: BoardPictureHost = {
      preview: async (path) => {
        host.previews.push(path)
        return new Blob([`preview:${path}`])
      },
      original: async (path) => {
        host.originals.push(path)
        return new Blob([path])
      },
      add: async (files) => {
        if (host.addError) throw host.addError
        host.added.push(files.map((f) => ({ name: f.name, bytes: f.data.length })))
        return files.map((f) => (host.addRefuse.has(f.name) ? null : `Boards/Gate/${f.name}`))
      },
      list: async () => host.assets,
      exists: (p) => host.present === null || host.present.has(p),
      onChange: (cb) => {
        host.pictureSubs.add(cb)
        return () => void host.pictureSubs.delete(cb)
      },
    }
    if (extras.open !== false) pictures.open = (p) => void host.opens.push(p)
    if (extras.reveal !== false) pictures.reveal = (p) => void host.reveals.push(p)
    if (extras.showInBrain !== false) pictures.showInBrain = (p) => void host.brains.push(p)
    this.pictures = pictures
    if (extras.window) this.window = new FakeWindow()
    void this.counter
  }

  async load(): Promise<string> {
    this.loads++
    if (this.loadError) throw this.loadError
    const raw = this.raw
    if (this.loadGate) await this.loadGate()
    return raw
  }

  async save(raw: string, expectedBase?: string): Promise<void> {
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.saveGate) await this.saveGate()
      if (this.saveError) throw this.saveError
      if (this.strict && expectedBase !== undefined && expectedBase !== this.raw) {
        throw new Error('The board was changed outside the board view, so this save was not written')
      }
      this.bases.push(expectedBase)
      this.saves.push(raw)
      this.raw = raw
    } finally {
      this.inFlight--
    }
  }

  onExternalChange(cb: () => void): () => void {
    this.externalSubs.add(cb)
    return () => void this.externalSubs.delete(cb)
  }

  toast(text: string, tone?: BoardTone, action?: { label: string; run(): void }): void {
    this.toasts.push({ text, tone, action })
  }

  async copyText(text: string): Promise<void> {
    if (this.copyError) throw this.copyError
    this.copied.push(text)
  }

  /** The note changed outside. */
  fireExternal(): void {
    for (const cb of [...this.externalSubs]) cb()
  }

  firePictures(): void {
    for (const cb of [...this.pictureSubs]) cb()
  }

  toastTexts(): string[] {
    return this.toasts.map((t) => t.text)
  }
}

/* ------------------------------------------------------------------------ env --- */

export function fakeCanvas(w: number, h: number): ExportCanvas & { ctx: RecordingContext } {
  const ctx = new RecordingContext()
  return { width: w, height: h, ctx, getContext: () => ctx }
}

export interface FakeEnv extends SessionEnv {
  storageMap: MemoryStorage
  /** Sizes by what a blob holds: a file's text (its name), `preview:<path>`, or a picture's path. */
  sizes: Record<string, { w: number; h: number }>
  /** Set: the storage is refused. */
  storageBroken: boolean
  pngs: Uint8Array[]
  canvases: ReturnType<typeof fakeCanvas>[]
  /** The size each export canvas was made at (the canvas itself is emptied once the picture is made). */
  made: { w: number; h: number }[]
  pixelsCalls: number
  /** Pixels each fake bitmap yields, by its `name`. */
  pixels: Record<string, Uint8ClampedArray>
  decodes: string[]
}

export function fakeEnv(timers: Timers): FakeEnv {
  const env: FakeEnv = {
    timers,
    metrics: estimateTextMetrics,
    storageMap: new MemoryStorage(),
    sizes: {},
    storageBroken: false,
    pngs: [],
    canvases: [],
    made: [],
    pixelsCalls: 0,
    pixels: {},
    decodes: [],
    storage: () => (env.storageBroken ? null : env.storageMap),
    decodeSize: async (blob) => {
      const key = await blob.text()
      env.decodes.push(key)
      return env.sizes[key] ?? null
    },
    pixelsOf: (bitmap) => {
      env.pixelsCalls++
      return env.pixels[(bitmap as unknown as { name?: string }).name ?? ''] ?? null
    },
    makeCanvas: (w, h) => {
      env.made.push({ w, h })
      const c = fakeCanvas(w, h)
      env.canvases.push(c)
      return c
    },
    canvasToPng: async (c) => {
      const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, c.width & 255, c.height & 255])
      env.pngs.push(png)
      return png
    },
    now: () => new Date(2026, 9, 9, 14, 35, 12),
  }
  return env
}

/* ---------------------------------------------------------------------- cache --- */

/** The real cache, telling what it was asked. */
export class SpyCache extends ImageCache {
  forgets: string[] = []
  visibles: string[][] = []
  disposes = 0
  clears = 0
  options: ImageCacheOptions
  constructor(options: ImageCacheOptions) {
    super(options)
    this.options = options
  }
  override forget(path: string): void {
    this.forgets.push(path)
    super.forget(path)
  }
  override setVisible(paths: Iterable<string>): void {
    const list = [...paths]
    this.visibles.push(list)
    super.setVisible(list)
  }
  override clear(): void {
    this.clears++
    super.clear()
  }
  override dispose(): void {
    this.disposes++
    super.dispose()
  }
}

/* -------------------------------------------------------------------- boards --- */

export const NOW = new Date(2026, 9, 9, 14, 35, 12)

/** A board note with these pictures (path, x, y, w, h) and notes (text, x, y), as the board file writes them. */
export function boardRaw(title = 'Gate', pictures: [string, number, number, number, number][] = [], notes: [string, number, number][] = []): string {
  let doc: BoardDoc = emptyBoard(title)
  for (const [path, x, y, w, h] of pictures) doc = addPicture(doc, { path, x, y, w, h }).doc
  for (const [text, x, y] of notes) doc = addNote(doc, { text, x, y, w: 200, size: 18 }).doc
  return serializeBoard(doc, newBoardNote(title, NOW), NOW)
}

export class FakeUi implements SessionUi {
  calls: string[] = []
  infos: number[] = []
  openPicker(): void {
    this.calls.push('picker')
  }
  showInfo(id: number): void {
    this.calls.push('info')
    this.infos.push(id)
  }
  toggleHideUi(): void {
    this.calls.push('hide')
  }
  openMenu(menu: 'arrange'): void {
    this.calls.push(`menu:${menu}`)
  }
}

export interface Rig {
  host: FakeHost
  timers: FakeTimers
  env: FakeEnv
  ui: FakeUi
  session: BoardSession
  caches: SpyCache[]
  cache(): SpyCache
}

/** A session on a fake host, loaded from `raw` and started. */
export function rig(raw: string = boardRaw(), hostExtras: ConstructorParameters<typeof FakeHost>[1] = {}, opts: { start?: boolean; load?: boolean } = {}): Rig {
  const host = new FakeHost(raw, hostExtras)
  const timers = new FakeTimers()
  const env = fakeEnv(timers)
  const ui = new FakeUi()
  const caches: SpyCache[] = []
  const session = new BoardSession({
    host,
    env,
    ui,
    makeCache: (o) => {
      const c = new SpyCache(o)
      caches.push(c)
      return c
    },
  })
  if (opts.load !== false) session.loadFromRaw(raw)
  if (opts.start !== false) session.start()
  return { host, timers, env, ui, session, caches, cache: () => caches[caches.length - 1]! }
}
