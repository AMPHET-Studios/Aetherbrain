import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { newBoardNote } from '@aether/core'
import { IPC, type AetherBridge, type BoardStatusDto, type ReadAssetResult, type VaultAssetDto, type VaultChangeDto } from '../src/shared/ipc.js'
import { ECHO_TEXTS, MAX_NAME_TRIES, PICTURE_CHANGE_MS, boardFolderOfPath, createFloatingBoardHost, numberedName, sniffMime } from '../src/renderer/board-host.js'
import { FsVault, isAssetName } from '../src/main/fsvault.js'
import { CRASH_WINDOW_MS } from '../src/main/crash.js'
import { lf } from './lf.js'
import {
  BOARD_DEFAULT_HEIGHT,
  BOARD_DEFAULT_WIDTH,
  BOARD_MIN_HEIGHT,
  BOARD_MIN_OPACITY,
  BOARD_MIN_WIDTH,
  BOARD_REVEAL_MS,
  BOARD_SAVE_MS,
  BOARD_TITLE,
  BoardWindowHost,
  LEDGER_MAX,
  PictureLedger,
  boardHandlers,
  boardNavigationAllowed,
  boardPageUrl,
  boardSettings,
  boardWindowOptions,
  cleanBoardPath,
  cleanConfigure,
  clampBoardBounds,
  clampOpacity,
  pictureChanges,
  supportsOpacity,
  workAreasOf,
  type Area,
  type BoardElectron,
  type BoardSettings,
} from '../src/main/board-window.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PRELOAD = '/app/dist/preload/board-preload.cjs'
const PAGE = path.join(path.sep === '\\' ? 'C:\\app\\dist\\renderer' : '/app/dist/renderer', 'board.html')
const DEV = 'http://localhost:5174'
const NOW = new Date('2026-10-09T12:00:00Z')
const BOARD = 'Boards/Gate.md'
const OTHER = 'Boards/Rust.md'

/* ------------------------------------------------------------------ */
/* Fake windows                                                       */
/* ------------------------------------------------------------------ */

let nextContentsId = 1
class FakeContents extends EventEmitter {
  readonly id = nextContentsId++
  sent: [string, unknown][] = []
  destroyed = false
  /**
   * A page still loading has nothing to save, so the close handshake does not wait for it (FlushGate.askable): the tests of this file
   * that are about something else close windows at once. The handshake's own tests (board-fix-desktop-close.test.ts) have their own fakes.
   */
  loading = true
  crashed = false
  reloads = 0
  openHandler: ((d: { url: string }) => { action: string }) | null = null
  /** Set to make `send` throw like a webContents that went away mid-send. */
  sendThrows = false
  send(channel: string, payload: unknown): void {
    if (this.sendThrows) throw new Error('Object has been destroyed')
    this.sent.push([channel, payload])
  }
  setWindowOpenHandler(fn: (d: { url: string }) => { action: string }): void {
    this.openHandler = fn
  }
  reload(): void {
    this.reloads++
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isLoading(): boolean {
    return this.loading
  }
  isCrashed(): boolean {
    return this.crashed
  }
  /** What was sent on one channel. */
  on_(channel: string): unknown[] {
    return this.sent.filter(([c]) => c === channel).map(([, p]) => p)
  }
}

class FakeWindow extends EventEmitter {
  static made: FakeWindow[] = []
  readonly webContents = new FakeContents()
  loaded: { url?: string; file?: string; query?: Record<string, string> }[] = []
  focused = 0
  visible = false
  minimized = false
  gone = false
  closeCalls = 0
  onTop: [boolean, string | undefined][] = []
  opacities: number[] = []
  bounds = { x: 100, y: 80, width: 800, height: 600 }
  /** Make the next loads fail like Electron's. */
  loadError: (Error & { code?: string }) | null = null
  /** Hold every load until this resolves. */
  loadGate: Promise<void> | null = null
  constructor(readonly options: Record<string, unknown> = {}) {
    super()
  }
  isDestroyed(): boolean {
    return this.gone
  }
  isMinimized(): boolean {
    return this.minimized
  }
  isVisible(): boolean {
    return this.visible
  }
  restore(): void {
    this.minimized = false
  }
  focus(): void {
    this.focused++
  }
  show(): void {
    this.visible = true
  }
  setAlwaysOnTop(flag: boolean, level?: string): void {
    this.onTop.push([flag, level])
  }
  setOpacity(o: number): void {
    this.opacities.push(o)
  }
  getNormalBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.bounds }
  }
  /** Electron: 'close' first (a listener may prevent it), then the window is destroyed and 'closed' follows. */
  close(): void {
    if (this.gone) return
    this.closeCalls++
    let prevented = false
    this.emit('close', { preventDefault: () => void (prevented = true) })
    if (!prevented) this.destroy()
  }
  allWorkspaces: [boolean, unknown][] = []
  setVisibleOnAllWorkspaces(on: boolean, options?: unknown): void {
    this.allWorkspaces.push([on, options])
  }
  destroy(): void {
    if (this.gone) return
    this.gone = true
    this.webContents.destroyed = true
    this.emit('closed')
  }
  private async load(entry: { url?: string; file?: string; query?: Record<string, string> }): Promise<void> {
    this.loaded.push(entry)
    await this.loadGate
    if (this.loadError) throw this.loadError
  }
  loadURL(url: string): Promise<void> {
    return this.load({ url })
  }
  loadFile(file: string, opts?: { query?: Record<string, string> }): Promise<void> {
    return this.load({ file, ...(opts?.query ? { query: opts.query } : {}) })
  }
}

const display = (id: number, x: number, y: number, width: number, height: number) => ({ id, workArea: { x, y, width, height } })

interface SetupOptions {
  platform?: NodeJS.Platform
  settings?: unknown
  displays?: ReturnType<typeof display>[]
  devUrl?: string | null
  brain?: FakeWindow | null
  save?: (s: BoardSettings) => unknown
}

