# The cosmology

What every body in the system layout *is*, how it moves and why. This is the contract: the desktop app is the concept that proves it, and the Unreal Engine 5.8 version is built to it. When the two disagree, this page is right and one of them has a bug.

## The six rules

| Your vault | Is | Drawn as |
| --- | --- | --- |
| a **drive** (or the whole vault, when it is one folder), or a **folder you mark** as one (below) | a **galaxy** | the biggest body, a steady glow; what is in it lies on a flat disc |
| a **folder** | a **star** | a glowing body; bigger the more it holds; a project folder is the brightest, biggest kind |
| a **picture, video or 3D model** big enough to matter, or a **document-sized note** | a **planet** | pictures, videos and models as extra-large thumbnails; a long note as a solid sphere |
| every **small file** | a **moon** | a small body on a close orbit |
| a **reference board** with pictures on it | a **sun** | a bright mint-white star of its own, bigger the more pictures it holds; the pictures on it orbit it instead of their folders |
| **how soon it needs you** | **orbit speed** and **star brightness** | a faster orbit; a brighter star for the whole system |

Everything orbits what is above it: files orbit their folder's star, a sub-folder's star orbits its parent star, a drive's stars lie on its disc. Nothing is a star that is not a folder, except a board's sun (below).

## A galaxy is a folder you mark

A drive is a galaxy. So is any folder you choose to make one. Every folder is a **star** by default; a project folder is the brightest, biggest kind of star (**★**); a project folder you mark as a **✦ galaxy** has a disc of its own, with its sub-folders lying on it as stars.

- **The mark** is one line in the folder's project note: `scale: galaxy` (any letter case). No line, or `scale: star`, is a star. The palette's *Make the selected folder a galaxy* and the folder inspector's *✦ Make galaxy* write it (and make the folder a project first, if it is not one); *Make the selected galaxy a star again* and *★ Make star again* take the line away. It is plain markdown in the vault, like everything else, so Claude and ChatGPT see it and it travels with the vault. A galaxy is still a project: it keeps its board card, its tasks and its place in the brief.
- **What a galaxy is.** The biggest kind of body there is after a drive: a radius of 12 to 15 by what it holds (a drive is 16), the cream of a drive, a steady glow that does not follow urgency, always named `✦ Name`, always shown and open on its own. What orbits it lies on a flat disc, like a drive's: its own notes close in, its sub-folders as stars outside them. The disc of a galaxy you marked is tilted a little (up to about 17°, `MARKED_GALAXY_INCLINATION`; a drive's is within 3°) so galaxies are not all in one plate. Under every galaxy (a drive, the vault when it is one folder, a folder you marked) a faint **plate of light with two loose spiral arms** is drawn in that same plane (`scene/galaxyDisc.ts`): one instanced mesh for all of them, fitted to the outermost orbit ring around the galaxy (a little wider, `DISC_SCALE`) so it always matches the rings, following the galaxy as it orbits, added to the light behind it and kept well under the bloom threshold, so it is a plate and never a flare.
- **Where it sits.** A galaxy sits on the galaxy above it, however deep its folder is: on the vault (or its drive) or on another galaxy. The plain folders between stay stars and keep their own planets. In the graph that is the galaxy's `parent`; its `folder.path` is still where it is on disk. The sub-folders of a star keep orbiting that star, and the sub-folders of a galaxy are stars on its disc (always shown, like the folders under a drive).
- **What it takes with it.** What a galaxy holds is no longer counted in the stars it left: their size is measured without it (`shedGalaxies`, `FolderNodeInfo.data` and `weight`), and it is no longer one of their sub-folders for their size. `totalNotes` and `childFolders` still count what is on disk.
- **How far it goes.** Three levels, counting the vault (or a drive) as the first: a galaxy on the vault is the second, a galaxy on that galaxy the third, and a mark deeper than that does not count. At most 64 marks count in a vault: the shallowest first, then by path, whatever order the notes come in (`GALAXY_MAX_LEVELS`, `GALAXY_MAX_MARKS`, `planGalaxies`). A mark that does not count is kept, and its folder stays a star; the inspector says why (`FolderNodeInfo.markIgnored`: `depth`, `count`, or `drive` for a drive or the vault, which are galaxies already). A mark that does not count does not stop the galaxies inside it from counting, and taking the line away is how to be rid of it. The Bio star is never a galaxy.
- **The viewer** is sent a galaxy you marked as a `star` in `kind` (a project folder, exactly as before: a viewer built to the original names keeps working, and a `kind` it does not know is refused), as a `galaxy` in `body`, with its radius as drawn, and its `parent` is the galaxy it sits on. A `galaxy` body always hangs from another galaxy, the origin, or nothing, never from a star. The scene cut treats it as the project star it is (`stars` in the budget, and a kept star always brings the galaxy it lies on).
- **The AI link** (`list_folder`) marks such a folder `scale: galaxy`; an AI writes the mark by putting the line in the project note.
- Code: `packages/core/src/graph/galaxies.ts` (the mark, the plan, the data), `build.ts` (the lift and the numbers), `vault/cosmos.ts` (`isGalaxyNode`), `packages/graph/src/layout/system.ts` (layout role 4), `theme.ts` (`nodeRadius`).

