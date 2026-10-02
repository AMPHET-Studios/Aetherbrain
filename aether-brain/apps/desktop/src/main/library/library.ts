/**
 * The librarian: copies every picture of a source folder (a whole drive,
 * `D:\`) into a library folder (`F:\MASTERIMAGES`), sorted Type › Genre ›
 * Year, and writes the library's index notes so it is a star in the brain.
 *
 * Two steps the user sees apart: analyze() looks through the source and
 * plans where everything goes (nothing is written but a cache of what the
 * vision helper saw), copy() carries the plan out. Copies only: the source is
 * never written, moved or deleted. Each picture is copied to a temp sibling,
 * its date set, its size checked, then put in place without replacing
 * anything (a hard link, or a rename after checking the name is free where
 * links are not supported: an exclusive empty placeholder first, then the
 * copy renamed over it). The library's manifest (`.aether-library.jsonl`)
 * remembers what came from where and each copy's SHA-256, so a second run
 * copies only what is new, leaves out what the user deleted from the library
 * (under any source name), and the notes always cover the whole library.
 *
 * Big drives mean hundreds of thousands of pictures: the manifest and the look
 * cache are JSON lines, appended as work is done and read and rewritten a few
 * thousand lines at a time, so the main thread never stalls on them.
 *
 * The source is walked with the brain's own rules (FsVault): installed games
 * and programs, system and build folders, hidden folders stay out, and so
 * does the library itself when it sits inside the source.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { FsVault, isImageName } from '../fsvault.js'
import { IMAGE_MIME, MAX_DECODE_PIXELS, MAX_THUMB_FILE_BYTES, readHead, readUpTo } from '../assets.js'
import { readMeta, type PictureMeta } from './meta.js'
import { LABEL_SETS, TYPES, type LibraryType } from './classify.js'
import {
  assignDests,
  freeName,
  libraryNotes,
  mergeNote,
  nameKey,
  newNote,
  picksOf,
  place,
  type Picture,
  type PlanItem,
  type Seen,
  type Shelved,
} from './plan.js'
import { VisionUnavailable, type VisionAnswer, type VisionJob } from './vision.js'

/** Bytes of each picture read to learn its kind, size, dates and maker. */
export const HEAD_BYTES = 64 * 1024
/** Smaller than this (bytes), or both sides under TINY_SIDE px: an icon or a cache thumbnail, left out unless asked. */
export const TINY_BYTES = 4 * 1024
export const TINY_SIDE = 160
export const MANIFEST = '.aether-library.jsonl'
/** Pictures read at once (headers), looked at at once, copied at once. */
const READ_CONCURRENCY = 16
const LOOK_CONCURRENCY = 3
const COPY_CONCURRENCY = 2
const TMP_SUFFIX = '.aether-tmp'

export type LibraryPhase = 'scanning' | 'reading' | 'looking' | 'comparing' | 'copying' | 'indexing'

export interface LibraryProgress {
  phase: LibraryPhase
  done: number
  /** Null while the total is not known yet (scanning). */
  total: number | null
}

/** What the librarian needs of the vision helper. */
export interface Eyes {
  look(job: VisionJob): Promise<VisionAnswer | null>
}

export interface AnalyzeOptions {
  source: string
  dest: string
  /** Keep icons and cache thumbnails too. */
  includeTiny?: boolean
  /** The vision helper; null when it cannot run (colours and the model then stay out). */
  eyes: Eyes | null
  /** Compare pictures with the descriptions too (the model is on disk). */
  model: boolean
  cache: LookCache
  signal?: AbortSignal
  onProgress?: (p: LibraryProgress) => void
  now?: Date
}

export interface Analysis {
  source: string
  dest: string
  items: PlanItem[]
  /** Everything in the library now (earlier runs), not counting this plan's new pictures. */
  shelved: Shelved[]
  /** Pictures found by name in the source (before the tiny and unreadable ones were left out). */
  found: number
  tiny: number
  /** Files named like pictures that are not (or could not be read). */
  unreadable: number
  /** Folders left out as installed games or programs. */
  installs: number
  /** The walk stopped at its folder limit. */
  truncated: boolean
  vision: { colours: boolean; model: boolean; error: string | null }
}

const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' })
}

/**
 * `fn` over `list` with at most `n` running at once, in order of start. A
 * failure (or a stop) starts nothing new and is thrown once every step
 * already running has ended, so nothing is still writing when it returns.
 */
