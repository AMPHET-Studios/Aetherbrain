/**
 * The board view's engine: one session per open board. It loads the note, owns the controller, the picture cache and the saver, and
 * answers everything the controller asks of its shell (BoardEvent), takes pictures and text from drops, pastes and the picker, and
 * exports. It knows nothing of React: the DOM-only pieces (reading a pixel, decoding a size, making a canvas) are handed in
 * (`SessionEnv`), so the whole of it is driven, and tested, in node with a fake host. The React shell (BoardView.tsx) draws the
 * session's state and feeds it input. Design: docs/design/reference-board.md.
 *
 * Lifecycle. `new BoardSession` does nothing; `load()` (or `loadFromRaw`) reads the note and builds the controller; `start()`
 * subscribes to the controller and the host and `stop()` lets them all go again, flushing a pending save first. start / stop may
 * alternate (React's strict mode does that), a closed view holds no timer, no listener and no bitmap.
 */
import {
  BOARD_LIMITS,
  boardPictureName,
  boardPictures,
  dominantColours,
  isBoardNote,
  parseBoard,
  screenToBoard,
  serializeBoard,
  type BoardDoc,
  type TextMetrics,
  type Vec2,
} from '@aether/core'
import type { BoardCommandId, BoardEvent, BoardHost, BoardTone, ImageSlot, ImageSource, KeyIn, PointerIn } from '../api'
import { BoardController } from '../controller'
import { keyToCommand } from '../commands'
import { DEFAULT_RETRY_MS, ImageCache, type BitmapLike, type ImageCacheOptions } from '../imageCache'
import { createImageLoader, type CreateBitmap } from '../imageLoader'
import { drawBoard, exportBoard, visiblePictures, type Ctx2D, type ExportCanvas } from '../renderer'
import {
  DROP_CHUNK_BYTES,
  DROP_CHUNK_FILES,
  HINT_MS,
  MAX_PALETTE_PICTURES,
  MESSAGES,
  PALETTE_COLOURS,
  PALETTE_PX,
  Saver,
  classifyTransfer,
  describePicture,
  exportFileName,
  exportScale,
  overCapMessage,
  readStoredView,
  tooBigMessage,
  writeStoredView,
  type PictureInfo,
  type Timers,
  type TransferSnapshot,
} from './session'

/* ------------------------------------------------------------------- seams --- */

/** What the session asks of the shell's React side. Every method may be called at any time after `start()`. */
export interface SessionUi {
  /** Open the picture picker. */
  openPicker(): void
  /** Show the info card of the picture with this item id. */
  showInfo(id: number): void
  /** Hide or show the toolbar and the status bar. */
  toggleHideUi(): void
  /** Open a toolbar menu (the Arrange menu on `A`). */
  openMenu(menu: 'arrange'): void
}

/** What only a browser can do. The shell passes the real ones (env.ts); tests pass fakes. */
export interface SessionEnv {
  timers: Timers
  /** Text measuring shared by the controller and the renderer (canvasTextMetrics over a canvas; the estimate without one). */
  metrics: TextMetrics
  storage(): Pick<Storage, 'getItem' | 'setItem'> | null
  /** The picture decoder the cache uses (createImageBitmap); the default of createImageLoader when left out. */
  createBitmap?: CreateBitmap
  /** A picture file's own size in pixels (upright, as the loader decodes it), or null when it is no picture the browser can read. */
  decodeSize(blob: Blob): Promise<{ w: number; h: number } | null>
  /** The picture's pixels scaled to at most `maxSide` on the longer side, as RGBA bytes, or null. */
  pixelsOf(bitmap: BitmapLike, maxSide: number): Uint8ClampedArray | null
  makeCanvas(w: number, h: number): ExportCanvas
  /** The canvas as PNG bytes, or null. */
  canvasToPng(canvas: ExportCanvas): Promise<Uint8Array | null>
  /** The time, for picture and export names. */
  now(): Date
}

/** The canvas on screen, for the sampler. */
export interface SessionSurface {
  /** The colour (6 hex digits) of the canvas pixel at `at` (CSS pixels), or null outside it. */
  readPixel(at: Vec2): string | null
}

export interface SessionOptions {
  host: BoardHost
  env: SessionEnv
  ui: SessionUi
  /** For tests: the cache to use. */
  makeCache?: (options: ImageCacheOptions) => ImageCache
}

export type SessionPhase = 'idle' | 'loading' | 'ready' | 'failed'
export type SaveState = 'saved' | 'saving' | 'unsaved' | 'failed'

/** Pictures opened in the image program by one command. */
const MAX_OPEN = 5
/** Pictures whose real size is read in the background after they were added from the vault. */
const MAX_PROBES = 200
/** How long after ⌘V the board waits for the browser's own paste event before it pastes its own items (ms). */
const PASTE_WAIT_MS = 150
/** Pictures that fit a preview's size completely: the picker's size probe asks for this much. */
const SIZE_PREVIEW_PX = 1024
/** Pictures held in the set of already-fed sizes before it is thrown away and learned again. */
const MAX_FED = 4096

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/* ----------------------------------------------------------------- session --- */

