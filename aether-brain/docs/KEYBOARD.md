# Keyboard

Every feature has a key. `⌘` is `Ctrl` on Windows/Linux. Single keys are ignored while you type in a text field; chords (`⌘K`, `⌘N`, `Alt ←`) work everywhere. `Enter` on a focused button, link or card presses that control only; the `Enter` shortcuts below apply when nothing like that has focus.

## Everywhere

| Key            | Action                                            |
| -------------- | ------------------------------------------------- |
| `⌘ K` · `/`    | Search neurons, folders & commands (palette)      |
| `⌘ N` · `c`    | Quick capture → Inbox                             |
| `y` · `7`      | Today: fly to the ☀ Today hub and show the daily brief (turns the hub on if it was off) |
| `d`            | Open (or create) today's daily note               |
| `i`            | Import your AI chats: pick the Claude / ChatGPT data export (.zip) — see [AI-CHATS.md](AI-CHATS.md) |
| `⇧ I`          | The **✚ Bio star**: fly to it. With none yet, a toast offers to make it (`u` or its button), or use the palette's *Create my Bio star* — see [The Bio star](COSMOLOGY.md#the-bio-star) |
| `1` `2` `3` `4` `5` `6` | Graph · Editor · Capture · Search · Review · Projects |
| `8` · `⇧ B` | Boards: reference boards, the board you were on or the list of boards — see [Reference boards](#reference-boards) |
| `p`            | Projects board (with a ★ project star selected: that project's board) |
| `u`            | The newest toast's action: *Undo* (a ticked brief task, a deleted task) or *Show* (pictures just imported, a Concept Forge critique) |
| `?`            | Keyboard cheatsheet                               |
| `Esc`          | Close overlay → close editor → clear filters → deselect (first thing that applies); over a board, the board's own Esc ladder goes first |
| `Esc` on a crash notice | Close the part of the app that crashed (the same as its Close button) |
| `Alt ←` / `Alt →` | History back / forward                         |

## Graph

| Key / gesture        | Action                                          |
| -------------------- | ----------------------------------------------- |
| drag · scroll        | Orbit · zoom (zooms toward the cursor)          |
| click · double-click | Select · open in editor (a folder: expand / collapse it) |
| drag a neuron        | Pin it somewhere else (physics adapts; in the system layout its moons come along) |
| click a ghost `+ Title` | Create the missing note in Inbox             |
| `e` · `Enter`        | Open selected in editor (a folder: expand / collapse · a picture: open it in your image app · a video: play it in your video player · the Today hub: focus its first task) |
| `f`                  | Fly to selected                                 |
| `Tab` · `⇧ Tab`      | Cycle through the selection's neighbors (a folder: its parent, planets and moons; nothing selected: the biggest hub) |
| `← → ↑ ↓`            | Orbit camera · with `⇧`: pan                    |
| `+` `−`              | Zoom in / out                                   |
| `Home` · `0`         | Fit the whole brain in view                     |
| `t`                  | Layout: constellation (areas) → orbit (rings = age, newest at the core) → system (folders) |
| `m`                  | Color mode: area → type → tag → age             |
| `z`                  | Picture size: medium → large → extra large icons (also the **M · L · XL** buttons in the legend) |
| `b`                  | Bloom on/off                                    |
| `l`                  | Hub labels on/off                               |

Legend chips (bottom-left): click an area or tag to filter (dims everything else); `⇧`-click a tag to show its **field** — a translucent sphere around the tag's centroid. Inspector tags: click = field, `⇧`-click = filter.

**Every icon does something.** The legend's kinds of body (◉ galaxy, ★ star, ● planet, · moon, ▣ sun, 🖼 picture) are chips too: click one to light up everything of that kind (and `Esc`, or the legend's *clear*, to stop); they combine with the area and tag filters. In an inspector the counts (↗ links out, ↙ backlinks, and a folder's moons, folders and pictures) jump to their lists. The round logo at the top left brings you back to the graph with the whole brain in view (`Home`). The top bar works in every view (Capture, Review, Projects and Boards sit under it, not over it), and the 3D view takes the mouse everywhere the legend and the panels do not.

## System layout (folders as solar systems)

The default layout, a cosmology (see [COSMOLOGY.md](COSMOLOGY.md)). Each drive is a **◉ galaxy** (several roots, e.g. `D:\` and `F:\`, are several galaxies); every folder is a **★ star**, a project's home folder the biggest; pictures, videos and long notes are **● planets** drawn as extra-large thumbnails; small files are the **· moons** orbiting the folder they live in. A **faster orbit** is a more urgent file and a **brighter star** a more urgent system: both come from the open tasks in your notes.

| Key         | Action                                                            |
| ----------- | ----------------------------------------------------------------- |
| `x`         | Expand / collapse the selected folder (show every subfolder, however deep) |
| `[` · `]`   | Show fewer / more folder levels without expanding (1–8, default 3) |
| `o`         | Orbits moving / paused (the camera follows a selected planet while it moves) |
| `⇧ O`       | Calm orbits on / off: urgency still orders the sky, but no orbit runs faster than a normal one (see [Calm mode](COSMOLOGY.md#calm-mode)) |
| `s`         | Open the selected ★ sun one level further: closed → planets → planets and moons → closed (on a planet or moon: its sun). A click on a closed sun opens its planets, and the bar at the bottom of the view picks a level |
| `⇧ S`       | Open every sun, or close every one |
| `⇧ M`       | Sound on / off: a note for every star, planet and moon you click, a run when a sun opens |
| `⇧ G`       | Star gallery: every picture of the selected ★ star (or of the star the selection belongs to, else the nearest star) floats around it in 3D, and the camera flies there; again: fold it |
| `t`         | Leave / come back to the system layout                            |

**Star galleries.** Fly close to a ★ star (within about two and a half times the size of its system: selecting it and pressing `f` is close enough) and every picture under its folder, subfolders included, grows out of the star as a card on a slowly turning sphere around it, newest at the top (up to 480 more than the ones already orbiting as picture moons). Flying past a star on the way somewhere else opens nothing: the gallery opens once the camera settles near it. Pull back and the cards fold into the star again. Cards are pictures (and videos) like any other: click one to see it in the inspector, `e` opens it in your image app (a video: your video player), `Tab` walks its neighbors. `⇧ G` on a star whose gallery is open folds it until you leave that star; the palette's *Toggle star galleries* turns the fly-close opening off (`⇧ G` still works).

The legend shows the same depth `−` / `+`, the motion switch and the ☾ calm switch. Selecting a folder opens the **folder inspector**: its path and counts, its planets (click = fly, double-click = expand) and moons, and buttons for *+ Note here*, *+ Folder here*, *★ Make project* (writes the folder note `<folder>/<name>.md`) or *★ Project board*, *Expand* / *Collapse* and *Reveal* (desktop: show it in Explorer / Finder). In the graph `Tab` walks the neighbors rather than the buttons, so every inspector action has a key or a palette command instead: `p` opens a star's board, `x` expands / collapses, and the palette (`>` folder) has *New note / New folder in the selected folder*, *Make the selected folder a project*, *Open the selected star's project board* and *Show in the file manager*.

## Today & pictures

The **☀ Today hub** is a glowing node that gathers today's to-dos from every note: tasks that are overdue (`📅` date before today), due today, scheduled for today or earlier (`⏳`), written in today's daily note or tagged `#today`, plus the first open task of every active project that has nothing else on the brief (*Next up*). Its beams point at the notes those tasks live in. In the system layout it hangs above the sun. The top bar's **☀ Today N** chip shows the count (a red dot while something is overdue) and flies there too; the brief follows the calendar (checked every minute and whenever the window comes back).

| Key                  | Action                                                        |
| -------------------- | ------------------------------------------------------------- |
| `y` · `7`            | Select the hub and fly to it; the inspector shows the brief   |
| `Tab` · `⇧ Tab`      | With the hub selected: into the brief (first / last task); inside it, from button to button (wraps) |
| `↑` · `↓`            | In the brief: the same button of the task above / below       |
| `Space` · `Enter`    | On a task's tick box: tick it — written as `- [x] … ✅ YYYY-MM-DD` in its own note |
| `u`                  | Undo that tick (while the toast shows)                        |
| `Enter` on ★ chip    | Select the task's project (its ★ star when the graph shows it, else the project note) |
| `Enter` on ↗ title   | Open the task's note in the editor                            |
| `Esc`                | Deselect (leaves the brief)                                   |

Focusing a task lights up its note in the graph. With no tasks the brief says *All clear for today* and how to put things there: `- [ ] Ink the gate 📅 2026-10-01`, `⏳ 2026-10-01`, `#today`, or today's daily note (`d`).

**Pictures** (png, jpg, webp, gif, bmp, avif), **videos** (mp4, m4v, mov, webm) and **3D models** (glb) are part of the brain: a note that embeds one (`![[gate.png]]`) links to it in every layout, and in the system layout each folder's newest pictures orbit it as **🖼 picture moons**, drawn as thumbnails. Select one to see its preview, where it lives, its size and date, and the notes it is embedded in. A video shows one still frame (a tenth of the way in, at most 5 s) with a ▶ badge — on its moon, its gallery card, its inspector and a note's `![[turntable.mp4]]` — and never plays in the brain: `e` plays it in your video player (desktop). Videos are shown, not imported: copy them into a vault folder and they appear.

| Key / gesture        | Action                                                        |
| -------------------- | ------------------------------------------------------------- |
| `e` · `Enter` · double-click | Open the selected picture in your image app, or play the selected video in your video player (desktop) |
| `Tab` · `⇧ Tab`      | The notes that embed it, and its folder                       |
| drop files on the window | Import pictures into the selected folder, a selected project's *Critique* planet, else `Inbox` — never replaces a file (`gate 2.png`); up to 40 MB each |

The picture inspector has *Open*, *Reveal* (desktop), *Copy embed* (`![[gate.png]]`, the vault path when two pictures share a name), *Add to board ▾* (a menu of the newest boards and *New board…*; palette: *Boards: add the selected picture to the last board* / *to a new board*) and *Embedded in*; the folder inspector counts a folder's pictures (*12 pictures · 8 shown*) and has *Import pictures…*. Palette commands (type `> picture`): *Import pictures…*, *Open the selected picture in your image app*, *Copy the embed of the selected picture*, *Toggle image moons*, *Toggle picture thumbnails*, *Picture size* (`z`), *Pictures: medium / large / extra large icons*; and *Today — daily brief*, *Toggle Today hub*.

**Picture size** works like Windows' icon views: *Medium icons* (the brain's first size), *Large icons* (about a big planet, the default) and *Extra large icons* (about a star). The system layout makes room: bigger pictures get wider orbits, so they never cover each other. After a change the camera stays with what is selected (else it shows the whole brain). The choice is remembered.

## Palette

| Key         | Action                                      |
| ----------- | ------------------------------------------- |
| `↑` `↓`     | Move                                        |
| `Enter`     | Open note / fly to folder (over the Projects board or the Boards view: back to the graph first) / run command |
| `⇧ Enter`   | Select + fly, keep the editor closed (over the Boards view, the Projects board, review or capture: back to the graph first, or nothing would be seen to happen) |
| `⌘ Enter`   | Turn the query into a graph filter          |
| `Tab`       | Toggle `>` command mode                     |
| `Esc`       | Close the palette (only the palette: the board under it stays open) |
| typing a title that doesn't exist | offers "Create neuron …" |

Folders match by name or path (up to six, after the three best notes); `Enter` selects the folder and flies there, switching to the system layout when needed. Pseudo-queries: `is:orphan`, `is:stale`.

## Editor

| Key         | Action                                   |
| ----------- | ---------------------------------------- |
| `[[`        | Link autocomplete (`↑` `↓` `Enter`/`Tab`, `Esc` dismisses) |
| `⌘ S`       | Save now (autosaves after 900 ms anyway) |
| `⌘ E`       | Edit → split → preview                   |
| `⌘ Enter`   | Save and return to the graph             |
| `Tab`       | Indent two spaces                        |
| `Esc`       | Close editor (saves)                     |
| click title | Rename the file                          |

**Long notes.** The preview draws the first 60,000 characters of a note; a *Show N more* button under it (reach it with `Tab`, press `Enter`) adds 60,000 at a time, up to 300,000. A note over 400,000 characters (an imported chat of megabytes) opens read-only as that preview, with no text box, so the editor never takes gigabytes of memory; the file is untouched and any text editor can change it.

Preview: wikilinks open the note (ghost links create it), `#tags` filter the graph, `![[embeds]]` render inline one level deep.

## Capture

| Key          | Action              |
| ------------ | ------------------- |
| `⌘ Enter`    | Save to Inbox       |
| `⇧ ⌘ Enter`  | Save and open       |
| `Esc`        | Cancel              |

## Projects

Board keys work when no text field has focus.

| Key        | Action                                                          |
| ---------- | --------------------------------------------------------------- |
| `j` / `k`  | Next / previous project                                         |
| `Enter` · `o` | Open the project note in the editor                          |
| `e`        | Rename the project (`Enter` saves, `Esc` cancels) — `Projects/Old.md` becomes `Projects/New.md` unless the note is its folder's own note or other notes link to it by path (`[[Projects/Old]]`); the old title and file name stay as aliases so `[[links]]` keep working |
| `s`        | Cycle the status: active → paused → done → someday              |
| `f`        | Add a folder (planet) inside the project's home folder — the home folder is created and linked first if the project has none |
| `n`        | Focus the new-task box (`Enter` writes `- [ ] …` under `## To do`) |
| `⇧ N`      | New project (creates `Projects/<name>.md` with a to-do section) |
| `x`        | Show / hide the done list                                       |
| `m`        | Draw one more page of the tasks (a long list is drawn 200 at a time, up to 2,000; also the *Show more* button; a held key draws one page) |
| `u`        | Undo (while the toast offers it, e.g. after deleting a task)    |
| `Tab`      | Move through the board's controls and task rows                 |
| `Esc`      | Back to the graph                                               |

On a focused task row (`Tab` to it, or click it):

| Key                 | Action                                                   |
| ------------------- | -------------------------------------------------------- |
| `Enter` · double-click | Edit the task text (`Enter` saves, `Esc` cancels; if another app or an AI changes the note meanwhile, the save still lands on this task) |
| `Space` · click ☐   | Tick — saved as `- [x] … ✅ YYYY-MM-DD`; untick removes the stamp |
| `Alt ↑` / `Alt ↓`   | Move the task up / down within its section, past the other list's tasks (open and done are listed apart; sub-tasks travel with it); focus follows it |
| `Del` · `Backspace` | Delete the task (no question; the toast has **Undo**, or press `u`) |
| `↑` / `↓`           | Focus the previous / next task                           |

Mouse: hovering a row shows ▲ ▼ ✎ ✕. The header edits in place: click the name, the summary (the `>` line under the title) or *✎ tags*; the status is a select. The home-folder row can *Show in space*, *Change…* (search every folder), *Unlink*, or *Create folder* / *Link existing…*; planets are chips (click = fly). *Archive* moves the note to `Archive/`, *Delete…* asks first. Read-only vaults show all of it without the edit controls.

Task checkboxes in any preview (editor split view, review) are clickable too and write back the same way.

## Reference boards

A **board** is a note of the vault (`type: board`) shown as an open canvas of pictures, text notes and drawn marks (guide: [REFERENCE-BOARD.md](REFERENCE-BOARD.md)). While a board is open it owns the keyboard: its keys are the ones below, and none of the 3D view's single keys (`b`, `l`, `t`, `m` …) also fires behind it. `⌘` is `Ctrl` on Windows/Linux. Every key is also a palette command (`⌘ K`, type "Board"); commands without a key are palette-only. From a board `2` … `7` still switch views, `/` and `?` still search and show the cheatsheet, and a text field (a note being written, the picker's search) keeps its own keys.

| Key | Action |
| --- | --- |
| `8` · `⇧ B` | Open the boards: the board you were on, else the list. Inside the view: from a board to the list, from the list back to the board |
| `n` | In the list of boards: make a new board (name it, `Enter`) |

**Tools**

| Key | Action |
| --- | --- |
| `V` | Select tool |
| `H` | Hand tool: drag to pan |
| `T` | Note tool: click for a text note |
| `P` | Pen (a tablet pen's pressure thickens the line) |
| `L` | Line and arrow |
| `R` | Rectangle |
| `O` | Ellipse |
| `E` | Eraser: removes whole marks |
| `I` | Colour sampler: click to read and copy the colour under the pointer |
| `C` | Crop the selected picture (`Enter` or `Esc` finishes) |
| `M` | Turn a 3D model: drag a model to turn it (`Esc` leaves the tool) |

**Edit**

| Key | Action |
| --- | --- |
| `⌘ Z` | Undo (200 steps) |
| `⌘ ⇧ Z` · `⌘ Y` | Redo |
| `⌘ A` | Select all |
| `Esc` | The ladder: cancel what is under way → leave cropping → select none → back to the select tool; at rest it closes the Boards view |
| `⌘ I` | Invert the selection |
| `⌘ D` | Duplicate |
| `Delete` · `⌫` | Delete |
| `⌘ C` · `⌘ X` · `⌘ V` | Copy · cut · paste. Copied items go on the system clipboard as text that starts with *Aether Brain board: N items copied*, so they paste into another board or window as well; a paste of anything else adds the picture or text the system clipboard holds |
| `⌘ G` · `⌘ ⇧ G` | Group · ungroup |
| `⌘ L` · `⌘ ⇧ L` | Lock · unlock |
| `F2` | Edit the selected note's text (`Enter` does the same when a note is the only thing selected) |

**Order and transform**

| Key | Action |
| --- | --- |
| `⌘ ]` · `]` | Bring to front · bring forward |
| `[` · `⌘ [` | Send backward · send to back |
| `⇧ H` · `⇧ V` | Flip horizontally · vertically |
| `⌘ R` · `⌘ ⇧ R` | Rotate 90° clockwise · counter-clockwise |

**Arrange and appearance**

| Key | Action |
| --- | --- |
| `A` | Arrange menu: optimal, row, column, grid, pile; sort; align; distribute; make the same size |
| `G` · `⇧ G` | Grey the whole board · grey the selected pictures |
| `S` | Smooth or crisp pixels |
| `N` | Captions on or off |
| `B` | Next background colour |
| `⇧ S` | Snap to grid |
| `⌥ ]` · `⌥ [` | More opaque · more transparent |

**View**

| Key | Action |
| --- | --- |
| `Home` · `F` | Fit all |
| `⇧ F` · `Z` | Fit the selection |
| `1` | Zoom to 100% |
| `+` · `=` · `-` | Zoom in · zoom in · zoom out |
| `Tab` | Hide or show the toolbar |

**Pictures**

| Key | Action |
| --- | --- |
| `⌘ O` | Add pictures… (the vault's pictures, with a search box) |
| `Enter` | Open the selected picture in your image program (with a note as the only selection it edits the note, as `F2` does) |
| `⌘ E` · `⌘ ⇧ E` | Export the selection · the whole board as a picture, saved in the board's folder |

**Gestures**

| Key / gesture | Action |
| --- | --- |
| `← ↑ → ↓` | Nudge the selection 1 unit (`⇧`: 10 units) |
| `Space + drag` | Pan |
| `Wheel` | Zoom at the pointer |
| `⇧ Wheel` | Pan sideways |
| `⌥ Wheel` | Pan up and down |
| `Double-click` | Edit a note, fit a picture, or add a note on empty canvas |

Palette only, no key: reset rotation / size / crop / everything, arrange row / column / grid / pile / optimal, sort by name / added / size / shuffle, align and distribute, make the same width / height / size, show at the pictures' own size, show in the file manager (desktop), show in the brain, picture info, extract a colour palette; and on the desktop pop out into its own window (`w` toggles it), dock back, always on top, window opacity. Also: *Boards: open*, *Boards: show list*, *Boards: new board*, *Boards: open the selected note as a board*, and for a selected picture *Boards: add the selected picture to the last board* / *to a new board* (palette only: which board is a choice, and the picture inspector's *Add to board* menu lists them).

## Review

| Key       | Action                                          |
| --------- | ----------------------------------------------- |
| `j` / `k` · `↓` / `↑` | Next / previous item                |
| `1`       | Still true — keep (review interval doubles)     |
| `2`       | Tomorrow                                        |
| `3`       | Archive                                         |
| `p` `a` `s` | Inbox item → Projects · Areas · Resources     |
| `o` · `Enter` | Edit this note                              |
| `Esc`     | Done                                            |

## Desktop app

| Key   | Action                                                                                 |
| ----- | -------------------------------------------------------------------------------------- |
| `v`   | Vault folders panel: add folders or whole drives (`D:\`, `F:\` …), skip folders, bring back folders you left out, see the games and programs skipped, rescan |
| `⇧ H` | Leave the selected folder out of the brain (nothing on disk changes; Undo on the toast, or Bring back in `v`) |
| `a`   | AI link panel: let Claude and ChatGPT read and write this brain (see [AI-LINK.md](AI-LINK.md)) |
| `w`   | Reference board: pop the board you have open out into its own window that stays on top of other windows, or bring it back (`w` in the floating window brings it back too; palette: *Board: Pop out to its own window*, *Always on top*, *Window opacity…*; see [REFERENCE-BOARD.md](REFERENCE-BOARD.md)) |
| `q`   | Chat with your brain: it reads your notes, checks in, remembers what you tell it to (see [BRAIN-CHAT.md](BRAIN-CHAT.md)); `Enter` sends, `Esc` on an empty box closes |
| `⇧ P` | Find projects: looks through the vault's folders (names only) for your projects — Unreal, Unity and Godot projects, git repositories, code projects, folders of Blender, ZBrush, Photoshop … files — and makes the ticked ones ★ stars in one go; in the panel `a` ticks all, `s` the sure ones, `n` none |
| `⇧ L` | Librarian: copy every picture of a folder or drive (`D:\`) into one library (`F:\MASTERIMAGES`) sorted by type, genre and year, tagged by taste, linked into the brain as a star; shows the plan before it copies anything (see [LIBRARIAN.md](LIBRARIAN.md)) |
| `g`   | Concept Forge: open your `concept-forge.html` in its own window; its **🪐 Save to Brain** button (`Ctrl+Shift+B`) files a graded drawing into a project's Critique planet (see [FORGE-LINK.md](FORGE-LINK.md)) |
| `a` → Unreal companion | Switch the companion link on / off: the Unreal Engine viewer (`unreal/`) draws this brain live (see [UNREAL.md](UNREAL.md); its own keys are there) |
| `Enter` | At the Concept Forge star, with its live screen open: open Concept Forge to draw (a click on the screen does the same; when another node is selected, `Enter` opens that one as usual) |

Inside a panel: `Esc` closes it, its own key closes it too, the other panel's key switches, and `Tab` stays inside the panel. Clicking the vault name in the top bar opens the vault folders panel.

**Games and weird folders stay out.** Mirroring a whole drive skips game libraries (`SteamLibrary`, `Epic Games`, `XboxGames`, `GOG Games`, `Riot Games` …) and every folder that holds an installed game or program, recognised by what sits in it: a store's or engine's file (`steam_api64.dll`, `.egstore`, `UnityPlayer.dll`, a GOG `goggame-…` file, an Unreal `Engine` folder next to an `.exe`), an uninstaller (`unins000.exe`), or a program's `.exe` with its DLLs. A game installed while the brain is open folds out as soon as its files land. The vault folders panel lists what was skipped, with **Show anyway** for a folder that is not a game. Any other folder you don't want: select its planet and press `⇧ H` (or **Leave out** in its inspector). It folds out at once, without a rescan, and nothing on disk changes.

**Find projects (`⇧ P`).** Main lists each folder of the last scan once (`src/main/projects.ts`: names only, no file is opened; at most 50 000 folders, shallowest first; the vault's roots, skipped folders and folders like Downloads or OneDrive are not looked into). Sure projects are an engine's project file (`.uproject`, Unity's `Assets` + `ProjectSettings`, `project.godot`), a git repository or a code project's manifest; a folder with two or more art files (Blender, ZBrush, Substance, Photoshop, Krita, Maya, Houdini …) is offered too. Ticked when the panel opens: every folder inside no sure project or star, and of the art folders only the outermost (a project's `SourceArt` is listed, not ticked). **Make N stars** writes each ticked folder's project note (the same note as *Make the selected folder a project*); stars you already have and archived folders are left out. When a vault on disk opens with at most one star, a toast offers this once.

## Commands (palette `>`)

Boards: open (`8` · `⇧ B`) · Boards: show list · Boards: new board · Boards: add the selected picture to the last board / a new board · Board: … (every command of an open board) · Today — daily brief · Toggle Today hub · Import AI chats (Claude / ChatGPT export)… (`i`) · Import pictures… · Open the selected picture · Copy the embed of the selected picture · Toggle image moons · Toggle picture thumbnails · Picture size (`z`) · Pictures: medium / large / extra large icons · Star gallery (`⇧ G`) · Toggle star galleries · Move note → Projects / Areas / Resources / Archive · Set status → evergreen / seedling · Delete note · New project · New folder / new note in the selected folder · Make the selected folder a project · Open the selected star's project board · Show in the file manager (a note, folder or picture) · Leave the selected folder out of the brain (`⇧ H`, desktop) · Cycle layout · Orbits moving / paused · Folder levels − / + · Expand / collapse folder · Reload vault from disk · Re-run layout physics · Vault folders · AI link · Chat with your brain (`q`) · New brain chat · Check in with your brain · Librarian (`⇧ L`) · Find projects (`⇧ P`) · Concept Forge — open · Concept Forge — choose file… · Concept Forge — fly to its star (live screen) · Unreal companion link: on / off · Unreal companion link: status… (desktop) · everything above.
