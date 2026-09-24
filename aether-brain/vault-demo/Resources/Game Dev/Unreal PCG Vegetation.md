---
title: Unreal PCG Vegetation
type: resource
tags: [unreal, gamedev, portal-game]
created: 2026-03-10
updated: 2026-07-15
status: budding
---
# Unreal PCG Vegetation

Unreal's Procedural Content Generation framework lets me grow a rainforest from rules instead of placing every fern by hand. #unreal

## Graph for the terrace
1. **Surface Sampler** on the landscape — points at a set density
2. **Normal To Density** plus a **Density Filter** — steep slopes get roots and moss, flat ground gets ferns
3. **Difference** against path splines and gameplay volumes — keep routes readable
4. **Noise-driven density** — clumps and clearings, never an even carpet
5. **Transform Points** — random scale and yaw; align ground cover to the surface
6. **Static Mesh Spawner** — a weighted mesh list per layer

## Layers
| Layer | Examples | Density |
|---|---|---|
| Canopy | buttress-root trees | sparse, hand-placed anchors |
| Understory | palms, tree ferns | medium |
| Ground | ferns, moss, leaf litter | dense |
| Detail | lianas on ruins | along ruin splines only |

## Lessons
- Spawned meshes end up as instanced components, which is why thousands of ferns are cheap — the same idea as [[Instanced Rendering]]
- Keep seeds deterministic so art-review screenshots stay reproducible
- Vegetation should frame the ruins, not bury them: plan it with the same eye as [[Composition]]
- Overgrowth tells time — see [[Environmental Storytelling]]

Built with [[Theo Lindqvist]] for the [[Portal Game Vertical Slice]].