export class BoardSession {
  readonly host: BoardHost
  readonly env: SessionEnv
  private ui: SessionUi
  private readonly makeCache: (options: ImageCacheOptions) => ImageCache

  phase: SessionPhase = 'idle'
  /** Why the board could not be opened. */
  error = ''
  private ctrl: BoardController | null = null

  private started = false
  private cache: ImageCache | null = null
  private offs: (() => void)[] = []
  private readonly saver: Saver
  private rawBase = ''
  private lastDoc: BoardDoc | null = null
  private gen = 0
  private lastFinal = true
  private surface: SessionSurface | null = null
  private editor: { id: number; get(): string } | null = null

  private version = 0
  private readonly subs = new Set<() => void>()
  private readonly frameSubs = new Set<() => void>()

  private message: { text: string; tone: BoardTone } | null = null
  private messageTimer: unknown = null
  private activityText: string | null = null
  private retryTimer: unknown = null
  private pasteTimer: unknown = null
  private marker = ''
  private exporting = false
  private reloading = false
  private reloadAgain = false
  /** What the note's reader had to say, kept until the view starts (a toast is no business of a render). */
  private pendingNotice: string | null = null

  private readonly fed = new Map<string, { w: number; h: number }>()
  /** Pictures whose size the controller holds is the picture's own (not a guess from a preview). */
  private readonly exact = new Set<string>()
  private failedSeen = new Set<string>()
  private existed = new Map<string, boolean>()
  private pictureEpoch = 0
  private missingCache: { items: unknown; epoch: number; value: { count: number; sample: string[] } } | null = null
  private readonly probeQueue: string[] = []
  private probing = false
  private probeRun: Promise<void> | null = null

  constructor(opts: SessionOptions) {
    this.host = opts.host
    this.env = opts.env
    this.ui = opts.ui
    this.makeCache = opts.makeCache ?? ((o) => new ImageCache(o))
    this.saver = new Saver({
      timers: this.env.timers,
      run: () => this.writeBoard(),
      onError: (err, first) => {
        // Once per run of failures: the indicator keeps saying so, and the retry is silent.
        if (first) this.say(`The board could not be saved: ${errorText(err)}. It is kept here and tried again.`, 'error')
      },
      persistView: () => this.persistView(),
      onStatus: () => this.notify(),
    })
  }

  /** The shell's React side may be swapped (a new render's callbacks). */
  setUi(ui: SessionUi): void {
    this.ui = ui
  }

  get controller(): BoardController {
    if (!this.ctrl) throw new Error('the board is not loaded yet')
    return this.ctrl
  }

  get loaded(): boolean {
    return this.ctrl !== null
  }

  /* -------------------------------------------------------------- loading --- */

  /** Reads the note and opens the board. Resolves when it is ready or has failed (`phase`); never rejects. */
  async load(): Promise<void> {
    if (this.phase === 'loading' || this.phase === 'ready') return
    this.phase = 'loading'
    this.error = ''
    this.notify()
    let raw: string
    try {
      raw = await this.host.load()
    } catch (err) {
      this.fail(`The board could not be opened: ${errorText(err)}`)
      return
    }
    this.loadFromRaw(raw)
  }

  /** Opens the board from the note's text (the text is already in hand: no loading flash). */
  loadFromRaw(raw: string): boolean {
    if (this.ctrl) return true
    if (raw.trim() !== '' && !isBoardNote(raw)) {
      this.fail('This note is not a reference board (its type is not "board"), so it was left as it is.')
      return false
    }
    const parsed = parseBoard(raw)
    const blank = raw.trim() === ''
    this.rawBase = blank ? '' : raw
    let doc = blank ? { ...parsed.doc, title: this.host.title || parsed.doc.title } : parsed.doc
    // The camera remembered in this browser is newer than the file's: the file is only written with real changes.
    const stored = readStoredView(this.env.storage(), this.host.path)
    if (stored) doc = { ...doc, view: stored }
    this.ctrl = new BoardController({ doc, metrics: this.env.metrics, now: () => this.env.timers.now() })
    this.phase = 'ready'
    this.error = ''
    if (parsed.warnings.length > 0) {
      const more = parsed.warnings.length > 1 ? ` (and ${parsed.warnings.length - 1} more)` : ''
      const notice = `${parsed.warnings[0]}${more}`
      if (this.started) this.say(notice, 'info')
      else this.pendingNotice = notice
    }
    if (this.started) this.wire()
    this.notify()
    this.invalidate()
    return true
  }

  private fail(message: string): void {
    this.phase = 'failed'
    this.error = message
    this.notify()
  }

  /** Back to the start after a failed load (the Try again button). */
  retryLoad(): Promise<void> {
    if (this.phase !== 'failed') return Promise.resolve()
    this.phase = 'idle'
    return this.load()
  }

  /* ------------------------------------------------------------- lifecycle --- */

