---
title: Color and Light
type: concept
tags: [color, drawing, fundamentals]
created: 2025-05-22
updated: 2026-07-30
status: evergreen
---
# Color and Light

How light behaves, and how to paint it convincingly. Named after — and heavily indebted to — [[James Gurney]]'s book *Color and Light: A Guide for the Realist Painter*. #color

## Principles I lean on
- **Temperature contrast:** outdoors, a warm key light usually pairs with cooler, sky-lit shadows; flip it under overcast or artificial light
- **Local color vs. light color:** a red cloth under blue light isn't "red" anymore — paint the result, not the label
- **Atmospheric perspective:** distance lowers contrast and pulls values toward the sky color
- **Subsurface scattering:** leaves, skin and wax glow where light passes through — huge in a rainforest
- **Gamut masking:** choose a limited slice of the color wheel before painting and get harmony for free

## Value first
Color sits on top of [[Value Structure]]. Temperature shifts should happen *within* a value group, not break it apart.

## For the portal game
The [[Ancient High-Tech Aesthetic]] depends on one contrast: warm, humid jungle light against cold cyan energy. Keep the emissive the only saturated thing in its neighbourhood, or it stops looking like light.

## Bridges to rendering
- [[PBR Materials]]: base color is local color with the lighting removed — the painter's distinction, formalized
- [[Bloom Post-Processing]]: a glow halo is a light effect, not a surface color
- [[Composition]]: the most saturated spot competes for attention, so put it at the focal point
