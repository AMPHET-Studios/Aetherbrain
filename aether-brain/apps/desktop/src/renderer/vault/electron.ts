import type { VaultAdapter, VaultChange, VaultFile } from '@aether/core'
import type { AetherBridge, VaultInfo } from '../../shared/ipc'

/** A folder on disk, served by the Electron main process (chokidar-watched). */
export class ElectronVaultAdapter implements VaultAdapter {
  readonly kind = 'electron' as const
  readonly name: string
  readonly location: string
  readonly readOnly = false

  constructor(
    private bridge: AetherBridge,
    info: VaultInfo,
  ) {
    this.name = info.name
    this.location = info.root
  }

  static bridge(): AetherBridge | null {
    return typeof window !== 'undefined' && window.aether ? window.aether : null
  }

  static async pick(): Promise<ElectronVaultAdapter | null> {
    const b = ElectronVaultAdapter.bridge()
    if (!b) return null
    const info = await b.pickVault()
    return info ? new ElectronVaultAdapter(b, info) : null
  }

  static async open(root: string): Promise<ElectronVaultAdapter | null> {
    const b = ElectronVaultAdapter.bridge()
    if (!b) return null
    try {
      return new ElectronVaultAdapter(b, await b.openVault(root))
    } catch {
      return null
    }
  }

  static async last(): Promise<string | null> {
    return (await ElectronVaultAdapter.bridge()?.lastVault()) ?? null
  }

  async list(): Promise<VaultFile[]> {
    return this.bridge.listFiles()
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
  watch(cb: (changes: VaultChange[]) => void): () => void {
    return this.bridge.onChanges((changes) =>
      cb(
        changes.map((c) => {
          const out: VaultChange = { kind: c.kind, path: c.path }
          if (c.content !== undefined) out.content = c.content
          if (c.mtime !== undefined) out.mtime = c.mtime
          return out
        }),
      ),
    )
  }
  reveal(path: string): Promise<void> {
    return this.bridge.revealInFolder(path)
  }
}
