/**
 * Picture thumbnails on image moons: the bookkeeping. Which image nodes
 * deserve one of the texture layers, which layer each picture lives in, what
 * to load next and what to leave alone. No three.js and no DOM here, so all
 * of it is unit-tested in node; `thumbLayer.ts` is the GPU and decoding side.
 *
 * Pictures are identified by `thumbKey` (path + mtime + size), never by node
 * index: graphs are rebuilt on every edit, and a picture that stays in the
 * graph keeps its layer across rebuilds.
 */
import type { ImageNodeInfo } from '@aether/core'

/** Layers of the thumbnail texture array: at most this many pictures at once. */
export const THUMB_LAYERS = 256
/** Width and height of one layer (px). */
export const THUMB_SIZE = 128
/** Size asked of the loader: twice the layer, so a cover-cropped wide picture still fills it. */
export const THUMB_REQUEST = THUMB_SIZE * 2
/** Smallest projected radius (px) at which a moon's picture is worth a layer. */
export const THUMB_MIN_PX = 5
/** Loads running at once. */
export const THUMB_MAX_IN_FLIGHT = 6
/** How often the wanted pictures are ranked again (ms). */
export const THUMB_TICK_MS = 250
/**
 * A failed picture is tried again after this long (ms, in the clock `want`
 * is given): not every tick, but a thumbnail that timed out while a drive
 * woke up does come back.
 */
export const THUMB_RETRY_MS = 60_000
/** Billboard width over the node's radius. */
export const THUMB_SCALE = 2.4
/** Hovered and selected pictures grow like the cores do. */
export const THUMB_HOVER_SCALE = 1.15
export const THUMB_SELECTED_SCALE = 1.3

/** Half the drawn width of node `i`'s picture over its projected radius (hover and selection grow it). */
export function thumbHalf(i: number, selI: number, hovI: number): number {
  return (THUMB_SCALE / 2) * (i === selI ? THUMB_SELECTED_SCALE : i === hovI ? THUMB_HOVER_SCALE : 1)
}

/**
 * True when the pointer, (dx, dy) px from a node's projected centre, hits it:
 * a picture is hit anywhere on its square as drawn (plus a 5 px margin, which
 * also covers the billboard's small shift toward the camera); a body within
 * its projected radius plus 5 px, never less than 9 px.
 */
export function thumbPickHit(dx: number, dy: number, radiusPx: number, picture: boolean, half: number): boolean {
  if (picture) return Math.max(Math.abs(dx), Math.abs(dy)) <= Math.max(9, radiusPx * half + 5)
  return Math.hypot(dx, dy) <= Math.max(9, radiusPx + 5)
}

/** Identity of one version of a picture: its path, plus mtime and size so an edited file loads again. */
export function thumbKey(image: Pick<ImageNodeInfo, 'path' | 'mtime' | 'size'>): string {
  return `${image.path}\u0000${image.mtime ?? ''}\u0000${image.size ?? ''}`
}

/**
 * Image nodes worth a thumbnail, biggest on screen first: in front of the
 * camera (NDC depth −1..1), on the viewport (billboard included) and at
 * least `minPx` in projected radius. `screen` holds 4 floats per graph node
 * (x, y, depth, radius in px) and `nodes` the graph indices of the image
 * nodes; `out` receives positions in `nodes` (at most `max`), ties broken by
 * position so the ranking is stable.
 */
export function rankThumbCandidates(
  screen: ArrayLike<number>,
  nodes: ArrayLike<number>,
  width: number,
  height: number,
  out: number[],
  max = THUMB_LAYERS,
  minPx = THUMB_MIN_PX,
): number[] {
  out.length = 0
  for (let k = 0; k < nodes.length; k++) {
    const i = nodes[k]!
    const depth = screen[i * 4 + 2]
    const r = screen[i * 4 + 3]
    if (depth === undefined || r === undefined || !(depth >= -1 && depth <= 1) || !(r >= minPx)) continue
    const x = screen[i * 4]!
    const y = screen[i * 4 + 1]!
    const m = (r * THUMB_SCALE) / 2
    if (!(x >= -m && x <= width + m && y >= -m && y <= height + m)) continue
    out.push(k)
  }
  out.sort((a, b) => screen[nodes[b]! * 4 + 3]! - screen[nodes[a]! * 4 + 3]! || a - b)
  if (out.length > max) out.length = Math.max(0, max)
  return out
}

