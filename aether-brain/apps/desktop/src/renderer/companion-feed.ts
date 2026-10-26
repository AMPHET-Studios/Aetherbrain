/**
 * What the companion link publishes to a viewer (the Unreal app) and when: the scene whenever the brain's graph, colours
 * or selection change (cut to a budget by companion-bound.ts, written by companion-scene.ts), and where everything is
 * (and the orbit rings) whenever the layout moved. Plain TypeScript over a `source` (the brain's state) and a `sink`
 * (the bridge to main), so the whole of it runs in a test against the real layout engine and worker.
 * companion.ts feeds it from the store on a timer while a viewer reads.
 */
import type { GraphData, NoteId } from '@aether/core'
import type { ColorMode, PictureSize } from '@aether/graph'
import type { CompanionGraphDto } from '../shared/ipc'
import { COMPANION_BUDGET, boundRings, gatherPositions, planBase, planFor, type BasePlan, type ScenePlan } from './companion-bound'
import { companionScene, sceneSignature } from './companion-scene'

/** How long to wait before trying again when a scene could not be made or sent (ms). */
export const COMPANION_RETRY_MS = 3000

/** The part of the layout engine the feed reads. */
export interface FeedEngine {
  placed: boolean
  answered: boolean
  carried: number
  mode: string
  alpha: number
  frame: number
  positions: Float32Array
  rings: Float32Array
  ringsVersion: number
}

/** What the brain shows now. */
export interface FeedSource {
  graph: GraphData
  engine: FeedEngine
  vault: string
  /** Anything that is replaced when another vault is opened (changes the scene when it is not the one before). */
  adapter: unknown
  selectedId: NoteId | null
  colorMode: ColorMode
  activeTag: string | null
  layoutMode: CompanionGraphDto['layout']
  pictureSize: PictureSize
  /** How much each node is used (what a star's brightness is), in node order; null until worked out. */
  activity: Float32Array | null
}

export interface FeedSink {
  companionGraph(scene: CompanionGraphDto): void
  companionPositions(version: number, positions: Float32Array, rings: Float32Array): void
}

export class CompanionFeed {
  /**
   * Numbers the published scenes. It starts from the clock so that a window that was reloaded (its module starts again)
   * never repeats a number the viewer already holds: it would be told "nothing new" and keep drawing the old scene.
   */
  version = Math.floor(Date.now() / 1000)
  /** What the last published scene was made from: a new graph, colours or selection publish again. */
  private made: unknown[] = []
  private madeSignature = ''
  private retryAt = 0
  private sentFrame = -1
  private sentRings = -1
  /** What to send of the graph in `made`, and what it was made from. */
  private base: { graph: GraphData; plan: BasePlan } | null = null
  plan: ScenePlan | null = null
  ringsOut: Float32Array = new Float32Array(0)
  private ringsFrom = -1
  /** The rings are judged by where the bodies are, so they are worked out again until the bodies have arrived. */
  private ringsDirty = true
  private placed: Float32Array | null = null

  constructor(
    private readonly read: () => FeedSource | null,
    private readonly sink: FeedSink,
  ) {}

  /** A viewer came (back) and must get everything again. */
  restart(): void {
    this.made = []
    this.madeSignature = ''
    this.retryAt = 0
    this.sentFrame = -1
    this.sentRings = -1
    this.ringsDirty = true
  }

  /** The places again, though nothing moved (a viewer asking a window that has been quiet). */
  resend(): void {
    this.sentFrame = -1
    this.sentRings = -1
  }

  /** Nobody reads any more: let go of everything held for them. */
  stop(): void {
    this.restart()
    this.base = null
    this.plan = null
    this.placed = null
    this.ringsOut = new Float32Array(0)
  }

  /** Publish the scene for the state in `key` (a new graph, colours, selection …). False when it could not be made. */
  private publish(src: FeedSource, key: unknown[]): boolean {
    const g = src.graph
    try {
      // Which part of a big brain the viewer gets: once per graph, and again for another selection.
      if (this.base?.graph !== g) this.base = { graph: g, plan: planBase(g, COMPANION_BUDGET) }
      const next = planFor(g, this.base.plan, src.selectedId, COMPANION_BUDGET)
      const scene = companionScene(
        g,
        {
          version: this.version + 1,
          vault: src.vault,
          layout: src.layoutMode,
          colorMode: src.colorMode,
          activeTag: src.activeTag,
          selectedId: src.selectedId,
          pictureSize: src.pictureSize,
          activity: src.activity,
        },
        next,
      )
      const signature = sceneSignature(scene)
      // The very same scene (a note edited, a file seen twice): the viewer has it, it is not handed a second copy.
      if (signature === this.madeSignature) {
        this.plan = next
        this.made = key
        return true
      }
      this.sink.companionGraph(scene)
      this.plan = next
      this.made = key
      this.version++
      this.madeSignature = signature
      this.sentFrame = -1
      this.ringsFrom = -1
      this.ringsOut = new Float32Array(0)
      this.ringsDirty = true
      return true
    } catch (err) {
      console.warn('Unreal companion link: the scene could not be made or sent', err)
      // Too big to build or to send (out of memory): not for every tick.
      this.plan = null
      this.madeSignature = ''
      this.retryAt = Date.now() + COMPANION_RETRY_MS
      return false
    }
  }

  tick(): void {
    const src = this.read()
    if (!src) return
    const g = src.graph
    const key = [g, src.colorMode, src.activeTag, src.selectedId, src.layoutMode, src.adapter, src.pictureSize, src.activity]
    if (key.some((k, i) => k !== this.made[i])) {
      if (Date.now() < this.retryAt || !this.publish(src, key)) return
    }
    const eng = src.engine
    const plan = this.plan
    // Until the layout has places for this node set, the positions are a seed (zeros for a new vault): not the brain's places.
    if (!plan || !eng.placed) return
    // Mid-rebuild the positions may still be the previous node set's.
    if (eng.positions.length !== g.nodes.length * 3) return
    // The system layout grows a new vault out of its root over a second or so, and every orbit ring is found by where the
    // bodies are on it. A viewer handed that would frame the camera on a clump and get no orbits: the first frames are held
    // back. (A node set most of which was there before is no such thing: its bodies are where they were.)
    const easing = eng.answered && eng.mode === 'system' && eng.alpha > 0
    if (easing && eng.carried < 0.5) return
    if (eng.frame === this.sentFrame && eng.ringsVersion === this.sentRings) return
    const out = gatherPositions(plan, eng.positions, this.placed ?? undefined)
    if (!out) return
    this.sentFrame = eng.frame
    if (eng.ringsVersion !== this.ringsFrom) {
      this.ringsFrom = eng.ringsVersion
      this.ringsDirty = true
    }
    if (this.ringsDirty) {
      this.ringsOut = boundRings(g, plan, eng.rings, eng.positions, COMPANION_BUDGET.rings)
      // The first frames of a layout are the old places (or its seed), then bodies on their way: judged again until the last.
      this.ringsDirty = !eng.answered || easing
    }
    this.sentRings = eng.ringsVersion
    this.placed = out
    this.sink.companionPositions(this.version, out, this.ringsOut)
  }
}
