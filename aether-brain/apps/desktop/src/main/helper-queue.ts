/**
 * Jobs for a hidden helper renderer (the thumbnail helper, the vision
 * helper), with the bookkeeping that keeps a bad picture from taking the app
 * down: the helper starts lazily, `concurrency` jobs are in flight and the
 * rest wait in order, every job has a timeout (it gets no answer, the helper
 * is destroyed, the next job starts a new one), answers count only from the
 * current helper, and after a crash the jobs that were in flight run again
 * one at a time, so the job that crashes it is the only one without an
 * answer. Pure: no electron import (tested with a fake helper).
 */

/** One helper as the queue sees it (a hidden window in the app, a fake in tests). */
export interface QueueHelper<J> {
  /** Its webContents id: an answer from anyone else is ignored. */
  readonly id: number
  send(id: number, job: J): void
  /** Close it for good; `hung`: it stopped answering, end its process instead of asking it to close. */
  destroy(hung: boolean): void
}

export interface HelperQueueOptions<J = unknown> {
  /** What the helper is called in errors (`thumbnail helper`). */
  name: string
  /** The error a job that got no answer through no fault of its own rejects with. */
  unavailable: (message: string) => Error
  /** What stop() tells the jobs it fails (`Thumbnails stopped`). */
  stopped: string
  /** Longest one job may take (and the helper to start, unless startTimeoutMs says otherwise). */
  timeoutMs: number
  /** Longest the helper may take to say it listens. */
  startTimeoutMs?: number
  /** A job that is allowed longer (or less) than `timeoutMs`: its own limit, or undefined for the usual one. */
  timeoutFor?: (job: J) => number | undefined
  /** Jobs in flight at once. */
  concurrency: number
}

interface Waiting<J, R> {
  job: J
  resolve(answer: R | null): void
  reject(err: Error): void
  /** In flight when a helper crashed: from then on it runs alone, and gets no answer if a helper crashes again. */
  suspect: boolean
}

interface Running<J, R> {
  w: Waiting<J, R>
  timer: ReturnType<typeof setTimeout>
}

/**
 * Every job gets exactly one outcome: an answer `accept` took, null (the
 * helper's answer was not one, the job took too long, or it crashed the
 * helper twice), or a rejection with `unavailable` (no helper could answer).
 */
export class HelperQueue<J, R> {
  readonly timeoutMs: number
  readonly concurrency: number
  private helper: QueueHelper<J> | null = null
  /** The current helper said it is ready. */
  private listening = false
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private waiting: Waiting<J, R>[] = []
  private running = new Map<number, Running<J, R>>()
  private seq = 0

  /**
   * `spawn` starts a helper; the app then calls ready() once it listens and
   * gone() when it crashes or is destroyed. `accept` turns a helper's answer
   * into a result, or null when it is not one (it is told which job the
   * answer is for: a queue may carry jobs whose answers are not alike).
   */
  constructor(
    private spawn: () => QueueHelper<J>,
    private accept: (answer: unknown, job: J) => R | null,
    private opts: HelperQueueOptions<J>,
  ) {
    this.timeoutMs = opts.timeoutMs
    this.concurrency = opts.concurrency
  }

  /** Jobs waiting for a slot. */
  get queued(): number {
    return this.waiting.length
  }

  /** Jobs in flight. */
  get inFlight(): number {
    return this.running.size
  }

  /** The current helper's id, or null when there is none. */
  get helperId(): number | null {
    return this.helper?.id ?? null
  }

  render(job: J): Promise<R | null> {
    return new Promise<R | null>((resolve, reject) => {
      this.waiting.push({ job, resolve, reject, suspect: false })
      this.pump()
    })
  }

  /** The helper `sender` says it listens now: only the current one counts. */
  ready(sender: number): void {
    if (!this.helper || sender !== this.helper.id || this.listening) return
    this.listening = true
    this.clearStart()
    this.pump()
  }

