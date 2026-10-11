#!/bin/sh
# Make the 8K sky and suns exactly as the viewer does and show them as pictures: sky_preview.sh [folder] [width].
set -e
cd "$(dirname "$0")"
OUT="${1:-./sky_preview}"
WIDTH="${2:-8192}"
CXX="${CXX:-c++}"
mkdir -p "$OUT"
BIN="${TMPDIR:-/tmp}/aether_sky_preview"
"$CXX" -std=c++17 -O2 -pthread -Wall -Wextra -Wshadow -Wconversion -Wno-sign-conversion -o "$BIN" sky_preview.cpp
"$BIN" "$OUT" "$WIDTH"
for f in "$OUT"/*.ppm; do python3 ppm2png.py "$f" && rm "$f"; done
ls -la "$OUT"
