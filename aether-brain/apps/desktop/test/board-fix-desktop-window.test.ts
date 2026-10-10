import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import {
  BOARD_MIN_HEIGHT,
  BOARD_MIN_WIDTH,
  boardSettings,
  boardWindowOptions,
  clampBoardBounds,
  FLUSH_WAIT_MS,
} from '../src/main/board-window.js'
import { BOARD_WINDOW_NAME, BRAIN_WINDOW_NAME, crashMessage } from '../src/main/crash.js'
import { IPC } from '../src/shared/ipc.js'
import { BOARD, FakeWin, OTHER, PAGE, rig } from './board-fix-desktop-fakes.js'

/**
 * live-window-2 / m2 (the window follows or is told about its note), live-window-m5 (no address to the browser, a navigation away
 * brings the page back), desktop-m2 (over full-screen apps on macOS), desktop-m7 + shell-m6 (480 x 320), desktop-m8 + live-window-m4
 * (the crash message names the window).
 */

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})
const settle = async (ms = 0): Promise<void> => void (await vi.advanceTimersByTimeAsync(ms))

describe('the board window follows or is told about its note', () => {
  it('is told for good when its note is deleted or moved away, on a case-sensitive and on a case-blind platform', async () => {
    for (const [platform, path] of [['linux', BOARD], ['win32', BOARD.toLowerCase()]] as const) {
      const t = rig({ platform })
      await t.host.open(BOARD)
      t.host.forward([{ kind: 'unlink', path }])
      const gone = t.win.webContents.on_(IPC.boardGone)
      expect(gone, platform).toHaveLength(1)
      expect(gone[0]![0], platform).toMatch(/deleted or moved away/)
      // The change itself still reaches the window (it tries to read the note again).
      expect(t.win.webContents.on_(IPC.changes)).toHaveLength(1)
    }
  })

  it('is told when an edit made the note no board (or one it cannot read), and not for a board, a plain edit of another note, or a picture', async () => {
    const t = rig({ platform: 'linux' })
    await t.host.open(BOARD)
    const board = '---\ntitle: Gate\ntype: board\n---\n# Gate\n\n## Board\n'
    t.host.forward([{ kind: 'change', path: BOARD, content: board }])
    t.host.forward([{ kind: 'unlink', path: OTHER }, { kind: 'change', path: OTHER, content: '---\ntype: note\n---\n' }, { kind: 'add', path: 'Boards/Gate/a.png' }])
    expect(t.win.webContents.on_(IPC.boardGone)).toEqual([])
    t.host.forward([{ kind: 'change', path: BOARD, content: '---\ntitle: Gate\ntype: note\n---\n# Gate\n' }])
    t.host.forward([{ kind: 'change', path: BOARD, content: '---\ntype: board\nmeta:\n  a: 1\n---\n' }])
    const gone = t.win.webContents.on_(IPC.boardGone).map((a) => a[0])
    expect(gone).toHaveLength(2)
    expect(gone[0]).toMatch(/no longer reads as a board/)
    // A change without content (the watcher's report of a picture ...) says nothing about the note.
    t.host.forward([{ kind: 'change', path: BOARD }])
    expect(t.win.webContents.on_(IPC.boardGone)).toHaveLength(2)
  })

  it('has its page save under the note\'s old name first, then loads the page again on the new name, and does not hand the board back', async () => {
    const t = rig({ platform: 'linux', answer: 60 })
    await t.host.open(BOARD)
    const w = t.win
    w.webContents.loading = false
    // Another note being renamed asks nothing.
    await t.host.beforeMove(OTHER)
    expect(w.webContents.on_(IPC.boardFlush)).toEqual([])
    const before = vi.fn()
    void t.host.beforeMove(BOARD).then(before)
    await settle(59)
    expect(w.webContents.on_(IPC.boardFlush)).toHaveLength(1)
    expect(before).not.toHaveBeenCalled()
    await settle(2)
    expect(before).toHaveBeenCalled()
    // ... the note is renamed on disk, then:
    const moved = t.host.followMove(BOARD, 'Boards/Renamed.md')
    expect(t.host.status().path).toBe('Boards/Renamed.md')
    await moved
    expect(w.loaded.at(-1)).toEqual({ file: PAGE, query: { path: 'Boards/Renamed.md' } })
    expect(w.loaded).toHaveLength(2)
    expect(t.brain.webContents.on_(IPC.boardClosed)).toEqual([])
    expect(t.brain.webContents.on_(IPC.boardState).at(-1)![0]).toMatchObject({ open: true, path: 'Boards/Renamed.md' })
    // The watcher's report of the new name now belongs to the window; the old name no longer does.
    t.host.forward([{ kind: 'unlink', path: BOARD }, { kind: 'add', path: 'Boards/Renamed.md', content: '---\ntype: board\n---\n' }])
    expect(w.webContents.on_(IPC.boardGone)).toEqual([])
  })

  it('says the note is gone when the window cannot follow it, and ignores a move of a note it does not show', async () => {
    const t = rig({ platform: 'linux' })
    await t.host.open(BOARD)
    await t.host.followMove(OTHER, 'Boards/X.md')
    expect(t.win.loaded).toHaveLength(1)
    t.win.loadError = Object.assign(new Error('ERR_FAILED'), { code: 'ERR_FAILED' })
    await t.host.followMove(BOARD, 'Boards/Renamed.md')
    expect(t.win.webContents.on_(IPC.boardGone)[0]![0]).toMatch(/renamed to Boards\/Renamed\.md, and the window could not follow it/)
  })

  it('compares the shown path the way the platform does', async () => {
    const t = rig({ platform: 'win32', answer: 0 })
    await t.host.open(BOARD)
    t.win.webContents.loading = false
    await t.host.beforeMove('boards/GATE.md')
    expect(t.win.webContents.on_(IPC.boardFlush)).toHaveLength(1)
    const u = rig({ platform: 'linux', answer: 0 })
    await u.host.open(BOARD)
    u.win.webContents.loading = false
    await u.host.beforeMove('boards/GATE.md')
    expect(u.win.webContents.on_(IPC.boardFlush)).toEqual([])
  })
})

