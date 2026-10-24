/**
 * Draws a model proxy (proxy.ts) as a square of RGBA pixels from any side: a small software rasteriser, pure typed-array arithmetic
 * (no canvas, no GPU, no DOM), so a window that cannot trust a model file still shows a model you can turn, and a test can read every
 * pixel. It looks like the stills the thumbnail helper draws (`rasterGlb` in thumb-preload.cts): the same light, the same exposure rule,
 * the same dark ground, orthographic, two-sided; a test pins the two together.
 *
 * Two differences, both on purpose. The scale comes from the proxy's bounding sphere and not from the bounds as seen, so a model keeps
 * its size and its place while it is turned (a long ship end-on would otherwise swell and swim). And colours are the proxy's own
 * per-vertex colours, interpolated, with smooth normals.
 */
import type { ModelProxy } from './proxy'

/** A view of a model: the camera's turn about it, in degrees. Yaw 0 looks at the model's front (+Z); positive yaw moves the camera toward +X. */
export interface ModelView {
  yaw: number
  /** Positive: the camera is above the model, looking down. */
  pitch: number
}

/** The view the thumbnails are drawn from: a third of a quarter turn off the front and a little above. */
export const MODEL_VIEW_DEFAULT: Readonly<ModelView> = Object.freeze({ yaw: 35, pitch: 24 })
/** The camera never goes straight over or under a model: up stays up. */
export const MODEL_PITCH_MAX = 89

/**
 * A view in range and as a board's file keeps it (one decimal): yaw in [0, 360), pitch within ±MODEL_PITCH_MAX; a number that is not one
 * is the default's. The view in memory is the view in the file, so a save and a read never move a model.
 */
export function normaliseView(v: { yaw?: unknown; pitch?: unknown }): ModelView {
  const yaw = typeof v.yaw === 'number' && Number.isFinite(v.yaw) ? v.yaw : MODEL_VIEW_DEFAULT.yaw
  const pitch = typeof v.pitch === 'number' && Number.isFinite(v.pitch) ? v.pitch : MODEL_VIEW_DEFAULT.pitch
  const tenth = (n: number): number => Math.round(n * 10) / 10 + 0
  const wrapped = tenth(((yaw % 360) + 360) % 360)
  return { yaw: wrapped >= 360 ? 0 : wrapped, pitch: tenth(Math.max(-MODEL_PITCH_MAX, Math.min(MODEL_PITCH_MAX, pitch))) }
}

/** Whether `v` is the view a model is drawn from when nobody has turned it. */
export function isDefaultView(v: ModelView): boolean {
  return Math.abs(v.yaw - MODEL_VIEW_DEFAULT.yaw) < 0.05 && Math.abs(v.pitch - MODEL_VIEW_DEFAULT.pitch) < 0.05
}

/** The rows of the world → view rotation for a view: x right, y up, z away from the camera. */
export function viewBasis(view: ModelView): { r: [number, number, number]; u: [number, number, number]; f: [number, number, number] } {
  const az = (view.yaw * Math.PI) / 180
  const el = (view.pitch * Math.PI) / 180
  const f: [number, number, number] = [-Math.sin(az) * Math.cos(el), -Math.sin(el), -Math.cos(az) * Math.cos(el)]
  const rx = -f[2]
  const rz = f[0]
  const rl = Math.hypot(rx, rz) || 1
  const r: [number, number, number] = [rx / rl, 0, rz / rl]
  const u: [number, number, number] = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
  return { r, u, f }
}

/** The key light's direction (toward it, in view space): from the upper left, in front. The helper's `LIGHT`. */
const LIGHT = (() => {
  const x = -0.45, y = 0.65, z = -0.62
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l] as const
})()

/** How bright a lit part of a model is drawn, as a multiple of its colour (the helper's `modelBrightness`: diffuse 0..1, facing 0..1). */
export function modelBrightness(diffuse: number, facing: number): number {
  const rim = (1 - facing) * (1 - facing)
  return 0.3 + 0.78 * diffuse + 0.22 * rim
}

