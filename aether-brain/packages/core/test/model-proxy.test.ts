import { describe, expect, it } from 'vitest'
import {
  MODEL_EXPOSURE,
  MODEL_MAX_GAIN,
  MODEL_PITCH_MAX,
  MODEL_VIEW_DEFAULT,
  PROXY_HEADER_BYTES,
  PROXY_LIMITS,
  PROXY_MAX_BYTES,
  PROXY_TARGET_TRIANGLES,
  decodeProxy,
  encodeProxy,
  isDefaultView,
  modelBrightness,
  normaliseView,
  proxyBytes,
  proxyHeader,
  renderProxy,
  viewBasis,
  type ModelProxy,
  type ProxyParts,
} from '../src'

/**
 * The model proxy (up to 24,000 triangles and a colour for every vertex: the one thing a window that draws a model is given) and
 * the software rasteriser that draws it from any side. The helper that bakes one is tested against these in apps/desktop.
 */

/* ------------------------------------------------------------------ */
/* Small proxies                                                      */
/* ------------------------------------------------------------------ */

const Q = 32767

/** A cube of half-side `h` (quantised as the file keeps it), one colour, outward winding. */
function cubeParts(h = 1, color: [number, number, number] = [200, 100, 50]): ProxyParts {
  const s = Math.round(h * Q)
  const positions: number[] = []
  for (const z of [-s, s]) for (const y of [-s, s]) for (const x of [-s, s]) positions.push(x, y, z)
  // vertex i has x from bit 0, y from bit 1, z from bit 2
  const quads = [
    [0, 2, 3, 1], // z = -1 (back)
    [4, 5, 7, 6], // z = +1 (front)
    [0, 1, 5, 4], // y = -1 (bottom)
    [2, 6, 7, 3], // y = +1 (top)
    [0, 4, 6, 2], // x = -1 (left)
    [1, 3, 7, 5], // x = +1 (right)
  ]
  const indices: number[] = []
  for (const [a, b, c, d] of quads) indices.push(a!, b!, c!, a!, c!, d!)
  return { centre: [0, 0, 0], half: 1, positions, colors: Array.from({ length: 8 }, () => color).flat(), indices }
}

/** A sphere of radius 1: `lat` bands, `lon` slices, one colour. */
function sphereParts(lat = 20, lon = 28, color: [number, number, number] = [200, 60, 60]): ProxyParts {
  const positions: number[] = []
  for (let i = 0; i <= lat; i++) {
    const t = (i / lat) * Math.PI
    for (let j = 0; j < lon; j++) {
      const a = (j / lon) * Math.PI * 2
      positions.push(Math.round(Math.sin(t) * Math.cos(a) * Q), Math.round(Math.cos(t) * Q), Math.round(Math.sin(t) * Math.sin(a) * Q))
    }
  }
  const indices: number[] = []
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const a = i * lon + j
      const b = i * lon + ((j + 1) % lon)
      const c = (i + 1) * lon + j
      const d = (i + 1) * lon + ((j + 1) % lon)
      indices.push(a, c, b, b, c, d)
    }
  }
  const vertices = positions.length / 3
  return { centre: [0, 0, 0], half: 1, positions, colors: Array.from({ length: vertices }, () => color).flat(), indices }
}

/** A box `hx` by `hy` by `hz` (half-sides, 0 to 1), as a proxy whose longest half-side is 1. */
function boxParts(hx: number, hy: number, hz: number): ProxyParts {
  const cube = cubeParts(1)
  const positions = cube.positions as number[]
  const scaled = positions.map((v, i) => Math.round(v * [hx, hy, hz][i % 3]!))
  return { ...cube, positions: scaled }
}

const proxyOf = (parts: ProxyParts): ModelProxy => decodeProxy(encodeProxy(parts))!

/* ------------------------------------------------------------------ */
/* The format                                                         */
/* ------------------------------------------------------------------ */

