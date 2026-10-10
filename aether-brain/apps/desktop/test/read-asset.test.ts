import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FsVault } from '../src/main/fsvault.js'
import { READ_ASSET_MAX_BYTES, readAssetBytes, type AssetReader } from '../src/main/read-asset.js'
import { ElectronVaultAdapter } from '../src/renderer/vault/electron.js'
import type { AetherBridge, VaultInfo } from '../src/shared/ipc.js'

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-read-asset-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

/** Deterministic bytes that hit every value (a text round trip, a UTF-8 decode or a trim would change them). */
function bytesOf(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 131 + seed + (i >> 8)) & 255
  return out
}
/** A PNG's signature followed by `n` bytes: main never looks inside, so this is all a "picture" needs to be. */
const pngBytes = (n = 3000): Uint8Array => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...bytesOf(n)])

async function put(rel: string, content: Uint8Array | string = ''): Promise<string> {
  const full = path.join(tmp, ...rel.split('/'))
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
  return full
}

/** The bytes of a vault file on disk as a plain Uint8Array. */
const onDisk = async (rel: string): Promise<Uint8Array> => new Uint8Array(await fs.readFile(path.join(tmp, ...rel.split('/'))))

describe('readAssetBytes: a picture of the vault, whole and undecoded', () => {
  it('serves a picture byte for byte, for every picture extension and any letter case', async () => {
    const v = new FsVault([tmp])
    for (const name of ['a.png', 'b.jpg', 'c.JPEG', 'd.webp', 'e.GIF', 'f.bmp', 'g.avif', 'Mixed.Png']) {
      const bytes = bytesOf(1500, name.length)
      await put(`Art/${name}`, bytes)
      const got = await readAssetBytes(v, `Art/${name}`)
      expect(got, name).toBeInstanceOf(Uint8Array)
      expect(got?.byteLength, name).toBe(bytes.length)
      expect(got, name).toEqual(bytes)
    }
  })

  it('serves a png and a jpg of a realistic size untouched', async () => {
    const png = pngBytes(200_000)
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...bytesOf(150_000, 3), 0xff, 0xd9])
    await put('Art/gate.png', png)
    await put('Art/photo.jpg', jpg)
    const v = new FsVault([tmp])
    expect(await readAssetBytes(v, 'Art/gate.png')).toEqual(png)
    expect(await readAssetBytes(v, 'Art/photo.jpg')).toEqual(jpg)
  })

  it('finds a picture under a backslash path, a name with spaces and accents, and in a multi-root vault', async () => {
    const bytes = pngBytes(500)
    await put('vault/Art/Gate at dusk é ü.png', bytes)
    await put('other/b.gif', bytesOf(40))
    const single = new FsVault([path.join(tmp, 'vault')])
    expect(await readAssetBytes(single, 'Art\\Gate at dusk é ü.png')).toEqual(bytes)
    const multi = new FsVault([path.join(tmp, 'vault'), path.join(tmp, 'other')])
    expect(await readAssetBytes(multi, 'vault/Art/Gate at dusk é ü.png')).toEqual(bytes)
    expect(await readAssetBytes(multi, 'other/b.gif')).toEqual(bytesOf(40))
    expect(await readAssetBytes(multi, 'nowhere/b.gif')).toBeNull()
  })

  it('serves no video, although the vault knows videos as assets: the board shows pictures', async () => {
    const v = new FsVault([tmp])
    for (const name of ['clip.mp4', 'clip.m4v', 'clip.mov', 'clip.webm', 'CLIP.MP4']) {
      await put(`Art/${name}`, bytesOf(800))
      // The vault itself would hand the file out: the refusal is readAssetBytes's own.
      expect(await v.assetAbs(`Art/${name}`), name).toBe(path.join(tmp, 'Art', name))
      expect(await readAssetBytes(v, `Art/${name}`), name).toBeNull()
    }
  })

  it('serves nothing that is not a picture name: notes, text, programs, svg, a name that only ends like one', async () => {
    const v = new FsVault([tmp])
    for (const name of ['note.md', 'readme.txt', 'tool.exe', 'vector.svg', 'archive.png.zip', 'pngfile', 'x.pngx', '~$office.png']) {
      await put(`Art/${name}`, bytesOf(300))
      expect(await readAssetBytes(v, `Art/${name}`), name).toBeNull()
    }
    expect(await readAssetBytes(v, '')).toBeNull()
    expect(await readAssetBytes(v, 'Art/')).toBeNull()
  })

  it('refuses a path that leaves the vault, though the file is there and readable', async () => {
    await put('outside/secret.png', pngBytes(100))
    await put('vault/Art/gate.png', pngBytes(100))
    const v = new FsVault([path.join(tmp, 'vault')])
    expect(await readAssetBytes(v, 'Art/gate.png')).not.toBeNull()
    expect((await onDisk('outside/secret.png')).length).toBeGreaterThan(0)
    for (const p of ['../outside/secret.png', 'Art/../../outside/secret.png', '..\\outside\\secret.png']) {
      expect(await readAssetBytes(v, p), p).toBeNull()
    }
  })

  it.skipIf(process.platform === 'win32')('refuses links: to a picture in the vault, to one outside it, and a folder link', async () => {
    await put('outside/secret.png', pngBytes(100))
    await put('vault/Art/gate.png', pngBytes(100))
    await fs.symlink(path.join(tmp, 'vault', 'Art', 'gate.png'), path.join(tmp, 'vault', 'Art', 'alias.png'))
    await fs.symlink(path.join(tmp, 'outside', 'secret.png'), path.join(tmp, 'vault', 'Art', 'leak.png'))
    await fs.symlink(path.join(tmp, 'outside'), path.join(tmp, 'vault', 'Link'))
    await fs.symlink(path.join(tmp, 'vault', 'Art', 'gate.png'), path.join(tmp, 'vault', 'Art', 'a-file.txt'))
    const v = new FsVault([path.join(tmp, 'vault')])
    expect(await readAssetBytes(v, 'Art/gate.png')).not.toBeNull()
    for (const p of ['Art/alias.png', 'Art/leak.png', 'Link/secret.png']) expect(await readAssetBytes(v, p), p).toBeNull()
  })

  it('refuses the folders the vault leaves out: hidden, dependency, build and cache folders, and one the user hid', async () => {
    const paths = ['.hidden/x.png', 'node_modules/x.png', 'Art/node_modules/deep/x.png', 'Library/x.png', 'Build/x.png', 'Cache/x.png', 'Art/Temp/x.png', '$Recycle.Bin/x.png', 'Secret/x.png']
    for (const p of paths) await put(p, pngBytes(50))
    await put('Art/visible.png', pngBytes(50))
    const v = new FsVault([tmp], { hidden: [path.join(tmp, 'Secret')] })
    expect(await readAssetBytes(v, 'Art/visible.png')).not.toBeNull()
    for (const p of paths) expect(await readAssetBytes(v, p), p).toBeNull()
    // Lifted, the same file is served: the refusal came from the folder rule.
    v.hidden = []
    expect(await readAssetBytes(v, 'Secret/x.png')).not.toBeNull()
  })

  it('refuses a file over the limit and serves one of exactly the limit', async () => {
    await put('Art/big.png', bytesOf(11))
    await put('Art/exact.png', bytesOf(10))
    await put('Art/small.png', bytesOf(9))
    const v = new FsVault([tmp])
    expect(await readAssetBytes(v, 'Art/big.png', 10)).toBeNull()
    expect(await readAssetBytes(v, 'Art/exact.png', 10)).toEqual(bytesOf(10))
    expect(await readAssetBytes(v, 'Art/small.png', 10)).toEqual(bytesOf(9))
    // The default limit is the contract's 64 MiB, and the same cap as the thumbnail path's.
    expect(READ_ASSET_MAX_BYTES).toBe(64 * 1024 * 1024)
    expect(await readAssetBytes(v, 'Art/big.png')).toEqual(bytesOf(11))
  })

  it('serves nothing for an empty file, a missing one, a folder named like a picture, or a vault that has no such path', async () => {
    await put('Art/empty.png')
    await fs.mkdir(path.join(tmp, 'Art', 'Folder.png'))
    const v = new FsVault([tmp])
    for (const p of ['Art/empty.png', 'Art/missing.png', 'Art/Folder.png', 'Missing/x.png']) expect(await readAssetBytes(v, p), p).toBeNull()
  })

  it('never throws: a vault that throws or rejects, a path that is gone by the time it is read, a path that is not a file', async () => {
    const throws: AssetReader = {
      assetAbs: () => {
        throw new Error('boom')
      },
    }
    const rejects: AssetReader = { assetAbs: () => Promise.reject(new Error('boom')) }
    expect(await readAssetBytes(throws, 'a.png')).toBeNull()
    expect(await readAssetBytes(rejects, 'a.png')).toBeNull()
    // The vault says yes, the file was deleted in between (or is a folder, or the disk errors).
    expect(await readAssetBytes({ assetAbs: async () => path.join(tmp, 'gone.png') }, 'gone.png')).toBeNull()
    expect(await readAssetBytes({ assetAbs: async () => tmp }, 'dir.png')).toBeNull()
    // A vault that answers at once, with a path or with nothing, is as good as one that answers later.
    const file = await put('plain.png', bytesOf(64))
    expect(await readAssetBytes({ assetAbs: () => file }, 'plain.png')).toEqual(bytesOf(64))
    expect(await readAssetBytes({ assetAbs: () => null }, 'plain.png')).toBeNull()
  })

  it('does not look inside the bytes: no signature check, no size check, nothing decoded', async () => {
    // Not a real picture at all: main hands it over and the renderer's decoder refuses it.
    await put('Art/notreally.png', 'this is text, not a png')
    // A header that claims 60000 x 60000 pixels (the thumbnail path refuses it; reading does not decode, so it must not look).
    const huge = pngBytes(0)
    const claim = Uint8Array.from([...huge, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0xea, 0x60, 0, 0, 0xea, 0x60, 8, 6, 0, 0, 0])
    await put('Art/claims-huge.png', claim)
    const v = new FsVault([tmp])
    expect(await readAssetBytes(v, 'Art/notreally.png')).toEqual(new TextEncoder().encode('this is text, not a png'))
    expect(await readAssetBytes(v, 'Art/claims-huge.png')).toEqual(claim)
  })
})