  /** An answer from `sender`. False when it is not the current helper answering a job it has. */
  done(sender: number, id: unknown, answer: unknown): boolean {
    if (!this.helper || sender !== this.helper.id || typeof id !== 'number') return false
    const r = this.running.get(id)
    if (!r) return false
    this.running.delete(id)
    clearTimeout(r.timer)
    r.w.resolve(this.accept(answer, r.w.job))
    this.pump()
    return true
  }

  /** The helper with this id crashed or was destroyed (from outside: the queue ignores its own destroys). */
  gone(helperId: number): void {
    if (!this.helper || this.helper.id !== helperId) return
    const started = this.listening
    this.drop(false)
    if (!started) {
      // It died before it could take a job: nothing ran, so nothing is to blame.
      this.failWaiting(`The ${this.opts.name} stopped while starting`)
      return
    }
    const again: Waiting<J, R>[] = []
    for (const r of this.takeRunning()) {
      // It ran alone and a helper crashed again: this job is the cause.
      if (r.w.suspect) r.w.resolve(null)
      else again.push({ ...r.w, suspect: true })
    }
    this.waiting.unshift(...again)
    this.pump()
  }

  /** Destroy the helper and fail every job (its window closed, the app quits). The next job starts a new helper. */
  stop(): void {
    for (const r of this.takeRunning()) r.w.reject(this.opts.unavailable(this.opts.stopped))
    this.drop(false)
    this.failWaiting(this.opts.stopped)
  }

  private pump(): void {
    if (!this.waiting.length) return
    if (!this.helper) {
      this.start()
      return
    }
    while (this.helper && this.listening && this.waiting.length && this.running.size < this.concurrency) {
      const next = this.waiting[0]!
      // A suspect runs alone, so that a crash names its job.
      if (this.running.size && (next.suspect || [...this.running.values()].some((r) => r.w.suspect))) return
      this.waiting.shift()
      this.dispatch(this.helper, next)
    }
  }

  private start(): void {
    let h: QueueHelper<J>
    try {
      h = this.spawn()
    } catch {
      this.failWaiting(`Could not start the ${this.opts.name}`)
      return
    }
    this.helper = h
    this.listening = false
    this.startTimer = setTimeout(() => {
      this.startTimer = null
      if (this.helper !== h || this.listening) return
      this.drop(true)
      this.failWaiting(`The ${this.opts.name} did not start`)
    }, this.opts.startTimeoutMs ?? this.timeoutMs)
  }

  private dispatch(helper: QueueHelper<J>, w: Waiting<J, R>): void {
    const id = ++this.seq
    const timer = setTimeout(() => this.timeout(id), this.opts.timeoutFor?.(w.job) ?? this.timeoutMs)
    this.running.set(id, { w, timer })
    try {
      helper.send(id, w.job)
    } catch {
      // Its window went away under us: as good as a crash.
      this.gone(helper.id)
    }
  }

  /** A job took too long: no answer for it, and a new helper for the others. */
  private timeout(id: number): void {
    const r = this.running.get(id)
    if (!r) return
    this.running.delete(id)
    r.w.resolve(null)
    // The others in flight were not late (yet): they start over on the next helper.
    this.waiting.unshift(...this.takeRunning().map((x) => x.w))
    this.drop(true)
    this.pump()
  }

  /** Every running job, their timers cleared, in the order they were sent. */
  private takeRunning(): Running<J, R>[] {
    const out = [...this.running.values()]
    for (const r of out) clearTimeout(r.timer)
    this.running.clear()
    return out
  }

  /** Forget the current helper and destroy it; its own gone() then no longer matches and is ignored. */
  private drop(hung: boolean): void {
    const h = this.helper
    this.helper = null
    this.listening = false
    this.clearStart()
    try {
      h?.destroy(hung)
    } catch {
      /* already gone */
    }
  }

  private clearStart(): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
  }

  private failWaiting(message: string): void {
    const all = this.waiting
    this.waiting = []
    for (const w of all) w.reject(this.opts.unavailable(message))
  }
}
