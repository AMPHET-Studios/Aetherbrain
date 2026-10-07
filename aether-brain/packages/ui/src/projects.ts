import { isProjectNote, moveTask, projectFolderOf, taskProgress, tasksOf, type NoteId, type ParsedNote, type TaskItem } from '@aether/core'

/** One card on the Projects board. */
export interface ProjectRow {
  note: ParsedNote
  tasks: TaskItem[]
  open: TaskItem[]
  /** Done tasks, most recently completed first. */
  done: TaskItem[]
  pct: number
  /** Home folder: bound on disk, or named in frontmatter (maybe not created yet); null when none. */
  home: string | null
}

const STATUS_ORDER: Record<string, number> = { active: 0, 'in progress': 0, budding: 1, seedling: 1, paused: 2, someday: 2, done: 3 }

/**
 * The projects of a vault for the board: every note `isProjectNote` accepts
 * (never `meta.type`, which is 'project' for anything under a Projects folder),
 * active ones first, then the most recently updated.
 */
export function listProjects(notes: Map<NoteId, ParsedNote>, folders: Set<string>): ProjectRow[] {
  const out: ProjectRow[] = []
  for (const n of notes.values()) {
    if (!isProjectNote(n)) continue
    // Read-only and cached per note (tasksOf): the board draws again on every change without scanning every project again.
    const tasks = tasksOf(n)
    out.push({
      note: n,
      tasks,
      open: tasks.filter((t) => !t.done),
      done: tasks.filter((t) => t.done).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')),
      pct: taskProgress(tasks).pct,
      home: projectFolderOf(n, folders),
    })
  }
  return out.sort((a, b) => {
    const sa = STATUS_ORDER[(a.note.meta.status ?? '').toLowerCase()] ?? 1
    const sb = STATUS_ORDER[(b.note.meta.status ?? '').toLowerCase()] ?? 1
    if (sa !== sb) return sa - sb
    return (b.note.meta.updated ?? '').localeCompare(a.note.meta.updated ?? '')
  })
}

/**
 * Move the task on `line` up / down the way the board lists tasks: open and
 * done ones apart, so a move passes over the other list's tasks (sub-tasks
 * travel along). Returns the new text and the line the task lands on. The
 * store writes with it and the board predicts the focus with it, so the two
 * always agree.
 */
export function moveTaskOnBoard(raw: string, line: number, dir: -1 | 1): { raw: string; line: number } {
  return moveTask(raw, line, dir, { sameState: true })
}
