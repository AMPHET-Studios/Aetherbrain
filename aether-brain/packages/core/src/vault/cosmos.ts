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
import type { GraphNode } from '../types'

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

/** True for a folder node that is a galaxy: a drive, or the vault root of a single-root vault. */
export function isGalaxyNode(n: GraphNode): boolean {
  const f = n.folder
  if (!f) return false
  return f.role === 'mount' || (f.role === 'root' && f.galaxy === true)
}
