/**
 * The cosmology of the system layout, in the words of the vault (docs/COSMOLOGY.md, which is also the contract the Unreal version
 * is built to). Space nests the way folders do:
 *
 *   a drive                       a galaxy      (a vault folder that is the whole vault is one too)
 *   a folder directly in a galaxy a star        (a project folder is a brighter, bigger one)
 *   a folder directly in a star   a planet
 *   a folder in a planet          a moon        (and a folder in a moon is a moon of that moon, without limit)
 *   every file                    a satellite   (it orbits a moon, never a star or a planet; a big one is drawn bigger)
 *
 * Everything orbits what is above it. Urgency (`markdown/urgency.ts`) is the orbit's speed and the star's brightness.
 */
import type { GraphData, GraphNode, NoteId } from '../types'

/** A picture, video or model smaller than this is a moon (an icon, a sprite, a tiny clip); bigger, a planet. */
export const PLANET_MIN_BYTES = 48 * 1024
/** A note of at least this many words is a planet (a document); shorter ones are moons. */
export const PLANET_MIN_WORDS = 3000

/**
 * True for a file big enough to matter (a picture, video or model of 48 KB or more or one nobody sized, a note of 3,000 words or
 * more): it is drawn bigger (an extra-large thumbnail, a solid sphere). It is still a satellite: no file is a planet.
 */
export function isBigFile(n: GraphNode): boolean {
  return isPlanetNode(n)
}

/** The old name of `isBigFile` (a big file used to be a planet; a planet is a folder now). */
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
export type LegendBody = 'galaxy' | 'star' | 'planet' | 'moon' | 'satellite' | 'sun' | 'picture'
export const LEGEND_BODIES: readonly LegendBody[] = ['galaxy', 'star', 'planet', 'moon', 'satellite', 'sun', 'picture']

/**
 * Which of the legend's kinds a node is. A drive (or a one-folder vault) is a galaxy; a folder is a star, a planet or a moon by
 * how deep it sits (`folderBodies`, which needs the graph, so a lone node is judged by its own depth: `legendBodiesIn` is the
 * exact one); a board with pictures orbiting it a sun; every file a satellite. A picture is also a picture. The Today hub is none.
 */
export function legendBodies(n: GraphNode, folderBody?: FolderBody): LegendBody[] {
  if (n.kind === 'today') return []
  if (n.folder) {
    if (isGalaxyNode(n)) return ['galaxy']
    return [folderBody === 'planet' ? 'planet' : folderBody === 'moon' ? 'moon' : 'star']
  }
  if (n.board) return ['sun']
  if (n.kind === 'image') return ['satellite', 'picture']
  return ['satellite']
}

/** `legendBodies` for node `i` of a graph, with the folder's exact body. */
export function legendBodiesIn(graph: GraphData, i: number, bodies: Uint8Array = folderBodies(graph)): LegendBody[] {
  return legendBodies(graph.nodes[i]!, FOLDER_BODY_NAMES[bodies[i]!])
}

/* ---- star, planet, moon: what depth makes a folder ---- */

/** What a folder is by where it sits: a star directly in a galaxy, a planet in a star, a moon in a planet or in another moon. */
export type FolderBody = 'galaxy' | 'star' | 'planet' | 'moon'
/** The codes `folderBodies` writes; 0 is a node that is not a folder. */
export const FB_NONE = 0
export const FB_GALAXY = 1
export const FB_STAR = 2
export const FB_PLANET = 3
export const FB_MOON = 4
export const FOLDER_BODY_NAMES: readonly (FolderBody | undefined)[] = [undefined, 'galaxy', 'star', 'planet', 'moon']

