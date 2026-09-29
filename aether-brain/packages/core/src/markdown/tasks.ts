/**
 * Markdown task lists as the app's to-do memory.
 *
 * Tasks are plain `- [ ] text` / `- [x] text` lines, so they stay editable in
 * any markdown tool. Completing a task marks it `[x]` in place and appends a
 * `✅ YYYY-MM-DD` stamp (the Obsidian Tasks convention), which is how the note
 * remembers *when* something got done.
 *
 * Every edit works on lines split at `\n` and rejoined the same way, so lines
 * that are not touched stay byte-identical (CRLF files keep their `\r`).
 */
import { joinFrontmatter } from './frontmatter'
import { normalizeFolderPath, slugifyTitle, todayIso } from '../vault/paths'

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
/** ATX heading; a closing `#` run only counts after whitespace (`## Learn C#` keeps its `#`). */
const HEADING_RE = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const FENCE_RE = /^\s*(```|~~~)/

/** A line without its trailing `\r`, plus the `\r` to put back. */
function splitCr(line: string): { text: string; cr: string } {
  return line.endsWith('\r') ? { text: line.slice(0, -1), cr: '\r' } : { text: line, cr: '' }
}

/** Tasks (outside frontmatter and fenced code) and heading line indices. */
function scan(lines: string[]): { tasks: TaskItem[]; headings: number[] } {
  const tasks: TaskItem[] = []
  const headings: number[] = []
  let section = ''
  let inFence = false
  let inFrontmatter = false
  for (let i = 0; i < lines.length; i++) {
    const line = splitCr(lines[i] ?? '').text
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
      headings.push(i)
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
    tasks.push({
      line: i,
      text: text.trim(),
      done: (m[3] ?? ' ') !== ' ',
      doneAt,
      section,
      indent: (m[1] ?? '').length,
    })
  }
  return { tasks, headings }
}

/** Every task line outside fenced code, in file order. */
export function extractTasks(raw: string): TaskItem[] {
  return scan(raw.split('\n')).tasks
}

export function taskProgress(tasks: TaskItem[]): { done: number; total: number; pct: number } {
  const total = tasks.length
  const done = tasks.filter((t) => t.done).length
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 }
}

/** The parts of the task on `line`, or null when that line is not a real task (e.g. inside code). */
function taskAt(lines: string[], line: number): { indent: string; bullet: string; mark: string; rest: string; cr: string } | null {
  const cur = lines[line]
  if (cur === undefined) return null
  if (!scan(lines).tasks.some((t) => t.line === line)) return null
  const { text, cr } = splitCr(cur)
  const m = TASK_RE.exec(text)
  if (!m) return null
  const [, indent = '', bullet = '-', mark = ' ', rest = ''] = m
  return { indent, bullet, mark, rest, cr }
}

/** Task text from user input: one line, no checkbox prefix, no completion stamp. */
function cleanTaskText(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .replace(/^[-*+]\s+\[[ xX]\]\s*/, '')
    .replace(STAMP_RE, '')
    .trim()
}

/** Mark the task on `line` done/undone, keeping everything else byte-identical. */
export function setTaskDone(raw: string, line: number, done: boolean, today = todayIso()): string {
  const lines = raw.split('\n')
  const t = taskAt(lines, line)
  if (!t) return raw
  const text = t.rest.replace(STAMP_RE, '')
  lines[line] = (done ? `${t.indent}${t.bullet} [x] ${text} ✅ ${today}` : `${t.indent}${t.bullet} [ ] ${text}`) + t.cr
  return lines.join('\n')
}

/**
 * Replace the text of the task on `line`. Keeps its indent, bullet, checkbox
 * and `✅` stamp; an empty text or a line that is not a task leaves `raw` as is.
 */
export function editTask(raw: string, line: number, text: string): string {
  const lines = raw.split('\n')
  const t = taskAt(lines, line)
  const clean = cleanTaskText(text)
  if (!t || !clean) return raw
  const stamp = STAMP_RE.exec(t.rest)
  lines[line] = `${t.indent}${t.bullet} [${t.mark}] ${clean}${stamp ? ` ✅ ${stamp[1] ?? ''}` : ''}${t.cr}`
  return lines.join('\n')
}

/** Remove the task on `line` (that line only; nested lines below it stay). */
export function deleteTask(raw: string, line: number): string {
  const lines = raw.split('\n')
  if (!taskAt(lines, line)) return raw
  lines.splice(line, 1)
  // The last line went: the one before it now ends the file, so its `\r` goes with the `\n`.
  if (line === lines.length && line > 0) lines[line - 1] = splitCr(lines[line - 1] ?? '').text
  return lines.join('\n')
}

/**
 * End (exclusive) of a task's block: the task line plus the deeper-indented
 * lines under it (sub-tasks, continuation lines), across blank lines only when
 * deeper content follows them.
 */
function blockEnd(lines: string[], task: TaskItem): number {
  let end = task.line + 1
  for (let i = task.line + 1; i < lines.length; i++) {
    const text = splitCr(lines[i] ?? '').text
    if (text.trim() === '') continue
    const indent = /^\s*/.exec(text)?.[0].length ?? 0
    if (indent <= task.indent) break
    end = i + 1
  }
  return end
}

/**
 * Move the task on `line` up (-1) or down (1): it swaps places with the
 * previous / next task of the same section and indent. Non-task lines and
 * deeper sub-tasks in between are skipped; a heading or a shallower (parent)
 * task is an edge, where the move is a no-op. Sub-tasks travel with their
 * parent. Returns the new raw text and the task's new line index.
 *
 * `sameState` also skips tasks whose done state differs, for lists that show
 * open and done tasks apart (the Projects board): moving an open task up
 * passes it over the next open task above it, not a hidden done one.
 */
export function moveTask(raw: string, line: number, dir: -1 | 1, opts: { sameState?: boolean } = {}): { raw: string; line: number } {
  const lines = raw.split('\n')
  const { tasks, headings } = scan(lines)
  const k = tasks.findIndex((t) => t.line === line)
  const task = tasks[k]
  if (!task) return { raw, line }
  let other: TaskItem | undefined
  for (let j = k + dir; j >= 0 && j < tasks.length; j += dir) {
    const c = tasks[j]
    if (!c) break
    const lo = Math.min(c.line, task.line)
    const hi = Math.max(c.line, task.line)
    if (headings.some((h) => h > lo && h < hi) || c.indent < task.indent) break
    if (c.indent === task.indent && (!opts.sameState || c.done === task.done)) {
      other = c
      break
    }
  }
  if (!other) return { raw, line }
  const [first, second] = dir < 0 ? [other, task] : [task, other]
  const a0 = first.line
  const a1 = blockEnd(lines, first)
  const b0 = second.line
  const b1 = blockEnd(lines, second)
  const out = [...lines.slice(0, a0), ...lines.slice(b0, b1), ...lines.slice(a1, b0), ...lines.slice(a0, a1), ...lines.slice(b1)]
  // A CRLF file whose last line moved up would otherwise gain a bare `\n` line.
  if (raw.includes('\r\n')) {
    const lastCr = splitCr(lines[lines.length - 1] ?? '').cr
    for (let i = 0; i < out.length; i++) out[i] = splitCr(out[i] ?? '').text + (i < out.length - 1 ? '\r' : lastCr)
  }
  return { raw: out.join('\n'), line: dir < 0 ? a0 : a0 + (b1 - b0) + (b0 - a1) }
}

/**
 * Append a task under the `## <section>` heading (created at the end of the
 * note if missing). A new task goes right after the last open top-level task
 * of the section (with its sub-tasks), so open tasks stay together, in the
 * order they were written, above the ones already ticked off. With no open
 * task it goes after the last task of the section.
 */
