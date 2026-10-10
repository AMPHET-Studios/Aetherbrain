/**
 * Colour helpers of the reference board: hex strings (6 digits, no `#`, as the board file writes them), contrast, the colours a picture
 * is mostly made of (median cut) and the colour under a sampler's pointer. Pure functions of plain data; the pixels come from the
 * caller's canvas as RGBA bytes. Design: docs/design/reference-board.md.
 */

const HEX6 = /^#?([0-9a-f]{6})$/i

/** The channels of a colour written as 6 hex digits (a leading `#` is allowed and ignored), or null for anything else. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (typeof hex !== 'string') return null
  const m = HEX6.exec(hex)
  if (!m) return null
  const v = parseInt(m[1]!, 16)
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }
}

function channelHex(v: number): string {
  const n = Number.isFinite(v) ? Math.round(v) : 0
  return Math.min(255, Math.max(0, n)).toString(16).padStart(2, '0')
}

/** Six lower-case hex digits, no `#`. Channels are rounded and held to 0..255; a number gone bad is 0. */
export function rgbToHex(r: number, g: number, b: number): string {
  return channelHex(r) + channelHex(g) + channelHex(b)
}

/** sRGB channel (0..255) to linear light. */
function linear(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance, 0 (black) to 1 (white). A colour that is not 6 hex digits counts as black. */
export function luminance(hex: string): number {
  const c = hexToRgb(hex)
  if (!c) return 0
  return Math.min(1, 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b))
}

/** `'000000'` or `'ffffff'`, whichever reads better on `hex` (the larger WCAG contrast ratio; black from a luminance of about 0.179 up). */
export function textColourOn(hex: string): string {
  const l = luminance(hex)
  const withBlack = (l + 0.05) / 0.05
  const withWhite = 1.05 / (l + 0.05)
  return withBlack >= withWhite ? '000000' : 'ffffff'
}

/* ------------------------------------------------------------ median cut --- */

/** The most pixels looked at. A photo has millions; a palette does not need them, and the cost must not grow with the picture. */
const SAMPLE_PIXELS = 10_000
/** A pixel this transparent (alpha below it) is not part of the picture's colours. */
const MIN_ALPHA = 128
/** The most colours asked for (a swatch row, not a quantiser). */
const MAX_COLOURS = 256

/** A small deterministic generator (mulberry32): the sample must be the same every time for the same pixels. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** How many times each opaque colour (packed r, g, b) occurs in the sample. */
function sampleColours(rgba: Uint8ClampedArray): Map<number, number> {
  const pixels = Math.floor(rgba.length / 4)
  const taken = Math.min(pixels, SAMPLE_PIXELS)
  const counts = new Map<number, number>()
  const rnd = seeded(0x9e3779b9)
  for (let k = 0; k < taken; k++) {
    let i = k
    if (pixels > taken) {
      // One pixel from each equal stretch of the picture, at a pseudo-random place in it: a fixed stride would see a single column
      // whenever it divided the picture's width.
      const from = Math.floor((k * pixels) / taken)
      const to = Math.floor(((k + 1) * pixels) / taken)
      i = from + Math.floor(rnd() * (to - from))
    }
    const o = i * 4
    if (rgba[o + 3]! < MIN_ALPHA) continue
    const key = (rgba[o]! << 16) | (rgba[o + 1]! << 8) | rgba[o + 2]!
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

interface Entry {
  r: number
  g: number
  b: number
  n: number
}

interface Box {
  entries: Entry[]
  /** Pixels in the box. */
  pop: number
  /** The channel (0 red, 1 green, 2 blue) with the widest spread, and that spread. */
  axis: number
  extent: number
}

function channelOf(e: Entry, axis: number): number {
  return axis === 0 ? e.r : axis === 1 ? e.g : e.b
}

function makeBox(entries: Entry[]): Box {
  let pop = 0
  const lo = [255, 255, 255]
  const hi = [0, 0, 0]
  for (const e of entries) {
    pop += e.n
    for (let c = 0; c < 3; c++) {
      const v = channelOf(e, c)
      if (v < lo[c]!) lo[c] = v
      if (v > hi[c]!) hi[c] = v
    }
  }
  let axis = 0
  let extent = -1
  for (let c = 0; c < 3; c++) {
    const spread = hi[c]! - lo[c]!
    if (spread > extent) {
      extent = spread
      axis = c
    }
  }
  return { entries, pop, axis, extent }
}

/** Cuts a box along its widest channel at the weighted median, so each half holds about half of the pixels. */
function splitBox(box: Box): [Box, Box] {
  const a = box.axis
  // Ties on the cut channel are broken by the other two, so the order (and so the cut) never depends on how the map was filled.
  const key = (e: Entry): number => (channelOf(e, a) << 16) | (channelOf(e, (a + 1) % 3) << 8) | channelOf(e, (a + 2) % 3)
  const sorted = box.entries.slice().sort((p, q) => key(p) - key(q))
  let seen = 0
  let cut = 0
  for (; cut < sorted.length - 2; cut++) {
    seen += sorted[cut]!.n
    if (seen * 2 >= box.pop) break
  }
  return [makeBox(sorted.slice(0, cut + 1)), makeBox(sorted.slice(cut + 1))]
}

/** The mean colour of a box, as hex. */
function boxColour(box: Box): string {
  let r = 0
  let g = 0
  let b = 0
  for (const e of box.entries) {
    r += e.r * e.n
    g += e.g * e.n
    b += e.b * e.n
  }
  return rgbToHex(r / box.pop, g / box.pop, b / box.pop)
}

/**
 * The colours a picture is mostly made of, most populous first, at most `count` and all different (fewer when the picture does not
 * have that many). `rgba` is the picture's pixels, 4 bytes each; a pixel with alpha under 128 is ignored, and at most about 10,000
 * pixels (evenly spread, chosen the same way every time) are looked at. Median cut: the colours are boxed, and the box with the most
 * pixels times spread is cut at its weighted median until there are `count` boxes or none can be cut; a box's colour is its mean.
 * Equal populations are ordered by hex, so the answer never depends on anything but the pixels.
 */
export function dominantColours(rgba: Uint8ClampedArray, count: number): string[] {
  const want = Number.isFinite(count) ? Math.min(MAX_COLOURS, Math.floor(count)) : 0
  if (want < 1) return []
  const entries: Entry[] = []
  for (const [key, n] of sampleColours(rgba)) entries.push({ r: key >> 16, g: (key >> 8) & 255, b: key & 255, n })
  if (entries.length === 0) return []

  const boxes: Box[] = [makeBox(entries)]
  let target = want
  for (;;) {
    let stuck = false
    while (boxes.length < target) {
      let pick = -1
      let best = 0
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!
        const priority = b.extent > 0 && b.entries.length > 1 ? b.pop * b.extent : 0
        if (priority > best) {
          best = priority
          pick = i
        }
      }
      if (pick < 0) {
        stuck = true
        break
      }
      const [left, right] = splitBox(boxes[pick]!)
      boxes[pick] = left
      boxes.push(right)
    }
    // Two boxes can round to one colour; they count once, and the boxes missing for it are made up by cutting further.
    const merged = new Map<string, number>()
    for (const b of boxes) {
      const hex = boxColour(b)
      merged.set(hex, (merged.get(hex) ?? 0) + b.pop)
    }
    if (merged.size >= want || stuck) {
      return [...merged]
        .sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))
        .slice(0, want)
        .map(([hex]) => hex)
    }
    target = boxes.length + (want - merged.size)
  }
}

