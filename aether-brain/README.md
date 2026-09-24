# Aether Brain

**A local-first 3D second brain.** Your notes are neurons. `[[Wikilinks]]` are synapses. Folders are constellations, tags are colored fields, and time is an orbital layer. Capture, edit, search and review all happen inside — or beside — a navigable thought-space rendered in WebGL.

Markdown files on disk are the only source of truth. No account, no cloud, no telemetry. Delete the app and your vault is still a folder of `.md` files that Obsidian, iA Writer or `grep` can read.

```
pnpm install
pnpm dev            # browser build with the bundled demo vault → http://localhost:5173
pnpm dev:desktop    # Electron: pick any folder of markdown on your disk
```

## What it does

| Loop step    | How                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Capture**  | `c` opens a one-box capture. First line becomes the title; it lands in `Inbox/` as a real file with frontmatter.                  |
| **Organize** | Review view (`r`) walks the inbox: `p` / `a` / `s` moves a note to Projects / Areas / Resources, `3` archives. Frontmatter updated. |
| **Connect**  | Editor with `[[` autocomplete, live preview, backlinks, and _unlinked mentions_ with a one-click "link it". Ghost neurons for links whose target doesn't exist yet — select one to create it. |
| **Retrieve** | `⌘/Ctrl K` searches titles, headings, tags, body and paths (MiniSearch, fuzzy + prefix). `⌘Enter` turns the query into a graph filter that dims everything else. |
| **Review**   | Orphans, stale notes (90+ days) and spaced-review items resurface in the queue. `1` keeps a note (interval doubles), `2` snoozes, `3` archives. |
| **Wander**   | Drag to orbit, scroll to zoom, click to select, double-click to open, drag a neuron to pin it. `Tab` hops between neighbors. `t` switches to the **orbit** layout where rings are age. `m` cycles color by area / type / tag / age. |

## The 3D view

- One `InstancedMesh` for neuron cores (fresnel shader, HDR output), one for additive halos, one `LineSegments` for every synapse with travelling pulses on the selected node's edges. A 2D canvas overlay draws crisp labels for hubs, the selection and its neighborhood.
- Layout is `d3-force-3d` in a **Web Worker**: clustered by PARA area in constellation mode, radial rings by age in orbit mode. The main thread only copies a `Float32Array` per tick.
- Selective bloom (`postprocessing`) with a luminance threshold: only the neurons bloom, never the UI, edges or stars.
- 1,000 neurons / 2,500 synapses is the design budget: `http://localhost:5173/?stress=1000` opens a synthetic vault; the top bar shows live fps.

## Vaults

| Where                | Adapter                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Desktop app          | `ElectronVaultAdapter` — folder on disk via IPC; `chokidar` streams debounced changes; writes are atomic. `aether-brain ~/notes` or `AETHER_VAULT=~/notes` opens a vault directly. |
| Browser (Chromium)   | `FsAccessVaultAdapter` — File System Access API, polls mtimes for external edits.                        |
| Browser (any)        | Bundled demo vault; edits persist in IndexedDB, "Reset demo vault" forgets them.                          |

Folder → area mapping is PARA: `Inbox/`, `Projects/`, `Areas/`, `Resources/`, `Archive/`; everything else is _untagged_. Note type comes from `type:` frontmatter or the nearest folder name (`Daily/`, `People/`, `Maps/` …). See [docs/SPEC.md](docs/SPEC.md) for the data model and [docs/KEYBOARD.md](docs/KEYBOARD.md) for every key.

## Repo

```
apps/web · apps/desktop · packages/core · packages/graph · packages/ui · vault-demo · docs
```

pnpm workspace, Vite 8, React 19, TypeScript strict, three + @react-three/fiber + drei, d3-force-3d, MiniSearch, unified/remark, Zustand, Tailwind v4, Electron 44. Tests: `pnpm test` (vitest, core parsing/graph/search). Type checks: `pnpm typecheck`.

## Status

MVP. Not yet: SQLite FTS for very large vaults, AI embeddings, WebXR, packaged installers (the Electron app runs from source with `pnpm dev:desktop` / `pnpm --filter @aether/desktop start`).