function setup(o: SetupOptions = {}) {
  FakeWindow.made = []
  const brain = o.brain === undefined ? new FakeWindow() : o.brain
  let currentBrain: FakeWindow | null = brain
  const saved: BoardSettings[] = []
  const shell = { openExternal: vi.fn(async () => undefined) }
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })) }
  const displays = o.displays ?? [display(1, 0, 0, 1920, 1040)]
  const electron = {
    BrowserWindow: class extends FakeWindow {
      constructor(options: Record<string, unknown>) {
        super(options)
        FakeWindow.made.push(this)
      }
    },
    screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0] },
    shell,
    dialog,
  } as unknown as BoardElectron
  const host = new BoardWindowHost({
    electron,
    settings: o.settings as BoardSettings,
    save: o.save ?? ((s) => void saved.push(s)),
    brain: () => currentBrain as never,
    preload: PRELOAD,
    devUrl: o.devUrl === undefined ? null : o.devUrl,
    pageFile: PAGE,
    platform: o.platform ?? 'win32',
  })
  return {
    host,
    brain,
    saved,
    shell,
    dialog,
    /** Replace the brain window (macOS: closed, then another opened by `activate`). */
    setBrain: (b: FakeWindow | null) => void (currentBrain = b),
    get win(): FakeWindow {
      const w = FakeWindow.made.at(-1)
      if (!w) throw new Error('no board window was made')
      return w
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/* ------------------------------------------------------------------ */
/* Settings, bounds, options (pure)                                   */
/* ------------------------------------------------------------------ */

describe('boardSettings', () => {
  const DEFAULTS = { width: BOARD_DEFAULT_WIDTH, height: BOARD_DEFAULT_HEIGHT, alwaysOnTop: true, opacity: 1 }

  it('fills in defaults for anything that is not a settings object', () => {
    for (const raw of [undefined, null, 'x', 7, true, [], [1, 2], () => 1]) expect(boardSettings(raw)).toEqual(DEFAULTS)
    expect(boardSettings({})).toEqual(DEFAULTS)
    expect(BOARD_DEFAULT_WIDTH).toBe(640)
    expect(BOARD_DEFAULT_HEIGHT).toBe(480)
  })

  it('keeps a position only when both coordinates are numbers within reach', () => {
    expect(boardSettings({ x: 10.4, y: -20.6 })).toEqual({ ...DEFAULTS, x: 10, y: -21 })
    expect(boardSettings({ x: -1920, y: 300 })).toMatchObject({ x: -1920, y: 300 })
    expect(boardSettings({ x: 100_000, y: -100_000 })).toMatchObject({ x: 100_000, y: -100_000 })
    for (const bad of [{ x: 5 }, { y: 5 }, { x: 5, y: '7' }, { x: Number.NaN, y: 1 }, { x: 1, y: Infinity }, { x: 100_001, y: 0 }, { x: 0, y: -1e9 }, { x: null, y: null }]) {
      const out = boardSettings(bad)
      expect(out, JSON.stringify(bad)).toEqual(DEFAULTS)
      expect('x' in out || 'y' in out).toBe(false)
    }
  })

  it('cuts sizes to the smallest window and to 16,384', () => {
    expect(boardSettings({ width: 10, height: 5 })).toMatchObject({ width: BOARD_MIN_WIDTH, height: BOARD_MIN_HEIGHT })
    expect(boardSettings({ width: 99_999, height: 1e9 })).toMatchObject({ width: 16_384, height: 16_384 })
    expect(boardSettings({ width: 799.6, height: 400.4 })).toMatchObject({ width: 800, height: 400 })
    expect(boardSettings({ width: -5, height: 0 })).toMatchObject({ width: BOARD_MIN_WIDTH, height: BOARD_MIN_HEIGHT })
    for (const bad of [Number.NaN, '800', null, undefined, {}, Infinity, -Infinity]) {
      const out = boardSettings({ width: bad, height: bad })
      // An infinite size is "not a number I can use", like text: the default, never 16,384 by accident.
      expect(out, String(bad)).toMatchObject({ width: BOARD_DEFAULT_WIDTH, height: BOARD_DEFAULT_HEIGHT })
    }
  })

  it('stays on top unless the file says `false`, and clamps opacity to 0.2 to 1', () => {
    for (const v of [true, 0, 1, 'no', null, undefined, {}]) expect(boardSettings({ alwaysOnTop: v }).alwaysOnTop, String(v)).toBe(true)
    expect(boardSettings({ alwaysOnTop: false }).alwaysOnTop).toBe(false)
    expect(BOARD_MIN_OPACITY).toBe(0.2)
    expect(boardSettings({ opacity: 0.1 }).opacity).toBe(0.2)
    expect(boardSettings({ opacity: 0 }).opacity).toBe(0.2)
    expect(boardSettings({ opacity: -3 }).opacity).toBe(0.2)
    expect(boardSettings({ opacity: 7 }).opacity).toBe(1)
    expect(boardSettings({ opacity: 0.456 }).opacity).toBe(0.46)
    for (const bad of [Number.NaN, '0.5', null, undefined, {}]) expect(boardSettings({ opacity: bad }).opacity, String(bad)).toBe(1)
  })

  it('drops every other field and does not touch what it was given', () => {
    const raw = { x: 1, y: 2, width: 700, height: 500, alwaysOnTop: false, opacity: 0.5, junk: 'x', __proto__: { polluted: true } }
    const frozen = JSON.stringify(raw)
    expect(boardSettings(raw)).toEqual({ x: 1, y: 2, width: 700, height: 500, alwaysOnTop: false, opacity: 0.5 })
    expect(JSON.stringify(raw)).toBe(frozen)
    // Sanitising twice is the same as once.
    const once = boardSettings(raw)
    expect(boardSettings(once)).toEqual(once)
  })
})

describe('clampOpacity and supportsOpacity', () => {
  it('turns any number into 0.2 to 1 with two decimals, and anything else into null', () => {
    expect(clampOpacity(0.5)).toBe(0.5)
    expect(clampOpacity(1)).toBe(1)
    expect(clampOpacity(0.2)).toBe(0.2)
    expect(clampOpacity(0.05)).toBe(0.2)
    expect(clampOpacity(-1)).toBe(0.2)
    expect(clampOpacity(-Infinity)).toBe(0.2)
    expect(clampOpacity(1.5)).toBe(1)
    expect(clampOpacity(Infinity)).toBe(1)
    expect(clampOpacity(0.3333)).toBe(0.33)
    for (const bad of [Number.NaN, '0.5', null, undefined, {}, [0.5], true]) expect(clampOpacity(bad), String(bad)).toBeNull()
  })

  it('offers window opacity on Windows and macOS only', () => {
    expect(supportsOpacity('win32')).toBe(true)
    expect(supportsOpacity('darwin')).toBe(true)
    for (const p of ['linux', 'freebsd', 'openbsd', 'aix', 'android'] as const) expect(supportsOpacity(p), p).toBe(false)
  })
})

describe('clampBoardBounds', () => {
  const one: Area[] = [{ x: 0, y: 0, width: 1920, height: 1040 }]
  const two: Area[] = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: -1280, y: -100, width: 1280, height: 984 },
  ]

  it('leaves a window that is wholly on a display where it is', () => {
    expect(clampBoardBounds({ x: 300, y: 200, width: 640, height: 480 }, one)).toEqual({ x: 300, y: 200, width: 640, height: 480 })
    expect(clampBoardBounds({ x: 0, y: 0, width: 1920, height: 1040 }, one)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
  })

  it('centres a window that was never placed, or whose position is half there, on the first display', () => {
    const centred = { x: 640, y: 280, width: 640, height: 480 }
    expect(clampBoardBounds({ width: 640, height: 480 }, one)).toEqual(centred)
    expect(clampBoardBounds({ x: 10, width: 640, height: 480 }, one)).toEqual(centred)
    expect(clampBoardBounds({ y: 10, width: 640, height: 480 }, one)).toEqual(centred)
    expect(clampBoardBounds({ x: Number.NaN, y: 10, width: 640, height: 480 }, one)).toEqual(centred)
  })

  it('centres a window saved off every display (a monitor that is gone) on the first one', () => {
    for (const [x, y] of [[5000, 5000], [-9000, 100], [100, -9000], [1920, 0], [0, 1040], [-640, 0]] as const) {
      expect(clampBoardBounds({ x, y, width: 640, height: 480 }, one), `${x},${y}`).toEqual({ x: 640, y: 280, width: 640, height: 480 })
    }
  })

  it('pulls a window that hangs over an edge back inside, and keeps negative coordinates on a display left of the first', () => {
    expect(clampBoardBounds({ x: 1800, y: 900, width: 640, height: 480 }, one)).toEqual({ x: 1280, y: 560, width: 640, height: 480 })
    expect(clampBoardBounds({ x: -300, y: -200, width: 640, height: 480 }, one)).toEqual({ x: 0, y: 0, width: 640, height: 480 })
    expect(clampBoardBounds({ x: -1000, y: 0, width: 640, height: 480 }, two)).toEqual({ x: -1000, y: 0, width: 640, height: 480 })
    // Hanging over the left display's left edge: pulled onto that display, not onto the first.
    expect(clampBoardBounds({ x: -1500, y: -50, width: 640, height: 480 }, two)).toEqual({ x: -1280, y: -50, width: 640, height: 480 })
  })

  it('picks the display the window overlaps most', () => {
    // 300 px on the left display, 340 on the first.
    expect(clampBoardBounds({ x: -300, y: 0, width: 640, height: 480 }, two)).toEqual({ x: 0, y: 0, width: 640, height: 480 })
    // 500 on the left, 140 on the first: it belongs to the left display, and is pulled wholly onto it.
    expect(clampBoardBounds({ x: -500, y: 0, width: 640, height: 480 }, two)).toEqual({ x: -640, y: 0, width: 640, height: 480 })
  })

  it('makes a tiny window 320 × 240 and cuts a huge one to its display', () => {
    expect(clampBoardBounds({ x: 100, y: 100, width: 10, height: 5 }, one)).toEqual({ x: 100, y: 100, width: BOARD_MIN_WIDTH, height: BOARD_MIN_HEIGHT })
    expect(clampBoardBounds({ x: 100, y: 100, width: -50, height: 0 }, one)).toEqual({ x: 100, y: 100, width: BOARD_MIN_WIDTH, height: BOARD_MIN_HEIGHT })
    expect(clampBoardBounds({ x: 100, y: 100, width: 9000, height: 7000 }, one)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
    // Mostly over the left display: that display's size.
    expect(clampBoardBounds({ x: -8900, y: 0, width: 9000, height: 7000 }, two)).toEqual({ x: -1280, y: -100, width: 1280, height: 984 })
    expect(clampBoardBounds({ x: 10, y: 10, width: Number.NaN, height: Infinity }, one)).toEqual({ x: 10, y: 10, width: BOARD_DEFAULT_WIDTH, height: BOARD_DEFAULT_HEIGHT })
  })

  it('pins a window larger than a tiny display to the display\'s top-left corner (it cannot fit)', () => {
    const tiny: Area[] = [{ x: 50, y: 60, width: 200, height: 150 }]
    expect(clampBoardBounds({ x: 60, y: 70, width: 640, height: 480 }, tiny)).toEqual({ x: 50, y: 60, width: BOARD_MIN_WIDTH, height: BOARD_MIN_HEIGHT })
  })

  it('rounds, and ignores displays with no usable area', () => {
    expect(clampBoardBounds({ x: 100.6, y: 200.4, width: 640.5, height: 480.4 }, one)).toEqual({ x: 101, y: 200, width: 641, height: 480 })
    const junk: Area[] = [
      { x: 0, y: 0, width: 0, height: 100 },
      { x: Number.NaN, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 100, height: -5 },
    ]
    expect(clampBoardBounds({ x: 100, y: 100, width: 640, height: 480 }, [...junk, ...one])).toEqual({ x: 100, y: 100, width: 640, height: 480 })
  })

  it('hands the saved numbers back when there is no display at all', () => {
    expect(clampBoardBounds({ x: 12, y: 34, width: 700, height: 500 }, [])).toEqual({ x: 12, y: 34, width: 700, height: 500 })
    expect(clampBoardBounds({ width: 700, height: 500 }, [])).toEqual({ x: 0, y: 0, width: 700, height: 500 })
    expect(clampBoardBounds({ x: 12, y: 34, width: 5, height: 5 }, junk())).toEqual({ x: 12, y: 34, width: BOARD_MIN_WIDTH, height: BOARD_MIN_HEIGHT })
    function junk(): Area[] {
      return [{ x: 0, y: 0, width: 0, height: 0 }]
    }
  })
})

describe('boardWindowOptions', () => {
  const areas: Area[] = [{ x: 0, y: 0, width: 1920, height: 1040 }]
  const settings: BoardSettings = { x: 100, y: 100, width: 700, height: 500, alwaysOnTop: true, opacity: 0.6 }

  it('is a normal, sandboxed, isolated window with the brain window\'s preload and no partition', () => {
    const o = boardWindowOptions(settings, 'win32', areas, PRELOAD)
    expect(o).toMatchObject({
      x: 100,
      y: 100,
      width: 700,
      height: 500,
      minWidth: BOARD_MIN_WIDTH,
      minHeight: BOARD_MIN_HEIGHT,
      title: BOARD_TITLE,
      show: false,
      alwaysOnTop: true,
      opacity: 0.6,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    // Exactly these web preferences: no partition (the default session, whose network block and permission refusals apply), nothing loosened.
    expect(Object.keys(o.webPreferences ?? {}).sort()).toEqual(['contextIsolation', 'nodeIntegration', 'preload', 'sandbox'])
    // A normal frame: nothing that would make it frameless, transparent, modal or a child.
    for (const k of ['frame', 'transparent', 'parent', 'modal', 'titleBarStyle', 'fullscreen', 'kiosk', 'focusable', 'skipTaskbar']) expect(o, k).not.toHaveProperty(k)
  })

  it('dims the window only where the platform can', () => {
    expect(boardWindowOptions(settings, 'win32', areas, PRELOAD)).toHaveProperty('opacity', 0.6)
    expect(boardWindowOptions(settings, 'darwin', areas, PRELOAD)).toHaveProperty('opacity', 0.6)
    expect(boardWindowOptions(settings, 'linux', areas, PRELOAD)).not.toHaveProperty('opacity')
  })

  it('follows the settings for always on top, and places the window through the clamp', () => {
    expect(boardWindowOptions({ ...settings, alwaysOnTop: false }, 'win32', areas, PRELOAD)).toHaveProperty('alwaysOnTop', false)
    const off = boardWindowOptions({ ...settings, x: 9000, y: 9000 }, 'win32', areas, PRELOAD)
    expect(off).toMatchObject({ x: 610, y: 270, width: 700, height: 500 })
  })
})

describe('workAreasOf', () => {
  it('lists the primary display first, then the others, as plain copies of their work areas', () => {
    const a = display(2, -1920, 0, 1920, 1040)
    const b = display(1, 0, 0, 2560, 1400)
    const c = display(3, 2560, 0, 1280, 800)
    const areas = workAreasOf({ getAllDisplays: () => [a, b, c] as never, getPrimaryDisplay: () => b as never })
    expect(areas).toEqual([b.workArea, a.workArea, c.workArea])
    expect(areas[0]).not.toBe(b.workArea)
  })
})

describe('boardPageUrl and boardNavigationAllowed', () => {
  it('puts the board path in the query, however odd it is', () => {
    for (const p of ['Boards/Gate.md', 'Boards/a b & c=d #e?.md', 'Boards/日本語 🎨.md', 'D/Boards/100%.md', 'Boards/x"y\'z.md']) {
      const url = new URL(boardPageUrl(DEV, p))
      expect(url.origin).toBe(DEV)
      expect(url.pathname).toBe('/board.html')
      expect(url.searchParams.get('path'), p).toBe(p)
      expect(url.hash).toBe('')
    }
    expect(boardPageUrl(`${DEV}/`, 'a.md')).toBe(boardPageUrl(DEV, 'a.md'))
  })

  it('lets the window stay on its own page and nothing else: the dev server\'s origin, or the built file', () => {
    const dev = { devUrl: DEV, file: PAGE }
    expect(boardNavigationAllowed(`${DEV}/board.html?path=a.md`, dev)).toBe(true)
    expect(boardNavigationAllowed(`${DEV}/`, dev)).toBe(true)
    for (const url of ['http://localhost:5175/board.html', 'https://localhost:5174/board.html', 'http://evil.example/board.html', 'file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)', 'about:blank', 'blob:http://localhost:5174/1', 'not a url', '']) {
      expect(boardNavigationAllowed(url, dev), url).toBe(false)
    }
    const built = { devUrl: null, file: PAGE }
    const own = pathToFileURL(PAGE).href
    expect(boardNavigationAllowed(own, built)).toBe(true)
    expect(boardNavigationAllowed(`${own}?path=Boards%2FGate.md`, built)).toBe(true)
    expect(boardNavigationAllowed(`${own}#top`, built)).toBe(true)
    for (const url of [pathToFileURL(path.join(path.dirname(PAGE), 'index.html')).href, pathToFileURL('/etc/passwd').href, 'https://example.com/board.html', 'http://localhost:5174/board.html', 'data:text/html,hi', 'about:blank', 'not a url']) {
      expect(boardNavigationAllowed(url, built), url).toBe(false)
    }
    // A dev server address that is no address, or has no origin, never lets a page through by accident (opaque origins are all "null").
    expect(boardNavigationAllowed(own, { devUrl: 'not a url', file: PAGE })).toBe(false)
    expect(boardNavigationAllowed('data:text/html,hi', { devUrl: 'file:///x/', file: PAGE })).toBe(false)
    expect(boardNavigationAllowed(own, { devUrl: 'file:///x/', file: PAGE })).toBe(false)
  })
})

describe('what crosses IPC', () => {
  it('cleanBoardPath takes text ending in .md and nothing else', () => {
    expect(cleanBoardPath('Boards/Gate.md')).toBe('Boards/Gate.md')
    expect(cleanBoardPath('Boards/GATE.MD')).toBe('Boards/GATE.MD')
    for (const bad of [undefined, null, 7, {}, [], '', '   ', 'Boards/Gate.txt', 'Boards/Gate.png', 'Boards/Gate.md\0', 'x'.repeat(5000) + '.md', 'Boards/Gate.md ']) {
      expect(() => cleanBoardPath(bad), String(bad).slice(0, 30)).toThrow()
    }
    expect(() => cleanBoardPath('a'.repeat(4093) + '.md')).not.toThrow()
    expect(() => cleanBoardPath('a'.repeat(4094) + '.md')).toThrow()
  })

  it('cleanConfigure keeps the well-typed fields, clamps opacity and drops it where windows cannot be dimmed', () => {
    expect(cleanConfigure({ alwaysOnTop: false, opacity: 0.5 }, 'win32')).toEqual({ alwaysOnTop: false, opacity: 0.5 })
    expect(cleanConfigure({ opacity: 0.05 }, 'darwin')).toEqual({ opacity: 0.2 })
    expect(cleanConfigure({ opacity: 9 }, 'win32')).toEqual({ opacity: 1 })
    expect(cleanConfigure({ alwaysOnTop: true, opacity: 0.5 }, 'linux')).toEqual({ alwaysOnTop: true })
    expect(cleanConfigure({ alwaysOnTop: 'yes', opacity: '0.5', extra: 1 }, 'win32')).toEqual({})
    for (const raw of [undefined, null, 'x', 5, [], [true]]) expect(cleanConfigure(raw, 'win32')).toEqual({})
    expect(cleanConfigure({ opacity: Number.NaN }, 'win32')).toEqual({})
  })
})

/* ------------------------------------------------------------------ */
/* The picture ledger                                                 */
/* ------------------------------------------------------------------ */

describe('PictureLedger', () => {
  const ch = (kind: VaultChangeDto['kind'], p: string, extra: Partial<VaultChangeDto> = {}): VaultChangeDto => ({ kind, path: p, ...extra })

  it('lists the last scan\'s pictures as they are, and only pictures', () => {
    const ledger = new PictureLedger()
    const out = ledger.list([{ path: 'a.png' }, { path: 'Art/b.JPG' }, { path: 'notes.md' }, { path: 'clip.mp4' }, { path: 'c.txt' }])
    expect(out).toEqual([{ path: 'a.png' }, { path: 'Art/b.JPG' }])
  })

  it('adds a picture that came since the scan, with its numbers', () => {
    const ledger = new PictureLedger()
    ledger.apply([ch('add', 'Boards/Gate/new.png', { mtime: 5, size: 99 })])
    expect(ledger.list([{ path: 'a.png' }])).toEqual([{ path: 'a.png' }, { path: 'Boards/Gate/new.png', mtime: 5, size: 99 }])
    ledger.add('Boards/Gate/made.png', { mtime: 7, size: 12 })
    ledger.add('Boards/Gate/bare.png')
    expect(ledger.list([]).map((a) => a.path)).toEqual(['Boards/Gate/new.png', 'Boards/Gate/made.png', 'Boards/Gate/bare.png'])
  })

  it('takes out a picture that was removed, and puts back one that came again', () => {
    const ledger = new PictureLedger()
    const scan = [{ path: 'a.png' }, { path: 'b.png' }]
    ledger.apply([ch('unlink', 'a.png')])
    expect(ledger.list(scan)).toEqual([{ path: 'b.png' }])
    ledger.apply([ch('add', 'a.png', { mtime: 9 })])
    expect(ledger.list(scan)).toEqual([{ path: 'a.png', mtime: 9 }, { path: 'b.png' }])
    // A removal of a picture the scan never had leaves nothing behind.
    ledger.apply([ch('add', 'x.png'), ch('unlink', 'x.png')])
    expect(ledger.list(scan).map((a) => a.path)).toEqual(['a.png', 'b.png'])
  })

  it('shows a changed picture as last reported', () => {
    const ledger = new PictureLedger()
    ledger.apply([ch('change', 'a.png', { mtime: 3, size: 30 })])
    expect(ledger.list([{ path: 'a.png' }, { path: 'b.png' }])).toEqual([{ path: 'a.png', mtime: 3, size: 30 }, { path: 'b.png' }])
  })

  it('ignores notes, videos, folders and files that are not pictures', () => {
    const ledger = new PictureLedger()
    ledger.apply([ch('add', 'n.md', { content: 'x' }), ch('add', 'v.mp4'), ch('addDir', 'Art'), ch('unlinkDir', 'Old'), ch('add', 'z.zip'), ch('unlink', 'q.md'), ch('add', 'Art.png/x.txt')])
    expect(ledger.list([])).toEqual([])
    // A folder named like a picture is still a folder.
    ledger.apply([ch('addDir', 'Art/folder.png')])
    expect(ledger.list([])).toEqual([])
  })

  it('takes videos and 3D models too when asked to (what the AI link lists), and still never notes or folders', () => {
    const ledger = new PictureLedger(isAssetName)
    expect(ledger.list([{ path: 'a.png' }, { path: 'clip.mp4' }, { path: 'robot.glb' }, { path: 'n.md' }, { path: 'c.txt' }])).toEqual([{ path: 'a.png' }, { path: 'clip.mp4' }, { path: 'robot.glb' }])
    ledger.apply([ch('add', 'new.MOV', { mtime: 2 }), ch('add', 'Refs/new.glb', { size: 9 }), ch('unlink', 'clip.mp4'), ch('add', 'n.md', { content: 'x' }), ch('addDir', 'Art/folder.glb')])
    expect(ledger.list([{ path: 'a.png' }, { path: 'clip.mp4' }])).toEqual([{ path: 'a.png' }, { path: 'new.MOV', mtime: 2 }, { path: 'Refs/new.glb', size: 9 }])
  })

  it('forgets everything when a scan finishes (the new list has it all)', () => {
    const ledger = new PictureLedger()
    ledger.apply([ch('add', 'new.png'), ch('unlink', 'old.png')])
    ledger.clear()
    expect(ledger.list([{ path: 'old.png' }])).toEqual([{ path: 'old.png' }])
    expect(ledger.overflowed).toBe(false)
  })

  it('is bounded: past its cap it keeps what it has, says the list is partial, and still updates what it knows', () => {
    const ledger = new PictureLedger()
    for (let i = 0; i < LEDGER_MAX; i++) ledger.add(`p/${i}.png`)
    expect(ledger.overflowed).toBe(false)
    ledger.add('one-too-many.png')
    expect(ledger.overflowed).toBe(true)
    expect(ledger.list([]).some((a) => a.path === 'one-too-many.png')).toBe(false)
    expect(ledger.list([])).toHaveLength(LEDGER_MAX)
    // A picture it already holds can still change or go.
    ledger.apply([ch('unlink', 'p/0.png'), ch('change', 'p/1.png', { mtime: 4 })])
    const kept = ledger.list([])
    expect(kept).toHaveLength(LEDGER_MAX - 1)
    expect(kept.find((a) => a.path === 'p/1.png')).toEqual({ path: 'p/1.png', mtime: 4 })
    ledger.clear()
    expect(ledger.overflowed).toBe(false)
  })

  it('does not change the lists it is given', () => {
    const ledger = new PictureLedger()
    const scan = [{ path: 'a.png' }]
    const changes = [ch('add', 'b.png', { mtime: 1 })]
    const before = JSON.stringify({ scan, changes })
    ledger.apply(changes)
    ledger.list(scan)
    expect(JSON.stringify({ scan, changes })).toBe(before)
  })
})

describe('pictureChanges', () => {
  it('keeps picture additions, changes and removals without note text', () => {
    const out = pictureChanges([
      { kind: 'add', path: 'n.md', content: 'secret' },
      { kind: 'add', path: 'a.png', mtime: 1, size: 2 },
      { kind: 'change', path: 'b.jpg', mtime: 3 },
      { kind: 'unlink', path: 'c.webp' },
      { kind: 'addDir', path: 'Art' },
      { kind: 'unlinkDir', path: 'Old.png' },
      { kind: 'add', path: 'v.mp4', size: 9 },
      { kind: 'add', path: 'd.png', content: 'smuggled' },
    ])
    expect(out).toEqual([
      { kind: 'add', path: 'a.png', mtime: 1, size: 2 },
      { kind: 'change', path: 'b.jpg', mtime: 3 },
      { kind: 'unlink', path: 'c.webp' },
      { kind: 'add', path: 'd.png' },
    ])
    expect(JSON.stringify(out)).not.toMatch(/secret|smuggled/)
  })
})

/* ------------------------------------------------------------------ */
/* The window                                                         */
/* ------------------------------------------------------------------ */

describe('BoardWindowHost: opening', () => {
  it('opens ONE window on the board, with the brain window\'s security and the settings\' place, and shows it when it is ready', async () => {
    const t = setup({ settings: { x: 200, y: 150, width: 700, height: 500, alwaysOnTop: true, opacity: 0.8 } })
    const status = await t.host.open(BOARD)
    expect(FakeWindow.made).toHaveLength(1)
    expect(status).toEqual({ open: true, path: BOARD, alwaysOnTop: true, opacity: 0.8, supportsOpacity: true })
    expect(t.win.options).toMatchObject({
      x: 200,
      y: 150,
      width: 700,
      height: 500,
      alwaysOnTop: true,
      opacity: 0.8,
      title: BOARD_TITLE,
      show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    expect(t.win.options['webPreferences']).not.toHaveProperty('partition')
    // Hidden until the page is ready, then shown once.
    expect(t.win.visible).toBe(false)
    t.win.emit('ready-to-show')
    expect(t.win.visible).toBe(true)
  })

  it('shows a window whose page never says it is ready after 1.2 s anyway, and only once it is not shown yet', async () => {
    const t = setup()
    await t.host.open(BOARD)
    expect(t.win.visible).toBe(false)
    await vi.advanceTimersByTimeAsync(BOARD_REVEAL_MS - 1)
    expect(t.win.visible).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(t.win.visible).toBe(true)
    // A closed window's timer is gone: nothing touches the destroyed window.
    const u = setup()
    await u.host.open(BOARD)
    const w = u.win
    w.close()
    const show = vi.spyOn(w, 'show')
    await vi.advanceTimersByTimeAsync(BOARD_REVEAL_MS * 2)
    expect(show).not.toHaveBeenCalled()
  })

  it('loads the page from the dev server in development, from the built file with the path in the query when packaged', async () => {
    const dev = setup({ devUrl: DEV })
    await dev.host.open('Boards/a b#c.md')
    expect(dev.win.loaded).toEqual([{ url: boardPageUrl(DEV, 'Boards/a b#c.md') }])
    expect(new URL(dev.win.loaded[0]!.url!).searchParams.get('path')).toBe('Boards/a b#c.md')
    const built = setup()
    await built.host.open(BOARD)
    expect(built.win.loaded).toEqual([{ file: PAGE, query: { path: BOARD } }])
  })

  it('opens a second request for the same board in the same window: focused, restored, not reloaded', async () => {
    const t = setup()
    await t.host.open(BOARD)
    t.win.minimized = true
    const again = await t.host.open(BOARD)
    expect(FakeWindow.made).toHaveLength(1)
    expect(t.win.loaded).toHaveLength(1)
    expect(t.win.minimized).toBe(false)
    expect(t.win.visible).toBe(true)
    expect(t.win.focused).toBe(1)
    expect(again.path).toBe(BOARD)
    // Nothing was handed back: the board is still out.
    expect(t.brain!.webContents.on_(IPC.boardClosed)).toEqual([])
  })

  it('moves the window to another board: the old one goes back to the brain window first, the page loads the new one', async () => {
    const t = setup()
    await t.host.open(BOARD)
    const status = await t.host.open(OTHER)
    expect(FakeWindow.made).toHaveLength(1)
    expect(t.win.loaded).toEqual([{ file: PAGE, query: { path: BOARD } }, { file: PAGE, query: { path: OTHER } }])
    expect(t.brain!.webContents.on_(IPC.boardClosed)).toEqual([BOARD])
    expect(status.path).toBe(OTHER)
    expect(t.host.status().path).toBe(OTHER)
    // The closing word comes before the new state, so the docked view has its board back before the window says it shows another.
    const order = t.brain!.webContents.sent.map(([c, p]) => (c === IPC.boardState ? `state:${(p as { path: string }).path}` : `${c}:${p}`))
    expect(order.indexOf(`${IPC.boardClosed}:${BOARD}`)).toBeLessThan(order.lastIndexOf(`state:${OTHER}`))
  })

  it('serialises opens: two at once make one window and end on the second board', async () => {
    const t = setup()
    const [a, b] = await Promise.all([t.host.open(BOARD), t.host.open(OTHER)])
    expect(FakeWindow.made).toHaveLength(1)
    expect(a.path === BOARD || a.path === OTHER).toBe(true)
    expect(b.path).toBe(OTHER)
    expect(t.host.status().path).toBe(OTHER)
    expect(t.win.loaded.map((l) => l.query?.['path'])).toEqual([BOARD, OTHER])
  })

  it('refuses what is not a board path before any window is made', async () => {
    const t = setup()
    for (const bad of [undefined, null, 5, '', 'Boards/Gate.png', 'x'.repeat(5000) + '.md']) await expect(t.host.open(bad)).rejects.toThrow()
    expect(FakeWindow.made).toHaveLength(0)
    expect(t.host.status().open).toBe(false)
  })

  it('ends a window whose page cannot load and says so; the brain window hears the board is not out', async () => {
    const t = setup()
    vi.spyOn(FakeWindow.prototype, 'loadFile').mockRejectedValueOnce(Object.assign(new Error('ERR_FILE_NOT_FOUND (-6) loading board.html'), { code: 'ERR_FILE_NOT_FOUND' }))
    await expect(t.host.open(BOARD)).rejects.toThrow(/Could not open the board window: ERR_FILE_NOT_FOUND/)
    expect(t.win.gone).toBe(true)
    expect(t.host.status()).toMatchObject({ open: false, path: null })
    expect(t.brain!.webContents.on_(IPC.boardClosed)).toEqual([BOARD])
    // The next open starts clean with a new window.
    await expect(t.host.open(BOARD)).resolves.toMatchObject({ open: true, path: BOARD })
    expect(FakeWindow.made).toHaveLength(2)
  })

  it('does not call a load that was replaced or aborted a failure', async () => {
    const t = setup()
    vi.spyOn(FakeWindow.prototype, 'loadFile').mockRejectedValueOnce(Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED' }))
    await expect(t.host.open(BOARD)).resolves.toMatchObject({ open: true, path: BOARD })
    expect(t.win.gone).toBe(false)
  })

  it('reports whether it is open and what it shows, per platform', async () => {
    const win = setup({ platform: 'win32', settings: { opacity: 0.5, alwaysOnTop: false } })
    expect(win.host.status()).toEqual({ open: false, path: null, alwaysOnTop: false, opacity: 0.5, supportsOpacity: true })
    const linux = setup({ platform: 'linux', settings: { opacity: 0.5 } })
    // Where windows cannot be dimmed the saved dimming does not show.
    expect(linux.host.status()).toEqual({ open: false, path: null, alwaysOnTop: true, opacity: 1, supportsOpacity: false })
    await linux.host.open(BOARD)
    expect(linux.host.status()).toMatchObject({ open: true, path: BOARD, opacity: 1, supportsOpacity: false })
    expect(linux.win.options).not.toHaveProperty('opacity')
  })

  it('sends board:state to both windows when it opens', async () => {
    const t = setup()
    await t.host.open(BOARD)
    const state = { open: true, path: BOARD, alwaysOnTop: true, opacity: 1, supportsOpacity: true }
    expect(t.brain!.webContents.on_(IPC.boardState).at(-1)).toEqual(state)
    expect(t.win.webContents.on_(IPC.boardState).at(-1)).toEqual(state)
  })
})

describe('BoardWindowHost: configure', () => {
  it('turns always on top off and on, on the open window, at the floating level when on', async () => {
    const t = setup()
    await t.host.open(BOARD)
    expect(t.host.configure({ alwaysOnTop: false })).toMatchObject({ alwaysOnTop: false })
    expect(t.host.configure({ alwaysOnTop: true })).toMatchObject({ alwaysOnTop: true })
    expect(t.win.onTop).toEqual([[false, undefined], [true, 'floating']])
  })

  it('dims the window, clamped to 0.2 to 1, where the platform can (Windows, macOS)', async () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const t = setup({ platform })
      await t.host.open(BOARD)
      expect(t.host.configure({ opacity: 0.5 })).toMatchObject({ opacity: 0.5, supportsOpacity: true })
      expect(t.host.configure({ opacity: 0.01 }).opacity).toBe(0.2)
      expect(t.host.configure({ opacity: -4 }).opacity).toBe(0.2)
      expect(t.host.configure({ opacity: 12 }).opacity).toBe(1)
      expect(t.host.configure({ opacity: 0.3333 }).opacity).toBe(0.33)
      expect(t.win.opacities, platform).toEqual([0.5, 0.2, 0.2, 1, 0.33])
    }
  })

  it('does not touch the window\'s opacity where the platform cannot dim it, and says so', async () => {
    const t = setup({ platform: 'linux' })
    await t.host.open(BOARD)
    const status = t.host.configure({ opacity: 0.5, alwaysOnTop: false })
    expect(status).toMatchObject({ supportsOpacity: false, opacity: 1, alwaysOnTop: false })
    expect(t.win.opacities).toEqual([])
    expect(t.win.onTop).toEqual([[false, undefined]])
    // And it does not remember it for later: no phantom dimming on a disk shared with another machine.
    await vi.advanceTimersByTimeAsync(BOARD_SAVE_MS + 1)
    expect(t.saved.at(-1)).toMatchObject({ opacity: 1, alwaysOnTop: false })
  })

  it('ignores what is not a setting: no call on the window, no broadcast, no save', async () => {
    const t = setup()
    await t.host.open(BOARD)
    const sentBefore = t.brain!.webContents.sent.length
    for (const junk of [undefined, null, 'on top', 3, [], {}, { alwaysOnTop: 'yes' }, { opacity: '0.5' }, { opacity: Number.NaN }, { other: true }]) {
      expect(t.host.configure(junk), JSON.stringify(junk)).toMatchObject({ open: true, alwaysOnTop: true, opacity: 1 })
    }
    expect(t.win.onTop).toEqual([])
    expect(t.win.opacities).toEqual([])
    expect(t.brain!.webContents.sent).toHaveLength(sentBefore)
    await vi.advanceTimersByTimeAsync(BOARD_SAVE_MS * 4)
    expect(t.saved).toEqual([])
  })

  it('does not announce a setting that did not change', async () => {
    const t = setup()
    await t.host.open(BOARD)
    const n = (): number => t.brain!.webContents.on_(IPC.boardState).length
    const before = n()
    t.host.configure({ alwaysOnTop: true, opacity: 1 })
    expect(n()).toBe(before)
    t.host.configure({ opacity: 0.5 })
    expect(n()).toBe(before + 1)
  })

  it('tells both windows when a setting changed, whichever sent it', async () => {
    const t = setup()
    await t.host.open(BOARD)
    t.host.configure({ opacity: 0.4 })
    const want = { open: true, path: BOARD, alwaysOnTop: true, opacity: 0.4, supportsOpacity: true }
    expect(t.brain!.webContents.on_(IPC.boardState).at(-1)).toEqual(want)
    expect(t.win.webContents.on_(IPC.boardState).at(-1)).toEqual(want)
  })

  it('remembers a setting made while the window is closed, applies it to the next window, and saves it', async () => {
    const t = setup()
    t.host.configure({ alwaysOnTop: false, opacity: 0.6 })
    expect(FakeWindow.made).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(BOARD_SAVE_MS + 1)
    expect(t.saved).toHaveLength(1)
    expect(t.saved[0]).toMatchObject({ alwaysOnTop: false, opacity: 0.6 })
    await t.host.open(BOARD)
    expect(t.win.options).toMatchObject({ alwaysOnTop: false, opacity: 0.6 })
  })
})

describe('BoardWindowHost: remembering the place', () => {
  it('saves the position and size 500 ms after the last move or resize, once for a drag', async () => {
    const t = setup()
    await t.host.open(BOARD)
    for (let i = 0; i < 20; i++) {
      t.win.bounds = { x: 100 + i * 10, y: 80, width: 800, height: 600 }
      t.win.emit('move')
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(t.saved).toEqual([])
    await vi.advanceTimersByTimeAsync(BOARD_SAVE_MS)
    expect(t.saved).toHaveLength(1)
    expect(t.saved[0]).toMatchObject({ x: 290, y: 80, width: 800, height: 600 })
    t.win.bounds = { x: 290, y: 80, width: 900, height: 700 }
    t.win.emit('resize')
    await vi.advanceTimersByTimeAsync(BOARD_SAVE_MS + 1)
    expect(t.saved).toHaveLength(2)
    expect(t.saved[1]).toMatchObject({ x: 290, y: 80, width: 900, height: 700 })
  })

  it('writes nothing for a move that ends where the saved place already is', async () => {
    const t = setup({ settings: { x: 100, y: 80, width: 800, height: 600 } })
    await t.host.open(BOARD)
    t.win.emit('move')
    await vi.advanceTimersByTimeAsync(BOARD_SAVE_MS + 1)
    expect(t.saved).toEqual([])
  })

  it('saves the normal bounds when the window closes, at once, so a quick close loses nothing', async () => {
    const t = setup()
    await t.host.open(BOARD)
    t.win.bounds = { x: 5, y: 6, width: 777, height: 555 }
    t.win.emit('move')
    t.win.close()
    expect(t.saved).toEqual([expect.objectContaining({ x: 5, y: 6, width: 777, height: 555 })])
    // The pending debounce was cancelled by the save: no second write.
    await vi.advanceTimersByTimeAsync(BOARD_SAVE_MS * 3)
    expect(t.saved).toHaveLength(1)
  })

  it('flush() saves a window that is still open (the app is quitting), and does nothing when nothing changed', async () => {
    const t = setup()
    await t.host.open(BOARD)
    t.win.bounds = { x: 1, y: 2, width: 700, height: 500 }
    t.host.flush()
    expect(t.saved).toEqual([expect.objectContaining({ x: 1, y: 2, width: 700, height: 500 })])
    t.host.flush()
    expect(t.saved).toHaveLength(1)
    // With no window: only a setting that changed.
    const closed = setup()
    closed.host.flush()
    expect(closed.saved).toEqual([])
    closed.host.configure({ alwaysOnTop: false })
    closed.host.flush()
    expect(closed.saved).toHaveLength(1)
  })

  it('keeps what it saves sane: a window dragged to absurd places is saved as settings that load', async () => {
    const t = setup()
    await t.host.open(BOARD)
    t.win.bounds = { x: 9_999_999, y: -9_999_999, width: 3, height: 1e9 }
    t.win.emit('move')
    await vi.advanceTimersByTimeAsync(BOARD_SAVE_MS + 1)
    expect(t.saved).toHaveLength(1)
    expect(boardSettings(t.saved[0])).toEqual(t.saved[0])
    expect(t.saved[0]!).toMatchObject({ width: BOARD_MIN_WIDTH, height: 16_384 })
    expect(t.saved[0]!.x).toBeUndefined()
  })

  it('survives a save that throws or rejects', async () => {
    for (const save of [(): never => { throw new Error('disk gone') }, () => Promise.reject(new Error('disk gone'))]) {
      const t = setup({ save })
      await t.host.open(BOARD)
      t.win.bounds = { x: 5, y: 5, width: 700, height: 500 }
      t.win.emit('move')
      await vi.advanceTimersByTimeAsync(BOARD_SAVE_MS + 1)
      expect(t.host.status().open).toBe(true)
      t.win.close()
      await vi.advanceTimersByTimeAsync(10)
    }
  })

  it('restores the saved place on the display it was on, and clamps one that is off screen, tiny or huge', async () => {
    const two = [display(1, 0, 0, 1920, 1040), display(2, -1280, -100, 1280, 984)]
    const cases: [object, object][] = [
      [{ x: -1000, y: 20, width: 700, height: 500 }, { x: -1000, y: 20, width: 700, height: 500 }],
      [{ x: 5000, y: 5000, width: 700, height: 500 }, { x: 610, y: 270, width: 700, height: 500 }],
      [{ x: 10, y: 10, width: 1, height: 1 }, { x: 10, y: 10, width: BOARD_MIN_WIDTH, height: BOARD_MIN_HEIGHT }],
      [{ x: 0, y: 0, width: 1e9, height: 1e9 }, { x: 0, y: 0, width: 1920, height: 1040 }],
      [{ x: -3, y: -3, width: 700, height: 500 }, { x: 0, y: 0, width: 700, height: 500 }],
      [{}, { x: 640, y: 280, width: BOARD_DEFAULT_WIDTH, height: BOARD_DEFAULT_HEIGHT }],
      ['garbage', { x: 640, y: 280, width: BOARD_DEFAULT_WIDTH, height: BOARD_DEFAULT_HEIGHT }],
    ]
    for (const [settings, want] of cases) {
      const t = setup({ settings, displays: two })
      await t.host.open(BOARD)
      expect(t.win.options, JSON.stringify(settings)).toMatchObject(want)
    }
  })

  it('opens at the saved numbers when the system lists no display', async () => {
    // No display to name (a session with no monitor), and a display with nothing in its work area: either way the numbers stay as saved.
    for (const displays of [[], [display(1, 0, 0, 0, 0)]]) {
      const t = setup({ settings: { x: 40, y: 50, width: 700, height: 500 }, displays })
      await t.host.open(BOARD)
      expect(t.win.options, JSON.stringify(displays)).toMatchObject({ x: 40, y: 50, width: 700, height: 500 })
    }
  })
})

describe('BoardWindowHost: closing', () => {
  it('closing the brain window closes the board window, once, and the app can quit (no window is left)', async () => {
    const t = setup()
    await t.host.open(BOARD)
    expect(t.win.gone).toBe(false)
    t.brain!.close()
    expect(t.win.gone).toBe(true)
    expect(t.win.closeCalls).toBe(1)
    expect(t.host.status().open).toBe(false)
    // The brain window is gone: nothing is sent to it, nothing throws.
    expect(t.brain!.webContents.on_(IPC.boardClosed)).toEqual([])
  })

  it('hooks each brain window once, however often a board is opened', async () => {
    const t = setup()
    await t.host.open(BOARD)
    await t.host.open(OTHER)
    await t.host.open(BOARD)
    expect(t.brain!.listenerCount('closed')).toBe(1)
  })

  it('follows a new brain window (macOS: closed and opened again) and closes with that one too', async () => {
    const t = setup()
    await t.host.open(BOARD)
    t.brain!.close()
    const next = new FakeWindow()
    t.setBrain(next)
    await t.host.open(BOARD)
    expect(FakeWindow.made).toHaveLength(2)
    expect(next.listenerCount('closed')).toBe(1)
    next.close()
    expect(FakeWindow.made[1]!.gone).toBe(true)
  })

  it('tells the brain window with the board\'s path when the user closes the board window, and both are told it is closed', async () => {
    const t = setup()
    await t.host.open(BOARD)
    t.win.close()
    expect(t.brain!.webContents.on_(IPC.boardClosed)).toEqual([BOARD])
    expect(t.brain!.webContents.on_(IPC.boardState).at(-1)).toEqual({ open: false, path: null, alwaysOnTop: true, opacity: 1, supportsOpacity: true })
    expect(t.host.status()).toMatchObject({ open: false, path: null })
  })

  it('close() closes the window; with no window it does nothing', async () => {
    const t = setup()
    t.host.close()
    await t.host.open(BOARD)
    t.host.close()
    expect(t.win.gone).toBe(true)
    expect(t.brain!.webContents.on_(IPC.boardClosed)).toEqual([BOARD])
    t.host.close()
    expect(t.brain!.webContents.on_(IPC.boardClosed)).toEqual([BOARD])
  })

  it('does not throw when the brain window is already gone, null, or cannot be sent to', async () => {
    const t = setup({ brain: null })
    await t.host.open(BOARD)
    t.win.close()
    const gone = setup()
    await gone.host.open(BOARD)
    gone.brain!.webContents.sendThrows = true
    expect(() => gone.win.close()).not.toThrow()
    const dead = setup()
    await dead.host.open(BOARD)
    dead.brain!.gone = true
    dead.brain!.webContents.destroyed = true
    expect(() => dead.host.configure({ alwaysOnTop: false })).not.toThrow()
    expect(() => dead.win.close()).not.toThrow()
  })

  it('is closed when the window is reopened after being closed: a fresh window, the state announced again', async () => {
    const t = setup()
    await t.host.open(BOARD)
    t.win.close()
    await t.host.open(OTHER)
    expect(FakeWindow.made).toHaveLength(2)
    expect(t.host.status()).toMatchObject({ open: true, path: OTHER })
    expect(t.brain!.webContents.on_(IPC.boardClosed)).toEqual([BOARD])
  })
})

describe('BoardWindowHost: guards on the page', () => {
  it('denies every window the page opens, and sends no address to the browser (the page has no links)', async () => {
    const t = setup()
    await t.host.open(BOARD)
    const open = t.win.webContents.openHandler!
    for (const url of ['https://example.com/x', 'http://example.com/y', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank', 'aether-vision://app/x', 'HTTPS://upper.example', 'ftp://x.example', '']) {
      expect(open({ url }), url).toEqual({ action: 'deny' })
    }
    expect(t.shell.openExternal).not.toHaveBeenCalled()
  })

  it('stops the window navigating away from its page (a picture dropped outside the board would otherwise open in it)', async () => {
    for (const devUrl of [null, DEV]) {
      const t = setup({ devUrl })
      await t.host.open(BOARD)
      const nav = (url: string): boolean => {
        const e = { url, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
        t.win.webContents.emit('will-navigate', e)
        return e.defaultPrevented
      }
      const own = devUrl ? `${DEV}/board.html?path=a.md` : `${pathToFileURL(PAGE).href}?path=a.md`
      expect(nav(own), `own page (${devUrl ?? 'built'})`).toBe(false)
      for (const url of ['file:///home/me/Pictures/dropped.png', 'https://example.com', 'http://localhost:5174/other-origin'.replace('5174', '9999'), 'data:text/html,hi', 'javascript:alert(1)', 'about:blank']) {
        expect(nav(url), `${url} (${devUrl ?? 'built'})`).toBe(true)
      }
    }
  })

  it('does not let a page that asks before unloading keep the window from closing', async () => {
    const t = setup()
    await t.host.open(BOARD)
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    t.win.webContents.emit('will-prevent-unload', e)
    expect(e.defaultPrevented).toBe(true)
  })
})

describe('BoardWindowHost: a page that died', () => {
  const gone = (t: ReturnType<typeof setup>, reason = 'crashed'): void => {
    t.win.webContents.emit('render-process-gone', {}, { reason, exitCode: 1 })
  }

  it('reloads the page and says why, the first two times in a minute', async () => {
    const t = setup()
    await t.host.open(BOARD)
    gone(t)
    expect(t.win.webContents.reloads).toBe(1)
    expect(t.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    const [parent, box] = t.dialog.showMessageBox.mock.calls[0] as unknown as [FakeWindow, { type: string; title: string; message: string; detail: string }]
    expect(parent).toBe(t.win)
    expect(box).toMatchObject({ type: 'error', title: BOARD_TITLE })
    expect(box.detail).toMatch(/opening again/)
    gone(t, 'oom')
    expect(t.win.webContents.reloads).toBe(2)
    expect(t.win.gone).toBe(false)
  })

  it('leaves the window shut after it died again right after opening, and closes it once the message is read', async () => {
    const t = setup()
    await t.host.open(BOARD)
    gone(t)
    gone(t)
    gone(t)
    expect(t.win.webContents.reloads).toBe(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(t.win.gone).toBe(true)
    expect(t.brain!.webContents.on_(IPC.boardClosed)).toEqual([BOARD])
  })

  it('forgets crashes after a minute, and ignores a clean exit', async () => {
    const t = setup()
    await t.host.open(BOARD)
    gone(t)
    gone(t)
    await vi.advanceTimersByTimeAsync(CRASH_WINDOW_MS + 1)
    gone(t)
    expect(t.win.webContents.reloads).toBe(3)
    expect(t.win.gone).toBe(false)
    const before = t.dialog.showMessageBox.mock.calls.length
    gone(t, 'clean-exit')
    expect(t.win.webContents.reloads).toBe(3)
    expect(t.dialog.showMessageBox).toHaveBeenCalledTimes(before)
  })

  it('does not hold the window open when the message box itself fails', async () => {
    const t = setup()
    t.dialog.showMessageBox.mockRejectedValue(new Error('no display'))
    await t.host.open(BOARD)
    gone(t)
    gone(t)
    gone(t)
    await vi.advanceTimersByTimeAsync(0)
    expect(t.win.gone).toBe(true)
  })
})

describe('BoardWindowHost: what it forwards of the vault\'s changes', () => {
  it('sends the window the pictures that came, went or changed (no note text) and the board it shows, content included', async () => {
    const t = setup({ platform: 'linux' })
    await t.host.open(BOARD)
    t.host.forward([
      { kind: 'add', path: 'Notes/secret.md', content: 'private' },
      { kind: 'add', path: 'Boards/Gate/new.png', mtime: 1, size: 2 },
      { kind: 'change', path: BOARD, content: 'the board text' },
      { kind: 'change', path: OTHER, content: 'another board' },
      { kind: 'addDir', path: 'Boards/Gate' },
      { kind: 'unlink', path: 'Boards/Gate/old.png' },
    ])
    expect(t.win.webContents.on_(IPC.changes)).toEqual([
      [
        { kind: 'add', path: 'Boards/Gate/new.png', mtime: 1, size: 2 },
        { kind: 'unlink', path: 'Boards/Gate/old.png' },
        { kind: 'change', path: BOARD, content: 'the board text' },
      ],
    ])
    expect(JSON.stringify(t.win.webContents.sent)).not.toMatch(/private|another board/)
  })

  it('sends a batch with nothing in it for the window not at all, and nothing at all with no window', async () => {
    const t = setup()
    t.host.forward([{ kind: 'add', path: 'new.png' }])
    await t.host.open(BOARD)
    t.host.forward([{ kind: 'add', path: 'n.md', content: 'x' }, { kind: 'addDir', path: 'D' }])
    expect(t.win.webContents.on_(IPC.changes)).toEqual([])
    const w = t.win
    w.close()
    t.host.forward([{ kind: 'add', path: 'new.png' }])
    expect(w.webContents.on_(IPC.changes)).toEqual([])
  })

  it('compares the board\'s path the way the OS does: case-blind on Windows and macOS, exact on Linux', async () => {
    for (const [platform, hears] of [['win32', true], ['darwin', true], ['linux', false]] as const) {
      const t = setup({ platform })
      await t.host.open('Boards/Gate.md')
      t.host.forward([{ kind: 'change', path: 'boards/GATE.md', content: 'x' }])
      expect(t.win.webContents.on_(IPC.changes).length > 0, platform).toBe(hears)
    }
  })

  it('does not throw when the window went away mid-send', async () => {
    const t = setup()
    await t.host.open(BOARD)
    t.win.webContents.sendThrows = true
    expect(() => t.host.forward([{ kind: 'add', path: 'a.png' }])).not.toThrow()
    expect(() => t.host.configure({ alwaysOnTop: false })).not.toThrow()
  })
})

/* ------------------------------------------------------------------ */
/* The IPC handlers, against a temp vault                             */
/* ------------------------------------------------------------------ */

describe('boardHandlers', () => {
  let tmp: string
  let root: string
  const board = (title = 'Gate'): string => newBoardNote(title, NOW)
  const at = (rel: string): string => path.join(root, ...rel.split('/'))

  beforeEach(async () => {
    // Real timers for the disk, fake ones for the windows: the temp vault is made with the clock running.
    vi.useRealTimers()
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-board-ipc-'))
    root = path.join(tmp, 'vault')
    await fs.mkdir(path.join(root, 'Boards'), { recursive: true })
    await fs.mkdir(path.join(root, 'Notes'), { recursive: true })
    await fs.writeFile(at('Boards/Gate.md'), board('Gate'))
    await fs.writeFile(at('Boards/Rust.md'), board('Rust'))
    await fs.writeFile(at('Notes/Plain.md'), '---\ntitle: Plain\n---\nJust a note.\n')
    vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  function wire(scan: { assets: { path: string }[]; assetsTruncated: boolean } | null = { assets: [], assetsTruncated: false }, vault: FsVault | null = new FsVault([root])) {
    const t = setup()
    const ledger = new PictureLedger()
    let current = vault
    const handlers = boardHandlers({ host: t.host, vault: () => current, scan: () => scan, ledger })
    return { t, ledger, handlers, setVault: (v: FsVault | null) => void (current = v) }
  }

  it('opens the window only for a board note that is there, and says why otherwise', async () => {
    const { t, handlers } = wire()
    await expect(handlers.open('Notes/Plain.md')).rejects.toThrow(/not a board note/)
    await expect(handlers.open('Boards/Missing.md')).rejects.toThrow(/There is no note at/)
    await expect(handlers.open('../outside.md')).rejects.toThrow(/Not a path inside the vault/)
    await expect(handlers.open('Boards/Gate.txt')).rejects.toThrow(/markdown/)
    for (const bad of [undefined, null, 4, {}, '']) await expect(handlers.open(bad)).rejects.toThrow()
    expect(FakeWindow.made).toHaveLength(0)
    const status = await handlers.open('Boards/Gate.md')
    expect(status).toMatchObject({ open: true, path: 'Boards/Gate.md' })
    expect(FakeWindow.made).toHaveLength(1)
    expect(t.host.status().path).toBe('Boards/Gate.md')
    // Another board moves the window; a note that is no board leaves it where it was.
    await handlers.open('Boards/Rust.md')
    await expect(handlers.open('Notes/Plain.md')).rejects.toThrow()
    expect(t.host.status().path).toBe('Boards/Rust.md')
    expect(FakeWindow.made).toHaveLength(1)
  })

  it('opens nothing without a vault', async () => {
    const { handlers } = wire(null, null)
    await expect(handlers.open('Boards/Gate.md')).rejects.toThrow(/No vault is open/)
    expect(FakeWindow.made).toHaveLength(0)
    expect(await handlers.read('Boards/Gate.md')).toBeNull()
    expect(await handlers.save('Boards/Gate.md', board())).toEqual({ ok: false, reason: 'No vault is open' })
    // No finished scan: the list is not known, and says so (the window then draws no picture as missing).
    expect(handlers.assets()).toEqual({ assets: [], truncated: true })
  })

  it('closes, reports, and configures through the host, whatever it is sent', async () => {
    const { t, handlers } = wire()
    expect(handlers.status()).toMatchObject({ open: false })
    await handlers.open('Boards/Gate.md')
    expect(handlers.configure({ opacity: 0.3, alwaysOnTop: false })).toMatchObject({ opacity: 0.3, alwaysOnTop: false })
    expect(handlers.configure('garbage')).toMatchObject({ opacity: 0.3, alwaysOnTop: false })
    expect(handlers.configure({ opacity: '0.9' })).toMatchObject({ opacity: 0.3 })
    expect(t.win.opacities).toEqual([0.3])
    handlers.close()
    expect(handlers.status()).toMatchObject({ open: false, path: null })
    expect(t.win.gone).toBe(true)
  })

  it('reads a board note and no other file; saves over a board note and nothing else', async () => {
    const { handlers } = wire()
    expect(await handlers.read('Boards/Gate.md')).toBe(board('Gate'))
    for (const p of ['Notes/Plain.md', 'Boards/Missing.md', '../x.md', 7, null, undefined]) expect(await handlers.read(p), String(p)).toBeNull()
    const next = board('Gate').replace('Reference board.', 'Edited in the window.')
    expect(await handlers.save('Boards/Gate.md', next)).toEqual({ ok: true })
    expect(await fs.readFile(at('Boards/Gate.md'), 'utf8')).toBe(next)
    for (const [p, text] of [['Boards/New.md', board()], ['Notes/Plain.md', board()], ['Boards/Gate.md', 'no frontmatter'], ['Boards/Gate.md', 5], [{}, board()]] as const) {
      expect((await handlers.save(p, text)).ok, String(p)).toBe(false)
    }
    expect(await fs.readFile(at('Boards/Gate.md'), 'utf8')).toBe(next)
    await expect(fs.stat(at('Boards/New.md'))).rejects.toThrow()
    expect(await fs.readFile(at('Notes/Plain.md'), 'utf8')).toContain('Just a note.')
  })

  it('answers the picture list with the last scan\'s pictures plus what changed since, and says when the list is partial', () => {
    const { ledger, handlers } = wire({ assets: [{ path: 'a.png' }, { path: 'gone.png' }, { path: 'clip.mp4' }], assetsTruncated: false })
    expect(handlers.assets()).toEqual({ assets: [{ path: 'a.png' }, { path: 'gone.png' }], truncated: false })
    ledger.apply([{ kind: 'unlink', path: 'gone.png' }, { kind: 'add', path: 'Boards/Gate/new.png', mtime: 3, size: 9 }])
    ledger.add('Boards/Gate/made.png', { mtime: 4, size: 8 })
    expect(handlers.assets()).toEqual({
      assets: [{ path: 'a.png' }, { path: 'Boards/Gate/new.png', mtime: 3, size: 9 }, { path: 'Boards/Gate/made.png', mtime: 4, size: 8 }],
      truncated: false,
    })
    const capped = wire({ assets: [{ path: 'a.png' }], assetsTruncated: true })
    expect(capped.handlers.assets().truncated).toBe(true)
    // Before the first scan finishes (a vault just reopened rescans for minutes): what was reported since, and "partial".
    const nothing = wire(null)
    nothing.ledger.add('x.png')
    expect(nothing.handlers.assets()).toEqual({ assets: [{ path: 'x.png' }], truncated: true })
    const overflow = wire({ assets: [], assetsTruncated: false })
    for (let i = 0; i <= LEDGER_MAX; i++) overflow.ledger.add(`p/${i}.png`)
    expect(overflow.handlers.assets().truncated).toBe(true)
  })

  it('stats nothing when it lists pictures (names are all the board needs)', () => {
    const { handlers } = wire({ assets: Array.from({ length: 5 }, (_, i) => ({ path: `p/${i}.png` })), assetsTruncated: false })
    const spy = vi.spyOn(FsVault.prototype, 'statAssets')
    expect(handlers.assets().assets).toHaveLength(5)
    expect(spy).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ */
/* main.ts wires it, and only it                                      */
/* ------------------------------------------------------------------ */

describe('main.ts wiring', () => {
  let src: string
  beforeEach(async () => {
    src = lf(await fs.readFile(path.join(here, '..', 'src', 'main', 'main.ts'), 'utf8'))
  })

  it('registers each board channel once, to the handlers, and the picture read to the checked reader', () => {
    const wiring = /function registerBoardIpc[\s\S]*?\n}\n/.exec(src)?.[0] ?? ''
    for (const [channel, call] of [
      ['boardOpen', 'h.open(p)'],
      ['boardClose', 'h.close()'],
      ['boardStatus', 'h.status()'],
      ['boardConfigure', 'h.configure(patch)'],
      ['boardSave', 'h.save(p, text, base)'],
      ['boardRead', 'h.read(p)'],
      ['boardAssets', 'h.assets()'],
    ] as const) {
      const line = wiring.split('\n').find((l) => l.includes(`IPC.${channel},`)) ?? ''
      expect(line, channel).toContain(call)
      expect(src.split(`IPC.${channel},`).length - 1, channel).toBe(1)
    }
    // Every argument arrives as `unknown`, to be checked by the handler.
    expect(wiring).not.toMatch(/\bany\b/)
    expect(src).toMatch(/ipc\.handle\(IPC\.readAsset, \(_e, p: unknown\) => \(vault && typeof p === 'string' \? within\(readAssetBytes\(vault, p\)/)
  })

  it('never makes the board window the brain window, and gives it a preload of its own (the board\'s calls) and no session of its own', () => {
    // `win` is assigned in createWindow and cleared when it closes: nowhere else.
    expect(src.match(/^\s*win = .*$/gm)?.map((l) => l.trim())).toEqual(['win = new BrowserWindow({', 'win = null'])
    const make = /function createBoardWindow[\s\S]*?\n}\n/.exec(src)?.[0] ?? ''
    expect(make).toContain('brain: () => win')
    expect(make).toContain("preload: path.join(__dirname, '..', 'preload', 'board-preload.cjs')")
    expect(make).toContain("pageFile: path.join(__dirname, '..', 'renderer', 'board.html')")
    expect(make).toContain("devUrl: process.env['VITE_DEV_SERVER_URL'] ?? null")
    expect(make.replace(/\/\/.*$/gm, '')).not.toMatch(/partition|session/)
    // The brain window keeps the full preload, once; the board window's is another file.
    expect(src.match(/preload: path\.join\(__dirname, '\.\.', 'preload', 'preload\.cjs'\)/g)).toHaveLength(1)
    // The board window is made by the host, never by main.
    expect(src.match(/new BrowserWindow\(/g)).toHaveLength(1)
  })

  it('keeps the app able to quit and the settings saved: flushed before quitting, closed with a vault that moved', () => {
    expect(/app\.on\('before-quit'[\s\S]*?\n}\)/.exec(src)?.[0]).toContain('board?.flush()')
    expect(src).toContain('board?.close()')
    // The board window's changes and pictures follow the watcher and the picture creator.
    expect(src).toContain('board?.forward(changes)')
    expect(src).toContain('pictureLedger.apply(changes)')
    expect(src).toContain('pictureLedger.add(canonical')
    expect(src.match(/pictureLedger\.clear\(\)/g)?.length).toBeGreaterThanOrEqual(2)
    // Saved in settings.json under `board`, sanitised on the way in.
    expect(src).toContain('settings.board = s')
    expect(src).toContain('boardSettings(settings.board)')
  })

  it('never tells the watcher about a board save (main.ts hands the board handlers no watcher)', () => {
    const wiring = /function registerBoardIpc[\s\S]*?\n}\n/.exec(src)?.[0] ?? ''
    expect(wiring.replace(/\/\/.*$/gm, '')).not.toMatch(/watcher|noteSelfWrite/)
    expect((/function createBoardWindow[\s\S]*?\n}\n/.exec(src)?.[0] ?? '').replace(/\/\/.*$/gm, '')).not.toMatch(/watcher|noteSelfWrite/)
  })
})

/* ------------------------------------------------------------------ */
/* The floating page's host (renderer side, over a fake bridge)       */
/* ------------------------------------------------------------------ */

const STATUS: BoardStatusDto = { open: true, path: BOARD, alwaysOnTop: true, opacity: 1, supportsOpacity: true }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function fakeBridge(init: { note?: string | null; assets?: VaultAssetDto[]; truncated?: boolean; platform?: string } = {}) {
  const st = {
    note: init.note === undefined ? newBoardNote('Gate', NOW) : init.note,
    assets: init.assets ?? [],
    truncated: init.truncated ?? false,
    existing: new Set<string>(),
    excluded: new Set<string>(),
    saveFails: null as string | null,
    saves: [] as string[],
    created: [] as { path: string; size: number }[],
    status: { ...STATUS },
    /** Make boardAssets wait for this to resolve. */
    listGate: null as Promise<void> | null,
  }
  const changeSubs = new Set<(c: VaultChangeDto[]) => void>()
  const stateSubs = new Set<(s: BoardStatusDto) => void>()
  const reject = (msg: string): never => {
    throw new Error(`Error invoking remote method 'vault:createAsset': Error: ${msg}`)
  }
  const bridge = {
    platform: init.platform ?? 'linux',
    boardRead: vi.fn(async (_p: string) => st.note),
    /** Main's side of `board:save` in miniature: ONE call that compares the note with the text the save was made from, then writes. */
    boardSave: vi.fn(async (_p: string, text: string, expectedBase?: string) => {
      if (st.saveFails) return { ok: false as const, reason: st.saveFails }
      if (st.note === null) return { ok: false as const, reason: 'The board note is gone, or is no longer a board: nothing was saved' }
      if (expectedBase !== undefined && st.note !== text && st.note !== expectedBase) {
        return { ok: false as const, reason: 'The board was changed outside this window: it has been left as it is. Reload to see the change.', changed: true as const }
      }
      st.note = text
      st.saves.push(text)
      return { ok: true as const }
    }),
    boardAssets: vi.fn(async () => {
      await st.listGate
      return { assets: st.assets.map((a) => ({ ...a })), truncated: st.truncated }
    }),
    boardStatus: vi.fn(async () => st.status),
    boardConfigure: vi.fn(async (patch: Partial<BoardStatusDto>) => {
      st.status = { ...st.status, ...patch }
      return st.status
    }),
    boardClose: vi.fn(async () => undefined),
    onChanges: (cb: (c: VaultChangeDto[]) => void) => {
      changeSubs.add(cb)
      return () => void changeSubs.delete(cb)
    },
    onBoardState: (cb: (s: BoardStatusDto) => void) => {
      stateSubs.add(cb)
      return () => void stateSubs.delete(cb)
    },
    thumbnail: vi.fn(async (_p: string, _px: number): Promise<Uint8Array | null> => new Uint8Array([1, 2])),
    readAsset: vi.fn(async (_p: string): Promise<Uint8Array | null> => new Uint8Array([3, 4])),
    readAssetChecked: vi.fn(async (_p: string): Promise<ReadAssetResult> => ({ ok: true, bytes: new Uint8Array([3, 4]) })),
    onBoardFlush: vi.fn((_cb: (token: number) => void) => () => undefined),
    boardFlushed: vi.fn((_token: number) => undefined),
    onBoardGone: vi.fn((_cb: (why: string) => void) => () => undefined),
    createAsset: vi.fn(async (p: string, data: Uint8Array) => {
      const folder = p.slice(0, p.lastIndexOf('/'))
      if (st.excluded.has(folder)) reject(`Path is excluded from the vault: ${p}`)
      if (st.existing.has(p.toLowerCase())) reject(`EEXIST: file already exists, open '${p}'`)
      st.existing.add(p.toLowerCase())
      st.created.push({ path: p, size: data.length })
    }),
    openAsset: vi.fn(async (_p: string) => undefined),
    revealInFolder: vi.fn(async (_p: string) => undefined),
    copyText: vi.fn(async (_t: string) => undefined),
  }
  return {
    st,
    bridge: bridge as unknown as AetherBridge,
    calls: bridge,
    emit: (changes: VaultChangeDto[]) => {
      for (const cb of [...changeSubs]) cb(changes)
    },
    emitState: (s: BoardStatusDto) => {
      for (const cb of [...stateSubs]) cb(s)
    },
    subs: { changes: changeSubs, state: stateSubs },
  }
}

const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(0)

describe('floating host: small pure helpers', () => {
  it('keeps a board\'s pictures in a folder named like the note, next to it, cleaned for the vault', () => {
    expect(boardFolderOfPath('Boards/Gate.md')).toBe('Boards/Gate')
    expect(boardFolderOfPath('Gate.md')).toBe('Gate')
    expect(boardFolderOfPath('D/Boards/Gate ref.MD')).toBe('D/Boards/Gate ref')
    expect(boardFolderOfPath('Boards/a#b[c].md')).toBe('Boards/a-b-c-')
    // A name the vault ignores gets a suffix, so the pictures are not hidden from the brain.
    expect(boardFolderOfPath('Boards/Library.md')).toBe('Boards/Library pictures')
    expect(boardFolderOfPath('Boards/Temp.md')).toBe('Boards/Temp pictures')
  })

  it('names a taken picture `name 2`, `name 3` ... and sniffs the type from the first bytes', () => {
    expect(numberedName('rust.png', 1)).toBe('rust.png')
    expect(numberedName('rust.png', 2)).toBe('rust 2.png')
    expect(numberedName('a.b.jpg', 12)).toBe('a.b 12.jpg')
    expect(numberedName('noext', 3)).toBe('noext 3')
    expect(numberedName('.hidden', 2)).toBe('.hidden 2')
    expect(sniffMime(PNG)).toBe('image/png')
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]))).toBe('image/gif')
    expect(sniffMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
    expect(sniffMime(new Uint8Array([0x42, 0x4d, 0, 0]))).toBe('image/bmp')
    expect(sniffMime(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))).toBe('image/avif')
    for (const junk of [new Uint8Array(), new Uint8Array([1, 2, 3]), new TextEncoder().encode('<svg xmlns=')]) expect(sniffMime(junk)).toBe('')
  })
})

describe('floating host: the note', () => {
  it('reads the note through the bridge, takes the title from its frontmatter, and refuses a note main will not serve', async () => {
    const f = fakeBridge({ note: newBoardNote('Gate ref', NOW) })
    const host = createFloatingBoardHost(f.bridge, BOARD)
    expect(host.path).toBe(BOARD)
    expect(host.title).toBe('Gate')
    expect(await host.load()).toBe(newBoardNote('Gate ref', NOW))
    expect(host.title).toBe('Gate ref')
    expect(f.calls.boardRead).toHaveBeenCalledWith(BOARD)
    f.st.note = null
    await expect(host.load()).rejects.toThrow(/gone, or is no longer a board/)
    // A note too long for the window rejects with its own sentence, which is not "gone".
    f.calls.boardRead.mockRejectedValueOnce(new Error('Boards/Gate.md is 1,200,000 characters long; the board window opens notes of up to 1,000,000 characters'))
    await expect(host.load()).rejects.toThrow(/1,200,000 characters long/)
    host.dispose()
  })

  it('saves in ONE board:save call that carries the text the save was made from (main compares; nothing is read first)', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD)
    const read = await host.load()
    f.calls.boardRead.mockClear()
    const next = newBoardNote('Gate', NOW).replace('Reference board.', 'Edited.')
    await host.save(next)
    expect(f.calls.boardSave).toHaveBeenCalledWith(BOARD, next, read)
    expect(f.calls.boardRead).not.toHaveBeenCalled()
    expect(f.st.note).toBe(next)
    // The view's own base wins over what the host last read: a reload that landed in between must not make a stale text look fresh.
    f.st.note = 'what a reload read'
    await host.save(next + 'x', 'what a reload read')
    expect(f.calls.boardSave).toHaveBeenLastCalledWith(BOARD, next + 'x', 'what a reload read')
    // The next save starts from what this window wrote.
    await host.save(next + '\nmore\n')
    expect(f.st.saves).toHaveLength(3)
    host.dispose()
  })

  it('does not overwrite an edit made elsewhere: refuses (and says so to the view) until the note is read again', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD)
    const original = await host.load()
    const heard = vi.fn()
    host.onExternalChange!(heard)
    const theirs = original + '\nAn AI added this line.\n'
    f.st.note = theirs
    await expect(host.save(original + 'mine')).rejects.toThrow(/changed outside this window/)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(f.st.saves).toEqual([])
    // Still refused however often the view tries.
    await expect(host.save(original + 'mine again')).rejects.toThrow(/changed outside/)
    expect(f.st.saves).toEqual([])
    expect(f.st.note).toBe(theirs)
    // After the view reloads (load), the new text is the base.
    await host.load()
    await host.save(theirs + 'mine')
    expect(f.st.note).toBe(theirs + 'mine')
    host.dispose()
  })

  it('lets a save through when the note on disk already is the very text (a repeat), and when it was never read (a fresh window)', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD)
    await host.load()
    f.st.note = 'identical'
    await expect(host.save('identical')).resolves.toBeUndefined()
    const fresh = createFloatingBoardHost(fakeBridge().bridge, BOARD)
    await expect(fresh.save(newBoardNote('Gate', NOW))).resolves.toBeUndefined()
    // A fresh window sends no base at all: main overwrites, as board:save always did.
    expect(fresh.save).toBeDefined()
    host.dispose()
    fresh.dispose()
  })

  it('says what went wrong: the note is gone, main refused, the write failed', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD)
    await host.load()
    f.st.saveFails = 'The disk is full'
    await expect(host.save('x')).rejects.toThrow('The disk is full')
    f.st.saveFails = null
    f.st.note = null
    await expect(host.save('x')).rejects.toThrow(/gone, or is no longer a board/)
    host.dispose()
  })

  it('runs saves one after the other, each reading the note the one before wrote', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD)
    await host.load()
    const texts = ['one', 'two', 'three']
    await Promise.all(texts.map((t) => host.save(t)))
    expect(f.st.saves).toEqual(texts)
    // A failed save does not stop the ones after it.
    f.st.saveFails = 'nope'
    const failed = await host.save('four').catch((e: Error) => e.message)
    f.st.saveFails = null
    expect(failed).toBe('nope')
    await host.save('five')
    expect(f.st.saves.at(-1)).toBe('five')
    host.dispose()
  })

  it('knows its own saves when the watcher reports them, even late and out of order; hears edits made elsewhere, and a deleted note', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD)
    await host.load()
    const heard = vi.fn()
    host.onExternalChange!(heard)
    await host.save('A')
    await host.save('B')
    // The report of A reaches the window after B was saved: ours, not an edit.
    f.emit([{ kind: 'change', path: BOARD, content: 'A' }])
    f.emit([{ kind: 'change', path: BOARD, content: 'B' }])
    expect(heard).not.toHaveBeenCalled()
    // Somebody else's text, a report of another note, a picture, a folder: only the first is news.
    f.emit([{ kind: 'change', path: OTHER, content: 'elsewhere' }, { kind: 'add', path: 'x.png' }, { kind: 'addDir', path: 'Boards' }])
    expect(heard).not.toHaveBeenCalled()
    f.emit([{ kind: 'change', path: BOARD, content: 'an editor wrote this' }])
    expect(heard).toHaveBeenCalledTimes(1)
    f.emit([{ kind: 'unlink', path: BOARD }])
    expect(heard).toHaveBeenCalledTimes(2)
    // A change without content (it cannot be told from ours) is left to the next save's check.
    f.emit([{ kind: 'change', path: BOARD }])
    expect(heard).toHaveBeenCalledTimes(2)
    host.dispose()
  })

  it('remembers only the last few texts it wrote (a note can be 1,000,000 characters)', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD)
    await host.load()
    const heard = vi.fn()
    host.onExternalChange!(heard)
    for (let i = 0; i < ECHO_TEXTS + 2; i++) await host.save(`text ${i}`)
    f.emit([{ kind: 'change', path: BOARD, content: `text ${ECHO_TEXTS + 1}` }])
    f.emit([{ kind: 'change', path: BOARD, content: `text ${ECHO_TEXTS - 2}` }])
    expect(heard).not.toHaveBeenCalled()
    f.emit([{ kind: 'change', path: BOARD, content: 'text 0' }])
    expect(heard).toHaveBeenCalledTimes(1)
    host.dispose()
  })

  it('compares the board\'s path the way the OS does', async () => {
    for (const [platform, news] of [['win32', true], ['darwin', true], ['linux', false]] as const) {
      const f = fakeBridge({ platform })
      const host = createFloatingBoardHost(f.bridge, 'Boards/Gate.md')
      await host.load()
      const heard = vi.fn()
      host.onExternalChange!(heard)
      f.emit([{ kind: 'change', path: 'boards/GATE.md', content: 'edit' }])
      expect(heard.mock.calls.length > 0, platform).toBe(news)
      host.dispose()
    }
  })

  it('stops listening when disposed: no change reaches a view that is gone', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD)
    await host.load()
    const heard = vi.fn()
    const off = host.onExternalChange!(heard)
    off()
    f.emit([{ kind: 'unlink', path: BOARD }])
    expect(heard).not.toHaveBeenCalled()
    host.onExternalChange!(heard)
    host.dispose()
    expect(f.subs.changes.size).toBe(0)
    expect(f.subs.state.size).toBe(0)
    f.emit([{ kind: 'unlink', path: BOARD }])
    expect(heard).not.toHaveBeenCalled()
  })
})

