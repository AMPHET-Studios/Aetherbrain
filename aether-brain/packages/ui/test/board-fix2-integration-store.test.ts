import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, type VaultFile } from '@aether/core'
import { ImageCache } from '../src/board/imageCache'
import { createImageLoader } from '../src/board/imageLoader'
import { PNG, assetFiles, boardRaw, freshApp, vaultFiles } from './board-integration-harness'

/**
 * Round 2 of the reference board's review, the store half (integration agent):
 * - live-docked-1: the docked board asks the desktop adapter for a picture WITH the reason there is none, so a picture over 150
 *   megapixels or 64 MiB says "too large to show" (not "can't be read") and is not asked for again and again;
 * - live-docked-m4: `readBoard` can be asked to say nothing (a reload of a board that is already open: its view has said what happened).
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

type Checked = { blob: Blob } | { blob: null; reason: 'missing' | 'too-large' | 'unreadable'; detail: string }

/** The desktop adapter's shape: `readAsset` as before, `readAssetChecked` with main's verdict (renderer/vault/electron.ts). */
class CheckedVault extends MemoryVaultAdapter {
  checkedCalls: string[] = []
  plainCalls: string[] = []
  verdicts = new Map<string, Checked>()
  async readAsset(path: string): Promise<Blob | null> {
    this.plainCalls.push(path)
    return super.readAsset(path)
  }
  /** Main makes no thumbnail of a picture over 64 megapixels (`thumbTarget`): the loader then goes to the original. */
  async thumbnail(): Promise<Blob | null> {
    return null
  }
  async readAssetChecked(path: string): Promise<Checked> {
    this.checkedCalls.push(path)
    const verdict = this.verdicts.get(path)
    if (verdict) return verdict
    const blob = await super.readAsset(path)
    return blob ? { blob } : { blob: null, reason: 'missing', detail: 'That picture is not in the vault' }
  }
}

const assets = () => [
  ...assetFiles(),
  { path: 'Art/giant.png', data: PNG, mtime: 900 },
  { path: 'Art/fat.png', data: PNG, mtime: 800 },
  { path: 'Art/broken.png', data: PNG, mtime: 700 },
  { path: 'Art/clip.mp4', data: PNG, mtime: 600 },
]
const checkedVault = (files: VaultFile[] = vaultFiles()) => {
  const v = new CheckedVault(files, { assets: assets() })
  v.verdicts.set('Art/giant.png', { blob: null, reason: 'too-large', detail: 'Art/giant.png claims 256 megapixels: over the 150 megapixel limit' })
  v.verdicts.set('Art/fat.png', { blob: null, reason: 'too-large', detail: 'Art/fat.png is over 64 MiB' })
  v.verdicts.set('Art/broken.png', { blob: null, reason: 'unreadable', detail: 'The picture could not be read' })
  return v
}
const toastTexts = (app: Awaited<ReturnType<typeof freshApp>>) => app.s().toasts.map((t) => t.text)
const reasonOf = (err: unknown) => (err as { reason?: unknown }).reason