  start(): void {
    if (this.started) return
    this.started = true
    if (this.ctrl) this.wire()
    if (this.pendingNotice !== null) {
      const notice = this.pendingNotice
      this.pendingNotice = null
      this.say(notice, 'info')
    }
  }

  /**
   * Lets everything go: flushes a pending save (the write is on its way before this returns), drops the cache and every listener.
   * Resolves when the save has ended (or failed).
   */
  async stop(): Promise<void> {
    if (!this.started) return
    this.commitEditing()
    const flushed = this.saver.flush()
    this.started = false
    this.unwire()
    if (this.messageTimer !== null) this.env.timers.clear(this.messageTimer)
    this.messageTimer = null
    this.message = null
    if (this.retryTimer !== null) this.env.timers.clear(this.retryTimer)
    this.retryTimer = null
    this.cancelPasteWait()
    this.probeQueue.length = 0
    await flushed
    this.saver.stop()
  }

  private wire(): void {
    const c = this.controller
    this.cache = this.makeCache({ load: createImageLoader(this.host.pictures, this.env.createBitmap), onLoaded: () => this.invalidate() })
    this.fed.clear()
    this.offs.push(
      c.subscribe(() => this.invalidate()),
      c.onChange((doc, why) => this.onChange(doc, why)),
      c.onEvent((e) => this.handleEvent(e)),
    )
    const offPictures = this.host.pictures.onChange?.(() => this.onPicturesChanged())
    if (offPictures) this.offs.push(offPictures)
    const offExternal = this.host.onExternalChange?.(() => void this.onExternalChange())
    if (offExternal) this.offs.push(offExternal)
    this.snapshotExistence()
  }

  private unwire(): void {
    for (const off of this.offs.splice(0)) {
      try {
        off()
      } catch {
        /* a subscription that will not end has nothing left to listen to */
      }
    }
    this.cache?.dispose()
    this.cache = null
  }

  /* ---------------------------------------------------------- subscriptions --- */

  /** Called when anything the session reports changes (phase, save state, messages, activity). Returns the unsubscribe. */
  subscribe(cb: () => void): () => void {
    this.subs.add(cb)
    return () => void this.subs.delete(cb)
  }

  getVersion(): number {
    return this.version
  }

  private notify(): void {
    this.version++
    for (const cb of [...this.subs]) cb()
  }

  /** The view needs drawing again (the canvas's frame loop listens). */
  onFrameNeeded(cb: () => void): () => void {
    this.frameSubs.add(cb)
    return () => void this.frameSubs.delete(cb)
  }

  invalidate(): void {
    for (const cb of [...this.frameSubs]) cb()
  }

  /* ------------------------------------------------------------ what is shown --- */

  get saveState(): SaveState {
    if (this.saver.running) return 'saving'
    if (this.saver.failing) return 'failed'
    return this.saver.dirty ? 'unsaved' : 'saved'
  }

  /** The last thing the board said, for a few seconds. */
  get lastMessage(): { text: string; tone: BoardTone } | null {
    return this.message
  }

  /** What is going on in the background ("Adding 3 pictures…"), or null. */
  get activity(): string | null {
    return this.activityText
  }

  private setActivity(text: string | null): void {
    if (this.activityText === text) return
    this.activityText = text
    this.notify()
  }

  /** Tells the user: the host's toast, and the status bar remembers it for a few seconds. */
  say(text: string, tone: BoardTone = 'info'): void {
    this.message = { text, tone }
    if (this.messageTimer !== null) this.env.timers.clear(this.messageTimer)
    this.messageTimer = this.env.timers.set(() => {
      this.messageTimer = null
      this.message = null
      this.notify()
    }, HINT_MS)
    this.notify()
    try {
      this.host.toast(text, tone)
    } catch {
      /* a host that cannot show a toast must not break the board */
    }
  }

  /** Pictures of the board that the vault no longer has, as a count and a few names; nothing is ever removed from the board. */
  missingPictures(): { count: number; sample: string[] } {
    const items = this.ctrl?.state.doc.items
    if (!items) return { count: 0, sample: [] }
    const cached = this.missingCache
    if (cached && cached.items === items && cached.epoch === this.pictureEpoch) return cached.value
    const gone = boardPictures(this.ctrl!.state.doc).filter((p) => !this.host.pictures.exists(p))
    const value = { count: gone.length, sample: gone.slice(0, 3).map(baseName) }
    this.missingCache = { items, epoch: this.pictureEpoch, value }
    return value
  }

  /** The picture with item id `id`, described for the info card; null when it is gone or not a picture. */
  pictureInfo(id: number): PictureInfo | null {
    const item = this.ctrl?.state.doc.items.find((it) => it.id === id)
    if (!item || item.kind !== 'picture') return null
    return describePicture(item, this.naturalOf(item.path))
  }

  /** The picture's own size in pixels when it is known for sure (a preview's size is only a shape), else null. */
  naturalOf(path: string): { w: number; h: number } | null {
    return this.exact.has(path) ? (this.ctrl?.naturalSize(path) ?? null) : null
  }

