import { describe, expect, it } from 'vitest'
import { truncate } from '../src/util'

describe('truncate', () => {
  it('keeps a short text and cuts a long one with an ellipsis, n characters at most', () => {
    expect(truncate('short', 10)).toBe('short')
    expect(truncate('exactly10!', 10)).toBe('exactly10!')
    expect(truncate('a longer text than that', 10)).toBe('a longer …')
    expect(truncate('a longer text than that', 10).length).toBe(10)
  })

  it('never cuts an emoji in half: a lone half draws as a replacement character', () => {
    const smile = '\u{1F600}'
    for (let n = 2; n < 12; n++) {
      const out = truncate(`ab${smile}${smile}${smile}${smile}${smile}`, n)
      expect(out.endsWith('\u2026')).toBe(true)
      // Every high half is followed by its low half.
      expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false)
      expect(out.length).toBeLessThanOrEqual(n)
    }
    expect(truncate('x', 0)).toBe('\u2026')
  })
})
