/**
 * Guards for the force layouts (constellation, orbit).
 *
 * d3-octree's `cover` ignores a NaN coordinate but loops forever on an infinite one: it doubles an extent that can
 * never contain the point and allocates a node on every pass, about a gigabyte a second. The layout worker shares the
 * window's process, so the window "ran out of memory" with the worker stuck at its first tick: every body at the origin,
 * one clumped star, no orbits. Nothing that reaches a force may be able to turn infinite, so the inputs are made finite
 * here and a body that still turns up non-finite is put back before the next tick.
 */

/** Most degree a link's strength divides by (a hub of many links does not make its links ever weaker). */
const LINK_DEGREE_CAP = 12

/**
 * Strength of a link: `base` over the smaller degree of its two ends, between 1 and 12.
 *
 * The 1 is the point. A degree is what the note links to and is linked from, and a Today beam (hub → a note with a
 * task due today) is not counted in it: that note can have degree 0, and `base / 0` is Infinity, which made the
 * velocity of both ends infinite on the first tick.
 */
export function linkStrength(base: number, sourceDegree: number, targetDegree: number): number {
  const d = Math.min(sourceDegree, targetDegree, LINK_DEGREE_CAP)
  // `d >= 1` is false for 0, a negative number and NaN alike.
  return base / (d >= 1 ? d : 1)
}

/** `v` when it is a finite number, else `fallback`. */
export function finiteOr(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** The part of a d3 node the simulation moves. */
export interface Body {
  x?: number
  y?: number
  z?: number
  vx?: number
  vy?: number
  vz?: number
}

/**
 * Put back every body whose place or speed is not finite: at `home(d)` (its area's anchor, say), at rest. Returns how
 * many there were. One pass over the nodes, cheap enough for every tick.
 */
export function healBodies<T extends Body>(nodes: readonly T[], home: (d: T) => readonly [number, number, number]): number {
  let healed = 0
  for (const d of nodes) {
    if (
      Number.isFinite(d.x) &&
      Number.isFinite(d.y) &&
      Number.isFinite(d.z) &&
      Number.isFinite(d.vx) &&
      Number.isFinite(d.vy) &&
      Number.isFinite(d.vz)
    ) {
      continue
    }
    const h = home(d)
    d.x = h[0]
    d.y = h[1]
    d.z = h[2]
    d.vx = 0
    d.vy = 0
    d.vz = 0
    healed++
  }
  return healed
}
