import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, idFromPath, parseBoard, type VaultFile } from '@aether/core'
import type { PointerIn } from '../src/board/api'
import { BoardSession } from '../src/board/view/boardSession'
import { assetFiles, freshApp, vaultFiles } from './board-integration-harness'
import { FakeTimers, FakeUi, fakeEnv, settle } from './helpers/board-view-fakes'

/**
 * Round 2 of the reference board's review, the session over the REAL docked host and the real store (a fake host has no stale flag):
 * a save and a reload that cross during a gesture (live-docked-3), and a board whose note is deleted while it is open (live-docked-m4).
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const PATH = 'Boards/Gate reference.md'
const PROSE = 'Reference board.'
const OUTSIDE = 'Edited outside, prose only.'

const vault = (files: VaultFile[] = vaultFiles()) => new MemoryVaultAdapter(files, { assets: assetFiles() })
const at = (x: number, y: number) => ({ x: x + 400, y: y + 300 })
const ptr = (v: { x: number; y: number }, extra: Partial<PointerIn> = {}): PointerIn => ({
  id: 1,
  x: v.x,
  y: v.y,
  button: 0,
  buttons: 1,
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
  pointerType: 'mouse',
  pressure: 0.5,
  time: 0,
  ...extra,
})

async function opened() {
  const app = await freshApp()
  const v = await app.open(vault())
  const host = app.hostModule.createDockedBoardHost(PATH)
  const timers = new FakeTimers()
  const env = fakeEnv(timers)
  const session = new BoardSession({ host, env, ui: new FakeUi() })
  await session.load()
  expect(session.phase).toBe('ready')
  session.start()
  const toasts = () => app.s().toasts.map((t) => t.text)
  return { app, v, host, timers, env, session, toasts }
}

const pictureXs = (raw: string | null): number[] => parseBoard(raw ?? '').doc.items.flatMap((i) => (i.kind === 'picture' ? [i.x] : []))

/* -------------------------------------------------------------------------- live-docked-3 --- */

describe('a save and a reload that cross do not leave the board "Not saved" for twenty seconds (live-docked-3)', () => {
  it('the note changes outside during a drag: at the release the board is saved at once, the move and the outside edit both on disk', async () => {
    const r = await opened()
    const c = r.session.controller
    expect(pictureXs(await r.v.read(PATH))).toEqual([0, 450])
    // A drag on the first picture.
    r.session.pointerDown(ptr(at(0, 0)))
    for (let i = 1; i <= 6; i++) c.pointerMove(ptr(at(i * 5, 0)))
    expect(c.state.gesturing).toBe(true)
    await r.timers.advance(400)
    // Somebody else writes the note while it is held: the board hears of it and waits for the gesture to end.
    await r.v.write(PATH, (await r.v.read(PATH))!.replace(PROSE, OUTSIDE))
    await settle()
    for (let i = 7; i <= 9; i++) c.pointerMove(ptr(at(i * 5, 0)))
    // The throttled save of the held gesture is refused (its base is the note as it was).
    await r.timers.advance(800)
    c.pointerUp(ptr(at(45, 0), { buttons: 0 }))
    await settle()

    // No timer was moved: the old board sat in 'failed' with its retry 20 seconds away.
    expect(r.session.saveState).toBe('saved')
    const disk = await r.v.read(PATH)
    expect(disk).toContain(OUTSIDE)
    expect(pictureXs(disk)[0]).toBeGreaterThan(30)
    // The board did not contradict itself: the "kept and tried again" message may come, the error that says reload does not stay.
    expect(r.toasts().filter((t) => /Reload the board/.test(t))).toEqual([])
  })

  it('the note changes outside while the reload\'s read is in flight and a one-shot command lands: saved at once', async () => {
    const r = await opened()
    await r.v.write(PATH, (await r.v.read(PATH))!.replace(PROSE, OUTSIDE))
    // The change is in flight; the board's own change (all grey) is made now, from the old text.
    r.session.exec('view.gray')
    await settle()
    expect(r.session.saveState).toBe('saved')
    const disk = await r.v.read(PATH)
    expect(disk).toContain(OUTSIDE)
    expect(parseBoard(disk!).doc.gray).toBe(true)
  })

  it('a save is still refused for a note that changed after the board read it, and the refusal asks for a reload (the stale flag is not gone)', async () => {
    const r = await opened()
    const base = (await r.v.read(PATH))!
    const theirs = base.replace(PROSE, OUTSIDE)
    await r.v.write(PATH, theirs)
    // A save made from the text the board read is refused: nothing is written over the outside edit.
    const err = await r.host.save(base.replace('gray=0', 'gray=1'), base).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(r.app.hostModule.BoardChangedOutsideError)
    expect(await r.v.read(PATH)).toBe(theirs)
    // ... and so is every other one, until the note has been read again.
    await expect(r.host.save(base.replace('gray=0', 'gray=1'), base)).rejects.toThrow(/changed outside/)
    expect(await r.host.load()).toBe(theirs)
    await r.host.save(theirs.replace('gray=0', 'gray=1'), theirs)
    expect(await r.v.read(PATH)).toContain('gray=1')
  })
})

/* ------------------------------------------------------------------------- live-docked-m4 --- */

describe('a board whose note is deleted says so once (live-docked-m4)', () => {
  it('the reload that follows the deletion is silent: no "could not open", no "could not be read again"', async () => {
    const r = await opened()
    // The Boards view says it ("was deleted or moved outside the app"); the board itself must not add two more of its own.
    await r.v.remove(PATH)
    await settle()
    expect(r.app.s().notes.has(idFromPath(PATH))).toBe(false)
    const said = r.toasts().concat(r.session.lastMessage ? [r.session.lastMessage.text] : [])
    expect(said.filter((t) => /Could not open the board|could not be read again|is not in the vault/.test(t))).toEqual([])
    // The board is still open and has its pictures.
    expect(r.session.controller.state.doc.items.filter((i) => i.kind === 'picture')).toHaveLength(2)
  })

  it('the host says the note is gone with a name the session knows; opening a board that is not there still says why', async () => {
    const r = await opened()
    await r.v.remove(PATH)
    await settle()
    const err = await r.host.load().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('BoardGoneError')
    // A board that was never open: the first read is the store's, with its own message.
    const fresh = r.app.hostModule.createDockedBoardHost('Boards/Nowhere.md')
    await expect(fresh.load()).rejects.toThrow(/not a board, is gone/)
    expect(r.toasts().some((t) => /Could not open the board: Boards\/Nowhere\.md is not in the vault/.test(t))).toBe(true)
  })
})
