/**
 * Asteroids: the reminders that float by (docs/COSMOLOGY.md, "Asteroids are reminders").
 *
 * Each reminder (an open task that is due soon or late, or a note tagged `reminder`) is a lumpy rock drifting through the part of the sky
 * you are looking at: a box that follows the camera, so wherever you are there are a few going by. A rock that is more urgent is nearer,
 * bigger, redder and faster; an overdue one is an ember. It tumbles, it wraps round the box and fades at its edges so none ever pops.
 * Hover one to read it, click it to open its note.
 *
 * ONE InstancedMesh with the planets' own rock shader, and every position is plain maths on typed arrays (`asteroidPlace`), so nothing is
 * allocated per frame and the whole motion is tested without a GPU. The clock is the orbit clock: `o` stops them with everything else.
 */
import { DynamicDrawUsage, Euler, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3, type PerspectiveCamera } from 'three'
import type { Reminder } from '@aether/core'
import { createNodeMaterial } from './materials'

/** The most asteroids at once (the same as the most reminders there are). */
export const ASTEROID_MAX = 24
/** The box follows the camera: its half width is this share of the distance to what the camera looks at, never less or more than these. */
export const ASTEROID_BOX_SHARE = 0.9
export const ASTEROID_BOX_MIN = 40
export const ASTEROID_BOX_MAX = 1500
/** An asteroid's radius as a share of the box's half width: a calm one, and how much more an overdue one has. */
export const ASTEROID_SIZE = 0.012
export const ASTEROID_SIZE_URGENT = 0.02
/** Box widths per second: a calm one drifts, an overdue one hurries. */
export const ASTEROID_SPEED = 0.012
export const ASTEROID_SPEED_URGENT = 0.03
/** Where in the box the fade starts, 0 (the middle) to 1 (the edge). */
const FADE_FROM = 0.72

/** The path of one asteroid, all in box units (-1 to 1): where it starts, how it drifts, how it tumbles and how lumpy it is. */
export interface AsteroidPlan {
  o: [number, number, number]
  v: [number, number, number]
  spin: [number, number, number]
  /** How much longer than wide, per axis (0.7 to 1.3). */
  squash: [number, number, number]
  /** 0 to 1: a little extra size, so no two are the same. */
  jitter: number
}

/** Stable hash of a string to [0, 1) (FNV-1a with a murmur3 finish). */
export function hash01(s: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** The same key and urgency always give the same path. More urgent is nearer the middle of the box and faster. */
export function planAsteroid(key: string, urgency: number): AsteroidPlan {
  const u = clamp01(urgency)
  const near = 1 - 0.45 * u
  const dir = (a: number, b: number): [number, number, number] => {
    const x = hash01(key, a) * 2 - 1
    const y = (hash01(key, b) * 2 - 1) * 0.5
    const z = hash01(key, a + b) * 2 - 1
    const len = Math.hypot(x, y, z) || 1
    return [x / len, y / len, z / len]
  }
  const d = dir(11, 12)
  const speed = ASTEROID_SPEED + (ASTEROID_SPEED_URGENT - ASTEROID_SPEED) * u
  return {
    o: [(hash01(key, 1) * 2 - 1) * near, (hash01(key, 2) * 2 - 1) * near * 0.6, (hash01(key, 3) * 2 - 1) * near],
    // The box is 2 wide: a drift of `speed` box widths per second is 2 * speed in box units.
    v: [d[0] * 2 * speed, d[1] * 2 * speed, d[2] * 2 * speed],
    spin: [(hash01(key, 4) - 0.5) * 0.9, (hash01(key, 5) - 0.5) * 0.9, (hash01(key, 6) - 0.5) * 0.9],
    squash: [0.7 + 0.6 * hash01(key, 7), 0.7 + 0.6 * hash01(key, 8), 0.7 + 0.6 * hash01(key, 9)],
    jitter: hash01(key, 10),
  }
}

/** `x` wrapped into [-1, 1). */
function wrap(x: number): number {
  const m = (((x + 1) % 2) + 2) % 2
  return m - 1
}

/**
 * Where an asteroid is `t` seconds in, in box units (-1 to 1), into `out` (x y z), and how visible it is (0 at the box's edge, 1 in the
 * middle): the return value. Allocates nothing.
 */
export function asteroidPlace(plan: AsteroidPlan, t: number, out: Float32Array | number[], at = 0): number {
  const tt = Number.isFinite(t) ? t : 0
  const x = wrap(plan.o[0] + plan.v[0] * tt)
  const y = wrap(plan.o[1] + plan.v[1] * tt)
  const z = wrap(plan.o[2] + plan.v[2] * tt)
  out[at] = x
  out[at + 1] = y
  out[at + 2] = z
  const edge = Math.max(Math.abs(x), Math.abs(y), Math.abs(z))
  const f = clamp01((1 - edge) / (1 - FADE_FROM))
  return f * f * (3 - 2 * f)
}

/** The box that follows the camera: its centre (half way to what it looks at) and its half width. */
export function asteroidBox(camera: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }, out: { cx: number; cy: number; cz: number; half: number }): void {
  const dx = target.x - camera.x
  const dy = target.y - camera.y
  const dz = target.z - camera.z
  const d = Math.hypot(dx, dy, dz)
  out.cx = camera.x + dx * 0.5
  out.cy = camera.y + dy * 0.5
  out.cz = camera.z + dz * 0.5
  out.half = Math.min(ASTEROID_BOX_MAX, Math.max(ASTEROID_BOX_MIN, (Number.isFinite(d) ? d : 0) * ASTEROID_BOX_SHARE))
}

