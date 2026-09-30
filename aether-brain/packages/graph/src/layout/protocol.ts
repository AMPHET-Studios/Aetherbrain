/** Messages between the main thread and the layout worker. */

/**
 * constellation — force layout clustered by PARA area
 * orbit         — force layout with time as radial rings
 * system        — solar system: the folder tree laid out analytically; folders
 *                 are stars/planets, notes are moons, children orbit parents
 */
export type LayoutMode = 'constellation' | 'orbit' | 'system'

/**
 * Node kind codes for the worker: 0 note, 1 ghost, 2 folder, 3 the Today hub,
 * 4 image. Images lay out like notes (leaf moons); the Today hub sits still
 * straight above the root sun in the system layout and floats freely (pulled
 * by its beams) in the force layouts.
 */
export type LayoutKind = 0 | 1 | 2 | 3 | 4
/** Folder role codes: 0 root, 1 mount, 2 project, 3 folder; -1 for non-folders. */
export type LayoutRole = -1 | 0 | 1 | 2 | 3

export interface LayoutNodeInput {
  id: string
  /** Index into the area anchor table (0..5). */
  area: number
  degree: number
  /** Epoch ms or null — drives the orbit (time) layout. */
  created: number | null
  ghost: boolean
  /** Visual radius, used for collision. */
  radius: number
  /** System layout: index of the structural parent node, -1 for none (the root). */
  parent: number
  kind: LayoutKind
  role: LayoutRole
}

export interface LayoutEdgeInput {
  /** Source/target as indices into the node array. */
  s: number
  t: number
  w: number
}

export type MainToWorker =
  | {
      type: 'graph'
      nodes: LayoutNodeInput[]
      edges: LayoutEdgeInput[]
      mode: LayoutMode
      /** Previous positions keyed by id, so re-layouts don't explode. */
      prev?: { ids: string[]; positions: Float32Array }
      seed?: number
    }
  | { type: 'mode'; mode: LayoutMode }
  | { type: 'pin'; index: number; x: number; y: number; z: number }
  | { type: 'release'; index: number; reheat: boolean }
  | { type: 'reheat'; alpha?: number }
  /** System layout: planets orbit their parents over time when on. */
  | { type: 'motion'; on: boolean }
  | { type: 'stop' }

export type WorkerToMain =
  | {
      type: 'positions'
      /** xyz triples in node order. Transferred, not copied. */
      positions: Float32Array
      alpha: number
      /** True on the final frame of a simulation run. */
      settled: boolean
      /** Layout generation the positions belong to. */
      generation: number
    }
  | { type: 'ready'; generation: number }
  | {
      /**
       * Orbit rings for the system layout, sent once per layout generation
       * (an empty array in other modes). 6 floats per ring:
       * parentIndex, radius, qx, qy, qz, qw — a circle of `radius` in the XZ
       * plane, rotated by quaternion q, centred on the parent's live position.
       */
      type: 'rings'
      rings: Float32Array
      generation: number
    }
