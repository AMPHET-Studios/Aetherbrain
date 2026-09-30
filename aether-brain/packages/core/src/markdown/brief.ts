/**
 * The daily brief: today's to-dos gathered from every note into one list, the
 * content of the Today hub. Pure and derived: nothing is written, the tasks
 * stay where they are (ticking one off edits its own note).
 *
 * A task is on today's brief when it is open and
 *   - overdue:   its due date is before today,
 *   - due:       its due date is today,
 *   - scheduled: its scheduled date is today or earlier,
 *   - daily:     it sits in today's daily note (`Daily/2026-09-30.md`),
 *   - flagged:   it carries `#today`,
 * in that order of precedence (a task appears once). "Next up" adds the first
 * open task of every active project that has nothing above, so the brief
 * always says what to pick up next. Notes in Archive never count.
 */
import type { NoteId, ParsedNote } from '../types'
import { basenameOf, folderOf, isDailyName, todayIso } from '../vault/paths'
import { isProjectNote, projectFolderOf } from './projects'
import { tasksOf, type TaskItem } from './tasks'

export type BriefReason = 'overdue' | 'due' | 'scheduled' | 'daily' | 'flagged' | 'next'

export interface BriefTask {
  noteId: NoteId
  notePath: string
  noteTitle: string
  /** 0-based line of the task in the note (as `TaskItem.line`). */
  line: number
  /** Task text as written (dates included): what `toggleTask` / `editTask` match against. */
  text: string
  /** The text without its date markers, for display. */
  label: string
  due: string | null
  scheduled: string | null
  reason: BriefReason
  /** Project the task belongs to: the project note itself, or the project whose home folder holds the note. */
  projectId: NoteId | null
  projectTitle: string | null
  section: string
}

export interface DailyBrief {
  /** The day (YYYY-MM-DD, local time). */
  date: string
  /** Due before today, oldest first. */
  overdue: BriefTask[]
  /** Due or scheduled today, today's daily note, #today. */
  today: BriefTask[]
  /** First open task of each active project with nothing in the sections above. */
  next: BriefTask[]
  /** Notes holding at least one task of the brief, in brief order (the Today hub's beams). */
  noteIds: NoteId[]
  total: number
}

export interface BriefOptions {
  /** Day of the brief, YYYY-MM-DD (default: today, local time). */
  date?: string
  /** Every folder of the vault, so projects bound to a sibling folder are found (see `projectFolderOf`). */
  folders?: Set<string>
  /** Most "next up" projects (default 8). */
  maxNext?: number
  /** Most tasks per section (default 100). */
  maxPerSection?: number
}

/** Project statuses that are not being worked on (lowercase). */
const INACTIVE = new Set([
  'done',
  'complete',
  'completed',
  'paused',
  'on hold',
  'hold',
  'someday',
  'archived',
  'cancelled',
  'canceled',
  'abandoned',
  'dropped',
])

const REASON_ORDER: Record<BriefReason, number> = { overdue: 0, due: 1, scheduled: 2, daily: 3, flagged: 4, next: 5 }

/** True for a project the brief proposes a next task for. */
export function isActiveProject(note: ParsedNote): boolean {
  if (note.meta.area === 'archive' || !isProject(note)) return false
  return !INACTIVE.has((note.meta.status ?? '').trim().toLowerCase())
}

/*
 * Date markers, stripped for display. No leading `\s*` (a long run of
 * whitespace would make the replace quadratic); spaces are collapsed after.
 */
const MARKERS: RegExp[] = [
  /(?:📅|🗓\uFE0F?|⏳)\s{0,2}\d{4}-\d{2}-\d{2}/gu,
  /[[(](?:due|scheduled)::\s{0,2}\d{4}-\d{2}-\d{2}[\])]/giu,
  /(?:due|scheduled)::\s{0,2}\d{4}-\d{2}-\d{2}/giu,
  /@due\(\d{4}-\d{2}-\d{2}\)/giu,
  /(?<![\p{L}\p{N}_])due:\d{4}-\d{2}-\d{2}/giu,
]

/** Task text without its due / scheduled markers (for display). */
export function taskLabel(text: string): string {
  let out = text
  for (const re of MARKERS) out = out.replace(re, ' ')
  const label = out.split(/\s+/).filter(Boolean).join(' ')
  return label || text.trim()
}

/** The reason an open task is on the brief of `date`, or null. */
function reasonOf(t: TaskItem, date: string, dailyNote: boolean): BriefReason | null {
  if (t.done) return null
  if (t.due !== null && t.due < date) return 'overdue'
  if (t.due === date) return 'due'
  if (t.scheduled !== null && t.scheduled <= date) return 'scheduled'
  if (dailyNote && (t.due === null || t.due <= date)) return 'daily'
  if (t.tags.includes('today')) return 'flagged'
  return null
}

/** `isProjectNote` per parsed note object (a note is re-parsed into a new object when its file changes). */
const projectCache = new WeakMap<ParsedNote, boolean>()

