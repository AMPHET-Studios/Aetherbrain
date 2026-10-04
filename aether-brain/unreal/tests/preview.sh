#!/bin/sh
# Render software pictures of the space world (textures, scene, parallax) into a folder: preview.sh [folder].
set -e
cd "$(dirname "$0")"
OUT="${1:-./preview}"
CXX="${CXX:-c++}"
mkdir -p "$OUT"
BIN="${TMPDIR:-/tmp}/aether_space_preview"
"$CXX" -std=c++17 -O2 -Wall -Wextra -Wshadow -Wconversion -Wno-sign-conversion -o "$BIN" space_preview.cpp
"$BIN" "$OUT"
for f in "$OUT"/*.ppm; do python3 ppm2png.py "$f" && rm "$f"; done
ls -la "$OUT"
