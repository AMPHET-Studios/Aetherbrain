/**
 * The board view's pure parts: the save scheduler, what a drop or a paste carries, where a board's camera is remembered, and the small
 * texts the toolbar, status bar and info card show. No React, no DOM: everything here runs (and is tested) in node, with timers and
 * storage handed in. The session (boardSession.ts) puts them to work. Design: docs/design/reference-board.md.
 */
import {
  BOARD_LIMITS,
  boardPictureName,
  isImagePath,
  itemsBounds,
  type BoardDoc,
  type BoardItem,
  type BoardView,
  type PictureItem,
  type TextMetrics,
} from '@aether/core'

/* ------------------------------------------------------------------ numbers --- */

/** A board that keeps changing is written at most this often (ms); the end of a gesture and a one-shot command write at once. */
export const SAVE_THROTTLE_MS = 1000
/** A pan or zoom is remembered in localStorage this long after the last one (ms). */
export const VIEW_PERSIST_MS = 300
/**
 * One-shot commands that follow each other this closely (a held arrow key, undo or opacity repeating) are one burst: the first is
 * written at once, the rest ride the throttle above, and the last state always lands.
 */
export const FINAL_BURST_MS = 250
/** A failed save is tried again after this long, doubling up to the second (ms). */
export const RETRY_FIRST_MS = 5000
export const RETRY_MAX_MS = 60_000
/** Pictures taken from one drop or paste; the rest are left out and the user is told. */
export const MAX_DROP_FILES = 40
/** The biggest picture file the vault accepts (the host refuses larger; checked here so it is never read into memory). */
export const MAX_FILE_BYTES = 40 * 1024 * 1024
/** Pictures the picker adds in one go. */
export const MAX_PICKER_ADD = 100
/** Pictures a palette is taken from, the longest side they are shrunk to, and the colours asked for. */
export const MAX_PALETTE_PICTURES = 12
export const PALETTE_PX = 128
export const PALETTE_COLOURS = 6
/** An export aims at this long a side (the exporter itself stops at 8192). */
export const EXPORT_TARGET_SIDE = 4096
/** How long the status bar keeps the last message (ms). */
export const HINT_MS = 8000
/** Pictures one file read-ahead holds at once while a drop is saved (bytes in flight, not the count of pictures). */
export const DROP_CHUNK_BYTES = 64 * 1024 * 1024
export const DROP_CHUNK_FILES = 8
/**
 * The most pixels a dropped or pasted picture may claim in its header: decoded it takes 4 bytes a pixel, and a few hundred KB of PNG
 * can claim a whole gigabyte. Pictures already in the vault are held to the picture cache's own rule (imageLoader.ts).
 */
export const MAX_DROP_PIXELS = 150_000_000
/** A batch of pictures this large or larger is brought into view when it landed off screen (the new items are selected). */
export const FIT_BATCH_MIN = 4

/* ------------------------------------------------------------------- timers --- */

export interface Timers {
  now(): number
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const realTimers: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/* -------------------------------------------------------------------- saver --- */

export interface SaverOptions {
  timers: Timers
  /** Writes the board as it is now. Resolves when that is done (also when there was nothing to write); rejects when it failed. */
  run(): Promise<void>
  /** A save failed. `first` is true when the attempt before it had not failed: the user is told once per run of failures. `failures` counts the run so far. */
  onError(err: unknown, first: boolean, failures?: number): void
  /** The camera moved and nothing else did: remember it where it costs nothing (never the file). */
  persistView(): void
  /** The saver's status (dirty / running / failing) changed. */
  onStatus(): void
  throttleMs?: number
}

/**
 * Decides when the board is written. The controller says when the board changed (`note`): while a gesture is under way a change
 * is written at most once a second (`throttleMs`, counted from the first change after the last write); the end of a gesture and a
 * one-shot command write at once; a pan or zoom writes nothing. Writes run one at a time (a second never starts before the first
 * ended: a change that arrives meanwhile is picked up by the next one). A failed write keeps the board dirty and is tried again
 * after a growing wait, and by every `flush`. Nothing here knows what a write is: `run` does that.
 */
export class Saver {
  /** There is something to write. */
  dirty = false
  /** A write is in flight. */
  running = false
  /** The last write failed. */
  failing = false

