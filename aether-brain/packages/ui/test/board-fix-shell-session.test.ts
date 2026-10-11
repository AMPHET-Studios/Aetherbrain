import { describe, expect, it } from 'vitest'
import { BOARD_LIMITS, boardPictureName, parseBoard, serializeBoard, type Vec2 } from '@aether/core'
import type { KeyIn, PointerIn } from '../src/board/api'
import { pictureSize } from '../src/board/view/env'
import { MOD, isMac } from '../src/util'
import {
  FINAL_BURST_MS,
  MAX_DROP_PIXELS,
  MAX_FILE_BYTES,
  RECOVERY_KEY_PREFIX,
  SAVE_THROTTLE_MS,
  Saver,
  budgetTone,
  clearRecovery,
  formatChars,
  pasteHint,
  readRecovery,
  tooLargeMessage,
  writeRecovery,
} from '../src/board/view/session'
import { FakeTimers, MemoryStorage, NOW, boardRaw, rig, settle } from './helpers/board-view-fakes'

/**
 * Fixes of the board view's shell (the review of the reference boards): a note being typed reaches the saver, a reload that raced a
 * gesture, a held key, a copy that crosses boards, a save that failed and was left behind, a picture that claims a gigabyte.
 * The canvas is 800 by 600 CSS pixels with the board's (0, 0) in the middle.
 */

