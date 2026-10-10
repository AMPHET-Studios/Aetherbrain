/**
 * The contract between the Electron main process and the renderer.
 * Everything crosses contextBridge as plain JSON; paths are vault paths
 * (posix, relative) and never escape the vault roots (main enforces it).
 *
 * Multi-root vaults: with more than one root, every vault path starts with
 * the root's mount segment (`D/Projects/x.md` → `D:\Projects\x.md`). With a
 * single root, paths are relative to that root, exactly as before.
 */
export interface VaultFileDto {
  path: string
  content: string
  mtime: number
}

export interface VaultChangeDto {
  /**
   * Note add/change/unlink (with content), image add/change/unlink (no
   * content; mtime and size), or folder addDir/unlinkDir (path = the folder).
   */
  kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
  content?: string
  mtime?: number
  /** Bytes, for images. */
  size?: number
}

/** An image file in the vault (png, jpg, jpeg, webp, gif, bmp, avif). */
export interface VaultAssetDto {
  path: string
  mtime?: number
  size?: number
}

export interface AssetListDto {
  assets: VaultAssetDto[]
  /** True when the scan stopped at the image cap; the list is partial. */
  truncated: boolean
}

/** The Concept Forge window (the user's own concept-forge.html, opened inside the app). */
export interface ForgeStatus {
  /** Absolute path of the remembered concept-forge.html, or null before the first pick. */
  file: string | null
  /** The Forge window is open. */
  open: boolean
}

/**
 * One frame of the Concept Forge page for its ★ star's screen in the brain:
 * the page as it looks right now, at most 1024 px wide, as raw pixels.
 */
export interface ForgeFrameDto {
  /** width × height × 4 bytes, rows top to bottom. */
  data: Uint8Array
  width: number
  height: number
  /** Byte order of each pixel: B, G, R, A (Chromium's own) when true, else R, G, B, A. */
  bgra: boolean
}

/* ---- the companion link (the Unreal viewer) ---- */

/** What a node is, for a viewer drawing it. */
export type CompanionKind = 'sun' | 'star' | 'planet' | 'moon' | 'ghost' | 'picture' | 'today'

/** A node of the brain as the brain window draws it. */
export interface CompanionNodeDto {
  id: string
  title: string
  kind: CompanionKind
  /** `#rrggbb`, the colour the brain draws it in. */
  color: string
  /** Radius in the brain's world units. */
  radius: number
  /** Index of its structural parent in `nodes` (the system layout's star, planet …), -1 for none. */
  parent: number
}

/**
 * The scene the brain window shows, for the companion link: published by the
 * brain window while a viewer reads it, served as JSON on /v1/graph.
 * Positions come separately (they change every frame): /v1/positions.
 */
export interface CompanionGraphDto {
  /** Bumped by the brain window with every new graph; positions carry it too. */
  version: number
  /** The vault's display name. */
  vault: string
  layout: 'constellation' | 'orbit' | 'system'
  nodes: CompanionNodeDto[]
  /** Links as pairs of node indices: [from0, to0, from1, to1, …]. */
  edges: number[]
  /** Index of the selected node, -1 for none. */
  selected: number
  /**
   * How much of the brain `nodes` and `edges` are (a big vault is cut to a budget, see renderer/companion-bound.ts):
   * how many are shown, and how many there are. Sent with every scene the brain window cuts; absent from older ones.
   */
  limits?: CompanionLimits
}

/** How much of the brain a published scene shows. */
export interface CompanionLimits {
  nodes: number
  ofNodes: number
  links: number
  ofLinks: number
}

export interface CompanionStatus {
  /** The user switched the link on. */
  enabled: boolean
  /** It is listening. */
  running: boolean
  port: number
  /** A viewer read the scene in the last few seconds. */
  connected: boolean
  /** Why it is not running (the port is taken …), or null. */
  error: string | null
  /** Where the viewer finds the address and token (written while running). */
  file: string
  /** Why the last scene was refused (the viewer is not told of it), or null. */
  warning?: string | null
  /** When the viewer is shown a part of a big brain: how much. Null while nothing is published or it is all of it. */
  showing?: CompanionLimits | null
}

export interface CompanionPatch {
  enabled?: boolean
  port?: number
  regenerateToken?: boolean
}