async function each<T>(list: T[], n: number, fn: (x: T, i: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0
  let failed = false
  const worker = async () => {
    while (next < list.length && !failed) {
      aborted(signal)
      const i = next++
      await fn(list[i]!, i)
    }
  }
  const all = await Promise.allSettled(
    Array.from({ length: Math.min(n, list.length) }, () =>
      worker().catch((err: unknown) => {
        failed = true
        throw err
      }),
    ),
  )
  const first = all.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (first) throw first.reason
}

/** Progress after every step (the host decides how often to pass it on). */
function reporter(fn: ((p: LibraryProgress) => void) | undefined): (p: LibraryProgress, force?: boolean) => void {
  return (p) => fn?.(p)
}

const pathKey = (abs: string): string => (process.platform === 'win32' ? path.resolve(abs).toLowerCase() : path.resolve(abs))

/** Where `child` is inside `parent` (`/`-separated), '' for the folder itself, or null when outside. */
export function inside(parent: string, child: string): string | null {
  const rel = path.relative(pathKey(parent), pathKey(child))
  if (rel === '') return ''
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return path.relative(path.resolve(parent), path.resolve(child)).split(path.sep).join('/')
}

const srcKey = (abs: string, size: number, mtime: number) => `${pathKey(abs)}|${size}|${Math.round(mtime)}`

/** Let other work run (IPC, the watcher, the renderer's requests) between chunks of a long loop. */
const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve))

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

/** fs.rename, retried briefly when Windows reports the target busy (an indexer or antivirus holding it). */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to)
    } catch (err) {
      const busy = ['EPERM', 'EBUSY', 'EACCES'].includes(errCode(err) ?? '')
      if (attempt >= 4 || !busy || process.platform !== 'win32') throw err
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
    }
  }
}

/** Every line of a JSON-lines file as parsed, a few thousand at a time; false when there is no file. A cut-off last line is skipped. */
async function readLines(file: string, onValue: (v: unknown) => void): Promise<boolean> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return false
  }
  for (let at = 0, n = 0; at < text.length; n++) {
    let nl = text.indexOf('\n', at)
    if (nl < 0) nl = text.length
    const line = text.slice(at, nl).trim()
    at = nl + 1
    if (line) {
      try {
        onValue(JSON.parse(line))
      } catch {
        /* a line a crash cut short */
      }
    }
    if (n % 4000 === 3999) await yieldNow()
  }
  return true
}

