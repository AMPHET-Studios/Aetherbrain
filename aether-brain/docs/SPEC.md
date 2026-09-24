# Aether Brain — product spec (trimmed working copy)

## 0. Product definition

Aether Brain is a personal knowledge operating system whose primary interface is a navigable 3D thought-space, not a file tree.

- A note is a neuron.
- A `[[wikilink]]` is a synapse.
- A folder / PARA area is a cluster / constellation.
- A tag is a colored field.
- Time is an orbital layer.
- Capture, edit, search and wander all happen inside or beside that space.

**Not:** an Obsidian plugin, a 2D graph with a 3D camera bolted on, a chat wrapper around notes, a SaaS that uploads the vault.

**Is:** a standalone app the user runs locally; markdown files on disk as the source of truth; a cinematic, usable 3D knowledge world; a real second brain loop — Inbox → organize → connect → retrieve → review.

Aesthetic: dark cosmos / living neural map. Deep space, bloom, glowing nodes, filament edges, readable UI chrome.

## 1. Hard constraints

- TypeScript strict throughout.
- Local-first. No required cloud account. No telemetry.
- Notes live as `.md` files in a user-selected vault folder.
- Wikilinks: `[[Note Title]]`, `[[Note Title|alias]]`, `[[Note Title#heading]]`, `![[Note Title]]` (embed).
- Frontmatter YAML: `title, tags, created, updated, status, area, type, aliases`.
- No proprietary note format.
- Graph physics never blocks the main thread: Web Worker (`d3-force-3d`).
- No secrets committed, no analytics SDKs.
- Fewer dependencies over a zoo of libraries.
- Every feature has a keyboard path (see KEYBOARD.md).
- 60 fps on a mid laptop at 1,000 nodes / 2,500 edges: instanced meshes, one draw call per primitive type.
- If a library fights the product, write the piece.

## 2. Stack

Electron 44 (desktop shell, folder picker, chokidar) · Vite 8 + React 19 + TypeScript · Zustand · Tailwind v4 + CSS tokens · three + @react-three/fiber + drei · d3-force-3d in a worker · postprocessing bloom (selective) · unified/remark-parse/remark-gfm + js-yaml + custom wikilink tokenizer · react-markdown preview with wikilink rendering · MiniSearch · pnpm, Node 22+.

Deferred (not MVP): SQLite FTS, AI embeddings / chat, WebXR.

## 3. Repo layout

```
apps/desktop   Electron main + preload + renderer
apps/web       same renderer, demo vault, no Electron
packages/core  vault parse, graph build, search index, types, adapters
packages/graph R3F scene, worker, materials, camera, interactions
packages/ui    HUD, inspector, command palette, editor, capture, review
vault-demo     60 richly linked starter notes
docs           SPEC.md, KEYBOARD.md
```

## 4. Data model (`packages/core/src/types.ts`)

```ts
type NoteId = string // stable: relative path without .md, posix
type NoteType = 'note' | 'daily' | 'person' | 'project' | 'area' | 'resource' | 'inbox' | 'concept' | 'moc'
type Area = 'inbox' | 'projects' | 'areas' | 'resources' | 'archive' | 'untagged'

interface NoteMeta {
  id: NoteId; title: string; path: string; folder: string
  area: Area; type: NoteType; tags: string[]
  created: string | null; updated: string | null; status: string | null
  wordCount: number; headings: { depth; text; slug }[]; aliases: string[]
}

interface Link { from: NoteId; to: NoteId; raw: string; kind: 'wikilink' | 'embed' | 'tag'; heading?; alias?; resolved: boolean; offset: number }
```

Derived: `title` = frontmatter.title → first H1 → filename. `area` = frontmatter.area → top folder (PARA names, numeric prefixes tolerated) → `untagged`. `type` = frontmatter.type → nearest folder (`Daily`, `People`, `Maps`, …) → `daily` if the filename is a date → `inbox` if in the inbox → `note`.

Link resolution order: exact path/id → title → alias → filename (unique, else shortest path). Unresolved targets become **ghost** nodes (`ghost:<target>`) so missing notes are visible and creatable.

Graph (`buildGraph`): nodes (notes + ghosts, deterministic order), weighted edges collapsed per (from, to, kind), backlinks/outlinks maps, orphans, tag and area counts.

## 5. Views

`graph | editor | capture | search | review` — a tiny state machine in the store, not routes. The graph is always mounted; the other views float over or beside it.

- **Graph**: instanced neurons + halos, filament synapses with travelling pulses on the focus, starfield + nebula, selective bloom, label overlay, screen-space picking, drag-to-pin, fit-to-graph camera, constellation (area clusters) and orbit (age rings) layouts, color by area / type / tag / age, tag field sphere.
- **Editor**: raw markdown + live preview (split / edit / preview), `[[` autocomplete, autosave (900 ms) + `⌘S`, rename via title, `updated:` touched on save.
- **Capture**: one box → `Inbox/<title>.md` with frontmatter (`type: inbox`, `status: unprocessed`).
- **Search**: palette over title / aliases / headings / tags / body / path; `>` for commands; `⌘Enter` converts a query to a graph filter; `is:orphan`, `is:stale` pseudo-queries.
- **Review**: queue = unprocessed inbox → orphans → spaced-review due → stale (>90 days). Actions move files between PARA folders and patch frontmatter; review intervals live in localStorage.
- **Projects**: board of every project note (`type: project` or in `Projects/`) with progress from its markdown task list. Ticking writes `- [x] … ✅ YYYY-MM-DD` in place (Obsidian Tasks convention); adding appends under `## To do`; "New project" scaffolds `Projects/<name>.md`. The note is the memory — no side database.

## 6. Vault adapters

`VaultAdapter { list, read, write, remove, rename, watch }` implemented by `MemoryVaultAdapter` (demo + tests), `FsAccessVaultAdapter` (browser folder, polling), `ElectronVaultAdapter` (IPC to a path-jailed main process with chokidar, 250 ms debounce, self-write echo suppression, atomic writes).
