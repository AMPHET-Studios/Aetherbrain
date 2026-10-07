# Niagara effects in the Unreal viewer (v0.9.0)

The Unreal viewer ([UNREAL.md](UNREAL.md)) has a second layer on top of the brain and the space around it: **Niagara
effects** that follow what the brain is doing.

| Effect | What you see | Niagara system |
|---|---|---|
| **Pulses** | Points of light run along the brain's links, a few a second (more links, more traffic, never a flood). With a node selected, about two thirds of them run on *its* links, mostly leaving it | `NS_AetherPulses` |
| **Coronas** | Each sun (up to three) breathes in a soft glow with sparks leaving it; the selected node gets a smaller halo | `NS_AetherCorona` |
| **Ripples** | A ring grows out of a node the moment you select it (here or in the desktop app), and out of every sun when the brain first appears | `NS_AetherRipple` |
| **Dust** | A box of slow motes around the camera. They stay where they are born, so flying through them shows your speed | `NS_AetherDust` |
| **Shooting stars** | A streak across the part of the sky you are looking at, about one every three seconds | `NS_AetherShootingStars` |

Press <kbd>N</kbd> to switch them on and off. The HUD (top right) says `Effects: on - 5/5 systems, 14 playing`.

## What is here, and what you have to make

The **C++ is done and tested**: `AetherFxActor` plays the five systems by setting their *User parameters* from the live brain
(which link a pulse runs along and when, where a shooting star crosses, how a corona breathes, how big a ripple grows), a
few pooled Niagara components at a time. What happens when is planned in `Private/AetherFxMath.h`, plain C++ with no
Unreal types.

The **five Niagara systems are not in the repository**. A Niagara system is a binary `.uasset` made in the Unreal Editor's
Niagara graph; nothing outside the editor can write one. You make each once, in about ten minutes, from the recipes below,
and save them in `Content/AetherFX/`. Until a system exists, that effect is simply not played, the HUD names what is
missing, and the viewer looks as it did before. Start with `NS_AetherPulses` (the one you will notice most) and add the rest
when you like.

The editor script (`Content/Python/init_unreal.py`) makes the folder `/Game/AetherFX` the first time the editor opens and
writes into the Output Log which of the five are still missing.

> **Not verified in a real Unreal Editor.** The planning maths and the actor's bookkeeping (which parameters each component
> gets, that no pulse or ripple component is played while busy, that nothing breaks with a system or the brain missing) are run as plain C++
> against a stand-in engine (`unreal/tests/run.sh`). The Niagara calls themselves (`SetAsset`, `SetVariableFloat`,
> `SetVariableVec3`, `SetVariablePosition`, `SetVariableLinearColor`, `Activate`, `Deactivate`) are written from the
> engine's documented API and have never been compiled against Unreal 5.8; and the recipes below were written from memory of
> Niagara's stock modules, not from a session in the editor. Menu wording shifts a little between versions. If a compiler
> error or a recipe step disagrees with your editor, it names the line: please report it.

## The contract: User parameters

Every system exposes exactly these **User** parameters (in the *Parameters* panel, under *User Exposed*, `+`, pick the type,
name it; Niagara shows the name as `User.<name>`). The names and types are what the C++ sets, and a test checks that it sets
nothing else.