  private readonly opts: SaverOptions
  private readonly throttle: number
  private timer: unknown = null
  private viewTimer: unknown = null
  private retryTimer: unknown = null
  private failures = 0
  /** A final change arrived while a write was running: write again as soon as it ends. */
  private again = false
  private current: Promise<void> | null = null
  /** When the last finished change (a final one) was noted. */
  private lastFinalAt: number | null = null

  constructor(opts: SaverOptions) {
    this.opts = opts
    this.throttle = opts.throttleMs !== undefined && opts.throttleMs >= 0 ? opts.throttleMs : SAVE_THROTTLE_MS
  }

  /** The controller's `onChange`. */
  note(why: { final: boolean; viewOnly: boolean }): void {
    const t = this.opts.timers
    if (why.viewOnly) {
      if (this.viewTimer === null) {
        this.viewTimer = t.set(() => {
          this.viewTimer = null
          this.opts.persistView()
        }, VIEW_PERSIST_MS)
      }
      return
    }
    // The indicator only needs to hear of the change from clean to dirty: a drag changes the board on every pointer move.
    const wasClean = !this.dirty
    this.dirty = true
    if (wasClean) this.opts.onStatus()
    if (why.final) {
      const now = t.now()
      // A held key repeats a one-shot command many times a second (a nudge, an undo): all but the first of such a burst ride the
      // throttle like a drag does, and the wait is never moved, so the last state always lands.
      const burst = this.lastFinalAt !== null && now - this.lastFinalAt < FINAL_BURST_MS
      this.lastFinalAt = now
      if (burst) {
        this.armThrottle()
      } else {
        this.clear('timer')
        this.clear('retryTimer')
        void this.pump()
      }
    } else {
      this.armThrottle()
    }
  }

  private armThrottle(): void {
    if (this.timer === null && !this.running && !this.failing) {
      this.timer = this.opts.timers.set(() => {
        this.timer = null
        void this.pump()
      }, this.throttle)
    }
  }

  /**
   * Writes whatever is not written and resolves when it is on disk, or when the attempt failed. Never rejects. Resolves true only when
   * nothing is left unsaved: a write that failed, or a board that changes faster than it is written, resolves false.
   */
  async flush(): Promise<boolean> {
    if (this.viewTimer !== null) {
      this.clear('viewTimer')
      this.opts.persistView()
    }
    // A write in flight, then what arrived meanwhile: a few rounds are enough, a board that changes faster than it is written waits.
    for (let round = 0; round < 8 && (this.dirty || this.running); round++) {
      this.clear('timer')
      this.clear('retryTimer')
      await (this.running ? this.current : this.pump())
      if (this.failing) break
    }
    return !this.dirty && !this.running && !this.failing
  }

  /** Tries again now a write that failed (what made it fail has been put right), instead of at the end of the wait. */
  retryNow(): void {
    if (!this.dirty) return
    this.clear('timer')
    this.clear('retryTimer')
    void this.pump()
  }

  /** Resolves when no write is in flight. */
  async idle(): Promise<void> {
    while (this.current) await this.current
  }

  /** Cancels the timers (the view was closed); call after `flush`. */
  stop(): void {
    this.clear('timer')
    this.clear('viewTimer')
    this.clear('retryTimer')
  }

  private clear(which: 'timer' | 'viewTimer' | 'retryTimer'): void {
    const h = this[which]
    if (h === null) return
    this[which] = null
    this.opts.timers.clear(h)
  }

