---
title: Glyph Emissive Material
type: resource
tags: [portal-game, unreal, shaders]
created: 2026-07-08
updated: 2026-09-22
status: active
---
# Glyph Emissive Material

UE5 material layer for the [[PORTALz]] glyphs described in [[Glyph Language]], owned with [[Theo Lindqvist]].

- Glyph mask lives in the alpha of the trim sheet, so one texture set covers every ruin ([[PBR Materials]])
- `PowerLevel` scalar (0–1) drives a vertical fill, animated by the [[Gate Opening Sequence]]
- Emissive intensity sits above the bloom threshold; the stone never does, so only glyphs glow ([[Bloom Post-Processing]])
- Dead glyphs fall back to bronze with extra roughness, no emissive cost

Budget: one material instance per ruin set, no dynamic lights, the emissive feeds Lumen instead.
