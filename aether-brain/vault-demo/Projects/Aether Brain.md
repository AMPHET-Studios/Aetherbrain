---
title: Aether Brain
type: project
tags: [tools, knowledge-work, graphics, 3d]
created: 2026-01-12
updated: 2026-09-23
status: active
---
# Aether Brain

A local-first 3D second brain. Point it at a folder of markdown files: notes become neurons, wikilinks become synapses, and you can fly through your own thinking. The files stay plain text and stay yours.

## Why
Flat graph views prove that notes are connected, but not *how* a body of thinking is shaped. I want to move through my ideas the way I'd walk a game level: clusters as regions, bridges as paths, forgotten corners visibly dim. It's the [[Memex]] dream of associative trails made spatial, with a [[Zettelkasten]] as the substrate.

## Architecture
- **Core** — parses frontmatter, wikilinks, tags and headings from plain `.md` files; the files are always the source of truth
- **Graph** — a 3D [[Force-Directed Layout]] with a Barnes–Hut approximation, running in [[Web Workers]] so the UI never stutters
- **Render** — neurons via [[Instanced Rendering]], synapses from the [[Shader Study - Neural Filaments]], and [[Bloom Post-Processing|selective bloom]] for the glow
- **Shells** — a web app and a desktop app built on the same packages

## Open Questions
- [ ] How should unresolved links look? Current plan: translucent "ghost neurons"
- [ ] Should review age dim neurons? (tie-in with [[Spaced Repetition]])
- [ ] Clusters from tags, folders, or pure topology?
- [ ] What's the right camera for 5,000+ notes — orbit, fly, or both?
- [x] Keep the vault format fully Obsidian-compatible

## Status
Core and graph are solid; rendering is in the polish phase. Getting it into people's hands lives in the [[Aether Brain Launch Plan]].