/** A project a graded drawing can be saved to (for the Forge window's picker). */
export interface ForgeProjectDto {
  id: string
  title: string
  status: string | null
  /** Home folder (vault path), or null when the project has none yet (one is created on save). */
  home: string | null
  /** Folder the critique lands in: the home folder's Critique planet (created on save when missing). */
  critique: string
}

/** One graded drawing to file into a project's Critique planet. */
export interface ForgeSaveDto {
  projectId: string
  /** What was drawn, e.g. "Gesture Warm-Up" (the note title and file name). */
  title: string
  /** The drawing as PNG bytes. */
  png: Uint8Array
  /**
   * The grade as Concept Forge had it (its `lastGrade` object or a grade
   * history entry), JSON-safe and untouched: the brain reads it with
   * `normalizeGrade` from @aether/core. Null when the drawing wasn't graded.
   */
  grade?: unknown
  /** Make the first fix a task due tomorrow (it shows on tomorrow's Today brief). Default true. */
  practiceTomorrow?: boolean
}

export interface ForgeSaveResult {
  noteId: string
  notePath: string
  imagePath: string
  /** Project title, for the confirmation. */
  project: string
}

/** A request from the Forge window, relayed by main to the brain window (whose store does the work). */
export type ForgeRequest = { id: number; kind: 'projects' } | { id: number; kind: 'save'; save: ForgeSaveDto }

/** What the Forge window's preload exposes to Concept Forge as `window.aetherForge`. */
export interface AetherForgeBridge {
  projects(): Promise<ForgeProjectDto[]>
  save(dto: ForgeSaveDto): Promise<ForgeSaveResult>
  version: string
}

export interface VaultProgressDto {
  phase: 'scanning' | 'reading' | 'done'
  /** Files read so far. */
  files: number
  /** Markdown files found so far. */
  found: number
  dirs: number
  done: boolean
}

import type { ChatEventDto, ChatPatch, ChatReplyDto, ChatStatusDto } from './chat.js'
export type { ChatEventDto, ChatPatch, ChatReplyDto, ChatStatusDto } from './chat.js'
import type { LibraryEventDto, LibraryModelAction, LibraryPatch, LibraryStatusDto } from './library.js'
export type * from './library.js'

export interface VaultRootDto {
  /** Absolute path on disk. */
  path: string
  /** Top-level vault folder for this root in a multi-root vault ('' when single-root). */
  mount: string
  /** Human label (`D:\` for a drive root, else the folder name). */
  label: string
}

export interface VaultInfo {
  /** Absolute path of the first root (kept for older callers). */
  root: string
  /** Display name: the folder name for one root, "D:\ + F:\" style for several. */
  name: string
  roots: VaultRootDto[]
  /** Extra folder names skipped while scanning (on top of the built-in list). */
  exclude: string[]
  /** Folders (absolute paths) left out of the brain. */
  hidden: string[]
  /** Folders (absolute paths) shown although they look like an installed game or program. */
  keep: string[]
}

/** A folder left out because it holds an installed game or program. */
export interface SkippedInstallDto {
  /** Absolute path. */
  path: string
  /** What it looks like: `Steam game`, `installed program`, `game library` … */
  kind: string
}

export interface FolderListDto {
  folders: string[]
  /** True when the scan stopped at the folder cap; the list is partial. */
  truncated: boolean
}

/** A folder Find projects thinks is one of the user's projects (it can become a star). */
export interface ProjectCandidateDto {
  /** Vault path of the folder. */
  path: string
  /** Its name. */
  name: string
  /** What it is, for people: `Unreal project`, `git repository`, `Blender files` … */
  kind: string
  /** A project for sure (an engine or code project, a git repository); creative files alone are a guess. */
  strong: boolean
  /** Creative files directly in it (0 for the sure kinds). */
  files: number
}

/** What a Find projects run found. Nothing is written by finding. */
export interface ProjectScanDto {
  /** Shallowest first. */
  candidates: ProjectCandidateDto[]
  /** Folders looked into. */
  looked: number
  /** Not every folder was looked into (the scan or the finder stopped at its cap). */
  truncated: boolean
  /** A stop, a newer run or another vault ended this run early: `candidates` is partial. */
  cancelled: boolean
}

