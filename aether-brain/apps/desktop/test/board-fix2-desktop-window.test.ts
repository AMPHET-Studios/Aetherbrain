import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FLUSH_WAIT_MS, boardMenuTemplate, isPageZoomChord } from '../src/main/board-window.js'
import { IPC } from '../src/shared/ipc.js'
import { BOARD, FakeWin, OTHER, rig } from './board-fix-desktop-fakes.js'

/**
 * Round 2, live-window-m2: Electron's default menu left browser accelerators live in the floating window (Ctrl+R / Ctrl+Shift+R reload
 * the page, Ctrl+Shift+I opens DevTools, F11 full-screens an always-on-top window, Ctrl+- / Ctrl+Shift+= zoom the whole page). The window
 * has a menu of its own now (Window > Close with Ctrl+W, the Edit roles), and its page stays at 100%.
 * live-window-m6: a board opened while the window holds its close waits for the window to go and gets a new one.
 */

const here = path.dirname(fileURLToPath(import.meta.url))

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})
const settle = async (ms = 0): Promise<void> => void (await vi.advanceTimersByTimeAsync(ms))

interface Item {
  label?: string
  role?: string
  type?: string
  accelerator?: string
  click?: () => void
  submenu?: Item[]
}
const menuOf = (w: FakeWin): Item[] => (w.menus[0] as { template: Item[] }).template

describe('the window\'s own menu', () => {
  it('is Window > Close (Ctrl+W) and the Edit roles, nothing else: no Reload, DevTools, Full Screen or zoom item, so none of their accelerators', () => {
    const closed = vi.fn()
    const template = boardMenuTemplate(closed) as Item[]
    expect(template.map((m) => m.label)).toEqual(['Window', 'Edit'])
    const [window, edit] = template
    expect(window!.submenu).toEqual([{ label: 'Close', accelerator: 'CmdOrCtrl+W', click: closed }])
    expect(edit!.submenu!.map((i) => i.role ?? i.type)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'selectAll'])
    const all = JSON.stringify(template, (_k, v: unknown) => (typeof v === 'function' ? 'fn' : v))
    expect(all).not.toMatch(/reload|forceReload|toggleDevTools|togglefullscreen|zoomIn|zoomOut|resetZoom|quit|F11|F12|F5/i)
    // The only accelerator given is Ctrl+W (the Edit roles bring their own, which the page does not use over a text box).
    expect([...all.matchAll(/"accelerator":"([^"]*)"/g)].map((m) => m[1])).toEqual(['CmdOrCtrl+W'])
  })

  it('is set on the window on Windows and Linux, once per window; macOS keeps the application menu', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const t = rig({ platform })
      await t.host.open(BOARD)
      expect(t.win.menus, platform).toHaveLength(1)
      expect(menuOf(t.win).map((m) => m.label), platform).toEqual(['Window', 'Edit'])
      // Showing another board in the same window does not make another menu.
      await t.host.open(OTHER)
      expect(t.win.menus, platform).toHaveLength(1)
    }
    const mac = rig({ platform: 'darwin' })
    await mac.host.open(BOARD)
    expect(mac.win.menus).toEqual([])
  })

  it('is skipped (the default menu stays) when Electron\'s Menu is not handed in, and never breaks the window when it cannot be made', async () => {
    const none = rig({ platform: 'win32', menu: false })
    await expect(none.host.open(BOARD)).resolves.toMatchObject({ open: true })
    expect(none.win.menus).toEqual([])
    const broken = rig({ platform: 'win32' })
    ;(FakeWin.prototype as unknown as { setMenu: unknown }).setMenu = function () {
      throw new Error('no menu here')
    }
    try {
      await expect(broken.host.open(BOARD)).resolves.toMatchObject({ open: true })
    } finally {
      delete (FakeWin.prototype as unknown as { setMenu?: unknown }).setMenu
      ;(FakeWin.prototype as unknown as { setMenu: unknown }).setMenu = function (this: FakeWin, menu: unknown) {
        this.menus.push(menu)
      }
    }
  })

  it('closes the window with Ctrl+W through the handshake: the page is asked to save, and the window goes only when it has', async () => {
    const t = rig({ platform: 'linux', answer: 40 })
    await t.host.open(BOARD)
    const w = t.win
    const closeItem = menuOf(w)[0]!.submenu![0]!
    closeItem.click!()
    // Held: the page is asked, the window is still there.
    expect(w.webContents.on_(IPC.boardFlush)).toHaveLength(1)
    expect(w.gone).toBe(false)
    await settle(41)
    expect(w.gone).toBe(true)
    expect(t.host.status().open).toBe(false)
    // The brain window was told the board is back with it, once.
    expect(t.brain.webContents.on_(IPC.boardClosed)).toEqual([[BOARD]])
  })
})

