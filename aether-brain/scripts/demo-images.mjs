#!/usr/bin/env node
/**
 * Paints the demo vault's pictures: moody PORTALz concept art (portal rings,
 * ruin silhouettes, gradient skies) and the ConceptForge value study that the
 * demo critique note embeds. Everything is procedural and deterministic, so
 * the committed PNGs only change when this script does. No dependencies: the
 * PNGs are encoded by hand with node:zlib.
 *
 *   node scripts/demo-images.mjs
 *
 * Kept small on purpose (the whole set stays well under 250 KB): smooth
 * gradients and flat silhouettes, no noise, which PNG's row filters compress
 * to almost nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ART = join(ROOT, 'vault-demo/Projects/PORTALz/Art')
const CRITIQUE = join(ROOT, 'vault-demo/Projects/ConceptForge/Critique')

const W = 384
const H = 240
/** Sub-samples per axis for anti-aliased shape edges. */
const SS = 3

/* ---------- colour and math helpers ---------- */

/** `#rrggbb` → [r, g, b] in 0–1. */
function hex(h) {
  const n = Number.parseInt(h.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v)
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}
/** Colour at `t` along gradient stops `[[t, '#hex'], …]` (t ascending). */
function ramp(stops, t) {
  if (t <= stops[0][0]) return hex(stops[0][1])
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i]
    const [t0, c0] = stops[i - 1]
    if (t <= t1) return mix(hex(c0), hex(c1), smooth(t0, t1, t))
  }
  return hex(stops[stops.length - 1][1])
}
/** Small seeded PRNG (mulberry32): the same picture every run. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** A skyline: height at x from three sines with seeded frequencies and phases. */
function ridge(seed, base, amp) {
  const r = rng(seed)
  const waves = [0.011, 0.027, 0.063].map((f) => [f * (0.7 + r() * 0.6), r() * Math.PI * 2])
  return (x) => base - amp * (0.55 * Math.sin(x * waves[0][0] + waves[0][1]) + 0.3 * Math.sin(x * waves[1][0] + waves[1][1]) + 0.15 * Math.sin(x * waves[2][0] + waves[2][1]))
}

/* ---------- a tiny float canvas ---------- */

class Canvas {
  constructor() {
    this.px = new Float32Array(W * H * 3)
  }
  /** Paint every pixel with `fn(x, y) → rgb` (pixel centres). */
  fill(fn) {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const c = fn(x + 0.5, y + 0.5)
        const i = (y * W + x) * 3
        this.px[i] = c[0]
        this.px[i + 1] = c[1]
        this.px[i + 2] = c[2]
      }
  }
  /** Blend `color(x, y)` over the pixels `inside(x, y)` covers, anti-aliased, at `alpha`. */
  shape(inside, color, alpha = 1, box = [0, 0, W, H]) {
    const [x0, y0, x1, y1] = box.map(Math.round)
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        let hit = 0
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) if (inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hit++
        if (!hit) continue
        const c = typeof color === 'function' ? color(x + 0.5, y + 0.5) : color
        this.blend(x, y, c, (alpha * hit) / (SS * SS))
      }
  }
  blend(x, y, c, a) {
    const i = (y * W + x) * 3
    for (let k = 0; k < 3; k++) this.px[i + k] += (c[k] - this.px[i + k]) * a
  }
  /** Add light: `fn(x, y) → [rgb, strength]` (or null for none). */
  light(fn) {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const l = fn(x + 0.5, y + 0.5)
        if (!l) continue
        const i = (y * W + x) * 3
        for (let k = 0; k < 3; k++) this.px[i + k] += l[0][k] * l[1]
      }
  }
  /** A soft round dot (stars, dust, glyph sparks). */
  dot(cx, cy, r, c, a = 1) {
    this.shape((x, y) => (x - cx) ** 2 + (y - cy) ** 2 < r * r, c, a, [cx - r - 1, cy - r - 1, cx + r + 2, cy + r + 2])
  }
  /** Darken toward the corners. */
  vignette(strength) {
    this.light((x, y) => {
      const d = Math.hypot((x - W / 2) / (W / 2), (y - H / 2) / (H / 2))
      return [[-1, -1, -1], strength * smooth(0.55, 1.45, d) * 0.35]
    })
  }
  /** 8-bit RGB. */
  bytes() {
    const out = new Uint8Array(W * H * 3)
    for (let i = 0; i < out.length; i++) out[i] = Math.round(clamp(this.px[i]) * 255)
    return out
  }
}

