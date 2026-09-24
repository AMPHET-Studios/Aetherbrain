# Keyboard

Every feature has a key. `⌘` is `Ctrl` on Windows/Linux. Single keys are ignored while you type in a text field; chords (`⌘K`, `⌘N`, `Alt ←`) work everywhere.

## Everywhere

| Key            | Action                                            |
| -------------- | ------------------------------------------------- |
| `⌘ K` · `/`    | Search neurons & commands (palette)               |
| `⌘ N` · `c`    | Quick capture → Inbox                             |
| `d`            | Open (or create) today's daily note               |
| `1` `2` `3` `4` `5` | Graph · Editor · Capture · Search · Review   |
| `?`            | Keyboard cheatsheet                               |
| `Esc`          | Close overlay → close editor → clear filters → deselect (first thing that applies) |
| `Alt ←` / `Alt →` | History back / forward                         |

## Graph

| Key / gesture        | Action                                          |
| -------------------- | ----------------------------------------------- |
| drag · scroll        | Orbit · zoom (zooms toward the cursor)          |
| click · double-click | Select · open in editor                         |
| drag a neuron        | Pin it somewhere else (physics adapts)          |
| click a ghost `+ Title` | Create the missing note in Inbox             |
| `e` · `Enter`        | Open selected in editor                         |
| `f`                  | Fly to selected                                 |
| `Tab` · `⇧ Tab`      | Cycle through the selection's neighbors (or jump to the biggest hub if nothing is selected) |
| `← → ↑ ↓`            | Orbit camera · with `⇧`: pan                    |
| `+` `−`              | Zoom in / out                                   |
| `Home` · `0`         | Fit the whole brain in view                     |
| `t`                  | Constellation ↔ Orbit layout (rings = age, newest at the core) |
| `m`                  | Color mode: area → type → tag → age             |
| `b`                  | Bloom on/off                                    |
| `l`                  | Hub labels on/off                               |

Legend chips (bottom-left): click an area or tag to filter (dims everything else); `⇧`-click a tag to show its **field** — a translucent sphere around the tag's centroid. Inspector tags: click = field, `⇧`-click = filter.

## Palette

| Key         | Action                                      |
| ----------- | ------------------------------------------- |
| `↑` `↓`     | Move                                        |
| `Enter`     | Open note / run command                     |
| `⇧ Enter`   | Select + fly, keep the editor closed         |
| `⌘ Enter`   | Turn the query into a graph filter          |
| `Tab`       | Toggle `>` command mode                     |
| typing a title that doesn't exist | offers "Create neuron …" |

Pseudo-queries: `is:orphan`, `is:stale`.

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

## Commands (palette `>`)

Move note → Projects / Areas / Resources / Archive · Set status → evergreen / seedling · Delete note · Reload vault from disk · Re-run layout physics · everything above.