  private markExact(path: string): void {
    if (this.exact.size >= MAX_FED) this.exact.clear()
    this.exact.add(path)
  }

  /** Reads the picture's own size in the background (the info card asks), unless it is known. */
  probeNatural(path: string): void {
    if (this.started && this.ctrl && !this.exact.has(path)) this.probe([path])
  }

  /** A screen point of the canvas (CSS pixels) as a board point. */
  toBoard(p: Vec2): Vec2 {
    const st = this.controller.state
    return screenToBoard(st.doc.view, st.viewport, p)
  }

  /** The middle of what the view shows, as a board point. */
  viewCentre(): Vec2 {
    const v = this.controller.state.doc.view
    return { x: v.x, y: v.y }
  }

  setSurface(surface: SessionSurface | null): void {
    this.surface = surface
  }

  /* ------------------------------------------------------------------ drawing --- */

  /**
   * Draws the board once. Tells the cache which pictures are in view first (only those load), hands it to the renderer as the picture
   * source, feeds the pictures' own sizes to the controller when they first appear, and arranges the next draw for when a failed
   * picture is due its retry.
   */
  draw(ctx: Ctx2D, dpr: number): void {
    const c = this.controller
    const st = c.state
    const doc = st.doc
    const cache = this.cache
    if (cache) cache.setVisible(visiblePictures(doc, doc.view, st.viewport, this.env.metrics))
    const arrived: [string, { w: number; h: number }][] = []
    const images: ImageSource = {
      get: (path, wantPx): ImageSlot => {
        const slot: ImageSlot = cache ? cache.get(path, wantPx) : { bitmap: null, natural: null, failed: false }
        if (slot.natural) {
          const known = this.fed.get(path)
          if (!known || known.w !== slot.natural.w || known.h !== slot.natural.h) arrived.push([path, slot.natural])
        }
        if (slot.failed) this.failedSeen.add(path)
        return slot
      },
    }
    drawBoard(ctx, {
      doc,
      view: doc.view,
      viewport: st.viewport,
      dpr,
      state: st,
      images,
      metrics: this.env.metrics,
      missing: (path) => !this.host.pictures.exists(path),
    })
    if (arrived.length > 0) {
      if (this.fed.size > MAX_FED) this.fed.clear()
      for (const [path, n] of arrived) {
        this.fed.set(path, n)
        this.markExact(path)
        c.setNaturalSize(path, n.w, n.h)
      }
      this.notify()
    }
    if (cache && cache.stats().failed > 0 && this.retryTimer === null) {
      this.retryTimer = this.env.timers.set(() => {
        this.retryTimer = null
        this.invalidate()
      }, DEFAULT_RETRY_MS)
    }
  }

  /* ----------------------------------------------------------------- the host --- */

  private snapshotExistence(): void {
    const next = new Map<string, boolean>()
    for (const p of boardPictures(this.controller.state.doc)) next.set(p, this.host.pictures.exists(p))
    this.existed = next
  }

  /** The vault's pictures changed: the ones that came or went, and the ones that could not be read, are read again. */
  private onPicturesChanged(): void {
    this.pictureEpoch++
    const cache = this.cache
    if (cache && this.ctrl) {
      const next = new Map<string, boolean>()
      for (const p of boardPictures(this.ctrl.state.doc)) {
        const now = this.host.pictures.exists(p)
        const was = this.existed.get(p)
        next.set(p, now)
        if ((was !== undefined && was !== now) || this.failedSeen.has(p)) {
          cache.forget(p)
          this.fed.delete(p)
        }
      }
      this.existed = next
    }
    this.failedSeen = new Set()
    this.notify()
    this.invalidate()
  }

  /** The note changed somewhere else. */
  private async onExternalChange(): Promise<void> {
    if (this.reloading) {
      this.reloadAgain = true
      return
    }
    this.reloading = true
    try {
      do {
        this.reloadAgain = false
        await this.reloadOnce()
      } while (this.reloadAgain && this.started)
    } finally {
      this.reloading = false
    }
  }

  private async reloadOnce(): Promise<void> {
    // A write of our own may be in flight: the change reported is probably its echo. Let it land, then judge.
    await this.saver.idle()
    if (!this.started || !this.ctrl) return
    // Unsaved work: a change not written yet, or a note still being typed (it is in nobody's history until it is committed).
    const unsaved = this.saver.dirty || this.ctrl.state.editingNote !== null
    let raw: string
    try {
      raw = await this.host.load()
    } catch (err) {
      this.say(`The board changed on disk but could not be read again: ${errorText(err)}`, 'error')
      return
    }
    if (!this.started || !this.ctrl) return
    if (raw === this.rawBase) return
    // Whatever the note says outside the board section is the base from now on: our next save merges into it.
    this.rawBase = raw
    if (unsaved) {
      this.say('The board was also changed outside this window. Your unsaved changes here are kept and will replace the board part of that change.', 'info')
      return
    }
    this.ctrl.replaceDoc(parseBoard(raw).doc)
  }

  /* ------------------------------------------------------------------- saving --- */

