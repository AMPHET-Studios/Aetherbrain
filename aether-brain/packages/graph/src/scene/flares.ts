/**
 * Corona ejections: a star that needs attention throws plasma (docs/COSMOLOGY.md, "A star that needs you erupts"). The more urgent its whole
 * system (the number that is its orbit's speed: open tasks, overdue ones most), the more often and the bigger: a quiet star does nothing,
 * a due one throws loops of plasma (prominences) now and then, and one that is overdue throws huge coronal mass ejections that leave
 * the star for many times its own radius.
 *
 * ONE instanced mesh for every flare there is (one draw call): each flare is an instance, each instance is a short stream of camera-facing
 * sprites whose whole motion is worked out in the vertex shader from a handful of numbers. The CPU only decides WHEN a star throws and WHICH
 * way (`FlareField.step`, plain typed arrays, nothing allocated per frame): at most `FLARE_MAX_STARS` stars flare at once (the most urgent,
 * the nearest the camera first) and at most `FLARE_MAX_ACTIVE` flares are alive, so a vault full of overdue folders is still bounded.
 * The scheduling is deterministic (hashed from the star and how many it has thrown), and the maths is plain numbers, tested without a GPU.
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial } from 'three'

/** A star below this urgency is quiet. From here it throws prominences, rarely; at 1 (overdue) often. */
export const FLARE_MIN_URGENCY = 0.35
/** From here a star can throw a huge ejection (never in calm mode). */
export const FLARE_CME_URGENCY = 0.7
/** Flares alive at once, and stars that flare at once. */
export const FLARE_MAX_ACTIVE = 96
export const FLARE_MAX_STARS = 40
/** Sprites in a flare. */
export const FLARE_PARTICLES = 64
/** Seconds between choosing again which stars flare (the camera moves, the urgency changes). */
export const FLARE_CHOOSE_EVERY = 0.5
/** The shader's clock wraps at this many seconds (float precision); a flare lives for seconds, so it never sees the wrap. */
export const FLARE_CLOCK_WRAP = 4096

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0)

/** A repeatable number in [0, 1) from two integers (no state, so the same star throws the same flares in the same order). */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Mean seconds between two flares of one star: never (Infinity) below `FLARE_MIN_URGENCY`, 16 s at it, 3 s when overdue. */
export function flareInterval(urgency: number): number {
  if (!(urgency >= FLARE_MIN_URGENCY)) return Infinity
  const x = (Math.min(1, urgency) - FLARE_MIN_URGENCY) / (1 - FLARE_MIN_URGENCY)
  return 16 - 13 * x
}

/** The chance that a flare is a huge ejection: 0 below `FLARE_CME_URGENCY` and in calm mode, 0.2 at it, 0.7 when overdue. */
export function ejectionChance(urgency: number, calm: boolean): number {
  if (calm || !(urgency >= FLARE_CME_URGENCY)) return 0
  const x = (Math.min(1, urgency) - FLARE_CME_URGENCY) / (1 - FLARE_CME_URGENCY)
  return 0.2 + 0.5 * x
}

export interface FlarePlan {
  /** 0 a prominence (a loop of plasma that rises and falls back), 1 a coronal mass ejection (a plume that leaves the star). */
  kind: 0 | 1
  /** Seconds it lives. */
  life: number
  /** How far it reaches, in radii of its star. */
  reach: number
  /** How strongly it glows, 0 to 1 (the star's urgency). */
  power: number
}

/** What one flare of a star of this urgency is. `roll` (0 to 1) decides prominence or ejection: the low part of it is the ejection's chance. */
export function planFlare(urgency: number, roll: number, calm: boolean): FlarePlan {
  const u = clamp01(urgency)
  if (roll < ejectionChance(u, calm)) return { kind: 1, life: 7 + 3 * u, reach: 6 + 6 * u, power: u }
  return { kind: 0, life: 4 + 2 * u, reach: 1.2 + 1.3 * u, power: u }
}

