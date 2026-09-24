---
title: Bloom Post-Processing
type: resource
tags: [graphics, shaders]
created: 2026-02-20
updated: 2026-09-22
status: evergreen
aliases: [Bloom]
---
# Bloom Post-Processing

Bloom simulates light bleeding beyond bright areas — the glow around lamps that cameras and eyes both produce. It's what makes emissive things read as *light* rather than as bright paint.

## The standard pipeline
1. Render the scene in HDR, so values can exceed 1.0
2. **Bright pass:** keep pixels above a threshold, with a soft knee to avoid popping
3. **Downsample** into a mip chain, filtering as you go
4. **Upsample** back up, adding each level — a wide, smooth glow for cheap
5. Composite over the scene, *then* tonemap

The downsample/upsample chain presented by Jorge Jimenez at SIGGRAPH 2014 (post-processing in *Call of Duty: Advanced Warfare*) is the approach most engines now follow.

## Selective Bloom
Global bloom smears everything bright-ish. For control:
- Push emissive materials well above 1.0 and keep the threshold near 1.0, so only true emitters glow
- Or render glowing objects to a separate layer or mask and bloom only that
- In [[Aether Brain]], neurons and filament cores glow; labels and UI never do

## Art direction
Bloom is a value decision. It only reads when the surrounding frame leaves dark headroom — [[Value Structure]] applies to renderers too. And painters already know the halo can sit slightly cooler than the core — [[Color and Light]].

## Used in
- [[Shader Study - Neural Filaments]]
- The crystal seam of the [[Monolith Generator Asset]], fed by emissive [[PBR Materials]]