const at = (x: number, y: number): Vec2 => ({ x: x + 400, y: y + 300 })
const ptr = (v: Vec2, extra: Partial<PointerIn> = {}): PointerIn => ({
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
const key = (k: string, extra: Partial<KeyIn> = {}): KeyIn => ({ key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, down: true, shift: false, ctrl: false, alt: false, meta: false, repeat: false, ...extra })

const RAW = boardRaw('Gate', [['Boards/Gate/rust.png', 0, 0, 200, 100]], [['hello', 0, -200]])
const noteTexts = (raw: string): string[] =>
  parseBoard(raw).doc.items.flatMap((i) => (i.kind === 'note' ? [i.text] : []))

/* ------------------------------------------------------------------------ the saver --- */

function saverRig(writeMs = 25) {
  const timers = new FakeTimers()
  const state = { writes: 0, errors: [] as { first: boolean; failures: number | undefined }[], last: 0, fail: null as Error | null }
  const saver = new Saver({
    timers,
    run: async () => {
      if (writeMs) await new Promise<void>((r) => timers.set(r, writeMs))
      if (state.fail) throw state.fail
      state.writes++
    },
    onError: (_e, first, failures) => state.errors.push({ first, failures }),
    persistView: () => undefined,
    onStatus: () => undefined,
  })
  return { saver, timers, state }
}

describe('the saver: a held key', () => {
  it('90 repeats of a one-shot command in 3 seconds are written about once a second, and the last state lands', async () => {
    const r = saverRig(25)
    for (let i = 0; i < 90; i++) {
      r.saver.note({ final: true, viewOnly: false })
      await r.timers.advance(33)
    }
    // Held for 3 s: the first press at once, then the throttle - not one write for each of the 90 presses.
    expect(r.state.writes).toBeLessThanOrEqual(4)
    expect(r.state.writes).toBeGreaterThanOrEqual(2)
    // Let go: what is left is written within a second, and the board is clean.
    await r.timers.advance(SAVE_THROTTLE_MS + 100)
    expect(r.saver.dirty).toBe(false)
    expect(r.saver.running).toBe(false)
    const writes = r.state.writes
    await r.timers.advance(5000)
    expect(r.state.writes).toBe(writes)
  })

  it('the 90-event ArrowRight probe through the real session: a few saves in 3 seconds, and the last position is the one on disk', async () => {
    const r = rig(RAW)
    r.session.controller.exec('edit.selectAll')
    // A save takes 25 ms of the fake clock, as on a disk.
    r.host.saveGate = () => new Promise<void>((res) => r.timers.set(res, 25))
    const start = (parseBoard(RAW).doc.items.find((i) => i.kind === 'picture') as { x: number }).x
    for (let i = 0; i < 90; i++) {
      r.session.key(key('ArrowRight', { code: 'ArrowRight', repeat: i > 0 }))
      await r.timers.advance(33)
    }
    // Held for 3 s: the first press at once, then about one a second - not one for each of the 90 presses.
    expect(r.host.saves.length).toBeLessThanOrEqual(4)
    expect(r.host.saves.length).toBeGreaterThanOrEqual(2)
    r.session.key(key('ArrowRight', { code: 'ArrowRight', down: false }))
    await r.timers.advance(SAVE_THROTTLE_MS + 200)
    expect(r.session.saveState).toBe('saved')
    const moved = parseBoard(r.host.saves.at(-1)!).doc.items.find((i) => i.kind === 'picture') as { x: number }
    expect(moved.x).toBe(r.session.controller.state.doc.items.find((i) => i.kind === 'picture' && true)!.x)
    expect(moved.x).toBeGreaterThan(start + 80)
    expect(r.host.maxInFlight).toBe(1)
  })

  it('a command that comes after a pause is written at once, as before; the first of a burst too', async () => {
    const r = saverRig(0)
    r.saver.note({ final: true, viewOnly: false })
    await settle()
    expect(r.state.writes).toBe(1)
    await r.timers.advance(FINAL_BURST_MS + 10)
    r.saver.note({ final: true, viewOnly: false })
    await settle()
    expect(r.state.writes).toBe(2)
    // And one that follows it closely waits for the throttle instead.
    await r.timers.advance(50)
    r.saver.note({ final: true, viewOnly: false })
    await settle()
    expect(r.state.writes).toBe(2)
    await r.timers.advance(SAVE_THROTTLE_MS + 1)
    expect(r.state.writes).toBe(3)
  })

  it('flush resolves true only when nothing is unsaved', async () => {
    const r = saverRig(10)
    expect(await r.saver.flush()).toBe(true)
    r.saver.note({ final: false, viewOnly: false })
    const p = r.saver.flush()
    await r.timers.advance(10)
    expect(await p).toBe(true)
    r.state.fail = new Error('nope')
    r.saver.note({ final: true, viewOnly: false })
    await r.timers.advance(20)
    const q = r.saver.flush()
    await r.timers.advance(20)
    expect(await q).toBe(false)
    expect(r.saver.dirty).toBe(true)
  })

  it('a run of failures counts them, and retryNow tries again at once instead of at the end of the wait', async () => {
    const r = saverRig(0)
    r.state.fail = new Error('nope')
    r.saver.note({ final: true, viewOnly: false })
    await settle()
    expect(r.state.errors).toEqual([{ first: true, failures: 1 }])
    r.state.fail = null
    r.saver.retryNow()
    await settle()
    expect(r.state.writes).toBe(1)
    expect(r.saver.failing).toBe(false)
  })
})

/* ----------------------------------------------------------------- a note being typed --- */

describe('a note being typed reaches the saver without waiting for the box to lose the focus', () => {
  it('a new note: its text is written within the throttle, the indicator says unsaved meanwhile, and nothing enters the history', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    const id = c.addNoteAt({ x: 100, y: 100 })
    let text = ''
    r.session.registerEditor(id, () => text)
    text = 'typed note text that must survive'
    r.session.draftNote(id)
    expect(r.session.saveState).toBe('unsaved')
    await r.timers.advance(SAVE_THROTTLE_MS + 1)
    expect(r.host.saves).toHaveLength(1)
    expect(noteTexts(r.host.saves[0]!)).toContain('typed note text that must survive')
    expect(r.session.saveState).toBe('saved')
    // Still being typed: the box is open and there is no undo step for it.
    expect(c.state.editingNote).toBe(id)
    expect(c.state.canUndo).toBe(false)
    // More typing is written the same way.
    text += ' and more'
    r.session.draftNote(id)
    await r.timers.advance(SAVE_THROTTLE_MS + 1)
    expect(noteTexts(r.host.saves.at(-1)!)).toContain('typed note text that must survive and more')
  })

  it('an edited note: the new text is written while the old one is still the committed one', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    const note = c.state.doc.items.find((i) => i.kind === 'note')!
    c.editNote(note.id)
    r.session.registerEditor(note.id, () => 'hello, edited in the box')
    r.session.draftNote(note.id)
    await r.timers.advance(SAVE_THROTTLE_MS + 1)
    expect(noteTexts(r.host.saves.at(-1)!)).toContain('hello, edited in the box')
    expect(c.state.doc.items.find((i) => i.id === note.id)).toMatchObject({ text: 'hello' })
  })

  it('flush commits the note and resolves true with the text on disk', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    const id = c.addNoteAt({ x: 100, y: 100 })
    r.session.registerEditor(id, () => 'typed, then the window closes')
    r.session.draftNote(id)
    expect(await r.session.flush()).toBe(true)
    expect(noteTexts(r.host.raw)).toContain('typed, then the window closes')
    expect(c.state.editingNote).toBeNull()
  })

  it('typing that is then cancelled (Esc) takes the draft out of the file again', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    const id = c.addNoteAt({ x: 100, y: 100 })
    r.session.registerEditor(id, () => 'a note I will not keep')
    r.session.draftNote(id)
    await r.timers.advance(SAVE_THROTTLE_MS + 1)
    expect(noteTexts(r.host.raw)).toContain('a note I will not keep')
    c.cancelNoteEdit()
    await settle()
    expect(noteTexts(r.host.raw)).not.toContain('a note I will not keep')
    expect(noteTexts(r.host.raw)).toEqual(['hello'])
    expect(r.session.saveState).toBe('saved')
  })

  it('a text the budget would refuse is not saved as a draft, and an empty box saves nothing', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    const id = c.addNoteAt({ x: 100, y: 100 })
    let text = '   '
    r.session.registerEditor(id, () => text)
    r.session.draftNote(id)
    await r.timers.advance(SAVE_THROTTLE_MS + 1)
    expect(noteTexts(r.host.raw)).toEqual(['hello'])
    text = 'x'.repeat(BOARD_LIMITS.noteChars)
    r.session.draftNote(id)
    await r.timers.advance(SAVE_THROTTLE_MS + 1)
    expect(noteTexts(r.host.raw).some((t) => t.length === BOARD_LIMITS.noteChars)).toBe(true)
  })

  it('a picture whose shape is corrected while a new note is open never takes the empty note into the file', async () => {
    const r = rig(RAW)
    r.session.controller.addNoteAt({ x: 0, y: 100 })
    r.session.controller.setNaturalSize('Boards/Gate/rust.png', 400, 100)
    await settle()
    await r.timers.advance(1500)
    for (const raw of r.host.saves) expect(noteTexts(raw)).not.toContain('')
    r.session.controller.cancelNoteEdit()
    await settle()
    await r.timers.advance(1500)
    for (const raw of r.host.saves) expect(noteTexts(raw)).toEqual(['hello'])
    // And once the board is saved for any other reason, the file has no empty note either.
    r.session.exec('view.gray')
    await settle()
    expect(noteTexts(r.host.saves.at(-1)!)).toEqual(['hello'])
  })

  it('a flush does not claim success while a note the budget refused is still open', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    const id = c.addNoteAt({ x: 100, y: 100 })
    r.session.registerEditor(id, () => 'some text')
    // The controller refuses this commit (the board is over its budget): the box stays open.
    ;(c as unknown as { fits(): boolean }).fits = () => false
    expect(await r.session.flush()).toBe(false)
    expect(c.state.editingNote).toBe(id)
  })
})

