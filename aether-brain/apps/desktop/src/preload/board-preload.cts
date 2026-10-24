/**
 * Preload of the reference board's floating window (board.html). The same name as the brain window's, `window.aether`, but only what
 * the board page really calls: the board note (read, save, picture list), the window's own settings and close, the pictures
 * (previews, whole pictures, new ones, open, show in the folder), the clipboard, and the save-before-close handshake. No note, vault,
 * chat, library or AI-link call exists on it. This page decodes pictures from the user's folders, so it is the page to give the least
 * (a bridge with the whole vault would turn a broken decoder into a way to read, change and delete the vault); main also refuses
 * every other channel to this window (BOARD_PAGE_CHANNELS in main/board-window.ts), for a page that sends one by hand, and on the
 * ones it has refuses any board but the one the window shows (`board:read`, `board:save`) and any note or folder (`vault:reveal`).
 * (CommonJS on purpose — Electron preloads run in a sandbox that loads CJS.)
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { BoardBridge } from '../shared/ipc'

/** Same channels as `IPC` in shared/ipc.ts (a sandboxed preload cannot import it at runtime): only the ones this page uses. */
const IPC = {
  changes: 'vault:changes',
  reveal: 'vault:reveal',
  thumb: 'vault:thumb',
  modelProxy: 'vault:modelProxy',
  createAsset: 'vault:createAsset',
  openAsset: 'vault:openAsset',
  readAsset: 'vault:readAsset',
  readAssetChecked: 'vault:readAssetChecked',
  boardClose: 'board:close',
  boardStatus: 'board:status',
  boardConfigure: 'board:configure',
  boardSave: 'board:save',
  boardRead: 'board:read',
  boardAssets: 'board:assets',
  boardState: 'board:state',
  boardFlush: 'board:flush',
  boardFlushed: 'board:flushed',
  boardGone: 'board:gone',
  copy: 'app:copy',
} as const

/** Subscribe to a main → page event; returns the unsubscribe function. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

/** Electron wraps a rejection ("Error invoking remote method 'board:read': Error: ..."); the board's messages are sentences for the user. */
function plain<T>(p: Promise<T>): Promise<T> {
  return p.catch((err: unknown) => {
    const m = err instanceof Error ? /^Error invoking remote method '[^']*': (?:Error: )?([\s\S]*)$/.exec(err.message) : null
    throw m ? new Error(m[1]) : err
  })
}

/**
 * Main asks this page to save what it has not saved before it closes the window (board:flush, with a token); the page answers
 * boardFlushed(token) once it is on disk. A page that registered nothing (not started yet) is answered for at once, so it never
 * holds a close.
 */
const flushSubs = new Set<(token: number) => void>()
ipcRenderer.on(IPC.boardFlush, (_e, token: unknown) => {
  if (typeof token !== 'number') return
  const answer = (): void => ipcRenderer.send(IPC.boardFlushed, token)
  if (!flushSubs.size) return answer()
  for (const cb of [...flushSubs]) {
    try {
      cb(token)
    } catch {
      answer()
    }
  }
})

const bridge: BoardBridge = {
  boardAssets: () => ipcRenderer.invoke(IPC.boardAssets),
  boardClose: () => ipcRenderer.invoke(IPC.boardClose),
  boardConfigure: (patch) => ipcRenderer.invoke(IPC.boardConfigure, patch),
  boardFlushed: (token) => ipcRenderer.send(IPC.boardFlushed, token),
  boardRead: (p) => plain(ipcRenderer.invoke(IPC.boardRead, p)),
  boardSave: (p, text, expectedBase) =>
    expectedBase === undefined ? ipcRenderer.invoke(IPC.boardSave, p, text) : ipcRenderer.invoke(IPC.boardSave, p, text, expectedBase),
  boardStatus: () => ipcRenderer.invoke(IPC.boardStatus),
  copyText: (text) => ipcRenderer.invoke(IPC.copy, text),
  createAsset: (p, data) => ipcRenderer.invoke(IPC.createAsset, p, data),
  onBoardFlush: (cb) => {
    flushSubs.add(cb)
    return () => void flushSubs.delete(cb)
  },
  onBoardGone: (cb) => on(IPC.boardGone, cb),
  onBoardState: (cb) => on(IPC.boardState, cb),
  onChanges: (cb) => on(IPC.changes, cb),
  openAsset: (p) => ipcRenderer.invoke(IPC.openAsset, p),
  platform: process.platform,
  readAsset: (p) => ipcRenderer.invoke(IPC.readAsset, p),
  readAssetChecked: (p) => ipcRenderer.invoke(IPC.readAssetChecked, p),
  revealInFolder: (p) => ipcRenderer.invoke(IPC.reveal, p),
  modelProxy: (p) => ipcRenderer.invoke(IPC.modelProxy, p),
  thumbnail: (p, size) => ipcRenderer.invoke(IPC.thumb, p, size),
  version: process.env['npm_package_version'] ?? '0.1.0',
}

contextBridge.exposeInMainWorld('aether', bridge)
