/**
 * The scene the brain window draws, as the companion link publishes it to a
 * viewer (the Unreal app): each node's kind, colour (the brain's own, in the
 * current colour mode) and radius, its structural parent, and the links. Pure,
 * unit-tested; companion.ts publishes it.
 */
import type { GraphData, GraphNode, NoteId } from '@aether/core'
import { nodeBaseColor, nodeRadius, type ColorMode } from '@aether/graph'
import type { CompanionGraphDto, CompanionKind } from '../shared/ipc'

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
}

/** The published scene of `graph` (same node order as the layout's positions). */
export function companionScene(graph: GraphData, o: CompanionSceneOptions): CompanionGraphDto {
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
  const at = (id: NoteId | null) => (id === null ? -1 : (graph.index.get(id) ?? -1))
  const nodes = graph.nodes.map((n) => ({
    id: n.id,
    title: n.title,
    kind: companionKind(n),
    color: `#${nodeBaseColor(n, o.colorMode, o.activeTag, ageOf).getHexString()}`,
    radius: Math.round(nodeRadius(n) * 1000) / 1000,
    parent: at(n.parent),
  }))
  const edges: number[] = []
  for (const e of graph.edges) {
    const a = at(e.from)
    const b = at(e.to)
    if (a >= 0 && b >= 0) edges.push(a, b)
  }
  return { version: o.version, vault: o.vault, layout: o.layout, nodes, edges, selected: at(o.selectedId) }
}