/** Find projects progress: folders looked into of the total. */
export interface ProjectScanProgressDto {
  done: number
  total: number
}

/** The in-app MCP server that lets Claude and ChatGPT talk to the vault. */
export interface AiLinkStatus {
  /** User switched the HTTP link on (persisted). */
  enabled: boolean
  /** The HTTP server is currently listening. */
  running: boolean
  host: string
  port: number
  /** Secret that every HTTP request must carry (URL path or Bearer header). */
  token: string
  /** Write tools are not offered when true. */
  readOnly: boolean
  /** Full local MCP URL including the token path, e.g. http://127.0.0.1:7457/mcp/<token>. */
  url: string
  /** Last start error, if any. */
  error: string | null
  /** Ready-to-paste `mcpServers` entry for claude_desktop_config.json (stdio via this app's executable). */
  claudeDesktopConfig: string
  /** Ready-to-paste `claude mcp add …` command for Claude Code. */
  claudeCodeCommand: string
  /** Absolute path of the bundled MCP server script (for manual setups). */
  serverScript: string
  /** True when running from the Portable exe, whose path changes every launch. */
  portable: boolean
}

export interface AiLinkPatch {
  enabled?: boolean
  port?: number
  readOnly?: boolean
  /** Generate a fresh token (invalidates old URLs). */
  regenerateToken?: boolean
}

/** One tool call an AI client made through the HTTP link (for toasts / fly-to). */
export interface AiActivityDto {
  /** Client name from the MCP handshake, e.g. "claude-ai" or "openai-mcp". */
  client: string
  tool: string
  /** One line for a toast, e.g. `created "Portal ideas"`. */
  summary: string
  /** Vault path of the note or folder the call touched, if any. */
  path: string | null
  write: boolean
}

/* ---- the reference board's floating window ---- */

/** The floating board window, for both windows' toolbars and the palette. */
export interface BoardStatusDto {
  /** The window exists. */
  open: boolean
  /** The board (vault path of its note) it shows, or null when closed. */
  path: string | null
  alwaysOnTop: boolean
  /** 0.2 to 1. Always 1 where the platform cannot dim a window (`supportsOpacity` false). */
  opacity: number
  /** Window opacity works here (Windows, macOS). */
  supportsOpacity: boolean
}

/** What `board:configure` takes: either field, either window may send it. */
export interface BoardConfigureDto {
  alwaysOnTop?: boolean
  /** 0.2 to 1 (clamped); ignored where the platform cannot dim a window. */
  opacity?: number
}

/**
 * The answer to `board:save`: nothing is written unless `ok`. `changed` marks the refusal that the note on disk is no longer the text
 * the save was made from (`expectedBase`): the page must read the note again before it writes.
 */
export type BoardSaveResult = { ok: true } | { ok: false; reason: string; changed?: true }

/** Why a picture was not handed over whole: it is not there (or not a picture of the vault), over a size cap, or could not be read. */
export type ReadAssetFailure = 'missing' | 'too-large' | 'unreadable'

/** The answer to `vault:readAssetChecked`: the bytes, or why there are none (`detail` is a sentence for a message). */
export type ReadAssetResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: ReadAssetFailure; detail: string }

export interface AetherBridge {
  /** Show the OS folder picker; returns null if cancelled. Opens + watches it as a single-root vault. */
  pickVault(): Promise<VaultInfo | null>
  /** Open + watch one or more folders (e.g. the remembered roots). */
  openVault(roots: string | string[]): Promise<VaultInfo>
  /** Roots to reopen on launch (CLI args, AETHER_VAULT, or the remembered set), or null. */
  lastVault(): Promise<string[] | null>
  /** Current vault info, or null when none is open. */
  vaultInfo(): Promise<VaultInfo | null>
  /** Pick a folder with the OS dialog and add it as another root (reopens the vault). */
  addRoot(): Promise<VaultInfo | null>
  /** Add a known absolute path (e.g. a drive from listDrives) as another root. */
  addRootPath(path: string): Promise<VaultInfo>
  /** Remove a root by absolute path (reopens the vault; refuses to remove the last one). */
  removeRoot(path: string): Promise<VaultInfo>
  /** Set extra folder names to skip while scanning (reopens the vault). */
  setExclude(names: string[]): Promise<VaultInfo>
  /** Leave one folder (vault path) out of the brain, at once (no rescan); nothing on disk changes. */
  hideFolder(path: string): Promise<VaultInfo>
  /** Let a folder left out with hideFolder (vault path) back in. */
  unhideFolder(path: string): Promise<VaultInfo>
  /** Replace the folders left out and/or the installs kept (absolute paths), applied at once. */
  setFolderRules(rules: { hidden?: string[]; keep?: string[] }): Promise<VaultInfo>
  /** Installed games and programs left out so far. */
  skippedInstalls(): Promise<SkippedInstallDto[]>
  /** Find the vault's project folders (progress through onFindProgress); nothing is written. A newer run stops the older one. */
  findProjects(): Promise<ProjectScanDto>
  /** Stop a findProjects run (it resolves with what it found so far). */
  findProjectsStop(): Promise<void>
  onFindProgress(cb: (p: ProjectScanProgressDto) => void): () => void

