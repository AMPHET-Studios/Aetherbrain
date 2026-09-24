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

async function readOverlay(): Promise<Map<string, VaultFile | null> | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).openCursor()
    const out = new Map<string, VaultFile | null>()
    req.onsuccess = () => {
      const cur = req.result
      if (!cur) return resolve(out)
      out.set(String(cur.key), cur.value as VaultFile | null)
      cur.continue()
    }
    req.onerror = () => resolve(out)
  })
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
function persistOverlay(base: Map<string, string>, files: Map<string, VaultFile>): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(async () => {
    const db = await openDb()
    if (!db) return
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    store.clear()
    // Store only diffs from the bundle: changed/added files, and tombstones.
    for (const [path, f] of files) if (base.get(path) !== f.content) store.put({ path: f.path, content: f.content, mtime: f.mtime }, path)
    for (const path of base.keys()) if (!files.has(path)) store.put(null, path)
  }, 250)
}

export async function createDemoVault(): Promise<MemoryVaultAdapter> {
  const base = demoFiles()
  const baseMap = new Map(base.map((f) => [f.path, f.content]))
  const overlay = await readOverlay()
  const files = new Map(base.map((f) => [f.path, f]))
  if (overlay) {
    for (const [path, f] of overlay) {
      if (f === null) files.delete(path)
      else files.set(path, f)
    }
  }
  return new MemoryVaultAdapter([...files.values()], {
    name: 'Demo vault',
    location: 'bundled · edits saved in this browser',
    onPersist: (map) => persistOverlay(baseMap, map),
  })
}

export async function resetDemoVault(): Promise<void> {
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
