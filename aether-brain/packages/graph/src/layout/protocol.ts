/** Messages between the main thread and the layout worker. */

export type LayoutMode = 'constellation' | 'orbit'

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
