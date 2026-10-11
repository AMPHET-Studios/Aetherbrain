import { readFileSync, readdirSync, statSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, NOTE_TYPES, SearchIndex, addNote, addPicture, emptyBoard, parseBoard, parseNote, serializeBoard } from '@aether/core'
import type { BoardHost } from '../src/board/api'
import type { BoardWindowControl, BoardWindowStatus } from '../src/board/active'
import { MAX_DROP_PIXELS, FINAL_BURST_MS, SAVE_THROTTLE_MS, Saver, tooLargeMessage } from '../src/board/view/session'
import { assetFiles, freshApp, vaultFiles } from './board-integration-harness'
import { Rig, threeThings } from './board-controller-harness'
import { FakeTimers, settle } from './helpers/board-view-fakes'

/**
 * Round 2 of the reference board's review, the documents (integration agent). The guide, the design, the spec and CLAUDE.md said things
 * the code does not do (undo kept after an outside change, "written back as it was", the board running on to the next heading, a card
 * in the app after a pop-out from the list, `board:save` accepting an empty note, a vault of 70 notes, a NoteType without `board` ...).
 * Each claim now written down is pinned here to the code it describes, and the old sentence is pinned absent, so a change to either
 * side fails a test instead of leaving a document that lies.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

afterEach(() => {
  vi.doUnmock('../src/board/BoardView')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const root = (p: string) => new URL(`../../../${p}`, import.meta.url)
const read = (p: string) => readFileSync(root(p), 'utf8')
const guide = read('docs/REFERENCE-BOARD.md')
const design = read('docs/design/reference-board.md')
const spec = read('docs/SPEC.md')
const claude = read('CLAUDE.md')
const keyboard = read('docs/KEYBOARD.md')
/** A document with its line breaks folded away, so a sentence is found wherever the lines were cut. */
const flat = (text: string) => text.replace(/\s+/g, ' ')
const guideText = flat(guide)
const designText = flat(design)
const specText = flat(spec)
const claudeText = flat(claude)

const NOW = new Date(2026, 9, 10, 9, 0, 0)
const HEAD = '---\ntitle: T\ntype: board\n---\n# T\n\n'
const roundTrip = (raw: string) => {
  const { doc, warnings } = parseBoard(raw)
  return { out: serializeBoard(doc, raw, NOW), warnings }
}

/* ------------------------------------------------------- live-docked-m1: undo after an outside change --- */

describe('an outside change restarts the undo history (live-docked-m1)', () => {
  it('a different board takes the undo steps away; the same board (an echo) keeps them', () => {
    const { doc } = threeThings()
    const r = new Rig(doc)
    r.c.exec('view.gray')
    expect(r.s.canUndo).toBe(true)
    // The echo of this board: nothing changes, the steps stay.
    r.c.replaceDoc(JSON.parse(JSON.stringify(r.doc)))
    expect(r.s.canUndo).toBe(true)
    // Another program changed a picture: the history starts again from that board.
    r.c.replaceDoc({ ...r.doc, items: r.doc.items.map((i) => (i.kind === 'picture' && i.id === 1 ? { ...i, x: i.x + 500 } : i)) })
    expect(r.s.canUndo).toBe(false)
  })

  it('the documents say so, and no longer say the steps are kept', () => {
    expect(guideText).toContain('undo starts again from that board, so the steps before it are gone')
    expect(guideText).not.toContain('(your undo steps are kept)')
    expect(designText).toContain('starts the history again from it')
    expect(designText).not.toContain('keeps the history and, where the ids line up')
    expect(specText).toContain('the undo history starts again from it')
    expect(specText).not.toContain('replaces the one on screen (history kept)')
  })
})

/* ---------------------------------------- live-docked-m2, diff-core-m5: what a save does to the board's lines --- */

