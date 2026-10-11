import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newBoardNote } from '@aether/core'
import { MAX_LOAD_PIXELS } from '../../../packages/ui/src/board/imageLoader'
import { FsVault } from '../src/main/fsvault.js'
import { READ_ASSET_HEAD_BYTES, READ_ASSET_MAX_BYTES, READ_ASSET_MAX_PIXELS, readAssetBytes, readAssetChecked } from '../src/main/read-asset.js'
import { createFloatingBoardHost } from '../src/renderer/board-host.js'
import { isBringBackKey, type KeyLike } from '../src/renderer/board-keys.js'
import { ElectronVaultAdapter } from '../src/renderer/vault/electron.js'
import type { AetherBridge, BoardStatusDto, ReadAssetResult, VaultInfo } from '../src/shared/ipc.js'

/**
 * desktop-4 (main half): a picture over the caps is refused by main with the reason, from its header, before the rest is read.
 * shell-6 (host half): a picture's refusal never moves the board's picture folder. live-window-m1: the key w in the floating window.
 */

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-fix-pics-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

/** A PNG's signature and IHDR claiming `w` x `h`, then `pad` filler bytes (main never decodes: the header is all it reads). */
function png(w: number, h: number, pad = 0): Uint8Array {
  const out = new Uint8Array(8 + 25 + pad)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0)
  const dv = new DataView(out.buffer)
  dv.setUint32(16, w)
  dv.setUint32(20, h)
  out.set([8, 6, 0, 0, 0], 24)
  return out
}
async function put(rel: string, bytes: Uint8Array | string): Promise<void> {
  const full = path.join(tmp, ...rel.split('/'))
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, bytes)
}
const vault = (): FsVault => new FsVault([tmp])

