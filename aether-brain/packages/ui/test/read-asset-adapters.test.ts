import { afterEach, describe, expect, it, vi } from 'vitest'
import { READ_ASSET_MAX_BYTES } from '@aether/core'
import { FsAccessVaultAdapter } from '../src/vault/fsAccess'

/** Bytes that hit every value, so a text round trip or a truncation shows. */
function bytesOf(n: number, seed = 3): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 89 + seed + (i >> 8)) & 255
  return out
}
const bytesOfBlob = async (b: Blob | null) => (b ? new Uint8Array(await b.arrayBuffer()) : null)

afterEach(() => {
  vi.unstubAllGlobals()
  opened = []
  touched = []
})

/* ------------------------------------------------ File System Access API --- */

/** Names of the files `getFile` was called for: a picture is opened only when it is read. */
let opened: string[] = []
/** Calls made on a stand-in for a file too big to exist in a test: nothing may read it. */
let touched: string[] = []

type Content = Uint8Array | { bigSize: number } | { denied: true }

class FakeFile {
  readonly kind = 'file' as const
  constructor(
    readonly name: string,
    private content: Content,
  ) {}
  async getFile(): Promise<File> {
    opened.push(this.name)
    const c = this.content
    if ('denied' in c) throw new DOMException('permission was revoked', 'NotAllowedError')
    if ('bigSize' in c) {
      // Only its size is real: any attempt to read it is recorded (and fails).
      const trap = (what: string) => () => {
        touched.push(what)
        throw new Error(`${what} on a file that is too big`)
      }
      return { name: this.name, size: c.bigSize, type: '', lastModified: 1, arrayBuffer: trap('arrayBuffer'), text: trap('text'), slice: trap('slice'), stream: trap('stream') } as unknown as File
    }
    return new File([c.slice()], this.name, { lastModified: 1 })
  }
}

class FakeDir {
  readonly kind = 'directory' as const
  readonly entries = new Map<string, FakeFile | FakeDir>()
  constructor(readonly name: string) {}
  async *values() {
    yield* this.entries.values()
  }
  async getDirectoryHandle(name: string): Promise<FakeDir> {
    const e = this.entries.get(name)
    if (e instanceof FakeDir) return e
    throw new DOMException(e ? 'TypeMismatchError' : 'NotFoundError', e ? 'TypeMismatchError' : 'NotFoundError')
  }
  async getFileHandle(name: string): Promise<FakeFile> {
    const e = this.entries.get(name)
    if (e instanceof FakeFile) return e
    throw new DOMException(e ? 'TypeMismatchError' : 'NotFoundError', e ? 'TypeMismatchError' : 'NotFoundError')
  }
}

function folder(files: Record<string, Content | 'dir'>): FsAccessVaultAdapter {
  const root = new FakeDir('vault')
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/')
    const name = parts.pop()!
    let dir = root
    for (const p of parts) {
      let next = dir.entries.get(p)
      if (!(next instanceof FakeDir)) dir.entries.set(p, (next = new FakeDir(p)))
      dir = next
    }
    dir.entries.set(name, content === 'dir' ? new FakeDir(name) : new FakeFile(name, content))
  }
  return new FsAccessVaultAdapter(root as never)
}