function isProject(note: ParsedNote): boolean {
  let p = projectCache.get(note)
  if (p === undefined) {
    p = isProjectNote(note)
    projectCache.set(note, p)
  }
  return p
}

const byId = (a: ParsedNote, b: ParsedNote): number => (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0)

/**
 * Home folder → project note, for every project (first by id wins a folder).
 * A note inside a project's home folder belongs to that project.
 */
function projectHomes(projects: ParsedNote[], folders: Set<string>): Map<string, ParsedNote> {
  const homes = new Map<string, ParsedNote>()
  for (const n of projects) {
    const home = projectFolderOf(n, folders)
    if (home && !homes.has(home)) homes.set(home, n)
  }
  return homes
}

/** The project a note belongs to: itself, or the nearest project home folder above it. */
function projectOf(note: ParsedNote, homes: Map<string, ParsedNote>): ParsedNote | null {
  if (isProject(note)) return note
  for (let f = note.meta.folder; ; f = folderOf(f)) {
    const p = homes.get(f)
    if (p) return p
    if (f === '') return null
  }
}

/** Build the brief of `opts.date` (default today) from every note. */
export function dailyBrief(input: Iterable<ParsedNote>, opts: BriefOptions = {}): DailyBrief {
  const date = opts.date ?? todayIso()
  const maxNext = opts.maxNext ?? 8
  const cap = opts.maxPerSection ?? 100
  // One pass keeps what the brief can use: projects and notes with tasks. Only
  // those get sorted (by id: first project wins a folder, rows keep a stable
  // order); a big vault's task-free notes cost one memoized check each.
  const projects: ParsedNote[] = []
  const withTasks: ParsedNote[] = []
  for (const n of input) {
    if (isProject(n)) projects.push(n)
    if (n.meta.area !== 'archive' && tasksOf(n).length) withTasks.push(n)
  }
  projects.sort(byId)
  withTasks.sort(byId)
  const homes = projectHomes(projects, opts.folders ?? new Set())

  const make = (n: ParsedNote, t: TaskItem, reason: BriefReason, project: ParsedNote | null): BriefTask => ({
    noteId: n.meta.id,
    notePath: n.meta.path,
    noteTitle: n.meta.title,
    line: t.line,
    text: t.text,
    label: taskLabel(t.text),
    due: t.due,
    scheduled: t.scheduled,
    reason,
    projectId: project?.meta.id ?? null,
    projectTitle: project?.meta.title ?? null,
    section: t.section,
  })

  const overdue: BriefTask[] = []
  const today: BriefTask[] = []
  const covered = new Set<NoteId>()
  for (const n of withTasks) {
    const tasks = tasksOf(n)
    const daily = isDailyName(basenameOf(n.meta.path)) && basenameOf(n.meta.path) === date
    let project: ParsedNote | null | undefined
    for (const t of tasks) {
      const reason = reasonOf(t, date, daily)
      if (!reason) continue
      project ??= projectOf(n, homes)
      const item = make(n, t, reason, project)
      if (reason === 'overdue') overdue.push(item)
      else today.push(item)
      if (project) covered.add(project.meta.id)
    }
  }
  overdue.sort((a, b) => (a.due ?? '').localeCompare(b.due ?? '') || byProjectThenNote(a, b))
  today.sort((a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason] || byProjectThenNote(a, b))

  const next: BriefTask[] = []
  const active = projects
    .filter((p) => isActiveProject(p) && !covered.has(p.meta.id))
    .sort((a, b) => (b.meta.updated ?? '').localeCompare(a.meta.updated ?? '') || a.meta.id.localeCompare(b.meta.id))
  for (const p of active) {
    if (next.length >= maxNext) break
    const open = tasksOf(p).filter((t) => !t.done && (t.due === null || t.due <= date) && (t.scheduled === null || t.scheduled <= date))
    if (!open.length) continue
    const top = Math.min(...open.map((t) => t.indent))
    const first = open.find((t) => t.indent === top)
    if (first) next.push(make(p, first, 'next', p))
  }

  const o = overdue.slice(0, cap)
  const t = today.slice(0, cap)
  const noteIds: NoteId[] = []
  const seen = new Set<NoteId>()
  for (const item of [...o, ...t, ...next]) {
    if (seen.has(item.noteId)) continue
    seen.add(item.noteId)
    noteIds.push(item.noteId)
  }
  return { date, overdue: o, today: t, next, noteIds, total: o.length + t.length + next.length }
}

function byProjectThenNote(a: BriefTask, b: BriefTask): number {
  const pa = a.projectTitle ?? '\uffff'
  const pb = b.projectTitle ?? '\uffff'
  return pa.localeCompare(pb) || a.noteTitle.localeCompare(b.noteTitle) || a.line - b.line
}

/** The day after `date` (YYYY-MM-DD), for "practice tomorrow" tasks. */
export function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1))
  return t.toISOString().slice(0, 10)
}
