import type { VaultAdapter, VaultChange, VaultFile, VaultRootInfo } from '@aether/core'
import type { AetherBridge, VaultChangeDto, VaultInfo } from '../../shared/ipc'

function toChange(c: VaultChangeDto): VaultChange {
  const out: VaultChange = { kind: c.kind, path: c.path }
  if (c.content !== undefined) out.content = c.content
  if (c.mtime !== undefined) out.mtime = c.mtime
  return out
}

/** Most changes kept for a load that is still running; past that the load is hopelessly behind (Rescan). */
const MAX_HELD = 20_000

/**
 * One or more folders on disk (a multi-root vault can be whole drives such
 * as D:\ + F:\), served by the Electron main process and watched there.
 */
export class ElectronVaultAdapter implements VaultAdapter {
  readonly kind = 'electron' as const
  readonly name: string
  readonly location: string
  readonly readOnly = false
  readonly roots: VaultRootInfo[]
  /** What main reported when it opened the vault (roots, exclusions). */
  readonly info: VaultInfo
  /** True when the last folder listing stopped at the folder cap (the tree is partial). */
  truncated = false
  /** Watchers of this adapter, for changes it makes itself (a new folder). */
  private listeners = new Set<(changes: VaultChange[]) => void>()
  /** Changes main reported while a load was running (between list() and watch()). */
  private held: VaultChange[] | null = null
  private offHeld: (() => void) | null = null

  constructor(
    private bridge: AetherBridge,
    info: VaultInfo,
  ) {
    this.info = info
    this.name = info.name
    this.location = info.roots.length > 1 ? info.roots.map((r) => r.path).join(' + ') : info.root
    this.roots = info.roots.map((r) => ({ path: r.path, mount: r.mount, label: r.label }))
  }

  static bridge(): AetherBridge | null {
    return typeof window !== 'undefined' && window.aether ? window.aether : null
  }

  /** An adapter for a vault main already opened (e.g. after adding or removing a root). Throws without the bridge. */
  static fromInfo(info: VaultInfo): ElectronVaultAdapter {
    const b = ElectronVaultAdapter.bridge()
    if (!b) throw new Error('Electron bridge not available')
    return new ElectronVaultAdapter(b, info)
  }

  /** OS folder picker → a single-root vault; null when cancelled or outside Electron. */
  static async pick(): Promise<ElectronVaultAdapter | null> {
    const b = ElectronVaultAdapter.bridge()
    if (!b) return null
    const info = await b.pickVault()
    return info ? new ElectronVaultAdapter(b, info) : null
  }

  /** Open one or more folders as the vault; null outside Electron. Rejects when none can be opened. */
  static async open(roots: string[]): Promise<ElectronVaultAdapter | null> {
    const b = ElectronVaultAdapter.bridge()
    if (!b) return null
    return new ElectronVaultAdapter(b, await b.openVault(roots))
  }

  /** Roots to reopen on launch (CLI, AETHER_VAULT or the remembered set), or null. */
  static async last(): Promise<string[] | null> {
    const roots = await ElectronVaultAdapter.bridge()?.lastVault()
    return roots?.length ? roots : null
  }

  /**
   * Every note, read by main. Main starts watching while it reads, and the app
   * subscribes (watch) only after parsing, so changes in between are kept and
   * handed to the first watcher instead of being lost.
   */
  async list(): Promise<VaultFile[]> {
    if (!this.listeners.size) this.hold()
    try {
      return await this.bridge.listFiles()
    } catch (err) {
      this.release()
      throw err
    }
  }
  async listFolders(): Promise<string[]> {
    const res = await this.bridge.listFolders()
    this.truncated = res.truncated
    return res.folders
  }
  read(path: string): Promise<string | null> {
    return this.bridge.readFile(path)
  }
  write(path: string, content: string): Promise<void> {
    return this.bridge.writeFile(path, content)
  }
  remove(path: string): Promise<void> {
    return this.bridge.deleteFile(path)
  }
  rename(from: string, to: string): Promise<void> {
    return this.bridge.renameFile(from, to)
  }
  /** Create a folder (and parents) on disk; emits 'addDir' at once (main's watcher confirms it later). */
  async createFolder(path: string): Promise<void> {
    await this.bridge.createFolder(path)
    const change: VaultChange[] = [{ kind: 'addDir', path }]
    for (const cb of this.listeners) cb(change)
  }
  watch(cb: (changes: VaultChange[]) => void): () => void {
    this.listeners.add(cb)
    const off = this.bridge.onChanges((changes) => cb(changes.map(toChange)))
    const held = this.release()
    if (held.length) cb(held)
    return () => {
      this.listeners.delete(cb)
      off()
    }
  }

  /** Start keeping main's change batches (a load began). */
  private hold(): void {
    this.release()
    const held: VaultChange[] = []
    this.held = held
    this.offHeld = this.bridge.onChanges((changes) => {
      if (held.length + changes.length > MAX_HELD) {
        this.release()
        return
      }
      for (const c of changes) held.push(toChange(c))
    })
  }

  /** Stop keeping batches; returns what was kept. */
  private release(): VaultChange[] {
    this.offHeld?.()
    this.offHeld = null
    const held = this.held ?? []
    this.held = null
    return held
  }
  reveal(path: string): Promise<void> {
    return this.bridge.revealInFolder(path)
  }
}
