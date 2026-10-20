/**
 * The sky behind the brain, as plain data (no three.js, no GPU): where the Milky Way lies, where the nebulae and the
 * distant galaxies hang, and the stars themselves. The shader (`skyShader.ts`) paints the soft parts (the galactic
 * band, the dust lanes, the clouds) into a cube map once; the stars are real points so they stay sharp however far
 * the camera is zoomed. Both read the same constants here, so the stars crowd along the band the shader draws.
 * Everything is a pure function of a seed: the same sky every time.
 */

export type Vec3 = readonly [number, number, number]

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** The pole of the galactic plane: the Milky Way is the great circle 90° from it. Tilted so the band crosses the home view on a diagonal. */
export const GALACTIC_NORMAL: Vec3 = unit([0.34, 0.84, 0.42])

/** The direction of the galactic centre: in the plane (90° from the pole), where the band is brightest and warmest. */
export const GALACTIC_CENTER: Vec3 = (() => {
  // Gram-Schmidt: a reference direction with its part along the pole taken away.
  const ref: Vec3 = [0.78, 0.12, -0.62]
  const d = ref[0] * GALACTIC_NORMAL[0] + ref[1] * GALACTIC_NORMAL[1] + ref[2] * GALACTIC_NORMAL[2]
  return unit([ref[0] - d * GALACTIC_NORMAL[0], ref[1] - d * GALACTIC_NORMAL[1], ref[2] - d * GALACTIC_NORMAL[2]])
})()

export interface Nebula {
  /** Where its middle lies (unit vector). */
  dir: Vec3
  /** How far it reaches from that middle, in radians. */
  radius: number
  /** Linear colour at its brightest: kept well under the bloom threshold (1.0), a nebula is a haze, not a flare. */
  color: Vec3
}

/** Four emission nebulae: a rose one, a teal one, a violet one and a gold one. */
export const NEBULAE: readonly Nebula[] = [
  { dir: unit([-0.62, 0.34, -0.7]), radius: 0.82, color: [0.95, 0.2, 0.46] },
  { dir: unit([0.7, -0.22, -0.68]), radius: 0.9, color: [0.12, 0.62, 0.78] },
  { dir: unit([0.12, 0.68, 0.72]), radius: 0.74, color: [0.42, 0.22, 0.95] },
  { dir: unit([-0.5, -0.56, 0.66]), radius: 0.7, color: [0.98, 0.58, 0.2] },
]

export interface DistantGalaxy {
  dir: Vec3
  /** Angular size of its long axis, in radians. */
  size: number
  /** 0 face-on (round) to 1 edge-on (a thin streak). */
  tilt: number
  /** Position angle of its long axis, in radians. */
  angle: number
  color: Vec3
}

/** Two faint galaxies far beyond ours: a smudge with a bright heart, the thing that says "this is deep space". */
export const DISTANT_GALAXIES: readonly DistantGalaxy[] = [
  { dir: unit([0.86, 0.38, 0.34]), size: 0.2, tilt: 0.72, angle: 0.6, color: [0.9, 0.8, 0.95] },
  { dir: unit([-0.3, -0.82, -0.48]), size: 0.14, tilt: 0.5, angle: 2.1, color: [0.75, 0.85, 1.0] },
]

export interface SkyStars {
  count: number
  /** Positions on the star shell: 3 floats a star, at `radius`. */
  position: Float32Array
  /** Size in pixels at the reference distance: most are pinpoints, a few are bright. */
  size: Float32Array
  /** Twinkle phase, 0 to 2π. */
  phase: Float32Array
  /** Colour temperature, 0 (blue-white) to 1 (orange). */
  temp: Float32Array
  /** How bright, 0 to 1. */
  bright: Float32Array
}

/** Distance of the star shell from the camera (the sky travels with the camera, so only the ratio to the far plane matters). */
export const STAR_SHELL_MIN = 900
export const STAR_SHELL_SPAN = 700

/** Share of the stars that crowd the Milky Way's band (the rest are spread over the whole sky). */
export const BAND_SHARE = 0.42

/** A small, fast, deterministic generator (LCG): the same seed always gives the same sky. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** A direction at the given latitude (sine of the angle above the galactic plane, -1..1) and a random longitude, in sky coordinates. */
function onSky(lat: number, lon: number): Vec3 {
  const n = GALACTIC_NORMAL
  const c = GALACTIC_CENTER
  const b: Vec3 = [n[1] * c[2] - n[2] * c[1], n[2] * c[0] - n[0] * c[2], n[0] * c[1] - n[1] * c[0]]
  const r = Math.sqrt(Math.max(0, 1 - lat * lat))
  const cl = Math.cos(lon) * r
  const sl = Math.sin(lon) * r
  return [c[0] * cl + b[0] * sl + n[0] * lat, c[1] * cl + b[1] * sl + n[1] * lat, c[2] * cl + b[2] * sl + n[2] * lat]
}

/**
 * The stars: `count` of them. Most are faint pinpoints; size follows a steep power so a dozen are big and bright, and
 * `BAND_SHARE` of them sit near the galactic plane (a narrow bell around it), thickest toward the centre.
 */
export function makeSkyStars(count: number, seed = 1337): SkyStars {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  const rnd = lcg(seed)
  const position = new Float32Array(n * 3)
  const size = new Float32Array(n)
  const phase = new Float32Array(n)
  const temp = new Float32Array(n)
  const bright = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let lat: number
    let lon = rnd() * Math.PI * 2
    if (rnd() < BAND_SHARE) {
      // A bell around the plane: the sum of three uniforms is close to a normal one.
      lat = ((rnd() + rnd() + rnd()) / 3 - 0.5) * 0.7
      // Thicker toward the centre (longitude 0): push some of the stars there.
      if (rnd() < 0.35) lon = (rnd() + rnd() - 1) * 1.1
    } else {
      lat = rnd() * 2 - 1
    }
    const d = onSky(lat, lon)
    const r = STAR_SHELL_MIN + rnd() * STAR_SHELL_SPAN
    position[i * 3] = d[0] * r
    position[i * 3 + 1] = d[1] * r
    position[i * 3 + 2] = d[2] * r
    const m = rnd()
    // m^9: nearly all faint, a few bright.
    const lum = Math.pow(m, 9)
    size[i] = 1.1 + lum * 7.5
    bright[i] = 0.22 + 0.78 * Math.min(1, Math.pow(m, 3) * 1.4)
    phase[i] = rnd() * Math.PI * 2
    // Most stars are white-blue; a minority are yellow or orange; the brighter ones lean blue (hot).
    const t = rnd()
    temp[i] = t < 0.55 ? t * 0.35 : t < 0.88 ? 0.2 + t * 0.4 : 0.7 + (t - 0.88) * 2.5
  }
  return { count: n, position, size, phase, temp, bright }
}

/** The darkest and the brightest the baked sky may be, in linear light (the bloom threshold is 1.0: the sky never blooms). */
export const SKY_MAX_LINEAR = 0.6
