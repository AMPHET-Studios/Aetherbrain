import { describe, expect, it } from 'vitest'
import { averageColour, dominantColours, hexToRgb, luminance, rgbToHex, textColourOn } from '../src/board/palette'

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Px = [number, number, number, number?]

/** RGBA bytes from pixels given as [r, g, b, a?]. */
function pixels(list: Px[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(list.length * 4)
  list.forEach((p, i) => out.set([p[0], p[1], p[2], p[3] ?? 255], i * 4))
  return out
}

/** `n` copies of one pixel. */
function flat(n: number, p: Px): Px[] {
  return Array.from({ length: n }, () => p)
}

const RED: Px = [255, 0, 0]
const BLUE: Px = [0, 0, 255]
const GREEN: Px = [0, 255, 0]

/* ------------------------------------------------------------- hex helpers --- */

describe('hexToRgb', () => {
  it('reads six digits, with or without #, in either case', () => {
    expect(hexToRgb('ff8800')).toEqual({ r: 255, g: 136, b: 0 })
    expect(hexToRgb('#FF8800')).toEqual({ r: 255, g: 136, b: 0 })
    expect(hexToRgb('00000a')).toEqual({ r: 0, g: 0, b: 10 })
    expect(hexToRgb('ffffff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(hexToRgb('000000')).toEqual({ r: 0, g: 0, b: 0 })
  })
  it('rejects anything that is not exactly six hex digits', () => {
    for (const bad of ['', '#', 'fff', '#fff', 'gg0000', 'ff88000', 'ff88', ' ff8800', 'ff8800 ', 'ff8800\n', 'ff8800ff', '##ff8800', '0xff8800', 'ff 880']) {
      expect(hexToRgb(bad), JSON.stringify(bad)).toBeNull()
    }
    expect(hexToRgb(undefined as unknown as string)).toBeNull()
    expect(hexToRgb(null as unknown as string)).toBeNull()
    expect(hexToRgb(0xff8800 as unknown as string)).toBeNull()
  })
})

describe('rgbToHex', () => {
  it('writes six lower-case digits without #, padded', () => {
    expect(rgbToHex(255, 136, 0)).toBe('ff8800')
    expect(rgbToHex(0, 0, 0)).toBe('000000')
    expect(rgbToHex(1, 2, 3)).toBe('010203')
    expect(rgbToHex(171, 205, 239)).toBe('abcdef')
  })
  it('rounds, holds each channel to 0..255 and turns a number gone bad into 0', () => {
    expect(rgbToHex(300, -5, 12.6)).toBe('ff000d')
    expect(rgbToHex(0.49, 0.5, 254.5)).toBe('0001ff')
    expect(rgbToHex(NaN, Infinity, -Infinity)).toBe('000000')
  })
  it('round-trips with hexToRgb over every channel value and over random colours', () => {
    for (let v = 0; v < 256; v++) {
      expect(hexToRgb(rgbToHex(v, 255 - v, v))).toEqual({ r: v, g: 255 - v, b: v })
    }
    const r = rng(7)
    for (let i = 0; i < 500; i++) {
      const hex = rgbToHex(r() * 255, r() * 255, r() * 255)
      expect(hex).toMatch(/^[0-9a-f]{6}$/)
      const c = hexToRgb(hex)!
      expect(rgbToHex(c.r, c.g, c.b)).toBe(hex)
    }
  })
})

/* ----------------------------------------------------------------- contrast --- */

describe('luminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(luminance('000000')).toBe(0)
    expect(luminance('ffffff')).toBeCloseTo(1, 10)
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 10)
  })
  it('weights the channels as WCAG does', () => {
    expect(luminance('ff0000')).toBeCloseTo(0.2126, 4)
    expect(luminance('00ff00')).toBeCloseTo(0.7152, 4)
    expect(luminance('0000ff')).toBeCloseTo(0.0722, 4)
  })
  it('linearises sRGB: the curve above the knee and the straight part below it', () => {
    // 128/255 -> ((0.50196 + 0.055) / 1.055) ^ 2.4
    expect(luminance('808080')).toBeCloseTo(0.21586, 4)
    // 10/255 is under the knee (0.04045): 0.0392 / 12.92
    expect(luminance('0a0a0a')).toBeCloseTo(0.003035, 5)
    // a plain average of the channels would say 0.5 for mid grey
    expect(luminance('808080')).toBeLessThan(0.25)
  })
  it('grows with the grey level and stays in 0..1', () => {
    let last = -1
    for (let v = 0; v < 256; v++) {
      const l = luminance(rgbToHex(v, v, v))
      expect(l).toBeGreaterThan(last)
      expect(l).toBeGreaterThanOrEqual(0)
      expect(l).toBeLessThanOrEqual(1)
      last = l
    }
  })
  it('counts a colour that is not six hex digits as black', () => {
    expect(luminance('nonsense')).toBe(0)
    expect(luminance('')).toBe(0)
  })
})

