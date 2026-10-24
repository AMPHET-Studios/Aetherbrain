import { beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { BOARD_PAGE_CHANNELS, boardWindowOptions, channelAllowed, guardIpc, type IpcLike } from '../src/main/board-window.js'
import { IPC } from '../src/shared/ipc.js'
import { FakeWin, rig } from './board-fix-desktop-fakes.js'
import { lf } from './lf.js'

/**
 * desktop-3: the board window's page decodes pictures from the user's folders, so it gets a bridge of its own (board-preload.cts: the
 * board and its pictures, nothing else), main answers it no other channel (BOARD_PAGE_CHANNELS, guardIpc), and its page may not
 * fetch anything (connect-src 'none').
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (...p: string[]): Promise<string> => fs.readFile(path.join(here, '..', ...p), 'utf8').then(lf)

/** The channels the board page may use, spelled out: a change to the list is a change to what a compromised page can do. */
const ALLOWED = [
  'app:copy',
  'board:assets',
  'board:close',
  'board:configure',
  'board:flushed',
  'board:read',
  'board:save',
  'board:status',
  'vault:createAsset',
  'vault:modelProxy',
  'vault:openAsset',
  'vault:readAsset',
  'vault:readAssetChecked',
  'vault:reveal',
  'vault:thumb',
]

describe('which channels the board window may use', () => {
  it('is the board, its pictures, the clipboard and the answer to a flush - spelled out', () => {
    expect([...BOARD_PAGE_CHANNELS].sort()).toEqual(ALLOWED)
  })

  it('has no way to read, write, create, rename or delete a note, open a vault, chat, sort a library, link an AI, open the Forge or another board', () => {
    for (const ch of Object.values(IPC)) {
      const dangerous = /^(vault:(read|write|create|delete|rename|mkdir|open|pick|addRoot|addRootPath|removeRoot|setExclude|hideFolder|unhideFolder|setFolderRules|list|folders|assets|last|info|drives|findProjects|skippedInstalls)$|chat:|library:|ai:|forge:|companion:|board:(open|state|closed|flush|gone)$)/.test(ch)
      if (dangerous) expect(BOARD_PAGE_CHANNELS.has(ch), ch).toBe(false)
      expect(channelAllowed(true, ch), ch).toBe(BOARD_PAGE_CHANNELS.has(ch))
      // Every other sender (the brain window, a helper) is answered as before.
      expect(channelAllowed(false, ch), ch).toBe(true)
    }
  })
})

describe('guardIpc', () => {
  function fake() {
    const handlers = new Map<string, (e: { sender: { id: number } }, ...a: unknown[]) => unknown>()
    const listeners = new Map<string, (e: { sender: { id: number } }, ...a: unknown[]) => void>()
    const ipc: IpcLike = {
      handle: (ch, fn) => void handlers.set(ch, fn as never),
      on: (ch, fn) => void listeners.set(ch, fn as never),
    }
    const BOARD_ID = 7
    const guard = guardIpc(ipc, (wc) => wc.id === BOARD_ID)
    return { handlers, listeners, guard, board: { sender: { id: BOARD_ID } }, brain: { sender: { id: 1 } } }
  }

  it('refuses the board page every channel outside the list before the handler runs, and answers the brain window all of them', async () => {
    const f = fake()
    const writeNote = vi.fn(async () => 'written')
    const status = vi.fn(() => ({ open: true }))
    f.guard.handle(IPC.write, writeNote)
    f.guard.handle(IPC.boardStatus, status)
    await expect(Promise.resolve().then(() => f.handlers.get(IPC.write)!(f.board as never, 'A.md', 'x'))).rejects.toThrow(/The board window may not use vault:write/)
    expect(writeNote).not.toHaveBeenCalled()
    await expect(f.handlers.get(IPC.write)!(f.brain as never, 'A.md', 'x')).resolves.toBe('written')
    expect(f.handlers.get(IPC.boardStatus)!(f.board as never)).toEqual({ open: true })
    expect(f.handlers.get(IPC.boardStatus)!(f.brain as never)).toEqual({ open: true })
    // The arguments reach the handler untouched.
    expect(writeNote).toHaveBeenLastCalledWith(f.brain, 'A.md', 'x')
  })

  it('drops a message the board page sends on a channel outside the list (send / on), and takes the ones inside', () => {
    const f = fake()
    const graph = vi.fn()
    const flushed = vi.fn()
    f.guard.on(IPC.companionGraph, graph)
    f.guard.on(IPC.boardFlushed, flushed)
    f.listeners.get(IPC.companionGraph)!(f.board as never, {})
    expect(graph).not.toHaveBeenCalled()
    f.listeners.get(IPC.companionGraph)!(f.brain as never, {})
    expect(graph).toHaveBeenCalledTimes(1)
    f.listeners.get(IPC.boardFlushed)!(f.board as never, 3)
    expect(flushed).toHaveBeenCalledWith(f.board, 3)
  })

  it('judges the sender by the host\'s record of board pages: a page of the board window, not any other', async () => {
    const t = rig()
    await t.host.open('Boards/Gate.md')
    const page = t.win.webContents
    expect(t.host.isBoardPage(page)).toBe(true)
    expect(t.host.isBoardPage(t.brain.webContents)).toBe(false)
    // After the window is gone the page is no longer a sender: ids are never reused, and the record does not grow for ever.
    t.win.destroy()
    expect(t.host.isBoardPage(page)).toBe(false)
  })
})

describe('main.ts registers every channel through the guard, and nothing else', () => {
  let src: string
  beforeAll(async () => {
    src = await read('src', 'main', 'main.ts')
  })

  it('has no raw ipcMain.handle / ipcMain.on: only guardIpc(ipcMain, ...) touches ipcMain', () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code.match(/\bipcMain\b/g)).toHaveLength(2) // the import and the guard
    // (Deliberately widened in round 2: the guard also gets the host's refusal of what the board page may name, board-fix2-desktop-scope.test.ts.)
    expect(code).toMatch(/const ipc = guardIpc\(\s*ipcMain,\s*\(wc\) => board\?\.isBoardPage\(wc\) \?\? false,\s*\(channel, args\) => board\?\.pageRefusal\(channel, args\) \?\? null,?\s*\)/)
    expect(code.match(/\bipc\.(handle|on)\(/g)!.length).toBeGreaterThan(60)
  })

  it('answers the flush from the board page and the brain page through the gate, with the sender\'s id', () => {
    expect(src).toMatch(/ipc\.on\(IPC\.boardFlushed, \(e, token: unknown\) => flushGate\.ack\(e\.sender\.id, token\)\)/)
    expect(src).toContain('flushGate.guardClose(win)')
  })

  it('gives the board window its own preload and the same gate', () => {
    const make = /function createBoardWindow[\s\S]*?\n}\n/.exec(src)?.[0] ?? ''
    expect(make).toContain("'board-preload.cjs'")
    expect(make).toContain('gate: flushGate')
  })

  it('holds the quit until the pages have saved (once), and the vault switch until the board window is gone', () => {
    const quit = /app\.on\('before-quit'[\s\S]*?\n}\)/.exec(src)?.[0] ?? ''
    expect(quit).toContain('e.preventDefault()')
    expect(quit).toContain('board.flushPage()')
    expect(quit).toContain('flushGate.ask(brainPage)')
    expect(quit).toContain('flushGate.openFor(')
    expect(quit.indexOf('app.quit()')).toBeLessThan(quit.indexOf('watcher?.stop()'))
    const open = /async function openVault[\s\S]*?\n}\n/.exec(src)?.[0] ?? ''
    // Closed (its page saves first) before the new vault replaces the old one, which the page's save goes to.
    expect(open).toMatch(/await board\?\.close\(\)/)
    expect(open.indexOf('await board?.close()')).toBeLessThan(open.indexOf('vault = next'))
  })

  it('forwards every own note write to the board window, and gives it the rename around the disk', () => {
    const code = src.replace(/\/\/.*$/gm, '')
    const fn = (name: string): string => new RegExp(`async function ${name}\\([\\s\\S]*?\\n}\\n`).exec(code)?.[0] ?? ''
    for (const name of ['writeNote', 'createNote', 'deleteNote', 'renameNote']) {
      expect(fn(name), name).toContain('afterOwnWrite(')
      expect(fn(name), name).not.toMatch(/\btoAi\(/)
    }
    expect(/function afterOwnWrite[\s\S]*?\n}\n/.exec(code)?.[0]).toMatch(/toAi\(changes\)[\s\S]*board\?\.forward\(changes\)/)
    const rename = fn('renameNote')
    expect(rename.indexOf('board?.beforeMove(a)')).toBeGreaterThan(-1)
    expect(rename.indexOf('board?.beforeMove(a)')).toBeLessThan(rename.indexOf('v.rename(a, b)'))
    expect(rename.indexOf('board?.followMove(a, b)')).toBeGreaterThan(rename.indexOf('v.rename(a, b)'))
    expect(rename.indexOf('board?.followMove(a, b)')).toBeLessThan(rename.indexOf('afterOwnWrite('))
  })
})

