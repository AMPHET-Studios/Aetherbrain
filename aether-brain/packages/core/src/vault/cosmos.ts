/**
 * The cosmology of the system layout, in the words of the vault:
 *
 *   a drive            a galaxy   (a vault folder that is the whole vault is one too)
 *   a folder           a star     (every folder; a project folder is a brighter, bigger one)
 *   a picture, video or 3D model, big enough to matter
 *                      a planet   (an extra-large thumbnail orbiting its folder's star)
 *   a note that is a document in its own right (thousands of words)
 *                      a planet   (a solid body, no thumbnail)
 *   every small file   a moon     (a small body on a close orbit)
 *
 * Everything orbits what is above it. Urgency (`markdown/urgency.ts`) is the orbit's speed and the star's
 * brightness. See docs/COSMOLOGY.md, which is also the contract the Unreal version is built to.
 */
import type { GraphData, GraphNode, NoteId } from '../types'

/** A picture, video or model smaller than this is a moon (an icon, a sprite, a tiny clip); bigger, a planet. */
export const PLANET_MIN_BYTES = 48 * 1024
/** A note of at least this many words is a planet (a document); shorter ones are moons. */
export const PLANET_MIN_WORDS = 3000

/** True for a leaf that is drawn as a planet; folders, ghosts and the Today hub never are. */
export function isPlanetNode(n: GraphNode): boolean {
  if (n.kind === 'image') {
    const size = n.image?.size
    // A size nobody looked at (a whole drive's pictures are not all stat'ed) is a planet: it is a picture, say so.
    return size === null || size === undefined || size >= PLANET_MIN_BYTES
  }
  if (n.kind === 'note') return n.wordCount >= PLANET_MIN_WORDS
  return false
}

/**
 * True for a folder node that is a galaxy: a drive, the vault root of a single-root vault, or a project folder the user marked as one
 * (`galaxyLevel`: the mark counts).
 */
export function isGalaxyNode(n: GraphNode): boolean {
  const f = n.folder
  if (!f) return false
  return f.role === 'mount' || (f.role === 'root' && f.galaxy === true) || f.galaxyLevel !== undefined
}

/** The kinds of body the legend names, and lets you light up (docs/COSMOLOGY.md). */
export type LegendBody = 'galaxy' | 'star' | 'planet' | 'moon' | 'sun' | 'picture'
export const LEGEND_BODIES: readonly LegendBody[] = ['galaxy', 'star', 'planet', 'moon', 'sun', 'picture']

/**
 * Which of the legend's kinds a node is. A drive (or a one-folder vault) is a galaxy, every other folder a star, a board with
 * pictures orbiting it a sun, a big file a planet and a small one a moon. A picture is also a picture: a big one is a planet and a
 * picture, a small one a moon and a picture. The Today hub is none of them.
 */
export function legendBodies(n: GraphNode): LegendBody[] {
  if (n.kind === 'today') return []
  if (n.folder) return [isGalaxyNode(n) ? 'galaxy' : 'star']
  if (n.board) return ['sun']
  if (n.kind === 'image') return isPlanetNode(n) ? ['planet', 'picture'] : ['moon', 'picture']
  return [isPlanetNode(n) ? 'planet' : 'moon']
}

/* ---- suns open into planets, then moons ---- */

/**
 * How much of a sun's system is shown: 0 closed (only the sun itself), 1 its planets (the big files and the long
 * notes) and the suns of its sub-folders, 2 those and its moons (every small file). A sun opens when it is clicked. The folders
 * directly under a galaxy (a drive, the vault) are always shown, so a closed vault is a field of suns, not one point.
 */
export type SunLevel = 0 | 1 | 2
export const SUN_LEVELS: readonly SunLevel[] = [0, 1, 2]
export const SUN_LEVEL_NAMES: Record<SunLevel, string> = { 0: 'Closed', 1: 'Planets', 2: 'Planets + moons' }

/**
 * True for a body that can open: a folder (a galaxy or a star) or a reference board with pictures orbiting it (a sun). The Bio
 * star before its folder exists has nothing in it to open.
 */
export function isSunNode(n: GraphNode): boolean {
  return (n.folder !== undefined && n.folder.placeholder !== true) || n.board !== undefined
}

/**
 * True for a drive, the vault's root (the origin of several drives too) and a folder marked as a galaxy: the galaxies, which are always
 * shown and open on their own. A galaxy sits on the galaxy above it, so the folders directly under one are stars on its disc.
 */