/** WCAG contrast ratio, written out here independently of the code under test. */
function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

describe('textColourOn', () => {
  it('is white on dark colours and black on light ones', () => {
    expect(textColourOn('000000')).toBe('ffffff')
    expect(textColourOn('14161d')).toBe('ffffff')
    expect(textColourOn('0000ff')).toBe('ffffff')
    expect(textColourOn('ffffff')).toBe('000000')
    expect(textColourOn('ffff00')).toBe('000000')
    expect(textColourOn('#f0f0f0')).toBe('000000')
  })
  it('picks by contrast, not by brightness of one channel: pure red takes black', () => {
    expect(contrast('ff0000', '000000')).toBeGreaterThan(contrast('ff0000', 'ffffff'))
    expect(textColourOn('ff0000')).toBe('000000')
    // a dark green is fine for white
    expect(textColourOn('006400')).toBe('ffffff')
  })
  it('switches between grey 117 and 118, where the two contrasts cross', () => {
    expect(textColourOn('757575')).toBe('ffffff')
    expect(textColourOn('767676')).toBe('000000')
  })
  it('always returns the colour with the larger contrast (random colours)', () => {
    const r = rng(11)
    for (let i = 0; i < 400; i++) {
      const hex = rgbToHex(r() * 255, r() * 255, r() * 255)
      const pick = textColourOn(hex)
      const other = pick === '000000' ? 'ffffff' : '000000'
      expect(['000000', 'ffffff']).toContain(pick)
      expect(contrast(hex, pick), hex).toBeGreaterThanOrEqual(contrast(hex, other) - 1e-9)
    }
  })
  it('treats a bad colour as black, so the text is white', () => {
    expect(textColourOn('???')).toBe('ffffff')
  })
})

/* ------------------------------------------------------------ dominantColours --- */

