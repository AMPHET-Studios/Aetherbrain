import { describe, expect, it, vi } from 'vitest'
import { BOARD_LIMITS, newBoardNote, parseBoard, type Vec2 } from '@aether/core'
import type { BoardEvent, PointerIn } from '../src/board/api'
import { BoardSession } from '../src/board/view/boardSession'
import { SAVE_THROTTLE_MS, VIEW_KEY_PREFIX } from '../src/board/view/session'
import { FakeHost, NOW, boardRaw, fakeEnv, FakeTimers, FakeUi, rig, settle } from './helpers/board-view-fakes'
import { makeBitmap } from './helpers/recordingContext'

/**
 * The board session driven with a fake host, a clock that only moves when the test moves it, and a picture cache that tells what it was
 * told: first load, saving, the note changing outside, every event the controller can send, the cache's wiring, files, pastes.
 * The canvas is 800 by 600 CSS pixels with the board's (0, 0) in the middle: a board point (x, y) is the pixel (x + 400, y + 300).
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

/** One picture of 200 by 100 at the middle of the board and a note above it. */
const RAW = boardRaw('Gate', [['Boards/Gate/rust.png', 0, 0, 200, 100]], [['hello', 0, -200]])

describe('first load', () => {
  it('reads the note, builds the controller with the file’s board, and is ready', async () => {
    const r = rig(RAW, {}, { load: false })
    expect(r.session.phase).toBe('idle')
    await r.session.load()
    expect(r.session.phase).toBe('ready')
    expect(r.host.loads).toBe(1)
    const doc = r.session.controller.state.doc
    expect(doc.items.map((i) => i.kind)).toEqual(['picture', 'note'])
    expect(doc.title).toBe('Gate')
  })

  it('a note that cannot be read is a failed phase with the reason, and Try again loads it once more', async () => {
    const r = rig(RAW, {}, { load: false })
    r.host.loadError = new Error('disk gone')
    await r.session.load()
    expect(r.session.phase).toBe('failed')
    expect(r.session.error).toContain('disk gone')
    r.host.loadError = null
    await r.session.retryLoad()
    expect(r.session.phase).toBe('ready')
  })

  it('a note that is not a board is refused and never written', async () => {
    const r = rig('---\ntitle: Plain\n---\nJust prose.\n', {}, { load: false })
    await r.session.load()
    expect(r.session.phase).toBe('failed')
    expect(r.session.error).toMatch(/not a reference board/i)
    expect(r.host.saves).toEqual([])
  })

  it('an empty file is a new board with the host’s title, written as a whole board note', async () => {
    const r = rig('', {}, { load: false })
    r.host.title = 'Fresh'
    await r.session.load()
    expect(r.session.phase).toBe('ready')
    expect(r.session.controller.state.doc.title).toBe('Fresh')
    r.session.exec('view.gray')
    await r.session.flush()
    expect(r.host.saves).toHaveLength(1)
    expect(r.host.saves[0]).toContain('type: board')
    expect(r.host.saves[0]).toContain('gray=1')
  })

  it('what the reader had to say becomes one toast, once the view has started', () => {
    const raw = boardRaw().replace('## Board\n', '## Board\n- pic x=1 y=2 w=3 h=4 bogus=5\n- stroke color=zz pts=1,2\n')
    const parsed = parseBoard(raw)
    expect(parsed.warnings.length).toBeGreaterThan(0)
    const r = rig(raw, {}, { start: false })
    // Loaded but not started (a render): no toast out of a render.
    expect(r.host.toasts).toEqual([])
    r.session.start()
    expect(r.host.toasts).toHaveLength(1)
    expect(r.host.toasts[0]!.text).toContain(parsed.warnings[0]!)
    if (parsed.warnings.length > 1) expect(r.host.toasts[0]!.text).toContain(`${parsed.warnings.length - 1} more`)
  })

  it('the camera remembered in this browser wins over the file’s', () => {
    const base = fakeEnv(new FakeTimers())
    base.storageMap.setItem(VIEW_KEY_PREFIX + 'Boards/Gate.md', JSON.stringify({ x: 55, y: -66, zoom: 2 }))
    const host = new FakeHost(RAW)
    const session = new BoardSession({ host, env: base, ui: new FakeUi() })
    session.loadFromRaw(RAW)
    expect(session.controller.state.doc.view).toEqual({ x: 55, y: -66, zoom: 2 })
  })

  it('a broken or absent storage leaves the file’s camera alone', () => {
    const env = fakeEnv(new FakeTimers())
    env.storageBroken = true
    const session = new BoardSession({ host: new FakeHost(RAW), env, ui: new FakeUi() })
    session.loadFromRaw(RAW)
    expect(session.controller.state.doc.view).toEqual(parseBoard(RAW).doc.view)
    const env2 = fakeEnv(new FakeTimers())
    env2.storageMap.setItem(VIEW_KEY_PREFIX + 'Boards/Gate.md', '{not json')
    const s2 = new BoardSession({ host: new FakeHost(RAW), env: env2, ui: new FakeUi() })
    s2.loadFromRaw(RAW)
    expect(s2.controller.state.doc.view).toEqual(parseBoard(RAW).doc.view)
  })
})

