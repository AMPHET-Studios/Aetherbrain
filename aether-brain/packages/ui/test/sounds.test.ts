import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLANET_MIN_BYTES, PLANET_MIN_WORDS, type GraphNode } from '@aether/core'
import { OCTAVES, PENTATONIC, ROOT_HZ, hash32, noteFor, soundKindOf, soundPlan, sunRun, type SoundKind } from '../src/audio/sounds'

/**
 * The sound of the sky: a click on a star, a planet or a moon plays a note of its own, opening or closing a sun plays a run. The pure
 * part (which note, which instrument) is tested as numbers; the synth is driven by a fake AudioContext that records what is made.
 */

/** A graph node with only what the sound looks at. */
function body(over: Partial<GraphNode> & { id: string }): GraphNode {
  return { title: over.id, area: 'untagged', type: 'note', tags: [], kind: 'note', ghost: false, parent: null, inDegree: 0, outDegree: 0, degree: 0, created: null, updated: null, wordCount: 10, ...over } as GraphNode
}
const folder = (id: string, role: 'root' | 'mount' | 'project' | 'folder', extra: Partial<NonNullable<GraphNode['folder']>> = {}): GraphNode =>
  body({ id, kind: 'folder', folder: { path: id, role, depth: 1, projectId: null, inProject: false, childFolders: 0, hiddenFolders: 0, notes: 0, totalNotes: 0, images: 0, shownImages: 0, ...extra } })
const image = (id: string, size: number | null): GraphNode =>
  body({ id, kind: 'image', image: { path: id, size, mtime: 1, width: 10, height: 10, video: false } as unknown as GraphNode['image'] })

describe('what sound a body makes', () => {
  it('follows the cosmology: a drive is a galaxy, a folder a star, a board a sun, a big file a planet, a small one a moon', () => {
    expect(soundKindOf(folder('folder:', 'root', { galaxy: true }))).toBe('galaxy')
    expect(soundKindOf(folder('folder:D', 'mount'))).toBe('galaxy')
    expect(soundKindOf(folder('folder:Work', 'folder'))).toBe('star')
    expect(soundKindOf(folder('folder:Work/Game', 'project'))).toBe('star')
    expect(soundKindOf(folder('folder:Bio', 'folder', { bio: true }))).toBe('star')
    expect(soundKindOf(body({ id: 'Board', board: { pictures: 3 } }))).toBe('sun')
    expect(soundKindOf(body({ id: 'Long', wordCount: PLANET_MIN_WORDS }))).toBe('planet')
    expect(soundKindOf(body({ id: 'Short', wordCount: PLANET_MIN_WORDS - 1 }))).toBe('moon')
    expect(soundKindOf(body({ id: 'ghost:x', kind: 'ghost', ghost: true }))).toBe('ghost')
    expect(soundKindOf(body({ id: 'today:', kind: 'today' }))).toBe('today')
  })

  it('tells a big picture (a planet) from a small one (a moon), and a picture nobody has sized is a big one', () => {
    expect(soundKindOf(image('image:a.png', PLANET_MIN_BYTES))).toBe('picture')
    expect(soundKindOf(image('image:b.png', PLANET_MIN_BYTES - 1))).toBe('moon')
    expect(soundKindOf(image('image:c.png', null))).toBe('picture')
  })
})

