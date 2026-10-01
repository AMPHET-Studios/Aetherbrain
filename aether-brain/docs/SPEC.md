# Aether Brain — product spec (trimmed working copy)

## 0. Product definition

Aether Brain is a personal knowledge operating system whose primary interface is a navigable 3D thought-space, not a file tree.

- A note is a neuron.
- A `[[wikilink]]` is a synapse.
- A folder / PARA area is a cluster / constellation.
- A tag is a colored field.
- Time is an orbital layer.
- In the **system layout** the folder tree is a set of solar systems: the vault (or each drive) is a sun, a project's home folder is a star, folders are planets, notes are moons.
- Capture, edit, search and wander all happen inside or beside that space.
- Claude and ChatGPT can talk to the brain directly through a local MCP server (the **AI link**).

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

Electron 44 (desktop shell, folder picker, native recursive `fs.watch`) · Vite 8 + React 19 + TypeScript · Zustand · Tailwind v4 + CSS tokens · three + @react-three/fiber + drei · d3-force-3d in a worker · postprocessing bloom (selective) · unified/remark-parse/remark-gfm + js-yaml + custom wikilink tokenizer · react-markdown preview with wikilink rendering · MiniSearch · pnpm, Node 22+.

AI link: `@modelcontextprotocol/sdk` + zod, bundled into one ES module (`dist/mcp/aether-mcp.mjs`) that the app runs in-process (HTTP) and Claude Desktop runs over stdio.

Deferred (not MVP): SQLite FTS, AI embeddings / chat inside the app, WebXR.

## 3. Repo layout

```
apps/desktop   Electron main (FsVault + VaultWatcher, AI link) + MCP server (src/mcp) + preload + renderer (vault folders & AI link panels)
apps/web       same renderer, demo vault, no Electron
packages/core  vault parse, graph build (with folder systems), search index, types, adapters, projects & tasks
packages/graph R3F scene, worker (force layouts + the analytic system layout), materials, camera, interactions
packages/ui    store, HUD, inspector, command palette, editor, capture, review, projects board, extension points
vault-demo     70 richly linked starter notes (two projects with planet folders: PORTALz, ConceptForge)
docs           SPEC.md, KEYBOARD.md, AI-LINK.md, design/
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

Graph (`buildGraph`): nodes (notes + ghosts, deterministic order), weighted edges collapsed per (from, to, kind), backlinks/outlinks maps, orphans, tag and area counts. Every node has a `kind` (`note` · `ghost` · `folder` · `image` · `today`) and a structural `parent`.

**Pictures** (`vault/assets.ts`): png, jpg, jpeg, webp, gif, bmp and avif files are the vault's pictures (SVG is left out: it can carry scripts). `![[gate.png]]` and `[[gate.png]]` resolve Obsidian-style (exact path → path relative to the note → nearest file of that name) to `image:<path>` nodes with an edge from the note; a picture link that resolves to nothing stays unresolved and never becomes a ghost. In the system layout each shown folder also gets its newest pictures as moons (24 per folder, linked ones included; 1,500 picture nodes at most), and folder nodes count `images` / `shownImages`.

**Tasks and the daily brief** (`markdown/tasks.ts`, `markdown/brief.ts`): a task may carry a due date (`📅 2026-10-01`, `🗓 …`, `[due:: …]`, `@due(…)`, `due:…`), a scheduled date (`⏳ …`, `[scheduled:: …]`) and inline `#tags`. `dailyBrief` gathers every open task that is overdue, due today, scheduled for today or earlier, in today's daily note, or tagged `#today` (Archive excluded; each task once), plus the first open task of every active project with nothing above ("next up"). It is derived and never written. With `today: { brief }` the graph gets one **Today hub** (`today:`), appended last, whose beams (`EdgeKind 'today'`) go to the notes of the brief; the beams are the hub's outlinks only, never a note's backlinks.