describe('what a save does to the lines of the board (live-docked-m2, diff-core-m5)', () => {
  it('rewrites every item line: unknown attributes and flags are kept, but after the known ones', () => {
    const raw = `${HEAD}## Board\n\n- view x=0\n- note theme=dark x=0 y=0 w=300 pinned » hi\n- stroke theme=dark color=ff0000 width=2 pts=1,2 3,4\n`
    const { out } = roundTrip(raw)
    expect(out).toContain('- note x=0 y=0 w=300 size=18 color=ffffff fill= r=0 theme=dark pinned » hi\n')
    expect(out).toContain('- stroke color=ff0000 width=2 theme=dark pts=1,2 3,4\n')
    expect(out).not.toBe(raw)
  })

  it('drops a token markdown could read, with a warning, and keeps a plain one with its warning', () => {
    const raw = `${HEAD}## Board\n\n- view x=0\n- note x=0 y=0 source=my_file ref=a/b w=300 theme=dark » z\n`
    const { out, warnings } = roundTrip(raw)
    expect(out).toContain('- note x=0 y=0 w=300 size=18 color=ffffff fill= r=0 theme=dark » z\n')
    expect(out).not.toContain('my_file')
    expect(out).not.toContain('a/b')
    expect(warnings.some((w) => /source is not a plain name and was dropped/.test(w))).toBe(true)
    expect(warnings.some((w) => /ref is not a plain name and was dropped/.test(w))).toBe(true)
  })

  it('a rectangle or ellipse with no fill gains an empty fill=', () => {
    const raw = `${HEAD}## Board\n\n- view x=0\n- rect x1=0 y1=0 x2=10 y2=10 color=ffffff width=2\n- ellipse x1=0 y1=0 x2=10 y2=10 color=ffffff width=2 pinned\n`
    const { out } = roundTrip(raw)
    expect(out).toContain('- rect x1=0 y1=0 x2=10 y2=10 color=ffffff width=2 fill=\n')
    expect(out).toContain('- ellipse x1=0 y1=0 x2=10 y2=10 color=ffffff width=2 fill= pinned\n')
  })

  it('the board ends at its last item line: the text after it, a heading and a list after that included, is byte for byte', () => {
    const tail = '\nAfter the board.\r\n\n## Next\n\n- note x=9 y=9 » not mine\n- line 3 is a remark\n'
    const raw = `${HEAD}## Board\n\n- view x=0\n- note x=1 y=2 w=300 » a\n${tail}`
    const { out } = roundTrip(raw)
    expect(out.endsWith(tail)).toBe(true)
    // A heading right under the last item is not eaten either.
    const close = `${HEAD}## Board\n\n- view x=0\n- note x=1 y=1 w=300 » a\n## Next\n\ntext\n`
    expect(roundTrip(close).out.endsWith('## Next\n\ntext\n')).toBe(true)
  })

  it('prose between the heading and the first item, and between items, is kept but written right after the last item, without its blank lines', () => {
    const raw = `${HEAD}## Board\n\nSome thoughts.\n\n- view x=0 y=0 zoom=1\n- note x=1 y=2 w=300 » a\n\nMiddle remark.\n\n- note x=5 y=5 w=300 » b\n\nAfter the board.\n`
    const { out, warnings } = roundTrip(raw)
    expect(warnings).toEqual([])
    const body = out.slice(out.indexOf('## Board'))
    expect(body).toBe(
      '## Board\n\n- view x=0 y=0 zoom=1 bg=14161d gray=0 smooth=1 captions=0 grid=0\n' +
        '- note x=1 y=2 w=300 size=18 color=ffffff fill= r=0 » a\n' +
        '- note x=5 y=5 w=300 size=18 color=ffffff fill= r=0 » b\n' +
        'Some thoughts.\nMiddle remark.\n\nAfter the board.\n',
    )
    // A second save changes nothing: what was moved is now where it stays.
    expect(roundTrip(out).out).toBe(out)
  })

  it('a bullet of the user\'s that starts with a kind word, after a blank line, stays theirs (the guide says so)', () => {
    const raw = `${HEAD}## Board\n\n- view x=0\n- note x=1 y=1 w=300 » a\n\n- note the colours of the gate\n`
    const { out } = roundTrip(raw)
    expect(out.endsWith('\n\n- note the colours of the gate\n')).toBe(true)
  })

  it('the guide, the design, the spec and CLAUDE.md say what happens, and not what did not', () => {
    for (const text of [guideText, designText, specText, claudeText]) {
      expect(text).toContain('last item line')
      expect(text).not.toContain('up to the next heading of level 1 or 2, belong to the board')
    }
    expect(guideText).toContain('A save rewrites every line of the board, not only the ones you changed.')
    expect(guideText).toContain('an empty `fill=`')
    expect(guideText).toContain('between the heading and the first item, or between items')
    expect(guideText).toContain('`source=my_file` or `ref=a/b`')
    expect(guideText).not.toContain('writes it back as it was')
    expect(designText).not.toContain('and written back as it was, with a warning')
    expect(designText).toContain('KEPT_TOKEN')
    expect(designText).toContain('without their blank lines')
    expect(specText).toContain('without their blank lines')
    expect(claudeText).toContain('rewritten from the model on every save')
  })
})

