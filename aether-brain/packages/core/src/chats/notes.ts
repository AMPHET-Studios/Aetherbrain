/**
 * AI chats as plain markdown notes, and the plan of an import.
 *
 * Layout (under a base folder such as `Resources/AI Chats`):
 *
 *   Claude/2026-03-02 Portal lighting.md          one note per chat
 *   Claude/<Project>/<Project> (Claude project).md hub: description, instructions, knowledge, chats
 *   Claude/<Project>/Knowledge/<Project> – <doc>.md the project's knowledge docs
 *   ChatGPT/2026-03-04 Monolith ideas.md
 *   ChatGPT/Pictures/2026-03-04 Monolith ideas 1.png  pictures of the chats (moons)
 *   ChatGPT/Project <id>/…                        chats of a ChatGPT project
 *
 * A chat or project with the name of an Aether project goes to that project's
 * `AI Chats` planet instead, linked to it.
 *
 * Nothing proprietary: frontmatter uses the standard keys only, and a note
 * knows its chat by a `Source: <https://claude.ai/chat/…>` line, which is
 * also the way back to the chat online. Re-importing an export finds those
 * notes wherever they were moved, adds new chats, and rewrites the
 * `## Transcript` of a chat that has grown (everything above that heading is
 * the user's and stays).
 *
 * Chat text is kept as written but made inert: a `[[…]]`, `#word` or
 * `- [ ]` inside a chat is escaped (`[\[…]]`, `\#word`, `- \[ ]`), so it shows
 * as text and never becomes a link, a tag or a to-do of the brain.
 */
import type { NoteId, ParsedNote } from '../types'
import { joinFrontmatter, splitFrontmatter, updateFrontmatter } from '../markdown/frontmatter'
import { inlineTagOffsets, parseMarkdown } from '../markdown/parse'
import { extractTasks } from '../markdown/tasks'
import { visit } from 'unist-util-visit'
import { basenameOf, folderOf, idFromPath, normalizePath, slugifyTitle } from '../vault/paths'
import { chatgptProjectUrl, type ChatArchive, type ChatConversation, type ChatMessage, type ChatProject, type ChatSource } from './exports'

/** Caps: one chat must never make a note the parser chokes on. */
export const MAX_MESSAGE_CHARS = 100_000
export const MAX_ATTACHMENT_CHARS = 20_000
export const MAX_ARTIFACT_CHARS = 100_000
export const MAX_DOC_CHARS = 200_000

export const TRANSCRIPT_HEADING = '## Transcript'
export const PROJECT_HEADING = '## Project'

const SOURCE_NAME: Record<ChatSource, string> = { claude: 'Claude', chatgpt: 'ChatGPT' }

// ------------------------------------------------------------------ text

/** Line breaks unified, control characters (NUL…) dropped: nothing a file or a parser trips on. */
function cleanText(text: string, max: number): string {
  let t = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  if (t.length > max) t = `${t.slice(0, max)}\n\n*… (cut at ${max.toLocaleString('en-US')} characters)*`
  return t
}

