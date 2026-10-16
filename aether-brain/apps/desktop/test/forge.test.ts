import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import type { Browser, Page } from 'playwright-core'
import { MemoryVaultAdapter, type VaultFile } from '@aether/core'
import { IPC, type AetherForgeBridge, type ForgeFrameDto, type ForgeRequest, type ForgeSaveDto } from '../src/shared/ipc.js'
import {
  CAPTURE_TIMEOUT_MS,
  FORGE_CSP,
  FORGE_PARTITION,
  FORGE_TIMEOUT_MS,
  FRAME_MAX,
  FRAME_MS,
  ForgeHost,
  ForgeRelay,
  MAX_FORGE_PNG,
  MAX_GRADE_BYTES,
  NO_BRAIN,
  cleanOpenOptions,
  cleanProjects,
  cleanSave,
  cleanSaved,
  forgeFileRequest,
  forgeNavigation,
  forgePermission,
  forgeSettings,
  frameOf,
  frameSize,
  isPng,
  PREVIEW_FPS,
  PREVIEW_IDLE_MS,
  unanswered,
  type ForgeElectron,
  type ForgeSettings,
  type RelayTarget,
} from '../src/main/forge.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const MOCK = path.join(here, 'fixtures', 'concept-forge-mock.html')

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (extra = 8) => new Uint8Array([...PNG_HEAD, ...new Array<number>(extra).fill(7)])
const dto = (over: Record<string, unknown> = {}) => ({ projectId: 'Projects/PORTALz', title: 'Gesture', png: png(), ...over })

/* ------------------------------------------------------------------ */
/* Pure checks                                                        */
/* ------------------------------------------------------------------ */

describe('save DTO validation', () => {
  it('accepts a well-formed save and fills practiceTomorrow', () => {
    const grade = { letter: 'B+', overall: 82, breakdown: [{ label: 'Rhythm', score: 81 }] }
    const out = cleanSave({ ...dto({ grade }), extra: 'dropped' })
    expect(out).toEqual({ projectId: 'Projects/PORTALz', title: 'Gesture', png: png(), grade, practiceTomorrow: true })
    expect(cleanSave(dto({ practiceTomorrow: false })).practiceTomorrow).toBe(false)
    expect(cleanSave(dto({ title: undefined })).title).toBe('')
    expect(cleanSave(dto({ grade: undefined })).grade).toBeNull()
  })

  it('needs a project id and a title of at most 200 characters', () => {
    expect(() => cleanSave(null)).toThrow('Nothing to save')
    expect(() => cleanSave(dto({ projectId: '' }))).toThrow('Pick a project')
    expect(() => cleanSave(dto({ projectId: 42 }))).toThrow('Pick a project')
    expect(() => cleanSave(dto({ title: 7 }))).toThrow('The title must be text')
    expect(cleanSave(dto({ title: 'x'.repeat(200) })).title).toHaveLength(200)
    expect(() => cleanSave(dto({ title: 'x'.repeat(201) }))).toThrow('longer than 200')
    expect(() => cleanSave(dto({ practiceTomorrow: 'yes' }))).toThrow('true or false')
  })

  it('takes PNG bytes only (magic bytes), not empty, at most 40 MB', () => {
    expect(() => cleanSave(dto({ png: 'iVBORw0KGgo=' }))).toThrow('PNG bytes expected')
    expect(() => cleanSave(dto({ png: new Uint8Array(0) }))).toThrow('empty')
    expect(() => cleanSave(dto({ png: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]) }))).toThrow('not a PNG')
    // Only the first four bytes of the signature: a truncated or fake header.
    expect(() => cleanSave(dto({ png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }))).toThrow('not a PNG')
    const big = new Uint8Array(MAX_FORGE_PNG + 1)
    big.set(PNG_HEAD)
    expect(() => cleanSave(dto({ png: big }))).toThrow('too big')
    const max = new Uint8Array(MAX_FORGE_PNG)
    max.set(PNG_HEAD)
    expect(cleanSave(dto({ png: max })).png.length).toBe(MAX_FORGE_PNG)
    // Other views and a bare ArrayBuffer (what structured clone may hand over) read as the same bytes.
    expect(cleanSave(dto({ png: png().buffer })).png).toEqual(png())
    expect([...cleanSave(dto({ png: Buffer.from(png()) })).png]).toEqual([...png()])
    expect(isPng(png(0))).toBe(true)
    expect(isPng(new Uint8Array([0x89, 0x50]))).toBe(false)
  })

  it('takes a grade that is plain JSON of at most 256 KB', () => {
    expect(() => cleanSave(dto({ grade: { when: new Date() } }))).toThrow('not plain JSON')
    expect(() => cleanSave(dto({ grade: { scores: new Map() } }))).toThrow('not plain JSON')
    expect(() => cleanSave(dto({ grade: { bytes: new Uint8Array(2) } }))).toThrow('not plain JSON')
    expect(() => cleanSave(dto({ grade: { score: Number.NaN } }))).toThrow('not plain JSON')
    const cyclic: Record<string, unknown> = { letter: 'B' }
    cyclic['self'] = cyclic
    expect(() => cleanSave(dto({ grade: cyclic }))).toThrow('not plain JSON')
    let deep: Record<string, unknown> = { letter: 'A' }
    for (let i = 0; i < 40; i++) deep = { deep }
    expect(() => cleanSave(dto({ grade: deep }))).toThrow('not plain JSON')
    // A shared (not cyclic) object is fine: structured clone keeps sharing.
    const shared = { label: 'Rhythm', score: 81 }
    expect(cleanSave(dto({ grade: { a: shared, b: shared } })).grade).toEqual({ a: shared, b: shared })
    expect(() => cleanSave(dto({ grade: { notes: 'x'.repeat(MAX_GRADE_BYTES) } }))).toThrow('larger than 256 KB')
    // Multi-byte text counts in bytes, as it would be stored.
    expect(() => cleanSave(dto({ grade: { notes: 'é'.repeat(MAX_GRADE_BYTES / 2) } }))).toThrow('larger than 256 KB')
    expect(cleanSave(dto({ grade: { notes: 'x'.repeat(MAX_GRADE_BYTES - 20) } })).grade).toBeTruthy()
    expect(cleanSave(dto({ grade: [{ letter: 'C' }] })).grade).toEqual([{ letter: 'C' }])
  })
})

