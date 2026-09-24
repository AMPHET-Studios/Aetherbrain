---
title: Game Feel
type: resource
tags: [gamedev, portal-game]
created: 2025-10-30
updated: 2026-09-23
status: budding
---
# Game Feel

The tactile sensation of controlling something in a game. Steve Swink's book *Game Feel* frames it as real-time control, a simulated space, and polish working together. If moving feels good, players forgive a lot.

## Levers
- **Responsiveness:** input to visible reaction within a frame or two
- **Forgiveness:** coyote time, input buffering, generous ledge grabs
- **Anticipation and follow-through:** a wind-up before, a settle after
- **Juice:** camera shake, hit-stop, particles, audio — used sparingly

## Portal traversal checklist
- [x] FOV kick on entry, easing back over 0.3 s
- [x] Brief flare from the portal — [[Bloom Post-Processing]]
- [ ] Low rumble plus a hum pitch-up — needs proper [[Sound Design]]
- [ ] Controller rumble on the threshold
- [ ] Playtest with five people; watch faces, not screens

## Tuning is springs
Most "feel" comes down to springs and damping: camera follow, UI easing, recoil. Too stiff is twitchy, too loose is floaty. The same knobs make a [[Force-Directed Layout]] graph feel alive or dead.

## Related
- Tight feedback keeps players in [[Flow State]]
- Prototyped with [[Theo Lindqvist]] for the [[Portal Game Vertical Slice]]
