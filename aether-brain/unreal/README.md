# Aether Brain Viewer (Unreal Engine 5.8)

`AetherBrainViewer/` is an Unreal Engine 5.8 project that draws the Aether Brain desktop app's brain, live, with
Unreal's bloom and lighting: open the desktop app's companion link (`a` → Unreal companion), open
`AetherBrainViewer.uproject`, press Play.

Full guide (building, keys, how the link works, privacy): [docs/UNREAL.md](../docs/UNREAL.md).

| Path | |
|---|---|
| `AetherBrainViewer.uproject` | the project (UE 5.8; Python Editor Script Plugin and Editor Scripting Utilities on) |
| `Plugins/AetherBrain/` | the viewer: `AetherScene` (reading the link), `AetherBrainActor` (the scene), `AetherBrainPlayerController` (flying, picking), `AetherBrainHUD`, `AetherBrainGameMode` (sets it all up in any level) |
| `Content/Python/init_unreal.py` | makes the glow material and the empty map the first time the editor opens |
| `Config/` | the default map and game mode, mouse capture on the right button, the material folder always cooked |
| `Source/AetherBrainViewer/` | the project's own (empty) module |

The C++ was written without an Unreal install at hand (the repository's CI can't run the engine): if your
compiler disagrees with a line, the error names it; please report it.
