import { describe, expect, it } from 'vitest'
import { buildGraph, parseNote, type GraphData, type NoteId, type ParsedNote } from '@aether/core'
import { cleanGraph } from '../src/main/companion.js'
import { COMPANION_BUDGET, planBase, planFor, type SceneBudget } from '../src/renderer/companion-bound'
import { companionBody, companionKind, companionScene, sceneSignature } from '../src/renderer/companion-scene'

/**
 * A folder you marked as a galaxy, as the Unreal viewer is told (docs/COSMOLOGY.md, "What the viewer is told"): its `kind` is what
 * a project star's always was (a viewer built to the original names keeps working; main refuses a scene with a kind it does not know),
 * its `body` is `galaxy`, and a galaxy only ever hangs from another galaxy, the origin, or nothing.
 */

const OPTS = { version: 1, vault: 'Vault', layout: 'system', colorMode: 'area', activeTag: null, selectedId: null } as const

function vault(files: Record<string, string>, all: string[]): GraphData {
  const notes = new Map<NoteId, ParsedNote>()
  for (const [path, content] of Object.entries(files)) {
    const n = parseNote({ path, content })
    notes.set(n.meta.id, n)
  }
  return buildGraph(notes, { folders: { multiRoot: false, all, rootTitle: 'Vault', maxDepth: 3, maxFolders: 0 } })
}

const mark = (name: string, scale = 'galaxy') => `---\ntype: project\nscale: ${scale}\n---\n# ${name}\n`
const FILES: Record<string, string> = {
  'Home.md': '# Home\n',
  'Games/Notes.md': '# Notes\n',
  'Games/Darktide/Darktide.md': mark('Darktide'),
  'Games/Darktide/Mods/Plan.md': '# Plan\n',
  'Games/Darktide/Mods/Deep/Deeper/Cake/Cake.md': mark('Cake'),
  'Games/Darktide/Mods/Deep/Deeper/Cake/Sub/Deeper/Zed/Zed.md': mark('Zed'),
  'Games/Other/Other.md': '---\ntype: project\n---\n# Other\n',
}
const FOLDERS = [
  'Games',
  'Games/Darktide',
  'Games/Darktide/Mods',
  'Games/Darktide/Mods/Deep',
  'Games/Darktide/Mods/Deep/Deeper',
  'Games/Darktide/Mods/Deep/Deeper/Cake',
  'Games/Darktide/Mods/Deep/Deeper/Cake/Sub',
  'Games/Darktide/Mods/Deep/Deeper/Cake/Sub/Deeper',
  'Games/Darktide/Mods/Deep/Deeper/Cake/Sub/Deeper/Zed',
  'Games/Other',
]

describe('a galaxy you marked, as the viewer is told', () => {
  const graph = vault(FILES, FOLDERS)
  const dto = companionScene(graph, OPTS)
  const at = (id: string) => dto.nodes.findIndex((n) => n.id === id)

  it('keeps its kind a project star’s and makes its body a galaxy', () => {
    const dark = dto.nodes[at('folder:Games/Darktide')]!
    expect(dark).toMatchObject({ kind: 'star', body: 'galaxy' })
    expect(dark.radius).toBeGreaterThanOrEqual(12)
    expect(dark.radius).toBeLessThanOrEqual(15)
    // The star next to it is what it was: a project star, a star.
    expect(dto.nodes[at('folder:Games/Other')]).toMatchObject({ kind: 'star', body: 'star' })
    // A mark that does not count is a project star.
    expect(dto.nodes[at('folder:Games/Darktide/Mods/Deep/Deeper/Cake/Sub/Deeper/Zed')]).toMatchObject({ kind: 'star', body: 'star' })
  })

  it('hangs a galaxy from a galaxy, the origin or nothing, and a nested one from the galaxy it sits on', () => {
    for (const n of dto.nodes) {
      if (n.body !== 'galaxy') continue
      if (n.parent < 0) continue
      expect(['galaxy', 'origin']).toContain(dto.nodes[n.parent]!.body)
    }
    const dark = dto.nodes[at('folder:Games/Darktide')]!
    const cake = dto.nodes[at('folder:Games/Darktide/Mods/Deep/Deeper/Cake')]!
    expect(dto.nodes[dark.parent]!.id).toBe('folder:')
    expect(cake.body).toBe('galaxy')
    expect(dto.nodes[cake.parent]!.id).toBe('folder:Games/Darktide')
  })

  it('sends only kinds and bodies main knows, so the whole scene is accepted as it is', () => {
    expect(() => cleanGraph(dto)).not.toThrow()
    const clean = cleanGraph(dto)
    expect(clean.nodes[at('folder:Games/Darktide')]).toMatchObject({ kind: 'star', body: 'galaxy' })
  })

  it('is the same scene a viewer sees whatever order the notes came in', () => {
    const again = companionScene(vault(Object.fromEntries(Object.entries(FILES).reverse()), [...FOLDERS].reverse()), OPTS)
    const view = (d: typeof dto) => d.nodes.filter((n) => n.id.startsWith('folder:')).map((n) => [n.id, n.kind, n.body, n.radius, d.nodes[n.parent]?.id])
    expect(view(again)).toEqual(view(dto))
  })

  it('names the kinds and bodies by the same functions as before', () => {
    const folder = (extra: object) => ({ kind: 'folder', ghost: false, folder: { role: 'project', ...extra } }) as never
    expect(companionKind(folder({ galaxyLevel: 2 }))).toBe('star')
    expect(companionBody(folder({ galaxyLevel: 2 }))).toBe('galaxy')
    expect(companionBody(folder({}))).toBe('star')
  })
})