/** Replace `file` with `lines` (one JSON value each), written a few thousand at a time to a temp sibling and renamed into place. */
async function writeLines(file: string, lines: Iterable<string>, active: Set<string>): Promise<void> {
  const tmp = `${file}.${randomUUID().slice(0, 8)}${TMP_SUFFIX}`
  active.add(tmp)
  try {
    const h = await fs.open(tmp, 'wx')
    try {
      let buf: string[] = []
      for (const l of lines) {
        buf.push(l)
        if (buf.length >= 2000) {
          await h.write(buf.join('\n') + '\n')
          buf = []
          await yieldNow()
        }
      }
      if (buf.length) await h.write(buf.join('\n') + '\n')
    } finally {
      await h.close()
    }
    await renameRetry(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  } finally {
    active.delete(tmp)
  }
}

/* ------------------------------------------------------------------ */
/* What the helper saw, remembered                                      */
/* ------------------------------------------------------------------ */

/** A short key of the descriptions the pictures are compared with: picks for other descriptions are not reused. */
export const labelsKey = (sets: Record<string, readonly string[]> = LABEL_SETS): string => createHash('sha256').update(JSON.stringify(sets)).digest('hex').slice(0, 16)

/** Most pictures remembered; the oldest go first. */
const CACHE_MAX = 400_000
/** New looks are appended to the file this often (and when a job ends). */
const CACHE_FLUSH_MS = 2000

/**
 * What the vision helper saw in each picture (by path, size and date), kept
 * in the app's data folder between runs as JSON lines
 * `[key, colours, picks, labels]`, appended as pictures are looked at and
 * compacted when the file has grown well past what it holds. Each entry is
 * kept as its JSON text (one string, not a tree of small objects).
 */
export class LookCache {
  private entries = new Map<string, string>()
  private pending: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing: Promise<void> = Promise.resolve()
  private onDisk = 0
  private active = new Set<string>()

  private constructor(
    private file: string | null,
    readonly labels: string,
  ) {}

  /** An empty cache that is never saved (tests). */
  static memory(labels = labelsKey()): LookCache {
    return new LookCache(null, labels)
  }

  static async load(file: string, labels = labelsKey()): Promise<LookCache> {
    const cache = new LookCache(file, labels)
    await readLines(file, (v) => {
      cache.onDisk++
      if (Array.isArray(v) && typeof v[0] === 'string') {
        cache.entries.delete(v[0])
        cache.entries.set(v[0], JSON.stringify(v.slice(1)))
      }
    })
    cache.trim()
    return cache
  }

  get size(): number {
    return this.entries.size
  }

  /** What was seen in this picture (picks only when they answer today's descriptions), or undefined. */
  get(abs: string, size: number, mtime: number): Seen | undefined {
    const text = this.entries.get(srcKey(abs, size, mtime))
    if (text === undefined) return undefined
    const [c, p, l] = JSON.parse(text) as [[number, number, number, number] | null, Record<string, [number, number][]> | null, string | null]
    const colours = c ? { lum: c[0], sat: c[1], warm: c[2], contrast: c[3] } : null
    return { colours, picks: l === this.labels && p ? p : null }
  }

  set(abs: string, size: number, mtime: number, seen: Seen): void {
    const key = srcKey(abs, size, mtime)
    const c = seen.colours ? [seen.colours.lum, seen.colours.sat, seen.colours.warm, seen.colours.contrast].map((x) => Math.round(x * 1000) / 1000) : null
    const value = [c, seen.picks ?? null, seen.picks ? this.labels : null]
    this.entries.delete(key)
    this.entries.set(key, JSON.stringify(value))
    this.trim()
    if (!this.file) return
    this.pending.push(JSON.stringify([key, ...value]))
    this.timer ??= setTimeout(() => {
      this.timer = null
      void this.flush().catch(() => undefined)
    }, CACHE_FLUSH_MS)
  }

  /** Append what was seen since the last save, and compact the file when it holds far more lines than pictures. */
  async save(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.flush()
    if (this.file && this.onDisk > this.entries.size * 1.5 + 1000) {
      const file = this.file
      // After a failed write too: one failure must not stop every later save.
      this.flushing = this.flushing
        .catch(() => undefined)
        .then(async () => {
          await writeLines(file, this.lines(), this.active)
          this.onDisk = this.entries.size
        })
      await this.flushing
    }
  }

  private flush(): Promise<void> {
    const file = this.file
    if (!file || !this.pending.length) return this.flushing
    const lines = this.pending
    this.pending = []
    this.flushing = this.flushing
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.appendFile(file, lines.join('\n') + '\n')
        this.onDisk += lines.length
      })
    return this.flushing
  }

  private *lines(): Iterable<string> {
    for (const [k, v] of this.entries) yield `[${JSON.stringify(k)},${v.slice(1)}`
  }

  private trim(): void {
    while (this.entries.size > CACHE_MAX) this.entries.delete(this.entries.keys().next().value!)
  }
}

/* ------------------------------------------------------------------ */
/* The manifest                                                         */
/* ------------------------------------------------------------------ */

export interface ManifestEntry {
  /** The source file it was copied from. */
  src: string
  size: number
  mtime: number
  type: LibraryType
  genre: string | null
  year: string
  tags: string[]
  /** SHA-256 of its bytes (taken while copying). */
  sha?: string
  /** Day it was copied. */
  added: string
  /** Not in the library any more (the user deleted it): never copied again, left out of the notes. Cleared if it comes back. */
  gone?: boolean
}

/** One line of the manifest: an entry and its library path. Later lines for the same path win. */
type ManifestLine = ManifestEntry & { dest: string }

/**
 * The library's memory, `<library>/.aether-library.jsonl`: one JSON line per
 * picture copied, appended as they are copied (later lines win), compacted
 * once a run is done.
 */
export class Manifest {
  /** By library path. */
  readonly entries = new Map<string, ManifestEntry>()
  private bySrc = new Map<string, string>()
  private pending: string[] = []
  private onDisk = 0
  /** Temp files being written right now (a sweep of leftovers must not take them). */
  readonly active = new Set<string>()

  constructor(readonly dest: string) {}

  get file(): string {
    return path.join(this.dest, MANIFEST)
  }