  /** The brain's chat: its settings and whether it can chat now. */
  chatStatus(): Promise<ChatStatusDto>
  chatConfigure(patch: ChatPatch): Promise<ChatStatusDto>
  /** Send a message in conversation `conv` (an id the renderer makes); events stream through onChatEvent. */
  chatSend(conv: string, text: string): Promise<ChatReplyDto>
  /** Stop the answer being written. */
  chatStop(conv: string): Promise<void>
  /** Let go of a conversation (its note stays). */
  chatForget(conv: string): Promise<void>
  onChatEvent(cb: (e: ChatEventDto) => void): () => void

  /** The librarian: where from and to, the vision model, the job running, the plan, the last result. */
  libraryStatus(): Promise<LibraryStatusDto>
  libraryConfigure(patch: LibraryPatch): Promise<LibraryStatusDto>
  /** Choose the folder to sort (`source`) or the library folder (`dest`) with the OS picker. */
  libraryPick(which: 'source' | 'dest'): Promise<LibraryStatusDto>
  /** Look through the pictures and plan the library (progress and the plan arrive through onLibraryEvent). */
  libraryAnalyze(): Promise<LibraryStatusDto>
  /** Copy the plan's new pictures into the library and write its notes. */
  libraryCopy(): Promise<LibraryStatusDto>
  /** Stop looking or copying (what is copied stays). */
  libraryStop(): Promise<void>
  /** Download the vision model (about 150 MB, once), stop the download, or delete the model. */
  libraryModel(action: LibraryModelAction): Promise<LibraryStatusDto>
  /** A small picture (data URL) of one picture of the plan, or null. */
  libraryThumb(id: number): Promise<string | null>
  onLibraryEvent(cb: (e: LibraryEventDto) => void): () => void
  /** Drive roots on Windows (`C:\`, `D:\`, …); empty elsewhere. */
  listDrives(): Promise<string[]>
  listFiles(): Promise<VaultFileDto[]>
  /** Every non-ignored folder in the vault (from the last scan). */
  listFolders(): Promise<FolderListDto>
  readFile(path: string): Promise<string | null>
  writeFile(path: string, content: string): Promise<void>
  /** Create a new note; rejects (message contains `EEXIST`) when anything exists at the path. */
  createFile(path: string, content: string): Promise<void>
  deleteFile(path: string): Promise<void>
  renameFile(from: string, to: string): Promise<void>
  /** Create a folder (and parents) inside the vault. */
  createFolder(path: string): Promise<void>
  revealInFolder(path: string): Promise<void>
  onChanges(cb: (changes: VaultChangeDto[]) => void): () => void
  /** Progress while the main process reads a vault (scan → read → done). */
  onProgress(cb: (p: VaultProgressDto) => void): () => void
  /** Every image file found by the last scan. */
  listAssets(): Promise<AssetListDto>
  /** PNG bytes of a preview at most `size` px (32–1024) on its longer side, or null when unreadable. */
  thumbnail(path: string, size: number): Promise<Uint8Array | null>
  /** Create a new image (create-only; rejects with EEXIST when anything is there). Image paths only, ≤ 40 MB. */
  createAsset(path: string, data: Uint8Array): Promise<void>
  /** Open an image of the vault in the OS default app (image paths only). */
  openAsset(path: string): Promise<void>
  /**
   * The bytes of a picture of the vault as they are on disk (a picture name, at most 64 MB), or null: not a picture, not in the
   * visible vault, empty, too big, unreadable, or no vault open. Main reads and never decodes; the caller does.
   */
  readAsset(path: string): Promise<Uint8Array | null>
  /**
   * `readAsset` with the reason when there are no bytes: 'missing', 'too-large' (over 64 MiB, or a header that claims more than
   * 150 million pixels: main reads the first 256 KB and judges it, so the renderer never receives bytes it must not decode) or
   * 'unreadable'. The bytes are the same.
   */
  readAssetChecked(path: string): Promise<ReadAssetResult>

