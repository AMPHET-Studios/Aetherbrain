import { describe, expect, it } from 'vitest'
import { LABEL_PRIORITY, LabelPlacer } from '../src/scene/labelPlace'

/** Labels are offered most important first and kept only when their box clears the boxes already kept. */
describe('placing labels without piling them', () => {
  it('keeps the first box and refuses one that overlaps it', () => {
    const p = new LabelPlacer()
    expect(p.tryPlace(100, 100, 80, 14)).toBe(true)
    expect(p.tryPlace(120, 104, 80, 14)).toBe(false)
    expect(p.count).toBe(1)
  })

  it('keeps a box clear of the others, to the side, above and below', () => {
    const p = new LabelPlacer()
    expect(p.tryPlace(100, 100, 80, 14)).toBe(true)
    expect(p.tryPlace(200, 100, 80, 14)).toBe(true)
    expect(p.tryPlace(100, 140, 80, 14)).toBe(true)
    expect(p.tryPlace(100, 60, 80, 14)).toBe(true)
    expect(p.count).toBe(4)
  })

  it('wants a margin between boxes: touching is too close, three pixels of air is enough', () => {
    const p = new LabelPlacer()
    p.add(100, 100, 80, 14)
    // Directly under it (it ends at 114): edge to edge and two pixels of air are crowded, three are enough.
    expect(p.fits(100, 114, 80, 14)).toBe(false)
    expect(p.fits(100, 116, 80, 14)).toBe(false)
    expect(p.fits(100, 117, 80, 14)).toBe(true)
    // With no margin at all, edge to edge fits.
    expect(p.fits(100, 114, 80, 14, 0)).toBe(true)
    expect(p.fits(100, 113, 80, 14, 0)).toBe(false)
  })

  it('keeps the same margin to the side: a label that touches another one’s end is too close, three pixels of air is enough', () => {
    const p = new LabelPlacer()
    p.add(100, 100, 80, 14)
    // To its right (it ends at 180).
    expect(p.fits(180, 100, 80, 14)).toBe(false)
    expect(p.fits(182, 100, 80, 14)).toBe(false)
    expect(p.fits(183, 100, 80, 14)).toBe(true)
    // To its left (the new box ends at 100 when it starts at 20).
    expect(p.fits(20, 100, 80, 14)).toBe(false)
    expect(p.fits(17, 100, 80, 14)).toBe(true)
  })

  it('fits asks and does not keep; add keeps without asking', () => {
    const p = new LabelPlacer()
    expect(p.fits(0, 0, 50, 10)).toBe(true)
    expect(p.count).toBe(0)
    p.add(0, 0, 50, 10)
    p.add(0, 0, 50, 10)
    expect(p.count).toBe(2)
    expect(p.fits(10, 2, 20, 6)).toBe(false)
  })

  it('forgets everything on reset and can be used again', () => {
    const p = new LabelPlacer()
    p.tryPlace(10, 10, 40, 12)
    p.reset()
    expect(p.count).toBe(0)
    expect(p.tryPlace(10, 10, 40, 12)).toBe(true)
  })

  it('keeps more boxes than its first storage holds', () => {
    const p = new LabelPlacer()
    for (let i = 0; i < 700; i++) expect(p.tryPlace(i * 100, 0, 50, 10)).toBe(true)
    expect(p.count).toBe(700)
    // The first ones are still remembered after the storage grew.
    expect(p.fits(10, 2, 20, 6)).toBe(false)
    expect(p.fits(69_900, 2, 20, 6)).toBe(false)
    expect(p.fits(69_970, 2, 20, 6)).toBe(true)
  })

  it('lets the most important label win a crowded spot when they are offered in order', () => {
    const p = new LabelPlacer()
    // Two labels for the same spot: whichever is offered first stays.
    const offered = [
      { name: 'selected', priority: LABEL_PRIORITY.selected, x: 50, y: 50 },
      { name: 'note', priority: LABEL_PRIORITY.note, x: 55, y: 52 },
      { name: 'landmark', priority: LABEL_PRIORITY.landmark, x: 300, y: 50 },
    ].sort((a, b) => b.priority - a.priority)
    const kept = offered.filter((o) => p.tryPlace(o.x, o.y, 90, 14)).map((o) => o.name)
    expect(kept).toEqual(['selected', 'landmark'])
  })
})

describe('the priority bands', () => {
  it('run from what the user points at down to the plain notes, each band above the next', () => {
    const order = [
      LABEL_PRIORITY.selected,
      LABEL_PRIORITY.hovered,
      LABEL_PRIORITY.landmark,
      LABEL_PRIORITY.linked,
      LABEL_PRIORITY.planet,
      LABEL_PRIORITY.note,
    ]
    for (let i = 1; i < order.length; i++) expect(order[i - 1]).toBeGreaterThan(order[i]!)
  })

  it('leave room inside a band for the size on screen to order labels', () => {
    const bands = Object.values(LABEL_PRIORITY).sort((a, b) => b - a)
    for (let i = 1; i < bands.length; i++) expect(bands[i - 1]! - bands[i]!).toBeGreaterThanOrEqual(100_000)
  })
})
