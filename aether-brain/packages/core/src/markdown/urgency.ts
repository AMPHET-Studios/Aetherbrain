/**
 * Urgency: how soon a note needs you, from 0 (nothing asks for it) to 1 (it is overdue). Derived from the open
 * tasks a note holds and nothing else; nothing is written.
 *
 * The system layout draws it twice: a body's **orbit speed** is its own urgency, and a **star's brightness** is
 * the urgency of its whole system (`systemUrgency`: the hottest thing in it, a little more for each other thing
 * that is hot too). So a glance at the sky says what is on fire and where.
 *
 * What an open task is worth (the largest one a note holds is the note's urgency):
 *
 *   overdue                          0.90, +0.025 for each day late, at most 1
 *   due today                        0.85
 *   due tomorrow                     0.70
 *   due in 2 to 3 days               0.55
 *   due in 4 to 7 days               0.38
 *   due in 8 to 14 days              0.22
 *   due later                        0.10
 *   scheduled for today or earlier   0.60
 *   flagged #today                   0.70
 *   in today's daily note            0.60
 *   open, no date at all             0.06   (it is on the pile, it is not on fire)
 */
import type { ParsedNote } from '../types'
import { basenameOf, isDailyName } from '../vault/paths'
import { tasksOf, type TaskItem } from './tasks'

/** Whole days from `from` to `to` (both YYYY-MM-DD): positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

/** Urgency of one task on `date`; `daily` is true when it sits in that day's daily note. */
export function taskUrgency(t: TaskItem, date: string, daily: boolean): number {
  if (t.done) return 0
  let u = 0
  if (t.due !== null) {
    const d = daysBetween(date, t.due)
    if (d < 0) u = Math.min(1, 0.9 + 0.025 * Math.min(4, -d))
    else if (d === 0) u = 0.85
    else if (d === 1) u = 0.7
    else if (d <= 3) u = 0.55
    else if (d <= 7) u = 0.38
    else if (d <= 14) u = 0.22
    else u = 0.1
  }
  if (t.scheduled !== null && t.scheduled <= date) u = Math.max(u, 0.6)
  if (t.tags.includes('today')) u = Math.max(u, 0.7)
  if (daily && (t.due === null || t.due <= date)) u = Math.max(u, 0.6)
  if (u === 0) u = 0.06
  return u
}

/** Urgency of a note on `date`: its most urgent open task, a little more when several others are hot too. */
export function noteUrgency(note: ParsedNote, date: string): number {
  if (note.meta.area === 'archive') return 0
  const tasks = tasksOf(note)
  if (!tasks.length) return 0
  const base = basenameOf(note.meta.path)
  const daily = isDailyName(base) && base === date
  const hot: number[] = []
  let max = 0
  for (const t of tasks) {
    const u = taskUrgency(t, date, daily)
    if (u > max) max = u
    if (u >= HOT) hot.push(u)
  }
  return max === 0 ? 0 : Math.min(1, max + Math.min(0.1, 0.02 * Math.max(0, hot.length - 1)))
}

/** Below this an item adds nothing to the pile of its system (an undated task is on the pile, not in the fire). */
const HOT = 0.15

/**
 * Urgency of a system (a folder and everything under it) from the urgencies of what is directly in it: the hottest
 * one, plus up to 30% of what is left for the heat of the others. Saturates, so a folder of three hundred calm
 * undated tasks does not outshine one overdue.
 */
export function systemUrgency(children: ArrayLike<number>): number {
  let max = 0
  let sum = 0
  for (let i = 0; i < children.length; i++) {
    const u = children[i]!
    if (u > max) max = u
    if (u >= HOT) sum += u
  }
  if (max <= 0) return 0
  const rest = Math.max(0, sum - max)
  return Math.min(1, max + (1 - max) * 0.3 * (1 - Math.exp(-rest / 4)))
}