  /**
   * The reference board's floating window. `boardOpen` opens it on a board note (a vault `.md` path whose note is a board) or, when it
   * is open, shows that board in it; the window belongs to the brain window and closes with it.
   */
  boardOpen(path: string): Promise<BoardStatusDto>
  /** Close the floating window (the brain window hears `onBoardClosed`). */
  boardClose(): Promise<void>
  boardStatus(): Promise<BoardStatusDto>
  /** Change the window's always-on-top and opacity; callable from either window. */
  boardConfigure(patch: BoardConfigureDto): Promise<BoardStatusDto>
  /**
   * Overwrite an existing board note (`type: board` in its head, text at most 1,000,000 characters). Never creates a note. ONE call:
   * main compares the note on disk with `expectedBase` (the text `text` was made from) and writes, so there is no read-then-write
   * gap and a save sent as a window closes is complete once main has it. A note that is no longer `expectedBase` (and is not already
   * `text`) is refused with `changed`; without `expectedBase` the note is overwritten. Written WITHOUT telling the watcher it was us,
   * so the brain window sees it like an outside edit and rebuilds its graph.
   */
  boardSave(path: string, text: string, expectedBase?: string): Promise<BoardSaveResult>
  /**
   * A board note's text for the floating window, or null when the path is not a board note that is there (or no vault is open).
   * Rejects with a message when the note is longer than the window can hold.
   */
  boardRead(path: string): Promise<string | null>
  /**
   * Every picture of the vault as it is NOW (the scan's list plus what was added or removed since: `listAssets` is the scan's
   * snapshot, and a picture dropped into a board a minute ago is not in it). For the floating window, which gets later changes
   * through `onChanges` (pictures only).
   */
  boardAssets(): Promise<AssetListDto>
  /** The floating window opened, closed, moved to another board or changed its settings. Sent to both windows. */
  onBoardState(cb: (s: BoardStatusDto) => void): () => void
  /** The floating window stopped showing the board at `path` (closed, or moved to another board): the docked view takes it back. */
  onBoardClosed(cb: (path: string) => void): () => void
  /**
   * Main is about to close a window (the board window, the app window, the app itself) and asks its page to save what it has not
   * saved: `cb(token)`, and the page answers with `boardFlushed(token)` once it is on disk (main waits 1.5 s at most). A page that has
   * registered nothing is answered for by its preload at once.
   */
  onBoardFlush(cb: (token: number) => void): () => void
  boardFlushed(token: number): void
  /**
   * The note the floating window shows was deleted, renamed away or is no longer a board: `cb(why)`. The window keeps what it has.
   * `cb(null)`: the note reads as a board again, and the notice comes down (not sent for the one about a rename the window could not follow).
   */
  onBoardGone(cb: (why: string | null) => void): () => void

  /** Open (or focus) the Concept Forge window; asks for concept-forge.html the first time or with `pick`. */
  forgeOpen(opts?: { pick?: boolean }): Promise<ForgeStatus>
  forgeStatus(): Promise<ForgeStatus>
  /**
   * Serve the Forge window's requests (the project list, saves) from the
   * brain's store. One handler at a time; returns the unsubscribe function.
   * A rejected promise reaches the Forge window as an error message.
   */
  onForgeRequest(handler: (req: ForgeRequest) => Promise<unknown>): () => void
  /**
   * The Concept Forge star's screen came into view (true) or folded away
   * (false). While it is in view main sends frames of the page (onForgeFrame):
   * of the Forge window when it is open, else of a hidden, muted copy of the
   * page that takes no input.
   */
  forgeScreen(on: boolean): Promise<void>
  onForgeFrame(cb: (frame: ForgeFrameDto) => void): () => void

