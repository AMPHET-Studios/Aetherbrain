import {
  MemoryVaultAdapter,
  folderOf,
  generateSyntheticVault,
  mimeOf,
  normalizePath,
  type MemoryAsset,
  type MemoryVaultOptions,
  type VaultAsset,
  type VaultFile,
} from '@aether/core'
import { resizeImage } from '../util'

/**
 * The bundled demo vault. Vite inlines every markdown file under
 * /vault-demo at build time and bundles its pictures as asset URLs; edits
 * (and pictures added in the app) are persisted to IndexedDB so the demo
 * behaves like a real vault across reloads (and can be reset).
 */
const bundled = import.meta.glob('../../../../vault-demo/**/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>
const bundledPictures = import.meta.glob('../../../../vault-demo/**/*.{png,jpg,jpeg,webp}', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

const DB_NAME = 'aether-demo'
const DB_VERSION = 2
const STORE = 'files'
/** Pictures added in the app (vault path → { path, data, mtime }); version 2 of the database. */
const ASSETS = 'assets'
/** Overlay key holding the explicit folder set (folders created in the app, or left empty); never a note path. */
const FOLDERS_KEY = '\u0000folders'

const demoPath = (key: string) => key.replace(/^.*?vault-demo\//, '')

function demoFiles(): VaultFile[] {
  return Object.entries(bundled).map(([key, content]) => ({ path: demoPath(key), content }))
}

async function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS)
    }
    req.onsuccess = () => {
      // Another tab upgrading the demo later must not wait on this one.
      req.result.onversionchange = () => req.result.close()
      resolve(req.result)
    }
    req.onerror = () => resolve(null)
    // An open tab still on the old version: run without the overlay rather than hang.
    req.onblocked = () => resolve(null)
  })
}

interface Overlay {
  /** Changed or added files; null = deleted from the bundle. */
  files: Map<string, VaultFile | null>
  /** Explicit folders of the in-memory vault (created in the app, or kept after their last note went). */
  folders: string[]
  /** Pictures added in the app. */
  assets: MemoryAsset[]
}

/** Every record of one object store (key → value), or an empty list when it can't be read. */
function readAll(db: IDBDatabase, name: string): Promise<[string, unknown][]> {
  return new Promise((resolve) => {
    const out: [string, unknown][] = []
    let req: IDBRequest<IDBCursorWithValue | null>
    try {
      req = db.transaction(name, 'readonly').objectStore(name).openCursor()
    } catch {
      return resolve(out)
    }
    req.onsuccess = () => {
      const cur = req.result
      if (!cur) return resolve(out)
      out.push([String(cur.key), cur.value])
      cur.continue()
    }
    req.onerror = () => resolve(out)
  })
}

function isMemoryAsset(v: unknown): v is MemoryAsset {
  const a = v as Partial<MemoryAsset> | null
  return !!a && typeof a.path === 'string' && a.data instanceof Uint8Array && typeof a.mtime === 'number'
}

async function readOverlay(): Promise<Overlay | null> {
  const db = await openDb()
  if (!db) return null
  const out: Overlay = { files: new Map(), folders: [], assets: [] }
  for (const [key, value] of await readAll(db, STORE)) {
    if (key === FOLDERS_KEY) out.folders = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
    else out.files.set(key, value as VaultFile | null)
  }
  for (const [, value] of await readAll(db, ASSETS)) if (isMemoryAsset(value)) out.assets.push(value)
  savedAssets = new Map(out.assets.map((a) => [a.path, a.mtime]))
  return out
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
/** Pictures in the overlay (path → mtime): only new or removed ones are written, not every picture on every save. */
let savedAssets = new Map<string, number>()

function persistOverlay(base: Map<string, string>, files: Map<string, VaultFile>, folders: Set<string>, assets: Map<string, MemoryAsset>): void {
  if (persistTimer) clearTimeout(persistTimer)
  // Copy now: the adapter keeps mutating its own maps and set (picture bytes are never changed in place).
  const snapshot = [...files.values()].map((f) => ({ path: f.path, content: f.content, mtime: f.mtime }))
  const dirs = [...folders]
  const pictures = [...assets.values()]
  persistTimer = setTimeout(async () => {
    const db = await openDb()
    if (!db) return
    const tx = db.transaction([STORE, ASSETS], 'readwrite')
    const store = tx.objectStore(STORE)
    store.clear()
    // Store only diffs from the bundle: changed/added files, and tombstones.
    const present = new Set<string>()
    for (const f of snapshot) {
      present.add(f.path)
      if (base.get(f.path) !== f.content) store.put(f, f.path)
    }
    for (const path of base.keys()) if (!present.has(path)) store.put(null, path)
    if (dirs.length) store.put(dirs, FOLDERS_KEY)
    const images = tx.objectStore(ASSETS)
    const keep = new Set<string>()
    for (const a of pictures) {
      keep.add(a.path)
      if (savedAssets.get(a.path) !== a.mtime) images.put({ path: a.path, data: a.data, mtime: a.mtime }, a.path)
    }
    for (const path of savedAssets.keys()) if (!keep.has(path)) images.delete(path)
    savedAssets = new Map(pictures.map((a) => [a.path, a.mtime]))
  }, 250)
}

/**
 * The bytes behind a bundled picture's URL. A data: URL (Vite inlines small
 * files) is decoded here: no request, and nothing for the desktop CSP to
 * refuse. Anything else is the app's own file: fetched, or read with XHR
 * where fetch can't load it (file:// in the packaged desktop app).
 */
async function bundledBlob(url: string, type: string): Promise<Blob | null> {
  const comma = url.indexOf(',')
  if (url.startsWith('data:') && comma > 0 && /;base64$/i.test(url.slice(0, comma))) {
    try {
      const bin = atob(url.slice(comma + 1))
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new Blob([bytes], { type })
    } catch {
      return null
    }
  }
  try {
    const res = await fetch(url)
    if (res.ok) return await res.blob()
  } catch {
    /* no fetch for this scheme: try XHR */
  }
  if (typeof XMLHttpRequest === 'undefined') return null
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.onload = () => resolve(xhr.response instanceof Blob && xhr.response.size > 0 ? xhr.response : null)
    xhr.onerror = () => resolve(null)
    try {
      xhr.open('GET', url)
      xhr.responseType = 'blob'
      xhr.send()
    } catch {
      resolve(null)
    }
  })
}

