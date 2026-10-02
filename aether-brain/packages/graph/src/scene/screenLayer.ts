import {
  BufferGeometry,
  Color,
  DataTexture,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  PlaneGeometry,
  RGBAFormat,
  Raycaster,
  SRGBColorSpace,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  type PerspectiveCamera,
} from 'three'
import type { GraphData } from '@aether/core'
import type { BrainController } from '../BrainController'
import { easeGrow, stepGrow } from '../gallery'
import { SCREEN_DEFAULT_ASPECT, SCREEN_DWELL_MS, screenFade, screenPlacement } from '../screen'
import { STAR_COLOR } from '../theme'

/** Width of the gold frame around the screen, as a fraction of the screen's width. */
const FRAME = 0.018
const CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]
/** Size of the placeholder card drawn before the first frame (px). */
const PLACEHOLDER_W = 800
const PLACEHOLDER_H = 500

/**
 * The star screen (see `StarScreen`): one quad showing the latest frame of
 * the app, a glowing gold frame around it, and a faint beam down to its star.
 * It faces the camera, sits above the star along the camera's up direction,
 * grows out of the star while the camera stays close and folds back when it
 * leaves (`screen.ts` places it). Frames are uploaded only when a new one
 * came in (`controller.screenFrameVersion`).
 */
export class ScreenLayer {
  readonly group = new Group()
  private readonly screen: Mesh
  private readonly frame: Mesh
  private readonly beam: Line
  private readonly screenMat: ShaderMaterial
  private readonly frameMat: ShaderMaterial
  private readonly beamMat = new LineBasicMaterial({ color: STAR_COLOR, transparent: true, opacity: 0.45, depthWrite: false })
  private texture: DataTexture | null = null
  private texVersion = -1
  /** What the placeholder card was last drawn for. */
  private placeholderFor: string | null = null
  private aspect = SCREEN_DEFAULT_ASPECT
  private grow = 0
  private readonly up = new Vector3()
  private readonly right = new Vector3()
  private readonly corner = new Vector3()
  private readonly camPos = new Vector3()
  /** What the screen hides this frame, in normalized device coordinates (x0 > x1: nothing). */
  private readonly cover = { x0: 1, y0: 1, x1: -1, y1: -1, z: 1 }
  private readonly ray = new Raycaster()
  private readonly ndc = new Vector2()

