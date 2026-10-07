// Unreal's build tool joins .cpp files of a module into one translation unit ("unity build"), so two files that each define a helper of
// the same name in an anonymous namespace stop compiling together, though each compiles alone. This joins the two actors the stand-in
// can build; run.sh compiles it (syntax only) so a clash is found here and not in a clean or packaged build.
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherSpaceActor.cpp"
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherFxActor.cpp"
