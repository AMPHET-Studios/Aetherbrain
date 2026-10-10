import { describe, expect, it } from 'vitest'
import { MemoryVaultAdapter, READ_ASSET_MAX_BYTES, type VaultAdapter } from '@aether/core'

/** Bytes that hit every value, so a text round trip or a truncation shows. */
function bytesOf(n: number, seed = 5): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 97 + seed + (i >> 8)) & 255
  return out
}

const vaultWith = (assets: { path: string; data: Uint8Array }[]) => new MemoryVaultAdapter([{ path: 'Art/note.md', content: '# n' }], { assets })
const bytesOfBlob = async (b: Blob | null) => (b ? new Uint8Array(await b.arrayBuffer()) : null)

describe('MemoryVaultAdapter.readAsset', () => {
  it('is part of the adapter the app talks to', () => {
    const a: VaultAdapter = vaultWith([])
    expect(typeof a.readAsset).toBe('function')
  })

  it('gives the stored bytes whole, in a Blob typed by the extension', async () => {
    const types: Record<string, string> = {
      'a.png': 'image/png',
      'b.jpg': 'image/jpeg',
      'c.jpeg': 'image/jpeg',
      'd.webp': 'image/webp',
      'e.gif': 'image/gif',
      'f.bmp': 'image/bmp',
      'g.avif': 'image/avif',
      'H.PNG': 'image/png',
      'I.JpG': 'image/jpeg',
    }
    const stored = Object.keys(types).map((name, i) => ({ path: `Art/${name}`, data: bytesOf(300 + i, i) }))
    const a = vaultWith(stored)
    for (const { path, data } of stored) {
      const blob = await a.readAsset(path)
      expect(blob?.type, path).toBe(types[path.slice('Art/'.length)])
      expect(blob?.size, path).toBe(data.length)
      expect(await bytesOfBlob(blob), path).toEqual(data)
    }
  })

  it('reads a picture added later, and not one that was removed', async () => {
    const a = vaultWith([])
    expect(await a.readAsset('Art/new.png')).toBeNull()
    const data = bytesOf(64)
    await a.createAsset('Art/new.png', data)
    expect(await bytesOfBlob(await a.readAsset('Art/new.png'))).toEqual(data)
    await a.remove('Art/new.png')
    expect(await a.readAsset('Art/new.png')).toBeNull()
  })

  it('takes the paths the rest of the adapter takes: backslashes, a leading ./ and doubled slashes', async () => {
    const data = bytesOf(40)
    const a = vaultWith([{ path: 'Art/Deep/gate.png', data }])
    for (const p of ['Art/Deep/gate.png', 'Art\\Deep\\gate.png', './Art/Deep/gate.png', '/Art//Deep/gate.png']) {
      expect(await bytesOfBlob(await a.readAsset(p)), p).toEqual(data)
    }
  })

  it('is null for a picture that is not there, a note, and a path that names nothing', async () => {
    const a = vaultWith([{ path: 'Art/a.png', data: bytesOf(10) }])
    for (const p of ['Art/missing.png', 'Art/note.md', 'Art', '', 'Art/a.png/', '../Art/a.png']) expect(await a.readAsset(p), p).toBeNull()
  })

  it('is null for a video, which the vault lists as an asset but the board does not read as a picture', async () => {
    const a = vaultWith([
      { path: 'Art/clip.mp4', data: bytesOf(100) },
      { path: 'Art/clip.webm', data: bytesOf(100) },
      { path: 'Art/clip.mov', data: bytesOf(100) },
    ])
    expect((await a.listAssets()).map((x) => x.path).sort()).toEqual(['Art/clip.mov', 'Art/clip.mp4', 'Art/clip.webm'])
    for (const p of ['Art/clip.mp4', 'Art/clip.webm', 'Art/clip.mov']) expect(await a.readAsset(p), p).toBeNull()
    // The preview path still serves them: only readAsset is pictures-only.
    expect(await a.thumbnail('Art/clip.mp4', 128)).not.toBeNull()
  })

  it('is null for a picture that holds no bytes (a simulated external add), and for one in a skipped folder', async () => {
    const a = vaultWith([
      { path: 'Art/empty.png', data: new Uint8Array(0) },
      { path: '.hidden/x.png', data: bytesOf(10) },
      { path: 'node_modules/x.png', data: bytesOf(10) },
    ])
    a.external([{ kind: 'add', path: 'Art/arrived.png', mtime: 5 }])
    expect((await a.listAssets()).map((x) => x.path).sort()).toEqual(['Art/arrived.png', 'Art/empty.png'])
    for (const p of ['Art/empty.png', 'Art/arrived.png', '.hidden/x.png', 'node_modules/x.png']) expect(await a.readAsset(p), p).toBeNull()
  })

  it('serves a picture of exactly 64 MiB and refuses one byte more', async () => {
    expect(READ_ASSET_MAX_BYTES).toBe(64 * 1024 * 1024)
    const a = vaultWith([
      { path: 'Art/exact.png', data: new Uint8Array(READ_ASSET_MAX_BYTES) },
      { path: 'Art/over.png', data: new Uint8Array(READ_ASSET_MAX_BYTES + 1) },
    ])
    expect((await a.readAsset('Art/exact.png'))?.size).toBe(READ_ASSET_MAX_BYTES)
    expect(await a.readAsset('Art/over.png')).toBeNull()
  })

  it('does not change what it reads from: the stored bytes and the listing stay as they were', async () => {
    const data = bytesOf(50)
    const copy = data.slice()
    const a = vaultWith([{ path: 'Art/a.png', data }])
    const before = await a.listAssets()
    await a.readAsset('Art/a.png')
    await a.readAsset('Art/a.png')
    expect(a.assetData('Art/a.png')).toBe(data)
    expect(data).toEqual(copy)
    expect(await a.listAssets()).toEqual(before)
  })
})
