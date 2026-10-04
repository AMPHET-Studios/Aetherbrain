#!/bin/sh
# Compile (with strict warnings) and run the space world's tests with an ordinary C++ compiler: no Unreal needed.
#  1. space_core_test.cpp  the maths: pictures, parallax, paths, ships (Private/AetherSpaceMath.h)
#  2. actor_harness.cpp    the real AetherSpaceActor.cpp run against a stand-in for the engine (ue_stubs/)
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