  private pump(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.current ?? Promise.resolve()
    }
    this.running = true
    this.opts.onStatus()
    this.current = this.loop().finally(() => {
      this.current = null
    })
    return this.current
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.again = false
        if (!this.dirty) break
        this.dirty = false
        try {
          await this.opts.run()
          this.failures = 0
          this.failing = false
        } catch (err) {
          // Still dirty: the board is not on disk. The user hears of the first failure of a run, a retry follows.
          this.dirty = true
          const first = !this.failing
          this.failing = true
          this.failures++
          this.opts.onError(err, first, this.failures)
          this.scheduleRetry()
          break
        }
      } while (this.again)
    } finally {
      this.running = false
      // Changes that arrived mid-write while a gesture was still going wait their turn at the throttle, not at once.
      if (this.dirty && !this.failing && this.timer === null) {
        this.timer = this.opts.timers.set(() => {
          this.timer = null
          void this.pump()
        }, this.throttle)
      }
      this.opts.onStatus()
    }
  }

  private scheduleRetry(): void {
    this.clear('retryTimer')
    const wait = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, this.failures - 1))
    this.retryTimer = this.opts.timers.set(() => {
      this.retryTimer = null
      void this.pump()
    }, wait)
  }
}

/* ---------------------------------------------------------- the camera's memory --- */

export const VIEW_KEY_PREFIX = 'aether.board.view:'

/** The browser's storage as the board uses it (`removeItem` may be missing from a stand-in). */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>

/** The camera remembered for the board at `path`, or null (nothing stored, bad JSON, numbers that are no camera, storage refusing). */
export function readStoredView(storage: StorageLike | null, path: string): BoardView | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(VIEW_KEY_PREFIX + path)
    if (!raw) return null
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return null
    const { x, y, zoom } = v as Record<string, unknown>
    if (typeof x !== 'number' || typeof y !== 'number' || typeof zoom !== 'number') return null
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return null
    if (zoom < BOARD_LIMITS.zoomMin || zoom > BOARD_LIMITS.zoomMax) return null
    if (Math.abs(x) > BOARD_LIMITS.coordinate || Math.abs(y) > BOARD_LIMITS.coordinate) return null
    return { x, y, zoom }
  } catch {
    return null
  }
}

/** Remembers the camera; false when the storage refused (private window, quota, no storage at all). */
export function writeStoredView(storage: StorageLike | null, path: string, view: BoardView): boolean {
  if (!storage) return false
  try {
    storage.setItem(VIEW_KEY_PREFIX + path, JSON.stringify({ x: view.x, y: view.y, zoom: view.zoom }))
    return true
  } catch {
    return false
  }
}

/* --------------------------------------------------------- the copy of an unsaved board --- */

export const RECOVERY_KEY_PREFIX = 'aether.board.unsaved:'
/** A board text longer than this is not kept (the browser's storage holds a few million characters in all). */
export const RECOVERY_MAX_CHARS = 1_200_000

export interface Recovery {
  /** The whole note as the board would have written it. */
  text: string
  /** When the save failed (ms since 1970). */
  at: number
}

/** Keeps the text of a board that could not be saved, for this board's path; replaces the one before. False when it could not be kept. */
export function writeRecovery(storage: StorageLike | null, path: string, text: string, at: number): boolean {
  if (!storage || text.length > RECOVERY_MAX_CHARS) return false
  try {
    storage.setItem(RECOVERY_KEY_PREFIX + path, JSON.stringify({ text, at }))
    return true
  } catch {
    return false
  }
}

/** The copy kept for this board, or null (nothing kept, broken JSON, storage refusing). */
export function readRecovery(storage: StorageLike | null, path: string): Recovery | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(RECOVERY_KEY_PREFIX + path)
    if (!raw) return null
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return null
    const { text, at } = v as Record<string, unknown>
    if (typeof text !== 'string' || text === '' || typeof at !== 'number' || !Number.isFinite(at)) return null
    return { text, at }
  } catch {
    return null
  }
}

/** Forgets the copy kept for this board (a save went through, or it was taken back). */
export function clearRecovery(storage: StorageLike | null, path: string): void {
  if (!storage) return
  try {
    if (typeof storage.removeItem === 'function') storage.removeItem(RECOVERY_KEY_PREFIX + path)
    else storage.setItem(RECOVERY_KEY_PREFIX + path, '')
  } catch {
    /* a storage that will not forget keeps a copy the next load compares with the note, and finds nothing to recover */
  }
}

/* ------------------------------------------------------------ drops and pastes --- */

/** What the view needs of a file from a drop or a paste (a `File` is one). */
export interface FileLike {
  name: string
  type: string
  size: number
}