describe('proxyBytes', () => {
  it('is a header, 6 + 3 bytes a vertex (one pad byte when there is an odd number of them) and 6 bytes a triangle', () => {
    expect(PROXY_HEADER_BYTES).toBe(32)
    expect(proxyBytes(4, 2)).toBe(32 + 24 + 12 + 0 + 12)
    expect(proxyBytes(3, 1)).toBe(32 + 18 + 9 + 1 + 6)
    expect(proxyBytes(1, 1)).toBe(32 + 6 + 3 + 1 + 6)
  })

  it('has a biggest size under a megabyte, and a target that fits far under the limits', () => {
    expect(PROXY_MAX_BYTES).toBe(proxyBytes(65_535, 40_000))
    expect(PROXY_MAX_BYTES).toBeLessThan(1024 * 1024)
    expect(PROXY_TARGET_TRIANGLES).toBeLessThan(PROXY_LIMITS.triangles)
    // At the target, even with as many vertices as triangles, a proxy is under 400 KB; with the half as many it really has, about 250 KB.
    expect(proxyBytes(PROXY_TARGET_TRIANGLES, PROXY_TARGET_TRIANGLES)).toBeLessThan(400 * 1024)
  })
})

describe('encodeProxy and decodeProxy', () => {
  it('give back what was put in: positions as the file keeps them over 32767, colours, indices, centre and half', () => {
    const p = decodeProxy(encodeProxy({ ...cubeParts(1), centre: [1.5, -2, 30], half: 4.25 }))!
    expect(p.vertices).toBe(8)
    expect(p.triangles).toBe(12)
    expect(p.centre).toEqual([1.5, -2, 30])
    expect(p.half).toBe(4.25)
    expect([...p.positions.slice(0, 3)]).toEqual([-1, -1, -1])
    expect([...p.positions.slice(21, 24)]).toEqual([1, 1, 1])
    expect([...p.colors.slice(0, 3)]).toEqual([200, 100, 50])
    expect(p.indices).toHaveLength(36)
    expect(p.radius).toBeCloseTo(Math.sqrt(3), 5)
  })

  it('works with an odd number of vertices, where the pad byte keeps the indices in their place', () => {
    const triangle: ProxyParts = { centre: [0, 0, 0], half: 1, positions: [0, 0, 0, Q, 0, 0, 0, Q, 0], colors: [255, 0, 0, 0, 255, 0, 0, 0, 255], indices: [0, 1, 2] }
    const bytes = encodeProxy(triangle)
    expect(bytes.length).toBe(proxyBytes(3, 1))
    const p = decodeProxy(bytes)!
    expect([...p.indices]).toEqual([0, 1, 2])
    expect([...p.colors]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255])
  })

  it('reads bytes that sit inside a bigger buffer (a view with an offset)', () => {
    const bytes = encodeProxy(cubeParts(1))
    const big = new Uint8Array(bytes.length + 11)
    big.set(bytes, 7)
    const p = decodeProxy(big.subarray(7, 7 + bytes.length))!
    expect(p.vertices).toBe(8)
    expect([...p.positions.slice(0, 3)]).toEqual([-1, -1, -1])
  })

  it('makes smooth unit normals that point out of a convex model', () => {
    const p = proxyOf(sphereParts(16, 24))
    let worst = 1
    for (let i = 0; i < p.vertices; i++) {
      const nx = p.normals[i * 3]!, ny = p.normals[i * 3 + 1]!, nz = p.normals[i * 3 + 2]!
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 4)
      const x = p.positions[i * 3]!, y = p.positions[i * 3 + 1]!, z = p.positions[i * 3 + 2]!
      const along = (nx * x + ny * y + nz * z) / Math.hypot(x, y, z)
      if (Math.hypot(x, y, z) > 0.9 && Math.abs(y) < 0.97) worst = Math.min(worst, Math.abs(along))
    }
    // On the body of the sphere the normal is the direction from the middle (the poles, where triangles collapse, are left out).
    expect(worst).toBeGreaterThan(0.98)
  })

  it('gives a vertex no triangle touches the normal straight up', () => {
    const parts = cubeParts(1)
    const spare: ProxyParts = { ...parts, positions: [...(parts.positions as number[]), 5, 5, 5], colors: [...(parts.colors as number[]), 1, 2, 3] }
    const p = proxyOf(spare)
    expect([...p.normals.slice(24, 27)]).toEqual([0, 1, 0])
  })

  it('refuses to write what it would refuse to read', () => {
    const ok = cubeParts(1)
    expect(() => encodeProxy({ ...ok, positions: [] })).toThrow(/vertices/)
    expect(() => encodeProxy({ ...ok, indices: [] })).toThrow(/triangles/)
    expect(() => encodeProxy({ ...ok, colors: [1, 2, 3] })).toThrow(/colour/)
    expect(() => encodeProxy({ ...ok, indices: [0, 1, 8] })).toThrow(/vertex that is not there/)
    expect(() => encodeProxy({ ...ok, indices: [0, 1, -1] })).toThrow(/not there/)
    expect(() => encodeProxy({ ...ok, indices: [0, 1, 0.5] })).toThrow(/not there/)
    expect(() => encodeProxy({ ...ok, positions: [1, 2] })).toThrow(/vertices/)
  })
})

