/**
 * Star galleries: when the camera comes close to a project star, every
 * picture under the star's folder floats around it as a card (the system
 * layout puts them on a sphere, see `layout/system.ts`). This is the pure
 * part: which star the camera is close to, and how the cards grow and fold.
 * No three.js, so it is unit-tested in node.
 */

/** A gallery opens when the camera is within this many system radii of its star… */
export const GALLERY_OPEN = 2.6
/** …and folds once the camera is further than this (hysteresis: no flicker at the edge). */
export const GALLERY_CLOSE = 3.4
/** System radius a small star counts with: one with a single planet still opens from a fair distance. */
export const GALLERY_MIN_EXTENT = 30
/** Another star takes over an open gallery only when the camera is this much closer to it (relative). */
export const GALLERY_SWITCH = 0.6
/** How often the scene measures the camera against the stars (ms). */
export const GALLERY_CHECK_MS = 150
/** Cards grow out of the star over this long (ms) … */
export const GALLERY_GROW_MS = 900
/** … and shrink back over this long when the gallery folds (ms). */
export const GALLERY_SHRINK_MS = 380
/** The graph lets the cards go this long after the fold starts (ms): once they have shrunk. */
export const GALLERY_FOLD_MS = 420
/** A gallery opened with Shift+G waits this long (ms) for the camera to reach its star. */
export const GALLERY_REACH_MS = 8000

/**
 * The project star the camera at (cx, cy, cz) is close to: the one with the
 * smallest distance over system radius (`extent`, at least
 * GALLERY_MIN_EXTENT), when that is below GALLERY_OPEN. `current` (a node
 * index, −1 for none) stays the answer while the camera is within
 * GALLERY_CLOSE of it, unless another star is within GALLERY_OPEN and
 * GALLERY_SWITCH times closer. `stars` holds node indices, `pos` xyz per node.
 * Returns a node index, or −1.
 */
export function nearestStar(
  stars: ArrayLike<number>,
  pos: ArrayLike<number>,
  extent: ArrayLike<number>,
  cx: number,
  cy: number,
  cz: number,
  current = -1,
  open = GALLERY_OPEN,
): number {
  let best = -1
  let bestRatio = Infinity
  let currentRatio = Infinity
  for (let k = 0; k < stars.length; k++) {
    const i = stars[k]!
    const x = pos[i * 3]
    const y = pos[i * 3 + 1]
    const z = pos[i * 3 + 2]
    const e = extent[i]
    if (x === undefined || y === undefined || z === undefined || e === undefined) continue
    const ratio = Math.hypot(x - cx, y - cy, z - cz) / Math.max(GALLERY_MIN_EXTENT, Number.isFinite(e) ? e : 0)
    if (!Number.isFinite(ratio)) continue
    if (i === current) currentRatio = ratio
    if (ratio < bestRatio) {
      bestRatio = ratio
      best = i
    }
  }
  if (currentRatio < GALLERY_CLOSE && !(best !== current && bestRatio < open && bestRatio < currentRatio * GALLERY_SWITCH)) return current
  return bestRatio < open ? best : -1
}

/** Ease a 0..1 growth value (smoothstep): cards start and settle gently. */
export function easeGrow(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

/**
 * One frame of card growth: `grow` (linear 0..1) moves toward 1 while the
 * gallery is open (over GALLERY_GROW_MS) and toward 0 while it folds (over
 * GALLERY_SHRINK_MS). `dtMs` is clamped, so a frame after a long pause never
 * jumps.
 */
export function stepGrow(grow: number, folding: boolean, dtMs: number): number {
  const dt = Math.min(100, Math.max(0, Number.isFinite(dtMs) ? dtMs : 0))
  return folding ? Math.max(0, grow - dt / GALLERY_SHRINK_MS) : Math.min(1, grow + dt / GALLERY_GROW_MS)
}