  constructor() {
    this.screenMat = new ShaderMaterial({
      uniforms: { uMap: { value: null }, uBgra: { value: 1 }, uFade: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uBgra;
        uniform float uFade;
        varying vec2 vUv;
        float bayer4(vec2 p) {
          vec2 q = mod(floor(p), 4.0);
          vec2 f = mod(q, 2.0);
          vec2 c = floor(q / 2.0);
          float fine = 2.0 * f.x + 3.0 * f.y - 4.0 * f.x * f.y;
          float coarse = 2.0 * c.x + 3.0 * c.y - 4.0 * c.x * c.y;
          return (fine * 4.0 + coarse + 0.5) / 16.0;
        }
        void main() {
          // Fades by dropping pixels (the kept ones write depth as solid ones), like a gallery card.
          if (uFade < bayer4(gl_FragCoord.xy)) discard;
          // Frames come top row first.
          vec4 c = texture2D(uMap, vec2(vUv.x, 1.0 - vUv.y));
          vec3 rgb = uBgra > 0.5 ? c.bgr : c.rgb;
          // Just under 1: an app's white never blooms.
          gl_FragColor = vec4(rgb * 0.94, 1.0);
        }
      `,
    })
    this.frameMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: new Color(STAR_COLOR) }, uInner: { value: new Vector2(0.95, 0.94) }, uFade: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform vec2 uInner;
        uniform float uFade;
        varying vec2 vUv;
        void main() {
          // Distance outside the screen's own rectangle (0 inside it), in units of the frame.
          vec2 p = abs(vUv - 0.5) * 2.0;
          vec2 d = max(p - uInner, 0.0) / max(1.0 - uInner, vec2(1e-4));
          float t = max(d.x, d.y);
          if (t <= 0.0) discard;
          float glow = 1.0 - smoothstep(0.0, 1.0, t);
          // Bright enough near the screen to bloom like its star.
          gl_FragColor = vec4(uColor * (0.6 + 1.1 * glow), glow * uFade);
        }
      `,
    })
    this.screen = new Mesh(new PlaneGeometry(1, 1), this.screenMat)
    this.frame = new Mesh(new PlaneGeometry(1, 1), this.frameMat)
    this.frame.renderOrder = 1
    const beamGeo = new BufferGeometry()
    beamGeo.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3))
    this.beam = new Line(beamGeo, this.beamMat)
    this.group.add(this.frame, this.screen, this.beam)
    this.group.visible = false
    this.screen.frustumCulled = false
    this.frame.frustumCulled = false
    this.beam.frustumCulled = false
  }

  /** True while the screen is drawn (grown at least a little). */
  get visible(): boolean {
    return this.group.visible
  }

  /**
   * One frame: open or fold the screen (the camera stayed close to its star
   * for SCREEN_DWELL_MS, system layout only), upload a new picture, place it.
   */
  update(
    c: BrainController,
    g: GraphData,
    pos: ArrayLike<number>,
    extents: ArrayLike<number>,
    camera: PerspectiveCamera,
    now: number,
    dt: number,
  ): void {
    const s = c.screen
    const i = s && c.layoutMode === 'system' && c.graph === g ? (g.index.get(s.star) ?? -1) : -1
    const near = i >= 0 && c.nearId === s!.star && c.nearFor(now) >= SCREEN_DWELL_MS
    c.screenShown(near)
    this.grow = i >= 0 ? stepGrow(this.grow, !near, dt * 1000) : 0
    this.cover.x0 = 1
    this.cover.x1 = -1
    if (i < 0 || this.grow <= 0.001 || i * 3 + 2 >= pos.length) {
      this.group.visible = false
      return
    }
    this.group.visible = true
    this.syncTexture(c)

    // Above the star along the camera's up direction, facing the camera.
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion)
    const sx = pos[i * 3] ?? 0
    const sy = pos[i * 3 + 1] ?? 0
    const sz = pos[i * 3 + 2] ?? 0
    const place = screenPlacement(sx, sy, sz, extents[i] ?? 0, this.aspect, this.up.x, this.up.y, this.up.z, easeGrow(this.grow))
    this.screen.position.set(place.x, place.y, place.z)
    this.screen.quaternion.copy(camera.quaternion)
    this.screen.scale.set(Math.max(place.width, 1e-3), Math.max(place.height, 1e-3), 1)
    const border = place.width * FRAME
    const fw = place.width + border * 2
    const fh = place.height + border * 2
    this.frame.position.copy(this.screen.position)
    this.frame.quaternion.copy(camera.quaternion)
    this.frame.scale.set(Math.max(fw, 1e-3), Math.max(fh, 1e-3), 1)
    ;(this.frameMat.uniforms['uInner']!.value as Vector2).set(place.width / fw, place.height / fh)
    // The beam: from the star to the screen's lower edge.
    const beam = this.beam.geometry.getAttribute('position') as Float32BufferAttribute
    const bottom = place.height / 2
    beam.setXYZ(0, sx, sy, sz)
    beam.setXYZ(1, place.x - this.up.x * bottom, place.y - this.up.y * bottom, place.z - this.up.z * bottom)
    beam.needsUpdate = true

    camera.getWorldPosition(this.camPos)
    const fade = screenFade(this.camPos.distanceTo(this.screen.position), place.width)
    this.screenMat.uniforms['uFade']!.value = fade
    this.frameMat.uniforms['uFade']!.value = fade
    this.beamMat.opacity = 0.45 * fade
    this.group.visible = fade > 0.01
    if (fade >= 0.5) this.measureCover(camera, fw, fh)
  }

  /**
   * True when a point drawn at (x, y) px of a `w` × `h` view, at NDC depth
   * `z`, is behind the screen as drawn (its label would float on the app).
   */
  covers(x: number, y: number, z: number, w: number, h: number): boolean {
    const c = this.cover
    if (c.x0 > c.x1 || w <= 0 || h <= 0) return false
    const nx = (x / w) * 2 - 1
    const ny = 1 - (y / h) * 2
    return nx >= c.x0 && nx <= c.x1 && ny >= c.y0 && ny <= c.y1 && z > c.z
  }

  /** The screen faces the camera, so it covers an upright rectangle of the view, at one depth. */
  private measureCover(camera: PerspectiveCamera, fw: number, fh: number): void {
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion)
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [a, b] of CORNERS) {
      const p = this.corner
        .copy(this.screen.position)
        .addScaledVector(this.right, (a * fw) / 2)
        .addScaledVector(this.up, (b * fh) / 2)
        .project(camera)
      // A corner behind the camera: too close to say; hide nothing.
      if (p.z < -1 || p.z > 1) return
      x0 = Math.min(x0, p.x)
      x1 = Math.max(x1, p.x)
      y0 = Math.min(y0, p.y)
      y1 = Math.max(y1, p.y)
    }
    const c = this.cover
    c.x0 = x0
    c.y0 = y0
    c.x1 = x1
    c.y1 = y1
    c.z = this.corner.copy(this.screen.position).project(camera).z
  }

  /** True when the pointer at (x, y) px of a `w` × `h` view is on the screen as drawn. */
  hit(x: number, y: number, w: number, h: number, camera: PerspectiveCamera): boolean {
    if (!this.group.visible || this.grow < 0.5 || w <= 0 || h <= 0) return false
    this.ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1)
    this.ray.setFromCamera(this.ndc, camera)
    return this.ray.intersectObject(this.screen, false).length > 0
  }

  dispose(): void {
    this.texture?.dispose()
    this.screen.geometry.dispose()
    this.frame.geometry.dispose()
    this.beam.geometry.dispose()
    this.screenMat.dispose()
    this.frameMat.dispose()
    this.beamMat.dispose()
  }

  /** The latest frame on the GPU (a placeholder card until the first one). */
  private syncTexture(c: BrainController): void {
    const f = c.screenFrame
    if (f && c.screenFrameVersion !== this.texVersion && f.width > 0 && f.height > 0 && f.data.length >= f.width * f.height * 4) {
      this.texVersion = c.screenFrameVersion
      this.upload(f.data, f.width, f.height, f.bgra)
      this.placeholderFor = null
      return
    }
    if (f) return
    const text = c.screen?.placeholder ?? ''
    if (this.texture && this.placeholderFor === text) return
    const card = placeholderCard(text)
    if (!card) return
    this.texVersion = c.screenFrameVersion
    this.placeholderFor = text
    this.upload(card, PLACEHOLDER_W, PLACEHOLDER_H, false)
  }

  private upload(data: Uint8Array, width: number, height: number, bgra: boolean): void {
    let t = this.texture
    if (!t || t.image.width !== width || t.image.height !== height) {
      t?.dispose()
      t = new DataTexture(new Uint8Array(data.buffer, data.byteOffset, width * height * 4), width, height, RGBAFormat, UnsignedByteType)
      t.colorSpace = SRGBColorSpace
      t.generateMipmaps = true
      t.minFilter = LinearMipmapLinearFilter
      t.magFilter = LinearFilter
      t.anisotropy = 4
      this.texture = t
      this.screenMat.uniforms['uMap']!.value = t
    } else {
      t.image.data = new Uint8Array(data.buffer, data.byteOffset, width * height * 4)
    }
    t.needsUpdate = true
    this.screenMat.uniforms['uBgra']!.value = bgra ? 1 : 0
    this.aspect = height / width
  }
}

