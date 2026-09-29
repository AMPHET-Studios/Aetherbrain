# Aether Brain — notes for agents and contributors

Aether Brain is a local-first **3D second brain**. Markdown files in a folder (or several folders / whole drives) are the only source of truth; the app renders them as a navigable neural map (notes = neurons, `[[wikilinks]]` = synapses, PARA folders = constellations, tags = colored fields, time = orbital rings). The default **system layout** shows the folder tree as solar systems: the vault / each drive is a sun, a project's home folder is a ★ star, folders are ● planets, notes are · moons. Claude and ChatGPT reach the brain through a local MCP server (the **AI link**, desktop only; see `docs/AI-LINK.md`).

## Non-negotiables

- **Local-first.** No accounts, no telemetry, no analytics SDKs, no outbound requests from the renderer. Electron's main process blocks http(s) in production. The AI link's HTTP server binds `127.0.0.1` only and every request carries a secret token.
- **Markdown is the format.** Never invent a proprietary note format. Frontmatter keys: `title, tags, created, updated, status, area, type, aliases`. Wikilinks: `[[Title]]`, `[[Title|alias]]`, `[[Title#Heading]]`, `![[Title]]`.
- **TypeScript strict** everywhere, `noUncheckedIndexedAccess` on. Run `pnpm typecheck` before committing.
- **Main thread stays free.** Graph physics runs in `packages/graph/src/layout/layout.worker.ts` (d3-force-3d; the system layout is the analytic `layout/system.ts`, also in the worker). Never run the simulation on the main thread.
- **One draw call per thing.** Nodes = one `InstancedMesh` (+ one for halos); edges = one `LineSegments`. No per-node meshes, no per-node React components.
- **Every feature has a keyboard path.** If you add a UI action, add a key in `packages/ui/src/hooks/useKeyboard.ts` and a command in `packages/ui/src/commands.ts`, and document it in `docs/KEYBOARD.md` (and the cheatsheet in `components/Help.tsx`). Desktop-only UI uses the extension points instead (below).
- **Writes on behalf of an AI** go through `FsVault` and only ever write `.md` notes; no MCP tool deletes a note.
- **Prefer fewer dependencies.** If a library fights the product, write the piece (see `frontmatter.ts`, `wikilink.ts`, the label overlay).

## Layout

```
apps/web          Vite renderer, runs in a plain browser (demo vault bundled, File System Access API for real folders)
apps/desktop
  src/main        Electron main: fsvault.ts (FsVault: multi-root scan, path jail, atomic writes — pure Node),
                  watcher.ts (VaultWatcher: native recursive fs.watch, 250 ms debounce, self-write echo suppression,
                  addDir/unlinkDir — pure Node; chokidar is gone), ai-link.ts (HTTP MCP link lifecycle), main.ts (IPC per src/shared/ipc.ts)
  src/mcp         MCP server (Brain, tools, stdio + HTTP), bundled by vite.mcp.config.ts to dist/mcp/aether-mcp.mjs;
                  runs in-process for the AI link and standalone for Claude Desktop (.mcpb via scripts/pack-mcpb.mjs)
  src/preload     contextBridge → window.aether (AetherBridge)
  src/renderer    the same UI + ElectronVaultAdapter + RootsPanel (v) and AiLinkPanel (a), registered through the extension points
packages/core     parse (frontmatter, wikilinks, tags), graph build + link resolution (+ folder nodes: vault/folders.ts, graph/build.ts),
                  projects (markdown/projects.ts) and tasks (markdown/tasks.ts), MiniSearch index, vault paths + adapters, templates
packages/graph    R3F scene, worker layout engine (constellation / orbit forces, system = layout/system.ts), materials, orbit rings,
                  BrainController (imperative view state: layout mode, motion, camera follow), theme
packages/ui       Zustand store (store.ts), HUD, editor, palette, capture, review, projects board, inspector (notes, ghosts, folders),
                  extension points, styles.css (Tailwind v4 + tokens)
vault-demo        70 richly linked starter notes (also the fixture for tests; PORTALz and ConceptForge are projects with planet folders)
docs              SPEC.md (product spec), KEYBOARD.md, AI-LINK.md (Claude / ChatGPT setup), design/ (contracts)
```

Packages are consumed as TypeScript source via Vite aliases (`apps/*/vite.config.ts`) and `paths` in the root `tsconfig.json`; there is no build step for packages.

## Data flow

