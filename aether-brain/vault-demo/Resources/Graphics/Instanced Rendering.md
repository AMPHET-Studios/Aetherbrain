---
title: Instanced Rendering
type: resource
tags: [graphics, 3d, shaders]
created: 2026-03-02
updated: 2026-09-18
status: budding
---
# Instanced Rendering

Drawing many copies of the same mesh in a single draw call, with per-instance data (transform, color, custom attributes) supplied in a buffer. The GPU is happy, and the CPU stops being the bottleneck.

## Why
Draw calls are expensive on the CPU side. Five thousand neurons as five thousand meshes means five thousand draw calls; as one instanced mesh, it's one.

## In three.js
- `InstancedMesh(geometry, material, count)`
- `setMatrixAt(i, matrix)` and `setColorAt(i, color)`, then flag `instanceMatrix.needsUpdate = true`
- Custom per-instance data through `InstancedBufferAttribute` — glow strength, review age, cluster id
- Watch culling: the whole batch shares one bounding volume, so recompute it or disable frustum culling while nodes move

## Tricks
- Draw camera-facing quads and shade them as sphere impostors in the fragment shader using [[Signed Distance Fields]] — far fewer vertices than real spheres
- Edges can be instanced too — one quad per link, as in [[Shader Study - Neural Filaments]]
- Upload positions straight from the buffer produced by the layout in [[Web Workers]]

## Elsewhere
Unreal does the same thing under the hood when PCG spawns thousands of ferns — [[Unreal PCG Vegetation]].

Powers the [[Force-Directed Layout]] view in [[Aether Brain#Architecture]].