## A star grows with what it holds

A star's size says how much is in it. What a folder holds is counted without looking at the disk, from what the brain already knows, everything under it (the folders inside it included) except what a galaxy took with it, in **note-equivalents**:

> one for each note, one for each sub-folder, one for every thousand words, a quarter for each picture, a half for each video or 3D model

(`dataWeight`, `FolderNodeInfo.weight`; the parts are in `FolderNodeInfo.data` and shown in the inspector as *holds 412 notes · 38k words · 38 pictures · 3 3D models*.) Pictures, videos and models are the ones the vault has listed, so they are a floor on a huge drive, and nothing is stat'ed or scanned for it: a count, not bytes.

The size follows a curve that keeps telling folders apart as they grow: `radius = 3.4 + 4.6 · f`, with `f = min(1, (log2(1 + weight) / log2(1 + 50 000)) ^ 0.75)`.

| holds | plain star | project star | galaxy you marked |
| --- | --- | --- | --- |
| nothing | 3.4 | 4.6 | 12.0 |
| 10 | 4.9 | 6.1 | 13.0 |
| 100 | 5.8 | 7.0 | 13.6 |
| 1 000 | 6.7 | 7.9 | 14.1 |
| 10 000 | 7.5 | 8.7 | 14.7 |
| 50 000 or more | 8.0 | 9.2 | 15.0 |

The size moves in steps of an eighth of a doubling of what a folder holds, so a few more words in a note do not move the star (and do not change the scene a viewer is sent); a change of about a tenth does. The Bio star keeps its own size (9.5 to 11, from the notes, folders and pictures on disk, `nodeRadius`), whatever the weight says. For a vault that is already open, stars with tens to hundreds of notes are smaller than they were (a folder of 100 notes went from 7.4 to 5.8): the whole range of sizes now carries meaning.

The ceilings, and their order, do not move: a drive (16) is bigger than any galaxy you marked (15), which is bigger than the Bio star (11), which is bigger than any project star (9.2), a board sun (9) and any plain star (8). Before this, every folder holding about 200 notes or more was the same size (8). The size feeds the layout (a bigger body asks for a wider orbit), so a folder that fills up pushes its neighbours out, a little at a time.

## A board is a sun

A reference board (`type: board`, the PureRef-style note of [REFERENCE-BOARD.md](REFERENCE-BOARD.md)) that has pictures on it is a **sun**: a star of its own with its pictures orbiting it.