export function addTask(raw: string, text: string, section = 'To do'): string {
  const clean = text.trim().replace(/^[-*+]\s+\[[ xX]\]\s*/, '')
  if (!clean) return raw
  const lines = raw.split('\n')
  const cr = raw.includes('\r\n') ? '\r' : ''
  const want = section.trim().toLowerCase()
  const plain = lines.map((l) => splitCr(l).text)
  let headingIdx = -1
  let inFence = false
  for (let i = 0; i < plain.length; i++) {
    const l = plain[i] ?? ''
    if (FENCE_RE.test(l)) inFence = !inFence
    if (inFence) continue
    const h = HEADING_RE.exec(l)
    if (h && (h[2] ?? '').trim().toLowerCase() === want) {
      headingIdx = i
      break
    }
  }
  if (headingIdx < 0) {
    const eol = `${cr}\n`
    const body = raw.replace(/\s+$/, '')
    return `${body}${eol}${eol}## ${section.trim()}${eol}${eol}- [ ] ${clean}${eol}`
  }
  // Section ends at the next heading (or EOF).
  let end = plain.length
  for (let i = headingIdx + 1; i < plain.length; i++) {
    if (HEADING_RE.test(plain[i] ?? '')) {
      end = i
      break
    }
  }
  let insertAt = headingIdx + 1
  for (let i = headingIdx + 1; i < end; i++) {
    if (TASK_RE.test(plain[i] ?? '')) insertAt = i + 1
  }
  const inSection = scan(lines).tasks.filter((t) => t.line > headingIdx && t.line < end)
  const top = Math.min(...inSection.map((t) => t.indent))
  const lastOpen = inSection.filter((t) => t.indent === top && !t.done).pop()
  if (lastOpen) insertAt = blockEnd(lines, lastOpen)
  const taskLine = `- [ ] ${clean}`
  if (insertAt === headingIdx + 1) {
    // No tasks yet: keep one blank line after the heading.
    if ((plain[insertAt] ?? '').trim() === '') insertAt += 1
    insertLine(lines, insertAt, taskLine, cr)
    if ((lines[insertAt + 1] ?? '').trim() !== '' && insertAt + 1 < lines.length) lines.splice(insertAt + 1, 0, cr)
    return lines.join('\n')
  }
  insertLine(lines, insertAt, taskLine, cr)
  return lines.join('\n')
}