**Critiques** (`markdown/critique.ts`): a graded drawing is a PNG plus a note next to it: `critiqueNote` writes `![[<file>.png]]`, the grade as text and as Dataview inline fields (`grade:: B+`, `score:: 82`), a scores table, the fixes as tasks (the first one due tomorrow when asked: tomorrow's brief), what's working, and the deep critique quoted. No new frontmatter keys; tags `critique`, `concept-forge`, `drill/<name>`. `normalizeGrade` reads grade objects of any common shape.

Built with folders (`buildGraph(notes, { folders })`, the system layout only), the graph also gets one node per visible folder (`folder:<path>`, the root is `folder:`), appended after the ghosts. `selectFolders` picks them: the root, every drive (mount) of a multi-root vault, every folder that holds notes, project folders, the children of expanded folders, then a breadth-first sweep down to the depth limit (default 3) up to 1,500 optional folders — a whole drive can hold hundreds of thousands. Folder roles: `root` (the vault), `mount` (a drive such as `D:\`), `project` (a folder bound to a project note: a star), `folder` (a planet). Parents: folder → nearest visible ancestor; note → its project's folder when it is the project note, else its nearest visible folder; ghost → the first note linking to it. Folder nodes add no edges, backlinks, tag or area counts.

**Projects** (`markdown/projects.ts`): a project is a note with `type: project`, a note directly in a Projects folder (`Projects/X.md`, `D/Projects/X.md`), or the folder note of a direct child (`Projects/X/X.md`) — never a note in Archive, never an ordinary note deeper inside a project folder (`isProjectNote`; `meta.type` says `project` for everything under Projects and is not the test). Its home folder (`projectFolderOf`): frontmatter `folder:` → the folder it is the folder note of → a same-named sibling folder (`Projects/PORTALz.md` + `Projects/PORTALz/`). `setProjectFields` rewrites title (old title kept in `aliases`), status, summary (the `>` line under the H1), tags and folder, leaving the rest of the file byte-identical, and refuses frontmatter whose YAML does not parse. Tasks are edited, deleted and moved in place (`editTask`, `deleteTask`, `moveTask`).

**Multi-root vaults**: a vault can span several folders or whole drives. With more than one root every vault path starts with the root's mount (`D/Projects/x.md` is `D:\Projects\x.md`); with one root paths are relative to it, as before. New notes (capture, daily, ghosts, projects) go under the first root (`homePrefix`); moving a note to a PARA area keeps it on its own drive.

## 5. Views

`graph | editor | capture | search | review | projects` — a tiny state machine in the store, not routes. The graph is always mounted; the other views float over or beside it.

- **Graph**: instanced neurons + halos, filament synapses with travelling pulses on the focus, starfield + nebula, selective bloom, label overlay, screen-space picking, drag-to-pin, fit-to-graph camera, color by area / type / tag / age, tag field sphere. Three layouts (`t` cycles): **constellation** (force layout clustered by area), **orbit** (force layout, age as rings) and **system** (the default): the folder tree laid out analytically as nested solar systems — no physics; children orbit their parent on tilted rings (many leaf moons form a sphere shell), planets keep moving while orbit motion is on (`o`) and the camera follows the selected one. Stars (project folders) and suns (the vault, drives) bloom; planets take a stable colour from their path; orbit rings are drawn for every system, brighter around the selection. Depth `[` `]`, expand `x`, double-click a folder to expand it. Only system graphs carry folder nodes: switching layout, depth or expansion rebuilds the graph, and folder changes on disk arrive live (`addDir` / `unlinkDir`).
- **Folder inspector**: a selected folder shows its role, path, note, folder and picture counts, its planets, moons and pictures, and actions — new note / new folder here, import pictures, make it a project (writes its folder note) or open its board, expand / collapse, reveal on disk (desktop).
- **Today** (`y` · `7`, the ☀ chip): selects the hub; the inspector lists Overdue / Today / Next up with a tick box per task (writes `✅` into the task's own note; `u` undoes), the project chip (flies to its star) and the note. A picture moon shows the picture framed; picture thumbnails come from the adapter (`thumbnail(path, size)`), the 256 nearest on screen, in one texture array.
- **Star galleries** (system layout): when the camera and the point it looks at both come within 2.6 system radii of a project star (measured where the camera is headed, once it has stayed there 0.3 s and not during the first framing flight; of several, the star looked at most closely; hysteresis: it folds past 3.4, and another star takes over only when it is looked at 15 % more closely), the store rebuilds the graph with `images.gallery = <star folder>`: every picture under the folder, subfolders included, newest first, becomes a card (`ImageNodeInfo.gallery`; moons and linked pictures keep their node and orbit slot, the rest come in parented to the star, at most 480). The layout puts the cards on an upright Fibonacci sphere around the star, just clear of its system, taking no room in any system, so nothing else moves; the worker sends each card's size with the rings. Cards grow out of the star (0.9 s) and shrink back before the graph lets them go (0.42 s); a card wider than 40 % of the view fades out and lets clicks through (unless selected). `⇧ G` opens the gallery of the selection's star (else the nearest) and flies there, or folds the open one (it then stays shut until the camera leaves that star); *Toggle star galleries* (palette) turns the fly-close opening off. The folder inspector of a star has *Gallery · N* / *Fold gallery*.
- **Picture inspector**: preview (a video: its still, with a ▶ badge), folder, size, date, open in the OS image app or video player (`e`, desktop), reveal, copy the `![[embed]]`, and the notes that embed it.
- **Videos** (mp4, m4v, mov, webm; no Ogg Theora, which Chromium does not decode) are media like pictures (`isMediaPath`: listed, watched, linked with `![[clip.mp4]]`, moons, gallery cards; `ImageNodeInfo.video`), shown as one still frame — a tenth of the way in, at most 5 s — with a ▶ badge (the card shader, the inspector, note embeds), never played in the brain; `e` plays one in the OS player (desktop: `openAsset` checks the file starts like a video). Desktop: main reads only a video's first bytes (its signature: ISO BMFF with a real box after any filler box, fragmented MP4, Matroska, and MPEG-TS, which only the OS player plays) and hands the thumbnail helper a one-job address (`aether-video://clip/<token>`, a privileged streamable scheme served on the helper's session from that file in byte ranges, CORS-readable, 404 once the job ends, when any stream still open ends too); the helper's media player seeks and draws the frame. The watcher reports a known video that is still being written (recorded, copied in) once it has been left alone for 4 s, not on every write. Browser adapters hand the video itself to the store, which takes the still (`stillOf` / `videoStill`: three at a time, kept per path, size and file version). A still that comes out see-through (`seeked` a moment before the frame can be drawn) is drawn again, then kept when the video has its frame (a transparent background). Imports stay pictures only. Pictures dropped on the window (or picked with *Import pictures…*) are copied into the selected folder, the selected project's Critique planet, or the Inbox — create-only.
- **Editor**: raw markdown + live preview (split / edit / preview), `[[` autocomplete, autosave (900 ms) + `⌘S`, rename via title, `updated:` touched on save.
- **Capture**: one box → `Inbox/<title>.md` with frontmatter (`type: inbox`, `status: unprocessed`).
- **Search**: palette over title / aliases / headings / tags / body / path; `>` for commands; `⌘Enter` converts a query to a graph filter; `is:orphan`, `is:stale` pseudo-queries.
- **Review**: queue = unprocessed inbox → orphans → spaced-review due → stale (>90 days). Actions move files between PARA folders and patch frontmatter; review intervals live in localStorage.
- **Projects**: board of every project note (`isProjectNote`) with progress from its markdown task list. Everything is editable in place and written straight back into the note: the name (`e`; the file follows — `Projects/Old.md` → `Projects/New.md` unless it is a folder note — and the old name stays an alias), status (select, `s` cycles active → paused → done → someday), tags, and summary; the **home folder** row shows the project's star folder with *Show in space*, *Change…* (searchable folder picker, writes `folder:`), *Unlink*, or *Create folder* / *Link existing…*; the **planets** are its subfolders with note counts, and *Add folder* (`f`) creates `<home>/<name>` on disk (the home folder first when needed). Tasks: tick (`- [x] … ✅ YYYY-MM-DD`, Obsidian Tasks convention), add under `## To do`, edit (✎, double-click, `Enter`), move (`Alt ↑↓`, ▲▼), delete (✕ / `Del`, with Undo). *Archive* moves the note to `Archive/`, *Delete…* asks first; a project's folder always stays on disk. "New project" scaffolds `Projects/<name>.md`. The note is the memory — no side database.

## 6. Vault adapters

`VaultAdapter { list, read, write, create?, remove, rename, watch, roots?, listFolders?, createFolder?, reveal?, listAssets?, thumbnail?, createAsset?, openAsset? }` implemented by `MemoryVaultAdapter` (demo + tests; the demo keeps edits and folders made in the app in IndexedDB), `FsAccessVaultAdapter` (browser folder, polling for files and folders), `ElectronVaultAdapter` (IPC to a path-jailed main process: `FsVault` scans one or more roots breadth-first — hidden, system and heavy folders such as `Windows`, `Program Files`, `node_modules`, `.git` skipped, and so are game libraries and folders that hold an installed game or program (`installs.ts`: store and engine marker files, uninstallers, an `.exe` with its DLLs; `keep` shows one anyway) and folders the user left out (`hidden`, absolute paths; `⇧ H`, applied live: the watcher unlinks what was shown and walks a folder let back in) — and writes atomically; `VaultWatcher` uses native recursive `fs.watch` per root with a 250 ms debounce and self-write echo suppression, and reports folders as `addDir` / `unlinkDir`). The desktop app can open several folders or whole drives at once (vault folders panel, `v`).

## 7. AI link (desktop)

Claude and ChatGPT talk to the brain directly through a local MCP server (`apps/desktop/src/mcp`): search and fetch (the ChatGPT connector convention), overview, read notes with backlinks and tasks, list folders as a tree, projects and their planets, related and recent notes, and — unless the link is read-only — create notes, append, edit, update frontmatter, capture, tasks, projects and folders. No tool deletes a note; every write goes through the same path-jailed `FsVault` and only writes `.md` notes. Claude Desktop runs it over stdio (a one-click `.mcpb` bundle); ChatGPT and claude.ai reach the in-app HTTP link (`127.0.0.1` only, secret token in the URL or a Bearer header) through a tunnel. AI edits show up live as toasts and the camera flies to what was touched. Panel: `a`. Setup: [AI-LINK.md](AI-LINK.md).

## 8. Concept Forge link (desktop)

`g` opens the user's own `concept-forge.html` (picked once, remembered) in a window of its own session (`persist:forge`, so the page's own online features keep working while the brain stays offline). A preload exposes only `window.aetherForge` (`projects()`, `save()`) and injects a **🪐 Save to Brain** button (`Ctrl+Shift+B`) in a closed shadow root: it captures the drawing canvas (overlays left out), reads the page's grade (`lastGrade`, or its grade history in localStorage), and asks for the project and title. Main validates the save (PNG signature, 40 MB, JSON-safe grade ≤ 256 KB) and relays it to the brain window, whose store writes the PNG and the critique note create-only into `<project home>/Critique/`. Setup and details: [FORGE-LINK.md](FORGE-LINK.md).

## 9. AI chats (web + desktop)

`i` (or dropping a `.zip` / `.json`, or the palette) imports Claude's and ChatGPT's data exports (`packages/core/src/chats`): a small zip reader (stored, deflate via `DecompressionStream`, zip64; entries read on demand from the `File`), readers for Claude's `conversations.json` + `projects.json` / `projects/*.json` (the kept branch, text, artifacts, attachment text) and ChatGPT's message trees (`current_node` to the root; generated pictures and their prompts, canvases; hidden, system and tool messages dropped), and `planChatImport`: one note per chat under `<home>Resources/AI Chats/<Claude|ChatGPT>/` (else `<home>AI Chats/`), a hub + `Knowledge/` notes per Claude project (into `<project home>/AI Chats/` when an Aether project has its name), ChatGPT pictures into `Pictures/` next to their chat. Notes use standard frontmatter only; a `Source: <https://claude.ai/chat/…>` line is the note's identity on re-import (found anywhere in the vault), and only the `## Transcript` section of a chat that grew is rewritten. Chat text is written inert: `[[`, `#tag` and task checkboxes are backslash-escaped where the brain would read them (links and tags are read from the markdown source, so escapes hold), HTML block openers that would swallow the note are escaped, open fences are closed. The store writes it as one batch (create-only notes and pictures, `rewriteNote` for transcripts), after a confirmation. The AI link's `save_chat` writes the same format live. Guide: [AI-CHATS.md](AI-CHATS.md).