describe('dominantColours', () => {
  it('finds two flat colours, the more populous first, and no more than there are', () => {
    const img = pixels([...flat(60, RED), ...flat(40, BLUE)])
    expect(dominantColours(img, 5)).toEqual(['ff0000', '0000ff'])
    expect(dominantColours(img, 2)).toEqual(['ff0000', '0000ff'])
    const flipped = pixels([...flat(40, RED), ...flat(60, BLUE)])
    expect(dominantColours(flipped, 2)).toEqual(['0000ff', 'ff0000'])
  })
  it('orders equal populations by hex, so the answer does not depend on pixel order', () => {
    const a = pixels([...flat(50, RED), ...flat(50, BLUE)])
    const b = pixels([...flat(50, BLUE), ...flat(50, RED)])
    expect(dominantColours(a, 2)).toEqual(['0000ff', 'ff0000'])
    expect(dominantColours(b, 2)).toEqual(['0000ff', 'ff0000'])
  })
  it('one colour asked for is the mean of the picture', () => {
    // 60% red, 40% blue: (153, 0, 102)
    expect(dominantColours(pixels([...flat(6, RED), ...flat(4, BLUE)]), 1)).toEqual(['990066'])
  })
  it('keeps three flat colours exact and in the order of their populations', () => {
    const img = pixels([...flat(30, BLUE), ...flat(70, [200, 100, 60]), ...flat(10, GREEN), ...flat(20, BLUE)])
    // 70 x c8643c, 50 x blue (30 + 20, not next to each other), 10 x green
    expect(dominantColours(img, 3)).toEqual(['c8643c', '0000ff', '00ff00'])
    expect(dominantColours(img, 10)).toEqual(['c8643c', '0000ff', '00ff00'])
  })
  it('splits a gradient into equal bands, each given as its mean', () => {
    const ramp = pixels(Array.from({ length: 256 }, (_, i): Px => [i, 0, 0]))
    expect(dominantColours(ramp, 2)).toEqual(['400000', 'c00000'])
    expect(dominantColours(ramp, 4)).toEqual(['200000', '600000', 'a00000', 'e00000'])
  })
  it('cuts the widest channel: a ramp in green is cut in green, not in red', () => {
    const ramp = pixels(Array.from({ length: 256 }, (_, i): Px => [10, i, 10]))
    expect(dominantColours(ramp, 2)).toEqual(['0a400a', '0ac00a'])
  })
  it('cuts where the pixels are, not in the middle of the range: a big flat colour is told from a thin gradient', () => {
    const img = pixels([...flat(900, [10, 10, 10]), ...Array.from({ length: 100 }, (_, i): Px => [200 + (i % 50), 0, 0])])
    // the flat grey is a box of its own; the gradient (200..249, twice each) is the other, as its mean
    expect(dominantColours(img, 2)).toEqual(['0a0a0a', 'e10000'])
  })
  it('ignores pixels with alpha under 128 and counts those at 128', () => {
    const img = pixels([...flat(90, [0, 255, 0, 0]), ...flat(5, [0, 255, 0, 127]), ...flat(3, RED), ...flat(2, [0, 0, 255, 128])])
    expect(dominantColours(img, 4)).toEqual(['ff0000', '0000ff'])
  })
  it('gives nothing for an image that is wholly transparent, empty, or asked for nothing', () => {
    expect(dominantColours(pixels(flat(50, [255, 0, 0, 0])), 3)).toEqual([])
    expect(dominantColours(new Uint8ClampedArray(0), 3)).toEqual([])
    expect(dominantColours(pixels(flat(5, RED)), 0)).toEqual([])
    expect(dominantColours(pixels(flat(5, RED)), -2)).toEqual([])
    expect(dominantColours(pixels(flat(5, RED)), NaN)).toEqual([])
  })
  it('handles one pixel', () => {
    expect(dominantColours(pixels([[18, 52, 86]]), 5)).toEqual(['123456'])
    expect(dominantColours(pixels([[18, 52, 86, 20]]), 5)).toEqual([])
    expect(dominantColours(pixels([[18, 52, 86]]), 1)).toEqual(['123456'])
  })
  it('ignores bytes that do not make a whole pixel', () => {
    const img = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255])
    expect(dominantColours(img, 3)).toEqual(['ff0000'])
  })
  it('gives exactly min(count, distinct colours) different colours for any small image', () => {
    const r = rng(3)
    for (let t = 0; t < 120; t++) {
      const palette = 1 + Math.floor(r() * 40)
      const spread = [2, 6, 40, 255][t % 4]!
      const colours: Px[] = Array.from({ length: palette }, () => [Math.floor(r() * spread), Math.floor(r() * spread), Math.floor(r() * spread)])
      const n = 1 + Math.floor(r() * 400)
      const list: Px[] = Array.from({ length: n }, () => colours[Math.floor(r() * colours.length)]!)
      const distinct = new Set(list.map((p) => rgbToHex(p[0], p[1], p[2]))).size
      const count = 1 + Math.floor(r() * 20)
      const out = dominantColours(pixels(list), count)
      expect(new Set(out).size, `distinct output ${out.join(',')}`).toBe(out.length)
      expect(out.length).toBe(Math.min(count, distinct))
      for (const h of out) expect(h).toMatch(/^[0-9a-f]{6}$/)
    }
  })
  it('puts the more populous colour first (random two-colour images)', () => {
    const r = rng(5)
    for (let t = 0; t < 40; t++) {
      const a = 1 + Math.floor(r() * 200)
      const b = 1 + Math.floor(r() * 200)
      if (a === b) continue
      const out = dominantColours(pixels([...flat(a, RED), ...flat(b, BLUE)]), 2)
      expect(out).toEqual(a > b ? ['ff0000', '0000ff'] : ['0000ff', 'ff0000'])
    }
  })
  it('does not change its input and gives the same answer every time', () => {
    const r = rng(9)
    const img = pixels(Array.from({ length: 5000 }, (): Px => [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)]))
    const before = img.slice()
    const a = dominantColours(img, 8)
    expect(img).toEqual(before)
    expect(dominantColours(img, 8)).toEqual(a)
    expect(a).toHaveLength(8)
  })

  describe('large pictures', () => {
    it('looks at no more than about 10,000 pixels', () => {
      const w = 1000
      const h = 1000
      const data = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < w * h; i++) data.set([i % 251, (i >> 3) % 253, 7, 255], i * 4)
      const seen = new Set<number>()
      let reads = 0
      const spy = new Proxy(data, {
        get(target, prop) {
          if (typeof prop === 'string' && /^\d+$/.test(prop)) {
            reads++
            seen.add(Math.floor(Number(prop) / 4))
            return target[Number(prop)]
          }
          const v = Reflect.get(target, prop) as unknown
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
        },
      })
      const out = dominantColours(spy as unknown as Uint8ClampedArray, 6)
      expect(out).toHaveLength(6)
      expect(seen.size).toBeLessThanOrEqual(10_000)
      expect(reads).toBeLessThanOrEqual(4 * 10_000)
    })
    it('is the same every time', () => {
      const w = 600
      const h = 500
      const r = rng(21)
      const data = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < w * h; i++) data.set([Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256), 255], i * 4)
      expect(dominantColours(data, 7)).toEqual(dominantColours(data.slice(), 7))
    })
    it('is not fooled by a picture whose width divides the sampling stride', () => {
      // 100 x 10,000: a sample every 100th pixel would see only the first column, which is red.
      const w = 100
      const h = 10_000
      const data = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < w * h; i++) data.set(i % w < 50 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4)
      expect(new Set(dominantColours(data, 4))).toEqual(new Set(['ff0000', '0000ff']))
    })
    it('still finds the big colour areas of a large picture', () => {
      const w = 800
      const h = 600
      const data = new Uint8ClampedArray(w * h * 4)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) data.set(y < 400 ? [30, 90, 200, 255] : x < 600 ? [220, 180, 40, 255] : [10, 10, 10, 255], (y * w + x) * 4)
      }
      // 2/3 blue, 1/4 yellow, 1/12 black
      expect(dominantColours(data, 3)).toEqual(['1e5ac8', 'dcb428', '0a0a0a'])
    })
    it('asking for more colours than the cap still answers within bounds', () => {
      const r = rng(2)
      const data = new Uint8ClampedArray(9000 * 4)
      for (let i = 0; i < 9000; i++) data.set([Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256), 255], i * 4)
      const out = dominantColours(data, 1e9)
      expect(out.length).toBeLessThanOrEqual(256)
      expect(out.length).toBeGreaterThan(100)
      expect(new Set(out).size).toBe(out.length)
    })
  })
})

