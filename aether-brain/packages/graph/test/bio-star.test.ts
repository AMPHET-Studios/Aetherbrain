import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Color, SRGBColorSpace } from 'three'
import { buildGraph, folderKey, parseNote, type GraphNode, type NoteId, type ParsedNote } from '@aether/core'
import {
  BIO_STAR_COLOR,
  BIO_STAR_LABEL_COLOR,
  BLACK_HOLE_MAX_RADIUS,
  BLACK_HOLE_MIN_RADIUS,
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
 * The Bio (docs/COSMOLOGY.md, "The Bio black hole"): the folder `Bio` at the vault's home, a super massive black hole at the centre of
 * the sky. Its blue sits far from every gold star, it is the biggest body there is, it gives no light of its own (the quad over it paints
 * the disc and the ring), and it is always named.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
const scene = read('../src/scene/BrainScene.tsx')
const engine = read('../src/layout/LayoutEngine.ts')

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
/** WCAG relative luminance of an sRGB colour, for the contrast of text on the dark panels. */
const luminance = (css: string): number => {
  const c = new Color(css)
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}
const folder = (over: Record<string, unknown>) => ({ kind: 'folder', folder: { totalNotes: 0, childFolders: 0, images: 0, role: 'folder', ...over } }) as never

describe('the Bio’s color', () => {
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

  it('is far from every other folder, sun and hub: only the Bio is blue', () => {
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

describe('the Bio’s size', () => {
  it('is the biggest body there is: 22 when empty, bigger than a drive (16) and than any star', () => {
    // The biggest star of any kind: a project star holding a million notes is 9.2; a board sun at most 9.
    const biggest = nodeRadius(folder({ role: 'project', totalNotes: 1_000_000, childFolders: 5000 }))
    expect(biggest).toBeCloseTo(9.2, 5)
    const empty = nodeRadius(folder({ bio: true }))
    expect(empty).toBeCloseTo(22, 5)
    expect(empty).toBe(BLACK_HOLE_MIN_RADIUS)
    expect(empty).toBeGreaterThan(nodeRadius(folder({ role: 'mount' })))
    expect(nodeRadius(folder({ role: 'mount' }))).toBe(16)
    expect(nodeRadius(folder({ role: 'root', galaxy: true }))).toBe(16)
  })

  it('grows a little with what it holds and stops at 28', () => {
    const r = (notes: number) => nodeRadius(folder({ bio: true, totalNotes: notes }))
    expect(r(6)).toBeGreaterThan(r(0))
    expect(r(60)).toBeGreaterThan(r(6))
    expect(r(6)).toBeCloseTo(22 + 0.9 * Math.log2(7), 5)
    expect(r(10_000_000)).toBe(28)
    expect(BLACK_HOLE_MAX_RADIUS).toBe(28)
  })

  it('is what the real graph’s Bio node measures, and its neighbors keep theirs', () => {
    expect(nodeRadius(nodeOf(folderKey('Bio')))).toBeGreaterThan(nodeRadius(nodeOf(folderKey('Work/Gate'))))
    expect(nodeRadius(nodeOf(folderKey('Bio')))).toBeGreaterThan(nodeRadius(nodeOf(folderKey('Work'))))
    expect(nodeRadius(nodeOf(folderKey('Work')))).toBeLessThan(8.01)
  })
})

describe('the Bio in the scene', () => {
  it('gives no light of its own: a dark core with no glow', () => {
    expect(scene).toContain('const dark = node.folder?.bio === true')
    expect(scene).toContain('colors[i * 3] = dark ? 0 : col.r')
    expect(scene).toContain('glow[i * 4] = dark ? 0 : gl')
    // Its blue stays in the base colours: the rings of the galaxies that circle it are tinted by it.
    expect(scene).toContain('base[i * 3] = col.r')
  })

  it('draws no core and no aura of its own: the quad over it is the whole body', () => {
    expect(scene).toContain('const core = i === holeI ? 0 :')
    expect(scene).toContain('const h = pictured || i === holeI ? 0 : r * buffers.haloK[i]!')
    expect(scene).toMatch(/const holeAt = blackHoleOf\(graph\)\n\s+if \(holeAt >= 0\) haloK\[holeAt\] = 0/)
  })

  it('draws it with one quad, in the plane its galaxies orbit, at its place, hovered and selected', () => {
    expect(scene).toContain('const hole = holeAt >= 0 ? buildBlackHole(holeAt) : null')
    expect(scene).toContain('if (buffers.hole) fitBlackHole(buffers.hole, buffers.ringParent, buffers.ringQuat.array as Float32Array, buffers.ringCount)')
    expect(scene).toMatch(/placeBlackHole\(buffers\.hole, dp\[k \* 3\] \?\? 0, dp\[k \* 3 \+ 1\] \?\? 0, dp\[k \* 3 \+ 2\] \?\? 0, buffers\.radii\[k\] \?\? 0, feedOf\(g\.nodes\[k\]\?\.folder\), st\.flareClock % 3600, lift\)/)
    expect(scene).toContain('const lift = k === selI ? 1 : k === hovI ? 0.5 : 0')
    expect(scene).toContain('{buffers.hole && <primitive object={buffers.hole.mesh} />}')
    expect(scene).toContain('hole?.dispose()')
  })

  it('has its rings, its unfolding and its layout follow who orbits whom, not the folders', () => {
    expect(scene).toContain('const parentIdx = orbitParents(graph)')
    expect(engine).toContain('const circles = orbitParents(graph)')
    expect(engine).toContain('parent: circles[i]!')
    expect(engine).toContain('n.folder.bio ? BLACK_HOLE_ROLE')
  })

  it('always names it, in its blue, with a ✚', () => {
    expect(scene).toMatch(/if \(f\?\.bio\) \{\n\s+\/\/[^\n]*\n\s+landmarks\.push\(i\)\n\s+labelColors\[i\] = BIO_STAR_LABEL_COLOR\n\s+label = `✚ \$\{label\}`\n\s+\}/)
  })
})
