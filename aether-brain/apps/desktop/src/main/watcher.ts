/**
 * Watches every root of an FsVault with native recursive fs.watch
 * (Windows, macOS and Linux on Node ≥ 20) and turns raw events into
 * debounced batches of vault changes: note add/change/unlink with content,
 * folder addDir/unlinkDir. Pure Node, shared with the MCP server.
 */
import { promises as fs, watch, type Dirent, type FSWatcher, type Stats } from 'node:fs'
import path from 'node:path'
import type { VaultChangeDto } from '../shared/ipc.js'
import { isNoteName, type FsVault, type MountedRoot } from './fsvault.js'

/** A write we made ourselves; its watcher echo is swallowed for SELF_WINDOW ms. */
interface SelfWrite {
  /** Content written, or null for a deletion. */
  content: string | null
  t: number
}

const SELF_WINDOW = 3000
const SELF_EXPIRE = 5000
/** Times an existing but unreadable note (locked mid-write) is retried. */
const READ_RETRIES = 3

/** Per-flush state: paths already reported, parent listings for exact-name checks. */
interface FlushCtx {
  out: VaultChangeDto[]
  handled: Set<string>
  listings: Map<string, Set<string> | null>
}

export class VaultWatcher {
  private readonly files: Set<string>
  private readonly folders: Set<string>
  private readonly debounceMs: number
  private watchers: FSWatcher[] = []
  private pending = new Set<string>()
  private firstPending = 0
  private timer: NodeJS.Timeout | null = null
  private restarts = new Set<NodeJS.Timeout>()
  private flushing = false
  /** Bumped by start/stop so a flush in flight never reports into a stopped watcher. */
  private generation = 0
  private running = false
  private selfWrites = new Map<string, SelfWrite>()
  private retries = new Map<string, number>()
  /** Consecutive watcher errors per root, for re-arm backoff. */
  private errors = new Map<string, number>()

  constructor(
    private readonly vault: FsVault,
    known: { files: Iterable<string>; folders: Iterable<string> },
    private readonly sink: (changes: VaultChangeDto[]) => void,
    opts: { debounceMs?: number } = {},
  ) {
    this.files = new Set(known.files)
    this.folders = new Set(known.folders)
    this.debounceMs = opts.debounceMs ?? 250
  }

  /** fs.watch(root.abs, { recursive: true }) per root. */
  start(): void {
    this.stop()
    this.running = true
    const gen = this.generation
    for (const root of this.vault.roots) this.watchRoot(root, gen)
  }

  stop(): void {
    this.running = false
    this.generation++
    for (const w of this.watchers) w.close()
    this.watchers = []
    for (const t of this.restarts) clearTimeout(t)
    this.restarts.clear()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
    this.retries.clear()
  }

  /** Remember content we wrote so the echo is swallowed (3 s window). */
  noteSelfWrite(vaultPath: string, content: string | null /* null = deleted */): void {
    let key: string | null
    try {
      // Canonical form (mount case, slashes) so it matches what events resolve to.
      key = this.vault.toVault(this.vault.abs(vaultPath))
    } catch {
      return
    }
    if (key === null) return
    const now = Date.now()
    this.selfWrites.set(key, { content, t: now })
    for (const [k, v] of this.selfWrites) if (now - v.t > SELF_EXPIRE) this.selfWrites.delete(k)
  }

  private watchRoot(root: MountedRoot, gen: number): void {
    let w: FSWatcher
    try {
      w = watch(root.abs, { recursive: true, persistent: true }, (_event, filename: string | Buffer | null) =>
        this.onEvent(root, filename),
      )
    } catch (err) {
      // Missing or unreachable right now (drive unplugged, network share down): keep trying.
      console.warn('[aether] cannot watch', root.abs, err)
      this.rearm(root, gen)
      return
    }
    this.watchers.push(w)
    w.on('error', (err) => {
      // Keep going: drop the broken watcher and re-arm it (a subfolder vanished
      // mid-traversal, a network drive blinked).
      console.warn('[aether] watcher error', root.abs, err)
      w.close()
      this.watchers = this.watchers.filter((x) => x !== w)
      this.rearm(root, gen)
    })
  }

