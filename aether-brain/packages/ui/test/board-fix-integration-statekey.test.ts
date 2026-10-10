import { describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, parseBoard } from '@aether/core'
import type { BoardHost } from '../src/board/api'
import { VIEW_KEY_PREFIX } from '../src/board/view/session'
import { assetFiles, boardRaw as appBoardRaw, freshApp, vaultFiles } from './board-integration-harness'
import { boardRaw, rig, type Rig } from './helpers/board-view-fakes'

// The first test loads the whole UI package, which takes seconds on a busy machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

/*
 * integration-m9 (d): the camera a board remembers (and the copy of a board that could not be saved) is kept per vault, not only per
 * path: a board of the same name in another vault, or one deleted and made again in a new vault, is another board and opens where its
 * own file says, not where another one was left.
 */

type KeyedHost = BoardHost & { stateKey?: string }

/** A session whose host has this `stateKey`, loaded from `raw` and started, on the given storage. */
function keyed(stateKey: string | undefined, storage?: Map<string, string>): Rig {
  const raw = boardRaw('Gate')
  const r = rig(raw, {}, { load: false, start: false })
  if (stateKey !== undefined) (r.host as KeyedHost).stateKey = stateKey
  if (storage) r.env.storageMap.map = storage
  r.session.loadFromRaw(raw)
  r.session.start()
  return r
}

describe('the camera is remembered per vault', () => {
  it('stores it under the host’s state key, not under the path alone', async () => {
    const r = keyed('memory://A\nBoards/Gate.md')
    r.session.controller.exec('view.zoomIn')
    await r.session.flush()
    expect([...r.env.storageMap.map.keys()]).toEqual([`${VIEW_KEY_PREFIX}memory://A\nBoards/Gate.md`])
  })

  it('a board of the same path in another vault does not pick up the camera, and the same vault does', async () => {
    const storage = new Map<string, string>()
    const first = keyed('memory://A\nBoards/Gate.md', storage)
    first.session.controller.exec('view.zoomIn')
    first.session.controller.exec('view.zoomIn')
    await first.session.flush()
    const zoomed = first.session.controller.state.doc.view.zoom
    const fileView = parseBoard(boardRaw('Gate')).doc.view
    expect(zoomed).not.toBe(fileView.zoom)
    // Another vault, same path: where its own file says.
    const other = keyed('memory://B\nBoards/Gate.md', storage)
    expect(other.session.controller.state.doc.view).toEqual(fileView)
    // The same vault again: where it was left.
    const same = keyed('memory://A\nBoards/Gate.md', storage)
    expect(same.session.controller.state.doc.view.zoom).toBe(zoomed)
  })

  it('a host with no state key keeps the path as the key, as before', async () => {
    const r = keyed(undefined)
    r.session.controller.exec('view.zoomIn')
    await r.session.flush()
    expect([...r.env.storageMap.map.keys()]).toEqual([`${VIEW_KEY_PREFIX}Boards/Gate.md`])
  })
})

describe('the docked host names its board by vault and path', () => {
  it('is the vault’s location and the path, so two vaults with a board of one name differ', async () => {
    const a = await freshApp()
    await a.open(new MemoryVaultAdapter(vaultFiles(), { assets: assetFiles(), location: 'memory://A' }))
    const keyA = a.hostModule.createDockedBoardHost('Boards/Armour.md').stateKey
    const b = await freshApp()
    await b.open(new MemoryVaultAdapter([{ path: 'Boards/Armour.md', content: appBoardRaw('Armour') }], { location: 'memory://B' }))
    const keyB = b.hostModule.createDockedBoardHost('Boards/Armour.md').stateKey
    expect(keyA).toContain('memory://A')
    expect(keyA).toContain('Boards/Armour.md')
    expect(keyB).toContain('memory://B')
    expect(keyA).not.toBe(keyB)
  })
})