/** The centred square of a `width` × `height` picture: what a cover crop keeps. */
export function coverRect(width: number, height: number): { sx: number; sy: number; side: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 0
  const h = Number.isFinite(height) && height > 0 ? height : 0
  const side = Math.min(w, h)
  return { sx: (w - side) / 2, sy: (h - side) / 2, side }
}

/** Which picture each texture layer holds. */
export interface SlotTable {
  /** Picture key per layer (null: free). */
  keys: (string | null)[]
  /** When each layer's picture was last wanted (ms). */
  lastWanted: Float64Array
  /** Layer per held key. */
  layerOf: Map<string, number>
}

export function createSlotTable(layers = THUMB_LAYERS): SlotTable {
  return { keys: new Array<string | null>(layers).fill(null), lastWanted: new Float64Array(layers), layerOf: new Map() }
}

export function clearSlots(t: SlotTable): void {
  t.keys.fill(null)
  t.lastWanted.fill(0)
  t.layerOf.clear()
}

/**
 * A layer for a freshly decoded picture last wanted at `wantedAt`: the
 * picture's own layer when it has one, else the first free layer, else the
 * layer wanted least recently, but only when that was before `wantedAt` (a
 * picture never pushes out one wanted as recently as itself). −1: no room.
 */
export function claimSlot(t: SlotTable, key: string, wantedAt: number): number {
  const own = t.layerOf.get(key)
  if (own !== undefined) {
    t.lastWanted[own] = Math.max(t.lastWanted[own]!, wantedAt)
    return own
  }
  let victim = -1
  let oldest = Infinity
  for (let l = 0; l < t.keys.length; l++) {
    if (t.keys[l] === null) {
      victim = l
      oldest = -Infinity
      break
    }
    if (t.lastWanted[l]! < oldest) {
      oldest = t.lastWanted[l]!
      victim = l
    }
  }
  if (victim < 0 || !(oldest < wantedAt)) return -1
  const old = t.keys[victim]
  if (old !== null && old !== undefined) t.layerOf.delete(old)
  t.keys[victim] = key
  t.layerOf.set(key, victim)
  t.lastWanted[victim] = wantedAt
  return victim
}

/** Give a layer back (its picture could not be stored). */
export function releaseSlot(t: SlotTable, layer: number): void {
  const key = t.keys[layer]
  if (key === null || key === undefined) return
  t.layerOf.delete(key)
  t.keys[layer] = null
  t.lastWanted[layer] = 0
}

/** Where pictures come from and where they go. */
export interface ThumbSource<P> {
  /** Read and decode one picture; null (or a rejection) when it can't be. */
  load(path: string): Promise<P | null>
  /** Put a decoded picture into a texture layer. */
  store(layer: number, picture: P): void
}

interface Flight {
  key: string
  wantedAt: number
}

/**
 * What to load and which layer it goes to. Each tick `want` gets the wanted
 * pictures, biggest first: held ones keep their layer (their last-wanted
 * time is refreshed), missing ones are loaded, at most `maxInFlight` at once
 * and never the same path twice at once. A finished load claims a layer
 * (least recently wanted goes first) and is stored; the next wanted picture
 * starts right away. Failures (null or a rejection) are remembered per key
 * and retried only after THUMB_RETRY_MS, on `retryFailed` or with a new key
 * (the file changed).
 * `reset` (another vault) forgets everything and drops the loads in flight.
 */