describe('readAssetBytes: how much of a file is ever read', () => {
  interface Read {
    size: number
    len: number
    pos: number
    got: number
  }
  /** Spies on fs.open for `file`: records every read (the buffer it was given, what it asked for, where, what came back); `lie` is the size stat reports. */
  function watchReads(file: string, lie?: number): { reads: Read[]; opens: () => number } {
    const reads: Read[] = []
    let opens = 0
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation((async (p: Parameters<typeof fs.open>[0], flags?: never) => {
      const handle = await open(p, flags)
      if (String(p) !== file) return handle
      opens++
      const read = handle.read.bind(handle) as (buf: Uint8Array, off: number, len: number, pos: number) => Promise<{ bytesRead: number }>
      const stat = handle.stat.bind(handle)
      Object.assign(handle, {
        read: async (buf: Uint8Array, off: number, len: number, pos: number) => {
          const res = await read(buf, off, len, pos)
          reads.push({ size: buf.length, len, pos, got: res.bytesRead })
          return res
        },
        stat: async () => (lie === undefined ? stat() : { ...(await stat()), size: lie }),
      })
      return handle
    }) as unknown as typeof fs.open)
    return { reads, opens: () => opens }
  }

  it('reads nothing of a file that stats over the limit', async () => {
    const file = await put('Art/big.png', bytesOf(5000))
    const w = watchReads(file)
    expect(await readAssetBytes(new FsVault([tmp]), 'Art/big.png', 10)).toBeNull()
    expect(w.opens()).toBe(1)
    expect(w.reads).toEqual([])
  })

  it('never holds or reads more than limit + 1 bytes of a file that grew after it was stat-ed', async () => {
    const file = await put('Art/grows.png', bytesOf(5000))
    // stat says 3 bytes; the disk holds 5000.
    const w = watchReads(file, 3)
    expect(await readAssetBytes(new FsVault([tmp]), 'Art/grows.png', 10)).toBeNull()
    expect(w.reads.length).toBeGreaterThan(1)
    for (const r of w.reads) {
      expect(r.size).toBeLessThanOrEqual(11)
      expect(r.pos + r.len).toBeLessThanOrEqual(11)
    }
    expect(w.reads.reduce((n, r) => n + r.got, 0)).toBe(11)
  })

  it('serves a file that grew a little after it was stat-ed, whole, when it still fits', async () => {
    const file = await put('Art/grew.png', bytesOf(7))
    const w = watchReads(file, 3)
    expect(await readAssetBytes(new FsVault([tmp]), 'Art/grew.png', 10)).toEqual(bytesOf(7))
    expect(w.reads.every((r) => r.size <= 11)).toBe(true)
  })

  it('applies the 64 MiB default: a file one byte over it is refused before any byte is read', async () => {
    const file = path.join(tmp, 'Art', 'sparse.png')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const h = await fs.open(file, 'w')
    await h.truncate(READ_ASSET_MAX_BYTES + 1)
    await h.close()
    const w = watchReads(file)
    // The length, not the value: a failure must not try to print 64 MiB.
    expect((await readAssetBytes(new FsVault([tmp]), 'Art/sparse.png'))?.length ?? null).toBeNull()
    expect(w.opens()).toBe(1)
    expect(w.reads).toEqual([])
  })
})