/* ------------------------------------------------------------------------ a failed save --- */

describe('a save that failed is not dropped in silence', () => {
  it('flush says false while the last save failed', async () => {
    const r = rig()
    r.host.saveError = new Error('read-only volume')
    r.session.exec('view.gray')
    await settle()
    expect(await r.session.flush()).toBe(false)
    r.host.saveError = null
    expect(await r.session.flush()).toBe(true)
  })

  it('the error says what happened once, without a doubled full stop, and carries a way to copy the board text', async () => {
    const r = rig()
    r.host.saveError = new Error('EACCES: permission denied.')
    r.session.exec('view.gray')
    await settle()
    const t = r.host.toasts.find((x) => /could not be saved/.test(x.text))!
    expect(t.text).toBe('The board could not be saved: EACCES: permission denied. It is kept here and tried again.')
    expect(t.action?.label).toBe('Copy board text')
    t.action!.run()
    await settle()
    expect(r.host.copied).toHaveLength(1)
    expect(r.host.copied[0]).toContain('gray=1')
    expect(r.host.copied[0]).toContain('## Board')
    expect(r.host.toastTexts().at(-1)).toMatch(/Copied the board/)
  })

  it('a failure that goes on is said once more, with the same way out', async () => {
    const r = rig()
    r.host.saveError = new Error('locked by another program')
    r.session.exec('view.gray')
    await settle()
    expect(r.host.toasts.filter((t) => t.action)).toHaveLength(1)
    // Retries after 5, 10 and 20 s: the fourth failure in a row speaks again.
    await r.timers.advance(5100)
    await r.timers.advance(10_100)
    await r.timers.advance(20_100)
    const withAction = r.host.toasts.filter((t) => t.action)
    expect(withAction).toHaveLength(2)
    expect(withAction[1]!.text).toMatch(/still cannot be saved/i)
  })

  it('stop with the board still unsaved keeps a copy in the browser, tells the user, and offers the text', async () => {
    const r = rig()
    r.host.saveError = new Error('read-only volume')
    r.session.exec('view.gray')
    await settle()
    r.session.exec('view.captions')
    await settle()
    await r.session.stop()
    const kept = readRecovery(r.env.storageMap, 'Boards/Gate.md')
    expect(kept).not.toBeNull()
    expect(kept!.text).toContain('gray=1')
    expect(kept!.text).toContain('captions=1')
    const last = r.host.toasts.at(-1)!
    expect(last.text).toMatch(/closed with changes that could not be saved/)
    expect(last.tone).toBe('error')
    expect(last.action?.label).toBe('Copy board text')
    last.action!.run()
    await settle()
    expect(r.host.copied.at(-1)).toContain('captions=1')
    // The stopped session holds no timer (the status message's included).
    expect(r.timers.pending).toBe(0)
  })

  it('a view that comes back while the write of its stop is out (a strict-mode remount) keeps the session: no farewell, no timer let go', async () => {
    const r = rig()
    r.host.saveError = new Error('read-only volume')
    r.session.exec('view.gray')
    await settle()
    const before = r.host.toasts.length
    const stopping = r.session.stop()
    r.session.start()
    await stopping
    expect(r.host.toasts.slice(before).some((t) => /closed with changes/.test(t.text))).toBe(false)
    expect(readRecovery(r.env.storageMap, 'Boards/Gate.md')?.text).toContain('gray=1')
    // The retry of the failed save is still waiting, and runs when the disk comes back.
    expect(r.timers.pending).toBeGreaterThan(0)
    r.host.saveError = null
    await r.timers.advance(11_000)
    expect(r.session.saveState).toBe('saved')
    expect(parseBoard(r.host.saves.at(-1)!).doc.gray).toBe(true)
  })

  it('a clean stop keeps nothing and says nothing; a save that goes through clears the copy', async () => {
    const r = rig()
    r.host.saveError = new Error('read-only volume')
    r.session.exec('view.gray')
    await settle()
    expect(readRecovery(r.env.storageMap, 'Boards/Gate.md')).not.toBeNull()
    r.host.saveError = null
    expect(await r.session.flush()).toBe(true)
    expect(readRecovery(r.env.storageMap, 'Boards/Gate.md')).toBeNull()
    const before = r.host.toasts.length
    await r.session.stop()
    expect(r.host.toasts).toHaveLength(before)
    expect(r.env.storageMap.map.has(RECOVERY_KEY_PREFIX + 'Boards/Gate.md')).toBe(false)
  })

  it('opened again, the board offers the copy; taking it back puts the changes on the board and writes them', async () => {
    const first = rig()
    first.host.saveError = new Error('read-only volume')
    first.session.exec('view.gray')
    await settle()
    first.session.exec('view.captions')
    await settle()
    await first.session.stop()
    // The next opening of the same board in the same browser: a new session over the note as it is on disk.
    // A session that was loaded and then started finds the copy at start.
    const r = rig(first.host.raw, {}, { start: false })
    r.env.storageMap.map = new Map(first.env.storageMap.map)
    r.session.start()
    const offer = r.host.toasts.find((t) => t.action?.label === 'Recover unsaved changes')
    expect(offer).toBeDefined()
    expect(r.session.controller.state.doc.gray).toBe(false)
    offer!.action!.run()
    await settle()
    const doc = r.session.controller.state.doc
    expect(doc.gray && doc.captions).toBe(true)
    expect(r.host.saves).toHaveLength(1)
    const saved = parseBoard(r.host.saves[0]!).doc
    expect(saved.gray && saved.captions).toBe(true)
    expect(readRecovery(r.env.storageMap, 'Boards/Gate.md')).toBeNull()
  })

  it('a copy that holds nothing the note does not already have is not offered', async () => {
    const r = rig(RAW, {}, { start: false })
    writeRecovery(r.env.storageMap, 'Boards/Gate.md', RAW, 1)
    r.session.start()
    expect(r.host.toasts.some((t) => t.action?.label === 'Recover unsaved changes')).toBe(false)
    expect(readRecovery(r.env.storageMap, 'Boards/Gate.md')).toBeNull()
  })

  it('a storage that refuses is no failure: nothing is kept, the toast says so, and the way out is the copy of the text', async () => {
    const r = rig()
    r.env.storageBroken = true
    r.host.saveError = new Error('read-only volume')
    r.session.exec('view.gray')
    await settle()
    await r.session.stop()
    const last = r.host.toasts.at(-1)!
    expect(last.text).toMatch(/closed with changes that could not be saved/)
    // It does not promise a copy it could not keep.
    expect(last.text).toMatch(/no copy could be kept/)
    expect(last.text).not.toMatch(/A copy was kept here/)
    expect(last.action?.label).toBe('Copy board text')
  })

  it('the page going away keeps a copy of what is not on disk before the write is answered; what did land is forgotten at the next opening', async () => {
    const r = rig()
    // A write that never answers: the window is gone before it does.
    r.host.saveGate = () => new Promise<void>(() => undefined)
    r.session.exec('view.gray')
    await settle()
    expect(r.session.saveState).toBe('saving')
    r.session.stash()
    const kept = readRecovery(r.env.storageMap, 'Boards/Gate.md')
    expect(kept?.text).toContain('gray=1')
    // The next opening finds the note as it was (the write never landed): the copy is offered.
    const again = rig(RAW, {}, { start: false })
    again.env.storageMap.map = new Map(r.env.storageMap.map)
    again.session.start()
    expect(again.host.toasts.some((t) => t.action?.label === 'Recover unsaved changes')).toBe(true)
    // Or the write did land in main although its answer never came back: the copy is the note, and is forgotten without a word.
    const landed = rig(kept!.text, {}, { start: false })
    landed.env.storageMap.map = new Map(r.env.storageMap.map)
    landed.session.start()
    expect(landed.host.toasts.some((t) => t.action?.label === 'Recover unsaved changes')).toBe(false)
    expect(readRecovery(landed.env.storageMap, 'Boards/Gate.md')).toBeNull()
  })

  it('stash keeps nothing for a board that is saved, and commits a note being typed before it copies', async () => {
    const r = rig()
    r.session.stash()
    expect(readRecovery(r.env.storageMap, 'Boards/Gate.md')).toBeNull()
    r.host.saveGate = () => new Promise<void>(() => undefined)
    const id = r.session.controller.addNoteAt({ x: 0, y: 100 })
    r.session.registerEditor(id, () => 'typed when the window went')
    r.session.stash()
    expect(readRecovery(r.env.storageMap, 'Boards/Gate.md')?.text).toContain('» typed when the window went')
  })

  it('the stored copy: round trip, a bad value is none, a copy that is too long is not kept', () => {
    const s = new MemoryStorage()
    expect(writeRecovery(s, 'Boards/A.md', 'text', 5)).toBe(true)
    expect(readRecovery(s, 'Boards/A.md')).toEqual({ text: 'text', at: 5 })
    expect(readRecovery(s, 'Boards/B.md')).toBeNull()
    s.setItem(RECOVERY_KEY_PREFIX + 'Boards/A.md', '{"text":3}')
    expect(readRecovery(s, 'Boards/A.md')).toBeNull()
    s.setItem(RECOVERY_KEY_PREFIX + 'Boards/A.md', 'not json')
    expect(readRecovery(s, 'Boards/A.md')).toBeNull()
    expect(writeRecovery(s, 'Boards/A.md', 'x'.repeat(2_000_000), 5)).toBe(false)
    expect(writeRecovery(null, 'Boards/A.md', 'x', 5)).toBe(false)
    clearRecovery(s, 'Boards/A.md')
    clearRecovery(null, 'Boards/A.md')
    expect(s.map.size).toBe(0)
    const throwing = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    expect(writeRecovery(throwing, 'Boards/A.md', 'x', 1)).toBe(false)
  })
})

