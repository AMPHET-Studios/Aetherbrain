import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter } from '@aether/core'
import type { AetherBridge, BoardConfigureDto, BoardStatusDto } from '../src/shared/ipc.js'

/**
 * The desktop side of the docked Boards view: `renderer/board.ts` registers a `BoardWindowControl` (packages/ui/src/board/active.ts) built
 * over the bridge, plus the palette entries and the `w` key. These tests load the real module against a fake bridge and the real store.
 */

// The first test of a file loads the whole UI package (its 3D libraries too): slow when other files load theirs at the same time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

class MemoryStorage {
  private map = new Map<string, string>()
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

const CLOSED: BoardStatusDto = { open: false, path: null, alwaysOnTop: true, opacity: 1, supportsOpacity: false }
const GATE = 'Boards/Gate.md'
const BOARD = `---\ntitle: Gate\ntype: board\n---\n# Gate\n\n## Board\n- view x=0 y=0 zoom=1 bg=14161d gray=0 smooth=1 captions=0 grid=0\n`

/** The bridge as far as the board window goes: what main answers, and every call made. */
function fakeBridge(first: BoardStatusDto = CLOSED) {
  let status = first
  const stateSubs = new Set<(s: BoardStatusDto) => void>()
  const closedSubs = new Set<(path: string) => void>()
  const flushSubs = new Set<(token: number) => void>()
  const acks: number[] = []
  const calls: string[] = []
  const bridge = {
    platform: 'win32',
    boardStatus: vi.fn(async () => status),
    boardOpen: vi.fn(async (path: string) => {
      calls.push(`open ${path}`)
      // Main opens a board note only.
      if (!/^Boards\/.+\.md$/.test(path) || path.includes('Idea')) throw new Error('Could not open the board window: not a board note')
      status = { ...status, open: true, path }
      for (const cb of stateSubs) cb(status)
      return status
    }),
    boardClose: vi.fn(async () => {
      calls.push('close')
      const was = status.path
      status = { ...status, open: false, path: null }
      for (const cb of stateSubs) cb(status)
      if (was) for (const cb of closedSubs) cb(was)
    }),
    boardConfigure: vi.fn(async (patch: BoardConfigureDto) => {
      calls.push(`configure ${JSON.stringify(patch)}`)
      status = { ...status, ...(patch.alwaysOnTop !== undefined ? { alwaysOnTop: patch.alwaysOnTop } : {}), ...(patch.opacity !== undefined ? { opacity: patch.opacity } : {}) }
      for (const cb of stateSubs) cb(status)
      return status
    }),
    onBoardState: vi.fn((cb: (s: BoardStatusDto) => void) => (stateSubs.add(cb), () => void stateSubs.delete(cb))),
    onBoardClosed: vi.fn((cb: (path: string) => void) => (closedSubs.add(cb), () => void closedSubs.delete(cb))),
    onBoardFlush: vi.fn((cb: (token: number) => void) => (flushSubs.add(cb), () => void flushSubs.delete(cb))),
    boardFlushed: vi.fn((token: number) => void acks.push(token)),
  }
  return {
    bridge: bridge as unknown as AetherBridge,
    raw: bridge,
    calls,
    /** Main says something on its own (a user closed the window, another board was opened). */
    say(next: BoardStatusDto) {
      status = next
      for (const cb of stateSubs) cb(next)
    },
    /** Main asks this window to save before it closes (the page answers with `boardFlushed`). */
    flush(token: number) {
      for (const cb of [...flushSubs]) cb(token)
    },
    acks,
    /** Main says the window stopped showing a board. */
    closed(path: string) {
      for (const cb of closedSubs) cb(path)
    },
  }
}

/** The renderer module loaded fresh against a bridge (or none), with the real store over a vault that has a board and a note. */
async function load(bridge: AetherBridge | null) {
  // No `window` while the UI package loads (its 3D libraries probe the browser they find); the bridge appears just before board.ts reads it.
  vi.unstubAllGlobals()
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  const ui = await import('@aether/ui')
  if (bridge) vi.stubGlobal('window', { aether: bridge, addEventListener: () => undefined, removeEventListener: () => undefined })
  const board = await import('../src/renderer/board')
  const keys = await import('../../../packages/ui/src/hooks/useKeyboard')
  await ui.useAether.getState().openVault(
    new MemoryVaultAdapter([
      { path: GATE, content: BOARD },
      { path: 'Inbox/Idea.md', content: '# Idea\n' },
    ]),
  )
  const s = () => ui.useAether.getState()
  const tick = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  await tick()
  return { ui, board, keys, s, tick }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the window control the docked view drives the window through', () => {
  it('is registered where the desktop bridge is, and only there', async () => {
    const f = fakeBridge()
    const { ui } = await load(f.bridge)
    const control = ui.getBoardWindowControl()
    expect(control).not.toBeNull()
    expect(control!.available).toBe(true)
    const web = await load(null)
    expect(web.ui.getBoardWindowControl()).toBeNull()
    expect(web.board.boardPopOutAvailable()).toBe(false)
  })

  it('is inert without a bridge: nothing opens, nothing throws', async () => {
    const { board, s } = await load(null)
    expect(await board.popOutBoard(GATE)).toBe(false)
    await expect(board.dockBoard()).resolves.toBeUndefined()
    expect(board.boardWindowState()).toMatchObject({ open: false, path: null })
    expect(s().toasts).toEqual([])
  })

  it('starts closed, on top and opaque, then follows main (boardStatus, and board:state pushes)', async () => {
    const f = fakeBridge({ open: true, path: GATE, alwaysOnTop: false, opacity: 0.7, supportsOpacity: true })
    const { ui, tick } = await load(f.bridge)
    await tick()
    expect(ui.getBoardWindowControl()!.status()).toEqual({ open: true, path: GATE, alwaysOnTop: false, opacity: 0.7, supportsOpacity: true })
    f.say({ open: false, path: null, alwaysOnTop: true, opacity: 1, supportsOpacity: true })
    expect(ui.getBoardWindowControl()!.status()).toMatchObject({ open: false, path: null, alwaysOnTop: true, opacity: 1 })
  })

  it('tells subscribers when the status changes, once per real change, and keeps one object between changes', async () => {
    const f = fakeBridge()
    const { ui, tick } = await load(f.bridge)
    await tick()
    const control = ui.getBoardWindowControl()!
    const heard = vi.fn()
    const off = control.subscribe(heard)
    const before = control.status()
    f.say({ ...before })
    expect(heard).not.toHaveBeenCalled()
    expect(control.status()).toBe(before)
    f.say({ ...before, open: true, path: GATE })
    expect(heard).toHaveBeenCalledTimes(1)
    const open = control.status()
    expect(open).toMatchObject({ open: true, path: GATE })
    expect(control.status()).toBe(open)
    f.say({ ...open, opacity: 0.5 })
    expect(heard).toHaveBeenCalledTimes(2)
    off()
    f.say({ ...open, opacity: 0.9 })
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('pops a board out after the view has saved it, and reports that the window shows it', async () => {
    const f = fakeBridge()
    const { ui, tick } = await load(f.bridge)
    await tick()
    const control = ui.getBoardWindowControl()!
    const order: string[] = []
    control.setFlush(async () => {
      order.push('flush started')
      await new Promise((r) => setTimeout(r, 5))
      f.calls.push('flush done')
      order.push('flush done')
    })
    expect(await control.popOut(GATE)).toBe(true)
    expect(f.calls).toEqual(['flush done', `open ${GATE}`])
    expect(control.status()).toMatchObject({ open: true, path: GATE })
  })

  it('does not open the window when the view could not save: the board stays docked, and the user is told', async () => {
    const f = fakeBridge()
    const { ui, tick, s } = await load(f.bridge)
    await tick()
    const control = ui.getBoardWindowControl()!
    control.setFlush(async () => {
      throw new Error('disk full')
    })
    expect(await control.popOut(GATE)).toBe(false)
    expect(f.raw.boardOpen).not.toHaveBeenCalled()
    expect(control.status().open).toBe(false)
    expect(s().toasts.at(-1)).toMatchObject({ kind: 'error' })
    expect(s().toasts.at(-1)!.text).toMatch(/could not be saved first.*disk full/)
  })

  it('opens when no view has a pending save to flush', async () => {
    const f = fakeBridge()
    const { ui, tick } = await load(f.bridge)
    await tick()
    expect(await ui.getBoardWindowControl()!.popOut(GATE)).toBe(true)
  })

  it('refuses a note the vault knows is no board, before saving or asking main', async () => {
    const f = fakeBridge()
    const { ui, tick, s } = await load(f.bridge)
    await tick()
    const control = ui.getBoardWindowControl()!
    const flush = vi.fn()
    control.setFlush(flush)
    expect(await control.popOut('Inbox/Idea.md')).toBe(false)
    expect(flush).not.toHaveBeenCalled()
    expect(f.raw.boardOpen).not.toHaveBeenCalled()
    expect(s().toasts.at(-1)!.text).toBe('Board window: Idea is not a board')
  })

  it('refuses what main refuses (a path the vault does not know), and says so; the window stays shut', async () => {
    const f = fakeBridge()
    const { ui, tick, s } = await load(f.bridge)
    await tick()
    const control = ui.getBoardWindowControl()!
    expect(await control.popOut('Elsewhere/Not a board.md')).toBe(false)
    expect(f.raw.boardOpen).toHaveBeenCalledTimes(1)
    expect(control.status().open).toBe(false)
    expect(s().toasts.at(-1)!.text).toMatch(/^Board window: Could not open the board window: not a board note/)
  })

  it('brings the board back: closes the window, and lets the docked view know which board returned', async () => {
    const f = fakeBridge()
    const { ui, tick } = await load(f.bridge)
    await tick()
    const control = ui.getBoardWindowControl()!
    const returned = vi.fn()
    control.onReturned(returned)
    await control.popOut(GATE)
    await control.dock()
    expect(f.calls).toEqual([`open ${GATE}`, 'close'])
    expect(control.status().open).toBe(false)
    expect(returned).toHaveBeenCalledWith(GATE)
    // Nothing is open: docking again asks nothing of main.
    await control.dock()
    expect(f.raw.boardClose).toHaveBeenCalledTimes(1)
  })

  it('tells every subscriber that the window gave a board back, one that throws included, until it unsubscribes', async () => {
    const f = fakeBridge()
    const { ui, tick } = await load(f.bridge)
    await tick()
    const control = ui.getBoardWindowControl()!
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const a = vi.fn(() => {
      throw new Error('broken view')
    })
    const b = vi.fn()
    control.onReturned(a)
    const offB = control.onReturned(b)
    f.closed(GATE)
    expect(a).toHaveBeenCalledWith(GATE)
    expect(b).toHaveBeenCalledWith(GATE)
    expect(warn).toHaveBeenCalled()
    offB()
    f.closed('Boards/Other.md')
    expect(b).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('sets always on top and opacity through main, keeping opacity between 20% and 100%', async () => {
    const f = fakeBridge()
    const { ui, tick } = await load(f.bridge)
    await tick()
    const control = ui.getBoardWindowControl()!
    await control.setAlwaysOnTop(false)
    await control.setOpacity(0.55)
    await control.setOpacity(0)
    await control.setOpacity(5)
    await control.setOpacity(Number.NaN)
    expect(f.calls).toEqual(['configure {"alwaysOnTop":false}', 'configure {"opacity":0.55}', 'configure {"opacity":0.2}', 'configure {"opacity":1}'])
    expect(control.status()).toMatchObject({ alwaysOnTop: false, opacity: 1 })
  })

  it('says so when main refuses a setting, and does not throw', async () => {
    const f = fakeBridge()
    const { ui, tick, s } = await load(f.bridge)
    await tick()
    f.raw.boardConfigure.mockRejectedValueOnce(new Error('no window'))
    await expect(ui.getBoardWindowControl()!.setAlwaysOnTop(true)).resolves.toBeUndefined()
    expect(s().toasts.at(-1)!.text).toBe('Board window: no window')
  })

  it('lets the view hand over its flush, and take it back; a stale unregister does not remove a newer flush', async () => {
    const f = fakeBridge()
    const { ui, tick } = await load(f.bridge)
    await tick()
    const control = ui.getBoardWindowControl()!
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = control.setFlush(first)
    const offSecond = control.setFlush(second)
    offFirst()
    await control.popOut(GATE)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    offSecond()
    await control.popOut('Boards/Again.md')
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('what the module exported before the control', () => {
  it('still exports its helpers', async () => {
    const f = fakeBridge()
    const { board } = await load(f.bridge)
    for (const name of ['boardPopOutAvailable', 'boardWindowState', 'useBoardWindow', 'useBoardOut', 'onBoardReturned', 'setBoardFlush', 'popOutBoard', 'dockBoard', 'parseOpacityPercent'] as const) {
      expect(typeof board[name], name).toBe('function')
    }
    expect(board.OPACITY_MIN_PERCENT).toBe(20)
    expect(board.boardPopOutAvailable()).toBe(true)
    expect(board.parseOpacityPercent('70 %')).toBe(0.7)
    expect(board.parseOpacityPercent('19')).toBeNull()
    expect(board.parseOpacityPercent('101')).toBeNull()
  })

  it('onBoardReturned and setBoardFlush are the control’s own functions', async () => {
    const f = fakeBridge()
    const { board, ui, tick } = await load(f.bridge)
    await tick()
    const control = ui.getBoardWindowControl()!
    const heard = vi.fn()
    board.onBoardReturned(heard)
    f.closed(GATE)
    expect(heard).toHaveBeenCalledWith(GATE)
    const flush = vi.fn()
    board.setBoardFlush(flush)
    await control.popOut(GATE)
    expect(flush).toHaveBeenCalledTimes(1)
  })
})

describe('the palette entries and the key', () => {
  const find = (ui: typeof import('@aether/ui'), q: string) => import('../../../packages/ui/src/commands').then((m) => m.findCommands(q, ui.useAether.getState()))
  const press = (keys: typeof import('../../../packages/ui/src/hooks/useKeyboard'), key: string) =>
    keys.handleKey({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: { tagName: 'BODY', getAttribute: () => null, hasAttribute: () => false }, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent)

  it('pop out is offered for the open board and the key w does it', async () => {
    const f = fakeBridge()
    const { ui, keys, s, tick } = await load(f.bridge)
    await tick()
    expect((await find(ui, 'Pop out')).map((c) => c.title)).toEqual([])
    s().openBoard(GATE)
    expect((await find(ui, 'Board: Pop out')).map((c) => c.title)).toEqual(['Board: Pop out to its own window'])
    press(keys, 'w')
    await tick()
    expect(f.calls).toEqual([`open ${GATE}`])
  })

  it('works with the board of the store, kept while the view is left', async () => {
    const f = fakeBridge()
    const { ui, keys, s, tick } = await load(f.bridge)
    await tick()
    s().openBoard(GATE)
    s().setView('graph')
    expect(s().boardPath).toBe(GATE)
    press(keys, 'w')
    await tick()
    expect(f.calls).toEqual([`open ${GATE}`])
    // Now the window has it: the entry to bring it back is offered and pop out is not.
    const titles = (await find(ui, 'Board: ')).map((c) => c.title)
    expect(titles).toContain('Board: Bring the board back from its window')
    expect(titles).not.toContain('Board: Pop out to its own window')
    press(keys, 'w')
    await tick()
    expect(f.calls).toEqual([`open ${GATE}`, 'close'])
  })

  it('w with no board open says what to do', async () => {
    const f = fakeBridge()
    const { keys, s, tick } = await load(f.bridge)
    await tick()
    press(keys, 'w')
    await tick()
    expect(f.calls).toEqual([])
    expect(s().toasts.at(-1)!.text).toMatch(/Open a board first \(8\)/)
  })

  it('offers window opacity only where the platform can', async () => {
    const f = fakeBridge()
    const { ui, tick } = await load(f.bridge)
    await tick()
    expect((await find(ui, 'opacity')).map((c) => c.title)).toEqual([])
    f.say({ ...CLOSED, supportsOpacity: true })
    expect((await find(ui, 'opacity')).map((c) => c.title)).toEqual(['Board: Window opacity…'])
  })

  it('never repeats a title or an id of the UI package’s own entries, whatever is open', async () => {
    const f = fakeBridge({ open: true, path: GATE, alwaysOnTop: true, opacity: 0.9, supportsOpacity: true })
    const { ui, s, tick } = await load(f.bridge)
    await tick()
    s().openBoard(GATE)
    ui.setActiveBoard({ path: GATE, exec: () => undefined, state: () => ({ selection: [1, 2, 3] }) as never, flush: async () => undefined })
    const all = await find(ui, '')
    const titles = all.map((c) => c.title)
    const ids = all.map((c) => c.id)
    expect(new Set(titles).size).toBe(titles.length)
    expect(new Set(ids).size).toBe(ids.length)
    // The four window entries are the desktop's, the other board entries the UI package's.
    expect(titles.filter((t) => /window|always on top|dock|pop out/i.test(t) && t.startsWith('Board:')).sort()).toEqual(['Board: Always on top', 'Board: Bring the board back from its window', 'Board: Window opacity…'])
    expect(titles).toContain('Board: Undo')
  })

  it('has a cheatsheet row for w in the desktop group', async () => {
    const f = fakeBridge()
    const { tick } = await load(f.bridge)
    await tick()
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const ui = await import('@aether/ui')
    ui.useAether.setState({ helpOpen: true })
    Object.assign(ui.useAether.getInitialState(), ui.useAether.getState())
    const { Help } = await import('../../../packages/ui/src/components/Help')
    const html = renderToStaticMarkup(createElement(Help))
    expect(html).toContain('Board: pop the open board out into its own window, or bring it back')
  })
})
