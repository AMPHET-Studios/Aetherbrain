---
title: Monolith Generator Asset
type: project
tags: [portal-game, 3d, gamedev]
created: 2026-04-18
updated: 2026-09-16
status: active
---
# Monolith Generator Asset

The hero prop of the [[Portal Game Vertical Slice]]: a six-metre basalt monolith split by a seam of glowing crystal, the generator that powers the gate. It has to read from 80 metres away and survive a close-up. #3d

## Design notes
- Primary form: a tall, stable rectangle — [[Shape Language]] for "ancient, immovable"
- Secondary: triangular cuts and a vertical seam that hint at danger and energy
- Tertiary: engraved circuit channels, moss in the crevices, a few bronze clamps
- Must pass the [[Silhouette Design|silhouette]] test against both sky and jungle
- Style reference: [[Ancient High-Tech Aesthetic]]

## Specs
| Item | Target |
|---|---|
| Height | 6 m |
| Texel density | 10.24 px/cm |
| Materials | stone trim sheet, oxidized bronze, emissive crystal |
| Geometry | Nanite mesh, simple collision |

## Tasks
- [x] Blockout and scale check in engine
- [x] High-poly pass — see [[Hard-Surface Modeling]]
- [ ] Stone material: break up [[PBR Materials#Roughness|roughness]] with wet streaks
- [ ] Crystal emissive tuned for [[Bloom Post-Processing#Selective Bloom]]
- [ ] Review the power-up pulse animation with [[Theo Lindqvist]]