/* ------------------------------------------------------------------- the reload race --- */

describe('the note changing outside while a reload is reading it', () => {
  const OUTSIDE = RAW.replace('Reference board.', 'PROSE: OUTSIDE EDIT.')

  it('a command pressed while the read is in flight stays on the screen and in the file, beside the outside edit', async () => {
    const r = rig(RAW)
    r.host.strict = true
    const c = r.session.controller
    let release!: () => void
    r.host.loadGate = () => new Promise<void>((res) => (release = res))
    r.host.raw = OUTSIDE
    r.host.fireExternal()
    await settle()
    expect(r.host.loads).toBe(1)
    // Inside the read: a finished change, written at once from the note as it was.
    r.session.exec('view.gray')
    await settle()
    r.host.loadGate = null
    release()
    await r.timers.advance(10)
    await settle()
    expect(c.state.doc.gray).toBe(true)
    // Never a text made from the old note over the outside edit: the first save was refused, the one after it merged.
    expect(r.host.saves).toHaveLength(1)
    expect(r.host.saves[0]).toContain('PROSE: OUTSIDE EDIT.')
    expect(parseBoard(r.host.saves[0]!).doc.gray).toBe(true)
    expect(r.host.raw).toContain('PROSE: OUTSIDE EDIT.')
    expect(r.session.saveState).toBe('saved')
    expect(c.state.dirty).toBe(false)
  })

  it('the merge is written at once, not after the retry wait; the error reads with one full stop', async () => {
    const r = rig(RAW)
    r.host.strict = true
    let release!: () => void
    r.host.loadGate = () => new Promise<void>((res) => (release = res))
    r.host.raw = OUTSIDE
    r.host.fireExternal()
    await settle()
    r.session.exec('transform.rotateCw')
    r.session.exec('edit.selectAll')
    r.session.exec('transform.rotateCw')
    await settle()
    r.host.loadGate = null
    release()
    await r.timers.advance(50)
    await settle()
    // Well before the first retry would have come (RETRY_FIRST_MS): the board is saved.
    expect(r.session.saveState).toBe('saved')
    expect(r.host.saves).toHaveLength(1)
    for (const t of r.host.toastTexts()) expect(t).not.toMatch(/\.\./)
  })

  it('every save is made from the text the host last read, and says so', async () => {
    const r = rig(RAW)
    r.session.exec('view.gray')
    await settle()
    expect(r.host.bases).toEqual([RAW])
    await r.timers.advance(300)
    r.session.exec('view.gray')
    await settle()
    expect(r.host.bases[1]).toBe(r.host.saves[0])
  })

  it('a note that was blank is saved against the blank text the host gave', async () => {
    const r = rig('\n', {}, { load: false, start: false })
    r.session.loadFromRaw('\n')
    r.session.start()
    r.session.exec('view.gray')
    await settle()
    expect(r.host.bases[0]).toBe('\n')
  })

  it('an unsaved change that is still being written is not replaced by the outside board either', async () => {
    const r = rig(RAW)
    r.host.strict = true
    const c = r.session.controller
    let release!: () => void
    r.host.loadGate = () => new Promise<void>((res) => (release = res))
    r.host.raw = RAW.replace('x=0 y=0 w=200', 'x=50 y=60 w=200')
    r.host.fireExternal()
    await settle()
    r.session.exec('edit.selectAll')
    r.session.exec('transform.flipH')
    await settle()
    r.host.loadGate = null
    release()
    await r.timers.advance(50)
    await settle()
    const pic = c.state.doc.items.find((i) => i.kind === 'picture')
    // The screen still has the user's flip; the file got it too.
    expect(pic && pic.kind === 'picture' ? pic.flipH : null).toBe(true)
    expect(parseBoard(r.host.raw).doc.items.some((i) => i.kind === 'picture' && i.flipH)).toBe(true)
  })
})

