---
title: Force-Directed Layout
type: resource
tags: [graphics, tools, 3d]
created: 2026-01-25
updated: 2026-09-18
status: evergreen
aliases: [Force Layout]
---
# Force-Directed Layout

A way to place the nodes of a graph by simulating physics: linked nodes attract like springs, all nodes repel like charges, and the system settles into a shape where clusters emerge on their own. #graphics

## Forces
- **Repulsion** between every pair (Coulomb-like) — keeps nodes from overlapping
- **Attraction** along edges (Hooke springs) — pulls linked ideas together
- **Centering** — stops the whole graph drifting away
- **Damping** — velocity decay, so it settles instead of oscillating forever

## History
Peter Eades' spring embedder (1984) and the Fruchterman–Reingold algorithm (1991) set the template. Naive repulsion is O(n²); the Barnes–Hut approximation (1986) groups distant nodes in an octree for roughly O(n log n) per step.

## Tuning notes
- Cool the simulation over time with a decaying "alpha", and reheat it on edits
- Set link distance by type: hub-to-note shorter than note-to-note
- Honestly, tuning damping and spring stiffness is closer to Game Feel than to math — you tweak until it *feels* right

## Why it fits notes
A [[Zettelkasten]] has no predefined hierarchy, so a layout that lets structure emerge from links is the honest way to draw one. [[Maps of Content]] naturally become hubs.

## Implementation
- Runs off the main thread in [[Web Workers]]
- Drawn with [[Instanced Rendering]]
- Part of [[Aether Brain#Architecture]]