/* ----------------------------------------------------------------- diff-app-m4: when a gesture is written --- */

describe('a gesture that follows a final change closely is written within the second (diff-app-m4)', () => {
  it('is 250 ms and one second in the code, as the guide says (a quarter of a second, within the second)', () => {
    expect(FINAL_BURST_MS).toBe(250)
    expect(SAVE_THROTTLE_MS).toBe(1000)
    expect(guideText).toContain('within a quarter of a second of the previous finished one')
    expect(guideText).toContain('is not written at once but within the second')
    expect(guideText).toContain('only a crash, a kill or a power cut inside that second can lose the last gesture')
    expect(specText).toContain('within 250 ms of the previous final change')
    expect(designText).toContain('`FINAL_BURST_MS` = 250 ms')
    expect(claudeText).toContain('within 250 ms of the previous final change')
  })

  it('the first final change is written at once, the second 100 ms later waits for the throttle', async () => {
    const timers = new FakeTimers()
    const runs: number[] = []
    const saver = new Saver({
      timers,
      run: async () => {
        runs.push(timers.t)
      },
      onError: () => undefined,
      persistView: () => undefined,
      onStatus: () => undefined,
    })
    const start = timers.t
    saver.note({ final: true, viewOnly: false })
    await settle()
    expect(runs).toEqual([start])
    await timers.advance(100)
    saver.note({ final: true, viewOnly: false })
    await settle()
    expect(runs).toEqual([start])
    await timers.advance(SAVE_THROTTLE_MS)
    expect(runs).toHaveLength(2)
    expect(runs[1]! - start).toBeLessThanOrEqual(SAVE_THROTTLE_MS + 100)
    // A final change after a pause is written at once again.
    await timers.advance(2 * FINAL_BURST_MS)
    saver.note({ final: true, viewOnly: false })
    await settle()
    expect(runs).toHaveLength(3)
  })
})

/* ------------------------------------------------------ live-window-m5: the card after a pop-out from the list --- */

describe('the card "This board is open in its window" (live-window-m5)', () => {
  function fakeControl(status: Partial<BoardWindowStatus>): BoardWindowControl {
    const full: BoardWindowStatus = { open: false, path: null, alwaysOnTop: true, opacity: 1, supportsOpacity: true, ...status }
    return {
      available: true,
      status: () => full,
      subscribe: () => () => undefined,
      popOut: async () => true,
      dock: async () => undefined,
      setAlwaysOnTop: async () => undefined,
      setOpacity: async () => undefined,
      onReturned: () => () => undefined,
      setFlush: () => () => undefined,
    }
  }

  it('the list shows no card for a board that is in its window; opening that board shows it', async () => {
    const app = await freshApp()
    vi.doMock('../src/board/BoardView', async () => {
      const { createElement } = await import('react')
      return { BoardView: (props: { host: BoardHost }) => createElement('div', { 'data-board-view': props.host.path }) }
    })
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const view = await import('../src/board/BoardsView')
    const html = () => {
      Object.assign(app.useAether.getInitialState(), app.useAether.getState())
      return renderToStaticMarkup(createElement(view.BoardsView))
    }
    await app.open(new MemoryVaultAdapter(vaultFiles(), { assets: assetFiles() }))
    app.active.setBoardWindowControl(fakeControl({ open: true, path: 'Boards/Armour.md' }))
    // The list, with the window holding Armour: a card per board, the pop-out button on each, and no card of the window.
    app.s().setView('boards')
    const list = html()
    expect(list).toContain('aria-label="Open Armour in its own window"')
    expect(list).not.toContain('open in its window')
    expect(list).not.toContain('Bring it back')
    // Open it from the list: now the card is there.
    app.s().openBoard('Boards/Armour.md')
    expect(html()).toContain('This board is open in its window')
    expect(html()).toContain('Bring it back')
    expect(guideText).toContain("When you pop out from a card's ⧉ in the list, the list stays as it was and shows no card; open that card and the same *This board is open in its window* card is there.")
    expect(guideText).not.toContain('then opens in its window and the app shows a card')
  })
})

