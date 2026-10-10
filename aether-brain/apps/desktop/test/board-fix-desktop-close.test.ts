import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLUSH_WAIT_MS, FlushGate } from '../src/main/board-window.js'
import { IPC } from '../src/shared/ipc.js'
import { BOARD, FakePage, FakeWin, OTHER, rig } from './board-fix-desktop-fakes.js'

/**
 * desktop-1, live-window-1, shell-1 (window half): a window's close, a vault switch, a move to another board and the quit all wait
 * for the page to say it saved (board:flush / board:flushed), because a note being typed is committed only by the flush and a
 * two-step write was cut off when the page went between its steps.
 */

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const settle = async (ms = 0): Promise<void> => void (await vi.advanceTimersByTimeAsync(ms))

describe('FlushGate.ask', () => {
  it('sends the page board:flush with a token and says true when that page answers with it', async () => {
    const gate = new FlushGate()
    const page = new FakePage()
    const got = vi.fn()
    void gate.ask(page).then(got)
    expect(page.on_(IPC.boardFlush)).toHaveLength(1)
    const token = page.on_(IPC.boardFlush)[0]![0] as number
    expect(typeof token).toBe('number')
    await settle()
    expect(got).not.toHaveBeenCalled()
    gate.ack(page.id, token)
    await settle()
    expect(got).toHaveBeenCalledWith(true)
  })

  it('says false after 1.5 s of silence, and a late answer does nothing', async () => {
    const gate = new FlushGate()
    const page = new FakePage()
    expect(FLUSH_WAIT_MS).toBe(1500)
    const got = vi.fn()
    void gate.ask(page).then(got)
    const token = page.on_(IPC.boardFlush)[0]![0] as number
    await settle(FLUSH_WAIT_MS - 1)
    expect(got).not.toHaveBeenCalled()
    await settle(2)
    expect(got).toHaveBeenCalledWith(false)
    gate.ack(page.id, token)
    await settle()
    expect(got).toHaveBeenCalledTimes(1)
  })

  it('does not wait for a page that is gone, crashed or still loading: false at once, nothing sent', async () => {
    const gate = new FlushGate()
    for (const set of [(p: FakePage) => (p.destroyed = true), (p: FakePage) => (p.crashed = true), (p: FakePage) => (p.loading = true)]) {
      const page = new FakePage()
      set(page)
      await expect(gate.ask(page)).resolves.toBe(false)
      expect(page.sent).toEqual([])
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores an answer from another page, with another token, or that is no token', async () => {
    const gate = new FlushGate()
    const page = new FakePage()
    const other = new FakePage()
    const got = vi.fn()
    void gate.ask(page).then(got)
    const token = page.on_(IPC.boardFlush)[0]![0] as number
    gate.ack(other.id, token)
    gate.ack(page.id, token + 1)
    gate.ack(page.id, String(token))
    gate.ack(page.id, undefined)
    await settle()
    expect(got).not.toHaveBeenCalled()
    gate.ack(page.id, token)
    await settle()
    expect(got).toHaveBeenCalledWith(true)
  })

  it('gives every ask its own token: the answer to the second does not release the first', async () => {
    const gate = new FlushGate()
    const a = new FakePage()
    const b = new FakePage()
    const doneA = vi.fn()
    const doneB = vi.fn()
    void gate.ask(a).then(doneA)
    void gate.ask(b).then(doneB)
    const ta = a.on_(IPC.boardFlush)[0]![0] as number
    const tb = b.on_(IPC.boardFlush)[0]![0] as number
    expect(ta).not.toBe(tb)
    gate.ack(b.id, tb)
    await settle()
    expect(doneB).toHaveBeenCalledWith(true)
    expect(doneA).not.toHaveBeenCalled()
    gate.ack(b.id, ta)
    await settle()
    expect(doneA).not.toHaveBeenCalled()
  })

  it('stops waiting when the page dies meanwhile (destroyed, or its process gone)', async () => {
    const gate = new FlushGate()
    const gone = new FakePage()
    const crashed = new FakePage()
    const r1 = vi.fn()
    const r2 = vi.fn()
    void gate.ask(gone).then(r1)
    void gate.ask(crashed).then(r2)
    gone.emit('destroyed')
    crashed.emit('render-process-gone')
    await settle()
    expect(r1).toHaveBeenCalledWith(false)
    expect(r2).toHaveBeenCalledWith(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('says false when the message cannot be sent', async () => {
    const gate = new FlushGate()
    const page = new FakePage()
    page.send = () => {
      throw new Error('Object has been destroyed')
    }
    await expect(gate.ask(page)).resolves.toBe(false)
  })
})

describe('FlushGate.guardClose', () => {
  function windowWith(page = new FakePage()) {
    const win = new FakeWin()
    ;(win as unknown as { webContents: FakePage }).webContents = page
    return win
  }

  it('holds the first close, asks the page, and lets the second go once the page has saved', async () => {
    const gate = new FlushGate()
    const win = windowWith()
    const before = vi.fn()
    gate.guardClose(win as never, before)
    win.close()
    expect(win.gone).toBe(false)
    expect(win.webContents.on_(IPC.boardFlush)).toHaveLength(1)
    // Nothing is destroyed while the page works.
    await settle(1000)
    expect(win.gone).toBe(false)
    gate.ack(win.webContents.id, win.webContents.on_(IPC.boardFlush)[0]![0])
    await settle()
    expect(win.gone).toBe(true)
    // `before` runs on every close event, held or not.
    expect(before).toHaveBeenCalledTimes(2)
    expect(win.closeEvents).toBe(2)
  })

  it('closes after the cap when the page never answers', async () => {
    const gate = new FlushGate()
    const win = windowWith()
    gate.guardClose(win as never)
    win.close()
    await settle(FLUSH_WAIT_MS - 1)
    expect(win.gone).toBe(false)
    await settle(2)
    expect(win.gone).toBe(true)
  })

  it('asks once however often the window is told to close meanwhile', async () => {
    const gate = new FlushGate()
    const win = windowWith()
    gate.guardClose(win as never)
    win.close()
    win.close()
    win.close()
    expect(win.webContents.on_(IPC.boardFlush)).toHaveLength(1)
    expect(win.gone).toBe(false)
    gate.ack(win.webContents.id, win.webContents.on_(IPC.boardFlush)[0]![0])
    await settle()
    expect(win.gone).toBe(true)
    expect(win.webContents.on_(IPC.boardFlush)).toHaveLength(1)
  })

  it('does not hold a window whose page is gone, crashed or loading', async () => {
    for (const set of [(p: FakePage) => (p.crashed = true), (p: FakePage) => (p.loading = true)]) {
      const gate = new FlushGate()
      const page = new FakePage()
      set(page)
      const win = windowWith(page)
      gate.guardClose(win as never)
      win.close()
      expect(win.gone).toBe(true)
      expect(page.sent).toEqual([])
    }
  })

  it('lets closes through for the time given (the app is quitting and every page has just saved), and holds again after it', async () => {
    let now = 1_000
    const gate = new FlushGate(FLUSH_WAIT_MS, () => now)
    gate.openFor(5000)
    const during = windowWith()
    gate.guardClose(during as never)
    during.close()
    expect(during.gone).toBe(true)
    now += 5001
    const after = windowWith()
    gate.guardClose(after as never)
    after.close()
    expect(after.gone).toBe(false)
  })

  it('does not throw when the window is destroyed while the page works', async () => {
    const gate = new FlushGate()
    const win = windowWith()
    gate.guardClose(win as never)
    win.close()
    win.destroy()
    await settle(FLUSH_WAIT_MS + 1)
    expect(win.gone).toBe(true)
  })
})

describe('the board window: its close waits for the page', () => {
  it('holds a close from anywhere (the X button, Ctrl+W, board:close, the vault switch) until the page has saved; the brain hears of it after', async () => {
    const t = rig({ answer: 100 })
    await t.host.open(BOARD)
    const w = t.win
    w.webContents.loading = false
    w.close()
    expect(w.gone).toBe(false)
    expect(w.webContents.on_(IPC.boardFlush)).toHaveLength(1)
    expect(t.brain.webContents.on_(IPC.boardClosed)).toEqual([])
    expect(t.host.status().open).toBe(true)
    await settle(100)
    expect(w.gone).toBe(true)
    expect(t.brain.webContents.on_(IPC.boardClosed)).toEqual([[BOARD]])
    expect(t.host.status().open).toBe(false)
  })

  it('close() resolves once the window is gone, and after the cap for a page that does not answer', async () => {
    const t = rig({ answer: 250 })
    await t.host.open(BOARD)
    t.win.webContents.loading = false
    const done = vi.fn()
    void t.host.close().then(done)
    await settle(249)
    expect(done).not.toHaveBeenCalled()
    await settle(2)
    expect(done).toHaveBeenCalled()
    expect(t.win.gone).toBe(true)

    const mute = rig({ answer: null })
    await mute.host.open(BOARD)
    mute.win.webContents.loading = false
    const closed = vi.fn()
    void mute.host.close().then(closed)
    await settle(FLUSH_WAIT_MS - 1)
    expect(closed).not.toHaveBeenCalled()
    expect(mute.win.gone).toBe(false)
    await settle(2)
    expect(closed).toHaveBeenCalled()
    expect(mute.win.gone).toBe(true)
  })

  it('remembers where the window was on the held close and again on the final one', async () => {
    const t = rig({ answer: 50 })
    await t.host.open(BOARD)
    t.win.webContents.loading = false
    t.win.bounds = { x: 300, y: 200, width: 900, height: 700 }
    t.win.close()
    expect(t.host.status().open).toBe(true)
    expect(t.saved.at(-1)).toMatchObject({ x: 300, y: 200, width: 900, height: 700 })
    // The window moved while the page was saving: the final close notes the place it had then.
    t.win.bounds = { x: 310, y: 210, width: 900, height: 700 }
    await settle(50)
    expect(t.win.gone).toBe(true)
    expect(t.saved.at(-1)).toMatchObject({ x: 310, y: 210, width: 900, height: 700 })
  })

  it('closing the brain window closes the board window the same way: the page is asked first', async () => {
    const t = rig({ answer: 40 })
    await t.host.open(BOARD)
    const w = t.win
    w.webContents.loading = false
    t.brain.destroy()
    expect(w.gone).toBe(false)
    expect(w.webContents.on_(IPC.boardFlush)).toHaveLength(1)
    await settle(40)
    expect(w.gone).toBe(true)
  })

  it('does not wait for a page that crashed: the close goes through at once', async () => {
    const t = rig({ answer: null })
    await t.host.open(BOARD)
    t.win.webContents.loading = false
    t.win.webContents.crashed = true
    t.win.close()
    expect(t.win.gone).toBe(true)
    expect(t.win.webContents.on_(IPC.boardFlush)).toEqual([])
  })

  it('asks the page to save before the window moves to another board, and loads the other board after it', async () => {
    const t = rig({ answer: 80 })
    await t.host.open(BOARD)
    const w = t.win
    w.webContents.loading = false
    const moved = t.host.open(OTHER)
    await settle(79)
    expect(w.webContents.on_(IPC.boardFlush)).toHaveLength(1)
    // Still the old board: not loaded, the docked view has not got it back yet.
    expect(w.loaded.map((l) => l.query?.['path'])).toEqual([BOARD])
    expect(t.brain.webContents.on_(IPC.boardClosed)).toEqual([])
    await settle(2)
    const status = await moved
    expect(status.path).toBe(OTHER)
    expect(w.loaded.map((l) => l.query?.['path'])).toEqual([BOARD, OTHER])
    expect(t.brain.webContents.on_(IPC.boardClosed)).toEqual([[BOARD]])
  })

  it('flushPage() asks the shown page (the quit), and does nothing with no window', async () => {
    const t = rig({ answer: 30 })
    await t.host.flushPage()
    expect(FakeWin.made).toHaveLength(0)
    await t.host.open(BOARD)
    t.win.webContents.loading = false
    const done = vi.fn()
    void t.host.flushPage().then(done)
    await settle(29)
    expect(done).not.toHaveBeenCalled()
    await settle(2)
    expect(done).toHaveBeenCalled()
    expect(t.win.gone).toBe(false)
    expect(t.host.shownPath()).toBe(BOARD)
  })
})