/* ------------------------------------------------------------- averageColour --- */

/** A w x h image whose pixel (x, y) is [10x, 10y, 0]. */
function grid(w: number, h: number): Uint8ClampedArray {
  const list: Px[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) list.push([10 * x, 10 * y, 0])
  return pixels(list)
}

describe('averageColour', () => {
  it('reads the pixel under the point when the radius is 0', () => {
    const img = grid(5, 5)
    expect(averageColour(img, 5, 5, 2.5, 3.5, 0)).toBe('141e00')
    expect(averageColour(img, 5, 5, 2, 3, 0)).toBe('141e00')
    expect(averageColour(img, 5, 5, 2.99, 3.99, 0)).toBe('141e00')
    expect(averageColour(img, 5, 5, 0, 0, 0)).toBe('000000')
  })
  it('averages the pixels whose centres lie within the radius', () => {
    const img = grid(5, 5)
    // radius 1 about the centre of pixel (2, 2): itself and its four neighbours; the diagonals are 1.41 away
    expect(averageColour(img, 5, 5, 2.5, 2.5, 1)).toBe('141400')
    // radius 1.5 takes the diagonals too: still symmetric about (2, 2)
    expect(averageColour(img, 5, 5, 2.5, 2.5, 1.5)).toBe('141400')
    // off-centre, about pixel (1, 2): itself, (0, 2), (2, 2), (1, 1), (1, 3): x mean 10, y mean 20
    expect(averageColour(img, 5, 5, 1.5, 2.5, 1)).toBe('0a1400')
  })
  it('weights every pixel in reach equally (a radius of 2 over a gradient)', () => {
    const img = grid(9, 1)
    // centre of pixel 4, radius 2: pixels 2..6 -> mean x 40
    expect(averageColour(img, 9, 1, 4.5, 0.5, 2)).toBe('280000')
  })
  it('clamps the point to the image', () => {
    const img = grid(4, 3)
    expect(averageColour(img, 4, 3, -50, -50, 0)).toBe('000000')
    expect(averageColour(img, 4, 3, 99, 99, 0)).toBe('1e1400')
    expect(averageColour(img, 4, 3, 4, 3, 0)).toBe('1e1400')
    expect(averageColour(img, 4, 3, 99, -99, 0)).toBe('1e0000')
    expect(averageColour(img, 4, 3, -1, 1.5, 0)).toBe('000a00')
  })
  it('clamps the reach to the image: a window over an edge averages only what is there', () => {
    const img = grid(5, 1)
    // pixels 0..2 within 2 of the centre of pixel 0
    expect(averageColour(img, 5, 1, 0.5, 0.5, 2)).toBe('0a0000')
    // a huge radius is the whole picture
    expect(averageColour(img, 5, 1, 2.5, 0.5, 1e9)).toBe('140000')
  })
  it('holds the radius to 256 pixels', () => {
    const w = 1000
    const list: Px[] = Array.from({ length: w }, (_, x): Px => (x < 300 ? RED : BLUE))
    // 256 pixels either side of x = 0.5 reach pixels 0..255 only: all red; unbounded it would take the blue too
    expect(averageColour(pixels(list), w, 1, 0.5, 0.5, 1e9)).toBe('ff0000')
  })
  it('ignores transparent pixels and gives null when all in reach are', () => {
    const list: Px[] = [
      [255, 0, 0, 255],
      [0, 255, 0, 0],
      [0, 0, 255, 127],
      [100, 100, 100, 128],
    ]
    const img = pixels(list)
    // pixels 0 and 3 count (alpha 255 and 128), 1 and 2 do not
    expect(averageColour(img, 4, 1, 2, 0.5, 10)).toBe('b23232')
    expect(averageColour(img, 4, 1, 1.5, 0.5, 0)).toBeNull()
    expect(averageColour(img, 4, 1, 2.5, 0.5, 0)).toBeNull()
    expect(averageColour(pixels(flat(9, [1, 2, 3, 0])), 3, 3, 1, 1, 5)).toBeNull()
  })
  it('gives null for an empty picture or a point that is not a number', () => {
    const img = grid(3, 3)
    expect(averageColour(img, 0, 3, 1, 1, 1)).toBeNull()
    expect(averageColour(img, 3, 0, 1, 1, 1)).toBeNull()
    expect(averageColour(new Uint8ClampedArray(0), 3, 3, 1, 1, 1)).toBeNull()
    expect(averageColour(img, NaN, 3, 1, 1, 1)).toBeNull()
    expect(averageColour(img, 3, 3, NaN, 1, 1)).toBeNull()
    expect(averageColour(img, 3, 3, 1, Infinity, 1)).toBeNull()
  })
  it('treats a radius that is negative or not a number as 0', () => {
    const img = grid(5, 5)
    expect(averageColour(img, 5, 5, 2.5, 2.5, -3)).toBe('141400')
    expect(averageColour(img, 5, 5, 2.5, 2.5, NaN)).toBe('141400')
  })
  it('does not read past a buffer shorter than w x h', () => {
    const img = grid(3, 2)
    expect(averageColour(img, 3, 10, 1.5, 8, 0)).toBe('0a0a00')
    expect(averageColour(img, 3, 10, 1.5, 8, 50)).toBe('0a0500')
    // a row that is not all there is not there
    expect(averageColour(img.slice(0, 8), 3, 2, 1.5, 1.5, 9)).toBeNull()
    expect(averageColour(img.slice(0, 16), 3, 2, 1.5, 1.5, 9)).toBe('0a0000')
  })
  it('does not change its input', () => {
    const img = grid(6, 6)
    const before = img.slice()
    averageColour(img, 6, 6, 3, 3, 4)
    expect(img).toEqual(before)
  })
})
