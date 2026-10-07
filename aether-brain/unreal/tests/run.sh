#!/bin/sh
# Compile (with strict warnings) and run the viewer's host tests with an ordinary C++ compiler: no Unreal needed.
#  1. space_core_test.cpp  the space world's maths: pictures, parallax, paths, ships (Private/AetherSpaceMath.h)
#  2. actor_harness.cpp    the real AetherSpaceActor.cpp run against a stand-in for the engine (ue_stubs/)
#  3. fx_core_test.cpp     the Niagara layer's maths: which link a pulse runs, shooting stars, coronas, the pool (Private/AetherFxMath.h)
#  4. fx_actor_harness.cpp the real AetherFxActor.cpp run against the same stand-in, with fake Niagara components that record what they are told
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
