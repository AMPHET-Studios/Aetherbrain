/**
 * The librarian in the app: its settings (where from, where to), one job at
 * a time (look through, or copy), progress for the panel, the vision model's
 * download, and thumbnails of the pictures a plan will copy. Electron-free:
 * main.ts hands in what it needs (the vision helper, the thumbnailer, the
 * vault's paths, a fetch for the download).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { analyze, copyPlan, LookCache, type Analysis, type Eyes, type LibraryProgress } from './library/library.js'
import { TASTE_NAMES } from './library/plan.js'
import { VISION_MODEL_LABEL, VISION_MODEL_MB, type VisionModel } from './library/vision-model.js'
import type {
  LibraryEventDto,
  LibraryModelAction,
  LibraryModelDto,
  LibraryPatch,
  LibraryPlanDto,
  LibraryProgressDto,
  LibraryResultDto,
  LibraryState,
  LibraryStatusDto,
  LibraryTypeDto,
} from '../shared/library.js'

export interface LibrarySettings {
  source?: string
  dest?: string
  includeTiny?: boolean
}

export interface LibraryHostOptions {
  initial: LibrarySettings
  defaults: { source: string; dest: string }
  save(s: LibrarySettings): void
  emit(e: LibraryEventDto): void
  /** The vision helper (null when it cannot run here). */
  eyes(): Eyes | null
  /** Let the vision helper go (a job ended: it holds the model in memory). */
  restEyes(): void
  model: VisionModel
  cacheFile: string
  /** The vault path of an absolute path inside the brain's folders, else null. */
  toVault(abs: string): string | null
  /** PNG bytes of a picture at most `px` on its longer side, or null. */
  thumb(abs: string, px: number): Promise<Uint8Array | null>
}

/** Plain settings from settings.json: absolute paths only. */
export function librarySettings(raw: unknown): LibrarySettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const abs = (v: unknown) => (typeof v === 'string' && path.isAbsolute(v) ? path.resolve(v) : undefined)
  const out: LibrarySettings = {}
  const source = abs(r['source'])
  const dest = abs(r['dest'])
  if (source) out.source = source
  if (dest) out.dest = dest
  if (typeof r['includeTiny'] === 'boolean') out.includeTiny = r['includeTiny']
  return out
}

/** Pictures shown per genre in the panel. */
const SAMPLES = 6
const THUMB_PX = 160

/** What the panel shows of a plan: the new pictures, by type, genre and year. */
export function planDto(a: Analysis, freeBytes: number | null): LibraryPlanDto {
  const todo = a.items.filter((i) => i.status === 'new')
  const types = new Map<string, { count: number; bytes: number; genres: Map<string, { count: number; bytes: number; years: Map<string, number>; items: typeof todo }> }>()
  const taste = new Map<string, number>()
  const years = new Map<string, number>()
  for (const it of todo) {
    const { type, genre, year, tags } = it.placement
    let t = types.get(type)
    if (!t) types.set(type, (t = { count: 0, bytes: 0, genres: new Map() }))
    t.count++
    t.bytes += it.pic.size
    const gk = genre ?? ''
    let g = t.genres.get(gk)
    if (!g) t.genres.set(gk, (g = { count: 0, bytes: 0, years: new Map(), items: [] }))
    g.count++
    g.bytes += it.pic.size
    g.years.set(year, (g.years.get(year) ?? 0) + 1)
    g.items.push(it)
    years.set(year, (years.get(year) ?? 0) + 1)
    for (const tag of tags) if (tag in TASTE_NAMES) taste.set(tag, (taste.get(tag) ?? 0) + 1)
  }
  const byYear = (m: Map<string, number>) => [...m].sort((x, y) => y[0].localeCompare(x[0])).map(([year, count]) => ({ year, count }))
  const typeList: LibraryTypeDto[] = [...types]
    .sort((x, y) => y[1].count - x[1].count || x[0].localeCompare(y[0]))
    .map(([type, t]) => ({
      type,
      count: t.count,
      bytes: t.bytes,
      genres: [...t.genres]
        .sort((x, y) => y[1].count - x[1].count || x[0].localeCompare(y[0]))
        .map(([genre, g]) => ({
          genre: genre || null,
          count: g.count,
          bytes: g.bytes,
          years: byYear(g.years),
          samples: [...g.items]
            .sort((x, y) => y.pic.mtime - x.pic.mtime)
            .slice(0, SAMPLES)
            .map((i) => i.id),
        })),
    }))
  return {
    source: a.source,
    dest: a.dest,
    found: a.found,
    tiny: a.tiny,
    unreadable: a.unreadable,
    installs: a.installs,
    truncated: a.truncated,
    toCopy: todo.length,
    bytes: todo.reduce((s, i) => s + i.pic.size, 0),
    duplicates: a.items.filter((i) => i.status === 'duplicate').length,
    already: a.items.filter((i) => i.status === 'copied').length,
    removed: a.items.filter((i) => i.status === 'removed').length,
    vision: a.vision,
    types: typeList,
    taste: [...taste].sort((x, y) => y[1] - x[1]).map(([tag, count]) => ({ tag, label: TASTE_NAMES[tag] ?? tag, count })),
    years: byYear(years),
    freeBytes,
  }
}