describe('the page stays at 100%', () => {
  it('asks Chromium for no pinch zoom, and puts the zoom back after a wheel zoom request and after a page load', async () => {
    const t = rig({ platform: 'linux' })
    await t.host.open(BOARD)
    const page = t.win.webContents
    expect(page.zoomLimits).toEqual([1, 1])
    page.zoom = 0.9129
    page.emit('zoom-changed', {}, 'out')
    expect(page.zoom).toBe(1)
    // A zoom carried over from the brain window's page (same session) is undone when the page has loaded.
    page.zoom = 1.2
    page.emit('did-finish-load')
    expect(page.zoom).toBe(1)
    // A page at 100% is left alone.
    const spy = vi.spyOn(page, 'setZoomFactor')
    page.emit('did-finish-load')
    expect(spy).not.toHaveBeenCalled()
  })

  it('never throws when the page is gone or has no zoom', async () => {
    const t = rig({ platform: 'linux' })
    await t.host.open(BOARD)
    const page = t.win.webContents
    page.zoom = 2
    page.destroyed = true
    expect(() => page.emit('zoom-changed', {}, 'in')).not.toThrow()
    expect(page.zoom).toBe(2)
    const bare = rig({ platform: 'linux' })
    await bare.host.open(BOARD)
    ;(bare.win.webContents as unknown as { getZoomFactor: unknown }).getZoomFactor = () => {
      throw new Error('gone')
    }
    expect(() => bare.win.webContents.emit('did-finish-load')).not.toThrow()
  })

  it('stops a zoom chord before the menu sees it (macOS keeps the application menu), and lets every other key reach the page', async () => {
    const t = rig({ platform: 'darwin' })
    await t.host.open(BOARD)
    const press = (input: Record<string, unknown>): boolean => {
      const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      t.win.webContents.emit('before-input-event', e, { type: 'keyDown', ...input })
      return e.defaultPrevented
    }
    for (const key of ['+', '=', '-', '_', '0']) {
      expect(press({ key, control: true }), `Ctrl ${key}`).toBe(true)
      expect(press({ key, meta: true }), `Cmd ${key}`).toBe(true)
      expect(press({ key, control: true, shift: true }), `Ctrl Shift ${key}`).toBe(true)
    }
    // The board's own keys: plain + - 1, and its chords (Ctrl+R rotates the selection, Ctrl+Z undoes, Ctrl+0 is not zoom but nothing the board uses).
    for (const input of [{ key: '-' }, { key: '+' }, { key: '1' }, { key: 'r', control: true }, { key: 'R', control: true, shift: true }, { key: 'z', control: true }, { key: '=', control: true, alt: true }, { key: 'w', control: true }]) {
      expect(press(input), JSON.stringify(input)).toBe(false)
    }
    // Key up is left alone.
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    t.win.webContents.emit('before-input-event', e, { type: 'keyUp', key: '-', control: true })
    expect(e.defaultPrevented).toBe(false)
  })

  it('knows a zoom chord when it sees one', () => {
    expect(isPageZoomChord({ type: 'keyDown', key: '-', control: true })).toBe(true)
    expect(isPageZoomChord({ type: 'keyDown', key: '0', meta: true })).toBe(true)
    expect(isPageZoomChord({ type: 'keyDown', key: '-' })).toBe(false)
    expect(isPageZoomChord({ type: 'keyDown', key: 'r', control: true })).toBe(false)
    expect(isPageZoomChord({ type: 'keyDown', key: '-', control: true, alt: true })).toBe(false)
    expect(isPageZoomChord({})).toBe(false)
  })
})