export function createFlareMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute vec2 aCorner;
      attribute float aIdx;
      attribute vec3 iCenter;
      attribute vec3 iDir;
      attribute vec3 iUp;
      attribute vec4 iParams; // start time, life, kind (0 prominence, 1 ejection), power
      attribute vec4 iShape;  // star radius, reach in radii, seed
      varying vec2 vUv;
      varying vec4 vColor;

      float rnd(float k) { return fract(sin(k * 127.1 + iShape.z * 311.7) * 43758.5453); }

      void main() {
        float life = iParams.y;
        float age = mod(uTime - iParams.x, ${FLARE_CLOCK_WRAP.toFixed(1)});
        float x = age / max(life, 0.001);
        if (life <= 0.0 || x > 1.0) {
          // Not alive: outside the clip volume, no pixels.
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          vUv = vec2(0.0);
          vColor = vec4(0.0);
          return;
        }
        float R = iShape.x;
        vec3 d = normalize(iDir);
        vec3 u = normalize(iUp);
        vec3 v = cross(d, u);
        float j = aIdx / ${(FLARE_PARTICLES - 1).toFixed(1)};
        float r1 = rnd(aIdx * 1.7 + 1.0);
        float r2 = rnd(aIdx * 3.1 + 5.0);
        float r3 = rnd(aIdx * 7.3 + 11.0);
        float power = iParams.w;
        vec3 world;
        float size;
        float alpha;
        float heat = 1.0 - x;
        if (iParams.z < 0.5) {
          // A prominence: an arch of plasma standing on the star, rising and then falling back.
          float rise = smoothstep(0.0, 0.3, x);
          float fall = 1.0 - smoothstep(0.62, 1.0, x);
          float hump = sin(3.14159265 * j);
          float H = R * iShape.y * rise;
          float span = R * (0.35 + 0.25 * iShape.y) * rise;
          world = iCenter + d * (R * 0.94 + H * hump) + u * (span * (1.0 - 2.0 * j)) + v * (R * 0.08 * (r2 - 0.5));
          size = R * (0.2 + 0.12 * r3) * (0.5 + 0.5 * hump);
          alpha = fall * (0.4 + 0.6 * hump);
        } else if (aIdx < 0.5) {
          // The flash where an ejection leaves: bright at once, gone within a moment.
          float f = clamp(x * 7.0, 0.0, 1.0);
          world = iCenter + d * (R * 0.98);
          size = R * (0.5 + 0.9 * sin(3.14159265 * f));
          alpha = (1.0 - f) * 1.4;
          heat = 1.0;
        } else {
          // An ejection: one stream of plasma from the star out to a head that speeds away, widening and twisting as it goes.
          float head = R * iShape.y * x * (0.5 + 0.5 * x);
          float s = j;
          float width = R * (0.1 + 0.6 * s) * (0.55 + 0.45 * sqrt(x));
          float ang = r1 * 6.28318530 + s * 3.0 + x * 1.5;
          world = iCenter + d * (R * 0.96 + head * s) + (u * cos(ang) + v * sin(ang)) * width * (0.3 + 0.7 * r2);
          size = R * (0.32 + 0.7 * s + 0.35 * x) * (0.6 + 0.7 * r3);
          alpha = (1.0 - smoothstep(0.35, 1.0, x)) * smoothstep(0.0, 0.06, x) * (0.5 + 0.5 * s);
          heat = (1.0 - x) * (0.5 + 0.5 * (1.0 - s));
        }
        vec4 mv = viewMatrix * vec4(world, 1.0);
        mv.xy += aCorner * size;
        gl_Position = projectionMatrix * mv;
        vUv = aCorner;
        // White-yellow while young, orange as it goes, a dull red at the end.
        vec3 hot = vec3(1.0, 0.93, 0.7);
        vec3 mid = vec3(1.0, 0.5, 0.15);
        vec3 cool = vec3(0.7, 0.1, 0.04);
        vec3 c = heat > 0.5 ? mix(mid, hot, (heat - 0.5) * 2.0) : mix(cool, mid, heat * 2.0);
        vColor = vec4(c * (1.1 + 1.7 * power * heat), alpha * (0.3 + 0.7 * power));
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec4 vColor;
      void main() {
        float d = length(vUv);
        if (d > 1.0) discard;
        float a = 1.0 - d;
        a = a * a;
        gl_FragColor = vec4(vColor.rgb * a * vColor.a, a * vColor.a);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
  })
}