  /** Watch `root` again later, backing off 1 s → 60 s while it keeps failing. */
  private rearm(root: MountedRoot, gen: number): void {
    const n = (this.errors.get(root.abs) ?? 0) + 1
    this.errors.set(root.abs, n)
    const t = setTimeout(
      () => {
        this.restarts.delete(t)
        if (this.running && gen === this.generation) this.watchRoot(root, gen)
      },
      Math.min(60_000, 1000 * 2 ** (n - 1)),
    )
    this.restarts.add(t)
  }

  private onEvent(root: MountedRoot, filename: string | Buffer | null): void {
    if (!this.running || filename == null) return
    this.errors.delete(root.abs)
    const name = typeof filename === 'string' ? filename : filename.toString('utf8')
    if (!name) return
    const p = this.vault.toVault(path.join(root.abs, name))
    // Filter before any fs call: ignored trees (node_modules, .git, …) can be very chatty.
    if (!p || this.vault.isIgnored(p)) return
    this.enqueue(p)
  }

  private enqueue(p: string): void {
    // A flush still running when stop() was called may retry a path: never re-arm a timer then.
    if (!this.running) return
    if (!this.pending.size) this.firstPending = Date.now()
    this.pending.add(p)
    this.schedule()
  }

  /** Trailing debounce, capped so a constant stream of events still flushes every 8 × debounce. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    const cap = this.firstPending + this.debounceMs * 8 - Date.now()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, Math.max(0, Math.min(this.debounceMs, cap)))
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.pending.size) return
    this.flushing = true
    const gen = this.generation
    // Sorted: parents before children, so a new folder's subtree scan reports its contents once.
    const batch = [...this.pending].sort()
    this.pending.clear()
    const ctx: FlushCtx = { out: [], handled: new Set(), listings: new Map() }
    try {
      for (const p of batch) {
        if (gen !== this.generation) return
        if (ctx.handled.has(p)) continue
        try {
          await this.classify(p, ctx)
        } catch (err) {
          console.warn('[aether] watcher could not process', p, err)
        }
      }
      const now = Date.now()
      for (const [k, v] of this.selfWrites) if (now - v.t > SELF_EXPIRE) this.selfWrites.delete(k)
      if (ctx.out.length && gen === this.generation) {
        try {
          this.sink(ctx.out)
        } catch (err) {
          console.warn('[aether] watcher sink failed', err)
        }
      }
    } finally {
      this.flushing = false
      if (this.pending.size && this.running) this.schedule()
    }
  }

  /** Decide what happened at `p` from what is on disk now versus what we knew. */
  private async classify(p: string, ctx: FlushCtx): Promise<void> {
    const abs = this.vault.abs(p)
    const st = await this.present(abs, ctx)
    const isDir = st?.isDirectory() ?? false
    const isNote = (st?.isFile() ?? false) && isNoteName(path.basename(abs))
    if (!isDir && this.folders.has(p)) this.dropFolder(p, ctx)
    if (!isNote && this.files.has(p)) this.dropFile(p, ctx)
    if (isNote) await this.addFile(p, abs, ctx)
    else if (isDir && !this.folders.has(p)) await this.addTree(p, abs, ctx)
  }

  /**
   * lstat() (symlinks are neither notes nor folders, as in scan) that also
   * requires the exact name to be listed in its parent, so a case-only rename
   * on a case-insensitive disk reports the old name as gone.
   */
  private async present(abs: string, ctx: FlushCtx): Promise<Stats | null> {
    const st = await fs.lstat(abs).catch(() => null)
    if (!st) return null
    const dir = path.dirname(abs)
    if (dir === abs) return st
    let names = ctx.listings.get(dir)
    if (names === undefined) {
      names = await fs.readdir(dir).then((n) => new Set(n), () => null)
      ctx.listings.set(dir, names)
    }
    return !names || names.has(path.basename(abs)) ? st : null
  }

