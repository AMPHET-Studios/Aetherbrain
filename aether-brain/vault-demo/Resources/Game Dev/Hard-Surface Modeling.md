---
title: Hard-Surface Modeling
type: resource
tags: [3d, gamedev]
created: 2026-02-15
updated: 2026-08-20
status: budding
---
# Hard-Surface Modeling

Modeling manufactured, rigid objects — machines, architecture, props. My pipeline is Blender for modeling and Unreal for the final look.

## Pipeline
1. **Blockout** — primary forms only, at real-world scale, tested in engine early
2. **Secondary forms** — cuts, panels, big bevels
3. **Tertiary detail** — bolts, engraving, damage
4. **Game mesh** — mid-poly with weighted normals for most props, Nanite for hero assets
5. **Materials** — trim sheets and tiling [[PBR Materials]]

## Principles
- Every real edge has a bevel; bevels catch light and sell scale
- Forms before details: if the blockout is boring, greebles won't save it
- Keep a clear hierarchy of primary, secondary and tertiary forms — the 3D side of [[Shape Language]]
- Judge the [[Silhouette Design|silhouette]] from gameplay distance, not from the modeling viewport

## Techniques
- Booleans for fast cuts, then clean up topology wherever it breaks the shading
- Weighted normals for flat surfaces without support loops
- Floating detail meshes for bolts and plates that a bake or Nanite can absorb

## Drawing helps
Thinking in boxes and ellipses from [[Perspective Fundamentals]] makes blockouts much faster — it's the same construction, just with a mouse.

Currently applied to the [[Monolith Generator Asset]].
