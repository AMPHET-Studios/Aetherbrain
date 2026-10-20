import { describe, expect, it } from 'vitest'
import { REVEAL_SECONDS, applyReveal, easeReveal, revealTargets, ringReps, ringReveal, stepReveal, type RevealInput } from '../src/scene/reveal'

/**
 * Suns open into planets, then moons: which bodies are shown for each level of each sun, and how they come out of it. A small
 * system, by node index:
 *
 *   0 galaxy (always shown)            1 star A (a folder under the galaxy: always shown)
 *   2 planet of A (tier 1)             3 moon of A (tier 2)            4 sub-star B of A (tier 1)
 *   5 planet of B (tier 1)             6 moon of B (tier 2)
 */
const TIER = Uint8Array.from([0, 0, 1, 2, 1, 1, 2])
const OWNER = Int32Array.from([-1, 0, 1, 1, 1, 4, 4])
const ORDER = Int32Array.from([0, 1, 2, 3, 4, 5, 6])
const COUNT = 7

function input(level: number[], over: Partial<RevealInput> = {}): RevealInput {
  return {
    count: COUNT,
    tier: TIER,
    owner: OWNER,
    order: ORDER,
    level: Uint8Array.from(level),
    card: new Uint8Array(COUNT),
    selected: -1,
    lit: null,
    all: false,
    ...over,
  }
}

function targets(level: number[], over: Partial<RevealInput> = {}): number[] {
  const out = new Uint8Array(COUNT)
  revealTargets(input(level, over), out)
  return [...out]
}

describe('which bodies a sun shows', () => {
  it('shows only the galaxy and the folders under it while every sun is closed', () => {
    expect(targets([0, 0, 0, 0, 0, 0, 0])).toEqual([1, 1, 0, 0, 0, 0, 0])
  })

  it('level 1 brings out a sun’s planets and the suns of its sub-folders, not its moons, and not what orbits those suns', () => {
    // A is at planets: its planet (2) and its sub-star (4) come out; its moon (3) does not; B is closed, so B's planet and moon stay in.
    expect(targets([0, 1, 0, 0, 0, 0, 0])).toEqual([1, 1, 1, 0, 1, 0, 0])
  })

  it('level 2 adds the moons', () => {
    expect(targets([0, 2, 0, 0, 0, 0, 0])).toEqual([1, 1, 1, 1, 1, 0, 0])
  })

  it('each sun is its own: opening B opens B’s planets and moons by B’s level', () => {
    expect(targets([0, 1, 0, 0, 1, 0, 0])).toEqual([1, 1, 1, 0, 1, 1, 0])
    expect(targets([0, 2, 0, 0, 2, 0, 0])).toEqual([1, 1, 1, 1, 1, 1, 1])
  })

  it('a body cannot float around a sun that is itself folded away: B open under a closed A shows nothing of B', () => {
    expect(targets([0, 0, 0, 0, 2, 0, 0])).toEqual([1, 1, 0, 0, 0, 0, 0])
  })

  it('the selected body is shown wherever it is, even inside a folded sun', () => {
    // Body 6 (a moon of B, inside the closed A) is selected: it is shown, B around it is not.
    const t = targets([0, 0, 0, 0, 0, 0, 0], { selected: 6 })
    expect(t[6]).toBe(1)
    expect(t[4]).toBe(0)
  })

  it('a star gallery card is shown whatever the level, as long as its own sun is', () => {
    const card = new Uint8Array(COUNT)
    card[3] = 1
    expect(targets([0, 0, 0, 0, 0, 0, 0], { card })[3]).toBe(1)
    // Its sun folded away: the card goes with it.
    card[6] = 1
    expect(targets([0, 0, 0, 0, 0, 0, 0], { card })[6]).toBe(0)
  })

  it('what a search lit up is shown while its sun is', () => {
    const t = targets([0, 0, 0, 0, 0, 0, 0], { lit: (i) => i === 3 || i === 6 })
    // The moon of A is lit and A is shown: out. The moon of B is lit but B is not shown: stays in.
    expect(t[3]).toBe(1)
    expect(t[6]).toBe(0)
  })

  it('shows everything when the levels are off (or the layout is not the system layout)', () => {
    expect(targets([0, 0, 0, 0, 0, 0, 0], { all: true })).toEqual([1, 1, 1, 1, 1, 1, 1])
  })

  it('shows a body that has no sun to open (a graph built without folders), whatever its tier', () => {
    const out = new Uint8Array(3)
    revealTargets(
      { count: 3, tier: Uint8Array.from([2, 1, 2]), owner: Int32Array.from([-1, -1, -1]), order: Int32Array.from([0, 1, 2]), level: new Uint8Array(3), card: new Uint8Array(3), selected: -1, lit: null, all: false },
      out,
    )
    expect([...out]).toEqual([1, 1, 1])
  })

  it('settles in one pass, whatever order the owners come in the node list, when `order` has each sun first', () => {
    // The same system with the bodies listed backwards: only `order` puts the suns first.
    const tier = Uint8Array.from([...TIER].reverse())
    const owner = Int32Array.from([...OWNER].map((o) => (o < 0 ? -1 : COUNT - 1 - o)).reverse())
    const order = Int32Array.from([6, 5, 4, 3, 2, 1, 0])
    // A, which is node 1 in the system above, is node 5 here.
    const level = Uint8Array.from([0, 0, 0, 0, 0, 1, 0])
    const out = new Uint8Array(COUNT)
    revealTargets({ count: COUNT, tier, owner, order, level, card: new Uint8Array(COUNT), selected: -1, lit: null, all: false }, out)
    expect([...out].reverse()).toEqual([1, 1, 1, 0, 1, 0, 0])
  })
})

