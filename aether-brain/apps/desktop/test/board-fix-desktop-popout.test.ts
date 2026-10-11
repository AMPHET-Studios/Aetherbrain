import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeyIn } from '../../../packages/ui/src/board/api'
import { boardRaw, rig } from '../../../packages/ui/test/helpers/board-view-fakes'
import type { BoardStatusDto } from '../src/shared/ipc.js'

/**
 * desktop-2: pop out refuses when the docked view could not save, using the REAL board session (its flush now says whether it is all
 * on disk) over a host whose save fails - and the brain window answers main's ask to save before it closes.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const CLOSED: BoardStatusDto = { open: false, path: null, alwaysOnTop: true, opacity: 1, supportsOpacity: false }
const GATE = 'Boards/Gate.md'
const RAW = boardRaw('Gate', [['Boards/Gate/rust.png', 0, 0, 200, 100]], [['hello', 0, -200]])
const key = (k: string): KeyIn => ({ key: k, code: k, down: true, shift: false, ctrl: false, alt: false, meta: false, repeat: false })

type Ui = typeof import('@aether/ui')
type Board = typeof import('../src/renderer/board.js')
let ui: Ui
let mod: Board
const flushAsks: ((token: number) => void)[] = []
const acks: number[] = []
const impl = {
  open: vi.fn(async (p: string): Promise<BoardStatusDto> => ({ ...CLOSED, open: true, path: p })),
  close: vi.fn(async () => undefined),
}
const toasts = (): string[] => ui.useAether.getState().toasts.map((t) => t.text)

beforeAll(async () => {
  const nav = { userAgent: 'node', platform: 'linux', maxTouchPoints: 0 }
  vi.stubGlobal('navigator', nav)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined })
  const bridge = {
    platform: 'linux',
    onBoardState: () => () => undefined,
    onBoardClosed: () => () => undefined,
    onBoardFlush: (cb: (token: number) => void) => (flushAsks.push(cb), () => undefined),
    boardFlushed: (token: number) => void acks.push(token),
    boardStatus: async () => CLOSED,
    boardOpen: (p: string) => impl.open(p),
    boardClose: () => impl.close(),
    boardConfigure: async () => CLOSED,
  }
  vi.stubGlobal('window', { aether: bridge, navigator: nav, addEventListener() {}, removeEventListener() {} })
  ui = await import('@aether/ui')
  mod = await import('../src/renderer/board.js')
  await Promise.resolve()
})
afterAll(() => {
  vi.unstubAllGlobals()
})
beforeEach(() => {
  impl.open.mockClear()
  impl.close.mockClear()
  acks.length = 0
  ui.useAether.setState({ boardPath: null, toasts: [] } as never)
  mod.setBoardFlush(null)
  ui.setActiveBoard(null)
})

/** What BoardsView registers: the board on screen, and a flush that goes to its session. */
function mount(r: ReturnType<typeof rig>): void {
  ui.setActiveBoard({ path: r.host.path, exec: () => undefined, state: () => ({}) as never, flush: () => r.session.flush() })
  mod.setBoardFlush(() => ui.getActiveBoard()?.flush())
}

describe('pop out: the docked view could not save', () => {
  it('does not open the window, keeps the board docked, and says why; once the note can be written the same pop out goes through', async () => {
    const r = rig(RAW)
    mount(r)
    r.host.saveError = new Error('EPERM: the note is locked')
    r.session.controller.exec('edit.selectAll')
    r.session.key(key('ArrowRight'))
    await r.timers.advance(100)
    expect(r.session.saveState).toBe('failed')
    // The real session's flush: it says false, it does not reject, and it leaves the change in the view to be tried again.
    await expect(r.session.flush()).resolves.toBe(false)
    expect(await mod.popOutBoard(GATE)).toBe(false)
    expect(impl.open).not.toHaveBeenCalled()
    expect(toasts().some((t) => /could not be saved first, so it was not moved/.test(t))).toBe(true)
    // The change is still the docked view's, written by nobody behind the window's back.
    expect(r.host.saves).toEqual([])

    r.host.saveError = null
    expect(await mod.popOutBoard(GATE)).toBe(true)
    expect(impl.open).toHaveBeenCalledTimes(1)
    expect(r.host.saves).toHaveLength(1)
  })

  it('opens at once when nothing is pending, and when the view has no board to flush', async () => {
    const r = rig(RAW)
    mount(r)
    expect(await mod.popOutBoard(GATE)).toBe(true)
    expect(r.host.saves).toEqual([])
    ui.setActiveBoard(null)
    expect(await mod.popOutBoard(GATE)).toBe(true)
    expect(impl.open).toHaveBeenCalledTimes(2)
  })

  it('refuses for a flush that answers false or throws (a view that registered either way), and for none else', async () => {
    mod.setBoardFlush(() => false)
    expect(await mod.popOutBoard(GATE)).toBe(false)
    mod.setBoardFlush(async () => false)
    expect(await mod.popOutBoard(GATE)).toBe(false)
    mod.setBoardFlush(async () => {
      throw new Error('boom')
    })
    expect(await mod.popOutBoard(GATE)).toBe(false)
    expect(impl.open).not.toHaveBeenCalled()
    for (const ok of [() => true, () => undefined, async () => undefined, async () => true]) {
      mod.setBoardFlush(ok)
      expect(await mod.popOutBoard(GATE)).toBe(true)
    }
    expect(impl.open).toHaveBeenCalledTimes(4)
  })
})

describe('the brain window answers main\'s ask to save before it closes', () => {
  const ask = async (token: number): Promise<void> => {
    for (const cb of flushAsks) cb(token)
    await vi.waitFor(() => expect(acks).toContain(token))
  }

  it('flushes the board of the docked view, and only then answers', async () => {
    const r = rig(RAW)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const flush = vi.fn(async () => {
      await gate
      return true
    })
    ui.setActiveBoard({ path: GATE, exec: () => undefined, state: () => ({}) as never, flush })
    void r
    for (const cb of flushAsks) cb(41)
    await new Promise((res) => setTimeout(res, 20))
    expect(flush).toHaveBeenCalledTimes(1)
    expect(acks).toEqual([])
    release()
    await vi.waitFor(() => expect(acks).toEqual([41]))
  })

  it('answers at once when no board is open, and when the flush fails or throws (a failed save never holds the close)', async () => {
    await ask(1)
    ui.setActiveBoard({ path: GATE, exec: () => undefined, state: () => ({}) as never, flush: async () => false })
    await ask(2)
    ui.setActiveBoard({
      path: GATE,
      exec: () => undefined,
      state: () => ({}) as never,
      flush: async () => {
        throw new Error('boom')
      },
    })
    await ask(3)
    expect(acks).toEqual([1, 2, 3])
  })
})
