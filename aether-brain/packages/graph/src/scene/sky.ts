/**
 * The sky behind the brain: a Milky Way, nebulae and distant galaxies painted once into a cube map (`bakeSky`), shown
 * by a dome that always sits at the far plane (`createSkyDome`), with the stars as real points over it
 * (`createSkyStars`). Baking costs a few milliseconds once; after that the whole backdrop is one cube-map lookup a pixel, so
 * a laptop GPU pays almost nothing for it. The bake needs a float-capable render target; when the GPU has none the
 * caller keeps the old plain nebula haze (`bakeSky` returns null).
 */
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CubeCamera,
  DoubleSide,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  Mesh,
  Points,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  WebGLCubeRenderTarget,
  type CubeTexture,
  type WebGLRenderer,
} from 'three'
import { DISTANT_GALAXIES, GALACTIC_CENTER, GALACTIC_NORMAL, NEBULAE, makeSkyStars } from './skyData'
import { SKY_BAKE_FRAGMENT, SKY_BAKE_VERTEX, SKY_DOME_FRAGMENT, SKY_DOME_VERTEX } from './skyShader'

/** Pixels along an edge of each of the six cube faces: 1024 is 50 MB as half floats and keeps nebulae smooth at the app's field of view. */
export const SKY_FACE = 1024
/** How many real stars are drawn: the faint crowd along the band is most of them. */
export const SKY_STAR_COUNT = 16000

export interface BakedSky {
  texture: CubeTexture
  dispose(): void
}

function bakeUniforms() {
  return {
    uN: { value: new Vector3(...GALACTIC_NORMAL) },
    uC: { value: new Vector3(...GALACTIC_CENTER) },
    uNebDir: { value: NEBULAE.map((n) => new Vector3(...n.dir)) },
    uNebCol: { value: NEBULAE.map((n) => new Vector3(...n.color)) },
    uNebRad: { value: NEBULAE.map((n) => n.radius) },
    uGalDir: { value: DISTANT_GALAXIES.map((g) => new Vector3(...g.dir)) },
    uGalShape: { value: DISTANT_GALAXIES.map((g) => new Vector3(g.size, g.tilt, g.angle)) },
    uGalCol: { value: DISTANT_GALAXIES.map((g) => new Vector3(...g.color)) },
    uGain: { value: 1 },
  }
}

/** Paint the sky into a cube map, once. Null when the GPU cannot render to a float cube target (the caller falls back). */
export function bakeSky(gl: WebGLRenderer, size = SKY_FACE): BakedSky | null {
  let target: WebGLCubeRenderTarget | null = null
  let material: ShaderMaterial | null = null
  let box: BoxGeometry | null = null
  try {
    const canFloat = gl.extensions.has('EXT_color_buffer_half_float') || gl.extensions.has('EXT_color_buffer_float')
    target = new WebGLCubeRenderTarget(size, {
      type: canFloat ? HalfFloatType : UnsignedByteType,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    })
    material = new ShaderMaterial({
      uniforms: bakeUniforms(),
      vertexShader: SKY_BAKE_VERTEX,
      fragmentShader: SKY_BAKE_FRAGMENT,
      side: BackSide,
      depthTest: false,
      depthWrite: false,
    })
    box = new BoxGeometry(2, 2, 2)
    const scene = new Scene()
    scene.add(new Mesh(box, material))
    const camera = new CubeCamera(0.1, 10, target)
    camera.update(gl, scene)
    const done = target
    return {
      texture: done.texture,
      dispose: () => done.dispose(),
    }
  } catch {
    target?.dispose()
    return null
  } finally {
    material?.dispose()
    box?.dispose()
  }
}

/**
 * The dome: a box drawn at depth 1 (`.xyww` in the vertex shader) that turns with the view and never moves with it, so
 * it is behind everything however far the camera flies or however far away the far plane is.
 */
export function createSkyDome(texture: CubeTexture): Mesh {
  const mesh = new Mesh(
    new BoxGeometry(2, 2, 2),
    new ShaderMaterial({
      uniforms: { uSky: { value: texture }, uGain: { value: 1 } },
      vertexShader: SKY_DOME_VERTEX,
      fragmentShader: SKY_DOME_FRAGMENT,
      side: DoubleSide,
      depthWrite: false,
      depthTest: true,
    }),
  )
  mesh.frustumCulled = false
  mesh.renderOrder = -100
  return mesh
}

/** The stars: sharp points over the baked sky, crowded along the Milky Way's band, a few of them bright with a cross of light. */
export function createSkyStars(count = SKY_STAR_COUNT): Points {
  const s = makeSkyStars(count)
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(s.position, 3))
  g.setAttribute('aSize', new Float32BufferAttribute(s.size, 1))
  g.setAttribute('aPhase', new Float32BufferAttribute(s.phase, 1))
  g.setAttribute('aTemp', new Float32BufferAttribute(s.temp, 1))
  g.setAttribute('aBright', new Float32BufferAttribute(s.bright, 1))
  const p = new Points(g, createSkyStarMaterial())
  p.frustumCulled = false
  return p
}

/** Star points: a soft disc in the star's colour (blue-white to orange), a slow twinkle, and a cross of light on the big ones. Additive, and always under the bloom threshold. */
export function createSkyStarMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aPhase;
      attribute float aTemp;
      attribute float aBright;
      uniform float uScale;
      varying float vPhase;
      varying float vTemp;
      varying float vBright;
      varying float vSize;
      void main() {
        vPhase = aPhase;
        vTemp = aTemp;
        vBright = aBright;
        vSize = aSize;
        gl_PointSize = aSize * uScale;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying float vPhase;
      varying float vTemp;
      varying float vBright;
      varying float vSize;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p) * 2.0;
        float disc = pow(smoothstep(1.0, 0.0, d), 1.7);
        // A cross of light, on the bigger stars only.
        float cross = 0.0;
        if (vSize > 4.0) {
          float a = exp(-abs(p.x) * 46.0) * smoothstep(1.0, 0.1, abs(p.y) * 2.0);
          float b = exp(-abs(p.y) * 46.0) * smoothstep(1.0, 0.1, abs(p.x) * 2.0);
          cross = max(a, b) * clamp((vSize - 4.0) / 3.0, 0.0, 1.0) * 0.55;
        }
        float tw = 0.78 + 0.22 * sin(uTime * (0.5 + vPhase * 0.08) + vPhase);
        vec3 hot = vec3(0.64, 0.76, 1.0);
        vec3 mid = vec3(1.0, 0.97, 0.92);
        vec3 cool = vec3(1.0, 0.72, 0.46);
        vec3 col = mix(hot, mix(mid, cool, smoothstep(0.55, 1.0, vTemp)), smoothstep(0.1, 0.55, vTemp));
        float a = (disc + cross) * vBright * tw;
        gl_FragColor = vec4(col * a * 0.95, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  })
}