/** A drop or a paste read out of its DataTransfer in the event handler (the transfer is only readable there). */
export interface TransferSnapshot<F extends FileLike = FileLike> {
  files: F[]
  /** `text/uri-list` */
  uriList: string
  /** `text/html` */
  html: string
  /** `text/plain` */
  text: string
}

export type TransferPlan<F extends FileLike = FileLike> =
  /** Files came with it: the pictures among them (at most MAX_DROP_FILES), and what was left out and why. */
  | { kind: 'files'; pictures: F[]; ignored: number; tooBig: F[]; overCap: number }
  /** An address, no file: the app cannot fetch it. */
  | { kind: 'url' }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'nothing' }

const IMAGE_MIME = /^image\/(png|jpe?g|pjpeg|webp|gif|bmp|x-ms-bmp|avif)$/i

/** A picture file the board takes: png, jpg, jpeg, webp, gif, bmp, avif by its type or by its extension (SVG is left out on purpose). */
export function isImageFile(f: Pick<FileLike, 'name' | 'type'>): boolean {
  return IMAGE_MIME.test(f.type.trim()) || isImagePath(f.name)
}

/** Whether HTML carries a picture by address (`<img src=...>`): what a picture dragged out of a web page looks like without its bytes. */
export function htmlHasImage(html: string): boolean {
  return /<img\b[^>]*?\bsrc\s*=/i.test(html)
}

/** Whether a `text/uri-list` names anything (comment lines start with `#`). */
export function uriListHasAddress(list: string): boolean {
  return list.split(/\r?\n/).some((line) => {
    const t = line.trim()
    return t !== '' && !t.startsWith('#')
  })
}

/** What to do with a drop or a paste. Files first (pictures only, capped), then an address (no network: say so), then plain text. */
export function classifyTransfer<F extends FileLike>(t: TransferSnapshot<F>): TransferPlan<F> {
  if (t.files.length > 0) {
    const images = t.files.filter(isImageFile)
    const small = images.filter((f) => f.size <= MAX_FILE_BYTES)
    const tooBig = images.filter((f) => f.size > MAX_FILE_BYTES)
    return {
      kind: 'files',
      pictures: small.slice(0, MAX_DROP_FILES),
      ignored: t.files.length - images.length,
      tooBig,
      overCap: Math.max(0, small.length - MAX_DROP_FILES),
    }
  }
  if (uriListHasAddress(t.uriList) || htmlHasImage(t.html)) return { kind: 'url' }
  const text = t.text.replace(/\r\n?/g, '\n')
  if (text.trim() === '') return { kind: 'nothing' }
  return { kind: 'text', text: text.slice(0, BOARD_LIMITS.noteChars), truncated: text.length > BOARD_LIMITS.noteChars }
}

/** The messages the view gives for what a drop or a paste could not take (one place, so the texts are tested). */
export const MESSAGES = {
  onlyPictures: 'Only pictures can go on a board (png, jpg, webp, gif, bmp, avif).',
  noNetwork:
    'The app makes no network requests, so it cannot fetch a picture from a web address. Save or copy the picture, then drop or paste it here.',
  nothing: 'There was nothing on the clipboard that a board can take.',
  staleCopy: 'Those board items could not be read back from the clipboard. Copy them again.',
} as const

/** What the Paste menu entry says when the board holds nothing of its own to paste: a picture or text on the system clipboard is Ctrl V's. */
export function pasteHint(mac: boolean): string {
  return `Nothing copied on the board to paste. To paste a picture or text from the system clipboard, press ${mac ? '⌘' : 'Ctrl'} V.`
}

export function tooLargeMessage(files: readonly Pick<FileLike, 'name'>[]): string {
  const mp = Math.round(MAX_DROP_PIXELS / 1_000_000)
  return files.length === 1
    ? `${files[0]!.name} is over ${mp} megapixels, so it was left out: a picture that large takes gigabytes of memory to show.`
    : `${files.length} pictures are over ${mp} megapixels and were left out: pictures that large take gigabytes of memory to show.`
}

export function tooBigMessage(files: readonly Pick<FileLike, 'name'>[]): string {
  const mb = Math.round(MAX_FILE_BYTES / 1024 / 1024)
  return files.length === 1 ? `${files[0]!.name} is bigger than ${mb} MB, so it was left out.` : `${files.length} pictures are bigger than ${mb} MB and were left out.`
}

