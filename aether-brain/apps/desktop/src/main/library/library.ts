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
 * links are not supported). The library's manifest (`.aether-library.json`)
 * remembers what came from where, so a second run copies only what is new,
 * leaves out what the user deleted from the library, and the notes always
 * cover the whole library.
 *
 * The source is walked with the brain's own rules (FsVault): installed games
 * and programs, system and build folders, hidden folders stay out, and so
 * does the library itself when it sits inside the source.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
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
export const MANIFEST = '.aether-library.json'
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

/* ------------------------------------------------------------------ */
/* What the helper saw, remembered                                      */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  /** lum, sat, warm, contrast. */
  c: [number, number, number, number] | null
  p?: Record<string, [number, number][]>
  /** Which descriptions `p` answers (labelsKey). */
  l?: string
}

/** A short key of the descriptions the pictures are compared with: picks for other descriptions are not reused. */
export const labelsKey = (sets: Record<string, readonly string[]> = LABEL_SETS): string => createHash('sha256').update(JSON.stringify(sets)).digest('hex').slice(0, 16)

/** Most pictures remembered; the oldest go first. */
const CACHE_MAX = 400_000

/** What the vision helper saw in each picture (by path, size and date), kept in the app's data folder between runs. */
export class LookCache {
  private entries = new Map<string, CacheEntry>()
  private dirty = false

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
    try {
      const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
      const entries = raw && typeof raw === 'object' ? (raw as { entries?: unknown }).entries : null
      if (entries && typeof entries === 'object') {
        for (const [k, v] of Object.entries(entries as Record<string, CacheEntry>)) if (v && typeof v === 'object') cache.entries.set(k, v)
      }
    } catch {
      /* none yet, or unreadable: start empty */
    }
    return cache
  }

  get size(): number {
    return this.entries.size
  }

  /** What was seen in this picture (picks only when they answer today's descriptions), or undefined. */
  get(abs: string, size: number, mtime: number): Seen | undefined {
    const e = this.entries.get(srcKey(abs, size, mtime))
    if (!e) return undefined
    const [lum = 0, sat = 0, warm = 0, contrast = 0] = e.c ?? []
    return { colours: e.c ? { lum, sat, warm, contrast } : null, picks: e.l === this.labels && e.p ? e.p : null }
  }

  set(abs: string, size: number, mtime: number, seen: Seen): void {
    const key = srcKey(abs, size, mtime)
    const c = seen.colours
    const e: CacheEntry = { c: c ? [c.lum, c.sat, c.warm, c.contrast].map((x) => Math.round(x * 1000) / 1000) as CacheEntry['c'] : null }
    if (seen.picks) {
      e.p = seen.picks
      e.l = this.labels
    }
    this.entries.delete(key)
    this.entries.set(key, e)
    while (this.entries.size > CACHE_MAX) this.entries.delete(this.entries.keys().next().value!)
    this.dirty = true
  }

  async save(): Promise<void> {
    if (!this.file || !this.dirty) return
    this.dirty = false
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }))
    await fs.rename(tmp, this.file)
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
  /** SHA-256, once it was needed to tell duplicates apart. */
  sha?: string
  /** Day it was copied. */
  added: string
  /** Deleted from the library since: never copied again, left out of the notes. */
  gone?: boolean
}

export class Manifest {
  /** By library path. */
  readonly entries = new Map<string, ManifestEntry>()
  private bySrc = new Map<string, string>()

  constructor(readonly dest: string) {}