describe('settings, options, permissions, navigation', () => {
  it('remembers only an absolute concept-forge.html path', () => {
    const abs = path.resolve('/art/concept-forge.html')
    expect(forgeSettings({ file: abs, junk: 1 })).toEqual({ file: abs })
    expect(forgeSettings({ file: 'concept-forge.html' })).toEqual({})
    expect(forgeSettings({ file: 3 })).toEqual({})
    expect(forgeSettings(undefined)).toEqual({})
    expect(cleanOpenOptions({ pick: true })).toEqual({ pick: true })
    expect(cleanOpenOptions({ pick: 'yes' })).toEqual({ pick: false })
    expect(cleanOpenOptions(null)).toEqual({ pick: false })
  })

  it('allows the page clipboard writes, fullscreen and pointer lock, nothing else', () => {
    for (const p of ['clipboard-sanitized-write', 'fullscreen', 'pointerLock']) expect(forgePermission(p)).toBe(true)
    for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'hid', 'serial', 'usb']) expect(forgePermission(p)).toBe(false)
  })

  it('stays on the file, sends web links to the browser, denies the rest', () => {
    const file = '/home/me/art/concept-forge.html'
    expect(forgeNavigation('file:///home/me/art/concept-forge.html', file, 'linux')).toBe('allow')
    expect(forgeNavigation('file:///home/me/art/concept-forge.html?drill=gesture#top', file, 'linux')).toBe('allow')
    expect(forgeNavigation('file:///home/me/art/other.html', file, 'linux')).toBe('deny')
    expect(forgeNavigation('file:///home/me/art/Concept-Forge.html', file, 'linux')).toBe('deny')
    expect(forgeNavigation('https://example.com/refs', file, 'linux')).toBe('external')
    expect(forgeNavigation('http://example.com', null, 'linux')).toBe('external')
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'about:blank', 'blob:null/1234', 'devtools://x', 'not a url']) {
      expect(forgeNavigation(url, file, 'linux')).toBe('deny')
    }
    // Windows: drive letters, backslashes and case don't matter.
    const win = 'D:\\Art\\concept-forge.html'
    expect(forgeNavigation('file:///D:/Art/concept-forge.html', win, 'win32')).toBe('allow')
    expect(forgeNavigation('file:///d:/art/CONCEPT-FORGE.html#x', win, 'win32')).toBe('allow')
    expect(forgeNavigation('file:///D:/Art/other.html', win, 'win32')).toBe('deny')
    expect(forgeNavigation('file:///C:/Windows/System32/calc.exe', win, 'win32')).toBe('deny')
  })

  it('serves the page itself to its session and no other file', () => {
    const file = '/home/me/art/concept-forge.html'
    // The page, a reload with any query or hash.
    expect(forgeFileRequest('file:///home/me/art/concept-forge.html', file, 'linux')).toBe(true)
    expect(forgeFileRequest('file:///home/me/art/concept-forge.html?drill=gesture#top', file, 'linux')).toBe(true)
    expect(forgeFileRequest('file:///home/me/art/./x/../concept-forge.html', file, 'linux')).toBe(true)
    // Spaces, # and % in the page's path are escaped in its URL.
    const odd = '/home/me/My Art #2/concept 100%.html'
    // `windows: false`: `odd` is a POSIX path judged as 'linux', so its URL is spelled that way on every platform (pathToFileURL
    // would put a drive letter in front of it on Windows).
    expect(forgeFileRequest(pathToFileURL(odd, { windows: false }).href, odd, 'linux')).toBe(true)
    expect(forgeFileRequest('file:///home/me/My Art %232/concept 100%25.html#top', odd, 'linux')).toBe(true)
    // As Electron's loadFile spells it: `#` escaped, a `%` that starts no escape left as it is.
    expect(forgeFileRequest('file:///home/me/My%20Art%20%232/concept%20100%.html', odd, 'linux')).toBe(true)
    expect(forgeNavigation('file:///home/me/My%20Art%20%232/concept%20100%.html#x', odd, 'linux')).toBe('allow')
    expect(forgeFileRequest('file:///home/me/My%20Art%20%232/other%20100%.html', odd, 'linux')).toBe(false)
    // Anything else on the disk: the vault's notes and pictures, files next to the page, its folder, system files.
    for (const url of [
      'file:///D/vault/Projects/PORTALz.md',
      'file:///home/me/art/refs/pose.png',
      'file:///home/me/art/',
      'file:///home/me/art',
      'file:///etc/hostname',
      'file:///home/me/art/Concept-Forge.html',
      'file:///home/me/art/concept-forge.html/..',
      'file:///home/me/art%2Fconcept-forge.html',
      'file://server/home/me/art/concept-forge.html',
    ]) {
      expect(forgeFileRequest(url, file, 'linux')).toBe(false)
    }
    // Not a file URL, nothing on show, not a URL.
    for (const url of ['https://example.com/concept-forge.html', 'blob:file:///1234', 'data:text/html,hi', 'not a url']) expect(forgeFileRequest(url, file, 'linux')).toBe(false)
    expect(forgeFileRequest('file:///home/me/art/concept-forge.html', null, 'linux')).toBe(false)
    // Windows: drive letters, backslashes and case don't matter; other drives and shares are refused.
    const win = 'D:\\Art\\concept-forge.html'
    expect(forgeFileRequest('file:///d:/art/CONCEPT-FORGE.html?x=1', win, 'win32')).toBe(true)
    expect(forgeFileRequest('file:///D:/Notes/PORTALz.md', win, 'win32')).toBe(false)
    expect(forgeFileRequest('file:///F:/Art/concept-forge.html', win, 'win32')).toBe(false)
    expect(forgeFileRequest('file://nas/share/Art/concept-forge.html', win, 'win32')).toBe(false)
    expect(forgeFileRequest('file:///D:/Art/concept-forge.html', '\\\\nas\\share\\concept-forge.html', 'win32')).toBe(false)
    expect(forgeFileRequest('file://nas/share/concept-forge.html', '\\\\nas\\share\\concept-forge.html', 'win32')).toBe(true)
  })

  it('reduces the brain answers to well-typed values', () => {
    const row = { id: 'Projects/PORTALz', title: 'PORTALz', status: 'active', home: 'Projects/PORTALz', critique: 'Projects/PORTALz/Critique' }
    expect(cleanProjects([row, { id: 3 }, null, { ...row, id: 'X', status: 5, home: null }])).toEqual([row, { ...row, id: 'X', status: null, home: null }])
    expect(() => cleanProjects({})).toThrow('no project list')
    const saved = { noteId: 'a', notePath: 'a.md', imagePath: 'a.png', project: 'P' }
    expect(cleanSaved({ ...saved, more: 1 })).toEqual(saved)
    expect(() => cleanSaved({ noteId: 'a' })).toThrow('unexpected answer')
  })
})

/* ------------------------------------------------------------------ */
/* Relay bookkeeping                                                  */
/* ------------------------------------------------------------------ */

