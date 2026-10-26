import { describe, expect, it } from 'vitest'
import { AdditiveBlending, InstancedBufferGeometry, Mesh } from 'three'
import {
  FLARE_CHOOSE_EVERY,
  FLARE_CME_URGENCY,
  FLARE_MAX_ACTIVE,
  FLARE_MAX_STARS,
  FLARE_MIN_URGENCY,
  FLARE_PARTICLES,
  FlareField,
  createFlareMaterial,
  ejectionChance,
  flareInterval,
  hash01,
  planFlare,
  type FlareInput,
} from '../src/scene/flares'

/**
 * Corona ejections (docs/COSMOLOGY.md, "A star that needs you erupts"): the scheduling is plain numbers, so it is tested as numbers:
 * who flares, how often, how big, never more than a bound, the same every time, frozen with the clock.
 */

describe('the numbers', () => {
  it('make the same number for the same two integers, spread across 0 to 1', () => {
    expect(hash01(3, 9)).toBe(hash01(3, 9))
    expect(hash01(3, 9)).not.toBe(hash01(9, 3))
    let lo = 1
    let hi = 0
    let sum = 0
    for (let i = 0; i < 4000; i++) {
      const h = hash01(i, 11)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(1)
      lo = Math.min(lo, h)
      hi = Math.max(hi, h)
      sum += h
    }
    expect(lo).toBeLessThan(0.01)
    expect(hi).toBeGreaterThan(0.99)
    expect(sum / 4000).toBeGreaterThan(0.45)
    expect(sum / 4000).toBeLessThan(0.55)
  })

  it('never flare a quiet star, and flare an urgent one more often the more urgent it is', () => {
    for (const u of [0, 0.1, FLARE_MIN_URGENCY - 0.001, Number.NaN, -1]) expect(flareInterval(u), String(u)).toBe(Infinity)
    expect(flareInterval(FLARE_MIN_URGENCY)).toBeCloseTo(16, 6)
    expect(flareInterval(1)).toBeCloseTo(3, 6)
    expect(flareInterval(5)).toBeCloseTo(3, 6)
    let last = Infinity
    for (let u = FLARE_MIN_URGENCY; u <= 1.0001; u += 0.05) {
      const i = flareInterval(u)
      expect(i).toBeLessThanOrEqual(last)
      last = i
    }
  })

  it('make a huge ejection only from an urgent star, rarely at first and often when overdue, and never in calm mode', () => {
    expect(ejectionChance(FLARE_CME_URGENCY - 0.01, false)).toBe(0)
    expect(ejectionChance(FLARE_CME_URGENCY, false)).toBeCloseTo(0.2, 6)
    expect(ejectionChance(1, false)).toBeCloseTo(0.7, 6)
    expect(ejectionChance(1, true)).toBe(0)
    expect(ejectionChance(Number.NaN, false)).toBe(0)
  })

  it('plan a loop of plasma or a huge ejection, bigger and brighter the more urgent the star', () => {
    const loop = planFlare(0.5, 0.99, false)
    expect(loop.kind).toBe(0)
    const big = planFlare(1, 0.05, false)
    expect(big.kind).toBe(1)
    // An ejection reaches many radii out and lives longer than a loop; the more urgent, the further.
    expect(big.reach).toBeGreaterThan(loop.reach * 3)
    expect(big.life).toBeGreaterThan(loop.life)
    expect(planFlare(1, 0.05, false).reach).toBeGreaterThan(planFlare(FLARE_CME_URGENCY, 0.05, false).reach)
    expect(planFlare(1, 0.5, false).power).toBe(1)
    // The same roll in calm mode is a loop.
    expect(planFlare(1, 0.05, true).kind).toBe(0)
    // Bad numbers are still a flare of some size.
    const odd = planFlare(Number.NaN, 0.5, false)
    expect(Number.isFinite(odd.life) && Number.isFinite(odd.reach) && Number.isFinite(odd.power)).toBe(true)
  })

  it('are drawn as one instanced mesh that adds light, sprites in front of the stars behind them', () => {
    const f = new FlareField(10)
    expect(f.mesh).toBeInstanceOf(Mesh)
    expect(f.geometry).toBeInstanceOf(InstancedBufferGeometry)
    const m = createFlareMaterial()
    expect(m.blending).toBe(AdditiveBlending)
    expect(m.depthWrite).toBe(false)
    expect(m.depthTest).toBe(true)
    // A flare is a short stream of sprites: 4 corners each, 6 indices each.
    expect(f.geometry.index!.count).toBe(FLARE_PARTICLES * 6)
    expect(f.geometry.getAttribute('aCorner').count).toBe(FLARE_PARTICLES * 4)
    f.dispose()
  })
})

