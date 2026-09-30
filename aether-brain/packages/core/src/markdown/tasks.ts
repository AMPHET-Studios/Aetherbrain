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
import type { ParsedNote } from '../types'
import { joinFrontmatter } from './frontmatter'
import { extractInlineTags } from './parse'
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
  /**
   * Due date written in the task (YYYY-MM-DD), or null: `📅 2026-10-01`
   * (Obsidian Tasks), `[due:: 2026-10-01]` (Dataview), `@due(2026-10-01)`
   * (TaskPaper) or `due:2026-10-01` (todo.txt). The first one wins.
   */
  due: string | null
  /** Scheduled date (`⏳ 2026-10-01` or `[scheduled:: 2026-10-01]`), or null. */
  scheduled: string | null
  /** Inline #tags in the task text, lowercased, without `#`. */
  tags: string[]
}

const FENCE_RE = /^\s*(```|~~~)/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** Characters `.` does not match in a regex: heading and task text never contain them. */
const LINE_BREAK_RE = /[\r\n\u2028\u2029]/

/*
 * Headings, task lines and completion stamps are parsed by hand, in one pass
 * over the line. The equivalent regexes (`/^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/`,
 * `/\s*✅\s*(\d{4}-\d{2}-\d{2})\s*$/`, `/\s+$/` …) backtrack quadratically
 * on a long run of whitespace, and note text can come from an AI client: one
 * crafted line must not freeze the app for minutes.
 */

/** One whitespace character, as `\s` and `String.prototype.trim` define it. */
function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && ch.trim() === ''
}

/** Index of the first non-whitespace character at or after `from` (the length when there is none). */
function skipSpace(text: string, from: number): number {
  let i = from
  while (i < text.length && isSpace(text[i])) i++
  return i
}

/**
 * An ATX heading (`## Section`): its level and text, or null. The text is
 * trimmed, and a closing `#` run only counts after whitespace (`## Learn C#`
 * keeps its `#`, `## Later ##` reads `Later`). Needs whitespace after the
 * opening hashes, like before (`#tag` is not a heading). Linear time.
 */
export function atxHeading(line: string): { level: number; text: string } | null {
  let level = 0
  while (line[level] === '#') level++
  if (level === 0 || level > 6 || !isSpace(line[level])) return null
  let text = line.slice(level).trim()
  let end = text.length
  while (end > 0 && text[end - 1] === '#') end--
  if (end < text.length && end > 0 && isSpace(text[end - 1])) text = text.slice(0, end).trimEnd()
  // Like the regex's `.`: the heading text never spans a line break (`\r`, U+2028 …).
  return LINE_BREAK_RE.test(text) ? null : { level, text }
}

/** The parts of a task line (`  - [x] text`), or null when the line is not one. Linear time. */
function taskParts(line: string): { indent: string; bullet: string; mark: string; rest: string } | null {
  const b = skipSpace(line, 0)
  const bullet = line[b]
  if (bullet !== '-' && bullet !== '*' && bullet !== '+') return null
  const open = skipSpace(line, b + 1)
  if (open === b + 1 || line[open] !== '[') return null
  const mark = line[open + 1]
  if ((mark !== ' ' && mark !== 'x' && mark !== 'X') || line[open + 2] !== ']') return null
  const start = skipSpace(line, open + 3)
  if (start === open + 3) return null
  const rest = line.slice(start)
  // The text runs to the end of the line and never spans a line break (`\r`, U+2028 …).
  if (LINE_BREAK_RE.test(rest)) return null
  return { indent: line.slice(0, b), bullet, mark, rest }
}

/**
 * A trailing `✅ YYYY-MM-DD` completion stamp: where it starts (whitespace
 * before the ✅ included) and its date, or null. Linear time.
 */
function stampOf(text: string): { index: number; date: string } | null {
  const t = text.trimEnd()
  const date = t.slice(-10)
  if (!DATE_RE.test(date)) return null
  let i = t.length - 10
  while (i > 0 && isSpace(t[i - 1])) i--
  if (t[i - 1] !== '✅') return null
  i--
  while (i > 0 && isSpace(t[i - 1])) i--
  return { index: i, date }
}

/** `text` without its trailing completion stamp. */
function withoutStamp(text: string): string {
  const stamp = stampOf(text)
  return stamp ? text.slice(0, stamp.index) : text
}

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
    let line = splitCr(lines[i] ?? '').text
    // A byte-order mark in front of the opening `---` is still frontmatter.
    if (i === 0 && line.startsWith('\uFEFF')) line = line.slice(1)
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
    const h = atxHeading(line)
    if (h) {
      section = h.text
      headings.push(i)
      continue
    }
    const m = taskParts(line)
    if (!m) continue
    const stamp = stampOf(m.rest)
    const text = (stamp ? m.rest.slice(0, stamp.index) : m.rest).trim()
    const dates = taskDates(text)
    tasks.push({
      line: i,
      text,
      done: m.mark !== ' ',
      doneAt: stamp?.date ?? null,
      section,
      indent: m.indent.length,
      due: dates.due,
      scheduled: dates.scheduled,
      tags: text.includes('#') ? extractInlineTags(text) : [],
    })
  }
  return { tasks, headings }
}