class FakeTarget implements RelayTarget {
  sent: unknown[][] = []
  destroyed = false
  fail = false
  send(...args: unknown[]): void {
    if (this.fail) throw new Error('Object has been destroyed')
    this.sent.push(args)
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

describe('relay', () => {
  afterEach(() => void vi.useRealTimers())

  it('numbers requests, sends them to the brain and settles each with its answer', async () => {
    const t = new FakeTarget()
    const relay = new ForgeRelay(() => t)
    const a = relay.request({ kind: 'projects' })
    const save = cleanSave(dto())
    const b = relay.request({ kind: 'save', save })
    expect(t.sent).toEqual([
      [IPC.forgeRequest, { id: 1, kind: 'projects' }],
      [IPC.forgeRequest, { id: 2, kind: 'save', save }],
    ])
    expect(relay.pending).toBe(2)
    expect(relay.reply(2, false, 'That project is no longer in the vault')).toBe(true)
    expect(relay.reply(1, true, ['p'])).toBe(true)
    await expect(a).resolves.toEqual(['p'])
    await expect(b).rejects.toThrow('That project is no longer in the vault')
    expect(relay.pending).toBe(0)
    // Late, repeated or foreign answers change nothing.
    expect(relay.reply(1, true, 'again')).toBe(false)
    expect(relay.reply('1', true, 'x')).toBe(false)
    expect(relay.reply(99, true, 'x')).toBe(false)
  })

  it('gives a readable error for an empty failure message', async () => {
    const t = new FakeTarget()
    const relay = new ForgeRelay(() => t)
    const p = relay.request({ kind: 'projects' })
    relay.reply(1, false, '')
    await expect(p).rejects.toThrow('Aether Brain could not do that')
  })

  it('says to open the vault when there is no brain window, it is gone, or the send fails', async () => {
    await expect(new ForgeRelay(() => null).request({ kind: 'projects' })).rejects.toThrow(NO_BRAIN)
    const t = new FakeTarget()
    t.destroyed = true
    await expect(new ForgeRelay(() => t).request({ kind: 'projects' })).rejects.toThrow(NO_BRAIN)
    const f = new FakeTarget()
    f.fail = true
    const relay = new ForgeRelay(() => f)
    await expect(relay.request({ kind: 'projects' })).rejects.toThrow(NO_BRAIN)
    expect(relay.pending).toBe(0)
  })

  it('times out after 30 s, forgets the request, and never tells a sent save to open the vault', async () => {
    vi.useFakeTimers()
    const t = new FakeTarget()
    const relay = new ForgeRelay(() => t)
    expect(relay.timeoutMs).toBe(FORGE_TIMEOUT_MS)
    const outcome = (p: Promise<unknown>) =>
      p.then(
        () => 'resolved',
        (err: Error) => err.message,
      )
    const projects = outcome(relay.request({ kind: 'projects' }))
    const save = outcome(relay.request({ kind: 'save', save: cleanSave(dto()) }))
    vi.advanceTimersByTime(FORGE_TIMEOUT_MS - 1)
    expect(relay.pending).toBe(2)
    vi.advanceTimersByTime(1)
    expect(await projects).toBe("Aether Brain didn't answer in 30 s; try again")
    // The brain got the save and may still write it: saying so keeps the page from filing it twice.
    expect(await save).toBe(
      "Aether Brain hasn't answered in 30 s; the drawing may still have been saved — check the project's Critique planet before saving again",
    )
    expect(relay.pending).toBe(0)
    expect(relay.reply(1, true, [])).toBe(false)
    expect(relay.reply(2, true, {})).toBe(false)
    // A short test timeout still reads as whole seconds.
    expect(unanswered('projects', 50)).toBe("Aether Brain didn't answer in 1 s; try again")
  })

  it('fails everything waiting when the brain goes away', async () => {
    const t = new FakeTarget()
    const relay = new ForgeRelay(() => t)
    const a = relay.request({ kind: 'projects' })
    const b = relay.request({ kind: 'projects' })
    relay.rejectAll(NO_BRAIN)
    await expect(a).rejects.toThrow(NO_BRAIN)
    await expect(b).rejects.toThrow(NO_BRAIN)
    expect(relay.pending).toBe(0)
  })
})

describe('star screen frames', () => {
  it('scales a page down to at most FRAME_MAX each way, keeping its shape, and never up', () => {
    expect(frameSize(1600, 1000)).toEqual({ width: FRAME_MAX, height: 640 })
    expect(frameSize(800, 500)).toEqual({ width: 800, height: 500 })
    // A tall window (a screen on its side) is held by its height.
    expect(frameSize(1000, 4000)).toEqual({ width: 256, height: FRAME_MAX })
    expect(frameSize(0, 100)).toEqual({ width: 0, height: 0 })
    expect(frameSize(NaN, 100)).toEqual({ width: 0, height: 0 })
    expect(frameSize(100000, 1)).toEqual({ width: FRAME_MAX, height: 1 })
  })

  it('turns a paint into raw pixels, and an empty or odd picture into nothing', () => {
    const f = frameOf(fakeImage(2048, 1280, 3) as never)
    expect(f).toMatchObject({ width: 1024, height: 640, bgra: true })
    expect(f?.data.length).toBe(1024 * 640 * 4)
    expect(frameOf(fakeImage(0, 0) as never)).toBeNull()
    const odd = { ...fakeImage(10, 10), resize: () => ({ ...fakeImage(10, 10), toBitmap: () => Buffer.alloc(7) }) }
    expect(frameOf(odd as never)).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* Host, with fake Electron modules                                   */
/* ------------------------------------------------------------------ */

let nextContentsId = 1

/** A NativeImage stand-in: `width × height` pixels, all `fill`. */
interface FakeImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(o: { width?: number; height?: number }): FakeImage
  toBitmap(): Buffer
}

function fakeImage(width: number, height: number, fill = 9): FakeImage {
  return {
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    resize: (o) => fakeImage(o.width ?? width, o.height ?? height, fill),
    toBitmap: () => Buffer.alloc(width * height * 4, fill),
  }
}

class FakeContents extends EventEmitter {
  readonly id = nextContentsId++
  sent: unknown[][] = []
  destroyed = false
  /** What the window shows (`getURL`). */
  url = ''
  openHandler: ((d: { url: string }) => { action: string }) | null = null
  muted = false
  frameRate = 60
  painting = true
  invalidated = 0
  /** What capturePage gives (the Forge window as it looks). */
  capture: FakeImage = fakeImage(1600, 1000)
  captures: unknown[] = []
  setAudioMuted(m: boolean): void {
    this.muted = m
  }
  setFrameRate(fps: number): void {
    this.frameRate = fps
  }
  isPainting(): boolean {
    return this.painting
  }
  startPainting(): void {
    this.painting = true
  }
  stopPainting(): void {
    this.painting = false
  }
  invalidate(): void {
    this.invalidated++
  }
  async capturePage(rect?: unknown, opts?: unknown): Promise<FakeImage> {
    this.captures.push(opts)
    return this.capture
  }
  send(...args: unknown[]): void {
    this.sent.push(args)
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  getURL(): string {
    return this.url
  }
  setWindowOpenHandler(fn: (d: { url: string }) => { action: string }): void {
    this.openHandler = fn
  }
}

class FakeWindow extends EventEmitter {
  static made: FakeWindow[] = []
  readonly webContents = new FakeContents()
  loaded: string[] = []
  focused = 0
  closed = false
  minimized = false
  visible = false
  constructor(readonly options: Record<string, unknown> = {}) {
    super()
  }
  isDestroyed(): boolean {
    return this.closed
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
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('closed')
  }
  destroyed = false
  destroy(): void {
    this.destroyed = true
    this.close()
  }
  getContentSize(): number[] {
    return [1500, 900]
  }
  focusedNow = false
  isFocused(): boolean {
    return this.focusedNow
  }
  /** Set to make the next loads fail like Electron's (e.g. `ERR_ABORTED` when the page's "leave?" answer is Stay). */
  loadError: (Error & { code?: string }) | null = null
  async loadFile(file: string): Promise<void> {
    this.loaded.push(file)
    if (this.loadError) throw this.loadError
    this.webContents.url = pathToFileURL(file).href
  }
}

/** An event as Electron hands it to `will-navigate` (with its url) and the other window events. */
function navEvent(url = ''): { url: string; prevented: boolean; preventDefault(): void } {
  return {
    url,
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
  }
}

describe('host', () => {
  let dir: string
  let file: string
  let brain: FakeWindow
  let picks: (string | null)[]
  let saved: unknown[]
  let permissionHandler: ((wc: unknown, perm: string, cb: (ok: boolean) => void) => void) | null
  let checkHandler: ((wc: unknown, perm: string) => boolean) | null
  let protocolHandlers: Map<string, (req: Request) => Response | Promise<Response>>
  /** `session.fetch` of the Forge session: what the file handler read from disk. */
  let sessionFetch: ReturnType<typeof vi.fn>
  let partitions: string[]
  let electron: {
    BrowserWindow: new (o: Record<string, unknown>) => FakeWindow
    dialog: { showOpenDialog: ReturnType<typeof vi.fn>; showMessageBoxSync: ReturnType<typeof vi.fn> }
    shell: { openExternal: ReturnType<typeof vi.fn> }
    session: { fromPartition(p: string): unknown }
    screen: { getPrimaryDisplay(): { workAreaSize: { width: number; height: number } } }
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-forge-'))
    file = path.join(dir, 'concept-forge.html')
    await fs.writeFile(file, '<!doctype html><title>CF</title>')
    brain = new FakeWindow()
    picks = []
    saved = []
    permissionHandler = null
    checkHandler = null
    protocolHandlers = new Map()
    sessionFetch = vi.fn(async (url: string) => new Response(`<!doctype html><title>${url}</title>`, { headers: { 'content-type': 'text/html' } }))
    partitions = []
    FakeWindow.made = []
    electron = {
      BrowserWindow: class extends FakeWindow {
        constructor(o: Record<string, unknown>) {
          super(o)
          FakeWindow.made.push(this)
        }
      },
      dialog: {
        showOpenDialog: vi.fn(async () => {
          const next = picks.shift() ?? null
          return { canceled: next === null, filePaths: next ? [next] : [] }
        }),
        showMessageBoxSync: vi.fn(() => 0),
      },
      shell: { openExternal: vi.fn(async () => undefined) },
      session: {
        fromPartition: (p: string) => {
          partitions.push(p)
          return {
            setPermissionRequestHandler: (fn: typeof permissionHandler) => void (permissionHandler = fn),
            setPermissionCheckHandler: (fn: typeof checkHandler) => void (checkHandler = fn),
            protocol: {
              handle: (scheme: string, fn: (req: Request) => Response | Promise<Response>) => {
                if (protocolHandlers.has(scheme)) throw new Error(`${scheme} is already handled`)
                protocolHandlers.set(scheme, fn)
              },
            },
            fetch: sessionFetch,
          }
        },
      },
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1366, height: 728 } }) },
    }
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const host = (settings: ForgeSettings = {}) =>
    new ForgeHost({
      electron: electron as unknown as ForgeElectron,
      settings,
      save: async (s) => void saved.push(s),
      brain: () => brain as never,
      preload: '/app/dist/preload/forge-preload.cjs',
      version: '0.4.0',
    })

  it('asks for the file the first time, remembers it, and opens one sandboxed window in its own session', async () => {
    const h = host()
    expect(h.status()).toEqual({ file: null, open: false })
    picks.push(file)
    await expect(h.open()).resolves.toEqual({ file, open: true })
    expect(saved).toEqual([{ file }])
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledTimes(1)
    const [parent, options] = electron.dialog.showOpenDialog.mock.calls[0] as [unknown, { filters: { extensions: string[] }[] }]
    expect(parent).toBe(brain)
    expect(options.filters[0]?.extensions).toEqual(['html', 'htm'])
    const [w] = FakeWindow.made
    expect(FakeWindow.made).toHaveLength(1)
    expect(w?.loaded).toEqual([file])
    expect(w?.options).toMatchObject({
      // 1600 × 1000, clamped to the work area of a small screen.
      width: 1366,
      height: 728,
      title: 'Concept Forge — Aether Brain',
      webPreferences: {
        preload: '/app/dist/preload/forge-preload.cjs',
        partition: FORGE_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        additionalArguments: ['--aether-forge-version=0.4.0'],
      },
    })
    expect(partitions).toEqual(['persist:forge'])
    const answers: boolean[] = []
    for (const perm of ['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'media', 'notifications']) permissionHandler?.(null, perm, (ok) => answers.push(ok))
    expect(answers).toEqual([true, true, true, false, false])
    expect(checkHandler?.(null, 'media')).toBe(false)
    expect(checkHandler?.(null, 'clipboard-sanitized-write')).toBe(true)

    // Again: the same window, focused (restored when minimized), not reloaded; no dialog.
    w!.minimized = true
    await h.open()
    expect(FakeWindow.made).toHaveLength(1)
    expect(w?.minimized).toBe(false)
    expect(w?.focused).toBe(1)
    expect(w?.loaded).toEqual([file])
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledTimes(1)
  })

  it('reopens the remembered file without asking, and asks again when it is gone or with pick', async () => {
    const h = host({ file })
    await h.open()
    expect(electron.dialog.showOpenDialog).not.toHaveBeenCalled()
    expect(FakeWindow.made[0]?.loaded).toEqual([file])

    // With pick: the new file replaces the old one in the same window.
    const other = path.join(dir, 'forge-v2.html')
    await fs.writeFile(other, '<!doctype html>')
    picks.push(other)
    await expect(h.open({ pick: true })).resolves.toEqual({ file: other, open: true })
    expect(FakeWindow.made).toHaveLength(1)
    expect(FakeWindow.made[0]?.loaded).toEqual([file, other])
    expect(saved).toEqual([{ file: other }])

    // Gone: asks, and a cancelled dialog changes nothing.
    FakeWindow.made[0]?.close()
    await fs.rm(other)
    picks.push(null)
    await expect(h.open()).resolves.toEqual({ file: other, open: false })
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledTimes(2)
    expect(FakeWindow.made).toHaveLength(1)
  })

  it('refuses a file that is not a page', async () => {
    const h = host()
    picks.push(path.join(dir, 'notes.txt'))
    await expect(h.open()).rejects.toThrow('.html page')
    expect(saved).toEqual([])
    expect(FakeWindow.made).toHaveLength(0)
  })

  it('joins a second open while the first is still asking', async () => {
    const h = host()
    picks.push(file)
    const [a, b] = await Promise.all([h.open(), h.open()])
    expect(a).toEqual(b)
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledTimes(1)
    expect(FakeWindow.made).toHaveLength(1)
  })

  it('keeps the window on its page: web links go to the browser, pop-ups are denied', async () => {
    const h = host({ file })
    await h.open()
    const wc = FakeWindow.made[0]!.webContents
    const same = navEvent(`${pathToFileURL(file).href}#drill`)
    wc.emit('will-navigate', same)
    expect(same.prevented).toBe(false)
    const web = navEvent('https://example.com/ref')
    wc.emit('will-navigate', web)
    expect(web.prevented).toBe(true)
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/ref')
    const local = navEvent(pathToFileURL(path.join(dir, 'secrets.html')).href)
    wc.emit('will-navigate', local)
    expect(local.prevented).toBe(true)
    expect(wc.openHandler?.({ url: 'https://example.com/pop' })).toEqual({ action: 'deny' })
    expect(electron.shell.openExternal).toHaveBeenLastCalledWith('https://example.com/pop')
    expect(wc.openHandler?.({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(2)
    // The page's own title doesn't replace the window's.
    const title = navEvent()
    FakeWindow.made[0]!.emit('page-title-updated', title, 'Concept Forge v3')
    expect(title.prevented).toBe(true)
    // A page that asks before unloading gets the user's answer.
    const unload = navEvent()
    wc.emit('will-prevent-unload', unload)
    expect(electron.dialog.showMessageBoxSync).toHaveBeenCalledTimes(1)
    expect(unload.prevented).toBe(true)
  })

  it('serves the page to its window with a policy that shuts file:, and refuses every other file', async () => {
    const h = host({ file })
    await h.open()
    const serve = protocolHandlers.get('file')
    expect([...protocolHandlers.keys()]).toEqual(['file'])
    const get = async (url: string) => {
      const res = await serve!(new Request(url))
      return { type: res.type, csp: res.headers.get('content-security-policy'), mime: res.headers.get('content-type'), body: res.type === 'error' ? null : await res.text() }
    }
    // The page (a reload, a query): read from disk as the chosen file, whatever the URL spells.
    const page = await get(`${pathToFileURL(file).href}?drill=gesture`)
    expect(page).toEqual({ type: 'default', csp: FORGE_CSP, mime: 'text/html', body: `<!doctype html><title>${pathToFileURL(file).href}</title>` })
    expect(sessionFetch).toHaveBeenCalledWith(pathToFileURL(file).href, { bypassCustomProtocolHandlers: true })
    // Everything else: a network error, and nothing is read.
    sessionFetch.mockClear()
    for (const url of [pathToFileURL(path.join(dir, 'secrets.md')).href, pathToFileURL(dir).href, 'file:///etc/hostname']) {
      expect((await get(url)).type).toBe('error')
    }
    expect(sessionFetch).not.toHaveBeenCalled()
    // The policy keeps the web, data: and blob: open, and file: shut (workers fetch around the handler).
    expect(FORGE_CSP).toMatch(/^default-src /)
    for (const source of ['https:', 'http:', 'data:', 'blob:', "'unsafe-inline'", "'unsafe-eval'"]) expect(FORGE_CSP.split(' ')).toContain(source)
    expect(FORGE_CSP).not.toMatch(/file:|\*|'self'/)

    // Another page chosen: only that one is served now. A page gone from disk: an error, not a throw.
    const other = path.join(dir, 'forge-v2.html')
    await fs.writeFile(other, '<!doctype html>')
    picks.push(other)
    await h.open({ pick: true })
    expect((await get(pathToFileURL(file).href)).type).toBe('error')
    expect((await get(pathToFileURL(other).href)).type).toBe('default')
    sessionFetch.mockRejectedValueOnce(new Error('ERR_FILE_NOT_FOUND'))
    expect((await get(pathToFileURL(other).href)).type).toBe('error')
    // Closed: nothing is served.
    FakeWindow.made[0]!.close()
    expect((await get(pathToFileURL(other).href)).type).toBe('error')
    // One handler for the session, however often the window opens.
    await h.open()
    expect(protocolHandlers.size).toBe(1)
    expect(partitions).toEqual(['persist:forge'])
  })

  it('keeps the page on show when it answers Stay to switching pages, and switches on the next open', async () => {
    const h = host({ file })
    await h.open()
    const w = FakeWindow.made[0]!
    const wc = w.webContents
    const other = path.join(dir, 'forge-v2.html')
    await fs.writeFile(other, '<!doctype html>')
    // The page asks about unsaved changes, the answer is Stay: the load is aborted, the old page stays.
    w.loadError = Object.assign(new Error("ERR_ABORTED (-3) loading 'file:///forge-v2.html'"), { code: 'ERR_ABORTED' })
    picks.push(other)
    await expect(h.open({ pick: true })).resolves.toEqual({ file: other, open: true })
    expect(w.loaded).toEqual([file, other])
    expect(wc.getURL()).toBe(pathToFileURL(file).href)
    // The old page keeps its reloads and hash changes; the file handler still serves it.
    const hash = navEvent(`${pathToFileURL(file).href}#drill`)
    wc.emit('will-navigate', hash)
    expect(hash.prevented).toBe(false)
    const res = await protocolHandlers.get('file')!(new Request(pathToFileURL(file).href))
    expect(res.type).toBe('default')
    // The next open tries the switch again instead of only focusing.
    w.loadError = null
    await h.open()
    expect(w.loaded).toEqual([file, other, other])
    expect(wc.getURL()).toBe(pathToFileURL(other).href)
    const back = navEvent(pathToFileURL(file).href)
    wc.emit('will-navigate', back)
    expect(back.prevented).toBe(true)
  })

  it('stays on the new page when it moved on by itself while loading', async () => {
    const h = host({ file })
    await h.open()
    const w = FakeWindow.made[0]!
    const other = path.join(dir, 'forge-v2.html')
    await fs.writeFile(other, '<!doctype html>')
    // The new page changed its own query while loading: aborted, but it is the page on show.
    w.loadError = Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED' })
    w.webContents.url = `${pathToFileURL(other).href}?drill=hands`
    picks.push(other)
    await h.open({ pick: true })
    const same = navEvent(`${pathToFileURL(other).href}#top`)
    w.webContents.emit('will-navigate', same)
    expect(same.prevented).toBe(false)
    w.loadError = null
    await h.open()
    expect(w.loaded).toEqual([file, other])
  })

  it('relays the Forge window requests to the brain and only takes the brain answers', async () => {
    const h = host({ file })
    await h.open()
    const forge = FakeWindow.made[0]!.webContents
    const projects = h.projects(forge as never)
    expect(brain.webContents.sent).toEqual([[IPC.forgeRequest, { id: 1, kind: 'projects' }]])
    // Only the brain window answers.
    h.reply(forge as never, 1, true, [])
    expect(h.relay.pending).toBe(1)
    const row = { id: 'Projects/PORTALz', title: 'PORTALz', status: 'active', home: 'Projects/PORTALz', critique: 'Projects/PORTALz/Critique' }
    h.reply(brain.webContents as never, 1, true, [row, 'junk'])
    await expect(projects).resolves.toEqual([row])

    const save = h.save(forge as never, { ...dto(), grade: { letter: 'B+' } })
    const [, req] = brain.webContents.sent[1] as [string, { id: number; kind: string; save: ForgeSaveDto }]
    expect(req).toMatchObject({ id: 2, kind: 'save', save: { projectId: 'Projects/PORTALz', title: 'Gesture', grade: { letter: 'B+' }, practiceTomorrow: true } })
    const result = { noteId: 'n', notePath: 'n.md', imagePath: 'Projects/PORTALz/Critique/n.png', project: 'PORTALz' }
    h.reply(brain.webContents as never, 2, true, result)
    await expect(save).resolves.toEqual(result)

    // The store's own message comes through.
    const failing = h.save(forge as never, dto())
    h.reply(brain.webContents as never, 3, false, 'This vault is read-only')
    await expect(failing).rejects.toThrow('This vault is read-only')

    // A bad save never reaches the brain.
    await expect(h.save(forge as never, dto({ png: new Uint8Array([1, 2, 3]) }))).rejects.toThrow('not a PNG')
    expect(brain.webContents.sent).toHaveLength(3)
  })

  it('serves the Forge window only', async () => {
    const h = host({ file })
    await expect(h.projects(brain.webContents as never)).rejects.toThrow('Only the Concept Forge window')
    await h.open()
    await expect(h.projects(brain.webContents as never)).rejects.toThrow('Only the Concept Forge window')
    await expect(h.save(new FakeContents() as never, dto())).rejects.toThrow('Only the Concept Forge window')
    expect(brain.webContents.sent).toEqual([])
  })

  it('answers at once without a brain window, and fails waiting requests when the brain goes', async () => {
    const h = host({ file })
    await h.open()
    const forge = FakeWindow.made[0]!.webContents
    const waiting = h.projects(forge as never)
    brain.webContents.emit('render-process-gone')
    await expect(waiting).rejects.toThrow(NO_BRAIN)
    brain.closed = true
    await expect(h.projects(forge as never)).rejects.toThrow(NO_BRAIN)
  })

  it('closes with the brain window', async () => {
    const h = host({ file })
    await h.open()
    expect(h.status().open).toBe(true)
    brain.close()
    expect(FakeWindow.made[0]?.closed).toBe(true)
    expect(h.status()).toEqual({ file, open: false })
  })

  describe('the star screen', () => {
    const frames = () => brain.webContents.sent.filter((m) => m[0] === IPC.forgeFrame).map((m) => m[1] as ForgeFrameDto)
    const previews = () => FakeWindow.made.filter((w) => (w.options['webPreferences'] as { offscreen?: boolean }).offscreen === true)

    beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }))
    afterEach(() => void vi.useRealTimers())

    it('paints a hidden, muted copy of the page while the screen is in view, and lets it rest after', async () => {
      const h = host({ file })
      h.screen(brain.webContents as never, true)
      const [p] = previews()
      expect(previews()).toHaveLength(1)
      expect(p?.options).toMatchObject({
        show: false,
        useContentSize: true,
        width: 1366,
        height: 728,
        webPreferences: { preload: '/app/dist/preload/forge-preload.cjs', partition: FORGE_PARTITION, sandbox: true, contextIsolation: true, offscreen: true },
      })
      expect(p?.visible).toBe(false)
      expect(p?.loaded).toEqual([file])
      expect(p?.webContents.muted).toBe(true)
      expect(p?.webContents.frameRate).toBe(PREVIEW_FPS)
      expect(h.status()).toEqual({ file, open: false })

      // Paints are sent at most every FRAME_MS, the newest one, scaled down to FRAME_MAX wide, as raw BGRA.
      p?.webContents.emit('paint', {}, {}, fakeImage(800, 500, 1))
      p?.webContents.emit('paint', {}, {}, fakeImage(1600, 1000, 2))
      expect(frames()).toHaveLength(0)
      vi.advanceTimersByTime(FRAME_MS)
      expect(frames()).toHaveLength(1)
      const f = frames()[0]!
      expect(f).toMatchObject({ width: FRAME_MAX, height: 640, bgra: true })
      expect(f.data.length).toBe(FRAME_MAX * 640 * 4)
      expect(f.data[0]).toBe(2)
      // Nothing new painted: nothing sent.
      vi.advanceTimersByTime(FRAME_MS * 4)
      expect(frames()).toHaveLength(1)
      expect(h.screenLive).toBe(true)

      // Folded away: no more frames, the copy stops painting and closes when nobody comes back.
      h.screen(brain.webContents as never, false)
      expect(h.screenLive).toBe(false)
      expect(p?.webContents.painting).toBe(false)
      p?.webContents.emit('paint', {}, {}, fakeImage(800, 500))
      vi.advanceTimersByTime(FRAME_MS * 4)
      expect(frames()).toHaveLength(1)
      expect(h.previewOpen).toBe(true)
      vi.advanceTimersByTime(PREVIEW_IDLE_MS)
      expect(p?.destroyed).toBe(true)
      expect(h.previewOpen).toBe(false)
    })

    it('wakes the resting copy when the screen comes back, without loading the page again', () => {
      const h = host({ file })
      h.screen(brain.webContents as never, true)
      h.screen(brain.webContents as never, false)
      vi.advanceTimersByTime(PREVIEW_IDLE_MS / 2)
      h.screen(brain.webContents as never, true)
      const [p] = previews()
      expect(previews()).toHaveLength(1)
      expect(p?.loaded).toEqual([file])
      expect(p?.webContents.painting).toBe(true)
      expect(p?.webContents.invalidated).toBe(2)
      vi.advanceTimersByTime(PREVIEW_IDLE_MS)
      expect(p?.destroyed).toBe(false)
    })

    it('mirrors the Forge window while it is open, and goes back to the copy when it closes', async () => {
      const h = host({ file })
      h.screen(brain.webContents as never, true)
      const first = previews()[0]
      await h.open()
      // The Forge window replaces the copy.
      expect(first?.destroyed).toBe(true)
      const w = FakeWindow.made.find((x) => !(x.options['webPreferences'] as { offscreen?: boolean }).offscreen)!
      w.webContents.capture = fakeImage(1600, 1000, 5)
      // Not shown yet: nothing is captured (a hidden page's capture may never come back).
      vi.advanceTimersByTime(FRAME_MS)
      expect(w.webContents.captures).toHaveLength(0)
      w.emit('ready-to-show')
      vi.advanceTimersByTime(FRAME_MS)
      await vi.waitFor(() => expect(frames()).toHaveLength(1))
      expect(frames()[0]).toMatchObject({ width: FRAME_MAX, height: 640, bgra: true })
      expect(frames()[0]?.data[0]).toBe(5)
      // Captured without telling a hidden page it is shown.
      expect(w.webContents.captures[0]).toEqual({ stayHidden: true })
      // An empty capture (a window not painted yet) sends nothing.
      w.webContents.capture = fakeImage(0, 0)
      vi.advanceTimersByTime(FRAME_MS)
      await Promise.resolve()
      await Promise.resolve()
      expect(frames()).toHaveLength(1)

      w.close()
      const [, again] = previews()
      expect(previews()).toHaveLength(2)
      expect(again?.loaded).toEqual([file])
      expect(h.screenLive).toBe(true)
    })

    it('gives up on a capture that never comes back, and captures again', async () => {
      const h = host({ file })
      await h.open()
      h.screen(brain.webContents as never, true)
      const w = FakeWindow.made[0]!
      w.show()
      let hang = true
      const real = w.webContents.capturePage.bind(w.webContents)
      w.webContents.capturePage = (rect?: unknown, opts?: unknown) => (hang ? (w.webContents.captures.push(opts), new Promise<FakeImage>(() => {})) : real(rect, opts))
      vi.advanceTimersByTime(FRAME_MS * 4)
      expect(w.webContents.captures).toHaveLength(1)
      hang = false
      vi.advanceTimersByTime(CAPTURE_TIMEOUT_MS)
      await vi.waitFor(() => expect(frames().length).toBeGreaterThan(0))
      expect(w.webContents.captures.length).toBeGreaterThan(1)
    })

    it('captures the Forge window once a second while it has the focus (the pen never waits on the main process)', async () => {
      const h = host({ file })
      await h.open()
      h.screen(brain.webContents as never, true)
      const w = FakeWindow.made[0]!
      w.show()
      w.focusedNow = true
      for (let t = 0; t < 8; t++) {
        vi.advanceTimersByTime(FRAME_MS)
        await Promise.resolve()
      }
      expect(w.webContents.captures).toHaveLength(2)
      w.focusedNow = false
      for (let t = 0; t < 4; t++) {
        vi.advanceTimersByTime(FRAME_MS)
        await Promise.resolve()
      }
      expect(w.webContents.captures).toHaveLength(6)
    })

    it('makes no copy before a page is chosen, and turns on only for the brain window', () => {
      const h = host()
      h.screen(brain.webContents as never, true)
      expect(previews()).toHaveLength(0)
      expect(h.screenLive).toBe(false)
      const stranger = new FakeWindow()
      expect(() => h.screen(stranger.webContents as never, true)).toThrow('Only the brain window can do that')
    })

    it('serves the copy its page and nothing else, and keeps it on it', async () => {
      const h = host({ file })
      h.screen(brain.webContents as never, true)
      const [p] = previews()
      const handler = protocolHandlers.get('file')!
      const ok = await handler(new Request(pathToFileURL(file).href))
      expect(ok.headers.get('Content-Security-Policy')).toBe(FORGE_CSP)
      const other = await handler(new Request(pathToFileURL(path.join(dir, 'secret.md')).href))
      expect(other.type).toBe('error')
      // It goes nowhere: no pop-ups, no other page, not even a web link (nobody asked for one).
      expect(p?.webContents.openHandler?.({ url: 'https://example.com' })).toEqual({ action: 'deny' })
      const away = navEvent('https://example.com')
      p?.webContents.emit('will-navigate', away)
      expect(away.prevented).toBe(true)
      expect(electron.shell.openExternal).not.toHaveBeenCalled()
      const reload = navEvent(`${pathToFileURL(file).href}#x`)
      p?.webContents.emit('will-navigate', reload)
      expect(reload.prevented).toBe(false)
      // A "leave?" question is answered Leave, with no dialog.
      const unload = navEvent()
      p?.webContents.emit('will-prevent-unload', unload)
      expect(unload.prevented).toBe(true)
      expect(electron.dialog.showMessageBoxSync).not.toHaveBeenCalled()
    })

    it('stops when the brain window closes, and when its page crashes', () => {
      const h = host({ file })
      h.screen(brain.webContents as never, true)
      const [p] = previews()
      brain.webContents.emit('render-process-gone')
      expect(p?.destroyed).toBe(true)
      expect(h.screenLive).toBe(false)
      h.screen(brain.webContents as never, true)
      const [, q] = previews()
      brain.close()
      expect(q?.destroyed).toBe(true)
      expect(h.screenLive).toBe(false)
    })
  })
})

/* ------------------------------------------------------------------ */
/* Brain side: the store serves the relayed requests                  */
/* ------------------------------------------------------------------ */

describe('brain side (renderer)', () => {
  afterEach(() => void vi.unstubAllGlobals())

  it('answers the project list only once the vault is in, as it does a save', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, String(v)),
      removeItem: (k: string) => void stored.delete(k),
      clear: () => stored.clear(),
    })
    const { useAether } = await import('@aether/ui')
    // The brain window with its bridge: the module hands its request handler to it on import.
    let serve: ((req: ForgeRequest) => Promise<unknown>) | null = null
    let frameTo: ((f: ForgeFrameDto) => void) | null = null
    const screens: boolean[] = []
    const aether = {
      onForgeRequest: (fn: typeof serve) => void (serve = fn),
      forgeOpen: vi.fn(async () => ({ file: '/art/forge/concept-forge.html', open: true })),
      forgeStatus: vi.fn(async () => ({ file: null, open: false })),
      forgeScreen: vi.fn(async (on: boolean) => void screens.push(on)),
      onForgeFrame: (fn: typeof frameTo) => {
        frameTo = fn
        return () => undefined
      },
      platform: 'linux',
    }
    vi.stubGlobal('window', { addEventListener: vi.fn(), aether })
    await import('../src/renderer/forge.js')
    expect(serve).not.toBeNull()
    const projects = () => serve!({ id: 1, kind: 'projects' })
    await expect(projects()).rejects.toThrow('Open your vault in Aether Brain first')

    // A long load (whole drives): the page must not hear "no projects yet, make one".
    let release = () => {}
    const listed = new Promise<void>((r) => (release = r))
    class SlowVault extends MemoryVaultAdapter {
      override async list(): Promise<VaultFile[]> {
        await listed
        return super.list()
      }
    }
    const opening = useAether.getState().openVault(new SlowVault([{ path: 'Projects/PORTALz.md', content: '---\nstatus: active\n---\n# PORTALz\n', mtime: 1 }]))
    expect(useAether.getState().status).toBe('loading')
    await expect(projects()).rejects.toThrow('The vault is still loading; try again in a moment')
    release()
    await opening
    expect(useAether.getState().status).toBe('ready')
    await expect(projects()).resolves.toMatchObject([{ id: 'Projects/PORTALz', title: 'PORTALz', critique: 'Projects/PORTALz/Critique' }])
    // A vault that failed to open.
    useAether.setState({ status: 'error' })
    await expect(projects()).rejects.toThrow('Open your vault in Aether Brain first')

    // The Concept Forge star: the project of that name, with its folder, carries the live screen.
    const c = useAether.getState().controller
    expect(c.screen).toBeNull()
    await useAether.getState().openVault(
      new MemoryVaultAdapter([
        { path: 'Projects/PORTALz.md', content: '---\nstatus: active\n---\n# PORTALz\n', mtime: 1 },
        { path: 'Projects/PORTALz/Art/Gate.md', content: '# Gate\n', mtime: 1 },
        { path: 'Projects/ConceptForge.md', content: '---\nstatus: active\naliases: [Concept Forge]\n---\n# ConceptForge\n', mtime: 1 },
        { path: 'Projects/ConceptForge/Critique/Value study.md', content: '# Value study\n', mtime: 1 },
      ]),
    )
    expect(c.screen?.star).toBe('folder:Projects/ConceptForge')
    expect(c.screen?.placeholder).toMatch(/Press g/)
    // In view: main is asked for frames, and they reach the screen.
    c.screenShown(true)
    expect(screens).toEqual([true])
    frameTo!({ data: new Uint8Array(8), width: 2, height: 1, bgra: true })
    expect(c.screenFrame).toMatchObject({ width: 2, height: 1, bgra: true })
    // Enter / a click opens the Forge window; the page it remembers now changes the screen's words.
    c.activateScreen()
    expect(aether.forgeOpen).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(c.screen?.placeholder).toMatch(/waking up/))
    // Closing the vault takes the screen away (and tells main).
    useAether.setState({ status: 'idle' })
    expect(c.screen).toBeNull()
    expect(screens).toEqual([true, false])
  })
})

