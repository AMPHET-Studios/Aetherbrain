import { joinFrontmatter } from '../markdown/frontmatter'
import { slugifyTitle, todayIso } from './paths'

export interface CaptureInput {
  text: string
  /** Explicit title; else derived from the first line. */
  title?: string
  tags?: string[]
}

/** Derive a title from free text: first non-empty line, minus markdown syntax. */
export function titleFromText(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return `Capture ${todayIso()}`
  return line
    .replace(/^#+\s*/, '')
    .replace(/^[-*]\s+\[[ xX]\]\s*/, '')
    .replace(/^[-*>]\s+/, '')
    .replace(/[*_`]+/g, '')
    .slice(0, 90)
    .trim()
}

/** Build an inbox note document (frontmatter + body) from a quick capture. */
export function inboxNote(input: CaptureInput, now = new Date()): { path: string; content: string; title: string } {
  const title = (input.title?.trim() || titleFromText(input.text)).trim()
  const date = todayIso(now)
  const body = input.text.trim()
  const firstLineIsTitle = body.split(/\r?\n/)[0]?.replace(/^#+\s*/, '').trim() === title
  const bodyText = firstLineIsTitle ? body.split(/\r?\n/).slice(1).join('\n').trim() : body
  const content = joinFrontmatter(
    {
      title,
      type: 'inbox',
      tags: input.tags ?? [],
      created: date,
      updated: date,
      status: 'unprocessed',
    },
    `# ${title}\n\n${bodyText}\n`,
  )
  return { path: `Inbox/${slugifyTitle(title)}.md`, content, title }
}

/** Daily note document for a given day. */
export function dailyNote(day = todayIso(), previous?: string | null): { path: string; content: string } {
  const prev = previous ? `\n\n← [[${previous}]]` : ''
  const content = joinFrontmatter(
    { title: day, type: 'daily', tags: ['daily'], created: day, updated: day },
    `# ${day}\n\n## Focus\n\n- \n\n## Log\n\n- \n\n## Captured\n\n- ${prev}\n`,
  )
  return { path: `Daily/${day}.md`, content }
}

/** Blank note for a ghost link ("create the missing neuron"). */
export function blankNote(title: string, folder = 'Inbox', now = new Date()): { path: string; content: string } {
  const date = todayIso(now)
  const content = joinFrontmatter(
    { title, type: folder.toLowerCase().startsWith('inbox') ? 'inbox' : 'note', tags: [], created: date, updated: date, status: 'seedling' },
    `# ${title}\n\n`,
  )
  const dir = folder.replace(/\/+$/, '')
  return { path: `${dir ? dir + '/' : ''}${slugifyTitle(title)}.md`, content }
}

export const AREA_FOLDER: Record<'inbox' | 'projects' | 'areas' | 'resources' | 'archive', string> = {
  inbox: 'Inbox',
  projects: 'Projects',
  areas: 'Areas',
  resources: 'Resources',
  archive: 'Archive',
}