| System | Parameter | Type | Meaning |
|---|---|---|---|
| Pulses | `Start`, `End` | **Position** | where the pulse leaves and arrives (world, cm) |
| | `Color` | Linear Color | the leaving node's colour, lifted toward white |
| | `Duration` | Float | seconds from Start to End |
| | `Size` | Float | the glow's size, cm |
| | `Intensity` | Float | brightness multiplier (3 × the actor's **Glow**) |
| Shooting stars | `Start`, `End` | **Position** | the streak's path |
| | `Color`, `Duration`, `Intensity` | as above | |
| | `Width` | Float | thickness at the head, cm |
| Corona | `Radius` | Float | how far the glow reaches, cm (it breathes ±7%) |
| | `Color`, `Intensity` | Linear Color, Float | the node's colour; brightness (breathes ±24%) |
| Ripple | `Radius` | Float | the ring's final radius, cm |
| | `Duration`, `Color`, `Intensity` | | |
| Dust | `Extent` | **Vector** | half the size of the box of dust, cm (a size, not a place) |
| | `SpawnRate` | Float | motes a second |
| | `Color`, `Intensity` | | |

Make `Start` and `End` of type **Position** (Niagara's Large World Coordinates type). If you would rather make them
**Vector**, untick **Position Parameters** on the Aether Fx Actor (place one in the level; the game mode only adds one when
there is none). A mismatch is silent: the pulses would play at the world's origin.

Each component sits at the effect's own place (the pulse's start, the sun, the camera) and also gets the world positions in
the parameters, so use the parameters for anything that must be in world space.

## Making the five systems

### Once, for all of them

1. Open `AetherBrainViewer.uproject` (the Niagara plugin is on). In the Content Browser open `Content/AetherFX`.
2. Make two materials (the particles need one that reads *Particle Color*):

   | Material | Settings |
   |---|---|
   | `M_AetherParticle` | Blend Mode **Additive**, Shading Model **Unlit**, Two Sided, *Usage → Used with Niagara Sprites*. **Emissive Color** = `Particle Color` (RGB) × `Particle Color` (A) × `Radial Gradient Exponential` (Center 0.5 / 0.5, Radius 0.5, Density 3). A soft round glow |
   | `M_AetherRing` | The same, but multiply the mask by `1 − Radial Gradient Exponential` (Radius 0.40, Density 8) and use Density 8 on the outer one: a thin ring |

3. For each system: right-click in `Content/AetherFX` → **FX → Niagara System** → empty system. Name it exactly as in the
   table at the top. Open it, add its **User parameters** (the contract above), then add the emitter below.
4. In every emitter: **Sim Target** CPU; **Calculate Bounds Mode** Fixed with a box of ±60,000 (the component sits at the
   effect's start, but particles run a long way from it, and a small box would cull them); **Local Space** off (world), except
   the corona. Renderer: **Sprite Renderer**.
5. To use a parameter: on a module's input click the small arrow at its right → **Link Inputs** → `User.<name>` (or drag it
   from the *Parameters* panel onto the input). For an input that needs a little maths, use the arrow → **Expression** and type it.

### `NS_AetherPulses`: the head of a comet that runs from Start to End

One emitter, `Comet`. It drops sprites along the line as it goes; the old ones fade, and that is the trail.

| Where | Module | Setting |
|---|---|---|
| Emitter Update | Emitter State | Loop Behavior **Once**, Loop Duration Mode **Direct Set**, Loop Duration ← `User.Duration`, Inactive Response **Complete** |
| Emitter Update | Spawn Rate | 100 |
| Particle Spawn | Initialize Particle | Lifetime 0.45, Sprite Size Mode **Uniform**, Uniform Sprite Size ← `User.Size`, Color ← `User.Color` |
| Particle Spawn | Set Parameters (after Initialize Particle) | `Particles.Position` = Expression `lerp(User.Start, User.End, saturate(Emitter.Age / User.Duration))` |
| Particle Update | Scale Color | RGB and Alpha separately: RGB scale ← `User.Intensity` (as a vector), Alpha scale ← a curve from 1 to 0 over Normalized Age |
| Particle Update | Scale Sprite Size | a curve from 1 to 0.2 over Normalized Age |
| Renderer | Sprite Renderer | Material `M_AetherParticle` |

### `NS_AetherShootingStars`: the same, longer and thinner

Save-as a copy of `NS_AetherPulses`, then: Lifetime 0.7, Spawn Rate 240, `Uniform Sprite Size` ← `User.Width`,
and the *Scale Sprite Size* curve from 1 to 0. The user parameters are the pulses' with `Width` in place of `Size`.

### `NS_AetherCorona`: a breathing glow with sparks (two emitters, both **Local Space** on)

`Glow`: Spawn Rate 6; Initialize Particle: Lifetime 2.5 to 3.5, Uniform Sprite Size = Expression `User.Radius * 1.6`, Color
← `User.Color`; Particle Update, Scale Color: RGB scale = Expression `User.Intensity * 0.35`, Alpha scale a curve 0 → 1 → 0
over Normalized Age. Material `M_AetherParticle`.

`Sparks`: Spawn Rate 24; **Sphere Location** (radius = Expression `User.Radius * 0.45`, Surface Only on); **Add Velocity from
Point** (strength = Expression `User.Radius * 0.35`, from the centre); Initialize Particle: Lifetime 1.2 to 2.0, size =
Expression `User.Radius * 0.04`, Color ← `User.Color`; Scale Color: RGB scale = Expression `User.Intensity * 3`, Alpha a
curve 1 → 0; **Solve Forces and Velocity** in Particle Update. Material `M_AetherParticle`.

The system runs while the component is active (loop **Infinite** on both emitters); the C++ deactivates it when its sun or
selection goes away.

### `NS_AetherDust`: motes around the camera

One emitter, world space, loop **Infinite**: Spawn Rate ← `User.SpawnRate`; Initialize Particle: Lifetime 18 to 26, Uniform
Sprite Size 14 to 34, Color ← `User.Color`; **Box Location** with Box Size = Expression `User.Extent * 2`; **Add
Velocity** a small random ±20 cm/s; Particle Update: **Curl Noise Force** (gentle), **Drag** 0.2, **Solve Forces and
Velocity**; Scale Color: RGB scale ← `User.Intensity`, Alpha scale a curve 0 → 0.5 → 0 over Normalized Age.
Material `M_AetherParticle`.

### `NS_AetherRipple`: a ring that grows out of a node

One emitter, `Ring`: Emitter State Loop Behavior **Once**, loop duration 0.1; **Spawn Burst Instantaneous** count 1;
Initialize Particle: Lifetime ← `User.Duration`, Color ← `User.Color`; Particle Update: **Set Parameters**
`Particles.SpriteSize` = Expression `float2(1, 1) * User.Radius * 2 * (1 - pow(1 - Particles.NormalizedAge, 3))` (it grows
fast and settles), Scale Color: RGB scale ← `User.Intensity`, Alpha scale a curve 1 → 0. Material `M_AetherRing`.

## Try it

1. Press Play on the `Brain` map with the desktop app's companion link on. The HUD says how many systems were found and
   names the ones that are missing; the Output Log has a line per missing asset.
2. Pulses should run along links within a second of the brain appearing. Click a node: a ripple, a halo, and about two
   thirds of the pulses now run on its links. <kbd>N</kbd> switches everything off and on.
3. If a system plays at the world's origin, or not at all, see the table at the end.

## Settings (Aether Fx Actor)

Place an **Aether Fx Actor** in the level to change these (the game mode adds one only when the level has none, and
not at all when **Spawn Fx** is off on the game mode).

| Setting | |
|---|---|
| On | whether the effects play when the game starts (<kbd>N</kbd> switches them) |
| Density | multiplies pulses, shooting stars and dust (1; 0 stops them) |
| Glow | multiplies every brightness (the systems read it as `User.Intensity`) |
| Seed | the same number gives the same pulses and stars |
| Selection Share | the share of pulses that run on the selected node's links (0.65) |
| Pulses, Coronas, Dust, Shooting Stars, Ripples | switch one layer off |
| Pulse System, Corona System, Dust System, Meteor System, Ripple System | which Niagara asset plays each (the `/Game/AetherFX` ones) |
| Position Parameters | send `Start` and `End` as Position parameters (on) or Vector |

## How it plays them

- **A pool.** Each system has a fixed number of components made when play starts (40 pulses, 6 shooting stars, 4 ripples,
  3 suns plus a halo, 1 dust: 55). An effect that finds none free is *dropped*, never queued, so a huge brain cannot pile
  work up; the HUD's playing count shows the pool in use.
- **Pulses are a stream of numbered events** (`EventTime`, `DueEvents`): the K-th pulse is the same pulse whenever it
  is asked for, one lands in each 1/rate-second slot, and a long frame never makes a burst (anything more than a quarter
  second late is dropped, at most six start in one frame). The rate follows the link count (`2 + 1.5·log10(1 + links)` a
  second: 4.8 for 76 links, about 10 for 200,000) times **Density**. Pulses run only along links the brain *draws* (its
  first **Max Links**, 20,000 by default; none with **Show Links** off), so the index holds those, built once per change
  of the brain or of that number, for any size of vault (at most 200,000 links).
- **Nothing runs while it is off or before there is something to show:** pulses, coronas and ripples wait for the brain's
  first positions; dust and shooting stars belong to the camera and play without a brain.
- **A pulse follows its nodes.** The layout keeps turning while a pulse runs (up to 3.5 s), so every frame a pulse that
  is still playing gets its two nodes' current places in `Start` and `End` (and its component moves with `Start`); the
  recipe's position expression reads them each time it spawns a sprite, so the head stays on the thread.
- **Selecting is a click, not a renumbering.** A rescan that inserts nodes before the selected one changes its number but
  not the selection: no ripple for it.
- **A pulse that has no length yet** (a layout still folded onto one point, or positions that are not numbers) is skipped.

## Troubleshooting

| You see | Do |
|---|---|
| `Niagara systems missing (not played): ...` on the HUD | Make them from the recipes above, with these exact names, in `Content/AetherFX`. The Output Log lists the paths it looked for |
| A system is found but nothing appears | Is its material *Used with Niagara Sprites* and Additive? Is **Calculate Bounds Mode** Fixed and large? Does the emitter's loop end too soon (the Emitter State)? |
| Pulses or stars all start at the world's origin | `Start` / `End` have the wrong type: make them **Position**, or untick **Position Parameters** on the actor if you made them Vector |
| The dust box does not follow the camera, or has the wrong size | `Extent` must be a **Vector** (half size in cm), the emitter's Box Location must read it, and the emitter must be in **world** space |
| The corona sits behind its sun when the layout moves | The corona's emitters must be **Local Space** |
| It stutters | Lower **Density**, or switch off a layer. Each active effect is one Niagara component; 55 is the most |
| The compiler stops on `SetVariablePosition`, `SetAsset` or `NiagaraComponent.h` | The `Niagara` module must be in `AetherBrain.Build.cs` (it is) and the Niagara plugin on in the `.uproject` and `.uplugin` (it is); if your 5.8 renamed a call, change that line in `Private/AetherFxActor.cpp` (search it for `SetAsset`, `SetVariable`, `Activate`, `Deactivate`, `LoadSynchronous`; the `User.` names are in one struct at its top) |

## Check it without Unreal

```
unreal/tests/run.sh      # five stages; the third and fourth are the Niagara layer's, the fifth joins both actors into one file the way Unreal's unity build does
```

`fx_core_test.cpp` checks `AetherFxMath.h` (the link index, the event streams deliver each event once and never a burst, link
picks follow the selection share, shooting stars stay in the view cone and cross the sky, coronas breathe within their range,
the pool never hands out a busy slot). `fx_actor_harness.cpp` compiles the real `AetherFxActor.cpp` against `ue_stubs/` with
fake Niagara components that record every call: it flies a camera, runs a fake brain, selects nodes, switches layers and the
whole layer off and on, and checks which parameters each component got (the table above, exactly), that every pulse runs a
real link, that no pulse or ripple component is played while busy, and that nothing breaks with a system, the brain, the positions or the
world missing. What it cannot say is whether Unreal accepts the calls or how Niagara draws the result.
