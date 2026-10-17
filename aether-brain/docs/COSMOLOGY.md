# The cosmology

What every body in the system layout *is*, how it moves and why. This is the contract: the desktop app is the concept that proves it, and the Unreal Engine 5.8 version is built to it. When the two disagree, this page is right and one of them has a bug.

## The six rules

| Your vault | Is | Drawn as |
| --- | --- | --- |
| a **drive** (or the whole vault, when it is one folder) | a **galaxy** | the biggest body, a steady glow; what is in it lies on a flat disc |
| a **folder** | a **star** | a glowing body; bigger the more it holds; a project folder is the brightest, biggest kind |
| a **picture, video or 3D model** big enough to matter, or a **document-sized note** | a **planet** | pictures, videos and models as extra-large thumbnails; a long note as a solid sphere |
| every **small file** | a **moon** | a small body on a close orbit |
| a **reference board** with pictures on it | a **sun** | a bright mint-white star of its own, bigger the more pictures it holds; the pictures on it orbit it instead of their folders |
| **how soon it needs you** | **orbit speed** and **star brightness** | a faster orbit; a brighter star for the whole system |

Everything orbits what is above it: files orbit their folder's star, a sub-folder's star orbits its parent star, a drive's stars lie on its disc. Nothing is a star that is not a folder, except a board's sun (below).

## A board is a sun

A reference board (`type: board`, the PureRef-style note of [REFERENCE-BOARD.md](REFERENCE-BOARD.md)) that has pictures on it is a **sun**: a star of its own with its pictures orbiting it.

- **Which pictures.** Every picture or video the board links to (its `pic` lines). In the system layout each of them orbits the board **instead of its own folder**; its links stay, and it is no longer one of its folder's moons. A picture on several boards orbits the first board by its path (a stable order); the others keep their links to it.
- **The board.** It orbits its own folder like any note (as a system, among the folder's sub-folders), is drawn bigger the more pictures it holds (radius 4 and a little more for each doubling, at most 9), always named (`▣ Name`), and blooms steadily in mint-white (`BOARD_SUN_COLOR`), whatever the colour mode. Flying to it frames its whole system.
- **Its pictures** are planets like any picture (extra-large thumbnails; a faster orbit when an urgent note embeds them), on rings around it.
- **A board with nothing to hold** (no pictures, only missing files, or every picture already on an earlier board) is a plain note. The other layouts do not change: there a board only links to its pictures.
- **The viewer** is sent the board as a `star` (kind and body) with its pictures as children (`parent`), and the sun's radius, like any other body.

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
| `kind` | the original names, **unchanged** so a viewer built to them keeps drawing what it drew: `sun` the vault or a drive · `star` a project folder, or a board with pictures orbiting it · `planet` any other folder · `moon` a note · `picture` · `ghost` · `today` |
| `body` | the cosmology's names, for the viewer built to this page: `galaxy` a drive or a one-folder vault · `origin` the root of several drives · `star` every folder and every board sun · `planet` / `moon` a big / small file (a `picture` kind carries one of them in its radius and its size) · `ghost` · `hub` (Today). Absent from older builds: use `kind` |
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
