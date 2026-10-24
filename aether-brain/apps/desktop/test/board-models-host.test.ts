import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { newBoardNote } from '@aether/core'
import { createFloatingBoardHost } from '../src/renderer/board-host.js'
import { ElectronVaultAdapter } from '../src/renderer/vault/electron.js'
import { PictureLedger } from '../src/main/board-window.js'
import { isImageName, isModelName } from '../src/main/fsvault.js'
import type { AetherBridge, BoardStatusDto, VaultChangeDto, VaultInfo } from '../src/shared/ipc.js'
import { lf } from './lf.js'

/**
 * A 3D model on a board reaches the page the way a picture does, with one more door: the floating window lists the vault's models
 * with its pictures (or a model would be drawn as "file missing"), keeps that list in step with the watcher, and asks main for a model's
 * proxy through `modelProxy`; the docked board gets the same through the vault's adapter.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const BOARD = 'Boards/Gate.md'
const STATUS: BoardStatusDto = { open: true, path: BOARD, alwaysOnTop: true, opacity: 1, supportsOpacity: true }

function bridgeOf(assets: string[], proxy: (p: string) => Promise<Uint8Array | null>) {
  const subs = new Set<(c: VaultChangeDto[]) => void>()
  const calls = { assets: 0, proxies: [] as string[] }
  const bridge = {
    platform: 'linux',
    boardRead: async () => newBoardNote('Gate', new Date('2026-10-09T12:00:00Z')),
    boardSave: async () => ({ ok: true as const }),
    boardAssets: async () => (calls.assets++, { assets: assets.map((p) => ({ path: p })), truncated: false }),
    boardStatus: async () => STATUS,
    boardConfigure: async () => STATUS,
    boardClose: async () => undefined,
    onChanges: (cb: (c: VaultChangeDto[]) => void) => (subs.add(cb), () => void subs.delete(cb)),
    onBoardState: () => () => undefined,
    modelProxy: vi.fn(async (p: string) => (calls.proxies.push(p), proxy(p))),
  }
  return { bridge: bridge as unknown as AetherBridge, calls, emit: (c: VaultChangeDto[]) => subs.forEach((s) => s(c)), mock: bridge.modelProxy }
}

describe('the floating board host and a 3D model', () => {
  it('lists the vault’s models with its pictures, so a model is not drawn as missing, and not a video or a note', async () => {
    const t = bridgeOf(['Art/gate.png', 'Art/robot.glb', 'Art/ROBOT2.GLB', 'Art/clip.mp4', 'Notes/a.md'], async () => null)
    const host = createFloatingBoardHost(t.bridge, BOARD)
    const list = await host.pictures.list()
    expect(list.map((a) => a.path).sort()).toEqual(['Art/ROBOT2.GLB', 'Art/gate.png', 'Art/robot.glb'])
    expect(host.pictures.exists('Art/robot.glb')).toBe(true)
    expect(host.pictures.exists('Art/other.glb')).toBe(false)
    host.dispose()
  })

  it('keeps the list in step: a model that was added, or removed, is in it, or is not', async () => {
    const t = bridgeOf(['Art/robot.glb'], async () => null)
    const host = createFloatingBoardHost(t.bridge, BOARD)
    await host.pictures.list()
    t.emit([{ kind: 'add', path: 'Art/new.glb', mtime: 5, size: 100 } as VaultChangeDto])
    t.emit([{ kind: 'unlink', path: 'Art/robot.glb' } as VaultChangeDto])
    expect(host.pictures.exists('Art/robot.glb')).toBe(false)
    expect(host.pictures.exists('Art/new.glb')).toBe(true)
    host.dispose()
  })

  it('asks main for a model’s proxy through the bridge, gives its bytes, and gives null for none or for a failure, never an error', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const t = bridgeOf([], async (p) => {
      if (p === 'Art/boom.glb') throw new Error('ipc closed')
      if (p === 'Art/empty.glb') return new Uint8Array()
      return p === 'Art/robot.glb' ? bytes : null
    })
    const host = createFloatingBoardHost(t.bridge, BOARD)
    expect(await host.pictures.modelProxy!('Art/robot.glb')).toBe(bytes)
    expect(await host.pictures.modelProxy!('Art/none.glb')).toBeNull()
    expect(await host.pictures.modelProxy!('Art/empty.glb')).toBeNull()
    expect(await host.pictures.modelProxy!('Art/boom.glb')).toBeNull()
    expect(t.calls.proxies).toEqual(['Art/robot.glb', 'Art/none.glb', 'Art/empty.glb', 'Art/boom.glb'])
    host.dispose()
  })

  it('never reads a model whole: the full-size read of a picture says null for it, as for a video', async () => {
    const t = bridgeOf([], async () => null)
    const readAssetChecked = vi.fn()
    ;(t.bridge as unknown as Record<string, unknown>)['readAssetChecked'] = readAssetChecked
    const host = createFloatingBoardHost(t.bridge, BOARD)
    expect(await host.pictures.original('Art/robot.glb')).toBeNull()
    expect(readAssetChecked).not.toHaveBeenCalled()
    host.dispose()
  })
})

describe('the docked board and a 3D model (the vault’s adapter)', () => {
  const info: VaultInfo = { root: '/v', name: 'v', roots: [{ path: '/v', mount: '', label: 'v' }], exclude: [], hidden: [], keep: [] }

  it('gives a model’s proxy from the bridge, and null for none, for an empty answer and for a failure', async () => {
    const bridge = {
      modelProxy: async (p: string) => {
        if (p === 'boom.glb') throw new Error('ipc closed')
        if (p === 'empty.glb') return new Uint8Array()
        return p === 'robot.glb' ? new Uint8Array([4, 5]) : null
      },
    } as unknown as AetherBridge
    const adapter = new ElectronVaultAdapter(bridge, info)
    expect(await adapter.modelProxy('robot.glb')).toEqual(new Uint8Array([4, 5]))
    expect(await adapter.modelProxy('none.glb')).toBeNull()
    expect(await adapter.modelProxy('empty.glb')).toBeNull()
    expect(await adapter.modelProxy('boom.glb')).toBeNull()
  })
})

describe('main’s list for the board window', () => {
  it('holds pictures and models, as changes arrive, and nothing else', () => {
    const ledger = new PictureLedger((name) => isImageName(name) || isModelName(name))
    ledger.apply([
      { kind: 'add', path: 'Art/a.png', mtime: 1, size: 10 },
      { kind: 'add', path: 'Art/robot.glb', mtime: 2, size: 20 },
      { kind: 'add', path: 'Art/clip.mp4', mtime: 3, size: 30 },
      { kind: 'add', path: 'Art/note.md', mtime: 4, size: 40 },
    ] as VaultChangeDto[])
    expect(ledger.list([]).map((a) => a.path).sort()).toEqual(['Art/a.png', 'Art/robot.glb'])
    ledger.apply([{ kind: 'unlink', path: 'Art/robot.glb' }] as VaultChangeDto[])
    expect(ledger.list([{ path: 'Art/robot.glb' }, { path: 'Art/a.png' }]).map((a) => a.path)).toEqual(['Art/a.png'])
  })

  it('is what main gives the board window (the brain’s own ledger is the one with videos)', () => {
    const main = lf(readFileSync(path.join(here, '..', 'src', 'main', 'main.ts'), 'utf8'))
    expect(main).toContain('const pictureLedger = new PictureLedger((name) => isImageName(name) || isModelName(name))')
    expect(main).toContain('const assetLedger = new PictureLedger(isAssetName)')
    expect(main).toContain('ledger: pictureLedger')
  })
})
