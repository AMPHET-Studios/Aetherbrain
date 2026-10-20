import { describe, expect, it } from 'vitest'
import {
  BAND_SHARE,
  DISTANT_GALAXIES,
  GALACTIC_CENTER,
  GALACTIC_NORMAL,
  NEBULAE,
  SKY_MAX_LINEAR,
  STAR_SHELL_MIN,
  STAR_SHELL_SPAN,
  makeSkyStars,
} from '../src/scene/skyData'
import { SKY_BAKE_FRAGMENT, SKY_BAKE_VERTEX, SKY_COLOR_GLSL, SKY_DOME_FRAGMENT, SKY_DOME_VERTEX, SKY_NOISE_GLSL } from '../src/scene/skyShader'

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
const len = (a: readonly number[]): number => Math.hypot(a[0]!, a[1]!, a[2]!)

describe('the sky’s fixed points', () => {
  it('has a galactic pole and centre that are unit vectors at right angles: the Milky Way is a great circle', () => {
    expect(len(GALACTIC_NORMAL)).toBeCloseTo(1, 6)
    expect(len(GALACTIC_CENTER)).toBeCloseTo(1, 6)
    expect(dot(GALACTIC_NORMAL, GALACTIC_CENTER)).toBeCloseTo(0, 6)
  })

  it('hangs four nebulae and two distant galaxies in unit directions, each with a reach', () => {
    expect(NEBULAE).toHaveLength(4)
    expect(DISTANT_GALAXIES).toHaveLength(2)
    for (const n of NEBULAE) {
      expect(len(n.dir)).toBeCloseTo(1, 6)
      expect(n.radius).toBeGreaterThan(0.3)
      expect(n.radius).toBeLessThan(Math.PI / 2)
    }
    for (const g of DISTANT_GALAXIES) {
      expect(len(g.dir)).toBeCloseTo(1, 6)
      expect(g.size).toBeGreaterThan(0)
      expect(g.tilt).toBeGreaterThanOrEqual(0)
      expect(g.tilt).toBeLessThanOrEqual(1)
    }
  })

  it('keeps every colour a haze: linear light under the bloom threshold of 1, so the sky never blooms', () => {
    expect(SKY_MAX_LINEAR).toBeLessThan(1)
    for (const n of NEBULAE) for (const c of n.color) expect(c).toBeLessThanOrEqual(1)
    // What the shader adds up is clamped to the same ceiling.
    expect(SKY_COLOR_GLSL).toContain(`vec3(${SKY_MAX_LINEAR})`)
  })

  it('spreads the four nebulae apart: no two share a part of the sky', () => {
    for (let i = 0; i < NEBULAE.length; i++) {
      for (let j = i + 1; j < NEBULAE.length; j++) {
        const angle = Math.acos(Math.max(-1, Math.min(1, dot(NEBULAE[i]!.dir, NEBULAE[j]!.dir))))
        expect(angle, `${i} and ${j}`).toBeGreaterThan(0.9)
      }
    }
  })
})