describe('saving', () => {
  it('a finished change is written at once; the text is the note with its board section replaced', async () => {
    const r = rig()
    r.session.exec('view.gray')
    await settle()
    expect(r.host.saves).toHaveLength(1)
    expect(r.host.saves[0]).toContain('gray=1')
    expect(r.host.saves[0]).toContain('## Board')
    // The title and the prose around the board are still there.
    expect(r.host.saves[0]).toContain('# Gate')
    expect(r.session.saveState).toBe('saved')
    expect(r.session.controller.state.dirty).toBe(false)
  })

  it('a drag in progress is written at most once a second, the end of it at once', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    r.session.pointerDown(ptr(at(0, 0)))
    for (let i = 1; i <= 10; i++) c.pointerMove(ptr(at(i * 5, 0)))
    await settle()
    expect(r.host.saves).toHaveLength(0)
    expect(r.session.saveState).toBe('unsaved')
    await r.timers.advance(999)
    expect(r.host.saves).toHaveLength(0)
    await r.timers.advance(2)
    expect(r.host.saves).toHaveLength(1)
    // Still dragging: the next write waits for the next second.
    c.pointerMove(ptr(at(80, 0)))
    await settle()
    expect(r.host.saves).toHaveLength(1)
    c.pointerUp(ptr(at(80, 0), { buttons: 0 }))
    await settle()
    expect(r.host.saves).toHaveLength(2)
    const x = parseBoard(r.host.saves[1]!).doc.items[0]
    expect(x && x.kind === 'picture' ? x.x : null).toBe(80)
    expect(r.session.saveState).toBe('saved')
  })

  it('a pan or zoom never writes the file; the camera goes to the browser’s storage a moment later', async () => {
    const r = rig()
    r.session.controller.wheel({ x: 400, y: 300, deltaX: 0, deltaY: -120, deltaMode: 0, ctrl: false, shift: false, alt: false })
    await r.timers.advance(5000)
    expect(r.host.saves).toEqual([])
    const stored = JSON.parse(r.env.storageMap.getItem(VIEW_KEY_PREFIX + 'Boards/Gate.md')!)
    expect(stored.zoom).toBeGreaterThan(1)
    expect(r.session.saveState).toBe('saved')
  })

  it('nothing is written when the board comes out as the text it was read from', async () => {
    const r = rig(RAW)
    r.session.exec('view.gray')
    await settle()
    // A second command this soon after the first would ride the burst throttle: a person's next command is seconds away.
    await r.timers.advance(300)
    r.session.exec('view.gray')
    await settle()
    // Back to the original board: the second write is the original text, which differs from the first, so it is written; a third no-op is not.
    expect(r.host.saves).toHaveLength(2)
    expect(r.host.saves[1]!.replace(/updated: .*/, '')).toBe(RAW.replace(/updated: .*/, ''))
    const before = r.host.saves.length
    r.session.controller.markSaved()
    await r.session.flush()
    expect(r.host.saves).toHaveLength(before)
  })

  it('writes run one at a time: a change that arrives during a write is written after it', async () => {
    const r = rig()
    let release!: () => void
    r.host.saveGate = () => new Promise<void>((res) => (release = res))
    r.session.exec('view.gray')
    await settle()
    expect(r.host.inFlight).toBe(1)
    r.session.exec('view.captions')
    r.session.exec('view.smooth')
    await settle()
    expect(r.host.inFlight).toBe(1)
    r.host.saveGate = null
    release()
    // Commands that follow each other within a quarter of a second are one burst: the rest of it is written at the throttle.
    await r.timers.advance(SAVE_THROTTLE_MS + 1)
    expect(r.host.maxInFlight).toBe(1)
    expect(r.host.saves).toHaveLength(2)
    const last = parseBoard(r.host.saves[1]!).doc
    expect(last.gray && last.captions && !last.smooth).toBe(true)
    expect(r.session.saveState).toBe('saved')
  })

  it('a failed write keeps the board unsaved, tells the user once, retries later, and flush tries at once', async () => {
    const r = rig()
    r.host.saveError = new Error('read-only volume')
    r.session.exec('view.gray')
    await settle()
    expect(r.session.saveState).toBe('failed')
    expect(r.host.toastTexts().filter((t) => /could not be saved/.test(t))).toHaveLength(1)
    expect(r.host.toasts.at(-1)!.tone).toBe('error')
    // A retry runs by itself (and says nothing more).
    await r.timers.advance(5100)
    expect(r.host.toastTexts().filter((t) => /could not be saved/.test(t))).toHaveLength(1)
    r.host.saveError = null
    await r.session.flush()
    expect(r.host.saves).toHaveLength(1)
    expect(r.session.saveState).toBe('saved')
    expect(r.session.controller.state.dirty).toBe(false)
  })

  it('stop flushes a pending write before it lets go, and a stopped view holds no timer', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    r.session.pointerDown(ptr(at(0, 0)))
    c.pointerMove(ptr(at(30, 0)))
    expect(r.timers.pending).toBeGreaterThan(0)
    await r.session.stop()
    expect(r.host.saves).toHaveLength(1)
    expect(r.timers.pending).toBe(0)
    expect(r.host.externalSubs.size).toBe(0)
    expect(r.host.pictureSubs.size).toBe(0)
  })

  it('start and stop may alternate (a strict-mode remount): the second start wires everything again', async () => {
    const r = rig()
    await r.session.stop()
    expect(r.host.externalSubs.size).toBe(0)
    r.session.start()
    expect(r.host.externalSubs.size).toBe(1)
    expect(r.host.pictureSubs.size).toBe(1)
    r.session.exec('view.gray')
    await settle()
    expect(r.host.saves).toHaveLength(1)
    expect(r.caches).toHaveLength(2)
    expect(r.caches[0]!.disposes).toBe(1)
  })
})