describe('readAssetChecked: why a picture is not served', () => {
  it('serves a picture, and says missing for what is not one of the vault', async () => {
    await put('Art/a.png', png(3000, 2000, 500))
    await put('Art/clip.mp4', 'video')
    const v = vault()
    const ok = await readAssetChecked(v, 'Art/a.png')
    expect(ok.ok).toBe(true)
    expect(ok.ok ? ok.bytes.length : 0).toBe(8 + 25 + 500)
    for (const p of ['Art/missing.png', 'Art/clip.mp4', 'Art/note.md', '../x.png', 'Art/']) {
      const res = await readAssetChecked(v, p)
      expect(res, p).toMatchObject({ ok: false, reason: 'missing' })
    }
    expect(await readAssetChecked({ assetAbs: () => null }, 'a.png')).toMatchObject({ ok: false, reason: 'missing' })
  })

  it('says unreadable for an empty file and a disk that says no, and never throws', async () => {
    await put('Art/empty.png', '')
    expect(await readAssetChecked(vault(), 'Art/empty.png')).toMatchObject({ ok: false, reason: 'unreadable' })
    const throws = { assetAbs: (): never => { throw new Error('boom') } }
    expect(await readAssetChecked(throws, 'a.png')).toMatchObject({ ok: false, reason: 'unreadable' })
    await put('Art/folder.png/inner.txt', 'x')
    expect(await readAssetChecked(vault(), 'Art/folder.png')).toMatchObject({ ok: false })
  })

  it('says too-large for a file over the byte cap, with the sizes in the sentence, reading none of it', async () => {
    await put('Art/big.png', png(10, 10, 5000))
    const res = await readAssetChecked(vault(), 'Art/big.png', 1000)
    expect(res).toMatchObject({ ok: false, reason: 'too-large' })
    expect(res.ok ? '' : res.detail).toMatch(/MB; the board shows pictures of up to/)
    expect(READ_ASSET_MAX_BYTES).toBe(64 * 1024 * 1024)
  })

  it('says too-large for a header that claims more pixels than the board decodes, and reads only the head of that file', async () => {
    // 20,000 x 20,000 (400 megapixels, 2.4 GB in the renderer): the file is 2 MB, over the head.
    await put('Art/bomb.png', png(20_000, 20_000, 2_000_000))
    const reads: number[] = []
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation((async (p: Parameters<typeof fs.open>[0], flags?: never) => {
      const handle = await open(p, flags)
      if (!String(p).endsWith('bomb.png')) return handle
      const read = handle.read.bind(handle) as (buf: Uint8Array, off: number, len: number, pos: number) => Promise<{ bytesRead: number }>
      Object.assign(handle, {
        read: async (buf: Uint8Array, off: number, len: number, pos: number) => {
          const r = await read(buf, off, len, pos)
          reads.push(r.bytesRead)
          return r
        },
      })
      return handle
    }) as unknown as typeof fs.open)
    const res = await readAssetChecked(vault(), 'Art/bomb.png')
    expect(res).toMatchObject({ ok: false, reason: 'too-large' })
    expect(res.ok ? '' : res.detail).toMatch(/20000 x 20000 pixels \(400 million\); the board shows pictures of up to 150 million/)
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(READ_ASSET_HEAD_BYTES)
    expect(await readAssetBytes(vault(), 'Art/bomb.png')).toBeNull()
  })

  it('draws the line at 150 million pixels, the loader\'s own: 8192 x 8192 (which the 64 MP thumbnail cap refused) is served', async () => {
    expect(READ_ASSET_MAX_PIXELS).toBe(MAX_LOAD_PIXELS)
    await put('Art/ok-8k.png', png(8192, 8192, 100))
    await put('Art/exact.png', png(15_000, 10_000, 100))
    await put('Art/over.png', png(15_000, 10_001, 100))
    const v = vault()
    expect((await readAssetChecked(v, 'Art/ok-8k.png')).ok).toBe(true)
    expect((await readAssetChecked(v, 'Art/exact.png')).ok).toBe(true)
    expect(await readAssetChecked(v, 'Art/over.png')).toMatchObject({ ok: false, reason: 'too-large' })
  })

  it('serves a file whose header it cannot read (the decoder and the loader refuse what is not a picture)', async () => {
    await put('Art/odd.png', 'this is text, not a png')
    expect((await readAssetChecked(vault(), 'Art/odd.png')).ok).toBe(true)
  })

  it('readAssetBytes (the old call) is the same answer with the reason dropped', async () => {
    await put('Art/a.png', png(100, 100, 10))
    await put('Art/bomb.png', png(30_000, 30_000, 10))
    const v = vault()
    expect(await readAssetBytes(v, 'Art/a.png')).toBeInstanceOf(Uint8Array)
    expect(await readAssetBytes(v, 'Art/bomb.png')).toBeNull()
    expect(await readAssetBytes(v, 'Art/missing.png')).toBeNull()
  })
})

