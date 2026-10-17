/**
 * Preload: the only bridge between the sandboxed renderer and the main
 * process. Exposes a small, typed, JSON-only API on `window.aether`.
 * (CommonJS on purpose — Electron preloads run in a sandbox that loads CJS.)
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { AetherBridge, ForgeRequest } from '../shared/ipc'

/** Same channels as `IPC` in shared/ipc.ts (a sandboxed preload cannot import it at runtime). */
const IPC = {
  pick: 'vault:pick',
  open: 'vault:open',
  last: 'vault:last',
  interrupted: 'startup:interrupted',
  settled: 'startup:settled',
  info: 'vault:info',
  addRoot: 'vault:addRoot',
  addRootPath: 'vault:addRootPath',
  removeRoot: 'vault:removeRoot',
  setExclude: 'vault:setExclude',
  hideFolder: 'vault:hideFolder',
  unhideFolder: 'vault:unhideFolder',
  setFolderRules: 'vault:setFolderRules',
  skippedInstalls: 'vault:skippedInstalls',
  findProjects: 'vault:findProjects',
  findProjectsStop: 'vault:findProjectsStop',
  findProgress: 'vault:findProgress',
  chatStatus: 'chat:status',
  chatConfigure: 'chat:configure',
  chatOllama: 'chat:ollama',
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  chatForget: 'chat:forget',
  chatEvent: 'chat:event',
  libraryStatus: 'library:status',
  libraryConfigure: 'library:configure',
  libraryPick: 'library:pick',
  libraryAnalyze: 'library:analyze',
  libraryCopy: 'library:copy',
  libraryStop: 'library:stop',
  libraryModel: 'library:model',
  libraryThumb: 'library:thumb',
  libraryEvent: 'library:event',
  drives: 'vault:drives',
  list: 'vault:list',
  listMore: 'vault:listMore',
  folders: 'vault:folders',
  read: 'vault:read',
  write: 'vault:write',
  create: 'vault:create',
  delete: 'vault:delete',
  rename: 'vault:rename',
  mkdir: 'vault:mkdir',
  reveal: 'vault:reveal',
  changes: 'vault:changes',
  progress: 'vault:progress',
  assets: 'vault:assets',
  thumb: 'vault:thumb',
  createAsset: 'vault:createAsset',
  openAsset: 'vault:openAsset',
  readAsset: 'vault:readAsset',
  readAssetChecked: 'vault:readAssetChecked',
  boardOpen: 'board:open',
  boardClose: 'board:close',
  boardStatus: 'board:status',
  boardConfigure: 'board:configure',
  boardSave: 'board:save',
  boardRead: 'board:read',
  boardAssets: 'board:assets',
  boardState: 'board:state',
  boardClosed: 'board:closed',
  boardFlush: 'board:flush',
  boardFlushed: 'board:flushed',
  boardGone: 'board:gone',
  forgeOpen: 'forge:open',
  forgeStatus: 'forge:status',
  forgeRequest: 'forge:request',
  forgeReply: 'forge:reply',
  forgeProjects: 'forge:win:projects',
  forgeSave: 'forge:win:save',
  forgeScreen: 'forge:screen',
  forgeFrame: 'forge:frame',
  companionStatus: 'companion:status',
  companionConfigure: 'companion:configure',
  companionGraph: 'companion:graph',
  companionPositions: 'companion:positions',
  companionWant: 'companion:want',
  companionSelect: 'companion:select',
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

/**
 * A rejected invoke carries Electron's own wrapping ("Error invoking remote method 'board:open': Error: ..."); the board's messages
 * are sentences for the user, so the wrapping is taken off them.
 */
function plain<T>(p: Promise<T>): Promise<T> {
  return p.catch((err: unknown) => {
    const m = err instanceof Error ? /^Error invoking remote method '[^']*': (?:Error: )?([\s\S]*)$/.exec(err.message) : null
    throw m ? new Error(m[1]) : err
  })
}

/**
 * Main asks a page to save what it has not saved before it closes the window (board:flush, with a token); the page answers
 * boardFlushed(token). A page that registered nothing (not started yet) is answered for at once, so it never holds a close.
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

type ForgeHandler = (req: ForgeRequest) => Promise<unknown>

/** Serves the Concept Forge window's requests (see onForgeRequest); one at a time, the latest registered. */
let forgeHandler: ForgeHandler | null = null

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Answer one relayed request: `forge:reply` (id, true, value) or (id, false,
 * message). Every request gets an answer, so the Forge window never waits
 * out main's timeout for a brain that is still starting.
 */
