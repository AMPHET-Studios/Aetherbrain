/**
 * The contract between the Electron main process and the renderer.
 * Everything crosses contextBridge as plain JSON; paths are vault-relative
 * posix strings and never escape the vault root (main enforces it).
 */
export interface VaultFileDto {
  path: string
  content: string
  mtime: number
}

export interface VaultChangeDto {
  kind: 'add' | 'change' | 'unlink'
  path: string
  content?: string
  mtime?: number
}

export interface VaultInfo {
  /** Absolute path on disk. */
  root: string
  name: string
}

export interface AetherBridge {
  /** Show the OS folder picker; returns null if cancelled. Also opens + watches it. */
  pickVault(): Promise<VaultInfo | null>
  /** Open + watch a known folder (e.g. the last one). */
  openVault(root: string): Promise<VaultInfo>
  lastVault(): Promise<string | null>
  listFiles(): Promise<VaultFileDto[]>
  readFile(path: string): Promise<string | null>
  writeFile(path: string, content: string): Promise<void>
  deleteFile(path: string): Promise<void>
  renameFile(from: string, to: string): Promise<void>
  revealInFolder(path: string): Promise<void>
  onChanges(cb: (changes: VaultChangeDto[]) => void): () => void
  /** process.platform of the main process ('darwin' | 'win32' | 'linux' | …). */
  platform: string
  version: string
}

export const IPC = {
  pick: 'vault:pick',
  open: 'vault:open',
  last: 'vault:last',
  list: 'vault:list',
  read: 'vault:read',
  write: 'vault:write',
  delete: 'vault:delete',
  rename: 'vault:rename',
  reveal: 'vault:reveal',
  changes: 'vault:changes',
} as const

declare global {
  interface Window {
    aether?: AetherBridge
  }
}