/* ------------------------------------------------------- live-docked-m3: the limits for pictures, spelled out --- */

describe('the limits for pictures (live-docked-m3, live-docked-1)', () => {
  it('a drop over 150 megapixels is refused with a message that says so', () => {
    expect(MAX_DROP_PIXELS).toBe(150_000_000)
    expect(tooLargeMessage([{ name: 'giant.png' }])).toBe('giant.png is over 150 megapixels, so it was left out: a picture that large takes gigabytes of memory to show.')
    expect(guideText).toContain('refused with a message (*… is over 150 megapixels, so it was left out*)')
    expect(guideText).toContain('A picture that claims more than 150 megapixels is refused with a message and is not copied')
  })

  it('the table says too large to show for a vaulted picture over either limit, in both hosts, and what the web build does', () => {
    expect(guideText).toContain('Up to 150 megapixels and 64 MiB. A picture over either that is in the vault already')
    expect(guideText).toContain('in the app and in the floating window alike')
    expect(guideText).toContain('On the web build a file over 64 MiB says *can\'t be read*')
    expect(guideText).toContain('only a drop or a paste is checked at the door')
  })

  it('names the file ceilings of a note and a stroke, which are the code\'s', async () => {
    const { BOARD_LIMITS } = await import('@aether/core')
    expect(BOARD_LIMITS.noteCharsFile).toBe(100_000)
    expect(BOARD_LIMITS.strokePointsFile).toBe(50_000)
    expect(guideText).toContain('up to 100,000 characters')
    expect(guideText).toContain('keeps up to 50,000 points')
    expect(specText).toContain('100,000 characters')
    expect(designText).toContain('100,000 characters')
  })
})

/* ------------------------------------------------------ diff-app-m1: where the app remembers a board's state --- */

describe('the camera and the copy of an unsaved board are kept per host key (diff-app-m1)', () => {
  it('the docked host keys them by the vault\'s location and the path; the floating host has no key, so its state is per path', async () => {
    const app = await freshApp()
    await app.open(new MemoryVaultAdapter(vaultFiles(), { assets: assetFiles() }))
    const key = app.hostModule.createDockedBoardHost('Boards/Armour.md').stateKey
    expect(key).toBe(`${app.s().adapter?.location ?? ''}\nBoards/Armour.md`)
    // The floating host (apps/desktop) is not loaded here: its source is the evidence. If it gets a key, the documents change.
    const floating = readFileSync(root('apps/desktop/src/renderer/board-host.ts'), 'utf8')
    expect(floating).not.toMatch(/\bstateKey\b/)
    expect(guideText).toContain('for the docked view under the vault\'s folder and the note\'s path')
    expect(guideText).toContain('for the floating window under the note\'s path alone')
    expect(guideText).toContain('Recover unsaved changes')
    expect(designText).toContain('The docked host only: the floating host has none')
    expect(specText).toContain('the floating host has none and keeps them per note path')
    expect(guideText).not.toContain('in this browser')
  })
})

/* -------------------------------------------- diff-app-m5: Add to board while the board is in its window --- */

