/**
 * Preload: the only bridge between the sandboxed renderer and the main
 * process. Exposes a small, typed, JSON-only API on `window.aether`.
 * (CommonJS on purpose — Electron preloads run in a sandbox that loads CJS.)
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { AetherBridge } from '../shared/ipc'

/** Same channels as `IPC` in shared/ipc.ts (a sandboxed preload cannot import it at runtime). */
const IPC = {
  pick: 'vault:pick',
  open: 'vault:open',
  last: 'vault:last',
  info: 'vault:info',
  addRoot: 'vault:addRoot',
  addRootPath: 'vault:addRootPath',
  removeRoot: 'vault:removeRoot',
  setExclude: 'vault:setExclude',
  drives: 'vault:drives',
  list: 'vault:list',
  folders: 'vault:folders',
  read: 'vault:read',
  write: 'vault:write',
  delete: 'vault:delete',
  rename: 'vault:rename',
  mkdir: 'vault:mkdir',
  reveal: 'vault:reveal',
  changes: 'vault:changes',
  progress: 'vault:progress',
  aiStatus: 'ai:status',
  aiConfigure: 'ai:configure',
  aiActivity: 'ai:activity',
  copy: 'app:copy',
} as const

/** Subscribe to a main → renderer event; returns the unsubscribe function. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const bridge: AetherBridge = {
  pickVault: () => ipcRenderer.invoke(IPC.pick),
  openVault: (roots) => ipcRenderer.invoke(IPC.open, roots),
  lastVault: () => ipcRenderer.invoke(IPC.last),
  vaultInfo: () => ipcRenderer.invoke(IPC.info),
  addRoot: () => ipcRenderer.invoke(IPC.addRoot),
  addRootPath: (p) => ipcRenderer.invoke(IPC.addRootPath, p),
  removeRoot: (p) => ipcRenderer.invoke(IPC.removeRoot, p),
  setExclude: (names) => ipcRenderer.invoke(IPC.setExclude, names),
  listDrives: () => ipcRenderer.invoke(IPC.drives),
  listFiles: () => ipcRenderer.invoke(IPC.list),
  listFolders: () => ipcRenderer.invoke(IPC.folders),
  readFile: (p) => ipcRenderer.invoke(IPC.read, p),
  writeFile: (p, content) => ipcRenderer.invoke(IPC.write, p, content),
  deleteFile: (p) => ipcRenderer.invoke(IPC.delete, p),
  renameFile: (a, b) => ipcRenderer.invoke(IPC.rename, a, b),
  createFolder: (p) => ipcRenderer.invoke(IPC.mkdir, p),
  revealInFolder: (p) => ipcRenderer.invoke(IPC.reveal, p),
  onChanges: (cb) => on(IPC.changes, cb),
  onProgress: (cb) => on(IPC.progress, cb),
  aiStatus: () => ipcRenderer.invoke(IPC.aiStatus),
  aiConfigure: (patch) => ipcRenderer.invoke(IPC.aiConfigure, patch),
  onAiActivity: (cb) => on(IPC.aiActivity, cb),
  copyText: (text) => ipcRenderer.invoke(IPC.copy, text),
  platform: process.platform,
  version: process.env['npm_package_version'] ?? '0.1.0',
}

contextBridge.exposeInMainWorld('aether', bridge)
