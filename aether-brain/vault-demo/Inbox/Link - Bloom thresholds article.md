---
title: Link - Bloom thresholds article
type: inbox
tags: [idea, graphics]
created: 2026-09-15
updated: 2026-09-22
status: unprocessed
---
# Link - Bloom thresholds article

Saved from my read-later queue: a long write-up comparing hard and soft-knee thresholds for bloom. Takeaways before I forget:

- A hard cutoff pops and flickers when pixels hover near the threshold; a soft knee eases them in
- Threshold in HDR, *before* tonemapping, or everything bright-ish glows
- The "only emissives above 1.0" trick is exactly what I want for [[Bloom Post-Processing#Selective Bloom]]

This is Value Structure all over again: glow only reads when the rest of the frame leaves headroom. Try it on [[Shader Study - Neural Filaments]] and on the crystal seam of the [[Monolith Generator Asset]].