/* ------------------------------------------------------------------ */
/* Preload                                                            */
/* ------------------------------------------------------------------ */

/** The forge preload run the way Electron runs it (CommonJS in a sandbox), with stand-ins for electron and window. */
async function loadPreload(): Promise<{
  exposed: Record<string, unknown>
  invoke: ReturnType<typeof vi.fn>
  domReady: () => void
  injected: string[]
}> {
  const src = await fs.readFile(path.join(here, '..', 'src', 'preload', 'forge-preload.cts'), 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exposed: Record<string, unknown> = {}
  const injected: string[] = []
  const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
  const listeners = new Map<string, () => void>()
  const electron = {
    contextBridge: { exposeInMainWorld: (key: string, api: unknown) => void (exposed[key] = api) },
    ipcRenderer: { invoke },
    webFrame: {
      executeJavaScript: async (code: string) => {
        injected.push(code)
      },
    },
  }
  const require = (id: string): unknown => {
    if (id === 'electron') return electron
    throw new Error(`the sandboxed preload cannot require ${id}`)
  }
  const window = { addEventListener: (type: string, fn: () => void) => listeners.set(type, fn) }
  const module = { exports: {} }
  const proc = { argv: ['electron', '--type=renderer', '--aether-forge-version=0.4.0'], env: {} }
  new Function('require', 'module', 'exports', 'process', 'window', js)(require, module, module.exports, proc, window)
  return { exposed, invoke, injected, domReady: () => listeners.get('DOMContentLoaded')?.() }
}

describe('forge preload', () => {
  it('exposes aetherForge with clean error messages and injects the page UI once the DOM is there', async () => {
    const p = await loadPreload()
    const api = p.exposed['aetherForge'] as AetherForgeBridge
    expect(Object.keys(p.exposed)).toEqual(['aetherForge'])
    expect(api.version).toBe('0.4.0')
    p.invoke.mockResolvedValueOnce([{ id: 'P' }])
    await expect(api.projects()).resolves.toEqual([{ id: 'P' }])
    const save = cleanSave(dto())
    p.invoke.mockRejectedValueOnce(new Error("Error invoking remote method 'forge:win:save': Error: Open your vault in Aether Brain first"))
    await expect(api.save(save)).rejects.toThrow(/^Open your vault in Aether Brain first$/)
    expect(p.invoke.mock.calls).toEqual([[IPC.forgeProjects], [IPC.forgeSave, save]])
    expect(p.injected).toEqual([])
    p.domReady()
    expect(p.injected).toHaveLength(1)
    expect(p.injected[0]).toMatch(/^\(function forgeLinkMain\(\) \{/)
    expect(p.injected[0]).toMatch(/\}\)\(\)$/)
  })

  it('keeps the injected function self-contained (it runs from its source text)', async () => {
    const p = await loadPreload()
    p.domReady()
    const code = p.injected[0] ?? ''
    // Nothing from the module scope (the compiled electron import, helpers, `exports`).
    for (const name of ['electron_1', 'require(', 'exports.', '__awaiter', 'ipcRenderer', 'contextBridge', 'webFrame']) expect(code).not.toContain(name)
    // Without a bridge it does nothing, and it never throws.
    expect(() => new Function('window', 'document', code)({}, {})).not.toThrow()
  })
})

/* ------------------------------------------------------------------ */
/* The injected UI against the mock Concept Forge page (Chromium)     */
/* ------------------------------------------------------------------ */

/** Chromium from Playwright's browser folder (PLAYWRIGHT_BROWSERS_PATH, else /opt/pw-browsers), if there is one. */
function findChromium(): string | undefined {
  const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false
  const bases = [process.env['PLAYWRIGHT_BROWSERS_PATH'], '/opt/pw-browsers'].filter((b): b is string => !!b && b !== '0')
  for (const base of bases) {
    // Some installs link the binary itself as <base>/chromium.
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

let browser: Browser | null = null
let linkSource = ''

const PROJECTS = [
  { id: 'Projects/PORTALz', title: 'PORTALz', status: 'active', home: 'Projects/PORTALz', critique: 'Projects/PORTALz/Critique' },
  { id: 'Projects/ConceptForge', title: 'ConceptForge', status: 'active', home: 'Projects/ConceptForge', critique: 'Projects/ConceptForge/critique' },
]

/**
 * In the page before its scripts: a stand-in for `window.aetherForge` (records saves; `__failSave` makes it
 * reject) and a hook that keeps the closed shadow root reachable for the test only.
 */
function pageSetup(projects: typeof PROJECTS): void {
  const w = window as unknown as Record<string, unknown>
  const attach = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = attach.call(this, init)
    w['__root'] = root
    return root
  }
  w['__saves'] = []
  w['aetherForge'] = {
    version: 'test',
    projects: async () => projects,
    save: async (dto: { projectId: string; title: string }) => {
      if (w['__failSave']) throw new Error(String(w['__failSave']))
      ;(w['__saves'] as unknown[]).push(dto)
      const project = projects.find((p) => p.id === dto.projectId)
      return {
        noteId: `${project?.critique}/2026-09-30 ${dto.title}`,
        notePath: `${project?.critique}/2026-09-30 ${dto.title}.md`,
        imagePath: `${project?.critique}/2026-09-30 ${dto.title}.png`,
        project: project?.title ?? '?',
      }
    },
  }
}

async function openMock(projects = PROJECTS): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1200, height: 800 } })
  await page.addInitScript(pageSetup, projects)
  await page.goto(pathToFileURL(MOCK).href)
  await page.addScriptTag({ content: linkSource })
  return page
}

