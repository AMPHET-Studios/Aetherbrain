# Aether Brain Viewer (Unreal Engine 5.8)

`AetherBrainViewer/` is an Unreal Engine 5.8 project that draws the Aether Brain desktop app's brain, live, with
Unreal's bloom and lighting: open the desktop app's companion link (`a` → Unreal companion), open
`AetherBrainViewer.uproject`, press Play.

Full guide (building, keys, how the link works, privacy): [docs/UNREAL.md](../docs/UNREAL.md).

| Path | |
|---|---|
| `AetherBrainViewer.uproject` | the project (UE 5.8; Python Editor Script Plugin and Editor Scripting Utilities on) |
| `Plugins/AetherBrain/` | the viewer: `AetherScene` (reading the link), `AetherBrainActor` (the scene), `AetherSpaceActor` (the space around it: parallax stars, nebulae, galaxies, asteroids, ships), `AetherFxActor` (the Niagara effects: pulses along links, coronas, ripples, dust, shooting stars), `AetherBrainPlayerController` (flying, picking, `B` for the space, `N` for the effects), `AetherBrainHUD`, `AetherBrainGameMode` (sets it all up in any level) |
| `Plugins/AetherBrain/Source/AetherBrain/Private/AetherSpaceMath.h` | the space's logic as plain C++ with no Unreal types: generated pictures, parallax, paths, ship designs |
| `Plugins/AetherBrain/Source/AetherBrain/Private/AetherViewMath.h` | the brain viewer's logic as plain C++: how big a far body is drawn (by rank), which body is under the ray, how often a big scene is redrawn, whether the first places are a layout |
| `Plugins/AetherBrain/Source/AetherBrain/Private/AetherFxMath.h` | the Niagara layer's logic as plain C++: which link a pulse runs and when, shooting stars, coronas, ripples, dust, the pool of components |
| `PackageWindows.bat` | double-click to make the standalone Windows program, `Packaged/Windows/AetherBrainViewer.exe` (needs Unreal 5.8, Visual Studio 2022 and the project opened in the editor once) |
| `Content/Python/init_unreal.py` | makes the glow, sky and rock materials and the empty map the first time the editor opens, and the empty `Content/AetherFX` folder (the five Niagara systems are made by hand from [docs/UNREAL-NIAGARA.md](../docs/UNREAL-NIAGARA.md)) |
| `../tests/` | tests of the space world and the Niagara layer run as plain C++ (`run.sh`, six stages; a stand-in engine with fake Niagara components in `ue_stubs/`, another for the brain actor and scene reader in `brain_stubs/`) and a software preview of the space (`preview.sh`) |
| `Config/` | the default map and game mode, mouse capture on the right button, the material and Niagara folders always cooked |
| `Source/AetherBrainViewer/` | the project's own (empty) module |

The C++ was written without an Unreal install at hand (the repository's CI can't run the engine). The space world's and
the Niagara layer's logic and the actors' bookkeeping are tested as ordinary C++ (`tests/run.sh`), but only your build says how Unreal
compiles and draws it: if your compiler disagrees with a line, the error names it; please report it.