describe('proxyHeader and decodeProxy refuse what is not a proxy', () => {
  const good = encodeProxy(cubeParts(1))
  const patched = (edit: (b: Uint8Array, v: DataView) => void): Uint8Array => {
    const copy = good.slice()
    edit(copy, new DataView(copy.buffer))
    return copy
  }

  it('takes the good one', () => {
    expect(proxyHeader(good)).toEqual({ vertices: 8, triangles: 12 })
  })

  it('refuses things that are not bytes', () => {
    for (const bad of [null, undefined, 'ABPX', [65, 66], {}, new ArrayBuffer(100)]) expect(decodeProxy(bad as unknown as Uint8Array)).toBeNull()
  })

  it('refuses a wrong magic, a wrong version and reserved bytes that are not zero', () => {
    for (let i = 0; i < 4; i++) expect(decodeProxy(patched((b) => void (b[i] = b[i]! ^ 1))), `magic byte ${i}`).toBeNull()
    expect(decodeProxy(patched((b) => void (b[4] = 2)))).toBeNull()
    expect(decodeProxy(patched((b) => void (b[4] = 0)))).toBeNull()
    expect(decodeProxy(patched((b) => void (b[5] = 1)))).toBeNull()
    expect(decodeProxy(patched((_b, v) => v.setUint32(28, 1, true)))).toBeNull()
  })

  it('refuses counts of nothing and counts past the limits', () => {
    expect(decodeProxy(patched((_b, v) => v.setUint16(6, 0, true)))).toBeNull()
    expect(decodeProxy(patched((_b, v) => v.setUint32(8, 0, true)))).toBeNull()
    expect(decodeProxy(patched((_b, v) => v.setUint32(8, PROXY_LIMITS.triangles + 1, true)))).toBeNull()
    expect(decodeProxy(patched((_b, v) => v.setUint32(8, 0xffffffff, true)))).toBeNull()
    // A header that promises more than the bytes hold, and one that promises less.
    expect(decodeProxy(patched((_b, v) => v.setUint16(6, 9, true)))).toBeNull()
    expect(decodeProxy(patched((_b, v) => v.setUint16(6, 7, true)))).toBeNull()
  })

  it('refuses a length that is not exactly the one the counts make', () => {
    expect(decodeProxy(good.subarray(0, good.length - 1))).toBeNull()
    expect(decodeProxy(new Uint8Array([...good, 0]))).toBeNull()
    expect(decodeProxy(good.subarray(0, 31))).toBeNull()
    expect(decodeProxy(new Uint8Array(0))).toBeNull()
    expect(decodeProxy(new Uint8Array(PROXY_MAX_BYTES + 1))).toBeNull()
  })

  it('refuses a header of nothing, and of one triangle too many, even when the length is exactly what the counts make', () => {
    const make = (vertices: number, triangles: number): Uint8Array => {
      const b = new Uint8Array(proxyBytes(vertices, triangles))
      b.set([0x41, 0x42, 0x50, 0x58, 1, 0])
      const v = new DataView(b.buffer)
      v.setUint16(6, vertices, true)
      v.setUint32(8, triangles, true)
      v.setFloat32(24, 1, true)
      return b
    }
    expect(proxyHeader(make(1, 1))).toEqual({ vertices: 1, triangles: 1 })
    expect(proxyHeader(make(0, 1))).toBeNull()
    expect(proxyHeader(make(3, 0))).toBeNull()
    expect(proxyHeader(make(1, PROXY_LIMITS.triangles))).toEqual({ vertices: 1, triangles: PROXY_LIMITS.triangles })
    expect(proxyHeader(make(1, PROXY_LIMITS.triangles + 1))).toBeNull()
    expect(proxyHeader(make(PROXY_LIMITS.vertices, 1))).toEqual({ vertices: PROXY_LIMITS.vertices, triangles: 1 })
  })

  it('refuses a half that is not a size, and a centre that is not a place', () => {
    for (const half of [0, -1, NaN, Infinity, 1e13]) expect(decodeProxy(patched((_b, v) => v.setFloat32(24, half, true))), `half ${half}`).toBeNull()
    for (const at of [12, 16, 20]) {
      expect(decodeProxy(patched((_b, v) => v.setFloat32(at, NaN, true)))).toBeNull()
      expect(decodeProxy(patched((_b, v) => v.setFloat32(at, -Infinity, true)))).toBeNull()
    }
  })

  it('refuses a triangle that names a vertex that is not there, wherever it is', () => {
    const indexAt = PROXY_HEADER_BYTES + 8 * 6 + 8 * 3
    for (const slot of [0, 1, 35]) {
      expect(decodeProxy(patched((_b, v) => v.setUint16(indexAt + slot * 2, 8, true))), `slot ${slot}`).toBeNull()
      expect(decodeProxy(patched((_b, v) => v.setUint16(indexAt + slot * 2, 65_535, true))), `slot ${slot}`).toBeNull()
    }
    // The last vertex that is there is fine.
    expect(decodeProxy(patched((_b, v) => v.setUint16(indexAt, 7, true)))).not.toBeNull()
  })

  it('reads -32768 as -1, the same as -32767: no vertex lands outside the box', () => {
    const p = decodeProxy(patched((_b, v) => v.setInt16(PROXY_HEADER_BYTES, -32768, true)))!
    expect(p.positions[0]).toBe(-1)
  })
})

