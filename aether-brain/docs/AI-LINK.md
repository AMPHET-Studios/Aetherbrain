# The AI link: Claude and ChatGPT inside your second brain

The AI link lets Claude and ChatGPT talk to your Aether Brain directly. They can
search your notes, read them, see your projects and their to-dos, and (unless you
switch on **Read only**) add notes, tasks and folders for you. Whatever they
change shows up in the 3D brain right away, because they edit the same markdown
files the app shows you.

Nothing goes through an Aether Brain server or account, because there isn't one.
The link runs on your own computer and reads the folders you chose.

- [What the AI can and cannot do](#what-the-ai-can-and-cannot-do)
- [Which setup do I need?](#which-setup-do-i-need)
- [Claude Desktop](#claude-desktop)
- [Claude Code](#claude-code)
- [ChatGPT](#chatgpt)
- [claude.ai in the browser](#claudeai-in-the-browser)
- [Things to ask](#things-to-ask)
- [Every tool](#every-tool)
- [Keeping it safe](#keeping-it-safe)
- [Troubleshooting](#troubleshooting)

## What the AI can and cannot do

**It can:**

- search and read every note in your vault folders, with its links, backlinks and tags
- look at the folder structure: each project is a **star**, and the folders inside a project's folder are its **planets**
- list your projects with their status, progress and next tasks
- capture ideas into your Inbox and create new notes
- add text to a note, or replace one exact passage in it
- add tasks, tick them off (a done task gets a date, like `- [x] Block out the gate chamber ✅ 2026-09-29`), reword them and remove task lines
- create projects, rename them and change their status, summary, tags or folder
- create folders, for example a new planet `Sound` inside your `PORTALz` project folder
- save the conversation you're having as a chat note (*"save this chat to my brain"*), see [AI-CHATS.md](AI-CHATS.md)

**It cannot:**

- **delete files.** No tool deletes a note or a folder. The most it can remove is a single task line, or text inside a note that it replaces.
- **overwrite a file by creating a new note.** A new note is only ever created
  where nothing exists yet, so it can't replace a note the link hasn't seen yet,
  a `README.md` or `CHANGELOG.md`, or a name that differs only in capitals. If a
  name is taken, it adds ` 2`, ` 3`, and so on.
- **create anything except `.md` notes and folders.** It can't create images, scripts or programs.
- **reach outside the folders you chose.** Every path is checked, including symlinks and junctions that point elsewhere.
- **open hidden or system folders.** It always skips `Windows`, `Program Files`, `AppData`, `$RECYCLE.BIN`, `System Volume Information`, dot-folders, `node_modules`, and build and cache folders.
- **open folders you told it to skip.** Where you set this depends on the setup:
  - the app's **AI link** (ChatGPT, claude.ai) uses the folders you excluded in the app (<kbd>v</kbd>);
  - the **Claude Desktop extension** uses its own **Skip these folders** setting. The
    exclusions in the app don't reach it, so list the same folders there;
  - a **config or command copied from the app** (Claude Desktop, Claude Code) contains
    the exclusions from the moment you copied it. After you change the exclusions in
    the app, copy it again and replace the old one.
- **change anything at all when Read only is on.** In that mode it can still search and read.

It works with the same folders the app shows. If you added `D:\` and `F:\` as
roots, the AI sees them as the top folders `D` and `F` (for example
`D/Projects/PORTALz.md`). New notes go into the first root's `Inbox` folder
(`D/Inbox`).

## Which setup do I need?

| You use | What to set up | Does the Aether Brain app need to be open? |
| --- | --- | --- |
| **Claude Desktop** | The Aether Brain extension (`.mcpb`), or a config from the app | No. Claude runs its own copy. |
| **Claude Code** (terminal) | One `claude mcp add` command | No |
| **ChatGPT** (web) | The app's **AI link**, a tunnel, and a connector in ChatGPT | Yes, with the link on |
| **claude.ai** (web) | The same link and tunnel as ChatGPT, then a custom connector | Yes, with the link on |

To open the **AI link** panel, press <kbd>a</kbd> in the desktop app. It has
ready-to-copy settings for every client below, and an **Activity** list that
shows each call an AI makes through the link.

## Claude Desktop

### Easiest: install the extension

1. Download `aether-brain-<version>.mcpb` from the
   [Releases page](https://github.com/YEASTINFECTIONCHEESE/desktop-tutorial/releases)
   (it is next to the Windows installer).
2. Double-click the file. Claude Desktop opens and offers to install **Aether Brain**.
   If double-clicking doesn't work, open Claude Desktop and go to **Settings → Extensions →
   Advanced settings → Install Extension…**, then pick the file.
3. In **Vault folders**, choose your note folders. For whole drives, pick `D:\`,
   then add `F:\` as a second folder.
4. Optionally, in **Skip these folders**, list folder names Claude must never
   open, separated by commas (for example `Private, Taxes`). Every folder with
   such a name is skipped, wherever it is. The exclusions you set in the app
   don't apply to the extension, so repeat them here.
5. Optionally switch on **Read only**.
6. Make sure the extension is enabled. Then start a new chat and ask *"What
   projects do I have in my second brain?"*

The extension carries its own copy of the server, and Claude Desktop runs it
with its built-in Node.js. You don't need to install anything else, and the
Aether Brain app can stay closed.

To change the folders later, go to **Settings → Extensions → Aether Brain**.

If one of the folders is missing when Claude Desktop starts (for example an
external `F:\` that isn't plugged in), the extension skips it and still serves
the others. Once the drive is back, restart Claude Desktop to include it again.

### Alternative: the config from the app

This uses the Aether Brain program you already installed, and needs no download.

1. In Aether Brain, press <kbd>a</kbd>. Under **Connect → Claude Desktop**, copy the config.
2. In Claude Desktop, open **Settings → Developer → Edit Config**. This opens
   `claude_desktop_config.json`.
3. Paste the config. If the file already has an `mcpServers` section, add the
   `"aether-brain": { … }` entry to it instead of a second `mcpServers`.
4. Save the file, then quit and restart Claude Desktop.

The config starts the server with Aether Brain's own program in Node mode
(`ELECTRON_RUN_AS_NODE=1`). If you use the **Portable** exe, this config breaks
because its path changes every launch. In that case, install Aether Brain with
the setup exe or use the extension.

The config lists your vault folders and the folders you excluded in the app
at the moment you copy it. If you change either later, copy it again and
replace the old entry.

**If it doesn't show up,** look at the logs in `%APPDATA%\Claude\logs`, mainly
`mcp-server-aether-brain.log` and `mcp.log`. On a Mac they are in
`~/Library/Logs/Claude`. A line such as `Vault folder not found` tells you what
to fix.

## Claude Code

Press <kbd>a</kbd> in the app and copy the command under **Connect → Claude
Code**. On Windows run it once in **PowerShell** (on macOS and Linux, in
Terminal). It looks like this (your paths will differ):

```powershell
claude mcp add aether-brain --scope user -e ELECTRON_RUN_AS_NODE=1 -- 'C:\Users\you\AppData\Local\Programs\Aether Brain\Aether Brain.exe' 'C:\Users\you\AppData\Local\Programs\Aether Brain\resources\app.asar.unpacked\dist\mcp\aether-mcp.mjs' --vault 'D:\' --vault 'F:\'
```

Use the copied command rather than typing it. Every path is in single quotes,
which PowerShell takes literally, so folder names with `$`, backticks or spaces
stay exactly as they are. It is a PowerShell command: Command Prompt (cmd.exe)
does not understand single quotes.

Then start `claude` in any folder and ask about your notes. `/mcp` shows whether
the link is connected. Add `--read-only` at the end of the command for a
read-only link.

Like the Claude Desktop config, the command contains your folders and
exclusions as they were when you copied it: after changing them in the app,
run `claude mcp remove aether-brain --scope user` and then the new command. It
also contains the path of the Aether Brain program, so with the **Portable** exe
(whose path changes every launch) it stops working; install Aether Brain with
the setup exe instead.

## ChatGPT

ChatGPT runs in OpenAI's cloud, so it can't start a program on your computer.
Instead, Aether Brain runs a small web server on your computer (the **AI link**),
and a *tunnel* gives it a temporary public `https://` address that ChatGPT can
reach.

Custom connectors that can **write** need ChatGPT's **Developer mode**. It is
available on the web for Plus, Pro, Business, Enterprise and Edu plans.

1. **Switch the link on.** In Aether Brain, press <kbd>a</kbd> and turn on **Link on**. The
   panel shows the local URL, `http://127.0.0.1:7457/mcp/<token>`. The long random
   `<token>` part is the password.
2. **Start a tunnel** in a terminal and leave it running. Use one of these:
   - [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
     (free, no account needed for quick tunnels):
     ```
     cloudflared tunnel --url http://127.0.0.1:7457
     ```
     It prints an address like `https://some-random-words.trycloudflare.com`.
   - [ngrok](https://ngrok.com/download):
     ```
     ngrok http 7457
     ```
     It prints an address like `https://abcd-1234.ngrok-free.app`.
   - OpenAI's official tunnel client for developer-mode connectors: point it at the
     local URL above, or let it run the server itself with the same command
     Claude Code uses. Follow OpenAI's instructions to install it.
3. **Turn on Developer mode** in ChatGPT: **Settings → Security and login →
   Developer mode**.
4. **Create the connector.** Go to [chatgpt.com/plugins](https://chatgpt.com/plugins),
   click **+** and create a new one:
   - **Name:** Aether Brain
   - **Connection / MCP server URL:** the tunnel address + `/mcp/` + your token, for example
     `https://some-random-words.trycloudflare.com/mcp/<token>`. The AI link panel
     builds this URL for you under **Connect → ChatGPT**.
   - **Authentication:** No authentication. The token in the URL does that job.
   - Confirm that you trust the connector, then create it.
5. In a chat, pick the **Aether Brain** connector (from the **+** / tools menu in
   Developer mode) and ask away. ChatGPT asks you to confirm before each change it
   makes; read-only tools run without asking.

A quick tunnel gets a **new address every time you start it**. When that
happens, edit the connector and paste the new URL. A named Cloudflare tunnel or
a reserved ngrok domain keeps the same address.

## claude.ai in the browser

This uses the same link and tunnel as ChatGPT:

1. Do steps 1 and 2 of the ChatGPT section: switch the link on and start the tunnel.
2. In claude.ai, open **Settings → Connectors → Add custom connector**. Give it a
   name and paste the same `https://…/mcp/<token>` URL, then click **Add**.
3. In a chat, enable the connector from the tools menu.

## Things to ask

- *"Add a task to PORTALz: block out the gate chamber"*
- *"Create a planet folder Sound under PORTALz"*
- *"What did I finish on ConceptForge this week?"*
- *"Capture this idea: a portal that hums lower the closer you get"*
- *"Which of my projects haven't moved lately, and what's the next task on each?"*
- *"Find my notes about value studies and link the best one to Map of Drawing"*
- *"Rename the project Monolith Generator Asset to Monolith Kit and mark it paused"*
- *"Show me how my F drive is organized, two levels deep"*
- *"Save this chat to my brain, in PORTALz"*

## Every tool

Read tools (always available):

| Tool | What it does |
| --- | --- |
| `vault_overview` | Roots, counts, areas, top tags, most-linked notes, top folders, projects, recent notes |
| `search_notes` | Search by words, optionally inside a folder or with a tag |
| `read_note` | A note in full: properties, text, links, backlinks, tasks with line numbers |
| `list_folder` | A folder as a tree: planets and moons with note counts, project stars marked |
| `list_projects` | Every project with status, home folder, progress and next tasks |
| `get_project` | One project: summary, all tasks (with ✅ dates), planets, notes inside |
| `daily_brief` | Today's brief, as the ☀ Today hub shows it: overdue, due or scheduled today, today's daily note, `#today`, and each active project's next task, with the note and line to tick it off with `set_task_done` (optional `date`) |
| `related_notes` | Notes a note links to, notes linking to it, and similar notes |
| `recent_notes` | Recently changed notes, optionally within some days or a folder |
| `search` / `fetch` | The same search and read in the shape ChatGPT's connectors expect |

Write tools (hidden when the link is read-only):

| Tool | What it does |
| --- | --- |
| `capture` | Save a quick idea as a new note in the Inbox |
| `create_note` | A new note (Inbox by default, or any folder); never overwrites |
| `append_to_note` | Add text at the end of a note, or under a heading |
| `edit_note` | Replace one exact passage (it must appear exactly once) |
| `update_frontmatter` | Set or remove properties such as status, tags or aliases |
| `add_task` | Add `- [ ] task` under a project's `## To do`; the reply lists the tasks with their current line numbers |
| `set_task_done` | Tick a task off with today's ✅ date, or reopen it |
| `edit_task` | Reword a task; its checkbox and date stay |
| `delete_task` | Remove one task line (the tasks below it move up a line; the reply lists the new line numbers) |
| `create_project` | A new project note with summary and tasks, plus its home folder |
| `update_project` | Rename (the old name stays as an alias, so links keep working), status, summary, tags, folder |
| `create_folder` | A new folder, such as a planet inside a project's folder |
| `link_notes` | Add `- Related: [[other note]]` to a note |
| `save_chat` | Save the conversation as a chat note: a summary on top (its links and `- [ ]` tasks count), then the transcript, under `AI Chats` or a project's `AI Chats` planet. Given the chat's web address, saving again updates that chat note: a new summary, and a new transcript only when there are more messages ([AI-CHATS.md](AI-CHATS.md)) |

The task tools name a task by its line number or its text. If the note changed
after the AI listed its tasks (you edited it in the app, for example), a task
given only by its line is found again by its text; if that isn't possible, the
tool changes nothing and replies with the current lines.

## Keeping it safe

- **The token is a password.** Anyone who has the full link URL can use your brain
  while the link and a tunnel are running. Don't post the URL, and don't paste it
  anywhere except your own connector settings.
- **Get a new token** with **New token…** in the AI link panel if the URL may
  have leaked. The old URL stops working at once. Then paste the new URL into
  ChatGPT or claude.ai. Claude Desktop and Claude Code don't use the token, so
  they aren't affected.
- **Turn the link off when you don't need it,** and stop the tunnel (press Ctrl+C
  in its window). Without the tunnel, the link is only reachable from your own
  computer. It listens on `127.0.0.1` only.
- **Use Read only** when you just want answers. This applies to the app's link,
  the extension setting and the `--read-only` flag.
- **Watch what happens.** Every call through the link shows up in the Activity
  list and as a toast, and the brain flies to the note that changed. Since
  everything is plain markdown, you can always open the file and fix it. If you
  use git, OneDrive or Dropbox version history, those keep older versions too.

## Troubleshooting

- **"Port 7457 is already in use"**: another app (or a second Aether Brain) uses
  that port. Pick another port in the AI link panel, and use the same port in the
  tunnel command.
- **"The AI link server is missing"**: reinstall Aether Brain. If you build it
  from source, run `pnpm build:mcp` in `apps/desktop`.
- **Claude Desktop shows no Aether Brain tools**: make sure the extension is
  enabled, restart Claude Desktop, and check `%APPDATA%\Claude\logs\mcp-server-aether-brain.log`.
- **One drive is missing from the answers**: the log says `Vault folder not found:
  F:\ (skipped; the other folders are served)`. That drive wasn't reachable when
  Claude Desktop started. Plug it in and restart Claude Desktop.
- **ChatGPT says it can't connect**: check that the link is on, that the tunnel
  window is still running, and that the connector URL uses the tunnel's *current*
  address and ends in `/mcp/<token>`.
- **The first answer takes a while on a whole drive**: the first time, the server
  reads every note on `D:\` and `F:\`. After that, it keeps up with changes as
  they happen.

### Running the server by hand

The server is one file, `aether-mcp.mjs`. It is inside the app at
`resources\app.asar.unpacked\dist\mcp\`, and inside the `.mcpb`, which is a zip
file. It runs with Node.js 20 or newer:

```
node aether-mcp.mjs --vault "D:\\" --vault "F:\\"                   # stdio, for any MCP client
node aether-mcp.mjs "D:\\" "F:\\" --read-only                        # folders can also be given bare
node aether-mcp.mjs --vault "D:\\" --http --port 7457 --token <secret>  # HTTP link for a tunnel
```

Options: `--vault <folder>` (repeatable), `--read-only[=true|false]`,
`--exclude <folder name>` (repeatable, one exact name each),
`--exclude-list "<name>, <name>"` (several names separated by commas), `--http`, `--port <n>`,
`--host <address>` (default `127.0.0.1`) and `--token <secret>` (16 or more
characters from `A–Z a–z 0–9 - _`; a random one is made when you leave it out).
In HTTP mode the server prints its local URL. `AETHER_VAULT` (folders separated
by `;` on Windows, `:` elsewhere) is used when no folder is given. A folder that
is missing at start is skipped with a warning; the server only stops when none
of the folders is there.
