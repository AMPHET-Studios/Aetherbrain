/**
 * The sound of the sky. A click on a star, a planet or a moon plays a short note, and opening or closing a sun plays a rising or
 * falling run. Everything is synthesised here (oscillators, a reverb made of decaying noise): no sound files are shipped, nothing is
 * downloaded, nothing leaves the computer, and a build with no Web Audio is simply silent.
 *
 * What makes it pleasant to play with: every body has its own note, always the same one (a hash of its id picks a degree of the
 * pentatonic scale, which has no wrong notes, so any run of clicks is a tune); a star rings low and long like a bell, a planet is a
 * round pluck, a moon a bright glassy tick. `soundPlan` is the pure part (which note, which instrument), tested without any audio.
 */
import { isGalaxyNode, isPlanetNode, type GraphNode } from '@aether/core'

export type SoundKind = 'galaxy' | 'star' | 'sun' | 'planet' | 'picture' | 'moon' | 'today' | 'ghost'

/** The sound a body makes: a drive is a galaxy, a folder a star, a reference board a sun, a big file a planet, a small one a moon. */
export function soundKindOf(n: GraphNode): SoundKind {
  if (n.kind === 'today') return 'today'
  if (n.folder) return isGalaxyNode(n) ? 'galaxy' : 'star'
  if (n.board) return 'sun'
  if (n.ghost) return 'ghost'
  if (n.kind === 'image') return isPlanetNode(n) ? 'picture' : 'moon'
  return isPlanetNode(n) ? 'planet' : 'moon'
}

/** Semitones above the root of the major pentatonic scale: any two of its notes sound well together. */
export const PENTATONIC: readonly number[] = [0, 2, 4, 7, 9]
/** Middle C, the root of every sound, in hertz. */
export const ROOT_HZ = 261.6256
/** Octaves above middle C each kind plays in: the big bodies low, the small ones high. */
export const OCTAVES: Record<SoundKind, number> = { galaxy: -1, star: -1, sun: 0, planet: 0, picture: 0, moon: 1, today: 1, ghost: 1 }

/** A hash of a string to an unsigned 32-bit integer (FNV-1a): the same id is always the same note. */
export function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** The note (hertz) of a body: its degree of the scale from its id, in its kind's octave. */
export function noteFor(kind: SoundKind, id: string): number {
  const degree = hash32(id) % PENTATONIC.length
  const semitones = PENTATONIC[degree]! + 12 * OCTAVES[kind]
  return ROOT_HZ * Math.pow(2, semitones / 12)
}

export interface Overtone {
  /** Multiple of the fundamental (a bell's partials are not whole multiples). */
  ratio: number
  gain: number
  /** Seconds to die away. */
  decay: number
  type: 'sine' | 'triangle'
}

export interface SoundPlan {
  freq: number
  /** Seconds to reach full level: short is a pluck, longer a swell. */
  attack: number
  partials: Overtone[]
  /** Ratios of extra voices sounded with the first (a chord: 1, 1.5, 2 is a root, a fifth and an octave). */
  chord: number[]
  /** Cutoff (Hz) of the lowpass: a star is warm, a moon bright. */
  lowpass: number
  /** How much of the sound goes to the reverb, 0 to 1. */
  reverb: number
  /** A soft low thump under it (stars). */
  thump: boolean
  /** Notes of a rising sparkle after it (the Today hub, a sun). */
  sparkle: number
  /** Loudness, 0 to 1 of a voice. */
  gain: number
}