/** Every task line outside fenced code, in file order. */
export function extractTasks(raw: string): TaskItem[] {
  return scan(raw.split('\n')).tasks
}

/** Tasks per parsed note object: a note is re-parsed into a new object when its file changes. */
const taskCache = new WeakMap<ParsedNote, TaskItem[]>()

/**
 * `extractTasks(note.raw)`, remembered per parsed note (the same object always
 * has the same text), so the daily brief can look at every note on every graph
 * rebuild. Notes without an open or done checkbox are skipped without a scan.
 * Treat the result as read-only.
 */
export function tasksOf(note: ParsedNote): TaskItem[] {
  let tasks = taskCache.get(note)
  if (!tasks) {
    const raw = note.raw
    tasks = raw.includes('[ ]') || raw.includes('[x]') || raw.includes('[X]') ? extractTasks(raw) : []
    taskCache.set(note, tasks)
  }
  return tasks
}

/** Real calendar date in YYYY-MM-DD form. */
function isRealDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false
  const y = Number(d.slice(0, 4))
  const m = Number(d.slice(5, 7))
  const day = Number(d.slice(8, 10))
  if (m < 1 || m > 12 || day < 1) return false
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return day <= last
}

/** The date right at `i` (after up to two spaces), or null. The next character must not be a digit. */
function dateAt(text: string, i: number): string | null {
  let j = i
  if (text[j] === '\uFE0F') j++
  for (let k = 0; k < 2 && text[j] === ' '; k++) j++
  const d = text.slice(j, j + 10)
  const after = text[j + 10]
  if (after !== undefined && after >= '0' && after <= '9') return null
  return isRealDate(d) ? d : null
}

/** First date after any of `markers` (emoji), or null. Linear: one indexOf pass per marker. */
function dateAfterMarker(text: string, markers: string[]): string | null {
  let best: { at: number; date: string } | null = null
  for (const mk of markers) {
    for (let at = text.indexOf(mk); at >= 0; at = text.indexOf(mk, at + mk.length)) {
      const d = dateAt(text, at + mk.length)
      if (d) {
        if (!best || at < best.at) best = { at, date: d }
        break
      }
    }
  }
  return best?.date ?? null
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)
}

/**
 * First date written as `<word>:: date`, `<word>::date`, `@<word>(date)` or
 * `<word>:date` (todo.txt, only for `due`), where `<word>` stands alone.
 */
function dateAfterWord(text: string, word: string, todoTxt: boolean): string | null {
  const lower = text.toLowerCase()
  for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) {
    if (isWordChar(text[at - 1])) continue
    let j = at + word.length
    if (text.startsWith('::', j)) j += 2
    else if (text[j] === '(' && text[at - 1] === '@') j += 1
    else if (todoTxt && text[j] === ':') j += 1
    else continue
    const d = dateAt(text, j)
    if (d) return d
  }
  return null
}