describe('the page cannot take the window anywhere', () => {
  it('opens no window and sends no address to the browser, whatever it asks', async () => {
    const t = rig()
    await t.host.open(BOARD)
    for (const url of ['https://example.com/', 'http://example.com/', 'file:///etc/passwd', 'about:blank', 'javascript:alert(1)']) {
      expect(t.win.webContents.openHandler!({ url }), url).toEqual({ action: 'deny' })
    }
    expect(t.shell.openExternal).not.toHaveBeenCalled()
  })

  it.each([
    ['built', null],
    ['dev server', 'http://localhost:5174'],
  ])('stops a navigation of any frame away from its own page (%s), and takes its own page', async (_name, devUrl) => {
    const t = rig({ devUrl })
    await t.host.open(BOARD)
    const prevented = (event: string, url: string): boolean => {
      const e = { url, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      t.win.webContents.emit(event, e)
      return e.defaultPrevented
    }
    const own = devUrl ? `${devUrl}/board.html?path=a.md` : `${pathToFileURL(PAGE).href}?path=a.md`
    for (const event of ['will-navigate', 'will-frame-navigate']) {
      expect(prevented(event, own), `${event} own`).toBe(false)
      for (const url of ['about:blank', 'https://example.com/', 'file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)']) expect(prevented(event, url), `${event} ${url}`).toBe(true)
    }
  })

  it('brings the board page back when something navigated away anyway (location = about:blank raises no will-navigate)', async () => {
    const t = rig()
    await t.host.open(BOARD)
    const w = t.win
    expect(w.loaded).toHaveLength(1)
    w.webContents.emit('did-navigate', {}, `${pathToFileURL(PAGE).href}?path=${encodeURIComponent(BOARD)}`)
    expect(w.loaded).toHaveLength(1)
    w.webContents.emit('did-navigate', {}, 'about:blank')
    await settle()
    expect(w.loaded).toHaveLength(2)
    expect(w.loaded.at(-1)).toEqual({ file: PAGE, query: { path: BOARD } })
    w.webContents.emit('did-navigate', {}, 'https://example.com/')
    await settle()
    expect(w.loaded).toHaveLength(3)
    // A page address this check cannot recognise does not make the window load itself for ever: three times in ten seconds, then it is left.
    w.webContents.emit('did-navigate', {}, 'about:blank')
    w.webContents.emit('did-navigate', {}, 'about:blank')
    await settle()
    expect(w.loaded).toHaveLength(4)
    await settle(10_001)
    w.webContents.emit('did-navigate', {}, 'about:blank')
    await settle()
    expect(w.loaded).toHaveLength(5)
    // A window that is gone is left alone.
    w.destroy()
    w.webContents.emit('did-navigate', {}, 'about:blank')
    await settle()
    expect(w.loaded).toHaveLength(5)
  })
})

describe('over full-screen apps on macOS', () => {
  it('is visible on every Space (full-screen ones too) while always on top, once per change, and only on macOS', async () => {
    const mac = rig({ platform: 'darwin' })
    await mac.host.open(BOARD)
    expect(mac.win.allWorkspaces).toEqual([[true, { visibleOnFullScreen: true }]])
    mac.host.configure({ alwaysOnTop: true })
    expect(mac.win.allWorkspaces).toHaveLength(1)
    mac.host.configure({ alwaysOnTop: false })
    mac.host.configure({ alwaysOnTop: true })
    expect(mac.win.allWorkspaces).toEqual([[true, { visibleOnFullScreen: true }], [false, undefined], [true, { visibleOnFullScreen: true }]])
    for (const platform of ['win32', 'linux'] as const) {
      const t = rig({ platform })
      await t.host.open(BOARD)
      t.host.configure({ alwaysOnTop: false })
      t.host.configure({ alwaysOnTop: true })
      expect(t.win.allWorkspaces, platform).toEqual([])
    }
    // A window the user left off the top is not on every Space.
    const off = rig({ platform: 'darwin', settings: { alwaysOnTop: false } })
    await off.host.open(BOARD)
    expect(off.win.allWorkspaces).toEqual([])
  })

  it('never throws where the call is missing or fails', async () => {
    const t = rig({ platform: 'darwin' })
    ;(FakeWin.prototype as unknown as { setVisibleOnAllWorkspaces: unknown }).setVisibleOnAllWorkspaces = function () {
      throw new Error('not here')
    }
    await expect(t.host.open(BOARD)).resolves.toMatchObject({ open: true })
    expect(() => t.host.configure({ alwaysOnTop: false })).not.toThrow()
    ;(FakeWin.prototype as unknown as { setVisibleOnAllWorkspaces: unknown }).setVisibleOnAllWorkspaces = undefined
    const u = rig({ platform: 'darwin' })
    await expect(u.host.open(BOARD)).resolves.toMatchObject({ open: true })
  })
})

describe('the smallest window is 480 x 320', () => {
  it('is the least a saved size, a clamp and the window options will give', () => {
    expect([BOARD_MIN_WIDTH, BOARD_MIN_HEIGHT]).toEqual([480, 320])
    expect(boardSettings({ width: 100, height: 100 })).toMatchObject({ width: 480, height: 320 })
    expect(clampBoardBounds({ width: 100, height: 100 }, [{ x: 0, y: 0, width: 1920, height: 1040 }])).toMatchObject({ width: 480, height: 320 })
    expect(boardWindowOptions({ width: 640, height: 480, alwaysOnTop: true, opacity: 1 }, 'win32', [{ x: 0, y: 0, width: 1920, height: 1040 }], '/p.cjs')).toMatchObject({ minWidth: 480, minHeight: 320 })
    // A small screen: pinned at the least, not below.
    expect(clampBoardBounds({ x: 0, y: 0, width: 600, height: 400 }, [{ x: 0, y: 0, width: 400, height: 300 }])).toMatchObject({ width: 480, height: 320 })
  })
})

describe('what the board window says when its page died', () => {
  it('names itself - "board window" - and says what a reload loses; the brain window keeps its own words', async () => {
    const t = rig()
    await t.host.open(BOARD)
    t.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(t.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    const box = (t.dialog.showMessageBox.mock.calls[0] as unknown as [unknown, { message: string; detail: string }])[1]
    expect(box.message).toBe('The board window crashed.')
    expect(box.detail).toMatch(/opening again with the board as its note last had it\. A note you were still typing is not in it/)
    expect(box.detail).not.toMatch(/Aether Brain/)
    expect(crashMessage('crashed', true).message).toBe('The Aether Brain window crashed.')
    expect(crashMessage('crashed', true, BRAIN_WINDOW_NAME).detail).toMatch(/Your notes are the files on disk and were not touched/)
  })

  it('does not call crashes 20 to 30 seconds apart "right after opening"', () => {
    for (const name of [BRAIN_WINDOW_NAME, BOARD_WINDOW_NAME]) {
      const m = crashMessage('oom', false, name)
      expect(m.detail, name).toMatch(/stopped several times within a minute, so it was left closed/)
      expect(m.detail, name).not.toMatch(/right after opening/)
    }
    expect(crashMessage('oom', false, BOARD_WINDOW_NAME).detail).toMatch(/Boards view/)
    expect(crashMessage('killed', true, BOARD_WINDOW_NAME).message).toBe('The board window was stopped by the system.')
  })
})

describe('the flush cap', () => {
  it('is 1.5 s', () => {
    expect(FLUSH_WAIT_MS).toBe(1500)
  })
})
