import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Color, LinearSRGBColorSpace, SRGBColorSpace } from 'three'
import { buildGraph, folderKey, parseNote, type GraphNode, type NoteId, type ParsedNote } from '@aether/core'
import {
  BIO_STAR_COLOR,
  BIO_STAR_GLOW,
  BIO_STAR_HALO,
  BIO_STAR_LABEL_COLOR,
  BOARD_SUN_COLOR,
  IMAGE_COLOR,
  STAR_COLOR,
  SUN_COLOR,
  TODAY_COLOR,
  nodeBaseColor,
  nodeRadius,
  starColor,
  type ColorMode,
} from '../src/theme'

/**
 * The Bio star (docs/COSMOLOGY.md): the folder `Bio` at the vault's home, the one big, bright, blue star. Blue sits far from every
 * gold star, it is bigger than any other star (a drive is still bigger), it burns at one brightness whatever the urgency, and it is
 * always named.
 */

const scene = readFileSync(fileURLToPath(new URL('../src/scene/BrainScene.tsx', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
const num = (name: string): number => Number(scene.match(new RegExp(`const ${name} = ([0-9.]+)`))?.[1])

function bioGraph() {
  const notes = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries({
    'Bio/Food.md': '# Food\n',
    'Bio/Meds.md': '# Meds\n',
    'Work/Gate/Gate.md': '---\ntype: project\nstatus: active\n---\n# Gate\n',
    'Work/Plan.md': '# Plan\n',
  })) {
    const n = parseNote({ path, content })
    notes.set(n.meta.id, n)
  }
  return buildGraph(notes, { folders: { all: new Set(['Bio', 'Work', 'Work/Gate']), rootTitle: 'Vault', multiRoot: false, maxDepth: 3, bio: 'Bio' } })
}
const nodeOf = (id: string): GraphNode => {
  const g = bioGraph()
  return g.nodes[g.index.get(id) ?? -1]!
}
/** Hue (degrees), saturation and lightness of a colour as the screen shows it (sRGB). */
const hueOf = (css: string): { h: number; s: number; l: number } => {
  const hsl = { h: 0, s: 0, l: 0 }
  new Color(css).getHSL(hsl, SRGBColorSpace)
  return { h: hsl.h * 360, s: hsl.s, l: hsl.l }
}
/**
 * What the middle of a star facing the camera shows on screen: the shader (`materials.ts`) outputs colour × glow × (1 + 0.18 pulse,
 * the pulse averaging a half) in linear light with no tone mapping, so a channel past 1 is simply clipped. Returned as an sRGB colour.
 */
const onScreen = (css: string, glow: number): { h: number; s: number; l: number } => {
  const c = new Color(css)
  const k = glow * 1.09
  const shown = new Color().setRGB(Math.min(1, c.r * k), Math.min(1, c.g * k), Math.min(1, c.b * k), LinearSRGBColorSpace)
  const hsl = { h: 0, s: 0, l: 0 }
  shown.getHSL(hsl, SRGBColorSpace)
  return { h: hsl.h * 360, s: hsl.s, l: hsl.l }
}
/** WCAG relative luminance of an sRGB colour, for the contrast of text on the dark panels. */
const luminance = (css: string): number => {
  const c = new Color(css)
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}
const folder = (over: Record<string, unknown>) => ({ kind: 'folder', folder: { totalNotes: 0, childFolders: 0, images: 0, role: 'folder', ...over } }) as never

describe('the Bio star’s color', () => {
  it('is a bright, saturated blue in every color mode, where notes would follow the mode', () => {
    const star = nodeOf(folderKey('Bio'))
    for (const mode of ['area', 'type', 'tag', 'age'] as ColorMode[]) {
      expect(`#${nodeBaseColor(star, mode, null, () => 0.5).getHexString()}`, mode).toBe(BIO_STAR_COLOR)
    }
    const { h, s, l } = hueOf(BIO_STAR_COLOR)
    expect(h).toBeGreaterThan(205)
    expect(h).toBeLessThan(230)
    expect(s).toBeGreaterThan(0.85)
    expect(l).toBeGreaterThan(0.5)
  })

  it('shows as a bright blue on screen at its glow, not cyan: the green channel must stay under the display limit', () => {
    const shown = onScreen(BIO_STAR_COLOR, BIO_STAR_GLOW)
    expect(shown.h).toBeGreaterThan(200)
    expect(shown.h).toBeLessThan(225)
    expect(shown.s).toBeGreaterThan(0.8)
    expect(shown.l).toBeGreaterThan(0.55)
    // The mistake this guards against: the lighter blue first tried clipped to cyan (hue 185) at the same glow.
    expect(onScreen('#3d9bff', BIO_STAR_GLOW).h).toBeLessThan(195)
    // And a selected Bio star (glow plus 0.4) is still blue.
    expect(onScreen(BIO_STAR_COLOR, BIO_STAR_GLOW + 0.4).h).toBeGreaterThan(200)
  })

  it('has a lighter blue for its name and its inspector, readable on the dark panels', () => {
    const { h } = hueOf(BIO_STAR_LABEL_COLOR)
    expect(h).toBeGreaterThan(205)
    expect(h).toBeLessThan(230)
    // Contrast against the panel's near-black (WCAG): the body's own deep blue is too dark for small text, this one is not.
    const dark = luminance('#0b1020')
    const contrast = (css: string) => (luminance(css) + 0.05) / (dark + 0.05)
    expect(contrast(BIO_STAR_LABEL_COLOR)).toBeGreaterThan(7)
    expect(contrast(BIO_STAR_COLOR)).toBeLessThan(7)
  })

  it('is far from every other folder, sun and hub: only the Bio star is blue', () => {
    // Every other star is drawn in the warm band (starColor hues 16 to 60, a project star gold, a drive cream).
    for (const path of ['Work', 'Work/Gate', 'Inbox', 'Art/Sketches', 'D/Projects']) {
      const hue = hueOf(starColor(path)).h
      expect(Math.abs(hue - hueOf(BIO_STAR_COLOR).h), path).toBeGreaterThan(120)
    }
    expect(Math.abs(hueOf(STAR_COLOR).h - hueOf(BIO_STAR_COLOR).h)).toBeGreaterThan(120)
    expect(new Set([BIO_STAR_COLOR, STAR_COLOR, SUN_COLOR, TODAY_COLOR, BOARD_SUN_COLOR, IMAGE_COLOR]).size).toBe(6)
    // The hub is the nearest in hue (aurora cyan): still well apart.
    expect(Math.abs(hueOf(TODAY_COLOR).h - hueOf(BIO_STAR_COLOR).h)).toBeGreaterThan(20)
  })

  it('leaves the other folders as they were', () => {
    const g = bioGraph()
    const color = (id: string) => `#${nodeBaseColor(g.nodes[g.index.get(id)!]!, 'area', null, () => 0).getHexString()}`
    expect(color(folderKey('Work/Gate'))).toBe(STAR_COLOR)
    expect(color(folderKey(''))).toBe(SUN_COLOR)
    expect(color(folderKey('Work'))).toBe(`#${new Color(starColor('Work')).getHexString()}`)
  })
})

describe('the Bio star’s size', () => {
  it('is bigger than any other star there can be, and smaller than a drive', () => {
    // The biggest star of any kind: a project star holding a million notes is 9.2; a board sun at most 9.
    const biggest = nodeRadius(folder({ role: 'project', totalNotes: 1_000_000, childFolders: 5000 }))
    expect(biggest).toBeCloseTo(9.2, 5)
    const empty = nodeRadius(folder({ bio: true }))
    expect(empty).toBeCloseTo(9.5, 5)
    expect(empty).toBeGreaterThan(biggest)
    expect(nodeRadius(folder({ role: 'mount' }))).toBe(16)
    expect(nodeRadius(folder({ bio: true, totalNotes: 1_000_000 }))).toBeLessThan(16)
  })

  it('grows a little with what it holds and stops at 11', () => {
    const r = (notes: number) => nodeRadius(folder({ bio: true, totalNotes: notes }))
    expect(r(6)).toBeGreaterThan(r(0))
    expect(r(60)).toBeGreaterThan(r(6))
    expect(r(6)).toBeCloseTo(9.5 + 0.3 * Math.log2(7), 5)
    expect(r(10_000_000)).toBe(11)
  })

  it('is what the real graph’s Bio node measures, and its neighbors keep theirs', () => {
    expect(nodeRadius(nodeOf(folderKey('Bio')))).toBeGreaterThan(nodeRadius(nodeOf(folderKey('Work/Gate'))))
    expect(nodeRadius(nodeOf(folderKey('Bio')))).toBeGreaterThan(nodeRadius(nodeOf(folderKey('Work'))))
    expect(nodeRadius(nodeOf(folderKey('Work')))).toBeLessThan(8.01)
  })
})

describe('the Bio star in the scene', () => {
  it('burns brighter than any star can, than a galaxy and than a board sun, and only the Today hub outshines it', () => {
    const brightestStar = num('PROJECT_GLOW_CALM') + num('STAR_GLOW_HEAT')
    expect(brightestStar).toBeGreaterThan(2)
    expect(BIO_STAR_GLOW).toBeGreaterThan(brightestStar)
    expect(BIO_STAR_GLOW).toBeGreaterThan(num('GALAXY_GLOW'))
    expect(BIO_STAR_GLOW).toBeGreaterThan(num('BOARD_SUN_GLOW'))
    expect(BIO_STAR_GLOW).toBeLessThan(num('TODAY_GLOW'))
  })

  it('uses that one brightness however much it is used, instead of the star glow', () => {
    expect(scene).toMatch(/const star = node\.folder\?\.bio \? BIO_STAR_GLOW : starGlow\(c\.activity !== null && c\.activity\.length === n \? \(c\.activity\[i\] \?\? 0\) : 0, role === ROLE_PROJECT\)/)
  })

  it('gives it a wider aura than any other body, so a deep blue is still a bright blue giant from far away', () => {
    expect(num('HALO_RADII')).toBe(3.2)
    expect(BIO_STAR_HALO).toBeGreaterThan(num('HALO_RADII') * 1.5)
    // Per node: the Bio star's, nobody else's; and the halo is sized from it, not from a fixed number.
    expect(scene).toMatch(/const haloK = new Float32Array\(count\)\.fill\(HALO_RADII\)\n\s+graph\.nodes\.forEach\(\(n, i\) => \{\n\s+if \(n\.folder\?\.bio\) haloK\[i\] = BIO_STAR_HALO\n\s+\}\)/)
    expect(scene).toContain('const h = pictured ? 0 : r * buffers.haloK[i]!')
  })

  it('always names it, in its blue, with a ✚', () => {
    expect(scene).toMatch(/if \(f\?\.bio\) \{\n\s+\/\/[^\n]*\n\s+landmarks\.push\(i\)\n\s+labelColors\[i\] = BIO_STAR_LABEL_COLOR\n\s+label = `✚ \$\{label\}`\n\s+\}/)
  })
})