/* ------------------------------------------------- the renderer's adapter --- */

const INFO: VaultInfo = { root: '/v/notes', name: 'notes', roots: [{ path: '/v/notes', mount: '', label: 'notes' }], exclude: [], hidden: [], keep: [] }

function adapterOver(readAsset: (p: string) => Promise<Uint8Array | null>): { adapter: ElectronVaultAdapter; asked: string[] } {
  const asked: string[] = []
  const bridge = {
    readAsset: async (p: string) => {
      asked.push(p)
      return readAsset(p)
    },
  } as unknown as AetherBridge
  return { adapter: new ElectronVaultAdapter(bridge, INFO), asked }
}

describe('ElectronVaultAdapter.readAsset', () => {
  it('wraps the bytes main sent in a Blob typed by the file extension', async () => {
    const bytes = pngBytes(400)
    const { adapter, asked } = adapterOver(async () => bytes)
    const types: Record<string, string> = {
      'a.png': 'image/png',
      'b.jpg': 'image/jpeg',
      'c.jpeg': 'image/jpeg',
      'd.webp': 'image/webp',
      'e.gif': 'image/gif',
      'f.bmp': 'image/bmp',
      'g.avif': 'image/avif',
      'H.PNG': 'image/png',
      'Art/Deep dir/i.JpG': 'image/jpeg',
    }
    for (const [p, type] of Object.entries(types)) {
      const blob = await adapter.readAsset(p)
      expect(blob, p).toBeInstanceOf(Blob)
      expect(blob?.type, p).toBe(type)
      expect(new Uint8Array(await blob!.arrayBuffer()), p).toEqual(bytes)
    }
    expect(asked).toEqual(Object.keys(types))
  })

  it('is null for what main refuses, an empty answer, and a failing bridge; it never rejects', async () => {
    const { adapter } = adapterOver(async (p) => {
      if (p === 'gone.png') return null
      if (p === 'empty.png') return new Uint8Array(0)
      throw new Error('ipc closed')
    })
    expect(await adapter.readAsset('gone.png')).toBeNull()
    expect(await adapter.readAsset('empty.png')).toBeNull()
    expect(await adapter.readAsset('fails.png')).toBeNull()
  })

  it('does not ask main for a video or anything that is not a picture', async () => {
    const { adapter, asked } = adapterOver(async () => bytesOf(100))
    for (const p of ['clip.mp4', 'clip.mov', 'note.md', 'vector.svg', 'noextension', '']) expect(await adapter.readAsset(p), p).toBeNull()
    expect(asked).toEqual([])
  })

  it('end to end over a real vault: the picture on disk comes out of the Blob, a video and an outside path do not', async () => {
    const png = pngBytes(5000)
    await put('vault/Art/gate.png', png)
    await put('vault/Art/clip.mp4', bytesOf(100))
    await put('outside/secret.png', png)
    const vault = new FsVault([path.join(tmp, 'vault')])
    const { adapter } = adapterOver((p) => readAssetBytes(vault, p))
    const blob = await adapter.readAsset('Art/gate.png')
    expect(blob?.type).toBe('image/png')
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(png)
    expect(await adapter.readAsset('Art/clip.mp4')).toBeNull()
    expect(await adapter.readAsset('../outside/secret.png')).toBeNull()
    expect(await adapter.readAsset('Art/missing.png')).toBeNull()
  })
})