/** An asteroid's colour: amber when calm, red when overdue (0 to 1 per channel). */
export function asteroidColor(urgency: number, out: Float32Array | number[], at = 0): void {
  const u = clamp01(urgency)
  out[at] = 0.95
  out[at + 1] = 0.48 - 0.38 * u
  out[at + 2] = 0.14 - 0.08 * u
}

/** A rock's lumps, baked into an icosphere once: every vertex pushed in or out by a hash of where it is. */
function lumpyRock(): IcosahedronGeometry {
  const g = new IcosahedronGeometry(1, 2)
  const p = g.getAttribute('position')
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i)
    const z = p.getZ(i)
    const k = `${Math.round(x * 6)},${Math.round(y * 6)},${Math.round(z * 6)}`
    const s = 0.78 + 0.4 * hash01(k, 21) + 0.12 * Math.sin(x * 5.1 + y * 3.7) * Math.cos(z * 4.3)
    p.setXYZ(i, x * s, y * s, z * s)
  }
  g.computeVertexNormals()
  return g
}

export interface AsteroidInput {
  /** The orbit clock in seconds (stops with `o`). */
  clock: number
  enabled: boolean
  reminders: readonly Reminder[]
  camera: PerspectiveCamera
  /** What the camera looks at. */
  target: { x: number; y: number; z: number }
  width: number
  height: number
}

const _m = new Matrix4()
const _p = new Vector3()
const _q = new Quaternion()
const _s = new Vector3()
const _e = new Euler()
const _box = { cx: 0, cy: 0, cz: 0, half: 1 }
const _pos = [0, 0, 0]
const _cam = { x: 0, y: 0, z: 0 }

export class AsteroidField {
  readonly mesh: InstancedMesh
  private readonly geometry: IcosahedronGeometry
  private readonly glow: InstancedBufferAttribute
  private readonly color: InstancedBufferAttribute
  private plans: AsteroidPlan[] = []
  private keys: string[] = []
  private list: readonly Reminder[] = []
  /** Screen place of each asteroid (x, y, radius in pixels, depth), for hovering and clicking: radius 0 when it is not shown. */
  readonly screen = new Float32Array(ASTEROID_MAX * 4)
  /** How many asteroids there are. */
  count = 0

  constructor() {
    this.geometry = lumpyRock()
    this.glow = new InstancedBufferAttribute(new Float32Array(ASTEROID_MAX * 4), 4)
    const light = new InstancedBufferAttribute(new Float32Array(ASTEROID_MAX * 4), 4)
    for (let i = 0; i < ASTEROID_MAX; i++) {
      light.array[i * 4] = 0.45
      light.array[i * 4 + 1] = 0.8
      light.array[i * 4 + 2] = 0.35
    }
    this.color = new InstancedBufferAttribute(new Float32Array(ASTEROID_MAX * 3), 3)
    this.geometry.setAttribute('aGlow', this.glow)
    this.geometry.setAttribute('aLight', light)
    this.mesh = new InstancedMesh(this.geometry, createNodeMaterial(), ASTEROID_MAX)
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.instanceColor = this.color
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.mesh.visible = false
  }

