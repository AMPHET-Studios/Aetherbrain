/**
 * Suns open into planets, then moons: which bodies are shown, and how they come out of their sun. Pure arrays in, arrays out
 * (no three.js), so it is tested without a scene and costs the frame loop one pass over the bodies and no allocation.
 *
 * Every body has a target: 1 shown, 0 hidden. A body is shown when its sun's level reaches its tier (planets from level 1,
 * moons from level 2), always for tier 0 (galaxies, the folders under them, the Today hub), for the body that is selected, for the
 * gallery cards (they have their own growth), for what a search lit up, and for everything when the sun levels are off or the
 * layout is not the system layout. The body's `reveal` then moves toward its target over `REVEAL_SECONDS`: it grows out of its
 * sun along its own orbit and shrinks back into it, so opening and closing read as an unfolding, not a pop.
 */

/** Seconds a body takes to come out of its sun (or go back into it). */
export const REVEAL_SECONDS = 0.55

/** Smoothstep: slow out of the sun, slow into the orbit. */
export function easeReveal(r: number): number {
  const x = r <= 0 ? 0 : r >= 1 ? 1 : r
  return x * x * (3 - 2 * x)
}

export interface RevealInput {
  count: number
  /** 0 always shown, 1 from planets, 2 from moons (`bodyTiers`). */
  tier: Uint8Array
  /** The sun (node index) each body belongs to, -1 for none (`bodyOwners`). */
  owner: Int32Array
  /** Node indices with every sun before the bodies it owns (`bodyOrder`): one pass settles who is shown. */
  order: Int32Array
  /** The level of each sun, by node index (0 closed, 1 planets, 2 planets and moons). */
  level: Uint8Array
  /** 1 per star gallery card: they are shown whatever the level says. */
  card: ArrayLike<number>
  /** The selected node's index, or -1: it is always shown. */
  selected: number
  /** True for a body a search or a filter lit up (null: nothing is lit). */
  lit: ((i: number) => boolean) | null
  /** Show everything (the sun levels are off, or this is not the system layout). */
  all: boolean
}

/** Fill `out` with each body's target: 1 shown, 0 hidden. */
export function revealTargets(input: RevealInput, out: Uint8Array): void {
  const { count, tier, owner, order, level, card, selected, lit, all } = input
  if (all) {
    out.fill(1, 0, count)
    return
  }
  for (let q = 0; q < count; q++) {
    const i = order[q]!
    const t = tier[i]!
    const o = owner[i]!
    let on = t === 0 || card[i] === 1 || i === selected
    // A body with no sun to open (a graph built without folders) is always shown.
    if (!on) on = o < 0 || level[o]! >= t || (lit !== null && lit(i))
    // A body cannot float around a sun that is itself folded away: it needs its sun shown (the selected one is shown wherever it is).
    if (on && o >= 0 && i !== selected && out[o] === 0) on = false
    out[i] = on ? 1 : 0
  }
}

/**
 * Move every body's reveal toward its target by `dt` seconds' worth. With `instant` it jumps (a fresh scene starts with every
 * body where it belongs: nothing folds into place on the first frame). Returns true when anything moved.
 */
export function stepReveal(reveal: Float32Array, target: Uint8Array, count: number, dt: number, instant: boolean): boolean {
  const step = instant ? 1 : Math.max(0, dt) / REVEAL_SECONDS
  let moved = false
  for (let i = 0; i < count; i++) {
    const r = reveal[i]!
    const t = target[i]!
    if (r === t) continue
    const next = t > r ? Math.min(t, r + step) : Math.max(t, r - step)
    if (next !== r) {
      reveal[i] = next
      moved = true
    }
  }
  return moved
}

/**
 * Where each body is drawn: its place on its orbit, pulled toward its sun by how little of it is revealed. A shown body is
 * exactly where the layout puts it; a hidden one sits in its sun (zero size, so nothing shows), and a link to it ends at the sun.
 */
export function applyReveal(pos: Float32Array, out: Float32Array, owner: Int32Array, reveal: Float32Array, count: number): void {
  for (let i = 0; i < count; i++) {
    const r = reveal[i]!
    const o = owner[i]!
    const k = i * 3
    if (r >= 1 || o < 0) {
      out[k] = pos[k] ?? 0
      out[k + 1] = pos[k + 1] ?? 0
      out[k + 2] = pos[k + 2] ?? 0
      continue
    }
    const e = easeReveal(r)
    const q = o * 3
    const sx = pos[q] ?? 0
    const sy = pos[q + 1] ?? 0
    const sz = pos[q + 2] ?? 0
    out[k] = sx + ((pos[k] ?? 0) - sx) * e
    out[k + 1] = sy + ((pos[k + 1] ?? 0) - sy) * e
    out[k + 2] = sz + ((pos[k + 2] ?? 0) - sz) * e
  }
}

/**
 * The body each ring carries, so a ring can show and hide with it: of the bodies orbiting the ring's parent, the first whose distance
 * from it is the ring's radius (a body sits exactly its orbit radius from its parent). -1 when none is found, the layout not having
 * answered yet: that ring is then always drawn. Returns how many rings found no body (the caller asks again a little later).
 */
export function ringReps(
  ringParent: Int32Array,
  ringRadius: Float32Array,
  ringCount: number,
  childStart: Int32Array,
  childList: Int32Array,
  pos: Float32Array,
  out: Int32Array,
): number {
  let missing = 0
  for (let k = 0; k < ringCount; k++) {
    out[k] = -1
    const p = ringParent[k]!
    const r = ringRadius[k]!
    const px = pos[p * 3] ?? 0
    const py = pos[p * 3 + 1] ?? 0
    const pz = pos[p * 3 + 2] ?? 0
    const tol = r * 0.02 + 0.05
    for (let c = childStart[p]!; c < childStart[p + 1]!; c++) {
      const i = childList[c]!
      const d = Math.hypot((pos[i * 3] ?? 0) - px, (pos[i * 3 + 1] ?? 0) - py, (pos[i * 3 + 2] ?? 0) - pz)
      if (Math.abs(d - r) <= tol) {
        out[k] = i
        break
      }
    }
    if (out[k]! < 0) missing++
  }
  return missing
}

/** The reveal of every orbit ring: that of the body it carries (eased like the body). 1 for a ring with none found, and for a ring of stars. */
export function ringReveal(rep: Int32Array, reveal: Float32Array, rings: number, out: Float32Array): void {
  for (let k = 0; k < rings; k++) {
    const i = rep[k]!
    out[k] = i < 0 ? 1 : easeReveal(reveal[i]!)
  }
}
