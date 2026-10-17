import { describe, expect, it } from 'vitest'
import { PICTURE_LABEL_MAX, shortFileLabel } from '../src/labels'

describe('a picture’s label', () => {
  it('leaves a name that fits as it is', () => {
    expect(shortFileLabel('gate.png')).toBe('gate.png')
    const exactly = 'x'.repeat(PICTURE_LABEL_MAX - 4) + '.png'
    expect(exactly).toHaveLength(PICTURE_LABEL_MAX)
    expect(shortFileLabel(exactly)).toBe(exactly)
  })

  it('leaves out the middle of a long generated name: its start, an ellipsis, and the end with the file type', () => {
    const name = 'Lucid_Origin_Heroic_frontfacing_AAA_3D_render_of_an_ancientfut_7_d10496eb-b5f2-4d54-bf26-c626485ed663.jpg'
    const label = shortFileLabel(name)
    expect(label).toHaveLength(PICTURE_LABEL_MAX)
    expect(label.startsWith('Lucid_Origin_H')).toBe(true)
    expect(label.endsWith('.jpg')).toBe(true)
    expect(label).toContain('…')
    // Two pictures of one batch tell apart by their tails.
    const other = shortFileLabel(name.replace('c626485ed663', 'c0ffee000001'))
    expect(other).not.toBe(label)
  })

  it('obeys the limit it is given, and never cuts a character in half', () => {
    expect(shortFileLabel('abcdefghijklmnopqrstuvwxyz.png', 12)).toHaveLength(12)
    // Never shorter than 8 whatever is asked, so a label keeps some meaning.
    expect(shortFileLabel('abcdefghijklmnopqrstuvwxyz.png', 2)).toHaveLength(8)
    const emoji = `${'🙂'.repeat(40)}.png`
    const cut = shortFileLabel(emoji)
    expect(Array.from(cut)).toHaveLength(PICTURE_LABEL_MAX)
    // A lone surrogate would break the string on its way to the canvas.
    expect(cut).toBe(cut.normalize('NFC'))
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(cut)).toBe(false)
  })
})