/** A sky of `n` stars at known places, all shown, with the given urgencies. */
function sky(urgencies: number[], extra: Partial<FlareInput> = {}): FlareInput {
  const n = urgencies.length
  const pos = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) pos.set([i * 50, (i % 3) * 10, 0], i * 3)
  return {
    clock: 0,
    enabled: true,
    calm: false,
    candidates: Int32Array.from({ length: n }, (_, i) => i),
    urgency: Float32Array.from(urgencies),
    reveal: new Float32Array(n).fill(1),
    radius: new Float32Array(n).fill(6),
    pos,
    cam: { x: 0, y: 0, z: 300 },
    ...extra,
  }
}
/** Run the field for `seconds` of flare clock in steps of `dt`, and report every flare that was ever alive (slot by start). */
function run(field: FlareField, inp: FlareInput, seconds: number, dt = 0.1) {
  const started: { star: number; at: number; kind: number; life: number }[] = []
  const seen = new Set<string>()
  for (let t = 0; t <= seconds + 1e-9; t += dt) {
    field.step({ ...inp, clock: inp.clock + t })
    const params = (field.geometry.getAttribute('iParams') as { array: Float32Array }).array
    for (let s = 0; s < FLARE_MAX_ACTIVE; s++) {
      const star = field.star[s]!
      if (star < 0) continue
      const key = `${s}:${params[s * 4]}:${star}`
      if (seen.has(key)) continue
      seen.add(key)
      started.push({ star, at: inp.clock + t, kind: params[s * 4 + 2]!, life: params[s * 4 + 1]! })
    }
  }
  return started
}

describe('which stars flare', () => {
  it('only the ones that need attention, and only while they are shown', () => {
    const f = new FlareField(5)
    const flares = run(f, sky([0, 0.2, 0.9, 1, 0.8], { reveal: Float32Array.from([1, 1, 1, 1, 0.5]) }), 60)
    const stars = new Set(flares.map((x) => x.star))
    expect(stars.has(0)).toBe(false)
    expect(stars.has(1)).toBe(false)
    // Star 4 is urgent but folded away inside a closed sun.
    expect(stars.has(4)).toBe(false)
    expect(stars.has(2)).toBe(true)
    expect(stars.has(3)).toBe(true)
  })

  it('throw more, and bigger, the more urgent the star is', () => {
    const f = new FlareField(3)
    const flares = run(f, sky([0.4, 0.7, 1]), 240, 0.25)
    const count = (i: number) => flares.filter((x) => x.star === i).length
    expect(count(0)).toBeGreaterThan(0)
    expect(count(2)).toBeGreaterThan(count(1))
    expect(count(1)).toBeGreaterThan(count(0))
    // Only the stars from 0.7 up throw huge ejections.
    expect(flares.filter((x) => x.star === 0 && x.kind === 1)).toHaveLength(0)
    expect(flares.filter((x) => x.star === 2 && x.kind === 1).length).toBeGreaterThan(0)
  })

  it('do not all start at the same moment: each star has its own first time', () => {
    const f = new FlareField(20)
    const flares = run(f, sky(Array.from({ length: 20 }, () => 1)), 3, 0.05)
    // The first flare of each star: spread over the first seconds, not all at one moment.
    const first = new Map<number, number>()
    for (const x of flares) if (!first.has(x.star)) first.set(x.star, x.at)
    expect(first.size).toBe(20)
    expect(new Set([...first.values()].map((a) => Math.round(a * 10))).size).toBeGreaterThan(8)
    expect(Math.min(...first.values())).toBeLessThan(1.5)
    expect(Math.max(...first.values())).toBeGreaterThan(1.5)
  })

  it('are the same every time for the same sky', () => {
    const a = run(new FlareField(6), sky([0.5, 0.6, 0.7, 0.8, 0.9, 1]), 60)
    const b = run(new FlareField(6), sky([0.5, 0.6, 0.7, 0.8, 0.9, 1]), 60)
    expect(b).toEqual(a)
  })
})