async function serveForge(_e: Electron.IpcRendererEvent, req: ForgeRequest): Promise<void> {
  const id = req?.id
  if (typeof id !== 'number') return
  const handler = forgeHandler
  if (!handler) {
    await ipcRenderer.invoke(IPC.forgeReply, id, false, 'Aether Brain is still starting: try again in a moment').catch(() => undefined)
    return
  }
  let value: unknown
  try {
    value = await handler(req)
  } catch (err) {
    await ipcRenderer.invoke(IPC.forgeReply, id, false, errorText(err)).catch(() => undefined)
    return
  }
  try {
    await ipcRenderer.invoke(IPC.forgeReply, id, true, value)
  } catch (err) {
    // The answer could not cross IPC (not cloneable): say so instead of leaving the Forge window waiting.
    await ipcRenderer.invoke(IPC.forgeReply, id, false, `Could not send the answer: ${errorText(err)}`).catch(() => undefined)
  }
}

ipcRenderer.on(IPC.forgeRequest, (e, req: ForgeRequest) => void serveForge(e, req))

const bridge: AetherBridge = {
  pickVault: () => ipcRenderer.invoke(IPC.pick),
  openVault: (roots, opts) => ipcRenderer.invoke(IPC.open, roots, opts),
  startupInterrupted: () => ipcRenderer.invoke(IPC.interrupted),
  startupSettled: () => ipcRenderer.send(IPC.settled),
  lastVault: () => ipcRenderer.invoke(IPC.last),
  vaultInfo: () => ipcRenderer.invoke(IPC.info),
  addRoot: () => ipcRenderer.invoke(IPC.addRoot),
  addRootPath: (p) => ipcRenderer.invoke(IPC.addRootPath, p),
  removeRoot: (p) => ipcRenderer.invoke(IPC.removeRoot, p),
  setExclude: (names) => ipcRenderer.invoke(IPC.setExclude, names),
  hideFolder: (p) => ipcRenderer.invoke(IPC.hideFolder, p),
  unhideFolder: (p) => ipcRenderer.invoke(IPC.unhideFolder, p),
  setFolderRules: (rules) => ipcRenderer.invoke(IPC.setFolderRules, rules),
  skippedInstalls: () => ipcRenderer.invoke(IPC.skippedInstalls),
  findProjects: () => ipcRenderer.invoke(IPC.findProjects),
  findProjectsStop: () => ipcRenderer.invoke(IPC.findProjectsStop),
  onFindProgress: (cb) => on(IPC.findProgress, cb),
  chatStatus: () => ipcRenderer.invoke(IPC.chatStatus),
  chatConfigure: (patch) => ipcRenderer.invoke(IPC.chatConfigure, patch),
  chatOllama: () => ipcRenderer.invoke(IPC.chatOllama),
  chatSend: (conv, text) => ipcRenderer.invoke(IPC.chatSend, conv, text),
  chatStop: (conv) => ipcRenderer.invoke(IPC.chatStop, conv),
  chatForget: (conv) => ipcRenderer.invoke(IPC.chatForget, conv),
  libraryStatus: () => ipcRenderer.invoke(IPC.libraryStatus),
  libraryConfigure: (patch) => ipcRenderer.invoke(IPC.libraryConfigure, patch),
  libraryPick: (which) => ipcRenderer.invoke(IPC.libraryPick, which),
  libraryAnalyze: () => ipcRenderer.invoke(IPC.libraryAnalyze),
  libraryCopy: () => ipcRenderer.invoke(IPC.libraryCopy),
  libraryStop: () => ipcRenderer.invoke(IPC.libraryStop),
  libraryModel: (action) => ipcRenderer.invoke(IPC.libraryModel, action),
  libraryThumb: (id) => ipcRenderer.invoke(IPC.libraryThumb, id),
  onLibraryEvent: (cb) => on(IPC.libraryEvent, cb),
  listDrives: () => ipcRenderer.invoke(IPC.drives),
  listFiles: () => ipcRenderer.invoke(IPC.list),
  listMoreFiles: (token) => ipcRenderer.invoke(IPC.listMore, token),
  listFolders: () => ipcRenderer.invoke(IPC.folders),
  readFile: (p) => ipcRenderer.invoke(IPC.read, p),
  writeFile: (p, content) => ipcRenderer.invoke(IPC.write, p, content),
  createFile: (p, content) => ipcRenderer.invoke(IPC.create, p, content),
  deleteFile: (p) => ipcRenderer.invoke(IPC.delete, p),
  renameFile: (a, b) => ipcRenderer.invoke(IPC.rename, a, b),
  createFolder: (p) => ipcRenderer.invoke(IPC.mkdir, p),
  revealInFolder: (p) => ipcRenderer.invoke(IPC.reveal, p),
  onChanges: (cb) => on(IPC.changes, cb),
  onProgress: (cb) => on(IPC.progress, cb),
  listAssets: () => ipcRenderer.invoke(IPC.assets),
  thumbnail: (p, size) => ipcRenderer.invoke(IPC.thumb, p, size),
  createAsset: (p, data) => ipcRenderer.invoke(IPC.createAsset, p, data),
  openAsset: (p) => ipcRenderer.invoke(IPC.openAsset, p),
  readAsset: (p) => ipcRenderer.invoke(IPC.readAsset, p),
  readAssetChecked: (p) => ipcRenderer.invoke(IPC.readAssetChecked, p),
  boardOpen: (p) => plain(ipcRenderer.invoke(IPC.boardOpen, p)),
  boardClose: () => ipcRenderer.invoke(IPC.boardClose),
  boardStatus: () => ipcRenderer.invoke(IPC.boardStatus),
  boardConfigure: (patch) => ipcRenderer.invoke(IPC.boardConfigure, patch),
  boardSave: (p, text, expectedBase) =>
    expectedBase === undefined ? ipcRenderer.invoke(IPC.boardSave, p, text) : ipcRenderer.invoke(IPC.boardSave, p, text, expectedBase),
  boardRead: (p) => plain(ipcRenderer.invoke(IPC.boardRead, p)),
  boardAssets: () => ipcRenderer.invoke(IPC.boardAssets),
  onBoardState: (cb) => on(IPC.boardState, cb),
  onBoardClosed: (cb) => on(IPC.boardClosed, cb),
  onBoardFlush: (cb) => {
    flushSubs.add(cb)
    return () => void flushSubs.delete(cb)
  },
  boardFlushed: (token) => ipcRenderer.send(IPC.boardFlushed, token),
  onBoardGone: (cb) => on(IPC.boardGone, cb),
  forgeOpen: (opts) => ipcRenderer.invoke(IPC.forgeOpen, opts),
  forgeStatus: () => ipcRenderer.invoke(IPC.forgeStatus),
  onForgeRequest: (handler) => {
    forgeHandler = handler
    return () => {
      if (forgeHandler === handler) forgeHandler = null
    }
  },
  forgeScreen: (on) => ipcRenderer.invoke(IPC.forgeScreen, on),
  onForgeFrame: (cb) => on(IPC.forgeFrame, cb),
  companionStatus: () => ipcRenderer.invoke(IPC.companionStatus),
  companionConfigure: (patch) => ipcRenderer.invoke(IPC.companionConfigure, patch),
  companionGraph: (graph) => ipcRenderer.send(IPC.companionGraph, graph),
  companionPositions: (version, positions, rings) => ipcRenderer.send(IPC.companionPositions, version, positions, rings),
  onCompanionWant: (cb) => on(IPC.companionWant, cb),
  onCompanionSelect: (cb) => on(IPC.companionSelect, cb),
  aiStatus: () => ipcRenderer.invoke(IPC.aiStatus),
  aiConfigure: (patch) => ipcRenderer.invoke(IPC.aiConfigure, patch),
  onAiActivity: (cb) => on(IPC.aiActivity, cb),
  onChatEvent: (cb) => on(IPC.chatEvent, cb),
  copyText: (text) => ipcRenderer.invoke(IPC.copy, text),
  platform: process.platform,
  version: process.env['npm_package_version'] ?? '0.1.0',
}

contextBridge.exposeInMainWorld('aether', bridge)