describe('floating host: pictures', () => {
  it('lists the vault\'s pictures once the bridge has, drops videos and files that are not pictures', async () => {
    const f = fakeBridge({ assets: [{ path: 'a.png', mtime: 1, size: 2 }, { path: 'clip.mp4' }, { path: 'b.JPG' }, { path: 'x.txt' }] })
    const host = createFloatingBoardHost(f.bridge, BOARD)
    expect((await host.pictures.list()).map((a) => a.path)).toEqual(['a.png', 'b.JPG'])
    expect(f.calls.boardAssets).toHaveBeenCalledTimes(1)
    host.dispose()
  })

  it('does not call a picture missing before it has the list, nor when the list is partial; after, only what is not in it', async () => {
    const f = fakeBridge({ assets: [{ path: 'a.png' }] })
    const host = createFloatingBoardHost(f.bridge, BOARD)
    expect(host.pictures.exists('anything.png')).toBe(true)
    await host.pictures.list()
    expect(host.pictures.exists('a.png')).toBe(true)
    expect(host.pictures.exists('gone.png')).toBe(false)
    host.dispose()
    const capped = fakeBridge({ assets: [{ path: 'a.png' }], truncated: true })
    const partial = createFloatingBoardHost(capped.bridge, BOARD)
    await partial.pictures.list()
    expect(partial.pictures.exists('somewhere-beyond-the-cap.png')).toBe(true)
    partial.dispose()
  })

  it('matches picture paths case-blind on Windows and macOS, exactly on Linux', async () => {
    for (const [platform, found] of [['win32', true], ['darwin', true], ['linux', false]] as const) {
      const f = fakeBridge({ assets: [{ path: 'Art/Gate.PNG' }], platform })
      const host = createFloatingBoardHost(f.bridge, BOARD)
      await host.pictures.list()
      expect(host.pictures.exists('art/gate.png'), platform).toBe(found)
      host.dispose()
    }
  })

  it('applies picture changes from the watcher to the list and tells the view once for a burst', async () => {
    const f = fakeBridge({ assets: [{ path: 'a.png', mtime: 1 }] })
    const host = createFloatingBoardHost(f.bridge, BOARD)
    await host.pictures.list()
    // The first list counts as a change itself (what was thought missing may be there): let that one go by.
    await vi.advanceTimersByTimeAsync(PICTURE_CHANGE_MS + 1)
    const heard = vi.fn()
    host.pictures.onChange!(heard)
    f.emit([{ kind: 'add', path: 'new.png', mtime: 5, size: 9 }])
    f.emit([{ kind: 'add', path: 'new2.png', mtime: 5 }, { kind: 'unlink', path: 'a.png' }])
    expect(heard).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(PICTURE_CHANGE_MS + 1)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(host.pictures.exists('new.png')).toBe(true)
    expect(host.pictures.exists('new2.png')).toBe(true)
    expect(host.pictures.exists('a.png')).toBe(false)
    // A later burst is a later call.
    f.emit([{ kind: 'unlink', path: 'new.png' }])
    await vi.advanceTimersByTimeAsync(PICTURE_CHANGE_MS + 1)
    expect(heard).toHaveBeenCalledTimes(2)
    host.dispose()
  })

  it('says nothing about a change that changes nothing, a folder, a note or a video', async () => {
    const f = fakeBridge({ assets: [{ path: 'a.png', mtime: 1, size: 2 }] })
    const host = createFloatingBoardHost(f.bridge, BOARD)
    await host.pictures.list()
    await vi.advanceTimersByTimeAsync(PICTURE_CHANGE_MS + 1)
    const heard = vi.fn()
    host.pictures.onChange!(heard)
    f.emit([{ kind: 'change', path: 'a.png', mtime: 1, size: 2 }, { kind: 'addDir', path: 'Boards' }, { kind: 'add', path: 'n.md', content: 'x' }, { kind: 'add', path: 'v.mp4' }, { kind: 'unlink', path: 'never.png' }])
    await vi.advanceTimersByTimeAsync(PICTURE_CHANGE_MS * 3)
    expect(heard).not.toHaveBeenCalled()
    f.emit([{ kind: 'change', path: 'a.png', mtime: 2, size: 2 }])
    await vi.advanceTimersByTimeAsync(PICTURE_CHANGE_MS + 1)
    expect(heard).toHaveBeenCalledTimes(1)
    host.dispose()
  })

  it('keeps the changes that arrive while the list is on its way, and applies them on top of it', async () => {
    let release!: () => void
    const f = fakeBridge({ assets: [{ path: 'a.png' }, { path: 'dropped-meanwhile.png' }] })
    f.st.listGate = new Promise<void>((r) => (release = r))
    const host = createFloatingBoardHost(f.bridge, BOARD)
    await settle()
    f.emit([{ kind: 'unlink', path: 'dropped-meanwhile.png' }, { kind: 'add', path: 'added-meanwhile.png' }])
    release()
    const list = await host.pictures.list()
    expect(list.map((a) => a.path).sort()).toEqual(['a.png', 'added-meanwhile.png'])
    host.dispose()
  })

  it('writes new pictures into the board\'s folder under a clean name, numbering a taken one, in the order given', async () => {
    const f = fakeBridge({ assets: [{ path: 'Boards/Gate/rust.png' }] })
    const host = createFloatingBoardHost(f.bridge, BOARD, { now: () => new Date(2026, 9, 9, 14, 35, 12) })
    await host.pictures.list()
    const out = await host.pictures.add([
      { name: 'rust.png', data: PNG },
      { name: 'rust.png', data: PNG },
      { name: 'my#pic[1].jpg', data: new Uint8Array([0xff, 0xd8, 0xff, 1]) },
      { name: 'image.png', data: PNG },
      { name: '', data: PNG },
    ])
    expect(out).toEqual([
      'Boards/Gate/rust 2.png',
      'Boards/Gate/rust 3.png',
      'Boards/Gate/my-pic-1.jpg',
      'Boards/Gate/ref 2026-10-09 143512.png',
      'Boards/Gate/ref 2026-10-09 143512 2.png',
    ])
    expect(f.st.created.map((c) => c.path)).toEqual(out)
    // They are in the list at once, so the board does not draw them as missing.
    for (const p of out) expect(host.pictures.exists(p as string)).toBe(true)
    host.dispose()
  })

  it('goes on to the next number when the vault says a name is taken that the list did not know', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD)
    f.st.existing.add('boards/gate/x.png')
    f.st.existing.add('boards/gate/x 2.png')
    expect(await host.pictures.add([{ name: 'x.png', data: PNG }])).toEqual(['Boards/Gate/x 3.png'])
    host.dispose()
  })

  it('gives null for a picture main refuses, and for a name that is taken all the way to the last number', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD)
    f.calls.createAsset.mockRejectedValueOnce(new Error("Error invoking remote method 'vault:createAsset': Error: Not a picture"))
    expect(await host.pictures.add([{ name: 'a.png', data: PNG }, { name: 'b.png', data: PNG }])).toEqual([null, 'Boards/Gate/b.png'])
    f.calls.createAsset.mockClear()
    f.calls.createAsset.mockRejectedValue(new Error('EEXIST: file already exists'))
    expect(await host.pictures.add([{ name: 'c.png', data: PNG }])).toEqual([null])
    expect(f.calls.createAsset).toHaveBeenCalledTimes(MAX_NAME_TRIES)
    host.dispose()
  })

  it('moves to `<name> pictures` once when the vault leaves the board\'s folder out, and keeps using it', async () => {
    const f = fakeBridge()
    f.st.excluded.add('Boards/Gate')
    const host = createFloatingBoardHost(f.bridge, BOARD)
    expect(await host.pictures.add([{ name: 'a.png', data: PNG }, { name: 'b.png', data: PNG }])).toEqual(['Boards/Gate pictures/a.png', 'Boards/Gate pictures/b.png'])
    // Only the first picture asked the excluded folder.
    expect(f.calls.createAsset.mock.calls.map((c) => c[0])).toEqual(['Boards/Gate/a.png', 'Boards/Gate pictures/a.png', 'Boards/Gate pictures/b.png'])
    host.dispose()
    // Both left out: refused, with no further tries.
    const g = fakeBridge()
    g.st.excluded.add('Boards/Gate')
    g.st.excluded.add('Boards/Gate pictures')
    const both = createFloatingBoardHost(g.bridge, BOARD)
    expect(await both.pictures.add([{ name: 'a.png', data: PNG }])).toEqual([null])
    expect(g.calls.createAsset).toHaveBeenCalledTimes(2)
    both.dispose()
  })

  it('reads a whole picture as a Blob of its type, and gives null for a video, an empty answer or a refusal', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD)
    const blob = await host.pictures.original('Art/a.jpg')
    expect(blob).toBeInstanceOf(Blob)
    expect(blob!.type).toBe('image/jpeg')
    expect(blob!.size).toBe(2)
    f.calls.readAssetChecked.mockClear()
    expect(await host.pictures.original('Art/clip.mp4')).toBeNull()
    expect(await host.pictures.original('Art/notes.md')).toBeNull()
    expect(f.calls.readAssetChecked).not.toHaveBeenCalled()
    f.calls.readAssetChecked.mockResolvedValueOnce({ ok: true, bytes: new Uint8Array() })
    expect(await host.pictures.original('Art/a.png')).toBeNull()
    f.calls.readAssetChecked.mockRejectedValueOnce(new Error('ipc closed'))
    expect(await host.pictures.original('Art/a.png')).toBeNull()
    host.dispose()
  })

  it('says why a picture is not served: a refusal from main rejects with its reason (the picture cache keeps the verdict)', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD)
    for (const reason of ['missing', 'too-large', 'unreadable'] as const) {
      f.calls.readAssetChecked.mockResolvedValueOnce({ ok: false, reason, detail: `because ${reason}` })
      const err = await host.pictures.original('Art/a.png').then(
        () => null,
        (e: unknown) => e as Error & { reason?: string },
      )
      expect(err?.message, reason).toBe(`because ${reason}`)
      expect(err?.reason, reason).toBe(reason)
    }
    host.dispose()
  })

  it('makes a preview as a PNG Blob, and gives null for nothing or a failure', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD)
    const blob = await host.pictures.preview('Art/a.png', 256)
    expect(blob!.type).toBe('image/png')
    expect(f.calls.thumbnail).toHaveBeenCalledWith('Art/a.png', 256)
    f.calls.thumbnail.mockResolvedValueOnce(null)
    expect(await host.pictures.preview('Art/a.png', 256)).toBeNull()
    f.calls.thumbnail.mockResolvedValueOnce(new Uint8Array())
    expect(await host.pictures.preview('Art/a.png', 256)).toBeNull()
    f.calls.thumbnail.mockRejectedValueOnce(new Error('helper stopped'))
    expect(await host.pictures.preview('Art/a.png', 256)).toBeNull()
    host.dispose()
  })

  it('opens and reveals through the bridge, and toasts a failure', async () => {
    const f = fakeBridge()
    const toast = vi.fn()
    const host = createFloatingBoardHost(f.bridge, BOARD, { toast })
    host.pictures.open!('Art/a.png')
    host.pictures.reveal!('Art/a.png')
    expect(f.calls.openAsset).toHaveBeenCalledWith('Art/a.png')
    expect(f.calls.revealInFolder).toHaveBeenCalledWith('Art/a.png')
    f.calls.openAsset.mockRejectedValueOnce(new Error('No program'))
    host.pictures.open!('Art/b.png')
    await settle()
    expect(toast).toHaveBeenCalledWith('Could not open b.png: No program', 'error')
    host.dispose()
  })
})

