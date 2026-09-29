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
  /** File add/change/unlink, or folder addDir/unlinkDir (path = the folder). */
  kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
  content?: string
  mtime?: number
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