/** The most pixels from the pointer that a sample may reach: the sampler's neighbourhood is a few pixels, never the picture. */
const MAX_SAMPLE_RADIUS = 256

/**
 * The mean colour of the opaque pixels (alpha 128 or more) whose centres lie within `radius` pixels of the point (cx, cy) in a
 * picture `w` by `h` pixels (a pixel (i, j) covers [i, i+1) by [j, j+1)). The point is held inside the picture, so one a little off an
 * edge reads the edge; the pixel under the point always counts, so a radius of 0 reads exactly that pixel. Null when the picture has no
 * pixels, the point is not a number, or every pixel in reach is transparent. `radius` is held to 256.
 */
export function averageColour(rgba: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, radius: number): string | null {
  if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(cx) || !Number.isFinite(cy)) return null
  const width = Math.floor(w)
  if (width < 1) return null
  // Rows the buffer does not hold are not there.
  const height = Math.min(Math.floor(h), Math.floor(rgba.length / (4 * width)))
  if (height < 1) return null
  const px = Math.min(Math.max(cx, 0), width)
  const py = Math.min(Math.max(cy, 0), height)
  const home = { x: Math.min(Math.floor(px), width - 1), y: Math.min(Math.floor(py), height - 1) }
  const reach = Number.isFinite(radius) ? Math.min(Math.max(radius, 0), MAX_SAMPLE_RADIUS) : 0
  const r2 = reach * reach
  let sr = 0
  let sg = 0
  let sb = 0
  let n = 0
  // The window always holds the pixel under the point, even when the point sits on the far edge (px === width).
  const y0 = Math.max(0, Math.min(home.y, Math.floor(py - reach)))
  const y1 = Math.min(height - 1, Math.max(home.y, Math.ceil(py + reach)))
  const x0 = Math.max(0, Math.min(home.x, Math.floor(px - reach)))
  const x1 = Math.min(width - 1, Math.max(home.x, Math.ceil(px + reach)))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const near = (x === home.x && y === home.y) || (x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2 <= r2
      if (!near) continue
      const o = (y * width + x) * 4
      if (rgba[o + 3]! < MIN_ALPHA) continue
      sr += rgba[o]!
      sg += rgba[o + 1]!
      sb += rgba[o + 2]!
      n++
    }
  }
  return n === 0 ? null : rgbToHex(sr / n, sg / n, sb / n)
}
