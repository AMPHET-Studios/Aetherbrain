# Reference boards (PureRef-style)

A **reference board** is an unbounded canvas of pictures, text notes and drawn marks, for keeping references next to your work: drop
or paste pictures, move, scale, rotate, flip, crop and group them, arrange them, write on them, grey them for value studies, pick
colours from them, and keep the whole board in a window that floats on top of your painting program. Boards are ordinary markdown
notes in the vault, so the brain links each board to its pictures, search finds it, git can diff it and nothing is locked in.

This file is the contract the pieces are written against. Types: `packages/core/src/board/types.ts` (data model) and
`packages/ui/src/board/api.ts` (host, input, state, commands, picture cache).

## Features

PureRef's feature set, built for this app. Everything has a key or a palette command (`⌘K`, type "Board").

| Group | Feature |
|---|---|
| Canvas | Unbounded pan and zoom (zoom toward the cursor, 0.5% to 6400%), fit all, zoom to selection, 100%, background colours (dark, mid, light, black, white), snap to grid, alignment guides while dragging. Pen, mouse and touch (pinch, two-finger pan). |
| Adding | Drop files, paste from the clipboard (screenshots, copied files, copied boards items), pick from the vault's pictures (picker with search), "Add to board" from a picture's inspector. Dropped and pasted pictures are saved into the board's own folder. |
| Pictures | Select (click, marquee, add with `⇧`, all, invert), move, scale (corners, from the centre with `Alt`), rotate (handle, `⇧` snaps to 15°), flip horizontally and vertically, crop (non-destructive, reset any time), opacity, grey (per picture or the whole board), smooth or crisp pixels, captions, lock, duplicate, delete, order (front, back, forward, backward), group and ungroup. Nothing changes the picture files. |
| Arrange | Optimal (a tidy packed layout), row, column, grid, stack; sort by name, added, size or shuffled; align left/right/top/bottom/centres; distribute; normalise width, height, size or scale. |
| Writing | Text notes (size, colour, background), pen (pressure from a tablet pen thickens the line), line and arrow, rectangle, ellipse, an eraser that removes whole marks. |
| Colour | Sampler: click anywhere to read the colour under the pointer (hex copied); extract a palette from the selection (swatch notes on the board). |
| Files | Undo and redo (200 steps), automatic saving, many boards (a list, new, duplicate), export the selection or the whole board as a picture saved in the board's folder. |
| Window | Desktop: pop the board out into its own window that stays on top, window opacity (Windows, macOS), hide the toolbar for a bare board, remembers its place and size. |

Not in scope: online search for pictures, downloading pictures from web addresses (the app makes no network requests; copy the
picture or save it, then paste or drop), the click-through window (no safe way back without a tray or global shortcut), animation.

## Decisions (and why)

1. **A board is a markdown note** (`type: board`), not a new file type: "Markdown is the format", the renderer may write only `.md`
   notes and create-only pictures, and a note links to its pictures by `![[...]]`, which makes the brain draw the board↔picture
   links for free. The layout is one **readable line per item** under a `## Board` heading, not a JSON block: a block hides in an
   HTML comment that the preview shows as text, ends at the first `-->` inside the data, and swallows the rest of the note when
   unclosed (measured in the recon); lines diff and merge well, survive hand edits, and need no special hiding.
2. **Pictures are never edited.** The renderer can only create pictures (never replace or delete). So crop, flip, rotation, grey and
   opacity are numbers on the board item; "export" writes a *new* picture.
3. **Canvas 2D drawing**, not DOM nodes: hundreds of pictures with arbitrary rotation, crop, flip and grey stay one canvas; hit
   testing is our own geometry (pure, testable in node); export reuses the very same draw function.
4. **Level of detail and a memory budget.** The existing read path is `thumbnail(path, ≤1024)`. A board needs the real picture when
   it is zoomed in, so a new `readAsset` (bytes of a vault picture, ≤ 64 MB, never decoded by the main process) is added. Pictures are
   held as `ImageBitmap`s in three tiers (256, 1024, full capped at 8192 px longer side), chosen by their size on screen, loaded
   lazily for what is in view, evicted least-recently-used under a pixel budget (128 megapixels), two decodes at a time.