/* ---------- PNG encoding ---------- */

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}
/** An 8-bit RGB PNG; each row takes the filter with the smallest residuals (the usual heuristic). */
function encodePng(rgb) {
  const stride = W * 3
  const raw = Buffer.alloc((stride + 1) * H)
  const row = new Uint8Array(stride)
  for (let y = 0; y < H; y++) {
    const cur = rgb.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? rgb.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride)
    let best = null
    let bestSum = Infinity
    for (let f = 0; f < 5; f++) {
      let sum = 0
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? cur[i - 3] : 0
        const b = prev[i]
        const c = i >= 3 ? prev[i - 3] : 0
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c)
        const v = (cur[i] - pred) & 255
        row[i] = v
        sum += v < 128 ? v : 256 - v
      }
      if (sum < bestSum) {
        bestSum = sum
        best = [f, Uint8Array.from(row)]
      }
    }
    raw[y * (stride + 1)] = best[0]
    raw.set(best[1], y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9, memLevel: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ])
}

/* ---------- the pictures ---------- */

const CYAN = hex('#3ee6f0')

/** The gate awake: a stone ring over the jungle, a disc of light opening inside it. */
function portalRing() {
  const c = new Canvas()
  c.fill((_, y) => ramp([[0, '#05111a'], [0.55, '#0c2a33'], [0.8, '#08171b'], [1, '#040809']], y / H))
  const far = ridge(11, 158, 10)
  c.shape((x, y) => y > far(x), hex('#0d2026'))
  const [cx, cy, R] = [192, 116, 74]
  // Light inside the ring: white core, cyan body, a faint iris swirl.
  c.shape(
    (x, y) => Math.hypot(x - cx, y - cy) < R - 6,
    (x, y) => {
      const r = Math.hypot(x - cx, y - cy) / (R - 6)
      const swirl = 0.06 * Math.sin(Math.atan2(y - cy, x - cx) * 3 + r * 9)
      return ramp([[0, '#f2ffff'], [0.35, '#8ff7ff'], [0.75, '#1fa7b8'], [1, '#0a4c58']], clamp(r + swirl))
    },
  )
  // The stone ring, lit from the upper left.
  c.shape(
    (x, y) => {
      const d = Math.hypot(x - cx, y - cy)
      return d >= R - 7 && d <= R + 8
    },
    (x, y) => mix(hex('#101719'), hex('#4a5a5c'), 0.5 + 0.5 * Math.cos(Math.atan2(y - cy, x - cx) + 2.3)),
  )
  // Glyph sparks on the ring.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    c.dot(cx + Math.cos(a) * R, cy + Math.sin(a) * R, 1.8, hex('#b8fbff'))
  }
  c.light((x, y) => {
    const d = Math.hypot(x - cx, y - cy)
    return d > R + 6 ? [CYAN, 0.55 * Math.exp(-(d - R - 6) / 26)] : null
  })
  const near = ridge(5, 206, 9)
  c.shape((x, y) => y > near(x) - 6 * Math.abs(Math.sin(x * 0.09)), hex('#030807'))
  const r = rng(3)
  for (let i = 0; i < 36; i++) {
    const a = r() * Math.PI * 2
    const d = R + 10 + r() * 60
    c.dot(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, 0.6 + r() * 0.8, hex('#c8fcff'), 0.35 + r() * 0.4)
  }
  c.vignette(1)
  return c
}

