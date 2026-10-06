import { describe, expect, it } from 'vitest'
import { DEFAULT_VIEWPORT_PX, OVERSCAN_ROWS, rowWindow, scrollToReveal } from '../src/windowing'

describe('rowWindow', () => {
  it('draws the rows in view plus a margin, and stands in for the rest with spacers that keep the scroll height', () => {
    const w = rowWindow(20000, 100, 0, 500)
    expect(w.start).toBe(0)
    expect(w.end).toBe(5 + OVERSCAN_ROWS)
    expect(w.padTop).toBe(0)
    expect(w.padBottom).toBe((20000 - w.end) * 100)
    // Whatever the scroll position, the drawn rows plus the spacers always add up to the whole list.
    for (const top of [0, 1, 99, 100, 12345, 1_000_000, 1_999_999, 5_000_000]) {
      const x = rowWindow(20000, 100, top, 500)
      expect(x.padTop + (x.end - x.start) * 100 + x.padBottom).toBe(20000 * 100)
      expect(x.end - x.start).toBeLessThanOrEqual(5 + 1 + 2 * OVERSCAN_ROWS)
    }
  })

  it('starts the window at the row under the top edge, minus the margin', () => {
    const w = rowWindow(1000, 50, 5000, 400)
    // Row 100 is at the top edge; rows 100..107 are in view.
    expect(w.start).toBe(100 - OVERSCAN_ROWS)
    expect(w.end).toBe(108 + OVERSCAN_ROWS)
  })

  it('stays inside the list: past the end, an empty list, a short list, and nonsense input', () => {
    expect(rowWindow(0, 100, 0, 500)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
    expect(rowWindow(3, 100, 0, 500)).toEqual({ start: 0, end: 3, padTop: 0, padBottom: 0 })
    const past = rowWindow(50, 100, 10_000_000, 500)
    expect(past.end).toBe(50)
    expect(past.start).toBeLessThanOrEqual(50)
    expect(past.start).toBeGreaterThanOrEqual(0)
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const w = rowWindow(1000, 100, bad, bad)
      expect(w.start).toBeGreaterThanOrEqual(0)
      expect(w.end).toBeLessThanOrEqual(1000)
      expect(w.end).toBeGreaterThanOrEqual(w.start)
    }
    expect(rowWindow(Number.NaN, 100, 0, 500)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
    // An unknown view height is assumed, never zero rows.
    const unknown = rowWindow(1000, 100, 0, 0)
    expect(unknown.end).toBe(Math.ceil(DEFAULT_VIEWPORT_PX / 100) + OVERSCAN_ROWS)
  })
})

describe('scrollToReveal', () => {
  it('leaves the scroll alone when the row is already in view', () => {
    expect(scrollToReveal(3, 100, 0, 500)).toBe(0)
    expect(scrollToReveal(5, 100, 200, 500)).toBe(200)
  })

  it('moves the least it can: up to a row above the view, down to a row below it', () => {
    expect(scrollToReveal(1, 100, 500, 500)).toBe(100)
    expect(scrollToReveal(10, 100, 0, 500)).toBe(600)
    expect(scrollToReveal(0, 100, 900, 500)).toBe(0)
    // A row only partly below the bottom edge still counts as not in view.
    expect(scrollToReveal(5, 100, 0, 550)).toBe(50)
  })

  it('never scrolls to a negative position', () => {
    expect(scrollToReveal(-3, 100, 0, 500)).toBe(0)
    expect(scrollToReveal(0, 100, 0, 50)).toBe(0)
  })
})