  static async load(dest: string): Promise<Manifest> {
    const m = new Manifest(dest)
    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(path.join(dest, MANIFEST), 'utf8'))
    } catch {
      return m
    }
    const entries = raw && typeof raw === 'object' ? (raw as { entries?: unknown }).entries : null
    if (!entries || typeof entries !== 'object') return m
    const list = Object.entries(entries as Record<string, unknown>).filter((kv): kv is [string, ManifestEntry] => isEntry(kv[1]))
    // A picture the user deleted from the library stays out of it.
    await each(list, READ_CONCURRENCY, async ([dest, e]) => {
      if (!e.gone && !(await fs.stat(path.join(m.dest, ...dest.split('/'))).catch(() => null))) e.gone = true
    })
    for (const [dest, e] of list) m.add(dest, e)
    return m
  }

  add(dest: string, e: ManifestEntry): void {
    this.entries.set(dest, e)
    this.bySrc.set(srcKey(e.src, e.size, e.mtime), dest)
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

  async save(): Promise<void> {
    await fs.mkdir(this.dest, { recursive: true })
    const file = path.join(this.dest, MANIFEST)
    const tmp = `${file}.${randomUUID().slice(0, 8)}${TMP_SUFFIX}`
    await fs.writeFile(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }, null, 1))
    await fs.rename(tmp, file)
  }
}

function isEntry(v: unknown): v is ManifestEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
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

const EMPTY_META: PictureMeta = { kind: null, width: null, height: null, taken: null, make: null, model: null, software: null, ai: null }

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
        if (bytes) {
          let answer: VisionAnswer | null = null
          try {
            answer = await eyes.look({ bytes, type: IMAGE_MIME[meta.kind], width: meta.width, height: meta.height, sets: useModel ? LABEL_SETS : null })
          } catch (err) {
            if (!(err instanceof VisionUnavailable)) throw err
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
      if (looked % 500 === 0) await o.cache.save().catch(() => undefined)
    },
    signal,
  ).finally(() => o.cache.save().catch(() => undefined))

  // 5. The same bytes twice (in the source, or already in the library): copied once.
  await markDuplicates(fresh, manifest, signal, (done, total) => progress({ phase: 'comparing', done, total }))

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

/**
 * New pictures whose bytes are already in the library, or repeat an earlier
 * new picture, become duplicates. Only files of the same size are hashed.
 */
async function markDuplicates(fresh: PlanItem[], manifest: Manifest, signal: AbortSignal | undefined, onProgress: (done: number, total: number) => void): Promise<void> {
  const bySize = new Map<number, { item?: PlanItem; dest?: string }[]>()
  const at = (size: number) => {
    let l = bySize.get(size)
    if (!l) bySize.set(size, (l = []))
    return l
  }
  for (const it of fresh) at(it.pic.size).push({ item: it })
  for (const [dest, e] of manifest.entries) if (!e.gone && bySize.has(e.size)) at(e.size).push({ dest })
  const groups = [...bySize.values()].filter((g) => g.length > 1 && g.some((x) => x.item))
  const total = groups.reduce((a, g) => a + g.length, 0)
  let done = 0
  for (const g of groups) {
    // Pictures already in the library come first (a new copy of one of them is the duplicate), then
    // the oldest file, then the shortest path: `gate.png` is kept, `gate copy.png` is its duplicate.
    const rank = (x: { item?: PlanItem; dest?: string }) => (x.dest ? [0, 0, 0] : [1, x.item!.pic.mtime, x.item!.pic.rel.length])
    g.sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)]
      return ra[0]! - rb[0]! || ra[1]! - rb[1]! || ra[2]! - rb[2]! || (a.item?.pic.rel ?? '').localeCompare(b.item?.pic.rel ?? '')
    })
    const firstOf = new Map<string, string>()
    for (const x of g) {
      aborted(signal)
      let sha: string | null = null
      try {
        if (x.dest) {
          const e = manifest.entries.get(x.dest)!
          sha = e.sha ?? (e.sha = await sha256(path.join(manifest.dest, ...x.dest.split('/')), signal))
        } else sha = await sha256(x.item!.pic.abs, signal)
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err
      }
      onProgress(++done, total)
      if (!sha) continue
      const first = firstOf.get(sha)
      if (x.item) {
        x.item.pic.sha = sha
        if (first !== undefined) {
          x.item.status = 'duplicate'
          x.item.duplicateOf = first
          continue
        }
      }
      if (first === undefined) firstOf.set(sha, x.dest ?? `#${x.item!.id}`)
    }
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
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** True when `abs` holds exactly the bytes of `pic` (same size, same SHA-256). */
async function sameBytes(abs: string, pic: Picture, signal?: AbortSignal): Promise<boolean> {
  const st = await fs.stat(abs).catch(() => null)
  if (!st?.isFile() || st.size !== pic.size) return false
  pic.sha ??= await sha256(pic.abs, signal)
  return (await sha256(abs, signal)) === pic.sha
}