/** What one frame needs to know. Every array is indexed by graph node. */
export interface FlareInput {
  /** The flare clock in seconds: it does not move while the orbits are paused, so a flare freezes with them. */
  clock: number
  /** Flares on or off (the setting, the layout, reduced motion). Off: everything is cleared. */
  enabled: boolean
  /** Calm mode: no ejections, prominences half as often. */
  calm: boolean
  /** Nodes that can flare: folder stars (not the vault, a drive, the Bio star) whose urgency reaches `FLARE_MIN_URGENCY`. */
  candidates: ArrayLike<number>
  urgency: ArrayLike<number>
  /** How far each body is out of its sun (0 hidden in a closed sun, 1 shown): only shown stars flare. */
  reveal: ArrayLike<number>
  /** The drawn radius of each node. */
  radius: ArrayLike<number>
  /** Where each node is now, xyz per node. */
  pos: ArrayLike<number>
  /** Where the camera is: the stars nearest it are the ones that flare when there are too many. */
  cam: { x: number; y: number; z: number }
}

/** The flares of a graph of `count` nodes: who throws what, when, and the mesh that draws it. */
export class FlareField {
  readonly mesh: Mesh
  readonly geometry: InstancedBufferGeometry
  private readonly material: ShaderMaterial
  /** Per flare slot: the star it comes from (-1: free) and the clock time it ends. */
  readonly star = new Int32Array(FLARE_MAX_ACTIVE).fill(-1)
  private readonly endAt = new Float64Array(FLARE_MAX_ACTIVE)
  private readonly center: InstancedBufferAttribute
  private readonly dir: InstancedBufferAttribute
  private readonly up: InstancedBufferAttribute
  private readonly params: InstancedBufferAttribute
  private readonly shape: InstancedBufferAttribute
  /** Per node: the clock time its next flare is due (NaN: not scheduled), and how many it has thrown. */
  private readonly nextAt: Float64Array
  private readonly thrown: Uint32Array
  /** The stars that flare now. */
  readonly live = new Int32Array(FLARE_MAX_STARS)
  nLive = 0
  private lastChoose = -Infinity
  private cursor = 0
  /** True while nothing is alive and nothing is scheduled (flares off): a frame with flares off then costs nothing. */
  private idle = true
  /** Scratch for choosing, so choosing allocates nothing. */
  private readonly bestIdx = new Int32Array(FLARE_MAX_STARS)
  private readonly bestScore = new Float64Array(FLARE_MAX_STARS)

  constructor(count: number) {
    this.nextAt = new Float64Array(Math.max(1, count)).fill(Number.NaN)
    this.thrown = new Uint32Array(Math.max(1, count))
    const g = new InstancedBufferGeometry()
    const m = FLARE_PARTICLES
    const corner = new Float32Array(m * 4 * 2)
    const idx = new Float32Array(m * 4)
    const index = new Uint16Array(m * 6)
    const C = [-1, -1, 1, -1, 1, 1, -1, 1]
    for (let k = 0; k < m; k++) {
      for (let c = 0; c < 4; c++) {
        corner[(k * 4 + c) * 2] = C[c * 2]!
        corner[(k * 4 + c) * 2 + 1] = C[c * 2 + 1]!
        idx[k * 4 + c] = k
      }
      index.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6)
    }
    g.setIndex(new BufferAttribute(index, 1))
    // `position` is not used by the shader; three wants one.
    g.setAttribute('position', new BufferAttribute(new Float32Array(m * 4 * 3), 3))
    g.setAttribute('aCorner', new BufferAttribute(corner, 2))
    g.setAttribute('aIdx', new BufferAttribute(idx, 1))
    const per = (size: number, dynamic: boolean) => {
      const a = new InstancedBufferAttribute(new Float32Array(FLARE_MAX_ACTIVE * size), size)
      if (dynamic) a.setUsage(DynamicDrawUsage)
      return a
    }
    this.center = per(3, true)
    this.dir = per(3, false)
    this.up = per(3, false)
    this.params = per(4, false)
    this.shape = per(4, false)
    g.setAttribute('iCenter', this.center)
    g.setAttribute('iDir', this.dir)
    g.setAttribute('iUp', this.up)
    g.setAttribute('iParams', this.params)
    g.setAttribute('iShape', this.shape)
    g.instanceCount = 0
    this.geometry = g
    this.material = createFlareMaterial()
    this.mesh = new Mesh(g, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 4
    this.mesh.visible = false
  }

  /** Flares alive now. */
  get active(): number {
    let n = 0
    for (let s = 0; s < FLARE_MAX_ACTIVE; s++) if (this.star[s]! >= 0) n++
    return n
  }