describe('FsAccessVaultAdapter.readAsset', () => {
  it('gives the file from the handle, whole, typed by its extension (the browser may leave a File untyped)', async () => {
    const types: Record<string, string> = {
      'a.png': 'image/png',
      'b.jpg': 'image/jpeg',
      'c.jpeg': 'image/jpeg',
      'd.webp': 'image/webp',
      'e.gif': 'image/gif',
      'f.bmp': 'image/bmp',
      'g.avif': 'image/avif',
      'H.PNG': 'image/png',
    }
    const files: Record<string, Content> = {}
    Object.keys(types).forEach((name, i) => (files[`Art/${name}`] = bytesOf(500 + i, i)))
    const a = folder(files)
    for (const name of Object.keys(types)) {
      const blob = await a.readAsset(`Art/${name}`)
      expect(blob, name).toBeInstanceOf(Blob)
      expect(blob?.type, name).toBe(types[name])
      expect(await bytesOfBlob(blob), name).toEqual(files[`Art/${name}`])
    }
  })

  it('finds a picture in nested folders, under a backslash path, and opens only that one file', async () => {
    const data = bytesOf(2000)
    const a = folder({ 'Boards/Gate/Deep/ref 1.png': data, 'Boards/Gate/other.png': bytesOf(10), 'top.jpg': bytesOf(20) })
    expect(await bytesOfBlob(await a.readAsset('Boards/Gate/Deep/ref 1.png'))).toEqual(data)
    expect(await bytesOfBlob(await a.readAsset('Boards\\Gate\\Deep\\ref 1.png'))).toEqual(data)
    expect(await bytesOfBlob(await a.readAsset('top.jpg'))).toEqual(bytesOf(20))
    expect(opened).toEqual(['ref 1.png', 'ref 1.png', 'top.jpg'])
  })

  it('is null for a video, a note and anything that is not a picture name, without opening the file', async () => {
    const a = folder({ 'Art/clip.mp4': bytesOf(50), 'Art/clip.webm': bytesOf(50), 'Art/note.md': bytesOf(50), 'Art/vector.svg': bytesOf(50), 'Art/noext': bytesOf(50) })
    for (const p of ['Art/clip.mp4', 'Art/clip.webm', 'Art/note.md', 'Art/vector.svg', 'Art/noext', 'Art', '']) expect(await a.readAsset(p), p).toBeNull()
    expect(opened).toEqual([])
  })

  it('is null for a missing file or folder, a folder named like a picture, and a path that climbs out of the vault', async () => {
    const a = folder({ 'Art/gate.png': bytesOf(10), 'Art/Folder.png': 'dir', 'outside.png': bytesOf(10) })
    for (const p of ['Art/missing.png', 'Nowhere/gate.png', 'Art/Folder.png', 'Art/gate.png/inside.png', '../Art/gate.png', 'Art/../outside.png']) {
      expect(await a.readAsset(p), p).toBeNull()
    }
    expect(await a.readAsset('Art/gate.png')).not.toBeNull()
  })

  it('is null for a picture in a skipped folder, though the file is there', async () => {
    const a = folder({ '.hidden/x.png': bytesOf(10), 'node_modules/pkg/x.png': bytesOf(10), 'Art/.cache/x.png': bytesOf(10) })
    for (const p of ['.hidden/x.png', 'node_modules/pkg/x.png', 'Art/.cache/x.png']) expect(await a.readAsset(p), p).toBeNull()
    expect(opened).toEqual([])
  })

  it('is null for an empty file, and for a file whose access was revoked; it never rejects', async () => {
    const a = folder({ 'Art/empty.png': new Uint8Array(0), 'Art/denied.png': { denied: true }, 'Art/ok.png': bytesOf(5) })
    expect(await a.readAsset('Art/empty.png')).toBeNull()
    expect(await a.readAsset('Art/denied.png')).toBeNull()
    expect(await a.readAsset('Art/ok.png')).not.toBeNull()
  })

  it('refuses a file over 64 MiB without reading a byte of it, and serves one of exactly 64 MiB', async () => {
    expect(READ_ASSET_MAX_BYTES).toBe(64 * 1024 * 1024)
    const a = folder({ 'Art/over.png': { bigSize: READ_ASSET_MAX_BYTES + 1 }, 'Art/exact.png': new Uint8Array(READ_ASSET_MAX_BYTES) })
    expect(await a.readAsset('Art/over.png')).toBeNull()
    expect(touched).toEqual([])
    expect((await a.readAsset('Art/exact.png'))?.size).toBe(READ_ASSET_MAX_BYTES)
  })
})

/* ---------------------------------------------------------- demo adapter --- */

const RING = 'Projects/PORTALz/Art/portal-ring.png'

describe('the demo vault adapter: readAsset', () => {
  /** Answers fetch for the bundled picture URLs with `bytes`, the way the dev server or the packaged app does, whatever type it claims. */
  function serve(bytes: Uint8Array | null, init: ResponseInit = {}) {
    const asked: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(String(url))
      if (!bytes) return new Response('nope', { status: 404 })
      return new Response(bytes.slice(), { status: 200, ...init })
    })
    return asked
  }

  it('reads a bundled picture through its URL, typed by its extension whatever the server says', async () => {
    const { createDemoVault } = await import('../src/vault/demo')
    const vault = await createDemoVault()
    const data = bytesOf(3000)
    for (const headers of [undefined, { 'Content-Type': 'application/octet-stream' }, { 'Content-Type': 'text/html' }]) {
      const asked = serve(data, headers ? { headers } : {})
      const blob = await vault.readAsset(RING)
      expect(blob?.type).toBe('image/png')
      expect(await bytesOfBlob(blob)).toEqual(data)
      expect(asked).toEqual(['/vault-demo/Projects/PORTALz/Art/portal-ring.png'])
    }
  })

  it('serves a picture added in the app from memory, not from the bundle', async () => {
    const { createDemoVault } = await import('../src/vault/demo')
    const vault = await createDemoVault()
    const asked = serve(bytesOf(10))
    const mine = bytesOf(777, 9)
    await vault.createAsset('Projects/PORTALz/Art/dropped.jpg', mine)
    const blob = await vault.readAsset('Projects/PORTALz/Art/dropped.jpg')
    expect(blob?.type).toBe('image/jpeg')
    expect(await bytesOfBlob(blob)).toEqual(mine)
    expect(asked).toEqual([])
  })

  it('is null when the bundled file cannot be fetched, comes back empty, is a video, or is not in the bundle at all', async () => {
    const { createDemoVault } = await import('../src/vault/demo')
    const vault = await createDemoVault()
    serve(null)
    expect(await vault.readAsset(RING)).toBeNull()
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network down')
    })
    expect(await vault.readAsset(RING)).toBeNull()
    serve(new Uint8Array(0))
    expect(await vault.readAsset(RING)).toBeNull()
    const asked = serve(bytesOf(100))
    // A video bundled with the demo (there is none today) would still be a vault asset, never a picture to read.
    ;(vault as unknown as { pictures: Map<string, string> }).pictures.set('Projects/PORTALz/Art/turntable.mp4', '/vault-demo/turntable.mp4')
    expect(await vault.listAssets()).toContainEqual({ path: 'Projects/PORTALz/Art/turntable.mp4' })
    for (const p of ['Projects/PORTALz/Art/turntable.mp4', 'Projects/PORTALz/Home.md', 'Nowhere/ring.png', '']) expect(await vault.readAsset(p), p).toBeNull()
    expect(asked).toEqual([])
  })
})
