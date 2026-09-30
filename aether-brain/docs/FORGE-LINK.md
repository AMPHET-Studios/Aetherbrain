# The Concept Forge link: graded drawings into your projects

Concept Forge is your own drawing trainer (`concept-forge.html`, a single page
on your disk). The link opens it inside Aether Brain and adds one button to it:
**🪐 Save to Brain**. One click files the drawing and its grade into a
project's **Critique** planet, and the biggest fix becomes tomorrow's to-do.

```
 Concept Forge window                 Aether Brain
 ┌──────────────────────────┐         ★ PORTALz
 │  draw → grade            │           ● Critique
 │                          │  ─────▶     · 2026-09-30 Gesture        (the note)
 │        🪐 Save to Brain  │             🖼 2026-09-30 Gesture.png  (the drawing)
 └──────────────────────────┘         ☀ Today (tomorrow): Push the curve of the spine further
```

The link is part of the desktop app. The browser version of Aether Brain
doesn't have it.

- [Set it up](#set-it-up)
- [Save a drawing](#save-a-drawing)
- [What gets written](#what-gets-written)
- [Tomorrow's practice task](#tomorrows-practice-task)
- [Where the grade comes from](#where-the-grade-comes-from)
- [Privacy](#privacy)
- [Keys](#keys)
- [Troubleshooting](#troubleshooting)

## Set it up

1. In Aether Brain, press <kbd>g</kbd> (or open the palette and run **Concept Forge — open**).
2. The first time, a file dialog asks for your page: pick `concept-forge.html`.
3. Concept Forge opens in its own window, titled *Concept Forge — Aether Brain*.

Aether Brain remembers the file. Next time <kbd>g</kbd> opens it straight
away, or brings the window to the front when it's already open.

- **Moved or renamed the file?** Aether Brain asks for it again.
- **Using another copy?** Run **Concept Forge — choose file…** from the palette.
- **Closing Aether Brain** also closes the Forge window. If your page asks
  about unsaved changes, you get to choose *Leave* or *Stay*.

## Save a drawing

1. Draw, and let Concept Forge grade it.
2. Click **🪐 Save to Brain** (bottom-right corner) or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>.
3. Check the small dialog:

   | | |
   |---|---|
   | **Preview** | the drawing that will be saved, its size, and the grade it found (`B+ · 82/100`) |
   | **Project** | where it goes. It remembers your last choice. The line under it shows the folder (`Into Projects/PORTALz/Critique`) |
   | **Title** | the drill's name (*Gesture*, from the grade or the drill picked in the page), else *Study*. Change it if you like |
   | **Practice the top fix tomorrow** | on by default |

4. Press **Save** (or <kbd>Enter</kbd>). A note confirms it: *Saved to PORTALz ▸ Critique*.
   The brain shows a toast too. Click **Show** there to fly to the new note.

**Esc** or **Cancel** closes the dialog without saving.

**What the picture contains.** The link saves what you see: the largest
drawing canvas, plus any layers stacked exactly on top of it (paper, ink),
flattened over the page's background colour (white if the page has none). It
leaves out overlays: grids, guides, cursors, previews, thumbnails, colour rings
and meters. It saves at the canvas's own resolution, not the zoom you see on
screen.

## What gets written

The link writes two new files in the project's folder, in its `Critique`
planet. If the project has no folder or no Critique folder yet, it creates
them. If there's already a `critique` folder, in any capitalisation, it uses
that one.

```
Projects/PORTALz/Critique/
  2026-09-30 Gesture.png
  2026-09-30 Gesture.md
```

It never overwrites anything. If the name is taken, the new files get
` 2`, ` 3`, … added (`2026-09-30 Gesture 2.png` + `.md`).

The note is plain markdown. The grade is written as Dataview fields
(`grade:: B+`, `score:: 82`), so no new frontmatter keys are invented:

```markdown
---
title: Gesture — 2026-09-30
tags: [critique, concept-forge, drill/gesture]
created: "2026-09-30"
updated: "2026-09-30"
---

# Gesture — 2026-09-30

![[2026-09-30 Gesture.png]]

Grade **B+ · 82/100** · Drill: Gesture · Project: [[PORTALz]] · Source: Concept Forge

grade:: B+
score:: 82

## Scores

| Criterion | Score | Note |
| --- | ---: | --- |
| Line of action | 88 |  |
| Proportion | 74 | Torso runs long |
| Rhythm | 81 |  |

## Fix next

- [ ] Push the curve of the spine further 📅 2026-10-01
- [ ] Simplify the hands into mitts

## Working

- Confident, single strokes
```

If Concept Forge wrote a *Deep Critique*, the note also gets a **Deep
critique** section with that text as a quote.

In the brain, the note is a moon of the Critique planet. The drawing shows up
as a picture moon next to it, and inside the note as the embedded image.

## Tomorrow's practice task

With **Practice the top fix tomorrow** on, the first item under *Fix next*
gets tomorrow's date (`📅 2026-10-01`). Tomorrow it shows up on the
**☀ Today** hub (press <kbd>y</kbd>) with your other to-dos. Tick it there, or
anywhere else. If you don't do it that day, it moves to *Overdue*.

Untick the box to skip this. The fixes are still listed as tasks, just
without a date.

## Where the grade comes from

When you open the dialog, the button reads the grade Concept Forge already has.
It looks in this order:

1. a page variable called `lastGrade`, `LAST_GRADE`, `currentGrade`, `gradeResult` or `lastResult`.
   This includes a top-level `let lastGrade = …` in the page's script;
2. otherwise, grade history in the page's local storage: any key with *grade* in its name
   that holds an object or a list of them. It takes the last one.

The link sends the grade to the brain as is. The brain reads the fields it
knows, loosely:

| Written as | Read from |
|---|---|
| letter | `letter`, `grade`, `mark`, `rank` |
| score | `score`, `overall`, `total`, `percent` (0–1 becomes 0–100) |
| drill | `drill`, `mode`, `exercise`, `category` |
| score table | `breakdown`, `criteria`, `scores`, `rubric` |
| fixes | `fixes`, `opportunities`, `improvements`, `nextSteps`, `tips` |
| working | `strengths`, `wins`, `positives` |
| deep critique | `deep`, `deepCritique`, `critique`, `feedback` |

It also looks one level inside, so `{ result: { letter: 'B+' } }` works too.
Anything the page keeps that isn't plain data, such as functions or page
elements, is left out, and so is anything past 256 KB.

## Privacy

- **The brain stays offline.** The Aether Brain window still makes no network requests.
- **The Forge window runs your page as it is.** It may use the internet for its
  own features, such as Deep Critique with your own API key and random
  references. It runs in a session of its own, separate from the brain.
- **The page can't read your other files.** It runs from `concept-forge.html`
  on your disk, but the Forge window gives it that one file and nothing else.
  It can't open, fetch, embed or show any other file on your drives: not your
  notes, not your pictures, not the files next to it. Pictures you drop into
  the page, or pick with its own file button, still work.
- **The page can't see your vault.** It can only ask for the list of your
  projects' names, and save one PNG with its critique note through the
  button. It can't read, change or delete anything.
- **Links open in your browser.** Clicking a web link in the page opens your
  default browser. The Forge window itself never leaves your page.
- **Permissions:** the page may copy to the clipboard, go fullscreen and lock
  the pointer. Everything else, such as the camera, microphone, location and
  notifications, is refused.
- **Your page's own *Save PNG*** still works as usual, with a normal save dialog.

## Keys

| Where | Key | Does |
|---|---|---|
| Aether Brain | <kbd>g</kbd> | open / focus Concept Forge |
| Concept Forge | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> | Save to Brain (press again to close) |
| the dialog | <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> | move between project, title, checkbox, Cancel, Save |
| the dialog | <kbd>Enter</kbd> | save |
| the dialog | <kbd>Esc</kbd> | close without saving |

Concept Forge keeps all its own keys (<kbd>Space</kbd>, <kbd>n</kbd>, <kbd>b</kbd>,
<kbd>e</kbd>, <kbd>[</kbd> <kbd>]</kbd>, <kbd>g</kbd>, <kbd>r</kbd>, <kbd>l</kbd>,
<kbd>Ctrl</kbd>+<kbd>Z</kbd>/<kbd>Y</kbd> …). While the dialog is open, what
you type goes to the dialog only.

## Troubleshooting

**"Open your vault in Aether Brain first"**
: Aether Brain has no vault open, or its window is gone. Open your vault
  there, then press Save again. The dialog stays open, so you lose nothing.

**"The vault is still loading; try again in a moment"**
: The brain is still reading your folders (whole drives take a while). When
  the map shows up, press Save again, or close the dialog and open it again
  to get the project list.

**"Aether Brain hasn't answered in 30 s; the drawing may still have been saved"**
: The brain got the drawing but didn't confirm it in time, for example while
  it was busy with a big vault. It may still save it. Look in the project's
  Critique planet (or its folder) before you press Save again, or you may end
  up with a second copy (`… 2`).

**"Aether Brain didn't answer in 30 s; try again"**
: The project list didn't come back in time. Close the dialog and open it again.

**"No projects in Aether Brain yet"**
: Critiques go to projects. Make one in Aether Brain (<kbd>p</kbd> opens the
  projects board), or turn a folder into a project, then open the dialog again.

**No grade found**
: The drawing is still saved, just without a grade, and there's no practice
  task. Grade the drawing in Concept Forge first. If it still finds nothing,
  your page keeps its grade somewhere the link doesn't look. Keep it in a
  top-level `lastGrade` variable (`let lastGrade = …` or `window.lastGrade = …`),
  or keep a grade history in local storage under a key with *grade* in its name.

**"No drawing found"**
: The page shows no canvas right now, or only overlays. Go back to the drawing
  view, then try again.

**"its canvas holds a picture from the web"**
: The browser won't let a page export a canvas that has a picture from another
  site drawn into it. The link then tries to save the drawing layer on its own.
  If the reference image is drawn into your drawing layer itself, keep the
  reference on a separate layer or canvas.

**Pictures, scripts or styles next to the page don't load**
: The Forge window gives your page its own file only (see [Privacy](#privacy)).
  Keep the page in one file: put its styles and scripts inside it or load them
  from the web, and drop reference pictures into the page.

**The wrong project is picked**
: Pick the right one once. The dialog remembers it for next time.