describe('the note of a body', () => {
  it('plays the major pentatonic scale: the root, a second, a third, a fifth and a sixth above middle C', () => {
    expect([...PENTATONIC]).toEqual([0, 2, 4, 7, 9])
    expect(ROOT_HZ).toBeCloseTo(261.6256, 4)
    // No semitone steps and no tritone: nothing in it clashes with anything else.
    for (const a of PENTATONIC) for (const b of PENTATONIC) expect([1, 6, 11]).not.toContain(Math.abs(a - b))
  })

  it('hashes an id the same way every time (FNV-1a, the published test values)', () => {
    expect(hash32('')).toBe(2166136261)
    expect(hash32('a')).toBe(0xe40c292c)
    expect(hash32('foobar')).toBe(0xbf9cf968)
    expect(hash32('Projects/Alpha')).toBe(hash32('Projects/Alpha'))
  })

  it('is always a degree of the pentatonic scale, in the octave of its kind: no wrong notes', () => {
    for (const kind of Object.keys(OCTAVES) as SoundKind[]) {
      for (let i = 0; i < 40; i++) {
        const semitones = 12 * Math.log2(noteFor(kind, `note-${i}`) / ROOT_HZ) - 12 * OCTAVES[kind]
        expect(PENTATONIC.some((p) => Math.abs(p - semitones) < 1e-9), `${kind} ${i}: ${semitones}`).toBe(true)
      }
    }
  })

  it('is the same note for the same body every time, and spreads over all five degrees across many bodies', () => {
    expect(noteFor('moon', 'Home')).toBe(noteFor('moon', 'Home'))
    const degrees = new Set<number>()
    for (let i = 0; i < 200; i++) degrees.add(hash32(`Notes/n${i}`) % PENTATONIC.length)
    expect(degrees.size).toBe(PENTATONIC.length)
    // Not lopsided: each degree gets a fair share of 1,000 bodies.
    const tally = new Array<number>(PENTATONIC.length).fill(0)
    for (let i = 0; i < 1000; i++) tally[hash32(`Notes/n${i}`) % PENTATONIC.length]!++
    for (const n of tally) expect(n).toBeGreaterThan(120)
  })

  it('puts the big bodies low and the small ones high: a star rings below a planet, which is below a moon', () => {
    const id = 'Projects/Same'
    expect(noteFor('star', id)).toBeLessThan(noteFor('planet', id))
    expect(noteFor('planet', id)).toBeLessThan(noteFor('moon', id))
    // Whole octaves apart for the same id: the same degree of the scale.
    expect(noteFor('moon', id) / noteFor('planet', id)).toBeCloseTo(2, 9)
    expect(noteFor('planet', id) / noteFor('star', id)).toBeCloseTo(2, 9)
  })
})

describe('the instrument of each kind', () => {
  const kinds = Object.keys(OCTAVES) as SoundKind[]

  it('is a pure function of the kind and the id', () => {
    for (const kind of kinds) expect(soundPlan(kind, 'x/y')).toEqual(soundPlan(kind, 'x/y'))
  })

  it('has a plan for every kind, quiet enough not to startle: a gain under half, and some reverb', () => {
    for (const kind of kinds) {
      const p = soundPlan(kind, 'x')
      expect(p.gain, kind).toBeGreaterThan(0)
      expect(p.gain, kind).toBeLessThan(0.5)
      expect(p.reverb, kind).toBeGreaterThan(0)
      expect(p.reverb, kind).toBeLessThanOrEqual(1)
      expect(p.partials.length, kind).toBeGreaterThan(0)
      expect(p.freq, kind).toBe(noteFor(kind, 'x'))
      for (const o of p.partials) {
        expect(o.gain).toBeGreaterThan(0)
        expect(o.decay).toBeGreaterThan(0)
      }
    }
  })

  it('makes a moon a short bright tick and a star a long warm bell with a thump under it', () => {
    const moon = soundPlan('moon', 'm')
    const star = soundPlan('star', 's')
    const longest = (p: ReturnType<typeof soundPlan>) => Math.max(...p.partials.map((o) => o.decay))
    expect(longest(moon)).toBeLessThan(0.4)
    expect(longest(star)).toBeGreaterThan(1)
    expect(star.thump).toBe(true)
    expect(moon.thump).toBe(false)
    expect(moon.lowpass).toBeGreaterThan(star.lowpass)
    expect(moon.attack).toBeLessThan(star.attack)
  })

  it('makes a galaxy a chord (a root, a fifth and an octave), and a sun and the Today hub sparkle', () => {
    expect(soundPlan('galaxy', 'g').chord).toEqual([1, 1.5, 2])
    expect(soundPlan('sun', 'b').sparkle).toBeGreaterThan(0)
    expect(soundPlan('today', 't').sparkle).toBeGreaterThan(0)
    for (const kind of ['moon', 'planet', 'star', 'picture', 'ghost'] as const) expect(soundPlan(kind, 'q').sparkle, kind).toBe(0)
  })
})

