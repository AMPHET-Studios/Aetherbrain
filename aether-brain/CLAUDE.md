# Aether Brain — notes for agents and contributors

Aether Brain is a local-first **3D second brain**. Markdown files in a folder (or several folders / whole drives) are the only source of truth; the app renders them as a navigable neural map (notes = neurons, `[[wikilinks]]` = synapses, PARA folders = constellations, tags = colored fields, time = orbital rings). The default **system layout** shows the folder tree as solar systems: the vault / each drive is a sun, a project's home folder is a ★ star, folders are ● planets, notes are · moons. Claude and ChatGPT reach the brain through a local MCP server (the **AI link**, desktop only; see `docs/AI-LINK.md`). Since v0.4: the **Today hub** (`today:`) hangs above the sun with beams to every note holding one of today's tasks (the daily brief, derived, nothing written); **picture moons** (`image:<path>`) show each folder's newest images as thumbnails and `![[gate.png]]` links notes to pictures; the **Concept Forge link** (desktop, `g`) hosts the user's own `concept-forge.html` and files graded drawings (PNG + critique note) into a project's Critique planet (see `docs/FORGE-LINK.md`). Since v0.5: **AI chats** — `i` (or dropping the `.zip`) imports the Claude and ChatGPT data exports as one note per chat (plus Claude project hubs and knowledge notes, ChatGPT pictures), re-importable; the AI link's `save_chat` saves a conversation live (see `docs/AI-CHATS.md`).

## Non-negotiables

- **Local-first.** No accounts, no telemetry, no analytics SDKs, no outbound requests from the renderer. Electron's main process blocks http(s) in production. The AI link's HTTP server binds `127.0.0.1` only and every request carries a secret token. The Concept Forge window is the one exception by design: it is the user's own page in its own session (`persist:forge`), so its Deep Critique can reach the vision AI the user configured there; the brain window's session still blocks everything, and the Forge page reaches the brain only through `window.aetherForge` (projects + save, validated in main). The Forge session serves no file but the chosen page (its own `file:` handler plus a CSP header on the page, since workers bypass protocol handlers): the page can't read the vault.
- **The main process never decodes pictures.** Thumbnails are made in the hidden helper window (`thumbnailer.ts`); `nativeImage` decoding runs on Windows' UI thread and freezes the app.
- **Markdown is the format.** Never invent a proprietary note format. Frontmatter keys: `title, tags, created, updated, status, area, type, aliases`. Wikilinks: `[[Title]]`, `[[Title|alias]]`, `[[Title#Heading]]`, `![[Title]]`.
- **TypeScript strict** everywhere, `noUncheckedIndexedAccess` on. Run `pnpm typecheck` before committing.
- **Main thread stays free.** Graph physics runs in `packages/graph/src/layout/layout.worker.ts` (d3-force-3d; the system layout is the analytic `layout/system.ts`, also in the worker). Never run the simulation on the main thread.
- **One draw call per thing.** Nodes = one `InstancedMesh` (+ one for halos); edges = one `LineSegments`. No per-node meshes, no per-node React components.
- **Every feature has a keyboard path.** If you add a UI action, add a key in `packages/ui/src/hooks/useKeyboard.ts` and a command in `packages/ui/src/commands.ts`, and document it in `docs/KEYBOARD.md` (and the cheatsheet in `components/Help.tsx`). Desktop-only UI uses the extension points instead (below).
- **Writes on behalf of an AI** go through `FsVault` and only ever write `.md` notes; no MCP tool deletes a note.
- **Pictures are written create-only and checked.** The renderer writes an image only through `createAsset` (image extension, ≤ 40 MB, file signature must match a real image, never over anything, EEXIST → the next ` 2` name); `openAsset` opens existing vault pictures only (`shell.openPath` would run anything else).
- **Prefer fewer dependencies.** If a library fights the product, write the piece (see `frontmatter.ts`, `wikilink.ts`, the label overlay, the zip reader in `chats/zip.ts`).
- **Imported chat text is inert.** What a chat says must never become a link, tag or task of the brain: `inertMarkdown` escapes it (`[\[`, `\#`, `- \[ ]`) exactly where the parsers would read one, and the parsers read links and tags from each text node's markdown source (so an escape holds). Only the note's own lines (header, hub lists, a `save_chat` summary) are live.

## Layout

