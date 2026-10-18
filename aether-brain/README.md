# Aether Brain

**A local-first 3D second brain.** Your notes are neurons. `[[Wikilinks]]` are synapses. Folders are constellations, tags are colored fields, and time is an orbital layer. Capture, edit, search and review all happen inside — or beside — a navigable thought-space rendered in WebGL.

Markdown files on disk are the only source of truth. No account, no cloud, no telemetry. Delete the app and your vault is still a folder of `.md` files that Obsidian, iA Writer or `grep` can read.

```
pnpm install
pnpm dev            # browser build with the bundled demo vault → http://localhost:5173
pnpm dev:desktop    # Electron: pick any folder of markdown on your disk
```

## Desktop app (.exe / .dmg / .AppImage)

Two ways to get a double-clickable build:

1. **Download a Release** — the [Releases page](https://github.com/YEASTINFECTIONCHEESE/desktop-tutorial/releases) has `AetherBrain-Setup-<version>-x64.exe` (installer with Start-menu + desktop shortcuts), `AetherBrain-Portable-<version>-x64.exe` (single file, no install — just run it), plus macOS `.dmg` and Linux `.AppImage`/`.deb`. To cut a new one: *Actions* → *Desktop builds* → *Run workflow*, type the tag (e.g. `v0.2.0`) in the `tag` box; CI tags `main`, builds all platforms and publishes the Release. Leaving `tag` empty just builds and uploads run artifacts. Every pull request also builds the Windows exe as an `aether-brain-windows` artifact.
2. **Build it yourself** on the target OS:

```
pnpm install
pnpm --filter @aether/desktop dist:win     # → apps/desktop/release/*.exe   (Windows)
pnpm --filter @aether/desktop dist:mac     # → apps/desktop/release/*.dmg   (macOS)
pnpm --filter @aether/desktop dist:linux   # → apps/desktop/release/*.AppImage, *.deb
```

Build on the OS you are targeting: Windows installers need `wine` when built from Linux/macOS (the CI workflow uses a Windows runner, so it never hits this), and macOS builds only run on macOS.

Builds are unsigned, so Windows SmartScreen will show "Windows protected your PC" the first time — click *More info → Run anyway*.

### Slow to start?

- **Use the installer for a shortcut.** The Portable exe unpacks the whole app into a temp folder on every launch (10–30 s). `AetherBrain-Setup-*.exe` installs once and its Start-menu / desktop shortcut launches directly.
- **Point it at your notes folder, not a whole project.** On launch the app re-opens the last vault and reads every markdown file under it. Build/engine folders (`node_modules`, `Intermediate`, `Saved`, `DerivedDataCache`, `Binaries`, `Library`, `dist`, …) are skipped automatically, but a folder with tens of thousands of other files still takes time to scan. Pick the folder that holds the notes (e.g. `F:\Lunco\Notes`), or start it with `AetherBrain.exe D:\notes`.
- The window now appears immediately with a progress bar (folders scanned → notes read → parsed → graph built), so you can see what it is doing. The app never talks to the network; it only reads and writes the vault folder you pick. On first launch it asks for a folder (or opens the bundled demo vault); it remembers your choice, and `AetherBrain.exe C:\path\to\notes` opens a vault directly.

## What it does

| Loop step    | How                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Capture**  | `c` opens a one-box capture. First line becomes the title; it lands in `Inbox/` as a real file with frontmatter.                  |
| **Organize** | Review view (`r`) walks the inbox: `p` / `a` / `s` moves a note to Projects / Areas / Resources, `3` archives. Frontmatter updated. |
| **Connect**  | Editor with `[[` autocomplete, live preview, backlinks, and _unlinked mentions_ with a one-click "link it". Ghost neurons for links whose target doesn't exist yet — select one to create it. |
| **Retrieve** | `⌘/Ctrl K` searches titles, headings, tags, body and paths (MiniSearch, fuzzy + prefix). `⌘Enter` turns the query into a graph filter that dims everything else. |
| **Review**   | Orphans, stale notes (90+ days) and spaced-review items resurface in the queue. `1` keeps a note (interval doubles), `2` snoozes, `3` archives. |
| **Projects** | `p` opens the board: one card per project with a progress bar and its to-do list. Everything is editable — rename (`e`), status (`s`), summary, tags, archive, delete; tasks can be ticked, edited, reordered (`Alt ↑/↓`) and deleted (with undo). Each project has a **home folder** (its star) whose subfolders are its **planets**: add one (`f`) and a real folder is created on disk. Tasks are plain `- [ ] …` / `- [x] … ✅ 2026-09-24` lines, so Obsidian and git see the same memory. |
| **Today**    | `y` flies to the glowing **Today hub** above the sun: one brief of today's to-dos from every note — overdue and due-today tasks (`📅 2026-10-01`, `[due:: …]`, `@due(…)`), scheduled ones (`⏳ …`), anything tagged `#today`, today's daily note — plus the next task of every active project. Tick them right there (`Tab` into the list, `Space` ticks, `u` undoes). Nothing is copied: each task stays in its own note. |
| **Pictures** | Concept art and references in your folders orbit them as **picture moons**: framed thumbnails of each folder's newest images (png, jpg, webp, gif, bmp, avif). **Videos** (mp4, m4v, mov, webm) join them as a still frame with a ▶ badge; they never play in the brain. **3D models** (glb) join them as a lit still the app draws itself (textures are not shown, only each material's colour); `e` opens one in your 3D app, and they never go on a reference board. Make them **large or extra large icons** like Windows Explorer with `z` (or the M · L · XL buttons in the legend); orbits widen so they never overlap. Select one for a preview, `e` opens it in your image app (a video: your video player), and `![[gate.png]]` embeds link notes to their pictures. Drop picture files on the window (or *Import pictures…*) to copy them into the selected folder. Fly close to a project's ★ star and **every** picture of the project, subfolders included, blooms out of it as a **3D gallery**: framed cards on a slowly turning sphere around the star, newest at the top; pull back and they fold away (`⇧ G` opens or folds it from anywhere). |
| **Critique** | `g` opens your own **Concept Forge** (`concept-forge.html`) inside the desktop app. Its **🪐 Save to Brain** button (`Ctrl+Shift+B`) files the drawing and its grade into the project's **Critique** planet: a PNG plus a critique note with the scores and fixes, and the top fix becomes tomorrow's practice task on the Today hub. Its project's ★ star carries a **live screen** of the page: fly up to the star and Concept Forge grows out of it, exactly as its window looks; `Enter` opens it to draw, and the screen mirrors what you draw. See [docs/FORGE-LINK.md](docs/FORGE-LINK.md). |
| **Wander**   | Drag to orbit, scroll to zoom, click to select, double-click to open (or expand a folder), drag a neuron to move it. `Tab` hops between neighbors. `t` cycles the layouts: **constellation** (by area) → **orbit** (rings are age) → **system** (your folders as solar systems). `m` cycles color by area / type / tag / age. |
| **AI chats** | Bring your whole Claude and ChatGPT history in: press `i` (or drop the export `.zip` on the window) and every chat becomes a searchable note, Claude projects become planets with their instructions and knowledge, and ChatGPT's pictures become picture moons. Re-import any time; only new or longer chats change. Or say *"save this chat to my brain"* over the AI link. See [docs/AI-CHATS.md](docs/AI-CHATS.md). |
| **Ask your AI** | Claude and ChatGPT can search, read and write the vault directly through the built-in MCP server — see [AI link](#ai-link-claude--chatgpt). They can also send it ideas (`capture`) and **pictures** (`save_image`: a screenshot Claude made, an image you attached in ChatGPT, a small picture as base64), which land in Inbox/Pictures with a note that shows them; see [Sending pictures and ideas](docs/AI-LINK.md#sending-pictures-and-ideas). |
| **Librarian** | Press `⇧ L` and every picture on a drive (`D:\`) is copied into one library (`F:\MASTERIMAGES`), sorted by type, genre and year and tagged by colour mood, with an offline vision model (CLIP, downloaded once) that sees concept art from photos and sci-fi from fantasy. You see the plan first; originals are never touched; duplicates are copied once. The library becomes a ★ star in the brain. See [docs/LIBRARIAN.md](docs/LIBRARIAN.md). |
| **Find projects** | Press `⇧ P` and the brain looks through your folders for your projects (Unreal, Unity and Godot projects, git repositories, folders of Blender, ZBrush or Photoshop files) and makes the ones you tick ★ stars in one go. Finding writes nothing; each star is one note in its folder. A brain with one star offers it when it opens. |
| **Reference boards** | Press `8` for the Boards view (or `⇧ B` to open the last board): a PureRef-style board where you drop, paste or pick pictures, arrange them (grid, columns, rows, pile and more), move, scale, rotate, crop, flip, grey, caption and group them, add text notes and draw on the board with a pen, lines, boxes and ellipses, and zoom far in and out. A board is one markdown note that the brain links to its pictures and search finds (the words on its notes and captions too); your pictures are never changed. In the 3D brain a board with pictures on it is a **sun**: a bright star of its own, and the pictures on it orbit it instead of their folders. On the desktop `w` opens the board in a floating always-on-top window with adjustable opacity, so you can keep it beside your painting program. See [docs/REFERENCE-BOARD.md](docs/REFERENCE-BOARD.md). |
| **Unreal Engine** | The **Unreal companion** (`unreal/`, an Unreal Engine 5.8 project you build once) draws your brain live with Unreal's bloom: the same suns, stars and moons in the same places and colours, orbits turning, and a living space around it: layers of stars, nebulae and far galaxies that slide against each other as you fly (parallax), asteroids going round and zooming through, shooting stars and alien ships (`B` cycles it). Fly with the mouse and WASD; a click there selects and flies here too, a double-click opens the note here. Switch the companion link on in `a`; it stays on this computer (127.0.0.1) and sees titles, colours and positions only. See [docs/UNREAL.md](docs/UNREAL.md). |
| **Chat in the brain** | Press `q` and talk to your brain right inside it (Claude with your own API key, or a local Ollama model). It reads your notes, checks in on how you are, and remembers what you tell it to in your own `Me/` notes; answers link to notes that fly in 3D. *Plan my day* (in the palette) plans the day with it, and a quiet card offers that, a check-in and a wrap-up in the morning, afternoon and evening (no sound, no counts; off in ⚙). See [docs/BRAIN-CHAT.md](docs/BRAIN-CHAT.md). |

## The 3D view

- One `InstancedMesh` for neuron cores (fresnel shader, HDR output), one for additive halos, one `LineSegments` for every synapse with travelling pulses on the selected node's edges. A 2D canvas overlay draws crisp labels for hubs, the selection and its neighborhood.
- Layout runs in a **Web Worker**: `d3-force-3d` clusters by PARA area in constellation mode and makes radial rings by age in orbit mode. The **system** layout (the default) is analytic: every drive is a ◉ galaxy, every folder is a ★ star (a project's home folder the biggest), big pictures, videos and long notes are ● planets drawn as extra-large thumbnails, and small files are · moons orbiting their folder. A faster orbit and a brighter star mean more urgent, from the open tasks in your notes. Bodies slowly orbit (`o` pauses, `⇧ O` is calm mode: no orbit runs faster than a normal one), faint rings trace each orbit, `[` / `]` change how deep folders unfold, `x` expands a collapsed folder. The main thread only copies a `Float32Array` per frame.
- The **Today hub** hangs still above the vault's sun, a cyan beacon with a beam to every note holding one of today's tasks (`☀ Today · 5 · 1 late`). **Picture moons** draw their thumbnails from one texture array (256 × 128² layers, filled for the pictures nearest the camera, decoded off the main thread) through one instanced billboard mesh. A video's thumbnail is one still frame: on desktop taken by the same off-main helper from a stream of the file served to it for that one job (a 4 GB timelapse is never read whole), in the web app by a `<video>` element in the page (three at a time, each kept per file version). A **star gallery** puts a project's pictures and videos on a Fibonacci sphere just outside the star's system (sized so cards never touch, moving nothing else), grows them out of the star once the camera settles within about 2.5 system radii, looking at it, and folds them past 3.4; cards the camera is about to pass fade so you can look through.
- Selective bloom (`postprocessing`) with a luminance threshold: only the neurons bloom, never the UI, edges or stars.
- 1,000 neurons / 2,500 synapses is the design budget: `http://localhost:5173/?stress=1000` opens a synthetic vault; the top bar shows live fps.

## Vaults

| Where                | Adapter                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Desktop app          | `ElectronVaultAdapter` — one or more folders on disk via IPC; a native recursive file watcher streams debounced changes (new folders become planets live); writes are atomic. **Whole drives work**: press `v` (Vault folders) and tick `D:\` and `F:\` — each root becomes a top-level system and the brain mirrors its real directory tree. System, build and cache folders (`Windows`, `Program Files`, `AppData`, `$RECYCLE.BIN`, `node_modules`, `Intermediate`, `Saved`, `DerivedDataCache`, …) are skipped, and so are game libraries (Steam, Epic, Xbox, GOG …) and any folder that holds an installed game or program. You can add your own names, and `⇧ H` leaves the selected folder out at once (bring it back in `v`). `AetherBrain.exe D:\ F:\` or `AETHER_VAULT` opens roots directly. |
| Browser (Chromium)   | `FsAccessVaultAdapter` — File System Access API, polls mtimes for external edits.                        |
| Browser (any)        | Bundled demo vault; edits persist in IndexedDB, "Reset demo vault" forgets them.                          |

Folder → area mapping is PARA: `Inbox/`, `Projects/`, `Areas/`, `Resources/`, `Archive/`; everything else is _untagged_. Note type comes from `type:` frontmatter or the nearest folder name (`Daily/`, `People/`, `Maps/` …). See [docs/SPEC.md](docs/SPEC.md) for the data model and [docs/KEYBOARD.md](docs/KEYBOARD.md) for every key.

## AI link (Claude + ChatGPT)

The desktop app ships an [MCP](https://modelcontextprotocol.io) server, so your AI assistant can work with the brain directly: search and read notes, list projects and their to-dos, add or tick tasks, write notes, capture ideas, and create planet folders. Changes appear live in the 3D view.

- **Claude Desktop** — install `aether-brain-<version>.mcpb` from the Releases page (double-click it, or Settings → Extensions → Install Extension) and pick your folders or drives. Or press `a` in the app and paste the generated config.
- **Claude Code** — press `a` in the app and copy the `claude mcp add …` command.
- **The Claude plugin** (Claude Code, and the Code tab of Claude Desktop) — `/plugin marketplace add YEASTINFECTIONCHEESE/desktop-tutorial`, then `/plugin install aether-brain@aether-brain`, with the app open and its link on. Claude then works in the *live* brain: it can send in a screenshot or picture file you name (`save_image`), **look at your pictures** (`find_pictures`, `get_image`) and **fly your 3D view** to a note, folder or picture (`show_in_brain`). See [The Claude plugin](docs/AI-LINK.md#the-claude-plugin).
- **ChatGPT** (and claude.ai on the web) — press `a`, switch the link on, expose it with a tunnel (`cloudflared tunnel --url http://127.0.0.1:7457`), and add the `https://…/mcp/<token>` URL as a developer-mode app / custom connector.

Ask it "what's on today?": the `daily_brief` tool returns the same brief as the Today hub. The AI can only touch markdown notes and folders inside your vault roots, never deletes files, and can be set to read-only. Full guide, tool list and security notes: [docs/AI-LINK.md](docs/AI-LINK.md).

## Repo

```
apps/web · apps/desktop · packages/core · packages/graph · packages/ui · vault-demo · docs
```

pnpm workspace, Vite 8, React 19, TypeScript strict, three + @react-three/fiber + drei, d3-force-3d, MiniSearch, unified/remark, Zustand, Tailwind v4, Electron 44, `@modelcontextprotocol/sdk` and `@anthropic-ai/sdk` (bundled into the MCP server, which also runs the brain's chat). Tests: `pnpm test` (vitest: core parsing/graph/folders/projects, the system layout, the store, the file layer and watcher, the MCP tools). Type checks: `pnpm typecheck`. Design notes: [docs/design/solar-system-and-ai-link.md](docs/design/solar-system-and-ai-link.md) (folder solar systems, the AI link) and [docs/design/today-images-forge.md](docs/design/today-images-forge.md) (the Today hub, picture moons, the Concept Forge link). The demo pictures are generated by `node scripts/demo-images.mjs`.

## Status

Working, early. Not yet: SQLite FTS for very large vaults, AI embeddings, WebXR, code-signed installers.
