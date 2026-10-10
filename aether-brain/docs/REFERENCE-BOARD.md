# Reference boards

A **reference board** is an open canvas for the pictures you draw from. Put your references side by side, make them as big or small as you like, turn them, crop them, grey them down to check your values, write on them, draw on them, pick colours out of them, and keep the whole board in a small window that floats over your painting program.

If you have used PureRef, this is that, built into Aether Brain. The difference is that a board is **an ordinary note in your vault**. The brain links it to its pictures, search finds it, git can keep its history, and nothing is locked in a file only one program can read.

- [Getting started](#getting-started)
- [Adding pictures](#adding-pictures)
- [Moving around](#moving-around)
- [Working with pictures](#working-with-pictures)
- [Arranging](#arranging)
- [Notes and drawing](#notes-and-drawing)
- [Colour and value studies](#colour-and-value-studies)
- [Saving, undo and the file](#saving-undo-and-the-file)
- [The floating window](#the-floating-window)
- [Using a board with your drawing program](#using-a-board-with-your-drawing-program)
- [Keys](#keys)
- [Limits](#limits)
- [What it does not do](#what-it-does-not-do)

## Getting started

Press **`8`** (or **`⇧ B`**). You see your boards as cards, each with a little collage of its pictures. Press **`n`** (or click **＋ New board**), type a name, press `Enter`: the board opens, empty.

Boards live in a `Boards` folder at the top of your vault (`Boards/Gate reference.md`). A board's own pictures go in a folder next to its note with the same name (`Boards/Gate reference/`).

Press `8` again inside a board to go back to the list, `Esc` to close the view. The board you were on is remembered: from anywhere in the app, `8` comes back to it.

Everything also has a palette command: press `⌘ K` (`Ctrl K`) and type "board".

## Adding pictures

| How | What happens |
| --- | --- |
| **Drop** files on the board | Pictures land where you drop them, packed neatly. They are copied into the board's own folder. |
| **Paste** (`⌘ V`) | A screenshot, a picture you copied in another program, or copied files. Screenshots are named `ref 2026-10-09 143512.png`. |
| **Add pictures…** (`⌘ O`, the **+** button) | Pick from the pictures already in your vault, with a search box. Nothing is copied: the board points at them. |
| **Add to board** in a picture's inspector | Select a picture in the 3D view, press *Add to board*, choose a board (or *New board…*). The board does not have to be open. |
| **Paste text** or drop text | A text note at that spot. |

Good to know:

- Pictures are never changed. Cropping, flipping, rotating, greying and opacity are numbers kept on the board; your original files stay exactly as they were.
- A name already taken gets a number (`ref 2026-10-09 143512 2.png`), nothing is ever replaced.
- png, jpg, webp, gif, bmp and avif. At most 40 files in one drop, 40 MB each.
- The app does not touch the internet. If you drag a picture out of a web page, the browser hands over an address, not the picture: save it or copy it first, then drop or paste it. The board tells you when this happens.
- A picture that is later deleted from the vault keeps its place on the board, drawn as a dashed crossed box, so you can put the file back or remove the box.

## Moving around

| Gesture | Mouse and trackpad | Pen | Touch |
| --- | --- | --- | --- |
| Pan | Hold `Space` and drag, middle-button drag, the hand tool (`H`), `⇧ Wheel` sideways, `⌥ Wheel` up and down | Barrel button and drag | Two fingers |
| Zoom | `Wheel` (zooms toward the pointer), `+` `-`, pinch on a trackpad | `Wheel` | Pinch |
| Fit everything | `Home` or `F` | | |
| Fit the selection | `⇧ F` or `Z` | | |
| 100% | `1` | | |

Zoom goes from 0.5% to 6400%. The status bar at the bottom shows the zoom (click it for 100%), how many items the board has, and whether it is saved.

## Working with pictures

**Select** by clicking, or drag a box round several (the box selects whatever it touches). `⇧`-click adds or removes one. `⌘ A` selects all, `⌘ I` inverts the selection, `Esc` clears it.

**Move** by dragging; alignment guides appear against other pictures as you pass them. The arrow keys nudge by one unit (`⇧` for ten).

**Scale** by dragging a corner; the shape stays. Hold `Alt` to scale from the centre.

**Rotate** with the handle above the box; hold `⇧` to snap to 15 degrees. `⌘ R` and `⌘ ⇧ R` turn by 90 degrees.

**Flip** with `⇧ H` (left to right) and `⇧ V` (top to bottom). A mirrored picture is a good way to spot what is wrong with your own drawing.

**Crop** with `C`: drag the edges. `Enter` finishes. The picture itself is not cut; *Reset crop* brings the rest back.

**Opacity** with `⌥ ]` and `⌥ [` (more and less opaque).

**Order**: `]` forward, `[` backward, `⌘ ]` to the front, `⌘ [` to the back.

**Group** pictures that belong together with `⌘ G`; a group moves, scales and rotates as one. `⌘ ⇧ G` ungroups. **Lock** with `⌘ L` so nothing moves by accident.

**Duplicate** (`⌘ D`), **copy** and **paste** (`⌘ C`, `⌘ V`) work within the board; **delete** with `Delete`.

**Captions** (`N`) show each picture's name under it. **Smooth or crisp pixels** (`S`) matters for pixel art: crisp keeps the squares sharp when you zoom in.

**Info**: select a picture, then *Picture info* in the Edit menu shows its name, where it lives in the vault, its pixel size, its size on the board and its file type. From the same menu: open it in your image program (`Enter`), show it in the file manager (desktop), or *Show in the brain* to leave the board and fly to the picture.

## Arranging

Select some pictures (or none, for the whole board) and press **`A`**, or use the **Arrange** menu:

| | |
| --- | --- |
| **Optimal** | A tidy packed layout that wastes little space, sizes untouched. This is also how new pictures are placed. |
| **Row**, **column**, **grid** | Lined up. |
| **Pile** | Stacked on one centre. |
| **Sort** | By name, by the order added, by size, or shuffled, then laid out. |
| **Align** | Left, right, top, bottom or centres of the selection. |
| **Distribute** | Equal gaps horizontally or vertically (three or more). |
| **Same width / height / size** | Makes the selection match. *Show at the pictures' own size* puts them back to one pixel per unit. |

Arranging never throws the group across the board: the result is centred on where the pictures were. Locked pictures stay where they are.

**Snap to grid** (`⇧ S`) makes dragging land on a grid.

## Notes and drawing

- **Note tool** (`T`): click on the canvas and type. `⌘ Enter` or clicking away finishes, `Esc` cancels. Double-click a note to edit it again. Notes have a size, a colour and an optional background in the style panel.
- **Pen** (`P`): freehand. On a tablet, pressure makes the line thicker.
- **Line and arrow** (`L`), **rectangle** (`R`), **ellipse** (`O`): drag. `⇧` snaps a line to 45 degree steps and a shape to equal sides; `Alt` draws from the middle. Turn *arrow* on in the style panel for an arrowhead. Shapes can be filled.
- **Eraser** (`E`): removes a whole mark with one touch. It does not touch pictures or notes.
- The **style panel** (the colour swatch in the toolbar) sets colour, width, fill and note size for the next thing you make, and restyles whatever is selected.

A line is as thick on screen as the style panel says when you draw it, whatever the zoom is at that moment: a 3 pixel pen line is 3 pixels wide when drawn zoomed out and when drawn zoomed in.

## Colour and value studies

- **Sampler** (`I`): click anywhere on the board and the colour under the pointer is copied as `#rrggbb`. A small loupe follows the pointer while you aim.
- **Extract a palette**: select a picture, then *Extract a colour palette* (Edit menu or the palette `⌘ K`). Six dominant colours land beside it as small notes, each filled with its colour and labelled with its hex. Use them as swatches.
- **Grey** the whole board with `G`, or just the selected pictures with `⇧ G`. This is the quickest way to check whether your values read.
- **Background** (`B`) steps through dark, mid grey, light grey, black and white. A mid grey background judges colours fairly.

## Saving, undo and the file

You never save by hand. The board writes itself into its note at the end of each gesture (when you let go of a drag, finish a command), and at most once a second while you are in the middle of one. The status bar says *Saved*, *Saving…* or *Not saved* (it tries again). Panning and zooming alone do not rewrite the note: your view is remembered by the app and written into the file with the next real change.

**Undo** (`⌘ Z`) and **redo** (`⌘ ⇧ Z`) go back 200 steps. A run of arrow-key nudges is one step.

If something else changes the note while the board is open (you edit it in the editor, an AI helper writes to it, git pulls a new version), the board reloads it. If you have unsaved changes of your own at that moment, yours are kept and the board warns you, and it refuses to save over the newer text until you reload the board. Nothing is overwritten without a word.

### The file, in plain words

A board is a markdown note like any other. Open one in the editor (the ✎ button on its card, or select it in the 3D view and press `e`) and you will see something like this:

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
- note x=10 y=10 w=300 size=18 color=ffffff fill=202530 r=0 » Check the edge\nof the lintel
- line x1=0 y1=0 x2=100 y2=40 color=ffffff width=2 arrow
```

- `type: board` is what makes it a board. Only the lines under the first `## Board` heading belong to the board; write whatever you like above and below (a heading, a to-do list, links to the project this board is for). It is kept byte for byte.
- One line per item, back to front: the view first, then pictures as `![[path]]` embeds (which is how the brain draws the link between the board and its pictures), notes, pen strokes, lines, rectangles and ellipses.
- Colours are six hex digits without the `#`. Positions and sizes are in board units, y growing downward. `r` is rotation in degrees, `op` opacity, `g` a group number, `flip` is `h`, `v` or `hv`, `crop` the part of the picture shown (left, top, right, bottom as fractions).
- A line the board does not understand (something you wrote by hand, an item from a newer version) is kept and written back after the items. Nothing is dropped.
- You can edit the lines by hand. A bad number is ignored with a warning, never the whole line.

## The floating window

On the desktop app a board can leave the app window and float on top of everything else, so it stays visible while you paint.

- **Pop out**: the *Pop out* button in the board's toolbar, the **`w`** key, a card's ⧉ button in the list, or the palette command *Board: Pop out to its own window*. The board saves first, then opens in its window and the app shows a card: *This board is open in its window*.
- **Bring it back**: the *Dock* button in the window's toolbar, `w` again, closing the window, or the *Bring it back* button on the card in the app. The board reloads from its note, with whatever you did in the window.
- **Always on top**: on by default; the pin button in the window's toolbar (or *Stays on top* on the card in the app) and the palette command *Board: Always on top* turn it off.
- **Opacity** (Windows and macOS): the − and + buttons dim the window in steps of 10%, down to 20%, so the program under it shows through. The percentage is shown. (Linux windows cannot be dimmed reliably, so the buttons are not there.)
- The window remembers its place, its size, its opacity and whether it stays on top.
- Only one board is in the window at a time. Opening another board in it sends the first back to the app.
- The window saves as you work, at the end of every gesture. If the window is closed (even by a crash), the board in the note is the last gesture you finished.

The window shows only the board: it never opens your vault and can't reach other notes.

## Using a board with your drawing program

A few ways that work well:

1. **Float it beside the canvas.** Pop the board out, make it a sensible size, keep it on top, and dim it to 80% if it covers part of your work. Zoom and pan in the board with the wheel while your pen stays on your drawing.
2. **Study before you paint.** Grey the pictures (`G`) to see the values, flip them (`⇧ H`) to see their shapes fresh, crop to the part you actually need.
3. **Colour from a reference.** The sampler (`I`) copies a colour as `#rrggbb` that most painting programs accept in their colour picker's hex box. Extract a palette to leave swatches on the board.
4. **Annotate.** Draw an arrow on the edge you want to learn from, write "warm light, cool shadow" in a note. Annotations belong to the board; the picture stays clean.
5. **One board per problem.** "Rusted gate", "Armour plates", "Lighting at dusk". Boards are cheap: make a new one when a project changes direction.
6. **Keep a board with its project.** The board is a note, so it can link to your project note and be linked from it: `[[Gate reference]]`.
7. **Export what you decided.** *Export* in the toolbar (`⌘ E` for the selection, `⌘ ⇧ E` for the whole board) saves a picture of the board into the board's folder, named like `Gate reference export 2026-10-09 143512.png`. Open it in your drawing program as a single reference, or place it on a game-engine mood board.

## Keys

The same table is the cheatsheet in the board (the **?** button), the palette (`⌘ K`, type "Board") and [KEYBOARD.md](KEYBOARD.md). On the Mac `⌘` is Command, elsewhere it is `Ctrl`. Keys work when no text box has the focus.

| Key | Action |
| --- | --- |
| `8` · `⇧ B` | Open the boards (inside the view: up to the list and back) |
| `n` | In the list: make a new board |
| `V` | Select tool |
| `H` | Hand tool |
| `T` | Note tool |
| `P` | Pen |
| `L` | Line and arrow |
| `R` | Rectangle |
| `O` | Ellipse |
| `E` | Eraser |
| `I` | Colour sampler |
| `C` | Crop |
| `⌘ Z` | Undo |
| `⌘ ⇧ Z` · `⌘ Y` | Redo |
| `⌘ A` | Select all |
| `Esc` | Cancel, leave cropping, select none, back to select; at rest, close the view |
| `⌘ I` | Invert selection |
| `⌘ D` | Duplicate |
| `Delete` · `⌫` | Delete |
| `⌘ C` · `⌘ X` · `⌘ V` | Copy, cut, paste |
| `⌘ G` · `⌘ ⇧ G` | Group, ungroup |
| `⌘ L` · `⌘ ⇧ L` | Lock, unlock |
| `⌘ ]` · `]` | To the front, forward |
| `[` · `⌘ [` | Backward, to the back |
| `⇧ H` · `⇧ V` | Flip horizontally, vertically |
| `⌘ R` · `⌘ ⇧ R` | Rotate 90° clockwise, counter-clockwise |
| `A` | Arrange menu |
| `G` · `⇧ G` | Grey the board, grey the selected pictures |
| `S` | Smooth or crisp pixels |
| `N` | Captions |
| `B` | Next background colour |
| `⇧ S` | Snap to grid |
| `⌥ ]` · `⌥ [` | More opaque, more transparent |
| `Home` · `F` | Fit all |
| `⇧ F` · `Z` | Fit the selection |
| `1` | Zoom to 100% |
| `+` · `=` · `-` | Zoom in, zoom in, zoom out |
| `Tab` | Hide or show the toolbar |
| `⌘ O` | Add pictures… |
| `Enter` | Open the selected picture in your image program |
| `⌘ E` · `⌘ ⇧ E` | Export the selection, the board |
| `← ↑ → ↓` | Nudge the selection |
| `Space + drag` | Pan |
| `Wheel` | Zoom at the pointer |
| `⇧ Wheel` | Pan sideways |
| `⌥ Wheel` | Pan up and down |
| `Double-click` | Edit a note, fit a picture, or add a note on empty canvas |

Not on a key, but in the menus and the palette: arrange, sort, align and distribute, the same size, resetting rotation, size or crop, picture info, extract a colour palette, show in the file manager, show in the brain. On the desktop: pop out (`w`), dock, always on top, window opacity.

## Limits

| | |
| --- | --- |
| Items on a board | 1,500 (pictures, notes and marks together). Past that the board says it is full. |
| Text in a note | 4,000 characters |
| Points in one pen stroke | 3,000 (a longer stroke is simplified) |
| Size of the board note | 300,000 characters |
| Picture files | png, jpg, webp, gif, bmp, avif; 40 MB each when added; 40 files per drop |
| Zoom | 0.5% to 6400% |
| Undo | 200 steps |
| Pictures kept ready in memory | About 128 megapixels of decoded pictures in total. The picture you are looking at is always kept; ones off screen are let go first and loaded again when you come back. Big pictures load at the size the screen needs and sharpen as you zoom in. |

A board with hundreds of large pictures stays smooth for this reason: only what is on screen is held at full size.

## What it does not do

- **No web search and no downloading** of pictures from addresses. Aether Brain never makes a network request for the board; save the picture first, then drop it in.
- **No click-through window.** A window you cannot click is a window you cannot get rid of without a tray icon or a global shortcut, so the floating window always takes clicks. Use opacity instead.
- **No animation** (GIFs show their first frame) and no video: boards are for stills.
- **No editing of your picture files.** The board never rewrites, resizes, or deletes a picture in the vault.
- **Two windows on one board.** A board is open in one place at a time: popping it out leaves a card in the app. That is deliberate, so two writers never fight over one note.
