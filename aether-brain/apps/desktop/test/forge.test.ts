import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import type { Browser, Page } from 'playwright-core'
import { IPC, type AetherForgeBridge, type ForgeSaveDto } from '../src/shared/ipc.js'
import {
  FORGE_PARTITION,
  FORGE_TIMEOUT_MS,
  ForgeHost,
  ForgeRelay,
  MAX_FORGE_PNG,
  MAX_GRADE_BYTES,
  NO_BRAIN,
  cleanOpenOptions,
  cleanProjects,
  cleanSave,
  cleanSaved,
  forgeNavigation,
  forgePermission,
  forgeSettings,
  isPng,
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

  it('times out after 30 s and forgets the request', async () => {
    vi.useFakeTimers()
    const t = new FakeTarget()
    const relay = new ForgeRelay(() => t)
    expect(relay.timeoutMs).toBe(FORGE_TIMEOUT_MS)
    const p = relay.request({ kind: 'projects' })
    const settled = p.then(
      () => 'resolved',
      (err: Error) => err.message,
    )
    vi.advanceTimersByTime(FORGE_TIMEOUT_MS - 1)
    expect(relay.pending).toBe(1)
    vi.advanceTimersByTime(1)
    await expect(settled).resolves.toBe(NO_BRAIN)
    expect(relay.pending).toBe(0)
    expect(relay.reply(1, true, [])).toBe(false)
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

/* ------------------------------------------------------------------ */
/* Host, with fake Electron modules                                   */
/* ------------------------------------------------------------------ */

let nextContentsId = 1

class FakeContents extends EventEmitter {
  readonly id = nextContentsId++
  sent: unknown[][] = []
  destroyed = false
  openHandler: ((d: { url: string }) => { action: string }) | null = null
  send(...args: unknown[]): void {
    this.sent.push(args)
  }
  isDestroyed(): boolean {
    return this.destroyed
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
  async loadFile(file: string): Promise<void> {
    this.loaded.push(file)
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
