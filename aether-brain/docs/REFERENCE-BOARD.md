# Reference boards

A **reference board** is an open canvas for the pictures you draw from. Put your references side by side, make them as big or small as you like, turn them, crop them, grey them down to check your values, write on them, draw on them, pick colours out of them, and keep the whole board in a small window that floats over your painting program.

If you have used PureRef, this is that, built into Aether Brain. The difference is that a board is **an ordinary note in your vault**. The brain links it to its pictures, search finds it (and the words you wrote on it, in notes and picture captions), git can keep its history, and nothing is locked in a file only one program can read.

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

Boards live in a `Boards` folder at the top of your vault (`Boards/Gate reference.md`). A board's own pictures go in a folder next to its note with the same name (`Boards/Gate reference/`; a name the vault would skip, like `Library` or `Temp`, gets ` pictures` added).

Press `8` again inside a board to go back to the list, `Esc` to close the view. The board you were on is remembered: from anywhere in the app, `8` comes back to it.

Everything also has a palette command: press `⌘ K` (`Ctrl K`) and type "board".

While the Boards view is open, the 3D brain behind it is not drawn (it is paused, and the panel over it is solid), so the board has all of the window's attention; the brain carries on where it was when you close the view. The Projects board does the same.

## Adding pictures

| How | What happens |
| --- | --- |
| **Drop** files on the board | Pictures land where you drop them, packed neatly. They are copied into the board's own folder. A picture that claims more than 150 megapixels is refused with a message and is not copied (see [Limits](#limits)). |
| **Paste** (`⌘ V`) | A screenshot, a picture you copied in another program, or copied files. Screenshots are named `ref 2026-10-09 143512.png`. |
| **Add pictures…** (`⌘ O`, the **+** button) | Pick from the pictures already in your vault, with a search box. Nothing is copied: the board points at them. |
| **Add to board** in a picture's inspector | Select a picture in the 3D view, press *Add to board*, choose a board (or *New board…*). The board does not have to be open in the app, but it must not be open in its floating window: the app says so and adds nothing; bring the board back first, or use the **+** button in the window. |
| **Paste text** or drop text | A text note at that spot. |

Good to know:

- Pictures are never changed. Cropping, flipping, rotating, greying and opacity are numbers kept on the board; your original files stay exactly as they were.
- A name already taken gets a number (`ref 2026-10-09 143512 2.png`), nothing is ever replaced.
- A board that is full (1,500 items, or its size budget) takes no more, and says so *before* anything is copied: a drop or paste onto a full board copies nothing, and with room for only some of the pictures, only that many are taken and the rest are left out, not copied into the folder.
- png, jpg, webp, gif, bmp and avif. At most 40 files in one drop, 40 MB each, and none that claims more than 150 megapixels: a small file can (a few kilobytes of PNG can say 30,000 × 30,000), and a picture that size takes gigabytes of memory to show. The message says so, and the file is left out.
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

The middle button only pans: letting go of it never pastes. (On Linux Chromium pastes the primary selection when the middle button is released; the board stops that, and acts on a paste event only when a `⌘ V` is waiting for it.)

