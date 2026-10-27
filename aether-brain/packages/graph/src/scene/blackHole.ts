/**
 * The Bio is a super massive black hole, and every galaxy in the sky revolves around it (docs/COSMOLOGY.md, "The Bio black hole").
 *
 * What is drawn: nothing but one billboard quad over the Bio, painted by a small ray tracer. For every pixel it follows a ray of light
 * past the hole, bending it as gravity does (the Schwarzschild approximation `a = -1.5 h² r / |r|⁵`), and asks where that ray meets the
 * accretion disc, a flat plate of white-hot, then blue, gas turning in the plane the galaxies orbit in. That one rule gives, for free:
 * the black shadow, the thin bright photon ring around it, the far side of the disc arching over the top and under the bottom, and the
 * side of the disc that turns towards you shining brighter. One draw call, no geometry, nothing allocated per frame.
 *
 * Lengths in the shader are in Schwarzschild radii `Rs` (`BH_RS` of the node's radius); the apparent shadow is about 2.6 Rs, which is
 * the node's own radius (the "event horizon" the picking and the layout use). Pure maths apart from the material, so the plane and the
 * feed are tested without a GPU.
 */
import { AddEquation, CustomBlending, DoubleSide, Mesh, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, ShaderMaterial, Vector3 } from 'three'
import { BIO_NOTES, type FolderNodeInfo } from '@aether/core'

/** One Schwarzschild radius, in radii of the node: the apparent shadow (2.6 Rs) comes out a little wider than the node. */
export const BH_RS = 0.42
/** Half the width of the quad, in radii of the node: it holds the whole disc (to 8 Rs) and the glow around it. */
export const BH_QUAD = 4.2
/** The accretion disc, in Rs: where it starts (the innermost stable orbit) and where it fades out. */
export const BH_DISC_IN = 3
export const BH_DISC_OUT = 8
/** The radius of the photon ring in Rs: the edge of the shadow. */
export const BH_PHOTON = 2.62
/** Where the bent part of a ray begins (Rs): outside it a ray is a straight line. */
export const BH_START = 12
/** Steps a ray may take; a ray still turning after this many is lost in the hole. */
export const BH_STEPS = 80

/** How far out the disc reaches, in radii of the node: the layout keeps this much (and more) clear around the hole. */
export const BH_DISC_REACH = BH_DISC_OUT * BH_RS

/** How hungry a dormant hole is (its Bio folder does not exist yet): no disc to speak of, only a faint ring. */
export const DORMANT_FEED = 0.1

/**
 * How hungry the black hole is, 0 to 1: how bright its accretion disc burns. Fed by what the Bio holds; a hole whose folder does not
 * exist yet (`placeholder`) is dormant and only shows its ring.
 *
 * TODO(human): decide what feeds your black hole. The default below lights the disc a little for the folder and then by how many of
 * the six pages exist, and nothing else. You could feed it by words written, by how recently a page was edited, or by anything else
 * `FolderNodeInfo` carries (`weight`, `totalNotes`, `images`); the result is clamped to 0 to 1 for you.
 */