describe('the run of a sun opening or closing', () => {
  it('rises in three notes when it opens to its planets and in five when the moons come out too', () => {
    const planets = sunRun(1, 0)
    const moons = sunRun(2, 0)
    expect(planets).toHaveLength(3)
    expect(moons).toHaveLength(5)
    for (const run of [planets, moons]) for (let i = 1; i < run.length; i++) expect(run[i]!.freq).toBeGreaterThan(run[i - 1]!.freq)
    // Going from planets to planets and moons is a further opening: the full run.
    expect(sunRun(2, 1)).toEqual(moons)
  })

  it('falls in three notes when it closes', () => {
    for (const [level, previous] of [[0, 1], [0, 2], [1, 2]] as const) {
      const run = sunRun(level, previous)
      expect(run, `${previous} to ${level}`).toHaveLength(3)
      for (let i = 1; i < run.length; i++) expect(run[i]!.freq).toBeLessThan(run[i - 1]!.freq)
    }
  })

  it('plays its notes a hair apart, from the first at once, all in the scale an octave above the root', () => {
    const run = sunRun(2, 0)
    expect(run[0]!.at).toBe(0)
    for (let i = 1; i < run.length; i++) expect(run[i]!.at - run[i - 1]!.at).toBeCloseTo(0.065, 9)
    const first = 12 * Math.log2(run[0]!.freq / ROOT_HZ)
    expect(first).toBeCloseTo(12, 9)
    for (const n of run) {
      const semis = (12 * Math.log2(n.freq / ROOT_HZ)) % 12
      expect(PENTATONIC.some((p) => Math.abs(p - semis) < 1e-9) || Math.abs(semis) < 1e-9).toBe(true)
    }
  })
})

/** A stand-in for the browser's AudioContext that counts what is made, and the nodes it makes do nothing. */
class FakeParam {
  value = 0
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
  exponentialRampToValueAtTime(): void {}
}
class FakeNode {
  connect(): void {}
}
class FakeOsc extends FakeNode {
  type = 'sine'
  frequency = new FakeParam()
  detune = new FakeParam()
  started: number | null = null
  start(t: number): void {
    this.started = t
  }
  stop(): void {}
}
class FakeGain extends FakeNode {
  gain = new FakeParam()
}
class FakeContext {
  static made: FakeContext[] = []
  currentTime = 0
  state: 'running' | 'suspended' = 'running'
  sampleRate = 8000
  destination = new FakeNode()
  oscillators: FakeOsc[] = []
  gains: FakeGain[] = []
  resumed = 0
  constructor() {
    FakeContext.made.push(this)
  }
  createGain(): FakeGain {
    const g = new FakeGain()
    this.gains.push(g)
    return g
  }
  createDynamicsCompressor() {
    return Object.assign(new FakeNode(), { threshold: new FakeParam(), ratio: new FakeParam() })
  }
  createConvolver() {
    return Object.assign(new FakeNode(), { buffer: null as unknown })
  }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) }
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: 'lowpass', frequency: new FakeParam(), Q: new FakeParam() })
  }
  createOscillator(): FakeOsc {
    const o = new FakeOsc()
    this.oscillators.push(o)
    return o
  }
  resume(): Promise<void> {
    this.resumed++
    this.state = 'running'
    return Promise.resolve()
  }
}