  /** Take a new list of reminders: plans for the ones that are there, kept for the ones that already were. */
  private adopt(list: readonly Reminder[]): void {
    this.list = list
    const n = Math.min(ASTEROID_MAX, list.length)
    this.plans = new Array<AsteroidPlan>(n)
    this.keys = new Array<string>(n)
    for (let i = 0; i < n; i++) {
      const r = list[i]!
      this.keys[i] = r.key
      this.plans[i] = planAsteroid(r.key, r.urgency)
      asteroidColor(r.urgency, this.color.array as Float32Array, i * 3)
      const u = clamp01(r.urgency)
      const g = this.glow.array as Float32Array
      g[i * 4] = 0.8 + 0.5 * u * u
      g[i * 4 + 1] = 1
      g[i * 4 + 2] = hash01(r.key, 30) * 6.283
      g[i * 4 + 3] = 1
    }
    this.count = n
    this.mesh.count = n
    this.color.needsUpdate = true
    this.glow.needsUpdate = true
  }

  /** Advance one frame: place every asteroid in the box that follows the camera. */
  step(inp: AsteroidInput): void {
    if (!inp.enabled || inp.reminders.length === 0) {
      if (this.mesh.visible) {
        this.mesh.visible = false
        this.screen.fill(0)
      }
      return
    }
    if (inp.reminders !== this.list) this.adopt(inp.reminders)
    _cam.x = inp.camera.position.x
    _cam.y = inp.camera.position.y
    _cam.z = inp.camera.position.z
    asteroidBox(_cam, inp.target, _box)
    const half = _box.half
    const halfH = inp.height / 2
    const tanHalf = Math.tan((inp.camera.fov * Math.PI) / 360)
    for (let i = 0; i < this.count; i++) {
      const plan = this.plans[i]!
      const r = this.list[i]!
      const fade = asteroidPlace(plan, inp.clock, _pos)
      const size = half * (ASTEROID_SIZE + ASTEROID_SIZE_URGENT * clamp01(r.urgency)) * (0.8 + 0.4 * plan.jitter) * fade
      _p.set(_box.cx + _pos[0]! * half, _box.cy + _pos[1]! * half, _box.cz + _pos[2]! * half)
      _e.set(inp.clock * plan.spin[0], inp.clock * plan.spin[1], inp.clock * plan.spin[2])
      _q.setFromEuler(_e)
      _s.set(size * plan.squash[0], size * plan.squash[1], size * plan.squash[2])
      _m.compose(_p, _q, _s)
      _m.toArray(this.mesh.instanceMatrix.array as Float32Array, i * 16)
      // Screen place, for the pointer.
      _p.project(inp.camera)
      const dist = Math.max(1e-3, inp.camera.position.distanceTo(_s.set(_box.cx + _pos[0]! * half, _box.cy + _pos[1]! * half, _box.cz + _pos[2]! * half)))
      const shown = fade > 0.15 && _p.z > -1 && _p.z < 1
      this.screen[i * 4] = (_p.x * 0.5 + 0.5) * inp.width
      this.screen[i * 4 + 1] = (1 - (_p.y * 0.5 + 0.5)) * inp.height
      this.screen[i * 4 + 2] = shown ? Math.max(6, (size * Math.max(...plan.squash) * halfH) / (dist * tanHalf)) : 0
      this.screen[i * 4 + 3] = _p.z
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.visible = true
  }

  /** The asteroid under the pointer (the nearest one), or -1. */
  hit(x: number, y: number): number {
    let best = -1
    let bestZ = Infinity
    for (let i = 0; i < this.count; i++) {
      const r = this.screen[i * 4 + 2]!
      if (r <= 0) continue
      const dx = this.screen[i * 4]! - x
      const dy = this.screen[i * 4 + 1]! - y
      if (dx * dx + dy * dy <= (r + 4) * (r + 4) && this.screen[i * 4 + 3]! < bestZ) {
        bestZ = this.screen[i * 4 + 3]!
        best = i
      }
    }
    return best
  }

  /** The reminder behind asteroid `i`. */
  reminder(i: number): Reminder | undefined {
    return this.list[i]
  }

  dispose(): void {
    this.geometry.dispose()
    ;(this.mesh.material as { dispose(): void }).dispose()
  }
}