  static async load(dest: string): Promise<Manifest> {
    const m = new Manifest(dest)
    await readLines(m.file, (v) => {
      m.onDisk++
      if (!isLine(v)) return
      const { dest: at, ...e } = v
      m.entries.set(at, e)
    })
    // Gone: deleted from the library (only "no such file" says so; a drive that is busy or
    // unplugged for a moment does not). Back again: no longer gone. One folder listing per
    // library folder, not one stat per picture (a library holds hundreds of thousands).
    const byFolder = new Map<string, string[]>()
    for (const at of m.entries.keys()) {
      const folder = at.slice(0, Math.max(0, at.lastIndexOf('/')))
      const list = byFolder.get(folder)
      if (list) list.push(at)
      else byFolder.set(folder, [at])
    }
    await each([...byFolder], READ_CONCURRENCY, async ([folder, list]) => {
      let names: Set<string> | null
      try {
        const dirents = await fs.readdir(path.join(m.dest, ...folder.split('/').filter(Boolean)), { withFileTypes: true })
        names = new Set(dirents.filter((d) => d.isFile()).map((d) => nameKey(d.name)))
      } catch (err) {
        const code = errCode(err)
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return
        names = null
      }
      for (const at of list) {
        const e = m.entries.get(at)!
        const there = names?.has(nameKey(at.slice(at.lastIndexOf('/') + 1))) ?? false
        if (e.gone && there) m.change(at, { ...e, gone: false })
        else if (!e.gone && !there) m.change(at, { ...e, gone: true })
      }
      await yieldNow()
    })
    for (const [at, e] of m.entries) m.bySrc.set(srcKey(e.src, e.size, e.mtime), at)
    return m
  }

  /** Remember a picture copied (or a change to one), appended at the next flush. */
  add(at: string, e: ManifestEntry): void {
    this.change(at, e)
    this.bySrc.set(srcKey(e.src, e.size, e.mtime), at)
  }

  /** The library path of the picture copied from this source file before, if any. */
  destOf(abs: string, size: number, mtime: number): string | undefined {
    return this.bySrc.get(srcKey(abs, size, mtime))
  }

  /** Every picture in the library now. */
  shelved(): Shelved[] {
    const out: Shelved[] = []
    for (const [dest, e] of this.entries) {
      if (!e.gone) out.push({ dest, type: e.type, genre: e.genre, year: e.year, tags: e.tags, size: e.size, mtime: e.mtime })
    }
    return out
  }

  /** Append the changes since the last flush. */
  async flush(): Promise<void> {
    if (!this.pending.length) return
    const lines = this.pending
    this.pending = []
    let written = 0
    try {
      await fs.mkdir(this.dest, { recursive: true })
      // A few thousand lines at a time (a library folder that went away changes them all at once).
      for (; written < lines.length; written += 4000) {
        await fs.appendFile(this.file, lines.slice(written, written + 4000).join('\n') + '\n')
        this.onDisk += Math.min(4000, lines.length - written)
      }
    } catch (err) {
      this.pending = [...lines.slice(written), ...this.pending]
      throw err
    }
  }

  /** Flush, then rewrite the file with one line per picture when it holds many more. */
  async compact(): Promise<void> {
    await this.flush()
    if (this.onDisk <= this.entries.size + 500) return
    const entries = this.entries
    await writeLines(this.file, (function* () {
      for (const [dest, e] of entries) yield JSON.stringify({ dest, ...e })
    })(), this.active)
    this.onDisk = this.entries.size
  }

  private change(at: string, e: ManifestEntry): void {
    this.entries.set(at, e)
    this.pending.push(JSON.stringify({ dest: at, ...e }))
  }
}

function isLine(v: unknown): v is ManifestLine {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    typeof e['dest'] === 'string' &&
    typeof e['src'] === 'string' &&
    typeof e['size'] === 'number' &&
    typeof e['mtime'] === 'number' &&
    (TYPES as readonly string[]).includes(e['type'] as string) &&
    (e['genre'] === null || typeof e['genre'] === 'string') &&
    typeof e['year'] === 'string' &&
    Array.isArray(e['tags']) &&
    (e['tags'] as unknown[]).every((t) => typeof t === 'string')
  )
}

/* ------------------------------------------------------------------ */
/* Analyze                                                              */
/* ------------------------------------------------------------------ */

async function sha256(abs: string, signal?: AbortSignal): Promise<string> {
  const h = createHash('sha256')
  await pipeline(createReadStream(abs), h, { signal })
  return h.digest('hex')
}

const EMPTY_META: PictureMeta = { kind: null, width: null, height: null, turned: false, taken: null, make: null, model: null, software: null, ai: null }

