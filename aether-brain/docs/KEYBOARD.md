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
| `1` `2` `3` `4` `5` `6` | Graph · Editor · Capture · Search · Review · Projects |
| `p`            | Projects board (with a ★ project star selected: that project's board) |
| `u`            | The newest toast's action: *Undo* (a ticked brief task, a deleted task) or *Show* (pictures just imported, a Concept Forge critique) |
| `?`            | Keyboard cheatsheet                               |
| `Esc`          | Close overlay → close editor → clear filters → deselect (first thing that applies) |
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
| `b`                  | Bloom on/off                                    |
| `l`                  | Hub labels on/off                               |

Legend chips (bottom-left): click an area or tag to filter (dims everything else); `⇧`-click a tag to show its **field** — a translucent sphere around the tag's centroid. Inspector tags: click = field, `⇧`-click = filter.

## System layout (folders as solar systems)

The default layout. The vault is the sun at the centre; with several roots (e.g. `D:\` and `F:\`) each drive is a sun of its own. A project's home folder is a **★ star**, folders are **● planets** (folders inside folders are their moons) and notes are the small **· moons** orbiting the folder they live in.

| Key         | Action                                                            |
| ----------- | ----------------------------------------------------------------- |
| `x`         | Expand / collapse the selected folder (show every subfolder, however deep) |
| `[` · `]`   | Show fewer / more folder levels without expanding (1–8, default 3) |
| `o`         | Orbits moving / paused (the camera follows a selected planet while it moves) |
| `⇧ G`       | Star gallery: every picture of the selected ★ star (or of the star the selection belongs to, else the nearest star) floats around it in 3D, and the camera flies there; again: fold it |
| `t`         | Leave / come back to the system layout                            |

**Star galleries.** Fly close to a ★ star (within about two and a half times the size of its system: selecting it and pressing `f` is close enough) and every picture under its folder, subfolders included, grows out of the star as a card on a slowly turning sphere around it, newest at the top (up to 480 more than the ones already orbiting as picture moons). Flying past a star on the way somewhere else opens nothing: the gallery opens once the camera settles near it. Pull back and the cards fold into the star again. Cards are pictures (and videos) like any other: click one to see it in the inspector, `e` opens it in your image app (a video: your video player), `Tab` walks its neighbors. `⇧ G` on a star whose gallery is open folds it until you leave that star; the palette's *Toggle star galleries* turns the fly-close opening off (`⇧ G` still works).

The legend shows the same depth `−` / `+` and the motion switch. Selecting a folder opens the **folder inspector**: its path and counts, its planets (click = fly, double-click = expand) and moons, and buttons for *+ Note here*, *+ Folder here*, *★ Make project* (writes the folder note `<folder>/<name>.md`) or *★ Project board*, *Expand* / *Collapse* and *Reveal* (desktop: show it in Explorer / Finder). In the graph `Tab` walks the neighbors rather than the buttons, so every inspector action has a key or a palette command instead: `p` opens a star's board, `x` expands / collapses, and the palette (`>` folder) has *New note / New folder in the selected folder*, *Make the selected folder a project*, *Open the selected star's project board* and *Show in the file manager*.

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

**Pictures** (png, jpg, webp, gif, bmp, avif) and **videos** (mp4, m4v, mov, webm) are part of the brain: a note that embeds one (`![[gate.png]]`) links to it in every layout, and in the system layout each folder's newest pictures orbit it as **🖼 picture moons**, drawn as thumbnails. Select one to see its preview, where it lives, its size and date, and the notes it is embedded in. A video shows one still frame (a tenth of the way in, at most 5 s) with a ▶ badge — on its moon, its gallery card, its inspector and a note's `![[turntable.mp4]]` — and never plays in the brain: `e` plays it in your video player (desktop). Videos are shown, not imported: copy them into a vault folder and they appear.

| Key / gesture        | Action                                                        |
| -------------------- | ------------------------------------------------------------- |
| `e` · `Enter` · double-click | Open the selected picture in your image app, or play the selected video in your video player (desktop) |
| `Tab` · `⇧ Tab`      | The notes that embed it, and its folder                       |
| drop files on the window | Import pictures into the selected folder, a selected project's *Critique* planet, else `Inbox` — never replaces a file (`gate 2.png`); up to 40 MB each |

The picture inspector has *Open*, *Reveal* (desktop), *Copy embed* (`![[gate.png]]`, the vault path when two pictures share a name) and *Embedded in*; the folder inspector counts a folder's pictures (*12 pictures · 8 shown*) and has *Import pictures…*. Palette commands (type `> picture`): *Import pictures…*, *Open the selected picture in your image app*, *Copy the embed of the selected picture*, *Toggle image moons*, *Toggle picture thumbnails*; and *Today — daily brief*, *Toggle Today hub*.

## Palette

| Key         | Action                                      |
| ----------- | ------------------------------------------- |
| `↑` `↓`     | Move                                        |
| `Enter`     | Open note / fly to folder (over the Projects board: back to the graph first) / run command |
| `⇧ Enter`   | Select + fly, keep the editor closed         |
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
| `q`   | Chat with your brain: it reads your notes, checks in, remembers what you tell it to (see [BRAIN-CHAT.md](BRAIN-CHAT.md)); `Enter` sends, `Esc` on an empty box closes |
| `⇧ L` | Librarian: copy every picture of a folder or drive (`D:\`) into one library (`F:\MASTERIMAGES`) sorted by type, genre and year, tagged by taste, linked into the brain as a star; shows the plan before it copies anything (see [LIBRARIAN.md](LIBRARIAN.md)) |
| `g`   | Concept Forge: open your `concept-forge.html` in its own window; its **🪐 Save to Brain** button (`Ctrl+Shift+B`) files a graded drawing into a project's Critique planet (see [FORGE-LINK.md](FORGE-LINK.md)) |

Inside a panel: `Esc` closes it, its own key closes it too, the other panel's key switches, and `Tab` stays inside the panel. Clicking the vault name in the top bar opens the vault folders panel.

**Games and weird folders stay out.** Mirroring a whole drive skips game libraries (`SteamLibrary`, `Epic Games`, `XboxGames`, `GOG Games`, `Riot Games` …) and every folder that holds an installed game or program, recognised by what sits in it: a store's or engine's file (`steam_api64.dll`, `.egstore`, `UnityPlayer.dll`, a GOG `goggame-…` file, an Unreal `Engine` folder next to an `.exe`), an uninstaller (`unins000.exe`), or a program's `.exe` with its DLLs. A game installed while the brain is open folds out as soon as its files land. The vault folders panel lists what was skipped, with **Show anyway** for a folder that is not a game. Any other folder you don't want: select its planet and press `⇧ H` (or **Leave out** in its inspector). It folds out at once, without a rescan, and nothing on disk changes.

## Commands (palette `>`)

Today — daily brief · Toggle Today hub · Import AI chats (Claude / ChatGPT export)… (`i`) · Import pictures… · Open the selected picture · Copy the embed of the selected picture · Toggle image moons · Toggle picture thumbnails · Star gallery (`⇧ G`) · Toggle star galleries · Move note → Projects / Areas / Resources / Archive · Set status → evergreen / seedling · Delete note · New project · New folder / new note in the selected folder · Make the selected folder a project · Open the selected star's project board · Show in the file manager (a note, folder or picture) · Leave the selected folder out of the brain (`⇧ H`, desktop) · Cycle layout · Orbits moving / paused · Folder levels − / + · Expand / collapse folder · Reload vault from disk · Re-run layout physics · Vault folders · AI link · Chat with your brain (`q`) · New brain chat · Check in with your brain · Librarian (`⇧ L`) · Concept Forge — open · Concept Forge — choose file… (desktop) · everything above.
