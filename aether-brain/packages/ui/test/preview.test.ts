import { describe, expect, it } from 'vitest'
import { EDIT_MAX, EMBED_MAX, PREVIEW_FIRST, PREVIEW_MAX, PREVIEW_STEP, groups, previewCut, tooBigToEdit } from '../src/preview'

/** What the preview draws of a long note: a bounded prefix, cut where a reader would not notice. */
describe('previewCut', () => {
  it('keeps the budgets of the preview as numbers (a note of 16 MB took 10 GB to draw whole)', () => {
    expect(PREVIEW_FIRST).toBe(60_000)
    expect(PREVIEW_STEP).toBe(60_000)
    expect(PREVIEW_MAX).toBe(300_000)
    expect(EMBED_MAX).toBe(20_000)
    expect(PREVIEW_MAX % PREVIEW_STEP).toBe(0)
  })

  it('leaves a short text alone, even exactly at the limit', () => {
    expect(previewCut('hello', 100)).toEqual({ text: 'hello', total: 5, cut: false })
    const s = 'a'.repeat(100)
    expect(previewCut(s, 100)).toEqual({ text: s, total: 100, cut: false })
    expect(previewCut('', 10)).toEqual({ text: '', total: 0, cut: false })
  })

  it('cuts a long text to no more than the limit, and the cut is a prefix of it', () => {
    const para = (i: number) => `paragraph ${i} ${'word '.repeat(40)}`.trim()
    const text = Array.from({ length: 400 }, (_, i) => para(i)).join('\n\n')
    for (const limit of [500, 5_000, 60_000]) {
      const c = previewCut(text, limit)
      expect(c.cut).toBe(true)
      expect(c.total).toBe(text.length)
      expect(c.text.length).toBeLessThanOrEqual(limit)
      expect(text.startsWith(c.text)).toBe(true)
    }
  })

  it('prefers a blank line, then a line end, then a space, then anywhere', () => {
    const blank = `${'a'.repeat(90)}\n\n${'b'.repeat(200)}`
    expect(previewCut(blank, 100).text).toBe('a'.repeat(90))
    const line = `${'a'.repeat(90)}\n${'b'.repeat(200)}`
    expect(previewCut(line, 100).text).toBe('a'.repeat(90))
    const space = `${'a'.repeat(90)} ${'b'.repeat(200)}`
    expect(previewCut(space, 100).text).toBe('a'.repeat(90))
    // The break is too far back to be worth it: cut at the limit.
    const far = `${'a'.repeat(10)}\n\n${'b'.repeat(300)}`
    expect(previewCut(far, 100).text).toBe(far.slice(0, 100))
    expect(previewCut('x'.repeat(300), 100).text).toBe('x'.repeat(100))
  })

  it('never splits an emoji in half', () => {
    const text = `${'a'.repeat(99)}😀${'b'.repeat(50)}`
    const c = previewCut(text, 100)
    expect(c.text).toBe('a'.repeat(99))
    for (let i = 0; i < c.text.length; i++) {
      const code = c.text.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) expect(c.text.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00)
    }
  })

  it('closes a code block the cut left open, with the same fence (a quoted one too), and only then', () => {
    const open = `intro\n\n\`\`\`js\n${'const a = 1\n'.repeat(50)}`
    const c = previewCut(open, 200)
    expect(c.cut).toBe(true)
    expect(c.text.endsWith('\n```')).toBe(true)
    const quoted = `> intro\n>\n> \`\`\`js\n${'> const a = 1\n'.repeat(50)}`
    const q = previewCut(quoted, 200)
    expect(q.text.endsWith('\n> ```')).toBe(true)
    const tilde = `~~~~\n${'x\n'.repeat(200)}`
    expect(previewCut(tilde, 100).text.endsWith('\n~~~~')).toBe(true)
    // A block that is closed before the cut needs nothing.
    const closed = `\`\`\`\ncode\n\`\`\`\n\n${'text '.repeat(100)}`
    const k = previewCut(closed, 100)
    expect(k.text.endsWith('```')).toBe(false)
    expect((k.text.match(/```/g) ?? []).length).toBe(2)
  })

  it('treats a bad limit as nothing to draw, not a crash', () => {
    expect(previewCut('hello world', 0).text).toBe('')
    expect(previewCut('hello world', -5).cut).toBe(true)
    expect(previewCut('hello world', Number.NaN).text).toBe('')
    expect(previewCut('hello world', Infinity).text).toBe('')
  })

  it('is fast on a very long text (a 20 MB chat)', () => {
    const big = 'lorem ipsum dolor sit amet. '.repeat(750_000)
    const t0 = performance.now()
    const c = previewCut(big, PREVIEW_MAX)
    expect(performance.now() - t0).toBeLessThan(500)
    expect(c.text.length).toBeLessThanOrEqual(PREVIEW_MAX)
    expect(c.total).toBe(big.length)
  })

  it('writes counts with separators', () => {
    expect(groups(16_000_000)).toBe('16,000,000')
    expect(groups(999)).toBe('999')
  })
})

describe('tooBigToEdit', () => {
  it('opens a note read-only past 400,000 characters, never before (a text box of 16 MB took 9 GB)', () => {
    expect(EDIT_MAX).toBe(400_000)
    expect(tooBigToEdit(0)).toBe(false)
    expect(tooBigToEdit(EDIT_MAX)).toBe(false)
    expect(tooBigToEdit(EDIT_MAX + 1)).toBe(true)
    expect(tooBigToEdit(16 * 1024 * 1024)).toBe(true)
  })
})