/** Look through the source and plan the library. Writes nothing but the look cache. */
export async function analyze(o: AnalyzeOptions): Promise<Analysis> {
  const { source, dest, signal } = o
  const progress = reporter(o.onProgress)
  if (inside(source, dest) === '') throw new Error('The library cannot be the folder it is sorted from')

  // 1. Every picture by name, with the brain's skip rules (and never the library itself).
  progress({ phase: 'scanning', done: 0, total: null }, true)
  const walker = new FsVault([source], { hidden: [dest], maxAssets: 2_000_000, maxDirs: 1_000_000 })
  const scan = await walker.scan((p) => {
    aborted(signal)
    progress({ phase: 'scanning', done: p.dirs, total: null })
  })
  aborted(signal)
  const named = scan.assets.filter((a) => isImageName(path.basename(a.abs)))

  // 2. Kind, size, dates, maker: the first 64 KB of each.
  const pictures: (Picture | null)[] = new Array(named.length).fill(null)
  let tiny = 0
  let unreadable = 0
  let read = 0
  await each(
    named,
    READ_CONCURRENCY,
    async (a, i) => {
      try {
        const st = await fs.stat(a.abs)
        if (!st.isFile()) throw new Error('not a file')
        const meta = st.size ? readMeta(await readHead(a.abs, HEAD_BYTES)) : EMPTY_META
        if (!meta.kind) unreadable++
        else if (!o.includeTiny && (st.size < TINY_BYTES || (meta.width !== null && meta.height !== null && Math.max(meta.width, meta.height) < TINY_SIDE))) tiny++
        else pictures[i] = { abs: a.abs, rel: a.path, size: st.size, mtime: st.mtimeMs, meta }
      } catch {
        unreadable++
      }
      progress({ phase: 'reading', done: ++read, total: named.length })
    },
    signal,
  )
  const pics = pictures.filter((p): p is Picture => p !== null)

  // 3. What the library has from earlier runs.
  const manifest = await Manifest.load(dest)
  const items: PlanItem[] = []
  const fresh: PlanItem[] = []
  for (const pic of pics) {
    const before = manifest.destOf(pic.abs, pic.size, pic.mtime)
    const e = before ? manifest.entries.get(before) : undefined
    if (before && e) {
      items.push({ id: items.length, pic, placement: { type: e.type, genre: e.genre, year: e.year, dateFrom: null, tags: e.tags, why: 'copied before' }, dest: before, status: e.gone ? 'removed' : 'copied' })
    } else {
      const it: PlanItem = { id: items.length, pic, placement: place(pic, null, o.now), dest: '', status: 'new' }
      items.push(it)
      fresh.push(it)
    }
    if (items.length % 2000 === 0) await yieldNow()
  }

  // 4. Colours and (with the model) what each new picture looks like.
  const vision = { colours: false, model: false, error: null as string | null }
  let eyes = o.eyes
  let useModel = o.model
  let looked = 0
  await each(
    fresh,
    LOOK_CONCURRENCY,
    async (it) => {
      const { abs, size, mtime, meta } = it.pic
      let seen = o.cache.get(abs, size, mtime)
      if ((!seen || (useModel && !seen.picks)) && eyes && meta.kind && (meta.width ?? 1) * (meta.height ?? 1) <= MAX_DECODE_PIXELS) {
        const bytes = await readUpTo(abs, MAX_THUMB_FILE_BYTES).catch(() => null)
        aborted(signal)
        if (bytes && eyes) {
          // The size it is shown at (after its EXIF turn): the helper decodes it already scaled.
          const [width, height] = meta.turned ? [meta.height, meta.width] : [meta.width, meta.height]
          let answer: VisionAnswer | null = null
          try {
            answer = await eyes.look({ bytes, type: IMAGE_MIME[meta.kind], width, height, sets: useModel ? LABEL_SETS : null })
          } catch (err) {
            if (!(err instanceof VisionUnavailable)) throw err
            aborted(signal)
            // No helper: the rest is sorted by its metadata, names and folders.
            vision.error = err.message
            eyes = null
          }
          if (answer?.modelError) {
            vision.error = `The vision model could not look: ${answer.modelError}`
            useModel = false
          }
          if (answer) {
            seen = { colours: answer.colours, picks: answer.probs ? picksOf(answer.probs) : (seen?.picks ?? null) }
            o.cache.set(abs, size, mtime, seen)
          }
        }
      }
      if (seen) {
        if (seen.colours) vision.colours = true
        if (seen.picks) vision.model = true
        it.placement = place(it.pic, seen, o.now)
      }
      progress({ phase: 'looking', done: ++looked, total: fresh.length })
    },
    signal,
  ).finally(() => o.cache.save().catch(() => undefined))

  // 5. The same bytes twice (in the source, already in the library, or deleted from it): copied once, or not again.
  const removed = new Map<string, PlanItem>()
  for (const it of items) if (it.status === 'removed') removed.set(it.dest, it)
  await markDuplicates(fresh, manifest, removed, signal, (done, total) => progress({ phase: 'comparing', done, total }))

  // 6. Names in each library folder, free of each other and of what is there.
  assignDests(items, manifest.entries.keys())
  progress({ phase: 'comparing', done: 1, total: 1 }, true)
  return {
    source,
    dest,
    items,
    shelved: manifest.shelved(),
    found: named.length,
    tiny,
    unreadable,
    installs: scan.installs.length,
    truncated: scan.truncated,
    vision,
  }
}