describe('the note changing outside', () => {
  it('without local changes the board is reloaded, keeping the camera and the selection by id', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    c.exec('edit.selectAll')
    c.wheel({ x: 400, y: 300, deltaX: 0, deltaY: -120, deltaMode: 0, ctrl: false, shift: false, alt: false })
    const view = c.state.doc.view
    r.host.raw = boardRaw('Gate', [['Boards/Gate/rust.png', 50, 60, 200, 100]], [['hello', 0, -200]])
    r.host.fireExternal()
    await settle()
    expect(r.host.loads).toBe(1)
    const doc = c.state.doc
    expect(doc.view).toEqual(view)
    const pic = doc.items.find((i) => i.kind === 'picture')
    expect(pic && pic.kind === 'picture' ? [pic.x, pic.y] : null).toEqual([50, 60])
    // The selection stays on the items that are exactly what they were (the picture moved, the note did not).
    expect(c.state.selection.length).toBe(1)
    expect(c.state.dirty).toBe(false)
    expect(r.host.toastTexts()).toEqual([])
  })

  it('with unsaved local changes ours are kept, the user is told, and our next save is merged into the new text', async () => {
    const r = rig(RAW)
    // Like the real hosts, which refuse a save made from a text that is no longer the note's.
    r.host.strict = true
    const c = r.session.controller
    r.session.pointerDown(ptr(at(0, 0)))
    c.pointerMove(ptr(at(30, 0)))
    const outside = RAW.replace('Reference board.', 'Written by hand outside.')
    r.host.raw = outside
    r.host.fireExternal()
    await settle()
    // The drag is held: the outside change waits for it (see board-fix-shell-session.test.ts), the drag is not touched.
    const pic = c.state.doc.items.find((i) => i.kind === 'picture')
    expect(pic && pic.kind === 'picture' ? pic.x : null).toBe(30)
    c.pointerUp(ptr(at(30, 0), { buttons: 0 }))
    await settle()
    expect(r.host.toastTexts().some((t) => /changed outside/i.test(t))).toBe(true)
    expect(r.host.saves).toHaveLength(1)
    expect(r.host.saves[0]).toContain('Written by hand outside.')
    expect(parseBoard(r.host.saves[0]!).doc.items.some((i) => i.kind === 'picture' && i.x === 30)).toBe(true)
  })

  it('a note being typed is not thrown away when the file changes: the typing goes on and is saved into the new text', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    const id = c.addNoteAt({ x: 100, y: 100 })
    r.session.registerEditor(id, () => 'half a thought')
    r.host.raw = RAW.replace('Reference board.', 'Edited outside.')
    r.host.fireExternal()
    await settle()
    expect(c.state.editingNote).toBe(id)
    expect(r.host.toastTexts().some((t) => /changed outside/i.test(t))).toBe(true)
    r.session.commitEditing()
    await settle()
    expect(r.host.saves).toHaveLength(1)
    expect(r.host.saves[0]).toContain('half a thought')
    expect(r.host.saves[0]).toContain('Edited outside.')
  })

  it('the echo of our own write is not an outside change', async () => {
    const r = rig()
    r.session.exec('view.gray')
    await settle()
    const loadsBefore = r.host.loads
    r.host.fireExternal()
    await settle()
    expect(r.host.loads).toBe(loadsBefore + 1)
    expect(r.host.toasts.filter((t) => /outside/i.test(t.text))).toEqual([])
    expect(r.session.controller.state.doc.gray).toBe(true)
  })

  it('a note that can no longer be read keeps the board as it is and says so', async () => {
    const r = rig()
    r.host.loadError = new Error('not a board any more')
    r.host.fireExternal()
    await settle()
    expect(r.host.toastTexts().some((t) => t.includes('not a board any more'))).toBe(true)
    expect(r.session.phase).toBe('ready')
  })
})

