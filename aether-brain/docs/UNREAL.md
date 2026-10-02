# Aether Brain in Unreal Engine

The **Unreal companion** draws your brain in Unreal Engine 5: the same suns, stars, planets and moons, in the same
places and colours, live. Every glow blooms, the orbits turn, and a starfield hangs behind. You fly through it with
the mouse and WASD. Click a star there and the desktop app flies to it too; double-click a note and it opens in the
desktop app.

It is a viewer. Your notes, the editor, the chat, the librarian and Concept Forge stay in the desktop app, which
remains the one place anything is written. The Unreal app reads the scene from the desktop app on your own computer
(127.0.0.1), live.

```
 Aether Brain (desktop)                         Aether Brain Viewer (Unreal Engine 5.8)
 ┌───────────────────────┐   127.0.0.1:7459     ┌──────────────────────────────────────┐
 │ notes · layout · AI    │ ── scene, 10×/s ───▶ │ glowing spheres, orbits, links, bloom │
 │ companion link (a)     │ ◀── select / open ── │ fly: mouse + WASD · click · Enter     │
 └───────────────────────┘                      └──────────────────────────────────────┘
```

- [What you need](#what-you-need)
- [Build it (once)](#build-it-once)
- [Use it](#use-it)
- [Keys](#keys)
- [How it works](#how-it-works)
- [Privacy](#privacy)
- [Change how it looks](#change-how-it-looks)
- [Troubleshooting](#troubleshooting)

## What you need

- **Unreal Engine 5.8**, from the Epic Games Launcher.
- **Visual Studio 2022** with the *Game development with C++* workload (Windows), or Xcode (macOS). The viewer has a
  little C++, so Unreal compiles it the first time you open it.
- **Aether Brain 0.8** or later (the desktop app), with a vault open.

## Build it (once)

1. Get the project: it is the `aether-brain/unreal/AetherBrainViewer` folder of this repository (download the source
   zip from GitHub, or clone it).
2. Double-click `AetherBrainViewer.uproject`. Unreal asks to build the missing modules: press **Yes**. It takes a
   few minutes the first time.
   - If it says it can't build them, right-click the `.uproject` → *Generate Visual Studio project files*, open the
     `.sln`, build *Development Editor*, then open the `.uproject` again.
3. The editor opens. On its first start it makes two assets by itself, in `Content/AetherBrain/` (see the Output Log):
   `M_AetherNode` (the glow material) and `Maps/Brain` (an empty level of space). Nothing to click.
4. Optional: **Platforms → Windows → Package Project** makes a standalone `AetherBrainViewer.exe` you can start
   without the editor.

## Use it

1. In the desktop app press <kbd>a</kbd> and, under **Unreal companion**, switch the **companion link on** (or run
   **Unreal companion link: on / off** from the palette).
2. In Unreal press **Play** (or start the packaged `.exe`). It finds the desktop app by itself, and the brain
   appears. The desktop app's panel says *The Unreal app is showing this brain*.
3. Fly. Whatever you do in the desktop app shows up at once: a new note is a new moon, switching the layout
   (<kbd>t</kbd>) moves everything, a new colour mode recolours it, and what you select there is where the Unreal
   camera flies.

You can leave the link on. It costs nothing while no viewer reads it: the desktop app sends the scene only while
the Unreal app is asking for it.

## Keys

| Key | Does |
|---|---|
| hold right mouse + move | look around |
| <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> | fly forward, left, back, right |
| <kbd>Q</kbd> / <kbd>E</kbd> | down / up |
| <kbd>Shift</kbd> | 4× faster |
| mouse wheel | slower / faster (the speed is on screen) |
| click a node | select it: the camera flies to it, and the desktop app selects it and flies there too |
| double-click a node, or <kbd>Enter</kbd> | open it in the desktop app (a note in the editor; anything else is selected there) |
| <kbd>F</kbd> | fly to the selection |
| <kbd>H</kbd> or <kbd>Home</kbd> | fly back to see everything |
| <kbd>Tab</kbd> | the next project star |

The name of what is under the cursor floats next to it; suns, stars and planets carry their names.

## How it works

The desktop app's **companion link** is a small HTTP server on `127.0.0.1` (port 7459 by default), off until you
switch it on. While it runs it writes its address and a secret token to `companion.json` in the app's data folder
(`%APPDATA%\Aether Brain\` on Windows, `~/Library/Application Support/Aether Brain/` on macOS,
`~/.config/Aether Brain/` on Linux), and deletes it when it stops. The viewer reads that file, so there is
nothing to copy.

| Request | Answer |
|---|---|
| `GET /v1/hello` | the app, its version, the vault's name |
| `GET /v1/graph` | JSON: every node (id, title, kind, colour, radius, parent), the links as index pairs, the selection, the layout. `ETag`, so asking again costs a `304` until something changes |
| `GET /v1/positions` | binary: a 16-byte header (`AEP1`, graph version, node count, ring count), then x y z per node and 6 floats per orbit ring (parent, radius, quaternion), little-endian float32 |
| `POST /v1/select` | `{"id": "...", "open": false}`: the desktop app selects the node and flies to it (with `open: true` it opens it) |

Every request carries `Authorization: Bearer <token>`. The scene is the one the desktop window draws, in its
current layout and colour mode. The desktop app publishes it only while a viewer asks (graph on change, positions
up to 10 times a second). The viewer eases toward the positions, so orbits keep turning smoothly between frames.

In Unreal everything is a handful of instanced meshes (one draw call each): spheres for nodes, thin cylinders for
links and orbit rings, and the starfield. The glow material reads each instance's colour and glow from its custom
data. A post-process volume fixes the exposure and adds bloom. The game mode sets all of this up in any level, so
the `Brain` map is just empty space.

Any other program can read the same link. A web page can't: it has no token, and the link sends no CORS headers.

## Privacy

- **Off by default**, and only on `127.0.0.1`: nothing on your network or the internet can reach it.
- **The viewer sees titles, colours and positions**, not what your notes say: no note text, no tags, no tasks.
- **It can only select a node, or open a note that exists**, the same as a click in the desktop app. It can't
  write, move or delete anything (a note that is only a link target is selected, never created).
- **The token** is in `companion.json`, readable only by you. **New token…** in the panel makes a new one; the
  viewer picks it up by itself.

## Change how it looks

In the level, place an **Aether Brain Actor** (search for it in *Place Actors*) to change its settings. The game
mode only adds one when the level has none.

| Setting | |
|---|---|
| World Scale | centimetres per brain unit (20). Bigger: a bigger brain, slower to cross |
| Glow Scale | every glow ×; bloom starts above 1 |
| Show Links / Show Orbits, Max Links | the threads; big vaults may want fewer |
| Max Labels | how many suns, stars and planets carry a name |
| Follow Brain Selection | fly where the desktop app's selection goes |
| Url / Token | only to connect to a link by hand (otherwise `companion.json`) |

The glow material `Content/AetherBrain/M_AetherNode` is yours to edit (keep its four per-instance custom data
inputs). The stage is a post-process volume made at start: place your own to change bloom, exposure, lens flares or
Lumen settings. The game mode then leaves it alone.

## Troubleshooting

| You see | Do |
|---|---|
| *Aether Brain's companion link is off* | Switch it on in the desktop app (<kbd>a</kbd> → Unreal companion). The viewer checks every 2 seconds |
| *Can't reach Aether Brain* | The desktop app is closed, or another program holds port 7459: change the port in the panel |
| *Waiting for Aether Brain to show a vault* | Open a vault in the desktop app |
| *Glow material missing*, everything grey | Open the project in the Unreal Editor once with the Python Editor Script Plugin on (the `.uproject` turns it on). Then package again |
| Grey spheres in a packaged build only | Make sure `Content/AetherBrain` is cooked: the project's `DefaultGame.ini` lists it under *Directories to always cook* |
| Right mouse doesn't look around | Click into the game window first; the project's `DefaultInput.ini` captures the mouse only while the right button is down |
| The link works but the viewer refuses the token | Press **New token…** in the panel; the viewer reads `companion.json` again |
