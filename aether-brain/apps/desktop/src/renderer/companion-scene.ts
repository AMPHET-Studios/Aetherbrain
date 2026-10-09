/**
 * The scene the brain window draws, as the companion link publishes it to a
 * viewer (the Unreal app): each node's kind, colour (the brain's own, in the
 * current colour mode) and radius, its structural parent, and the links. Pure,
 * unit-tested; companion.ts publishes it.
 */
import type { GraphData, GraphNode, NoteId } from '@aether/core'
import { nodeBaseColor, nodeRadius, type ColorMode, type PictureSize } from '@aether/graph'
import type { CompanionGraphDto, CompanionKind } from '../shared/ipc'
import type { ScenePlan } from './companion-bound'

export function companionKind(n: GraphNode): CompanionKind {
  if (n.kind === 'today') return 'today'
  if (n.kind === 'image') return 'picture'
  if (n.folder) {
    const role = n.folder.role
    return role === 'root' || role === 'mount' ? 'sun' : role === 'project' ? 'star' : 'planet'
  }
  return n.ghost ? 'ghost' : 'moon'
}

export interface CompanionSceneOptions {
  version: number
  vault: string
  layout: CompanionGraphDto['layout']
  colorMode: ColorMode
  activeTag: string | null
  selectedId: NoteId | null
  /** How big the brain draws pictures (their radius). */
  pictureSize?: PictureSize
}

/**
 * The published scene of `graph`: every node in the layout's order, or with a `plan` (companion-bound.ts) only the
 * nodes it keeps, in the same relative order, with their parents, the links and the selection renumbered, and a
 * `limits` field that says how much of the brain it is.
 */
export function companionScene(graph: GraphData, o: CompanionSceneOptions, plan?: ScenePlan): CompanionGraphDto {
  // Age colours run from the oldest note (1) to the newest (0), as the brain draws them.
  let minT = Infinity
  let maxT = -Infinity
  for (const n of graph.nodes) {
    if (n.created === null) continue
    if (n.created < minT) minT = n.created
    if (n.created > maxT) maxT = n.created
  }
  if (minT === Infinity) {
    minT = 0
    maxT = 1
  }
  const span = Math.max(1, maxT - minT)
  const ageOf = (n: GraphNode) => (n.created === null ? 0.9 : 1 - (n.created - minT) / span)
  const dto = (n: GraphNode, parent: number) => ({
    id: n.id,
    title: n.title,
    kind: companionKind(n),
    color: `#${nodeBaseColor(n, o.colorMode, o.activeTag, ageOf).getHexString()}`,
    radius: Math.round(nodeRadius(n, o.pictureSize) * 1000) / 1000,
    parent,
  })
  if (plan) {
    const nodes = Array.from(plan.keep, (i) => {
      const p = plan.parent[i]!
      return dto(graph.nodes[i]!, p < 0 ? -1 : plan.newIndex[p]!)
    })
    const edges = plan.edges.map((i) => plan.newIndex[i]!)
    return {
      version: o.version,
      vault: o.vault,
      layout: o.layout,
      nodes,
      edges,
      selected: plan.selected < 0 ? -1 : plan.newIndex[plan.selected]!,
      limits: { nodes: nodes.length, ofNodes: plan.n, links: edges.length / 2, ofLinks: plan.linksTotal },
    }
  }
  const at = (id: NoteId | null) => (id === null ? -1 : (graph.index.get(id) ?? -1))
  const nodes = graph.nodes.map((n) => dto(n, at(n.parent)))
  const edges: number[] = []
  for (const e of graph.edges) {
    const a = at(e.from)
    const b = at(e.to)
    if (a >= 0 && b >= 0) edges.push(a, b)
  }
  return { version: o.version, vault: o.vault, layout: o.layout, nodes, edges, selected: at(o.selectedId) }
}