5. **Two hosts, one board view.** `BoardView` (React, in packages/ui) takes a `BoardHost` and knows nothing of the store or of Electron:
   the **docked** host wraps the store (`rewriteNote`, `importImages`, `preview`), the **floating** host wraps the bridge in a second
   window. A board is open in one place at a time: popping out leaves a placeholder docked, closing the window gives it back. That
   avoids two writers (the vault watcher does not echo a window's own writes, so a live two-window sync would need its own bus).
6. **The floating window is a second HTML entry** (`board.html`) loading only the board view, with the same preload and default
   session as the brain window (same security: no network in production, every permission refused). It never boots a vault: it
   must not call `openVault`, `listFiles` or anything that restarts the watcher. Its saves go through `board:save`, which writes
   the note *without* telling the watcher to ignore it, so the brain window sees the change like any outside edit.
7. **Window opacity, not transparency.** `BrowserWindow.setOpacity` works on Windows and macOS with a normal frame; a transparent
   frameless window cannot be resized on Windows without custom handles, and click-through strands the user.
8. **Keys.** The board is an overlay view with its own capture-phase key handling (it consumes the keys it uses, so `b`, `z`, `t`
   and the others of the 3D view do not also fire). `8` and `⇧B` open the boards view.

## The board file

```markdown
---
title: Gate reference
type: board
created: "2026-10-09"
updated: "2026-10-09"
---
# Gate reference

Reference board. Open it from the Boards view (8). Everything under "Board" is rewritten by the board view; write anything else here or below.

## Board

- view x=0 y=0 zoom=1 bg=14161d gray=0 smooth=1 captions=0 grid=0
- ![[Boards/Gate reference/rust.png]] x=120 y=-40 w=640 h=480 r=3 flip=h crop=.1,.1,.9,.8 gray op=.8 lock g=2 » Rusted gate
- pic Boards/odd#name.png x=-300 y=10 w=200 h=300
- note x=10 y=10 w=300 size=18 color=ffffff fill=202530 r=0 » Check the edge\nof the lintel \[sic\]
- stroke color=ff5533 width=3 pts=12,34 13,36 15,40
- line x1=0 y1=0 x2=100 y2=40 color=ffffff width=2 arrow
- rect x1=0 y1=0 x2=100 y2=60 color=ffffff width=2 fill=
- ellipse x1=0 y1=0 x2=100 y2=60 color=ffffff width=2 fill=
```

Rules:

- Only the lines under the first `## Board` heading (outside code fences) up to the next heading of level 1 or 2 belong to the board.
  `serializeBoard(doc, raw)` rewrites exactly that span (adding the heading at the end when missing) and returns everything else
  byte for byte; frontmatter is patched with the existing in-place helpers (`title`, `type`, `updated`).
- One item per list line, back to front. First token after `- ` is the kind: `view`, an embed `![[path]]`, `pic` (a picture whose
  path cannot be embedded), `note`, `stroke`, `line`, `rect`, `ellipse`. Then `key=value` pairs separated by single spaces and bare
  flags (`gray`, `lock`, `arrow`). Numbers are written with at most 2 decimals (crop with 3), trimmed. Colours are 6 hex digits
  with **no `#`** (a `#ff8800` in the body would become a vault tag). `g=` is a group label (renumbered from 1 on every write).
  `flip=` is `h`, `v` or `hv`. `r=` is the rotation in degrees. `op=` is opacity.
- Text (a note's text, a picture's caption) follows the first ` » ` on the line. It is escaped so the line stays inert markdown
  and one line: `\` → `\\`, a newline → `\n`, and `\` before each of `[ ] # < > | * _ ~ ! \``. No link, tag, task or HTML can
  come out of a note. Reading reverses it exactly.
- A picture is written as an embed `![[path]]` (so the brain links the board to the picture) when its path is safe to embed (no
  `#`, `|`, `[`, `]`, `<`, `>`, no leading or trailing space, none of `*`/`_`/`~` flanking a name part); otherwise as `pic path`
  with the path escaped and no graph link. Paths are the vault's own picture paths. A picture that is missing from the vault keeps
  its line and its place, and is drawn as a placeholder.
- Lines under `## Board` the reader does not understand (a hand-written remark, an item kind of a newer version) go to `doc.extra`
  and are written back after the items. Nothing is dropped. A bad number or an unknown flag on a known line is ignored for that
  attribute with a warning, never the line.
- Limits (`BOARD_LIMITS`): 1,500 items, 4,000 characters per note, 3,000 points per stroke, 300,000 characters for the note. Reading
  a board over a limit keeps the first items and warns; the view refuses to add past it.
- The reader never fails: a note without a board section is an empty board; broken YAML in the frontmatter is not touched and the
  board is treated as an ordinary note (`isBoardNote` is false) so nothing is overwritten.

Saving costs a full re-parse of the note and a graph rebuild on the main thread, so the view saves **at most once per second while
changing and once at the end of a gesture**, never per pointer move, and not at all for a pan or zoom alone (the view goes to
`localStorage` per board path and is written into the file with the next real change).

## Core (`packages/core/src/board/`)

Pure TypeScript, no DOM. Exported from `@aether/core`.

- `text.ts`: `escapeBoardText(s)`, `unescapeBoardText(s)`, `estimateTextMetrics: TextMetrics` (average glyph width 0.55 × size,
  wrapping at spaces, line height 1.25 × size), `NOTE_PADDING`.
- `format.ts`: `parseBoard(raw: string): { doc: BoardDoc; warnings: string[] }`, `serializeBoard(doc: BoardDoc, raw?: string): string`
  (merge into `raw` when given, else a fresh note), `newBoardNote(title: string, now: Date): string`, `isBoardNote(raw: string):
  boolean`, `boardPictures(doc): string[]` (distinct picture paths in order), `safeEmbedPath(path): boolean`, `boardFolderName(title)`.
- `geometry.ts`: `itemSize(item, metrics): { w, h }` (shown size, unrotated), `itemCentre`, `itemQuad(item, metrics): [Vec2×4]`,
  `itemBounds(item, metrics): Rect`, `itemsBounds(items, metrics): Rect | null`, `pointInItem(item, p, tol, metrics)`, `hitTest(doc, p,
  tol, metrics): BoardItem | null` (topmost), `itemsInRect(doc, rect, mode: 'touch' | 'contain', metrics): number[]`, `rotatePoint`,
  `screenToBoard(view, viewport, p)`, `boardToScreen(...)`, `zoomAt(view, factor, anchorScreen, viewport)`, `fitView(bounds,
  viewport, margin)`, `clampView`, `snapMove(doc, movingIds, delta, opts): { delta, guides }`, `normalizeAngle`.
- `ops.ts`: pure functions `BoardDoc → BoardDoc` (never mutate; unchanged parts keep their identity): `addPicture`, `addNote`,
  `addMark`, `moveItems`, `scaleItems`, `resizePicture`, `rotateItems`, `flipItems`, `setCrop`, `setProps`, `group`, `ungroup`,
  `expandGroups(doc, ids): number[]`, `reorder`, `removeItems`, `duplicateItems`, `lockItems`, `clampDoc`. All skip locked
  items except `lockItems` itself.
- `arrange.ts`: `arrange(doc, ids, mode, opts)` (optimal, row, column, grid, stack), `sortItems`, `align`, `distribute`, `normalize`.
- `history.ts`: `History<T>`: `push(doc, label)`, `undo()`, `redo()`, `canUndo`, `canRedo`, `clear()`; coalesces pushes with the same
  `key` within 800 ms (a run of arrow-key nudges is one step); 200 steps.
- `palette.ts`: `hexToRgb`, `rgbToHex`, `luminance`, `dominantColours(rgba: Uint8ClampedArray, count): string[]` (median-cut),
  `textColourOn(hex)`.

## UI (`packages/ui/src/board/`)

- `controller.ts`: `class BoardController` — the whole interaction state machine, free of the DOM. `constructor({ doc, metrics?,
  now? })`; `state: BoardUiState`; `subscribe(cb)`; `setViewport(w, h)`; `pointerDown/Move/Up/Cancel(e: PointerIn)`,
  `wheel(e: WheelIn)`, `key(e: KeyIn): boolean` (true when consumed), `exec(id: BoardCommandId, arg?)`, `replaceDoc(doc)` (external
  change: keeps the selection by id and the history), `onChange(cb: (doc, why) => void)` (for saving), `addPictures(items:
  {path, w, h}[], at?: Vec2)`, `addNoteAt(p)`, `commitNoteText(id, text)`, `setNaturalSize(path, w, h)` (a picture's real
  aspect arrived), `sampleAt(p, rgba)`.
  It owns tools, selection, drag (move with snapping, scale from handles with aspect lock, rotate with snap, crop edges,
  marquee), pan (middle button, Space+drag, hand tool, two-finger touch, pen barrel button), pinch zoom, wheel zoom (and trackpad
  pan with `⇧`), the draft mark while drawing, eraser, history, dirtiness.
- `commands.ts`: `BOARD_COMMANDS: BoardCommandInfo[]` (every `BoardCommandId`, title, group, keys), `keyToCommand(e: KeyIn, tool)`.
- `imageCache.ts`: `class ImageCache implements ImageSource` — tiers, budget, LRU, concurrency; takes `{ load(path, tier):
  Promise<ImageBitmap | null>, budgetPixels?, onLoaded() }`; `pickTier(wantPx, natural)`; `dispose()`.
- `renderer.ts`: `drawBoard(ctx, args)` — background, grid, pictures (crop, flip, rotation, opacity, grey, smoothing, captions),
  notes (real text metrics), marks, selection box and handles, guides, marquee, draft, sampler loupe, missing-picture
  placeholders; `exportBoard(doc, ids, scale, images)` → canvas; `canvasTextMetrics(ctx): TextMetrics`.
- `BoardView.tsx`: the React shell over a `BoardHost`: canvas (pointer, wheel and key listeners with `{ passive: false }`,
  `touch-action: none`, pointer capture), toolbar (tools, arrange menu, colour, window controls), status bar (zoom, selection,
  saved/saving), picker, note editor overlay (a textarea over the note), context menu, drop and paste handling (stops the
  window's own drop-zone from importing the same files), save debounce, external-change reload, missing-picture list.
- `BoardsView.tsx` (docked): board list (notes with `type: board`), new board, open, the placeholder when the board is popped out.
  `docked host` over the store lives in `dockedHost.ts`.

Store (`packages/ui/src/store.ts`): `View` gains `'boards'`; `boardPath: string | null`; `openBoard(path)`, `newBoard(title?)`
(creates `<home>Boards/<Title>.md` through the create-only note path), `addPicturesToBoard(paths, boardPath?)` (used by the
inspector's "Add to board" button), `boardFolderOf(path)`. Keys: `8`, `⇧B` open the boards view; `Esc` leaves it. The inspector of a
picture gets *Add to board*. Palette: every `BOARD_COMMANDS` entry as "Board: …" (active only while the view is open) plus
"Boards: open", "Boards: new board".

## Desktop (`apps/desktop`)

- **`readAsset`**: `AetherBridge.readAsset(path): Promise<Uint8Array | null>`, channel `vault:readAsset` (in `ipc.ts` and the
  duplicate in `preload.cts`), main handler `v.assetAbs(path)` + `readUpTo(abs, 64 MiB)`, null otherwise; no decoding. Core:
  `VaultAdapter.readAsset?(path): Promise<Blob | null>`; implemented by the Electron adapter (MIME from the extension), the
  File System Access adapter, the memory and demo adapters.
- **Clipboard images**: paste is a DOM `paste` event (the sandbox refuses `navigator.clipboard.read`); drops handle `dataTransfer.files`;
  a dropped or pasted address (text/uri-list, text/html with an `<img src>`) cannot be fetched (no network) and says so in a toast.
- **`src/main/board-window.ts`**: `BoardWindowHost` in the style of `ForgeHost` (no runtime electron import; takes `BrowserWindow`,
  `screen`, the brain window getter, preload path, settings and a save callback). One window, lazily opened, reused, closed with the
  brain window. Options: `alwaysOnTop` (`'floating'` level), `opacity`, normal frame, same preload, **no partition**, per-webContents
  guards copied from `createWindow` (`setWindowOpenHandler`, `will-navigate`, `render-process-gone`, reveal on `ready-to-show`).
  Pure helpers: `boardWindowOptions(settings, display)`, `clampBoardBounds`, `boardSettings(raw)` sanitizer (opacity 0.2–1, sizes within
  the display). Settings: `settings.board = { x?, y?, width, height, alwaysOnTop, opacity }` in `settings.json`.
- **IPC** (both `ipc.ts` and `preload.cts`): `board:open(path)`, `board:close()`, `board:status()` → `{ open, path, alwaysOnTop, opacity,
  supportsOpacity }`, `board:configure({ alwaysOnTop?, opacity? })` (applies to the board window; callable from either window),
  `board:save(path, text)` (see below), events `board:state` (to both windows) and `board:closed(path)` (to the brain window).
  `board:save` accepts only a vault `.md` path whose current file (or empty) is a board note (`type: board` in the first 4 KB),
  text ≤ 400,000 characters, written with `FsVault.write` and **without** `noteSelfWrite`.
- **`src/renderer/board.html` + `board.tsx`**: mounts `BoardView` with the floating host (reads `?path=`; loads with `readFile`,
  saves with `board:save`; pictures through `thumbnail`, `readAsset`, `createAsset` into the board folder, `listAssets`). Vite
  builds two inputs (`index`, `board`); the CSP meta (with the `%VITE_CSP_*%` placeholders) is repeated. Never calls `boot()` /
  `openVault` / `listFiles`.
- **Docked ↔ floating**: `PopOut` in the toolbar calls `board:open`; the docked view flushes its save first and shows the
  placeholder "This board is open in its window — Bring it back"; `board:closed` re-loads the note. Registered with
  `registerCommands` ("Board: Pop out / Dock / Always on top").

## Pictures: where they live, and the limits

- A board's pictures go to `<home>Boards/<Title>/` (the board's own folder, named like the board; if that name is one FsVault ignores
  — `Library`, `Temp`, `Cache`, `Out`, `Build`, ... — or the write is refused as excluded, `<Title> pictures`). Names are cleaned
  (`#|[]<>*_~` replaced by `-`); a pasted `image.png` becomes `ref 2026-10-09 143512.png`, `ref ... 2.png` when taken.
  They are created through the store's importer (`importImages`: create-only, signature checked, ≤ 40 MB, one graph rebuild per batch)
  and not selected (the importer's select-and-toast is switched off for boards).
- Pictures already in the vault are referenced where they are (nothing is copied).
- Memory: the cache budget is 128 megapixels of decoded bitmaps and at most 2 loads at once; a picture is only decoded while it is
  in view; off-screen bitmaps are dropped first. 1,500 items maximum.

## Tests

- **Node (run in CI):** `format` (round trips, a fuzzer over every attribute, escape inertness: `parseNote` of a serialised board has
  no links beyond the embeds, no tags, no tasks), geometry and ops (properties: transforms are inverse, locked items are skipped,
  groups move whole), arrange, history, the controller (scripted pointer sequences: marquee, move with snapping, scale from every
  corner, rotate with snap, crop, draw, erase, pan and zoom with mouse, pen and two touches, every command), image cache (tiers,
  eviction, concurrency with fakes), commands table (every id has a row, a key that is not taken twice, a line in KEYBOARD.md), desktop
  (preload/IPC parity, `readAsset` against a temp vault, `board:save` validation, the window host with fake windows, settings sanitiser).
- **Chromium (local, skipped without a browser):** the canvas renderer draws a known board and pixels are checked; pointer drags through
  `page.mouse`; the BoardView with a fake host (drop, paste, picker, note editing, save debounce).
- **Real Electron (by hand / the harness in the scratchpad):** the floating window opens on top, opacity applies, a drop adds pictures,
  a save is seen by the brain window.