describe('the board page asks main with the reason', () => {
  it('main.ts answers vault:readAssetChecked with a timeout fallback that is a reason, not a null', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8')
    expect(src).toMatch(/ipc\.handle\(IPC\.readAssetChecked, \(_e, p: unknown\)/)
    expect(src).toMatch(/within<ReadAssetResult>\(readAssetChecked\(vault, p\), READ_ASSET_TIMEOUT, \{ ok: false, reason: 'unreadable'/)
    expect(src).toMatch(/ipc\.handle\(IPC\.readAsset, [^\n]*readAssetBytes\(vault, p\)/)
  })

  it('ElectronVaultAdapter.readAssetChecked gives a Blob, or the reason (for the docked board); readAsset is as before', async () => {
    const info: VaultInfo = { root: '/v', name: 'v', roots: [{ path: '/v', mount: '', label: 'v' }], exclude: [], hidden: [], keep: [] }
    const answers: Record<string, ReadAssetResult> = {
      'a.png': { ok: true, bytes: new Uint8Array([1, 2, 3]) },
      'big.png': { ok: false, reason: 'too-large', detail: 'The picture file is 90 MB' },
      'empty.png': { ok: true, bytes: new Uint8Array() },
    }
    const bridge = {
      readAssetChecked: async (p: string) => {
        if (p === 'boom.png') throw new Error('ipc closed')
        return answers[p] ?? { ok: false, reason: 'missing', detail: 'gone' }
      },
      readAsset: async () => new Uint8Array([9]),
    } as unknown as AetherBridge
    const adapter = new ElectronVaultAdapter(bridge, info)
    const ok = await adapter.readAssetChecked('a.png')
    expect(ok.blob?.type).toBe('image/png')
    expect(await adapter.readAssetChecked('big.png')).toEqual({ blob: null, reason: 'too-large', detail: 'The picture file is 90 MB' })
    expect(await adapter.readAssetChecked('nope.png')).toMatchObject({ blob: null, reason: 'missing' })
    expect(await adapter.readAssetChecked('empty.png')).toMatchObject({ blob: null, reason: 'unreadable' })
    expect(await adapter.readAssetChecked('boom.png')).toMatchObject({ blob: null, reason: 'unreadable' })
    expect(await adapter.readAssetChecked('clip.mp4')).toMatchObject({ blob: null, reason: 'missing' })
    expect((await adapter.readAsset('a.png'))?.size).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* The floating host's picture folder (shell-6)                       */
/* ------------------------------------------------------------------ */

const BOARD = 'Boards/Gate.md'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const STATUS: BoardStatusDto = { open: true, path: BOARD, alwaysOnTop: true, opacity: 1, supportsOpacity: true }

function pictureBridge(refuse: (target: string) => string | null) {
  const created: string[] = []
  const bridge = {
    platform: 'linux',
    boardRead: async () => newBoardNote('Gate', new Date('2026-10-09T12:00:00Z')),
    boardSave: async () => ({ ok: true as const }),
    boardAssets: async () => ({ assets: [], truncated: false }),
    boardStatus: async () => STATUS,
    boardConfigure: async () => STATUS,
    boardClose: async () => undefined,
    onChanges: () => () => undefined,
    onBoardState: () => () => undefined,
    createAsset: vi.fn(async (p: string) => {
      const why = refuse(p)
      if (why) throw new Error(`Error invoking remote method 'vault:createAsset': Error: ${why}`)
      created.push(p)
    }),
  }
  return { bridge: bridge as unknown as AetherBridge, created, calls: bridge }
}
const excluded = (p: string): string => `Path is excluded from the vault: ${p}`

describe('the floating host keeps a board\'s pictures in one folder unless the FOLDER is the problem', () => {
  const NOW = (): Date => new Date('2026-10-09T12:00:00Z')

  it('moves to "<Title> pictures" when the vault leaves the board\'s own folder out, and stays there once a picture really went in', async () => {
    const f = pictureBridge((p) => (p.startsWith('Boards/Gate/') ? excluded(p) : null))
    const toast = vi.fn()
    const host = createFloatingBoardHost(f.bridge, BOARD, { now: NOW, toast, status: STATUS })
    expect(await host.pictures.add([{ name: 'a.png', data: PNG }])).toEqual(['Boards/Gate pictures/a.png'])
    f.calls.createAsset.mockClear()
    expect(await host.pictures.add([{ name: 'b.png', data: PNG }])).toEqual(['Boards/Gate pictures/b.png'])
    // The second picture went straight to the folder that works: one call, not a failed try in the first.
    expect(f.calls.createAsset).toHaveBeenCalledTimes(1)
    expect(toast).not.toHaveBeenCalled()
    host.dispose()
  })

  it('does not move the folder for a file name the vault refuses in both (core now cleans a leading $ off the name; any other name the vault leaves out is the same case), and says why', async () => {
    const f = pictureBridge((p) => (/refuse-me/.test(p) ? excluded(p) : null))
    const toast = vi.fn()
    const host = createFloatingBoardHost(f.bridge, BOARD, { now: NOW, toast, status: STATUS })
    expect(await host.pictures.add([{ name: 'refuse-me.png', data: PNG }])).toEqual([null])
    // The next, ordinary picture still goes to the board's own folder.
    expect(await host.pictures.add([{ name: 'later.png', data: PNG }])).toEqual(['Boards/Gate/later.png'])
    expect(f.created).toEqual(['Boards/Gate/later.png'])
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0]![0]).toMatch(/was not added: the vault leaves out names like that/)
    expect(toast.mock.calls[0]![1]).toBe('error')
    host.dispose()
  })

  it('keeps a good picture in the board\'s folder when a bad one comes first in the same drop', async () => {
    const f = pictureBridge((p) => (/refuse-me/.test(p) ? excluded(p) : null))
    const host = createFloatingBoardHost(f.bridge, BOARD, { now: NOW, toast: vi.fn(), status: STATUS })
    expect(
      await host.pictures.add([
        { name: 'refuse-me.png', data: PNG },
        { name: 'rust.png', data: PNG },
        { name: 'other.png', data: PNG },
      ]),
    ).toEqual([null, 'Boards/Gate/rust.png', 'Boards/Gate/other.png'])
    host.dispose()
  })

  it('leaves the reasons the view already words well (a size, a type) to the view, and says nothing itself', async () => {
    const f = pictureBridge((p) => (p.endsWith('big.png') ? 'The picture is too big: 45.2 MB (at most 40 MB)' : p.endsWith('text.png') ? 'Not a picture: the data is not a PNG, JPEG, GIF, WebP, BMP or AVIF image' : null))
    const toast = vi.fn()
    const host = createFloatingBoardHost(f.bridge, BOARD, { now: NOW, toast, status: STATUS })
    expect(await host.pictures.add([{ name: 'big.png', data: PNG }, { name: 'text.png', data: PNG }])).toEqual([null, null])
    expect(toast).not.toHaveBeenCalled()
    host.dispose()
  })

  it('says why for any other refusal, once for a drop, with how many more', async () => {
    const f = pictureBridge(() => 'The disk is full')
    const toast = vi.fn()
    const host = createFloatingBoardHost(f.bridge, BOARD, { now: NOW, toast, status: STATUS })
    await host.pictures.add([{ name: 'a.png', data: PNG }, { name: 'b.png', data: PNG }, { name: 'c.png', data: PNG }])
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0]![0]).toMatch(/was not added: Error invoking remote method 'vault:createAsset': Error: The disk is full \(and 2 more\)|was not added: .*The disk is full.*\(and 2 more\)/)
    host.dispose()
  })
})

describe('the key w in the floating window', () => {
  const key = (over: Partial<KeyLike> = {}): KeyLike => ({
    key: 'w',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    target: { tagName: 'BODY' },
    ...over,
  })

  it('brings the board back from the canvas, the bars and the page', () => {
    expect(isBringBackKey(key(), false)).toBe(true)
    expect(isBringBackKey(key({ target: { tagName: 'CANVAS' } }), false)).toBe(true)
    expect(isBringBackKey(key({ target: { tagName: 'BUTTON' } }), false)).toBe(true)
    expect(isBringBackKey(key({ target: null }), false)).toBe(true)
  })

  it('leaves it alone in a text box, with a modifier, held down, composed, already handled, or with a menu or dialog open', () => {
    expect(isBringBackKey(key({ target: { tagName: 'TEXTAREA' } }), false)).toBe(false)
    expect(isBringBackKey(key({ target: { tagName: 'input' } }), false)).toBe(false)
    expect(isBringBackKey(key({ target: { tagName: 'SELECT' } }), false)).toBe(false)
    expect(isBringBackKey(key({ target: { tagName: 'DIV', isContentEditable: true } }), false)).toBe(false)
    for (const over of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }, { key: 'W' }, { key: 'x' }]) {
      expect(isBringBackKey(key(over), false), JSON.stringify(over)).toBe(false)
    }
    expect(isBringBackKey(key(), true)).toBe(false)
  })

  it('is wired in board.tsx to the board\'s dock command, with the window\'s own close as the way out of a board that did not load', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'board.tsx'), 'utf8')
    expect(src).toContain("isBringBackKey(e, document.querySelector('[data-board-overlay], [role=\"dialog\"]') !== null)")
    expect(src).toContain("board.exec('window.dock')")
    expect(src).toContain('bridge.boardClose()')
    expect(src).toContain('bringBackOnW(bridge)')
  })
})