const MOON: Overtone[] = [
  { ratio: 1, gain: 0.6, decay: 0.32, type: 'sine' },
  { ratio: 2.76, gain: 0.22, decay: 0.14, type: 'sine' },
  { ratio: 5.4, gain: 0.08, decay: 0.07, type: 'sine' },
]
const PLANET: Overtone[] = [
  { ratio: 1, gain: 0.55, decay: 0.7, type: 'triangle' },
  { ratio: 2, gain: 0.2, decay: 0.35, type: 'sine' },
  { ratio: 3, gain: 0.1, decay: 0.22, type: 'sine' },
  { ratio: 4.1, gain: 0.06, decay: 0.12, type: 'sine' },
]
const BELL: Overtone[] = [
  { ratio: 1, gain: 0.5, decay: 1.5, type: 'sine' },
  { ratio: 2, gain: 0.28, decay: 1.1, type: 'sine' },
  { ratio: 3, gain: 0.14, decay: 0.8, type: 'sine' },
  { ratio: 5.04, gain: 0.09, decay: 0.5, type: 'sine' },
]
const SHIMMER: Overtone[] = [
  { ratio: 1, gain: 0.5, decay: 0.55, type: 'sine' },
  { ratio: 2.01, gain: 0.25, decay: 0.4, type: 'sine' },
  { ratio: 6, gain: 0.1, decay: 0.25, type: 'sine' },
]

/** Which note and which instrument a body plays. Pure: the same kind and id always make the same plan. */
export function soundPlan(kind: SoundKind, id: string): SoundPlan {
  const freq = noteFor(kind, id)
  const base = { freq, chord: [1], thump: false, sparkle: 0 }
  switch (kind) {
    case 'moon':
      return { ...base, attack: 0.002, partials: MOON, lowpass: 7000, reverb: 0.22, gain: 0.22 }
    case 'planet':
      return { ...base, attack: 0.004, partials: PLANET, lowpass: 4500, reverb: 0.3, gain: 0.26 }
    case 'picture':
      return { ...base, attack: 0.003, partials: SHIMMER, lowpass: 6000, reverb: 0.34, gain: 0.24 }
    case 'ghost':
      return { ...base, attack: 0.006, partials: PLANET.slice(0, 2), lowpass: 2600, reverb: 0.2, gain: 0.14 }
    case 'star':
      return { ...base, attack: 0.01, partials: BELL, lowpass: 3200, reverb: 0.45, thump: true, gain: 0.3 }
    case 'galaxy':
      return { ...base, chord: [1, 1.5, 2], attack: 0.02, partials: BELL, lowpass: 2800, reverb: 0.55, thump: true, gain: 0.26 }
    case 'sun':
      return { ...base, attack: 0.008, partials: BELL, lowpass: 5200, reverb: 0.45, sparkle: 2, gain: 0.26 }
    case 'today':
      return { ...base, attack: 0.006, partials: SHIMMER, lowpass: 6500, reverb: 0.5, sparkle: 3, gain: 0.24 }
  }
}

/**
 * The run that opens a sun (level 1: three notes rising, level 2: five) or closes one (falling). Notes are degrees of the scale from
 * the root, in hertz, with when each one starts, in seconds.
 */
export function sunRun(level: 0 | 1 | 2, previous: 0 | 1 | 2): { freq: number; at: number }[] {
  const opening = level > previous
  const count = opening ? (level === 2 ? 5 : 3) : 3
  const out: { freq: number; at: number }[] = []
  for (let k = 0; k < count; k++) {
    const degree = opening ? k : count - 1 - k
    const octave = Math.floor(degree / PENTATONIC.length)
    const semitones = PENTATONIC[degree % PENTATONIC.length]! + 12 * (octave + 1)
    out.push({ freq: ROOT_HZ * Math.pow(2, semitones / 12), at: k * 0.065 })
  }
  return out
}

/* ---- the synth: Web Audio, made on first use ---- */

interface Rig {
  ctx: AudioContext
  master: GainNode
  reverb: GainNode
  voices: number
}

let rig: Rig | null = null
let unsupported = false
/** Most notes sounding at once: a hammered key must not become a roar. */
const MAX_VOICES = 14
/** The loudness of everything, 0 to 1. */
let volume = 0.5

export function setSoundVolume(v: number): void {
  volume = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5))
  if (rig) rig.master.gain.value = volume * 0.7
}

/** True when this environment can make sound at all. */
export function soundSupported(): boolean {
  if (unsupported) return false
  const w = globalThis as { AudioContext?: unknown; webkitAudioContext?: unknown }
  return typeof w.AudioContext === 'function' || typeof w.webkitAudioContext === 'function'
}