/** A broken gate against a dusk sky. */
function gateAtDusk() {
  const c = new Canvas()
  c.fill((_, y) => ramp([[0, '#170d2b'], [0.45, '#50264a'], [0.72, '#c06438'], [0.82, '#f0b060'], [1, '#f0b060']], y / H))
  c.light((x, y) => [hex('#ffb070'), 0.5 * Math.exp(-Math.hypot(x - 276, (y - 188) * 1.6) / 40)])
  for (const [ex, ey, rx, ry] of [
    [90, 60, 80, 7],
    [250, 42, 110, 6],
    [320, 95, 70, 5],
  ])
    c.shape((x, y) => ((x - ex) / rx) ** 2 + ((y - ey) / ry) ** 2 < 1, hex('#2a1436'), 0.55)
  const far = ridge(21, 190, 6)
  c.shape((x, y) => y > far(x), hex('#3a1c33'))
  const ink = hex('#0c0610')
  // The gate: a slab with an arched opening and a broken crown.
  c.shape((x, y) => {
    if (x < 140 || x > 244 || y > 216) return false
    const crown = 70 + (x < 170 ? 0 : x < 196 ? 9 : x < 214 ? 3 : 14)
    if (y < crown) return false
    const inArch = x > 164 && x < 220 && (y > 114 || Math.hypot(x - 192, y - 114) < 28)
    return !inArch
  }, ink)
  // Broken columns on either side.
  for (const [x0, w, top] of [
    [96, 16, 128],
    [118, 12, 150],
    [262, 14, 138],
    [286, 18, 160],
  ])
    c.shape((x, y) => x > x0 && x < x0 + w && y > top + 5 * Math.sin(x * 0.8) && y < 216, ink)
  c.shape((x, y) => y > 212 + 3 * Math.sin(x * 0.05), hex('#07040a'))
  c.vignette(0.8)
  return c
}

/** Monoliths in the mist, three ridges deep, their glyphs still lit. */
function monolithRow() {
  const c = new Canvas()
  c.fill((_, y) => ramp([[0, '#18262a'], [0.62, '#6c877e'], [1, '#2a3a36']], y / H))
  const layers = [
    [ridge(31, 150, 12), '#4d655e'],
    [ridge(32, 176, 10), '#2b3e3a'],
    [ridge(33, 208, 8), '#101918'],
  ]
  const slabs = [
    [1, 70, 18, 70],
    [1, 150, 22, 92],
    [1, 236, 16, 60],
    [2, 112, 26, 118],
    [2, 290, 24, 104],
  ]
  layers.forEach(([line, col], i) => {
    c.shape((x, y) => y > line(x), hex(col))
    for (const [layer, x0, w, h] of slabs) {
      if (layer !== i) continue
      const foot = line(x0 + w / 2) + 6
      c.shape((x, y) => x > x0 && x < x0 + w && y > foot - h + (x - x0) * 0.12 && y < foot, hex(col))
      // Glyph cuts: short cyan dashes in groups of three.
      for (let g = 0; g < 3; g++) {
        const gy = foot - h * 0.75 + g * 9
        c.shape((x, y) => x > x0 + w / 2 - 1.2 && x < x0 + w / 2 + 1.2 && y > gy && y < gy + 5, hex('#9ff8ff'), i === 2 ? 1 : 0.6)
      }
      c.light((x, y) => [CYAN, (i === 2 ? 0.22 : 0.12) * Math.exp(-Math.hypot(x - x0 - w / 2, y - foot + h * 0.62) / 14)])
    }
    // Fog settles between the ridges.
    const fogY = line(W / 2) - 4
    c.light((_, y) => [hex('#9fb8ae'), 0.1 * Math.exp(-(((y - fogY) / 14) ** 2))])
  })
  c.vignette(0.7)
  return c
}