describe('floating host: the window\'s own controls', () => {
  it('starts from the status it was given, and from the bridge\'s when it was not', async () => {
    const f = fakeBridge()
    const given = createFloatingBoardHost(f.bridge, BOARD, { status: { ...STATUS, alwaysOnTop: false, opacity: 0.4, supportsOpacity: false } })
    expect(given.window).toMatchObject({ floating: true, alwaysOnTop: false, opacity: 0.4, supportsOpacity: false })
    expect(f.calls.boardStatus).not.toHaveBeenCalled()
    f.st.status = { ...STATUS, opacity: 0.7 }
    const asked = createFloatingBoardHost(f.bridge, BOARD)
    expect(asked.window).toMatchObject({ alwaysOnTop: true, opacity: 1, supportsOpacity: false })
    await settle()
    expect(asked.window).toMatchObject({ opacity: 0.7, supportsOpacity: true })
    given.dispose()
    asked.dispose()
  })

  it('sends a new always-on-top and a clamped opacity to main and takes main\'s answer', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD, { status: STATUS })
    host.window!.setOpacity(0.05)
    expect(host.window!.opacity).toBe(0.2)
    host.window!.setOpacity(7)
    expect(host.window!.opacity).toBe(1)
    host.window!.setOpacity(Number.NaN)
    host.window!.setOpacity(Infinity)
    // A number that is no number (NaN, infinity) is not sent at all.
    expect(f.calls.boardConfigure.mock.calls.map((c) => c[0])).toEqual([{ opacity: 0.2 }, { opacity: 1 }])
    host.window!.setAlwaysOnTop(false)
    expect(host.window!.alwaysOnTop).toBe(false)
    expect(f.calls.boardConfigure).toHaveBeenLastCalledWith({ alwaysOnTop: false })
    await settle()
    expect(host.window!.alwaysOnTop).toBe(false)
    host.dispose()
  })

  it('shows what the window really is when main refuses a change', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD, { status: STATUS })
    f.calls.boardConfigure.mockRejectedValueOnce(new Error('no window'))
    host.window!.setAlwaysOnTop(false)
    expect(host.window!.alwaysOnTop).toBe(false)
    await settle()
    expect(host.window!.alwaysOnTop).toBe(true)
    host.dispose()
  })

  it('follows board:state from main (the other window changed a setting)', () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD, { status: STATUS })
    f.emitState({ ...STATUS, alwaysOnTop: false, opacity: 0.3 })
    expect(host.window).toMatchObject({ alwaysOnTop: false, opacity: 0.3 })
    host.dispose()
  })

  it('docks by closing the window, after a save in flight has finished', async () => {
    const f = fakeBridge()
    const host = createFloatingBoardHost(f.bridge, BOARD, { status: STATUS })
    await host.load()
    let finish!: () => void
    f.calls.boardSave.mockImplementationOnce(
      (_p: string, text: string) =>
        new Promise<{ ok: true }>((r) => {
          finish = () => {
            f.st.note = text
            f.st.saves.push(text)
            r({ ok: true })
          }
        }),
    )
    const saving = host.save('last words')
    host.window!.dock()
    await settle()
    expect(f.calls.boardClose).not.toHaveBeenCalled()
    finish()
    await saving
    await settle()
    expect(f.st.note).toBe('last words')
    expect(f.calls.boardClose).toHaveBeenCalledTimes(1)
    // popOut is the docked view's job: nothing happens here.
    host.window!.popOut()
    expect(f.calls.boardClose).toHaveBeenCalledTimes(1)
    host.dispose()
  })

  it('copies text and toasts through what the page gave it', async () => {
    const f = fakeBridge()
    const toast = vi.fn()
    const host = createFloatingBoardHost(f.bridge, BOARD, { toast })
    await host.copyText('#ff8800')
    expect(f.calls.copyText).toHaveBeenCalledWith('#ff8800')
    host.toast('Saved', 'success')
    expect(toast).toHaveBeenCalledWith('Saved', 'success')
    // Without a toast function it is silent, not a crash.
    expect(() => createFloatingBoardHost(fakeBridge().bridge, BOARD).toast('x')).not.toThrow()
    host.dispose()
  })
})