/** Free bytes on the drive of `abs` (its nearest existing folder), or null. */
async function freeSpace(abs: string): Promise<number | null> {
  for (let cur = path.resolve(abs); ; cur = path.dirname(cur)) {
    try {
      const st = await fs.statfs(cur)
      return st.bavail * st.bsize
    } catch {
      if (path.dirname(cur) === cur) return null
    }
  }
}

const isAbort = (err: unknown) => (err as Error | null)?.name === 'AbortError'

export class LibraryHost {
  private settings: LibrarySettings
  private state: LibraryState = 'idle'
  private progress: LibraryProgressDto | null = null
  private analysis: Analysis | null = null
  private plan: LibraryPlanDto | null = null
  private result: LibraryResultDto | null = null
  private error: string | null = null
  private job: AbortController | null = null
  private modelJob: AbortController | null = null
  private modelInfo = { ready: false, bytes: 0, done: 0, total: null as number | null, error: null as string | null }
  private lastProgress = 0

  constructor(private opts: LibraryHostOptions) {
    this.settings = librarySettings(opts.initial)
    void this.refreshModel().then(() => this.emitStatus())
  }

  get source(): string {
    return this.settings.source ?? this.opts.defaults.source
  }

  get dest(): string {
    return this.settings.dest ?? this.opts.defaults.dest
  }

  status(): LibraryStatusDto {
    return {
      source: this.source,
      dest: this.dest,
      includeTiny: this.settings.includeTiny ?? false,
      state: this.state,
      progress: this.progress,
      plan: this.plan,
      result: this.result,
      error: this.error,
      model: this.modelDto(),
    }
  }

  configure(patch: LibraryPatch): LibraryStatusDto {
    if (this.busy) throw new Error('The librarian is busy: stop it first')
    const next = { ...this.settings }
    for (const key of ['source', 'dest'] as const) {
      const v = patch[key]
      if (v === undefined) continue
      const s = String(v).trim()
      if (!s || !path.isAbsolute(s)) throw new Error(`Type a whole path, like ${key === 'source' ? 'D:\\' : 'F:\\MASTERIMAGES'}`)
      next[key] = path.resolve(s)
    }
    if (typeof patch.includeTiny === 'boolean') next.includeTiny = patch.includeTiny
    this.settings = next
    this.opts.save(next)
    // A plan is for the folders it was made for.
    if (patch.source !== undefined || patch.dest !== undefined || patch.includeTiny !== undefined) this.reset()
    this.emitStatus()
    return this.status()
  }

  /** Look through the source and plan the library (in the background; progress and the plan arrive as events). */
  analyze(): LibraryStatusDto {
    if (this.busy) throw new Error('The librarian is busy')
    const ac = new AbortController()
    this.job = ac
    this.reset()
    this.state = 'analyzing'
    this.emitStatus()
    void this.runAnalyze(ac)
    return this.status()
  }

  /** Copy the plan's new pictures (in the background). */
  copy(): LibraryStatusDto {
    if (this.busy) throw new Error('The librarian is busy')
    const a = this.analysis
    if (!a || this.state !== 'planned') throw new Error('Look through the pictures first')
    if (this.plan && this.plan.freeBytes !== null && this.plan.bytes > this.plan.freeBytes) {
      throw new Error(`Not enough space where the library goes: ${gb(this.plan.bytes)} to copy, ${gb(this.plan.freeBytes)} free`)
    }
    const ac = new AbortController()
    this.job = ac
    this.state = 'copying'
    this.error = null
    this.progress = null
    this.emitStatus()
    void this.runCopy(a, ac)
    return this.status()
  }

  /** Stop the running job (a copy keeps what it copied so far). */
  stop(): void {
    this.job?.abort()
  }