`VaultAdapter.list()` + `listFolders()` → `parseNote` (per file) → `buildGraph` (resolves links vault-wide, creates ghost nodes for unresolved targets; in the system layout also folder nodes and structural parents) → `SearchIndex.rebuild` → store → `BrainController.setGraph` → `LayoutEngine` posts to the worker → positions `Float32Array` (+ orbit rings) → `BrainScene` writes instance matrices each frame.

The store passes `loadVault` / `applyChanges` its folder set and a graph-options callback that asks for folder nodes only in the `'system'` layout (root title, mount labels, depth, expanded folders). Crossing system ↔ other layouts, changing depth or expanding a folder rebuilds the graph and calls `controller.setLayoutMode(mode, graph)`.

Edits go through the store (`saveDraft`, `writeNote`, `moveToArea`, `updateProject`, `editTask`, `createFolder`, …) → adapter write → `applyChanges` (incremental parse + full graph rebuild, ~1 ms / 100 notes) → controller keeps previous positions so the layout doesn't jump. External changes (other apps, the AI link) arrive through `adapter.watch` and take the same path, folders included (`addDir` / `unlinkDir`).

Multi-root vaults (e.g. `D:\` + `F:\`): every vault path starts with the root's mount (`D/Projects/x.md`); single-root paths are unchanged. New notes go under `store.homePrefix()` (the first mount); `moveToArea` keeps a note on its own drive.

## Commands

```
pnpm install
pnpm dev             # web app at http://localhost:5173  (?demo=1 auto-opens the demo, ?stress=1000 the synthetic vault)
pnpm dev:desktop     # Electron + Vite dev server
pnpm test            # vitest: packages/core, packages/graph, packages/ui, apps/desktop (255 tests in 13 files at v0.3)
pnpm typecheck       # tsc for renderer code + Electron main + MCP server
pnpm build           # web build → apps/web/dist
pnpm build:desktop   # MCP bundle (vite) + main/preload (tsc) + renderer (vite) → apps/desktop/dist
```

Tests (v0.3): core 82 (`packages/core/test`: parsing, folders, projects, tasks), graph 29 (`packages/graph/test`: system layout, worker), ui 21 (`packages/ui/test/store.test.ts`: the store, palette commands and the global key handler against a `MemoryVaultAdapter`, node env, no Worker, no DOM), desktop 123 (`apps/desktop/test`: FsVault, watcher, MCP tools, AI link). Run one area with `pnpm exec vitest run packages/ui`.

## Conventions

- Store actions are the API; components don't touch adapters directly.
- A project is decided **only** by `isProjectNote(note)` from `@aether/core`; `meta.type` is `'project'` for every note under a Projects folder at any depth. `setProjectFields` throws on frontmatter it can't parse — callers catch and show the error (the store toasts). Never rewrite a frontmatter block whose YAML does not parse (`updateFrontmatter` would drop it); the store stamps `updated:` in place.
- Store rewrites of one note (tasks, project fields, `moveToArea`, `patchFrontmatter`, renames) first save a dirty editor draft of that note and stop (toast) when it can't be saved, so a draft is never overwritten. Task `line` numbers count in the saved note (what the board shows); the store follows them into the just-saved draft.
- Windows and macOS file names are case-insensitive: new notes and folders reuse the vault's existing spelling of a folder (`D/inbox`, not a second `D/Inbox`), and creating never replaces a note whose id differs only in case.
- Folder node ids are `folder:<vault path>` (`folderKey`, `isFolderId`, `folderPathOf`); anything that takes a note id must guard against folder and ghost ids.
- No `window.prompt` (Electron doesn't implement it): a command that needs text opens an in-app form (`store.requestForm`). `window.confirm` works.
- Desktop-only UI plugs into `@aether/ui` through extension points instead of editing the package: `registerCommands` (palette), `registerKey` (single key, same guards as the built-ins, built-ins win, returns an unregister function) and `registerHelpRows` (cheatsheet).
- Main-process writers (IPC handlers, the AI link) call `watcher.noteSelfWrite(path, content)` (content `null` for deletions; renames: `noteSelfWrite(from, null)` + `noteSelfWrite(to, content)`) so their own edits aren't echoed back. `FsVault.read/stat` return null for ignored or unresolvable paths; `write/mkdir/rename/remove` throw.
- Anything drawn per frame lives in `BrainScene.tsx` and reads from refs/typed arrays — no React state on the hot path.
- Colors: `packages/graph/src/theme.ts` and the `:root` tokens in `packages/ui/src/styles.css` must agree.
- Tests live next to the package (`packages/*/test`, `apps/desktop/test`). Add a test when you touch parsing, resolution, search, folders, projects or store actions.
