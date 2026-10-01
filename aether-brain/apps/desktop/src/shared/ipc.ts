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

  /** Open (or focus) the Concept Forge window; asks for concept-forge.html the first time or with `pick`. */
  forgeOpen(opts?: { pick?: boolean }): Promise<ForgeStatus>
  forgeStatus(): Promise<ForgeStatus>
  /**
   * Serve the Forge window's requests (the project list, saves) from the
   * brain's store. One handler at a time; returns the unsubscribe function.
   * A rejected promise reaches the Forge window as an error message.
   */
  onForgeRequest(handler: (req: ForgeRequest) => Promise<unknown>): () => void

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
  forgeOpen: 'forge:open',
  forgeStatus: 'forge:status',
  /** main → brain window: a ForgeRequest to serve. */
  forgeRequest: 'forge:request',
  /** brain window → main: (id, ok, value | error message). */
  forgeReply: 'forge:reply',
  /** Forge window → main (its preload): the project list / a save. */
  forgeProjects: 'forge:win:projects',
  forgeSave: 'forge:win:save',
  aiStatus: 'ai:status',
  aiConfigure: 'ai:configure',
  aiActivity: 'ai:activity',
  copy: 'app:copy',
} as const

declare global {
  interface Window {
    aether?: AetherBridge
  }
}