/** A member of a group of same-size files: a new picture, a picture in the library, or one deleted from it. */
interface Member {
  item?: PlanItem
  dest?: string
  gone?: boolean
}

/**
 * New pictures whose bytes are in the library already, or repeat an earlier
 * new picture, become duplicates; those whose bytes the user deleted from
 * the library (under any source name) become removed. Only files of the same
 * size are hashed. `removed`: this run's pictures whose copy was deleted, by
 * library path (their source is read for an entry kept without a hash).
 */
async function markDuplicates(
  fresh: PlanItem[],
  manifest: Manifest,
  removed: Map<string, PlanItem>,
  signal: AbortSignal | undefined,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const bySize = new Map<number, Member[]>()
  const at = (size: number) => {
    let l = bySize.get(size)
    if (!l) bySize.set(size, (l = []))
    return l
  }
  for (const it of fresh) at(it.pic.size).push({ item: it })
  for (const [dest, e] of manifest.entries) if (bySize.has(e.size)) at(e.size).push({ dest, gone: !!e.gone })
  const groups = [...bySize.values()].filter((g) => g.length > 1 && g.some((x) => x.item))
  const total = groups.reduce((a, g) => a + g.length, 0)
  let done = 0
  // The library first (a new copy of one of its pictures is the duplicate), then what was deleted from
  // it, then the oldest file, then the shortest path: `gate.png` is kept, `gate copy.png` repeats it.
  const rank = (x: Member): [number, number, number] => (x.dest ? [x.gone ? 1 : 0, 0, 0] : [2, x.item!.pic.mtime, x.item!.pic.rel.length])
  for (const g of groups) {
    g.sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)]
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || (a.item?.pic.rel ?? '').localeCompare(b.item?.pic.rel ?? '')
    })
    const firstOf = new Map<string, Member>()
    for (const x of g) {
      aborted(signal)
      let sha: string | null = null
      try {
        if (x.dest) {
          const e = manifest.entries.get(x.dest)!
          const was = removed.get(x.dest)
          // A deleted copy is known by its hash, or by its source when it is still there.
          sha = e.sha ?? (x.gone ? (was ? await sha256(was.pic.abs, signal) : null) : await sha256(path.join(manifest.dest, ...x.dest.split('/')), signal))
          if (sha) e.sha = sha
        } else sha = x.item!.pic.sha ?? (await sha256(x.item!.pic.abs, signal))
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err
      }
      onProgress(++done, total)
      if (!sha) continue
      const first = firstOf.get(sha)
      if (x.item) {
        x.item.pic.sha = sha
        if (first) {
          x.item.status = first.gone ? 'removed' : 'duplicate'
          x.item.duplicateOf = first.dest ?? `#${first.item!.id}`
          continue
        }
      }
      if (!first) firstOf.set(sha, x)
    }
    await yieldNow()
  }
}

/* ------------------------------------------------------------------ */
/* Copy                                                                 */
/* ------------------------------------------------------------------ */

export interface CopyOptions {
  signal?: AbortSignal
  onProgress?: (p: LibraryProgress) => void
  now?: Date
}

