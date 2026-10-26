import { describe, expect, it } from 'vitest'
import { buildGraph, folderKey, parseNote, type GraphData, type NoteId, type ParsedNote } from '@aether/core'
import { blackHoleOf, orbitParents } from '../src/layout/orbitParents'

/**
 * The Bio is a super massive black hole and every galaxy revolves around it (docs/COSMOLOGY.md, "The Bio black hole"): who orbits whom
 * is the folder tree, except that the Bio has no parent and each galaxy's parent is the Bio, however deep the galaxy lives.
 */

function graphOf(files: Record<string, string>, folders: string[], extra: Record<string, unknown> = {}, multiRoot = false): GraphData {
  const notes = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    notes.set(n.meta.id, n)
  }
  return buildGraph(notes, { folders: { all: new Set(folders), rootTitle: multiRoot ? 'Drives' : 'Vault', multiRoot, maxDepth: 3, maxFolders: 0, ...extra } })
}

const FILES = {
  'Bio/Food.md': '# Food\n',
  'Bio/Meds.md': '# Meds\n',
  'Lab/Lab.md': '---\ntype: project\nscale: galaxy\n---\n# Lab\n',
  'Lab/Core/Core.md': '---\ntype: project\nscale: galaxy\n---\n# Core\n',
  'Lab/Core/Sub/Deep.md': '# Deep\n',
  'Work/Plan.md': '# Plan\n',
  'Work/Gate/Gate.md': '---\ntype: project\n---\n# Gate\n',
}
const FOLDERS = ['Bio', 'Lab', 'Lab/Core', 'Lab/Core/Sub', 'Work', 'Work/Gate']

const at = (g: GraphData, id: string): number => g.index.get(id) ?? -1
const idOf = (g: GraphData, p: Int32Array, id: string): string | undefined => {
  const k = p[at(g, id)]!
  return k < 0 ? undefined : g.nodes[k]!.id
}

describe('who orbits whom with a black hole in the sky', () => {
  const g = graphOf(FILES, FOLDERS, { bio: 'Bio' })
  const p = orbitParents(g)

  it('finds the Bio as the centre', () => {
    expect(blackHoleOf(g)).toBe(at(g, folderKey('Bio')))
    expect(p[at(g, folderKey('Bio'))]).toBe(-1)
  })

  it('hangs the vault on the Bio: the vault is a galaxy', () => {
    expect(idOf(g, p, folderKey(''))).toBe(folderKey('Bio'))
  })

  it('hangs a galaxy you marked on the Bio, nested in another galaxy or not', () => {
    // The graph itself still says Core sits on Lab; the sky says both circle the Bio.
    const lab = g.nodes[at(g, folderKey('Lab'))]!
    const core = g.nodes[at(g, folderKey('Lab/Core'))]!
    expect(lab.folder?.galaxyLevel).toBeDefined()
    expect(core.folder?.galaxyLevel).toBeDefined()
    expect(core.parent).toBe(folderKey('Lab'))
    expect(idOf(g, p, folderKey('Lab'))).toBe(folderKey('Bio'))
    expect(idOf(g, p, folderKey('Lab/Core'))).toBe(folderKey('Bio'))
  })

  it('leaves everything else with the folder it lives in', () => {
    expect(idOf(g, p, folderKey('Work'))).toBe(folderKey(''))
    expect(idOf(g, p, folderKey('Work/Gate'))).toBe(folderKey('Work'))
    expect(idOf(g, p, folderKey('Lab/Core/Sub'))).toBe(folderKey('Lab/Core'))
    for (const n of g.nodes) {
      if (n.folder !== undefined) continue
      expect(p[at(g, n.id)], n.id).toBe(n.parent === null ? -1 : at(g, n.parent))
    }
  })

  it('keeps the Bio’s own pages orbiting the Bio', () => {
    const pages = g.nodes.filter((n) => n.parent === folderKey('Bio'))
    expect(pages.length).toBeGreaterThanOrEqual(2)
    for (const n of pages) expect(idOf(g, p, n.id)).toBe(folderKey('Bio'))
  })

  it('has no cycle: every body reaches the Bio by the bodies it orbits', () => {
    const hole = blackHoleOf(g)
    for (let i = 0; i < g.nodes.length; i++) {
      let k = i
      let steps = 0
      while (k >= 0 && k !== hole && steps++ <= g.nodes.length) k = p[k]!
      expect(k, g.nodes[i]!.id).toBe(hole)
    }
  })
})

describe('without a black hole in the sky', () => {
  it('is exactly the folder tree', () => {
    const g = graphOf(FILES, FOLDERS)
    expect(blackHoleOf(g)).toBe(-1)
    const p = orbitParents(g)
    g.nodes.forEach((n, i) => expect(p[i], n.id).toBe(n.parent === null ? -1 : at(g, n.parent)))
  })
})

describe('a Bio that is not made yet', () => {
  it('is the centre too: a dormant black hole', () => {
    const g = graphOf({ 'Work/Plan.md': '# Plan\n' }, ['Work'], { bio: 'Bio', bioPlaceholder: true })
    const hole = blackHoleOf(g)
    expect(hole).toBe(at(g, folderKey('Bio')))
    expect(g.nodes[hole]!.folder?.placeholder).toBe(true)
    const p = orbitParents(g)
    expect(p[hole]).toBe(-1)
    expect(idOf(g, p, folderKey(''))).toBe(folderKey('Bio'))
  })
})

describe('a vault of several drives', () => {
  it('hangs every drive, and the loose root that held them, on the Bio', () => {
    const g = graphOf({ 'D/Bio/Food.md': '# Food\n', 'D/Work/Plan.md': '# Plan\n', 'F/Art/Sketch.md': '# Sketch\n' }, ['D', 'F', 'D/Bio', 'D/Work', 'F/Art'], { bio: 'D/Bio' }, true)
    const hole = blackHoleOf(g)
    expect(hole).toBe(at(g, folderKey('D/Bio')))
    const p = orbitParents(g)
    expect(p[hole]).toBe(-1)
    const mounts = g.nodes.filter((n) => n.folder?.role === 'mount')
    expect(mounts.length).toBe(2)
    for (const m of mounts) expect(idOf(g, p, m.id), m.id).toBe(folderKey('D/Bio'))
    const root = g.nodes.find((n) => n.folder?.role === 'root')!
    expect(idOf(g, p, root.id)).toBe(folderKey('D/Bio'))
    // A folder on a drive still circles its drive, and the drive the Bio.
    expect(idOf(g, p, folderKey('F/Art'))).toBe(folderKey('F'))
  })
})
