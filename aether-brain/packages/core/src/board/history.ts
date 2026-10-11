/**
 * Undo and redo for any immutable state (the board uses it on `BoardDoc`). The states themselves are kept, not patches: the board's
 * operations return new documents that share every part they did not change, so a step costs only what the edit touched, and undo
 * is handing back the object that was there. The pure operations never mutate, which is what makes that safe.
 * Design: docs/design/reference-board.md.
 */

/** The longest history a caller may ask for; the default is far below it. Nothing a view holds is unbounded. */
const MAX_LIMIT = 10_000
const DEFAULT_LIMIT = 200
const DEFAULT_COALESCE_MS = 800

export interface HistoryOptions {
  /** Steps that can be undone, 200 by default. The oldest are forgotten past it. */
  limit?: number
  /** Pushes with the same key closer together than this (milliseconds) are one step, 800 by default. 0 turns it off. */
  coalesceMs?: number
}

export interface PushOptions {
  /** Pushes with the same key in a row, each within the window of the one before, replace each other (a run of arrow-key nudges). */
  key?: string
  /** What the step did, for "Undo move" in a menu. */
  label?: string
  /** The time of the push in milliseconds; the clock when left out. Tests supply it. */
  now?: number
}

interface Entry<T> {
  state: T
  /** What the push that made this state did; null for the first state. */
  label: string | null
  key: string | undefined
  /** When the push was made (the last push folded into it). */
  time: number
}

export class History<T> {
  private readonly limit: number
  private readonly coalesceMs: number
  private entries: Entry<T>[] = []
  /** Index of the current state in `entries`; the ones after it are the redo steps. */
  private at = 0
  /** Whether the current entry can still absorb a push with its key: false as soon as the user steps through the history. */
  private open = false

  constructor(opts: HistoryOptions = {}) {
    const limit = opts.limit
    const coalesce = opts.coalesceMs
    this.limit = limit !== undefined && Number.isFinite(limit) ? Math.min(MAX_LIMIT, Math.max(0, Math.floor(limit))) : DEFAULT_LIMIT
    this.coalesceMs = coalesce !== undefined && Number.isFinite(coalesce) ? Math.max(0, coalesce) : DEFAULT_COALESCE_MS
  }

  /** Forgets every step and starts again from `initial`. */
  reset(initial: T): void {
    this.entries = [{ state: initial, label: null, key: undefined, time: 0 }]
    this.at = 0
    this.open = false
  }

  /** The state now shown. Undefined until the first `reset` (or push, which then is the first state). */
  get current(): T {
    return this.entries[this.at]?.state as T
  }

  /**
   * Makes `next` the current state and drops every redo step. The very same object as the current state is not a change and is
   * ignored. A push with the same `key` as the one before it, made no more than `coalesceMs` after it and with no undo or redo in
   * between, replaces that step instead of adding one (the window slides: a long run of nudges is one step).
   */
  push(next: T, opts: PushOptions = {}): void {
    if (this.entries.length === 0) {
      this.reset(next)
      return
    }
    if (Object.is(next, this.current)) return
    const now = opts.now !== undefined && Number.isFinite(opts.now) ? opts.now : Date.now()
    const here = this.entries[this.at]!
    const key = opts.key
    this.entries.length = this.at + 1
    if (this.open && key !== undefined && key === here.key && this.coalesceMs > 0) {
      const dt = now - here.time
      if (dt >= 0 && dt <= this.coalesceMs) {
        this.entries[this.at] = { state: next, label: opts.label ?? here.label, key, time: now }
        return
      }
    }
    this.entries.push({ state: next, label: opts.label ?? null, key, time: now })
    this.at++
    this.open = true
    // One state more than the steps allowed: the current one, and `limit` to go back to.
    if (this.entries.length > this.limit + 1) {
      this.entries.shift()
      this.at--
    }
  }

  /** Steps back and returns the state now current, or null when there is nothing to undo. */
  undo(): T | null {
    if (this.at === 0) return null
    this.at--
    this.open = false
    return this.entries[this.at]!.state
  }

  /** Steps forward again and returns the state now current, or null when there is nothing to redo. */
  redo(): T | null {
    if (this.at >= this.entries.length - 1) return null
    this.at++
    this.open = false
    return this.entries[this.at]!.state
  }

  get canUndo(): boolean {
    return this.at > 0
  }

  get canRedo(): boolean {
    return this.at < this.entries.length - 1
  }

  /** The label of the step an undo would take back, or null (nothing to undo, or the step had no label). */
  get undoLabel(): string | null {
    return this.at > 0 ? this.entries[this.at]!.label : null
  }

  /** The label of the step a redo would apply again, or null. */
  get redoLabel(): string | null {
    return this.at < this.entries.length - 1 ? this.entries[this.at + 1]!.label : null
  }

  /** States held, redo steps included: never more than `limit + 1`. */
  get size(): number {
    return this.entries.length
  }
}