  async model(action: LibraryModelAction): Promise<LibraryStatusDto> {
    if (action === 'cancel') this.modelJob?.abort()
    else if (action === 'remove') {
      if (this.busy) throw new Error('The librarian is using the model: stop it first')
      this.opts.restEyes()
      await this.opts.model.remove()
      await this.refreshModel()
    } else if (!this.modelJob) {
      const ac = new AbortController()
      this.modelJob = ac
      this.modelInfo = { ...this.modelInfo, done: 0, total: null, error: null }
      this.emitStatus()
      void this.opts.model
        .download((p) => {
          this.modelInfo.done = p.done
          this.modelInfo.total = p.total
          this.emitProgress(false)
        }, ac.signal)
        .catch((err: unknown) => {
          this.modelInfo.error = isAbort(err) || ac.signal.aborted ? null : `The download stopped: ${err instanceof Error ? err.message : String(err)}`
        })
        .finally(async () => {
          this.modelJob = null
          await this.refreshModel()
          this.emitStatus()
        })
    }
    this.emitStatus()
    return this.status()
  }

  /** A data URL of a small picture of plan item `id`, or null. */
  async thumb(id: unknown): Promise<string | null> {
    const it = typeof id === 'number' ? this.analysis?.items[id] : undefined
    if (!it) return null
    const png = await this.opts.thumb(it.pic.abs, THUMB_PX).catch(() => null)
    return png ? `data:image/png;base64,${Buffer.from(png).toString('base64')}` : null
  }

  close(): void {
    this.job?.abort()
    this.modelJob?.abort()
  }

  private get busy(): boolean {
    return this.state === 'analyzing' || this.state === 'copying'
  }

  private reset(): void {
    this.analysis = null
    this.plan = null
    this.result = null
    this.error = null
    this.progress = null
    if (!this.busy) this.state = 'idle'
  }

  private onProgress = (p: LibraryProgress): void => {
    const since = this.progress && this.progress.phase === p.phase ? this.progress.since : Date.now()
    this.progress = { ...p, since }
    this.emitProgress(p.total !== null && p.done >= p.total)
  }

  private async runAnalyze(ac: AbortController): Promise<void> {
    // Stop ends the looks in flight at once (the helper is let go of), not after they finish.
    const rest = () => this.opts.restEyes()
    ac.signal.addEventListener('abort', rest, { once: true })
    try {
      const modelReady = (await this.opts.model.state()).ready
      // Loaded for this job only: it can hold hundreds of thousands of pictures.
      const cache = await LookCache.load(this.opts.cacheFile)
      const a = await analyze({
        source: this.source,
        dest: this.dest,
        includeTiny: this.settings.includeTiny ?? false,
        eyes: this.opts.eyes(),
        model: modelReady,
        cache,
        signal: ac.signal,
        onProgress: this.onProgress,
      })
      this.analysis = a
      this.plan = planDto(a, await freeSpace(this.dest))
      this.state = 'planned'
    } catch (err) {
      this.state = 'idle'
      if (!isAbort(err)) this.error = err instanceof Error ? err.message : String(err)
    } finally {
      ac.signal.removeEventListener('abort', rest)
      if (this.job === ac) this.job = null
      this.progress = null
      this.opts.restEyes()
      this.emitStatus()
    }
  }

  private async runCopy(a: Analysis, ac: AbortController): Promise<void> {
    try {
      const r = await copyPlan(a, { signal: ac.signal, onProgress: this.onProgress })
      const name = path.basename(path.resolve(a.dest)) || 'Library'
      this.result = {
        copied: r.copied,
        bytes: r.bytes,
        alreadyThere: r.alreadyThere,
        failed: r.failed.slice(0, 50),
        notes: r.notes,
        stopped: r.stopped,
        warning: r.warning,
        hubPath: r.notes ? this.opts.toVault(path.join(a.dest, `${name}.md`)) : null,
        inVault: this.opts.toVault(a.dest) !== null,
      }
      if (r.failed.length > 50) this.result.failed.push({ rel: `… and ${r.failed.length - 50} more`, error: '' })
      this.state = 'done'
    } catch (err) {
      this.state = 'planned'
      this.error = err instanceof Error ? err.message : String(err)
    } finally {
      if (this.job === ac) this.job = null
      this.progress = null
      this.emitStatus()
    }
  }

  private async refreshModel(): Promise<void> {
    const s = await this.opts.model.state()
    this.modelInfo.ready = s.ready
    this.modelInfo.bytes = s.bytes
  }

  private modelDto(): LibraryModelDto {
    return { label: VISION_MODEL_LABEL, mb: VISION_MODEL_MB, downloading: this.modelJob !== null, ...this.modelInfo }
  }

  private emitStatus(): void {
    this.opts.emit({ kind: 'status', status: this.status() })
  }

  /** Progress, at most every 150 ms (and always at the end of a phase). */
  private emitProgress(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.lastProgress < 150) return
    this.lastProgress = now
    this.opts.emit({ kind: 'progress', progress: this.progress, model: this.modelJob ? this.modelDto() : null })
  }
}

function gb(n: number): string {
  return `${(n / 1e9).toFixed(1)} GB`
}