function getRig(): Rig | null {
  if (rig) return rig
  if (!soundSupported()) return null
  try {
    const w = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    const Ctor = (w.AudioContext ?? w.webkitAudioContext)!
    const ctx = new Ctor()
    const master = ctx.createGain()
    master.gain.value = volume * 0.7
    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -16
    compressor.ratio.value = 5
    master.connect(compressor)
    compressor.connect(ctx.destination)
    // A reverb made of noise that dies away: the sound hangs in the dark a moment, as it would in a big empty place.
    const convolver = ctx.createConvolver()
    const seconds = 1.7
    const length = Math.floor(ctx.sampleRate * seconds)
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate)
    for (let c = 0; c < 2; c++) {
      const data = impulse.getChannelData(c)
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.2)
    }
    convolver.buffer = impulse
    const reverb = ctx.createGain()
    reverb.gain.value = 0.5
    reverb.connect(convolver)
    convolver.connect(master)
    rig = { ctx, master, reverb, voices: 0 }
    return rig
  } catch {
    unsupported = true
    return null
  }
}

/** One note of a plan, starting `delay` seconds from now. */
function sound(r: Rig, plan: SoundPlan, delay = 0, level = 1): void {
  if (r.voices >= MAX_VOICES) return
  const { ctx } = r
  const t0 = ctx.currentTime + delay + 0.005
  const detune = (Math.random() - 0.5) * 8
  const out = ctx.createGain()
  out.gain.value = plan.gain * level
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = plan.lowpass
  filter.Q.value = 0.4
  out.connect(filter)
  filter.connect(r.master)
  const send = ctx.createGain()
  send.gain.value = plan.reverb
  filter.connect(send)
  send.connect(r.reverb)
  let longest = 0
  r.voices++
  for (const ratio of plan.chord) {
    for (const p of plan.partials) {
      const o = ctx.createOscillator()
      o.type = p.type
      o.frequency.value = plan.freq * ratio * p.ratio
      o.detune.value = detune
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t0)
      g.gain.linearRampToValueAtTime(p.gain, t0 + plan.attack)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + plan.attack + p.decay)
      o.connect(g)
      g.connect(out)
      o.start(t0)
      o.stop(t0 + plan.attack + p.decay + 0.05)
      longest = Math.max(longest, plan.attack + p.decay)
    }
  }
  if (plan.thump) {
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(plan.freq * 0.5, t0)
    o.frequency.exponentialRampToValueAtTime(48, t0 + 0.18)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3)
    o.connect(g)
    g.connect(out)
    o.start(t0)
    o.stop(t0 + 0.35)
  }
  const done = setTimeout(() => {
    r.voices = Math.max(0, r.voices - 1)
  }, (delay + longest + 0.2) * 1000)
  void done
  // The sparkle: a few notes rising from the body's own note, quiet and bright.
  for (let k = 0; k < plan.sparkle; k++) {
    const ratio = [1.5, 2, 3][k] ?? 3
    sound(r, { ...MOON_PLAN, freq: plan.freq * ratio, gain: 0.12, chord: [1], thump: false, sparkle: 0 }, delay + 0.07 * (k + 1), level)
  }
}

const MOON_PLAN: SoundPlan = { freq: 880, attack: 0.002, partials: MOON, chord: [1], lowpass: 8000, reverb: 0.4, thump: false, sparkle: 0, gain: 0.12 }

/** Play the sound of a body (a click on it). Silent when the environment has no audio or the context is still locked. */
export function playBody(n: GraphNode): void {
  const r = getRig()
  if (!r) return
  if (r.ctx.state === 'suspended') void r.ctx.resume()
  sound(r, soundPlan(soundKindOf(n), n.id))
}

/** Play the run of a sun opening or closing (levels 0, 1, 2: a rising run when it opens further, a falling one when it closes). */
export function playSun(level: 0 | 1 | 2, previous: 0 | 1 | 2): void {
  if (level === previous) return
  const r = getRig()
  if (!r) return
  if (r.ctx.state === 'suspended') void r.ctx.resume()
  for (const note of sunRun(level, previous)) {
    sound(r, { ...MOON_PLAN, freq: note.freq, gain: level > previous ? 0.2 : 0.16, reverb: 0.5, lowpass: level > previous ? 7500 : 3800 }, note.at)
  }
}