/** A wall of the builders' script: stone blocks, moss, glyphs of light (one panel cracked). */
function glyphWall() {
  const c = new Canvas()
  const r = rng(41)
  const rows = []
  for (let y = 0; y < H; y += 40) {
    const blocks = []
    let x = -r() * 60
    while (x < W) {
      const w = 60 + r() * 70
      blocks.push([x, w, 0.85 + r() * 0.3])
      x += w
    }
    rows.push([y, blocks])
  }
  c.fill((x, y) => {
    const [ry, blocks] = rows[Math.min(rows.length - 1, Math.floor(y / 40))]
    const b = blocks.find(([bx, bw]) => x >= bx && x < bx + bw) ?? blocks[0]
    const inRow = y - ry
    if (inRow < 2 || x - b[0] < 2) return hex('#0a0d0d')
    const base = mix(hex('#2c3536'), hex('#1a2021'), inRow / 40)
    const moss = smooth(30, 39, inRow) * 0.6
    return mix(base.map((v) => v * b[2]), hex('#2f4424'), moss)
  })
  const glow = hex('#53f1ff')
  const glyphs = [
    [70, 60],
    [104, 60],
    [138, 60],
    [236, 140],
    [270, 140],
    [304, 140],
  ]
  // Straight cuts and full circles only, no two alike.
  const ring = (dx, dy, r) => Math.abs(Math.hypot(dx, dy) - r) < 1.4
  const bar = (d, len) => Math.abs(d) < 1.4 && len
  const strokes = [
    (dx, dy) => ring(dx, dy, 9) || bar(dx, Math.abs(dy) < 14),
    (dx, dy) => [-8, 0, 8].some((y0, k) => bar(dy - y0, Math.abs(dx) < 10 - k * 3)),
    (dx, dy) => ring(dx, dy + 5, 5) || bar(dy - 8, Math.abs(dx) < 10),
    (dx, dy) => ring(dx, dy, 10) || ring(dx, dy, 4),
    (dx, dy) => bar(dx + 3, Math.abs(dy) < 13) || bar(dy + 6, dx > -3 && dx < 7) || bar(dy - 4, dx > -3 && dx < 4),
    (dx, dy) => ring(dx, dy - 4, 7) || bar(dy + 10, Math.abs(dx) < 8),
  ]
  glyphs.forEach(([gx, gy], i) => {
    const stroke = strokes[i] ?? strokes[0]
    c.shape((x, y) => stroke(x - gx, y - gy), glow)
    c.light((x, y) => [CYAN, 0.35 * Math.exp(-Math.hypot(x - gx, y - gy) / 16)])
  })
  // The crack runs through one glyph; the channel stays whole on both halves.
  c.shape((x, y) => Math.abs(y - 140 - (x - 270) * 0.9) < 1.2 && y > 118 && y < 164, hex('#050707'))
  c.vignette(1.1)
  return c
}

/** God rays through the canopy onto a stepped ruin. */
function canopyRays() {
  const c = new Canvas()
  c.fill((_, y) => ramp([[0, '#08170e'], [0.5, '#1b3a22'], [1, '#07120a']], y / H))
  const a = 1.15
  c.light((x, y) => {
    const u = x * Math.cos(a) - y * Math.sin(a)
    const band = Math.max(0, Math.sin(u * 0.045)) ** 10 + 0.6 * Math.max(0, Math.sin(u * 0.08 + 1.7)) ** 14
    return [hex('#d8f2a0'), 0.28 * band * smooth(0, 60, y) * (1 - smooth(150, 240, y))]
  })
  c.shape((x, y) => {
    for (let s = 0; s < 4; s++) {
      const half = 92 - s * 20
      const top = 196 - s * 18
      if (Math.abs(x - 200) < half && y > top) return true
    }
    return false
  }, hex('#0e2214'), 0.9)
  c.shape((x, y) => y < 26 + 12 * Math.abs(Math.sin(x * 0.045)) + 6 * Math.sin(x * 0.13), hex('#030a05'))
  c.shape((x, y) => y > 214 - 14 * Math.abs(Math.sin(x * 0.21)) - 5 * Math.sin(x * 0.05), hex('#020704'))
  c.vignette(0.9)
  return c
}

/** Pet drone concept: soft-square body, one waiting eye, guide lines of the sheet. */
function droneSketch() {
  const c = new Canvas()
  c.fill((x, y) => mix(hex('#1c2436'), hex('#07090e'), smooth(0.2, 1.1, Math.hypot((x - 192) / 200, (y - 116) / 150))))
  const guide = hex('#2b3650')
  c.shape((x, y) => Math.abs(y - 112) < 0.5 || Math.abs(x - 192) < 0.5 || Math.abs(y - 164) < 0.5, guide, 0.8)
  c.shape((x, y) => ((x - 192) / 70) ** 2 + ((y - 196) / 9) ** 2 < 1, hex('#05070b'), 0.7)
  const [cx, cy, a, b] = [192, 110, 60, 48]
  c.shape(
    (x, y) => ((x - cx) / a) ** 4 + ((y - cy) / b) ** 4 < 1,
    (_, y) => mix(hex('#a4b0c2'), hex('#343d4e'), smooth(cy - b, cy + b, y)),
  )
  c.shape((x, y) => ((x - cx) / (a - 6)) ** 4 + ((y - cy - 30) / 10) ** 4 < 1, hex('#262d3a'), 0.6)
  c.dot(cx, cy - 4, 15, hex('#0a0f18'))
  c.dot(cx, cy - 4, 6, hex('#bffcff'))
  c.light((x, y) => [CYAN, 0.45 * Math.exp(-Math.hypot(x - cx, y - cy + 4) / 12)])
  for (const side of [-1, 1]) {
    const tx = cx + side * 70
    c.shape((x, y) => ((x - tx) / 10) ** 4 + ((y - cy - 6) / 16) ** 4 < 1, hex('#56607a'))
    c.light((x, y) => [hex('#ff9a4a'), 0.35 * Math.exp(-Math.hypot(x - tx, (y - cy - 28) * 0.8) / 9)])
  }
  c.shape((x, y) => Math.abs(x - 214 - (y - 62) * 0.35) < 1 && y > 42 && y < 64, hex('#8d99ad'))
  c.dot(207, 41, 3, hex('#8ff7ff'))
  c.vignette(0.6)
  return c
}

