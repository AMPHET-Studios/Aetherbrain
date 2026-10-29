/**
 * Who orbits whom in the sky (docs/COSMOLOGY.md, "The Bio black hole").
 *
 * The folder tree says where a folder lives; the sky says what it circles. They are the same, with one exception: the Bio is a
 * super massive black hole at the centre of everything, and every galaxy (a drive, the vault, a folder you marked) revolves around
 * it. So with a Bio in the graph the Bio has no parent, and each galaxy's parent is the Bio, however deep in the tree it lives.
 * What a galaxy holds (its stars, planets and moons) stays with it, and the Bio's own pages keep orbiting the Bio.
 *
 * Pure and cheap (one pass), shared by the layout engine and the scene so the rings, the unfolding and the layout agree on the
 * same tree. The graph itself is not touched: `GraphNode.parent` is still the folder it lives in, which the roll-ups, the
 * breadcrumbs and the AI link use.
 */
import { isGalaxyNode, type GraphData } from '@aether/core'

/** The node the sky circles (the Bio, or its dormant star), or -1 when the graph has none. */
export function blackHoleOf(graph: GraphData): number {
  const nodes = graph.nodes
  for (let i = 0; i < nodes.length; i++) if (nodes[i]!.folder?.bio === true) return i
  return -1
}

/** The index each node orbits (-1 for none): the folder it lives in, except that every galaxy and every loose folder root circles the Bio. */
export function orbitParents(graph: GraphData): Int32Array {
  const nodes = graph.nodes
  const parent = new Int32Array(nodes.length)
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i]!.orbit ?? nodes[i]!.parent
    parent[i] = p === null ? -1 : (graph.index.get(p) ?? -1)
  }
  const hole = blackHoleOf(graph)
  if (hole < 0) return parent
  for (let i = 0; i < nodes.length; i++) {
    if (i === hole) {
      parent[i] = -1
      continue
    }
    const n = nodes[i]!
    // The Today hub hangs above its own sun, a note or a picture keeps its folder: only a galaxy, or a folder that was a root, moves.
    if (n.folder === undefined) continue
    if (parent[i]! < 0 || isGalaxyNode(n)) parent[i] = hole
  }
  return parent
}