export function overCapMessage(taken: number, left: number): string {
  return `Added the first ${taken} pictures; ${left} more were left out (a drop takes at most ${MAX_DROP_FILES}). Drop the rest in a second go.`
}

/** A canvas pixel as board hex (6 lower-case digits, no #), from the first three bytes of its RGBA. */
export function hexOfPixel(data: ArrayLike<number>): string {
  const h = (v: number | undefined): string => Math.min(255, Math.max(0, Math.round(v ?? 0))).toString(16).padStart(2, '0')
  return h(data[0]) + h(data[1]) + h(data[2])
}

/* ----------------------------------------------------------- what the user reads --- */

/** The key text with the platform's own words: `⌘ ⇧ Z` is `Ctrl Shift Z` away from a Mac. */
export function formatKeys(keys: string, mac: boolean): string {
  if (mac) return keys
  return keys.replace(/⌘/g, 'Ctrl').replace(/⇧/g, 'Shift').replace(/⌥/g, 'Alt')
}

export interface SelectionSummary {
  total: number
  pictures: number
  notes: number
  marks: number
  text: string
}

/** "2 pictures, 1 note" for the status bar. */
export function summarizeSelection(doc: BoardDoc, ids: readonly number[]): SelectionSummary {
  const chosen = new Set(ids)
  let pictures = 0
  let notes = 0
  let marks = 0
  for (const it of doc.items) {
    if (!chosen.has(it.id)) continue
    if (it.kind === 'picture') pictures++
    else if (it.kind === 'note') notes++
    else marks++
  }
  const total = pictures + notes + marks
  const parts: string[] = []
  if (pictures) parts.push(`${pictures} ${pictures === 1 ? 'picture' : 'pictures'}`)
  if (notes) parts.push(`${notes} ${notes === 1 ? 'note' : 'notes'}`)
  if (marks) parts.push(`${marks} ${marks === 1 ? 'mark' : 'marks'}`)
  const text = total === 0 ? 'Nothing selected' : parts.length === 1 ? `${parts[0]!} selected` : `${total} selected: ${parts.join(', ')}`
  return { total, pictures, notes, marks, text }
}

/** The line under the canvas that says what the tool in hand does. */
export function toolHint(state: { tool: string; cropping: number | null; selection: readonly number[] }, itemCount: number, mac = true): string {
  switch (state.tool) {
    case 'hand':
      return 'Drag to pan the board'
    case 'note':
      return 'Click to place a note'
    case 'pen':
      return 'Drag to draw'
    case 'line':
      return 'Drag to draw a line'
    case 'rect':
      return 'Drag to draw a rectangle'
    case 'ellipse':
      return 'Drag to draw an ellipse'
    case 'eraser':
      return 'Drag over marks to erase them'
    case 'sampler':
      return 'Click to copy the colour under the pointer'
    case 'crop':
      return state.cropping !== null ? 'Drag the edges to crop · Enter to finish' : 'Click the picture you want to crop'
    case 'turn':
      return 'Drag a 3D model to turn it · Esc to leave'
    default:
      if (itemCount === 0) return `Drop pictures here, paste with ${mac ? '⌘' : 'Ctrl'} V, or add pictures`
      return state.selection.length > 0 ? 'Drag to move · corners scale · the knob above rotates' : 'Click to select · drag for a box · Space + drag pans'
  }
}

