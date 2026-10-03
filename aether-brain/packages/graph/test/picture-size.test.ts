import { describe, expect, it } from 'vitest'
import { computeSystemLayout, systemPositions, type SystemInput } from '../src/layout/system'
import { PICTURE_RADIUS, PICTURE_SIZES, isPictureSize, nodeRadius, type PictureSize } from '../src'
import { THUMB_SCALE } from '../src/scene/thumbs'

/** A folder planet with `count` picture moons (layout kind 4), around a sun. */
function folderOfPictures(count: number, size: PictureSize): SystemInput {
  const n = 2 + count
  const parent = new Int32Array(n)
  const kind = new Uint8Array(n)
  const role = new Int8Array(n)
  const radius = new Float32Array(n)
  parent[0] = -1
  kind[0] = 2
  role[0] = 0
  radius[0] = 8
  parent[1] = 0
  kind[1] = 2
  role[1] = 3
  radius[1] = 3
  const ids = ['folder:', 'folder:Art']
  for (let i = 0; i < count; i++) {
    parent[2 + i] = 1
    kind[2 + i] = 4
    role[2 + i] = -1
    radius[2 + i] = nodeRadius({ kind: 'image' } as never, size)
    ids.push(`image:Art/p${i}.png`)
  }
  return { parent, kind, role, radius, ids }
}

describe('picture sizes', () => {
  it('names three sizes, medium being the old one, each bigger than the last', () => {
    expect(PICTURE_SIZES).toEqual(['medium', 'large', 'xl'])
    expect(nodeRadius({ kind: 'image' } as never)).toBe(1.4)
    expect(nodeRadius({ kind: 'image' } as never, 'medium')).toBe(PICTURE_RADIUS.medium)
    expect(PICTURE_RADIUS.medium).toBeLessThan(PICTURE_RADIUS.large)
    expect(PICTURE_RADIUS.large).toBeLessThan(PICTURE_RADIUS.xl)
    // Only pictures change.
    const note = { kind: 'note', ghost: false, degree: 4, type: 'note' } as never
    expect(nodeRadius(note, 'xl')).toBe(nodeRadius(note, 'medium'))
    expect(isPictureSize('large')).toBe(true)
    expect(isPictureSize('huge')).toBe(false)
  })

  it('gives bigger pictures room: wider orbits, and no two pictures overlap at any size', () => {
    const extents: number[] = []
    for (const size of PICTURE_SIZES) {
      const input = folderOfPictures(12, size)
      const layout = computeSystemLayout(input)
      extents.push(layout.extent[1]!)
      const pos = new Float32Array(input.ids.length * 3)
      systemPositions(layout, 0, pos)
      // A picture is drawn THUMB_SCALE × its radius wide: half of that on each side.
      const half = (PICTURE_RADIUS[size] * THUMB_SCALE) / 2
      for (let a = 2; a < input.ids.length; a++) {
        for (let b = a + 1; b < input.ids.length; b++) {
          const d = Math.hypot(pos[a * 3]! - pos[b * 3]!, pos[a * 3 + 1]! - pos[b * 3 + 1]!, pos[a * 3 + 2]! - pos[b * 3 + 2]!)
          // Two squares `half` wide on each side never overlap when their centres are 2 × half apart.
          expect(d).toBeGreaterThanOrEqual(half * 2)
        }
      }
    }
    expect(extents[1]!).toBeGreaterThan(extents[0]!)
    expect(extents[2]!).toBeGreaterThan(extents[1]!)
  })
})