describe('readPicture says why there is no picture when the adapter can (live-docked-1)', () => {
  it('rejects with the adapter\'s reason, and the detail as the message, for a verdict about the file', async () => {
    const app = await freshApp()
    const v = await app.open(checkedVault())
    const giant = await app.s().readPicture('Art/giant.png').catch((e: unknown) => e)
    expect(giant).toBeInstanceOf(Error)
    expect(reasonOf(giant)).toBe('too-large')
    expect((giant as Error).message).toMatch(/256 megapixels/)
    expect(reasonOf(await app.s().readPicture('Art/fat.png').catch((e: unknown) => e))).toBe('too-large')
    expect(reasonOf(await app.s().readPicture('Art/broken.png').catch((e: unknown) => e))).toBe('unreadable')
    expect(reasonOf(await app.s().readPicture('Art/nowhere.png').catch((e: unknown) => e))).toBe('missing')
    // The checked read is the one that was asked: no second read through the plain one.
    expect(v.checkedCalls).toEqual(['Art/giant.png', 'Art/fat.png', 'Art/broken.png', 'Art/nowhere.png'])
    expect(v.plainCalls).toEqual([])
  })

  it('still hands over the picture when there is one', async () => {
    const app = await freshApp()
    await app.open(checkedVault())
    const blob = await app.s().readPicture('Art/gate.png')
    expect(blob?.type).toBe('image/png')
    expect(blob?.size).toBe(PNG.length)
  })

  it('does not ask for a video (not a picture to read whole): null, no round trip', async () => {
    const app = await freshApp()
    const v = await app.open(checkedVault())
    expect(await app.s().readPicture('Art/clip.mp4')).toBeNull()
    expect(v.checkedCalls).toEqual([])
  })

  it('answers null (never a rejection without a reason) when the checked read itself throws', async () => {
    const app = await freshApp()
    const v = await app.open(checkedVault())
    v.readAssetChecked = async () => {
      throw new Error('the bridge is gone')
    }
    expect(await app.s().readPicture('Art/gate.png')).toBeNull()
  })

  it('keeps the web and memory path: an adapter with no readAssetChecked gives the picture or null, as before', async () => {
    const app = await freshApp()
    await app.open(new MemoryVaultAdapter(vaultFiles(), { assets: assetFiles() }))
    expect((await app.s().readPicture('Art/gate.png'))?.size).toBe(PNG.length)
    expect(await app.s().readPicture('Art/missing.png')).toBeNull()
    expect(await app.s().readPicture('Inbox/Idea.md')).toBeNull()
    // No adapter at all.
    const none = await freshApp()
    expect(await none.s().readPicture('Art/gate.png')).toBeNull()
  })

  it('end to end: the docked host and the real picture cache give "too-large" for a picture over a limit, once, and it stays', async () => {
    const app = await freshApp()
    const v = await app.open(checkedVault([...vaultFiles(), { path: 'Boards/Giants.md', content: boardRaw('Giants', ['Art/giant.png', 'Art/fat.png', 'Art/gate.png']) }]))
    const host = app.hostModule.createDockedBoardHost('Boards/Giants.md')
    // No thumbnails (like main for a picture over 64 megapixels): every tier falls through to the original.
    let now = 0
    const cache = new ImageCache({ load: createImageLoader(host.pictures), onLoaded: () => {}, now: () => now })
    const settle = async () => {
      cache.get('Art/giant.png', 300)
      cache.get('Art/fat.png', 300)
      await new Promise((r) => setTimeout(r, 10))
    }
    cache.setVisible(['Art/giant.png', 'Art/fat.png'])
    await settle()
    await settle()
    expect(cache.failureOf('Art/giant.png')).toBe('too-large')
    expect(cache.failureOf('Art/fat.png')).toBe('too-large')
    expect(cache.get('Art/giant.png', 300)).toMatchObject({ bitmap: null, failed: true, reason: 'too-large' })
    const reads = v.checkedCalls.length
    // A verdict about the file is kept: ten minutes later (past every retry of a plain failure) nothing is asked again.
    now += 10 * 60_000
    await settle()
    await settle()
    expect(v.checkedCalls).toHaveLength(reads)
    expect(v.plainCalls).toEqual([])
    cache.dispose()
    host.dispose()
  })
})

describe('readBoard can be quiet (live-docked-m4, store half)', () => {
  it('toasts "not in the vault" for a real open, and says nothing when asked to be quiet', async () => {
    const app = await freshApp()
    await app.open(new MemoryVaultAdapter(vaultFiles(), { assets: assetFiles() }))
    expect(await app.s().readBoard('Boards/Nowhere.md')).toBeNull()
    expect(toastTexts(app)).toEqual(['Could not open the board: Boards/Nowhere.md is not in the vault'])
    expect(await app.s().readBoard('Boards/Nowhere.md', { quiet: true })).toBeNull()
    expect(toastTexts(app)).toHaveLength(1)
  })

  it('is quiet about a note that is no longer on disk, or that no longer reads as a board, and still answers null', async () => {
    const app = await freshApp()
    const v = await app.open(new MemoryVaultAdapter(vaultFiles(), { assets: assetFiles() }))
    // Gone from the disk before the watcher reported it.
    const adapter = v as unknown as { read(path: string): Promise<string | null> }
    const read = adapter.read.bind(v)
    let gone = true
    adapter.read = async (p) => (gone && p === 'Boards/Armour.md' ? null : read(p))
    expect(await app.s().readBoard('Boards/Armour.md')).toBeNull()
    expect(toastTexts(app).at(-1)).toBe('Could not open the board: Boards/Armour.md is no longer on disk')
    const before = toastTexts(app).length
    expect(await app.s().readBoard('Boards/Armour.md', { quiet: true })).toBeNull()
    expect(toastTexts(app)).toHaveLength(before)
    gone = false

    // Edited into something that is no board.
    await v.write('Boards/Armour.md', '---\ntitle: Armour\ntype: note\n---\n# Armour\n')
    app.s().applyExternal([{ kind: 'change', path: 'Boards/Armour.md', content: '---\ntitle: Armour\ntype: note\n---\n# Armour\n', mtime: Date.now() }])
    expect(await app.s().readBoard('Boards/Armour.md')).toBeNull()
    expect(toastTexts(app).at(-1)).toMatch(/Armour is not a board/)
    const after = toastTexts(app).length
    expect(await app.s().readBoard('Boards/Armour.md', { quiet: true })).toBeNull()
    expect(toastTexts(app)).toHaveLength(after)
  })

  it('a quiet read of a board that is there is the same read: the text on disk', async () => {
    const app = await freshApp()
    const v = await app.open(new MemoryVaultAdapter(vaultFiles(), { assets: assetFiles() }))
    const raw = (await v.read('Boards/Armour.md'))!
    expect(await app.s().readBoard('Boards/Armour.md', { quiet: true })).toBe(raw)
    expect(await app.s().readBoard('Boards/Armour.md')).toBe(raw)
    expect(toastTexts(app)).toEqual([])
  })
})