describe('the board preload', () => {
  const electron = (() => {
    const listeners = new Map<string, ((e: unknown, ...a: unknown[]) => void)[]>()
    const invoked: unknown[][] = []
    const sent: unknown[][] = []
    const exposed: Record<string, unknown> = {}
    return {
      listeners,
      invoked,
      sent,
      exposed,
      invoke: vi.fn(async (...args: unknown[]): Promise<unknown> => void invoked.push(args)),
      module: {} as Record<string, unknown>,
    }
  })()

  async function load(file: string): Promise<Record<string, (...a: unknown[]) => unknown>> {
    electron.listeners.clear()
    electron.invoked.length = 0
    electron.sent.length = 0
    electron.module['contextBridge'] = { exposeInMainWorld: (key: string, api: unknown) => void (electron.exposed[key] = api) }
    electron.module['ipcRenderer'] = {
      invoke: electron.invoke,
      send: (...args: unknown[]) => void electron.sent.push(args),
      on: (channel: string, fn: (e: unknown, ...a: unknown[]) => void) => void electron.listeners.set(channel, [...(electron.listeners.get(channel) ?? []), fn]),
      off: (channel: string, fn: (e: unknown, ...a: unknown[]) => void) => void electron.listeners.set(channel, (electron.listeners.get(channel) ?? []).filter((x) => x !== fn)),
    }
    const code = await read('src', 'preload', file)
    const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const require = (id: string): unknown => {
      if (id === 'electron') return electron.module
      throw new Error(`the sandboxed preload cannot require ${id}`)
    }
    new Function('require', 'module', 'exports', 'process', js)(require, { exports: {} }, {}, process)
    return electron.exposed['aether'] as Record<string, (...a: unknown[]) => unknown>
  }

  const KEYS = ['boardAssets', 'boardClose', 'boardConfigure', 'boardFlushed', 'boardRead', 'boardSave', 'boardStatus', 'copyText', 'createAsset', 'modelProxy', 'onBoardFlush', 'onBoardGone', 'onBoardState', 'onChanges', 'openAsset', 'platform', 'readAsset', 'readAssetChecked', 'revealInFolder', 'thumbnail', 'version']

  it('exposes window.aether with the board bridge and nothing else', async () => {
    const bridge = await load('board-preload.cts')
    expect(Object.keys(bridge).sort()).toEqual(KEYS)
    for (const gone of ['readFile', 'writeFile', 'createFile', 'deleteFile', 'renameFile', 'openVault', 'pickVault', 'addRootPath', 'listFiles', 'listAssets', 'chatSend', 'aiConfigure', 'libraryCopy', 'boardOpen', 'forgeOpen', 'companionConfigure', 'onForgeRequest']) {
      expect(bridge, gone).not.toHaveProperty(gone)
    }
  })

  it('invokes exactly the channels main answers the board window - no more, no fewer', async () => {
    const bridge = await load('board-preload.cts')
    await bridge.boardAssets!()
    await bridge.boardClose!()
    await bridge.boardConfigure!({ alwaysOnTop: false })
    await bridge.boardRead!('Boards/Gate.md')
    await bridge.boardSave!('Boards/Gate.md', 'text')
    await bridge.boardStatus!()
    await bridge.copyText!('x')
    await bridge.createAsset!('Boards/Gate/a.png', new Uint8Array(1))
    await bridge.modelProxy!('Art/robot.glb')
    await bridge.openAsset!('a.png')
    await bridge.readAsset!('a.png')
    await bridge.readAssetChecked!('a.png')
    await bridge.revealInFolder!('a.png')
    await bridge.thumbnail!('a.png', 256)
    bridge.boardFlushed!(4)
    const used = new Set([...electron.invoked.map((a) => a[0] as string), ...electron.sent.map((a) => a[0] as string)])
    expect([...used].sort()).toEqual(ALLOWED)
    expect(used).toEqual(BOARD_PAGE_CHANNELS)
    // Events main sends the page: only these four.
    expect([...electron.listeners.keys()].sort()).toEqual(['board:flush'])
    bridge.onBoardGone!(() => undefined)
    bridge.onBoardState!(() => undefined)
    bridge.onChanges!(() => undefined)
    expect([...electron.listeners.keys()].sort()).toEqual(['board:flush', 'board:gone', 'board:state', 'vault:changes'])
  })

  it('sends a save as ONE call carrying the text it was made from, and a save without one as before', async () => {
    const bridge = await load('board-preload.cts')
    await bridge.boardSave!('Boards/Gate.md', 'new', 'old')
    await bridge.boardSave!('Boards/Gate.md', 'new')
    expect(electron.invoked).toEqual([
      [IPC.boardSave, 'Boards/Gate.md', 'new', 'old'],
      [IPC.boardSave, 'Boards/Gate.md', 'new'],
    ])
  })

  for (const file of ['board-preload.cts', 'preload.cts']) {
    describe(`${file}: the answer to main's ask to save`, () => {
      const ask = (token: unknown): void => {
        for (const fn of electron.listeners.get('board:flush') ?? []) fn({}, token)
      }

      it('answers at once for a page that registered nothing (it never holds a close)', async () => {
        await load(file)
        ask(9)
        expect(electron.sent).toEqual([[IPC.boardFlushed, 9]])
      })

      it('leaves the answer to the page once it has registered, and takes it back when the page lets go', async () => {
        const bridge = await load(file)
        const got = vi.fn()
        const off = bridge.onBoardFlush!(got) as () => void
        ask(10)
        expect(got).toHaveBeenCalledWith(10)
        expect(electron.sent).toEqual([])
        bridge.boardFlushed!(10)
        expect(electron.sent).toEqual([[IPC.boardFlushed, 10]])
        off()
        ask(11)
        expect(electron.sent.at(-1)).toEqual([IPC.boardFlushed, 11])
      })

      it('answers for a page whose handler throws, and ignores a message that is no token', async () => {
        const bridge = await load(file)
        bridge.onBoardFlush!(() => {
          throw new Error('boom')
        })
        ask(12)
        expect(electron.sent).toEqual([[IPC.boardFlushed, 12]])
        ask('13')
        ask(undefined)
        expect(electron.sent).toHaveLength(1)
      })

      it('takes Electron\'s wrapping off the board\'s messages (board:read, board:open reach the user as sentences)', async () => {
        const bridge = await load(file)
        electron.invoke.mockRejectedValueOnce(new Error("Error invoking remote method 'board:read': Error: Boards/Gate.md is 1,200,000 characters long"))
        await expect(bridge.boardRead!('Boards/Gate.md')).rejects.toThrow(/^Boards\/Gate\.md is 1,200,000 characters long$/)
        electron.invoke.mockRejectedValueOnce('not an error')
        await expect(bridge.boardRead!('Boards/Gate.md')).rejects.toBe('not an error')
      })
    })
  }

  it('keeps the brain window\'s bridge whole, with the new calls on the same channels (readAssetChecked, a save with its base, the flush ask, a note that is gone)', async () => {
    const bridge = await load('preload.cts')
    for (const name of ['readFile', 'writeFile', 'deleteFile', 'renameFile', 'openVault', 'boardOpen', 'chatSend', 'libraryCopy', 'readAssetChecked', 'boardSave', 'boardFlushed', 'onBoardFlush', 'onBoardGone']) {
      expect(bridge, name).toHaveProperty(name)
    }
    await bridge.readAssetChecked!('a.png')
    await bridge.boardSave!('Boards/Gate.md', 'new', 'old')
    await bridge.boardSave!('Boards/Gate.md', 'new')
    bridge.boardFlushed!(7)
    expect(electron.invoked).toEqual([
      [IPC.readAssetChecked, 'a.png'],
      [IPC.boardSave, 'Boards/Gate.md', 'new', 'old'],
      [IPC.boardSave, 'Boards/Gate.md', 'new'],
    ])
    expect(electron.sent).toEqual([[IPC.boardFlushed, 7]])
    const heard = vi.fn()
    bridge.onBoardGone!(heard)
    for (const fn of electron.listeners.get(IPC.boardGone) ?? []) fn({}, 'the note is gone')
    expect(heard).toHaveBeenCalledWith('the note is gone')
  })

  it('is the bridge the board page really uses: every bridge member board-host.ts and board.tsx call is on it', async () => {
    const bridge = await load('board-preload.cts')
    for (const file of ['board-host.ts', 'board.tsx']) {
      const code = (await read('src', 'renderer', file)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      const used = new Set([...code.matchAll(/\bbridge\.(\w+)/g)].map((m) => m[1]!))
      expect(used.size, file).toBeGreaterThan(3)
      for (const name of used) expect(Object.keys(bridge), `${file}: bridge.${name}`).toContain(name)
    }
  })

  it('is compiled next to the other preloads, and is the page window\'s preload in the window options', async () => {
    const tsconfig = JSON.parse(await read('tsconfig.main.json')) as { include: string[] }
    expect(tsconfig.include).toContain('src/preload')
    const o = boardWindowOptions({ width: 640, height: 480, alwaysOnTop: true, opacity: 1 }, 'win32', [{ x: 0, y: 0, width: 1920, height: 1040 }], '/app/dist/preload/board-preload.cjs')
    expect(o.webPreferences).toEqual({ preload: '/app/dist/preload/board-preload.cjs', contextIsolation: true, nodeIntegration: false, sandbox: true })
    void FakeWin
  })
})

describe('board.html: the page fetches nothing', () => {
  it("says connect-src 'none' (a file: address matches 'self' and was readable), and keeps the rest of the brain page's policy", async () => {
    const board = await read('src', 'renderer', 'board.html')
    const index = await read('src', 'renderer', 'index.html')
    const policy = (html: string): string => /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1] ?? ''
    const b = policy(board)
    expect(b).toContain("connect-src 'none'")
    expect(b).not.toMatch(/connect-src 'self'/)
    // The brain page's own policy is not this change's business.
    expect(policy(index)).toMatch(/connect-src 'self'/)
    const rest = (p: string): string => p.replace(/connect-src [^;]*;\s*/, '')
    expect(rest(b)).toBe(rest(policy(index)))
  })
})
