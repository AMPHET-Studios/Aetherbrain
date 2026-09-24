---
title: Shader Study - Neural Filaments
type: project
tags: [shaders, graphics, 3d]
created: 2026-07-21
updated: 2026-09-22
status: active
---
# Shader Study - Neural Filaments

Goal: make [[Aether Brain]]'s synapses look like living filaments instead of flat lines — thin, glowing, with pulses of activity travelling along them. #shaders

## Approach
1. Each edge is a camera-facing quad, drawn with [[Instanced Rendering]] — one draw call for every edge in the vault
2. In the fragment shader, distance from the centre line gives a soft core plus a halo — a 2D capsule borrowed from [[Signed Distance Fields]]
3. A pulse is a moving Gaussian along the edge's `u` coordinate, driven by time
4. The core is pushed above 1.0 so only it catches bloom

```glsl
float core  = exp(-d * d * 180.0);
float halo  = exp(-d * d * 12.0) * 0.25;
float pulse = exp(-pow(fract(u - uTime * 0.4) - 0.5, 2.0) * 90.0);
vec3 col = uTint * (core * 1.6 + halo + pulse * 2.0);
```

## Findings so far
- The halo reads better slightly cooler than the core — warm core, cool falloff, straight out of [[Color and Light]]
- Thin lines alias badly at a distance; fade width and alpha with depth
- Pulses read as "activity" only when they're rare

## Reference

![[Bloom Post-Processing#Selective Bloom]]
