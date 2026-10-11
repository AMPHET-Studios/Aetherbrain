import { describe, expect, it } from 'vitest'
import { parseBoard } from '@aether/core'
import { BOARD_GONE } from '../src/board/api'
import { BoardSession } from '../src/board/view/boardSession'
import { FakeHost, FakeTimers, FakeUi, boardRaw, fakeEnv, rig, settle } from './helpers/board-view-fakes'

/**
 * Round 2 of the reference board's review, the session against a fake host: a flush that waits for the reload that heals a refused save
 * (live-window-1), the red toast that a healed refusal does not raise (live-window-m3), a paste event nobody asked for (live-docked-2),
 * a note that is gone (live-docked-m4).
 */

const RAW = boardRaw('Gate', [['Boards/Gate/rust.png', 0, 0, 200, 100]], [['hello', 0, -200]])
const PROSE = 'Reference board.'
const OUTSIDE = 'An outside line.'

/** The refusal the real hosts send when the note on disk is not the text a save was made from. */
const CHANGED = 'The board was changed outside this window: it has been left as it is. Reload to see the change.'

/**
 * A host that refuses a save whose base is not the note on disk, as both real hosts do, and tells the board that the note changed in
 * the same breath (before the refusal is thrown). `refuseNext` refuses that many saves whatever they carry.
 */
class RefusingHost extends FakeHost {
  refused = 0
  refuseNext = 0
  /** Saves before which somebody else writes the note again (the edit lands between the board's read and its save). */
  drift = 0
  private edits = 0
  override async save(raw: string, expectedBase?: string): Promise<void> {
    if (this.drift > 0) {
      this.drift--
      this.raw = RAW.replace(PROSE, `Outside edit ${++this.edits}.`)
    }
    const stale = expectedBase !== undefined && expectedBase !== this.raw
    if (this.refuseNext > 0 || stale) {
      if (this.refuseNext > 0) this.refuseNext--
      this.refused++
      this.fireExternal()
      throw new Error(CHANGED)
    }
    return super.save(raw, expectedBase)
  }
}