/** A dark model is brought up to this mean brightness (0..1), never by more than `MODEL_MAX_GAIN` times (the helper's rule). */
export const MODEL_EXPOSURE = 0.42
export const MODEL_MAX_GAIN = 3

export interface ProxyRenderOptions extends ModelView {
  /** The square's side in pixels (8 to 1024). */
  side: number
  /** Samples a pixel in each direction (2: smoother, four times the work). Default 2 up to 512 px, else 1. */
  supersample?: 1 | 2
  /** The brightness gain to use (what an earlier render of this model returned): the same gain for every view keeps a turning model from flickering. */
  gain?: number
}

export interface ProxyRender {
  /** Side × side RGBA, opaque, over a dark gradient. */
  pixels: Uint8ClampedArray
  /** The exposure gain applied (1 to MODEL_MAX_GAIN). */
  gain: number
  /** Pixels (before averaging down) the model covers. */
  covered: number
}

/** Scratch space kept between renders, which come one after another while a model is turned. */
let scratch = new Float32Array(0)
let scratchNormals = new Float32Array(0)

/**
 * The proxy drawn from `opts.yaw`, `opts.pitch` as a square of `opts.side`. Null when nothing of it lands on the picture (every
 * triangle edge-on). Deterministic: the same proxy and options give the same pixels.
 */
