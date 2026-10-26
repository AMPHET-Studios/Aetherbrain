import { describe, expect, it } from 'vitest'
import { ActivityLog, buildGraph, computeActivity, folderKey, parseNote, type GraphData, type NoteId, type ParsedNote } from '@aether/core'
import { cleanGraph } from '../src/main/companion.js'
import { planBase, planFor, type SceneBudget } from '../src/renderer/companion-bound'
import { companionScene, sceneSignature } from '../src/renderer/companion-scene'

/**
 * How much each node is used, as the Unreal viewer is told (docs/COSMOLOGY.md, "A star's brightness is how much you use it"): an
 * optional `activity` per node, 0 to 1, that an older viewer simply does not read.
 */

const OPTS = { version: 1, vault: 'Vault', layout: 'system', colorMode: 'area', activeTag: null, selectedId: null } as const
const T0 = Date.UTC(2026, 9, 26, 12)

function vault(): GraphData {
  const notes = new Map<NoteId, ParsedNote>()
  for (const path of ['Work/Plan.md', 'Work/Deep/Notes.md', 'Play/Game.md', 'Quiet/Still.md']) {
    const n = parseNote({ path, content: `# ${path}\n` })
    notes.set(n.meta.id, n)
  }
  return buildGraph(notes, { folders: { multiRoot: false, all: ['Work', 'Work/Deep', 'Play', 'Quiet'], rootTitle: 'Vault', maxDepth: 3, maxFolders: 0 } })
}

describe('the activity of each node, in the scene', () => {
  const graph = vault()
  const log = new ActivityLog()
  for (let i = 0; i < 3; i++) log.record('Work/Plan', 'save', T0 + i * 60_000)
  const activity = computeActivity(graph, log, T0 + 200_000)
  const at = (dto: ReturnType<typeof companionScene>, id: string) => dto.nodes.find((n) => n.id === id)!

  it('is sent for every node, to the hundredth, when the brain has worked it out', () => {
    const dto = companionScene(graph, { ...OPTS, activity })
    for (const n of dto.nodes) {
      expect(n.activity).toBeGreaterThanOrEqual(0)
      expect(n.activity).toBeLessThanOrEqual(1)
      // To the hundredth.
      expect(Math.abs(n.activity! * 100 - Math.round(n.activity! * 100))).toBeLessThan(1e-9)
    }
    expect(at(dto, folderKey('Work')).activity).toBeGreaterThan(0.4)
    expect(at(dto, folderKey('Play')).activity).toBe(0)
    expect(at(dto, 'Work/Plan').activity).toBe(at(dto, folderKey('Work')).activity)
  })

  it('is left out, as in an older build, when there is nothing to send: not worked out yet, or for another graph', () => {
    for (const none of [undefined, null, new Float32Array(3)]) {
      const dto = companionScene(graph, { ...OPTS, activity: none })
      for (const n of dto.nodes) expect('activity' in n).toBe(false)
    }
  })

  it('goes with its node through the cut to a budget: a kept node carries ITS number, not the one of the node at its new place', () => {
    const TIGHT: SceneBudget = { nodes: 5, stars: 2, planets: 2, moons: 2, perFolderMoons: 1, guaranteedMoons: 0, ghosts: 0, pictures: 0, perFolderPictures: 0, links: 10, rings: 5, beams: 0 }
    const base = planBase(graph, TIGHT)
    const plan = planFor(graph, base, null, TIGHT)
    const dto = companionScene(graph, { ...OPTS, activity }, plan)
    expect(dto.nodes.length).toBeLessThan(graph.nodes.length)
    for (const n of dto.nodes) expect(n.activity).toBe(Math.round(activity[graph.index.get(n.id)!]! * 100) / 100)
  })

  it('is part of what makes a scene a new scene: another use is another picture, the same use is the same', () => {
    const a = companionScene(graph, { ...OPTS, activity })
    const same = companionScene(graph, { ...OPTS, version: 9, activity })
    const calm = companionScene(graph, { ...OPTS, activity: new Float32Array(graph.nodes.length) })
    expect(sceneSignature(same)).toBe(sceneSignature(a))
    expect(sceneSignature(calm)).not.toBe(sceneSignature(a))
  })

  it('passes main’s checks, kept to 0..1, and a bad one is dropped without failing the scene', () => {
    const dto = companionScene(graph, { ...OPTS, activity })
    const clean = cleanGraph(dto)
    expect(clean.nodes.map((n) => n.activity)).toEqual(dto.nodes.map((n) => n.activity))
    const odd = JSON.parse(JSON.stringify(dto)) as typeof dto
    odd.nodes[0]!.activity = 7
    odd.nodes[1]!.activity = -2
    ;(odd.nodes[2] as { activity: unknown }).activity = 'bright'
    ;(odd.nodes[3] as { activity: unknown }).activity = Number.NaN
    const out = cleanGraph(odd)
    expect(out.nodes[0]!.activity).toBe(1)
    expect(out.nodes[1]!.activity).toBe(0)
    expect(out.nodes[2]!.activity).toBeUndefined()
    expect(out.nodes[3]!.activity).toBeUndefined()
  })
})