describe('a board opened while the window is on its way out', () => {
  it('waits for the window to go and gets a new one (no Chromium error), and the first board is saved and handed back first', async () => {
    const t = rig({ platform: 'linux', answer: 60 })
    await t.host.open(BOARD)
    const first = t.win
    const closed = t.host.close()
    // The close is held while the page saves; this open arrives in the meantime.
    expect(first.gone).toBe(false)
    const opened = t.host.open(OTHER)
    const settled = vi.fn()
    void opened.then(settled, settled)
    await settle(30)
    // Nothing was loaded into the window that is going, and the open is still waiting.
    expect(first.loaded).toHaveLength(1)
    expect(settled).not.toHaveBeenCalled()
    await settle(40)
    await closed
    await expect(opened).resolves.toMatchObject({ open: true, path: OTHER })
    expect(first.gone).toBe(true)
    expect(FakeWin.made).toHaveLength(2)
    const second = FakeWin.made[1]!
    expect(second.gone).toBe(false)
    expect(second.loaded).toEqual([{ file: '/app/dist/renderer/board.html', query: { path: OTHER } }])
    expect(first.loaded).toHaveLength(1)
    expect(t.host.status()).toMatchObject({ open: true, path: OTHER })
    // The board that was shown went back to the brain window exactly once.
    expect(t.brain.webContents.on_(IPC.boardClosed)).toEqual([[BOARD]])
    // And the new window is a board window like the first (its page is judged against the channel list, it has its menu).
    expect(t.host.isBoardPage(second.webContents)).toBe(true)
    expect(second.menus).toHaveLength(1)
  })

  it('also waits when the close comes from the page\'s "Bring it back" or Ctrl+W and the open from the brain window at the same moment (a storm of pairs leaves one window)', async () => {
    const t = rig({ platform: 'linux', answer: 20 })
    await t.host.open(BOARD)
    for (let i = 0; i < 6; i++) {
      void t.host.close()
      const p = t.host.open(i % 2 ? BOARD : OTHER)
      void p.catch(() => undefined)
      await settle(25)
    }
    await settle(100)
    expect(FakeWin.made.filter((w) => !w.gone).length).toBeLessThanOrEqual(1)
    // The next open works.
    await expect(t.host.open(BOARD)).resolves.toMatchObject({ open: true, path: BOARD })
  })

  it('gives up on a close that something else keeps from happening, and carries on in the window it has', async () => {
    const t = rig({ platform: 'linux', answer: 0 })
    await t.host.open(BOARD)
    const w = t.win
    w.on('close', (e: { preventDefault(): void }) => e.preventDefault())
    void t.host.close()
    await settle(5)
    expect(w.gone).toBe(false)
    const opened = t.host.open(OTHER)
    await settle(FLUSH_WAIT_MS * 2 - 10)
    expect(w.loaded).toHaveLength(1)
    await settle(20)
    await expect(opened).resolves.toMatchObject({ open: true, path: OTHER })
    // The window that would not close shows the board; no second one was made.
    expect(FakeWin.made).toHaveLength(1)
    expect(w.loaded.at(-1)).toEqual({ file: '/app/dist/renderer/board.html', query: { path: OTHER } })
  })

  it('does not wait at all when no close is under way', async () => {
    const t = rig({ platform: 'linux' })
    await t.host.open(BOARD)
    const second = t.host.open(OTHER)
    await settle(0)
    await expect(second).resolves.toMatchObject({ path: OTHER })
    expect(FakeWin.made).toHaveLength(1)
  })
})

describe('main.ts hands the window Electron\'s Menu', () => {
  it('and the board window module does not import Electron at runtime (types only)', async () => {
    const main = await fs.readFile(path.join(here, '..', 'src', 'main', 'main.ts'), 'utf8')
    expect(main).toMatch(/import \{[^}]*\bMenu\b[^}]*\} from 'electron'/)
    expect(main).toContain('electron: { BrowserWindow, screen, shell, dialog, Menu },')
    const win = await fs.readFile(path.join(here, '..', 'src', 'main', 'board-window.ts'), 'utf8')
    expect(win.match(/^import .*from 'electron'$/gm)).toEqual(["import type { BrowserWindow, BrowserWindowConstructorOptions, Dialog, Display, Menu, MenuItemConstructorOptions, Screen, Shell, WebContents } from 'electron'"])
  })
})
