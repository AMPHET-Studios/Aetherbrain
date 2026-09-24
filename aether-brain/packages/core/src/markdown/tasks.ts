/**
 * Markdown task lists as the app's to-do memory.
 *
 * Tasks are plain `- [ ] text` / `- [x] text` lines, so they stay editable in
 * any markdown tool. Completing a task marks it `[x]` in place and appends a
 * `✅ YYYY-MM-DD` stamp (the Obsidian Tasks convention), which is how the note
 * remembers *when* something got done.
 */
import { joinFrontmatter } from './frontmatter'
import { slugifyTitle, todayIso } from '../vault/paths'

export interface TaskItem {
  /** 0-based line index in the raw file (frontmatter included). */
  line: number
  /** Task text without the checkbox and without the completion stamp. */
  text: string
  done: boolean
  /** Date from a trailing `✅ YYYY-MM-DD` stamp, if any. */
  doneAt: string | null
  /** Nearest preceding heading text ('' if none). */
  section: string
  indent: number
}

const TASK_RE = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/
const STAMP_RE = /\s*✅\s*(\d{4}-\d{2}-\d{2})\s*$/
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE_RE = /^\s*(```|~~~)/

/** Every task line outside fenced code, in file order. */
export function extractTasks(raw: string): TaskItem[] {
  const lines = raw.split('\n')
  const out: TaskItem[] = []
  let section = ''
  let inFence = false
  let inFrontmatter = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (i === 0 && /^---\s*$/.test(line)) {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (/^(---|\.\.\.)\s*$/.test(line)) inFrontmatter = false
      continue
    }
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const h = HEADING_RE.exec(line)
    if (h) {
      section = h[2] ?? ''
      continue
    }
    const m = TASK_RE.exec(line)
    if (!m) continue
    let text = m[4] ?? ''
    let doneAt: string | null = null
    const stamp = STAMP_RE.exec(text)
    if (stamp) {
      doneAt = stamp[1] ?? null
      text = text.slice(0, stamp.index)
    }
    out.push({
      line: i,
      text: text.trim(),
      done: (m[3] ?? ' ') !== ' ',
      doneAt,
      section,
      indent: (m[1] ?? '').length,
    })
  }
  return out
}

export function taskProgress(tasks: TaskItem[]): { done: number; total: number; pct: number } {
  const total = tasks.length
  const done = tasks.filter((t) => t.done).length
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 }
}

/** Mark the task on `line` done/undone, keeping everything else byte-identical. */
export function setTaskDone(raw: string, line: number, done: boolean, today = todayIso()): string {
  const lines = raw.split('\n')
  const cur = lines[line]
  if (cur === undefined) return raw
  const m = TASK_RE.exec(cur)
  if (!m) return raw
  const [, indent = '', bullet = '-', , rest = ''] = m
  const text = rest.replace(STAMP_RE, '')
  lines[line] = done ? `${indent}${bullet} [x] ${text} ✅ ${today}` : `${indent}${bullet} [ ] ${text}`
  return lines.join('\n')
}

/**
 * Append a task under the `## <section>` heading (created at the end of the
 * note if missing). New tasks go after the last task already in the section
 * so lists read in the order they were written.
 */
export function addTask(raw: string, text: string, section = 'To do'): string {
  const clean = text.trim().replace(/^[-*+]\s+\[[ xX]\]\s*/, '')
  if (!clean) return raw
  const lines = raw.split('\n')
  const want = section.trim().toLowerCase()
  let headingIdx = -1
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? ''
    if (FENCE_RE.test(l)) inFence = !inFence
    if (inFence) continue
    const h = HEADING_RE.exec(l)
    if (h && (h[2] ?? '').trim().toLowerCase() === want) {
      headingIdx = i
      break
    }
  }
  const taskLine = `- [ ] ${clean}`
  if (headingIdx < 0) {
    const body = raw.replace(/\s+$/, '')
    return `${body}\n\n## ${section.trim()}\n\n${taskLine}\n`
  }
  // Section ends at the next heading (or EOF).
  let end = lines.length
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i] ?? '')) {
      end = i
      break
    }
  }
  let insertAt = headingIdx + 1
  for (let i = headingIdx + 1; i < end; i++) {
    if (TASK_RE.test(lines[i] ?? '')) insertAt = i + 1
  }
  if (insertAt === headingIdx + 1) {
    // No tasks yet: keep one blank line after the heading.
    if ((lines[insertAt] ?? '').trim() === '') insertAt += 1
    lines.splice(insertAt, 0, taskLine)
    if ((lines[insertAt + 1] ?? '').trim() !== '' && insertAt + 1 < lines.length) lines.splice(insertAt + 1, 0, '')
    return lines.join('\n')
  }
  lines.splice(insertAt, 0, taskLine)
  return lines.join('\n')
}

export interface ProjectInput {
  name: string
  summary?: string
  tags?: string[]
  tasks?: string[]
}

/** A new project note with a to-do section ready for the Projects board. */
export function projectNote(input: ProjectInput, now = new Date()): { path: string; content: string; title: string } {
  const title = input.name.trim()
  const date = todayIso(now)
  const tasks = (input.tasks?.length ? input.tasks : ['Define what done looks like']).map((t) => `- [ ] ${t}`).join('\n')
  const content = joinFrontmatter(
    { title, type: 'project', tags: input.tags ?? [], created: date, updated: date, status: 'active' },
    `# ${title}\n\n> ${input.summary?.trim() || 'One line on what this project is and what done looks like.'}\n\n## To do\n\n${tasks}\n\n## Notes\n\n`,
  )
  return { path: `Projects/${slugifyTitle(title)}.md`, content, title }
}