export interface CopyResult {
  copied: number
  bytes: number
  /** Already in the library with the same bytes under the planned name. */
  alreadyThere: number
  failed: { rel: string; error: string }[]
  /** Index notes written or updated. */
  notes: number
  /** Library paths of the index notes (the hub first). */
  notePaths: string[]
  stopped: boolean
  /** Something went wrong that is no picture's fault (the manifest could not be written), or null. */
  warning: string | null
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Copy `src` to `tmp` (which must not exist), hashing the bytes on the way. */
async function copyHashed(src: string, tmp: string, signal?: AbortSignal): Promise<{ size: number; sha: string }> {
  const hash = createHash('sha256')
  let size = 0
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk)
      size += chunk.length
      cb(null, chunk)
    },
  })
  await pipeline(createReadStream(src), tap, createWriteStream(tmp, { flags: 'wx' }), { signal })
  return { size, sha: hash.digest('hex') }
}

/** True when `abs` holds exactly the bytes of `pic` (same size, same SHA-256). */
async function sameBytes(abs: string, pic: Picture, signal?: AbortSignal): Promise<boolean> {
  const st = await fs.stat(abs).catch(() => null)
  if (!st?.isFile() || st.size !== pic.size) return false
  pic.sha ??= await sha256(pic.abs, signal)
  return (await sha256(abs, signal)) === pic.sha
}

const exists = () => Object.assign(new Error('EEXIST: the name is taken'), { code: 'EEXIST' })

/**
 * `tmp` put in place at `final` without replacing anything: a hard link
 * (fails when anything is there). Where the drive has no hard links (exFAT,
 * FAT32), an empty placeholder is created exclusively first, then the copy
 * renamed over that placeholder, which is ours.
 */
async function placeNew(tmp: string, final: string): Promise<void> {
  try {
    await fs.link(tmp, final)
    await fs.rm(tmp, { force: true })
    return
  } catch (err) {
    if (errCode(err) === 'EEXIST') throw err
  }
  const placeholder = await fs.open(final, 'wx')
  await placeholder.close()
  try {
    await renameRetry(tmp, final)
  } catch (err) {
    // Only our own empty placeholder is taken away.
    const st = await fs.stat(final).catch(() => null)
    if (st?.size === 0) await fs.rm(final, { force: true }).catch(() => undefined)
    throw err
  }
}

/** One copy run's shared state: names reserved by either worker, folders swept, temp files in use. */
interface CopyRun {
  lib: string
  /** nameKeys of every library path planned or chosen this run (and the manifest's). */
  reserved: Set<string>
  swept: Set<string>
  active: Set<string>
  signal?: AbortSignal
}

/** Remove temp files a crash left in `dir` (not the ones being written now). Once per folder per run. */
async function sweep(run: CopyRun, dir: string): Promise<void> {
  const key = nameKey(dir)
  if (run.swept.has(key)) return
  run.swept.add(key)
  for (const n of await fs.readdir(dir).catch(() => [] as string[])) {
    const abs = path.join(dir, n)
    if (n.endsWith(TMP_SUFFIX) && !run.active.has(abs)) await fs.rm(abs, { force: true }).catch(() => undefined)
  }
}

/**
 * Copy one picture into the library at its planned path; when something took
 * that name since, the same bytes count as copied, else the next name free on
 * disk and in this run. Returns the library path used.
 */
async function copyOne(run: CopyRun, it: PlanItem): Promise<{ dest: string; there: boolean }> {
  let dest = it.dest
  const fileName = it.pic.rel.slice(it.pic.rel.lastIndexOf('/') + 1)
  for (let attempt = 0; attempt < 50; attempt++) {
    const final = path.join(run.lib, ...dest.split('/'))
    const dir = path.dirname(final)
    await fs.mkdir(dir, { recursive: true })
    await sweep(run, dir)
    if (await sameBytes(final, it.pic, run.signal)) return { dest, there: true }
    const tmp = `${final}.${randomUUID().slice(0, 8)}${TMP_SUFFIX}`
    run.active.add(tmp)
    try {
      const { size, sha } = await copyHashed(it.pic.abs, tmp, run.signal)
      if (size !== it.pic.size) throw new Error(`Copied ${size} of ${it.pic.size} bytes (the file changed while it was copied)`)
      it.pic.sha = sha
      // The picture keeps its date in the library.
      await fs.utimes(tmp, new Date(), new Date(it.pic.mtime))
      await placeNew(tmp, final)
      return { dest, there: false }
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      if (errCode(err) !== 'EEXIST') throw err
      // Taken since the plan: the next name free on disk and not reserved by either worker.
      const folder = dest.slice(0, dest.lastIndexOf('/'))
      const taken = new Set((await fs.readdir(dir).catch(() => [] as string[])).map(nameKey))
      const prefix = `${nameKey(folder)}/`
      for (const r of run.reserved) if (r.startsWith(prefix)) taken.add(r.slice(prefix.length))
      dest = `${folder}/${freeName(fileName, taken)}`
      run.reserved.add(nameKey(dest))
    } finally {
      run.active.delete(tmp)
    }
  }
  throw new Error('No free name')
}