/**
 * Due and scheduled dates written in a task's text (see TaskItem.due). Linear
 * time: task text can come from an AI client.
 */
export function taskDates(text: string): { due: string | null; scheduled: string | null } {
  const due = dateAfterMarker(text, ['📅', '🗓']) ?? dateAfterWord(text, 'due', true)
  const scheduled = dateAfterMarker(text, ['⏳']) ?? dateAfterWord(text, 'scheduled', false)
  return { due, scheduled }
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
  const m = taskParts(line === 0 && text.startsWith('\uFEFF') ? text.slice(1) : text)
  if (!m) return null
  // A task on the first line keeps the byte-order mark in front of it.
  const indent = (line === 0 && text.startsWith('\uFEFF') ? '\uFEFF' : '') + m.indent
  return { indent, bullet: m.bullet, mark: m.mark, rest: m.rest, cr }
}

/** Task text from user input: one line, no checkbox prefix, no completion stamp. */
function cleanTaskText(text: string): string {
  const line = text
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .trim()
    .replace(/^[-*+]\s+\[[ xX]\]\s*/, '')
  return withoutStamp(line).trim()
}

/** Mark the task on `line` done/undone, keeping everything else byte-identical. */
export function setTaskDone(raw: string, line: number, done: boolean, today = todayIso()): string {
  const lines = raw.split('\n')
  const t = taskAt(lines, line)
  if (!t) return raw
  const text = withoutStamp(t.rest)
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
  const stamp = stampOf(t.rest)
  lines[line] = `${t.indent}${t.bullet} [${t.mark}] ${clean}${stamp ? ` ✅ ${stamp.date}` : ''}${t.cr}`
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
 * task it goes after the last task of the section (and its sub-tasks); with
 * no task at all, right under the heading. Headings and tasks inside fenced
 * code or frontmatter don't count, so a new task never lands in a code block.
 * The text becomes one line (line breaks collapse to spaces).
 */
export function addTask(raw: string, text: string, section = 'To do'): string {
  const clean = cleanTaskText(text)
  if (!clean) return raw
  const lines = raw.split('\n')
  const cr = raw.includes('\r\n') ? '\r' : ''
  const want = section.trim().toLowerCase()
  const plain = lines.map((l, i) => {
    const text = splitCr(l).text
    return i === 0 && text.startsWith('\uFEFF') ? text.slice(1) : text
  })
  // Real headings and tasks only: scan skips frontmatter and fenced code.
  const { tasks, headings } = scan(lines)
  const k = headings.findIndex((i) => atxHeading(plain[i] ?? '')?.text.toLowerCase() === want)
  const headingIdx = k < 0 ? -1 : (headings[k] ?? -1)
  if (headingIdx < 0) {
    const eol = `${cr}\n`
    const body = raw.trimEnd()
    return `${body}${eol}${eol}## ${section.trim()}${eol}${eol}- [ ] ${clean}${eol}`
  }
  // The section ends at the next heading (or EOF).
  const end = headings[k + 1] ?? plain.length
  const inSection = tasks.filter((t) => t.line > headingIdx && t.line < end)
  const top = Math.min(...inSection.map((t) => t.indent))
  const lastOpen = inSection.filter((t) => t.indent === top && !t.done).pop()
  const last = lastOpen ?? inSection[inSection.length - 1]
  const taskLine = `- [ ] ${clean}`
  if (!last) {
    // No tasks yet: keep one blank line after the heading.
    let insertAt = headingIdx + 1
    if ((plain[insertAt] ?? '').trim() === '') insertAt += 1
    insertLine(lines, insertAt, taskLine, cr)
    if ((lines[insertAt + 1] ?? '').trim() !== '' && insertAt + 1 < lines.length) lines.splice(insertAt + 1, 0, cr)
    return lines.join('\n')
  }
  insertLine(lines, blockEnd(lines, last), taskLine, cr)
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