/* ------------------------------------------------------------------ */
/* Views                                                              */
/* ------------------------------------------------------------------ */

describe('views', () => {
  it('the default is the thumbnails’ own: 35 degrees off the front and 24 above', () => {
    expect(MODEL_VIEW_DEFAULT).toEqual({ yaw: 35, pitch: 24 })
    expect(isDefaultView({ yaw: 35, pitch: 24 })).toBe(true)
    expect(isDefaultView({ yaw: 35.04, pitch: 23.97 })).toBe(true)
    expect(isDefaultView({ yaw: 35.2, pitch: 24 })).toBe(false)
    expect(isDefaultView({ yaw: 35, pitch: 25 })).toBe(false)
  })

  it('wraps a yaw into a turn, holds a pitch to ±89 and takes the default for what is not a number', () => {
    expect(normaliseView({ yaw: 370, pitch: 10 })).toEqual({ yaw: 10, pitch: 10 })
    expect(normaliseView({ yaw: -10, pitch: 10 })).toEqual({ yaw: 350, pitch: 10 })
    expect(normaliseView({ yaw: 720, pitch: 0 }).yaw).toBe(0)
    // A yaw that rounds up to a whole turn is no turn at all: 0, never 360.
    expect(normaliseView({ yaw: 359.96, pitch: 0 }).yaw).toBe(0)
    expect(normaliseView({ yaw: 359.94, pitch: 0 }).yaw).toBe(359.9)
    expect(normaliseView({ yaw: 12.34, pitch: -5.55 })).toEqual({ yaw: 12.3, pitch: -5.5 })
    expect(normaliseView({ yaw: 0, pitch: 200 }).pitch).toBe(MODEL_PITCH_MAX)
    expect(normaliseView({ yaw: 0, pitch: -200 }).pitch).toBe(-MODEL_PITCH_MAX)
    expect(normaliseView({ yaw: NaN, pitch: Infinity })).toEqual({ yaw: 35, pitch: 24 })
    expect(normaliseView({ yaw: '90', pitch: null })).toEqual({ yaw: 35, pitch: 24 })
    expect(normaliseView({})).toEqual({ yaw: 35, pitch: 24 })
  })

  it('looks at the front from straight ahead at yaw 0, pitch 0: x to the right, y up, the camera on the +Z side', () => {
    const b = viewBasis({ yaw: 0, pitch: 0 })
    expect(b.f.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, 0, -1])
    expect(b.r.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([1, 0, 0])
    expect(b.u.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, 1, 0])
  })

  it('has three perpendicular unit vectors for every view, and a camera that goes toward +X as the yaw grows', () => {
    for (const yaw of [0, 35, 90, 181, 270, 359]) {
      for (const pitch of [-89, -40, 0, 24, 60, 89]) {
        const { r, u, f } = viewBasis({ yaw, pitch })
        const dot = (a: number[], c: number[]) => a[0]! * c[0]! + a[1]! * c[1]! + a[2]! * c[2]!
        for (const v of [r, u, f]) expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 9)
        expect(dot(r, u)).toBeCloseTo(0, 9)
        expect(dot(r, f)).toBeCloseTo(0, 9)
        expect(dot(u, f)).toBeCloseTo(0, 9)
        // Right-handed, and "up" stays up on the screen.
        expect(u[1]).toBeGreaterThan(0)
      }
    }
    // Looking toward -X from +X (yaw 90): the camera is on the +X side.
    expect(viewBasis({ yaw: 90, pitch: 0 }).f[0]).toBeCloseTo(-1, 9)
  })
})