/** The body of every folder node, by node index (FB_NONE for anything that is not a folder). A moon's folder is a moon without limit of depth. */
export function folderBodies(graph: GraphData): Uint8Array {
  const nodes = graph.nodes
  const out = new Uint8Array(nodes.length)
  const done = new Uint8Array(nodes.length)
  const walk = (start: number): void => {
    // The chain of folders up to one that is known (capped, so an owner cycle a sane graph never has cannot hang it).
    const chain: number[] = []
    let cur = start
    while (cur >= 0 && !done[cur] && chain.length < 64) {
      chain.push(cur)
      const n = nodes[cur]!
      const p = n.parent === null ? -1 : (graph.index.get(n.parent) ?? -1)
      if (n.folder === undefined || isGalaxyRole(n)) break
      cur = p
    }
    for (let k = chain.length - 1; k >= 0; k--) {
      const i = chain[k]!
      const n = nodes[i]!
      done[i] = 1
      if (n.folder === undefined) continue
      if (isGalaxyRole(n)) {
        out[i] = FB_GALAXY
        continue
      }
      // A home moon is a moon wherever its folder sits (a star holds its own files on one).
      if (n.folder.home === true) {
        out[i] = FB_MOON
        continue
      }
      const pi = n.parent === null ? -1 : (graph.index.get(n.parent) ?? -1)
      const above = pi >= 0 && nodes[pi]!.folder !== undefined ? out[pi]! : FB_NONE
      out[i] = above === FB_STAR ? FB_PLANET : above === FB_PLANET || above === FB_MOON ? FB_MOON : FB_STAR
    }
  }
  for (let i = 0; i < nodes.length; i++) if (!done[i]) walk(i)
  return out
}

/* ---- suns open into planets, then moons ---- */

/**
 * How much of a sun's system is shown: 0 closed (only the sun itself), 1 the bodies of its sub-folders (a star's planets, a
 * planet's moons, a moon's moons), 2 those and its files (its satellites). A sun opens when it is clicked. The folders
 * directly under a galaxy (a drive, the vault) are always shown, so a closed vault is a field of suns, not one point.
 */
export type SunLevel = 0 | 1 | 2
export const SUN_LEVELS: readonly SunLevel[] = [0, 1, 2]
export const SUN_LEVEL_NAMES: Record<SunLevel, string> = { 0: 'Closed', 1: 'Folders', 2: 'Folders + files' }

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
 * 1 once its sub-folders show (a sub-folder, a reference board), 2 once its files show (every file, and every unresolved link).
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
    else out[i] = 2
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
    const p = nodes[i]!.orbit ?? nodes[i]!.parent
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
  /** Reference boards it shows from level 1 (a board with pictures is a sun of its own). */
  planets: number
  /** Its sub-folders (a star's planets, a planet's moons, a moon's moons), shown from level 1. */
  systems: number
  /** Its files (satellites), shown from level 2. */
  moons: number
}

/** What each sun holds, by the id of the sun: only suns that hold at least one body are in it. */
export function sunCounts(graph: GraphData): Map<NoteId, SunCounts> {
  const owners = bodyOwners(graph)
  const tiers = bodyTiers(graph)
  const out = new Map<NoteId, SunCounts>()
  for (let i = 0; i < graph.nodes.length; i++) {
    let o = owners[i]!
    const tier = tiers[i]!
    // A home moon is its folder's files, not a folder of its own: it is not counted, and its files count for the folder.
    if (graph.nodes[i]!.folder?.home === true) continue
    if (o >= 0 && graph.nodes[o]!.folder?.home === true) o = graph.index.get(graph.nodes[o]!.parent ?? '') ?? -1
    // What is always shown (the folders directly under a galaxy, the Today hub) is not the sun's to hold back: not counted, no entry made.
    if (o < 0 || tier === 0) continue
    const node = graph.nodes[i]!
    const id = graph.nodes[o]!.id
    let c = out.get(id)
    if (!c) {
      c = { planets: 0, systems: 0, moons: 0 }
      out.set(id, c)
    }
    // A sub-folder's body comes out with level 1.
    if (node.folder !== undefined) c.systems++
    else if (tier === 2) c.moons++
    else c.planets++
  }
  return out
}
