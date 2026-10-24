import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, encodeProxy, type VaultFile } from '@aether/core'
import { PNG, assetFiles, freshApp, vaultFiles } from './board-integration-harness'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/**
 * The docked board (inside the brain window) and a 3D model: the picker lists the vault's models with its pictures, and a model's proxy
 * comes from the vault's adapter through the store, which never rejects; a vault whose adapter has no 3D models says null.
 */

const PROXY = encodeProxy({ centre: [0, 0, 0], half: 1, positions: [-32767, 0, 0, 32767, 0, 0, 0, 32767, 0], colors: [255, 0, 0, 0, 255, 0, 0, 0, 255], indices: [0, 1, 2] })

/** A vault with a model and a video among its pictures, and an adapter that has proxies for some models. */
class ModelVault extends MemoryVaultAdapter {
  asked: string[] = []
  constructor(files: VaultFile[] = vaultFiles(), private readonly proxies: Record<string, Uint8Array | 'throws'> = { 'Art/robot.glb': PROXY }) {
    super(files, { assets: [...assetFiles(), { path: 'Art/robot.glb', data: PNG, mtime: 600 }, { path: 'Art/turntable.mp4', data: PNG, mtime: 500 }] })
  }
  async modelProxy(path: string): Promise<Uint8Array | null> {
    this.asked.push(path)
    const p = this.proxies[path]
    if (p === 'throws') throw new Error('the helper stopped')
    return p ?? null
  }
}

async function hosted(v: MemoryVaultAdapter) {
  const app = await freshApp()
  await app.open(v)
  const host = app.hostModule.createDockedBoardHost('Boards/Armour.md')
  await host.load()
  return { app, host }
}

describe('the docked board and a 3D model', () => {
  it('lists the vault’s models with its pictures for the picker (not its videos), and knows a model exists', async () => {
    const { host } = await hosted(new ModelVault())
    const paths = (await host.pictures.list()).map((a) => a.path)
    expect(paths).toContain('Art/robot.glb')
    expect(paths).not.toContain('Art/turntable.mp4')
    expect(paths.some((p) => p.endsWith('.png'))).toBe(true)
    expect(host.pictures.exists('Art/robot.glb')).toBe(true)
    expect(host.pictures.exists('Art/other.glb')).toBe(false)
  })

  it('gives a model’s proxy from the adapter through the store, and null for a model with none and for an adapter that throws', async () => {
    const v = new ModelVault(vaultFiles(), { 'Art/robot.glb': PROXY, 'Art/boom.glb': 'throws' })
    const { host } = await hosted(v)
    expect(await host.pictures.modelProxy!('Art/robot.glb')).toEqual(PROXY)
    expect(await host.pictures.modelProxy!('Art/none.glb')).toBeNull()
    expect(await host.pictures.modelProxy!('Art/boom.glb')).toBeNull()
    expect(v.asked).toEqual(['Art/robot.glb', 'Art/none.glb', 'Art/boom.glb'])
  })

  it('gives null where the vault’s adapter has no 3D models (the web app)', async () => {
    const { host } = await hosted(new MemoryVaultAdapter(vaultFiles(), { assets: assetFiles() }))
    expect(await host.pictures.modelProxy!('Art/robot.glb')).toBeNull()
  })

  it('never reads a model whole for the board: the full-size read is null, as for a video', async () => {
    const { host } = await hosted(new ModelVault())
    expect(await host.pictures.original('Art/robot.glb')).toBeNull()
  })
})
