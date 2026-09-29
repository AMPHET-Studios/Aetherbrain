# Keyboard

Every feature has a key. `⌘` is `Ctrl` on Windows/Linux. Single keys are ignored while you type in a text field; chords (`⌘K`, `⌘N`, `Alt ←`) work everywhere. `Enter` on a focused button, link or card presses that control only; the `Enter` shortcuts below apply when nothing like that has focus.

## Everywhere

| Key            | Action                                            |
| -------------- | ------------------------------------------------- |
| `⌘ K` · `/`    | Search neurons, folders & commands (palette)      |
| `⌘ N` · `c`    | Quick capture → Inbox                             |
| `d`            | Open (or create) today's daily note               |
| `1` `2` `3` `4` `5` `6` | Graph · Editor · Capture · Search · Review · Projects |
| `p`            | Projects board                                    |
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
| `e` · `Enter`        | Open selected in editor (a folder: expand / collapse) |
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
| `t`         | Leave / come back to the system layout                            |

The legend shows the same depth `−` / `+` and the motion switch. Selecting a folder opens the **folder inspector**: its path and counts, its planets (click = fly, double-click = expand) and moons, and buttons for *+ Note here*, *+ Folder here*, *★ Make project* (writes the folder note `<folder>/<name>.md`) or *★ Project board*, *Expand* / *Collapse* and *Reveal* (desktop: show it in Explorer / Finder). Every button is reachable with `Tab`; the palette has the same actions (`>` folder).

## Palette

| Key         | Action                                      |
| ----------- | ------------------------------------------- |
| `↑` `↓`     | Move                                        |
| `Enter`     | Open note / fly to folder / run command     |
| `⇧ Enter`   | Select + fly, keep the editor closed         |
| `⌘ Enter`   | Turn the query into a graph filter          |
| `Tab`       | Toggle `>` command mode                     |
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
| `e`        | Rename the project (`Enter` saves, `Esc` cancels) — `Projects/Old.md` becomes `Projects/New.md` unless the note is its folder's own note; the old name stays as an alias so `[[links]]` keep working |
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
| `Enter` · double-click | Edit the task text (`Enter` saves, `Esc` cancels)     |
| `Space` · click ☐   | Tick — saved as `- [x] … ✅ YYYY-MM-DD`; untick removes the stamp |
| `Alt ↑` / `Alt ↓`   | Move the task up / down within its section (sub-tasks travel with it) |
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
| `v`   | Vault folders panel: add folders or whole drives (`D:\`, `F:\` …), skip folders, rescan |
| `a`   | AI link panel: let Claude and ChatGPT read and write this brain (see [AI-LINK.md](AI-LINK.md)) |

Inside a panel: `Esc` closes it, its own key closes it too, the other panel's key switches, and `Tab` stays inside the panel. Clicking the vault name in the top bar opens the vault folders panel.

## Commands (palette `>`)

Move note → Projects / Areas / Resources / Archive · Set status → evergreen / seedling · Delete note · New project · New folder / new note in the selected folder · Make the selected folder a project · Show in the file manager · Cycle layout · Orbits moving / paused · Folder levels − / + · Expand / collapse folder · Reload vault from disk · Re-run layout physics · Vault folders · AI link (desktop) · everything above.