describe('Add to board does not touch a board that is in its window (diff-app-m5)', () => {
  it('adds nothing and says why; the guide says so', async () => {
    const app = await freshApp()
    const v = await app.open(new MemoryVaultAdapter(vaultFiles(), { assets: assetFiles() }))
    app.active.setBoardWindowControl({
      available: true,
      status: () => ({ open: true, path: 'Boards/Armour.md', alwaysOnTop: true, opacity: 1, supportsOpacity: true }),
      subscribe: () => () => undefined,
      popOut: async () => true,
      dock: async () => undefined,
      setAlwaysOnTop: async () => undefined,
      setOpacity: async () => undefined,
      onReturned: () => () => undefined,
      setFlush: () => () => undefined,
    })
    const before = await v.read('Boards/Armour.md')
    expect(await app.s().addPicturesToBoard(['Art/sky.png'], 'Boards/Armour.md')).toBe(0)
    expect(await v.read('Boards/Armour.md')).toBe(before)
    expect(app.s().toasts.at(-1)?.text).toMatch(/Armour is open in its own window: bring it back to the app first, or add pictures in the window \(the \+ button\)/)
    expect(guideText).toContain('it must not be open in its floating window: the app says so and adds nothing')
  })
})

/* ------------------------------------------------- diff-app-m5: board:save and the window's load, in the design --- */

describe('the design says what board:save accepts and how the window loads (diff-app-m5)', () => {
  it('an existing plain board note only; the page reads with board:read', () => {
    expect(designText).toContain('an existing, plain (not a link) file whose head already says `type: board` (a missing, empty or ordinary note is refused')
    expect(designText).not.toContain('whose current file (or empty) is a board note')
    expect(designText).toContain('loads with `board:read`')
    expect(designText).not.toContain('loads with `readFile`')
  })
})

/* ------------------------------------------------------ app-regression-m7: numbers and unions in the spec --- */

describe('the spec matches the code (app-regression-m7)', () => {
  it('its NoteType union is the code\'s, `board` included', () => {
    const line = /type NoteType = ([^\n]+)/.exec(spec)?.[1]
    expect(line).toBeDefined()
    const named = [...line!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!)
    expect(named).toEqual([...NOTE_TYPES])
    expect(named).toContain('board')
  })

  it('says how many notes the demo vault has, and it is that many', () => {
    const count = (dir: string): number =>
      readdirSync(dir).reduce((n, name) => {
        const p = `${dir}/${name}`
        return n + (statSync(p).isDirectory() ? count(p) : name.endsWith('.md') ? 1 : 0)
      }, 0)
    const real = count(new URL('../../../vault-demo', import.meta.url).pathname)
    expect(spec).toContain(`vault-demo     ${real} richly linked starter notes`)
    expect(claude).toContain(`vault-demo        ${real} richly linked starter notes`)
  })
})

/* ------------------------------------------------------------- search finds what is written on a board --- */

describe('search finds the words written on a board (diff-core-m1, as the guide says)', () => {
  it('a note and a caption are found; the guide says so', () => {
    let doc = emptyBoard('Gate reference')
    doc = addNote(doc, { text: 'unicornmarker rust patina', x: 0, y: 0 }).doc
    doc = addPicture(doc, { path: 'Boards/Gate reference/gate.png', w: 400, h: 300, caption: 'captionmarker lintel' }).doc
    const note = parseNote({ path: 'Boards/Gate reference.md', content: serializeBoard(doc, undefined, NOW) })
    const index = new SearchIndex()
    index.rebuild([note])
    expect(index.search('unicornmarker').map((h) => h.id)).toEqual(['Boards/Gate reference'])
    expect(index.search('captionmarker').map((h) => h.id)).toEqual(['Boards/Gate reference'])
    expect(guideText).toContain('search finds it (and the words you wrote on it, in notes and picture captions)')
    expect(specText).toContain('is search text and counts as words, never as links or tags')
  })
})

/* ------------------------------------- diff-app-1, live-window-m2: what the floating window's page may name --- */

