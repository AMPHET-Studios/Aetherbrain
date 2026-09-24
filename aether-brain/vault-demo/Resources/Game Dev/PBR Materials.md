---
title: PBR Materials
type: resource
tags: [gamedev, 3d, graphics]
created: 2026-01-20
updated: 2026-09-16
status: evergreen
---
# PBR Materials

Physically based rendering materials describe surfaces with measurable properties, so they look right under any light. I use the metallic/roughness workflow, which Unreal, Blender and three.js all speak.

## The maps
- **Base color** — local color with no lighting baked in; the painter's idea of local color from [[Color and Light]]
- **Metallic** — almost always 0 or 1; in-between values are for transitions like dust on metal
- **Roughness** — how blurry the reflections are
- **Normal** — small-scale surface detail
- **AO** — cavity darkening; keep it subtle
- **Emissive** — light the surface gives off; drives [[Bloom Post-Processing]] when bright enough

## Roughness
Roughness is where the story lives. Base color tells you *what* a surface is; roughness tells you *what happened to it*: fingerprints on bronze, polished edges where hands touched, wet streaks down stone after rain. For the [[Monolith Generator Asset]] I want dry, rough stone with glossy rain channels following the carved grooves.

## Rules of thumb
- Keep non-metal base colors away from pure black and pure white
- Never paint lighting into base color
- Break up roughness at large, medium and small scales; uniform roughness looks CG
- Check materials under several lighting setups, not just the flattering one

## Related
- Surfaces get their shape from [[Hard-Surface Modeling]]
- The game's material palette is defined in [[Ancient High-Tech Aesthetic]]