function rigWith(host: FakeHost, raw: string = host.raw) {
  const timers = new FakeTimers()
  const env = fakeEnv(timers)
  const ui = new FakeUi()
  const session = new BoardSession({ host, env, ui })
  session.loadFromRaw(raw)
  session.start()
  return { host, timers, env, ui, session }
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const errorToasts = (host: FakeHost) => host.toasts.filter((t) => t.tone === 'error')

/* ------------------------------------------------------------------------- live-window-1 --- */

describe('a flush waits for the reload that heals a save the note refused (live-window-1)', () => {
  it('the close is not answered while the save is refused and the read is out; once the read lands the change is on disk, with the outside line', async () => {
    const host = new RefusingHost(RAW)
    const r = rigWith(host)
    // An outside program changed the note's prose; the board has not heard of it yet.
    host.raw = RAW.replace(PROSE, OUTSIDE)
    const gate = deferred()
    host.loadGate = () => gate.promise
    // A change is made and its save is refused: the host tells the board, the board starts to read the note again (the read is held).
    r.session.exec('view.gray')
    await settle()
    expect(host.refused).toBeGreaterThanOrEqual(1)
    expect(r.session.saveState).toBe('failed')

    let answer: boolean | undefined
    const closing = r.session.flush().then((v) => (answer = v))
    await settle()
    // The old answer was false, at once: the window was then destroyed with the change only in the browser's copy.
    expect(answer).toBeUndefined()
    expect(host.saves).toEqual([])

    gate.resolve()
    await closing
    expect(answer).toBe(true)
    expect(host.saves).toHaveLength(1)
    expect(host.raw).toContain(OUTSIDE)
    expect(parseBoard(host.raw).doc.gray).toBe(true)
    expect(r.session.saveState).toBe('saved')
  })

  it('a read that never comes does not hold the close past the budget: false, within a second', async () => {
    const host = new RefusingHost(RAW)
    const r = rigWith(host)
    host.raw = RAW.replace(PROSE, OUTSIDE)
    host.loadGate = () => new Promise<void>(() => undefined)
    r.session.exec('view.gray')
    await settle()
    let answer: boolean | undefined
    void r.session.flush().then((v) => (answer = v))
    await r.timers.advance(900)
    expect(answer).toBeUndefined()
    await r.timers.advance(100)
    expect(answer).toBe(false)
    // The change is not lost: the browser keeps a copy for the next opening.
    r.session.stash()
    expect([...r.env.storageMap.map.keys()].some((k) => k.startsWith('aether.board.unsaved:'))).toBe(true)
  })

  it('a refusal that comes again (the note changed once more before the retry) is healed in a second round', async () => {
    const host = new RefusingHost(RAW)
    const r = rigWith(host)
    host.drift = 2
    r.session.exec('view.gray')
    const ok = await r.session.flush()
    expect(ok).toBe(true)
    expect(host.refused).toBe(2)
    expect(host.saves).toHaveLength(1)
    expect(host.raw).toContain('Outside edit 2.')
    expect(parseBoard(host.raw).doc.gray).toBe(true)
  })

  it('a failure with no reload coming (a full disk) ends the flush at once, as before', async () => {
    const host = new RefusingHost(RAW)
    const r = rigWith(host)
    host.saveError = new Error('no space left on device')
    r.session.exec('view.gray')
    await settle()
    expect(await r.session.flush()).toBe(false)
    expect(host.refused).toBe(0)
    expect(r.session.saveState).toBe('failed')
  })

  it('nothing to heal: a flush of a board that is saved answers true without waiting', async () => {
    const host = new RefusingHost(RAW)
    const r = rigWith(host)
    r.session.exec('view.gray')
    expect(await r.session.flush()).toBe(true)
    expect(host.saves).toHaveLength(1)
    expect(r.timers.pending).toBe(0)
  })
})

/* ------------------------------------------------------------------------- live-window-m3 --- */

describe('a refusal that the board heals by itself is not a red toast (live-window-m3)', () => {
  it('the note changed outside, the save is refused, the reload makes it again: saved, and nothing red was shown', async () => {
    const host = new RefusingHost(RAW)
    const r = rigWith(host)
    host.raw = RAW.replace(PROSE, OUTSIDE)
    r.session.exec('view.gray')
    await settle()
    expect(host.refused).toBe(1)
    expect(r.session.saveState).toBe('saved')
    expect(host.raw).toContain(OUTSIDE)
    expect(parseBoard(host.raw).doc.gray).toBe(true)
    expect(errorToasts(host)).toEqual([])
    expect(r.session.lastMessage?.tone).not.toBe('error')
  })

  it('when the heal does not work (the retry is refused too) the failure is told, with the way to copy the text', async () => {
    const host = new RefusingHost(RAW)
    const r = rigWith(host)
    host.raw = RAW.replace(PROSE, OUTSIDE)
    host.refuseNext = 2
    r.session.exec('view.gray')
    await settle()
    const told = errorToasts(host)
    expect(told).toHaveLength(1)
    expect(told[0]!.text).toMatch(/The board could not be saved/)
    expect(told[0]!.action?.label).toBe('Copy board text')
  })

  it('when no retry follows the reload, the failure is told with the next try', async () => {
    const host = new RefusingHost(RAW)
    const r = rigWith(host)
    // The note is as the board read it: the reload finds nothing new, and the refusal stands (refused twice).
    host.refuseNext = 2
    r.session.exec('view.gray')
    await settle()
    expect(errorToasts(host)).toEqual([])
    await r.timers.advance(5100)
    expect(errorToasts(host)).toHaveLength(1)
    await r.timers.advance(10_100)
    expect(r.session.saveState).toBe('saved')
  })

  it('any other failure is told at once, as before', async () => {
    const host = new RefusingHost(RAW)
    const r = rigWith(host)
    host.saveError = new Error('read-only volume')
    r.session.exec('view.gray')
    await settle()
    expect(errorToasts(host)).toHaveLength(1)
    expect(errorToasts(host)[0]!.text).toMatch(/read-only volume/)
  })
})

/* -------------------------------------------------------------------------- live-docked-2 --- */

describe('a paste event nobody asked for pastes nothing (live-docked-2)', () => {
  const EMPTY = { files: [], uriList: '', html: '', text: '' }
  const ctrlV = { key: 'v', code: 'KeyV', down: true, shift: false, ctrl: true, alt: false, meta: false, repeat: false }

  it('an empty paste event with no key press does not paste the board’s own items, and says nothing', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    c.exec('edit.selectAll')
    c.exec('edit.copy')
    const n = c.state.doc.items.length
    const told = r.host.toasts.length
    // Chromium on Linux sends this on every middle-button release.
    for (let i = 0; i < 3; i++) await r.session.handlePaste(EMPTY, null)
    await r.timers.advance(500)
    expect(c.state.doc.items).toHaveLength(n)
    expect(r.host.toasts).toHaveLength(told)
  })

  it('and with nothing copied it is no "nothing on the clipboard" toast either', async () => {
    const r = rig(RAW)
    await r.session.handlePaste(EMPTY, null)
    expect(r.host.toasts).toEqual([])
  })

  it('after a ⌘V press the empty event is the answer to it: the board’s own items are pasted, once', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    c.exec('edit.selectAll')
    c.exec('edit.copy')
    const n = c.state.doc.items.length
    expect(r.session.key(ctrlV)).toBe(false)
    await r.session.handlePaste(EMPTY, null)
    expect(c.state.doc.items).toHaveLength(n * 2)
    await r.timers.advance(500)
    expect(c.state.doc.items).toHaveLength(n * 2)
  })

  it('an empty event that comes after the wait has ended does not paste a second time', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    c.exec('edit.selectAll')
    c.exec('edit.copy')
    const n = c.state.doc.items.length
    r.session.key(ctrlV)
    await r.timers.advance(200)
    expect(c.state.doc.items).toHaveLength(n * 2)
    await r.session.handlePaste(EMPTY, null)
    expect(c.state.doc.items).toHaveLength(n * 2)
  })

  it('a paste event that carries something is handled whether or not a key asked for it', async () => {
    const r = rig(RAW)
    const n = r.session.controller.state.doc.items.length
    await r.session.handlePaste({ files: [], uriList: '', html: '', text: 'something I copied elsewhere' }, { x: 10, y: 10 })
    expect(r.session.controller.state.doc.items).toHaveLength(n + 1)
  })
})

/* ------------------------------------------------------------------------ live-docked-m4 --- */

describe('a note that is gone is said once, not three times (live-docked-m4)', () => {
  it('a reload that finds the note gone (the host has said so) keeps quiet', async () => {
    const r = rig(RAW)
    r.host.loadError = Object.assign(new Error('The note of this board is gone from the vault'), { name: BOARD_GONE })
    r.host.fireExternal()
    await settle()
    expect(r.host.toasts).toEqual([])
    // The board is still open and still has its work.
    expect(r.session.controller.state.doc.items.length).toBeGreaterThan(0)
  })

  it('any other reason a reload cannot read the note is still told', async () => {
    const r = rig(RAW)
    r.host.loadError = new Error('permission denied')
    r.host.fireExternal()
    await settle()
    expect(r.host.toastTexts().at(-1)).toMatch(/could not be read again: permission denied/)
  })
})
