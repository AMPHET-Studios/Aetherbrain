/**
 * Watches every root of an FsVault with native recursive fs.watch
 * (Windows, macOS and Linux on Node ≥ 20) and turns raw events into
 * debounced batches of vault changes: note add/change/unlink with content,
 * picture add/change/unlink with mtime and size (no content), folder
 * addDir/unlinkDir. Pure Node, shared with the MCP server.
 *
 * Nothing is lost silently:
 *   - Start it before the initial scan with `known` null: events are buffered
 *     until `seed()` hands over the scan, then classified against it (a note
 *     created in an already-walked folder while a drive is scanned is an add).
 *   - A lost-events signal (an event without a file name: Windows' change
 *     buffer overflowed) or a root watched again after an error triggers a
 *     debounced rescan of that root, diffed against the known sets.
 *   - Re-arming after an error first checks, asynchronously, that the root
 *     answers: fs.watch opens the folder synchronously, which would freeze
 *     the main process on a network share that stopped answering.
 */
import { promises as fs, watch as nodeWatch, type Dirent, type FSWatcher, type Stats } from 'node:fs'
import path from 'node:path'
import type { VaultChangeDto } from '../shared/ipc.js'
import { isImageName, isNoteName, within, type FsVault, type MountedRoot } from './fsvault.js'

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
/**
 * A resync re-reads known notes modified (or changed: ctime) since the last
 * event that did arrive, minus this margin for coarse timestamps (FAT: 2 s)
 * and a network share's clock being off. Re-reading an unchanged note only
 * costs a 'change' with the same content.
 */
const LOST_SLACK = 60_000
/** Paths buffered before seed() at most; past that a root is rescanned instead. */
const MAX_BUFFERED = 50_000
/** Retry delay for a resync that could not read its root. */
const RESYNC_RETRY = 30_000
/** Longest re-arm back-off. */
const REARM_MAX = 60_000

