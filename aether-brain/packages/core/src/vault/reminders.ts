/**
 * Reminders: the things that float by as asteroids (docs/COSMOLOGY.md, "Asteroids are reminders").
 *
 * Two kinds, nothing written, nothing sent anywhere:
 *   - an open **task with a due date** that is overdue or due within two weeks (what `taskUrgency` already says is worth a glance), and
 *   - a **note tagged `reminder`** (`#reminder` in the text or `tags: [reminder]`): the way to ask for one yourself.
 * The most urgent come first and there are never more than `REMINDER_MAX`, so the sky is never a rock field.
 */
import type { NoteId, ParsedNote } from '../types'
import { tasksOf } from '../markdown/tasks'
import { taskUrgency } from '../markdown/urgency'

/** The tag that turns a note into a reminder. */
export const REMINDER_TAG = 'reminder'
/** The most asteroids there are at once. */
export const REMINDER_MAX = 24
/** A dated task needs at least this much urgency (due within 14 days, or late) to be a reminder. */
export const REMINDER_MIN_URGENCY = 0.22
/** What a note tagged `reminder` is worth when it has no hotter task of its own. */
export const REMINDER_TAGGED_URGENCY = 0.5
/** The longest label an asteroid carries. */
export const REMINDER_TEXT_MAX = 80

export interface Reminder {
  /** Stable across rebuilds: the note, plus the task's line for a task (`note#12`). */
  key: string
  /** The note to open when the asteroid is clicked. */
  note: NoteId
  /** What it says: the task's text, or the note's title. */
  text: string
  /** 0 to 1: how soon it matters. The nearer, bigger, redder and faster the asteroid. */
  urgency: number
  /** The due date (YYYY-MM-DD) of a task, else null. */
  due: string | null
  source: 'task' | 'tag'
}

/** The task's own words: its date markers (`📅 2026-10-01`, `[due:: …]`, `@due(…)`, `due:…`, `⏳ …`) are the asteroid's job, not its label. */
const DATE_MARKS = /(?:[📅⏳🛫]️?\s*\d{4}-\d{2}-\d{2}|\[(?:due|scheduled|start)::?\s*[^\]]*\]|@due\([^)]*\)|\bdue:\d{4}-\d{2}-\d{2})/gu

function clip(text: string): string {
  const t = text.replace(DATE_MARKS, ' ').replace(/\s+/g, ' ').trim()
  return t.length > REMINDER_TEXT_MAX ? `${t.slice(0, REMINDER_TEXT_MAX - 1)}…` : t
}

/** Every reminder on `date` (YYYY-MM-DD), most urgent first, at most `max`. A note that is tagged AND holds a due task gives both. */
export function remindersOf(notes: ReadonlyMap<NoteId, ParsedNote>, date: string, max = REMINDER_MAX): Reminder[] {
  const out: Reminder[] = []
  for (const [id, note] of notes) {
    if (note.meta.area === 'archive') continue
    for (const t of tasksOf(note)) {
      if (t.done || t.due === null) continue
      const u = taskUrgency(t, date, false)
      if (u < REMINDER_MIN_URGENCY) continue
      out.push({ key: `${id}#${t.line}`, note: id, text: clip(t.text) || note.meta.title, urgency: u, due: t.due, source: 'task' })
    }
    if (note.meta.tags.includes(REMINDER_TAG) || note.inlineTags.includes(REMINDER_TAG)) {
      out.push({ key: id, note: id, text: clip(note.meta.title), urgency: REMINDER_TAGGED_URGENCY, due: null, source: 'tag' })
    }
  }
  out.sort((a, b) => b.urgency - a.urgency || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return out.slice(0, Math.max(0, max))
}
