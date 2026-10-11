import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { newBoardNote } from '@aether/core'
import { FsVault } from '../src/main/fsvault.js'
import { PictureLedger, boardHandlers, guardIpc } from '../src/main/board-window.js'
import { IPC } from '../src/shared/ipc.js'
import { rig, type Rig } from './board-fix-desktop-fakes.js'

/**
 * Round 2, diff-app-1 + live-window-m1: the floating window's page reads and saves ONLY the board it shows, and shows only pictures,
 * videos and that board in the file manager. board:read, board:save and vault:reveal sit in BOARD_PAGE_CHANNELS (the page needs
 * them), and the channel list never looked at what the call named: a page that a broken decoder took over could read and overwrite
 * every other board note of the vault, and learn which notes and folders exist. The brain window is not judged.
 *
 * The wiring here is main.ts's, built from the same pieces: guardIpc with the host's isBoardPage and pageRefusal in front of the
 * handlers (`h.save(p, text, base)`, `h.read(p)`), over a real temp vault and a host with fake windows. The senders are the host's
 * pages: `t.win.webContents` is the board page, `t.brain.webContents` the brain window.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const NOW = new Date('2026-10-10T12:00:00Z')
const SHOWN = 'Boards/Shown.md'
const OTHER = 'Boards/Other.md'

let tmp: string
let root: string
const at = (rel: string): string => path.join(root, ...rel.split('/'))
const board = (title: string, extra = ''): string => newBoardNote(title, NOW) + extra

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-board-scope-'))
  root = path.join(tmp, 'vault')
  await fs.mkdir(path.join(root, 'Boards'), { recursive: true })
  await fs.mkdir(path.join(root, 'Projects', 'Art'), { recursive: true })
  await fs.writeFile(at(SHOWN), board('Shown'))
  await fs.writeFile(at(OTHER), board('Other', 'SECRET-OF-THE-OTHER-BOARD\n'))
  await fs.writeFile(at('Home.md'), '---\ntitle: Home\n---\nHome.\n')
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

type Handler = (e: { sender: unknown }, ...args: unknown[]) => unknown

function wire(t: Rig) {
  const handlers = new Map<string, Handler>()
  const ipc = guardIpc(
    { handle: (ch, fn) => void handlers.set(ch, fn as Handler), on: () => undefined },
    (wc) => t.host.isBoardPage(wc),
    (channel, args) => t.host.pageRefusal(channel, args),
  )
  const vault = new FsVault([root])
  const h = boardHandlers({ host: t.host, vault: () => vault, scan: () => null, ledger: new PictureLedger() })
  const revealed: string[] = []
  // The registrations of main.ts's registerBoardIpc and of vault:reveal, in miniature.
  ipc.handle(IPC.boardSave, (_e, p: unknown, text: unknown, base: unknown) => h.save(p, text, base))
  ipc.handle(IPC.boardRead, (_e, p: unknown) => h.read(p))
  ipc.handle(IPC.reveal, (_e, p: unknown) => void revealed.push(String(p)))
  const call = async (sender: unknown, channel: string, ...args: unknown[]): Promise<unknown> => handlers.get(channel)!({ sender }, ...args)
  return {
    call,
    revealed,
    // The page of the latest board window (a getter: there is none before a board is opened).
    get page() {
      return t.win.webContents
    },
    brain: t.brain.webContents,
  }
}

describe('board:read and board:save from the board window\'s page', () => {
  it('reach the board the window shows, and no other board note of the vault', async () => {
    const t = rig({ platform: 'linux' })
    await t.host.open(SHOWN)
    const w = wire(t)
    const shown = board('Shown')
    // The shown board: read, and saved with the text it was made from.
    expect(await w.call(w.page, IPC.boardRead, SHOWN)).toBe(shown)
    const next = shown.replace('Reference board.', 'Edited in the window.')
    expect(await w.call(w.page, IPC.boardSave, SHOWN, next, shown)).toEqual({ ok: true })
    expect(await fs.readFile(at(SHOWN), 'utf8')).toBe(next)
    // Another board: the call is refused before the handler runs; nothing is read, nothing is written.
    const other = await fs.readFile(at(OTHER), 'utf8')
    await expect(w.call(w.page, IPC.boardRead, OTHER)).rejects.toThrow(/only the board it shows/)
    await expect(w.call(w.page, IPC.boardSave, OTHER, other.replace('SECRET-OF-THE-OTHER-BOARD', 'OVERWRITTEN-BY-THE-PAGE'), other)).rejects.toThrow(/only the board it shows/)
    await expect(w.call(w.page, IPC.boardSave, OTHER, other)).rejects.toThrow(/only the board it shows/)
    expect(await fs.readFile(at(OTHER), 'utf8')).toBe(other)
    // A note that is no board, a path that leaves the vault, and what is no path at all: refused the same way.
    for (const p of ['Home.md', '../outside.md', '', 7, null, undefined, {}]) {
      await expect(w.call(w.page, IPC.boardRead, p), String(p)).rejects.toThrow(/only the board it shows/)
      await expect(w.call(w.page, IPC.boardSave, p, board('X'), undefined), String(p)).rejects.toThrow(/only the board it shows/)
    }
  })

  it('are not judged for the brain window, which keeps reading and saving any board note (it has readFile and writeFile anyway)', async () => {
    const t = rig({ platform: 'linux' })
    await t.host.open(SHOWN)
    const w = wire(t)
    expect(await w.call(w.brain, IPC.boardRead, OTHER)).toBe(await fs.readFile(at(OTHER), 'utf8'))
    const next = board('Other', 'Edited by the brain window.\n')
    expect(await w.call(w.brain, IPC.boardSave, OTHER, next)).toEqual({ ok: true })
    expect(await fs.readFile(at(OTHER), 'utf8')).toBe(next)
    // ... also with no board window at all.
    const closed = rig({ platform: 'linux' })
    const c = wire(closed)
    expect(await c.call(c.brain, IPC.boardRead, SHOWN)).toBe(board('Shown'))
  })

  it('compare the shown path the way the platform does: case-blind on Windows and macOS, exact on Linux', async () => {
    for (const [platform, accepted] of [['win32', true], ['darwin', true], ['linux', false]] as const) {
      const t = rig({ platform })
      await t.host.open(SHOWN)
      const w = wire(t)
      const read = w.call(w.page, IPC.boardRead, 'boards/SHOWN.md')
      if (accepted) await expect(read, platform).resolves.toBeNull() // allowed through; the vault then looks for that spelling (a miss on Linux's disk)
      else await expect(read, platform).rejects.toThrow(/only the board it shows/)
    }
  })

  it('follow a rename (the window shows the new name) and refuse the old one', async () => {
    const t = rig({ platform: 'linux' })
    await t.host.open(SHOWN)
    const w = wire(t)
    await fs.rename(at(SHOWN), at('Boards/Renamed.md'))
    await t.host.followMove(SHOWN, 'Boards/Renamed.md')
    expect(await w.call(w.page, IPC.boardRead, 'Boards/Renamed.md')).toBe(board('Shown'))
    await expect(w.call(w.page, IPC.boardRead, SHOWN)).rejects.toThrow(/only the board it shows/)
  })

  it('still save the shown board while the window holds its close for the page\'s last save, and refuse once the window is gone', async () => {
    const t = rig({ platform: 'linux', answer: 80 })
    await t.host.open(SHOWN)
    const w = wire(t)
    const shown = board('Shown')
    t.win.close() // held: the page is asked to save
    expect(t.win.webContents.on_(IPC.boardFlush)).toHaveLength(1)
    expect(t.win.gone).toBe(false)
    const last = shown.replace('Reference board.', 'Typed as the window closed.')
    expect(await w.call(w.page, IPC.boardSave, SHOWN, last, shown)).toEqual({ ok: true })
    expect(await fs.readFile(at(SHOWN), 'utf8')).toBe(last)
    await new Promise((r) => setTimeout(r, 160))
    expect(t.win.gone).toBe(true)
    // No window shows anything now.
    expect(t.host.showsPath(SHOWN)).toBe(false)
  })
})

describe('vault:reveal from the board window\'s page', () => {
  it('shows a picture, a video or the board it shows, and refuses notes and folders, whether they exist or not (no way to tell which do)', async () => {
    const t = rig({ platform: 'linux' })
    await t.host.open(SHOWN)
    const w = wire(t)
    for (const p of ['Projects/Art/gate.png', 'Projects/Art/CLIP.MP4', 'a.webp', 'Boards/Shown/photo 2.JPEG', 'Boards/Shown.md']) {
      await expect(w.call(w.page, IPC.reveal, p), p).resolves.toBeUndefined()
    }
    expect(w.revealed).toEqual(['Projects/Art/gate.png', 'Projects/Art/CLIP.MP4', 'a.webp', 'Boards/Shown/photo 2.JPEG', 'Boards/Shown.md'])
    w.revealed.length = 0
    for (const p of ['Home.md', OTHER, 'Projects', 'Projects/Art', 'Nope-does-not-exist.md', 'Projects/', '', '..', 'x.png/..', 'x.png/', 7, null, undefined]) {
      await expect(w.call(w.page, IPC.reveal, p), String(p)).rejects.toThrow(/only pictures, videos and its own board/)
    }
    expect(w.revealed).toEqual([])
  })

  it('is not judged for the brain window, which keeps showing notes and folders', async () => {
    const t = rig({ platform: 'linux' })
    await t.host.open(SHOWN)
    const w = wire(t)
    for (const p of ['Home.md', OTHER, 'Projects']) await w.call(w.brain, IPC.reveal, p)
    expect(w.revealed).toEqual(['Home.md', OTHER, 'Projects'])
  })
})

describe('the guard\'s argument check', () => {
  function fake(refuse?: (channel: string, args: readonly unknown[]) => string | null) {
    const handlers = new Map<string, Handler>()
    const listeners = new Map<string, (e: { sender: unknown }, ...a: unknown[]) => void>()
    const ipc = guardIpc(
      { handle: (ch, fn) => void handlers.set(ch, fn as Handler), on: (ch, fn) => void listeners.set(ch, fn as never) },
      (wc) => (wc as { id: number }).id === 7,
      refuse,
    )
    return { ipc, handlers, listeners, page: { id: 7 }, brain: { id: 1 } }
  }

  it('judges only the board page, and only when it is given one; a null answer lets the call through with its arguments untouched', () => {
    const seen: [string, readonly unknown[]][] = []
    // Two channels the board page may use, one refused by the check and one not.
    const f = fake((channel, args) => (seen.push([channel, args]), channel === IPC.boardSave ? 'refused: because' : null))
    const ran = { n: 0 }
    f.ipc.handle(IPC.boardSave, () => ++ran.n)
    f.ipc.handle(IPC.boardStatus, (_e, ...a) => a)
    expect(() => f.handlers.get(IPC.boardSave)!({ sender: f.page }, 'p')).toThrow('refused: because')
    expect(ran.n).toBe(0)
    expect(f.handlers.get(IPC.boardSave)!({ sender: f.brain })).toBe(1)
    expect(f.handlers.get(IPC.boardStatus)!({ sender: f.page }, 'a', 2)).toEqual(['a', 2])
    // The brain window's calls are never even shown to the check; the channel list still comes first.
    expect(seen).toEqual([[IPC.boardSave, ['p']], [IPC.boardStatus, ['a', 2]]])
    f.ipc.handle(IPC.write, () => 'written')
    expect(() => f.handlers.get(IPC.write)!({ sender: f.page })).toThrow(/may not use vault:write/)
    expect(seen).toHaveLength(2)
    // Without a check nothing changes.
    const g = fake()
    g.ipc.handle(IPC.boardSave, () => 'ok')
    expect(g.handlers.get(IPC.boardSave)!({ sender: g.page })).toBe('ok')
  })

  it('drops a message (send) the check refuses, and takes the others', () => {
    const f = fake((_channel, args) => (args[0] === 'bad' ? 'no' : null))
    const heard: unknown[] = []
    f.ipc.on(IPC.boardFlushed, (_e, token) => void heard.push(token))
    f.listeners.get(IPC.boardFlushed)!({ sender: f.page }, 'bad')
    f.listeners.get(IPC.boardFlushed)!({ sender: f.page }, 3)
    f.listeners.get(IPC.boardFlushed)!({ sender: f.brain }, 'bad')
    expect(heard).toEqual([3, 'bad'])
  })
})

describe('main.ts wires the check', () => {
  it('gives guardIpc the host\'s refusal, and passes the sender of a reveal on so that a folder is refused to the board page', async () => {
    const src = await fs.readFile(path.join(here, '..', 'src', 'main', 'main.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).toMatch(/const ipc = guardIpc\(\s*ipcMain,\s*\(wc\) => board\?\.isBoardPage\(wc\) \?\? false,\s*\(channel, args\) => board\?\.pageRefusal\(channel, args\) \?\? null,?\s*\)/)
    expect(code).toContain('ipc.handle(IPC.reveal, (e, p: unknown) => reveal(p, board?.isBoardPage(e.sender) ?? false))')
    const reveal = /async function reveal\([\s\S]*?\n}\n/.exec(code)?.[0] ?? ''
    expect(reveal).toMatch(/fromBoardPage && !st\.isFile/)
    // The brain window's reveal of a note or a folder is the same call without the flag.
    expect(reveal).toContain('shell.showItemInFolder(v.abs(rel))')
    // The board handlers are still the plain functions the other tests pin.
    expect(code).toContain('h.save(p, text, base)')
    expect(code).toContain('h.read(p)')
  })

  it('says in the window\'s header what is true: the board it shows, and only that one', async () => {
    const src = await fs.readFile(path.join(here, '..', 'src', 'main', 'board-window.ts'), 'utf8')
    expect(src).toMatch(/reads and saves the board it shows, and only that one/)
    expect(src).not.toMatch(/reads and saves the one board note/)
  })
})