- **Which pictures.** Every picture or video the board links to (its `pic` lines). In the system layout each of them orbits the board **instead of its own folder**; its links stay, and it is no longer one of its folder's moons. A picture on several boards orbits the first board by its path (a stable order); the others keep their links to it.
- **The board.** It orbits its own folder like any note (as a system, among the folder's sub-folders), is drawn bigger the more pictures it holds (radius 4 and a little more for each doubling, at most 9), always named (`▣ Name`), and blooms steadily in mint-white (`BOARD_SUN_COLOR`), whatever the colour mode. Flying to it frames its whole system.
- **Its pictures** are planets like any picture (extra-large thumbnails; a faster orbit when an urgent note embeds them), on rings around it.
- **A board with nothing to hold** (no pictures, only missing files, or every picture already on an earlier board) is a plain note. The other layouts do not change: there a board only links to its pictures.
- **The viewer** is sent the board as a `star` (kind and body) with its pictures as children (`parent`), and the sun's radius, like any other body.

## The Bio star

One star in the sky is the user's own body and mind: the **Bio star**, a big, bright, blue star. It is the `Bio` folder at the vault's home (`Bio`, or `D/Bio` under the first drive of a vault with several roots), and it holds one page each for **Sleep schedule, Food, Meds, Exercise, Drugs and Mental health**.

- **Making it.** The palette's *Create my Bio star* (or the *Make it* on the toast that `⇧ I` shows when there is none) writes the folder and the pages that are missing. It is create-only: a page that is there, under any letter case, is never touched, a deleted one comes back, and nothing is numbered or replaced. The pages are starting points in the user's own voice, headings and empty lists to fill in: no advice, no diagnosis, no phone numbers, nothing about changing a medicine (the coach keeps to the same rules). They hold no task, link or tag in their text, so nothing lands on the daily brief or in the graph by itself.
- **Which folder.** Exactly the folder `Bio` at the vault's home, spelled as the vault spells it (`bio` on Windows is `Bio`). A folder called Bio anywhere else is an ordinary star and a drive named Bio is a drive. A vault with no such folder, that can be written to, shows the star **dormant**: the same blue star, named `✚ Bio`, standing where the folder will be with nothing in it (`folder.placeholder`; `FolderGraphOptions.bioPlaceholder`, which the store asks for), so it can be seen before it is made. Drawing it writes nothing and makes no folder; the inspector's *Make my Bio star* does, and the dormant star becomes the real one in place (the same id, so the selection stays). A dormant star is not a sun (nothing in it to open), it hangs from the galaxy, and a read-only vault has none.
- **How it looks.** The biggest star there is (radius 9.5, a little more for each doubling of what it holds, at most 11; a project star tops out at 9.2, a board sun at 9, a galaxy you marked is 12 to 15, a drive is 16), blue (`BIO_STAR_COLOR` is a deep body colour on purpose: the scene shows colour × glow with no tone mapping, so at the Bio star's glow it comes out a bright blue, where a lighter blue clipped to cyan), with a wider soft aura than any other body (`BIO_STAR_HALO`, 5.4 radii against 3.2) so it is a blue giant from far away too, always named (`✚ Bio`, in the lighter `BIO_STAR_LABEL_COLOR`, which its inspector uses too), burning at one brightness whatever the urgency (`BIO_STAR_GLOW`: more than the most urgent star, a galaxy or a board sun; only the Today hub outshines it). In every other way it is a folder: its pages orbit it, it orbits its drive, and it is always shown while it exists, however deep it sits.
- **The inspector** of the Bio star says what lives there and who could see it, and adds the pages that are missing on a click. On a dormant star it says the star is waiting and that nothing is written until the button is pressed, and the one button makes it.
- **Who could see it.** The pages are plain markdown on this computer, like every note. With Claude as the chat's answerer, whatever the chat reads from them goes to Anthropic; with Ollama nothing leaves the computer ([BRAIN-CHAT.md](BRAIN-CHAT.md#your-bio-notes)).
- **The viewer** is sent the Bio star as a `star` (kind and body) in its blue and its radius, and the scene cut always keeps it with a page or two, like the drives and the Today hub. A dormant one is sent too, as a star with no children.

## Suns open into planets, then moons

A sun (a folder's star, a drive's galaxy, a board's sun) is something you open. A closed sun shows only itself, so a big vault is a field of stars to pick from, not a wall of dots.

| Level | Shows |
| --- | --- |
| **Closed** (0) | the star alone |
| **Planets** (1) | its planets (a big picture, video or model, a long note) and the stars of its sub-folders, orbiting it |
| **Planets + moons** (2) | those and its moons: every small file, and the links to notes that do not exist yet |

- **Always shown.** The galaxy, the folders directly under it (so a closed vault is a field of stars), the Today hub, the selected body, the cards of an open star gallery, and what a search or a filter lights up.
- **Opening.** A click on a closed star opens its planets (its moons, when it has no planets), the camera flies in and a rising run of notes plays. The bar at the bottom of the 3D view then picks *Closed*, *Planets* or *Planets + moons* for the selected sun, with what it holds (`1 planet · 2 folders · 7 moons`); a level it has nothing for is off. `s` steps the selected sun (or the sun of the selected body) through the levels it has something for, `⇧ S` opens every sun or closes every one.
- **Each sun is its own**, and the levels are saved for the vault. A body is shown only while the sun it orbits is shown (`bodyOwners`, `bodyTiers`, `bodyOrder` in `packages/core/src/vault/cosmos.ts`): a sub-folder's planets wait for its own star to open. Counts for the bar come from `sunCounts`.
- **Selecting a hidden body** (a search, a link, `Tab`, back and forward) opens the stars above it as far as it needs, so what you asked for is always there, and the opening is saved like any other.
- **The unfolding.** When a sun opens its bodies grow out of it along their own orbits, and when it closes they fold back into it (about half a second, `REVEAL_SECONDS` in `scene/reveal.ts`); their orbit rings come and go with them, and a link to a hidden body ends at its sun. A fresh scene starts with every body where it belongs.
- **Switching it off** (the palette's *Suns: open on click / always show every planet and moon*) shows every body, always, as before. The other layouts never fold anything: they have no suns.
- **The viewer** is still sent the whole scene: the levels are how the brain window looks at it, not part of the contract it sends.

## The sky

Behind the bodies is a procedural sky, so the brain sits in space and not on a black page: a Milky Way band tilted across the home view with dark dust lanes and a warm bright centre, four soft emission nebulae (rose, teal, violet and gold), two faint galaxies far beyond ours and about 16,000 real stars (sharp however far you zoom: most are pinpoints, a few are bright, and they crowd along the band).

- The soft parts are painted once, when the scene starts, into a cube map and shown on a dome at the far plane that turns with the view and never moves with it; nothing is a file. `scene/skyData.ts` holds the constants and the stars (a pure function of a seed: the same sky every time), `scene/skyShader.ts` the GLSL, `scene/sky.ts` the three.js objects. If the bake fails the scene falls back to a plain haze.
- It stays under the bloom threshold (`SKY_MAX_LINEAR`, 0.6 of 1), so it never glows like a body.
- Orbit rings are drawn brighter than a faint hint (the selected system's brightest), and labels are placed most important first (`scene/labelPlace.ts`): a label that would print on top of one already placed is left out, and last frame's labels are kept when two compete, so names do not flicker.

## Sound

A click on a star, a planet or a moon plays a short note of its own; opening or closing a sun plays a run of notes, rising when it opens and falling when it closes. `⇧ M` turns it on and off (a setting, on by default); the day-planning nudge cards stay silent, as their own contract says.

- **Every body has its own note**, always the same: a hash of its id (FNV-1a) picks a degree of the major pentatonic scale, which has no wrong notes, so any run of clicks is a tune. Big bodies are low and small ones high: a galaxy (as a chord) and a star sound in the octave below middle C, a planet, a picture and a board's sun in the octave of middle C, a moon, a ghost and the Today hub an octave above.
- **Each kind its own instrument**: a star is a warm bell with a soft thump under it, a planet a round pluck, a picture a glassy shimmer, a moon a bright tick, a ghost a soft, quiet pluck, the Today hub and a board's sun sparkle.
- **Everything is made on the spot** with Web Audio (oscillators and a reverb made of decaying noise, a compressor, at most 14 notes at once): no sound file is shipped, nothing is downloaded, nothing leaves the computer. A page with no Web Audio is silent, and the context is only made on the first click (a browser wants one before it will play).
- `packages/ui/src/audio/sounds.ts`; `soundPlan` and `sunRun` are the pure parts, tested as numbers.

## Planet or moon

A file is a **planet** when it is worth looking at as itself:

- a picture, video or `.glb` model of at least **48 KB** (`PLANET_MIN_BYTES`), or one whose size nobody looked at (a whole drive's pictures are not all stat'ed: a picture is a planet until it says it is small);
- a note of at least **3,000 words** (`PLANET_MIN_WORDS`).

Everything else is a **moon**: notes, ghosts (links to notes that do not exist yet), icons and sprites. Folders and the Today hub are never either.

### What a model looks like

A `.glb` (binary glTF, one self-contained file) is drawn as one still by the desktop app itself. The thumbnail helper has no GPU, so a small software rasterizer in its preload draws the model's triangles from a fixed side (a little off the front and above, with one key light), in its materials' base colours (a textured material in its texture's average colour), on a dark ground. A dark model is lifted to a readable level, never by more than three times.

What it does not do, said plainly: textures are not mapped; skins, animation and lights are ignored (the bind pose is drawn); compressed (Draco, meshopt) and sparse geometry is skipped; and a file over 64 MB gets no still (it is still a planet, without a picture). The production viewer is free to draw the real model. The planet and moon rule above is the contract, not the still.

## Urgency

Urgency is a number from 0 to 1: how soon something needs you. It is derived from the **open tasks** a note holds and from nothing else (`packages/core/src/markdown/urgency.ts`); nothing is written anywhere.

| An open task that is … | is worth |
| --- | --- |
| overdue | 0.90, plus 0.025 for each day late, at most 1 |
| due today | 0.85 |
| due tomorrow | 0.70 |
| due in 2 to 3 days | 0.55 |
| due in 4 to 7 days | 0.38 |
| due in 8 to 14 days | 0.22 |
| due later | 0.10 |
| scheduled for today or earlier | 0.60 |
| flagged `#today` | 0.70 |
| in today's daily note | 0.60 |
| open with no date at all | 0.06 |

- A **note** is its most urgent task, plus 0.02 for each other task that is hot (0.15 or more), at most 0.1 extra. Archived notes are 0.
- A **picture, video or model** is the most urgent note that embeds it.
- A **folder** is its whole system (`systemUrgency`): the hottest thing directly in it (a file or a sub-folder's own system), plus up to 30% of what is left for the heat of the others. It saturates on purpose: three hundred calm undated tasks are 0.06, not a fire.

### Orbit speed is urgency

Bodies of the same heat share rings, so a ring has one speed (`packages/graph/src/layout/system.ts`):

- Heat bands: **critical** ≥ 0.75, **urgent** ≥ 0.5, **soon** ≥ 0.2, **calm** below.
- Around a star, from the inside out: **urgent files** (urgency ≥ 0.55: the hottest, fastest, closest in), **moons**, **planets**, then the **stars of its sub-folders**. Inside each group the hottest band comes first.
- A ring's speed is the usual `0.9 / √radius` times `urgencySpeed(u) = 0.55 + 1.45·u`, with `u` the mean urgency of the ring: a calm orbit crawls at 0.55×, an overdue one runs at 2×. **Nothing ever stops**: the sky stays alive.
- Moons beyond 24 go on a Fibonacci shell that turns as one, at the speed of their mean urgency (the urgent ones have left it for their own rings).

### Calm mode

Some days a sky of fast orbits is too much to look at. **Calm mode** (`⇧ O`, the legend's ☾ calm, the palette's *calm orbits*) keeps the same rings, the same order and the same brightness, and holds the speed to a normal orbit's pace:

- A ring's speed is the usual `0.9 / √radius` times `calmSpeed(u) = 0.55 + 0.45·u` instead of `urgencySpeed(u)`: a low-urgency orbit still crawls at 0.55×, an overdue one runs at 1× (`CALM_MAX_SPEED`, a normal orbit), never 2×. A more urgent orbit is still a faster one, just by less.
- It is a clock, not a layout. Every orbit carries `slack`, the speed calm takes off it (0 for an orbit urgency does not speed up), and the brain window counts the seconds spent calm: an angle is `phase + speed · t − slack · calm seconds` (`systemPositions`). So switching calm on or off, or laying the sky out again, moves nothing: an orbit simply turns slower or faster from where it is.
- `o` still pauses everything; calm only changes how fast orbits go while they move. Gallery cards, the Today hub and the roots are not urgency's to speed up, so calm leaves them as they are.
- It is a setting of the brain window: remembered, and off by default. Positions already carry it, so a viewer is sent nothing new and needs nothing. Star brightness, which ring a body is on and the `urgency` number it is sent do not change: urgent things are still the bright, close ones.

### Star brightness is urgency

A star's glow is `calm + heat · U`, with `U` the urgency of its **whole system**: a calm star is a solid body under the bloom threshold; an urgent one blooms. A project star starts higher. A glance at the sky says what is on fire and where, and flying into a bright star shows which of its planets is faster than the others.

## What the viewer is told

The brain window publishes the scene to a viewer (`docs/UNREAL.md`, the companion link). For each node:

| Field | |
| --- | --- |
| `kind` | the original names, **unchanged** so a viewer built to them keeps drawing what it drew: `sun` the vault or a drive · `star` a project folder, a board with pictures orbiting it, or the Bio star · `planet` any other folder · `moon` a note · `picture` · `ghost` · `today` |
| `body` | the cosmology's names, for the viewer built to this page: `galaxy` a drive, a one-folder vault or a folder you marked as a galaxy (its `kind` stays `star`) · `origin` the root of several drives · `star` every other folder and every board sun · `planet` / `moon` a big / small file (a `picture` kind carries one of them in its radius and its size) · `ghost` · `hub` (Today). Absent from older builds: use `kind` |
| `radius` | in the brain's world units (the layout spaces orbits by it) |
| `color` | the colour the brain draws it in |
| `parent` | what it orbits |
| `urgency` | 0 to 1, as above (absent from older builds: draw every orbit at one speed) |

Positions come separately, every frame, from the brain window's own layout: a viewer **never** lays the sky out itself. That is what keeps the concept and the production version the same sky.

## Translating it to Unreal Engine 5.8

The concept proves *what things mean*. The production build makes them beautiful. The line between the two:

| Stays exactly as here | Is free to become production quality |
| --- | --- |
| the six rules and the planet / moon thresholds | the look of a galaxy (a spiral of instanced stars and dust, not a sphere), stars (corona, flares, spectral colour), planets (PBR, atmosphere, real thumbnails as materials), moons |
| urgency from tasks, and the speed and brightness it drives | lighting, bloom, volumetrics, post-processing, sound |
| positions from the brain window's layout | camera work, flight, picking, UI |
| the `body` names (`galaxy` `star` `planet` `moon`) and the `urgency` number | meshes, materials, Niagara systems behind each of them |

Build order that keeps the two honest: (1) the viewer draws every `kind` with placeholder shapes at the published positions and speeds; (2) it matches the concept frame for frame with the same scene; (3) only then does each body get its production art. A change to a rule above changes this page, the desktop app, its tests and the viewer together. The viewer built before this page keeps working on `kind`; the production one reads `body` and `urgency`, and the day it does, `kind` can be retired.

## Budgets

Two tiers. Numbers are planning estimates to confirm on the card, not measurements.

| | Baseline (an 8 GB card, what is shipped) | This machine (RTX 5080, 16 GB; Ryzen 7 9800X3D; 31 GB RAM) |
| --- | --- | --- |
| scene | at most 12,000 nodes, 8,000 links, 400 rings (the companion's cut, `companion-bound.ts`) | the same cut, raised: the budget is a setting |
| thumbnails | 256 px, 256 layers: 64 MB of texture array | 512 px, 512 layers: 512 MB |
| the render | a lighter Lumen/Nanite profile, no volumetric clouds | the full profile |
| the coach (the AI that works with you) | a 3 to 4 B model at 4-bit, about 2 to 3 GB, run beside the viewer | a 7 to 8 B model at 4-bit, about 5 GB, with room to spare |

The coach runs **outside** the viewer (a local model server, the way the app's chat already uses Ollama), so the render never waits for it and a bigger or smaller model is a setting, not a rebuild. Nothing about the coach is in the cosmology: it reads the same notes, tasks and check-ins, and it is the one that helps you pick the single bright thing that matters today.
