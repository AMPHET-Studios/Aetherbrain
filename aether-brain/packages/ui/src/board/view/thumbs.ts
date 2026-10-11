/**
 * Thumbnails for the picture picker: a small least-recently-used table of picture previews as object URLs, loaded only for the rows in
 * view, a few at a time, and given back (`revokeUrl`) when they fall out of the table. No React and no DOM of its own (the page's
 * `URL.createObjectURL` is handed in), so it is tested in node. Nothing held is unbounded: at most `max` URLs, whatever the vault has.
 */

export interface ThumbOptions {
  /** The preview of a picture, or null when there is none. May reject: that is a missing thumbnail. */
  load(path: string): Promise<Blob | null>
  createUrl(blob: Blob): string
  revokeUrl(url: string): void
  /** A thumbnail arrived (or failed): draw again. */
  onChange(): void
  /** URLs held at most. Default 120. */
  max?: number
  /** Loads running at once. Default 3. */
  concurrency?: number
}

export const THUMB_MAX = 120
export const THUMB_CONCURRENCY = 3

export class ThumbCache {
  private readonly opts: ThumbOptions
  private readonly max: number
  private readonly concurrency: number
  /** path → its URL, or null when the preview could not be made. Map order is use order: the oldest is first. */
  private readonly held = new Map<string, string | null>()
  private wanted: ReadonlySet<string> = new Set()
  private queue: string[] = []
  private readonly loading = new Set<string>()
  private disposed = false

  constructor(opts: ThumbOptions) {
    this.opts = opts
    this.max = opts.max !== undefined && opts.max >= 1 ? Math.floor(opts.max) : THUMB_MAX
    this.concurrency = opts.concurrency !== undefined && opts.concurrency >= 1 ? Math.floor(opts.concurrency) : THUMB_CONCURRENCY
  }

  /** The URL of a picture's thumbnail; null when it could not be made; undefined while it is not there yet. */
  urlOf(path: string): string | null | undefined {
    return this.held.get(path)
  }

  /** URLs held now. */
  get size(): number {
    return this.held.size
  }

  /** Loads running now. */
  get active(): number {
    return this.loading.size
  }

  /** The pictures in view now. Only these load; what waited for a row that has scrolled away is dropped, what is held stays until pushed out. */
  want(paths: readonly string[]): void {
    if (this.disposed) return
    this.wanted = new Set(paths)
    this.queue = this.queue.filter((p) => this.wanted.has(p))
    for (const p of paths) {
      if (this.held.has(p)) {
        // Used again: it moves to the young end.
        const url = this.held.get(p)!
        this.held.delete(p)
        this.held.set(p, url)
      } else if (!this.loading.has(p) && !this.queue.includes(p)) this.queue.push(p)
    }
    this.pump()
  }

  /** Gives every URL back and stops loading. */
  dispose(): void {
    this.disposed = true
    for (const url of this.held.values()) if (url) this.revoke(url)
    this.held.clear()
    this.queue = []
    this.wanted = new Set()
  }

  private revoke(url: string): void {
    try {
      this.opts.revokeUrl(url)
    } catch {
      /* a URL that will not be revoked has nothing left to give back */
    }
  }

  private pump(): void {
    while (!this.disposed && this.loading.size < this.concurrency && this.queue.length > 0) {
      const path = this.queue.shift()!
      this.loading.add(path)
      let job: Promise<Blob | null>
      try {
        job = Promise.resolve(this.opts.load(path))
      } catch (err) {
        job = Promise.reject(err)
      }
      job.then(
        (blob) => this.arrived(path, blob),
        () => this.arrived(path, null),
      )
    }
  }

  private arrived(path: string, blob: Blob | null): void {
    this.loading.delete(path)
    if (this.disposed) return
    // The row scrolled away while it loaded: no URL for a picture nobody sees.
    if (this.wanted.has(path)) {
      let url: string | null = null
      if (blob) {
        try {
          url = this.opts.createUrl(blob)
        } catch {
          url = null
        }
      }
      this.held.delete(path)
      this.held.set(path, url)
      this.evict()
      this.opts.onChange()
    }
    this.pump()
  }

  /** Pushes out the oldest until the table fits, never a picture in view. */
  private evict(): void {
    if (this.held.size <= this.max) return
    for (const [path, url] of this.held) {
      if (this.held.size <= this.max) break
      if (this.wanted.has(path)) continue
      this.held.delete(path)
      if (url) this.revoke(url)
    }
  }
}