  private isSelf(p: string, content: string | null): boolean {
    const s = this.selfWrites.get(p)
    return !!s && s.content === content && Date.now() - s.t < SELF_WINDOW
  }

  /**
   * True when `p` going away is the echo of our own deletion of it or of a
   * folder above it (a big folder's children can arrive in earlier flushes).
   */
  private isSelfDelete(p: string): boolean {
    for (let q = p; ; q = q.slice(0, q.lastIndexOf('/'))) {
      if (this.isSelf(q, null)) return true
      if (!q.includes('/')) return false
    }
  }

  private emit(ctx: FlushCtx, change: VaultChangeDto): void {
    ctx.out.push(change)
    ctx.handled.add(change.path)
  }

  private dropFile(p: string, ctx: FlushCtx): void {
    this.files.delete(p)
    if (!this.isSelfDelete(p)) this.emit(ctx, { kind: 'unlink', path: p })
    else ctx.handled.add(p)
  }

  /** A known folder is gone: unlink its known notes, then unlinkDir its folders deepest first, itself last. */
  private dropFolder(p: string, ctx: FlushCtx): void {
    const prefix = `${p}/`
    const quiet = this.isSelfDelete(p)
    for (const f of [...this.files].filter((f) => f.startsWith(prefix)).sort()) {
      this.files.delete(f)
      if (quiet) ctx.handled.add(f)
      else this.emit(ctx, { kind: 'unlink', path: f })
    }
    const subs = [...this.folders].filter((d) => d.startsWith(prefix)).sort().reverse()
    for (const d of [...subs, p]) {
      this.folders.delete(d)
      if (quiet) ctx.handled.add(d)
      else this.emit(ctx, { kind: 'unlinkDir', path: d })
    }
  }

  /** Report a note (add when unknown, change when known) unless it is the echo of our own write. */
  private async addFile(p: string, abs: string, ctx: FlushCtx): Promise<void> {
    let read: [string, number]
    try {
      read = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs).then((s) => s.mtimeMs)])
    } catch {
      // Exists but unreadable right now (locked mid-write on Windows): try again next flush.
      const n = (this.retries.get(p) ?? 0) + 1
      if (n <= READ_RETRIES) {
        this.retries.set(p, n)
        this.enqueue(p)
      } else {
        this.retries.delete(p)
      }
      return
    }
    this.retries.delete(p)
    const [content, mtime] = read
    this.addAncestors(p, ctx)
    const known = this.files.has(p)
    this.files.add(p)
    if (this.isSelf(p, content)) ctx.handled.add(p)
    else this.emit(ctx, { kind: known ? 'change' : 'add', path: p, content, mtime })
  }

  /** addDir for parent folders we never heard about (events can be coalesced or missed). */
  private addAncestors(p: string, ctx: FlushCtx): void {
    const segs = p.split('/')
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/')
      if (this.folders.has(dir)) continue
      this.folders.add(dir)
      this.emit(ctx, { kind: 'addDir', path: dir })
    }
  }

  /**
   * A new folder: addDir for it, then walk its subtree (created or moved in
   * before we could watch it) reporting every folder and note inside.
   */
  private async addTree(p: string, abs: string, ctx: FlushCtx): Promise<void> {
    this.addAncestors(p, ctx)
    this.folders.add(p)
    this.emit(ctx, { kind: 'addDir', path: p })
    const queue = [{ abs, vault: p }]
    for (let head = 0; head < queue.length; head++) {
      const dir = queue[head]!
      let entries: Dirent[]
      try {
        entries = await fs.readdir(dir.abs, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const vault = `${dir.vault}/${e.name}`
        if (this.vault.isIgnored(vault)) continue
        const child = path.join(dir.abs, e.name)
        if (e.isDirectory()) {
          if (!this.folders.has(vault)) {
            this.folders.add(vault)
            this.emit(ctx, { kind: 'addDir', path: vault })
          }
          queue.push({ abs: child, vault })
        } else if (e.isFile() && isNoteName(e.name) && !this.files.has(vault)) {
          await this.addFile(vault, child, ctx)
        }
      }
    }
  }
}