describe('the floating window reads and saves only the board it shows (diff-app-1, live-window-m2)', () => {
  it('the wiring is in main.ts and the host: pageRefusal in front of board:read, board:save and vault:reveal', () => {
    const main = read('apps/desktop/src/main/main.ts')
    const host = read('apps/desktop/src/main/board-window.ts')
    expect(main).toContain('= guardIpc(')
    expect(main).toContain('board?.pageRefusal(channel, args)')
    expect(host).toContain('The board window reads and saves only the board it shows')
    expect(host).toMatch(/case IPC\.boardRead:\s*case IPC\.boardSave:/)
    expect(host).toMatch(/case IPC\.reveal:/)
  })

  it('the window has a menu of its own with Close on Ctrl W and no browser chords', async () => {
    const { boardMenuTemplate, isPageZoomChord } = await import('../../../apps/desktop/src/main/board-window')
    const template = boardMenuTemplate(() => undefined)
    const close = template.flatMap((m) => (Array.isArray(m.submenu) ? m.submenu : [])).find((i) => i.label === 'Close')
    expect(close?.accelerator).toBe('CmdOrCtrl+W')
    const roles = template.flatMap((m) => (Array.isArray(m.submenu) ? m.submenu : [])).map((i) => String(i.role ?? ''))
    for (const browser of ['reload', 'forceReload', 'toggleDevTools', 'togglefullscreen', 'zoomIn', 'zoomOut', 'resetZoom']) expect(roles).not.toContain(browser)
    expect(isPageZoomChord({ type: 'keyDown', key: '-', control: true })).toBe(true)
    expect(isPageZoomChord({ type: 'keyDown', key: '=', meta: true })).toBe(true)
    expect(isPageZoomChord({ type: 'keyDown', key: 'z', control: true })).toBe(false)
  })

  it('the guide, the design, the spec and CLAUDE.md say so, and the old claim is gone', () => {
    expect(guideText).toContain('reading and saving **the one board note it shows**, and no other note, another board included')
    expect(guideText).toContain('showing a picture, a video or its own board in the file manager, never a note or a folder')
    expect(guideText).toContain('The window is not a browser')
    expect(guideText).not.toContain('reading and saving a note that is a board, a note that is not one is refused')
    expect(designText).toContain('`board:read` and `board:save` only for the path the window shows')
    expect(specText).toContain('not even other boards')
    expect(claudeText).toContain('`board:read` and `board:save` are answered only for the one board the window shows')
    expect(claudeText).toContain('`vault:reveal` only for a picture, a video or that board')
  })
})

/* ------------------------------------------------------------ the rest of the round: what the guide now says --- */

describe('the guide says what the other fixes of the round did', () => {
  it('the middle button never pastes, F2 and Enter need a lone note, a full board takes no drop', () => {
    expect(guideText).toContain('The middle button only pans: letting go of it never pastes.')
    expect(guideText).toContain('the keys need the note to be the only thing selected, and a note in a group is selected with its group, so double-click it')
    expect(guideText).toContain('a drop or paste onto a full board copies nothing')
    expect(guideText).toContain('The banner comes down by itself when the note reads as a board again.')
  })

  it('a bullet of the user\'s between two items stays theirs; the rest of the prose moves behind the items', () => {
    const raw = `${HEAD}## Board\n\n- view x=0\n- note x=1 y=1 w=300 » a\n\n- line 3 is wrong\n- note x=2 y=2 w=300 » b\n`
    const { out } = roundTrip(raw)
    const before = out.indexOf('- line 3 is wrong')
    expect(before).toBeGreaterThan(out.indexOf('» a'))
    expect(before).toBeLessThan(out.indexOf('» b'))
    expect(out.slice(out.indexOf('» a'), before)).toMatch(/\n\n$/)
    expect(guideText).toContain('The one exception is a bullet of your own that starts with a kind word and sits after a blank line between two items (`- line 3 is wrong`)')
  })
})

/* ---------------------------------------------------------------- the pieces of the pop-out description --- */

describe('the keys document stays in step with the pop-out line', () => {
  it('still lists w in the desktop keys (the table is read by board-keys.test.ts)', () => {
    expect(keyboard).toMatch(/\| `w` +\| Reference board: pop the board/)
  })
})
