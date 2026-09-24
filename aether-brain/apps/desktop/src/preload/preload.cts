/**
 * Preload: the only bridge between the sandboxed renderer and the main
 * process. Exposes a small, typed, JSON-only API on `window.aether`.
 * (CommonJS on purpose — Electron preloads run in a sandbox that loads CJS.)
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { AetherBridge, VaultChangeDto } from '../shared/ipc'

const IPC = {
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

const bridge: AetherBridge = {
  pickVault: () => ipcRenderer.invoke(IPC.pick),
  openVault: (root) => ipcRenderer.invoke(IPC.open, root),
  lastVault: () => ipcRenderer.invoke(IPC.last),
  listFiles: () => ipcRenderer.invoke(IPC.list),
  readFile: (p) => ipcRenderer.invoke(IPC.read, p),
  writeFile: (p, content) => ipcRenderer.invoke(IPC.write, p, content),
  deleteFile: (p) => ipcRenderer.invoke(IPC.delete, p),
  renameFile: (a, b) => ipcRenderer.invoke(IPC.rename, a, b),
  revealInFolder: (p) => ipcRenderer.invoke(IPC.reveal, p),
  onChanges: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, changes: VaultChangeDto[]) => cb(changes)
    ipcRenderer.on(IPC.changes, handler)
    return () => ipcRenderer.off(IPC.changes, handler)
  },
  platform: process.platform,
  version: process.env['npm_package_version'] ?? '0.1.0',
}

contextBridge.exposeInMainWorld('aether', bridge)
