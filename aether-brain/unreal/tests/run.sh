#!/bin/sh
# Compile (with strict warnings) and run the viewer's host tests with an ordinary C++ compiler: no Unreal needed.
#  1. space_core_test.cpp  the space world's maths: pictures, parallax, paths, ships (Private/AetherSpaceMath.h)
#  2. actor_harness.cpp    the real AetherSpaceActor.cpp run against a stand-in for the engine (ue_stubs/)
#  3. fx_core_test.cpp     the Niagara layer's maths: which link a pulse runs, shooting stars, coronas, the pool (Private/AetherFxMath.h)
#  4. fx_actor_harness.cpp the real AetherFxActor.cpp run against the same stand-in, with fake Niagara components that record what they are told
#  5. view_core_test.cpp   the brain viewer's maths: how big a far body must be drawn, how often a big scene is redrawn, unplaced layouts (Private/AetherViewMath.h)
#  6. brain_actor_harness.cpp  the real AetherBrainActor.cpp and AetherScene.cpp run against another stand-in (brain_stubs/): the scene it is sent, what it draws, what it says
#  7. sky_core_test.cpp    the 8K sky, sun and corona generators: determinism, thread independence, seams, colour by temperature (Private/AetherSkyMath.h)
#  8. ship_core_test.cpp   the mesh toolkit and the three ships: outward faces, tangent frames, symmetry, size, the tileable hull maps (Private/AetherMeshMath.h, AetherShipMath.h)
#  9. rock_core_test.cpp   the asteroid meshes and rock maps (Private/AetherRockMath.h)
# 10. combat_core_test.cpp the voyage: route, asteroid fields, shots, fracture, shield, pilot, aim, debris (Private/AetherCombatMath.h)
# 11. unity_check.cpp      both actors in one translation unit, as Unreal's unity build joins them (helper names must not clash)
set -e
cd "$(dirname "$0")"
CXX="${CXX:-c++}"
TMP="${TMPDIR:-/tmp}"
P=../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain
WARN="-Wall -Wextra -Wshadow -Wconversion -Wno-sign-conversion -Werror"
"$CXX" -std=c++17 -O1 $WARN -o "$TMP/aether_space_core_test" space_core_test.cpp
"$TMP/aether_space_core_test"
"$CXX" -std=c++20 -O1 -g $WARN -I ue_stubs -I "$P/Public" -I "$P/Private" actor_harness.cpp "$P/Private/AetherSpaceActor.cpp" -o "$TMP/aether_actor_harness"
"$TMP/aether_actor_harness"
"$CXX" -std=c++17 -O1 $WARN -o "$TMP/aether_fx_core_test" fx_core_test.cpp
"$TMP/aether_fx_core_test"
"$CXX" -std=c++20 -O1 -g $WARN -I ue_stubs -I "$P/Public" -I "$P/Private" fx_actor_harness.cpp "$P/Private/AetherFxActor.cpp" -o "$TMP/aether_fx_actor_harness"
"$TMP/aether_fx_actor_harness"
"$CXX" -std=c++17 -O1 $WARN -o "$TMP/aether_view_core_test" view_core_test.cpp
"$TMP/aether_view_core_test"
"$CXX" -std=c++17 -O1 -pthread $WARN -o "$TMP/aether_sky_core_test" sky_core_test.cpp
"$TMP/aether_sky_core_test"
"$CXX" -std=c++17 -O1 -pthread $WARN -o "$TMP/aether_ship_core_test" ship_core_test.cpp
"$TMP/aether_ship_core_test"
"$CXX" -std=c++17 -O1 -pthread $WARN -o "$TMP/aether_rock_core_test" rock_core_test.cpp
"$TMP/aether_rock_core_test"
"$CXX" -std=c++17 -O1 $WARN -o "$TMP/aether_combat_core_test" combat_core_test.cpp
"$TMP/aether_combat_core_test"
# Address and undefined-behaviour checking where the compiler has it (an instance range that does not fit, a read past a TArray).
SAN=""
if echo 'int main(){return 0;}' | "$CXX" -x c++ -fsanitize=address,undefined -o "$TMP/aether_san_probe" - 2>/dev/null; then
	SAN="-fsanitize=address,undefined -fno-sanitize-recover=undefined"
fi
"$CXX" -std=c++20 -O1 -g $SAN -Wall -Wextra -Wshadow -Wno-unused-parameter -Werror -I brain_stubs -I "$P/Public" -I "$P/Private" brain_actor_harness.cpp -o "$TMP/aether_brain_actor_harness"
ASAN_OPTIONS=detect_leaks=0 "$TMP/aether_brain_actor_harness"
"$CXX" -std=c++20 -fsyntax-only $WARN -I ue_stubs -I "$P/Public" -I "$P/Private" unity_check.cpp
echo "unity check: ok"