/* ------------------------------------------------------------------ */
/* board.ts: the docked side (palette, key, what the docked view uses) */
/* ------------------------------------------------------------------ */

describe('board.ts: the brain window\'s side of the floating window', () => {
  type BoardModule = typeof import('../src/renderer/board.js')
  type UiModule = typeof import('@aether/ui')
  let mod: BoardModule
  let ui: UiModule
  let findCommands: typeof import('../../../packages/ui/src/commands').findCommands
  let handleKey: typeof import('../../../packages/ui/src/hooks/useKeyboard').handleKey
  const CLOSED: BoardStatusDto = { open: false, path: null, alwaysOnTop: true, opacity: 1, supportsOpacity: true }
  const impl = {
    open: vi.fn(async (_p: string): Promise<BoardStatusDto> => CLOSED),
    close: vi.fn(async (): Promise<void> => undefined),
    status: vi.fn(async (): Promise<BoardStatusDto> => CLOSED),
    configure: vi.fn(async (_patch: object): Promise<BoardStatusDto> => CLOSED),
  }
  const listeners = { state: [] as ((s: BoardStatusDto) => void)[], closed: [] as ((p: string) => void)[], flush: [] as ((t: number) => void)[] }
  const acks: number[] = []
  const emitState = (s: BoardStatusDto): void => listeners.state.forEach((cb) => cb(s))
  const emitClosed = (p: string): void => listeners.closed.forEach((cb) => cb(p))
  const toasts = (): string[] => ui.useAether.getState().toasts.map((t) => t.text)
  const pressed = (key: string): void => {
    handleKey({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, preventDefault() {} } as unknown as KeyboardEvent)
  }
  const palette = (): Map<string, ReturnType<typeof findCommands>[number]> => new Map(findCommands('Board', ui.useAether.getState()).map((c) => [c.id, c]))

  beforeAll(async () => {
    // The brain window's modules look at `window` when they load: give them the bridge the preload would (and what the 3D code wants of a browser).
    const nav = { userAgent: 'node', platform: 'linux', maxTouchPoints: 0 }
    vi.stubGlobal('navigator', nav)
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined })
    const bridge = {
      platform: 'linux',
      onBoardState: (cb: (s: BoardStatusDto) => void) => (listeners.state.push(cb), () => undefined),
      onBoardClosed: (cb: (p: string) => void) => (listeners.closed.push(cb), () => undefined),
      onBoardFlush: (cb: (token: number) => void) => (listeners.flush.push(cb), () => undefined),
      boardFlushed: (token: number) => void acks.push(token),
      boardStatus: () => impl.status(),
      boardOpen: (p: string) => impl.open(p),
      boardClose: () => impl.close(),
      boardConfigure: (patch: object) => impl.configure(patch),
    }
    vi.stubGlobal('window', { aether: bridge, navigator: nav, addEventListener() {}, removeEventListener() {} })
    ui = await import('@aether/ui')
    findCommands = (await import('../../../packages/ui/src/commands')).findCommands
    handleKey = (await import('../../../packages/ui/src/hooks/useKeyboard')).handleKey
    mod = await import('../src/renderer/board.js')
    await Promise.resolve()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    for (const fn of Object.values(impl)) fn.mockReset()
    impl.open.mockResolvedValue(CLOSED)
    impl.close.mockResolvedValue(undefined)
    impl.status.mockResolvedValue(CLOSED)
    impl.configure.mockResolvedValue(CLOSED)
    emitState(CLOSED)
    ui.useAether.setState({ boardPath: null, toasts: [] } as never)
    mod.setBoardFlush(null)
  })

  it('is on in the desktop app, and starts from a closed window', () => {
    expect(mod.boardPopOutAvailable()).toBe(true)
    expect(mod.boardWindowState()).toEqual(CLOSED)
  })

  it('reads "70", "70 %" and "70%" as a window opacity of 0.7, whole percents from 20 to 100, and nothing else', () => {
    expect(mod.OPACITY_MIN_PERCENT).toBe(20)
    for (const [text, want] of [['70', 0.7], [' 70 % ', 0.7], ['70%', 0.7], ['100', 1], ['20', 0.2], ['20.4', 0.2], ['99.5', 1], ['  45', 0.45], ['100.0', 1]] as const) {
      expect(mod.parseOpacityPercent(text), text).toBe(want)
    }
    for (const bad of ['19', '19.9', '101', '1000', '0', '-5', '', ' ', 'abc', '7e1', '0x40', '50 percent', '5 0', '50%%', '%50', '.5', '1e2', '٥٠']) {
      expect(mod.parseOpacityPercent(bad), bad).toBeNull()
    }
  })

  it('mirrors what main says about the window, and keeps the same object when nothing differs', () => {
    const open: BoardStatusDto = { open: true, path: 'Boards/Gate.md', alwaysOnTop: false, opacity: 0.6, supportsOpacity: true }
    emitState(open)
    expect(mod.boardWindowState()).toEqual(open)
    const kept = mod.boardWindowState()
    emitState({ ...open })
    expect(mod.boardWindowState()).toBe(kept)
    emitState({ ...open, opacity: 0.5 })
    expect(mod.boardWindowState()).not.toBe(kept)
  })

  it('tells a view whether the window shows its board (compared exactly, as Linux does)', () => {
    const Probe = (props: { path: string | null }) => createElement('span', null, String(mod.useBoardOut(props.path)))
    const draw = (path: string | null): string => renderToStaticMarkup(createElement(Probe, { path }))
    expect(draw('Boards/Gate.md')).toBe('<span>false</span>')
    emitState({ ...CLOSED, open: true, path: 'Boards/Gate.md' })
    expect(draw('Boards/Gate.md')).toBe('<span>true</span>')
    expect(draw('Boards/Other.md')).toBe('<span>false</span>')
    expect(draw('boards/gate.md')).toBe('<span>false</span>')
    expect(draw(null)).toBe('<span>false</span>')
    expect(draw('')).toBe('<span>false</span>')
    // A closed window shows nothing, whatever path it last had.
    emitState({ ...CLOSED, open: false, path: 'Boards/Gate.md' })
    expect(draw('Boards/Gate.md')).toBe('<span>false</span>')
  })

  it('hands a board back to every listener when the window lets go of it, and survives one that throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const a = vi.fn(() => {
      throw new Error('this view broke')
    })
    const b = vi.fn()
    const offA = mod.onBoardReturned(a)
    const offB = mod.onBoardReturned(b)
    emitClosed('Boards/Gate.md')
    expect(a).toHaveBeenCalledWith('Boards/Gate.md')
    expect(b).toHaveBeenCalledWith('Boards/Gate.md')
    expect(warn).toHaveBeenCalled()
    offA()
    offB()
    emitClosed('Boards/Other.md')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  describe('pop out and dock', () => {
    it('saves what the docked view has pending first, then opens the window, and says whether it shows the board', async () => {
      const order: string[] = []
      mod.setBoardFlush(async () => void order.push('flush'))
      const shown: BoardStatusDto = { ...CLOSED, open: true, path: 'Boards/Gate.md' }
      impl.open.mockImplementation(async (p) => (order.push(`open ${p}`), shown))
      await expect(mod.popOutBoard('Boards/Gate.md')).resolves.toBe(true)
      expect(order).toEqual(['flush', 'open Boards/Gate.md'])
      expect(mod.boardWindowState()).toEqual(shown)
    })

    it('does not move the board when it could not be saved first, and says so', async () => {
      mod.setBoardFlush(async () => {
        throw new Error('The disk is full')
      })
      await expect(mod.popOutBoard('Boards/Gate.md')).resolves.toBe(false)
      expect(impl.open).not.toHaveBeenCalled()
      expect(toasts().join('\n')).toMatch(/could not be saved first.*The disk is full/)
    })

    it('says why main refused, without the IPC wrapper, and leaves the docked view as it was', async () => {
      impl.open.mockRejectedValue(new Error("Error invoking remote method 'board:open': Error: There is no note at Boards/Gate.md"))
      await expect(mod.popOutBoard('Boards/Gate.md')).resolves.toBe(false)
      expect(toasts()).toEqual(['Board window: There is no note at Boards/Gate.md'])
      expect(mod.boardWindowState().open).toBe(false)
    })

    it('is false when the window ends up on another board', async () => {
      impl.open.mockResolvedValue({ ...CLOSED, open: true, path: 'Boards/Other.md' })
      await expect(mod.popOutBoard('Boards/Gate.md')).resolves.toBe(false)
    })

    it('uses the flush the view registered last, and lets a replaced one unregister without harm', async () => {
      const first = vi.fn()
      const second = vi.fn()
      const offFirst = mod.setBoardFlush(first)
      const offSecond = mod.setBoardFlush(second)
      offFirst()
      await mod.popOutBoard('Boards/Gate.md')
      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledTimes(1)
      offSecond()
      second.mockClear()
      await mod.popOutBoard('Boards/Gate.md')
      expect(second).not.toHaveBeenCalled()
    })

    it('docks by closing the window, only when it is open', async () => {
      await mod.dockBoard()
      expect(impl.close).not.toHaveBeenCalled()
      emitState({ ...CLOSED, open: true, path: 'Boards/Gate.md' })
      await mod.dockBoard()
      expect(impl.close).toHaveBeenCalledTimes(1)
      impl.close.mockRejectedValueOnce(new Error('already gone'))
      await mod.dockBoard()
      expect(toasts()).toEqual(['Board window: already gone'])
    })
  })

  describe('the palette', () => {
    const titles = (): string[] => [...palette().values()].map((c) => c.title).filter((t) => t.startsWith('Board: ')).sort()

    it('offers on top and opacity with no board open, and nothing that needs a board', () => {
      expect(titles()).toEqual(['Board: Always on top', 'Board: Window opacity…'])
    })

    it('offers to pop out the board that is open in the docked view, and to bring it back while the window has one', () => {
      ui.useAether.setState({ boardPath: 'Boards/Gate.md' } as never)
      expect(titles()).toEqual(['Board: Always on top', 'Board: Pop out to its own window', 'Board: Window opacity…'])
      // The window shows that board already: only the way back.
      emitState({ ...CLOSED, open: true, path: 'Boards/Gate.md' })
      expect(titles()).toEqual(['Board: Always on top', 'Board: Bring the board back from its window', 'Board: Window opacity…'])
      // The window shows another board: the docked one can still be popped out (it takes the window over).
      emitState({ ...CLOSED, open: true, path: 'Boards/Other.md' })
      expect(titles()).toContain('Board: Pop out to its own window')
      expect(titles()).toContain('Board: Bring the board back from its window')
    })

    it('does not offer the opacity where windows cannot be dimmed', () => {
      emitState({ ...CLOSED, supportsOpacity: false })
      expect(titles()).toEqual(['Board: Always on top'])
    })

    it('pops out the docked board, and brings it back', async () => {
      ui.useAether.setState({ boardPath: 'Boards/Gate.md' } as never)
      const open = { ...CLOSED, open: true, path: 'Boards/Gate.md' }
      impl.open.mockResolvedValue(open)
      void palette().get('board-window-pop-out')!.run(ui.useAether.getState())
      await vi.advanceTimersByTimeAsync(0)
      expect(impl.open).toHaveBeenCalledWith('Boards/Gate.md')
      expect(mod.boardWindowState()).toEqual(open)
      await palette().get('board-window-dock')!.run(ui.useAether.getState())
      expect(impl.close).toHaveBeenCalledTimes(1)
    })

    it('flips always on top from what the window said, and shows the answer', async () => {
      impl.configure.mockResolvedValueOnce({ ...CLOSED, alwaysOnTop: false })
      await palette().get('board-window-on-top')!.run(ui.useAether.getState())
      expect(impl.configure).toHaveBeenLastCalledWith({ alwaysOnTop: false })
      expect(mod.boardWindowState().alwaysOnTop).toBe(false)
      expect(toasts().at(-1)).toMatch(/no longer stays on top/)
      impl.configure.mockResolvedValueOnce({ ...CLOSED, alwaysOnTop: true })
      await palette().get('board-window-on-top')!.run(ui.useAether.getState())
      expect(impl.configure).toHaveBeenLastCalledWith({ alwaysOnTop: true })
      expect(toasts().at(-1)).toMatch(/stays on top of other windows/)
      impl.configure.mockRejectedValueOnce(new Error('no window'))
      await palette().get('board-window-on-top')!.run(ui.useAether.getState())
      expect(toasts().at(-1)).toBe('Board window: no window')
    })

    it('uses the key w for the same thing as the pop out and dock commands, and says what to do when there is no board', async () => {
      pressed('w')
      expect(toasts().at(-1)).toMatch(/Open a board first/)
      expect(impl.open).not.toHaveBeenCalled()
      ui.useAether.setState({ boardPath: 'Boards/Gate.md' } as never)
      pressed('w')
      await vi.advanceTimersByTimeAsync(0)
      expect(impl.open).toHaveBeenCalledWith('Boards/Gate.md')
      emitState({ ...CLOSED, open: true, path: 'Boards/Gate.md' })
      pressed('w')
      await vi.advanceTimersByTimeAsync(0)
      expect(impl.close).toHaveBeenCalledTimes(1)
    })
  })
})