/** One line of plain text for markdown: every markdown character escaped. */
export function inlineText(text: string, max = 160): string {
  const t = text
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (t.length > max ? `${t.slice(0, max - 1)}…` : t).replace(/[\\`*_[\]<>#!|~]/g, '\\$&')
}

/** A title usable inside `[[…]]` and as a file name. */
function linkTitle(text: string): string {
  return text
    .replace(/[[\]|#^\\/:*?"<>]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
}

/** A file or folder name every OS takes (no separators, no trailing dot, not too long). */
function safeName(text: string, max = 80): string {
  const name = slugifyTitle(text.replace(/[\u0000-\u001f\u007f]+/g, ' '))
    .slice(0, max)
    .replace(/[. ]+$/, '')
    .trim()
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? `${name} chat` : name
}

/**
 * Close a fenced code block a chat message left open, so it can't swallow
 * the rest of the note (CommonMark rules: same fence character, at least as
 * long, up to three spaces of indent).
 */
export function closeFences(text: string): string {
  let open: { ch: string; len: number } | null = null
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!m) continue
    const fence = m[1]!
    const ch = fence[0]!
    if (!open) {
      // A backtick fence's info string can't hold a backtick.
      if (ch === '`' && m[2]!.includes('`')) continue
      open = { ch, len: fence.length }
    } else if (ch === open.ch && fence.length >= open.len && !m[2]!.trim()) open = null
  }
  return open ? `${text}\n${open.ch.repeat(open.len)}` : text
}

/** A fence for `content`: longer than any backtick run inside it. */
function fenceFor(content: string): string {
  let longest = 0
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** HTML that opens a block only its end marker closes (CommonMark types 1–5): it would swallow what follows. */
const HTML_OPENER = /^<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--|\?|![A-Za-z]|!\[CDATA\[)/i

/**
 * Make chat text inert from offset `from` on: escape everything the brain
 * would read as a wikilink (`[[`), an inline tag (`#word`) or a task
 * (`- [ ]`), and every HTML opener that could swallow the rest of the note.
 * Code stays untouched. The markdown is parsed the way the brain parses notes,
 * so what is escaped is exactly what the brain would have picked up.
 */
export function inertMarkdown(body: string, from = 0): string {
  let text = body
  for (let round = 0; round < 50; round++) {
    const tree = parseMarkdown(text)
    const htmlAt: number[] = []
    visit(tree, 'html', (node) => {
      const at = node.position?.start.offset
      if (at === undefined || at < from) return
      if (HTML_OPENER.test(node.value.trimStart())) {
        const lt = text.indexOf('<', at)
        if (lt >= 0) htmlAt.push(lt)
      }
    })
    if (htmlAt.length) {
      // Escaping an opener can change how everything after it parses: fix, then look again.
      text = insertBackslashes(text, htmlAt)
      continue
    }
    const at = new Set<number>()
    visit(tree, 'text', (node) => {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined || end <= from) return
      const src = text.slice(start, end)
      for (let i = src.indexOf('[['); i >= 0; i = src.indexOf('[[', i + 1)) if (start + i + 1 >= from) at.add(start + i + 1)
      for (const i of inlineTagOffsets(src)) if (start + i >= from) at.add(start + i)
    })
    // Tasks are read line by line (tasks.ts), not from the tree: escape what that scan sees.
    const lines = text.split('\n')
    const lineStart: number[] = []
    for (let i = 0, off = 0; i < lines.length; i++) {
      lineStart.push(off)
      off += lines[i]!.length + 1
    }
    for (const t of extractTasks(text)) {
      const off = lineStart[t.line]
      if (off === undefined || off < from) continue
      const m = /^\s*[-*+]\s+\[/.exec(lines[t.line]!)
      if (m) at.add(off + m[0].length - 1)
    }
    return insertBackslashes(text, [...at])
  }
  return text
}

function insertBackslashes(text: string, offsets: number[]): string {
  const sorted = [...new Set(offsets)].sort((a, b) => b - a)
  let out = text
  for (const i of sorted) out = `${out.slice(0, i)}\\${out.slice(i)}`
  return out
}

// ------------------------------------------------------------------ dates

function partsOf(iso: string, utc: boolean): { day: string; time: string } | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  const [y, mo, da, h, mi] = utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]
  return { day: `${y}-${p(mo)}-${p(da)}`, time: `${p(h)}:${p(mi)}` }
}

function dayOf(iso: string | null, utc: boolean): string | null {
  return iso ? (partsOf(iso, utc)?.day ?? null) : null
}

// ------------------------------------------------------------------ chat notes

export interface ChatRenderOptions {
  /** Times in UTC instead of local time (tests). */
  utc?: boolean
  /** Title of the project hub note to link, or null. */
  projectLink?: string | null
  /** Title of the Aether project to link, or null. */
  aetherProject?: string | null
  /** Pictures of the chat: file id → picture file name in the vault. */
  pictures?: ReadonlyMap<string, string>
  /**
   * A summary written above the transcript (markdown, kept live: its links,
   * tags and tasks count, like any note's). For chats saved through the AI link.
   */
  summary?: string | null
}

/** Web addresses of a chat that `Source:` lines may carry (the note's identity on re-import). */
export function isChatUrl(url: string): boolean {
  return /^https:\/\/(claude\.ai\/chat|chatgpt\.com\/c|chat\.openai\.com\/c)\/[A-Za-z0-9_-]{6,80}$/.test(url)
}

/** `2026-03-02 Portal lighting`: the file name (and title) of a chat's note. */
export function chatBaseName(conv: ChatConversation, utc = false): string {
  const day = dayOf(conv.created ?? conv.updated, utc) ?? 'undated'
  return `${day} ${safeName(conv.title) || 'Chat'}`
}

/** How many messages a transcript says it holds (its `*N messages*` line), or null. */
export function transcriptCount(section: string): number | null {
  const m = /^\*(\d+) messages?\b/m.exec(section)
  return m ? Number(m[1]) : null
}

/** Placeholders for the lines that must stay live (embeds, links) while the rest is made inert. */
class Live {
  private lines: string[] = []
  add(line: string): string {
    this.lines.push(line)
    return `\u0000${this.lines.length - 1}\u0000`
  }
  fill(text: string): string {
    return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => this.lines[Number(i)] ?? '')
  }
}

function messageBlock(m: ChatMessage, speaker: string, day: { last: string | null }, opts: ChatRenderOptions, live: Live): string {
  const at = m.time ? partsOf(m.time, !!opts.utc) : null
  let stamp = ''
  if (at) {
    stamp = at.day === day.last ? ` · ${at.time}` : ` · ${at.day} ${at.time}`
    day.last = at.day
  }
  const out: string[] = [`### ${speaker}${stamp}`, '']
  if (m.text) out.push(closeFences(cleanText(m.text, MAX_MESSAGE_CHARS)), '')
  for (const img of m.images) {
    const file = opts.pictures?.get(img.fileId)
    out.push(file ? live.add(`![[${file}]]`) : '🖼 *picture not in the export*', '')
    if (img.prompt && !m.text.includes(img.prompt)) out.push(`*Prompt:* ${inlineText(img.prompt, 1000)}`, '')
  }
  for (const a of m.artifacts) {
    const content = cleanText(a.content, MAX_ARTIFACT_CHARS)
    const fence = fenceFor(content)
    out.push(`**🧩 ${inlineText(a.title, 120)}**`, '', `${fence}${a.language}`, content, fence, '')
  }
  for (const a of m.attachments) {
    out.push(`📎 ${inlineText(a.name, 200)}`, '')
    if (a.text?.trim()) {
      const content = cleanText(a.text, MAX_ATTACHMENT_CHARS)
      const fence = fenceFor(content)
      out.push(`${fence}text`, content, fence, '')
    }
  }
  return out.join('\n')
}

/** The `## Transcript` section of a chat (heading included), inert. */
export function renderTranscript(conv: ChatConversation, opts: ChatRenderOptions = {}): string {
  const utc = !!opts.utc
  const assistant = SOURCE_NAME[conv.source]
  const live = new Live()
  const first = dayOf(conv.created, utc)
  const last = dayOf(conv.updated, utc)
  const facts = [`${conv.messages.length} message${conv.messages.length === 1 ? '' : 's'}`]
  if (first) facts.push(last && last !== first ? `${first} → ${last}` : first)
  if (conv.model) facts.push(inlineText(conv.model, 60))
  const day = { last: null as string | null }
  const blocks = conv.messages.map((m) => messageBlock(m, m.role === 'user' ? 'You' : assistant, day, opts, live))
  const head = `${TRANSCRIPT_HEADING}\n\n*${facts.join(' · ')}*\n\n`
  const body = inertMarkdown(head + blocks.join('\n'), head.length)
  return `${live.fill(body).replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** Header lines of a chat note (between its title and the transcript). */
function chatHeader(conv: ChatConversation, opts: ChatRenderOptions): string {
  const what = `${SOURCE_NAME[conv.source]} chat`
  const lines: string[] = []
  const inProject = opts.projectLink ? ` in [[${opts.projectLink}]]` : ''
  lines.push(`${what}${inProject}${conv.gptId ? ` with GPT ${inlineText(conv.gptId, 60)}` : ''}`)
  if (opts.aetherProject) lines.push(`Project: [[${opts.aetherProject}]]`)
  // A chat saved live through the AI link may not know its web address.
  if (/^https:\/\//.test(conv.url)) lines.push(`Source: <${conv.url}>`)
  if (conv.source === 'chatgpt' && conv.projectId && !opts.projectLink) lines.push(`ChatGPT project: <${chatgptProjectUrl(conv.projectId)}>`)
  return lines.join('  \n')
}

/** The whole note of a chat, titled `title` (its file name without `.md`). */
export function renderChatNote(conv: ChatConversation, title: string, opts: ChatRenderOptions = {}): string {
  const utc = !!opts.utc
  const created = dayOf(conv.created, utc)
  const updated = dayOf(conv.updated, utc) ?? created
  const fm: Record<string, unknown> = { title, tags: ['ai-chat', conv.source] }
  if (created) fm.created = created
  if (updated) fm.updated = updated
  const summary = opts.summary?.trim() ? `## Summary\n\n${closeFences(cleanText(opts.summary.trim(), MAX_MESSAGE_CHARS))}\n\n` : ''
  const body = `# ${inlineText(title, 200)}\n\n${chatHeader(conv, opts)}\n\n${summary}${renderTranscript(conv, opts)}`
  return joinFrontmatter(fm, body)
}

// ------------------------------------------------------------------ projects

/** `PORTALz (Claude project)`: the title (and file name) of a project's hub note. */
export function projectHubTitle(project: ChatProject): string {
  return `${linkTitle(project.name).slice(0, 80) || 'Project'} (${SOURCE_NAME[project.source]} project)`
}

/** Fence language of a knowledge doc by its extension; '' = markdown shown as markdown. */
function docLanguage(name: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  if (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === '' || ext === 'pdf' || ext === 'docx' || ext === 'doc' || ext === 'rtf') return null
  const map: Record<string, string> = { py: 'python', js: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx', cs: 'csharp', cpp: 'cpp', h: 'cpp', hpp: 'cpp', rs: 'rust', rb: 'ruby', sh: 'bash', ps1: 'powershell', yml: 'yaml' }
  return map[ext] ?? ext
}

export interface ProjectRenderOptions {
  utc?: boolean
  /** Titles of the project's knowledge doc notes, in order. */
  docs?: string[]
  /** Titles of the project's chat notes, newest first. */
  chats?: string[]
  aetherProject?: string | null
}

/** The `## Project` section of a hub (heading included): description, instructions, knowledge, chats. */
export function renderProjectSection(project: ChatProject, opts: ProjectRenderOptions = {}): string {
  const live = new Live()
  const out: string[] = [PROJECT_HEADING, '']
  if (project.description) out.push(closeFences(cleanText(project.description, MAX_DOC_CHARS)), '')
  if (project.instructions) out.push('### Instructions', '', closeFences(cleanText(project.instructions, MAX_DOC_CHARS)), '')
  if (opts.docs?.length) out.push('### Knowledge', '', ...opts.docs.map((t) => live.add(`- [[${t}]]`)), '')
  if (opts.chats?.length) out.push('### Chats', '', ...opts.chats.map((t) => live.add(`- [[${t}]]`)), '')
  const text = inertMarkdown(out.join('\n'), PROJECT_HEADING.length)
  return `${live.fill(text).replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

export function renderProjectHub(project: ChatProject, title: string, opts: ProjectRenderOptions = {}): string {
  const utc = !!opts.utc
  const created = dayOf(project.created, utc)
  const updated = dayOf(project.updated, utc) ?? created
  const fm: Record<string, unknown> = { title, tags: ['ai-project', project.source] }
  if (created) fm.created = created
  if (updated) fm.updated = updated
  const lines = [`${SOURCE_NAME[project.source]} project`]
  if (opts.aetherProject) lines.push(`Project: [[${opts.aetherProject}]]`)
  lines.push(`Source: <${project.url}>`)
  return joinFrontmatter(fm, `# ${inlineText(title, 200)}\n\n${lines.join('  \n')}\n\n${renderProjectSection(project, opts)}`)
}

export function renderProjectDoc(project: ChatProject, doc: { name: string; content: string }, title: string, hubTitle: string, utc = false): string {
  const created = dayOf(project.created, utc)
  const fm: Record<string, unknown> = { title, tags: ['ai-knowledge', project.source] }
  if (created) fm.created = created
  const content = cleanText(doc.content, MAX_DOC_CHARS)
  const lang = docLanguage(doc.name)
  const live = new Live()
  const head = `# ${inlineText(title, 200)}\n\nKnowledge of ${live.add(`[[${hubTitle}]]`)} · ${inlineText(doc.name, 200)}\n\n## Document\n\n`
  let body: string
  if (lang === null) body = inertMarkdown(head + closeFences(content), 0)
  else {
    const fence = fenceFor(content)
    body = inertMarkdown(`${head}${fence}${lang}\n${content}\n${fence}`, 0)
  }
  return joinFrontmatter(fm, `${live.fill(body).trimEnd()}\n`)
}

// ------------------------------------------------------------------ re-import

/** `Source: <url>` lines of notes the importer wrote: url → note. */
export function importedNotes(notes: Iterable<ParsedNote>): Map<string, ParsedNote> {
  const out = new Map<string, ParsedNote>()
  for (const n of notes) {
    if (!n.raw.includes('Source: <https://')) continue
    for (const m of n.raw.matchAll(/^Source: <(https:\/\/[^>\s]+)>/gm)) {
      const url = m[1]!
      if (!out.has(url)) out.set(url, n)
    }
  }
  return out
}

/** Folders of ChatGPT projects already imported: project url → folder of one of its chats. */
function chatgptProjectFolders(notes: Iterable<ParsedNote>): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of notes) {
    if (!n.raw.includes('ChatGPT project: <')) continue
    const m = /^ChatGPT project: <(https:\/\/[^>\s]+)>/m.exec(n.raw)
    if (m && !out.has(m[1]!)) out.set(m[1]!, n.meta.folder)
  }
  return out
}

/**
 * `raw` with everything from the line `heading` on replaced by `section`
 * (which starts with that heading), or null when the note has no such line
 * outside its frontmatter. Line endings follow the note's.
 */
export function replaceSection(raw: string, heading: string, section: string): string | null {
  const { bodyOffset } = splitFrontmatter(raw)
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  let at = bodyOffset
  for (;;) {
    const end = raw.indexOf('\n', at)
    const line = raw.slice(at, end < 0 ? raw.length : end).replace(/\r$/, '')
    if (line.trimEnd() === heading) break
    if (end < 0) return null
    at = end + 1
  }
  return raw.slice(0, at) + (eol === '\n' ? section : section.replace(/\n/g, '\r\n'))
}

/** The section of `raw` from the line `heading` on, or null. */
export function sectionOf(raw: string, heading: string): string | null {
  const marker = `\u0001`
  const replaced = replaceSection(raw, heading, marker)
  if (replaced === null) return null
  return raw.slice(replaced.length - marker.length).replace(/\r\n/g, '\n')
}

// ------------------------------------------------------------------ plan

export interface ChatImportOptions {
  /** Folder for chats, e.g. `Resources/AI Chats` or `D/AI Chats` ('' = vault root). */
  base: string
  /** Aether projects (title, home folder): a chat project of the same name files into `<home>/AI Chats`. */
  projects?: { title: string; home: string }[]
  /** Picture files in the export (zip paths), for ChatGPT's pictures. */
  pictureFiles?: string[]
  /** Vault paths of pictures already in the vault. */
  existingPictures?: Iterable<string>
  /** Times in UTC (tests). */
  utc?: boolean
}

export interface PlannedNote {
  path: string
  content: string
  kind: 'chat' | 'project' | 'doc'
  source: ChatSource
}

export interface PlannedUpdate {
  noteId: NoteId
  path: string
  /** Heading the replaced section starts at. */
  heading: string
  section: string
  /** New `updated` date for the frontmatter, or null to leave it. */
  updated: string | null
  kind: 'chat' | 'project'
}

export interface PlannedPicture {
  /** Path of the picture in the export. */
  from: string
  /** Vault path to write it to. */
  path: string
}

export interface ChatImportPlan {
  create: PlannedNote[]
  update: PlannedUpdate[]
  pictures: PlannedPicture[]
  /** Chats already in the brain and unchanged. */
  unchanged: number
  counts: { claude: number; chatgpt: number; projects: number; docs: number; messages: number; pictures: number }
  /** Folders the plan writes into (to create first). */
  folders: string[]
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

const join = (...parts: string[]) => normalizePath(parts.filter(Boolean).join('/'))

/** Picture files of an export by file id (`file-AbC-name.png` → `file-AbC`). */
function pictureIndex(files: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of files) {
    const base = f.slice(f.lastIndexOf('/') + 1)
    const m = /^(file[-_][A-Za-z0-9]+)/.exec(base)
    if (m && !out.has(m[1]!)) out.set(m[1]!, f)
  }
  return out
}

/**
 * What importing `archive` into a vault holding `existing` does: the notes to
 * create (paths free, names numbered ` 2`, ` 3` … when taken), the imported
 * notes to update (a chat that has grown, a project hub that changed) and the
 * pictures to copy. Pure: nothing is written.
 */
export function planChatImport(archive: ChatArchive, existing: Iterable<ParsedNote>, opts: ChatImportOptions): ChatImportPlan {
  const utc = !!opts.utc
  const notes = [...existing]
  const imported = importedNotes(notes)
  const gptFolders = chatgptProjectFolders(notes)
  const taken = new Set(notes.map((n) => n.meta.path.toLowerCase()))
  // Titles too: links resolve by title, so two chats named alike in different folders must not share one.
  const titles = new Set<string>()
  for (const n of notes) {
    titles.add(n.meta.title.trim().toLowerCase())
    titles.add(basenameOf(n.meta.path).toLowerCase())
  }
  const pictureTaken = new Set([...(opts.existingPictures ?? [])].map((p) => p.toLowerCase()))
  const byName = new Map<string, { title: string; home: string }>()
  for (const p of opts.projects ?? []) if (norm(p.title) && !byName.has(norm(p.title))) byName.set(norm(p.title), p)
  const pics = pictureIndex(opts.pictureFiles ?? [])
  const plan: ChatImportPlan = {
    create: [],
    update: [],
    pictures: [],
    unchanged: 0,
    counts: { claude: 0, chatgpt: 0, projects: 0, docs: 0, messages: 0, pictures: 0 },
    folders: [],
  }
  const folders = new Set<string>()

  /** A free note `<dir>/<name>.md` whose title no note has (` 2`, ` 3` … when taken); returns [path, title]. */
  const freeNote = (dir: string, name: string): [string, string] => {
    for (let n = 1; ; n++) {
      const title = n === 1 ? name : `${name} ${n}`
      const path = join(dir, `${title}.md`)
      if (!taken.has(path.toLowerCase()) && !titles.has(title.toLowerCase())) {
        taken.add(path.toLowerCase())
        titles.add(title.toLowerCase())
        return [path, title]
      }
    }
  }

  // Projects first: their hubs decide where their chats go.
  interface ProjectPlace {
    dir: string
    hubTitle: string
    /** Path of a hub to create (null when the hub is already in the vault). */
    hubPath: string | null
    aether: string | null
    hub: ParsedNote | null
    project: ChatProject
    docs: string[]
    chats: { title: string; created: string }[]
  }
  const places = new Map<string, ProjectPlace>()
  for (const p of archive.projects) {
    const hub = imported.get(p.url) ?? null
    const match = byName.get(norm(p.name)) ?? null
    let dir: string
    let hubTitle: string
    if (hub) {
      dir = hub.meta.folder
      hubTitle = hub.meta.title
    } else {
      const home = match ? join(match.home, 'AI Chats') : join(opts.base, SOURCE_NAME[p.source], safeName(p.name, 60) || `Project ${p.id.slice(0, 8)}`)
      dir = home
      hubTitle = ''
    }
    places.set(p.id, { dir, hubTitle, hubPath: null, aether: match?.title ?? null, hub, project: p, docs: [], chats: [] })
  }
  // Hub titles for new hubs (after existing ones took theirs).
  for (const place of places.values()) {
    if (place.hub) continue
    const [path, title] = freeNote(place.dir, projectHubTitle(place.project))
    place.hubTitle = title
    place.hubPath = path
  }

  // Knowledge docs: create-only, next to the hub.
  for (const place of places.values()) {
    const kdir = join(place.dir, 'Knowledge')
    for (const doc of place.project.docs) {
      const name = `${linkTitle(place.project.name).slice(0, 40) || 'Project'} – ${safeName(doc.name.replace(/\.[a-z0-9]+$/i, ''), 60) || 'Document'}`
      const path = join(kdir, `${name}.md`)
      if (place.docs.includes(name)) continue
      place.docs.push(name)
      if (taken.has(path.toLowerCase())) continue
      taken.add(path.toLowerCase())
      plan.create.push({ path, content: renderProjectDoc(place.project, doc, name, place.hubTitle, utc), kind: 'doc', source: place.project.source })
      plan.counts.docs++
      folders.add(kdir)
    }
  }

  // Chats.
  const sorted = [...archive.conversations].sort((a, b) => (a.created ?? '').localeCompare(b.created ?? '') || a.id.localeCompare(b.id))
  for (const conv of sorted) {
    if (!conv.messages.length) continue
    plan.counts[conv.source]++
    plan.counts.messages += conv.messages.length
    const place = conv.projectId ? places.get(conv.projectId) : undefined
    const existingNote = imported.get(conv.url) ?? null
    let dir: string
    let title: string
    let path: string
    if (existingNote) {
      dir = existingNote.meta.folder
      title = existingNote.meta.title
      path = existingNote.meta.path
    } else {
      if (place) dir = place.dir
      else if (conv.source === 'chatgpt' && conv.projectId) {
        dir = gptFolders.get(chatgptProjectUrl(conv.projectId)) ?? join(opts.base, 'ChatGPT', `Project ${conv.projectId.replace(/^g-p-/, '').slice(0, 8)}`)
      } else dir = join(opts.base, SOURCE_NAME[conv.source])
      ;[path, title] = freeNote(dir, chatBaseName(conv, utc))
    }
    // Pictures: `<chat folder>/Pictures/<chat> <n>.<ext>`, create-only.
    const pictures = new Map<string, string>()
    let added = 0
    let n = 0
    for (const m of conv.messages) {
      for (const img of m.images) {
        const from = pics.get(img.fileId)
        if (!from || pictures.has(img.fileId)) continue
        n++
        const ext = (/\.[a-z0-9]+$/i.exec(from)?.[0] ?? '.png').toLowerCase()
        const file = `${safeName(title, 100)} ${n}${ext}`
        const target = join(dir, 'Pictures', file)
        pictures.set(img.fileId, file)
        if (pictureTaken.has(target.toLowerCase())) continue
        pictureTaken.add(target.toLowerCase())
        added++
        plan.pictures.push({ from, path: target })
        plan.counts.pictures++
        folders.add(folderOf(target))
      }
    }
    const renderOpts: ChatRenderOptions = { utc, pictures, projectLink: place?.hubTitle ?? null, aetherProject: place?.aether ?? null }
    if (place) place.chats.push({ title, created: conv.created ?? '' })
    if (existingNote) {
      const current = sectionOf(existingNote.raw, TRANSCRIPT_HEADING)
      const count = current === null ? null : transcriptCount(current)
      // A transcript is rewritten only when the chat grew or brought new pictures: edits the user made stay.
      if (current === null || (count === conv.messages.length && added === 0)) {
        plan.unchanged++
        continue
      }
      plan.update.push({
        noteId: existingNote.meta.id,
        path: existingNote.meta.path,
        heading: TRANSCRIPT_HEADING,
        section: renderTranscript(conv, renderOpts),
        updated: dayOf(conv.updated, utc),
        kind: 'chat',
      })
      continue
    }
    plan.create.push({ path, content: renderChatNote(conv, title, renderOpts), kind: 'chat', source: conv.source })
    folders.add(dir)
  }

  // Hubs last: they list their docs and chats.
  for (const place of places.values()) {
    plan.counts.projects++
    const chats = place.chats.sort((a, b) => b.created.localeCompare(a.created)).map((c) => c.title)
    const ropts: ProjectRenderOptions = { utc, docs: place.docs, chats, aetherProject: place.aether }
    if (place.hub) {
      const current = sectionOf(place.hub.raw, PROJECT_HEADING)
      const section = renderProjectSection(place.project, ropts)
      if (current === null || current === section) continue
      plan.update.push({ noteId: place.hub.meta.id, path: place.hub.meta.path, heading: PROJECT_HEADING, section, updated: dayOf(place.project.updated, utc), kind: 'project' })
      continue
    }
    if (!place.hubPath) continue
    plan.create.push({ path: place.hubPath, content: renderProjectHub(place.project, place.hubTitle, ropts), kind: 'project', source: place.project.source })
    folders.add(place.dir)
  }

  plan.folders = [...folders].filter(Boolean).sort()
  return plan
}

/** Apply a planned update to the note's text on disk: the section replaced, `updated` patched. Null when the section is gone. */
export function applyChatUpdate(raw: string, u: Pick<PlannedUpdate, 'heading' | 'section' | 'updated'>): string | null {
  const next = replaceSection(raw, u.heading, u.section)
  if (next === null) return null
  return u.updated ? updateFrontmatter(next, { updated: u.updated }) : next
}

/** Note id of a planned path. */
export const plannedId = (path: string): NoteId => idFromPath(path)

/** What an import plan will do, as short lines for a confirmation (no markdown). */
export function describeChatImport(plan: ChatImportPlan, base: string): string[] {
  const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
  const chats = { claude: 0, chatgpt: 0 }
  let hubs = 0
  let docs = 0
  for (const p of plan.create) {
    if (p.kind === 'chat') chats[p.source]++
    else if (p.kind === 'project') hubs++
    else docs++
  }
  const lines: string[] = []
  const bySource = [chats.claude ? n(chats.claude, 'Claude chat') : '', chats.chatgpt ? n(chats.chatgpt, 'ChatGPT chat') : ''].filter(Boolean)
  if (bySource.length) lines.push(`New: ${bySource.join(', ')}`)
  if (hubs || docs) lines.push(`Projects: ${n(hubs, 'project')}${docs ? ` with ${n(docs, 'knowledge doc')}` : ''}`)
  if (plan.pictures.length) lines.push(`Pictures: ${n(plan.pictures.length, 'picture')} from the chats`)
  const grown = plan.update.filter((u) => u.kind === 'chat').length
  if (grown) lines.push(`Updated: ${n(grown, 'chat')} that grew since the last import (only the transcript)`)
  const hubUpdates = plan.update.length - grown
  if (hubUpdates) lines.push(`Updated: ${n(hubUpdates, 'project hub')}`)
  if (plan.unchanged) lines.push(`Already in your brain: ${n(plan.unchanged, 'chat')} (left as they are)`)
  lines.push(`Into: ${base || 'the vault root'}`)
  return lines
}