export function renderProxy(p: ModelProxy, opts: ProxyRenderOptions): ProxyRender | null {
  const side = Math.round(opts.side)
  if (!(side >= 8 && side <= 1024)) return null
  const ss = opts.supersample ?? (side <= 512 ? 2 : 1)
  const n = side * ss
  const view = normaliseView(opts)
  const { r, u, f } = viewBasis(view)

  const count = p.vertices * 3
  if (scratch.length < count) {
    scratch = new Float32Array(count)
    scratchNormals = new Float32Array(count)
  }
  const pos = p.positions
  const nrm = p.normals
  for (let i = 0; i < count; i += 3) {
    const x = pos[i]!, y = pos[i + 1]!, z = pos[i + 2]!
    scratch[i] = r[0] * x + r[1] * y + r[2] * z
    scratch[i + 1] = u[0] * x + u[1] * y + u[2] * z
    scratch[i + 2] = f[0] * x + f[1] * y + f[2] * z
    const nx = nrm[i]!, ny = nrm[i + 1]!, nz = nrm[i + 2]!
    scratchNormals[i] = r[0] * nx + r[1] * ny + r[2] * nz
    scratchNormals[i + 1] = u[0] * nx + u[1] * ny + u[2] * nz
    scratchNormals[i + 2] = f[0] * nx + f[1] * ny + f[2] * nz
  }

  // The model keeps its size and its place however it is turned: the scale is the bounding sphere's.
  const scale = (0.86 * n) / (2 * Math.max(p.radius, 1e-6))
  const half = n / 2
  const depth = new Float32Array(n * n).fill(Infinity)
  const px = new Uint8ClampedArray(n * n * 3)
  const cover = new Uint8Array(n * n)
  const col = p.colors
  const idx = p.indices
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, d = idx[t + 2]! * 3
    const x0 = half + scratch[a]! * scale, y0 = half - scratch[a + 1]! * scale
    const x1 = half + scratch[b]! * scale, y1 = half - scratch[b + 1]! * scale
    const x2 = half + scratch[d]! * scale, y2 = half - scratch[d + 1]! * scale
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if (!Number.isFinite(area) || Math.abs(area) < 1e-9) continue
    const xmin = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
    const xmax = Math.min(n - 1, Math.ceil(Math.max(x0, x1, x2)))
    const ymin = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
    const ymax = Math.min(n - 1, Math.ceil(Math.max(y0, y1, y2)))
    if (xmin > xmax || ymin > ymax) continue
    const az = scratch[a + 2]!, bz = scratch[b + 2]!, dz = scratch[d + 2]!
    const ca = idx[t]! * 3, cb = idx[t + 1]! * 3, cd = idx[t + 2]! * 3
    const inv = 1 / area
    for (let y = ymin; y <= ymax; y++) {
      const py = y + 0.5
      for (let x = xmin; x <= xmax; x++) {
        const qx = x + 0.5
        const w0 = ((x1 - qx) * (y2 - py) - (x2 - qx) * (y1 - py)) * inv
        const w1 = ((x2 - qx) * (y0 - py) - (x0 - qx) * (y2 - py)) * inv
        const w2 = 1 - w0 - w1
        // A hair of slack so neighbouring triangles leave no cracks (the depth test settles the overlap).
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue
        const z = w0 * az + w1 * bz + w2 * dz
        const at = y * n + x
        if (z >= depth[at]!) continue
        depth[at] = z
        let nx = w0 * scratchNormals[a]! + w1 * scratchNormals[b]! + w2 * scratchNormals[d]!
        let ny = w0 * scratchNormals[a + 1]! + w1 * scratchNormals[b + 1]! + w2 * scratchNormals[d + 1]!
        let nz = w0 * scratchNormals[a + 2]! + w1 * scratchNormals[b + 2]! + w2 * scratchNormals[d + 2]!
        const l = Math.hypot(nx, ny, nz) || 1
        nx /= l
        ny /= l
        nz /= l
        // Two-sided: a surface seen from behind is lit as if it faced us.
        if (nz > 0) {
          nx = -nx
          ny = -ny
          nz = -nz
        }
        const k = modelBrightness(Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]), -nz)
        const o = at * 3
        px[o] = (w0 * col[ca]! + w1 * col[cb]! + w2 * col[cd]!) * k
        px[o + 1] = (w0 * col[ca + 1]! + w1 * col[cb + 1]! + w2 * col[cd + 1]!) * k
        px[o + 2] = (w0 * col[ca + 2]! + w1 * col[cb + 2]! + w2 * col[cd + 2]!) * k
        cover[at] = 1
      }
    }
  }

  // Exposure: the gain that brings a dark model's mean up to MODEL_EXPOSURE (or the one an earlier view of it used).
  let lit = 0
  let seen = 0
  for (let i = 0; i < cover.length; i++) {
    if (!cover[i]) continue
    lit += 0.299 * px[i * 3]! + 0.587 * px[i * 3 + 1]! + 0.114 * px[i * 3 + 2]!
    seen++
  }
  if (!seen) return null
  const mean = lit / seen
  const gain = opts.gain !== undefined && Number.isFinite(opts.gain) ? Math.max(1, Math.min(MODEL_MAX_GAIN, opts.gain)) : mean > 0 ? Math.min(MODEL_MAX_GAIN, Math.max(1, (MODEL_EXPOSURE * 255) / mean)) : 1

  // Average each ss × ss block down, over a dark gradient where nothing was drawn (the thumbnails' ground).
  const out = new Uint8ClampedArray(side * side * 4)
  const block = ss * ss
  for (let y = 0; y < side; y++) {
    const tt = y / Math.max(1, side - 1)
    const br = 20 - 12 * tt, bg = 26 - 15 * tt, bb = 46 - 26 * tt
    for (let x = 0; x < side; x++) {
      let rr = 0, gg = 0, bl = 0, covered = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const at = (y * ss + sy) * n + (x * ss + sx)
          if (!cover[at]) continue
          covered++
          rr += px[at * 3]! * gain
          gg += px[at * 3 + 1]! * gain
          bl += px[at * 3 + 2]! * gain
        }
      }
      const rest = block - covered
      const o = (y * side + x) * 4
      out[o] = (rr + br * rest) / block
      out[o + 1] = (gg + bg * rest) / block
      out[o + 2] = (bl + bb * rest) / block
      out[o + 3] = 255
    }
  }
  return { pixels: out, gain, covered: seen }
}