/** A count of characters as the status bar writes it: "812", "9.4k", "123k". */
export function formatChars(n: number): string {
  if (!(n > 0) || !Number.isFinite(n)) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

/** How full the board is against its character budget: 'ok', 'warn' from 90 percent, 'full' at the budget. */
export function budgetTone(chars: number, limit: number): 'ok' | 'warn' | 'full' {
  if (!(limit > 0)) return 'ok'
  if (chars >= limit) return 'full'
  return chars >= limit * 0.9 ? 'warn' : 'ok'
}

/** The zoom as the status bar writes it: "100%", "12.5%", "6400%". */
export function formatZoom(zoom: number): string {
  if (!(zoom > 0) || !Number.isFinite(zoom)) return '—'
  const pct = zoom * 100
  if (pct >= 100) return `${Math.round(pct)}%`
  if (pct >= 10) return `${+pct.toFixed(1)}%`
  return `${+pct.toFixed(2)}%`
}

/** A colour typed into a hex field: `ff8800`, `#ff8800`, `f80` and `#F80` all give six lower-case digits; anything else is null. */
export function parseHexInput(text: string): string | null {
  const t = text.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(t)) return t.toLowerCase()
  if (/^[0-9a-fA-F]{3}$/.test(t)) return t.replace(/./g, (c) => c + c).toLowerCase()
  return null
}

/* ---------------------------------------------------------------- picture info --- */

export interface PictureInfo {
  name: string
  path: string
  /** The picture's own pixels, once known. */
  natural: { w: number; h: number } | null
  /** The size it is shown at on the board, in board units (the shown part, crop applied). */
  shown: { w: number; h: number }
  /** How much of its own pixels the board shows, in percent (100: one picture pixel per board unit), or null while its size is unknown. */
  scalePercent: number | null
  /** The file type from the name: "PNG", "JPG" ... */
  type: string
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export function describePicture(item: PictureItem, natural: { w: number; h: number } | null): PictureInfo {
  const name = baseName(item.path)
  const dot = name.lastIndexOf('.')
  const shownW = (item.crop.r - item.crop.l) * item.w
  const shownH = (item.crop.b - item.crop.t) * item.h
  return {
    name,
    path: item.path,
    natural,
    shown: { w: Math.round(shownW), h: Math.round(shownH) },
    scalePercent: natural && natural.w > 0 ? Math.round((item.w / natural.w) * 100) : null,
    type: dot >= 0 ? name.slice(dot + 1).toUpperCase() : '',
  }
}

/** The info card's rows, label and value. */
export function infoRows(info: PictureInfo): [string, string][] {
  const rows: [string, string][] = [
    ['Name', info.name],
    ['In the vault', info.path],
    ['Picture size', info.natural ? `${info.natural.w} × ${info.natural.h} px` : 'reading…'],
    ['On the board', `${info.shown.w} × ${info.shown.h}${info.scalePercent !== null ? ` · ${info.scalePercent}% of its pixels` : ''}`],
  ]
  if (info.type) rows.push(['File type', info.type])
  return rows
}

/* ----------------------------------------------------------------------- export --- */

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `<board title> export 2026-10-09 143512.png`, cleaned the way every picture name of a board is. */
export function exportFileName(title: string, now: Date): string {
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  // A slash would read as a folder to boardPictureName, which keeps only the last part of a path: "Gate / rust" must not become "rust".
  const name = title.replace(/[\\/]+/g, '-').trim() || 'Board'
  return boardPictureName(`${name} export ${stamp}.png`, 'image/png', now)
}

/**
 * Pixels per board unit for an export of `ids` (null: everything): the finest the pictures in it have (their own pixels over the
 * units they take, never below 1), brought down so the longer side stays at about EXPORT_TARGET_SIDE. A selection with no picture
 * of known size is drawn twice as large as it is on the board. The exporter itself keeps the result under 8192 px.
 */
export function exportScale(
  doc: BoardDoc,
  ids: readonly number[] | null,
  naturalOf: (path: string) => { w: number; h: number } | null,
  metrics: TextMetrics,
): number {
  const wanted = ids ? new Set(ids) : null
  const items: BoardItem[] = wanted ? doc.items.filter((it) => wanted.has(it.id)) : doc.items
  const bounds = itemsBounds(items, metrics)
  if (!bounds) return 1
  let native = 0
  for (const it of items) {
    if (it.kind !== 'picture' || !(it.w > 0)) continue
    const n = naturalOf(it.path)
    if (n && n.w > 0) native = Math.max(native, n.w / it.w)
  }
  const wish = native > 0 ? Math.max(1, native) : 2
  const longer = Math.max(bounds.w, bounds.h, 1e-9)
  return Math.max(0.01, Math.min(wish, EXPORT_TARGET_SIDE / longer))
}
