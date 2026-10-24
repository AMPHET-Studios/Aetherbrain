/**
 * Auto-baking the pictures of 3D models. Without it a model got its picture only when the camera came near enough to want it, and
 * a big one (an export of 300 MB) took the helper a moment: the first fly-by showed a plain moon. The baker walks the models of the vault
 * a little after it opens, one at a time, and has each one drawn ahead of need (the picture is kept on disk: `model-icons.ts`).
 *
 * It is a background job and keeps to its place: it waits `delayMs` after the vault opens (the window is busy opening it), makes one
 * picture at a time with a rest between (`gapMs`), counts only the pictures it really had to draw (a model baked on an earlier day is
 * a check of the disk), stops after `limit` of them (the rest are drawn when they come into view, as they always were, or on the next
 * start), and forgets everything when the vault changes. A model that was just added or changed jumps the queue and does not count
 * against the limit. It never throws: a model that cannot be baked is left for when it is seen.
 *
 * `bake` makes one model's pictures and says whether it had to draw anything; `models` lists what the vault holds, most important
 * first. Both are the app's own (main.ts); timers are injected so a test can run a whole vault in no time.
 */
export interface BakerOptions {
  /** Wait after `start` before the first model. */
  delayMs?: number
  /** Rest after a picture that had to be drawn. */
  gapMs?: number
  /** Most models drawn from the vault's list per `start`. */
  limit?: number
}

export interface BakerTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
}

const realTimers: BakerTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    // A rest must never keep the process from ending.
    t.unref?.()
    return t
  },
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
}

export const BAKE_DELAY_MS = 15_000
export const BAKE_GAP_MS = 250
export const BAKE_LIMIT = 200

interface Item {
  path: string
  /** Just added or changed: ahead of the rest, and not counted against the limit. */
  urgent: boolean
}

export class ModelBaker {
  private queue: Item[] = []
  private generation = 0
  private waiting: unknown = null
  private ready = false
  private active = false
  private drawn = 0

  constructor(
    private readonly bake: (path: string) => Promise<boolean>,
    private readonly models: () => string[],
    private readonly opts: BakerOptions = {},
    private readonly timers: BakerTimers = realTimers,
  ) {}

  /** Models waiting to be baked. */
  get pending(): number {
    return this.queue.length
  }

  /** Pictures it had to draw since the vault opened. */
  get baked(): number {
    return this.drawn
  }

  /** A vault opened (or reopened): forget the last one's queue and, after the delay, bake what this one holds. */
  start(): void {
    this.stop()
    const gen = this.generation
    this.waiting = this.timers.setTimeout(() => {
      this.waiting = null
      if (gen !== this.generation) return
      let list: string[] = []
      try {
        list = this.models()
      } catch {
        /* no vault (any more) */
      }
      const known = new Set(this.queue.map((i) => i.path))
      for (const p of list) {
        if (known.has(p)) continue
        known.add(p)
        this.queue.push({ path: p, urgent: false })
      }
      this.ready = true
      void this.run(gen)
    }, this.opts.delayMs ?? BAKE_DELAY_MS)
  }

  /** Models that are new or changed: baked first, once the baker is going (and, if it is not yet, when it starts). */
  add(paths: readonly string[]): void {
    if (!this.waiting && !this.ready) return
    const fresh = new Set(paths)
    const rest = this.queue.filter((i) => !fresh.has(i.path))
    this.queue = [...[...fresh].map((p) => ({ path: p, urgent: true })), ...rest]
    if (this.ready) void this.run(this.generation)
  }

  /** The vault closed or the app quits: nothing more is baked (a picture being drawn finishes and is dropped). */
  stop(): void {
    this.generation++
    if (this.waiting !== null) this.timers.clearTimeout(this.waiting)
    this.waiting = null
    this.queue = []
    this.ready = false
    this.active = false
    this.drawn = 0
  }

  private async run(gen: number): Promise<void> {
    if (this.active) return
    this.active = true
    try {
      while (gen === this.generation) {
        // Past the limit only what was just added is still baked.
        if (this.drawn >= (this.opts.limit ?? BAKE_LIMIT)) this.queue = this.queue.filter((i) => i.urgent)
        const next = this.queue.shift()
        if (!next) return
        let drew = false
        try {
          drew = await this.bake(next.path)
        } catch {
          /* it is baked when it is seen */
        }
        if (gen !== this.generation) return
        if (drew) {
          if (!next.urgent) this.drawn++
          await new Promise<void>((resolve) => this.timers.setTimeout(resolve, this.opts.gapMs ?? BAKE_GAP_MS))
        }
      }
    } finally {
      if (gen === this.generation) this.active = false
    }
  }
}
