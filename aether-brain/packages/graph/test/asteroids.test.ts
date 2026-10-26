import { describe, expect, it } from 'vitest'
import { PerspectiveCamera } from 'three'
import type { Reminder } from '@aether/core'
import { ASTEROID_BOX_MAX, ASTEROID_BOX_MIN, ASTEROID_MAX, AsteroidField, asteroidBox, asteroidColor, asteroidPlace, hash01, planAsteroid } from '../src/scene/asteroids'

/** Asteroids (docs/COSMOLOGY.md, "Asteroids are reminders"): where each one is, how it looks, and that it can be hovered. */

type Plan = ReturnType<typeof planAsteroid>
const speedOf = (p: Plan) => Math.hypot(...p.v)
const reminder = (key: string, urgency: number): Reminder => ({ key, note: key, text: key, urgency, due: null, source: 'tag' })
const still = (): Plan => ({ o: [0, 0, 0], v: [0, 0, 0], spin: [0, 0, 0], squash: [1, 1, 1], jitter: 0 })

describe('the path of an asteroid', () => {
  it('is the same for the same reminder, and different for another', () => {
    expect(planAsteroid('a#1', 0.5)).toEqual(planAsteroid('a#1', 0.5))
    expect(planAsteroid('a#1', 0.5).o).not.toEqual(planAsteroid('b#1', 0.5).o)
    expect(hash01('x', 1)).toBeGreaterThanOrEqual(0)
    expect(hash01('x', 1)).toBeLessThan(1)
  })

  it('is faster and nearer the middle when it is more urgent', () => {
    let calm = 0
    let hot = 0
    let calmFar = 0
    let hotFar = 0
    for (let i = 0; i < 40; i++) {
      const c = planAsteroid(`k${i}`, 0.1)
      const h = planAsteroid(`k${i}`, 1)
      calm += speedOf(c)
      hot += speedOf(h)
      calmFar += Math.hypot(...c.o)
      hotFar += Math.hypot(...h.o)
    }
    expect(hot).toBeGreaterThan(calm * 1.8)
    expect(hotFar).toBeLessThan(calmFar)
  })

  it('stays inside the box at any time, fades to nothing at its edge and shows in the middle', () => {
    const out = [0, 0, 0]
    for (let i = 0; i < 20; i++) {
      const p = planAsteroid(`k${i}`, 0.7)
      for (const t of [0, 1, 37.5, 1e5]) {
        const f = asteroidPlace(p, t, out)
        for (const c of out) {
          expect(c).toBeGreaterThanOrEqual(-1)
          expect(c).toBeLessThan(1)
        }
        expect(f).toBeGreaterThanOrEqual(0)
        expect(f).toBeLessThanOrEqual(1)
      }
    }
    expect(asteroidPlace(still(), 0, out)).toBe(1)
    expect(asteroidPlace({ ...still(), o: [0.999, 0, 0] }, 0, out)).toBeLessThan(0.05)
  })

  it('is gone (faded) before it comes back on the other side of the box', () => {
    const p: Plan = { ...still(), o: [0.9, 0, 0], v: [0.1, 0, 0] }
    const out = [0, 0, 0]
    for (let t = 0; t < 40; t += 0.05) {
      const f = asteroidPlace(p, t, out)
      if (Math.abs(out[0]!) > 0.97) expect(f).toBeLessThan(0.1)
    }
  })

  it('does not break for a clock that is not a number', () => {
    expect(Number.isFinite(asteroidPlace(planAsteroid('z', 0.3), Number.NaN, [0, 0, 0]))).toBe(true)
  })
})

describe('the box that follows the camera', () => {
  it('is centred half way to what is looked at, and as wide as the distance, within limits', () => {
    const out = { cx: 0, cy: 0, cz: 0, half: 0 }
    asteroidBox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -400 }, out)
    expect(out.cz).toBe(-200)
    expect(out.half).toBeCloseTo(360, 6)
    asteroidBox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, out)
    expect(out.half).toBe(ASTEROID_BOX_MIN)
    asteroidBox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1e6 }, out)
    expect(out.half).toBe(ASTEROID_BOX_MAX)
    asteroidBox({ x: Number.NaN, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, out)
    expect(out.half).toBe(ASTEROID_BOX_MIN)
  })
})

describe('the colour', () => {
  it('is amber when calm and red when overdue', () => {
    const calm = [0, 0, 0]
    const hot = [0, 0, 0]
    asteroidColor(0, calm)
    asteroidColor(1, hot)
    expect(calm[1]!).toBeGreaterThan(hot[1]!)
    expect(hot[0]).toBeGreaterThan(0.9)
    expect(hot[1]!).toBeLessThan(0.15)
  })
})

describe('the field of asteroids', () => {
  const camera = new PerspectiveCamera(55, 1.6, 1, 5000)
  camera.position.set(0, 100, 400)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  const input = (reminders: readonly Reminder[], enabled = true) => ({ clock: 5, enabled, reminders, camera, target: { x: 0, y: 0, z: 0 }, width: 1600, height: 1000 })

  it('shows one rock per reminder, at most the cap, and nothing when there are none or it is off', () => {
    const f = new AsteroidField()
    expect(f.mesh.visible).toBe(false)
    f.step(input(Array.from({ length: 40 }, (_, i) => reminder(`r${i}`, 0.5))))
    expect(f.count).toBe(ASTEROID_MAX)
    expect(f.mesh.count).toBe(ASTEROID_MAX)
    expect(f.mesh.visible).toBe(true)
    f.step(input([]))
    expect(f.mesh.visible).toBe(false)
    f.step(input([reminder('a', 1)], false))
    expect(f.mesh.visible).toBe(false)
    f.dispose()
  })

  it('can be found under the pointer, and not where there is none', () => {
    const f = new AsteroidField()
    f.step(input(Array.from({ length: 12 }, (_, i) => reminder(`r${i}`, 0.9))))
    let found = -1
    for (let i = 0; i < f.count; i++) {
      if (f.screen[i * 4 + 2]! > 0) {
        found = i
        expect(f.hit(f.screen[i * 4]!, f.screen[i * 4 + 1]!)).toBeGreaterThanOrEqual(0)
        break
      }
    }
    expect(found).toBeGreaterThanOrEqual(0)
    expect(f.hit(-5000, -5000)).toBe(-1)
    expect(f.reminder(found)?.key).toBe(`r${found}`)
    expect(f.reminder(99)).toBeUndefined()
    f.dispose()
  })

  it('moves with the clock, and stands still when the clock does', () => {
    const f = new AsteroidField()
    const list = [reminder('a', 0.9), reminder('b', 0.6)]
    f.step({ ...input(list), clock: 10 })
    const a = Array.from(f.mesh.instanceMatrix.array.slice(0, 32))
    f.step({ ...input(list), clock: 10 })
    expect(Array.from(f.mesh.instanceMatrix.array.slice(0, 32))).toEqual(a)
    f.step({ ...input(list), clock: 25 })
    expect(Array.from(f.mesh.instanceMatrix.array.slice(0, 32))).not.toEqual(a)
    f.dispose()
  })
})