  /** The companion link (the Unreal viewer): status and switches. */
  companionStatus(): Promise<CompanionStatus>
  companionConfigure(patch: CompanionPatch): Promise<CompanionStatus>
  /** Publish the scene (while a viewer reads it, see onCompanionWant). */
  companionGraph(graph: CompanionGraphDto): void
  /** Publish where everything is now: xyz per node, and the orbit rings (6 floats each), for graph `version`. */
  companionPositions(version: number, positions: Float32Array, rings: Float32Array): void
  /** A viewer started (true) or stopped (false) reading the scene. */
  onCompanionWant(cb: (on: boolean) => void): () => void
  /** A viewer asked to select (and fly to) a node, or to open it. */
  onCompanionSelect(cb: (req: { id: string; open: boolean }) => void): () => void

  aiStatus(): Promise<AiLinkStatus>
  aiConfigure(patch: AiLinkPatch): Promise<AiLinkStatus>
  onAiActivity(cb: (a: AiActivityDto) => void): () => void
  /** Copy text to the OS clipboard (the sandboxed renderer may not have clipboard access). */
  copyText(text: string): Promise<void>

  /** process.platform of the main process ('darwin' | 'win32' | 'linux' | …). */
  platform: string
  version: string
}

export const IPC = {
  pick: 'vault:pick',
  open: 'vault:open',
  last: 'vault:last',
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
  /** main → brain window: a ProjectScanProgressDto. */
  findProgress: 'vault:findProgress',
  chatStatus: 'chat:status',
  chatConfigure: 'chat:configure',
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
  /** main → brain window and floating window: a BoardStatusDto. */
  boardState: 'board:state',
  /** main → brain window: the vault path of the board the floating window stopped showing. */
  boardClosed: 'board:closed',
  /** main → a page about to be closed: a token (number); the page answers `boardFlushed` with it once everything is saved. */
  boardFlush: 'board:flush',
  /** page → main (send): the token of the `boardFlush` that is answered. */
  boardFlushed: 'board:flushed',
  /** main → board window: why its note is gone (a string). */
  boardGone: 'board:gone',
  forgeOpen: 'forge:open',
  forgeStatus: 'forge:status',
  /** main → brain window: a ForgeRequest to serve. */
  forgeRequest: 'forge:request',
  /** brain window → main: (id, ok, value | error message). */
  forgeReply: 'forge:reply',
  /** Forge window → main (its preload): the project list / a save. */
  forgeProjects: 'forge:win:projects',
  forgeSave: 'forge:win:save',
  /** brain window → main: the star screen is in view (true) or not (false). */
  forgeScreen: 'forge:screen',
  /** main → brain window: a ForgeFrameDto for the star screen. */
  forgeFrame: 'forge:frame',
  companionStatus: 'companion:status',
  companionConfigure: 'companion:configure',
  /** brain window → main (send): the scene / the positions. */
  companionGraph: 'companion:graph',
  companionPositions: 'companion:positions',
  /** main → brain window: a viewer is reading (true) or went quiet (false). */
  companionWant: 'companion:want',
  /** main → brain window: { id, open } from a viewer. */
  companionSelect: 'companion:select',
  aiStatus: 'ai:status',
  aiConfigure: 'ai:configure',
  aiActivity: 'ai:activity',
  copy: 'app:copy',
} as const

/**
 * What the floating board window's page really calls (its preload, board-preload.cts, exposes exactly these under the same name,
 * `window.aether`, and main answers no other channel to that window: see BOARD_PAGE_CHANNELS in main/board-window.ts).
 */
export type BoardBridge = Pick<
  AetherBridge,
  | 'boardAssets'
  | 'boardClose'
  | 'boardConfigure'
  | 'boardFlushed'
  | 'boardRead'
  | 'boardSave'
  | 'boardStatus'
  | 'copyText'
  | 'createAsset'
  | 'onBoardFlush'
  | 'onBoardGone'
  | 'onBoardState'
  | 'onChanges'
  | 'openAsset'
  | 'platform'
  | 'readAsset'
  | 'readAssetChecked'
  | 'revealInFolder'
  | 'thumbnail'
  | 'version'
>

declare global {
  interface Window {
    aether?: AetherBridge
  }
}