/** RGBA pixels of a dark card with `text` (lines split on \n) in the middle, or null without a 2D canvas (tests). */
function placeholderCard(text: string): Uint8Array | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  const canvas = new OffscreenCanvas(PLACEHOLDER_W, PLACEHOLDER_H)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const bg = ctx.createLinearGradient(0, 0, 0, PLACEHOLDER_H)
  bg.addColorStop(0, '#0b0e22')
  bg.addColorStop(1, '#05060f')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, PLACEHOLDER_W, PLACEHOLDER_H)
  ctx.fillStyle = STAR_COLOR
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = '600 44px system-ui, sans-serif'
  ctx.fillText('★', PLACEHOLDER_W / 2, PLACEHOLDER_H / 2 - 70)
  ctx.fillStyle = '#d9defa'
  ctx.font = '500 28px system-ui, sans-serif'
  const lines = text.split('\n').slice(0, 3)
  lines.forEach((l, k) => ctx.fillText(l, PLACEHOLDER_W / 2, PLACEHOLDER_H / 2 + k * 40 - ((lines.length - 1) * 40) / 2 + 10, PLACEHOLDER_W - 80))
  return new Uint8Array(ctx.getImageData(0, 0, PLACEHOLDER_W, PLACEHOLDER_H).data.buffer)
}