/** The memory vault plus the bundled pictures (read-only files of the app, listed and previewed like the others). */
class DemoVaultAdapter extends MemoryVaultAdapter {
  constructor(
    files: VaultFile[],
    opts: MemoryVaultOptions,
    /** Vault path → URL of each bundled picture. */
    private readonly pictures: Map<string, string>,
  ) {
    super(files, opts)
  }

  override async listAssets(): Promise<VaultAsset[]> {
    const own = await super.listAssets()
    const mine = new Set(own.map((a) => a.path))
    return [...[...this.pictures.keys()].filter((p) => !mine.has(p)).map((path) => ({ path })), ...own]
  }

  override async listFolders(): Promise<string[]> {
    const out = new Set(await super.listFolders())
    for (const p of this.pictures.keys()) for (let f = folderOf(p); f && !out.has(f); f = folderOf(f)) out.add(f)
    return [...out].sort()
  }

  override async thumbnail(path: string, size: number): Promise<Blob | null> {
    const p = normalizePath(path)
    const own = this.assetData(p)
    const url = this.pictures.get(p)
    const source = own ? new Blob([own.slice()], { type: mimeOf(p) }) : url !== undefined ? await bundledBlob(url, mimeOf(p)) : null
    return source ? resizeImage(source, size) : null
  }

  /** Create-only over the bundled pictures too (any letter case), like a disk that has them. */
  override async createAsset(path: string, data: Uint8Array): Promise<void> {
    const lower = normalizePath(path).toLowerCase()
    for (const p of this.pictures.keys()) {
      if (p.toLowerCase() === lower) throw Object.assign(new Error(`EEXIST: file already exists, create '${path}'`), { code: 'EEXIST' })
    }
    return super.createAsset(path, data)
  }
}

export async function createDemoVault(): Promise<MemoryVaultAdapter> {
  const base = demoFiles()
  const baseMap = new Map(base.map((f) => [f.path, f.content]))
  const overlay = await readOverlay()
  const files = new Map(base.map((f) => [f.path, f]))
  if (overlay) {
    for (const [path, f] of overlay.files) {
      if (f === null) files.delete(path)
      else files.set(path, f)
    }
  }
  const pictures = new Map(Object.entries(bundledPictures).map(([key, url]) => [demoPath(key), url]))
  return new DemoVaultAdapter(
    [...files.values()],
    {
      name: 'Demo vault',
      location: 'bundled · edits saved in this browser',
      folders: overlay?.folders ?? [],
      assets: overlay?.assets ?? [],
      onPersist: (map, folders, assets) => persistOverlay(baseMap, map, folders, assets),
    },
    pictures,
  )
}

/** Forget every local edit to the demo: changed, added and deleted notes, folders made and pictures added in the app. */
export async function resetDemoVault(): Promise<void> {
  // A pending save from the vault being reset must not write the edits back.
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  savedAssets = new Map()
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    const tx = db.transaction([STORE, ASSETS], 'readwrite')
    tx.objectStore(STORE).clear()
    tx.objectStore(ASSETS).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

export function createStressVault(nodes: number, edges: number): MemoryVaultAdapter {
  return new MemoryVaultAdapter(generateSyntheticVault(nodes, edges), {
    name: `Stress ${nodes}×${edges}`,
    location: 'synthetic',
  })
}
