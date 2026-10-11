#!/bin/sh
# Make the Voyage scene: ship, rocks, sun and sky exactly as the viewer does and show them as pictures: voyage_preview.sh [folder] [map size].
set -e
cd "$(dirname "$0")"
OUT="${1:-./voyage_preview}"

CXX="${CXX:-c++}"
mkdir -p "$OUT"
BIN="${TMPDIR:-/tmp}/aether_voyage_preview"
"$CXX" -std=c++17 -O2 -pthread -Wall -Wextra -Wshadow -Wconversion -Wno-sign-conversion -o "$BIN" voyage_preview.cpp
"$BIN" "$OUT"
for f in "$OUT"/*.ppm; do python3 ppm2png.py "$f" && rm "$f"; done
ls -la "$OUT"