describe('events from the controller', () => {
  it('toast: shown by the host, remembered for the status bar for a few seconds', async () => {
    const r = rig(RAW)
    r.session.handleEvent({ type: 'toast', text: 'Copied 1 item.', tone: 'info' })
    expect(r.host.toasts.at(-1)).toEqual({ text: 'Copied 1 item.', tone: 'info' })
    expect(r.session.lastMessage).toEqual({ text: 'Copied 1 item.', tone: 'info' })
    await r.timers.advance(8100)
    expect(r.session.lastMessage).toBeNull()
  })

  it('sample-request: the pixel under the pointer is read from the canvas and handed back; a click copies it', async () => {
    const r = rig(RAW)
    const seen: Vec2[] = []
    r.session.setSurface({
      readPixel: (p) => {
        seen.push(p)
        return 'c0ffee'
      },
    })
    const c = r.session.controller
    c.exec('tool.sampler')
    r.session.pointerDown(ptr({ x: 120, y: 80 }))
    expect(seen).toEqual([{ x: 120, y: 80 }])
    expect(c.state.sample).toEqual({ x: 120, y: 80, hex: 'c0ffee' })
    c.pointerUp(ptr({ x: 120, y: 80 }, { buttons: 0 }))
    await settle()
    expect(r.host.copied).toEqual(['#c0ffee'])
    expect(r.host.toastTexts().at(-1)).toBe('Copied #c0ffee')
  })

  it('sample-request off the canvas gives nothing; sample-commit survives a clipboard that refuses', async () => {
    const r = rig(RAW)
    r.session.setSurface({ readPixel: () => null })
    const c = r.session.controller
    c.exec('tool.sampler')
    r.session.pointerDown(ptr({ x: 5, y: 5 }))
    expect(c.state.sample).toBeNull()
    r.host.copyError = new Error('no clipboard')
    r.session.handleEvent({ type: 'sample-commit', hex: 'abcdef' })
    await settle()
    expect(r.host.toasts.at(-1)).toEqual({ text: 'Could not copy #abcdef: no clipboard', tone: 'error' })
  })

  it('palette-request: the selected pictures are read small, the colours found become swatch notes beside them', async () => {
    const r = rig(RAW)
    // Two bitmaps' worth of pixels: red and blue halves.
    const px = new Uint8ClampedArray(64 * 4)
    for (let i = 0; i < 64; i++) px.set(i < 32 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4)
    r.env.pixels['rust'] = px
    const bitmap = makeBitmap(256, 128, 'rust')
    // The cache has no bitmap (the picture is not drawn): the session loads a small preview of its own and closes it.
    const created: unknown[] = []
    const session = new BoardSession({
      host: r.host,
      env: { ...r.env, createBitmap: async () => (created.push(bitmap), bitmap) },
      ui: r.ui,
    })
    session.loadFromRaw(RAW)
    session.start()
    session.controller.exec('edit.selectAll')
    const before = session.controller.state.doc.items.length
    session.controller.exec('picture.palette')
    await settle()
    expect(r.host.previews).toContain('Boards/Gate/rust.png')
    expect(bitmap.closed).toBe(true)
    const doc = session.controller.state.doc
    const swatches = doc.items.slice(before)
    expect(swatches.length).toBeGreaterThanOrEqual(2)
    expect(swatches.every((s) => s.kind === 'note' && /^#[0-9a-f]{6}$/.test(s.text))).toBe(true)
    expect(swatches.map((s) => (s.kind === 'note' ? s.fill : ''))).toEqual(expect.arrayContaining(['ff0000', '0000ff']))
    expect(session.activity).toBeNull()
  })

  it('palette-request with pictures that cannot be read says so and adds nothing', async () => {
    const r = rig(RAW)
    r.session.controller.exec('edit.selectAll')
    const n = r.session.controller.state.doc.items.length
    r.env.pixels = {}
    r.session.controller.exec('picture.palette')
    await settle()
    expect(r.session.controller.state.doc.items).toHaveLength(n)
    expect(r.host.toasts.at(-1)!.tone).toBe('error')
  })

  it('command picture.add opens the picker, arrange.menu the Arrange menu, view.hideUi toggles the bars', () => {
    const r = rig(RAW)
    r.session.controller.exec('picture.add')
    r.session.controller.exec('arrange.menu')
    r.session.controller.exec('view.hideUi')
    expect(r.ui.calls).toEqual(['picker', 'menu:arrange', 'hide'])
  })

  it('commands picture.open / reveal / showInBrain go to the host with the selected pictures’ paths', () => {
    const r = rig(boardRaw('Gate', [['a/one.png', 0, 0, 100, 100], ['a/two.png', 300, 0, 100, 100]]))
    r.session.controller.exec('edit.selectAll')
    r.session.controller.exec('picture.open')
    r.session.controller.exec('picture.reveal')
    r.session.controller.exec('picture.showInBrain')
    expect(r.host.opens).toEqual(['a/one.png', 'a/two.png'])
    expect(r.host.reveals).toEqual(['a/one.png'])
    expect(r.host.brains).toEqual(['a/one.png'])
  })

  it('opening many pictures is capped, and a host without a picture program says so', () => {
    const many = Array.from({ length: 8 }, (_, i): [string, number, number, number, number] => [`p${i}.png`, i * 120, 0, 100, 100])
    const r = rig(boardRaw('Gate', many))
    r.session.controller.exec('edit.selectAll')
    r.session.controller.exec('picture.open')
    expect(r.host.opens).toHaveLength(5)
    expect(r.host.toastTexts().at(-1)).toMatch(/first 5 of 8/)
    const bare = rig(RAW, { open: false, reveal: false, showInBrain: false })
    bare.session.controller.exec('edit.selectAll')
    bare.session.controller.exec('picture.open')
    bare.session.controller.exec('picture.reveal')
    bare.session.controller.exec('picture.showInBrain')
    expect(bare.host.toasts).toHaveLength(3)
  })

  it('command picture.info: the card for one picture, a message for several', () => {
    const r = rig(boardRaw('Gate', [['a/one.png', 0, 0, 100, 100], ['a/two.png', 300, 0, 100, 100]]))
    const [one, two] = r.session.controller.state.doc.items
    r.session.controller.exec('edit.selectAll')
    r.session.controller.exec('picture.info')
    expect(r.ui.infos).toEqual([])
    expect(r.host.toastTexts().at(-1)).toMatch(/one picture/i)
    // Selecting one picture by clicking it.
    r.session.pointerDown(ptr(at(0, 0)))
    r.session.controller.pointerUp(ptr(at(0, 0), { buttons: 0 }))
    r.session.controller.exec('picture.info')
    expect(r.ui.infos).toEqual([one!.id])
    expect(two!.id).not.toBe(one!.id)
    const info = r.session.pictureInfo(one!.id)!
    expect(info).toMatchObject({ name: 'one.png', path: 'a/one.png', type: 'PNG', shown: { w: 100, h: 100 }, natural: null })
  })

  it('window commands drive the host’s window; without one they say what is needed', () => {
    const r = rig(RAW, { window: true })
    r.session.controller.exec('window.popOut')
    r.session.controller.exec('window.onTop')
    expect(r.host.window!.calls).toEqual(['popOut', 'onTop:false'])
    r.host.window!.floating = true
    r.session.controller.exec('window.dock')
    r.session.controller.exec('window.popOut')
    expect(r.host.window!.calls).toEqual(['popOut', 'onTop:false', 'dock'])
    const bare = rig(RAW)
    bare.session.controller.exec('window.popOut')
    bare.session.controller.exec('window.onTop')
    expect(bare.host.toasts).toHaveLength(2)
  })

  it('export.board draws the whole board, saves the PNG in the board’s folder under a dated name, and says so', async () => {
    const r = rig(RAW)
    const bitmap = makeBitmap(400, 200, 'full')
    const session = new BoardSession({ host: r.host, env: { ...r.env, createBitmap: async () => bitmap }, ui: r.ui })
    session.loadFromRaw(RAW)
    session.start()
    session.controller.exec('export.board')
    await settle()
    expect(r.host.added).toHaveLength(1)
    expect(r.host.added[0]![0]!.name).toBe('Gate export 2026-10-09 143512.png')
    expect(r.host.added[0]![0]!.bytes).toBe(r.env.pngs[0]!.length)
    expect(r.host.toastTexts().at(-1)).toBe("Saved Gate export 2026-10-09 143512.png in the board's folder")
    // The original was decoded for the export and given back.
    expect(bitmap.closed).toBe(true)
    expect(r.env.canvases[0]!.width).toBe(0)
    expect(session.activity).toBeNull()
  })

  it('export.selection draws only the selection; nothing selected is the controller’s own message', async () => {
    const r = rig(RAW)
    r.session.controller.exec('export.selection')
    expect(r.host.toastTexts().at(-1)).toMatch(/select something/i)
    r.session.controller.exec('edit.selectAll')
    r.session.controller.exec('export.selection')
    await settle()
    expect(r.host.added).toHaveLength(1)
  })

  it('an export reads the pictures’ own sizes first, so that it is made at their detail', async () => {
    const raw = boardRaw('Gate', [['Boards/Gate/rust.png', 0, 0, 200, 100]])
    const r = rig(raw)
    r.env.sizes['Boards/Gate/rust.png'] = { w: 800, h: 400 }
    r.session.controller.exec('export.board')
    await settle()
    expect(r.host.originals).toContain('Boards/Gate/rust.png')
    // 800 pixels over 200 units: four pixels a unit, so 800 by 400.
    expect(r.env.made).toEqual([{ w: 800, h: 400 }])
    expect(r.session.naturalOf('Boards/Gate/rust.png')).toEqual({ w: 800, h: 400 })
  })

  it('an export the vault refuses, and one that throws, are errors', async () => {
    const r = rig(RAW)
    r.host.addRefuse.add('Gate export 2026-10-09 143512.png')
    r.session.controller.exec('export.board')
    await settle()
    expect(r.host.toasts.at(-1)!.tone).toBe('error')
    r.host.addError = new Error('vault is read-only')
    r.session.controller.exec('export.board')
    await settle()
    expect(r.host.toastTexts().at(-1)).toContain('vault is read-only')
    expect(r.session.activity).toBeNull()
  })

  it('every event type the controller can send is handled', () => {
    const r = rig(RAW)
    const types: BoardEvent['type'][] = ['toast', 'sample-request', 'sample-commit', 'palette-request', 'command']
    const events: BoardEvent[] = [
      { type: 'toast', text: 'x', tone: 'info' },
      { type: 'sample-request', at: { x: 1, y: 1 } },
      { type: 'sample-commit', hex: '000000' },
      { type: 'palette-request', ids: [], near: { x: 0, y: 0 } },
      { type: 'command', id: 'view.hideUi', ids: [], paths: [] },
    ]
    expect(events.map((e) => e.type).sort()).toEqual([...types].sort())
    for (const e of events) expect(() => r.session.handleEvent(e)).not.toThrow()
  })
})

describe('the picture cache', () => {
  it('draw tells the cache which pictures are in view, and only those', () => {
    const raw = boardRaw('Gate', [
      ['in.png', 0, 0, 100, 100],
      ['far.png', 9000, 9000, 100, 100],
    ])
    const r = rig(raw)
    const ctx = new (class {
      calls = 0
    })()
    void ctx
    drawOnce(r)
    expect(r.cache().visibles.at(-1)).toEqual(['in.png'])
  })

  it('a picture’s own size, once the cache knows it, is fed to the controller once', () => {
    const r = rig(boardRaw('Gate', [['in.png', 0, 0, 200, 100]]))
    const spy = vi.spyOn(r.session.controller, 'setNaturalSize')
    const bitmap = makeBitmap(300, 300, 'sq')
    const cache = r.cache()
    // The loader hands the cache a bitmap and the picture's size; wait for it by hand.
    cache.options.load = async () => ({ bitmap, natural: { w: 300, h: 300 } })
    drawOnce(r)
    return settle().then(() => {
      drawOnce(r)
      drawOnce(r)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('in.png', 300, 300)
      // The picture took its real shape.
      const pic = r.session.controller.state.doc.items[0]!
      expect(pic.kind === 'picture' ? Math.round((pic.w / pic.h) * 100) : 0).toBe(100)
    })
  })

  it('a picture that came back, or went, is forgotten by the cache; one that did not change is left alone', () => {
    const r = rig(
      boardRaw('Gate', [
        ['stays.png', 0, 0, 100, 100],
        ['goes.png', 200, 0, 100, 100],
        ['comes.png', -200, 0, 100, 100],
      ]),
    )
    r.host.present = new Set(['stays.png', 'goes.png'])
    r.host.firePictures()
    expect(r.cache().forgets).toEqual(['comes.png'])
    r.cache().forgets.length = 0
    r.host.present = new Set(['stays.png', 'comes.png'])
    r.host.firePictures()
    expect(r.cache().forgets.sort()).toEqual(['comes.png', 'goes.png'])
    // Nothing flipped, nothing forgotten.
    r.cache().forgets.length = 0
    r.host.firePictures()
    expect(r.cache().forgets).toEqual([])
    expect(r.session.missingPictures()).toEqual({ count: 1, sample: ['goes.png'] })
  })

  it('missing pictures are counted, named, and never removed from the board', () => {
    const r = rig(boardRaw('Gate', [['a/x.png', 0, 0, 100, 100], ['a/y.png', 200, 0, 100, 100]]))
    r.host.present = new Set(['a/x.png'])
    r.host.firePictures()
    expect(r.session.missingPictures()).toEqual({ count: 1, sample: ['y.png'] })
    expect(r.session.controller.state.doc.items).toHaveLength(2)
  })

  it('a failed picture is drawn again when its retry is due, and the cache is disposed with the view', async () => {
    const r = rig(boardRaw('Gate', [['bad.png', 0, 0, 100, 100]]))
    r.cache().options.load = async () => null
    const frames = vi.fn()
    r.session.onFrameNeeded(frames)
    drawOnce(r)
    await settle()
    drawOnce(r)
    expect(r.cache().stats().failed).toBe(1)
    const waits = r.timers.waits
    expect(waits.some((w) => w === 15_000)).toBe(true)
    frames.mockClear()
    await r.timers.advance(15_001)
    expect(frames).toHaveBeenCalled()
    await r.session.stop()
    expect(r.cache().disposes).toBe(1)
  })
})

function drawOnce(r: ReturnType<typeof rig>): void {
  // A context that draws nothing: the renderer's own tests cover what it draws.
  const noop = new Proxy(
    {},
    {
      get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 10 }) : prop === 'filter' ? 'none' : () => undefined),
      set: () => true,
      has: () => true,
    },
  )
  r.session.draw(noop as never, 1)
}