describe('how many at once', () => {
  it('never more than the bound of stars, the most urgent first, however many need attention', () => {
    const n = 500
    const urg = Array.from({ length: n }, (_, i) => 0.4 + 0.6 * (i / n))
    const f = new FlareField(n)
    // All about as near the camera as each other (a few units apart), so how urgent they are decides.
    const close = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) close.set([i * 0.01, 0, 0], i * 3)
    f.step(sky(urg, { cam: { x: 0, y: 0, z: 0 }, pos: close }))
    expect(f.nLive).toBe(FLARE_MAX_STARS)
    const chosen = [...f.live].slice(0, f.nLive)
    const least = Math.min(...chosen.map((i) => urg[i]!))
    const unchosen = Array.from({ length: n }, (_, i) => i).filter((i) => !chosen.includes(i))
    expect(unchosen.filter((i) => urg[i]! > least + 0.3)).toHaveLength(0)
  })

  it('chooses the nearer star when two are as urgent', () => {
    const f = new FlareField(FLARE_MAX_STARS + 2)
    const n = FLARE_MAX_STARS + 2
    const inp = sky(new Array(n).fill(0.9), { cam: { x: 0, y: 0, z: 0 } })
    f.step(inp)
    // Stars sit at x = 50 i: the first ones are the nearest, the last two the farthest.
    const chosen = new Set([...f.live].slice(0, f.nLive))
    expect(chosen.has(0)).toBe(true)
    expect(chosen.has(n - 1)).toBe(false)
  })

  it('never more flares alive than the bound, however long it runs', () => {
    const n = 200
    const f = new FlareField(n)
    const inp = sky(new Array(n).fill(1))
    let most = 0
    for (let t = 0; t < 120; t += 0.1) {
      f.step({ ...inp, clock: t })
      most = Math.max(most, f.active)
    }
    expect(most).toBeLessThanOrEqual(FLARE_MAX_ACTIVE)
    expect(most).toBeGreaterThan(10)
    expect(f.geometry.instanceCount).toBeLessThanOrEqual(FLARE_MAX_ACTIVE)
  })

  it('are over when their time is: a flare ends, its slot is free again (a star at 0.4 throws one every ~15 s and each lasts ~4)', () => {
    const f = new FlareField(1)
    const inp = sky([0.4])
    let sawOne = false
    let ended = false
    let slot = -1
    for (let t = 0; t < 90; t += 0.1) {
      f.step({ ...inp, clock: t })
      if (!sawOne && f.active > 0) {
        sawOne = true
        slot = [...f.star].findIndex((s) => s === 0)
      }
      if (sawOne && f.active === 0) ended = true
    }
    expect(sawOne).toBe(true)
    expect(ended).toBe(true)
    // The slot it had is free, and no longer asks to be drawn (its life is 0).
    expect(slot).toBeGreaterThanOrEqual(0)
    const life = (f.geometry.getAttribute('iParams') as { array: Float32Array }).array[slot * 4 + 1]!
    expect(f.star[slot] === -1 ? life : 1).toBe(0)
  })

  it('overlap when a star is very urgent: its flares come every ~3 s and last 4 to 10, so there is nearly always one alive', () => {
    const f = new FlareField(1)
    const inp = sky([1])
    let alive = 0
    let frames = 0
    for (let t = 20; t < 120; t += 0.1) {
      f.step({ ...inp, clock: t })
      frames++
      if (f.active > 0) alive++
    }
    expect(alive / frames).toBeGreaterThan(0.9)
  })
})