  /** Advance one frame: end the flares that are over, choose the stars that flare, start the flares that are due, follow the stars. */
  step(inp: FlareInput): void {
    if (!inp.enabled) {
      if (!this.idle) this.clear()
      return
    }
    this.idle = false
    const clock = inp.clock
    let dirty = false
    // 1. End the flares that are over.
    for (let s = 0; s < FLARE_MAX_ACTIVE; s++) {
      if (this.star[s]! >= 0 && clock >= this.endAt[s]!) {
        this.star[s] = -1
        this.params.array[s * 4 + 1] = 0
        dirty = true
      }
    }
    // 2. Choose the stars that flare now (the most urgent, then the nearest), now and then.
    if (clock - this.lastChoose >= FLARE_CHOOSE_EVERY || clock < this.lastChoose) {
      this.lastChoose = clock
      this.choose(inp)
    }
    // 3. Start the flares that are due.
    for (let k = 0; k < this.nLive; k++) {
      const i = this.live[k]!
      if (!(clock >= this.nextAt[i]!)) continue
      const u = inp.urgency[i] ?? 0
      const slot = this.freeSlot()
      if (slot < 0) {
        this.nextAt[i] = clock + FLARE_CHOOSE_EVERY
        continue
      }
      this.start(slot, i, u, inp, clock)
      dirty = true
    }
    // 4. Follow the stars, and tell the GPU what changed.
    let top = 0
    const c = this.center.array as Float32Array
    for (let s = 0; s < FLARE_MAX_ACTIVE; s++) {
      const i = this.star[s]!
      if (i < 0) continue
      c[s * 3] = inp.pos[i * 3] ?? 0
      c[s * 3 + 1] = inp.pos[i * 3 + 1] ?? 0
      c[s * 3 + 2] = inp.pos[i * 3 + 2] ?? 0
      top = s + 1
    }
    this.center.needsUpdate = true
    if (dirty) {
      this.dir.needsUpdate = true
      this.up.needsUpdate = true
      this.params.needsUpdate = true
      this.shape.needsUpdate = true
    }
    this.geometry.instanceCount = top
    this.mesh.visible = top > 0
    this.material.uniforms['uTime']!.value = clock % FLARE_CLOCK_WRAP
  }

  /** No flares, no schedule: used when flares are switched off. */
  clear(): void {
    let any = false
    for (let s = 0; s < FLARE_MAX_ACTIVE; s++) {
      if (this.star[s]! >= 0) {
        any = true
        this.star[s] = -1
        this.params.array[s * 4 + 1] = 0
      }
    }
    if (any) this.params.needsUpdate = true
    this.nextAt.fill(Number.NaN)
    this.nLive = 0
    this.lastChoose = -Infinity
    this.geometry.instanceCount = 0
    this.mesh.visible = false
    this.idle = true
  }

  /**
   * Take over the flares of the field this one replaces (the graph was rebuilt: every node may have a new index), matched by node id:
   * the flares that are in the air keep flying and the stars keep their schedule, so saving a note does not make every plume vanish.
   * `oldId` names a node of the old graph by its index, `newIndex` finds a node of the new graph by its id.
   */
  adoptFrom(old: FlareField, oldId: (i: number) => string | undefined, newIndex: (id: string) => number | undefined): void {
    if (old === this) return
    for (let s = 0; s < FLARE_MAX_ACTIVE; s++) {
      const was = old.star[s]!
      if (was < 0) continue
      const id = oldId(was)
      const now = id === undefined ? undefined : newIndex(id)
      if (now === undefined || now < 0 || now >= this.nextAt.length) continue
      this.star[s] = now
      this.endAt[s] = old.endAt[s]!
      for (const [mine, theirs, size] of [
        [this.dir, old.dir, 3],
        [this.up, old.up, 3],
        [this.params, old.params, 4],
        [this.shape, old.shape, 4],
      ] as const) {
        for (let k = 0; k < size; k++) (mine.array as Float32Array)[s * size + k] = (theirs.array as Float32Array)[s * size + k]!
      }
    }
    for (let i = 0; i < old.nextAt.length; i++) {
      const at = old.nextAt[i]!
      const n = old.thrown[i]!
      if (Number.isNaN(at) && n === 0) continue
      const id = oldId(i)
      const now = id === undefined ? undefined : newIndex(id)
      if (now === undefined || now < 0 || now >= this.nextAt.length) continue
      this.nextAt[now] = at
      this.thrown[now] = n
    }
    this.dir.needsUpdate = true
    this.up.needsUpdate = true
    this.params.needsUpdate = true
    this.shape.needsUpdate = true
    this.idle = false
    this.lastChoose = -Infinity
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }

  /** The best `FLARE_MAX_STARS` of the candidates: shown, urgent enough, ranked by urgency and nearness to the camera. */
  private choose(inp: FlareInput): void {
    let m = 0
    const best = this.bestIdx
    const score = this.bestScore
    const cands = inp.candidates
    for (let k = 0; k < cands.length; k++) {
      const i = cands[k]!
      const u = inp.urgency[i] ?? 0
      if (!(u >= FLARE_MIN_URGENCY) || (inp.reveal[i] ?? 0) < 0.98) continue
      const dx = (inp.pos[i * 3] ?? 0) - inp.cam.x
      const dy = (inp.pos[i * 3 + 1] ?? 0) - inp.cam.y
      const dz = (inp.pos[i * 3 + 2] ?? 0) - inp.cam.z
      const s = u / (1 + Math.sqrt(dx * dx + dy * dy + dz * dz) / 400) + (i % 997) * 1e-9
      if (m === FLARE_MAX_STARS && s <= score[m - 1]!) continue
      // Insert into the short list, best first.
      let at = m < FLARE_MAX_STARS ? m : m - 1
      while (at > 0 && score[at - 1]! < s) {
        score[at] = score[at - 1]!
        best[at] = best[at - 1]!
        at--
      }
      score[at] = s
      best[at] = i
      if (m < FLARE_MAX_STARS) m++
    }
    this.nLive = m
    for (let k = 0; k < m; k++) {
      const i = best[k]!
      this.live[k] = i
      // A star that starts to flare does not throw at once: its first one comes within its interval, staggered by who it is.
      if (Number.isNaN(this.nextAt[i]!)) this.nextAt[i] = inp.clock + hash01(i, 7) * Math.min(flareInterval(inp.urgency[i] ?? 0), 30)
    }
  }

  private freeSlot(): number {
    for (let n = 0; n < FLARE_MAX_ACTIVE; n++) {
      const s = (this.cursor + n) % FLARE_MAX_ACTIVE
      if (this.star[s]! < 0) {
        this.cursor = (s + 1) % FLARE_MAX_ACTIVE
        return s
      }
    }
    return -1
  }

  private start(slot: number, i: number, u: number, inp: FlareInput, clock: number): void {
    const n = this.thrown[i]!
    const plan = planFlare(u, hash01(i, n * 4 + 1), inp.calm)
    // A direction out of the star, anywhere on its sphere.
    const z = 2 * hash01(i, n * 4 + 2) - 1
    const phi = 2 * Math.PI * hash01(i, n * 4 + 3)
    const s = Math.sqrt(1 - z * z)
    const dx = s * Math.cos(phi)
    const dy = s * Math.sin(phi)
    const dz = z
    // Any direction across it (the one of the three axes it is least along, crossed with it).
    const ax = Math.abs(dx) < 0.6 ? 1 : 0
    const ay = ax === 0 && Math.abs(dy) < 0.6 ? 1 : 0
    const az = ax === 0 && ay === 0 ? 1 : 0
    let ux = dy * az - dz * ay
    let uy = dz * ax - dx * az
    let uz = dx * ay - dy * ax
    const ul = Math.hypot(ux, uy, uz) || 1
    ux /= ul
    uy /= ul
    uz /= ul
    ;(this.dir.array as Float32Array).set([dx, dy, dz], slot * 3)
    ;(this.up.array as Float32Array).set([ux, uy, uz], slot * 3)
    ;(this.params.array as Float32Array).set([clock % FLARE_CLOCK_WRAP, plan.life, plan.kind, plan.power], slot * 4)
    ;(this.shape.array as Float32Array).set([Math.max(0.1, inp.radius[i] ?? 1), plan.reach, hash01(i, n * 4 + 4) * 10, 0], slot * 4)
    this.star[slot] = i
    this.endAt[slot] = clock + plan.life
    this.thrown[i] = n + 1
    // The next one: about an interval away (twice as far in calm mode), never quite regular.
    const every = flareInterval(u) * (inp.calm ? 2 : 1)
    this.nextAt[i] = clock + every * (0.55 + 0.9 * hash01(i, n * 4 + 5))
  }
}