describe('keys and clipboard', () => {
  it('⌘V is the browser’s: the key is not consumed; with no paste event the board pastes its own items after a moment', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    c.exec('edit.selectAll')
    c.exec('edit.copy')
    const n = c.state.doc.items.length
    const key = { key: 'v', code: 'KeyV', down: true, shift: false, ctrl: true, alt: false, meta: false, repeat: false }
    expect(r.session.key(key)).toBe(false)
    expect(c.state.doc.items).toHaveLength(n)
    await r.timers.advance(200)
    expect(c.state.doc.items).toHaveLength(n * 2)
  })

  it('a paste event cancels that wait: a picture on the clipboard is added instead of the board’s own items', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    c.exec('edit.selectAll')
    c.exec('edit.copy')
    const n = c.state.doc.items.length
    r.env.sizes['shot.png'] = { w: 300, h: 200 }
    r.session.key({ key: 'v', code: 'KeyV', down: true, shift: false, ctrl: true, alt: false, meta: false, repeat: false })
    await r.session.handlePaste({ files: [new File(['shot.png'], 'shot.png', { type: 'image/png' })], uriList: '', html: '', text: '' }, null)
    await r.timers.advance(500)
    expect(c.state.doc.items).toHaveLength(n + 1)
    expect(c.state.doc.items.filter((i) => i.kind === 'picture')).toHaveLength(2)
  })

  it('a copy of the board’s items leaves a self-describing copy on the system clipboard; a paste carrying it pastes the items, other text becomes a note', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    c.exec('edit.selectAll')
    r.session.exec('edit.copy')
    await settle()
    const copy = r.host.copied.at(-1)!
    // A line a person can read, then the items as a small board note: any board, window or session can read them back.
    expect(copy.startsWith('Aether Brain board: 2 items copied\n')).toBe(true)
    expect(copy).toContain('## Board')
    const n = c.state.doc.items.length
    await r.session.handlePaste({ files: [], uriList: '', html: '', text: copy }, null)
    expect(c.state.doc.items).toHaveLength(n + 2)
    await r.session.handlePaste({ files: [], uriList: '', html: '', text: 'something I copied elsewhere' }, { x: 10, y: 10 })
    expect(c.state.doc.items).toHaveLength(n + 3)
    const note = c.state.doc.items.at(-1)!
    expect(note.kind === 'note' ? note.text : '').toBe('something I copied elsewhere')
  })

  it('an empty clipboard with nothing of the board’s own to paste says so', async () => {
    const r = rig(RAW)
    await r.session.handlePaste({ files: [], uriList: '', html: '', text: '' }, null)
    expect(r.host.toastTexts().at(-1)).toMatch(/nothing on the clipboard/i)
  })

  it('a key the board uses is consumed; Space is held until it is released', () => {
    const r = rig(RAW)
    const k = (key: string, down: boolean, extra = {}) => ({ key, code: key === ' ' ? 'Space' : `Key${key.toUpperCase()}`, down, shift: false, ctrl: false, alt: false, meta: false, repeat: false, ...extra })
    expect(r.session.key(k('p', true))).toBe(true)
    expect(r.session.controller.state.tool).toBe('pen')
    expect(r.session.key(k('F9', true, { code: 'F9' }))).toBe(false)
    expect(r.session.key(k(' ', true))).toBe(true)
    expect(r.session.key(k(' ', false))).toBe(true)
  })
})

