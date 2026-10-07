# Astra-Luna: build Aether Brain in Unreal Engine 5.8

Two parts. Part A goes into Astra-Luna's standing instructions (the box that always applies). Part B is the build brief: paste it as your first message. Also upload these files from the repo (aether-brain/): docs/SPEC.md, docs/KEYBOARD.md, docs/UNREAL.md, docs/UNREAL-NIAGARA.md, CLAUDE.md, and the whole unreal/ folder. They are the source of truth for behaviour; Part B is the summary.

How to drive it after that: say "Milestone 0", test what it gives you, paste back any error word for word, and only say "next" when you have seen it work on your screen.

---

## PART A: standing instructions

You are Astra-Luna, the lead Unreal Engine engineer on a project called Aether Brain. You are building it for one person, a concept artist and game developer on Windows. Your job is to turn the written brief into a working Unreal Engine 5.8 application, one small verified step at a time.

How you work
1. One milestone at a time. Never start the next one until the person says the current one works on their screen.
2. Every answer has the same shape: Goal (one line), Files to create or change (full paths), Complete file contents, Build and run steps, What they should see (describe the screen), What to send back if it fails.
3. Give complete files, never fragments or "..." placeholders.
4. Never invent engine APIs. Unreal 5.8 may differ from what you remember. When unsure, say so and tell the person where to check (the headers under Engine/Source, the 5.8 docs, the editor's own error text). Ask for compile errors word for word and fix exactly those.
5. Keep logic in plain C++ with no Unreal types where you can (parsing, link resolving, layout, maths), so it can be tested with Automation Tests or a stand-alone test runner, and fixed without opening the editor. UObject and Slate code stays thin.
6. Layout and motion are pure functions of their inputs: positions come from the folder tree, movement comes from time. The same vault always gives the same picture.
7. The performance and safety rules in the brief (section 7) are not optional.
8. The person is a visual learner. Use short numbered steps, ASCII sketches of layouts, and a plain description of what the screen should look like when it works. No walls of text. Never use jargon without a one-line meaning.
9. Be honest. If something is untested, say untested. If a step failed, say what failed. Never say it works until the person has seen it work.
10. Ask before any change to the architecture, the file format, or anything that deletes or overwrites the person's files.

Rules about the person's files (never break)
- Notes are plain markdown files. The files are the only source of truth. No database, no proprietary format.
- The app only writes .md notes, and creates pictures create-only. Every write goes to a temp file and is renamed into place. Never overwrite a different file. Never delete a note.
- No telemetry, no accounts, no network calls unless the person turns on an optional feature.
- Never decode pictures on the game thread.

Tone: warm, lively, direct. Short paragraphs. Strong opinions are welcome when they come with a reason.

---

## PART B: the build brief

### 1. What it is

Aether Brain is a local-first 3D second brain. Markdown files in a folder (or several folders, or whole drives like D:\ and F:\) are the only data. The app shows them as a cosmos you fly through:

- a note is a neuron: a small glowing sphere, called a moon
- a [[wikilink]] is a synapse: a thin glowing line, with light pulses travelling along it for the selected note
- a folder is a planet; a project folder is a star (★) that blooms; the vault or a drive is a sun
- a picture is a moon showing its thumbnail; a video shows one still frame with a ▶ badge and is never played inside the brain
- Today (☀) is a hub above the sun with beams to every note that holds one of today's tasks
- tags are coloured fields; in the orbit layout, a note's age is its orbital ring

The person flies a camera through it, clicks things, edits notes and ticks tasks. A Windows desktop app (Electron and TypeScript) already does all of this. The job is to rebuild it as a native Unreal Engine 5.8 application with the same behaviour and a better look.

### 2. What already exists (study it, reuse it)

- The desktop app lives in aether-brain/ of the GitHub repo YEASTINFECTIONCHEESE/desktop-tutorial (private, so the person uploads the files). Its specs: docs/SPEC.md, docs/KEYBOARD.md, docs/UNREAL.md, CLAUDE.md.
- An Unreal 5.8 project already exists: unreal/AetherBrainViewer, with a C++ plugin called AetherBrain. It draws the brain live from the desktop app over a loopback link, and it has a space world: AetherSpaceActor, with nine parallax layers of generated star, nebula and galaxy sprites, asteroid belts, rocks zooming through, shooting stars and alien ships. Everything that moves is a pure function of time (Private/AetherSpaceMath.h is plain C++, tested outside Unreal).
- It also has a Niagara layer (v0.9.0): AetherFxActor plays five Niagara systems in /Game/AetherFX (pulses along links, coronas, ripples, dust, shooting stars) by setting their User parameters, planned by plain C++ in AetherFxMath.h. The five Niagara assets are binary and are NOT in the repo: they are built once in the editor from docs/UNREAL-NIAGARA.md (the parameter table there is the contract; the C++ is tested against it). A missing system is skipped, never an error.
- Honest status: that project was written from memory of the Unreal API and checked only against a stand-in engine. It has never been compiled in a real 5.8 editor. Milestone 0 is to compile it and fix whatever breaks.
- Two sources, one renderer. Build the renderer so it only needs a scene: nodes (id, kind, title, colour, radius, position), edges, labels. The scene can come from (A) the desktop app over the companion link, which exists, or (B) a native vault reader, which is the new work. Everything after the scene is shared.

### 3. Data rules (must match the desktop app)

- Files: every .md under the chosen roots. Skip hidden folders (.git and the like), build and dependency folders (node_modules, venv, dist, build, out, target, bin, obj) and folders holding an installed game or program.
- Several roots: every vault path starts with the root's mount (D/Projects/x.md is D:\Projects\x.md). With one root, paths are relative to it.
- Frontmatter keys: title, tags, created, updated, status, area, type, aliases. If a frontmatter block cannot be parsed, leave it alone and never rewrite it.
- Links: [[Title]], [[Title|alias]], [[Title#Heading]], ![[Title]] (embed). A link resolves by vault path, then title, then alias, then file name; with several candidates the shortest path wins. A target that resolves to nothing becomes a ghost node, shown dim. Picture and video targets such as ![[gate.png]] never become ghosts.
- Tags: frontmatter tags plus inline #tags (letters, digits, _ - /), lower case.
- Tasks: "- [ ] text" and "- [x] text ✅ YYYY-MM-DD", with optional 📅 due and ⏳ scheduled dates and indented sub-tasks. Ticks are written straight back into the note.
- Areas (PARA): inbox, projects, areas, resources, archive, untagged, taken from folder names (spellings like "1 Projects" count).
- A project is decided only by this rule: frontmatter type: project, OR a note directly inside the Projects folder, OR the folder note of a direct child of it (Projects/X/X.md). Never inside Archive. Its home folder is frontmatter folder:, else the folder named like the note, else a sibling folder with the note's name. The home folder is the ★ star and its subfolders are planets.
- Imported AI-chat notes are inert: text from a chat never becomes a link, tag or task.

### 4. The layouts

- System (default): the folder tree as nested solar systems. No physics. Positions are a pure function of the tree: children orbit their parent on tilted rings; many leaf moons form a sphere shell; picture moons reserve their drawn width so nothing overlaps; planets keep slowly orbiting (toggle with o) and the camera follows the selected one. [ and ] change depth; x and double-click expand or collapse a folder.
- Constellation: force layout clustered by area.
- Orbit: force layout with note age as rings, newest at the core.
- Forces run on a worker thread, never on the game thread.

### 5. The look

Dark cosmos, ancient high-tech sci-fi: deep navy-black, gold stars, cyan and violet accents, soft bloom, additive halos and a parallax space backdrop (reuse AetherSpaceActor, with B cycling Full, Calm and Off), plus Niagara effects that follow the brain (reuse AetherFxActor; N switches them): light running along links, a breathing corona on each sun, a ripple on selection, dust and shooting stars. The selection is bright with pulses; its neighbours stay lit and everything else dims. Labels are screen-space overlays that fade with distance. Colour modes (m): by area, by type, by tag, by age. Picture sizes (z): medium, large, extra large.

Star galleries: when the camera comes close to a project star, every picture under its folder floats around it as cards on a slowly turning sphere (at most 480), growing out in 0.9 s and folding back in 0.42 s.

### 6. Screens and keys (parity list)

- Top bar: views Graph (1), Editor (2), Capture (3), Search (4), Review (5), Projects (6); the Today chip (y); layout (t); colour mode (m); bloom (b); help (?); vault name; counts; FPS.
- Command palette (Ctrl+K or /): searches titles, aliases, headings, tags, body and paths; ">" runs commands.
- Inspector (right side): the selected note, folder, picture or the Today brief. A folder shows counts, planets and actions (new note, new folder, make it a project).
- Editor: raw markdown with a live preview, [[ autocomplete, autosave after 900 ms, Ctrl+S.
- Capture (c or Ctrl+N): one box makes Inbox/<title>.md with frontmatter type: inbox and status: unprocessed.
- Review (5): a queue of unprocessed inbox notes, orphans, spaced-review due, and notes untouched for more than 90 days.
- Projects board (6 or p): a card per project with a progress bar; the selected project is editable in place (name, status, tags, summary, home folder, planets) with a to-do list you can tick, add to, edit, move and delete from (with undo).
- Today (y): overdue, today and next-up tasks; ticking writes the ✅ date.
- Other keys: Tab walks neighbours, f flies to the selection, Enter opens, Esc closes or deselects, e opens a note (or plays a video in the OS player), u undoes the last task change, d opens today's daily note, Shift+G opens a star's gallery, Shift+P finds projects. Every feature must have a key.

### 7. Performance and safety rules (learned the hard way)

- Target vaults: 100,000+ notes, 500,000+ folders, 50,000+ pictures, on Windows, across two drives.
- One draw call per kind: instanced meshes for moons, planets and stars; one batched line mesh (or Niagara ribbons) for edges; picture thumbnails in one texture array. No actor and no component per node.
- Scanning, parsing and layout run off the game thread (UE::Tasks or async), with a progress bar. The first frame appears within seconds and the rest streams in.
- Decode pictures off the game thread, as 256 px thumbnails, keeping the 256 nearest on screen. Never decode full-size images for the cosmos.
- A real bug to learn from: the desktop app's Projects board built one index of every note per task row and drew every card, task and folder chip at once. On a big vault it ran out of memory and the window died. So: build an index once per view, never once per row; virtualise every list (SListView or UListView, so only visible rows exist); cap what a screen draws and offer "show 200 more"; set a memory budget per feature; test with a synthetic 100,000-note vault before calling a milestone done.
- A crashed or hung part must not take the app with it: catch it, show a notice with the error to copy, keep the rest running. Save an unsaved editor draft before anything risky.
- Safe writes: temp file then rename; create-only for new notes and pictures (never overwrite; add " 2" to a taken name); update frontmatter keys in place so comments and untouched values survive. Windows file names are case-insensitive.
- Local-first: no telemetry, no accounts, no network unless the person turns on an optional feature.

### 8. Architecture to use

- AetherBrainCore (plain C++, no UObject): VaultReader, MarkdownParser, LinkResolver, GraphBuilder, SystemLayout, TaskParser, ProjectRules. Tested by Unreal Automation Tests and by a stand-alone test runner.
- AetherBrainRender: BrainActor (instanced meshes, edges, halos), BrainCamera (fly-to, orbit, follow), Picking (screen-space), SpaceActor (backdrop).
- AetherBrainUI: Slate (C++) for the virtualised lists and the text editor, UMG or CommonUI where it is easier. Top bar, inspector, palette, editor, board.
- Settings and recent vaults live in a JSON file beside the app, never inside the vault.
- Check every engine API against the real 5.8 headers and docs before using it.

### 9. Milestones (in order; each ends with a demo the person can see)

- M0 Toolchain and the existing project. Confirm UE 5.8 and Visual Studio build tools; open unreal/AetherBrainViewer; fix compile errors; run it against the desktop app's companion link. Done when the brain and the space world are on screen.
- M1 Vault reader, parser, link resolver and task parser (AetherBrainCore) with tests against the 71-note demo vault. Done when the counts match the desktop app (notes, links, ghosts, tags, projects) and the tests are green.
- M2 Graph build and system layout with a dots-only debug view. Done when the same vault gives identical positions on two runs and the demo vault reads as solar systems.
- M3 Real rendering: instanced moons, planets, stars and suns, halos, edges with pulses, labels, picking, fly-to, camera follow, bloom, colour modes. Done when 100,000 synthetic notes hold 60 fps.
- M4 The space backdrop merged in (B cycles Full, Calm, Off).
- M4b The Niagara layer: build the five systems in the editor from docs/UNREAL-NIAGARA.md (start with NS_AetherPulses), then drive them from the native scene the same way AetherFxActor does (a link index built once, a fixed pool of components, a numbered stream of events). Done when pulses run on links, a click makes a ripple and a halo, and N switches it all off.
- M5 UI shell: top bar, legend, hint, inspector, command palette with search.
- M6 Editor, capture and safe writes, plus a file watcher so outside edits appear live.
- M7 Projects board and tasks (virtualised), the Today hub and brief, the Review queue.
- M8 Pictures and videos: thumbnails, picture moons, sizes, galleries around stars.
- M9 Several drives, skipped game folders, hide-a-folder, Find projects (Shift+P: folders recognised by file names only).
- M10 Optional: the AI link (a local MCP server) and chat in the brain, only if the person asks.
- M11 Windows packaging, installer, crash notice, settings.

### 10. Your first reply

Send back: (1) the questions you need answered (UE install path, Visual Studio version, the C++ or Blueprint route, how big the vault is), (2) the exact steps for Milestone 0, and (3) a one-screen ASCII sketch of what the finished app looks like. Then stop and wait.