async function freshSounds() {
  vi.resetModules()
  FakeContext.made = []
  return import('../src/audio/sounds')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the synth', () => {
  it('is silent where there is no Web Audio, and never throws', async () => {
    const s = await freshSounds()
    expect(s.soundSupported()).toBe(false)
    expect(() => s.playBody(body({ id: 'Home' }))).not.toThrow()
    expect(() => s.playSun(2, 0)).not.toThrow()
    expect(FakeContext.made).toHaveLength(0)
  })

  it('makes no context until the first sound (a browser wants a click first), and one for all of them', async () => {
    vi.stubGlobal('AudioContext', FakeContext)
    const s = await freshSounds()
    expect(s.soundSupported()).toBe(true)
    expect(FakeContext.made).toHaveLength(0)
    s.playBody(body({ id: 'A' }))
    s.playBody(body({ id: 'B' }))
    expect(FakeContext.made).toHaveLength(1)
  })

  it('plays a moon as its partials, each at its own pitch from the body’s note', async () => {
    vi.stubGlobal('AudioContext', FakeContext)
    const s = await freshSounds()
    const n = body({ id: 'Notes/Home' })
    s.playBody(n)
    const ctx = FakeContext.made[0]!
    const plan = s.soundPlan('moon', n.id)
    expect(ctx.oscillators.map((o) => o.frequency.value)).toEqual(plan.partials.map((p) => plan.freq * p.ratio))
    expect(ctx.oscillators.every((o) => o.started !== null)).toBe(true)
  })

  it('plays a star as a bell and a thump (one more oscillator than its partials), and a galaxy as a chord of bells', async () => {
    vi.stubGlobal('AudioContext', FakeContext)
    const s = await freshSounds()
    s.playBody(folder('folder:Work', 'folder'))
    expect(FakeContext.made[0]!.oscillators).toHaveLength(s.soundPlan('star', 'folder:Work').partials.length + 1)
    s.playBody(folder('folder:', 'root', { galaxy: true }))
    const galaxy = s.soundPlan('galaxy', 'folder:')
    expect(FakeContext.made[0]!.oscillators).toHaveLength(s.soundPlan('star', 'folder:Work').partials.length + 1 + galaxy.partials.length * 3 + 1)
  })

  it('wakes a context the browser left suspended', async () => {
    vi.stubGlobal('AudioContext', class extends FakeContext {
      override state: 'running' | 'suspended' = 'suspended'
    })
    const s = await freshSounds()
    s.playBody(body({ id: 'A' }))
    expect(FakeContext.made[0]!.resumed).toBe(1)
  })

  it('never sounds more than 14 notes at once: a hammered key does not become a roar, and room comes back as notes end', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('AudioContext', FakeContext)
    const s = await freshSounds()
    const perMoon = s.soundPlan('moon', 'x').partials.length
    for (let i = 0; i < 40; i++) s.playBody(body({ id: `m${i}` }))
    const ctx = FakeContext.made[0]!
    expect(ctx.oscillators).toHaveLength(14 * perMoon)
    vi.advanceTimersByTime(2000)
    s.playBody(body({ id: 'later' }))
    expect(ctx.oscillators).toHaveLength(15 * perMoon)
  })

  it('plays a run for a sun that changes level and nothing for one that does not', async () => {
    vi.stubGlobal('AudioContext', FakeContext)
    const s = await freshSounds()
    s.playSun(1, 1)
    expect(FakeContext.made).toHaveLength(0)
    s.playSun(0, 2)
    const ctx = FakeContext.made[0]!
    // Three notes, each a moon-like tick of three partials.
    expect(ctx.oscillators).toHaveLength(3 * s.soundPlan('moon', 'x').partials.length)
  })

  it('goes quiet for good when a context cannot be made', async () => {
    vi.stubGlobal('AudioContext', class {
      constructor() {
        throw new Error('no audio device')
      }
    })
    const s = await freshSounds()
    expect(s.soundSupported()).toBe(true)
    expect(() => s.playBody(body({ id: 'A' }))).not.toThrow()
    expect(s.soundSupported()).toBe(false)
    expect(() => s.playSun(2, 0)).not.toThrow()
  })

  it('keeps the volume between 0 and 1 and puts it on the master gain once there is one', async () => {
    vi.stubGlobal('AudioContext', FakeContext)
    const s = await freshSounds()
    s.setSoundVolume(7)
    s.playBody(body({ id: 'A' }))
    const master = FakeContext.made[0]!.gains[0]!
    expect(master.gain.value).toBeCloseTo(0.7, 9)
    s.setSoundVolume(-3)
    expect(master.gain.value).toBe(0)
    s.setSoundVolume(Number.NaN)
    expect(master.gain.value).toBeCloseTo(0.35, 9)
  })
})