describe('the note changing outside during a gesture', () => {
  const ROW = 'Reference board.'

  it('a change that leaves the board as it is does not cancel the stroke being drawn', async () => {
    const r = rig(RAW)
    r.host.strict = true
    const c = r.session.controller
    r.session.exec('tool.pen')
    r.session.pointerDown(ptr(at(-100, 100)))
    for (let i = 0; i < 15; i++) c.pointerMove(ptr(at(-100 + i * 6, 100 + i * 3)))
    expect(c.state.draft).not.toBeNull()
    r.host.raw = RAW.replace(ROW, 'Edited outside, prose only.')
    r.host.fireExternal()
    await settle()
    // Held: not read, not replaced, nothing cancelled.
    expect(c.state.draft).not.toBeNull()
    for (let i = 15; i < 30; i++) c.pointerMove(ptr(at(-100 + i * 6, 100 + i * 3)))
    c.pointerUp(ptr(at(-100 + 29 * 6, 100 + 29 * 3), { buttons: 0 }))
    await settle()
    expect(c.state.doc.items.filter((i) => i.kind === 'stroke')).toHaveLength(1)
    // The stroke was kept and written into the note as it is now, outside prose and all.
    expect(r.host.saves.at(-1)).toContain('Edited outside, prose only.')
    expect(parseBoard(r.host.saves.at(-1)!).doc.items.filter((i) => i.kind === 'stroke')).toHaveLength(1)
  })

  it('a different board waits for a pan that is held, and is taken the moment the pointer is up', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    r.session.exec('tool.hand')
    r.session.pointerDown(ptr(at(0, 0)))
    c.pointerMove(ptr(at(20, 0)))
    expect(c.state.gesturing).toBe(true)
    r.host.raw = boardRaw('Gate', [['Boards/Gate/rust.png', 50, 60, 200, 100]], [['hello', 0, -200]])
    r.host.fireExternal()
    await settle()
    const before = c.state.doc.items.find((i) => i.kind === 'picture')
    expect(before && before.kind === 'picture' ? before.x : null).toBe(0)
    c.pointerUp(ptr(at(20, 0), { buttons: 0 }))
    await settle()
    const pic = c.state.doc.items.find((i) => i.kind === 'picture')
    expect(pic && pic.kind === 'picture' ? [pic.x, pic.y] : null).toEqual([50, 60])
    expect(c.state.dirty).toBe(false)
  })

  it('a board that changed, with a stroke that was kept: the stroke wins and the user is told', async () => {
    const r = rig(RAW)
    r.host.strict = true
    const c = r.session.controller
    r.session.exec('tool.pen')
    r.session.pointerDown(ptr(at(-100, 100)))
    for (let i = 0; i < 12; i++) c.pointerMove(ptr(at(-100 + i * 8, 100)))
    r.host.raw = boardRaw('Gate', [['Boards/Gate/rust.png', 50, 60, 200, 100]], [['hello', 0, -200]])
    r.host.fireExternal()
    await settle()
    c.pointerUp(ptr(at(-100 + 11 * 8, 100), { buttons: 0 }))
    await r.timers.advance(50)
    await settle()
    expect(c.state.doc.items.filter((i) => i.kind === 'stroke')).toHaveLength(1)
    expect(r.host.toastTexts().some((t) => /changed outside/i.test(t))).toBe(true)
    expect(parseBoard(r.host.raw).doc.items.filter((i) => i.kind === 'stroke')).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ copy and paste --- */

describe('copying between boards, and the clipboard', () => {
  it('items copied in one board are pasted into another, in a session that never saw the copy', async () => {
    const a = rig(RAW)
    a.session.controller.exec('edit.selectAll')
    a.session.exec('edit.copy')
    await settle()
    const text = a.host.copied.at(-1)!
    const b = rig(boardRaw('Other'))
    expect(b.session.controller.state.doc.items).toHaveLength(0)
    await b.session.handlePaste({ files: [], uriList: '', html: '', text }, null)
    const items = b.session.controller.state.doc.items
    expect(items.map((i) => i.kind).sort()).toEqual(['note', 'picture'])
    expect(items.some((i) => i.kind === 'note' && i.text === 'hello')).toBe(true)
    expect(items.some((i) => i.kind === 'picture' && i.path === 'Boards/Gate/rust.png')).toBe(true)
    // Ids are new and the paste is one step of its own.
    expect(b.session.controller.state.canUndo).toBe(true)
  })

  it('the same copy dropped as text, or pasted with the clipboard’s own line breaks, is items too', async () => {
    const a = rig(RAW)
    a.session.controller.exec('edit.selectAll')
    a.session.exec('edit.copy')
    await settle()
    const text = a.host.copied.at(-1)!
    const b = rig(boardRaw('Other'))
    await b.session.handleTransfer({ files: [], uriList: '', html: '', text: text.replace(/\n/g, '\r\n') }, null)
    expect(b.session.controller.state.doc.items).toHaveLength(2)
  })

  it('text that says it is a copy but cannot be read back is never a note: the user is told to copy again', async () => {
    const b = rig(boardRaw('Other'))
    await b.session.handlePaste({ files: [], uriList: '', html: '', text: 'Aether Brain board: 3 items copied' }, null)
    expect(b.session.controller.state.doc.items).toHaveLength(0)
    expect(b.host.toastTexts().at(-1)).toMatch(/Copy them again/i)
    await b.session.handlePaste({ files: [], uriList: '', html: '', text: 'Aether Brain board: 3 items copied\nnot a board at all' }, null)
    expect(b.session.controller.state.doc.items.filter((i) => i.kind === 'note')).toHaveLength(0)
  })

  it('nothing selected, or only locked items: the system clipboard is left alone', async () => {
    const r = rig(RAW)
    r.session.exec('edit.copy')
    await settle()
    expect(r.host.copied).toEqual([])
    r.session.controller.exec('edit.selectAll')
    r.session.exec('edit.lock')
    r.session.exec('edit.cut')
    await settle()
    expect(r.host.copied).toEqual([])
    // A real copy still goes there, and a later empty copy does not overwrite it.
    r.session.exec('edit.unlock')
    r.session.exec('edit.copy')
    await settle()
    expect(r.host.copied).toHaveLength(1)
    r.session.controller.exec('edit.selectNone')
    r.session.exec('edit.copy')
    await settle()
    expect(r.host.copied).toHaveLength(1)
  })

  it('a clipboard write that fails leaves the session trusting nothing: the paste reads what is really on the clipboard', async () => {
    const r = rig(RAW)
    r.host.copyError = new Error('clipboard busy')
    r.session.controller.exec('edit.selectAll')
    r.session.exec('edit.copy')
    await settle()
    const n = r.session.controller.state.doc.items.length
    await r.session.handlePaste({ files: [], uriList: '', html: '', text: 'something older on the clipboard' }, null)
    expect(r.session.controller.state.doc.items).toHaveLength(n + 1)
    expect(r.session.controller.state.doc.items.at(-1)).toMatchObject({ kind: 'note', text: 'something older on the clipboard' })
  })

  it('the session’s own copy pastes from memory; a copy made since is read from the text', async () => {
    const r = rig(RAW)
    r.session.controller.exec('edit.selectAll')
    r.session.exec('edit.copy')
    await settle()
    const n = r.session.controller.state.doc.items.length
    await r.session.handlePaste({ files: [], uriList: '', html: '', text: r.host.copied.at(-1)! }, null)
    expect(r.session.controller.state.doc.items).toHaveLength(n + 2)
  })

  it('holding ⌘V does not paste again for each repeat of the key: the repeats are taken', async () => {
    const r = rig(RAW)
    r.session.controller.exec('edit.selectAll')
    r.session.exec('edit.copy')
    const n = r.session.controller.state.doc.items.length
    const paste = key('v', { ctrl: true })
    expect(r.session.key(paste)).toBe(false)
    // The browser would paste for each repeat; the board takes them (the key is consumed, so there is no paste event).
    expect(r.session.key({ ...paste, repeat: true })).toBe(true)
    expect(r.session.key({ ...paste, repeat: true })).toBe(true)
    // No paste event came for the press: the board pastes its own items, once.
    await r.timers.advance(400)
    expect(r.session.controller.state.doc.items).toHaveLength(n + 2)
  })

  it('Paste from a menu with nothing copied on the board says how to paste from the clipboard', () => {
    const r = rig(RAW)
    r.session.exec('edit.paste')
    // The hint names the platform's own modifier (⌘ on a Mac, Ctrl elsewhere).
    expect(r.host.toastTexts().at(-1)).toBe(pasteHint(isMac))
    expect(r.host.toastTexts().at(-1)).toContain(`${MOD} V`)
    expect(pasteHint(false)).toMatch(/Ctrl V/)
    expect(pasteHint(true)).toMatch(/⌘ V/)
    expect(r.session.controller.state.doc.items).toHaveLength(2)
  })
})

/* ------------------------------------------------------------ pictures and memory --- */

function pngHeader(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const v = new DataView(b.buffer)
  v.setUint32(16, w)
  v.setUint32(20, h)
  b[24] = 8
  b[25] = 2
  return b
}

function jpegSideways(w: number, h: number): Uint8Array {
  const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif]
  const sof = [0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xda, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
}

describe('the size of a picture comes from its header: nothing is decoded', () => {
  it('a PNG that claims 16000 x 16000 is read in a few bytes, whatever it would decode to', async () => {
    expect(await pictureSize(new Blob([pngHeader(16000, 16000)]))).toEqual({ w: 16000, h: 16000 })
  })

  it('a phone photo turned a quarter by its EXIF has its shown shape (width and height swapped)', async () => {
    expect(await pictureSize(new Blob([jpegSideways(4000, 3000)]))).toEqual({ w: 3000, h: 4000 })
  })

  it('only the start of the file is looked at', async () => {
    const big = new Uint8Array(3_000_000)
    big.set(pngHeader(1200, 800))
    const blob = new Blob([big])
    let sliced = -1
    const spy = { size: blob.size, slice: (a: number, b: number) => ((sliced = b - a), blob.slice(a, b)) } as unknown as Blob
    expect(await pictureSize(spy)).toEqual({ w: 1200, h: 800 })
    expect(sliced).toBeLessThanOrEqual(256 * 1024)
  })

  it('a file that is no picture, and a large one whose header cannot be read, have no size (they are not decoded)', async () => {
    expect(await pictureSize(new Blob(['just some text']))).toBeNull()
    expect(await pictureSize(new Blob([new Uint8Array(5 * 1024 * 1024)]))).toBeNull()
  })
})

describe('a dropped picture that claims more than the budget is refused with the reason', () => {
  const file = (name: string, type = 'image/png'): File => new File([name], name, { type })

  it('over 150 megapixels in its header: left out, said so in the toast; the others go in', async () => {
    const r = rig(boardRaw('Gate'))
    r.env.sizes['huge.png'] = { w: 16000, h: 16000 }
    r.env.sizes['ok.png'] = { w: 3000, h: 2000 }
    r.env.sizes['edge.png'] = { w: 12247, h: 12247 }
    await r.session.handleTransfer({ files: [file('huge.png'), file('ok.png'), file('edge.png')], uriList: '', html: '', text: '' }, null)
    const names = r.host.added.flat().map((f) => f.name)
    expect(names).toEqual(['ok.png', 'edge.png'])
    expect(r.session.controller.state.doc.items).toHaveLength(2)
    const toast = r.host.toasts.find((t) => /megapixels/.test(t.text))!
    expect(toast.text).toBe(tooLargeMessage([{ name: 'huge.png' }]))
    expect(toast.text).toContain('150 megapixels')
    expect(toast.tone).toBe('error')
    expect(MAX_DROP_PIXELS).toBe(150_000_000)
  })

  it('several of them are counted in one toast, and none of their bytes are read', async () => {
    const r = rig(boardRaw('Gate'))
    let read = 0
    const big = (name: string): File => {
      const f = file(name)
      f.arrayBuffer = async () => (read++, new ArrayBuffer(1))
      return f
    }
    r.env.sizes['a.png'] = { w: 20000, h: 20000 }
    r.env.sizes['b.png'] = { w: 30000, h: 30000 }
    await r.session.handleTransfer({ files: [big('a.png'), big('b.png')], uriList: '', html: '', text: '' }, null)
    expect(read).toBe(0)
    expect(r.host.added).toEqual([])
    expect(r.host.toastTexts().some((t) => /^2 pictures are over 150 megapixels/.test(t))).toBe(true)
  })
})

describe('a batch of pictures lands where the user can see it', () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => new File([`p${i}.png`], `p${i}.png`, { type: 'image/png' }))

  it('a big batch dropped far from the view brings the view to the pictures', async () => {
    const r = rig(boardRaw('Gate'))
    const names = files(8)
    for (const f of names) r.env.sizes[f.name] = { w: 1200, h: 800 }
    const before = r.session.controller.state.doc.view
    await r.session.handleTransfer({ files: names, uriList: '', html: '', text: '' }, { x: 9000, y: 9000 })
    const view = r.session.controller.state.doc.view
    expect(view.x).not.toBe(before.x)
    expect(Math.abs(view.x - 9000)).toBeLessThan(2000)
    const sel = r.session.controller.state.selection
    expect(sel).toHaveLength(8)
  })

  it('a small batch, and a big one that fits the view already, leave the camera alone', async () => {
    const r = rig(boardRaw('Gate'))
    const three = files(3)
    for (const f of three) r.env.sizes[f.name] = { w: 1200, h: 800 }
    const before = r.session.controller.state.doc.view
    await r.session.handleTransfer({ files: three, uriList: '', html: '', text: '' }, { x: 9000, y: 9000 })
    expect(r.session.controller.state.doc.view).toEqual(before)
    const r2 = rig(boardRaw('Gate'))
    const many = files(5)
    for (const f of many) r2.env.sizes[f.name] = { w: 100, h: 100 }
    const v2 = r2.session.controller.state.doc.view
    await r2.session.handleTransfer({ files: many, uriList: '', html: '', text: '' }, null)
    expect(r2.session.controller.state.doc.view).toEqual(v2)
  })
})

/* -------------------------------------------------------------------- small things --- */

describe('the status bar’s size cell, the export, the retry redraw', () => {
  it('characters as the bar writes them, and when it turns amber and red', () => {
    expect(formatChars(0)).toBe('0')
    expect(formatChars(812)).toBe('812')
    expect(formatChars(9_400)).toBe('9.4k')
    expect(formatChars(123_456)).toBe('123k')
    expect(formatChars(500_000)).toBe('500k')
    expect(budgetTone(100_000, 500_000)).toBe('ok')
    expect(budgetTone(449_999, 500_000)).toBe('ok')
    expect(budgetTone(450_000, 500_000)).toBe('warn')
    expect(budgetTone(500_000, 500_000)).toBe('full')
    expect(budgetTone(600_000, 500_000)).toBe('full')
  })

  it('an export whose PNG is over the vault’s limit is made again, smaller, instead of being refused', async () => {
    const r = rig(RAW)
    r.env.sizes['Boards/Gate/rust.png'] = { w: 2000, h: 1000 }
    const sizes = [MAX_FILE_BYTES + 5_000_000, 1000]
    const made: { w: number; h: number }[] = []
    r.env.canvasToPng = async (c) => {
      made.push({ w: c.width, h: c.height })
      return new Uint8Array(sizes.shift() ?? 10)
    }
    await r.session.exportItems(null, 'board')
    expect(r.host.added).toHaveLength(1)
    expect(r.host.added[0]![0]!.bytes).toBe(1000)
    expect(r.env.made).toHaveLength(2)
    expect(r.env.made[1]!.w).toBeLessThan(r.env.made[0]!.w)
    expect(r.host.toastTexts().at(-1)).toMatch(/made smaller/)
  })

  it('an export that fits is made once', async () => {
    const r = rig(RAW)
    await r.session.exportItems(null, 'board')
    expect(r.env.made).toHaveLength(1)
    expect(r.host.toastTexts().at(-1)).not.toMatch(/smaller/)
  })

  it('a picture that failed to load but is not on screen does not keep the board redrawing every 15 seconds', async () => {
    const r = rig(boardRaw('Gate', [['Boards/Gate/near.png', 0, 0, 200, 100]]))
    r.host.pictures.preview = async () => null
    r.host.pictures.original = async () => null
    const ctx = (await import('./helpers/recordingContext')).RecordingContext
    const g = new ctx()
    r.session.draw(g as never, 1)
    await r.timers.advance(10)
    await settle()
    r.session.draw(g as never, 1)
    // The picture is on screen and failed: a redraw is armed for its retry.
    expect(r.timers.waits.length).toBeGreaterThan(0)
    // Pan far away: nothing failed is drawn, and no timer is left waiting.
    r.session.controller.setView({ x: 50_000, y: 50_000, zoom: 1 })
    await r.timers.advance(20_000)
    r.session.draw(g as never, 1)
    await r.timers.advance(20_000)
    r.session.draw(g as never, 1)
    await r.timers.advance(20_000)
    expect(r.timers.waits).toEqual([])
  })

  it('boardPictureName is still what names a dropped picture', () => {
    expect(boardPictureName('shot.png', 'image/png', NOW)).toBe('shot.png')
    expect(serializeBoard).toBeTypeOf('function')
  })
})