export class ThumbScheduler<P> {
  readonly table: SlotTable
  /** Bumped whenever a layer changes hands: the renderer maps nodes to layers again. */
  version = 0
  private readonly inFlight = new Map<string, Flight>()
  /** Failed keys → when they failed (the last `want` time then). */
  private readonly failed = new Map<string, number>()
  private generation = 0
  private readonly wantedKeys: string[] = []
  private readonly wantedPaths: string[] = []
  private wantedAt = 0

  constructor(
    private readonly source: ThumbSource<P>,
    layers = THUMB_LAYERS,
    private readonly maxInFlight = THUMB_MAX_IN_FLIGHT,
  ) {
    this.table = createSlotTable(layers)
  }

  /** Loads running now. */
  get loading(): number {
    return this.inFlight.size
  }

  /** Layer holding the picture `key`, or −1. */
  layerOf(key: string): number {
    return this.table.layerOf.get(key) ?? -1
  }

  /** True while `key`'s last failure is recent (not yet due for another try). */
  hasFailed(key: string): boolean {
    const at = this.failed.get(key)
    return at !== undefined && this.wantedAt - at < THUMB_RETRY_MS
  }

  /** The pictures wanted now (`count` entries of the parallel `keys` / `paths`, biggest first). */
  want(keys: ArrayLike<string>, paths: ArrayLike<string>, count: number, now: number): void {
    const n = Math.min(count, keys.length, paths.length, this.table.keys.length)
    this.wantedKeys.length = 0
    this.wantedPaths.length = 0
    this.wantedAt = now
    for (let k = 0; k < n; k++) {
      const key = keys[k]!
      const path = paths[k]!
      this.wantedKeys.push(key)
      this.wantedPaths.push(path)
      const layer = this.table.layerOf.get(key)
      if (layer !== undefined) this.table.lastWanted[layer] = now
      else {
        const f = this.inFlight.get(path)
        if (f && f.key === key) f.wantedAt = now
      }
    }
    this.pump()
  }

  /** Try the failed pictures again (thumbnails were switched back on). */
  retryFailed(): void {
    this.failed.clear()
    this.pump()
  }

  /** Another vault (or none): forget every picture and ignore the loads still in flight. */
  reset(): void {
    this.generation++
    this.inFlight.clear()
    this.failed.clear()
    this.wantedKeys.length = 0
    this.wantedPaths.length = 0
    clearSlots(this.table)
    this.version++
  }

  /** Start loads for wanted pictures that have no layer, down the list, while there is room. */
  private pump(): void {
    for (let k = 0; k < this.wantedKeys.length && this.inFlight.size < this.maxInFlight; k++) {
      const key = this.wantedKeys[k]!
      const path = this.wantedPaths[k]!
      if (this.table.layerOf.has(key) || this.hasFailed(key) || this.inFlight.has(path)) continue
      this.start(key, path)
    }
  }

  private start(key: string, path: string): void {
    const gen = this.generation
    const flight: Flight = { key, wantedAt: this.wantedAt }
    this.inFlight.set(path, flight)
    let task: Promise<P | null>
    try {
      task = this.source.load(path)
    } catch {
      task = Promise.resolve(null)
    }
    task.then(
      (picture) => this.finish(gen, path, flight, picture ?? null),
      () => this.finish(gen, path, flight, null),
    )
  }

  private finish(gen: number, path: string, flight: Flight, picture: P | null): void {
    if (gen !== this.generation) return
    if (this.inFlight.get(path) === flight) this.inFlight.delete(path)
    if (picture === null) {
      this.failed.set(flight.key, this.wantedAt)
    } else {
      this.failed.delete(flight.key)
      const layer = claimSlot(this.table, flight.key, flight.wantedAt)
      if (layer >= 0) {
        try {
          this.source.store(layer, picture)
          this.version++
        } catch {
          releaseSlot(this.table, layer)
          this.failed.set(flight.key, this.wantedAt)
          this.version++
        }
      }
    }
    this.pump()
  }
}