```
apps/web          Vite renderer, runs in a plain browser (demo vault bundled, File System Access API for real folders)
apps/desktop
  src/main        Electron main: fsvault.ts (FsVault: multi-root scan of notes + pictures, path jail, atomic writes, create-only
                  binary writes — pure Node), watcher.ts (VaultWatcher: native recursive fs.watch, 250 ms debounce, self-write echo
                  suppression, addDir/unlinkDir, picture add/change/unlink — pure Node), assets.ts (pure checks behind the picture IPC:
                  signatures, header pixel sizes and orientation, size caps, the thumbnail cache), thumbnailer.ts (Thumbnailer:
                  a hidden helper window decodes pictures off the main process; the pure ThumbQueue), ai-link.ts (HTTP MCP link lifecycle),
                  forge.ts (ForgeHost: the Concept Forge window, its persist:forge session, the relay of its saves to the brain
                  window; the checks are pure functions), main.ts (IPC per src/shared/ipc.ts)
  src/mcp         MCP server (Brain, tools, stdio + HTTP), bundled by vite.mcp.config.ts to dist/mcp/aether-mcp.mjs;
                  runs in-process for the AI link and standalone for Claude Desktop (.mcpb via scripts/pack-mcpb.mjs)
  src/preload     preload.cts → window.aether (AetherBridge); forge-preload.cts → window.aetherForge + the injected Save to Brain UI;
                  thumb-preload.cts → the thumbnail helper's decoder
  src/renderer    the same UI + ElectronVaultAdapter + RootsPanel (v), AiLinkPanel (a) and forge.ts (g), through the extension points
packages/core     parse (frontmatter, wikilinks, tags), graph build + link resolution (+ folder nodes: vault/folders.ts, graph/build.ts;
                  image + Today nodes), projects (markdown/projects.ts), tasks with due/scheduled dates (markdown/tasks.ts), the daily
                  brief (markdown/brief.ts), critique notes + grade reading (markdown/critique.ts), pictures (vault/assets.ts),
                  AI chat exports (chats/: zip.ts reader, exports.ts Claude + ChatGPT readers, notes.ts inert chat notes and
                  planChatImport), MiniSearch index, vault paths + adapters, templates
packages/graph    R3F scene, worker layout engine (constellation / orbit forces, system = layout/system.ts; the Today hub hangs above
                  the sun), materials, orbit rings, picture thumbnails (scene/thumbs.ts pure slot/LRU logic, scene/thumbLayer.ts one
                  texture array + one instanced billboard mesh), BrainController (layout mode, motion, camera follow, thumbnails), theme
packages/ui       Zustand store (store.ts), HUD, editor, palette, capture, review, projects board, inspector (notes, ghosts, folders,
                  pictures, the Today brief), picture import (components/pictures.ts, drop zone in App.tsx), AI chat import
                  (components/chats.ts reads the export; store.importChats writes it), extension points,
                  styles.css (Tailwind v4 + tokens)
vault-demo        71 richly linked starter notes + 8 pictures (also the fixture for tests; PORTALz and ConceptForge are projects with
                  planet folders; PORTALz/Art holds concept art, ConceptForge/Critique a sample critique). The pictures are generated
                  by scripts/demo-images.mjs (deterministic, zlib only)
docs              SPEC.md (product spec), KEYBOARD.md, AI-LINK.md (Claude / ChatGPT setup), FORGE-LINK.md (Concept Forge),
                  AI-CHATS.md (importing and saving chats), design/ (contracts)
```

Packages are consumed as TypeScript source via Vite aliases (`apps/*/vite.config.ts`) and `paths` in the root `tsconfig.json`; there is no build step for packages.

## Data flow

`VaultAdapter.list()` + `listFolders()` + `listAssets()` → `parseNote` (per file) → `buildGraph` (resolves links vault-wide, creates ghost nodes for unresolved targets; in the system layout also folder nodes and structural parents) → `SearchIndex.rebuild` → store → `BrainController.setGraph` → `LayoutEngine` posts to the worker → positions `Float32Array` (+ orbit rings) → `BrainScene` writes instance matrices each frame.

The store passes `loadVault` / `applyChanges` its folder set, its picture set (`assets`, copy-on-write like the folders) and a graph-options callback that asks for folder nodes only in the `'system'` layout (root title, mount labels, depth, expanded folders), picture moons there (`images.moons`; linked pictures in every layout), and the Today hub (`today: { brief }`, with the brief computed once per rebuild by `dailyBrief`). Crossing system ↔ other layouts, changing depth or expanding a folder rebuilds the graph and calls `controller.setLayoutMode(mode, graph)`.

Edits go through the store (`saveDraft`, `writeNote`, `moveToArea`, `updateProject`, `editTask`, `createFolder`, …) → adapter write → `applyChanges` (incremental parse + full graph rebuild, ~1 ms / 100 notes) → controller keeps previous positions so the layout doesn't jump. External changes (other apps, the AI link) arrive through `adapter.watch` and take the same path, folders included (`addDir` / `unlinkDir`).