  private onChange(doc: BoardDoc, why: { reason: string; final: boolean; viewOnly: boolean }): void {
    if (!why.viewOnly) {
      this.lastDoc = doc
      this.gen++
      this.lastFinal = why.final
    }
    this.saver.note(why)
  }

  private persistView(): void {
    if (!this.ctrl) return
    writeStoredView(this.env.storage(), this.host.path, this.ctrl.state.doc.view)
  }

  /** One save: the board as the last change left it (with the camera as it is now) merged into the note; nothing is written when it is the same text. */
  private async writeBoard(): Promise<void> {
    const c = this.ctrl
    const base = this.lastDoc
    if (!c || !base) return
    const gen = this.gen
    const final = this.lastFinal
    const doc: BoardDoc = { ...base, view: c.state.doc.view }
    const now = this.env.now()
    const raw = this.rawBase === '' ? serializeBoard(doc, undefined, now) : serializeBoard(doc, this.rawBase, now)
    if (raw !== this.rawBase) {
      await this.host.save(raw)
      this.rawBase = raw
    }
    // Only a finished change that nothing has followed is what the file now holds; a drag in progress is not.
    if (this.gen === gen && final) c.markSaved()
  }

  /** Writes whatever is not written, a note being typed included (it is committed first). Resolves when it is on disk or the attempt failed; never rejects. */
  async flush(): Promise<void> {
    this.commitEditing()
    await this.saver.flush()
  }

  /** Writes what is pending without ending a note being typed (the window lost the focus: the text is still being written). */
  async save(): Promise<void> {
    await this.saver.flush()
  }

  /* ---------------------------------------------------------------- note edits --- */

  /** The note text box tells the session how to read its text (so that a press or a command can commit it first). Returns the unregister. */
  registerEditor(id: number, get: () => string): () => void {
    const entry = { id, get }
    this.editor = entry
    return () => {
      if (this.editor === entry) this.editor = null
    }
  }

  /** Commits the note being typed, if there is one. Always called before a press on the canvas or a command is forwarded. */
  commitEditing(): void {
    const c = this.ctrl
    if (!c) return
    const editing = c.state.editingNote
    if (editing === null) return
    if (this.editor && this.editor.id === editing) c.commitNoteText(editing, this.editor.get())
    else c.cancelNoteEdit()
  }

  /* ------------------------------------------------------------------- input --- */

  /** A press on the canvas: a note being typed is committed first (the controller drops a press while one is edited). */
  pointerDown(e: PointerIn): void {
    this.commitEditing()
    this.controller.pointerDown(e)
  }

  /** Runs a command from a button, a menu or the palette. */
  exec(id: BoardCommandId, arg?: unknown): void {
    this.commitEditing()
    const count = this.controller.state.selection.length
    this.controller.exec(id, arg)
    if (id === 'edit.copy' || id === 'edit.cut') this.markClipboard(count)
  }

  /**
   * A key press or release (the shell has already left text fields alone). True when the board used it.
   * ⌘V is the browser's: the paste event decides between a picture on the system clipboard and the board's own items, so the key is
   * not consumed; when no paste event follows, the board pastes its own items.
   */
  key(k: KeyIn): boolean {
    const c = this.controller
    const st = c.state
    const id = k.down ? keyToCommand(k, { tool: st.tool, editing: st.editingNote !== null, cropping: st.cropping !== null }) : null
    if (id === 'edit.paste') {
      this.expectPaste()
      return false
    }
    const count = st.selection.length
    const used = c.key(k)
    if (used && (id === 'edit.copy' || id === 'edit.cut')) this.markClipboard(count)
    return used
  }

  private expectPaste(): void {
    this.cancelPasteWait()
    this.pasteTimer = this.env.timers.set(() => {
      this.pasteTimer = null
      if (this.started) this.exec('edit.paste')
    }, PASTE_WAIT_MS)
  }

  private cancelPasteWait(): void {
    if (this.pasteTimer === null) return
    this.env.timers.clear(this.pasteTimer)
    this.pasteTimer = null
  }

  /** The board's own copy also leaves a line on the system clipboard, so that a paste can tell it from something copied since. */
  private markClipboard(count: number): void {
    const c = this.ctrl
    if (!c || !c.state.canPaste) return
    this.marker = `Aether Brain board: ${count} item${count === 1 ? '' : 's'} copied`
    this.host.copyText(this.marker).catch(() => undefined)
  }

  /* ------------------------------------------------------------- events in --- */

  /** Everything the controller asks of the shell. */
  handleEvent(e: BoardEvent): void {
    switch (e.type) {
      case 'toast':
        this.say(e.text, e.tone)
        return
      case 'sample-request': {
        const hex = this.surface ? this.surface.readPixel(e.at) : null
        this.controller.sampleAt(e.at, hex)
        return
      }
      case 'sample-commit': {
        const text = `#${e.hex}`
        this.host.copyText(text).then(
          () => this.say(`Copied ${text}`, 'success'),
          (err: unknown) => this.say(`Could not copy ${text}: ${errorText(err)}`, 'error'),
        )
        return
      }
      case 'palette-request':
        void this.extractPalette(e.ids, e.near)
        return
      case 'command':
        this.handleCommand(e)
        return
    }
  }