/** Keys the page's own keydown listener saw, without bare modifiers. */
const pageKeys = (page: Page) =>
  page.evaluate(() => (window as unknown as { pageKeys: string[] }).pageKeys.filter((k) => !['Control', 'Shift', 'Alt', 'Meta'].includes(k)))

/** Something inside the link's shadow root. */
const inRoot = (page: Page, selector: string) => page.evaluateHandle((s) => ((window as unknown as { __root: ShadowRoot }).__root.querySelector(s) as HTMLElement), selector)

async function click(page: Page, selector: string): Promise<void> {
  const el = (await inRoot(page, selector)).asElement()
  if (!el) throw new Error(`no ${selector}`)
  await el.click()
}

/** The dialog once its drawing and project list are in (Save enabled), as the user sees it. */
async function dialogReady(page: Page): Promise<{ grade: string; sub: string; size: string; title: string; project: string; practice: boolean; practiceDisabled: boolean; where: string }> {
  await page.waitForFunction(() => {
    const r = (window as unknown as { __root: ShadowRoot }).__root
    return !r.querySelector('.scrim')?.hasAttribute('hidden') && !(r.querySelector('button[type=submit]') as HTMLButtonElement).disabled
  })
  return page.evaluate(() => {
    const r = (window as unknown as { __root: ShadowRoot }).__root
    const text = (s: string) => r.querySelector(s)?.textContent ?? ''
    const box = r.querySelector('input[type=checkbox]') as HTMLInputElement
    return {
      grade: text('.grade'),
      sub: text('.grade + .sub'),
      size: text('.sub + .sub'),
      title: (r.querySelector('input[type=text]') as HTMLInputElement).value,
      project: (r.querySelector('select') as HTMLSelectElement).value,
      practice: box.checked,
      practiceDisabled: box.disabled,
      where: text('.where'),
    }
  })
}