describe('the way out of the sun', () => {
  it('eases: slow out of the sun, slow into the orbit, clamped to 0..1', () => {
    expect(easeReveal(0)).toBe(0)
    expect(easeReveal(1)).toBe(1)
    expect(easeReveal(0.5)).toBe(0.5)
    expect(easeReveal(-3)).toBe(0)
    expect(easeReveal(7)).toBe(1)
    expect(easeReveal(0.1)).toBeLessThan(0.1)
    expect(easeReveal(0.9)).toBeGreaterThan(0.9)
    let last = -1
    for (let r = 0; r <= 1.0001; r += 0.05) {
      const e = easeReveal(r)
      expect(e).toBeGreaterThanOrEqual(last)
      last = e
    }
  })

  it('moves toward the target by dt over REVEAL_SECONDS and stops there, never overshooting', () => {
    const reveal = new Float32Array([0, 1, 0.5])
    const target = Uint8Array.from([1, 0, 1])
    expect(stepReveal(reveal, target, 3, REVEAL_SECONDS / 2, false)).toBe(true)
    expect([...reveal]).toEqual([0.5, 0.5, 1])
    expect(stepReveal(reveal, target, 3, REVEAL_SECONDS * 10, false)).toBe(true)
    expect([...reveal]).toEqual([1, 0, 1])
    // Settled: nothing moves, and it says so.
    expect(stepReveal(reveal, target, 3, 1, false)).toBe(false)
  })

  it('jumps when asked to (a fresh scene starts with every body where it belongs) and ignores a negative step', () => {
    const reveal = new Float32Array([0, 1])
    stepReveal(reveal, Uint8Array.from([1, 0]), 2, 0, true)
    expect([...reveal]).toEqual([1, 0])
    const still = new Float32Array([0.25])
    expect(stepReveal(still, Uint8Array.from([1]), 1, -5, false)).toBe(false)
    expect(still[0]).toBe(0.25)
  })

  it('draws a shown body where the layout puts it and a hidden one inside its sun, halfway when halfway', () => {
    // Body 0 is the sun at (10, 0, 0); body 1 orbits it at (14, 0, 0); body 2 has no sun.
    const pos = Float32Array.from([10, 0, 0, 14, 0, 0, 3, 3, 3])
    const owner = Int32Array.from([-1, 0, -1])
    const out = new Float32Array(9)
    applyReveal(pos, out, owner, Float32Array.from([1, 1, 0]), 3)
    expect([...out]).toEqual([10, 0, 0, 14, 0, 0, 3, 3, 3])
    applyReveal(pos, out, owner, Float32Array.from([1, 0, 1]), 3)
    expect([...out.slice(3, 6)]).toEqual([10, 0, 0])
    applyReveal(pos, out, owner, Float32Array.from([1, 0.5, 1]), 3)
    expect(out[3]).toBeCloseTo(12, 5)
    // A body with no sun is never pulled anywhere, however little of it is revealed.
    applyReveal(pos, out, owner, Float32Array.from([1, 1, 0]), 3)
    expect([...out.slice(6, 9)]).toEqual([3, 3, 3])
  })
})

describe('the orbit rings follow their body', () => {
  // A sun at the origin with two bodies, 10 and 20 away, and three rings: the two orbits and one nothing sits on.
  const childStart = Int32Array.from([0, 2, 2, 2])
  const childList = Int32Array.from([1, 2])
  const pos = Float32Array.from([0, 0, 0, 10.1, 0, 0, 0, 20, 0])

  it('finds the body each ring carries, by its distance from the ring’s sun, within a hair', () => {
    const rep = new Int32Array(3)
    const missing = ringReps(Int32Array.from([0, 0, 0]), Float32Array.from([10, 20, 30]), 3, childStart, childList, pos, rep)
    expect([...rep]).toEqual([1, 2, -1])
    // It says how many rings found nobody, so the scene asks again once the layout has placed the bodies.
    expect(missing).toBe(1)
  })

  it('finds every ring when the bodies are where the rings say, and none when the layout has not placed anyone yet', () => {
    const rep = new Int32Array(2)
    expect(ringReps(Int32Array.from([0, 0]), Float32Array.from([10, 20]), 2, childStart, childList, pos, rep)).toBe(0)
    const unplaced = new Float32Array(9)
    expect(ringReps(Int32Array.from([0, 0]), Float32Array.from([10, 20]), 2, childStart, childList, unplaced, rep)).toBe(2)
    expect([...rep]).toEqual([-1, -1])
  })

  it('a ring has the reveal of its body, and a ring with no body found is always drawn', () => {
    const out = new Float32Array(3)
    ringReveal(Int32Array.from([1, 2, -1]), Float32Array.from([1, 0.5, 0]), 3, out)
    expect(out[0]).toBe(easeReveal(0.5))
    expect(out[1]).toBe(0)
    expect(out[2]).toBe(1)
  })
})