export function holeFeed(f: Pick<FolderNodeInfo, 'placeholder' | 'totalNotes'> | undefined): number {
  if (f === undefined || f.placeholder === true) return DORMANT_FEED
  return clamp01(0.35 + 0.65 * (f.totalNotes / BIO_NOTES.length))
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

/** The feed that is used: `holeFeed`, kept in 0 to 1 whatever it returns. */
export function feedOf(f: Pick<FolderNodeInfo, 'placeholder' | 'totalNotes'> | undefined): number {
  return clamp01(holeFeed(f))
}

/**
 * The axes of the plane the galaxies orbit in, from that plane's quaternion (x y z w): the in-plane axes `u` and `v` and the normal
 * `n` of the disc, as unit vectors in the world. `out` takes u, n, v (nine numbers). A quaternion that is not a number leaves the flat
 * plane (the sky's own x and z, y up).
 */
export function planeAxes(qx: number, qy: number, qz: number, qw: number, out: Float32Array | number[]): void {
  let x = qx
  let y = qy
  let z = qz
  let w = qw
  const len = Math.hypot(x, y, z, w)
  if (!(len > 1e-6) || !Number.isFinite(len)) {
    x = 0
    y = 0
    z = 0
    w = 1
  } else {
    x /= len
    y /= len
    z /= len
    w /= len
  }
  // The columns of the rotation matrix of the quaternion: where x, y and z go.
  out[0] = 1 - 2 * (y * y + z * z)
  out[1] = 2 * (x * y + z * w)
  out[2] = 2 * (x * z - y * w)
  out[3] = 2 * (x * y - z * w)
  out[4] = 1 - 2 * (x * x + z * z)
  out[5] = 2 * (y * z + x * w)
  out[6] = 2 * (x * z + y * w)
  out[7] = 2 * (y * z - x * w)
  out[8] = 1 - 2 * (x * x + y * y)
}

/** The wide-open sky of the shader, in Rs: the quad's half width, for the glow to fade out before the quad's edge. */
const QUAD_RS = BH_QUAD / BH_RS

export function createBlackHoleMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uSize: { value: 1 },
      uRs: { value: 1 },
      uTime: { value: 0 },
      uFeed: { value: 1 },
      uLift: { value: 0 },
      uU: { value: new Vector3(1, 0, 0) },
      uN: { value: new Vector3(0, 1, 0) },
      uV: { value: new Vector3(0, 0, 1) },
    },
    vertexShader: /* glsl */ `
      uniform float uSize;
      varying vec3 vView;
      varying vec3 vCenter;
      void main() {
        // A billboard: the quad is expanded in view space, so it always faces the camera.
        vec4 c = viewMatrix * modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec4 p = c + vec4(position.xy * uSize, 0.0, 0.0);
        vCenter = c.xyz;
        vView = p.xyz;
        gl_Position = projectionMatrix * p;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uRs;
      uniform float uTime;
      uniform float uFeed;
      uniform float uLift;
      uniform vec3 uU;
      uniform vec3 uN;
      uniform vec3 uV;
      varying vec3 vView;
      varying vec3 vCenter;

      const float RIN = ${BH_DISC_IN.toFixed(1)};
      const float ROUT = ${BH_DISC_OUT.toFixed(1)};
      const float RSTART = ${BH_START.toFixed(1)};
      const float PHOTON = ${BH_PHOTON.toFixed(2)};
      const float QS = ${QUAD_RS.toFixed(2)};

      // The gas of the disc: spiral streaks that turn faster closer in. Two copies, half a period apart, fade into each other so the
      // streaks never wind up tighter and tighter as the clock runs.
      float streak(float rr, float ang, float tt) {
        float phi = ang - tt * 1.5 / (rr * sqrt(rr));
        float a = sin(5.0 * phi + 7.0 * log(rr));
        float b = sin(11.0 * phi - 4.0 * log(rr) + 1.7);
        return 0.5 + 0.36 * a + 0.14 * b;
      }

      void main() {
        vec3 rd = normalize(vView);
        vec3 ro = -vCenter / uRs;
        mat3 R = mat3(viewMatrix);
        vec3 N = normalize(R * uN);
        vec3 U = normalize(R * uU);
        vec3 W = normalize(R * uV);

        // The straight ray's closest approach to the hole: its impact parameter, in Rs.
        float tb = -dot(ro, rd);
        float b = length(ro + rd * tb);

        vec3 col = vec3(0.0);
        float T = 1.0;
        bool dark = false;

        // A ray that never comes near the disc is left alone (the disc ends at ROUT, gravity moves a ray at 9.5 only a little).
        if (b < 9.5) {
          float cc = dot(ro, ro) - RSTART * RSTART;
          float t0 = 0.0;
          bool reaches = true;
          if (cc > 0.0) {
            float dsc = tb * tb - cc;
            if (dsc < 0.0) reaches = false; else t0 = tb - sqrt(dsc);
          }
          if (reaches) {
            vec3 pos = ro + rd * t0;
            vec3 vel = rd;
            vec3 hv = cross(pos, vel);
            float h2 = dot(hv, hv);
            bool done = false;
            for (int i = 0; i < ${BH_STEPS}; i++) {
              float r = length(pos);
              if (r < 1.0) { dark = true; done = true; break; }
              float dt = clamp(0.1 * r, 0.05, 0.8);
              vec3 acc = -1.5 * h2 * pos / (r * r * r * r * r);
              vel = normalize(vel + acc * dt);
              vec3 np = pos + vel * dt;
              float s0 = dot(pos, N);
              float s1 = dot(np, N);
              if (s0 * s1 < 0.0) {
                // The ray crossed the plane of the disc.
                vec3 hp = mix(pos, np, s0 / (s0 - s1));
                float rr = length(hp);
                if (rr > RIN && rr < ROUT) {
                  float x = (rr - RIN) / (ROUT - RIN);
                  float ang = atan(dot(hp, W), dot(hp, U));
                  float ph = fract(uTime / 24.0);
                  float w1 = 0.5 + 0.5 * cos(6.2831853 * ph);
                  float sk = w1 * streak(rr, ang, ph * 24.0) + (1.0 - w1) * streak(rr, ang, fract(ph + 0.5) * 24.0);
                  // The side of the disc that turns towards you shines brighter.
                  vec3 vdir = normalize(cross(N, hp));
                  float beta = 0.55 * sqrt(RIN / rr);
                  float beam = pow(clamp(1.0 + 0.8 * beta * dot(vdir, -vel), 0.4, 1.5), 1.5);
                  float edge = smoothstep(0.0, 0.07, x) * (1.0 - smoothstep(0.4, 0.95, x));
                  float heat = 0.12 + 1.5 * pow(RIN / rr, 2.0);
                  vec3 em = mix(vec3(0.82, 0.93, 1.0), vec3(0.10, 0.34, 1.0), smoothstep(0.0, 0.85, x)) * heat * sk * beam * uFeed;
                  float a = 0.92 * edge * clamp(1.6 * uFeed, 0.0, 1.0);
                  col += T * a * em;
                  T *= 1.0 - a;
                }
              }
              pos = np;
              if (dot(pos, vel) > 0.0 && dot(pos, pos) > RSTART * RSTART) { done = true; break; }
            }
            // A ray still circling the hole after all its steps is lost in it.
            if (!done) dark = true;
          }
        }

        // The photon ring (light that has gone round the hole) and a soft glow, added over everything, both stronger when it is hovered or selected.
        float lift = 1.0 + 0.5 * uLift;
        float ring = exp(-pow((b - PHOTON) / 0.05, 2.0));
        col += vec3(0.78, 0.9, 1.0) * ring * (0.2 + 0.8 * uFeed) * lift;
        float aura = exp(-max(b - PHOTON, 0.0) / 2.4) * (1.0 - smoothstep(QS * 0.5, QS, b)) * smoothstep(PHOTON - 0.15, PHOTON + 0.05, b);
        col += vec3(0.22, 0.5, 1.0) * aura * (0.05 + 0.3 * uFeed) * lift;

        gl_FragColor = vec4(col, dark ? 1.0 : 1.0 - T);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // Premultiplied: the shadow (alpha 1, black) hides what is behind the hole, the disc covers it a little, the ring and the glow only add.
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
    side: DoubleSide,
  })
}

export interface BlackHole {
  mesh: Mesh
  material: ShaderMaterial
  /** The node it is drawn over. */
  node: number
  /** Axes of the disc's plane: u, n, v as unit vectors in the world (nine numbers). */
  axes: Float32Array
  dispose(): void
}

/** The black hole over node `node` (the Bio). Hidden until it is placed. */
export function buildBlackHole(node: number): BlackHole {
  const geometry = new PlaneGeometry(2, 2)
  const material = createBlackHoleMaterial()
  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  // Last of all that is blended: the shadow covers the halos and the plumes behind the hole, and the depth test keeps what is in front of it.
  mesh.renderOrder = 10
  mesh.visible = false
  const axes = new Float32Array(9)
  planeAxes(0, 0, 0, 1, axes)
  return {
    mesh,
    material,
    node,
    axes,
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

/**
 * Lay the disc in the plane the galaxies orbit in: the plane of the first ring the layout draws around the black hole. Without a ring
 * (the layout has not answered, or it is not the system layout) the disc keeps the plane it has. Returns whether a ring was found.
 */
export function fitBlackHole(h: BlackHole, ringParent: ArrayLike<number>, ringQuat: ArrayLike<number>, ringCount: number): boolean {
  for (let k = 0; k < ringCount; k++) {
    if (ringParent[k] !== h.node) continue
    const x = ringQuat[k * 4]!
    const y = ringQuat[k * 4 + 1]!
    const z = ringQuat[k * 4 + 2]!
    const w = ringQuat[k * 4 + 3]!
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(w))) continue
    planeAxes(x, y, z, w, h.axes)
    const u = h.material.uniforms['uU']!.value as Vector3
    const n = h.material.uniforms['uN']!.value as Vector3
    const v = h.material.uniforms['uV']!.value as Vector3
    u.set(h.axes[0]!, h.axes[1]!, h.axes[2]!)
    n.set(h.axes[3]!, h.axes[4]!, h.axes[5]!)
    v.set(h.axes[6]!, h.axes[7]!, h.axes[8]!)
    return true
  }
  return false
}

/**
 * Put the black hole at its node's live place with its drawn radius. `feed` is 0 to 1 (`feedOf`), `time` the orbit clock in seconds (the
 * disc turns with the orbits and stops with them), `lift` 0 to 1 how much it is hovered or selected. A hole with no size is hidden.
 */
export function placeBlackHole(h: BlackHole, x: number, y: number, z: number, radius: number, feed: number, time: number, lift: number): void {
  const r = Number.isFinite(radius) ? radius : 0
  h.mesh.visible = r > 0.01
  h.mesh.position.set(Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, Number.isFinite(z) ? z : 0)
  const u = h.material.uniforms
  u['uSize']!.value = BH_QUAD * r
  u['uRs']!.value = Math.max(1e-3, BH_RS * r)
  u['uFeed']!.value = clamp01(feed)
  u['uTime']!.value = Number.isFinite(time) ? time : 0
  u['uLift']!.value = clamp01(lift)
}
