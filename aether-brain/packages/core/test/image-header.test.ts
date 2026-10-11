import { describe, expect, it } from 'vitest'
import { readImageHeader, MAX_DECODE_PIXELS } from '../src'

const png = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const v = new DataView(b.buffer)
  v.setUint32(16, w)
  v.setUint32(20, h)
  return b
}

describe('readImageHeader', () => {
  it('reads a PNG size from its first bytes without decoding', () => {
    expect(readImageHeader(png(12000, 9000))).toMatchObject({ kind: 'png', width: 12000, height: 9000, shownWidth: 12000, shownHeight: 9000 })
  })
  it('knows a header that claims more than the decode cap', () => {
    const h = readImageHeader(png(30000, 30000))!
    expect(h.width * h.height).toBeGreaterThan(MAX_DECODE_PIXELS)
  })
  it('returns null for anything that is not a picture or has no size', () => {
    expect(readImageHeader(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(readImageHeader(png(0, 5))).toBeNull()
    expect(readImageHeader(new Uint8Array(0))).toBeNull()
  })
})
