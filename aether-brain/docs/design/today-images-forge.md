# Design: the Today hub, image moons, and the Concept Forge link (v0.4)

Status: contract for v0.4. Interface files that are part of the contract (already
written; do not change their shapes without updating this doc):
`packages/core/src/types.ts`, `apps/desktop/src/shared/ipc.ts`,
`packages/graph/src/layout/protocol.ts`. The core pieces below are **already
implemented and tested** (`packages/core/test/v04.test.ts`); build on them.

## What the user asked for

1. **A daily brief planet**: one glowing hub that collects today's to-dos from
   every project.
2. **Image thumbnails as moons**: concept art in the project folders (PORTALz/Art…)
   shows up in the solar system as picture moons.
3. **A Concept Forge link**: drawings graded in Concept Forge (the user's own
   single-file drawing trainer, `concept-forge.html`, not in this repo) save
   straight into a project's **Critique** planet.

The user is a concept artist on Windows with an XP-Pen tablet, opens D:\ and F:\
as vault roots, and is a visual learner: things should be obvious by looking.

## Invariants (unchanged from v0.3, restated)

- Markdown files and folders on disk stay the only source of truth. The brief is
  derived (nothing written). Critiques are a plain `.md` + `.png` pair.
- No new frontmatter keys: grades are Dataview inline fields in the body
  (`grade:: B+`, `score:: 82`). Tags: `critique`, `concept-forge`, `drill/<name>`.
- Create-only for new files (EEXIST → next name). Never overwrite.
- One draw call per thing. Thumbnails are ONE instanced mesh sampling ONE
  texture array. No per-image meshes, no per-image React components.
- The brain renderer makes no network requests. (The Forge window is the user's
  own page in its own session; see Forge.)
- Every UI action has a keyboard path, a palette command, and a cheatsheet row.
- TypeScript strict, `noUncheckedIndexedAccess`. Run the typecheck.

## Ids and kinds (core, done)

| Thing | Node id | `GraphNode.kind` | Extra field | Layout kind code |
|---|---|---|---|---|
| note | vault path without `.md` | `note` | | 0 |
| missing note | `ghost:<target>` | `ghost` | | 1 |
| folder | `folder:<path>` | `folder` | `folder` (+ `images`, `shownImages`) | 2 |
| Today hub | `today:` (`TODAY_ID`) | `today` | `today: TodayNodeInfo` | 3 |
| picture | `image:<path with ext>` | `image` | `image: ImageNodeInfo` | 4 |

Helpers (`@aether/core`): `isImagePath`, `imageKey`, `isImageId`, `imagePathOf`,
`TODAY_ID`, `isTodayId`, `isVirtualId` (folder / ghost / image / today: **any
code that takes a note id guards with `isVirtualId`**), `imageFileName`,
`imageBaseName`, `imageTitle`, `assetMap`, `AssetResolver`, `mimeOf`.

`EdgeKind = LinkKind | 'today'`: the hub's beams. They are outlinks of the hub
only; a note's backlinks never list the hub and it never un-orphans a note.

## Core (done)

- `TaskItem` gained `due`, `scheduled` (YYYY-MM-DD or null) and `tags`.
  Formats: `📅 date` / `🗓 date` (due), `⏳ date` (scheduled), `[due:: date]`,
  `(scheduled:: date)`, `@due(date)`, `due:date`. Linear-time parsing.
  `taskDates(text)`, `taskLabel(text)` (display text without date markers),
  `tasksOf(note)` (memoized per ParsedNote object).