/**
 * `tmp` put in place at `final` without replacing anything: a hard link
 * (fails when anything is there), or where the file system has none (exFAT,
 * FAT32) a rename after checking the name is free.
 */
async function placeNew(tmp: string, final: string): Promise<void> {
  try {
    await fs.link(tmp, final)
    await fs.rm(tmp, { force: true })
    return
  } catch (err) {
    if (errCode(err) === 'EEXIST') throw err
  }
  if (await fs.lstat(final).catch(() => null)) throw Object.assign(new Error(`EEXIST: ${final}`), { code: 'EEXIST' })
  await fs.rename(tmp, final)
}

/** Copy one picture to `dest` inside the library; on a taken name, the same bytes count as copied, else the next free name. Returns the library path used. */
async function copyOne(lib: string, it: PlanItem, signal?: AbortSignal): Promise<{ dest: string; there: boolean }> {
  let dest = it.dest
  for (let attempt = 0; attempt < 50; attempt++) {
    const final = path.join(lib, ...dest.split('/'))
    await fs.mkdir(path.dirname(final), { recursive: true })
    if (await sameBytes(final, it.pic, signal)) return { dest, there: true }
    const tmp = `${final}.${randomUUID().slice(0, 8)}${TMP_SUFFIX}`
    try {
      await fs.copyFile(it.pic.abs, tmp, constants.COPYFILE_EXCL)
      const st = await fs.stat(tmp)
      if (st.size !== it.pic.size) throw new Error(`Copied ${st.size} of ${it.pic.size} bytes`)
      // The picture keeps its date in the library.
      await fs.utimes(tmp, new Date(), new Date(it.pic.mtime))
      await placeNew(tmp, final)
      return { dest, there: false }
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      if (errCode(err) !== 'EEXIST') throw err
      // Something else took the name since the plan: the next free one in that folder.
      const folder = dest.slice(0, dest.lastIndexOf('/'))
      const names = new Set((await fs.readdir(path.dirname(final)).catch(() => [] as string[])).map(nameKey))
      dest = `${folder}/${freeName(it.pic.rel.slice(it.pic.rel.lastIndexOf('/') + 1), names)}`
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
    await fs.writeFile(tmp, text, existing === null ? { flag: 'wx' } : {})
    if (existing === null) await placeNew(tmp, abs).catch(async (err: unknown) => {
      await fs.rm(tmp, { force: true })
      throw err
    })
    else await fs.rename(tmp, abs)
  }
  return notes.map((n) => n.path)
}

/** Carry out a plan: copy its new pictures, remember them in the manifest, write the index notes. */
export async function copyPlan(a: Analysis, o: CopyOptions = {}): Promise<CopyResult> {
  const { signal } = o
  const now = o.now ?? new Date()
  const progress = reporter(o.onProgress)
  const manifest = await Manifest.load(a.dest)
  const todo = a.items.filter((it) => it.status === 'new')
  const result: CopyResult = { copied: 0, bytes: 0, alreadyThere: 0, failed: [], notes: 0, notePaths: [], stopped: false }
  let done = 0
  let sinceSave = 0
  progress({ phase: 'copying', done: 0, total: todo.length }, true)
  try {
    await each(
      todo,
      COPY_CONCURRENCY,
      async (it) => {
        try {
          const { dest, there } = await copyOne(a.dest, it, signal)
          it.dest = dest
          it.status = 'copied'
          const pl = it.placement
          manifest.add(dest, {
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
          if (there) result.alreadyThere++
          else {
            result.copied++
            result.bytes += it.pic.size
          }
          if (++sinceSave >= 200) {
            sinceSave = 0
            await manifest.save()
          }
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err
          result.failed.push({ rel: it.pic.rel, error: err instanceof Error ? err.message : String(err) })
        }
        progress({ phase: 'copying', done: ++done, total: todo.length })
      },
      signal,
    )
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err
    result.stopped = true
  } finally {
    await manifest.save()
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