/* ------------------------------------------------------------------ */
/* Drawing                                                            */
/* ------------------------------------------------------------------ */

const at = (img: Uint8ClampedArray, side: number, x: number, y: number) => [img[(y * side + x) * 4]!, img[(y * side + x) * 4 + 1]!, img[(y * side + x) * 4 + 2]!, img[(y * side + x) * 4 + 3]!]

/** Pixels that are not the ground: the ground of row y is what the picture holds at x = 0 of that row. */
function mask(img: Uint8ClampedArray, side: number): boolean[] {
  const out: boolean[] = []
  for (let y = 0; y < side; y++) {
    const bg = at(img, side, 0, y)
    for (let x = 0; x < side; x++) {
      const p = at(img, side, x, y)
      out.push(Math.abs(p[0]! - bg[0]!) + Math.abs(p[1]! - bg[1]!) + Math.abs(p[2]! - bg[2]!) > 6)
    }
  }
  return out
}
const count = (m: boolean[]) => m.filter(Boolean).length
function centroid(m: boolean[], side: number): { x: number; y: number } {
  let sx = 0, sy = 0, n = 0
  m.forEach((on, i) => {
    if (!on) return
    sx += i % side
    sy += Math.floor(i / side)
    n++
  })
  return { x: sx / n, y: sy / n }
}

