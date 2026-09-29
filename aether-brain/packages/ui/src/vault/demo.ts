import { MemoryVaultAdapter, generateSyntheticVault, type VaultFile } from '@aether/core'

/**
 * The bundled demo vault. Vite inlines every markdown file under
 * /vault-demo at build time; edits are persisted to IndexedDB so the demo
 * behaves like a real vault across reloads (and can be reset).
 */
const bundled = import.meta.glob('../../../../vault-demo/**/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>

const DB_NAME = 'aether-demo'
const STORE = 'files'
/** Overlay key holding the explicit folder set (folders created in the app, or left empty); never a note path. */
const FOLDERS_KEY = '\u0000folders'

function demoFiles(): VaultFile[] {
  return Object.entries(bundled).map(([key, content]) => ({
    path: key.replace(/^.*?vault-demo\//, ''),
    content,
  }))
}

async function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}

interface Overlay {
  /** Changed or added files; null = deleted from the bundle. */
  files: Map<string, VaultFile | null>
  /** Explicit folders of the in-memory vault (created in the app, or kept after their last note went). */
  folders: string[]
}

async function readOverlay(): Promise<Overlay | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).openCursor()
    const out: Overlay = { files: new Map(), folders: [] }
    req.onsuccess = () => {
      const cur = req.result
      if (!cur) return resolve(out)
      const key = String(cur.key)
      if (key === FOLDERS_KEY) {
        const v: unknown = cur.value
        out.folders = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
      } else out.files.set(key, cur.value as VaultFile | null)
      cur.continue()
    }
    req.onerror = () => resolve(out)
  })
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
function persistOverlay(base: Map<string, string>, files: Map<string, VaultFile>, folders: Set<string>): void {
  if (persistTimer) clearTimeout(persistTimer)
  // Copy now: the adapter keeps mutating its own map and set.
  const snapshot = [...files.values()].map((f) => ({ path: f.path, content: f.content, mtime: f.mtime }))
  const dirs = [...folders]
  persistTimer = setTimeout(async () => {
    const db = await openDb()
    if (!db) return
    const tx = db.transaction(STORE, 'readwrite')
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
  }, 250)
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
  return new MemoryVaultAdapter([...files.values()], {
    name: 'Demo vault',
    location: 'bundled · edits saved in this browser',
    folders: overlay?.folders ?? [],
    onPersist: (map, folders) => persistOverlay(baseMap, map, folders),
  })
}

/** Forget every local edit to the demo: changed, added and deleted notes, and folders made in the app. */
export async function resetDemoVault(): Promise<void> {
  // A pending save from the vault being reset must not write the edits back.
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
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