describe('a keystroke in a note', () => {
  it('does not change the scene a viewer is sent: a few more words leave every radius, so the scene’s signature, as it was', () => {
    const files = (words: number): Record<string, string> => {
      const out: Record<string, string> = { 'Docs/Notes/Draft.md': `# Draft\n${'word '.repeat(words)}\n` }
      for (let i = 0; i < 99; i++) out[`Docs/Notes/n${i}.md`] = `# n${i}\n`
      return out
    }
    const dto = (words: number) => companionScene(vault(files(words), ['Docs', 'Docs/Notes']), OPTS)
    const a = dto(100)
    const b = dto(130)
    expect(b.nodes.map((n) => n.radius)).toEqual(a.nodes.map((n) => n.radius))
    expect(sceneSignature(b)).toBe(sceneSignature(a))
  })
})

describe('a galaxy in a scene that is cut to a budget', () => {
  const TIGHT: SceneBudget = {
    nodes: 120,
    stars: 4,
    planets: 30,
    moons: 60,
    perFolderMoons: 3,
    guaranteedMoons: 1,
    ghosts: 4,
    pictures: 4,
    perFolderPictures: 1,
    links: 100,
    rings: 20,
    beams: 5,
  }
  // 12 galaxies on the vault, each with 6 stars of 12 notes.
  const files: Record<string, string> = { 'Home.md': '# Home\n' }
  const all: string[] = []
  for (let g = 0; g < 12; g++) {
    files[`G${g}/G${g}.md`] = mark(`G${g}`)
    all.push(`G${g}`)
    for (let s = 0; s < 6; s++) {
      all.push(`G${g}/S${s}`)
      for (let n = 0; n < 12; n++) files[`G${g}/S${s}/n${n}.md`] = `# n${g}-${s}-${n}\n`
    }
  }
  const graph = vault(files, all)

  it('keeps the chain above whatever it keeps, so a kept star never loses the galaxy it lies on', () => {
    const base = planBase(graph, TIGHT)
    const plan = planFor(graph, base, null, TIGHT)
    const kept = new Set(plan.keep)
    expect(plan.keep.length).toBeLessThan(graph.nodes.length)
    for (const i of plan.keep) {
      const p = plan.parent[i]!
      if (p >= 0) expect(kept.has(p), graph.nodes[i]!.id).toBe(true)
    }
    const dto = companionScene(graph, OPTS, plan)
    for (const n of dto.nodes) if (n.body === 'galaxy' && n.parent >= 0) expect(['galaxy', 'origin']).toContain(dto.nodes[n.parent]!.body)
    expect(() => cleanGraph(dto)).not.toThrow()
  })

  it('does not let marked galaxies grow the scene past the star budget the cut already has', () => {
    const base = planBase(graph, COMPANION_BUDGET)
    const plan = planFor(graph, base, null, COMPANION_BUDGET)
    const dto = companionScene(graph, OPTS, plan)
    expect(dto.nodes.filter((n) => n.body === 'galaxy').length).toBeLessThanOrEqual(13)
    expect(dto.nodes.length).toBeLessThanOrEqual(COMPANION_BUDGET.nodes + 16)
  })
})
