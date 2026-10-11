#!/bin/sh
# Make the ships and their hull maps exactly as the viewer does and show them as pictures: ship_preview.sh [folder] [map size].
set -e
cd "$(dirname "$0")"
OUT="${1:-./ship_preview}"
SIZE="${2:-2048}"
CXX="${CXX:-c++}"
mkdir -p "$OUT"
BIN="${TMPDIR:-/tmp}/aether_ship_preview"
"$CXX" -std=c++17 -O2 -pthread -Wall -Wextra -Wshadow -Wconversion -Wno-sign-conversion -o "$BIN" ship_preview.cpp
"$BIN" "$OUT" "$SIZE"
for f in "$OUT"/*.ppm; do python3 ppm2png.py "$f" && rm "$f"; done
ls -la "$OUT"
