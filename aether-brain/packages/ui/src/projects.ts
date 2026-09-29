import { extractTasks, isProjectNote, projectFolderOf, taskProgress, type NoteId, type ParsedNote, type TaskItem } from '@aether/core'

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
    const tasks = extractTasks(n.raw)
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