/** fs.watch as the watcher calls it (tests inject a fake to deliver chosen events). */
export type WatchFn = (
  dir: string,
  opts: { recursive: boolean; persistent: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
) => FSWatcher

/** What the watcher knows is on disk: note, folder and picture paths (vault paths). */
export interface KnownPaths {
  files: Iterable<string>
  folders: Iterable<string>
  /** Picture files (the scan's assets); none when omitted. */
  images?: Iterable<string>
  /**
   * The scan stopped at its picture cap (`assetsTruncated`): `images` is
   * partial on purpose. A resync then takes no scanned picture it does not
   * know for new, or it would add back what the cap left out (the scan's cap
   * is shared by every root, a rescan's is one root's own).
   */
  imagesCapped?: boolean
}

export interface VaultWatcherOptions {
  /** Trailing debounce of change batches (default 250 ms). */
  debounceMs?: number
  /** Wait after a lost-events signal before the root is rescanned (default 2000 ms). */
  resyncMs?: number
  /** First re-arm delay after a watcher error; doubles up to 60 s (default 1000 ms). */
  rearmMs?: number
  /** How long a re-arm waits for the root to answer before trying again later (default 5000 ms). */
  probeMs?: number
  /** fs.watch (default: node's). */
  watch?: WatchFn
  /** Report picture files too (default true). The AI link's brain has no use for them. */
  images?: boolean
}

/** Per-flush state: paths already reported, parent listings for exact-name checks. */
interface FlushCtx {
  out: VaultChangeDto[]
  handled: Set<string>
  listings: Map<string, Set<string> | null>
}

export class VaultWatcher {
  private files: Set<string>
  private folders: Set<string>
  /**
   * Picture path → `mtime:size` of its last report ('' when only the scan saw
   * it): a read that Windows reports as a change (last-access updates) or a
   * repeated event reports nothing.
   */
  private images: Map<string, string>
  private readonly trackImages: boolean
  /** The known pictures are the scan's capped list: see KnownPaths.imagesCapped. */
  private imagesCapped: boolean
  /** False until the known sets exist (constructed with `known` null, then seed()): events are only buffered. */
  private seeded: boolean
  private readonly debounceMs: number
  private readonly resyncMs: number
  private readonly rearmMs: number
  private readonly probeMs: number
  private readonly watchFn: WatchFn
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
  /** Roots (abs) with a live native watcher. */
  private armed = new Set<string>()
  /** Per root: every event up to this time arrived (armed then, or the last event seen). */
  private syncedAt = new Map<string, number>()
  /** Per root: events may be missing from this time on; a resync catches up once the root is watched. */
  private lostSince = new Map<string, number>()
  private resyncTimers = new Map<string, NodeJS.Timeout>()
  private resyncing = new Set<string>()
  /** The one reachability probe in flight per root (a hung share must not tie up more threads). */
  private probes = new Map<string, Promise<boolean>>()

  /**
   * `known`: what the initial scan found. Pass null to start watching before
   * the scan and hand the result over with seed() once it is done.
   */
  constructor(
    private readonly vault: FsVault,
    known: KnownPaths | null,
    private readonly sink: (changes: VaultChangeDto[]) => void,
    opts: VaultWatcherOptions = {},
  ) {
    this.trackImages = opts.images !== false
    this.files = new Set(known?.files ?? [])
    this.folders = new Set(known?.folders ?? [])
    this.images = this.knownImages(known)
    this.imagesCapped = known?.imagesCapped ?? false
    this.seeded = known !== null
    this.debounceMs = opts.debounceMs ?? 250
    this.resyncMs = opts.resyncMs ?? 2000
    this.rearmMs = opts.rearmMs ?? 1000
    this.probeMs = opts.probeMs ?? 5000
    this.watchFn = opts.watch ?? nodeWatch
  }

  private knownImages(known: KnownPaths | null): Map<string, string> {
    const out = new Map<string, string>()
    if (this.trackImages) for (const p of known?.images ?? []) out.set(p, '')
    return out
  }

  /**
   * fs.watch(root.abs, { recursive: true }) per root, each first checked with
   * an async stat (up to probeMs): fs.watch opens the folder synchronously, so
   * a network share that stopped answering would block the process. A root
   * that does not answer is retried in the background and rescanned once it
   * can be watched. Resolves when every root is watched or waiting for that:
   * await it before scanning so nothing slips between scan and watch.
   */
  async start(): Promise<void> {
    this.stop()
    this.running = true
    const gen = this.generation
    const roots = this.vault.roots
    const answers = await Promise.all(roots.map((r) => this.reachable(r.abs)))
    if (!this.live(gen)) return
    for (const [i, root] of roots.entries()) {
      if (answers[i]) {
        this.watchRoot(root, gen)
        continue
      }
      console.warn('[aether] cannot reach', root.abs)
      this.markLost(root)
      this.rearm(root, gen)
    }
  }

  /**
   * Hand over what the initial scan found (for a watcher constructed with
   * `known` null). Paths buffered since start() are then classified against
   * it: a note on disk the scan did not see is an add, a new folder an addDir,
   * a scanned note that is gone an unlink (pictures alike).
   */
  seed(known: KnownPaths): void {
    this.files = new Set(known.files)
    this.folders = new Set(known.folders)
    this.images = this.knownImages(known)
    this.imagesCapped = known.imagesCapped ?? false
    this.seeded = true
    if (!this.running) return
    if (this.pending.size) this.schedule()
    for (const root of this.vault.roots) if (this.lostSince.has(root.abs)) this.scheduleResync(root)
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
    for (const t of this.resyncTimers.values()) clearTimeout(t)
    this.resyncTimers.clear()
    this.resyncing.clear()
    this.lostSince.clear()
    this.armed.clear()
    this.syncedAt.clear()
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

  /** Undo noteSelfWrite(vaultPath, content) for a write that failed (the file there is not ours). */
  forgetSelfWrite(vaultPath: string, content: string | null): void {
    let key: string | null
    try {
      key = this.vault.toVault(this.vault.abs(vaultPath))
    } catch {
      return
    }
    if (key !== null && this.selfWrites.get(key)?.content === content) this.selfWrites.delete(key)
  }

  private live(gen: number): boolean {
    return this.running && gen === this.generation
  }

  private watchRoot(root: MountedRoot, gen: number): void {
    let w: FSWatcher
    try {
      w = this.watchFn(root.abs, { recursive: true, persistent: true }, (_event, filename) => this.onEvent(root, filename))
    } catch (err) {
      // Missing or unreachable right now (drive unplugged, network share down): keep trying,
      // and rescan it once it can be watched (notes may appear or change meanwhile).
      console.warn('[aether] cannot watch', root.abs, err)
      this.markLost(root)
      this.rearm(root, gen)
      return
    }
    this.watchers.push(w)
    this.armed.add(root.abs)
    this.syncedAt.set(root.abs, Date.now())
    w.on('error', (err) => {
      // Keep going: drop the broken watcher and re-arm it (a subfolder vanished
      // mid-traversal, a network drive blinked); what happens until then is resynced.
      console.warn('[aether] watcher error', root.abs, err)
      w.close()
      this.watchers = this.watchers.filter((x) => x !== w)
      if (!this.live(gen)) return
      this.armed.delete(root.abs)
      this.markLost(root)
      this.rearm(root, gen)
    })
    // Watched again after an error, or a root that was missing at start: catch up.
    if (this.lostSince.has(root.abs)) this.scheduleResync(root)
  }

  /**
   * Watch `root` again later, backing off 1 s → 60 s while it keeps failing.
   * fs.watch opens the folder synchronously (CreateFileW on Windows): on a
   * network share that stopped answering that blocks the whole process for
   * the SMB timeout, so it is only called once an async stat says the root
   * answers.
   */
  private rearm(root: MountedRoot, gen: number): void {
    const n = (this.errors.get(root.abs) ?? 0) + 1
    this.errors.set(root.abs, n)
    const t = setTimeout(
      () => {
        this.restarts.delete(t)
        if (!this.live(gen)) return
        void this.reachable(root.abs).then((ok) => {
          if (!this.live(gen)) return
          if (ok) this.watchRoot(root, gen)
          else this.rearm(root, gen)
        })
      },
      Math.min(REARM_MAX, this.rearmMs * 2 ** (n - 1)),
    )
    this.restarts.add(t)
  }

  /**
   * True when `abs` is a folder that answers within probeMs. A stat that
   * hangs is not started again while it is still running (each one holds a
   * libuv thread until the share times out).
   */
  private reachable(abs: string): Promise<boolean> {
    let probe = this.probes.get(abs)
    if (!probe) {
      const p = fs.stat(abs).then(
        (st) => st.isDirectory(),
        () => false,
      )
      this.probes.set(abs, p)
      void p.then(() => {
        if (this.probes.get(abs) === p) this.probes.delete(abs)
      })
      probe = p
    }
    return within(probe, this.probeMs, false)
  }

  private onEvent(root: MountedRoot, filename: string | Buffer | null): void {
    if (!this.running) return
    this.errors.delete(root.abs)
    const name = filename == null ? '' : typeof filename === 'string' ? filename : filename.toString('utf8')
    if (!name) {
      // No file name: the OS dropped events (Windows' 4 KB change buffer overflowed). Rescan the root.
      this.markLost(root)
      this.scheduleResync(root)
      return
    }
    this.syncedAt.set(root.abs, Date.now())
    const p = this.vault.toVault(path.join(root.abs, name))
    // Filter before any fs call: ignored trees (node_modules, .git, …) can be very chatty.
    if (!p || this.vault.isIgnored(p)) return
    if (!this.seeded && this.pending.size >= MAX_BUFFERED && !this.pending.has(p)) {
      // Too much going on during the initial scan: rescan this root once it is done instead.
      this.markLost(root)
      return
    }
    this.enqueue(p)
  }

  private enqueue(p: string): void {
    // A flush still running when stop() was called may retry a path: never re-arm a timer then.
    if (!this.running) return
    if (!this.pending.size) this.firstPending = Date.now()
    this.pending.add(p)
    // Before seed() paths are only buffered.
    if (this.seeded) this.schedule()
  }

  /* -------------------------------------------------------------- */
  /* Resync after lost events                                       */
  /* -------------------------------------------------------------- */

  /** Events for `root` may be missing from its last seen event on. */
  private markLost(root: MountedRoot): void {
    const since = (this.syncedAt.get(root.abs) ?? Date.now()) - LOST_SLACK
    const cur = this.lostSince.get(root.abs)
    this.lostSince.set(root.abs, cur === undefined ? since : Math.min(cur, since))
  }

  /**
   * Debounced rescan of `root`, once the known sets exist and the root is
   * watched (a rescan of an unwatched root would miss what follows). One at a
   * time per root; a signal during a rescan runs another one after it.
   */
  private scheduleResync(root: MountedRoot, delay = this.resyncMs): void {
    if (!this.running || !this.seeded || !this.armed.has(root.abs) || this.resyncing.has(root.abs)) return
    const old = this.resyncTimers.get(root.abs)
    if (old) clearTimeout(old)
    const gen = this.generation
    const t = setTimeout(() => {
      if (this.resyncTimers.get(root.abs) === t) this.resyncTimers.delete(root.abs)
      void this.resync(root, gen)
    }, delay)
    this.resyncTimers.set(root.abs, t)
  }

  private async resync(root: MountedRoot, gen: number): Promise<void> {
    const since = this.lostSince.get(root.abs)
    if (since === undefined || !this.live(gen)) return
    this.lostSince.delete(root.abs)
    this.resyncing.add(root.abs)
    let done = false
    try {
      done = await this.reconcile(root, since, gen)
    } catch (err) {
      console.warn('[aether] could not rescan', root.abs, err)
    }
    if (gen !== this.generation) return
    this.resyncing.delete(root.abs)
    if (!done) {
      // The root did not answer: keep the gap and try again later.
      const cur = this.lostSince.get(root.abs)
      this.lostSince.set(root.abs, cur === undefined ? since : Math.min(cur, since))
      this.scheduleResync(root, Math.max(this.resyncMs, RESYNC_RETRY))
    } else if (this.lostSince.has(root.abs)) {
      this.scheduleResync(root)
    }
  }

  /**
   * Rescan `root` and queue every path where disk and the known sets may
   * disagree: new notes, pictures and folders, known ones gone from a folder
   * the rescan did read, and known notes modified since `since` (pictures are
   * not stat'ed: a whole drive can hold hundreds of thousands). New pictures
   * only while the known ones are not a capped list (a picture made while
   * events were lost then waits for the next full scan). The normal flush
   * then decides from what is on disk at that moment (so live events that
   * raced the rescan are not undone). False when the root could not be read.
   */
  private async reconcile(root: MountedRoot, since: number, gen: number): Promise<boolean> {
    const scan = await this.vault.scanRoot(root)
    if (gen !== this.generation) return true
    if (!scan.dirs) return false
    const prefix = `${root.mount}/`
    const inRoot = (p: string): boolean => !root.mount || p.startsWith(prefix)
    const parentOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')))
    const onDisk = new Set(scan.files.map((f) => f.path))
    const dirs = new Set(scan.folders)
    // Folders whose listing the rescan read (the root included): only their known children can be gone.
    const listed = new Set(scan.folders).add(root.mount)
    const suspects = new Set<string>()
    for (const d of scan.folders) if (!this.folders.has(d)) suspects.add(d)
    for (const d of this.folders) if (inRoot(d) && !dirs.has(d) && listed.has(parentOf(d))) suspects.add(d)
    for (const f of this.files) if (inRoot(f) && !onDisk.has(f) && listed.has(parentOf(f))) suspects.add(f)
    if (this.trackImages) {
      const pictures = new Set<string>()
      for (const a of scan.assets) {
        pictures.add(a.path)
        if (!this.imagesCapped && !this.images.has(a.path)) suspects.add(a.path)
      }
      // A rescan that stopped at the picture cap did not list every picture: none is taken for gone.
      if (!scan.assetsTruncated) {
        for (const f of this.images.keys()) if (inRoot(f) && !pictures.has(f) && listed.has(parentOf(f))) suspects.add(f)
      }
    }
    const known: { path: string; abs: string }[] = []
    for (const f of scan.files) {
      if (this.files.has(f.path)) known.push(f)
      else suspects.add(f.path)
    }
    // Known notes edited while events were lost.
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < known.length && gen === this.generation) {
        const f = known[next++]!
        const st = await fs.stat(f.abs).catch(() => null)
        if (st && Math.max(st.mtimeMs, st.ctimeMs) >= since) suspects.add(f.path)
      }
    }
    await Promise.all(Array.from({ length: Math.min(32, known.length) }, worker))
    if (gen !== this.generation) return true
    for (const p of suspects) this.enqueue(p)
    return true
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
    if (this.flushing || !this.pending.size || !this.seeded) return
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
    const isFile = st?.isFile() ?? false
    const name = path.basename(abs)
    const isNote = isFile && isNoteName(name)
    const isImage = isFile && this.trackImages && isImageName(name)
    if (!isDir && this.folders.has(p)) this.dropFolder(p, ctx)
    if (!isNote && this.files.has(p)) this.dropFile(p, ctx)
    if (!isImage && this.images.has(p)) this.dropImage(p, ctx)
    if (isNote) await this.addFile(p, abs, ctx)
    else if (isImage && st) this.addImage(p, st, ctx)
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
   * True when `content` is our own write of `p` caught half way: what is on
   * disk is a strict start of what we are writing (FsVault.create fills a new
   * note in place on disks without hard links, so it can be read empty).
   * Reporting that would leave the app with an empty note, since the full
   * content that follows is swallowed as our own echo.
   */
  private selfInProgress(p: string, content: string): boolean {
    const s = this.selfWrites.get(p)
    return !!s && s.content !== null && s.content !== content && s.content.startsWith(content) && Date.now() - s.t < SELF_WINDOW
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

  private dropImage(p: string, ctx: FlushCtx): void {
    this.images.delete(p)
    if (!this.isSelfDelete(p)) this.emit(ctx, { kind: 'unlink', path: p })
    else ctx.handled.add(p)
  }

  /** A known folder is gone: unlink its known notes and pictures, then unlinkDir its folders deepest first, itself last. */
  private dropFolder(p: string, ctx: FlushCtx): void {
    const prefix = `${p}/`
    const quiet = this.isSelfDelete(p)
    const gone = [...this.files].filter((f) => f.startsWith(prefix))
    for (const f of this.images.keys()) if (f.startsWith(prefix)) gone.push(f)
    for (const f of gone.sort()) {
      this.files.delete(f)
      this.images.delete(f)
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
    if (this.selfInProgress(p, content)) {
      // Look again next flush (at most until the self-write window ends, then it is reported as it is).
      ctx.handled.add(p)
      this.enqueue(p)
      return
    }
    this.addAncestors(p, ctx)
    const known = this.files.has(p)
    this.files.add(p)
    if (this.isSelf(p, content)) ctx.handled.add(p)
    else this.emit(ctx, { kind: known ? 'change' : 'add', path: p, content, mtime })
  }

  /**
   * Report a picture: an add when unknown, a change when its mtime or size
   * moved. Nothing is read (pictures carry no content) and there is no echo
   * to swallow: whoever wrote it applies an add anyway, and adds are idempotent.
   */
  private addImage(p: string, st: Stats, ctx: FlushCtx): void {
    const sig = `${st.mtimeMs}:${st.size}`
    const before = this.images.get(p)
    if (before === sig) {
      ctx.handled.add(p)
      return
    }
    this.addAncestors(p, ctx)
    this.images.set(p, sig)
    this.emit(ctx, { kind: before === undefined ? 'add' : 'change', path: p, mtime: st.mtimeMs, size: st.size })
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
   * before we could watch it) reporting every folder, note and picture inside.
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
      const pictures: { abs: string; vault: string }[] = []
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
        } else if (!e.isFile()) {
          continue
        } else if (isNoteName(e.name)) {
          if (!this.files.has(vault)) await this.addFile(vault, child, ctx)
        } else if (this.trackImages && isImageName(e.name) && !this.images.has(vault)) {
          pictures.push({ abs: child, vault })
        }
      }
      // A folder of renders moved in can hold thousands: stat them a batch at a time.
      for (let i = 0; i < pictures.length; i += 32) {
        const batch = pictures.slice(i, i + 32)
        const stats = await Promise.all(batch.map((x) => fs.lstat(x.abs).catch(() => null)))
        for (const [j, x] of batch.entries()) {
          const st = stats[j]
          if (st?.isFile()) this.addImage(x.vault, st, ctx)
        }
      }
    }
  }
}