/** Terraces stepping down into fog under the moon, a gate glowing far up. */
function terraceFog() {
  const c = new Canvas()
  c.fill((_, y) => ramp([[0, '#080d1c'], [0.7, '#223250'], [1, '#141c2e']], y / H))
  const r = rng(71)
  for (let i = 0; i < 70; i++) c.dot(r() * W, r() * 120, 0.5 + r() * 0.5, hex('#dfe8ff'), 0.4 + r() * 0.5)
  c.dot(302, 58, 15, hex('#e8eefc'))
  c.light((x, y) => [hex('#9fb4e8'), 0.35 * Math.exp(-Math.hypot(x - 302, y - 58) / 30)])
  const layers = ['#3b4a6a', '#27334d', '#171f33', '#0a0f1b']
  layers.forEach((col, i) => {
    const base = 120 + i * 30
    const phase = i * 37
    c.shape((x, y) => y > base + Math.floor(((x + phase) % 140) / 35) * 6 - (i === 0 ? 0 : 4) * Math.sin(x * 0.03), hex(col))
    c.light((_, y) => [hex('#6f82aa'), 0.08 * Math.exp(-(((y - base - 8) / 10) ** 2))])
    if (i === 0) c.light((x, y) => [CYAN, 0.5 * Math.exp(-Math.hypot(x - 96, y - base + 4) / 7)])
  })
  c.vignette(0.8)
  return c
}

/**
 * The ConceptForge value study the demo critique grades: three values that
 * mostly hold, a midground where the arch and the trees fight at one gray,
 * and a gate opening that isn't the darkest dark yet.
 */
function valueStudy() {
  const c = new Canvas()
  const g = (v) => [v, v, v]
  c.fill((_, y) => g(0.86 - 0.08 * (y / H)))
  c.shape((x, y) => y > 150 - 26 * Math.exp(-(((x - 90) / 60) ** 2)) - 18 * Math.exp(-(((x - 300) / 50) ** 2)), g(0.52))
  c.shape((x, y) => {
    if (x < 150 || x > 250 || y < 64 || y > 200) return false
    return !(x > 172 && x < 228 && (y > 110 || Math.hypot(x - 200, y - 110) < 28))
  }, g(0.47))
  c.shape((x, y) => x > 180 && x < 220 && y > 120 && y < 200, g(0.3))
  c.shape((x, y) => y > 196 + 8 * Math.sin(x * 0.04), g(0.16))
  // Loose construction strokes, as a quick study has.
  c.shape((x, y) => Math.abs(y - 64 - (x - 150) * 0.02) < 0.6 && x > 120 && x < 280, g(0.35), 0.6)
  c.shape((x, y) => Math.abs(x - 200) < 0.5 && y > 40 && y < 230, g(0.6), 0.5)
  return c
}

const PICTURES = [
  [ART, 'portal-ring.png', portalRing],
  [ART, 'gate-at-dusk.png', gateAtDusk],
  [ART, 'monolith-row.png', monolithRow],
  [ART, 'glyph-wall.png', glyphWall],
  [ART, 'canopy-rays.png', canopyRays],
  [ART, 'drone-sketch.png', droneSketch],
  [ART, 'terrace-fog.png', terraceFog],
  [CRITIQUE, '2026-09-28 Value Study.png', valueStudy],
]

let total = 0
for (const [dir, name, paint] of PICTURES) {
  const png = encodePng(paint().bytes())
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), png)
  total += png.length
  console.log(`${relative(ROOT, join(dir, name))}  ${(png.length / 1024).toFixed(1)} KB`)
}
console.log(`total ${(total / 1024).toFixed(1)} KB`)
