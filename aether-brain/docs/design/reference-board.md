# Reference boards (PureRef-style)

A **reference board** is an unbounded canvas of pictures, text notes and drawn marks, for keeping references next to your work: drop
or paste pictures, move, scale, rotate, flip, crop and group them, arrange them, write on them, grey them for value studies, pick
colours from them, and keep the whole board in a window that floats on top of your painting program. Boards are ordinary markdown
notes in the vault, so the brain links each board to its pictures, search finds it, git can diff it and nothing is locked in.

This file is the contract the pieces were written against, brought up to date with the code when the build was finished (names,
signatures and the places where the build went another way are marked *Built as:*). Where this text and the code differ, the code
wins. Types: `packages/core/src/board/types.ts` (data model) and `packages/ui/src/board/api.ts` (host, input, state, commands,
picture cache). The user's guide is [../REFERENCE-BOARD.md](../REFERENCE-BOARD.md), the keys are in [../KEYBOARD.md](../KEYBOARD.md).

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
| Files | Undo and redo (200 steps), automatic saving, many boards (a list with search, new; a board is a note, so duplicating one is copying its file), export the selection or the whole board as a picture saved in the board's folder. |
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
   the **docked** host wraps the store (`readBoard` / `saveBoard`, `importBoardPictures`, `preview`), the **floating** host wraps the bridge in a second
   window. A board is open in one place at a time: popping out leaves a placeholder docked, closing the window gives it back. That
   avoids two writers (the vault watcher does not echo a window's own writes, so a live two-window sync would need its own bus).
6. **The floating window is a second HTML entry** (`board.html`) loading only the board view, in the default session as the brain
   window (same security: no network in production, every permission refused) but with a **preload of its own** (`board-preload.cts`:
   the board calls, the pictures, the clipboard, the flush handshake, nothing else; main also answers it no other channel,
   `BOARD_PAGE_CHANNELS`, so a page that sends one by hand is refused). The page decodes pictures from the user's folders, so it is the
   page to give the least: a bridge with the whole vault would turn a broken decoder into a way to read, change and delete the
   vault. It never boots a vault: it must not call `openVault`, `listFiles` or anything that restarts the watcher. Its saves go
   through `board:save`, which compares the note with the text the save was made from and writes in one step in main, *without*
   telling the watcher to ignore it, so the brain window sees the change like any outside edit.
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

- The board is the first `## Board` heading (outside code fences and comments) and the lines from there to its **last item line**, plus
  the lines that follow that one with no blank line in between; a heading of level 1 or 2 ends the search, but the span does not run
  on to it: a blank line after the last item starts the user's text. After a blank line a bullet counts as an item only when it looks
  like one the board writes (`writtenLike`: attributes, text after ` » `, a picture file), so `- note the colours` stays the user's.
  `serializeBoard(doc, raw)` rewrites exactly that span (adding the heading at the end when missing) and returns everything else
  byte for byte, the text after the last item line included; frontmatter is patched with the existing in-place helpers (`title`,
  `type`, `updated`).
- One item per list line, back to front. First token after `- ` is the kind: `view`, an embed `![[path]]`, `pic` (a picture whose
  path cannot be embedded), `note`, `stroke`, `line`, `rect`, `ellipse`. Then `key=value` pairs separated by single spaces and bare
  flags (`gray`, `lock`, `arrow`). Numbers are written with at most 2 decimals (crop edges and mark widths with 3, the zoom with 4), trimmed. Colours are 6 hex digits
  with **no `#`** (a `#ff8800` in the body would become a vault tag). `g=` is a group label (renumbered from 1 on every write).
  `flip=` is `h`, `v` or `hv`. `r=` is the rotation in degrees. `op=` is opacity. A 3D model's line (a `pic` line, never an embed) may carry
  `yaw=` and `pitch=`, the camera's place round it in degrees with one decimal, written after `crop=` and only when they differ from the view
  its still is drawn from (35 and 24); core's `normaliseView` is the one rule that keeps the view in memory the view in the file.
  A model is on the board because a board holds `isBoardAssetPath` (pictures, videos and models: `isMediaPath` stays what the thumbnails
  are) and is drawn from its proxy (core's `models/`: `decodeProxy`, `renderProxy`; baked by the thumbnail helper, handed to the board
  window by the one channel `vault:modelProxy`, never the file), turned with the Turn tool (`M`, one history step a drag).
- Text (a note's text, a picture's caption) follows the first ` » ` on the line. It is escaped so the line stays inert markdown
  and one line: `\` → `\\`, a newline → `\n`, and `\` before each of `[ ] # < > | * _ ~ ! \``. No link, tag, task or HTML can
  come out of a note. Reading reverses it exactly.
- A picture is written as an embed `![[path]]` (so the brain links the board to the picture) when its path is safe to embed
  (`safeEmbedPath`): a picture extension; no control character, `#`, `|`, `[`, `]`, `<`, `>`, `\` or backtick; no leading or trailing
  space; no `&...;` character reference; no web address or e-mail address (what a markdown parser turns into its own link); none
  of `*`/`_`/`~` that could pair into emphasis; otherwise as `pic path` with the path escaped and no graph link. Paths are the vault's own picture paths. A picture that is missing from the vault keeps
  its line and its place, and is drawn as a placeholder.
- **A save rewrites every line of the span** from the model (`itemLine`): known attributes in a fixed order, numbers cut to their
  decimals, a note always with `r=` and `fill=`, a rect or ellipse with no fill gaining an empty `fill=`, groups counted again from 1.
  Hand-written lines therefore change on the first save; saving an unchanged board in that form gives `raw` back.
- Lines inside the span that the reader does not understand (a hand-written remark, an item kind of a newer version) and any prose
  between the heading and the first item or between items go to `doc.extra` (a warning for a `- ` line it cannot read, none for
  prose and none for a to-do line) and are written back **right after the last item, in order, without their blank lines**: they are kept, but not in
  place. An attribute or flag it does not know on a line it does is kept on the item (`unknown`, at most 8 a line) and written after
  the known ones (before `pts=` on a stroke), with a warning when read, but only when it is a plain name with a plain value
  (`KEPT_TOKEN`: a name `[A-Za-z][A-Za-z0-9-]{0,31}`, a value `[A-Za-z0-9.,:+-]{0,64}`); a token with any other character (`source=my_file`,
  `ref=a/b`: what a markdown parser would read as a link, tag, emphasis or html) is dropped with a warning. A bad number on a known
  line is ignored for that attribute with a warning, never the line: the default is used, and the next save writes the default in
  its place.
- Everything outside the board's span (the frontmatter apart from the patched keys, the text above, the text after the board's last
  item line up to the end of the note) is returned byte for byte.
- Limits (`BOARD_LIMITS`): 1,500 items, 4,000 characters per note and 3,000 points per stroke that a user can make (a file may hold a
  note of up to 100,000 characters and a stroke of 50,000 points: `noteCharsFile`, `strokePointsFile`; a longer note from a file is
  kept whole and never cut by editing it, `noteCap` in `controller.ts`: the text box takes at most that many characters, a commit of
  the unchanged text changes nothing), and a **size budget** of 500,000 characters
  for the board's items, measured by `boardChars(doc)` / `itemChars(item)` (a cached count per item, within a few characters of what
  `serializeBoard` writes, no serialising per pointer move). Reading a board over a limit keeps the first items and warns. The budget is
  enforced **when the board grows**: any operation that would make `boardChars(next)` exceed it AND exceed `boardChars(current)` is
  refused with the 'limit' toast (*The board is full ...*, naming the budget) by the controller (a stroke, a note, pictures, a paste) and
  by `addPicturesToBoardText` (pictures onto a closed board: as many as fit, the rest counted in `over`). An operation that keeps or
  shrinks the size is always allowed, so a board loaded over the budget can be thinned, never grown. The floating window's whole-note cap
  `MAX_BOARD_TEXT` (`apps/desktop/src/main/board-save.ts`) is 1,000,000 characters, well above it (the prose around the board counts
  there), and `board:open` refuses an over-cap note up front.
- The reader never fails: a note without a board section is an empty board; broken YAML in the frontmatter is not touched and the
  board is treated as an ordinary note (`isBoardNote` is false) so nothing is overwritten.

Saving costs a re-parse of the note and a graph rebuild on the main thread. `parseNote` is board-aware (a board's item lines are read by
the board's own line scan, 6 to 7 ms for a 1,500-picture or a 300-stroke board against 215 to 290 ms through the markdown parser, and
none of their text becomes links, tags or search text; the picture embeds are still the note's links), so what is left of a save in a
big vault is the graph rebuild (a save of a 242 KB board in a vault of 5,000 notes measured about 80 ms on a loaded test machine). The view saves **at most once per second while changing and
once at the end of a gesture** (one that ends within `FINAL_BURST_MS` = 250 ms of the previous final change rides the throttle and
lands within the second; a close, blur, hide, dock or quit flushes), never per pointer move, and not at all for a pan or zoom alone
(the view goes to `localStorage` under the host's `stateKey` and is written into the file with the next real change).

## Core (`packages/core/src/board/`)

Pure TypeScript, no DOM. Exported from `@aether/core`.

- `types.ts`: `BoardDoc`, the item kinds (`PictureItem`, `NoteItem`, `StrokeItem`, `LineItem`, `RectItem`, `EllipseItem`), `BoardView`, `Crop`,
  `TextMetrics`, `BOARD_LIMITS`, `emptyBoard(title)`.
- `text.ts`: `escapeBoardText(s)`, `unescapeBoardText(s)`, `estimateTextMetrics: TextMetrics` (average glyph width 0.55 × size, wrapping
  at spaces, line height 1.25 × size), `NOTE_PADDING`.
- `format.ts`: `parseBoard(raw): { doc, warnings }`, `serializeBoard(doc, raw?, now?)` (merge into `raw` when given, else a fresh note;
  returns `raw` itself when nothing changed), `newBoardNote(title, now)`, `isBoardNote(raw)`, `boardPictures(doc)` (distinct picture paths
  in order), `safeEmbedPath(path)`, `boardFolderName(title)` (the folder a board's pictures live in), `boardPictureName(original,
  mimeType, now)` (a safe file name for a dropped or pasted picture: `ref 2026-10-09 143512.png` when the name says nothing),
  `formatNumber(n, dec)`.
- `geometry.ts`: `itemSize`, `itemCentre`, `itemQuad`, `itemBounds`, `itemsBounds(items, metrics)`, `selectionBounds`, `noteBox`,
  `pointInItem(item, p, tol, metrics)`, `hitTest(doc, p, tol, metrics)` (topmost), `itemsInRect(doc, rect, 'touch' | 'contain', metrics)`,
  `rotatePoint`, `normalizeAngle`, `screenToBoard(view, viewport, p)`, `boardToScreen`, `zoomAt(view, factor, anchorScreen, viewport)`,
  `panView`, `fitView(bounds, viewport, margin)`, `clampView`, `snapMove(doc, movingIds, delta, opts)`, `handlesFor`, `hitHandle`,
  `canRotateItems`.
- `ops.ts`: pure functions `BoardDoc → BoardDoc` (never mutate; unchanged parts keep their identity): `addPicture`, `addNote`,
  `addMark` (each returns `{ doc, id }`, `id` null when the board is full), `insertItems`, `duplicateItems`, `moveItems`, `scaleItems`,
  `resizePicture`, `resizeNote`, `rotateItems`, `flipItems`, `setCrop`, `resetCrop`, `setProps(doc, ids, patch: BoardPatch, metrics)`,
  `group`, `ungroup`, `expandGroups(doc, ids)`, `reorder`, `removeItems`, `lockItems`, `clampDoc`, `BOARD_ITEM_LIMITS`. All skip locked
  items except `lockItems` itself.
- `arrange.ts`: `arrange(doc, ids, mode, opts)` (optimal, row, column, grid, stack; centred on where the units were), `sortOrder`, `align`,
  `distribute`, `normalize`.
- `history.ts`: `History<T>`: `reset(initial)`, `current`, `push(next, { key?, label?, now? })` (pushes with the same `key` within 800 ms
  coalesce, so a run of arrow-key nudges is one step), `undo()`, `redo()`, `canUndo`, `canRedo`, `undoLabel`, `redoLabel`, `size`; 200
  steps.
- `palette.ts`: `hexToRgb`, `rgbToHex`, `luminance`, `textColourOn(hex)`, `dominantColours(rgba, count)` (median-cut), `averageColour`.

## UI (`packages/ui/src/board/`)

- `api.ts`: only types and constants: `BoardHost` (+ `BoardPictureHost`, `BoardWindowHost`), `PointerIn`, `WheelIn`, `KeyIn`, `BoardUiState`,
  `BoardStyle`, `BoardEvent`, `BoardCommandId`, `BoardCommandInfo`, `IMAGE_TIERS`, `ImageSlot`, `ImageSource`.
- `controller.ts`: `class BoardController` — the whole interaction state machine, free of the DOM. `constructor({ doc, metrics?, now?,
  history?, viewport? })`; `state: BoardUiState`; `subscribe(cb)`; `onChange(cb(doc, why: { reason, final, viewOnly }))` (for saving:
  `final` is true at the end of a gesture, false while a drag runs, `viewOnly` for a pan or zoom); `onEvent(cb(BoardEvent))` (toasts,
  sampler requests, palette requests, commands only the shell can carry out); `setViewport(w, h)`, `setView(view)`, `replaceDoc(doc, {
  view? })` (an outside change: a board that holds the same work changes nothing; any other **starts the history again from it**, a
  barrier, so an undo cannot take back what another program wrote; keeps the camera and the selection of items that are exactly what
  they were; counts as saved), `markSaved()`,
  `setStyle(patch)`, `pointerDown/Move/Up/Cancel(e: PointerIn)`, `pointerLeave()`, `blur()`, `wheel(e: WheelIn)`, `key(e: KeyIn):
  boolean` (true when consumed), `exec(id, arg?)`, `addPictures(items: { path, w, h }[], at?)`, `setNaturalSize(path, w, h)`,
  `naturalSize(path)`, `addNoteAt(p)`, `editNote(id)`, `commitNoteText(id, text)`, `cancelNoteEdit()`, `sampleAt(p, hex | null)`,
  `addSwatches(colours, near)`, `dispose()`. It owns tools, selection, drag (move with snapping, scale from handles with aspect lock,
  rotate with snap, crop edges, marquee), pan (middle button, Space+drag, hand tool, two-finger touch, pen barrel button), pinch zoom,
  wheel zoom (and trackpad pan with `⇧`), the draft mark while drawing, eraser, history, dirtiness. *Built as:* a press while a note is
  being edited is dropped (the shell commits the text first); modifier keys held during a drag without movement are not re-applied;
  ids renumber on a reload through `parseBoard`, so the selection survives `replaceDoc` only where they line up.
- `commands.ts`: `BOARD_COMMANDS: BoardCommandInfo[]` (every `BoardCommandId`: title, group, keys, `needs`, `desktopOnly`),
  `commandInfo(id)`, `keyToCommand(e: KeyIn, { tool, editing, cropping })`, `isRepeatable(id)`, `boardHelpRows()` (the cheatsheet rows).
  The rows are the one source of truth: the key map is built by reading each row's `keys` text, so the cheatsheet, the palette, the
  menus and docs/KEYBOARD.md (a test) cannot disagree.
- `imageCache.ts`: `class ImageCache implements ImageSource`: `constructor({ load(path, tier): Promise<{ bitmap, natural? } | null>,
  onLoaded(), budgetPixels?, concurrency?, retryAfterMs?, now? })`, `get(path, wantPx)`, `setVisible(paths)`, `forget(path)`, `clear()`,
  `dispose()`, `stats()`; `pickTier(wantPx, natural)`. `imageLoader.ts`: `createImageLoader(host.pictures)` makes the `load` (previews for
  the two small tiers, the original scaled while decoding past 8192 px).
- `renderer.ts`: `drawBoard(ctx, args: DrawArgs)` — background, grid, pictures (crop, flip, rotation, opacity, grey, smoothing,
  captions), notes (real text metrics), marks, selection box and handles, guides, marquee, draft, sampler loupe, missing-picture boxes;
  `visiblePictures(doc, view, viewport, metrics)`; `canvasTextMetrics(ctx)`; `exportBoard(doc, ids | null, scale, images, makeCanvas,
  metrics, opts?)` → canvas (the same draw function, a pass of full-size bitmaps at a time); `HANDLE_PX`, `ROTATE_STALK_PX`.
- `active.ts`: two small registries that join the pieces without importing each other. The **active board**
  (`setActiveBoard({ path, exec, state, flush })`, `getActiveBoard()`, `subscribeActiveBoard`): the mounted board view announces itself so
  the palette, the docked host and the pop-out code can run a command, read the selection or flush a save without a reference to the
  React tree. The **window control** (`setBoardWindowControl(control)`, `getBoardWindowControl()`, `subscribeBoardWindowControl`): the
  desktop app announces how the floating window is driven (`BoardWindowControl`: `available`, `status()`, `subscribe`, `popOut(path)`,
  `dock()`, `setAlwaysOnTop`, `setOpacity`, `onReturned(cb(path))`, `setFlush(fn)`), so the docked view can offer pop-out and show *this
  board is open in its window* without importing the desktop app.
- `BoardView.tsx` + `view/`: the React shell over a `BoardHost` (`{ host, className? }`, `initialRaw?`): canvas (pointer, wheel and key
  listeners, `{ passive: false }`, `touch-action: none`, pointer capture), toolbar (tools, style panel, Edit / Arrange / View / Export
  menus, add pictures, window controls from `host.window`), status bar (zoom, item count, saved / saving / not saved), picker (the vault's
  pictures, windowed, searchable, multi-select), note editor (a text box over the note), context menu, info card, cheatsheet, drop and
  paste handling (stops the window's drop zone from importing the same files; web addresses get a toast), save scheduling, external-change
  reload. The engine behind it is `view/boardSession.ts` (load, controller, cache, saving, events); a test pins each part.
- `boardRegistry.ts`: pure helpers of the app side: `listBoards(notes)` (notes whose frontmatter type is `board`, newest first), `boardStem`
  / `uniqueBoardStem` (a new board's name), `boardFolderOf(path)` (a board's own picture folder, the same one the floating window uses),
  `summarizeBoard(path, raw)` (what a card shows), `addPicturesToBoardText(raw, items)` (pictures onto a board that is not open: the most whose
  arranged board fits the size budget, found by halving, with `added`, `skipped`, `full` (item limit) and `over` (budget) counted; `BOARD_BUDGET_TEXT` is
  the budget as the messages say it), `fitPictureSize`, `pictureAspect`, `PreviewUrls` (bounded object URLs of the list's previews),
  `BoardChangedOutsideError`.
- `dockedHost.ts`: `createDockedBoardHost(path): BoardHost & { dispose() }` — the host over the store (see below).
- `BoardsView.tsx`: the Boards view. A wrapper that renders nothing while the view is closed; the list of boards (cards in pages of 24, a
  collage of up to 4 pictures per card loaded only while the card is in view, a search box, a *New board* tile, an empty state); and an
  open board: a breadcrumb over `<BoardView host={createDockedBoardHost(path)} />` inside an `ErrorBoundary`, or, while the floating window
  has that board, a card with *Bring it back* and the window's on-top and opacity state. The card belongs to the open board only: the
  list draws every board the same (a ⧉ pop-out button on its card) whether the window has it or not, so a pop-out from the list shows
  nothing in the app until that board is opened. It registers the active board's `flush` with the
  window control (`setFlush`) so that popping out waits for the pending save (a `false` answer, a save that could not be made, stops the
  pop-out). *Built as:* a board whose note disappears (deleted or moved by a sync tool or git) is **not** closed: the view keeps it
  open with the title and path the note had, a notice (`role="status"`) and one toast, its saves are refused (the session offers *Copy
  board text*), and it takes the note back when it returns. The panels of the list and of an open board are `.panel-solid` (the 3D view
  behind them is not drawn, see the store).

### The docked host

`createDockedBoardHost(path)` over the store's actions (components never touch adapters):

| `BoardHost` | Docked |
| --- | --- |
| `load()` | `store.readBoard(path, opts?)`: the file as it is on disk (a pending editor draft is saved first, a change the watcher has not reported is applied). Resets "changed outside". `readBoard` toasts "Could not open the board: …" when the note is not in the vault, is gone from the disk or is no board; `{ quiet: true }` leaves those toasts out, for a reload of a board that is already open (its view has said what became of it; the host answers a note that has gone since it was read with an error named `BOARD_GONE`, which the session does not say again). |
| `save(raw, expectedBase?)` | `store.saveBoard(path, raw, expectedBase ?? lastKnown)`: runs in the note's exclusive queue; `expectedBase` is the text `raw` was made from, so a reload that landed in between cannot make a stale text look fresh. Refuses with `BoardChangedOutsideError` (message contains "changed outside") when the file holds neither that text nor `raw`; the host then refuses every save until `load()` reads the note again, and **every refusal tells the external-change callbacks again** (a reload that failed because the note was edited into a non-board can succeed once it is put right). Also refuses when the editor holds unsaved edits of the note, the vault is read-only, the note is gone, `raw` is not a board, or (when nothing was expected) the note on disk is not a board. Saves are serialised. Never toasts (the view does). |
| `stateKey` | the vault's location and the path: what the app's memory of the board (its camera, the copy of an unsaved board) is kept under, so a board of the same path in another vault is another board. The docked host only: the floating host has none, so the session falls back to the note's path, and the window's camera and copy are kept per path (not per vault) and apart from the docked view's. |
| `onExternalChange(cb)` | follows the store's copy of the note; ignores the last 4 texts it read or wrote (its own saves, and a slow watcher's late echo of them); a deleted note is reported too. Listens only while somebody is subscribed. |
| `pictures.preview` / `original` | `store.preview(path, px)` / `store.readPicture(path)`: the whole picture (`VaultAdapter.readAsset`), or, on an adapter that has `readAssetChecked` (the desktop's), a rejection carrying `reason` (`'missing'`, `'too-large'` for a file over 64 MiB or a header that claims over 150 megapixels, `'unreadable'`), which the picture cache keeps so the placeholder says *too large to show* rather than *can't be read*; the web and memory adapters give a picture or null. |
| `pictures.add(files)` | `store.importBoardPictures(path, files)`: create-only into `boardFolderOf(path)`, one graph rebuild for the batch, nothing selected, no success toast, one answer per file (`null`: refused or failed); a folder the vault refuses (`excluded from the vault`) is replaced by `<folder> pictures` from then on. |
| `pictures.list()` / `exists(p)` | pictures of `store.assets` (videos left out) / `assets.has(p)` |
| `pictures.open` / `reveal` / `showInBrain` | `store.openImage` / `store.reveal` (present only where the vault can) / `store.showPicture` (leaves the view, selects the picture's node, flies there) |
| `pictures.onChange(cb)` | `store.assets` changed |
| `toast`, `copyText` | `store.toast`; `copyText` from `components/pictures.ts` (browser clipboard, else the desktop bridge) |
| `window` | built from `getBoardWindowControl()` (`floating: false`; `popOut()` calls `control.popOut(path)`; settings shown at once and corrected by the control's state); absent when no control is registered (the web) |

### Store (`packages/ui/src/store.ts`)

`View` gains `'boards'` (also in `COVERING_VIEWS`, exported with `FULL_PANEL_VIEWS`: `projects` and `boards`, the views that fill the window; `App.tsx` calls `controller.setCovered` from the view alone, so a crashed or closed panel always lets go, and the scene's Canvas frame loop is `'never'` while it is set (`frameloopFor`); the layout keeps running and the first frame after is a plain redraw). State: `boardPath` (the board open in the view; kept when the view is left so `8` returns to
it), `lastBoardPath` (also in `localStorage` per vault). Actions: `boards()`, `openBoards()`, `openBoard(path)`, `closeBoard()`, `newBoard(title?,
{ open? })` (`<home>Boards/<Title>.md` through the create-only note path; title and file name unique: `Title 2`), `addPicturesToBoard(paths,
boardPath?)`, `boardFolderOf(path)`, `readBoard`, `saveBoard`, `readPicture`, `importBoardPictures`, `showPicture`, `showNode(id)` (select and fly, leaving any covering view); `importImages(files,
folder, { quiet })`; `requestForm('board')` asks the list for its new-board form. *Built as:* a board's pictures folder is named like the
note's **file** (what the floating window computes from the path alone), not like its title; `addPicturesToBoard` skips a picture the board
already shows, adds as many as fit the size budget (the message names it), stops with a message when the board open in the view could not
be flushed (`ActiveBoard.flush()` resolves `false`), and on an empty board sets the view to fit the new pictures. `saveBoard` also
refuses to write a board text over a note on disk that is not a board. The board last open (`aether:board:<location>`) follows a rename. Keys: `8`, `⇧B` (inside the view: up); `Esc` is the board's
ladder first, then closes the view; the global handler ignores every other single key while the view is up. The inspector of a picture
has *Add to board*. Palette: *Boards: open*, *show list*, *new board*, *open the selected note as a board*, *add the selected picture to
the last board* / *to a new board*, and every row of `BOARD_COMMANDS` but the window's as *Board: …* (offered while a board is open and
enough is selected; the window rows are registered by the desktop app, so no title appears twice).

## Desktop (`apps/desktop`)

- **`readAsset`**: `AetherBridge.readAsset(path): Promise<Uint8Array | null>`, channel `vault:readAsset` (in `ipc.ts` and the
  duplicate in `preload.cts`), main handler `v.assetAbs(path)` + `readUpTo(abs, 64 MiB)`, null otherwise; no decoding. Core:
  `VaultAdapter.readAsset?(path): Promise<Blob | null>`; implemented by the Electron adapter (MIME from the extension), the
  File System Access adapter, the memory and demo adapters.
- **Clipboard images**: paste is a DOM `paste` event (the sandbox refuses `navigator.clipboard.read`); drops handle `dataTransfer.files`;
  a dropped or pasted address (text/uri-list, text/html with an `<img src>`) cannot be fetched (no network) and says so in a toast.
- **`src/main/board-window.ts`**: `BoardWindowHost` in the style of `ForgeHost` (no runtime electron import; takes `BrowserWindow`,
  `screen`, the brain window getter, preload path, settings and a save callback). One window, lazily opened, reused, closed with the
  brain window. Options: `alwaysOnTop` (`'floating'` level), `opacity`, normal frame, its own preload (`board-preload.cts`), **no partition**, per-webContents
  guards copied from `createWindow` (`setWindowOpenHandler`, `will-navigate`, `render-process-gone`, reveal on `ready-to-show`).
  Pure helpers: `boardWindowOptions(settings, display)`, `clampBoardBounds`, `boardSettings(raw)` sanitizer (opacity 0.2–1, sizes within
  the display). Settings: `settings.board = { x?, y?, width, height, alwaysOnTop, opacity }` in `settings.json`.
- **IPC** (both `ipc.ts` and `preload.cts`): `board:open(path)`, `board:close()`, `board:status()` → `{ open, path, alwaysOnTop, opacity,
  supportsOpacity }`, `board:configure({ alwaysOnTop?, opacity? })` (applies to the board window; callable from either window),
  `board:save(path, text, expectedBase?)` (see below), `board:read`, `board:assets`, the close handshake `board:flush` (main to page, with a
  token) / `board:flushed` (page to main), events `board:state` (to both windows) and `board:closed(path)` (to the brain window).
  `board:save` accepts only a vault `.md` path that is an existing, plain (not a link) file whose head already says `type: board`
  (a missing, empty or ordinary note is refused: it never creates a note and never turns one into a board), and a new text that is
  itself a board note of at most 1,000,000 characters (`MAX_BOARD_TEXT`); it compares the note with `expectedBase` and writes in one call (no read-then-write gap
  between the window and main), with `FsVault.write` and **without** `noteSelfWrite`. `board:open` refuses a note over the cap up front
  with a message, so a window is never opened on a board it cannot read. A window's close (and a move to another board, a vault
  switch, quitting) is held while its page is asked to write what it has not written (`FlushGate`, 1.5 s at most). The window's page
  may use only `BOARD_PAGE_CHANNELS`; main refuses every other channel from it, and on the ones it has it refuses what names another
  board or note: `board:read` and `board:save` only for the path the window shows (`BoardWindowHost.pageRefusal`, applied by `guardIpc`
  to the board page's messages alone; the brain window is not judged), `vault:reveal` only for a picture, a video or that board.
  The window has a menu of its own on Windows and Linux (Close, Edit) and no zoom chord, reload, full screen or DevTools shortcut.
- **`src/renderer/board.html` + `board.tsx`**: mounts `BoardView` with the floating host (reads `?path=`; loads with `board:read`,
  saves with `board:save`; pictures through `thumbnail`, `readAsset`, `createAsset` into the board folder, `listAssets`). Vite
  builds two inputs (`index`, `board`); the CSP meta (with the `%VITE_CSP_*%` placeholders) is repeated. Never calls `boot()` /
  `openVault` / `listFiles`.
- **Docked ↔ floating**: `renderer/board.ts` (the brain window's side) registers a `BoardWindowControl` with `setBoardWindowControl`
  (packages/ui `board/active.ts`) over the bridge: `status()` (the last `board:status` / `board:state` main sent; one object between
  changes), `subscribe`, `popOut(path)` (refuses a note the vault knows is no board, awaits the docked view's flush, stops with a toast
  when the flush fails, then `board:open`; main checks the file too), `dock()` (`board:close`, only when a window is open),
  `setAlwaysOnTop` / `setOpacity` (`board:configure`, opacity kept between 0.2 and 1; works while the window is closed, main keeps it for
  the next), `onReturned(cb)` (`board:closed`: the window stopped showing that board), `setFlush(fn)`. The docked Boards view shows the
  placeholder "This board is open in its window — Bring it back" while `status()` says the window shows its board, loads the note again
  when the window gives it back, and registers the active board's `flush` with `setFlush`. Palette entries (`board-window-pop-out`,
  `board-window-dock`, `board-window-on-top`, `board-window-opacity`: "Board: Pop out to its own window", "Board: Bring the board back
  from its window", "Board: Always on top", "Board: Window opacity…") and the key `w` act on `store.boardPath` and exist only with the
  bridge. `apps/desktop/test/board-ui-wiring.test.ts` drives the real module against a fake bridge.

## Pictures: where they live, and the limits

- A board's pictures go to the folder next to its note named like the note's file (`<home>Boards/<Title>/`; if that name is one FsVault
  ignores — `Library`, `Temp`, `Cache`, `Out`, `Build`, ... — `boardFolderName` adds ` pictures`, and a vault that refuses the folder
  as excluded gets `<Title> pictures` from then on). Names are cleaned (`#|[]<>*_~` replaced by `-`); a pasted `image.png` becomes
  `ref 2026-10-09 143512.png`, `ref ... 2.png` when taken. The docked host adds them through `store.importBoardPictures` (the importer's
  create-only path: file signature checked, ≤ 40 MB, one graph rebuild per batch; nothing is selected and there is no "Added" toast, the
  option `importImages(files, folder, { quiet: true })`); the floating host through `createAsset`. The view takes at most 40 files per drop.
- Pictures already in the vault are referenced where they are (nothing is copied).
- Memory: the cache budget is 128 megapixels of decoded bitmaps and at most 2 loads at once; a picture is only decoded while it is
  in view; off-screen bitmaps are dropped first. 1,500 items maximum.

## Tests

- **Node (run in CI):** `format` (round trips, a fuzzer over every attribute, escape inertness: `parseNote` of a serialised board has
  no links beyond the embeds, no tags, no tasks), geometry and ops (properties: transforms are inverse, locked items are skipped,
  groups move whole), arrange, history, palette, the controller (scripted pointer sequences: marquee, move with snapping, scale from every
  corner, rotate with snap, crop, draw, erase, pan and zoom with mouse, pen and two touches, every command), image cache (tiers,
  eviction, concurrency with fakes) and loader, the renderer against a recording context, the commands table (every id has a row, a key
  that is not taken twice, every key runs its command), the view's engine, menus, picker and session against a fake host, desktop
  (preload/IPC parity, `readAsset` against a temp vault, `board:save` validation, the window host with fake windows, settings sanitiser).
- **Joining the app (node):** `board-integration-store` (boards, new board, open and leave, pictures onto a closed board, read and save with
  the changed-outside refusal, pictures dropped on a board), `board-integration-registry` (names, summaries, placing pictures, preview
  URLs bounded), `board-integration-host` (the docked host: load, save, outside changes and the echo of its own saves, pictures, the
  window), `board-integration-view` (the Boards view as server markup: list, empty state, paging, placeholder while popped out),
  `board-integration-palette` (every board command offered by what is selected, window rows left to the desktop, no repeated title),
  `board-keys` (the global key handler pressed with every key while the view is up, the way in and out, docs/KEYBOARD.md and
  docs/REFERENCE-BOARD.md against the table of keys, the cheatsheet), `apps/desktop/test/board-ui-wiring` (the window control, the
  palette entries and `w` against a fake bridge).
- **Review fixes (node):** `board-fix-integration-registry` (pictures onto a board close to or over its size budget), `board-fix-integration-store`
  (the budget message, a view that could not flush, a board text over an ordinary note, the last-board key through a rename, `showNode`, no
  videos on a board), `board-fix-integration-host` (a save judged against its own base text, a repeated refusal asks for the reload
  again), `board-fix-integration-statekey` (the camera per vault), `packages/graph/test/board-fix-integration-covered` (the scene's frame
  rule and the controller's switch).
- **Round 2 (node, second review):** `board-fix2-integration-store` (`readPicture` rejects with the desktop adapter's reason and the docked
  host with a real picture cache gives *too large to show* once and keeps it; `readBoard` with `quiet`), `board-fix2-integration-docs` (the
  sentences of the guide, the design, the spec and CLAUDE.md about saving, the board's span, the limits, the pop-out card, the page's scope
  and the window's menu, each pinned to the code it describes, the old sentence pinned absent; the spec's NoteType and the demo vault's
  note count against the code), `board-fix2-core-*` (the header reader past 256 KB, Windows device names, the user's remarks between
  items, the words on a board as search text), `board-fix2-ui-*` (a note over the creation limit that is never cut by editing, a drop onto
  a full board that copies nothing, a save and a reload that cross, the close that waits for the reload that heals a refused save, a paste
  event nobody asked for, a Mac Option bracket; in Chromium the long note's text box, the middle button, the sampler's canvas),
  `board-fix2-core-loader` (the 150-megapixel gate in the loader and in Chromium with real flat JPEGs) and
  `apps/desktop/test/board-fix2-desktop-*` (the page may name only the board it shows, the banner that comes down by itself, the window's
  menu and its fixed zoom, a board opened while the window holds its close).
- **Chromium (local, skipped without a browser):** `board-fix-integration-chromium` mounts the whole app on software GL with the compiled
  stylesheet and counts WebGL draw calls: none behind the Boards view and the Projects board, drawing again when they close, still
  drawing behind review and capture; the panels over a paused scene are solid; Shift+Enter in the palette steps out of the Boards view;
  the top bar is one line from 1100 px to 1920 px. And: the canvas renderer draws a known board and pixels are checked; pointer drags through
  `page.mouse`; the BoardView with a fake host (drop, paste, picker, note editing, save debounce); `board-integration-dom` the Boards
  view with the real store and keys (lazy previews that scroll away, open and leave by key, the new-board form, the placeholder and
  the return, an outside change, a deleted note that keeps its board open, the flush before a window opens).
- **Real Electron (by hand / the harness in the scratchpad):** the floating window opens on top, opacity applies, a drop adds pictures,
  a save is seen by the brain window.
