# Aether Brain — notes for agents and contributors

Aether Brain is a local-first **3D second brain**. Markdown files in a folder are the only source of truth; the app renders them as a navigable neural map (notes = neurons, `[[wikilinks]]` = synapses, PARA folders = constellations, tags = colored fields, time = orbital rings).

## Non-negotiables

- **Local-first.** No accounts, no telemetry, no analytics SDKs, no outbound requests from the renderer. Electron's main process blocks http(s) in production.
- **Markdown is the format.** Never invent a proprietary note format. Frontmatter keys: `title, tags, created, updated, status, area, type, aliases`. Wikilinks: `[[Title]]`, `[[Title|alias]]`, `[[Title#Heading]]`, `![[Title]]`.
- **TypeScript strict** everywhere, `noUncheckedIndexedAccess` on. Run `pnpm typecheck` before committing.
- **Main thread stays free.** Graph physics runs in `packages/graph/src/layout/layout.worker.ts` (d3-force-3d). Never run the simulation on the main thread.
- **One draw call per thing.** Nodes = one `InstancedMesh` (+ one for halos); edges = one `LineSegments`. No per-node meshes, no per-node React components.
- **Every feature has a keyboard path.** If you add a UI action, add a key in `packages/ui/src/hooks/useKeyboard.ts` and a command in `packages/ui/src/commands.ts`, and document it in `docs/KEYBOARD.md`.
- **Prefer fewer dependencies.** If a library fights the product, write the piece (see `frontmatter.ts`, `wikilink.ts`, the label overlay).

## Layout

```
apps/web        Vite renderer, runs in a plain browser (demo vault bundled, File System Access API for real folders)
apps/desktop    Electron main (chokidar watcher, path-jailed fs IPC) + preload + the same renderer
packages/core   parse (frontmatter, wikilinks, tags), graph build + link resolution, MiniSearch index, vault adapters, templates
packages/graph  R3F scene, worker layout engine, materials, BrainController (imperative view state), theme
packages/ui     Zustand store, HUD, editor, palette, capture, review, inspector, styles.css (Tailwind v4 + tokens)
vault-demo      60 richly linked starter notes (also the fixture for smoke tests)
docs            SPEC.md (product spec), KEYBOARD.md
```

Packages are consumed as TypeScript source via Vite aliases (`apps/*/vite.config.ts`) and `paths` in the root `tsconfig.json`; there is no build step for packages.

## Data flow

`VaultAdapter.list()` → `parseNote` (per file) → `buildGraph` (resolves links vault-wide, creates ghost nodes for unresolved targets) → `SearchIndex.rebuild` → store → `BrainController.setGraph` → `LayoutEngine` posts to the worker → positions `Float32Array` → `BrainScene` writes instance matrices each frame.

Edits go through the store (`saveDraft`, `writeNote`, `moveToArea`, …) → adapter write → `applyChanges` (incremental parse + full graph rebuild, ~1 ms / 100 notes) → controller keeps previous positions so the layout doesn't jump. External changes arrive through `adapter.watch` and take the same path.

## Commands

```
pnpm install
pnpm dev             # web app at http://localhost:5173  (?demo=1 auto-opens the demo, ?stress=1000 the synthetic vault)
pnpm dev:desktop     # Electron + Vite dev server
pnpm test            # vitest (packages/core)
pnpm typecheck       # tsc for renderer code + Electron main
pnpm build           # web build → apps/web/dist
pnpm build:desktop   # main/preload (tsc) + renderer (vite) → apps/desktop/dist
```

## Conventions

- Store actions are the API; components don't touch adapters directly.
- Anything drawn per frame lives in `BrainScene.tsx` and reads from refs/typed arrays — no React state on the hot path.
- Colors: `packages/graph/src/theme.ts` and the `:root` tokens in `packages/ui/src/styles.css` must agree.
- Tests live next to the package (`packages/core/test`). Add a test when you touch parsing, resolution or search.