describe('drops and pastes of pictures and text', () => {
  const file = (name: string, type = 'image/png', size?: number): File => {
    const f = new File([name], name, { type })
    if (size !== undefined) Object.defineProperty(f, 'size', { value: size })
    return f
  }

  it('dropped pictures are named, saved in the board’s folder and put on the board together around the drop point', async () => {
    const r = rig(RAW)
    r.env.sizes['gate.png'] = { w: 800, h: 600 }
    r.env.sizes['rust.jpg'] = { w: 400, h: 400 }
    const before = r.session.controller.state.doc.items.length
    const result = await r.session.handleTransfer(
      { files: [file('gate.png'), file('rust.jpg', 'image/jpeg'), file('image.png')], uriList: '', html: '', text: '' },
      { x: 1000, y: 1000 },
    )
    expect(result).toBe('handled')
    r.env.sizes['image.png'] = { w: 10, h: 10 }
    // "image.png" has no known size: it is unreadable and left out, the others are in.
    const doc = r.session.controller.state.doc
    const pics = doc.items.slice(before)
    expect(pics).toHaveLength(2)
    expect(r.host.added[0]!.map((f) => f.name)).toEqual(['gate.png', 'rust.jpg'])
    expect(pics.map((p) => (p.kind === 'picture' ? p.path : ''))).toEqual(['Boards/Gate/gate.png', 'Boards/Gate/rust.jpg'])
    const cx = pics.reduce((s, p) => s + (p.kind === 'picture' ? p.x : 0), 0) / pics.length
    expect(Math.abs(cx - 1000)).toBeLessThan(400)
    expect(r.host.toastTexts().some((t) => /could not be read/.test(t))).toBe(true)
    expect(r.session.controller.state.selection).toHaveLength(2)
    expect(r.session.activity).toBeNull()
  })

  it('a pasted screenshot named image.png is named by the clock; names come from boardPictureName', async () => {
    const r = rig(RAW)
    r.env.sizes['image.png'] = { w: 50, h: 50 }
    await r.session.handleTransfer({ files: [file('image.png')], uriList: '', html: '', text: '' }, null)
    expect(r.host.added[0]![0]!.name).toBe('ref 2026-10-09 143512.png')
  })

  it('only pictures: other files are refused with the reason, pictures among them still go in', async () => {
    const r = rig(RAW)
    r.env.sizes['a.png'] = { w: 20, h: 20 }
    await r.session.handleTransfer({ files: [file('notes.txt', 'text/plain'), file('a.png'), file('movie.mp4', 'video/mp4')], uriList: '', html: '', text: '' }, null)
    expect(r.host.toastTexts()).toContain('Only pictures can go on a board (png, jpg, webp, gif, bmp, avif).')
    expect(r.host.added[0]).toHaveLength(1)
    const only = await r.session.handleTransfer({ files: [file('notes.txt', 'text/plain')], uriList: '', html: '', text: '' }, null)
    expect(only).toBe('handled')
    expect(r.host.added).toHaveLength(1)
  })

  it('at most 40 files a drop (the rest are told of), none over 40 MB is read', async () => {
    const r = rig(RAW)
    const files = Array.from({ length: 45 }, (_, i) => file(`f${i}.png`))
    for (const f of files) r.env.sizes[f.name] = { w: 10, h: 10 }
    await r.session.handleTransfer({ files, uriList: '', html: '', text: '' }, null)
    const names = r.host.added.flat().map((f) => f.name)
    expect(names).toHaveLength(40)
    expect(names[39]).toBe('f39.png')
    expect(r.host.toastTexts().some((t) => /first 40 pictures; 5 more/.test(t))).toBe(true)
    const big = file('huge.png', 'image/png', 41 * 1024 * 1024)
    r.env.sizes['huge.png'] = { w: 10, h: 10 }
    r.host.added.length = 0
    await r.session.handleTransfer({ files: [big], uriList: '', html: '', text: '' }, null)
    expect(r.host.added).toEqual([])
    expect(r.env.decodes).not.toContain('huge.png')
    expect(r.host.toastTexts().some((t) => /huge\.png is bigger than 40 MB/.test(t))).toBe(true)
  })

  it('files are saved in chunks, so a drop is never read into memory whole', async () => {
    const r = rig(RAW)
    const files = Array.from({ length: 20 }, (_, i) => file(`c${i}.png`))
    for (const f of files) r.env.sizes[f.name] = { w: 10, h: 10 }
    await r.session.handleTransfer({ files, uriList: '', html: '', text: '' }, null)
    expect(r.host.added.map((a) => a.length)).toEqual([8, 8, 4])
    expect(r.session.controller.state.doc.items.filter((i) => i.kind === 'picture')).toHaveLength(21)
  })

  it('files the vault refuses are counted and the rest still go in', async () => {
    const r = rig(RAW)
    r.env.sizes['ok.png'] = { w: 10, h: 10 }
    r.env.sizes['no.png'] = { w: 10, h: 10 }
    r.host.addRefuse.add('no.png')
    await r.session.handleTransfer({ files: [file('ok.png'), file('no.png')], uriList: '', html: '', text: '' }, null)
    expect(r.host.toastTexts().some((t) => /refused 1 picture/.test(t))).toBe(true)
    expect(r.session.controller.state.doc.items.filter((i) => i.kind === 'picture')).toHaveLength(2)
  })

  it('an address with no file is refused because the app makes no network requests', async () => {
    const r = rig(RAW)
    const n = r.session.controller.state.doc.items.length
    expect(await r.session.handleTransfer({ files: [], uriList: 'https://example.com/a.png', html: '', text: 'https://example.com/a.png' }, null)).toBe('handled')
    expect(await r.session.handleTransfer({ files: [], uriList: '', html: '<img src="https://x/y.png">', text: '' }, null)).toBe('handled')
    expect(r.session.controller.state.doc.items).toHaveLength(n)
    expect(r.host.toastTexts().filter((t) => /no network requests/.test(t))).toHaveLength(2)
  })

  it('plain text becomes a note at the drop point', async () => {
    const r = rig(RAW)
    await r.session.handleTransfer({ files: [], uriList: '', html: '', text: 'first line\nsecond line' }, { x: 300, y: 300 })
    const note = r.session.controller.state.doc.items.at(-1)!
    expect(note.kind).toBe('note')
    expect(note.kind === 'note' ? note.text : '').toBe('first line\nsecond line')
    expect(note.kind === 'note' ? note.x : 0).toBeGreaterThan(300)
    expect(r.session.controller.state.editingNote).toBeNull()
  })

  it('text longer than a note can hold is cut and the user is told', async () => {
    const r = rig(RAW)
    await r.session.handleTransfer({ files: [], uriList: '', html: '', text: 'x'.repeat(BOARD_LIMITS.noteChars + 500) }, null)
    const note = r.session.controller.state.doc.items.at(-1)!
    expect(note.kind === 'note' ? note.text.length : 0).toBe(BOARD_LIMITS.noteChars)
    expect(r.host.toastTexts().some((t) => /longer than a note/.test(t))).toBe(true)
  })

  it('a host that fails to save the pictures leaves the board as it was', async () => {
    const r = rig(RAW)
    r.env.sizes['a.png'] = { w: 10, h: 10 }
    r.host.addError = new Error('disk full')
    const n = r.session.controller.state.doc.items.length
    await r.session.handleTransfer({ files: [file('a.png')], uriList: '', html: '', text: '' }, null)
    expect(r.session.controller.state.doc.items).toHaveLength(n)
    expect(r.host.toastTexts().some((t) => /disk full/.test(t))).toBe(true)
  })

  it('pictures chosen in the picker: the shape comes from a preview at once, a big picture’s real size is read in the background', async () => {
    const r = rig(RAW)
    r.env.sizes['preview:big.jpg'] = { w: 1024, h: 683 }
    r.env.sizes['big.jpg'] = { w: 6000, h: 4000 }
    r.env.sizes['preview:small.png'] = { w: 300, h: 200 }
    const before = r.session.controller.state.doc.items.length
    await r.session.addVaultPictures(['big.jpg', 'small.png'])
    const added = r.session.controller.state.doc.items.slice(before)
    expect(added.map((i) => (i.kind === 'picture' ? i.path : ''))).toEqual(['big.jpg', 'small.png'])
    // The small one's preview is the picture itself: no background read for it.
    await r.session.settled()
    expect(r.host.originals).toEqual(['big.jpg'])
    expect(r.session.controller.naturalSize('big.jpg')).toEqual({ w: 6000, h: 4000 })
    expect(r.session.naturalOf('big.jpg')).toEqual({ w: 6000, h: 4000 })
    expect(r.session.naturalOf('small.png')).toEqual({ w: 300, h: 200 })
    // And the shape is the real one, to 1%.
    const big = r.session.controller.state.doc.items.find((i) => i.kind === 'picture' && i.path === 'big.jpg')!
    expect(big.kind === 'picture' ? Math.abs(big.w / big.h - 1.5) < 0.015 : false).toBe(true)
  })

  it('a picker add with nothing to read in the background does not stop the next one from reading', async () => {
    const r = rig(RAW)
    r.env.sizes['preview:small.png'] = { w: 300, h: 200 }
    r.env.sizes['preview:big.jpg'] = { w: 1024, h: 683 }
    r.env.sizes['big.jpg'] = { w: 6000, h: 4000 }
    await r.session.addVaultPictures(['small.png'])
    await r.session.settled()
    expect(r.host.originals).toEqual([])
    await r.session.addVaultPictures(['big.jpg'])
    await r.session.settled()
    expect(r.host.originals).toEqual(['big.jpg'])
    expect(r.session.naturalOf('big.jpg')).toEqual({ w: 6000, h: 4000 })
  })

  it('a preview that cannot be read still puts the picture on the board (a square until its size is known)', async () => {
    const r = rig(RAW)
    const before = r.session.controller.state.doc.items.length
    await r.session.addVaultPictures(['nothing-known.png'])
    expect(r.session.controller.state.doc.items).toHaveLength(before + 1)
  })
})

