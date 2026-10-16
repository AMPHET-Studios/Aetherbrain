import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { MAX_BOARD_TEXT } from '../src/main/board-save.js'
import { IPC, type AetherBridge, type BoardBridge, type VaultChangeDto } from '../src/shared/ipc.js'
import { createFloatingBoardHost } from '../src/renderer/board-host.js'
import { BOARD, OTHER, rig, type Rig } from './board-fix-desktop-fakes.js'
import { lf } from './lf.js'

/**
 * Round 2, diff-app-2 + live-window-m4: the red banner of the floating window ("deleted or moved away", "no longer reads as a board") was
 * one-way. A note that is whole again (a sync tool or an editor that writes in place, a delete and a re-create, an autosave of a
 * draft typed through `type: boa`) left it up for good, saying nothing is saved while the window saved fine. Main now sends
 * `board:gone` with null when a later change of the shown note reads as a board again, and the banner offers "Copy board text" as well
 * as "Bring it back" (the text of a board whose note is gone is not lost).
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (...p: string[]): Promise<string> => fs.readFile(path.join(here, '..', ...p), 'utf8').then(lf)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const GOOD = '---\ntitle: Gate\ntype: board\n---\n# Gate\n\n## Board\n'
const NOTE = '---\ntitle: Gate\ntype: note\n---\n# Gate\n'
const gone = (t: Rig): unknown[] => t.win.webContents.on_(IPC.boardGone).map((a) => a[0])
const DELETED = /deleted or moved away/
const NOT_BOARD = /no longer reads as a board/

async function open(opts: Parameters<typeof rig>[0] = { platform: 'linux' }): Promise<Rig> {
  const t = rig(opts)
  await t.host.open(BOARD)
  return t
}

describe('the banner takes itself down when the note is a board again', () => {
  it('after a delete and a re-create (two batches): the notice, then null', async () => {
    const t = await open()
    t.host.forward([{ kind: 'unlink', path: BOARD }])
    expect(gone(t)).toEqual([expect.stringMatching(DELETED)])
    t.host.forward([{ kind: 'add', path: BOARD, content: GOOD }])
    expect(gone(t)).toEqual([expect.stringMatching(DELETED), null])
  })

  it('after the note was emptied and then written whole again (a program that writes in place)', async () => {
    const t = await open()
    t.host.forward([{ kind: 'change', path: BOARD, content: '' }])
    expect(gone(t)).toEqual([expect.stringMatching(NOT_BOARD)])
    t.host.forward([{ kind: 'change', path: BOARD, content: GOOD }])
    expect(gone(t)).toEqual([expect.stringMatching(NOT_BOARD), null])
  })

  it('after a draft saved mid-typing through `type: boa`, once `type: board` is whole', async () => {
    const t = await open()
    t.host.forward([{ kind: 'change', path: BOARD, content: GOOD.replace('type: board', 'type: boa') }])
    t.host.forward([{ kind: 'change', path: BOARD, content: GOOD.replace('type: board', 'type: boar') }])
    expect(gone(t)).toHaveLength(2)
    t.host.forward([{ kind: 'change', path: BOARD, content: GOOD }])
    expect(gone(t)).toEqual([expect.stringMatching(NOT_BOARD), expect.stringMatching(NOT_BOARD), null])
  })

  it('in one batch, in order: a delete and its re-create end with the banner down; a re-create and a later delete end with it up', async () => {
    const t = await open()
    t.host.forward([{ kind: 'unlink', path: BOARD }, { kind: 'add', path: BOARD, content: GOOD }])
    expect(gone(t)).toEqual([expect.stringMatching(DELETED), null])
    t.host.forward([{ kind: 'add', path: BOARD, content: GOOD }, { kind: 'unlink', path: BOARD }])
    expect(gone(t)).toEqual([expect.stringMatching(DELETED), null, expect.stringMatching(DELETED)])
  })

  it('sends the null once, and only when a banner is up: a board that was never gone, and a second whole copy, send nothing', async () => {
    const t = await open()
    t.host.forward([{ kind: 'change', path: BOARD, content: GOOD }])
    expect(gone(t)).toEqual([])
    t.host.forward([{ kind: 'unlink', path: BOARD }])
    t.host.forward([{ kind: 'add', path: BOARD, content: GOOD }])
    t.host.forward([{ kind: 'change', path: BOARD, content: GOOD + '- note x=0 y=0\n' }])
    expect(gone(t)).toEqual([expect.stringMatching(DELETED), null])
    // The whole copies still reach the window as changes (it reads the note again).
    expect(t.win.webContents.on_(IPC.changes)).toHaveLength(4)
  })

  it('keeps the banner for a note that is still no board, one main cannot read, one without content, one over the limit, and another note', async () => {
    const t = await open()
    t.host.forward([{ kind: 'unlink', path: BOARD }])
    const before = gone(t).length
    t.host.forward([{ kind: 'add', path: BOARD, content: NOTE }])
    t.host.forward([{ kind: 'change', path: BOARD, content: '---\ntype: board\nmeta:\n  a: 1\n---\n' }])
    t.host.forward([{ kind: 'change', path: BOARD }])
    // Whole as a board, but longer than the window reads or saves (board:read refuses it): not a note it can save to.
    t.host.forward([{ kind: 'change', path: BOARD, content: GOOD + 'x'.repeat(MAX_BOARD_TEXT) }])
    t.host.forward([{ kind: 'change', path: OTHER, content: GOOD }, { kind: 'add', path: 'Boards/Gate/a.png' }])
    const sent = gone(t).slice(before)
    expect(sent).toHaveLength(2) // the two bad notes said their piece again
    expect(sent.every((s) => typeof s === 'string')).toBe(true)
    // ... and the first note the window can save to again takes it down.
    t.host.forward([{ kind: 'change', path: BOARD, content: GOOD + 'x'.repeat(MAX_BOARD_TEXT - GOOD.length) }])
    expect(gone(t).at(-1)).toBeNull()
  })

  it('judges the note by the platform\'s way of comparing paths', async () => {
    const t = await open({ platform: 'win32' })
    t.host.forward([{ kind: 'unlink', path: BOARD.toLowerCase() }])
    t.host.forward([{ kind: 'add', path: BOARD.toUpperCase().replace('.MD', '.md'), content: GOOD }])
    expect(gone(t)).toEqual([expect.stringMatching(DELETED), null])
    const u = await open({ platform: 'linux' })
    u.host.forward([{ kind: 'unlink', path: BOARD }])
    u.host.forward([{ kind: 'add', path: BOARD.toLowerCase(), content: GOOD }])
    expect(gone(u)).toEqual([expect.stringMatching(DELETED)])
  })

  it('does not carry a banner over to another board (the page is loaded again) and sends no null for it', async () => {
    const t = await open()
    t.host.forward([{ kind: 'unlink', path: BOARD }])
    await t.host.open(OTHER)
    t.host.forward([{ kind: 'change', path: OTHER, content: GOOD }])
    expect(gone(t)).toEqual([expect.stringMatching(DELETED)])
  })
})

describe('the notice about a rename the window could not follow stays', () => {
  it('is not taken down by a whole note under the new name, and is not replaced by a later bad edit', async () => {
    const t = await open()
    t.win.loadError = Object.assign(new Error('ERR_FAILED'), { code: 'ERR_FAILED' })
    await t.host.followMove(BOARD, 'Boards/Renamed.md')
    expect(gone(t)).toEqual([expect.stringMatching(/renamed to Boards\/Renamed\.md, and the window could not follow it/)])
    t.host.forward([{ kind: 'unlink', path: 'Boards/Renamed.md' }])
    t.host.forward([{ kind: 'add', path: 'Boards/Renamed.md', content: GOOD }])
    t.host.forward([{ kind: 'change', path: 'Boards/Renamed.md', content: NOTE }])
    expect(gone(t)).toHaveLength(1)
  })

  it('goes with the page when the window does follow: a banner that was up is not kept, and a later whole note sends nothing', async () => {
    const t = await open()
    t.host.forward([{ kind: 'unlink', path: BOARD }])
    expect(gone(t)).toHaveLength(1)
    await t.host.followMove(BOARD, 'Boards/Renamed.md')
    t.host.forward([{ kind: 'change', path: 'Boards/Renamed.md', content: GOOD }])
    expect(gone(t)).toHaveLength(1)
  })
})

describe('the bridge and the page', () => {
  it('declare the null: onBoardGone takes (why: string | null) in the bridge type and both preloads pass the payload through', async () => {
    const ipc = await read('src', 'shared', 'ipc.ts')
    expect(ipc).toMatch(/onBoardGone\(cb: \(why: string \| null\) => void\): \(\) => void/)
    // Type level: a callback that takes null is a valid one.
    const accepts: AetherBridge['onBoardGone'] = (cb) => {
      cb(null)
      cb('why')
      return () => undefined
    }
    const board: BoardBridge['onBoardGone'] = accepts
    expect(typeof board).toBe('function')
  })

  for (const file of ['board-preload.cts', 'preload.cts']) {
    it(`${file}: a null on board:gone reaches the page as null`, async () => {
      const listeners = new Map<string, ((e: unknown, ...a: unknown[]) => void)[]>()
      const exposed: Record<string, unknown> = {}
      const electron = {
        contextBridge: { exposeInMainWorld: (k: string, api: unknown) => void (exposed[k] = api) },
        ipcRenderer: {
          invoke: async () => undefined,
          send: () => undefined,
          on: (ch: string, fn: (e: unknown, ...a: unknown[]) => void) => void listeners.set(ch, [...(listeners.get(ch) ?? []), fn]),
          off: () => undefined,
        },
      }
      const js = ts.transpileModule(await read('src', 'preload', file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
      new Function('require', 'module', 'exports', 'process', js)((id: string) => (id === 'electron' ? electron : (() => { throw new Error(id) })()), { exports: {} }, {}, process)
      const bridge = exposed['aether'] as { onBoardGone(cb: (why: string | null) => void): () => void }
      const heard: (string | null)[] = []
      bridge.onBoardGone((why) => void heard.push(why))
      for (const fn of listeners.get(IPC.boardGone) ?? []) {
        fn({}, 'The note is gone')
        fn({}, null)
      }
      expect(heard).toEqual(['The note is gone', null])
    })
  }

  it('give the banner two buttons, "Copy board text" and "Bring it back", and wire the first to the clipboard through the bridge', async () => {
    const page = await read('src', 'renderer', 'board.tsx')
    expect(page).toMatch(/function GoneBanner\(\{ onClose, onCopy \}/)
    const copyButton = /<button type="button" className="hud-btn shrink-0" onClick=\{onCopy\}>\s*Copy board text\s*<\/button>/.exec(page)
    const bringButton = /<button type="button" className="hud-btn shrink-0" onClick=\{onClose\}>\s*Bring it back\s*<\/button>/.exec(page)
    expect(copyButton).not.toBeNull()
    expect(bringButton).not.toBeNull()
    expect(copyButton!.index).toBeLessThan(bringButton!.index)
    expect(page).toContain('<GoneBanner onClose={() => void bridge.boardClose().catch(() => undefined)} onCopy={() => void copyBoardText()} />')
    const copy = /const copyBoardText = async[\s\S]*?\n {2}}\n/.exec(page)?.[0] ?? ''
    // What was typed is written first, then the newest text goes to the clipboard.
    expect(copy.indexOf('getActiveBoard()?.flush()')).toBeGreaterThan(-1)
    expect(copy.indexOf('getActiveBoard()?.flush()')).toBeLessThan(copy.indexOf('host.latestText()'))
    expect(copy).toContain('bridge.copyText(text)')
    // The page already hands whatever main sends to setGone, which takes null.
    expect(page).toContain('bridge.onBoardGone(setGone)')
    expect(page).toMatch(/function setGone\(why: string \| null\)/)
  })
})

describe('"Copy board text": the newest text of the board the window has', () => {
  function bridge(note: string | null) {
    const st = { note, saves: [] as string[], refuse: null as string | null }
    const b = {
      platform: 'linux',
      boardRead: vi.fn(async () => st.note),
      boardSave: vi.fn(async (_p: string, text: string) => {
        if (st.refuse) return { ok: false as const, reason: st.refuse }
        st.note = text
        st.saves.push(text)
        return { ok: true as const }
      }),
      boardAssets: vi.fn(async () => ({ assets: [], truncated: false })),
      boardStatus: vi.fn(async () => ({ open: true, path: BOARD, alwaysOnTop: true, opacity: 1, supportsOpacity: false })),
      boardConfigure: vi.fn(),
      boardClose: vi.fn(async () => undefined),
      onChanges: () => () => undefined,
      onBoardState: () => () => undefined,
      copyText: vi.fn(async () => undefined),
    }
    return { st, bridge: b as unknown as BoardBridge }
  }

  it('is null before the note is read, the text read, then the text of every try to write it - a try the gone note refused too', async () => {
    const { st, bridge: b } = bridge(GOOD)
    const host = createFloatingBoardHost(b, BOARD)
    expect(host.latestText()).toBeNull()
    expect(await host.load()).toBe(GOOD)
    expect(host.latestText()).toBe(GOOD)
    const edited = GOOD + '- note x=0 y=0 w=100 size=18 color=ffffff fill= r=0 » kept\n'
    await host.save(edited, GOOD)
    expect(host.latestText()).toBe(edited)
    // The note is gone: the save is refused, and the text is still the newest the window has (it is what "Copy board text" copies).
    st.refuse = 'The board note is gone, or is no longer a board: nothing was saved'
    const later = edited + '- note x=10 y=10 w=100 size=18 color=ffffff fill= r=0 » typed after the delete\n'
    await expect(host.save(later, edited)).rejects.toThrow(/nothing was saved/)
    expect(host.latestText()).toBe(later)
    expect(st.saves).toEqual([edited])
    host.dispose()
  })

  it('goes back to the note when it is read again', async () => {
    const { st, bridge: b } = bridge(GOOD)
    const host = createFloatingBoardHost(b, BOARD)
    await host.load()
    st.refuse = 'gone'
    await expect(host.save(GOOD + 'x', GOOD)).rejects.toThrow()
    st.note = GOOD + 'restored elsewhere\n'
    await host.load()
    expect(host.latestText()).toBe(GOOD + 'restored elsewhere\n')
    host.dispose()
  })
})

describe('the changes that are not about the notice', () => {
  it('still reach the window exactly as before (the notice only adds a message)', async () => {
    const t = await open()
    const changes: VaultChangeDto[] = [{ kind: 'unlink', path: BOARD }, { kind: 'add', path: BOARD, content: GOOD }]
    t.host.forward(changes)
    expect(t.win.webContents.on_(IPC.changes)).toEqual([[changes]])
  })
})
