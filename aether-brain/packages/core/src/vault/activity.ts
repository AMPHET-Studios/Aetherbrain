/**
 * How much you use each note and each folder: what a star's brightness is (docs/COSMOLOGY.md, "A star's brightness is how much you use it").
 *
 * Opening a note and saving it are the interactions. Each leaves a little heat on that note that fades with time (it halves every
 * `ACTIVITY_HALF_LIFE_DAYS`), so a folder you have been working in glows and one you have left alone goes quiet again over a few weeks.
 * A folder's brightness is its whole system's, the way a folder's urgency is: the hottest thing in it plus a share of the rest.
 *
 * It is a record of YOUR use, so it stays on this computer, beside the app's other view settings: never in the vault, never sent anywhere,
 * and the palette can forget all of it. Pure (the clock is handed in), bounded, and tolerant of whatever is found in storage.
 */
import type { GraphData, NoteId } from '../types'
import { systemUrgency } from '../markdown/urgency'

/** A note's heat halves every this many days: after a month it is about a fifth, after two about a twentieth. */
export const ACTIVITY_HALF_LIFE_DAYS = 14
export const ACTIVITY_HALF_LIFE_MS = ACTIVITY_HALF_LIFE_DAYS * 24 * 3600 * 1000
/** What an interaction adds to a note's score: opening it, and saving a change to it. */
export const ACTIVITY_OPEN = 1
export const ACTIVITY_SAVE = 2
/** The same kind of interaction with the same note within this long counts once (a note re-opened by a click storm, an autosave). */
export const ACTIVITY_REPEAT_MS = 20_000
/** Most notes the log keeps; past it the coolest are forgotten first. */
export const ACTIVITY_MAX_NOTES = 4000
/** The score at which a note is half as hot as it can get (heat = score / (score + K)): about two saves. */
export const ACTIVITY_HEAT_K = 4
/** A score below this is no heat at all and is not kept. */
const ACTIVITY_FLOOR = 0.02
/** No score is believed past this (a corrupt number cannot make a note burn forever). */
const ACTIVITY_CEILING = 1000

export type ActivityKind = 'open' | 'save'

/** What is stored: a score per note and when it was last set (ms since the epoch). */
export interface ActivityData {
  v: 1
  e: Record<string, [number, number]>
}

const decay = (ms: number): number => (ms > 0 ? Math.pow(0.5, ms / ACTIVITY_HALF_LIFE_MS) : 1)

export class ActivityLog {
  /** Score at time `t`, per note id. */
  private readonly entries = new Map<NoteId, { s: number; t: number }>()
  /** When each kind of interaction with each note last counted (memory only: it only guards against repeats). */
  private readonly recent = new Map<string, number>()

  get size(): number {
    return this.entries.size
  }

  /** Count an interaction with a note at `now`. Returns whether it counted (a repeat within `ACTIVITY_REPEAT_MS` does not). */
  record(id: NoteId, kind: ActivityKind, now: number): boolean {
    if (!id || !Number.isFinite(now)) return false
    const key = `${kind}\u0000${id}`
    const last = this.recent.get(key)
    if (last !== undefined && now >= last && now - last < ACTIVITY_REPEAT_MS) return false
    this.recent.set(key, now)
    if (this.recent.size > 600) this.forgetRecent(now)
    const prev = this.entries.get(id)
    const kept = prev ? prev.s * decay(now - prev.t) : 0
    const s = Math.min(ACTIVITY_CEILING, kept + (kind === 'save' ? ACTIVITY_SAVE : ACTIVITY_OPEN))
    // A clock that went back keeps the later time, so an old record is never made to look newer than it is.
    this.entries.set(id, { s, t: prev ? Math.max(prev.t, now) : now })
    if (this.entries.size > ACTIVITY_MAX_NOTES) this.trim(now)
    return true
  }