  private handleCommand(e: Extract<BoardEvent, { type: 'command' }>): void {
    const pictures = this.host.pictures
    switch (e.id) {
      case 'arrange.menu':
        this.ui.openMenu('arrange')
        return
      case 'view.hideUi':
        this.ui.toggleHideUi()
        return
      case 'picture.add':
        this.ui.openPicker()
        return
      case 'picture.open': {
        if (!pictures.open) return this.say('Opening a picture in an image program needs the desktop app.')
        for (const p of e.paths.slice(0, MAX_OPEN)) pictures.open(p)
        if (e.paths.length > MAX_OPEN) this.say(`Opened the first ${MAX_OPEN} of ${e.paths.length} pictures.`)
        return
      }
      case 'picture.reveal': {
        if (!pictures.reveal) return this.say('Showing a picture in the file manager needs the desktop app.')
        const first = e.paths[0]
        if (first !== undefined) pictures.reveal(first)
        if (e.paths.length > 1) this.say('Showing the first picture of the selection.')
        return
      }
      case 'picture.showInBrain': {
        if (!pictures.showInBrain) return this.say('Showing a picture in the brain is only possible from the board in the app window.')
        const first = e.paths[0]
        if (first !== undefined) pictures.showInBrain(first)
        if (e.paths.length > 1) this.say('Showing the first picture of the selection in the brain.')
        return
      }
      case 'picture.info': {
        if (e.ids.length !== 1) return this.say('Select one picture to see its info.')
        this.ui.showInfo(e.ids[0]!)
        return
      }
      case 'export.selection':
        void this.exportItems(e.ids, 'selection')
        return
      case 'export.board':
        void this.exportItems(null, 'board')
        return
      case 'window.popOut':
        if (this.host.window && !this.host.window.floating) this.host.window.popOut()
        else if (!this.host.window) this.say('A board can be popped out into its own window in the desktop app.')
        return
      case 'window.dock':
        if (this.host.window?.floating) this.host.window.dock()
        return
      case 'window.onTop': {
        const w = this.host.window
        if (w) w.setAlwaysOnTop(!w.alwaysOnTop)
        else this.say('Keeping the board on top needs the desktop app.')
        return
      }
      default:
        return
    }
  }

  /* -------------------------------------------------------------- palette --- */

  private async extractPalette(ids: readonly number[], near: Vec2): Promise<void> {
    const c = this.controller
    const doc = c.state.doc
    const paths: string[] = []
    for (const id of ids) {
      const it = doc.items.find((x) => x.id === id)
      if (it?.kind === 'picture' && !paths.includes(it.path)) paths.push(it.path)
    }
    const loader = createImageLoader(this.host.pictures, this.env.createBitmap)
    const chunks: Uint8ClampedArray[] = []
    this.setActivity('Reading colours…')
    try {
      for (const path of paths.slice(0, MAX_PALETTE_PICTURES)) {
        // The cache's bitmap when it holds one (used on the spot: it is closed only between frames), else a small preview of our own.
        let owned: BitmapLike | null = null
        let bmp: BitmapLike | null = (this.cache?.get(path, PALETTE_PX).bitmap as BitmapLike | null | undefined) ?? null
        if (!bmp) {
          const loaded = await loader(path, 256)
          owned = loaded?.bitmap ?? null
          bmp = owned
        }
        try {
          const px = bmp ? this.env.pixelsOf(bmp, PALETTE_PX) : null
          if (px) chunks.push(px)
        } finally {
          try {
            owned?.close()
          } catch {
            /* nothing left to give back */
          }
        }
        if (!this.started) return
      }
    } finally {
      this.setActivity(null)
    }
    if (chunks.length === 0) {
      this.say('The colours could not be read: the pictures could not be opened.', 'error')
      return
    }
    let total = 0
    for (const ch of chunks) total += ch.length
    const all = new Uint8ClampedArray(total)
    let at = 0
    for (const ch of chunks) {
      all.set(ch, at)
      at += ch.length
    }
    const colours = dominantColours(all, PALETTE_COLOURS)
    if (colours.length === 0) {
      this.say('No colours to take from those pictures (they are transparent).', 'info')
      return
    }
    const made = c.addSwatches(colours, near)
    if (made.length > 0) this.say(`Added ${made.length} colour${made.length === 1 ? '' : 's'} next to the picture${paths.length === 1 ? '' : 's'}.`, 'success')
  }

  /* --------------------------------------------------------------- export --- */