describe('what the field does with time and settings', () => {
  it('freezes with the clock: no flare starts or ends while the clock stands still (orbits paused)', () => {
    const f = new FlareField(4)
    const inp = sky([1, 1, 1, 1])
    for (let t = 0; t < 20; t += 0.1) f.step({ ...inp, clock: t })
    const before = [...f.star]
    const params = Array.from((f.geometry.getAttribute('iParams') as { array: Float32Array }).array)
    for (let k = 0; k < 400; k++) f.step({ ...inp, clock: 20 })
    expect([...f.star]).toEqual(before)
    expect(Array.from((f.geometry.getAttribute('iParams') as { array: Float32Array }).array)).toEqual(params)
  })

  it('clears everything when it is switched off, and starts again when it is switched on', () => {
    const f = new FlareField(3)
    const inp = sky([1, 1, 1])
    for (let t = 0; t < 30; t += 0.1) f.step({ ...inp, clock: t })
    expect(f.active).toBeGreaterThan(0)
    f.step({ ...inp, clock: 31, enabled: false })
    expect(f.active).toBe(0)
    expect(f.mesh.visible).toBe(false)
    expect(f.geometry.instanceCount).toBe(0)
    let again = 0
    for (let t = 32; t < 80; t += 0.1) {
      f.step({ ...inp, clock: t })
      again = Math.max(again, f.active)
    }
    expect(again).toBeGreaterThan(0)
  })

  it('throws no huge ejection in calm mode, and fewer loops', () => {
    const loud = run(new FlareField(1), sky([1]), 300, 0.25)
    const calm = run(new FlareField(1), sky([1], { calm: true }), 300, 0.25)
    expect(loud.some((x) => x.kind === 1)).toBe(true)
    expect(calm.some((x) => x.kind === 1)).toBe(false)
    expect(calm.length).toBeLessThan(loud.length)
  })

  it('follows its star as it orbits, and keeps the numbers the shader reads finite', () => {
    const f = new FlareField(2)
    const inp = sky([1, 1])
    for (let t = 0; t < 10; t += 0.1) f.step({ ...inp, clock: t })
    const slot = [...f.star].findIndex((s) => s === 1)
    expect(slot).toBeGreaterThanOrEqual(0)
    inp.pos.set([777, -5, 42], 3)
    f.step({ ...inp, clock: 10.1 })
    const c = (f.geometry.getAttribute('iCenter') as { array: Float32Array }).array
    expect([c[slot * 3], c[slot * 3 + 1], c[slot * 3 + 2]]).toEqual([777, -5, 42])
    for (const name of ['iCenter', 'iDir', 'iUp', 'iParams', 'iShape']) for (const v of (f.geometry.getAttribute(name) as { array: Float32Array }).array) expect(Number.isFinite(v), name).toBe(true)
    // Directions are unit vectors and the cross direction is across them.
    const d = (f.geometry.getAttribute('iDir') as { array: Float32Array }).array
    const u = (f.geometry.getAttribute('iUp') as { array: Float32Array }).array
    expect(Math.hypot(d[slot * 3]!, d[slot * 3 + 1]!, d[slot * 3 + 2]!)).toBeCloseTo(1, 4)
    expect(Math.hypot(u[slot * 3]!, u[slot * 3 + 1]!, u[slot * 3 + 2]!)).toBeCloseTo(1, 4)
    expect(Math.abs(d[slot * 3]! * u[slot * 3]! + d[slot * 3 + 1]! * u[slot * 3 + 1]! + d[slot * 3 + 2]! * u[slot * 3 + 2]!)).toBeLessThan(1e-4)
  })

  it('survives bad numbers: no radius, no position, no urgency', () => {
    const f = new FlareField(3)
    const inp = sky([1, Number.NaN, 1], { radius: Float32Array.from([0, Number.NaN, 6]), pos: new Float32Array(0) })
    expect(() => {
      for (let t = 0; t < 30; t += 0.1) f.step({ ...inp, clock: t })
    }).not.toThrow()
    for (const v of (f.geometry.getAttribute('iShape') as { array: Float32Array }).array) expect(Number.isFinite(v)).toBe(true)
  })

  it('keeps its plumes when the graph is rebuilt: the new field takes over what is in the air, by node id, wherever the nodes moved to', () => {
    const idsA = ['a', 'b', 'c']
    const a = new FlareField(3)
    const inp = sky([1, 1, 1])
    for (let t = 0; t < 12; t += 0.1) a.step({ ...inp, clock: t })
    expect(a.active).toBeGreaterThan(0)
    // The graph is rebuilt with a node in front and the others shifted: a, b, c are now 2, 3, 1.
    const idsB = ['x', 'c', 'a', 'b']
    const newIndex = (id: string): number | undefined => {
      const i = idsB.indexOf(id)
      return i < 0 ? undefined : i
    }
    const b = new FlareField(4)
    b.adoptFrom(a, (i) => idsA[i], newIndex)
    expect(b.active).toBe(a.active)
    const pa = (a.geometry.getAttribute('iParams') as { array: Float32Array }).array
    const pb = (b.geometry.getAttribute('iParams') as { array: Float32Array }).array
    for (let s = 0; s < FLARE_MAX_ACTIVE; s++) {
      const was = a.star[s]!
      if (was < 0) {
        expect(b.star[s]).toBe(-1)
        continue
      }
      // The same flare, in the same slot, on the same star under its new index.
      expect(b.star[s]).toBe(newIndex(idsA[was]!))
      expect([pb[s * 4], pb[s * 4 + 1], pb[s * 4 + 2], pb[s * 4 + 3]]).toEqual([pa[s * 4], pa[s * 4 + 1], pa[s * 4 + 2], pa[s * 4 + 3]])
    }
    // It goes on from there: the plumes are still in the air a moment later, and they follow their stars to the new places.
    const pos = new Float32Array(12)
    pos.set([500, 0, 0], 2 * 3) // 'a' now sits at index 2
    b.step({ ...sky([0, 1, 1, 1]), clock: 12.1, pos })
    const slot = [...b.star].findIndex((s) => s === 2)
    if (slot >= 0) expect((b.geometry.getAttribute('iCenter') as { array: Float32Array }).array[slot * 3]).toBe(500)
    expect(b.active).toBeGreaterThan(0)
  })

  it('lets go of the plumes of a star that is gone, and does not throw if the old field is empty or the same', () => {
    const a = new FlareField(2)
    const inp = sky([1, 1])
    for (let t = 0; t < 10; t += 0.1) a.step({ ...inp, clock: t })
    const b = new FlareField(1)
    b.adoptFrom(a, (i) => ['keep', 'gone'][i], (id) => (id === 'keep' ? 0 : undefined))
    for (const s of b.star) expect(s === -1 || s === 0).toBe(true)
    const c = new FlareField(2)
    expect(() => c.adoptFrom(new FlareField(2), () => undefined, () => undefined)).not.toThrow()
    expect(() => c.adoptFrom(c, () => undefined, () => undefined)).not.toThrow()
    expect(c.active).toBe(0)
  })

  it('costs nothing while it is switched off: nothing is cleared again and again', () => {
    const f = new FlareField(4)
    const inp = sky([1, 1, 1, 1])
    for (let t = 0; t < 10; t += 0.1) f.step({ ...inp, clock: t })
    f.step({ ...inp, clock: 10.1, enabled: false })
    expect(f.active).toBe(0)
    // A mark left in the schedule is still there after more frames with flares off: they did not clear it again.
    const nextAt = (f as unknown as { nextAt: Float64Array }).nextAt
    nextAt[0] = 123
    for (let k = 0; k < 50; k++) f.step({ ...inp, clock: 10.2 + k * 0.1, enabled: false })
    expect(nextAt[0]).toBe(123)
    // And switched on again, it works.
    let again = 0
    for (let t = 20; t < 60; t += 0.1) {
      f.step({ ...inp, clock: t })
      again = Math.max(again, f.active)
    }
    expect(again).toBeGreaterThan(0)
  })

  it('is drawn by the scene as one mesh, on a clock that stops with the orbits, off in other layouts, tamed by calm mode, freed with the buffers', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const scene = readFileSync(fileURLToPath(new URL('../src/scene/BrainScene.tsx', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
    expect(scene).toContain('<primitive object={buffers.flares.mesh} />')
    expect(scene).toContain('if (controller.motion) st.flareClock += dt')
    expect(scene).toContain("fi.enabled = controller.flares && controller.layoutMode === 'system'")
    expect(scene).toContain('fi.calm = controller.calm')
    expect(scene).toContain('buffers.flares.step(fi)')
    expect(scene).toContain('buffers.flares.adoptFrom(before.flares,')
    expect(scene).toContain('flares.dispose()')
    // Only folder stars can erupt: not the vault, a drive or the Bio star.
    expect(scene).toContain("f.role !== 'root' && f.role !== 'mount' && urgency[i]! >= FLARE_MIN_URGENCY")
  })

  it('chooses again every half second, not every frame', () => {
    expect(FLARE_CHOOSE_EVERY).toBe(0.5)
    const f = new FlareField(2)
    const inp = sky([1, 0.1])
    f.step({ ...inp, clock: 0 })
    expect(f.nLive).toBe(1)
    // The second star becomes urgent: it is picked up at the next choosing, not within a frame.
    inp.urgency[1] = 1
    f.step({ ...inp, clock: 0.1 })
    expect(f.nLive).toBe(1)
    f.step({ ...inp, clock: 0.6 })
    expect(f.nLive).toBe(2)
  })
})