async function lastSave(page: Page): Promise<Record<string, unknown>> {
  await page.waitForFunction(() => ((window as unknown as { __saves: unknown[] }).__saves.length ?? 0) > 0)
  return page.evaluate(() => {
    const saves = (window as unknown as { __saves: { png: Uint8Array }[] }).__saves
    const d = saves[saves.length - 1]!
    return { ...d, png: Array.from(d.png.slice(0, 8)), pngLength: d.png.length, pngIsBytes: d.png instanceof Uint8Array }
  })
}

describe('the injected Save to Brain UI (Chromium, mock Concept Forge page)', () => {
  beforeAll(async () => {
    const p = await loadPreload()
    p.domReady()
    linkSource = p.injected[0] ?? ''
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

  it('adds one button in a closed shadow root and changes nothing else on the page', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await openMock()
    try {
      await page.addScriptTag({ content: linkSource })
      expect(await page.evaluate(() => document.querySelectorAll('aether-forge-link').length)).toBe(1)
      expect(await page.evaluate(() => document.querySelector('aether-forge-link')?.shadowRoot ?? null)).toBeNull()
      expect(await page.evaluate(() => Object.keys(window).filter((k) => /aether/i.test(k)).sort())).toEqual(['aetherForge'])
      expect(await page.evaluate(() => (window as unknown as { __aetherForgeLink: boolean }).__aetherForgeLink)).toBe(true)
      expect(await (await inRoot(page, '.fab')).evaluate((b) => b.textContent)).toBe('🪐 Save to Brain')
      // The page's keys still reach the page.
      await page.keyboard.press('b')
      expect(await pageKeys(page)).toEqual(['b'])
    } finally {
      await page.close()
    }
  })

  it('saves the composited drawing, the raw grade, the drill title and the remembered project', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await openMock()
    try {
      await page.evaluate(() => localStorage.setItem('aetherForge.project', 'Projects/ConceptForge'))
      await click(page, '.fab')
      const shown = await dialogReady(page)
      expect(shown).toEqual({
        grade: 'B+ · 82/100',
        sub: 'Drill: Gesture',
        size: '800 × 500 px',
        title: 'Gesture',
        project: 'Projects/ConceptForge',
        practice: true,
        practiceDisabled: false,
        where: 'Into Projects/ConceptForge/critique',
      })
      // Typing in the dialog doesn't reach the page's shortcuts.
      await page.keyboard.press('End')
      await page.keyboard.type(' Warm-Up')
      expect(await pageKeys(page)).toEqual([])
      await click(page, 'button[type=submit]')
      const save = await lastSave(page)
      expect(save['projectId']).toBe('Projects/ConceptForge')
      expect(save['title']).toBe('Gesture Warm-Up')
      expect(save['practiceTomorrow']).toBe(true)
      expect(save['png']).toEqual(PNG_HEAD)
      expect(save['pngIsBytes']).toBe(true)
      expect(await page.evaluate('JSON.stringify(__saves[0].grade) === JSON.stringify(lastGrade)')).toBe(true)
      expect(save['grade']).toMatchObject({ letter: 'B+', overall: 82, drill: 'Gesture', opportunities: ['Push the curve of the spine further', 'Simplify the hands into mitts'] })

      // What was saved is what the page shows: paper + ink over the stage color, without the grid overlay.
      const px = await page.evaluate(async () => {
        const d = (window as unknown as { __saves: { png: Uint8Array }[] }).__saves[0]!
        const bmp = await createImageBitmap(new Blob([d.png as BlobPart], { type: 'image/png' }))
        const c = new OffscreenCanvas(bmp.width, bmp.height)
        const g = c.getContext('2d')!
        g.drawImage(bmp, 0, 0)
        const at = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data)
        return { size: [bmp.width, bmp.height], ink: at(300, 400), diagonal: at(220, 180), paper: at(675, 425), gridOnPaper: at(700, 425), stage: at(725, 75), gridLine: at(450, 225), gridCross: at(450, 250) }
      })
      expect(px.size).toEqual([800, 500])
      expect(px.ink).toEqual([20, 20, 20, 255])
      expect(px.diagonal).toEqual([20, 20, 20, 255])
      expect(px.paper).toEqual([200, 220, 255, 255])
      expect(px.gridOnPaper).toEqual([200, 220, 255, 255])
      expect(px.stage).toEqual([243, 239, 230, 255])
      expect(px.gridLine).toEqual([243, 239, 230, 255])
      expect(px.gridCross).toEqual([243, 239, 230, 255])

      // Done: the dialog closes, the choice is remembered, the toast says where it went.
      await page.waitForFunction(() => (window as unknown as { __root: ShadowRoot }).__root.querySelector('.scrim')?.hasAttribute('hidden'))
      expect(await page.evaluate(() => localStorage.getItem('aetherForge.project'))).toBe('Projects/ConceptForge')
      expect(await (await inRoot(page, '.toast')).evaluate((t) => t.textContent)).toBe('Saved to ConceptForge ▸ critique')
      // The page has its keys back.
      await page.keyboard.press('n')
      expect(await pageKeys(page)).toEqual(['n'])
    } finally {
      await page.close()
    }
  })

  it('opens with Ctrl+Shift+B, works from the keyboard, closes with Esc', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await openMock()
    try {
      await page.keyboard.press('Control+Shift+B')
      const shown = await dialogReady(page)
      // No remembered project: the first one.
      expect(shown.project).toBe('Projects/PORTALz')
      expect(await pageKeys(page)).toEqual([])
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => (window as unknown as { __root: ShadowRoot }).__root.querySelector('.scrim')?.hasAttribute('hidden'))
      expect(await page.evaluate(() => (window as unknown as { __saves: unknown[] }).__saves)).toEqual([])

      // Tab walks the dialog (and stays in it); Enter on Save saves.
      await page.keyboard.press('Control+Shift+B')
      await dialogReady(page)
      const focusOrder: string[] = []
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Tab')
        focusOrder.push(await page.evaluate(() => {
          const a = (window as unknown as { __root: ShadowRoot }).__root.activeElement as HTMLElement | null
          return a ? `${a.tagName.toLowerCase()}${a.getAttribute('type') ? `:${a.getAttribute('type')}` : ''}` : 'none'
        }))
      }
      // From the title: the checkbox, Cancel, Save, then around to the project picker and the title.
      expect(focusOrder).toEqual(['input:checkbox', 'button:button', 'button:submit', 'select', 'input:text', 'input:checkbox'])
      await page.keyboard.press('Space')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Enter')
      const save = await lastSave(page)
      expect(save['projectId']).toBe('Projects/PORTALz')
      expect(save['practiceTomorrow']).toBe(false)
      expect(await pageKeys(page)).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('closes with Esc after a click on the dialog background, and leaves element fullscreen first', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await openMock()
    try {
      await click(page, '.fab')
      await dialogReady(page)
      await click(page, 'h2')
      await page.keyboard.press('x')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => (window as unknown as { __root: ShadowRoot }).__root.querySelector('.scrim')?.hasAttribute('hidden'))
      expect(await pageKeys(page)).toEqual([])

      // The stage in fullscreen (top layer): the link leaves fullscreen, then opens its dialog.
      await page.evaluate(() => {
        const stage = document.querySelector('.stage')
        let full: Element | null = stage
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full })
        document.exitFullscreen = async () => void (full = null)
      })
      await page.keyboard.press('Control+Shift+B')
      await dialogReady(page)
      expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
    } finally {
      await page.close()
    }
  })

  it('shows the brain error, keeps the dialog for another try', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await openMock()
    try {
      await page.evaluate(() => void ((window as unknown as { __failSave: string }).__failSave = 'Open your vault in Aether Brain first'))
      await click(page, '.fab')
      await dialogReady(page)
      await click(page, 'button[type=submit]')
      await page.waitForFunction(() => !!(window as unknown as { __root: ShadowRoot }).__root.querySelector('.toast.error'))
      expect(await (await inRoot(page, '.toast.error')).evaluate((t) => t.textContent)).toBe('Open your vault in Aether Brain first')
      // Still open, Save usable again.
      const again = await dialogReady(page)
      expect(again.title).toBe('Gesture')
      await page.evaluate(() => void ((window as unknown as { __failSave: string }).__failSave = ''))
      await click(page, 'button[type=submit]')
      expect((await lastSave(page))['projectId']).toBe('Projects/PORTALz')
    } finally {
      await page.close()
    }
  })

  it('titles from the active drill, reads grade history from localStorage, and saves without a grade', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await openMock()
    try {
      // A grade without a drill: the nav's active button names it.
      await page.evaluate(`lastGrade = { grade: 'a', score: 0.91 }`)
      await page.evaluate(() => {
        const [warm, gesture, value] = Array.from(document.querySelectorAll('nav button'))
        gesture?.classList.remove('active')
        gesture?.removeAttribute('aria-pressed')
        value?.setAttribute('aria-pressed', 'true')
        void warm
      })
      await click(page, '.fab')
      let shown = await dialogReady(page)
      expect(shown.grade).toBe('A · 91/100')
      expect(shown.title).toBe('Value Study')
      await page.keyboard.press('Escape')

      // No global grade: the last entry of a grade history in localStorage.
      await page.evaluate(`lastGrade = undefined`)
      await page.evaluate(() =>
        localStorage.setItem('cf.gradeHistory', JSON.stringify([{ letter: 'C', score: 70 }, { letter: 'A-', score: 88, mode: 'Hands' }])),
      )
      await click(page, '.fab')
      shown = await dialogReady(page)
      expect(shown.grade).toBe('A- · 88/100')
      expect(shown.title).toBe('Hands')
      await page.keyboard.press('Escape')

      // Nothing graded: still saves the drawing, without a practice task.
      await page.evaluate(() => localStorage.removeItem('cf.gradeHistory'))
      await click(page, '.fab')
      shown = await dialogReady(page)
      expect(shown).toMatchObject({ grade: 'Not graded', title: 'Value Study', practice: true, practiceDisabled: true })
      expect(shown.sub).toContain('No grade found')
      await click(page, 'button[type=submit]')
      const save = await lastSave(page)
      expect(save['grade']).toBeNull()
      expect(save['practiceTomorrow']).toBe(false)
      expect(save['png']).toEqual(PNG_HEAD)
    } finally {
      await page.close()
    }
  })

  it('sends the grade as plain JSON: no functions, DOM or cycles, 6 levels deep', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await openMock()
    try {
      await page.evaluate(`
        lastGrade = { letter: 'B', fn() {}, el: document.body, when: new Date(Date.UTC(2026, 8, 30)), nan: NaN,
          l1: { l2: { l3: { l4: { l5: { l6: { l7: 1 } }, keep: 5 } } } }, list: [1, () => 2, document.body, 'x'],
          map: new Map([[1, 2]]), bytes: new Uint8Array(4), ['__proto__']: { polluted: true } }
        lastGrade.self = lastGrade
      `)
      await click(page, '.fab')
      await dialogReady(page)
      await click(page, 'button[type=submit]')
      await lastSave(page)
      const seen = await page.evaluate(() => {
        const g = (window as unknown as { __saves: { grade: Record<string, unknown> }[] }).__saves[0]!.grade
        return { json: JSON.stringify(g), plainProto: Object.getPrototypeOf(g) === Object.prototype, ownProto: Object.prototype.hasOwnProperty.call(g, '__proto__') }
      })
      // A key named __proto__ stays a key, it never becomes the clone's prototype.
      expect(seen.plainProto).toBe(true)
      expect(seen.ownProto).toBe(true)
      const grade = JSON.parse(seen.json) as Record<string, unknown>
      expect(grade).toEqual({
        letter: 'B',
        when: '2026-09-30T00:00:00.000Z',
        nan: null,
        l1: { l2: { l3: { l4: { l5: {}, keep: 5 } } } },
        list: [1, null, null, 'x'],
        ['__proto__']: { polluted: true },
      })
      // And main takes it.
      expect(() => cleanSave({ ...dto(), grade })).not.toThrow()
    } finally {
      await page.close()
    }
  })

  it('cuts a huge grade down to 256 KB, keeping what fits', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await openMock()
    try {
      await page.evaluate(`lastGrade = { letter: 'C', overall: 64, notes: 'é'.repeat(400000), fixes: ['Bigger shapes first'] }`)
      await click(page, '.fab')
      expect((await dialogReady(page)).grade).toBe('C · 64/100')
      await click(page, 'button[type=submit]')
      await lastSave(page)
      const json = await page.evaluate(() => JSON.stringify((window as unknown as { __saves: { grade: unknown }[] }).__saves[0]!.grade))
      expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_GRADE_BYTES)
      const grade = JSON.parse(json) as { letter: string; overall: number; notes: string }
      expect(grade).toMatchObject({ letter: 'C', overall: 64 })
      // Most of the room goes to the text (2 bytes a character).
      expect(grade.notes.length).toBeGreaterThan(100_000)
      expect(() => cleanSave({ ...dto(), grade })).not.toThrow()
    } finally {
      await page.close()
    }
  })

  it('explains when there is no drawing or no project, and never throws into the page', async (ctx) => {
    if (!browser) return ctx.skip()
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    try {
      await page.addInitScript(pageSetup, [])
      await page.goto('about:blank')
      await page.setContent('<p>No canvas here</p><canvas id="gridOverlay" width="300" height="200"></canvas>')
      await page.addScriptTag({ content: linkSource })
      await click(page, '.fab')
      await page.waitForFunction(() => !(window as unknown as { __root: ShadowRoot }).__root.querySelector('.msg')?.hasAttribute('hidden'))
      await page.waitForFunction(() => ((window as unknown as { __root: ShadowRoot }).__root.querySelector('.msg')?.textContent ?? '').includes('No projects'))
      const msg = await (await inRoot(page, '.msg')).evaluate((m) => m.textContent)
      expect(msg).toContain('No drawing found')
      expect(msg).toContain('No projects in Aether Brain yet')
      expect(await (await inRoot(page, 'button[type=submit]')).evaluate((b) => (b as HTMLButtonElement).disabled)).toBe(true)
      expect(errors).toEqual([])
    } finally {
      await page.close()
    }
  })
})