describe('the stars', () => {
  it('are the same every time for a seed, and another sky for another seed', () => {
    const a = makeSkyStars(500, 7)
    const b = makeSkyStars(500, 7)
    const c = makeSkyStars(500, 8)
    expect([...a.position]).toEqual([...b.position])
    expect([...a.size]).toEqual([...b.size])
    expect([...a.position]).not.toEqual([...c.position])
  })

  it('come as many as asked, whole numbers only, none for a count that is not one', () => {
    const s = makeSkyStars(1234)
    expect(s.count).toBe(1234)
    expect(s.position).toHaveLength(1234 * 3)
    for (const k of ['size', 'phase', 'temp', 'bright'] as const) expect(s[k], k).toHaveLength(1234)
    expect(makeSkyStars(10.9).count).toBe(10)
    expect(makeSkyStars(0).count).toBe(0)
    expect(makeSkyStars(-5).count).toBe(0)
    expect(makeSkyStars(Number.NaN).count).toBe(0)
  })

  it('sit on a shell round the camera, so only their directions matter', () => {
    const s = makeSkyStars(2000)
    for (let i = 0; i < s.count; i++) {
      const r = Math.hypot(s.position[i * 3]!, s.position[i * 3 + 1]!, s.position[i * 3 + 2]!)
      expect(r).toBeGreaterThanOrEqual(STAR_SHELL_MIN - 0.5)
      expect(r).toBeLessThanOrEqual(STAR_SHELL_MIN + STAR_SHELL_SPAN + 0.5)
    }
  })

  it('stay in their ranges: pinpoints with a few bright ones, white-blue to orange, a twinkle phase round the circle', () => {
    const s = makeSkyStars(4000)
    let big = 0
    for (let i = 0; i < s.count; i++) {
      // The arrays are 32-bit floats: 0.22 is stored as 0.21999999, so the bounds give a hair.
      expect(s.size[i]).toBeGreaterThanOrEqual(1.1 - 1e-5)
      expect(s.size[i]).toBeLessThanOrEqual(8.6001)
      expect(s.bright[i]).toBeGreaterThanOrEqual(0.22 - 1e-6)
      expect(s.bright[i]).toBeLessThanOrEqual(1.0001)
      expect(s.temp[i]).toBeGreaterThanOrEqual(0)
      expect(s.temp[i]).toBeLessThanOrEqual(1.0001)
      expect(s.phase[i]).toBeGreaterThanOrEqual(0)
      expect(s.phase[i]).toBeLessThan(Math.PI * 2 + 1e-5)
      if (s.size[i]! > 6) big++
    }
    // Nearly all are faint; a few are bright (a power law, not a flat spread).
    expect(big).toBeGreaterThan(0)
    expect(big / s.count).toBeLessThan(0.08)
  })

  it('crowd the Milky Way: far more of them lie near the galactic plane than an even sky would give', () => {
    const s = makeSkyStars(20000)
    let near = 0
    for (let i = 0; i < s.count; i++) {
      const x = s.position[i * 3]!
      const y = s.position[i * 3 + 1]!
      const z = s.position[i * 3 + 2]!
      const lat = (x * GALACTIC_NORMAL[0] + y * GALACTIC_NORMAL[1] + z * GALACTIC_NORMAL[2]) / Math.hypot(x, y, z)
      if (Math.abs(lat) < 0.2) near++
    }
    // An even sky puts a fifth of its stars within 0.2 of the plane; the band's share is on top of that.
    expect(near / s.count).toBeGreaterThan(0.2 + BAND_SHARE * 0.6)
  })
})

describe('the sky shaders', () => {
  it('declare as many nebulae and galaxies as the data has (the uniforms are arrays of that size)', () => {
    expect(SKY_COLOR_GLSL).toContain(`uniform vec3 uNebDir[${NEBULAE.length}];`)
    expect(SKY_COLOR_GLSL).toContain(`uniform vec3 uNebCol[${NEBULAE.length}];`)
    expect(SKY_COLOR_GLSL).toContain(`uniform float uNebRad[${NEBULAE.length}];`)
    expect(SKY_COLOR_GLSL).toContain(`uniform vec3 uGalDir[${DISTANT_GALAXIES.length}];`)
    expect(SKY_COLOR_GLSL).toContain(`i < ${NEBULAE.length}`)
  })

  it('bake the whole sky from a direction, with the noise first (the colour function uses it)', () => {
    expect(SKY_BAKE_FRAGMENT).toContain('vec3 skyColor(vec3 dir)')
    expect(SKY_BAKE_FRAGMENT).toContain('skyColor(normalize(vDir))')
    expect(SKY_BAKE_FRAGMENT.indexOf('float fbm')).toBeGreaterThan(-1)
    expect(SKY_BAKE_FRAGMENT.indexOf('float fbm')).toBeLessThan(SKY_BAKE_FRAGMENT.indexOf('vec3 skyColor'))
    expect(SKY_NOISE_GLSL).toContain('float fbm(')
    expect(SKY_BAKE_VERTEX).toContain('vDir = position')
  })

  it('draw the dome at the far plane, turning with the view and never moving with it, dithered and colour-managed', () => {
    // .xyww puts the depth at exactly 1 whatever the camera does; the view's rotation is applied, its position is not.
    expect(SKY_DOME_VERTEX).toContain('.xyww')
    expect(SKY_DOME_VERTEX).toContain('mat3(viewMatrix)')
    expect(SKY_DOME_FRAGMENT).toContain('textureCube(uSky')
    expect(SKY_DOME_FRAGMENT).toContain('dither(')
    expect(SKY_DOME_FRAGMENT).toContain('#include <colorspace_fragment>')
  })
})