  /** The note's score at `now`: what it has gathered, faded. 0 for a note never touched. */
  scoreOf(id: NoteId, now: number): number {
    const e = this.entries.get(id)
    return e ? e.s * decay(now - e.t) : 0
  }

  /** The note's heat from 0 (untouched) towards 1 (used a lot lately): never 1 exactly. */
  heatOf(id: NoteId, now: number): number {
    const s = this.scoreOf(id, now)
    return s > 0 ? s / (s + ACTIVITY_HEAT_K) : 0
  }

  /** Forget everything. */
  clear(): void {
    this.entries.clear()
    this.recent.clear()
  }

  toJSON(): ActivityData {
    const e: Record<string, [number, number]> = {}
    for (const [id, v] of this.entries) e[id] = [Math.round(v.s * 1000) / 1000, Math.round(v.t)]
    return { v: 1, e }
  }

  /** The log saved in `raw` (anything: garbage gives an empty log). Entries that are not numbers, are negative or have faded away are left out. */
  static from(raw: unknown, now: number): ActivityLog {
    const log = new ActivityLog()
    if (!raw || typeof raw !== 'object') return log
    const data = raw as { v?: unknown; e?: unknown }
    if (data.v !== 1 || !data.e || typeof data.e !== 'object' || Array.isArray(data.e)) return log
    for (const [id, entry] of Object.entries(data.e as Record<string, unknown>)) {
      if (!Array.isArray(entry) || entry.length < 2) continue
      const s = Number(entry[0])
      const t = Number(entry[1])
      if (!Number.isFinite(s) || !Number.isFinite(t) || s <= 0) continue
      // A time in the future (a clock set wrong once) is read as now.
      const at = Math.min(t, now)
      const score = Math.min(ACTIVITY_CEILING, s)
      if (score * decay(now - at) < ACTIVITY_FLOOR) continue
      log.entries.set(id, { s: score, t: at })
    }
    if (log.entries.size > ACTIVITY_MAX_NOTES) log.trim(now)
    return log
  }

  /** Forget the coolest notes until the log is a tenth under its cap (so it is not trimmed again at the very next interaction). */
  private trim(now: number): void {
    const keep = Math.floor(ACTIVITY_MAX_NOTES * 0.9)
    const ranked = [...this.entries].map(([id, v]) => [id, v.s * decay(now - v.t)] as const).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    for (let i = keep; i < ranked.length; i++) this.entries.delete(ranked[i]![0])
  }

  private forgetRecent(now: number): void {
    for (const [k, t] of this.recent) if (!(now >= t && now - t < ACTIVITY_REPEAT_MS)) this.recent.delete(k)
  }
}

/**
 * The brightness of every node of `graph`, 0 to 1, in node order. A note's is its own heat; a folder's is that of its whole system: the
 * hottest note or sub-folder in it, plus a share of the others (`systemUrgency`: it saturates on purpose, so three hundred notes you
 * touched once each are not a blaze). Pictures, ghosts and the Today hub have none: only notes are used.
 */
export function computeActivity(graph: GraphData, log: ActivityLog, now: number): Float32Array {
  const nodes = graph.nodes
  const out = new Float32Array(nodes.length)
  const kids = new Map<number, number[]>()
  const folders: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    if (n.kind === 'note') out[i] = log.heatOf(n.id, now)
    if (n.folder) folders.push(i)
    if (n.parent === null) continue
    const p = graph.index.get(n.parent)
    if (p === undefined) continue
    const list = kids.get(p)
    if (list) list.push(i)
    else kids.set(p, [i])
  }
  // The deepest folders first, so a folder is read after everything in it.
  folders.sort((a, z) => nodes[z]!.folder!.depth - nodes[a]!.folder!.depth)
  for (const f of folders) {
    const list = kids.get(f)
    if (!list) continue
    const values = new Float64Array(list.length)
    for (let k = 0; k < list.length; k++) values[k] = out[list[k]!]!
    out[f] = systemUrgency(values)
  }
  return out
}
