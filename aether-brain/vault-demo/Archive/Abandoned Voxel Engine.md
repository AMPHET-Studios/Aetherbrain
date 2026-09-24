---
title: Abandoned Voxel Engine
type: note
tags: [graphics, gamedev]
created: 2025-03-05
updated: 2025-06-10
status: done
---
# Abandoned Voxel Engine

A hobby voxel engine I started in early 2025 to learn low-level graphics. Shelved after about three months. No regrets — it paid for itself in lessons.

## What worked
- A chunked world: 32×32×32 blocks per chunk, meshed on a background thread
- Greedy meshing cut the triangle count by roughly an order of magnitude on flat terrain
- Cheap per-vertex ambient occlusion computed from neighbouring blocks

## Why I stopped
- The fun part (rendering) was done in weeks; the rest was tooling, saving and editing — months of plumbing
- It was an engine, not a game. There was nothing to *play*
- Art time dropped to zero, and art is the work that pays

## Lessons I kept
- Scope to an experience, not to a technology
- Profile before optimizing; my first bottleneck was memory allocation, not the GPU
- Meshing on a background thread taught me how to keep a render loop smooth — useful later for browser graphics work

Code is zipped in cold storage.
