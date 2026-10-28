/**
 * The sky builds itself in order: galaxies first, then stars, then planets, then moons, then the files that orbit them. Pure arrays in,
 * arrays out (no three.js), like `reveal.ts`, which it feeds: a body that is not due yet is *held*, and a held body's reveal target is 0,
 * so it grows out of its sun along its own orbit when its turn comes.
 *
 * It runs when a vault opens (every body is new) and whenever something is added (only the new bodies are held, and they come in the same
 * order among themselves: a new folder, then what is in it). Nothing that was already in the sky is held, so an edit never makes the
 * rest of it flicker.
 */
import { isGalaxyNode, isPlanetNode, type GraphData, type GraphNode } from '@aether/core'

/** The order things appear in. */
export const BUILD_GALAXY = 0
export const BUILD_STAR = 1
export const BUILD_PLANET = 2
export const BUILD_MOON = 3
export const BUILD_FILE = 4

/** Seconds between one stage starting and the next. */
export const BUILD_STAGE_SECONDS = 0.8
/** Within a stage the bodies do not all come at once: each waits up to this much of a stage, by its own number. */
export const BUILD_SPREAD = 0.55

/** Which stage a node belongs to. */
export function stageOf(n: GraphNode): number {
  if (n.folder !== undefined) return isGalaxyNode(n) ? BUILD_GALAXY : BUILD_STAR
  if (n.board !== undefined || n.kind === 'today') return BUILD_STAR
  if (n.kind === 'image' && n.image?.file !== undefined) return BUILD_FILE
  if (n.ghost) return BUILD_MOON
  return isPlanetNode(n) ? BUILD_PLANET : BUILD_MOON
}

/** The stage of every node, by index. */
export function bodyStages(graph: GraphData): Uint8Array {
  const out = new Uint8Array(graph.nodes.length)
  for (let i = 0; i < out.length; i++) out[i] = stageOf(graph.nodes[i]!)
  return out
}

/** A number in [0, 1) that is always the same for the same index (a cheap integer hash: the spread must not change between frames). */
function jitter(i: number): number {
  let x = (i + 1) * 0x9e3779b1
  x ^= x >>> 15
  x = Math.imul(x, 0x85ebca6b)
  x ^= x >>> 13
  return ((x >>> 0) % 1000) / 1000
}

/**
 * When each body is due, in seconds from the moment the graph appeared. `isNew(i)` says whether body `i` is new: a body that was
 * already in the sky is due at 0. The new bodies are timed from the earliest stage among them, so a lone new note does not wait for
 * the galaxies and stars it was never going to add. Returns the latest due time (0 when nothing is held).
 */
export function buildDelays(stage: Uint8Array, isNew: (i: number) => boolean, count: number, out: Float32Array): number {
  let first = 255
  for (let i = 0; i < count; i++) if (isNew(i) && stage[i]! < first) first = stage[i]!
  let latest = 0
  for (let i = 0; i < count; i++) {
    if (!isNew(i)) {
      out[i] = 0
      continue
    }
    const d = (stage[i]! - first) * BUILD_STAGE_SECONDS + jitter(i) * BUILD_SPREAD * BUILD_STAGE_SECONDS
    out[i] = d
    if (d > latest) latest = d
  }
  return latest
}

/** Fill `hold` with 1 for each body that is not due at `clock`; returns how many are held. */
export function holdBodies(delay: Float32Array, clock: number, count: number, hold: Uint8Array): number {
  let held = 0
  for (let i = 0; i < count; i++) {
    const h = delay[i]! > clock ? 1 : 0
    hold[i] = h
    held += h
  }
  return held
}