describe('commit before forwarding', () => {
  it('a press on the canvas commits the note being typed first, and then acts', () => {
    const r = rig(RAW)
    const c = r.session.controller
    const id = c.addNoteAt({ x: 100, y: 100 })
    expect(c.state.editingNote).toBe(id)
    r.session.registerEditor(id, () => 'typed text')
    r.session.pointerDown(ptr({ x: 700, y: 500 }))
    expect(c.state.editingNote).toBeNull()
    const note = c.state.doc.items.find((i) => i.id === id)
    expect(note && note.kind === 'note' ? note.text : null).toBe('typed text')
  })

  it('a command commits it first as well; a box that was never read (not mounted yet) cancels the new note', () => {
    const r = rig(RAW)
    const c = r.session.controller
    const id = c.addNoteAt({ x: 100, y: 100 })
    r.session.registerEditor(id, () => 'abc')
    r.session.exec('view.gray')
    expect(c.state.doc.items.find((i) => i.id === id && i.kind === 'note')).toBeTruthy()
    const id2 = c.addNoteAt({ x: 200, y: 100 })
    r.session.exec('view.captions')
    expect(c.state.doc.items.find((i) => i.id === id2)).toBeUndefined()
  })

  it('stopping the view while a note is open keeps what was typed and saves it', async () => {
    const r = rig(RAW)
    const c = r.session.controller
    const id = c.addNoteAt({ x: 100, y: 100 })
    r.session.registerEditor(id, () => 'kept on close')
    await r.session.stop()
    expect(r.host.saves).toHaveLength(1)
    expect(r.host.saves[0]).toContain('kept on close')
  })
})

describe('a picture’s info', () => {
  it('names the file, the vault path, the sizes and the type', () => {
    const r = rig(boardRaw('Gate', [['Art/Concept/gate rust.WebP', 0, 0, 300, 150]]))
    const id = r.session.controller.state.doc.items[0]!.id
    expect(r.session.pictureInfo(id)).toMatchObject({ name: 'gate rust.WebP', path: 'Art/Concept/gate rust.WebP', type: 'WEBP', shown: { w: 300, h: 150 }, natural: null })
    expect(r.session.pictureInfo(9999)).toBeNull()
    void NOW
    void newBoardNote
  })
})