/** Insert a line; appended after a last line without a newline, that line gets the ending instead. */
function insertLine(lines: string[], at: number, text: string, cr: string): void {
  if (at < lines.length) {
    lines.splice(at, 0, text + cr)
    return
  }
  const last = lines.length - 1
  if (last >= 0 && !(lines[last] ?? '').endsWith('\r')) lines[last] = (lines[last] ?? '') + cr
  lines.push(text)
}

export interface ProjectInput {
  name: string
  summary?: string
  tags?: string[]
  tasks?: string[]
  /** Folder the note is created in (default 'Projects'; '' = the vault root). */
  dir?: string
  /** Home folder of the project (vault path), written to frontmatter `folder:`. */
  folder?: string
}

/** A new project note with a to-do section ready for the Projects board. */
export function projectNote(input: ProjectInput, now = new Date()): { path: string; content: string; title: string } {
  const title = input.name.trim()
  const date = todayIso(now)
  const tasks = (input.tasks?.length ? input.tasks : ['Define what done looks like']).map((t) => `- [ ] ${t}`).join('\n')
  const fm: Record<string, unknown> = { title, type: 'project', tags: input.tags ?? [], created: date, updated: date, status: 'active' }
  const folder = input.folder !== undefined ? normalizeFolderPath(input.folder) : ''
  if (folder) fm['folder'] = folder
  const content = joinFrontmatter(
    fm,
    `# ${title}\n\n> ${input.summary?.trim() || 'One line on what this project is and what done looks like.'}\n\n## To do\n\n${tasks}\n\n## Notes\n\n`,
  )
  const dir = normalizeFolderPath(input.dir ?? 'Projects')
  return { path: `${dir ? `${dir}/` : ''}${slugifyTitle(title)}.md`, content, title }
}