function isGalaxyRole(n: GraphNode | undefined): boolean {
  return n?.folder?.role === 'root' || n?.folder?.role === 'mount' || n?.folder?.galaxyLevel !== undefined
}

/**
 * What a sun must show for this body to show: 0 always (a galaxy, the Today hub, a folder directly under a galaxy),
 * 1 once planets show (a big file, a long note, a reference board, a sub-folder's sun), 2 once moons show (every small file and
 * every unresolved link).
 */
export type BodyTier = 0 | 1 | 2

/** The tier of every body (see `BodyTier`), by node index. */
export function bodyTiers(graph: GraphData): Uint8Array {
  const nodes = graph.nodes
  const out = new Uint8Array(nodes.length)
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    if (n.kind === 'today') out[i] = 0
    else if (n.folder !== undefined) {
      const parent = n.parent === null ? undefined : nodes[graph.index.get(n.parent) ?? -1]
      out[i] = isGalaxyRole(n) || isGalaxyRole(parent) || parent === undefined ? 0 : 1
    } else if (n.board !== undefined) out[i] = 1
    else if (n.ghost) out[i] = 2
    else out[i] = isPlanetNode(n) ? 1 : 2
  }
  return out
}

/**
 * The sun (a node index) each body belongs to: its folder; the board a picture orbits; for a folder, its parent folder; for an
 * unresolved link, the sun of the note that links to it. -1 for a galaxy and for a body with no sun (a graph built without folders).
 */
export function bodyOwners(graph: GraphData): Int32Array {
  const nodes = graph.nodes
  const owner = new Int32Array(nodes.length).fill(-1)
  const parentOf = (i: number): number => {
    const p = nodes[i]!.parent
    return p === null ? -1 : (graph.index.get(p) ?? -1)
  }
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    if (isGalaxyRole(n)) continue
    let p = parentOf(i)
    // Up to the nearest sun (a ghost hangs from the note that links to it).
    for (let hop = 0; hop < 8 && p >= 0 && !isSunNode(nodes[p]!); hop++) p = parentOf(p)
    owner[i] = p >= 0 && isSunNode(nodes[p]!) ? p : -1
  }
  return owner
}

/** Node indices with every owner before the bodies it owns (a sun before its planets, a galaxy before its stars): one pass can then settle who is shown. */
export function bodyOrder(owner: Int32Array): Int32Array {
  const n = owner.length
  const depth = new Int32Array(n).fill(-1)
  // The chain of owners being walked: capped, so an owner cycle (which a sane graph never has) cannot hang it.
  const chain = new Int32Array(65)
  for (let i = 0; i < n; i++) {
    if (depth[i]! >= 0) continue
    let len = 0
    let cur = i
    while (cur >= 0 && depth[cur]! < 0 && len < 64) {
      chain[len++] = cur
      cur = owner[cur]!
    }
    let d = cur >= 0 && depth[cur]! >= 0 ? depth[cur]! + 1 : 0
    for (let k = len - 1; k >= 0; k--) depth[chain[k]!] = d++
  }
  const idx = Int32Array.from({ length: n }, (_, i) => i)
  return idx.sort((a, b) => depth[a]! - depth[b]! || a - b)
}

export interface SunCounts {
  /** Planets the sun shows from level 1. */
  planets: number
  /** Suns of its sub-folders, shown with the planets (a board with pictures counts as a planet). */
  systems: number
  /** Moons it shows from level 2. */
  moons: number
}

/** What each sun holds, by the id of the sun: only suns that hold at least one body are in it. */
export function sunCounts(graph: GraphData): Map<NoteId, SunCounts> {
  const owners = bodyOwners(graph)
  const tiers = bodyTiers(graph)
  const out = new Map<NoteId, SunCounts>()
  for (let i = 0; i < graph.nodes.length; i++) {
    const o = owners[i]!
    const tier = tiers[i]!
    // What is always shown (the folders directly under a galaxy, the Today hub) is not the sun's to hold back: not counted, no entry made.
    if (o < 0 || tier === 0) continue
    const node = graph.nodes[i]!
    const id = graph.nodes[o]!.id
    let c = out.get(id)
    if (!c) {
      c = { planets: 0, systems: 0, moons: 0 }
      out.set(id, c)
    }
    // A sub-folder's sun comes out with the planets.
    if (node.folder !== undefined) c.systems++
    else if (tier === 2) c.moons++
    else c.planets++
  }
  return out
}
