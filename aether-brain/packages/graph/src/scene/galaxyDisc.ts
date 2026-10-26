/**
 * The disc of a galaxy: a faint, soft plate of light with two loose spiral arms, lying in the plane its folders orbit in, so a galaxy
 * (a drive, the vault, a folder you marked) reads as a galaxy and not as a bright sun with a ring (docs/COSMOLOGY.md, "A galaxy is a
 * folder you mark").
 *
 * One InstancedMesh for every galaxy there is (one draw call, never a mesh per galaxy). Each disc takes its plane and its size from the
 * OUTERMOST orbit ring the layout draws around its galaxy (`fitDiscs`), so the disc always matches the rings, and follows the galaxy's
 * live place every frame (`placeDiscs`, no allocation). Pure maths apart from the material, so the fitting and placing are tested
 * without a GPU.
 */
import { AdditiveBlending, CircleGeometry, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, ShaderMaterial, Vector3 } from 'three'

/** A disc reaches a little past the ring it follows, so the stars on the outer ring lie inside it, not on its edge. */
export const DISC_SCALE = 1.12
/**
 * How strong the plate is at its brightest, in linear light: the core's haze and an arm together. The scene's bloom starts at 1.0, so a
 * disc (and a few overlapping ones, nested galaxies) stays a plate and never flares.
 */
export const DISC_CORE = 0.1
export const DISC_ARM = 0.12
export const DISC_BASE = 0.045
/** Segments of the disc's rim. */
export const DISC_SEGMENTS = 64

export interface DiscSet {
  mesh: InstancedMesh
  /** Node index of each galaxy that gets a disc (the instance order). */
  node: Int32Array
  /** Instance of a node (-1: not a galaxy). */
  slotOf: Int32Array
  /** Radius of each disc in world units (0: its galaxy has no ring yet, so no disc), and its plane as a quaternion (x y z w). */
  radius: Float32Array
  quat: Float32Array
  /** Discs that have a size: `mesh.visible` follows it. */
  fitted: number
  dispose(): void
}

export function createDiscMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vP;
      varying vec3 vColor;
      void main() {
        vP = position.xz;
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #else
          vColor = vec3(1.0);
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vP;
      varying vec3 vColor;
      void main() {
        float r = length(vP);
        if (r > 1.0) discard;
        float a = atan(vP.y, vP.x);
        // Two loose logarithmic arms, soft where they fade into the plate.
        float arms = 0.5 + 0.5 * cos(2.0 * (a - 3.1 * log(r + 0.14)));
        float edge = smoothstep(1.0, 0.25, r);
        float core = exp(-r * r * 10.0);
        float strength = (${DISC_BASE.toFixed(3)} + ${DISC_ARM.toFixed(3)} * arms * smoothstep(0.04, 0.3, r)) * edge + ${DISC_CORE.toFixed(3)} * core;
        gl_FragColor = vec4(vColor * strength, strength);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
  })
}

/**
 * The discs for `galaxies` (node indices) of a graph of `count` nodes. `color` gives each galaxy's tint (0 to 1 per channel).
 * The instance order is the order of `galaxies`.
 */
export function buildDiscs(galaxies: readonly number[], count: number, color: (node: number) => readonly [number, number, number]): DiscSet {
  const n = galaxies.length
  const geometry = new CircleGeometry(1, DISC_SEGMENTS)
  // The ring's own plane: a circle in XZ (CircleGeometry stands in XY), so the ring's quaternion tilts the disc the same way.
  geometry.rotateX(-Math.PI / 2)
  const material = createDiscMaterial()
  const mesh = new InstancedMesh(geometry, material, Math.max(1, n))
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  const tint = new Float32Array(Math.max(1, n) * 3)
  const node = new Int32Array(n)
  const slotOf = new Int32Array(count).fill(-1)
  for (let s = 0; s < n; s++) {
    const g = galaxies[s]!
    node[s] = g
    slotOf[g] = s
    const [r, gg, b] = color(g)
    tint[s * 3] = r
    tint[s * 3 + 1] = gg
    tint[s * 3 + 2] = b
  }
  mesh.instanceColor = new InstancedBufferAttribute(tint, 3)
  mesh.count = n
  mesh.frustumCulled = false
  mesh.renderOrder = -1
  mesh.visible = false
  const quat = new Float32Array(Math.max(1, n) * 4)
  for (let s = 0; s < n; s++) quat[s * 4 + 3] = 1
  return {
    mesh,
    node,
    slotOf,
    radius: new Float32Array(Math.max(1, n)),
    quat,
    fitted: 0,
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

/**
 * Give each galaxy's disc the size and plane of the outermost ring around it. `ringParent[k]` is the node index a ring orbits,
 * `ringRadius[k]` its radius and `ringQuat[k * 4 ..]` its plane (the layout's own numbers, `syncRings`). A galaxy with no ring has no
 * disc (radius 0). Anything not finite or not positive is ignored, so a bad ring never makes a disc the size of the sky.
 */
export function fitDiscs(set: DiscSet, ringParent: ArrayLike<number>, ringRadius: ArrayLike<number>, ringQuat: ArrayLike<number>, ringCount: number): void {
  set.radius.fill(0)
  for (let k = 0; k < ringCount; k++) {
    const p = ringParent[k]!
    const slot = p >= 0 && p < set.slotOf.length ? set.slotOf[p]! : -1
    if (slot < 0) continue
    const r = ringRadius[k]!
    if (!(r > 0) || !Number.isFinite(r) || r <= set.radius[slot]! / DISC_SCALE) continue
    const x = ringQuat[k * 4]!
    const y = ringQuat[k * 4 + 1]!
    const z = ringQuat[k * 4 + 2]!
    const w = ringQuat[k * 4 + 3]!
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(w))) continue
    set.radius[slot] = r * DISC_SCALE
    set.quat[slot * 4] = x
    set.quat[slot * 4 + 1] = y
    set.quat[slot * 4 + 2] = z
    set.quat[slot * 4 + 3] = w
  }
  let fitted = 0
  for (let s = 0; s < set.node.length; s++) if (set.radius[s]! > 0) fitted++
  set.fitted = fitted
  set.mesh.visible = fitted > 0
}

const _m = new Matrix4()
const _p = new Vector3()
const _q = new Quaternion()
const _s = new Vector3()

/** Centre every disc on its galaxy's live place (`pos`: xyz per node) with its plane and size; one upload. A disc with no size is a point. */
export function placeDiscs(set: DiscSet, pos: ArrayLike<number>): void {
  const out = set.mesh.instanceMatrix.array as Float32Array
  for (let s = 0; s < set.node.length; s++) {
    const g = set.node[s]!
    const r = set.radius[s]!
    _p.set(pos[g * 3] ?? 0, pos[g * 3 + 1] ?? 0, pos[g * 3 + 2] ?? 0)
    _q.set(set.quat[s * 4]!, set.quat[s * 4 + 1]!, set.quat[s * 4 + 2]!, set.quat[s * 4 + 3]!)
    _s.set(r, r, r)
    _m.compose(_p, _q, _s)
    _m.toArray(out, s * 16)
  }
  set.mesh.instanceMatrix.needsUpdate = true
}