Zoom goes from 0.5% to 6400%. The status bar at the bottom shows the zoom (click it for 100%), what is selected, how many pictures and items the board has, how much of its size budget the items use (see [Limits](#limits)), and a hint for the tool in your hand. Whether the board is saved is shown in the toolbar (*Saved*, *Saving…*, *Unsaved*, *Not saved*).

## Working with pictures

**Select** by clicking, or drag a box round several (the box selects whatever it touches). `⇧`-click adds or removes one. `⌘ A` selects all, `⌘ I` inverts the selection, `Esc` clears it.

**Move** by dragging; alignment guides appear against other pictures as you pass them. The arrow keys nudge by one unit (`⇧` for ten).

**Scale** by dragging a corner; the shape stays. Hold `Alt` to scale from the centre.

**Rotate** with the handle above the box; hold `⇧` to snap to 15 degrees. `⌘ R` and `⌘ ⇧ R` turn by 90 degrees. Pictures, notes, pen strokes and lines turn at any angle. A rectangle or ellipse is always upright: `⌘ R` / `⌘ ⇧ R` turn it a quarter (it swaps its width and height about its new centre, so a frame drawn round a picture still encloses the picture after a quarter turn), but rotating by hand, or by a free angle, only moves its centre round with the group and leaves its shape upright.

**Flip** with `⇧ H` (left to right) and `⇧ V` (top to bottom). A mirrored picture is a good way to spot what is wrong with your own drawing.

**Crop** with `C`: drag the edges. `Enter` finishes. The picture itself is not cut; *Reset crop* brings the rest back.

**Opacity** with `⌥ ]` and `⌥ [` (more and less opaque).

**Order**: `]` forward, `[` backward, `⌘ ]` to the front, `⌘ [` to the back.

**Group** pictures that belong together with `⌘ G`; a group moves and scales as one, and turns as one except for the free-angle rule for rectangles and ellipses above. `⌘ ⇧ G` ungroups. **Lock** with `⌘ L` so nothing moves by accident.

**Duplicate** (`⌘ D`), **copy** and **paste** (`⌘ C`, `⌘ V`) work between boards too, and between windows (a board in the app and one in the floating window): what you copy goes on the system clipboard as text that starts with *Aether Brain board: 3 items copied* followed by the items, so you can paste it into another board or look at it in any text editor. A paste is held to the same limits as anything you add. **Delete** with `Delete`.

**Captions** (`N`) show each picture's name under it. **Smooth or crisp pixels** (`S`) matters for pixel art: crisp keeps the squares sharp when you zoom in.

**Info**: select a picture, then *Picture info* in the Edit menu shows its name, where it lives in the vault, its pixel size, its size on the board and its file type. From the same menu: open it in your image program (`Enter`), show it in the file manager (desktop), or *Show in the brain* to leave the board and fly to the picture.

## Arranging

Select two or more items (or none, for the whole board) and press **`A`**, or use the **Arrange** menu. With exactly one item selected, arranging and sorting do nothing and say so: they would rearrange everything you did not point at.

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

- **Note tool** (`T`): click on the canvas and type. `⌘ Enter` or clicking away finishes, `Esc` cancels. Double-click a note, or select it and press `F2` (or `Enter`), to edit it again; the keys need the note to be the only thing selected, and a note in a group is selected with its group, so double-click it. Notes have a size, a colour and an optional background in the style panel.
- **Pen** (`P`): freehand. On a tablet, pressure makes the line thicker.
- **Line and arrow** (`L`), **rectangle** (`R`), **ellipse** (`O`): drag. `⇧` snaps a line to 45 degree steps and a shape to equal sides; `Alt` draws from the middle. Turn *arrow* on in the style panel for an arrowhead. Shapes can be filled.
- **Eraser** (`E`): removes a whole mark with one touch. It does not touch pictures or notes.
- The **style panel** (the colour swatch in the toolbar) sets colour, width, fill and note size for the next thing you make, and restyles whatever is selected.

A line is as thick on screen as the style panel says when you draw it, whatever the zoom is at that moment: a 3 pixel pen line is 3 pixels wide when drawn zoomed out and when drawn zoomed in. This holds at every zoom for widths from about half a pixel to 200 pixels (a mark's width is kept between 0.005 and 40,000 board units, which is what that range needs between the lowest and the highest zoom).

## Colour and value studies

- **Sampler** (`I`): click anywhere on the board and the colour under the pointer is copied as `#rrggbb`. A small loupe follows the pointer while you aim.
- **Extract a palette**: select a picture, then *Extract a colour palette* (Edit menu or the palette `⌘ K`). Six dominant colours land beside it as small notes, each filled with its colour and labelled with its hex. Use them as swatches.
- **Grey** the whole board with `G`, or just the selected pictures with `⇧ G`. This is the quickest way to check whether your values read.
- **Background** (`B`) steps through dark, mid grey, light grey, black and white. A mid grey background judges colours fairly.

## Saving, undo and the file

You never save by hand. The board writes itself into its note at the end of each gesture (when you let go of a drag, finish a command), and at most once a second while you are in the middle of one. A gesture or command that ends within a quarter of a second of the previous finished one (a held arrow key, two quick strokes) is not written at once but within the second. Closing the board, the window losing the focus or being hidden, docking, closing the window and quitting all write what is waiting first, so only a crash, a kill or a power cut inside that second can lose the last gesture. The toolbar says *Saved*, *Saving…*, *Unsaved* or *Not saved*. When a save fails the board keeps your work on screen, tries again, and says so in a message with a *Copy board text* button: the board's text on the clipboard, to paste into a note by hand, so nothing is lost even if the note can never be written. If the board is closed with changes that could not be saved, the app keeps a copy, and the next time you open that board in the same place it offers *Recover unsaved changes*: that replaces the board on screen with the copy (undo starts again from it) and saves it. Panning and zooming alone do not rewrite the note: your view is remembered by the app and written into the file with the next real change. The app remembers the view, and that copy, per board: for the docked view under the vault's folder and the note's path (a board of the same path in another vault is another board), for the floating window under the note's path alone. They are two memories, so a copy the window kept is offered by the window, not by the docked view.

**Undo** (`⌘ Z`) and **redo** (`⌘ ⇧ Z`) go back 200 steps. A run of arrow-key nudges is one step.

If something else changes the note while the board is open (you edit it in the editor, an AI helper writes to it, git pulls a new version), the board reads it again by itself. With nothing unsaved, the board in the note replaces the one on your screen and your camera stays; undo starts again from that board, so the steps before it are gone (an undo must not take back what the other program wrote and save the older board over it). A change that leaves the board part as it was, such as the echo of your own save or an edit of the text around the board, changes nothing and keeps your undo steps. If you have unsaved changes at that moment, **yours win, and the board says so**: it keeps what is on your screen and writes it over the *board part* of the note, while whatever the other change did elsewhere in the note (the frontmatter, the text above and below the board) stays. A save is never written over a note it did not read: if the note changed between the board's last read and the write, the write is refused, the board reads the note again and saves again from that. If the note is deleted or moved while its board is open, the board is not closed (it holds the only copy of your latest work): it stays up with a notice and cannot save until the note is back, and *Copy board text* in the message keeps what you did.

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

- `type: board` is what makes it a board. The board is the first `## Board` heading and the lines from there down to its **last item line** (the view line and the item lines, `- view`, `- ![[…]]`, `- pic`, `- note`, `- stroke`, `- line`, `- rect`, `- ellipse`), plus any lines that follow that last one with no blank line between. It does not run on to the next heading: a blank line after the last item starts your own text. Write whatever you like above the heading and below the board (a heading, a to-do list, links to the project this board is for). Everything outside the board, the text after the board's last item line included, is kept exactly as you wrote it, byte for byte, line endings and blank lines too, when the board saves; only `title`, `type` and `updated` in the frontmatter are patched. After a blank line only a bullet that looks like one the board writes (attributes such as `x=3`, text after ` » `, or a picture file) still counts as an item, so a bullet of your own such as `- note the colours` stays yours.
- One line per item, back to front: the view first, then pictures as `![[path]]` embeds (which is how the brain draws the link between the board and its pictures), notes, pen strokes, lines, rectangles and ellipses.
- Colours are six hex digits without the `#`. Positions and sizes are in board units, y growing downward. `r` is rotation in degrees, `op` opacity, `g` a group number, `flip` is `h`, `v` or `hv`, `crop` the part of the picture shown (left, top, right, bottom as fractions).
- **A save rewrites every line of the board, not only the ones you changed.** Each item is written from the board in the form the app uses: attributes in the order above, numbers rounded (two decimals; three for a crop and a line's width; four for the zoom), a note always with `r=` and `fill=`, a rectangle or ellipse with no fill gaining an empty `fill=`, group numbers counted again from 1. If you wrote a board by hand, or a newer version did, the first save changes lines you did not touch (a vault kept in git shows it); after that only the lines of the items you change differ (group numbers apart).
- What the board does not understand is kept, but not always where it was. An attribute or flag it does not know on a line it does (`theme=dark`, `pinned`; at most 8 on a line) is written back after the attributes it knows (before `pts=` on a pen stroke, before the text on a note). It is kept only when it is a plain name with a plain value: a name of letters, digits and `-` that starts with a letter, a value of letters, digits and `. , : + -`. Anything else, which a markdown reader would take for a link, tag, emphasis or HTML (a `_`, `/`, `#`, `[`, `@`, `*`, `~`, `\`, `!`, `&`, `<` or `>`, as in `source=my_file` or `ref=a/b`), is dropped (the board says so when it is opened) and is gone from the line at the next save. A whole line it does not understand (something you wrote by hand, an item kind from a newer version) is kept, and so is any prose of yours **between the heading and the first item, or between items**; these are written right after the last item, in their order, without the blank lines they had. The one exception is a bullet of your own that starts with a kind word and sits after a blank line between two items (`- line 3 is wrong`): it is written back before the last item, behind a blank line, so that it is still yours when the board is read again. To keep prose where you put it, write it above `## Board`, or below the last item after a blank line.
- You can edit the lines by hand. A bad number is ignored with a warning, never the whole line: the board uses the default for that one attribute, and the next save writes the default in its place.

## The board in the 3D brain

In the system layout (the default 3D view) a board with pictures on it is a **sun**: a bright mint-white star of its own, named `▣ Board name`, bigger the more pictures it holds. The pictures on it orbit it, as thumbnails on rings around it, instead of orbiting their own folders. Fly to the board (search for it, or select it and press `f`) and the whole system comes into view; select a picture and its inspector shows where it lives.

Which pictures count: every picture or video that has a line on the board. If one picture is on several boards it orbits the first board by its path, and the others keep their links to it. A board with no pictures on it is an ordinary note. Nothing on disk changes, and the other layouts (`t`) draw a board as before, linked to its pictures.

## The floating window

On the desktop app a board can leave the app window and float on top of everything else, so it stays visible while you paint.

- **Pop out**: the *Pop out* button in the board's toolbar, the **`w`** key, a card's ⧉ button in the list, or the palette command *Board: Pop out to its own window*. The board saves first, then opens in its window. When you pop out from inside the board in the app (the toolbar button, `w`), the app shows a card in its place: *This board is open in its window*, with *Bring it back*, *Stays on top* and the opacity buttons. When you pop out from a card's ⧉ in the list, the list stays as it was and shows no card; open that card and the same *This board is open in its window* card is there.
- **Bring it back**: the *Dock* button in the window's toolbar, `w` again (pressed in the window or in the app), closing the window, or the *Bring it back* button on the card in the app. The board reloads from its note, with whatever you did in the window.
- **Always on top**: on by default; the pin button in the window's toolbar (or *Stays on top* on the card in the app) and the palette command *Board: Always on top* turn it off.
- **Opacity** (Windows and macOS): the − and + buttons dim the window in steps of 10%, down to 20%, so the program under it shows through. The percentage is shown. (Linux windows cannot be dimmed reliably, so the buttons are not there.)
- The window remembers its place, its size, its opacity and whether it stays on top.
- Only one board is in the window at a time. Opening another board in it sends the first back to the app.
- The window saves as you work, at the end of every gesture. Closing it (or docking it, switching vaults, quitting) is held for a moment, 1.5 seconds at most, while its page writes what it has not written yet, a note you are still typing included; only then does it go. If the window dies without a word, the board in the note is the last gesture you finished.
- A board whose note is longer than 1,000,000 characters (the text around the board counts) is not opened in the window: *Pop out* says so and the board stays in the app.

The window shows only the board. It never opens your vault, and it cannot reach other notes: its page has a bridge with only what a board needs (reading and saving **the one board note it shows**, and no other note, another board included: a request that names any other path is refused; reading, adding and opening pictures; showing a picture, a video or its own board in the file manager, never a note or a folder; its own window settings; the clipboard), and the app answers it no other request, even one sent by hand. A picture that turns out to be a broken file therefore has no way to the rest of your vault.

The window is not a browser: the page is never zoomed (`Ctrl -` and `Ctrl +` do nothing; the board has its own `-`, `+` and `1`), and on Windows and Linux it has a small menu of its own (Close, `Ctrl W`, and Edit) in place of the browser's, so `Ctrl R`, `F5`, `F11` and the developer tools shortcut do nothing there.

If the note of the board in the window is deleted, moved away, or edited so that it no longer reads as a board, the window stays up with a red banner (*Copy board text* puts the board's latest text on the clipboard; *Bring it back* closes the window), and what you draw is not saved. The banner comes down by itself when the note reads as a board again.

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
| `F2` | Edit the selected note's text (`Enter` does the same when a note is the only thing selected) |
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
| Text in a note | 4,000 characters when you type, paste or add one. A longer note that is already in the file (an AI helper or a hand edit wrote it) is kept whole, up to 100,000 characters (past that it is cut when the board is opened, with a warning): opening it for editing and leaving it as it is changes nothing, and you can shorten it but not make it longer than it was. |
| Points in one pen stroke | 3,000 (a longer stroke is simplified while you draw it). A stroke already in the file keeps up to 50,000 points. |
| What the board's items take in the note | 500,000 characters (the status bar shows how much is used: amber from 90%, red when it is full). This is enforced when the board **grows**: a stroke, a note, pictures or a paste that would take it past the limit is refused with *The board is full*; pictures put on a board that is not open are added as many as fit, and the message says how many did not and names the limit. Anything that keeps the size or makes it smaller is always allowed, so you can always delete your way out. A board that is already over the limit when it is opened (a hand-edited or older one) says so once and can still be edited and thinned, never grown. |
| The whole note in the floating window | 1,000,000 characters (the text around the board counts too). A longer note is not opened in the window; it stays in the app. |
| Picture files | png, jpg, webp, gif, bmp, avif; 40 MB each when added; 40 files per drop. A dropped or pasted picture whose header claims more than 150 megapixels is refused with a message (*… is over 150 megapixels, so it was left out*) and is not copied into the vault. |
| Pictures shown | Up to 150 megapixels and 64 MiB. A picture over either that is in the vault already (added with *Add pictures…* or *Add to board*, or put there in the file manager: only a drop or a paste is checked at the door) stays on the board as a placeholder that says *too large to show*, in the app and in the floating window alike; one the file system cannot read says *can't be read*, and so does a damaged file whose header cannot be read when it is bigger than 16 KB, and one that is gone says *file missing*. On the web build a file over 64 MiB says *can't be read*, because the browser's file access hands over no more than 64 MiB. |
| Zoom | 0.5% to 6400% |
| Undo | 200 steps |
| Pictures kept ready in memory | About 128 megapixels of decoded pictures in total. The picture you are looking at is always kept; ones off screen are let go first and loaded again when you come back. Big pictures load at the size the screen needs and sharpen as you zoom in. |

A board with hundreds of large pictures stays smooth for this reason: only what is on screen is held at full size.

## What it does not do

- **No web search and no downloading** of pictures from addresses. Aether Brain never makes a network request for the board; save the picture first, then drop it in.
- **No click-through window.** A window you cannot click is a window you cannot get rid of without a tray icon or a global shortcut, so the floating window always takes clicks. Use opacity instead.
- **No animation** (GIFs show their first frame) and no video: boards are for stills.
- **No editing of your picture files.** The board never rewrites, resizes, or deletes a picture in the vault.
- **Two windows on one board.** A board is open in one place at a time: popping it out hands it to the window, and opening it in the app shows a card instead of a second copy. That is deliberate, so two writers never fight over one note.
