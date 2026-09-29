# Design: folder solar systems, multi-root vaults, editable projects, AI link

Status: implemented in v0.3. This is the contract the pieces are built against.
Interface files that are part of the contract (already written, do not change
their shapes without updating this doc): `packages/core/src/types.ts`,
`apps/desktop/src/shared/ipc.ts`, `packages/graph/src/layout/protocol.ts`.

## What the user asked for

1. Projects can be edited, not just read: rename, status, summary, tags, its
   folder, archive/delete; tasks can be edited, deleted and reordered.
2. A project is a **star**. The folders inside the project's main folder are its
   **planets**; folders inside those are moons; notes are satellites. You can add
   folders (planets) from the app and they are created on disk.
3. The brain mirrors the real directory organization of whole drives (`D:\`,
   `F:\`): several roots in one vault, laid out as nested solar systems.
4. Claude and ChatGPT talk to the brain directly: an MCP server exposing the
   vault (search, read, write notes, projects, tasks, folders).

## Vocabulary

- **Root**: an absolute folder on disk that is part of the vault (`D:\`).
- **Mount**: the top-level vault folder a root appears under when the vault has
  more than one root. `D:\` → `D`, `F:\` → `F`, `/home/me/Notes` → `Notes`;
  collisions get ` 2`, ` 3` suffixes. `/` → `root`.
- **Vault path**: posix, relative. Single root: relative to it (unchanged from
  v0.2, so existing ids keep working). Multi-root: `<mount>/<path in root>`.
- **Home prefix**: where new notes go. `''` for a single root; `<first mount>/`
  for multi-root. Inbox/Daily/Projects for new notes live under it.

## 1. Core (`packages/core`)

### 1.1 Types
See `types.ts`: `NodeKind`, `FolderRole`, `FolderNodeInfo`, `GraphNode.kind`,
`GraphNode.parent`, `GraphNode.folder`, `VaultChangeKind` (+ `addDir`,
`unlinkDir`), `VaultRootInfo`, `VaultAdapter.roots/listFolders/createFolder/reveal`.

Every place that constructs a `GraphNode` must set `kind` and `parent`.

### 1.2 Paths (`vault/paths.ts`)
```ts
export function folderKey(path: string): NoteId            // `folder:${normalizePath(path)}` ('' → 'folder:')
export function isFolderId(id: NoteId): boolean            // id.startsWith('folder:')
export function folderPathOf(id: NoteId): string           // inverse of folderKey
export function ancestorsOf(path: string): string[]        // 'a/b/c' → ['a','a/b'] (proper ancestors, no '')
export function mountOf(path: string, roots?: VaultRootInfo[] | null): string // first segment when multi-root, else ''
export function homePrefix(roots?: VaultRootInfo[] | null): string            // '' or `${roots[0].mount}/`
export function isBoilerplateMarkdown(path: string): boolean
  // exact, case-sensitive basenames: LICENSE.md LICENCE.md CHANGELOG.md CHANGES.md HISTORY.md
  // CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md AUTHORS.md NOTICE.md
  // PULL_REQUEST_TEMPLATE.md ISSUE_TEMPLATE.md — repo boilerplate, never notes
```
Changes:
- `areaFromFolder(path)`: the first of the first **two** segments that is a PARA
  folder name wins (so `D/Projects/x.md` is in Projects). Deeper segments never count.
- `isIgnoredPath(path)`: also true for `isBoilerplateMarkdown(path)`.

### 1.3 Folder selection (`vault/folders.ts`, new, pure)
```ts
export interface FolderSelectOptions {
  multiRoot: boolean
  /** Deepest folder level shown without expanding (root = 0, mounts = 1 in multi-root). Default 3. */
  maxDepth?: number
  /** Cap on optional (depth-based / expanded) folders. Must-show folders are never dropped. Default 1500. */
  maxFolders?: number
  /** Folders whose direct children are always shown. */
  expanded?: Iterable<string>
  /** Folders that must be shown (e.g. project folders); their ancestors too. */
  pinned?: Iterable<string>
}
export interface FolderSelection {
  /** Visible folder vault paths, always including '' (the root). */
  visible: Set<string>
  /** Direct subfolder counts on disk, per folder ('' included). */
  childCount: Map<string, number>
  /** Direct subfolders not visible, per visible folder. */
  hidden: Map<string, number>
  /** How many optional folders were dropped by maxFolders. */
  dropped: number
}
export function selectFolders(all: Iterable<string>, notePaths: Iterable<string>, opts: FolderSelectOptions): FolderSelection
```
Algorithm: the universe of folders is `all` ∪ ancestors of every folder in
`all` ∪ every note's folder and its ancestors ∪ pinned. Must-show: `''`; in
multi-root every top-level folder (mount); every note's folder chain; pinned
folders + their ancestors; direct children of expanded folders (+ their
ancestors). Optional: breadth-first by depth, folders with depth ≤ maxDepth,
alphabetical within a depth, until `maxFolders` optional folders were added
(the rest counted in `dropped`). Depth of `'a/b'` is 2; `''` is 0.

### 1.4 Graph with folders (`graph/build.ts`)
```ts
export interface FolderGraphOptions extends FolderSelectOptions {
  /** Every folder known on disk (vault paths). */
  all: Iterable<string>
  /** Title of the root node (the vault name). */
  rootTitle: string
  /** Display labels for mounts, e.g. { D: 'D:\\' }. */
  mountLabels?: Record<string, string>
}
export interface BuildGraphOptions {
  ghosts?: boolean
  /** Build folder nodes + structural parents (system layout). Omit/null for classic graphs. */
  folders?: FolderGraphOptions | null
}
export interface GraphData { /* existing fields */ folderSelection: FolderSelection | null }
```
- Without `folders`: identical to v0.2 plus `kind` ('note' / 'ghost'), `parent: null`, `folderSelection: null`.
- With `folders`:
  - Project binding: every project note (`isProjectNote`) gets a home folder via
    `projectFolderOf(note, allFolderSet)`; those folders are pinned.
  - Folder nodes are appended after ghosts, sorted by path, id `folderKey(path)`.
    `title`: basename; root → `rootTitle`; mount → `mountLabels[m] ?? m`.
    `area`: `areaFromFolder(path + '/x')` ?? 'untagged' (project folders: 'projects').
    `type`: 'project' for project folders, else 'moc'. `tags: []`, degrees 0,
    `created/updated: null`, `wordCount: 0`, `ghost: false`, `kind: 'folder'`.
  - `folder` info: role (`''` → root; multi-root depth 1 → mount; bound project
    folder → project; else folder), depth, projectId, inProject (some ancestor
    is a project folder), childFolders/hiddenFolders from the selection,
    notes (direct), totalNotes (subtree).
  - `parent`: folder → nearest visible ancestor folder id (root → null). Note →
    if it is the bound project note of folder F: F; else nearest visible
    ancestor of its folder. Ghost → the lexicographically first note linking to
    it (fallback root).
  - Folder nodes never add edges, backlinks, outlinks, tag/area counts or orphans.

### 1.5 Loading and changes (`vault/load.ts`)
```ts
export interface LoadedVault { notes; graph; search; folders: Set<string> }
export function loadVault(adapter, search?, onProgress?, graphOptions?: (folders: Set<string>, notes: Map<NoteId, ParsedNote>) => BuildGraphOptions): Promise<LoadedVault>
export function applyChanges(
  notes: Map<NoteId, ParsedNote>, changes: VaultChange[], search: SearchIndex,
  opts?: { folders?: Set<string>; graph?: (folders: Set<string>, notes: Map<NoteId, ParsedNote>) => BuildGraphOptions },
): { notes; graph; touched: NoteId[]; folders: Set<string> }
```
`folders` = `adapter.listFolders?.()` ?? every note folder + ancestors.
`addDir` adds the folder (and ancestors); `unlinkDir` removes it and every
descendant folder (the adapter sends `unlink` for the notes itself).

### 1.6 Projects (`markdown/projects.ts`, new; tasks stay in `tasks.ts`)
```ts
/** True for an explicit `type: project` in frontmatter, or a note sitting directly in the
 *  Projects area folder (`Projects/X.md`, `D/Projects/X.md`), or the folder note of a direct
 *  child of it (`Projects/X/X.md`). Never for notes in Archive. Notes deeper inside a project
 *  folder are ordinary notes of that project. */
export function isProjectNote(note: ParsedNote): boolean
/** Home folder of a project: 1) frontmatter `folder:` (vault path, normalized, must exist in `folders`
 *  or be creatable — return it even if missing); 2) folder note: parent folder when the note's
 *  basename equals the folder's basename (case-insensitive); 3) sibling folder with the note's
 *  basename (`Projects/PORTALz.md` + `Projects/PORTALz/`) when it exists in `folders`; else null. */
export function projectFolderOf(note: ParsedNote, folders: Set<string>): string | null
/** Where a new folder for a project without one goes: `<note folder>/<basename>`. */
export function defaultProjectFolder(note: ParsedNote): string
export interface ProjectPatch { title?: string; status?: string | null; summary?: string | null; tags?: string[]; folder?: string | null }
/** Rewrite a project note. title: frontmatter title + first H1, old title appended to `aliases`
 *  (so existing [[links]] keep resolving). summary: replace the first `> ` blockquote line after
 *  the H1, insert one after the H1 if missing, remove it when '' / null. status/tags/folder:
 *  frontmatter (null deletes the key). Body otherwise byte-identical. */
export function setProjectFields(raw: string, patch: ProjectPatch): string
/** Project summary as shown on cards: first blockquote line after the H1, else first paragraph. */
export function projectSummary(note: ParsedNote): string
/** A folder note that makes an existing folder a project: `<folder>/<basename>.md`. */
export function folderProjectNote(folder: string, opts?: { summary?: string; tags?: string[] }, now?: Date): { path: string; content: string; title: string }
```
`projectNote(input)` (tasks.ts) gains `dir?: string` (default `'Projects'`) and
`folder?: string` (written to frontmatter).

Task editing (`tasks.ts`):
```ts
export function editTask(raw: string, line: number, text: string): string   // keeps indent, bullet, [x], ✅ stamp
export function deleteTask(raw: string, line: number): string               // removes the task line only
export function moveTask(raw: string, line: number, dir: -1 | 1): { raw: string; line: number }
  // swaps with the previous/next task of the same section and indent; no-op at the edges
```

## 2. Graph (`packages/graph`)

### 2.1 Protocol
See `protocol.ts`: `LayoutMode` gains `'system'`; `LayoutNodeInput.parent/kind/role`;
`{type:'motion'}`; `{type:'rings'}`.

### 2.2 System layout (`layout/system.ts`, pure, unit-tested)
```ts
export interface SystemInput { parent: Int32Array; kind: Uint8Array; role: Int8Array; radius: Float32Array; ids: string[] }
export interface SystemLayout {
  order: Int32Array          // parents before children
  orbitRadius: Float32Array  // distance from parent (0 for roots)
  phase: Float32Array        // initial angle
  speed: Float32Array        // rad/s
  plane: Float32Array        // quaternion per node (4 floats): orientation of the orbit plane around its parent
  shell: Uint8Array          // 1 when the node sits on a spherical shell (many leaf moons) instead of a ring
  shellDir: Float32Array     // unit direction (3 floats) on the shell for shell nodes
  rings: Float32Array        // 6 floats per ring (see protocol)
  extent: Float32Array       // subtree radius
}
export function computeSystemLayout(input: SystemInput): SystemLayout
export function systemPositions(layout: SystemLayout, t: number, out: Float32Array, offsets?: Float32Array): void
```
- Extent bottom-up. Leaves (notes, ghosts, collapsed folders without visible
  children): `radius*1.6 + 1`.
- Children of a node: leaf moons on the inner rings; folder children (planets)
  on outer rings, biggest first. A ring holds children while
  `Σ(2·extent + gap) ≤ 2π·r`; next ring `r_next = r + maxExtent_this + maxExtent_next + gap`.
  More than 24 leaf moons → a Fibonacci sphere shell instead of rings.
- First ring radius `radius(parent)*2.4 + extent + gap`. Gap ≈ 2.
- Every parent gets a stable tilted orbit plane (hash of its id → inclination
  0–0.45 rad, any azimuth) so systems read in 3D. Angles within a ring are
  allocated by extent; start phase from the hash.
- Speed: `ω = 0.9 / sqrt(max(r, 4))` rad/s, alternate direction per depth;
  shells rotate rigidly with ω. Roots sit at the origin; several roots (should
  not happen) go on a wide ring.
- `systemPositions` walks `order`: `pos[i] = pos[parent] + rot(plane[parent]) · ring/shell offset(t) + offsets[i]`
  (offsets = user drags; children follow because they are relative).

### 2.3 Worker
- Mode 'system': no d3 simulation. Compute layout, post `rings`, then post
  positions. Transition: over 1.2 s ease from the previous positions to the
  system positions. Motion on → post every 33 ms with `settled:false`
  forever; motion off → post once with `settled:true` (after the transition).
- `pin` in system mode: `offsets[i] += target - current(i)`; `release` keeps it.
- Other modes: unchanged, but post an empty `rings` message on every generation.

### 2.4 Controller + scene
```ts
class BrainController {
  motion: boolean            // default true
  setMotion(on: boolean): void
  /** Switch layout; pass the rebuilt graph when the node set changes (system ↔ others). */
  setLayoutMode(mode: LayoutMode, graph?: GraphData): void
  follow: boolean            // camera follows the selected node while it orbits (default true)
}
LayoutEngine: rings: Float32Array (latest ring buffer, empty when none); setMotion(on)
theme.ts:
  export const STAR_COLOR = '#ffcf6b', SUN_COLOR = '#fff1d6'
  export function planetColor(path: string): string   // stable hashed hue, soft saturation
  nodeRadius(n): folders by role — root 8, mount 6.5, project 5.5,
    folder 1.6 + 0.55*log2(1 + totalNotes + childFolders) clamped [1.6, 4.2]; notes unchanged
  nodeBaseColor: folders ignore color mode — root/mount SUN_COLOR, project STAR_COLOR, else planetColor(path)
```
Scene: folder glow by role (root/mount 2.2, project 2.4 — they bloom; planets 0.95
— solid, no bloom). Orbit rings: one instanced line geometry (unit circle, 96
segments) with per-ring center (parent live position), radius, quaternion,
alpha; drawn only in system mode; brighter for the selected node's system.
Labels: root, mounts and project stars always; planets when big on screen;
collapsed folders show `+N`. Project star labels prefixed `★ `. Picking and
drag work for all nodes. Camera follow: while motion is on and a node is
selected, each frame `controls.moveTo(targetEnd + delta, true)` by the selected
node's movement since the last frame.

## 3. Desktop main process (`apps/desktop/src/main`)

### 3.1 `fsvault.ts` (pure Node, no electron import; shared with the MCP server)
```ts
export const HEAVY_DIRS: Set<string>          // lowercased folder names never scanned (see file)
export interface MountedRoot { abs: string; mount: string; label: string }
export interface ScanResult { files: { path: string; abs: string }[]; folders: string[]; truncated: boolean; dirs: number }
export interface ScanProgress { dirs: number; found: number }
export class FsVault {
  constructor(roots: string[], opts?: { exclude?: string[]; maxDirs?: number })
  readonly roots: MountedRoot[]            // mount '' when single-root
  readonly multi: boolean
  exclude: string[]
  static mountNames(absRoots: string[]): MountedRoot[]
  /** vault path → absolute path; throws on escape, unknown mount, or '' in multi-root. */
  abs(vaultPath: string): string
  /** absolute path → vault path, or null when outside every root. */
  toVault(abs: string): string | null
  /** Hidden (dot/$ prefixed), HEAVY_DIRS, OS system folders, user excludes — any segment of the path inside its root. */
  isIgnored(vaultPath: string): boolean
  scan(onProgress?: (p: ScanProgress) => void): Promise<ScanResult>     // BFS over all roots, markdown only, folder cap maxDirs (default 250k)
  readAll(files: ScanResult['files'], onProgress?: (done: number) => void): Promise<{ path: string; content: string; mtime: number }[]>  // 32-way concurrency
  lastScan: ScanResult | null
  read(p: string): Promise<string | null>
  write(p: string, content: string): Promise<void>                   // atomic temp+rename, mkdir -p
  remove(p: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(p: string): Promise<void>
  stat(p: string): Promise<{ isDir: boolean; isFile: boolean; mtime: number } | null>
}
```
OS system folders skipped (case-insensitive, any depth): names starting with
`$` or `.`, `System Volume Information`, `Windows`, `Program Files`,
`Program Files (x86)`, `ProgramData`, `Recovery`, `PerfLogs`, `MSOCache`,
`Config.Msi`, `AppData`, `WindowsApps`, `steamapps`, plus the v0.2 heavy list and
`third_party`, `thirdparty`, `site-packages`, `.git`.

### 3.2 `watcher.ts` (pure Node; shared with the MCP server)
```ts
export class VaultWatcher {
  constructor(vault: FsVault, known: { files: Iterable<string>; folders: Iterable<string> }, sink: (changes: VaultChangeDto[]) => void, opts?: { debounceMs?: number })
  start(): void            // fs.watch(root.abs, { recursive: true }) per root
  stop(): void
  /** Remember content we wrote so the echo is swallowed (3 s window). */
  noteSelfWrite(path: string, content: string | null /* null = deleted */): void
}
```
Classification on flush (debounced 250 ms, paths filtered by `isIgnored` before any stat):
existing `.md` file → `add` (unknown) / `change` (known, content ≠ self-write);
existing folder not known → `addDir` + scan its subtree (`addDir` / `add` for
everything inside); missing known file → `unlink`; missing known folder →
`unlinkDir` + `unlink`/`unlinkDir` for everything known under it. chokidar is
removed (native recursive fs.watch on Windows/macOS/Linux, Node ≥ 20).

### 3.3 `main.ts`
- Settings: `{ roots?: string[]; lastVault?: string (migrated into roots); exclude?: string[]; ai?: { enabled; port; token; readOnly } }`.
- CLI: every non-flag argument is a root; `AETHER_VAULT` split on `path.delimiter`.
- IPC per `ipc.ts`. `vault:open` accepts a string or string[].
- `listDrives`: on win32 test `A:\`…`Z:\` with `fs.access`; elsewhere `[]`.
- AI link: `ai-link.ts` owns the HTTP MCP server lifecycle (start/stop/restart on
  root changes or settings), token generation (`crypto.randomBytes(24).toString('base64url')`),
  status (see `AiLinkStatus`), and forwards activity to the renderer. It
  dynamic-imports the bundled server `dist/mcp/aether-mcp.mjs` (asar-unpacked).
- The renderer network block stays; the MCP server binds `127.0.0.1` only.

## 4. MCP server (`apps/desktop/src/mcp`, bundled to `dist/mcp/aether-mcp.mjs`)

Module API (exports of the bundle; `main` imports these):
```ts
export interface BrainOptions { roots: string[]; exclude?: string[]; readOnly?: boolean; watch?: boolean }
export class Brain { static open(opts: BrainOptions): Promise<Brain>; close(): void /* index + watcher */ }
export interface ActivityEvent { client: string; tool: string; summary: string; path: string | null; write: boolean }
export function createMcpServer(brain: Brain, opts: { readOnly: boolean; onActivity?: (a: ActivityEvent) => void; getClient?: () => string }): McpServer
export interface HttpLink { url: string; port: number; close(): Promise<void> }
export function startHttpLink(opts: { brain: Brain; host?: string; port: number; token: string; readOnly: boolean; onActivity?: (a: ActivityEvent) => void }): Promise<HttpLink>
export function runStdio(argv: string[]): Promise<void>   // CLI: --vault <dir> (repeatable) --read-only --exclude <name> --http --port --token --host
```
CLI entry runs when the file is executed directly (`node aether-mcp.mjs --vault D:\ --vault F:\`).

Tools (snake_case; read tools `readOnlyHint: true`; writes only when not read-only):
| tool | purpose |
| --- | --- |
| `search` | ChatGPT connector convention: `{query}` → `{results:[{id,title,url}]}` |
| `fetch` | ChatGPT convention: `{id}` → `{id,title,text,url,metadata}` |
| `vault_overview` | roots, counts, areas, top tags, hubs, projects — orientation |
| `search_notes` | `{query, limit?, folder?}` → hits with path, tags, snippet |
| `read_note` | `{note}` (id, path, or title) → frontmatter, markdown, links, backlinks, tasks |
| `list_folder` | `{path?, depth?}` → subfolders + notes, counts (the solar system as a tree) |
| `list_projects` | status, folder, progress, next tasks |
| `get_project` | `{project}` → summary, tasks (with line numbers), planets (subfolders), notes |
| `related_notes` | `{note, limit?}` → linked + similar notes |
| `recent_notes` | `{limit?, days?}` |
| `create_note` | `{title, folder?, content?, tags?, type?}` → never overwrites |
| `append_to_note` | `{note, text, heading?}` |
| `edit_note` | `{note, old_text, new_text}` exact, single occurrence |
| `update_frontmatter` | `{note, set?, remove?}` |
| `capture` | `{text, tags?}` → Inbox |
| `add_task` / `set_task_done` / `edit_task` / `delete_task` | project to-dos |
| `create_project` / `update_project` | projects (title, status, summary, tags, folder) |
| `create_folder` | `{path}` — a new planet |
| `link_notes` | `{from, to}` → appends `- Related: [[to]]` |

No tool deletes a note file. Every write goes through `FsVault` (path jail,
`.md` only, atomic). Note references resolve by id, vault path (with or
without `.md`), then title/alias; ambiguity is an error listing candidates.

HTTP: stateless Streamable HTTP on `http://127.0.0.1:<port>/mcp/<token>`
(also accepts `Authorization: Bearer <token>` on `/mcp`); anything else 401/404;
1 MB body cap; constant-time token compare.

Distribution: `release/aether-brain-<version>.mcpb` (Claude Desktop one-click;
directory `user_config` with `multiple: true`; built by `scripts/pack-mcpb.mjs`
with a tiny built-in zip writer), the unpacked script inside the app for the
stdio config and the in-app HTTP link for ChatGPT / claude.ai via a tunnel.
See `docs/AI-LINK.md`.

## 5. UI (`packages/ui`, `apps/desktop/src/renderer`)

Store additions:
```ts
roots: VaultRootInfo[]; folders: Set<string>; expandedFolders: Set<string>
settings.layoutMode: LayoutMode (default 'system'; one-time migration to 'system' via settings.v = 2)
settings.folderDepth: number (default 3, 1–8); settings.motion: boolean (default true)
homePrefix(): string
toggleFolder(path: string): void                 // expand/collapse; persisted per vault location
setFolderDepth(n: number): void
createFolder(path: string): Promise<string | null>   // returns path; toast; selects the new planet
makeProject(folderPath: string): Promise<NoteId | null>
updateProject(id: NoteId, patch: ProjectPatch & { renameFile?: boolean }): Promise<NoteId>
editTask(id: NoteId, line: number, text: string): Promise<void>
deleteTask(id: NoteId, line: number): Promise<void>
moveTask(id: NoteId, line: number, dir: -1 | 1): Promise<void>
archiveProject(id: NoteId): Promise<void>        // moveToArea(id, 'archive')
deleteProject(id: NoteId): Promise<void>         // confirm in the UI, then deleteNote
```
- New notes (capture, ghosts, daily, projects) go under `homePrefix()`;
  `moveToArea` keeps the note's own mount.
- `openNote(folderId)` toggles expand + selects; ghosts unchanged.
- Graph is built with folders only in 'system' mode; switching mode or depth,
  expanding, or folder changes rebuild it (`controller.setLayoutMode(mode, graph)`).
- Projects board: editable header (title, status select, tags, summary), home
  folder row (link / change / create), planets list (subfolders with note
  counts) with "Add folder" input, task rows with edit (✎ / double-click /
  `Enter` on a focused row), delete, move up/down (Alt+↑/↓), Archive and Delete
  project. Keys on the board: `e` edit project, `f` add folder, `s` cycle status.
- Inspector for folder nodes: path, role, counts, children, actions (new note
  here, new folder here, make project / open project, expand/collapse, reveal).
- TopBar: layout button cycles Constellation → Orbit → System; counts exclude folders.
- Legend: system mode key (★ star · ● planet · · moon), depth −/+, motion toggle.
- Keys: `t` cycle layout, `o` orbit motion, `[` `]` folder depth, `x` expand /
  collapse selected folder; desktop: `v` vault folders panel, `a` AI link panel.
- Desktop renderer: `RootsPanel` (roots list, add folder, one-click drives,
  remove, exclusions, rescan) and `AiLinkPanel` (on/off, read-only, port, URL,
  copy buttons for Claude Desktop / Claude Code / ChatGPT, token regenerate,
  activity feed). AI activity arrives as toasts and flies to the touched note.

Extension points for desktop-only UI (exported from `@aether/ui`):
```ts
export function registerCommands(cmds: Command[]): void                 // palette entries (commands.ts)
export function registerKey(key: string, run: () => void): () => void   // single-key shortcut, same guards as built-ins
export function registerHelpRows(group: string, rows: [string, string][]): void
```

## Addendum (wave 2 decisions)

### Graph: settle signal in system mode
The worker posts `settled: true` on the frame where the transition into the system
layout completes (even if orbit motion keeps posting `settled: false` frames after
it). `BrainController.setLayoutMode(mode, graph)` arms a one-shot camera refit on the
next `settled` frame, exactly like a freshly opened vault.

### MCP brain inside the Electron main process
```ts
export interface BrainOptions {
  roots: string[]
  exclude?: string[]
  readOnly?: boolean
  /** Run its own recursive fs.watch (default true). The in-app link passes false and feeds changes itself. */
  watch?: boolean
  /** Skip the initial scan by handing over what the host already read. */
  preload?: { files: { path: string; content: string; mtime: number }[]; folders: string[] }
}
class Brain {
  static open(opts: BrainOptions): Promise<Brain>
  /** Apply file/folder changes observed elsewhere (the host's watcher). Idempotent. */
  applyExternal(changes: VaultChangeDto[]): void
  close(): void
}
```
The Electron main process opens the in-app Brain with `watch: false`, `preload` = the
files + folders it already read for the renderer, and forwards every batch from its own
VaultWatcher to `brain.applyExternal`. Brain writes go through its own FsVault; main's
watcher then sees them like any external edit and the renderer updates live.

### HTTP link host check
No Host-header allow-list: the tunnel (cloudflared / ngrok) forwards public host names.
Every request must carry the secret token instead (URL path `/mcp/<token>` or
`Authorization: Bearer <token>` on `/mcp`), compared in constant time. Stateless
Streamable HTTP: a fresh McpServer + StreamableHTTPServerTransport per POST
(`sessionIdGenerator: undefined`, `maxRequestBodySize: 1048576`); GET/DELETE → 405.

### Client names for activity
stdio: `server.server.getClientVersion()?.name`. HTTP (stateless, no handshake per request):
derive from `User-Agent` — contains `openai` → `ChatGPT`, `claude`/`anthropic` → `Claude`,
else `AI client`.

### Package scripts (apps/desktop/package.json, owned by the MCP agent)
`build:mcp` = `vite build --config vite.mcp.config.ts` → `dist/mcp/aether-mcp.mjs`;
`build` = `pnpm build:mcp && pnpm build:main && pnpm build:renderer`;
`typecheck:mcp` = `tsc -p tsconfig.mcp.json --noEmit` (root `typecheck` runs it too);
`pack:mcpb` = `node scripts/pack-mcpb.mjs` → `release/aether-brain-<version>.mcpb`;
every `dist*` script also runs `pack:mcpb`. `chokidar` is removed from dependencies.
`scripts/dev.mjs` (desktop main agent) runs `pnpm build:mcp` once before starting Electron.