- `dailyBrief(notes, { date?, folders?, maxNext?, maxPerSection? }) → DailyBrief`
  (`markdown/brief.ts`): sections `overdue`, `today` (reasons `due`,
  `scheduled`, `daily` = today's daily note, `flagged` = `#today`) and `next`
  (first open task of each active project with nothing above). Every
  `BriefTask` has `noteId, notePath, noteTitle, line, text, label, due,
  scheduled, reason, projectId, projectTitle, section`. `noteIds` are the hub's
  beams. `nextDay(date)`. `isActiveProject(note)`.
- `critiqueNote(input, imageFile, { date?, practiceDue? })`,
  `critiqueBaseName(title, date)` (`2026-09-30 Gesture Warm-Up`),
  `normalizeGrade(raw: unknown) → CritiqueGrade` (reads any grade object:
  `letter`/`grade`, `score`/`overall`, `breakdown`/`criteria`,
  `fixes`/`opportunities`, `strengths`, `deep`/`deepCritique`, one nested
  level), `cleanGrade`, `cleanScore`.
- `buildGraph(notes, { …, images?: { all, moons?, maxPerFolder? = 24, maxTotal? = 1500 }, today?: { brief } })`:
  - `![[gate.png]]` / `[[gate.png]]` resolve through `AssetResolver` (exact
    path, note-relative path, nearest file name) to `image:` nodes with
    edges; picture targets **never become ghosts** (with or without images).
  - With folders and `moons: true`, each shown folder gets its newest images
    (mtime desc) as moons, linked images counting toward the per-folder cap,
    shallow folders first until `maxTotal`. `FolderNodeInfo.images` = images
    directly in the folder on disk, `shownImages` = image nodes orbiting it.
  - `today: { brief }` appends the hub (last node), parent `folder:` in the
    system graph (else null), beams to `brief.noteIds`.
- `loadVault` calls `adapter.listAssets?.()`; `LoadedVault.assets`.
  `GraphOptionsFn(folders, notes, assets)`. `applyChanges(…, { assets })`
  returns `assets` (copy-on-write; image add/change/unlink, `unlinkDir` drops
  images below).
- `VaultAdapter` gained optional `listAssets`, `thumbnail(path, size) → Blob|null`,
  `createAsset(path, bytes)` (create-only, EEXIST), `openAsset(path)`.
  `VaultChange.size`. `MemoryVaultAdapter` implements the first three
  (`assets` option, `assetData(path)`; `thumbnail` returns the raw bytes).

## Part GRAPH — `packages/graph` (owner: graph agent)

Files: `layout/system.ts`, `layout/layout.worker.ts` (only if needed),
`layout/LayoutEngine.ts` (kind codes already mapped), `theme.ts`,
`BrainController.ts`, `scene/BrainScene.tsx`, `scene/materials.ts`, new
`scene/thumbs.ts`, `index.ts`, `test/*`.

1. **System layout: the hub hangs above the sun.** In `computeSystemLayout`,
   a node with kind 3 is not placed on its parent's rings. It sits still,
   straight above its parent (the root sun) at height
   `bodyRadius(parent) * FIRST_RING + 30`: `orbitRadius` = that, `speed` 0,
   `phase` π/2, `plane` = the quaternion rotating the XZ ring into the vertical
   (−90° about X: `(-√½, 0, 0, √½)`), no ring emitted. A kind-3 node with no
   parent attaches to the first root (never a second root). Its extent does
   not grow the parent's extent. Unit tests: position straight above the sun,
   never moves with `t`, no ring, other bodies unchanged vs. a graph without it.
   Images (kind 4) are leaf moons exactly like notes.
2. **Theme** (`theme.ts`, keep `styles.css` tokens in sync, the UI agent adds
   them): `TODAY_COLOR = '#8ff7ff'` (aurora cyan, distinct from gold stars),
   `IMAGE_COLOR = '#f4f1ff'`. `nodeBaseColor`: kind `today` → TODAY_COLOR,
   `image` → IMAGE_COLOR regardless of color mode. `nodeRadius`: today 4.6,
   image 1.4.
3. **BrainScene**:
   - The hub glows and breathes: glow ≈ 2.6 (+0.4 selected), a landmark
     (always labelled), label `☀ Today · N` (N = `today.total`, `☀ Today ✓`
     when 0), label color TODAY_COLOR; when `today.overdue > 0` the label
     reads `☀ Today · N · M late`. Beams (edges kind `today`) should read as
     light: in the system layout they must be visible (not the faint 0.12 base)
     at least while the hub is selected or hovered (it is: focus highlights).
   - Image nodes: label = file name, label color IMAGE_COLOR; solid core
     (like planets, `solid = 1`) with low glow so they don't bloom.
   - `role` array / landmarks: add the hub to landmarks.
4. **Thumbnails** (`scene/thumbs.ts` + a `Thumbs` piece inside `Brain`):
   - `BrainController.thumbnails: ThumbnailLoader | null` where
     `type ThumbnailLoader = (path: string, size: number) => Promise<Blob | null>`
     (the store sets it from `adapter.thumbnail`), and
     `BrainController.showThumbnails = true` (setter bumps `version`).
     Export `ThumbnailLoader` from the package index.
   - One `DataArrayTexture` of `THUMB_LAYERS = 256` layers × `THUMB_SIZE = 128`²
     RGBA, one instanced billboard mesh (PlaneGeometry, custom ShaderMaterial in
     `materials.ts`: camera-facing quad from per-instance `iCenter` (vec3,
     dynamic), `iSize`, `iLayer`, `iAlpha`; samples the array with v flipped;
     rounded-rect mask with a thin bright rim so a picture reads as a framed
     moon; fog-free; output below the bloom threshold). `frustumCulled = false`.
   - Every ~250 ms pick the image nodes worth a thumbnail: on screen (depth in
     −1..1), projected radius ≥ 5 px, biggest first, at most 256. Keep slots of
     images still wanted (LRU by last wanted time), evict the rest. Request
     missing ones through the loader, at most 6 in flight, never the same path
     twice at once, and remember failures (null / reject) per path for this
     graph so they are not retried every tick.
   - Decode off the main thread where possible: `createImageBitmap(blob)`,
     then draw cover-cropped (centred square) into a 128×128 canvas
     (`OffscreenCanvas` when available), `getImageData`, copy into the layer,
     `texture.addLayerUpdate(layer)`, `needsUpdate = true`.
   - Per frame: instances = loaded slots whose node is in the current graph;
     `iCenter` from the live positions (same buffer as the cores), size ≈
     radius × 2.4 (× 1.3 selected, × 1.15 hovered), alpha from the node's dim
     state (highlight / focus) so filters dim thumbnails too. While a node has
     a thumbnail its sphere core is drawn small (≈ 0.35 r) and its halo off,
     so the picture is the body.
   - Everything keyed by image path (`image.path`), not by node index (graphs
     are rebuilt constantly). Dispose texture/geometry/material with the
     buffers. No React state on the hot path.
   - `showThumbnails = false` or no loader → no billboards, plain moons.
   - Unit-test the pure parts (slot allocation / LRU / candidate ranking) in
     `test/thumbs.test.ts` (node env, no WebGL): put them in pure functions.
5. **BrainController.flyTo** distances: the hub and images get sensible
   distances (hub ≈ 90, image ≈ 26).

Acceptance: `pnpm exec vitest run packages/graph` green, `pnpm typecheck`
clean for graph files, no per-frame allocation added in `useFrame`.

## Part UI — `packages/ui`, `vault-demo`, `apps/web` (owner: UI agent)

Files: `store.ts`, `App.tsx`, `commands.ts`, `hooks/useKeyboard.ts`,
`components/*` (Inspector, TopBar, Help, Legend, CommandPalette …),
`vault/demo.ts`, `vault/fsAccess.ts`, `styles.css`, `util.ts`, `projects.ts`,
`index.ts`, `test/*`, `vault-demo/**`, `docs/KEYBOARD.md`.

Store (`AetherState` additions; keep existing behavior):
- `assets: Map<string, VaultAsset>` (from `loadVault` / `applyChanges`; pass
  `assets` into `applyChanges`, keep identity when unchanged).
- `brief: DailyBrief | null`, computed with `dailyBrief(notes.values(),
  { date: todayIso(), folders })` whenever notes or folders change (inside the
  graph-options callback, so it is computed once per rebuild) and passed to
  `buildGraph` as `today: { brief }` when `settings.todayHub` (default true).
  `refreshBrief()` recomputes it and rebuilds the graph when the date changed
  (App runs it every 60 s and on window focus).
- `graphOptions(folders, notes, assets)` adds
  `images: { all: assets, moons: layout === 'system' && settings.imageMoons }`
  (embedded images in every layout). New settings (persisted, defaults true):
  `imageMoons`, `todayHub`. `controller.showThumbnails = settings.thumbnails`
  (default true).
- `openVault` sets `controller.thumbnails` from `adapter.thumbnail`
  (null when absent) and clears it on close.
- `showToday()`: turns the hub on if off, selects `TODAY_ID`, flies to it.
  Selecting the hub shows the brief in the Inspector.
- `select` / `openNote` / `cycleNeighbor` / history / editor accept the new ids:
  `openNote(imageId)` → `openImage(path)`; `openNote(TODAY_ID)` → select it
  (no editor). Every note-id action guards with `isVirtualId`.
- `openImage(path)`: `adapter.openAsset` when present, else a toast.
- `importImages(files: { name: string; data: Uint8Array }[], folder?: string)`:
  target = `folder`, else the selected folder, else the selected project's
  Critique planet (project star or project note selected), else
  `<home>Inbox`; existing spelling reused; create-only with ` 2`, ` 3`
  suffixes (`gate 2.png`); only image names; ≤ 40 MB each; applies the adds
  locally (don't wait for the watcher; the echo is idempotent); toast with
  "Show"; selects the first new image. Returns the paths written.
- `forgeProjects(): ForgeProjectDto-shaped rows` (`{ id, title, status, home,
  critique }`): active projects first (`listProjects` order, done/archived
  last or dropped), `critique` = the existing child folder of the home named
  `critique` (any case) or `<home>/Critique`; home = `projectFolderOf ??
  defaultProjectFolder`.
- `saveCritique({ projectId, title, png, grade?: unknown, practiceTomorrow? = true })
  → { noteId, notePath, imagePath, project }`: project must be a project note;
  create the home folder / Critique folder when missing (createFolder);
  `g = normalizeGrade(grade)`; base = `critiqueBaseName(title || g.drill ||
  'Drawing', today)`; write the PNG create-only (`base.png`, `base 2.png` …);
  then the note (`critiqueNote({ title, project: project title, drill, grade,
  score, scores, fixes, strengths, deep }, imageFileName, { practiceDue:
  practiceTomorrow ? nextDay(today) : null })`) create-only next to it (same
  base when free); apply both locally; toast "Critique saved to <Project> ▸
  Critique" with a "Show" action (select + fly to the note). Reject with a
  clear message when no vault is open, the project is gone, or the vault is
  read-only.
- `toggleTask` etc. already take note ids + lines: the brief's rows use them.

Components:
- **Inspector** gets `TodayInspector` for `TODAY_ID`: date, counts, three
  sections (Overdue / Today / Next up) of rows: a checkbox button (ticks the
  task through `toggleTask(noteId, line, true)`, with the usual Undo toast), the
  label, a project chip (click → select that project's star when shown, else
  its note) and a due chip; the note title opens the note. Empty state: "All
  clear for today" + a hint on how to put things here (`📅 2026-10-01`,
  `#today`, today's daily note `d`). Every row is a real button (Tab / Enter /
  Space).
- `ImageInspector` for `image:` ids: a preview (`adapter.thumbnail(path, 512)`
  → object URL, revoked on unmount/change; CSP allows `blob:`), file name,
  folder, size, date, buttons **Open** (`e` / Enter; `openImage`), **Reveal**
  (when `adapter.reveal`), **Copy embed** (`![[name.png]]` to the clipboard via
  `navigator.clipboard`, falling back to `window.aether?.copyText`), and
  "Embedded in" (backlinks) with the LinkList. `LinkList` renders image and
  hub ids (🖼 file name / ☀ Today) instead of dropping or crashing on them.
- `FolderInspector` shows `images` / `shownImages` ("12 pictures · 8 shown")
  and an **Import pictures…** button (a hidden `<input type=file multiple
  accept="image/*">` → `importImages(…, folder)`).
- **TopBar**: a `☀ Today N` chip (red dot when overdue) → `showToday()`.
- **App**: drag & drop of image files anywhere → `importImages` (drop overlay
  "Drop pictures into <target>"); 60 s timer + `focus` → `refreshBrief()`;
  `Hint` texts for images ("e open · Tab neighbors") and the hub ("Space tick
  the focused task · y Today").
- **Keys** (`useKeyboard.ts` + `commands.ts` + `Help.tsx` + `docs/KEYBOARD.md`):
  `y` and `7` → Today (`showToday`). `e` / Enter on an image → open it.
  Palette commands: "Today — daily brief" (`y`), "Import pictures…",
  "Toggle image moons", "Toggle picture thumbnails", "Toggle Today hub".
- **Legend**: rows for ☀ Today hub and 🖼 pictures.
- `styles.css` tokens `--today: #8ff7ff`, `--image: #f4f1ff`.

Adapters:
- `vault/demo.ts`: bundle `vault-demo/**/*.{png,jpg,jpeg,webp}` with
  `import.meta.glob(…, { query: '?url', import: 'default', eager: true })`;
  `listAssets` (bundled + created), `thumbnail` (fetch the URL / created bytes →
  resize to `size` on a canvas → PNG Blob; plain Blob fallback), `createAsset`
  (kept in memory + IndexedDB overlay so a dropped picture survives reload).
- `vault/fsAccess.ts`: `listAssets` during the walk (no per-file reads; mtime
  unknown is fine), `thumbnail` (getFile → `createImageBitmap` resize → canvas
  → Blob), `createAsset` (create-only like `create`, write the bytes).

Demo vault content (keep it small: the whole demo image set < 250 KB):
- 6–8 procedurally generated PNGs (a script under `scripts/` that writes them
  with `zlib`, committed output): `Projects/PORTALz/Art/*` (portal rings,
  ruins silhouettes, gradient skies), `Projects/ConceptForge/Critique/2026-09-28
  Value Study.png` + its critique note written with `critiqueNote`.
- A few tasks with due dates relative to "now" can't be static; instead give
  PORTALz and ConceptForge tasks with dates near the release
  (`📅 2026-10-01`, `⏳ 2026-09-30`), one `#today` task, and embed one image
  from a note (`![[portal-ring.png]]`). Update any test that counts demo notes.

Tests (`packages/ui/test`, MemoryVaultAdapter, node env): brief in the store
(hub node present with counts; ticking a brief task updates it), showToday,
image moons in the system graph and embedded images in others, asset changes
via the adapter, `importImages` (target rules, suffixes, rejects non-images),
`saveCritique` (folders created, PNG bytes written, note content, practice
task due tomorrow, Critique folder reused in another case, EEXIST suffixing,
unknown project rejected), `forgeProjects`, the new keys.

## Part DESKTOP — `apps/desktop` main, preload, vault adapter, MCP (owner: desktop agent)

Files: `src/main/fsvault.ts`, `src/main/watcher.ts`, `src/main/main.ts` (IPC for
assets only), `src/preload/preload.cts`, `src/renderer/vault/electron.ts`,
`src/mcp/brain.ts`, `src/mcp/tools.ts`, `scripts/pack-mcpb.mjs` (if the tool
list is hard-coded), `test/*` (not forge tests).

- **FsVault**: `isImageName(name)` (image extensions, not temp files). `scan`
  collects `assets: { path, abs }[]` (no stat during the scan; cap
  `maxAssets` = 200 000 → `assetsTruncated`), same skip rules as notes.
  `assetAbs(p): Promise<string | null>` (allowed + exists + file + image name).
  `createBinary(p, data)`: create-only with the same EEXIST semantics as
  `create` (case-insensitive sibling check, `wx`), image names only.
- **VaultWatcher**: tracks images (`KnownPaths.images`, seeded from the scan):
  image add/change/unlink with `mtime`/`size` (no content), a removed folder
  unlinks its images, `addTree` reports images, resync diffs images (new /
  gone). No self-write suppression needed for images (adds are idempotent).
- **IPC** (`main.ts`): `vault:assets` → `AssetListDto` from the last scan;
  `vault:thumb(path, size)` → PNG bytes (`Uint8Array`) or null:
  `assetAbs` → `nativeImage.createThumbnailFromPath(abs, {width,height})` on
  win32/darwin (falls back on error), else `nativeImage.createFromPath(abs)`
  (skip files > 64 MB), `.resize` to fit `size` (clamped 32–1024), `toPNG()`;
  LRU cache (~1500 entries) keyed by abs + mtime + size; empty images → null.
  `vault:createAsset(path, data)`: image path, `Uint8Array` ≤ 40 MB, magic bytes
  must match a real image (PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `GIF8`,
  WebP `RIFF….WEBP`, BMP `BM`, AVIF `….ftypavif`), then `createBinary`, then
  tell the AI link. `vault:openAsset(path)`: image path in the vault only →
  `shell.openPath(abs)` (never anything else: `openPath` runs executables).
  The renderer still reads/writes only `.md` through the old channels.
- **Preload** (`preload.cts`): the new `AetherBridge` methods, including
  `forgeOpen`, `forgeStatus` (plain invokes) and `onForgeRequest(handler)`:
  listens on `forge:request`, calls the handler, replies with
  `ipcRenderer.invoke('forge:reply', id, true, value)` or `(id, false,
  message)`; only one handler (a new one replaces the old). Keep the IPC
  channel list in sync with `IPC`.
- **ElectronVaultAdapter**: `listAssets` (bridge; remember `assetsTruncated`),
  `thumbnail` (bytes → `Blob` type image/png), `createAsset`, `openAsset`.
  Image changes from `onChanges` pass through untouched.
- **MCP**: `Brain.dailyBrief(date?)` (core `dailyBrief` over the brain's notes
  and folders) and a read tool `daily_brief` ("Use this when the user asks
  what's on today, what's due or overdue, or what to work on next…"; optional
  `date` YYYY-MM-DD) returning sections with task text, note title/path, line,
  project, due, reason — plus how to tick one (`set_task_done` with note + line).
  One line in INSTRUCTIONS. `.mcpb` manifest tool list updated if needed.
  The brain must ignore image changes (core `applyChanges` already does unless
  given `assets`).
- Tests: FsVault assets (scan, skip rules, cap, `assetAbs` jail, `createBinary`
  EEXIST incl. case variants), watcher image events (add, change, unlink,
  folder removal, addTree, resync), IPC validation helpers as pure functions
  (magic bytes, size caps, path checks) unit-tested, MCP `daily_brief`.

## Part FORGE — the Concept Forge link (owner: forge agent; runs after the others)

Files: new `apps/desktop/src/main/forge.ts`, new
`apps/desktop/src/preload/forge-preload.cts`, `src/main/main.ts` (only the
forge wiring), new `src/renderer/forge.ts` (+ one import in
`src/renderer/main.tsx`), `tsconfig.main.json` / `electron-builder.config.cjs`
if the new preload needs listing, new `docs/FORGE-LINK.md`, new
`test/forge.test.ts`, new `test/fixtures/concept-forge-mock.html`.

- **ForgeHost** (`forge.ts`): remembers `settings.forge.file` (absolute path of
  concept-forge.html). `open({ pick })`: pick the file with the OS dialog
  (filters: HTML) the first time, with `pick`, or when the file is gone; then
  create or focus ONE BrowserWindow (1600×1000, title "Concept Forge — Aether
  Brain", dark background) with `webPreferences: { preload: forge-preload.cjs,
  partition: 'persist:forge', contextIsolation: true, sandbox: true,
  nodeIntegration: false }` and `loadFile(file)`.
  - Its own session (`persist:forge`): the main session's production http(s)
    block does not apply, so the page's Deep Critique (vision AI with the
    user's own key) and random references keep working. Permissions on that
    session: allow `clipboard-sanitized-write`, `fullscreen`, `pointerLock`;
    deny the rest.
  - Navigation: stays on the file (hash changes ok); http(s) links and
    `window.open` go to the default browser (`shell.openExternal`); anything
    else is denied. Downloads (its Save PNG) use the normal save dialog.
  - Relay: `forge:win:projects` / `forge:win:save` from the Forge window are
    forwarded to the brain window as `forge:request` `{ id, kind, … }`; the
    reply arrives on `forge:reply` (id, ok, value|message). 30 s timeout;
    clear errors: "Open your vault in Aether Brain first" (no brain window or
    it doesn't answer), the store's own messages otherwise. Validate the save
    DTO in main before relaying (projectId string, title ≤ 200 chars, png a
    Uint8Array ≤ 40 MB with PNG magic bytes, grade JSON-safe ≤ 256 KB).
  - IPC `forge:open`, `forge:status` for the brain window.
- **forge-preload.cts** (sandboxed; can't require local files): exposes
  `window.aetherForge` (`AetherForgeBridge`) with `contextBridge`, and after
  `DOMContentLoaded` injects the page UI into the main world with
  `webFrame.executeJavaScript('(' + forgeLinkMain.toString() + ')()')`, where
  `forgeLinkMain` is a self-contained function in the same file (no closures
  over module scope, no imports). It must never break the page: wrap
  everything in try/catch, render into a closed shadow root, namespace every
  global it sets (`__aetherForge…`).
  - UI: a floating **"🪐 Save to Brain"** button (bottom-right, above the
    page's own UI, dark glass style) and `Ctrl+Shift+B` (don't steal the
    page's own keys: Space, n, b, e, [, ], g, r, l, Ctrl+Z/Y). It opens a small
    dialog: project picker (from `aetherForge.projects()`, last choice
    remembered in `localStorage['aetherForge.project']`), title (prefilled
    from the drill name, else "Study"), a preview of what was found (thumbnail
    of the capture, grade letter + score if any), a "Practice the top fix
    tomorrow" checkbox (default on), Save / Cancel (Esc). Keyboard reachable.
    Toast on success ("Saved to PORTALz ▸ Critique") or the error message.
  - Capture: the drawing canvas = among visible `<canvas>` elements, prefer
    ids/classes matching `/draw|paint|art|main|canvas|board|sketch/i`, never
    `/overlay|grid|guide|cursor|preview|thumb|ring|meter|hud|ui/i`, largest
    visible area wins; composite every visible non-overlay canvas that covers
    the same rect (DOM order) over the first non-transparent computed
    background of the canvas or its ancestors (else white); `toBlob('image/png')`.
  - Grade: the first of the page's global bindings `lastGrade`,
    `LAST_GRADE`, `currentGrade`, `gradeResult`, `lastResult` that is an object
    (read with indirect `eval` of `typeof x !== 'undefined' ? x : undefined`, so
    top-level `let`/`const` of classic scripts are found), else the last entry
    of any `localStorage` value whose key matches `/grade/i` and parses to an
    object or array of objects. Deep-clone JSON-safely (drop functions/DOM,
    depth ≤ 6, ≤ 256 KB) and send it raw as `grade`; the brain normalizes it
    (`normalizeGrade`). The dialog preview reads letter/score loosely.
  - The drill name for the title: `grade.drill` / `grade.mode` loosely, else
    the text of an element that looks like the active drill
    (`[aria-pressed=true]`, `.active`, `[aria-selected=true]` inside a nav),
    else "Study".
- **Renderer** (`src/renderer/forge.ts`, imported once by `main.tsx`):
  `registerKey('g', () => bridge.forgeOpen())`, palette commands "Concept
  Forge — open" and "Concept Forge — choose file…", a cheatsheet row, and
  `bridge.onForgeRequest(req => req.kind === 'projects' ?
  store.forgeProjects() : store.saveCritique(req.save))`. After a save the
  brain shows the toast (the store does) — the Forge window shows its own.
- **docs/FORGE-LINK.md**: what it does, how to point it at concept-forge.html,
  what gets written (with an example note), how the top fix becomes tomorrow's
  task, privacy (the Forge window may use the internet for its own features;
  the brain still doesn't), and what to do if the button finds no grade
  (it still saves the drawing; the grade is read from `lastGrade` or grade
  history in localStorage).
- **Tests** (`test/forge.test.ts`): the pure parts of ForgeHost (DTO
  validation, relay id/timeout bookkeeping with a fake sender), and the
  injected script against `test/fixtures/concept-forge-mock.html` in a real
  browser if feasible (Playwright Chromium is installed; skip gracefully when
  it can't launch), else by evaluating `forgeLinkMain` source in a minimal DOM.
  The mock page: a drawing canvas + an overlay canvas, a top-level
  `let lastGrade = {...}` in a classic script, a drill nav with an active
  button.

## Verification (integration, by the lead)

- `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm build:desktop`.
- Web smoke (headless Chromium, demo vault): hub visible and selectable with
  `y`, brief rows tick tasks, image thumbnails appear (texture layers filled),
  image inspector preview, drop import.
- Electron e2e (two fake drive roots): images listed and thumbnailed through
  IPC, watcher reports a new PNG live, `createAsset` refuses non-images and
  EEXIST, Forge window opens the mock page, Save to Brain files a critique
  (PNG + note) into the project's Critique planet and the brain shows it.