describe('modelBrightness (the helper’s look, written down here as well)', () => {
  it('is a floor of light, the diffuse on top and a little rim', () => {
    expect(modelBrightness(0, 1)).toBeCloseTo(0.3, 9)
    expect(modelBrightness(1, 1)).toBeCloseTo(1.08, 9)
    expect(modelBrightness(0, 0)).toBeCloseTo(0.52, 9)
    expect(modelBrightness(0.5, 0.5)).toBeCloseTo(0.3 + 0.39 + 0.055, 9)
    expect(MODEL_EXPOSURE).toBe(0.42)
    expect(MODEL_MAX_GAIN).toBe(3)
  })
})

describe('renderProxy', () => {
  const side = 96

  it('draws a square of opaque pixels over the same dark gradient the thumbnails use', () => {
    const r = renderProxy(proxyOf(sphereParts()), { side, yaw: 35, pitch: 24 })!
    expect(r.pixels).toHaveLength(side * side * 4)
    for (let i = 3; i < r.pixels.length; i += 4) expect(r.pixels[i]).toBe(255)
    // Top-left: 20, 26, 46; bottom-left: 8, 11, 20 (the gradient of rasterGlb).
    expect(at(r.pixels, side, 0, 0)).toEqual([20, 26, 46, 255])
    expect(at(r.pixels, side, 0, side - 1)).toEqual([8, 11, 20, 255])
  })

  it('shows a sphere as a disc of the size the scale gives, in the middle, in its own colour', () => {
    const r = renderProxy(proxyOf(sphereParts(28, 40)), { side: 128, yaw: 35, pitch: 24 })!
    const m = mask(r.pixels, 128)
    const expected = Math.PI * (0.86 * 128 * 0.5) ** 2
    expect(count(m)).toBeGreaterThan(expected * 0.93)
    expect(count(m)).toBeLessThan(expected * 1.04)
    const c = centroid(m, 128)
    expect(c.x).toBeGreaterThan(63)
    expect(c.x).toBeLessThan(65)
    expect(c.y).toBeGreaterThan(63)
    expect(c.y).toBeLessThan(65)
    // Red, in the middle: its colour is (200, 60, 60), lit and exposed.
    const mid = at(r.pixels, 128, 64, 64)
    expect(mid[0]).toBeGreaterThan(mid[1]! * 2)
    expect(mid[0]).toBeGreaterThan(mid[2]! * 2)
  })

  it('takes two samples a pixel up to 512 px and one above it, when it is not told', () => {
    const p = proxyOf(sphereParts())
    const same = (x: Uint8ClampedArray, y: Uint8ClampedArray): boolean => Buffer.compare(Buffer.from(x), Buffer.from(y)) === 0
    const small = renderProxy(p, { side: 96, yaw: 35, pitch: 24 })!
    expect(same(small.pixels, renderProxy(p, { side: 96, yaw: 35, pitch: 24, supersample: 2 })!.pixels)).toBe(true)
    expect(same(small.pixels, renderProxy(p, { side: 96, yaw: 35, pitch: 24, supersample: 1 })!.pixels)).toBe(false)
    const big = renderProxy(p, { side: 600, yaw: 35, pitch: 24 })!
    expect(same(big.pixels, renderProxy(p, { side: 600, yaw: 35, pitch: 24, supersample: 1 })!.pixels)).toBe(true)
  })

  it('draws the same pixels for the same proxy and options, every time', () => {
    const p = proxyOf(sphereParts())
    const a = renderProxy(p, { side, yaw: 120, pitch: -20 })!
    const b = renderProxy(p, { side, yaw: 120, pitch: -20 })!
    expect(Buffer.compare(Buffer.from(a.pixels), Buffer.from(b.pixels))).toBe(0)
    expect(a.gain).toBe(b.gain)
  })

  it('keeps a model’s size and place as it is turned: a long box keeps its middle, and shows less of itself end-on', () => {
    const box = proxyOf(boxParts(1, 0.2, 0.2))
    const side2 = 128
    const front = renderProxy(box, { side: side2, yaw: 90, pitch: 0 })! // the long side faces the camera (camera on +X)
    const end = renderProxy(box, { side: side2, yaw: 0, pitch: 0 })! // the camera looks along the long axis's end... the +Z face
    const mFront = mask(front.pixels, side2)
    const mEnd = mask(end.pixels, side2)
    // Seen from +X the box is 0.4 wide (z) and 0.4 tall; from +Z it is 2 wide (x) and 0.4 tall: the wide view covers more.
    expect(count(mEnd)).toBeGreaterThan(count(mFront) * 3)
    for (const m of [mFront, mEnd]) {
      const c = centroid(m, side2)
      expect(Math.abs(c.x - 64)).toBeLessThan(1)
      expect(Math.abs(c.y - 64)).toBeLessThan(1)
    }
    // The wide view spans most of the picture (the box's longest side is 2 of a bounding sphere 2.24 across, at 0.86 of the side).
    const xs = mEnd.map((on, i) => (on ? i % side2 : -1)).filter((v) => v >= 0)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(side2 * 0.7)
  })

  it('lights a face toward the light more than one turned away from it', () => {
    const cube = proxyOf(cubeParts(1, [180, 180, 180]))
    // From the front (yaw 0, pitch 0) the +Z face is seen square: the light is up-left in front of the camera.
    const flat = renderProxy(cube, { side: 64, yaw: 0, pitch: 0, gain: 1 })!
    const centre = at(flat.pixels, 64, 32, 32)
    // Straight at us, the light 0.617 along it: 0.3 + 0.78 * 0.617 = 0.781, times 180.
    expect(centre[0]).toBeGreaterThan(180 * 0.74)
    expect(centre[0]).toBeLessThan(180 * 0.82)
    // The same cube from below: the bottom face faces us and the light comes from above: darker.
    const below = renderProxy(cube, { side: 64, yaw: 0, pitch: -89, gain: 1 })!
    expect(at(below.pixels, 64, 32, 32)[0]!).toBeLessThan(centre[0]!)
  })

  it('paints the colour of a vertex over the triangles it belongs to (blending toward the others)', () => {
    const parts = cubeParts(1)
    // The +Z face's four vertices (4, 5, 6, 7): red on the left (x = -1), blue on the right (x = +1).
    const colors = (parts.colors as number[]).slice()
    for (const v of [4, 6]) colors.splice(v * 3, 3, 255, 0, 0)
    for (const v of [5, 7]) colors.splice(v * 3, 3, 0, 0, 255)
    const r = renderProxy(proxyOf({ ...parts, colors }), { side: 128, yaw: 0, pitch: 0, gain: 1 })!
    const left = at(r.pixels, 128, 40, 64)
    const right = at(r.pixels, 128, 88, 64)
    expect(left[0]).toBeGreaterThan(left[2]!)
    expect(right[2]).toBeGreaterThan(right[0]!)
  })

  it('lifts a dark model to the exposure the thumbnails use, never by more than three times, and leaves a bright one as it is', () => {
    const dark = renderProxy(proxyOf(sphereParts(16, 24, [20, 20, 20])), { side, yaw: 35, pitch: 24 })!
    expect(dark.gain).toBeGreaterThan(1.5)
    expect(dark.gain).toBeLessThanOrEqual(MODEL_MAX_GAIN)
    const black = renderProxy(proxyOf(sphereParts(16, 24, [2, 2, 2])), { side, yaw: 35, pitch: 24 })!
    expect(black.gain).toBe(MODEL_MAX_GAIN)
    const bright = renderProxy(proxyOf(sphereParts(16, 24, [255, 255, 255])), { side, yaw: 35, pitch: 24 })!
    expect(bright.gain).toBe(1)
  })

  it('uses the gain it is given, held to what the rule allows, so a turning model does not flicker', () => {
    const p = proxyOf(sphereParts(16, 24, [100, 100, 100]))
    const auto = renderProxy(p, { side, yaw: 35, pitch: 24 })!
    expect(renderProxy(p, { side, yaw: 200, pitch: 10, gain: auto.gain })!.gain).toBe(auto.gain)
    expect(renderProxy(p, { side, yaw: 200, pitch: 10, gain: 99 })!.gain).toBe(MODEL_MAX_GAIN)
    expect(renderProxy(p, { side, yaw: 200, pitch: 10, gain: 0.2 })!.gain).toBe(1)
    expect(renderProxy(p, { side, yaw: 200, pitch: 10, gain: NaN })!.gain).toBeGreaterThanOrEqual(1)
  })

  it('draws with one sample a pixel as well, to the same silhouette within the edge', () => {
    const p = proxyOf(sphereParts(24, 32))
    const one = renderProxy(p, { side: 128, yaw: 35, pitch: 24, supersample: 1 })!
    const two = renderProxy(p, { side: 128, yaw: 35, pitch: 24, supersample: 2 })!
    const a = count(mask(one.pixels, 128))
    const b = count(mask(two.pixels, 128))
    expect(Math.abs(a - b) / b).toBeLessThan(0.04)
  })

  it('answers null for a side that is not one, and for a model with nothing to see', () => {
    const p = proxyOf(sphereParts())
    for (const bad of [0, 7, 1025, NaN, Infinity, -64]) expect(renderProxy(p, { side: bad, yaw: 0, pitch: 0 }), `side ${bad}`).toBeNull()
    // A flat sheet seen exactly edge-on has no area to draw.
    const sheet: ProxyParts = { centre: [0, 0, 0], half: 1, positions: [-Q, 0, 0, Q, 0, 0, 0, 0, Q], colors: [9, 9, 9, 9, 9, 9, 9, 9, 9], indices: [0, 1, 2] }
    expect(renderProxy(proxyOf(sheet), { side: 64, yaw: 0, pitch: 0 })).toBeNull()
  })

  it('draws a triangle seen from behind as lit as if it faced the camera (two-sided)', () => {
    const sheet: ProxyParts = { centre: [0, 0, 0], half: 1, positions: [-Q, -Q, 0, Q, -Q, 0, 0, Q, 0], colors: [200, 200, 200, 200, 200, 200, 200, 200, 200], indices: [0, 1, 2] }
    const flipped: ProxyParts = { ...sheet, indices: [0, 2, 1] }
    const a = renderProxy(proxyOf(sheet), { side: 64, yaw: 0, pitch: 0, gain: 1 })!
    const b = renderProxy(proxyOf(flipped), { side: 64, yaw: 0, pitch: 0, gain: 1 })!
    expect(Buffer.compare(Buffer.from(a.pixels), Buffer.from(b.pixels))).toBe(0)
    expect(count(mask(a.pixels, 64))).toBeGreaterThan(200)
  })

  it('a single triangle square to the camera is lit by the one rule the helper uses', () => {
    const sheet: ProxyParts = { centre: [0, 0, 0], half: 1, positions: [-Q, -Q, 0, Q, -Q, 0, 0, Q, 0], colors: Array.from({ length: 9 }, () => 200), indices: [0, 1, 2] }
    const r = renderProxy(proxyOf(sheet), { side: 64, yaw: 0, pitch: 0, gain: 1, supersample: 1 })!
    const l = Math.hypot(-0.45, 0.65, -0.62)
    const diffuse = Math.abs(-0.62) / l
    const expected = 200 * modelBrightness(diffuse, 1)
    const p = at(r.pixels, 64, 32, 40)
    expect(Math.abs(p[0]! - expected)).toBeLessThanOrEqual(1)
    expect(Math.abs(p[1]! - expected)).toBeLessThanOrEqual(1)
  })

  it('costs a turning model little: a proxy at the target size draws a 256 px view in well under a second', () => {
    const p = proxyOf(sphereParts(100, 120))
    expect(p.triangles).toBeGreaterThan(PROXY_TARGET_TRIANGLES / 2)
    const t0 = performance.now()
    for (let i = 0; i < 4; i++) expect(renderProxy(p, { side: 256, yaw: i * 40, pitch: 20, supersample: 1 })).not.toBeNull()
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})