/** Write (or update) the library's index notes; returns their library paths, the hub first. */
export async function writeNotes(lib: string, shelved: Shelved[], source: string, now = new Date()): Promise<string[]> {
  const day = localDay(now)
  const name = path.basename(path.resolve(lib)) || 'Library'
  const notes = libraryNotes(name, shelved, { source, day })
  for (const n of notes) {
    const abs = path.join(lib, ...n.path.split('/'))
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const existing = await fs.readFile(abs, 'utf8').catch(() => null)
    const text = existing === null ? newNote(n, day) : mergeNote(existing, n.section, day)
    if (text === existing) continue
    const tmp = `${abs}.${randomUUID().slice(0, 8)}${TMP_SUFFIX}`
    await fs.writeFile(tmp, text, { flag: 'wx' })
    try {
      if (existing === null) await placeNew(tmp, abs)
      else await renameRetry(tmp, abs)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
  }
  return notes.map((n) => n.path)
}

/** The manifest is appended to this often while copying (and once at the end). */
const MANIFEST_FLUSH_MS = 2000

/** Carry out a plan: copy its new pictures, remember them in the manifest, write the index notes. */
export async function copyPlan(a: Analysis, o: CopyOptions = {}): Promise<CopyResult> {
  const { signal } = o
  const now = o.now ?? new Date()
  const progress = reporter(o.onProgress)
  const manifest = await Manifest.load(a.dest)
  const todo = a.items.filter((it) => it.status === 'new')
  const result: CopyResult = { copied: 0, bytes: 0, alreadyThere: 0, failed: [], notes: 0, notePaths: [], stopped: false, warning: null }
  const run: CopyRun = { lib: a.dest, reserved: new Set(), swept: new Set(), active: manifest.active, ...(signal ? { signal } : {}) }
  for (const it of todo) run.reserved.add(nameKey(it.dest))
  for (const k of manifest.entries.keys()) run.reserved.add(nameKey(k))
  await fs.mkdir(a.dest, { recursive: true })
  await sweep(run, a.dest)
  // The manifest is written apart from the pictures: failing to write it is no picture's fault.
  let lastFlush = Date.now()
  const flush = async (force: boolean) => {
    if (!force && Date.now() - lastFlush < MANIFEST_FLUSH_MS) return
    lastFlush = Date.now()
    try {
      await manifest.flush()
    } catch (err) {
      result.warning = `The library's manifest could not be written (${err instanceof Error ? err.message : String(err)}): the next run checks the pictures again.`
    }
  }
  let done = 0
  progress({ phase: 'copying', done: 0, total: todo.length }, true)
  try {
    await each(
      todo,
      COPY_CONCURRENCY,
      async (it) => {
        let copied: { dest: string; there: boolean } | null = null
        try {
          copied = await copyOne(run, it)
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err
          result.failed.push({ rel: it.pic.rel, error: err instanceof Error ? err.message : String(err) })
        }
        if (copied) {
          it.dest = copied.dest
          it.status = 'copied'
          const pl = it.placement
          manifest.add(copied.dest, {
            src: it.pic.abs,
            size: it.pic.size,
            mtime: it.pic.mtime,
            type: pl.type,
            genre: pl.genre,
            year: pl.year,
            tags: pl.tags,
            ...(it.pic.sha ? { sha: it.pic.sha } : {}),
            added: localDay(now),
          })
          if (copied.there) result.alreadyThere++
          else {
            result.copied++
            result.bytes += it.pic.size
          }
        }
        await flush(false)
        progress({ phase: 'copying', done: ++done, total: todo.length })
      },
      signal,
    )
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err
    result.stopped = true
  } finally {
    await flush(true)
    await manifest.compact().catch(() => undefined)
  }
  // The notes cover whatever is in the library now, stopped or not.
  progress({ phase: 'indexing', done: 0, total: 1 }, true)
  const shelved = manifest.shelved()
  if (shelved.length) {
    result.notePaths = await writeNotes(a.dest, shelved, a.source, now)
    result.notes = result.notePaths.length
  }
  progress({ phase: 'indexing', done: 1, total: 1 }, true)
  return result
}