Multi-root vaults (e.g. `D:\` + `F:\`): every vault path starts with the root's mount (`D/Projects/x.md`); single-root paths are unchanged. New notes go under `store.homePrefix()` (the first mount); `moveToArea` keeps a note on its own drive.

## Commands

```
pnpm install
pnpm dev             # web app at http://localhost:5173  (?demo=1 auto-opens the demo, ?stress=1000 the synthetic vault)
pnpm dev:desktop     # Electron + Vite dev server
pnpm test            # vitest: packages/core, packages/graph, packages/ui, apps/desktop (546 tests in 26 files at v0.4)
pnpm typecheck       # tsc for renderer code + Electron main + MCP server
pnpm build           # web build → apps/web/dist
pnpm build:desktop   # MCP bundle (vite) + main/preload (tsc) + renderer (vite) → apps/desktop/dist
```

Tests (v0.4): core 132 (`packages/core/test`: parsing, folders, projects, tasks and dates, frontmatter, the brief, critiques, pictures), graph 51 (`packages/graph/test`: system layout and the hub, worker, engine, camera follow and range, thumbnails and picking), ui 93 (`packages/ui/test`: store, fsAccess adapter, folder search, v0.4 store, views and review fixes — the store, palette commands and the global key handler against a `MemoryVaultAdapter`, node env, no Worker, no DOM; views server-rendered), desktop 270 + 1 skipped (`apps/desktop/test`: FsVault, watcher, picture checks, the thumbnailer, preload, MCP tools, AI link, the Forge link — some tests drive real Chromium from /opt/pw-browsers and skip without it). Run one area with `pnpm exec vitest run packages/ui`.

## Conventions

- Store actions are the API; components don't touch adapters directly.
- A project is decided **only** by `isProjectNote(note)` from `@aether/core`; `meta.type` is `'project'` for every note under a Projects folder at any depth. `setProjectFields` throws on frontmatter it can't parse — callers catch and show the error (the store toasts). `updateFrontmatter` / `rewriteFrontmatter` patch changed keys in place (comments, untouched values, BOM and line endings survive) and leave a block they cannot parse alone. New notes are always created with `adapter.create` (fails with EEXIST, never overwrites); store rewrites of one note run one at a time and start from the file on disk.
- Store rewrites of one note (tasks, project fields, `moveToArea`, `patchFrontmatter`, renames) first save a dirty editor draft of that note and stop (toast) when it can't be saved, so a draft is never overwritten. Task `line` numbers count in the saved note (what the board shows); the store follows them into the just-saved draft.
- Windows and macOS file names are case-insensitive: new notes and folders reuse the vault's existing spelling of a folder (`D/inbox`, not a second `D/Inbox`), and creating never replaces a note whose id differs only in case.
- Notes the chat importer wrote are known by their `Source: <https://claude.ai/chat/…>` (or `chatgpt.com/c/…`, `claude.ai/project/…`) line, wherever they were moved; a re-import rewrites only the `## Transcript` (chats) or `## Project` (hubs) section and everything from there down, and only when the chat grew. Chat and hub titles are unique vault-wide (links resolve by title).
- Node ids that are not notes: `folder:<vault path>` (`folderKey`, `isFolderId`, `folderPathOf`), `ghost:<target>`, `image:<vault path with extension>` (`imageKey`, `isImageId`, `imagePathOf`) and the Today hub `today:` (`TODAY_ID`). Anything that takes a note id guards with `isVirtualId`. Picture link targets (`![[gate.png]]`) never become ghosts.
- No `window.prompt` (Electron doesn't implement it): a command that needs text opens an in-app form (`store.requestForm`). `window.confirm` works.
- Desktop-only UI plugs into `@aether/ui` through extension points instead of editing the package: `registerCommands` (palette), `registerKey` (single key, same guards as the built-ins, built-ins win, returns an unregister function) and `registerHelpRows` (cheatsheet).
- Main-process writers (IPC handlers, the AI link) call `watcher.noteSelfWrite(path, content)` (content `null` for deletions; renames: `noteSelfWrite(from, null)` + `noteSelfWrite(to, content)`) so their own edits aren't echoed back. `FsVault.read/stat` return null for ignored or unresolvable paths; `write/mkdir/rename/remove` throw.
- Anything drawn per frame lives in `BrainScene.tsx` and reads from refs/typed arrays — no React state on the hot path.
- Colors: `packages/graph/src/theme.ts` and the `:root` tokens in `packages/ui/src/styles.css` must agree.
- Tests live next to the package (`packages/*/test`, `apps/desktop/test`). Add a test when you touch parsing, resolution, search, folders, projects or store actions.