  /** Draws the items (null: the whole board) into a picture and saves it in the board's folder. */
  async exportItems(ids: readonly number[] | null, what: 'selection' | 'board'): Promise<void> {
    if (this.exporting) {
      this.say('An export is already running.')
      return
    }
    const c = this.controller
    this.exporting = true
    this.setActivity(`Exporting the ${what}…`)
    try {
      // The scale follows the finest picture in it, so the pictures' own sizes have to be known first (a picture that was never
      // zoomed to has not had its size read). A size learned may also correct a picture's shape, so the board is taken after.
      const wanted = ids ? new Set(ids) : null
      const paths = [...new Set(c.state.doc.items.flatMap((it) => (it.kind === 'picture' && (!wanted || wanted.has(it.id)) ? [it.path] : [])))]
      await this.learnNaturals(paths)
      const doc = c.state.doc
      const scale = exportScale(doc, ids, (p) => this.naturalOf(p), this.env.metrics)
      const loader = createImageLoader(this.host.pictures, this.env.createBitmap)
      const result = await exportBoard(
        doc,
        ids,
        scale,
        {
          get: async (path) => (await loader(path, 8192))?.bitmap ?? null,
          release: (_path, bitmap) => bitmap.close(),
        },
        (w, h) => this.env.makeCanvas(w, h),
        this.env.metrics,
      )
      if (!result) {
        this.say('There is nothing to export.', 'info')
        return
      }
      const data = await this.env.canvasToPng(result.canvas)
      // The canvas can be 8192 square: let go of it now.
      result.canvas.width = 0
      result.canvas.height = 0
      if (!data) {
        this.say('The picture could not be made.', 'error')
        return
      }
      const name = exportFileName(c.state.doc.title || this.host.title, this.env.now())
      const [path] = await this.host.pictures.add([{ name, data }])
      if (!path) this.say('The vault refused the exported picture (too big?).', 'error')
      else this.say(`Saved ${baseName(path)} in the board's folder`, 'success')
    } catch (err) {
      this.say(`The export failed: ${errorText(err)}`, 'error')
    } finally {
      this.exporting = false
      this.setActivity(null)
    }
  }

  /* --------------------------------------------------- drops, pastes, pictures --- */

  /**
   * A drop or a paste, already read out of its DataTransfer. Pictures are saved into the board's folder and put on the board
   * around `at` (a board point; the middle of the view when null); an address is refused with the reason; text becomes a note.
   * Resolves 'nothing' when the transfer held nothing a board can use (a paste then falls back to the board's own items).
   */
  async handleTransfer(t: TransferSnapshot<File>, at: Vec2 | null): Promise<'handled' | 'nothing'> {
    const plan = classifyTransfer(t)
    switch (plan.kind) {
      case 'files':
        if (plan.ignored > 0) this.say(MESSAGES.onlyPictures)
        if (plan.tooBig.length > 0) this.say(tooBigMessage(plan.tooBig), 'error')
        if (plan.overCap > 0) this.say(overCapMessage(plan.pictures.length, plan.overCap))
        if (plan.pictures.length > 0) await this.addFiles(plan.pictures, at)
        return 'handled'
      case 'url':
        this.say(MESSAGES.noNetwork)
        return 'handled'
      case 'text':
        this.addText(plan.text, at)
        if (plan.truncated) this.say(`The text is longer than a note can hold; the first ${BOARD_LIMITS.noteChars} characters were kept.`)
        return 'handled'
      case 'nothing':
        return 'nothing'
    }
  }

  /** The paste event. Text that is the board's own copy marker (nothing copied since) pastes the board's items. */
  async handlePaste(t: TransferSnapshot<File>, at: Vec2 | null): Promise<void> {
    this.cancelPasteWait()
    const own = this.marker !== '' && t.files.length === 0 && t.text.trim() === this.marker
    const result = own ? 'nothing' : await this.handleTransfer(t, at)
    if (result === 'nothing') {
      if (this.controller.state.canPaste) this.exec('edit.paste')
      else this.say(MESSAGES.nothing)
    }
  }

  /** A note with this text, top-left corner at `at` (the middle of the view when null). */
  addText(text: string, at: Vec2 | null): void {
    const c = this.controller
    const zoom = c.state.doc.view.zoom
    const centre = this.viewCentre()
    const p = at ?? { x: centre.x - 120 / zoom, y: centre.y - 20 / zoom }
    const id = c.addNoteAt(p)
    if (id > 0) c.commitNoteText(id, text)
  }

