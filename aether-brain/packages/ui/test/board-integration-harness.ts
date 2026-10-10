/**
 * Shared set-up for the board integration tests (board-integration-*.test.ts, board-keys.test.ts): a fresh store and the modules that
 * share its registries, an in-memory vault with boards and pictures, and board notes to put in it. Not a test file.
 */
import { MemoryVaultAdapter, addPicture, newBoardNote, parseBoard, serializeBoard, type VaultFile, type VaultRootInfo } from '@aether/core'
import { vi } from 'vitest'

/** localStorage for the node test environment. */
export class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v))
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
  clear(): void {
    this.map.clear()
  }
}

export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

/** A board note as the app writes one: the title, `type: board`, and these pictures laid out in a row. */
export function boardRaw(title: string, pictures: string[] = [], updated = '2026-10-01'): string {
  const now = new Date(`${updated}T10:00:00`)
  let raw = newBoardNote(title, now)
  if (pictures.length === 0) return raw
  let { doc } = parseBoard(raw)
  pictures.forEach((path, i) => {
    doc = addPicture(doc, { path, w: 400, h: 300, x: i * 450, y: 0 }).doc
  })
  raw = serializeBoard(doc, raw, now)
  return raw
}

/** The notes and pictures of a small vault with two boards and a few ordinary notes. */
export function vaultFiles(): VaultFile[] {
  return [
    { path: 'Boards/Gate reference.md', content: boardRaw('Gate reference', ['Art/gate.png', 'Art/ring.png'], '2026-10-03') },
    { path: 'Boards/Armour.md', content: boardRaw('Armour', [], '2026-10-01') },
    { path: 'Projects/Gate.md', content: '---\ntitle: Gate\ntype: project\nstatus: active\n---\n# Gate\n\n## To do\n\n- [ ] Ink the gate\n' },
    { path: 'Inbox/Idea.md', content: '# Idea\n\nA note about a gate.\n' },
  ]
}

export const assetFiles = () => [
  { path: 'Art/gate.png', data: PNG, mtime: 3000 },
  { path: 'Art/ring.png', data: PNG, mtime: 2000 },
  { path: 'Art/sky.png', data: PNG, mtime: 1000 },
]

/** A vault of two drives, as the desktop app's multi-root vaults. */
export class TwoRoots extends MemoryVaultAdapter {
  readonly roots: VaultRootInfo[] = [
    { path: 'D:\\', mount: 'D', label: 'D:\\' },
    { path: 'F:\\', mount: 'F', label: 'F:\\' },
  ]
}

/** A vault that can show files in the OS file manager (the desktop adapter's `reveal`) and reads whole pictures. */
export class DesktopLikeVault extends MemoryVaultAdapter {
  revealed: string[] = []
  opened: string[] = []
  async reveal(path: string): Promise<void> {
    this.revealed.push(path)
  }
  async openAsset(path: string): Promise<void> {
    this.opened.push(path)
  }
}

/** A fresh store module and the modules that share its registries (a fresh state, key map and board registry each call). */
export async function freshApp(stored?: Record<string, string>) {
  const storage = new MemoryStorage()
  for (const [k, v] of Object.entries(stored ?? {})) storage.setItem(k, v)
  vi.stubGlobal('localStorage', storage)
  vi.resetModules()
  const store = await import('../src/store')
  const active = await import('../src/board/active')
  const registry = await import('../src/board/boardRegistry')
  const hostModule = await import('../src/board/dockedHost')
  const s = () => store.useAether.getState()
  /** Open a vault and wait for the store to be ready. */
  const open = async (vault: MemoryVaultAdapter) => {
    await s().openVault(vault)
    return vault
  }
  return { storage, store, useAether: store.useAether, s, active, registry, hostModule, open }
}

/** Lets promise callbacks run (a few turns). */
export const tick = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}
