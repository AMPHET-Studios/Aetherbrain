/**
 * A star screen: a live picture of an app (the desktop's Concept Forge)
 * floating above one project star. It grows out of the star when the camera
 * comes close (like a star gallery) and folds back into it when the camera
 * leaves. This is the pure part: where the screen sits, how big it is, how it
 * fades when the camera comes right up to it. No three.js, so it is
 * unit-tested in node.
 */

/** The screen opens once the camera has stayed close to its star this long (ms): flying past opens nothing. */
export const SCREEN_DWELL_MS = 300
/**
 * Width of the screen, in system radii of its star (at least SCREEN_MIN_EXTENT). With SCREEN_GAP it is sized so
 * the whole screen (gap + 1.05 × 0.625 ≈ 0.81 radii above the star) stays in view where a fly to the star ends.
 */
export const SCREEN_WIDTH = 1.05
/** Gap between the star and the screen's lower edge, in system radii: clear of the star's own glow. */
export const SCREEN_GAP = 0.15
/** System radius a small star counts with: one with a single planet still gets a readable screen. */
export const SCREEN_MIN_EXTENT = 30
/** Shape of the screen before its first frame arrives (the Concept Forge window's 1600 × 1000). */
export const SCREEN_DEFAULT_ASPECT = 1000 / 1600

export interface ScreenPlacement {
  /** Centre of the screen (world). */
  x: number
  y: number
  z: number
  /** Size of the screen (world units), already grown. */
  width: number
  height: number
}

/**
 * Where the screen of the star at (sx, sy, sz) sits: centred above it along
 * the camera's up direction (ux, uy, uz, a unit vector), its lower edge
 * SCREEN_GAP system radii above the star, SCREEN_WIDTH system radii wide,
 * `aspect` (height / width) tall. `grow` (0..1, already eased) scales it and
 * slides it out of the star: at 0 it is a point at the star.
 */
export function screenPlacement(
  sx: number,
  sy: number,
  sz: number,
  extent: number,
  aspect: number,
  ux: number,
  uy: number,
  uz: number,
  grow: number,
): ScreenPlacement {
  const size = Math.max(SCREEN_MIN_EXTENT, Number.isFinite(extent) ? extent : 0)
  const a = Number.isFinite(aspect) && aspect > 0.05 && aspect < 20 ? aspect : SCREEN_DEFAULT_ASPECT
  const g = Math.min(1, Math.max(0, Number.isFinite(grow) ? grow : 0))
  const width = size * SCREEN_WIDTH * g
  const height = width * a
  const rise = (size * SCREEN_GAP + (size * SCREEN_WIDTH * a) / 2) * g
  // A degenerate up direction (zero length, not a number): straight up the world's y axis.
  const len = Math.hypot(ux, uy, uz)
  const [dx, dy, dz] = len > 1e-9 && Number.isFinite(len) ? [ux / len, uy / len, uz / len] : [0, 1, 0]
  return { x: sx + dx * rise, y: sy + dy * rise, z: sz + dz * rise, width, height }
}

/**
 * How solid the screen is with the camera `dist` from its centre: 1 from
 * 0.9 screen widths away, fading to nothing at 0.35 widths, so a camera
 * that flies right up to it (or through it, to a planet) sees through it.
 */
export function screenFade(dist: number, width: number): number {
  if (!(width > 0) || !Number.isFinite(dist)) return 1
  const t = (dist / width - 0.35) / (0.9 - 0.35)
  return Math.min(1, Math.max(0, t))
}