  /**
   * Picture files: their own size from the browser, their bytes into the board's folder through the host, in chunks of a few files
   * and some megabytes (a drop of forty large pictures never sits in memory whole), then all of them on the board at once.
   */
  async addFiles(files: readonly File[], at: Vec2 | null): Promise<void> {
    if (files.length === 0) return
    this.setActivity(`Adding ${files.length} picture${files.length === 1 ? '' : 's'}…`)
    const items: { path: string; w: number; h: number }[] = []
    let unreadable = 0
    let refused = 0
    try {
      for (let i = 0; i < files.length; ) {
        const chunk: File[] = []
        let bytes = 0
        while (i < files.length && chunk.length < DROP_CHUNK_FILES && (chunk.length === 0 || bytes + files[i]!.size <= DROP_CHUNK_BYTES)) {
          bytes += files[i]!.size
          chunk.push(files[i++]!)
        }
        const prepared = await Promise.all(
          chunk.map(async (f) => {
            try {
              const size = await this.env.decodeSize(f)
              if (!size) return null
              return { f, size, data: new Uint8Array(await f.arrayBuffer()) }
            } catch {
              return null
            }
          }),
        )
        const ok = prepared.filter((p): p is NonNullable<typeof p> => p !== null)
        unreadable += prepared.length - ok.length
        if (ok.length === 0) continue
        let paths: (string | null)[]
        try {
          const now = this.env.now()
          paths = await this.host.pictures.add(ok.map((p) => ({ name: boardPictureName(p.f.name, p.f.type, now), data: p.data })))
        } catch (err) {
          this.say(`The pictures could not be saved: ${errorText(err)}`, 'error')
          continue
        }
        ok.forEach((p, k) => {
          const path = paths[k]
          if (path) {
            items.push({ path, w: p.size.w, h: p.size.h })
            this.markExact(path)
          } else refused++
        })
      }
      if (unreadable > 0) this.say(`${unreadable} file${unreadable === 1 ? '' : 's'} could not be read as ${unreadable === 1 ? 'a picture' : 'pictures'}.`, 'error')
      if (refused > 0) this.say(`The vault refused ${refused} picture${refused === 1 ? '' : 's'} (a type it does not know, or over 40 MB).`, 'error')
      if (items.length > 0 && this.started) this.controller.addPictures(items, at ?? undefined)
    } finally {
      this.setActivity(null)
    }
  }

  /**
   * Pictures that are already in the vault (the picker): put on the board where the view is looking. Their shape comes from a
   * preview at once; a picture bigger than the preview has its real size read in the background afterwards and corrected.
   */
  async addVaultPictures(paths: readonly string[], at: Vec2 | null = null): Promise<void> {
    if (paths.length === 0) return
    this.setActivity(`Adding ${paths.length} picture${paths.length === 1 ? '' : 's'}…`)
    try {
      const sizes: ({ w: number; h: number; exact: boolean } | null)[] = []
      for (let i = 0; i < paths.length; i += 4) {
        sizes.push(...(await Promise.all(paths.slice(i, i + 4).map((p) => this.previewSize(p)))))
      }
      if (!this.started) return
      const items = paths.map((path, k) => ({ path, w: sizes[k]?.w ?? 0, h: sizes[k]?.h ?? 0 }))
      this.controller.addPictures(items, at ?? undefined)
      paths.forEach((p, k) => sizes[k]?.exact && this.markExact(p))
      this.probe(paths.filter((_, k) => sizes[k] !== null && !sizes[k]!.exact))
    } finally {
      this.setActivity(null)
    }
  }

  private async previewSize(path: string): Promise<{ w: number; h: number; exact: boolean } | null> {
    const known = this.naturalOf(path)
    if (known) return { ...known, exact: true }
    try {
      const blob = await this.host.pictures.preview(path, SIZE_PREVIEW_PX)
      if (!blob) return null
      const size = await this.env.decodeSize(blob)
      if (!size) return null
      return { ...size, exact: Math.max(size.w, size.h) < SIZE_PREVIEW_PX }
    } catch {
      return null
    }
  }

  private probe(paths: readonly string[]): void {
    for (const p of paths) if (this.probeQueue.length < MAX_PROBES && !this.probeQueue.includes(p)) this.probeQueue.push(p)
    // Gated by a flag of its own: a run that has nothing to do ends before `probeRun` is even assigned.
    if (this.probing || this.probeQueue.length === 0) return
    this.probing = true
    this.probeRun = this.runProbes()
  }

  /** Reads the real sizes one picture at a time, so that the board never waits on a stack of large decodes. */
  private async runProbes(): Promise<void> {
    try {
      while (this.started && this.probeQueue.length > 0) {
        const path = this.probeQueue.shift()!
        try {
          const blob = await this.host.pictures.original(path)
          const size = blob ? await this.env.decodeSize(blob) : null
          if (size && this.started) {
            this.controller.setNaturalSize(path, size.w, size.h)
            this.markExact(path)
            this.notify()
          }
        } catch {
          /* a picture whose size cannot be read keeps the shape its preview gave */
        }
      }
    } finally {
      this.probing = false
      this.probeRun = null
    }
  }

  /** Reads the real sizes of these pictures now, one at a time (an export needs them before it starts). */
  private async learnNaturals(paths: readonly string[]): Promise<void> {
    for (const path of paths.slice(0, MAX_PROBES)) {
      if (this.exact.has(path) || !this.started) continue
      try {
        const blob = await this.host.pictures.original(path)
        const size = blob ? await this.env.decodeSize(blob) : null
        if (size && this.started) {
          this.controller.setNaturalSize(path, size.w, size.h)
          this.markExact(path)
        }
      } catch {
        /* a picture whose size cannot be read is exported at the board's own scale */
      }
    }
  }

  /** Resolves when the background reads of real picture sizes have ended (tests wait for them with this). */
  settled(): Promise<void> {
    return this.probeRun ?? Promise.resolve()
  }
}
